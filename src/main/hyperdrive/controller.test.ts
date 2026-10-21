import { afterEach, describe, expect, it, vi } from "vitest";

import type { Session } from "electron";

import type { HyperdriveMode } from "../../shared/browser";
import type { BrowserPreferences, PreferencesStore } from "../preferences";
import { HyperdriveController } from "./controller";

function makePreferences(
  patch: Partial<BrowserPreferences> = {},
): PreferencesStore {
  const value: BrowserPreferences = {
    ublockEnabled: true,
    restoreSession: true,
    sidebarAttached: true,
    sidebarOpen: true,
    bookmarkBarVisible: false,
    newTabTheme: "minimal",
    searchEngine: "duckduckgo",
    remoteSearchSuggestionsEnabled: false,
    hyperdriveMode: "balanced",
    hyperdriveRamBudgetMb: 256,
    hyperdriveCrossSitePreloadingEnabled: false,
    hyperdriveSearchPreloadingEnabled: false,
    hyperdriveExcludedHosts: [],
    hyperdriveMonitorOpen: false,
    extensionDeveloperMode: false,
    ...patch,
  };
  return {
    get snapshot() {
      return value;
    },
    async setHyperdriveMode(mode: HyperdriveMode) {
      value.hyperdriveMode = mode;
    },
    async setHyperdriveRamBudgetMb(megabytes: number) {
      value.hyperdriveRamBudgetMb = megabytes;
    },
    async setHyperdriveCrossSitePreloadingEnabled(enabled: boolean) {
      value.hyperdriveCrossSitePreloadingEnabled = enabled;
    },
    async setHyperdriveSearchPreloadingEnabled(enabled: boolean) {
      value.hyperdriveSearchPreloadingEnabled = enabled;
    },
    async setHyperdriveExcludedHosts(hosts: string[]) {
      value.hyperdriveExcludedHosts = hosts;
    },
    async setHyperdriveMonitorOpen(open: boolean) {
      value.hyperdriveMonitorOpen = open;
    },
  } as unknown as PreferencesStore;
}

function makeController(
  preferences: PreferencesStore,
  overrides: {
    preconnect?: (url: string, sockets: number) => void;
    prepare?: (tabId: string, request: { id: string; url: string }) => void;
    cancel?: (tabId: string, id: string) => void;
    canPrepare?: () => boolean;
  } = {},
): HyperdriveController {
  return new HyperdriveController({} as Session, preferences, {
    learningFilePath: "unused-in-controller-tests.json",
    emit: vi.fn(),
    network: {
      preconnect:
        overrides.preconnect ?? vi.fn<(url: string, sockets: number) => void>(),
    },
    prepareDocument:
      overrides.prepare ??
      vi.fn<(tabId: string, request: { id: string; url: string }) => void>(),
    cancelDocument:
      overrides.cancel ?? vi.fn<(tabId: string, id: string) => void>(),
    canPrepare: overrides.canPrepare ?? (() => true),
    availableMemoryBytes: () => 8 * 1024 * 1024 * 1024,
    totalMemoryBytes: () => 16 * 1024 * 1024 * 1024,
  });
}

function omniboxSignal(destination = "https://youtube.com/", search = false) {
  return {
    tabId: "tab-1",
    input: search ? "minecraft shaders" : "you",
    destination,
    title: search ? "minecraft shaders" : "YouTube",
    trigger: search
      ? ("search-suggestion" as const)
      : ("omnibox-selection" as const),
    confidence: 0.96,
    search,
  };
}

const controllers: HyperdriveController[] = [];

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("HyperdriveController", () => {
  it("does no speculative work while Hyperdrive is off", () => {
    const preconnect = vi.fn();
    const prepare = vi.fn();
    const controller = makeController(
      makePreferences({ hyperdriveMode: "off" }),
      { preconnect, prepare },
    );
    controllers.push(controller);
    controller.setActiveTab("tab-1");

    controller.updateOmnibox(omniboxSignal(), "");

    expect(preconnect).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(controller.snapshot.status).toBe("off");
  });

  it("keeps cross-site Omnibox predictions network-idle by default", () => {
    const preconnect = vi.fn();
    const prepare = vi.fn();
    const controller = makeController(makePreferences(), {
      preconnect,
      prepare,
    });
    controllers.push(controller);
    controller.setActiveTab("tab-1");

    controller.updateOmnibox(omniboxSignal(), "https://example.com/");

    expect(preconnect).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(controller.snapshot.destinations[0]).toMatchObject({
      state: "blocked",
      preparation: "none",
      reason: "Cross-site preparation blocked by privacy settings.",
    });
  });

  it("does not count or retain a superseded network-idle prediction as a cancelled preload", () => {
    const preconnect = vi.fn();
    const prepare = vi.fn();
    const controller = makeController(makePreferences(), {
      preconnect,
      prepare,
    });
    controllers.push(controller);
    controller.setActiveTab("tab-1");

    controller.updateOmnibox(omniboxSignal(), "https://example.com/");
    controller.updateOmnibox(
      omniboxSignal("https://github.com/"),
      "https://example.com/",
    );

    expect(preconnect).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(controller.snapshot.metrics.cancelledPreloads).toBe(0);
    expect(controller.snapshot.destinations).toHaveLength(1);
    expect(controller.snapshot.destinations[0]?.host).toBe("github.com");
  });

  it("deduplicates page URLs before applying the candidate bound", () => {
    const controller = makeController(makePreferences());
    controllers.push(controller);
    controller.setActiveTab("tab-1");
    const duplicateCandidates = Array.from({ length: 64 }, (_, index) => ({
      url: `https://example.com/repeated#${index}`,
      title: `Repeated ${index}`,
      left: 20,
      top: 20,
      right: 120,
      bottom: 60,
    }));

    controller.updatePageSignals("tab-1", "https://example.com/start", {
      pointer: { x: 10, y: 10 },
      candidates: [
        ...duplicateCandidates,
        {
          url: "https://example.com/unique-target",
          title: "Unique target",
          left: 140,
          top: 20,
          right: 260,
          bottom: 60,
        },
      ],
    });

    expect(controller.snapshot.destinations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Unique target" }),
      ]),
    );
    expect(controller.snapshot.metrics.predictionsEvaluated).toBe(2);
  });

  it("uses page-context prefetch for an explicitly permitted high-confidence destination", async () => {
    const prepare = vi.fn();
    const controller = makeController(
      makePreferences({ hyperdriveCrossSitePreloadingEnabled: true }),
      { prepare },
    );
    controllers.push(controller);
    controller.setActiveTab("tab-1");

    controller.updateOmnibox(omniboxSignal(), "https://example.com/");
    await Promise.resolve();

    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith(
      "tab-1",
      expect.objectContaining({ url: "https://youtube.com/" }),
    );
    expect(controller.snapshot.destinations[0]?.state).toBe("prefetching");
  });

  it("does not issue a speculative search request without search consent", async () => {
    const preconnect = vi.fn();
    const prepare = vi.fn();
    const controller = makeController(
      makePreferences({ hyperdriveCrossSitePreloadingEnabled: true }),
      { preconnect, prepare },
    );
    controllers.push(controller);
    controller.setActiveTab("tab-1");

    controller.updateOmnibox(
      omniboxSignal("https://duckduckgo.com/?q=minecraft+shaders", true),
      "https://example.com/",
    );
    await Promise.resolve();

    expect(preconnect).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("labels a completed hint as prefetched and only records reuse after navigation proof", async () => {
    const prepare = vi.fn();
    const controller = makeController(
      makePreferences({ hyperdriveCrossSitePreloadingEnabled: true }),
      { prepare },
    );
    controllers.push(controller);
    controller.setActiveTab("tab-1");
    controller.updateOmnibox(omniboxSignal(), "https://example.com/");
    await Promise.resolve();
    const destination = controller.snapshot.destinations[0];

    controller.handlePreparationResult("tab-1", {
      id: destination.id,
      url: "https://youtube.com/",
      status: "loaded",
    });

    expect(controller.snapshot.destinations[0]).toMatchObject({
      state: "prefetched",
      ready: false,
      reused: false,
    });

    controller.navigationStarted("tab-1", "https://youtube.com/");
    controller.noteNavigationTiming("tab-1", "https://youtube.com/", {
      transferSize: 0,
      activationStart: 0,
    });
    controller.navigationFinished("tab-1", "https://youtube.com/");

    expect(controller.snapshot.destinations[0]).toMatchObject({
      state: "cache-reused",
      reused: true,
      reason: "Cache reuse confirmed by the destination navigation.",
    });
    expect(controller.snapshot.metrics.cacheReuseSuccesses).toBe(1);
    expect(controller.snapshot.metrics.navigationTimeSavedMs).toBeNull();
  });

  it("attributes a safely resolved Google redirect to the prepared destination", async () => {
    const prepare = vi.fn();
    const controller = makeController(
      makePreferences({ hyperdriveCrossSitePreloadingEnabled: true }),
      { prepare },
    );
    controllers.push(controller);
    controller.setActiveTab("tab-1");
    const googleUrl = "https://www.google.com/search?q=hello";
    const destination = "https://en.wikipedia.org/wiki/Hello";
    const wrapper = `${googleUrl.slice(0, googleUrl.indexOf("/search"))}/url?q=${encodeURIComponent(destination)}`;
    const candidate = {
      url: wrapper,
      title: "Hello - Wikipedia",
      left: 120,
      top: 40,
      right: 320,
      bottom: 90,
    };
    controller.updatePageSignals("tab-1", googleUrl, {
      pointer: { x: 20, y: 60 },
      candidates: [candidate],
    });
    controller.updatePageSignals("tab-1", googleUrl, {
      pointer: { x: 180, y: 60 },
      hoveredUrl: wrapper,
      clickedUrl: wrapper,
      candidates: [candidate],
    });
    await Promise.resolve();

    expect(prepare).toHaveBeenCalledWith(
      "tab-1",
      expect.objectContaining({ url: destination }),
    );
    const predicted = controller.snapshot.destinations.find(
      (entry) => entry.displayUrl === "en.wikipedia.org/wiki/Hello",
    );
    expect(predicted).toBeDefined();
    controller.handlePreparationResult("tab-1", {
      id: predicted?.id,
      url: destination,
      status: "loaded",
    });

    controller.navigationStarted("tab-1", wrapper);
    controller.navigationRedirected("tab-1", destination);
    controller.noteNavigationTiming("tab-1", destination, {
      transferSize: 0,
      activationStart: 0,
    });
    controller.navigationFinished("tab-1", destination);

    expect(controller.snapshot.destinations[0]).toMatchObject({
      state: "cache-reused",
      reused: true,
    });
    expect(controller.snapshot.metrics.successfulPredictions).toBe(1);
  });

  it("marks a completed prefetch as not reused when navigation transfers the document", async () => {
    const controller = makeController(
      makePreferences({ hyperdriveCrossSitePreloadingEnabled: true }),
    );
    controllers.push(controller);
    controller.setActiveTab("tab-1");
    controller.updateOmnibox(omniboxSignal(), "https://example.com/");
    await Promise.resolve();
    const destination = controller.snapshot.destinations[0];
    controller.handlePreparationResult("tab-1", {
      id: destination.id,
      url: "https://youtube.com/",
      status: "loaded",
    });

    controller.navigationStarted("tab-1", "https://youtube.com/");
    controller.noteNavigationTiming("tab-1", "https://youtube.com/", {
      transferSize: 4096,
      activationStart: 0,
    });
    controller.navigationFinished("tab-1", "https://youtube.com/");

    expect(controller.snapshot.destinations[0]).toMatchObject({
      state: "not-reused",
      reused: false,
      reason: "Preparation not reused; navigation transferred the document.",
    });
    expect(controller.snapshot.metrics.cacheReuseSuccesses).toBe(0);
  });

  it("does not count a prediction as successful when its navigation fails", async () => {
    const controller = makeController(
      makePreferences({ hyperdriveCrossSitePreloadingEnabled: true }),
    );
    controllers.push(controller);
    controller.setActiveTab("tab-1");
    controller.updateOmnibox(omniboxSignal(), "https://example.com/");
    await Promise.resolve();
    const destination = controller.snapshot.destinations[0];
    controller.handlePreparationResult("tab-1", {
      id: destination.id,
      url: "https://youtube.com/",
      status: "loaded",
    });

    controller.navigationStarted("tab-1", "https://youtube.com/");
    expect(controller.snapshot.metrics.successfulPredictions).toBe(0);
    controller.navigationFailed(
      "tab-1",
      "https://youtube.com/",
      "Connection reset",
    );

    expect(controller.snapshot.metrics.successfulPredictions).toBe(0);
    expect(controller.snapshot.destinations[0]).toMatchObject({
      state: "not-reused",
      reused: false,
      reason: "Navigation failed after preparation: Connection reset",
    });
  });

  it("does not claim a site-owned duplicate prefetch as Hyperdrive reuse", async () => {
    const controller = makeController(
      makePreferences({ hyperdriveCrossSitePreloadingEnabled: true }),
    );
    controllers.push(controller);
    controller.setActiveTab("tab-1");
    controller.updateOmnibox(omniboxSignal(), "https://example.com/");
    await Promise.resolve();
    const destination = controller.snapshot.destinations[0];
    controller.handlePreparationResult("tab-1", {
      id: destination.id,
      url: "https://youtube.com/",
      status: "duplicate",
    });

    controller.navigationStarted("tab-1", "https://youtube.com/");
    controller.noteNavigationTiming("tab-1", "https://youtube.com/", {
      transferSize: 0,
      activationStart: 0,
    });
    controller.navigationFinished("tab-1", "https://youtube.com/");

    expect(controller.snapshot.destinations[0]).toMatchObject({
      state: "deduplicated",
      reused: false,
      reuseEvidence: "none",
    });
    expect(controller.snapshot.metrics.cacheReuseSuccesses).toBe(0);
  });

  it("does not credit reuse when navigation overtakes an unfinished prefetch", async () => {
    const cancel = vi.fn();
    const controller = makeController(
      makePreferences({ hyperdriveCrossSitePreloadingEnabled: true }),
      { cancel },
    );
    controllers.push(controller);
    controller.setActiveTab("tab-1");
    controller.updateOmnibox(omniboxSignal(), "https://example.com/");
    await Promise.resolve();

    controller.navigationStarted("tab-1", "https://youtube.com/");
    controller.noteNavigationTiming("tab-1", "https://youtube.com/", {
      transferSize: 0,
      activationStart: 0,
    });
    controller.navigationFinished("tab-1", "https://youtube.com/");

    expect(cancel).toHaveBeenCalledOnce();
    expect(controller.snapshot.destinations[0]).toMatchObject({
      state: "not-reused",
      reused: false,
      reuseEvidence: "none",
      reason: "Navigation began before document prefetch completed.",
    });
    expect(controller.snapshot.metrics.cacheReuseSuccesses).toBe(0);
  });

  it("holds queued work until content protection reports ready", async () => {
    let ready = false;
    const prepare = vi.fn();
    const controller = makeController(
      makePreferences({ hyperdriveCrossSitePreloadingEnabled: true }),
      { prepare, canPrepare: () => ready },
    );
    controllers.push(controller);
    controller.setActiveTab("tab-1");
    controller.updateOmnibox(omniboxSignal(), "https://example.com/");
    await Promise.resolve();
    expect(prepare).not.toHaveBeenCalled();

    ready = true;
    controller.refreshPreparationReadiness();

    expect(prepare).toHaveBeenCalledOnce();
  });

  it("cancels obsolete Omnibox prefetches rather than duplicating them", async () => {
    const prepare = vi.fn();
    const cancel = vi.fn();
    const controller = makeController(
      makePreferences({ hyperdriveCrossSitePreloadingEnabled: true }),
      { prepare, cancel },
    );
    controllers.push(controller);
    controller.setActiveTab("tab-1");
    controller.updateOmnibox(omniboxSignal(), "https://example.com/");
    await Promise.resolve();
    controller.updateOmnibox(
      omniboxSignal("https://github.com/"),
      "https://example.com/",
    );
    await Promise.resolve();

    expect(cancel).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(controller.snapshot.metrics.cancelledPreloads).toBeGreaterThan(0);
  });

  it("does not requeue an already completed document prefetch", async () => {
    const prepare = vi.fn();
    const controller = makeController(
      makePreferences({ hyperdriveCrossSitePreloadingEnabled: true }),
      { prepare },
    );
    controllers.push(controller);
    controller.setActiveTab("tab-1");
    controller.updateOmnibox(omniboxSignal(), "https://example.com/");
    await Promise.resolve();
    const destination = controller.snapshot.destinations[0];
    controller.handlePreparationResult("tab-1", {
      id: destination.id,
      url: "https://youtube.com/",
      status: "loaded",
    });

    controller.updateOmnibox(omniboxSignal(), "https://example.com/");
    await Promise.resolve();

    expect(prepare).toHaveBeenCalledOnce();
    expect(controller.snapshot.destinations[0]?.state).toBe("prefetched");
  });

  it("coalesces repeated connection warming for the same origin", () => {
    const preconnect = vi.fn();
    const controller = makeController(
      makePreferences({ hyperdriveCrossSitePreloadingEnabled: true }),
      { preconnect },
    );
    controllers.push(controller);
    controller.setActiveTab("tab-1");

    controller.updateOmnibox(
      omniboxSignal("https://duckduckgo.com/?q=one", true),
      "https://example.com/",
    );
    controller.updateOmnibox(
      omniboxSignal("https://duckduckgo.com/?q=two", true),
      "https://example.com/",
    );

    expect(preconnect).toHaveBeenCalledOnce();
  });

  it("waits for search typing to settle before an opted-in document prefetch", async () => {
    vi.useFakeTimers();
    const prepare = vi.fn();
    const controller = makeController(
      makePreferences({
        hyperdriveMode: "maximum",
        hyperdriveCrossSitePreloadingEnabled: true,
        hyperdriveSearchPreloadingEnabled: true,
      }),
      { prepare },
    );
    controllers.push(controller);
    controller.setActiveTab("tab-1");

    controller.updateOmnibox(
      omniboxSignal("https://duckduckgo.com/?q=minecraft+shaders", true),
      "https://example.com/",
    );
    await Promise.resolve();
    expect(prepare).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(550);

    expect(prepare).toHaveBeenCalledOnce();
  });
});
