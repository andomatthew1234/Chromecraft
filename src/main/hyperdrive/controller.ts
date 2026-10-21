import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { Session } from "electron";

import type {
  BrowserDataSnapshot,
  HyperdriveDestinationSnapshot,
  HyperdriveEventSnapshot,
  HyperdriveMode,
  HyperdriveOmniboxSignal,
  HyperdrivePredictionTrigger,
  HyperdrivePreparationState,
  HyperdriveSnapshot,
} from "../../shared/browser";
import { isAllowedWebUrl } from "../../shared/navigation";
import type { PreferencesStore } from "../preferences";
import { rankCursorIntent } from "./cursor-intent";
import { resolveSiteCandidateUrl } from "./adapters";
import { HyperdriveOutcomeLearner } from "./learner";
import type {
  LinkCandidate,
  PointSample,
  PredictionTrigger,
  RankedPrediction,
} from "./model";
import { HyperdrivePredictionEngine } from "./predictor";

const MAX_PAGE_CANDIDATES = 80;
const MAX_RAW_PAGE_CANDIDATES = 320;
const MAX_MONITOR_DESTINATIONS = 16;
const MAX_MONITOR_EVENTS = 120;
const MAX_URL_LENGTH = 8_192;
const EMIT_DELAY_MS = 90;
const MEMORY_POLL_MS = 2_000;
const ENTRY_TTL_MS = 30_000;
const LEARNING_WRITE_DELAY_MS = 500;
const SEARCH_SETTLE_DELAY_MS = 550;
const POINTER_DEPRIORITISE_GRACE_MS = 650;

interface HyperdriveNetwork {
  preconnect(url: string, sockets: number): void;
}

interface InternalDestination {
  id: string;
  tabId: string;
  url: string;
  title: string;
  confidence: number;
  trigger: HyperdrivePredictionTrigger;
  modelTrigger: PredictionTrigger;
  state: HyperdrivePreparationState;
  preparation: "none" | "preconnect" | "document-prefetch";
  source: "pointer" | "omnibox";
  adapter: string | null;
  estimatedBytes: number | null;
  startedAt: number;
  updatedAt: number;
  ready: boolean;
  reused: boolean;
  reuseEvidence: "none" | "navigation-transfer-size-zero";
  cacheEligible: boolean;
  prefetchOwned: boolean;
  prefetchCompletedAt: number | null;
  crossSite: boolean;
  reason: string;
  search: boolean;
}

interface CleanPageSignals {
  pointer: PointSample | null;
  hoveredUrl: string | null;
  clickedUrl: string | null;
  candidates: LinkCandidate[];
}

interface NavigationRecord {
  url: string;
  destinationUrl: string | null;
  destinationId: string | null;
  startedAt: number;
  fromCache: boolean;
  clicked: boolean;
}

interface HyperdriveControllerOptions {
  learningFilePath: string;
  emit: (snapshot: HyperdriveSnapshot) => void;
  network?: HyperdriveNetwork;
  prepareDocument?: (
    tabId: string,
    request: { id: string; url: string },
  ) => void;
  cancelDocument?: (tabId: string, id: string) => void;
  canPrepare?: () => boolean;
  now?: () => number;
  availableMemoryBytes?: () => number;
  totalMemoryBytes?: () => number;
}

function canonicalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href.length <= MAX_URL_LENGTH ? url.href : null;
  } catch {
    return null;
  }
}

function cleanHost(value: string): string {
  return value.toLowerCase().replace(/^www\./, "");
}

function sameHost(left: string, right: string): boolean {
  try {
    return (
      cleanHost(new URL(left).hostname) === cleanHost(new URL(right).hostname)
    );
  } catch {
    return false;
  }
}

function displayUrl(value: string): string {
  try {
    const url = new URL(value);
    const host = cleanHost(url.hostname);
    if (/^(?:accounts|auth|login)\./i.test(host)) return host;
    if (
      (host === "chatgpt.com" || host === "chat.openai.com") &&
      /^\/(?:c|g|share)\//i.test(url.pathname)
    ) {
      return `${host}/private`;
    }
    const pathLabel = url.pathname === "/" ? "" : url.pathname.slice(0, 80);
    return `${host}${pathLabel}`;
  } catch {
    return value.slice(0, 120);
  }
}

function mapTrigger(trigger: PredictionTrigger): HyperdrivePredictionTrigger {
  return trigger === "cursor-trajectory" ? "pointer-trajectory" : trigger;
}

function finiteNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}

function electronSystemMemory(): {
  totalBytes: number;
  availableBytes: number;
} {
  const electronProcess = process as typeof process & {
    getSystemMemoryInfo?: () => {
      total: number;
      free: number;
      available?: number;
    };
  };
  const info = electronProcess.getSystemMemoryInfo?.();
  if (!info) {
    return { totalBytes: os.totalmem(), availableBytes: os.freemem() };
  }
  const availableKb =
    process.platform === "linux" && typeof info.available === "number"
      ? info.available
      : info.free;
  return {
    totalBytes: info.total * 1024,
    availableBytes: availableKb * 1024,
  };
}

function normalizePageSignals(
  value: unknown,
  now: number,
): CleanPageSignals | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const rawCandidates = Array.isArray(record.candidates)
    ? record.candidates.slice(0, MAX_RAW_PAGE_CANDIDATES)
    : [];
  const candidates: LinkCandidate[] = [];
  const seenCandidateUrls = new Set<string>();
  for (let index = 0; index < rawCandidates.length; index += 1) {
    const raw = rawCandidates[index];
    if (!raw || typeof raw !== "object") continue;
    const candidate = raw as Record<string, unknown>;
    const url =
      typeof candidate.url === "string" ? canonicalUrl(candidate.url) : null;
    const left = finiteNumber(candidate.left, -10_000, 100_000);
    const top = finiteNumber(candidate.top, -10_000, 100_000);
    const right = finiteNumber(candidate.right, -10_000, 100_000);
    const bottom = finiteNumber(candidate.bottom, -10_000, 100_000);
    if (
      !url ||
      left === null ||
      top === null ||
      right === null ||
      bottom === null ||
      right <= left ||
      bottom <= top
    ) {
      continue;
    }
    if (seenCandidateUrls.has(url)) continue;
    seenCandidateUrls.add(url);
    candidates.push({
      id: `${index}:${url}`,
      url,
      title:
        typeof candidate.title === "string"
          ? candidate.title.trim().slice(0, 240)
          : undefined,
      rect: { left, top, right, bottom },
      visible: true,
      source: "page",
      alreadySpeculated: candidate.alreadySpeculated === true,
    });
    if (candidates.length >= MAX_PAGE_CANDIDATES) break;
  }
  const rawPointer = record.pointer;
  let pointer: PointSample | null = null;
  if (rawPointer && typeof rawPointer === "object") {
    const point = rawPointer as Record<string, unknown>;
    const x = finiteNumber(point.x, -10_000, 100_000);
    const y = finiteNumber(point.y, -10_000, 100_000);
    if (x !== null && y !== null) pointer = { x, y, timeMs: now };
  }
  return {
    pointer,
    hoveredUrl:
      typeof record.hoveredUrl === "string"
        ? canonicalUrl(record.hoveredUrl)
        : null,
    clickedUrl:
      typeof record.clickedUrl === "string"
        ? canonicalUrl(record.clickedUrl)
        : null,
    candidates,
  };
}

function modeConcurrency(mode: HyperdriveMode): number {
  if (mode === "balanced") return 1;
  if (mode === "aggressive") return 2;
  if (mode === "maximum") return 3;
  return 0;
}

function omniboxTier(
  mode: HyperdriveMode,
  confidence: number,
): RankedPrediction["preparationTier"] {
  if (mode === "off") return "none";
  const thresholds =
    mode === "balanced"
      ? { connection: 0.38, prefetch: 0.82 }
      : mode === "aggressive"
        ? { connection: 0.25, prefetch: 0.67 }
        : { connection: 0.15, prefetch: 0.52 };
  if (confidence >= thresholds.prefetch) return "prefetch";
  if (confidence >= thresholds.connection) return "connection";
  return "none";
}

/**
 * Main-process Hyperdrive module. Its small interface accepts sanitized intent and
 * navigation outcomes; prediction, policy, scheduling, learning and monitoring stay
 * inside the implementation.
 */
export class HyperdriveController {
  private readonly entries = new Map<string, InternalDestination>();
  private readonly events: HyperdriveEventSnapshot[] = [];
  private readonly pointerSamples = new Map<string, PointSample[]>();
  private readonly previousPointerWinner = new Map<string, string>();
  private readonly hoverStartedAt = new Map<
    string,
    { url: string; at: number }
  >();
  private readonly activeFetches = new Map<string, string>();
  private readonly preparationTimeouts = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly searchPrefetchTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly warmedOrigins = new Map<string, number>();
  private readonly navigationByTab = new Map<string, NavigationRecord>();
  private readonly trustedClicks = new Map<
    string,
    { url: string; navigationUrl: string; timestamp: number }
  >();
  private readonly visitCounts = new Map<string, number>();
  private readonly network: HyperdriveNetwork;
  private readonly now: () => number;
  private readonly availableMemoryBytes: () => number;
  private readonly totalMemoryBytes: () => number;
  private learner = new HyperdriveOutcomeLearner();
  private activeTabId = "";
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private memoryTimer: ReturnType<typeof setInterval> | null = null;
  private learningTimer: ReturnType<typeof setTimeout> | null = null;
  private learningWriteQueue: Promise<void> = Promise.resolve();
  private learningWriteCounter = 0;
  private initialized = false;
  private disposed = false;
  private paused = false;
  private memoryPressure = false;
  private processPrivateMemoryBytes: number | null = null;
  private activePrefetches = 0;
  private observedSpeculativeBytes: number | null = null;
  private estimatedSpeculativeMemoryBytes = 0;
  private successfulPredictions = 0;
  private missedPredictions = 0;
  private cancelledPreloads = 0;
  private wastedPreparations = 0;
  private cacheReuseSuccesses = 0;
  private rankingTimeMs = 0;
  private predictionsEvaluated = 0;
  private navigationTimeSavedMs: number | null = null;

  constructor(
    private readonly browserSession: Session,
    private readonly preferences: PreferencesStore,
    private readonly options: HyperdriveControllerOptions,
  ) {
    this.network =
      options.network ??
      ({
        preconnect: (url, sockets) =>
          this.browserSession.preconnect({ url, numSockets: sockets }),
      } satisfies HyperdriveNetwork);
    this.now = options.now ?? performance.now.bind(performance);
    this.availableMemoryBytes =
      options.availableMemoryBytes ??
      (() => electronSystemMemory().availableBytes);
    this.totalMemoryBytes =
      options.totalMemoryBytes ?? (() => electronSystemMemory().totalBytes);
  }

  async initialize(): Promise<void> {
    try {
      const raw = await fs.readFile(this.options.learningFilePath, "utf8");
      this.learner = new HyperdriveOutcomeLearner(JSON.parse(raw) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("Could not read Hyperdrive learning data.", error);
      }
    }
    this.memoryTimer = setInterval(
      () => this.checkMemoryPressure(),
      MEMORY_POLL_MS,
    );
    this.initialized = true;
    this.checkMemoryPressure();
    this.scheduleEmit();
  }

  get snapshot(): HyperdriveSnapshot {
    const now = this.now();
    const mode = this.preferences.snapshot.hyperdriveMode;
    const retainedEntries = [...this.entries.values()].filter(
      (entry) => now - entry.updatedAt <= ENTRY_TTL_MS,
    );
    const destinations = retainedEntries
      .sort(
        (left, right) =>
          Number(right.source === "omnibox") -
            Number(left.source === "omnibox") ||
          right.confidence - left.confidence ||
          right.updatedAt - left.updatedAt,
      )
      .slice(0, MAX_MONITOR_DESTINATIONS)
      .map((entry): HyperdriveDestinationSnapshot => {
        const url = new URL(entry.url);
        return {
          id: entry.id,
          title: entry.title,
          displayUrl: displayUrl(entry.url),
          host: cleanHost(url.hostname),
          confidence: entry.confidence,
          trigger: entry.trigger,
          state: entry.state,
          preparation: entry.preparation,
          source: entry.source,
          adapter: entry.adapter,
          estimatedBytes: entry.estimatedBytes,
          elapsedMs: Math.max(0, now - entry.startedAt),
          ready: entry.ready,
          reused: entry.reused,
          reuseEvidence: entry.reuseEvidence,
          reason: entry.reason,
        };
      });
    const activeStates = new Set<HyperdrivePreparationState>([
      "queued",
      "connecting",
      "prefetching",
      "preparing-page",
    ]);
    return {
      status:
        mode === "off"
          ? "off"
          : this.memoryPressure
            ? "memory-pressure"
            : retainedEntries.some((entry) => activeStates.has(entry.state))
              ? "predicting"
              : "idle",
      mode,
      ramBudgetMb: this.preferences.snapshot.hyperdriveRamBudgetMb,
      availableMemoryMb: Math.round(this.availableMemoryBytes() / 1024 / 1024),
      totalMemoryMb: Math.round(this.totalMemoryBytes() / 1024 / 1024),
      paused: this.paused,
      monitorOpen: this.preferences.snapshot.hyperdriveMonitorOpen,
      warning: this.memoryPressure
        ? "Speculation paused because available system memory is low."
        : mode === "off"
          ? "Hyperdrive is opt-in and currently off."
          : null,
      metrics: {
        activePredictions: retainedEntries.filter((entry) =>
          activeStates.has(entry.state),
        ).length,
        activePreloads: this.activePrefetches,
        preparedDestinations: retainedEntries.filter(
          (entry) =>
            entry.state === "prefetched" ||
            entry.state === "cache-reused" ||
            entry.ready,
        ).length,
        cacheReuseSuccesses: this.cacheReuseSuccesses,
        successfulPredictions: this.successfulPredictions,
        missedPredictions: this.missedPredictions,
        cancelledPreloads: this.cancelledPreloads,
        wastedPreparations: this.wastedPreparations,
        observedSpeculativeBytes: this.observedSpeculativeBytes,
        estimatedSpeculativeMemoryBytes: this.estimatedSpeculativeMemoryBytes,
        processPrivateMemoryBytes: this.processPrivateMemoryBytes,
        navigationTimeSavedMs: this.navigationTimeSavedMs,
        rankingTimeMs: this.rankingTimeMs,
        predictionsEvaluated: this.predictionsEvaluated,
      },
      destinations,
      events: this.events.slice(0, MAX_MONITOR_EVENTS),
    };
  }

  setBrowserData(data: BrowserDataSnapshot): void {
    this.visitCounts.clear();
    for (const entry of data.history) {
      const url = canonicalUrl(entry.url);
      if (url) this.visitCounts.set(url, (this.visitCounts.get(url) ?? 0) + 1);
    }
  }

  setActiveTab(tabId: string): void {
    const previousTabId = this.activeTabId;
    this.activeTabId = tabId;
    if (!previousTabId || previousTabId === tabId) return;
    for (const entry of this.entries.values()) {
      if (
        entry.tabId === previousTabId &&
        (entry.state === "queued" ||
          entry.state === "connecting" ||
          entry.state === "prefetching")
      ) {
        this.cancelEntry(entry, "Deprioritised after switching tabs");
      }
    }
    this.scheduleEmit();
  }

  updatePageSignals(tabId: string, currentUrl: string, value: unknown): void {
    if (
      this.disposed ||
      tabId !== this.activeTabId ||
      this.preferences.snapshot.hyperdriveMode === "off" ||
      this.memoryPressure ||
      !isAllowedWebUrl(currentUrl)
    ) {
      return;
    }
    const now = this.now();
    const signals = normalizePageSignals(value, now);
    if (!signals) return;
    const rawHoveredUrl = signals.hoveredUrl;
    const rawClickedUrl = signals.clickedUrl;
    signals.hoveredUrl = rawHoveredUrl
      ? canonicalUrl(resolveSiteCandidateUrl(currentUrl, rawHoveredUrl))
      : null;
    signals.clickedUrl = rawClickedUrl
      ? canonicalUrl(resolveSiteCandidateUrl(currentUrl, rawClickedUrl))
      : null;
    for (const candidate of signals.candidates) {
      candidate.url = resolveSiteCandidateUrl(currentUrl, candidate.url);
    }
    if (!signals.pointer && !this.pointerSamples.has(tabId)) return;
    if (signals.clickedUrl && rawClickedUrl) {
      this.trustedClicks.set(tabId, {
        url: signals.clickedUrl,
        navigationUrl: rawClickedUrl,
        timestamp: now,
      });
    }
    const samples = this.pointerSamples.get(tabId) ?? [];
    if (signals.pointer) {
      samples.push(signals.pointer);
      while (samples.length > 4) samples.shift();
      this.pointerSamples.set(tabId, samples);
    }
    let hoverDurationMs = 0;
    if (signals.hoveredUrl) {
      const previous = this.hoverStartedAt.get(tabId);
      if (!previous || previous.url !== signals.hoveredUrl) {
        this.hoverStartedAt.set(tabId, { url: signals.hoveredUrl, at: now });
      } else {
        hoverDurationMs = now - previous.at;
      }
    } else {
      this.hoverStartedAt.delete(tabId);
    }
    for (const candidate of signals.candidates) {
      candidate.visitCount = this.visitCounts.get(candidate.url) ?? 0;
    }
    const hoverCandidateId = signals.candidates.find(
      (candidate) => candidate.url === signals.hoveredUrl,
    )?.id;
    const cursor = rankCursorIntent({
      samples,
      candidates: signals.candidates,
      hoverCandidateId,
      hoverDurationMs,
      previousWinnerId: this.previousPointerWinner.get(tabId),
    });
    if (cursor.winnerId) this.previousPointerWinner.set(tabId, cursor.winnerId);
    const batch = new HyperdrivePredictionEngine({
      mode: this.preferences.snapshot.hyperdriveMode,
      learner: this.learner,
      policy: {
        allowCrossSite:
          this.preferences.snapshot.hyperdriveCrossSitePreloadingEnabled,
        disabledHosts: this.preferences.snapshot.hyperdriveExcludedHosts,
      },
      maxPredictions:
        this.preferences.snapshot.hyperdriveMode === "balanced" ? 3 : 6,
    }).rank({
      currentUrl,
      candidates: signals.candidates,
      pointerIntent: cursor.ranked,
    });
    this.applyPredictionBatch(tabId, currentUrl, batch.predictions, "pointer");
    this.rankingTimeMs = batch.rankingTimeMs;
    this.predictionsEvaluated += batch.considered;
    this.scheduleEmit();
  }

  updateOmnibox(signal: HyperdriveOmniboxSignal, currentUrl: string): void {
    if (
      this.disposed ||
      signal.tabId !== this.activeTabId ||
      this.preferences.snapshot.hyperdriveMode === "off" ||
      this.memoryPressure
    ) {
      return;
    }
    const destination = signal.destination
      ? canonicalUrl(signal.destination)
      : null;
    if (
      !destination ||
      signal.input.length > 2_048 ||
      signal.title.length > 240
    )
      return;
    const trigger: PredictionTrigger =
      signal.trigger === "search-suggestion"
        ? "omnibox-selection"
        : signal.trigger;
    const batch = new HyperdrivePredictionEngine({
      mode: this.preferences.snapshot.hyperdriveMode,
      learner: this.learner,
      policy: {
        // A typed or selected destination is a direct user-intent signal. Cross-site
        // document fetching is still capped to connection-only below unless enabled.
        allowCrossSite: true,
        disabledHosts: this.preferences.snapshot.hyperdriveExcludedHosts,
      },
      maxPredictions: 1,
    }).rank({
      currentUrl: isAllowedWebUrl(currentUrl) ? currentUrl : destination,
      candidates: [
        {
          id: `omnibox:${destination}`,
          url: destination,
          title: signal.title.slice(0, 240),
          visible: true,
          selected: signal.trigger === "omnibox-selection",
          source: "omnibox",
          trigger,
          visitCount: this.visitCounts.get(destination) ?? 0,
        },
      ],
    });
    const prediction = batch.predictions[0];
    if (!prediction) return;
    prediction.confidence = Math.max(
      prediction.confidence,
      Math.min(1, Math.max(0, signal.confidence)),
    );
    prediction.preparationTier = omniboxTier(
      this.preferences.snapshot.hyperdriveMode,
      prediction.confidence,
    );
    this.applyPredictionBatch(
      signal.tabId,
      currentUrl,
      [prediction],
      "omnibox",
      {
        search: signal.search,
        trigger: signal.trigger,
      },
    );
    this.rankingTimeMs = batch.rankingTimeMs;
    this.predictionsEvaluated += 1;
    this.scheduleEmit();
  }

  navigationStarted(tabId: string, urlValue: string): void {
    const url = canonicalUrl(urlValue);
    if (!url) return;
    const click = this.trustedClicks.get(tabId);
    const clickedDestinationUrl =
      click &&
      this.now() - click.timestamp < 1_500 &&
      (click.navigationUrl === url || click.url === url)
        ? click.url
        : url;
    const matchingDestination = this.entries.get(clickedDestinationUrl);
    const destination =
      matchingDestination?.tabId === tabId ? matchingDestination : undefined;
    const clicked = Boolean(
      destination?.source === "omnibox" ||
      (click &&
        (click.navigationUrl === url || click.url === url) &&
        this.now() - click.timestamp < 1_500),
    );
    for (const entry of this.entries.values()) {
      if (
        entry.tabId === tabId &&
        entry.url !== clickedDestinationUrl &&
        entry.state !== "cancelled" &&
        entry.state !== "failed" &&
        entry.state !== "evicted"
      ) {
        this.recordOutcome(entry, false, false);
        if (
          entry.state === "prefetched" ||
          entry.ready ||
          entry.estimatedBytes
        ) {
          this.wastedPreparations += 1;
        }
        this.cancelEntry(entry, "Navigation chose another destination");
        this.entries.delete(entry.url);
      }
    }
    if (destination) {
      destination.updatedAt = this.now();
      destination.reason =
        destination.state === "prefetched"
          ? "Navigation started; verifying whether the prefetched document is reused."
          : "Navigation matched a predicted destination.";
      this.addEvent(destination, "Navigation matched a predicted destination");
    } else if (clicked && this.preferences.snapshot.hyperdriveMode !== "off") {
      this.missedPredictions += 1;
    }
    this.trustedClicks.delete(tabId);
    if (destination && this.activeFetches.has(destination.url)) {
      this.cancelActivePrefetch(destination);
      this.cancelledPreloads += 1;
      destination.state = "not-reused";
      destination.reused = false;
      destination.reuseEvidence = "none";
      destination.reason =
        "Navigation began before document prefetch completed.";
      this.addEvent(destination, destination.reason, true);
    }
    this.navigationByTab.set(tabId, {
      url,
      destinationUrl: destination?.url ?? null,
      destinationId: destination?.id ?? null,
      startedAt: this.now(),
      fromCache: false,
      clicked,
    });
    this.scheduleEmit();
  }

  navigationRedirected(tabId: string, urlValue: string): void {
    const navigation = this.navigationByTab.get(tabId);
    const url = canonicalUrl(urlValue);
    if (!navigation || !url) return;
    navigation.url = url;
    const destination = navigation.destinationUrl
      ? this.entries.get(navigation.destinationUrl)
      : undefined;
    if (destination?.id === navigation.destinationId) {
      destination.reason =
        url === destination.url
          ? "Redirect reached the prepared destination; verifying cache reuse."
          : "Navigation redirected; the prepared destination no longer matches.";
      destination.updatedAt = this.now();
      this.addEvent(destination, destination.reason);
    }
    this.scheduleEmit();
  }

  navigationFailed(tabId: string, urlValue: string, reason: string): void {
    const navigation = this.navigationByTab.get(tabId);
    const url = canonicalUrl(urlValue);
    if (
      !navigation ||
      !url ||
      (navigation.url !== url && navigation.destinationUrl !== url)
    ) {
      return;
    }
    const destination = navigation.destinationUrl
      ? this.entries.get(navigation.destinationUrl)
      : undefined;
    if (destination?.id === navigation.destinationId) {
      destination.state = destination.prefetchOwned ? "not-reused" : "failed";
      destination.reused = false;
      destination.reuseEvidence = "none";
      destination.updatedAt = this.now();
      destination.reason = `Navigation failed after preparation: ${reason.slice(0, 160)}`;
      this.addEvent(destination, destination.reason, true);
      this.recordOutcome(destination, navigation.clicked, false);
    }
    this.navigationByTab.delete(tabId);
    this.scheduleEmit();
  }

  navigationFinished(tabId: string, urlValue: string): void {
    const navigation = this.navigationByTab.get(tabId);
    const url = canonicalUrl(urlValue);
    if (!navigation || !url || navigation.url !== url) return;
    const matchingDestination = this.entries.get(url);
    const destination =
      matchingDestination?.tabId === tabId &&
      matchingDestination.id === navigation.destinationId
        ? matchingDestination
        : undefined;
    if (destination) {
      destination.reused =
        destination.prefetchOwned &&
        destination.prefetchCompletedAt !== null &&
        destination.prefetchCompletedAt <= navigation.startedAt &&
        destination.preparation === "document-prefetch" &&
        navigation.fromCache;
      destination.updatedAt = this.now();
      if (destination.reused) {
        destination.state = "cache-reused";
        destination.reuseEvidence = "navigation-transfer-size-zero";
        destination.reason =
          "Cache reuse confirmed by the destination navigation.";
        this.cacheReuseSuccesses += 1;
        this.addEvent(destination, "Navigation reused Chromium's HTTP cache");
      } else if (
        destination.prefetchOwned &&
        destination.prefetchCompletedAt !== null &&
        destination.preparation === "document-prefetch"
      ) {
        destination.state = "not-reused";
        destination.reuseEvidence = "none";
        destination.reason =
          "Preparation not reused; navigation transferred the document.";
        this.addEvent(destination, destination.reason, true);
      }
      if (navigation.clicked) this.successfulPredictions += 1;
      this.recordOutcome(destination, navigation.clicked, destination.reused);
    }
    // A paired, controlled benchmark is required before claiming time saved. Live
    // navigation alone has no valid counterfactual, so this deliberately stays null.
    this.navigationTimeSavedMs = null;
    this.navigationByTab.delete(tabId);
    this.scheduleEmit();
  }

  refreshPreparationReadiness(): void {
    if (
      this.disposed ||
      (this.options.canPrepare && !this.options.canPrepare())
    ) {
      return;
    }
    for (const entry of this.entries.values()) {
      if (entry.state === "queued" && entry.preparation === "preconnect") {
        this.preconnect(entry);
      }
    }
    this.drainPrefetchQueue();
  }

  noteNavigationTiming(
    tabId: string,
    urlValue: string,
    timing: { transferSize: number; activationStart: number },
  ): void {
    const navigation = this.navigationByTab.get(tabId);
    const url = canonicalUrl(urlValue);
    if (!navigation || !url || navigation.url !== url) return;
    if (
      Number.isFinite(timing.transferSize) &&
      timing.transferSize === 0 &&
      this.entries.get(url)?.tabId === tabId &&
      this.entries.get(url)?.id === navigation.destinationId &&
      this.entries.get(url)?.preparation === "document-prefetch" &&
      this.entries.get(url)?.prefetchOwned === true &&
      this.entries.get(url)?.prefetchCompletedAt !== null &&
      (this.entries.get(url)?.prefetchCompletedAt ??
        Number.POSITIVE_INFINITY) <= navigation.startedAt
    ) {
      navigation.fromCache = true;
    }
    // Electron 44 rejects WebContentsView prerendering. A future non-zero value is
    // captured for diagnostics but does not silently enable Tier 3.
    if (timing.activationStart > 0) {
      this.addEvent(
        this.entries.get(url)?.tabId === tabId
          ? (this.entries.get(url) ?? null)
          : null,
        "A native prerender activation was observed; Tier 3 remains gated",
      );
    }
  }

  cancelTab(tabId: string): void {
    const searchTimer = this.searchPrefetchTimers.get(tabId);
    if (searchTimer) clearTimeout(searchTimer);
    this.searchPrefetchTimers.delete(tabId);
    for (const entry of this.entries.values()) {
      if (entry.tabId === tabId) {
        this.cancelEntry(entry, "Tab closed or replaced", true);
        this.entries.delete(entry.url);
      }
    }
    this.pointerSamples.delete(tabId);
    this.previousPointerWinner.delete(tabId);
    this.hoverStartedAt.delete(tabId);
    this.trustedClicks.delete(tabId);
    this.navigationByTab.delete(tabId);
    this.scheduleEmit();
  }

  handlePreparationResult(tabId: string, value: unknown): void {
    if (!value || typeof value !== "object") return;
    const result = value as Record<string, unknown>;
    if (
      typeof result.id !== "string" ||
      typeof result.url !== "string" ||
      !["loaded", "failed", "duplicate"].includes(String(result.status))
    ) {
      return;
    }
    const url = canonicalUrl(result.url);
    const entry = url ? this.entries.get(url) : undefined;
    if (
      !entry ||
      entry.tabId !== tabId ||
      entry.id !== result.id ||
      this.activeFetches.get(entry.url) !== entry.id
    ) {
      return;
    }
    this.finishActivePrefetch(entry);
    if (result.status === "failed") {
      this.options.cancelDocument?.(entry.tabId, entry.id);
      entry.state = "failed";
      entry.ready = false;
      entry.reason = "The page declined or failed the prefetch hint";
      this.addEvent(entry, entry.reason, true);
    } else if (result.status === "duplicate") {
      entry.state = "deduplicated";
      entry.preparation = "none";
      entry.ready = false;
      entry.cacheEligible = false;
      entry.prefetchOwned = false;
      entry.prefetchCompletedAt = null;
      entry.reason =
        "The page already had an equivalent prefetch; Hyperdrive cannot claim it.";
      this.addEvent(entry, entry.reason);
    } else {
      entry.state = "prefetched";
      entry.ready = false;
      entry.cacheEligible = false;
      entry.prefetchOwned = true;
      entry.prefetchCompletedAt = this.now();
      entry.reason =
        "Document prefetched; navigation reuse has not yet been proven.";
      this.addEvent(entry, entry.reason);
    }
    entry.updatedAt = this.now();
    this.drainPrefetchQueue();
    this.scheduleEmit();
  }

  async setMode(mode: HyperdriveMode): Promise<void> {
    await this.preferences.setHyperdriveMode(mode);
    if (mode === "off") this.clearSpeculation("Hyperdrive disabled");
    this.addEvent(null, `Performance mode changed to ${mode}`);
    this.scheduleEmit(true);
  }

  async setRamBudgetMb(megabytes: number): Promise<void> {
    await this.preferences.setHyperdriveRamBudgetMb(megabytes);
    this.enforceBudget();
    this.scheduleEmit(true);
  }

  async setCrossSiteEnabled(enabled: boolean): Promise<void> {
    await this.preferences.setHyperdriveCrossSitePreloadingEnabled(enabled);
    if (!enabled) this.cancelCrossSiteWork();
    this.scheduleEmit(true);
  }

  async setSearchPreloadingEnabled(enabled: boolean): Promise<void> {
    await this.preferences.setHyperdriveSearchPreloadingEnabled(enabled);
    if (!enabled) {
      for (const timer of this.searchPrefetchTimers.values())
        clearTimeout(timer);
      this.searchPrefetchTimers.clear();
      for (const entry of this.entries.values()) {
        if (entry.search) this.cancelEntry(entry, "Search preloading disabled");
      }
    }
    this.scheduleEmit(true);
  }

  async setExcludedHosts(hosts: string[]): Promise<void> {
    await this.preferences.setHyperdriveExcludedHosts(hosts);
    for (const entry of this.entries.values()) {
      if (hosts.some((host) => sameHost(entry.url, `https://${host}`))) {
        this.cancelEntry(entry, "Site excluded");
      }
    }
    this.scheduleEmit(true);
  }

  async setMonitorOpen(open: boolean): Promise<void> {
    await this.preferences.setHyperdriveMonitorOpen(open);
    this.scheduleEmit(true);
  }

  setMonitorPaused(paused: boolean): void {
    this.paused = paused;
    this.scheduleEmit(true);
  }

  clearEvents(): void {
    this.events.length = 0;
    this.scheduleEmit(true);
  }

  clearSpeculation(reason = "Cleared by user"): void {
    for (const timer of this.searchPrefetchTimers.values()) clearTimeout(timer);
    this.searchPrefetchTimers.clear();
    for (const entry of this.entries.values()) {
      if (
        entry.preparation === "document-prefetch" &&
        !this.activeFetches.has(entry.url)
      ) {
        this.options.cancelDocument?.(entry.tabId, entry.id);
      }
      this.cancelEntry(entry, reason, true);
    }
    this.entries.clear();
    this.estimatedSpeculativeMemoryBytes = 0;
    this.addEvent(null, reason);
    this.scheduleEmit(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearSpeculation("Hyperdrive stopped");
    if (this.emitTimer) clearTimeout(this.emitTimer);
    if (this.memoryTimer) clearInterval(this.memoryTimer);
    if (this.learningTimer) clearTimeout(this.learningTimer);
    this.emitTimer = null;
    this.memoryTimer = null;
    this.learningTimer = null;
    if (this.initialized) void this.persistLearning();
  }

  private applyPredictionBatch(
    tabId: string,
    currentUrl: string,
    predictions: readonly RankedPrediction[],
    source: "pointer" | "omnibox",
    override?: { search: boolean; trigger: HyperdrivePredictionTrigger },
  ): void {
    const currentUrls = new Set(
      predictions.map((prediction) => prediction.url),
    );
    if (source === "pointer") {
      for (const entry of this.entries.values()) {
        if (
          entry.source === "pointer" &&
          entry.tabId === tabId &&
          !currentUrls.has(entry.url) &&
          entry.state !== "prefetched" &&
          entry.state !== "activated" &&
          this.now() - entry.updatedAt > POINTER_DEPRIORITISE_GRACE_MS
        ) {
          if (entry.preparation === "none") {
            this.entries.delete(entry.url);
          } else if (entry.preparation === "document-prefetch") {
            this.cancelEntry(entry, "Pointer intent changed");
          }
        }
      }
    } else {
      const searchTimer = this.searchPrefetchTimers.get(tabId);
      if (searchTimer) clearTimeout(searchTimer);
      this.searchPrefetchTimers.delete(tabId);
      for (const entry of this.entries.values()) {
        if (
          entry.source === "omnibox" &&
          entry.tabId === tabId &&
          !currentUrls.has(entry.url) &&
          entry.state !== "prefetched" &&
          entry.state !== "activated"
        ) {
          if (entry.preparation === "document-prefetch") {
            this.cancelEntry(entry, "Omnibox prediction superseded");
          }
          this.entries.delete(entry.url);
        }
      }
    }

    for (const prediction of predictions) {
      const now = this.now();
      const previousEntry = this.entries.get(prediction.url);
      const existing =
        previousEntry?.tabId === tabId ? previousEntry : undefined;
      const wasBlocked = existing?.state === "blocked";
      if (previousEntry && !existing) {
        if (
          previousEntry.preparation === "document-prefetch" &&
          !this.activeFetches.has(previousEntry.url)
        ) {
          this.options.cancelDocument?.(previousEntry.tabId, previousEntry.id);
        }
        this.cancelEntry(previousEntry, "Prediction moved to the active tab");
      }
      const trigger = override?.trigger ?? mapTrigger(prediction.trigger);
      const entry: InternalDestination = existing ?? {
        id: randomUUID(),
        tabId,
        url: prediction.url,
        title: prediction.title,
        confidence: prediction.confidence,
        trigger,
        modelTrigger: prediction.trigger,
        state: "predicted",
        preparation: "none",
        source,
        adapter:
          prediction.adapter.adapterId === "generic"
            ? null
            : prediction.adapter.adapterId,
        estimatedBytes: null,
        startedAt: now,
        updatedAt: now,
        ready: false,
        reused: false,
        reuseEvidence: "none",
        cacheEligible: false,
        prefetchOwned: false,
        prefetchCompletedAt: null,
        crossSite:
          !isAllowedWebUrl(currentUrl) || !sameHost(currentUrl, prediction.url),
        reason: prediction.reasons.join(" · ") || "Ranked destination",
        search: override?.search ?? false,
      };
      entry.tabId = tabId;
      entry.title = prediction.title;
      entry.confidence = prediction.confidence;
      entry.trigger = trigger;
      entry.modelTrigger = prediction.trigger;
      entry.source = source;
      entry.adapter =
        prediction.adapter.adapterId === "generic"
          ? null
          : prediction.adapter.adapterId;
      entry.reason = prediction.reasons.join(" · ") || "Ranked destination";
      entry.search = override?.search ?? false;
      entry.crossSite =
        !isAllowedWebUrl(currentUrl) || !sameHost(currentUrl, entry.url);
      entry.updatedAt = now;
      if (entry.state === "blocked") entry.state = "predicted";
      this.entries.set(entry.url, entry);

      let tier = prediction.preparationTier;
      if (
        entry.crossSite &&
        !this.preferences.snapshot.hyperdriveCrossSitePreloadingEnabled
      ) {
        tier = "none";
        entry.state = "blocked";
        entry.preparation = "none";
        entry.reason = "Cross-site preparation blocked by privacy settings.";
        if (!wasBlocked) this.addEvent(entry, entry.reason, true);
      } else if (
        entry.search &&
        !this.preferences.snapshot.hyperdriveSearchPreloadingEnabled
      ) {
        tier = "connection";
      }
      if (
        tier === "prefetch" &&
        entry.search &&
        entry.trigger !== "omnibox-selection"
      ) {
        this.scheduleSettledSearchPrefetch(entry);
      } else if (tier === "prefetch") this.queuePrefetch(entry);
      else if (tier === "connection") this.preconnect(entry);
    }
    this.pruneEntries();
  }

  private preconnect(entry: InternalDestination): void {
    if (
      entry.state === "ready" ||
      entry.state === "prefetching" ||
      entry.preparation === "preconnect"
    ) {
      return;
    }
    entry.preparation = "preconnect";
    if (this.options.canPrepare && !this.options.canPrepare()) {
      entry.state = "queued";
      entry.reason = "Waiting for content protection to become ready";
      setTimeout(() => {
        if (
          !this.disposed &&
          this.preferences.snapshot.hyperdriveMode !== "off" &&
          this.entries.get(entry.url) === entry &&
          entry.state === "queued"
        ) {
          this.preconnect(entry);
        }
      }, 250);
      return;
    }
    try {
      const origin = new URL(entry.url).origin;
      const warmedAt = this.warmedOrigins.get(origin);
      if (warmedAt && this.now() - warmedAt < ENTRY_TTL_MS) {
        entry.state = "predicted";
        entry.reason = "Reused a recently requested origin connection warm-up";
        entry.updatedAt = this.now();
        return;
      }
      this.network.preconnect(entry.url, 1);
      this.warmedOrigins.set(origin, this.now());
      entry.state = "connecting";
      entry.preparation = "preconnect";
      entry.updatedAt = this.now();
      this.addEvent(
        entry,
        "Requested one-socket origin warming; completion is not observable",
      );
      setTimeout(() => {
        if (
          this.entries.get(entry.url) !== entry ||
          entry.state !== "connecting"
        )
          return;
        entry.state = "predicted";
        entry.updatedAt = this.now();
        this.scheduleEmit();
      }, 750);
    } catch (error) {
      entry.state = "failed";
      entry.reason = error instanceof Error ? error.message : String(error);
      this.addEvent(entry, "Connection preparation failed", true);
    }
  }

  private queuePrefetch(entry: InternalDestination): void {
    if (
      entry.ready ||
      (entry.preparation === "document-prefetch" &&
        (entry.state === "prefetched" || entry.state === "activated")) ||
      entry.state === "queued" ||
      entry.state === "prefetching" ||
      this.activeFetches.has(entry.url)
    ) {
      return;
    }
    entry.state = "queued";
    entry.preparation = "document-prefetch";
    entry.updatedAt = this.now();
    this.addEvent(entry, "Queued a cache-aware document prefetch");
    queueMicrotask(() => this.drainPrefetchQueue());
  }

  private scheduleSettledSearchPrefetch(entry: InternalDestination): void {
    entry.state = "queued";
    entry.preparation = "document-prefetch";
    entry.reason = "Waiting briefly for the search query to settle";
    entry.updatedAt = this.now();
    const timer = setTimeout(() => {
      this.searchPrefetchTimers.delete(entry.tabId);
      if (
        this.disposed ||
        this.entries.get(entry.url) !== entry ||
        entry.state !== "queued" ||
        !this.preferences.snapshot.hyperdriveSearchPreloadingEnabled
      ) {
        return;
      }
      entry.state = "predicted";
      this.queuePrefetch(entry);
      this.drainPrefetchQueue();
      this.scheduleEmit();
    }, SEARCH_SETTLE_DELAY_MS);
    this.searchPrefetchTimers.set(entry.tabId, timer);
  }

  private drainPrefetchQueue(): void {
    const mode = this.preferences.snapshot.hyperdriveMode;
    const capacity = modeConcurrency(mode);
    if (
      capacity === 0 ||
      this.memoryPressure ||
      (this.options.canPrepare && !this.options.canPrepare())
    ) {
      return;
    }
    const queued = [...this.entries.values()]
      .filter(
        (entry) =>
          entry.state === "queued" && entry.preparation === "document-prefetch",
      )
      .sort(
        (left, right) =>
          Number(right.source === "omnibox") -
            Number(left.source === "omnibox") ||
          right.confidence - left.confidence ||
          right.updatedAt - left.updatedAt,
      );
    while (this.activePrefetches < capacity && queued.length > 0) {
      const entry = queued.shift();
      if (entry) this.prefetch(entry);
    }
  }

  private prefetch(entry: InternalDestination): void {
    const estimatedTaskBytes = 4 * 1024 * 1024;
    const budgetBytes =
      this.preferences.snapshot.hyperdriveRamBudgetMb * 1024 * 1024;
    if (
      this.estimatedSpeculativeMemoryBytes + estimatedTaskBytes >
      budgetBytes
    ) {
      entry.state = "evicted";
      entry.reason =
        "Speculative RAM estimate would exceed the configured ceiling";
      this.addEvent(entry, entry.reason, true);
      return;
    }
    if (!this.options.prepareDocument) {
      entry.state = "failed";
      entry.reason = "No page-context prefetch adapter is available";
      this.addEvent(entry, entry.reason, true);
      return;
    }
    this.activeFetches.set(entry.url, entry.id);
    this.activePrefetches += 1;
    this.estimatedSpeculativeMemoryBytes += estimatedTaskBytes;
    entry.state = "prefetching";
    entry.prefetchOwned = true;
    entry.prefetchCompletedAt = null;
    entry.updatedAt = this.now();
    this.addEvent(
      entry,
      "Issued a page-context prefetch through the active tab",
    );
    try {
      this.options.prepareDocument(entry.tabId, {
        id: entry.id,
        url: entry.url,
      });
      const timeout = setTimeout(() => {
        if (this.activeFetches.get(entry.url) !== entry.id) return;
        this.cancelActivePrefetch(entry);
        entry.state = "failed";
        entry.reason = "Page-context prefetch timed out";
        this.addEvent(entry, entry.reason, true);
        this.drainPrefetchQueue();
        this.scheduleEmit();
      }, 10_000);
      this.preparationTimeouts.set(entry.id, timeout);
    } catch (error) {
      this.finishActivePrefetch(entry);
      entry.state = "failed";
      entry.ready = false;
      entry.reason = error instanceof Error ? error.message : String(error);
      this.addEvent(entry, `Prefetch failed: ${entry.reason}`, true);
      this.scheduleEmit();
    }
  }

  private finishActivePrefetch(entry: InternalDestination): void {
    if (this.activeFetches.get(entry.url) !== entry.id) return;
    this.activeFetches.delete(entry.url);
    this.activePrefetches = Math.max(0, this.activePrefetches - 1);
    this.estimatedSpeculativeMemoryBytes = Math.max(
      0,
      this.estimatedSpeculativeMemoryBytes - 4 * 1024 * 1024,
    );
    const timeout = this.preparationTimeouts.get(entry.id);
    if (timeout) clearTimeout(timeout);
    this.preparationTimeouts.delete(entry.id);
  }

  private cancelActivePrefetch(entry: InternalDestination): void {
    if (this.activeFetches.get(entry.url) !== entry.id) return;
    this.options.cancelDocument?.(entry.tabId, entry.id);
    this.finishActivePrefetch(entry);
  }

  private cancelEntry(
    entry: InternalDestination,
    reason: string,
    evicted = false,
  ): void {
    const cancelledDocumentPrefetch =
      entry.preparation === "document-prefetch" &&
      (entry.state === "queued" || entry.state === "prefetching");
    this.cancelActivePrefetch(entry);
    if (
      entry.state !== "cancelled" &&
      entry.state !== "failed" &&
      entry.state !== "evicted" &&
      entry.state !== "activated"
    ) {
      entry.state = evicted ? "evicted" : "cancelled";
      entry.ready = false;
      entry.updatedAt = this.now();
      if (cancelledDocumentPrefetch) this.cancelledPreloads += 1;
      this.addEvent(entry, reason);
    }
  }

  private cancelCrossSiteWork(): void {
    for (const entry of this.entries.values()) {
      if (entry.crossSite) {
        this.cancelEntry(entry, "Cross-site preloading disabled");
      }
    }
  }

  private enforceBudget(): void {
    const budgetBytes =
      this.preferences.snapshot.hyperdriveRamBudgetMb * 1024 * 1024;
    if (this.estimatedSpeculativeMemoryBytes <= budgetBytes) return;
    const victims = [...this.entries.values()]
      .filter((entry) => this.activeFetches.has(entry.url))
      .sort((left, right) => left.confidence - right.confidence);
    for (const victim of victims) {
      this.cancelEntry(victim, "Evicted to enforce the RAM ceiling", true);
      if (this.estimatedSpeculativeMemoryBytes <= budgetBytes) break;
    }
  }

  private checkMemoryPressure(): void {
    const available = this.availableMemoryBytes();
    const total = Math.max(1, this.totalMemoryBytes());
    const pressure = available < Math.max(512 * 1024 * 1024, total * 0.08);
    if (pressure && !this.memoryPressure) {
      this.memoryPressure = true;
      this.clearSpeculation("Released speculative work under memory pressure");
    } else if (!pressure && this.memoryPressure && available > total * 0.12) {
      this.memoryPressure = false;
      this.addEvent(null, "System memory recovered; Hyperdrive may resume");
    }
    const electronProcess = process as typeof process & {
      getProcessMemoryInfo?: () => Promise<{ private: number }>;
    };
    void electronProcess
      .getProcessMemoryInfo?.()
      .then((info) => {
        this.processPrivateMemoryBytes = info.private * 1024;
        this.scheduleEmit();
      })
      .catch(() => undefined);
    this.pruneEntries();
    this.scheduleEmit();
  }

  private pruneEntries(): void {
    const now = this.now();
    for (const [origin, warmedAt] of this.warmedOrigins) {
      if (now - warmedAt > ENTRY_TTL_MS) this.warmedOrigins.delete(origin);
    }
    const values = [...this.entries.values()].sort(
      (left, right) => right.updatedAt - left.updatedAt,
    );
    for (const entry of values.slice(MAX_MONITOR_DESTINATIONS * 2)) {
      this.cancelEntry(entry, "Evicted stale prediction", true);
      this.entries.delete(entry.url);
    }
    for (const entry of values) {
      if (
        now - entry.updatedAt > ENTRY_TTL_MS &&
        !this.activeFetches.has(entry.url)
      ) {
        this.entries.delete(entry.url);
      }
    }
  }

  private recordOutcome(
    entry: InternalDestination,
    clicked: boolean,
    reused: boolean,
  ): void {
    this.learner.record({
      adapterId:
        (entry.adapter as
          | "google"
          | "youtube"
          | "chatgpt"
          | "github"
          | "wikipedia"
          | null) ?? "generic",
      trigger: entry.modelTrigger,
      predicted: true,
      clicked,
      reused,
      wastedBytes: clicked ? 0 : (entry.estimatedBytes ?? 0),
    });
    this.scheduleLearningWrite();
  }

  private addEvent(
    entry: InternalDestination | null,
    message: string,
    warning = false,
  ): void {
    if (this.paused) return;
    this.events.unshift({
      id: randomUUID(),
      timestamp: Date.now(),
      state: entry?.state ?? "predicted",
      host: entry ? cleanHost(new URL(entry.url).hostname) : null,
      message,
      warning,
    });
    this.events.length = Math.min(this.events.length, MAX_MONITOR_EVENTS);
  }

  private scheduleEmit(immediate = false): void {
    if (this.disposed) return;
    if (this.emitTimer) {
      if (!immediate) return;
      clearTimeout(this.emitTimer);
    }
    this.emitTimer = setTimeout(
      () => {
        this.emitTimer = null;
        this.options.emit(this.snapshot);
      },
      immediate ? 0 : EMIT_DELAY_MS,
    );
  }

  private scheduleLearningWrite(): void {
    if (this.learningTimer) clearTimeout(this.learningTimer);
    this.learningTimer = setTimeout(() => {
      this.learningTimer = null;
      void this.persistLearning();
    }, LEARNING_WRITE_DELAY_MS);
  }

  private async persistLearning(): Promise<void> {
    const operation = this.learningWriteQueue.then(async () => {
      const filePath = this.options.learningFilePath;
      const temporaryPath = `${filePath}.${process.pid}.${++this.learningWriteCounter}.tmp`;
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(
          temporaryPath,
          `${JSON.stringify(this.learner.snapshot(), null, 2)}\n`,
          { encoding: "utf8", mode: 0o600, flag: "wx" },
        );
        await fs.rename(temporaryPath, filePath);
      } catch (error) {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
        console.warn("Could not persist Hyperdrive learning data.", error);
      }
    });
    this.learningWriteQueue = operation.catch(() => undefined);
    await operation;
  }
}
