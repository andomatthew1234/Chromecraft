import { describe, expect, it } from "vitest";

import {
  benchmarkPredictionRanking,
  evaluatePredictionBatches,
} from "./benchmark";
import type { LinkCandidate, PredictionBatch } from "./model";
import { HyperdrivePredictionEngine } from "./predictor";

function batch(
  order: readonly string[],
  rankingTimeMs: number,
): PredictionBatch {
  return {
    predictions: order.map((candidateId) => ({
      candidateId,
      url: `https://example.com/${candidateId}`,
      title: candidateId,
      confidence: 0.5,
      utility: 0.5,
      trigger: "visible-link",
      reasons: [],
      preparationTier: "connection",
      adapter: {
        adapterId: "generic",
        category: "link",
        priority: 0,
        sensitive: false,
        suppressSpeculation: false,
        reasons: [],
      },
    })),
    rejected: [],
    considered: order.length,
    truncated: false,
    rankingTimeMs,
  };
}

describe("Hyperdrive benchmark helpers", () => {
  it("measures the bounded pure ranking path independently of worker scheduling", () => {
    const engine = new HyperdrivePredictionEngine();
    const candidates: LinkCandidate[] = Array.from(
      { length: 32 },
      (_, index) => ({
        id: String(index),
        url: `https://example.com/${index}`,
        visible: true,
        visitCount: index,
      }),
    );
    let clockMs = 0;
    const result = benchmarkPredictionRanking(
      engine,
      { currentUrl: "https://example.com/", candidates },
      250,
      () => {
        clockMs += 0.25;
        return clockMs;
      },
    );

    expect(result).toEqual({
      iterations: 250,
      meanMs: 0.25,
      p50Ms: 0.25,
      p95Ms: 0.25,
      maximumMs: 0.25,
    });
  });

  it("reports honest accuracy and wasted top predictions", () => {
    const result = evaluatePredictionBatches([
      { batch: batch(["a", "b", "c"], 0.1), clickedCandidateId: "a" },
      { batch: batch(["a", "b", "c"], 0.3), clickedCandidateId: "b" },
      { batch: batch(["a", "b", "c"], 0.2), clickedCandidateId: "missing" },
    ]);
    expect(result).toEqual({
      samples: 3,
      topOneAccuracy: 1 / 3,
      topThreeAccuracy: 2 / 3,
      meanRankingTimeMs: 0.20000000000000004,
      wastedTopPredictions: 2,
    });
  });

  it("does not invent results for an empty evaluation", () => {
    expect(evaluatePredictionBatches([])).toEqual({
      samples: 0,
      topOneAccuracy: 0,
      topThreeAccuracy: 0,
      meanRankingTimeMs: 0,
      wastedTopPredictions: 0,
    });
  });
});
