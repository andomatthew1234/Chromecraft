export const HYPERDRIVE_MAX_CANDIDATES = 64;
export const HYPERDRIVE_MAX_PREDICTIONS = 8;

export type HyperdriveMode = "off" | "balanced" | "aggressive" | "maximum";

export type PredictionTrigger =
  | "visible-link"
  | "cursor-trajectory"
  | "hover"
  | "history"
  | "site-adapter"
  | "omnibox-typing"
  | "omnibox-autocomplete"
  | "omnibox-selection";

export type PreparationTier = "none" | "connection" | "prefetch" | "page";

export interface PointSample {
  x: number;
  y: number;
  /** Monotonic timestamp, in milliseconds. */
  timeMs: number;
}

export interface CandidateRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface LinkCandidate {
  /** Stable for the lifetime of one document. */
  id: string;
  url: string;
  title?: string;
  rect?: CandidateRect;
  visible?: boolean;
  /** Aggregate local signals. Raw history is deliberately not required. */
  historicalClicks?: number;
  historicalImpressions?: number;
  visitCount?: number;
  bookmarked?: boolean;
  /** A page may mark a resource it already speculates so Hyperdrive will not duplicate it. */
  alreadySpeculated?: boolean;
  /** Optional scheduler estimate; never presented as measured process memory. */
  estimatedPreparationBytes?: number;
  /** Set only for a currently selected Omnibox suggestion. */
  selected?: boolean;
  source?: "page" | "omnibox";
  trigger?: PredictionTrigger;
}

export interface PointerIntentScore {
  candidateId: string;
  confidence: number;
  distancePx: number;
  intersectsPredictedPath: boolean;
  approaching: boolean;
  hovering: boolean;
  reasons: readonly string[];
}

export interface AdaptedCandidate {
  adapterId: SiteAdapterId | "generic";
  category: string;
  priority: number;
  sensitive: boolean;
  suppressSpeculation: boolean;
  reasons: readonly string[];
}

export type SiteAdapterId =
  | "google"
  | "youtube"
  | "chatgpt"
  | "github"
  | "wikipedia";

export interface RankedPrediction {
  candidateId: string;
  url: string;
  title: string;
  confidence: number;
  utility: number;
  trigger: PredictionTrigger;
  reasons: readonly string[];
  preparationTier: PreparationTier;
  adapter: AdaptedCandidate;
}

export interface RejectedPrediction {
  candidateId: string;
  url: string;
  reason: string;
}

export interface PredictionBatch {
  predictions: readonly RankedPrediction[];
  rejected: readonly RejectedPrediction[];
  considered: number;
  truncated: boolean;
  rankingTimeMs: number;
}

export interface LearningKey {
  adapterId: SiteAdapterId | "generic";
  trigger: PredictionTrigger;
}

export interface PredictionOutcome extends LearningKey {
  predicted: boolean;
  clicked: boolean;
  reused: boolean;
  wastedBytes?: number;
}

export type MonotonicClock = () => number;
