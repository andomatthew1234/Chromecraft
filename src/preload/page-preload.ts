import { ipcRenderer } from "electron";

import { channels } from "../shared/channels";

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

let candidates: LinkCandidate[] = [];
let geometryDirty = true;
let lastPointer: PointerSample | null = null;
let hoveredUrl: string | null = null;
let clickedUrl: string | null = null;
let lastEmitAt = 0;
let scheduled = false;
let geometryTimer: number | null = null;
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

function anchorFromTarget(
  target: EventTarget | null,
): HTMLAnchorElement | null {
  return target instanceof Element
    ? target.closest<HTMLAnchorElement>("a[href]")
    : null;
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
  new MutationObserver(markGeometryDirty).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href", "hidden", "aria-hidden"],
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

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
} else {
  initialize();
}
