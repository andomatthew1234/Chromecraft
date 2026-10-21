import { describe, expect, it } from "vitest";

import { rankCursorIntent } from "./cursor-intent";
import type { LinkCandidate, PointSample } from "./model";

function link(
  id: string,
  left: number,
  top = 40,
  right = left + 60,
  bottom = top + 40,
): LinkCandidate {
  return {
    id,
    url: `https://example.com/${id}`,
    visible: true,
    rect: { left, top, right, bottom },
  };
}

describe("rankCursorIntent", () => {
  it("returns no prediction without pointer samples", () => {
    expect(
      rankCursorIntent({ samples: [], candidates: [link("one", 100)] }),
    ).toEqual({
      ranked: [],
      speedPxPerMs: 0,
      accelerationPxPerMs2: 0,
      horizonMs: 0,
    });
  });

  it("predicts a link before hover when the trajectory intersects it", () => {
    const result = rankCursorIntent({
      samples: [
        { x: 0, y: 60, timeMs: 0 },
        { x: 50, y: 60, timeMs: 25 },
      ],
      candidates: [link("ahead", 120), link("behind", -100)],
    });

    expect(result.winnerId).toBe("ahead");
    expect(result.ranked[0]).toMatchObject({
      intersectsPredictedPath: true,
      approaching: true,
      hovering: false,
    });
    expect(result.ranked[0].confidence).toBeGreaterThan(0.5);
  });

  it("elevates hover confidence without assuming hover guarantees a click", () => {
    const result = rankCursorIntent({
      samples: [{ x: 130, y: 60, timeMs: 100 }],
      candidates: [link("hovered", 120)],
      hoverCandidateId: "hovered",
      hoverDurationMs: 400,
    });

    expect(result.ranked[0].hovering).toBe(true);
    expect(result.ranked[0].confidence).toBeGreaterThan(0.5);
    expect(result.ranked[0].confidence).toBeLessThan(1);
  });

  it("detects deceleration and extends the prediction horizon", () => {
    const result = rankCursorIntent({
      samples: [
        { x: 0, y: 60, timeMs: 0 },
        { x: 40, y: 60, timeMs: 10 },
        { x: 50, y: 60, timeMs: 20 },
      ],
      candidates: [link("ahead", 120)],
    });

    expect(result.accelerationPxPerMs2).toBeLessThan(0);
    expect(result.horizonMs).toBeGreaterThan(200);
  });

  it("switches rapidly when direction reverses decisively", () => {
    const before = rankCursorIntent({
      samples: [
        { x: 100, y: 60, timeMs: 0 },
        { x: 140, y: 60, timeMs: 20 },
      ],
      candidates: [link("right", 220), link("left", 0)],
    });
    const after = rankCursorIntent({
      samples: [
        { x: 140, y: 60, timeMs: 20 },
        { x: 90, y: 60, timeMs: 40 },
      ],
      candidates: [link("right", 220), link("left", 0)],
      previousWinnerId: before.winnerId,
    });

    expect(before.winnerId).toBe("right");
    expect(after.winnerId).toBe("left");
  });

  it("uses hysteresis for adjacent links with near-equal scores", () => {
    const result = rankCursorIntent({
      samples: [
        { x: 100, y: 60, timeMs: 0 },
        { x: 130, y: 60, timeMs: 30 },
      ],
      candidates: [
        link("new", 200, 35, 250, 70),
        link("stable", 200, 55, 250, 90),
      ],
      previousWinnerId: "stable",
    });

    expect(result.winnerId).toBe("stable");
  });

  it("ignores hidden or geometry-free candidates", () => {
    const candidates: LinkCandidate[] = [
      { ...link("hidden", 100), visible: false },
      { id: "missing", url: "https://example.com/missing" },
    ];
    expect(
      rankCursorIntent({ samples: [{ x: 0, y: 0, timeMs: 0 }], candidates })
        .ranked,
    ).toEqual([]);
  });

  it("ignores non-finite pointer samples and invalid geometry", () => {
    const candidates: LinkCandidate[] = [
      {
        ...link("invalid", 100),
        rect: { left: 100, top: 20, right: Number.NaN, bottom: 80 },
      },
    ];
    expect(
      rankCursorIntent({
        samples: [{ x: Number.POSITIVE_INFINITY, y: 0, timeMs: 0 }],
        candidates,
      }).ranked,
    ).toEqual([]);
  });

  it("bounds work to at most 64 candidates", () => {
    const candidates = Array.from({ length: 80 }, (_, index) =>
      link(String(index), 100 + index),
    );
    const samples: PointSample[] = [{ x: 0, y: 60, timeMs: 0 }];
    const result = rankCursorIntent({
      samples,
      candidates,
      hoverCandidateId: "79",
    });

    expect(result.ranked).toHaveLength(64);
    expect(result.ranked.some((entry) => entry.candidateId === "79")).toBe(
      false,
    );
  });
});
