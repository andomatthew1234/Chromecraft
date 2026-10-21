import { describe, expect, it } from "vitest";

import { HyperdriveOutcomeLearner } from "./learner";
import type { LinkCandidate, PointerIntentScore } from "./model";
import { HyperdrivePredictionEngine } from "./predictor";

const currentUrl = "https://example.com/start";

function candidate(
  id: string,
  overrides: Partial<LinkCandidate> = {},
): LinkCandidate {
  return {
    id,
    url: `https://example.com/${id}`,
    title: id,
    visible: true,
    ...overrides,
  };
}

function pointer(candidateId: string, confidence: number): PointerIntentScore {
  return {
    candidateId,
    confidence,
    distancePx: 20,
    intersectsPredictedPath: true,
    approaching: true,
    hovering: false,
    reasons: ["Predicted path intersects link"],
  };
}

describe("HyperdrivePredictionEngine", () => {
  it("reports deterministic injected ranking time", () => {
    const timestamps = [100, 100.125];
    const engine = new HyperdrivePredictionEngine({
      clock: () => timestamps.shift() ?? 0,
    });
    expect(
      engine.rank({ currentUrl, candidates: [candidate("one")] }).rankingTimeMs,
    ).toBe(0.125);
  });

  it("does no speculative work when mode is off", () => {
    const engine = new HyperdrivePredictionEngine({ mode: "off" });
    expect(
      engine.rank({ currentUrl, candidates: [candidate("one")] }),
    ).toMatchObject({
      predictions: [],
      rejected: [],
      considered: 0,
      truncated: true,
    });
  });

  it("makes pointer intent outrank an otherwise equivalent link", () => {
    const engine = new HyperdrivePredictionEngine();
    const batch = engine.rank({
      currentUrl,
      candidates: [candidate("other"), candidate("intent")],
      pointerIntent: [pointer("intent", 0.9)],
    });

    expect(batch.predictions[0]).toMatchObject({
      candidateId: "intent",
      trigger: "cursor-trajectory",
    });
    expect(batch.predictions[0].confidence).toBeGreaterThan(
      batch.predictions[1].confidence,
    );
  });

  it("prioritises a selected Omnibox destination", () => {
    const engine = new HyperdrivePredictionEngine({
      policy: { allowCrossSite: true },
    });
    const batch = engine.rank({
      currentUrl,
      candidates: [
        candidate("page", { visitCount: 20 }),
        candidate("youtube", {
          source: "omnibox",
          trigger: "omnibox-selection",
          selected: true,
          url: "https://youtube.com/",
        }),
      ],
    });

    expect(batch.predictions[0]).toMatchObject({
      candidateId: "youtube",
      trigger: "omnibox-selection",
    });
  });

  it("ranks explicit local history without retaining raw history", () => {
    const engine = new HyperdrivePredictionEngine();
    const batch = engine.rank({
      currentUrl,
      candidates: [candidate("new"), candidate("frequent", { visitCount: 63 })],
    });
    expect(batch.predictions[0].candidateId).toBe("frequent");
    expect(batch.predictions[0].reasons).toContain("Local visit history");
  });

  it("rejects cross-site, sensitive, disabled and site-prepared candidates", () => {
    const engine = new HyperdrivePredictionEngine({
      policy: { disabledHosts: ["disabled.example.com"] },
    });
    const batch = engine.rank({
      currentUrl,
      candidates: [
        candidate("cross", { url: "https://other.test/" }),
        candidate("sensitive", { url: "https://example.com/logout" }),
        candidate("disabled", { url: "https://disabled.example.com/page" }),
        candidate("prepared", { alreadySpeculated: true }),
      ],
    });

    expect(batch.predictions).toEqual([]);
    expect(batch.rejected.map((entry) => entry.reason)).toEqual([
      "cross-site-disabled",
      "sensitive-path",
      "site-disabled",
      "site-already-speculates-or-unsafe",
    ]);
  });

  it("rejects private ChatGPT conversations even when sensitive policy is opted in", () => {
    const engine = new HyperdrivePredictionEngine({
      policy: { allowSensitiveSites: true },
    });
    const batch = engine.rank({
      currentUrl: "https://chatgpt.com/",
      candidates: [
        candidate("private", { url: "https://chatgpt.com/c/private-id" }),
      ],
    });
    expect(batch.rejected[0].reason).toBe("sensitive-adapter-content");
    expect(batch.rejected[0].url).toBe("https://chatgpt.com/[sensitive]");
  });

  it("never returns duplicate normalized destinations", () => {
    const engine = new HyperdrivePredictionEngine();
    const batch = engine.rank({
      currentUrl,
      candidates: [
        candidate("one", { url: "/same#first" }),
        candidate("two", { url: "https://example.com/same#second" }),
      ],
    });
    expect(batch.predictions).toHaveLength(1);
  });

  it("merges duplicate signals and preserves the strongest candidate", () => {
    const engine = new HyperdrivePredictionEngine();
    const batch = engine.rank({
      currentUrl,
      candidates: [
        candidate("page", { url: "/same" }),
        candidate("selected", {
          url: "https://example.com/same#fragment",
          source: "omnibox",
          selected: true,
        }),
      ],
    });
    expect(batch.predictions).toHaveLength(1);
    expect(batch.predictions[0]).toMatchObject({
      candidateId: "selected",
      trigger: "omnibox-selection",
    });
  });

  it("rejects malformed destinations and sanitises non-finite signals", () => {
    const engine = new HyperdrivePredictionEngine();
    const batch = engine.rank({
      currentUrl,
      candidates: [
        candidate("invalid", { url: "http://[broken" }),
        candidate("finite", {
          historicalClicks: Number.POSITIVE_INFINITY,
          historicalImpressions: Number.NaN,
          visitCount: Number.NaN,
        }),
      ],
      pointerIntent: [pointer("finite", Number.NaN)],
    });
    expect(batch.rejected[0].reason).toBe("invalid-url");
    expect(Number.isFinite(batch.predictions[0].confidence)).toBe(true);
  });

  it("bounds candidate work and output size", () => {
    const engine = new HyperdrivePredictionEngine({
      maxCandidates: 20,
      maxPredictions: 3,
    });
    const candidates = Array.from({ length: 100 }, (_, index) =>
      candidate(String(index)),
    );
    const batch = engine.rank({ currentUrl, candidates });
    expect(batch.considered).toBe(20);
    expect(batch.predictions).toHaveLength(3);
    expect(batch.truncated).toBe(true);
  });

  it("uses stronger preparation tiers only in stronger modes", () => {
    const link = candidate("intent", { selected: true, source: "omnibox" });
    const intent = [pointer("intent", 0.45)];
    const balanced = new HyperdrivePredictionEngine({ mode: "balanced" }).rank({
      currentUrl,
      candidates: [link],
      pointerIntent: intent,
    });
    const maximum = new HyperdrivePredictionEngine({ mode: "maximum" }).rank({
      currentUrl,
      candidates: [link],
      pointerIntent: intent,
    });

    expect(balanced.predictions[0].preparationTier).toBe("connection");
    expect(maximum.predictions[0].preparationTier).toBe("prefetch");
  });

  it("allows a confirmed high-confidence hover to prefetch in balanced mode", () => {
    const intent: PointerIntentScore = {
      ...pointer("intent", 0.9),
      hovering: true,
      reasons: ["Pointer hovering", "Predicted path intersects link"],
    };
    const batch = new HyperdrivePredictionEngine({ mode: "balanced" }).rank({
      currentUrl,
      candidates: [candidate("intent")],
      pointerIntent: [intent],
    });

    expect(batch.predictions[0]).toMatchObject({
      candidateId: "intent",
      trigger: "hover",
      preparationTier: "prefetch",
    });
    expect(batch.predictions[0].confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("accounts for estimated preparation cost when utility is otherwise equal", () => {
    const engine = new HyperdrivePredictionEngine({ mode: "maximum" });
    const batch = engine.rank({
      currentUrl,
      candidates: [
        candidate("expensive", { estimatedPreparationBytes: 8 * 1024 * 1024 }),
        candidate("cheap", { estimatedPreparationBytes: 64 * 1024 }),
      ],
      pointerIntent: [pointer("expensive", 0.8), pointer("cheap", 0.8)],
    });
    expect(batch.predictions[0].candidateId).toBe("cheap");
    expect(batch.predictions[0].utility).toBeGreaterThan(
      batch.predictions[1].utility,
    );
  });

  it("calibrates confidence from aggregate local outcomes", () => {
    const learner = new HyperdriveOutcomeLearner();
    for (let index = 0; index < 40; index += 1) {
      learner.record({
        adapterId: "generic",
        trigger: "visible-link",
        predicted: true,
        clicked: true,
        reused: false,
      });
    }
    const learned = new HyperdrivePredictionEngine({ learner }).rank({
      currentUrl,
      candidates: [candidate("one")],
    });
    const fresh = new HyperdrivePredictionEngine().rank({
      currentUrl,
      candidates: [candidate("one")],
    });
    expect(learned.predictions[0].confidence).toBeGreaterThan(
      fresh.predictions[0].confidence,
    );
  });
});
