import { describe, expect, it } from "vitest";

import { SPLIT_DIVIDER_WIDTH, SplitViewState } from "./split-view-state";

const eligible = new Set(["left", "right", "third", "fourth"]);

function createState() {
  let id = 0;
  return new SplitViewState(() => `split-${++id}`);
}

describe("SplitViewState", () => {
  it("creates multiple disjoint pairs without changing tab identity", () => {
    const state = createState();
    state.dispatch(
      { type: "create", tabId: "right", side: "right" },
      { activeTabId: "left", eligibleTabIds: eligible },
    );
    state.dispatch(
      { type: "create", tabId: "fourth", side: "left" },
      { activeTabId: "third", eligibleTabIds: eligible },
    );

    expect(state.snapshot("left")).toEqual({
      activePairId: "split-1",
      pairs: [
        {
          id: "split-1",
          leftTabId: "left",
          rightTabId: "right",
          ratio: 0.5,
          focusedTabId: "left",
        },
        {
          id: "split-2",
          leftTabId: "fourth",
          rightTabId: "third",
          ratio: 0.5,
          focusedTabId: "third",
        },
      ],
    });
  });

  it("rejects duplicate, ineligible and already-paired tabs", () => {
    const state = createState();
    expect(() =>
      state.dispatch(
        { type: "create", tabId: "left", side: "right" },
        { activeTabId: "left", eligibleTabIds: eligible },
      ),
    ).toThrow("different tab");
    expect(() =>
      state.dispatch(
        { type: "create", tabId: "missing", side: "right" },
        { activeTabId: "left", eligibleTabIds: eligible },
      ),
    ).toThrow("loaded website tabs");

    state.dispatch(
      { type: "create", tabId: "right", side: "right" },
      { activeTabId: "left", eligibleTabIds: eligible },
    );
    expect(() =>
      state.dispatch(
        { type: "create", tabId: "third", side: "right" },
        { activeTabId: "left", eligibleTabIds: eligible },
      ),
    ).toThrow("only one Split View");
  });

  it("focuses, resizes, swaps and exits through one command interface", () => {
    const state = createState();
    state.dispatch(
      { type: "create", tabId: "right", side: "right" },
      { activeTabId: "left", eligibleTabIds: eligible },
    );

    expect(
      state.dispatch(
        { type: "focus", pairId: "split-1", tabId: "right" },
        { activeTabId: "left", eligibleTabIds: eligible },
      ).activeTabId,
    ).toBe("right");
    state.dispatch(
      { type: "resize", pairId: "split-1", ratio: 0.7 },
      { activeTabId: "right", eligibleTabIds: eligible },
    );
    state.dispatch(
      { type: "swap", pairId: "split-1" },
      { activeTabId: "right", eligibleTabIds: eligible },
    );
    expect(state.snapshot("right").pairs[0]).toMatchObject({
      leftTabId: "right",
      rightTabId: "left",
      ratio: 0.7,
      focusedTabId: "right",
    });
    state.dispatch(
      { type: "exit", pairId: "split-1" },
      { activeTabId: "right", eligibleTabIds: eligible },
    );
    expect(state.snapshot("right")).toEqual({
      activePairId: null,
      pairs: [],
    });
  });

  it("lays out exact side-by-side integer bounds and clamps minimum widths", () => {
    const state = createState();
    state.dispatch(
      { type: "create", tabId: "right", side: "right" },
      { activeTabId: "left", eligibleTabIds: eligible },
    );
    state.dispatch(
      { type: "resize", pairId: "split-1", ratio: 0.05 },
      { activeTabId: "left", eligibleTabIds: eligible },
    );

    const plan = state.presentation(
      "left",
      { x: 54, y: 104, width: 1000, height: 700 },
      null,
    );
    expect(plan.compact).toBe(false);
    expect(plan.panes[0]?.bounds.width).toBeGreaterThanOrEqual(240);
    expect(plan.panes[1]?.bounds.width).toBeGreaterThanOrEqual(240);
    expect(
      plan.panes[0]!.bounds.width +
        SPLIT_DIVIDER_WIDTH +
        plan.panes[1]!.bounds.width,
    ).toBe(1000);
    expect(plan.panes[1]!.bounds.x).toBe(plan.divider!.x + SPLIT_DIVIDER_WIDTH);
  });

  it("focuses one pane in narrow windows without destroying the pair", () => {
    const state = createState();
    state.dispatch(
      { type: "create", tabId: "right", side: "right" },
      { activeTabId: "left", eligibleTabIds: eligible },
    );
    const plan = state.presentation(
      "right",
      { x: 0, y: 104, width: 480, height: 600 },
      null,
    );
    expect(plan.compact).toBe(true);
    expect(plan.panes).toEqual([
      { tabId: "right", bounds: { x: 0, y: 104, width: 480, height: 600 } },
    ]);
    expect(state.snapshot("right").pairs).toHaveLength(1);
  });

  it("suspends the peer for HTML fullscreen and restores persisted pairs safely", () => {
    const state = createState();
    state.restore(
      [
        {
          id: "restored",
          leftTabId: "left",
          rightTabId: "right",
          ratio: 0.3,
          focusedTabId: "right",
        },
        {
          id: "invalid-duplicate",
          leftTabId: "right",
          rightTabId: "third",
          ratio: 0.5,
          focusedTabId: "third",
        },
        {
          id: "invalid-ratio",
          leftTabId: "third",
          rightTabId: "fourth",
          ratio: Number.NaN,
          focusedTabId: "third",
        },
      ],
      eligible,
    );
    const fullscreen = state.presentation(
      "right",
      { x: 0, y: 0, width: 1280, height: 720 },
      "right",
    );
    expect(fullscreen.panes).toEqual([
      { tabId: "right", bounds: { x: 0, y: 0, width: 1280, height: 720 } },
    ]);
    expect(state.snapshot("right").pairs).toHaveLength(1);
  });

  it("defends the state boundary from malformed runtime commands", () => {
    const state = createState();
    expect(() =>
      state.dispatch(
        { type: "create", tabId: "right", side: "middle" } as never,
        { activeTabId: "left", eligibleTabIds: eligible },
      ),
    ).toThrow("left or right");
    state.dispatch(
      { type: "create", tabId: "right", side: "right" },
      { activeTabId: "left", eligibleTabIds: eligible },
    );
    expect(() =>
      state.dispatch({ type: "unknown", pairId: "split-1" } as never, {
        activeTabId: "left",
        eligibleTabIds: eligible,
      }),
    ).toThrow("Unsupported Split View command");
  });

  it("removes a pair when either member closes and returns the survivor", () => {
    const state = createState();
    state.dispatch(
      { type: "create", tabId: "right", side: "right" },
      { activeTabId: "left", eligibleTabIds: eligible },
    );
    expect(state.removeTab("left")).toBe("right");
    expect(state.snapshot("right").pairs).toEqual([]);
  });
});
