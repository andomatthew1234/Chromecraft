import type { PredictionBatch } from "./model";
import { HyperdrivePredictionEngine, type PredictionInput } from "./predictor";

export interface RankingBenchmarkResult {
  iterations: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maximumMs: number;
}

export interface PredictionEvaluation {
  samples: number;
  topOneAccuracy: number;
  topThreeAccuracy: number;
  meanRankingTimeMs: number;
  wastedTopPredictions: number;
}

export interface PredictionEvaluationCase {
  batch: PredictionBatch;
  clickedCandidateId: string;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  ];
}

/** Micro-benchmark for the pure ranking path. It deliberately performs no I/O. */
export function benchmarkPredictionRanking(
  engine: HyperdrivePredictionEngine,
  input: PredictionInput,
  iterations = 1_000,
  now: () => number = () => performance.now(),
): RankingBenchmarkResult {
  const count = Math.max(1, Math.min(100_000, Math.floor(iterations)));
  const timings: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const startedAt = now();
    engine.rank(input);
    timings.push(Math.max(0, now() - startedAt));
  }
  timings.sort((left, right) => left - right);
  const total = timings.reduce((sum, duration) => sum + duration, 0);
  return {
    iterations: count,
    meanMs: total / count,
    p50Ms: percentile(timings, 0.5),
    p95Ms: percentile(timings, 0.95),
    maximumMs: timings.at(-1) ?? 0,
  };
}

export function evaluatePredictionBatches(
  cases: readonly PredictionEvaluationCase[],
): PredictionEvaluation {
  if (cases.length === 0) {
    return {
      samples: 0,
      topOneAccuracy: 0,
      topThreeAccuracy: 0,
      meanRankingTimeMs: 0,
      wastedTopPredictions: 0,
    };
  }
  let topOne = 0;
  let topThree = 0;
  let totalRankingTime = 0;
  for (const sample of cases) {
    const ids = sample.batch.predictions.map((entry) => entry.candidateId);
    if (ids[0] === sample.clickedCandidateId) topOne += 1;
    if (ids.slice(0, 3).includes(sample.clickedCandidateId)) topThree += 1;
    totalRankingTime += sample.batch.rankingTimeMs;
  }
  return {
    samples: cases.length,
    topOneAccuracy: topOne / cases.length,
    topThreeAccuracy: topThree / cases.length,
    meanRankingTimeMs: totalRankingTime / cases.length,
    wastedTopPredictions: cases.length - topOne,
  };
}
