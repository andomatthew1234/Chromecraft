import { adaptLinkCandidate, resolveSiteCandidateUrl } from "./adapters";
import { HyperdriveOutcomeLearner } from "./learner";
import {
  HYPERDRIVE_MAX_CANDIDATES,
  HYPERDRIVE_MAX_PREDICTIONS,
  type HyperdriveMode,
  type LinkCandidate,
  type MonotonicClock,
  type PointerIntentScore,
  type PredictionBatch,
  type PredictionTrigger,
  type PreparationTier,
  type RankedPrediction,
} from "./model";
import {
  evaluateSpeculationEligibility,
  type HyperdrivePolicyOptions,
} from "./policy";

export interface PredictionEngineOptions {
  mode?: HyperdriveMode;
  maxCandidates?: number;
  maxPredictions?: number;
  policy?: HyperdrivePolicyOptions;
  learner?: HyperdriveOutcomeLearner;
  clock?: MonotonicClock;
}

export interface PredictionInput {
  currentUrl: string;
  candidates: readonly LinkCandidate[];
  pointerIntent?: readonly PointerIntentScore[];
}

const MODE_THRESHOLDS: Readonly<
  Record<
    Exclude<HyperdriveMode, "off">,
    { connection: number; prefetch: number }
  >
> = {
  balanced: { connection: 0.38, prefetch: 0.82 },
  aggressive: { connection: 0.25, prefetch: 0.67 },
  maximum: { connection: 0.15, prefetch: 0.52 },
};

const HOVER_PREFETCH_THRESHOLDS: Readonly<
  Record<Exclude<HyperdriveMode, "off">, number>
> = {
  balanced: 0.6,
  aggressive: 0.56,
  maximum: 0.52,
};

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function defaultClock(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function triggerFor(
  candidate: LinkCandidate,
  pointer: PointerIntentScore | undefined,
  adapterPriority: number,
): PredictionTrigger {
  if (candidate.trigger) return candidate.trigger;
  if (candidate.source === "omnibox") {
    return candidate.selected ? "omnibox-selection" : "omnibox-autocomplete";
  }
  if (pointer?.hovering) return "hover";
  if (pointer && pointer.confidence >= 0.25) return "cursor-trajectory";
  if (
    (candidate.historicalClicks ?? 0) > 0 ||
    (candidate.visitCount ?? 0) > 0
  ) {
    return "history";
  }
  if (adapterPriority > 0) return "site-adapter";
  return "visible-link";
}

function tierFor(
  mode: Exclude<HyperdriveMode, "off">,
  confidence: number,
  maximum: PreparationTier,
  trigger: PredictionTrigger,
): PreparationTier {
  const threshold = MODE_THRESHOLDS[mode];
  const prefetchThreshold =
    trigger === "hover"
      ? Math.min(threshold.prefetch, HOVER_PREFETCH_THRESHOLDS[mode])
      : threshold.prefetch;
  if (confidence >= prefetchThreshold && maximum === "prefetch")
    return "prefetch";
  if (confidence >= threshold.connection && maximum !== "none")
    return "connection";
  return "none";
}

function titleFor(candidate: LinkCandidate, normalizedUrl: string): string {
  if (candidate.title?.trim()) return candidate.title.trim();
  try {
    return new URL(normalizedUrl).hostname;
  } catch {
    return normalizedUrl;
  }
}

function finitePositive(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

function candidateStrength(
  candidate: LinkCandidate,
  pointer: PointerIntentScore | undefined,
): number {
  return (
    (candidate.selected ? 100 : 0) +
    (candidate.source === "omnibox" ? 20 : 0) +
    (pointer?.hovering ? 10 : 0) +
    finitePositive(pointer?.confidence) * 5 +
    Math.min(4, Math.log2(1 + finitePositive(candidate.visitCount)))
  );
}

function mergeDuplicateCandidate(
  existing: LinkCandidate,
  candidate: LinkCandidate,
  pointerById: ReadonlyMap<string, PointerIntentScore>,
): LinkCandidate {
  const preferred =
    candidateStrength(candidate, pointerById.get(candidate.id)) >
    candidateStrength(existing, pointerById.get(existing.id))
      ? candidate
      : existing;
  return {
    ...preferred,
    bookmarked: existing.bookmarked === true || candidate.bookmarked === true,
    alreadySpeculated:
      existing.alreadySpeculated === true ||
      candidate.alreadySpeculated === true,
    historicalClicks: Math.max(
      finitePositive(existing.historicalClicks),
      finitePositive(candidate.historicalClicks),
    ),
    historicalImpressions: Math.max(
      finitePositive(existing.historicalImpressions),
      finitePositive(candidate.historicalImpressions),
    ),
    visitCount: Math.max(
      finitePositive(existing.visitCount),
      finitePositive(candidate.visitCount),
    ),
    estimatedPreparationBytes: (() => {
      const existingEstimate = finitePositive(
        existing.estimatedPreparationBytes,
      );
      const candidateEstimate = finitePositive(
        candidate.estimatedPreparationBytes,
      );
      if (existingEstimate > 0 && candidateEstimate > 0) {
        return Math.min(existingEstimate, candidateEstimate);
      }
      return existingEstimate || candidateEstimate;
    })(),
  };
}

function normalizedUrl(value: string, currentUrl: string): string | null {
  if (value.length > 8_192) return null;
  try {
    const url = new URL(resolveSiteCandidateUrl(currentUrl, value), currentUrl);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function rejectedUrl(value: string, sensitive: boolean): string {
  if (!sensitive) return value.slice(0, 512);
  try {
    return `${new URL(value).origin}/[sensitive]`;
  } catch {
    return "[sensitive]";
  }
}

/**
 * Deterministic, bounded ranking. DOM collection and network preparation are kept
 * outside this class so pointer input never waits for I/O.
 */
export class HyperdrivePredictionEngine {
  readonly #mode: HyperdriveMode;
  readonly #maxCandidates: number;
  readonly #maxPredictions: number;
  readonly #policy: HyperdrivePolicyOptions;
  readonly #learner: HyperdriveOutcomeLearner;
  readonly #clock: MonotonicClock;

  constructor(options: PredictionEngineOptions = {}) {
    this.#mode = options.mode ?? "balanced";
    this.#maxCandidates = Math.min(
      HYPERDRIVE_MAX_CANDIDATES,
      Math.max(
        1,
        Math.floor(options.maxCandidates ?? HYPERDRIVE_MAX_CANDIDATES),
      ),
    );
    this.#maxPredictions = Math.min(
      HYPERDRIVE_MAX_PREDICTIONS,
      Math.max(
        1,
        Math.floor(options.maxPredictions ?? HYPERDRIVE_MAX_PREDICTIONS),
      ),
    );
    this.#policy = options.policy ?? {};
    this.#learner = options.learner ?? new HyperdriveOutcomeLearner();
    this.#clock = options.clock ?? defaultClock;
  }

  rank(input: PredictionInput): PredictionBatch {
    const startedAt = this.#clock();
    if (this.#mode === "off") {
      return {
        predictions: [],
        rejected: [],
        considered: 0,
        truncated: input.candidates.length > 0,
        rankingTimeMs: Math.max(0, this.#clock() - startedAt),
      };
    }

    const mode = this.#mode;
    const pointerById = new Map(
      (input.pointerIntent ?? []).map((entry) => [entry.candidateId, entry]),
    );
    const predictions: RankedPrediction[] = [];
    const rejected: PredictionBatch["rejected"][number][] = [];
    const boundedCandidates = input.candidates.slice(0, this.#maxCandidates);
    const candidateByUrl = new Map<string, LinkCandidate>();
    for (const candidate of boundedCandidates) {
      const url = normalizedUrl(candidate.url, input.currentUrl);
      if (!url) {
        rejected.push({
          candidateId: candidate.id,
          url: rejectedUrl(candidate.url, false),
          reason: "invalid-url",
        });
        continue;
      }
      const normalizedCandidate = { ...candidate, url };
      const existing = candidateByUrl.get(url);
      candidateByUrl.set(
        url,
        existing
          ? mergeDuplicateCandidate(existing, normalizedCandidate, pointerById)
          : normalizedCandidate,
      );
    }
    const candidates = [...candidateByUrl.values()];

    for (const candidate of candidates) {
      const url = candidate.url;

      const adapter = adaptLinkCandidate(input.currentUrl, {
        ...candidate,
        url,
      });
      const eligibility = evaluateSpeculationEligibility(
        input.currentUrl,
        url,
        this.#policy,
      );
      if (
        !eligibility.eligible ||
        adapter.sensitive ||
        adapter.suppressSpeculation
      ) {
        rejected.push({
          candidateId: candidate.id,
          url: rejectedUrl(url, adapter.sensitive || eligibility.sensitive),
          reason: adapter.sensitive
            ? "sensitive-adapter-content"
            : adapter.suppressSpeculation
              ? "site-already-speculates-or-unsafe"
              : eligibility.reason,
        });
        continue;
      }

      const pointer = pointerById.get(candidate.id);
      const trigger = triggerFor(candidate, pointer, adapter.priority);
      const impressions = finitePositive(candidate.historicalImpressions);
      const clicks = Math.min(
        finitePositive(candidate.historicalClicks),
        impressions,
      );
      const localClickRate =
        impressions > 0 ? (clicks + 1) / (impressions + 3) : 0;
      const historySignal = Math.min(
        1,
        Math.log2(1 + finitePositive(candidate.visitCount)) / 6,
      );
      const pointerConfidence = finitePositive(pointer?.confidence);

      let confidence =
        0.07 +
        (candidate.visible === false ? -0.06 : 0.03) +
        clamp(pointerConfidence) * 0.58 +
        adapter.priority +
        localClickRate * 0.16 +
        historySignal * 0.1 +
        (candidate.bookmarked ? 0.05 : 0) +
        (candidate.source === "omnibox" ? 0.13 : 0) +
        (candidate.selected ? 0.24 : 0);
      confidence = this.#learner.calibrate(clamp(confidence), {
        adapterId: adapter.adapterId,
        trigger,
      });

      const preparationTier = tierFor(
        mode,
        confidence,
        eligibility.maxTier,
        trigger,
      );
      const preparationCost =
        preparationTier === "prefetch"
          ? 0.08
          : preparationTier === "connection"
            ? 0.025
            : 0;
      const estimatedBytes = finitePositive(
        candidate.estimatedPreparationBytes,
      );
      const sizeCost =
        estimatedBytes > 0
          ? Math.min(0.12, (estimatedBytes / (8 * 1024 * 1024)) * 0.12)
          : 0;
      const utility = clamp(
        confidence -
          preparationCost -
          sizeCost +
          (candidate.selected ? 0.04 : 0),
      );
      const reasons = [
        ...adapter.reasons,
        ...(pointer?.reasons ?? []),
        ...(candidate.selected ? ["Selected suggestion"] : []),
        ...(historySignal > 0 ? ["Local visit history"] : []),
      ];
      predictions.push({
        candidateId: candidate.id,
        url,
        title: titleFor(candidate, url),
        confidence,
        utility,
        trigger,
        reasons,
        preparationTier,
        adapter,
      });
    }

    predictions.sort(
      (left, right) =>
        right.utility - left.utility ||
        right.confidence - left.confidence ||
        left.url.localeCompare(right.url),
    );

    return {
      predictions: predictions.slice(0, this.#maxPredictions),
      rejected,
      considered: boundedCandidates.length,
      truncated:
        input.candidates.length > this.#maxCandidates ||
        predictions.length > this.#maxPredictions,
      rankingTimeMs: Math.max(0, this.#clock() - startedAt),
    };
  }
}
