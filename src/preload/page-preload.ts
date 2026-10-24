import { ipcRenderer } from "electron";

import { channels } from "../shared/channels";
import type {
  SmartReaderExtractionRequest,
  SmartReaderExtractionResult,
} from "../shared/smart-reader";
import { extractSmartReaderArticleFromDocument } from "./smart-reader-extraction";

interface LinkCandidate {
  url: string;
  title: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  area: number;
  rel: string;
  alreadySpeculated: boolean;
}

interface PointerSample {
  x: number;
  y: number;
  timestamp: number;
}

const MAX_DOM_LINKS = 320;
const MAX_VISIBLE_CANDIDATES = 80;
const MIN_EMIT_INTERVAL_MS = 60;
const GEOMETRY_DEBOUNCE_MS = 120;
const SMART_READER_MUTATION_DEBOUNCE_MS = 750;

let candidates: LinkCandidate[] = [];
let geometryDirty = true;
let lastPointer: PointerSample | null = null;
let hoveredUrl: string | null = null;
let clickedUrl: string | null = null;
let lastEmitAt = 0;
let scheduled = false;
let geometryTimer: number | null = null;
let smartReaderMutationTimer: number | null = null;
const speculativeLinks = new Map<string, HTMLLinkElement>();
let observedVideo: HTMLVideoElement | null = null;
let observedVideoLastTime = 0;
let observedPlaybackSeconds = 0;
let observationBucket = 0;
let observationVideoId: string | null = null;

interface WebsiteDocumentPolicy {
  autoplay: "ask" | "allow" | "block";
  javascript: "ask" | "allow" | "block";
  network: "ask" | "allow" | "block";
}

function readWebsiteDocumentPolicy(): WebsiteDocumentPolicy {
  try {
    const value = ipcRenderer.sendSync(
      channels.getWebsiteDocumentPolicy,
    ) as Partial<WebsiteDocumentPolicy> | null;
    return {
      autoplay:
        value?.autoplay === "allow" || value?.autoplay === "block"
          ? value.autoplay
          : "ask",
      javascript:
        value?.javascript === "allow" || value?.javascript === "block"
          ? value.javascript
          : "ask",
      network:
        value?.network === "allow" || value?.network === "block"
          ? value.network
          : "ask",
    };
  } catch {
    return { autoplay: "ask", javascript: "ask", network: "ask" };
  }
}

const websiteDocumentPolicy = readWebsiteDocumentPolicy();
if (websiteDocumentPolicy.autoplay === "block") {
  addEventListener(
    "play",
    (event) => {
      if (event.target instanceof HTMLMediaElement) event.target.pause();
    },
    { capture: true },
  );
}

function cleanHttpUrl(raw: string): string | null {
  try {
    const url = new URL(raw, location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href.length <= 8_192 ? url.href : null;
  } catch {
    return null;
  }
}

function linkTitle(anchor: HTMLAnchorElement): string {
  return (
    anchor.getAttribute("aria-label")?.trim() ||
    anchor.textContent?.replace(/\s+/g, " ").trim() ||
    anchor.title.trim() ||
    anchor.hostname
  ).slice(0, 240);
}

function refreshGeometry(): void {
  geometryDirty = false;
  const visible: LinkCandidate[] = [];
  const hyperdriveOwnedLinks = new Set(speculativeLinks.values());
  const pagePrefetches = new Set(
    [
      ...document.querySelectorAll<HTMLLinkElement>(
        "link[rel~='prefetch'][href]",
      ),
    ]
      .filter((link) => !hyperdriveOwnedLinks.has(link))
      .map((link) => cleanHttpUrl(link.href))
      .filter((url): url is string => url !== null),
  );
  const links = document.querySelectorAll<HTMLAnchorElement>("a[href]");
  const count = Math.min(links.length, MAX_DOM_LINKS);
  for (let index = 0; index < count; index += 1) {
    const anchor = links[index];
    if (
      anchor.download ||
      anchor.getAttribute("aria-disabled") === "true" ||
      anchor.closest("[inert]")
    ) {
      continue;
    }
    const url = cleanHttpUrl(anchor.href);
    if (!url) continue;
    const rect = anchor.getBoundingClientRect();
    if (
      rect.width < 8 ||
      rect.height < 8 ||
      rect.right <= 0 ||
      rect.bottom <= 0 ||
      rect.left >= innerWidth ||
      rect.top >= innerHeight
    ) {
      continue;
    }
    const style = getComputedStyle(anchor);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) < 0.05
    ) {
      continue;
    }
    visible.push({
      url,
      title: linkTitle(anchor),
      left: Math.max(0, rect.left),
      top: Math.max(0, rect.top),
      right: Math.min(innerWidth, rect.right),
      bottom: Math.min(innerHeight, rect.bottom),
      area: Math.round(rect.width * rect.height),
      rel: anchor.rel.slice(0, 160),
      alreadySpeculated: pagePrefetches.has(url),
    });
  }

  const point = lastPointer ?? {
    x: innerWidth / 2,
    y: innerHeight / 2,
    timestamp: performance.now(),
  };
  visible.sort((left, right) => {
    const leftX = Math.max(left.left, Math.min(point.x, left.right));
    const leftY = Math.max(left.top, Math.min(point.y, left.bottom));
    const rightX = Math.max(right.left, Math.min(point.x, right.right));
    const rightY = Math.max(right.top, Math.min(point.y, right.bottom));
    return (
      Math.hypot(leftX - point.x, leftY - point.y) -
      Math.hypot(rightX - point.x, rightY - point.y)
    );
  });
  candidates = visible.slice(0, MAX_VISIBLE_CANDIDATES);
}

function emitSignals(force = false): void {
  scheduled = false;
  if (document.visibilityState !== "visible" || window.top !== window) return;
  const now = performance.now();
  if (!force && now - lastEmitAt < MIN_EMIT_INTERVAL_MS) {
    scheduleEmit();
    return;
  }
  if (geometryDirty) refreshGeometry();
  lastEmitAt = now;
  ipcRenderer.send(channels.hyperdrivePageSignals, {
    pageUrl: location.href,
    pageTitle: document.title.slice(0, 240),
    timestamp: Date.now(),
    viewport: { width: innerWidth, height: innerHeight },
    pointer: lastPointer,
    hoveredUrl,
    clickedUrl,
    candidates,
  });
  clickedUrl = null;
}

function scheduleEmit(force = false): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => emitSignals(force));
}

function markGeometryDirty(): void {
  geometryDirty = true;
  if (geometryTimer !== null) window.clearTimeout(geometryTimer);
  geometryTimer = window.setTimeout(() => {
    geometryTimer = null;
    scheduleEmit(true);
  }, GEOMETRY_DEBOUNCE_MS);
}

function scheduleSmartReaderContentChanged(): void {
  if (window.top !== window) return;
  if (smartReaderMutationTimer !== null) return;
  smartReaderMutationTimer = window.setTimeout(() => {
    smartReaderMutationTimer = null;
    ipcRenderer.send(channels.smartReaderContentChanged, {
      url: location.href,
    });
  }, SMART_READER_MUTATION_DEBOUNCE_MS);
}

function anchorFromTarget(
  target: EventTarget | null,
): HTMLAnchorElement | null {
  return target instanceof Element
    ? target.closest<HTMLAnchorElement>("a[href]")
    : null;
}

type AssistantSelectionKind = "screenshot" | "element";

let assistantSelection: {
  kind: AssistantSelectionKind;
  requestId: string;
  overlay: HTMLDivElement;
  selection: HTMLDivElement;
  tooltip: HTMLDivElement;
  start: { x: number; y: number } | null;
  cleanup: () => void;
} | null = null;

function assistantText(value: string | null | undefined, maximum: number) {
  const text = value?.replace(/\s+/gu, " ").trim() ?? "";
  return text ? text.slice(0, maximum) : null;
}

function assistantUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value, location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href.slice(0, 2_048);
  } catch {
    return null;
  }
}

function meaningfulAssistantElement(
  target: EventTarget | null,
): Element | null {
  if (!(target instanceof Element)) return null;
  const candidate = target.closest(
    "button, a[href], input:not([type='password']), textarea, select, img, h1, h2, h3, h4, h5, h6, [role='button'], [role='link'], [role='heading'], [role='textbox'], [role='checkbox'], [role='switch'], nav, form, article, main",
  );
  if (!candidate || candidate.closest("[data-chromecraft-assistant-selection]"))
    return null;
  if (
    candidate.matches(
      "input[type='password'], input[type='hidden'], [aria-hidden='true']",
    )
  )
    return null;
  const rect = candidate.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return null;
  return candidate;
}

function assistantElementSummary(element: Element) {
  const tag = element.tagName.toLowerCase();
  const role = assistantText(element.getAttribute("role"), 80);
  const label = assistantText(
    element.getAttribute("aria-label") || element.getAttribute("title"),
    240,
  );
  const input =
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
      ? element
      : null;
  const placeholderInput =
    input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement
      ? input
      : null;
  const type =
    input instanceof HTMLInputElement ? input.type.slice(0, 80) : null;
  const text = assistantText(
    input
      ? input.labels?.[0]?.textContent || placeholderInput?.placeholder
      : element.textContent,
    800,
  );
  const href =
    element instanceof HTMLAnchorElement ? assistantUrl(element.href) : null;
  const alt =
    element instanceof HTMLImageElement
      ? assistantText(element.alt, 240)
      : null;
  const placeholder = placeholderInput
    ? assistantText(placeholderInput.placeholder, 240)
    : null;
  const attributes = [
    role ? ` role="${role.replaceAll('"', "")}"` : "",
    label ? ` aria-label="${label.replaceAll('"', "")}"` : "",
    href ? ` href="${href.replaceAll('"', "")}"` : "",
    alt ? ` alt="${alt.replaceAll('"', "")}"` : "",
    type ? ` type="${type.replaceAll('"', "")}"` : "",
  ].join("");
  const markup = `<${tag}${attributes}>${(text ?? "").replaceAll("<", "&lt;").replaceAll(">", "&gt;").slice(0, 480)}</${tag}>`;
  return { tag, role, label, text, href, alt, placeholder, type, markup };
}

function clearAssistantSelection() {
  const current = assistantSelection;
  if (!current) return;
  assistantSelection = null;
  current.cleanup();
}

function startAssistantSelection(kind: AssistantSelectionKind) {
  clearAssistantSelection();
  const overlay = document.createElement("div");
  const selection = document.createElement("div");
  const tooltip = document.createElement("div");
  overlay.dataset.chromecraftAssistantSelection = kind;
  overlay.setAttribute("data-chromecraft-assistant-selection", "");
  selection.setAttribute("data-chromecraft-assistant-selection", "");
  tooltip.setAttribute("data-chromecraft-assistant-selection", "");
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483646",
    cursor: "crosshair",
    background: kind === "screenshot" ? "rgba(12, 20, 38, .18)" : "transparent",
  });
  Object.assign(selection.style, {
    position: "fixed",
    display: "none",
    zIndex: "2147483647",
    pointerEvents: "none",
    border: "2px solid #2557d6",
    borderRadius: "6px",
    background: "rgba(65, 111, 235, .12)",
    boxShadow: "0 0 0 9999px rgba(10, 16, 30, .2)",
  });
  Object.assign(tooltip.style, {
    position: "fixed",
    display: "none",
    zIndex: "2147483647",
    maxWidth: "260px",
    padding: "5px 8px",
    borderRadius: "8px",
    color: "#fff",
    background: "#1e2741",
    boxShadow: "0 6px 16px rgba(0,0,0,.24)",
    font: "12px system-ui, sans-serif",
    pointerEvents: "none",
  });
  document.documentElement.append(overlay, selection, tooltip);
  const previousCursor = document.documentElement.style.cursor;
  document.documentElement.style.cursor = "crosshair";
  const requestId = `selection-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const current = {
    kind,
    requestId,
    overlay,
    selection,
    tooltip,
    start: null as { x: number; y: number } | null,
    cleanup: () => {
      document.documentElement.style.cursor = previousCursor;
      overlay.remove();
      selection.remove();
      tooltip.remove();
      removeEventListener("keydown", onKey, true);
      removeEventListener("pointermove", onMove, true);
      removeEventListener("pointerup", onUp, true);
      overlay.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("click", onElementClick, true);
    },
  };
  const showRectangle = (
    left: number,
    top: number,
    width: number,
    height: number,
  ) => {
    Object.assign(selection.style, {
      display: "block",
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    clearAssistantSelection();
  };
  const onDown = (event: PointerEvent) => {
    if (kind !== "screenshot" || event.button !== 0) return;
    event.preventDefault();
    current.start = { x: event.clientX, y: event.clientY };
    overlay.setPointerCapture?.(event.pointerId);
    showRectangle(event.clientX, event.clientY, 1, 1);
  };
  const onMove = (event: PointerEvent) => {
    if (kind === "screenshot" && current.start) {
      const left = Math.min(current.start.x, event.clientX);
      const top = Math.min(current.start.y, event.clientY);
      showRectangle(
        left,
        top,
        Math.abs(event.clientX - current.start.x),
        Math.abs(event.clientY - current.start.y),
      );
      return;
    }
    if (kind !== "element") return;
    const element = meaningfulAssistantElement(
      document.elementFromPoint(event.clientX, event.clientY),
    );
    if (!element) {
      selection.style.display = "none";
      tooltip.style.display = "none";
      return;
    }
    const rect = element.getBoundingClientRect();
    showRectangle(rect.left, rect.top, rect.width, rect.height);
    tooltip.textContent = `${element.tagName.toLowerCase()}${assistantText(element.getAttribute("aria-label") || element.textContent, 50) ? ` · ${assistantText(element.getAttribute("aria-label") || element.textContent, 50)}` : ""}`;
    Object.assign(tooltip.style, {
      display: "block",
      left: `${Math.min(innerWidth - 270, Math.max(8, rect.left))}px`,
      top: `${Math.max(8, rect.top - 32)}px`,
    });
  };
  const onUp = (event: PointerEvent) => {
    if (kind !== "screenshot" || !current.start) return;
    const left = Math.max(0, Math.min(current.start.x, event.clientX));
    const top = Math.max(0, Math.min(current.start.y, event.clientY));
    const width = Math.abs(event.clientX - current.start.x);
    const height = Math.abs(event.clientY - current.start.y);
    if (width >= 8 && height >= 8) {
      ipcRenderer.send(channels.assistantSelectionResult, {
        requestId,
        kind,
        rectangle: { x: left, y: top, width, height },
        viewport: { width: innerWidth, height: innerHeight },
      });
    }
    clearAssistantSelection();
  };
  const onElementClick = (event: MouseEvent) => {
    if (kind !== "element" || !event.isTrusted) return;
    const element = meaningfulAssistantElement(event.target);
    if (!element) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    ipcRenderer.send(channels.assistantSelectionResult, {
      requestId,
      kind,
      element: assistantElementSummary(element),
    });
    clearAssistantSelection();
  };
  assistantSelection = current;
  addEventListener("keydown", onKey, true);
  addEventListener("pointermove", onMove, true);
  addEventListener("pointerup", onUp, true);
  if (kind === "screenshot")
    overlay.addEventListener("pointerdown", onDown, true);
  else {
    overlay.style.pointerEvents = "none";
    document.addEventListener("click", onElementClick, true);
  }
}

function initialize(): void {
  addEventListener(
    "pointermove",
    (event) => {
      if (!event.isTrusted || event.pointerType === "touch") return;
      lastPointer = {
        x: event.clientX,
        y: event.clientY,
        timestamp: performance.now(),
      };
      hoveredUrl = cleanHttpUrl(anchorFromTarget(event.target)?.href ?? "");
      scheduleEmit();
    },
    { capture: true, passive: true },
  );
  addEventListener(
    "pointerover",
    (event) => {
      if (!event.isTrusted) return;
      hoveredUrl = cleanHttpUrl(anchorFromTarget(event.target)?.href ?? "");
      scheduleEmit(true);
    },
    { capture: true, passive: true },
  );
  addEventListener(
    "pointerout",
    (event) => {
      if (!event.isTrusted) return;
      const nextAnchor = anchorFromTarget(event.relatedTarget);
      hoveredUrl = cleanHttpUrl(nextAnchor?.href ?? "");
      scheduleEmit(true);
    },
    { capture: true, passive: true },
  );
  addEventListener(
    "pointerdown",
    (event) => {
      if (!event.isTrusted) return;
      ipcRenderer.send(channels.closeExtensionPopup);
      if (event.button !== 0) return;
      clickedUrl = cleanHttpUrl(anchorFromTarget(event.target)?.href ?? "");
      if (clickedUrl) scheduleEmit(true);
    },
    { capture: true, passive: true },
  );
  addEventListener(
    "click",
    (event) => {
      if (!event.isTrusted) return;
      clickedUrl = cleanHttpUrl(anchorFromTarget(event.target)?.href ?? "");
      if (clickedUrl) scheduleEmit(true);
    },
    { capture: true, passive: true },
  );
  addEventListener("scroll", markGeometryDirty, {
    capture: true,
    passive: true,
  });
  addEventListener("resize", markGeometryDirty, { passive: true });
  addEventListener("pageshow", () => {
    markGeometryDirty();
    scheduleEmit(true);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      markGeometryDirty();
      scheduleEmit(true);
    }
  });
  new MutationObserver(() => {
    markGeometryDirty();
    scheduleSmartReaderContentChanged();
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["href", "src", "hidden", "aria-hidden"],
  });
  initializeYouTubePlaybackObserver();
  scheduleEmit(true);
}

function currentYouTubeVideoId(): string | null {
  try {
    if (
      location.protocol !== "https:" ||
      location.hostname !== "www.youtube.com" ||
      location.pathname !== "/watch"
    )
      return null;
    const id = new URL(location.href).searchParams.get("v") ?? "";
    return /^[A-Za-z0-9_-]{11}$/u.test(id) ? id : null;
  } catch {
    return null;
  }
}

function initializeYouTubePlaybackObserver(): void {
  const tick = () => {
    const videoId = currentYouTubeVideoId();
    const candidate = document.querySelector<HTMLVideoElement>(
      "video.html5-main-video",
    );
    if (videoId !== observationVideoId || candidate !== observedVideo) {
      observationVideoId = videoId;
      observedVideo = candidate;
      observedVideoLastTime = candidate?.currentTime ?? 0;
      observedPlaybackSeconds = 0;
      observationBucket = 0;
      return;
    }
    if (
      !videoId ||
      !candidate ||
      candidate.paused ||
      candidate.ended ||
      document.visibilityState !== "visible" ||
      window.top !== window
    ) {
      observedVideoLastTime = candidate?.currentTime ?? 0;
      return;
    }
    const nextTime = candidate.currentTime;
    const delta = nextTime - observedVideoLastTime;
    observedVideoLastTime = nextTime;
    if (delta <= 0 || delta > 3) return;
    observedPlaybackSeconds += delta;
    const nextBucket = Math.floor(observedPlaybackSeconds / 30);
    if (nextBucket <= observationBucket) return;
    observationBucket = nextBucket;
    ipcRenderer.send(channels.smartDownloadsPlayback, {
      observationId: `${Math.floor(performance.timeOrigin)}:${videoId}:${nextBucket}`,
      videoId,
      playbackSeconds: 30,
      occurredAt: Date.now(),
    });
  };
  const timer = window.setInterval(tick, 1_000);
  addEventListener("pagehide", () => window.clearInterval(timer), {
    once: true,
  });
}

ipcRenderer.on(channels.hyperdrivePrepareDocument, (_event, value: unknown) => {
  if (!value || typeof value !== "object") return;
  const request = value as Record<string, unknown>;
  if (
    typeof request.id !== "string" ||
    request.id.length > 128 ||
    typeof request.url !== "string"
  ) {
    return;
  }
  const url = cleanHttpUrl(request.url);
  if (!url || speculativeLinks.has(request.id)) return;
  const existing = [
    ...document.querySelectorAll<HTMLLinkElement>(
      "link[rel~='prefetch'][href]",
    ),
  ].some((link) => cleanHttpUrl(link.href) === url);
  if (existing) {
    ipcRenderer.send(channels.hyperdrivePreparationResult, {
      id: request.id,
      url,
      status: "duplicate",
    });
    return;
  }
  const link = document.createElement("link");
  link.rel = "prefetch";
  link.as = "document";
  link.href = url;
  link.referrerPolicy = "strict-origin-when-cross-origin";
  link.fetchPriority = "low";
  const finish = (status: "loaded" | "failed") => {
    ipcRenderer.send(channels.hyperdrivePreparationResult, {
      id: request.id,
      url,
      status,
    });
  };
  link.addEventListener("load", () => finish("loaded"), { once: true });
  link.addEventListener("error", () => finish("failed"), { once: true });
  speculativeLinks.set(request.id, link);
  document.head?.append(link);
});

ipcRenderer.on(channels.hyperdriveCancelDocument, (_event, id: unknown) => {
  if (typeof id !== "string") return;
  const link = speculativeLinks.get(id);
  if (!link) return;
  link.remove();
  speculativeLinks.delete(id);
});

ipcRenderer.on(channels.assistantStartSelection, (_event, value: unknown) => {
  if (!value || typeof value !== "object") return;
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "screenshot" || kind === "element")
    startAssistantSelection(kind);
});

ipcRenderer.on(channels.assistantCancelSelection, () => {
  clearAssistantSelection();
});

ipcRenderer.on(channels.smartReaderExtract, (_event, value: unknown) => {
  if (!value || typeof value !== "object" || window.top !== window) return;
  const candidate = value as Partial<SmartReaderExtractionRequest>;
  if (
    typeof candidate.requestId !== "string" ||
    candidate.requestId.length > 128 ||
    typeof candidate.expectedUrl !== "string" ||
    typeof candidate.revision !== "number" ||
    typeof candidate.force !== "boolean"
  ) {
    return;
  }
  const sourceUrl = location.href;
  const result: SmartReaderExtractionResult = {
    requestId: candidate.requestId,
    sourceUrl,
    revision: candidate.revision,
    available: false,
    article: null,
    error: null,
  };
  if (sourceUrl !== candidate.expectedUrl) {
    ipcRenderer.send(channels.smartReaderExtractionResult, result);
    return;
  }
  try {
    result.article = extractSmartReaderArticleFromDocument(
      document,
      sourceUrl,
      candidate.force,
    );
    result.available = result.article !== null;
  } catch (error) {
    result.error =
      error instanceof Error
        ? error.message.slice(0, 500)
        : "Extraction failed.";
  }
  ipcRenderer.send(channels.smartReaderExtractionResult, result);
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
} else {
  initialize();
}
