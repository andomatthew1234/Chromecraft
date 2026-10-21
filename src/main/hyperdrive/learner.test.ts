import { describe, expect, it } from "vitest";

import { HyperdriveOutcomeLearner } from "./learner";
import type { PredictionOutcome } from "./model";

const baseOutcome: PredictionOutcome = {
  adapterId: "generic",
  trigger: "cursor-trajectory",
  predicted: true,
  clicked: true,
  reused: true,
};

describe("HyperdriveOutcomeLearner", () => {
  it("records aggregate outcome and reuse counters", () => {
    const learner = new HyperdriveOutcomeLearner();
    learner.record({ ...baseOutcome, wastedBytes: 512 });
    learner.record({
      ...baseOutcome,
      clicked: false,
      reused: false,
      wastedBytes: 1_024,
    });

    expect(
      learner.getBucket({
        adapterId: "generic",
        trigger: "cursor-trajectory",
      }),
    ).toEqual({
      adapterId: "generic",
      trigger: "cursor-trajectory",
      opportunities: 2,
      predictions: 2,
      clicks: 1,
      successfulReuse: 1,
      wastedBytes: 1_536,
    });
  });

  it("records misses without calling them successful predictions", () => {
    const learner = new HyperdriveOutcomeLearner();
    learner.record({ ...baseOutcome, predicted: false, reused: false });
    expect(
      learner.getBucket({
        adapterId: "generic",
        trigger: "cursor-trajectory",
      }),
    ).toMatchObject({ opportunities: 1, predictions: 0, clicks: 1 });
  });

  it("calibrates conservatively from repeated outcomes", () => {
    const successful = new HyperdriveOutcomeLearner();
    const unsuccessful = new HyperdriveOutcomeLearner();
    for (let index = 0; index < 40; index += 1) {
      successful.record(baseOutcome);
      unsuccessful.record({ ...baseOutcome, clicked: false, reused: false });
    }
    const key = { adapterId: "generic", trigger: "cursor-trajectory" } as const;
    expect(successful.calibrate(0.5, key)).toBeGreaterThan(0.6);
    expect(unsuccessful.calibrate(0.5, key)).toBeLessThan(0.4);
  });

  it("round-trips a bounded, URL-free persistence snapshot", () => {
    const learner = new HyperdriveOutcomeLearner();
    learner.record(baseOutcome);
    const serialized = JSON.stringify(learner.snapshot());
    const restored = new HyperdriveOutcomeLearner(JSON.parse(serialized));

    expect(serialized).not.toContain("http");
    expect(restored.snapshot()).toEqual(learner.snapshot());
  });

  it("fails closed on malformed snapshots and clears all learning", () => {
    const learner = new HyperdriveOutcomeLearner({
      version: 1,
      buckets: [{ adapterId: null, trigger: 4, clicks: -100 }],
    });
    expect(learner.snapshot().buckets).toEqual([]);
    learner.record(baseOutcome);
    learner.clear();
    expect(learner.snapshot().buckets).toEqual([]);
  });

  it("does not accept arbitrary strings that could smuggle identifiers", () => {
    const learner = new HyperdriveOutcomeLearner({
      version: 1,
      buckets: [
        {
          adapterId: "https://private.example",
          trigger: "private-query",
          opportunities: 10,
        },
      ],
    });
    expect(learner.snapshot().buckets).toEqual([]);

    learner.record({
      ...baseOutcome,
      adapterId: "https://private.example" as "generic",
    });
    expect(learner.snapshot().buckets).toEqual([]);
  });
});
