import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { HyperdriveSnapshot } from "../shared/browser";
import { HyperdriveMonitor } from "./App";

const snapshot: HyperdriveSnapshot = {
  status: "idle",
  mode: "balanced",
  ramBudgetMb: 512,
  availableMemoryMb: 8_192,
  totalMemoryMb: 16_384,
  paused: false,
  monitorOpen: true,
  warning: null,
  metrics: {
    activePredictions: 2,
    activePreloads: 1,
    preparedDestinations: 3,
    cacheReuseSuccesses: 4,
    successfulPredictions: 5,
    missedPredictions: 1,
    cancelledPreloads: 2,
    wastedPreparations: 1,
    observedSpeculativeBytes: 32_768,
    estimatedSpeculativeMemoryBytes: 16 * 1_048_576,
    processPrivateMemoryBytes: 64 * 1_048_576,
    navigationTimeSavedMs: null,
    rankingTimeMs: 0.25,
    predictionsEvaluated: 6,
  },
  destinations: [
    {
      id: "destination-1",
      title: "Example page",
      displayUrl: "example.test/page",
      host: "example.test",
      confidence: 0.82,
      trigger: "pointer-trajectory",
      state: "prefetched",
      preparation: "document-prefetch",
      source: "pointer",
      adapter: null,
      estimatedBytes: 16_384,
      elapsedMs: 120,
      ready: false,
      reused: false,
      reuseEvidence: "none",
      reason: "The pointer is moving toward this link.",
    },
  ],
  events: [
    {
      id: "event-1",
      timestamp: 1,
      state: "prefetched",
      host: "example.test",
      message: "Document prefetched",
      warning: false,
    },
  ],
};

describe("HyperdriveMonitor", () => {
  it("shows simple controls and understandable results outside developer mode", () => {
    const markup = renderToStaticMarkup(
      <HyperdriveMonitor snapshot={snapshot} developerMode={false} />,
    );

    expect(markup).toContain('aria-label="Hyperdrive enabled"');
    expect(markup).toContain('aria-label="Hyperdrive RAM limit"');
    expect(markup).toContain("Correct predictions");
    expect(markup).toContain("Cache wins");
    expect(markup).toContain("What Hyperdrive is doing");
    expect(markup).not.toContain("Omnibox predictions");
    expect(markup).not.toContain("Destinations");
    expect(markup).not.toContain("Event history");
    expect(markup).not.toContain("ranking");
  });

  it("reveals the live diagnostic feed only in developer mode", () => {
    const markup = renderToStaticMarkup(
      <HyperdriveMonitor snapshot={snapshot} developerMode />,
    );

    expect(markup).toContain("Live metrics");
    expect(markup).toContain("Omnibox predictions");
    expect(markup).toContain("Destinations");
    expect(markup).toContain("Event history");
    expect(markup).toContain("Clear speculative work");
    expect(markup).not.toContain("What Hyperdrive is doing");
  });
});
