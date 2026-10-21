import {
  HYPERDRIVE_MAX_CANDIDATES,
  type CandidateRect,
  type LinkCandidate,
  type PointSample,
  type PointerIntentScore,
} from "./model";

export interface CursorIntentInput {
  samples: readonly PointSample[];
  candidates: readonly LinkCandidate[];
  hoverCandidateId?: string;
  hoverDurationMs?: number;
  previousWinnerId?: string;
  maxCandidates?: number;
}

export interface CursorIntentResult {
  ranked: readonly PointerIntentScore[];
  winnerId?: string;
  speedPxPerMs: number;
  accelerationPxPerMs2: number;
  horizonMs: number;
  predictedPoint?: { x: number; y: number };
}

const EPSILON = 0.000_001;

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function distanceToRect(point: PointSample, rect: CandidateRect): number {
  const dx = Math.max(rect.left - point.x, 0, point.x - rect.right);
  const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom);
  return Math.hypot(dx, dy);
}

function contains(rect: CandidateRect, point: PointSample): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}

function isValidRect(rect: CandidateRect): boolean {
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.right) &&
    Number.isFinite(rect.bottom) &&
    rect.right >= rect.left &&
    rect.bottom >= rect.top
  );
}

function isValidSample(sample: PointSample): boolean {
  return (
    Number.isFinite(sample.x) &&
    Number.isFinite(sample.y) &&
    Number.isFinite(sample.timeMs)
  );
}

function segmentIntersectsRect(
  start: PointSample,
  end: { x: number; y: number },
  rect: CandidateRect,
): boolean {
  let lower = 0;
  let upper = 1;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const checks: readonly [number, number][] = [
    [-dx, start.x - rect.left],
    [dx, rect.right - start.x],
    [-dy, start.y - rect.top],
    [dy, rect.bottom - start.y],
  ];

  for (const [p, q] of checks) {
    if (Math.abs(p) < EPSILON) {
      if (q < 0) return false;
      continue;
    }
    const ratio = q / p;
    if (p < 0) lower = Math.max(lower, ratio);
    else upper = Math.min(upper, ratio);
    if (lower > upper) return false;
  }
  return true;
}

function vector(
  samples: readonly PointSample[],
  offset: number,
): {
  x: number;
  y: number;
  speed: number;
} {
  const end = samples[samples.length - 1 - offset];
  const start = samples[samples.length - 2 - offset];
  if (!start || !end) return { x: 0, y: 0, speed: 0 };
  const elapsed = Math.max(1, end.timeMs - start.timeMs);
  const x = (end.x - start.x) / elapsed;
  const y = (end.y - start.y) / elapsed;
  return { x, y, speed: Math.hypot(x, y) };
}

function scoreCandidate(
  candidate: LinkCandidate,
  current: PointSample,
  previous: PointSample | undefined,
  velocity: { x: number; y: number; speed: number },
  predictedPoint: { x: number; y: number },
  input: CursorIntentInput,
): PointerIntentScore | null {
  if (
    !candidate.rect ||
    candidate.visible === false ||
    !isValidRect(candidate.rect)
  ) {
    return null;
  }
  const rect = candidate.rect;
  const centerX = (rect.left + rect.right) / 2;
  const centerY = (rect.top + rect.bottom) / 2;
  const targetX = centerX - current.x;
  const targetY = centerY - current.y;
  const targetDistance = Math.hypot(targetX, targetY);
  const distance = distanceToRect(current, rect);
  const previousDistance = previous ? distanceToRect(previous, rect) : distance;
  const approaching = previousDistance - distance > 0.5;
  const hovering =
    input.hoverCandidateId === candidate.id || contains(rect, current);
  const intersects = segmentIntersectsRect(current, predictedPoint, rect);
  const alignment =
    velocity.speed > EPSILON && targetDistance > EPSILON
      ? clamp(
          (velocity.x * targetX + velocity.y * targetY) /
            (velocity.speed * targetDistance),
          -1,
          1,
        )
      : 0;

  const proximity = 1 / (1 + distance / 180);
  const reasons: string[] = [];
  let confidence = proximity * 0.18;
  if (alignment > 0) {
    confidence += alignment * 0.28;
    if (alignment > 0.75) reasons.push("Pointer direction aligned");
  }
  if (intersects) {
    confidence += 0.25;
    reasons.push("Predicted path intersects link");
  }
  if (approaching) {
    confidence += 0.12;
    reasons.push("Pointer approaching link");
  }
  if (hovering) {
    confidence += 0.28 + clamp((input.hoverDurationMs ?? 0) / 600) * 0.14;
    reasons.push("Pointer hovering");
  }
  if (input.previousWinnerId === candidate.id) {
    confidence += 0.055;
    reasons.push("Prediction stable");
  }

  return {
    candidateId: candidate.id,
    confidence: clamp(confidence),
    distancePx: distance,
    intersectsPredictedPath: intersects,
    approaching,
    hovering,
    reasons,
  };
}

export function rankCursorIntent(input: CursorIntentInput): CursorIntentResult {
  const samples = input.samples.filter(isValidSample).slice(-4);
  const current = samples.at(-1);
  if (!current) {
    return {
      ranked: [],
      speedPxPerMs: 0,
      accelerationPxPerMs2: 0,
      horizonMs: 0,
    };
  }

  const currentVector = vector(samples, 0);
  const previousVector = vector(samples, 1);
  const vectorElapsed = Math.max(
    1,
    (samples.at(-1)?.timeMs ?? 0) - (samples.at(-2)?.timeMs ?? 0),
  );
  const acceleration =
    (currentVector.speed - previousVector.speed) / vectorElapsed;
  const decelerating = acceleration < -0.002;
  const horizonMs = clamp(
    100 + currentVector.speed * 90 + (decelerating ? 70 : 0),
    90,
    360,
  );
  const predictedPoint = {
    x: current.x + currentVector.x * horizonMs,
    y: current.y + currentVector.y * horizonMs,
  };
  const maximum = Math.min(
    Math.max(1, input.maxCandidates ?? HYPERDRIVE_MAX_CANDIDATES),
    HYPERDRIVE_MAX_CANDIDATES,
  );
  const ranked = input.candidates
    .slice(0, maximum)
    .map((candidate) =>
      scoreCandidate(
        candidate,
        current,
        samples.at(-2),
        currentVector,
        predictedPoint,
        input,
      ),
    )
    .filter((score): score is PointerIntentScore => score !== null)
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.distancePx - right.distancePx ||
        left.candidateId.localeCompare(right.candidateId),
    );

  // Hysteresis avoids oscillation between adjacent links. Keep the old winner when it
  // remains close to the new leader, but switch immediately for a decisive signal.
  const formerWinner = ranked.find(
    (entry) => entry.candidateId === input.previousWinnerId,
  );
  if (
    formerWinner &&
    ranked[0] &&
    ranked[0] !== formerWinner &&
    ranked[0].confidence - formerWinner.confidence < 0.08
  ) {
    ranked.splice(ranked.indexOf(formerWinner), 1);
    ranked.unshift(formerWinner);
  }

  return {
    ranked,
    winnerId: ranked[0]?.candidateId,
    speedPxPerMs: currentVector.speed,
    accelerationPxPerMs2: acceleration,
    horizonMs,
    predictedPoint,
  };
}
