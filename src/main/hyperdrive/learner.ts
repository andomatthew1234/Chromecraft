import type {
  LearningKey,
  PredictionOutcome,
  PredictionTrigger,
  SiteAdapterId,
} from "./model";

const LEARNER_VERSION = 1;
const MAX_BUCKETS = 64;
const MAX_COUNTER = 1_000_000;
const ADAPTER_IDS = new Set([
  "generic",
  "google",
  "youtube",
  "chatgpt",
  "github",
  "wikipedia",
]);
const TRIGGERS = new Set([
  "visible-link",
  "cursor-trajectory",
  "hover",
  "history",
  "site-adapter",
  "omnibox-typing",
  "omnibox-autocomplete",
  "omnibox-selection",
]);

export interface LearningBucket {
  adapterId: SiteAdapterId | "generic";
  trigger: PredictionTrigger;
  opportunities: number;
  predictions: number;
  clicks: number;
  successfulReuse: number;
  wastedBytes: number;
}

export interface HyperdriveLearningSnapshot {
  version: typeof LEARNER_VERSION;
  buckets: readonly LearningBucket[];
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function counter(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, MAX_COUNTER)
    : 0;
}

function bucketKey(key: LearningKey): string {
  return `${key.adapterId}\u0000${key.trigger}`;
}

/**
 * A deliberately small local aggregate learner. It stores no URL, title, query or
 * timestamp; only adapter/trigger outcome counters suitable for local persistence.
 */
export class HyperdriveOutcomeLearner {
  readonly #buckets = new Map<string, LearningBucket>();

  constructor(snapshot?: unknown) {
    if (
      !snapshot ||
      typeof snapshot !== "object" ||
      (snapshot as { version?: unknown }).version !== LEARNER_VERSION ||
      !Array.isArray((snapshot as { buckets?: unknown }).buckets)
    ) {
      return;
    }

    for (const value of (
      snapshot as { buckets: readonly Partial<LearningBucket>[] }
    ).buckets.slice(0, MAX_BUCKETS)) {
      if (
        typeof value.adapterId !== "string" ||
        !ADAPTER_IDS.has(value.adapterId) ||
        typeof value.trigger !== "string" ||
        !TRIGGERS.has(value.trigger)
      ) {
        continue;
      }
      const candidate: LearningBucket = {
        adapterId: value.adapterId as LearningBucket["adapterId"],
        trigger: value.trigger as PredictionTrigger,
        opportunities: counter(value.opportunities),
        predictions: counter(value.predictions),
        clicks: counter(value.clicks),
        successfulReuse: counter(value.successfulReuse),
        wastedBytes: counter(value.wastedBytes),
      };
      this.#buckets.set(bucketKey(candidate), candidate);
    }
  }

  record(outcome: PredictionOutcome): void {
    if (!ADAPTER_IDS.has(outcome.adapterId) || !TRIGGERS.has(outcome.trigger)) {
      return;
    }
    const key = bucketKey(outcome);
    const bucket = this.#buckets.get(key) ?? {
      adapterId: outcome.adapterId,
      trigger: outcome.trigger,
      opportunities: 0,
      predictions: 0,
      clicks: 0,
      successfulReuse: 0,
      wastedBytes: 0,
    };
    bucket.opportunities = Math.min(MAX_COUNTER, bucket.opportunities + 1);
    if (outcome.predicted) {
      bucket.predictions = Math.min(MAX_COUNTER, bucket.predictions + 1);
    }
    if (outcome.clicked) {
      bucket.clicks = Math.min(MAX_COUNTER, bucket.clicks + 1);
    }
    if (outcome.reused) {
      bucket.successfulReuse = Math.min(
        MAX_COUNTER,
        bucket.successfulReuse + 1,
      );
    }
    bucket.wastedBytes = Math.min(
      MAX_COUNTER,
      bucket.wastedBytes + Math.max(0, Math.round(outcome.wastedBytes ?? 0)),
    );
    this.#buckets.set(key, bucket);
  }

  /**
   * Blend the raw score with observed click-through rate. Eight prior observations
   * make early results conservative; even mature history can only move a score 15%.
   */
  calibrate(baseConfidence: number, key: LearningKey): number {
    const bucket = this.#buckets.get(bucketKey(key));
    if (!bucket || bucket.opportunities === 0) return clamp(baseConfidence);
    const empiricalRate = (bucket.clicks + 2) / (bucket.opportunities + 4);
    const maturity = Math.min(1, bucket.opportunities / 40);
    const adjustment = (empiricalRate - 0.5) * 0.3 * maturity;
    return clamp(baseConfidence + adjustment);
  }

  getBucket(key: LearningKey): Readonly<LearningBucket> | undefined {
    const bucket = this.#buckets.get(bucketKey(key));
    return bucket ? { ...bucket } : undefined;
  }

  snapshot(): HyperdriveLearningSnapshot {
    return {
      version: LEARNER_VERSION,
      buckets: [...this.#buckets.values()]
        .sort((left, right) => bucketKey(left).localeCompare(bucketKey(right)))
        .map((entry) => ({ ...entry })),
    };
  }

  clear(): void {
    this.#buckets.clear();
  }
}
