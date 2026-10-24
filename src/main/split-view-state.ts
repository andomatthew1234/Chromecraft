import { randomUUID } from "node:crypto";

import type {
  SplitViewCommand,
  SplitViewPairSnapshot,
  SplitViewSnapshot,
  TabId,
} from "../shared/browser";

export const SPLIT_DIVIDER_WIDTH = 12;
export const SPLIT_MIN_PANE_WIDTH = 240;
const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;
const MAX_PAIR_ID_LENGTH = 128;

export interface SplitViewRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SplitViewPresentation {
  pair: SplitViewPairSnapshot | null;
  panes: Array<{ tabId: TabId; bounds: SplitViewRectangle }>;
  divider: SplitViewRectangle | null;
  compact: boolean;
}

export interface SplitViewDispatchContext {
  activeTabId: TabId;
  eligibleTabIds: ReadonlySet<TabId>;
}

export interface SplitViewDispatchResult {
  activeTabId: TabId;
  changed: boolean;
}

function clonePair(pair: SplitViewPairSnapshot): SplitViewPairSnapshot {
  return { ...pair };
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio))
    throw new TypeError("Split ratio must be finite.");
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

/**
 * Owns Split View relationships and geometry policy. TabManager remains the
 * lifecycle adapter for native WebContentsView instances.
 */
export class SplitViewState {
  private readonly pairs = new Map<string, SplitViewPairSnapshot>();

  constructor(private readonly createId: () => string = randomUUID) {}

  snapshot(activeTabId: TabId): SplitViewSnapshot {
    return {
      pairs: [...this.pairs.values()].map(clonePair),
      activePairId: this.pairForTab(activeTabId)?.id ?? null,
    };
  }

  restore(
    requestedPairs: readonly SplitViewPairSnapshot[],
    eligibleTabIds: ReadonlySet<TabId>,
  ): void {
    this.pairs.clear();
    const claimedTabs = new Set<TabId>();
    for (const requested of requestedPairs) {
      if (
        !requested.id ||
        requested.id.length > MAX_PAIR_ID_LENGTH ||
        this.pairs.has(requested.id) ||
        requested.leftTabId === requested.rightTabId ||
        !eligibleTabIds.has(requested.leftTabId) ||
        !eligibleTabIds.has(requested.rightTabId) ||
        claimedTabs.has(requested.leftTabId) ||
        claimedTabs.has(requested.rightTabId) ||
        !Number.isFinite(requested.ratio)
      ) {
        continue;
      }
      const focusedTabId =
        requested.focusedTabId === requested.rightTabId
          ? requested.rightTabId
          : requested.leftTabId;
      const pair: SplitViewPairSnapshot = {
        id: requested.id,
        leftTabId: requested.leftTabId,
        rightTabId: requested.rightTabId,
        ratio: clampRatio(requested.ratio),
        focusedTabId,
      };
      this.pairs.set(pair.id, pair);
      claimedTabs.add(pair.leftTabId);
      claimedTabs.add(pair.rightTabId);
    }
  }

  dispatch(
    command: SplitViewCommand,
    context: SplitViewDispatchContext,
  ): SplitViewDispatchResult {
    if (command.type === "create") {
      if (command.side !== "left" && command.side !== "right") {
        throw new TypeError("Split View side must be left or right.");
      }
      const activeTabId = context.activeTabId;
      if (activeTabId === command.tabId) {
        throw new Error("Choose a different tab for Split View.");
      }
      if (
        !context.eligibleTabIds.has(activeTabId) ||
        !context.eligibleTabIds.has(command.tabId)
      ) {
        throw new Error("Split View is available for loaded website tabs.");
      }
      if (this.pairForTab(activeTabId) || this.pairForTab(command.tabId)) {
        throw new Error(
          "A tab can belong to only one Split View. Exit its current split first.",
        );
      }
      const id = this.createId();
      if (!id || id.length > MAX_PAIR_ID_LENGTH || this.pairs.has(id)) {
        throw new Error("Could not create a unique Split View.");
      }
      const pair: SplitViewPairSnapshot = {
        id,
        leftTabId: command.side === "left" ? command.tabId : activeTabId,
        rightTabId: command.side === "right" ? command.tabId : activeTabId,
        ratio: 0.5,
        focusedTabId: activeTabId,
      };
      this.pairs.set(pair.id, pair);
      return { activeTabId, changed: true };
    }

    const pair = this.pairs.get(command.pairId);
    if (!pair) throw new Error("That Split View is no longer available.");

    if (command.type === "focus") {
      if (
        command.tabId !== pair.leftTabId &&
        command.tabId !== pair.rightTabId
      ) {
        throw new Error("That tab is not part of this Split View.");
      }
      const changed = pair.focusedTabId !== command.tabId;
      pair.focusedTabId = command.tabId;
      return { activeTabId: command.tabId, changed };
    }
    if (command.type === "resize") {
      const ratio = clampRatio(command.ratio);
      const changed = Math.abs(pair.ratio - ratio) > 0.0001;
      pair.ratio = ratio;
      return { activeTabId: context.activeTabId, changed };
    }
    if (command.type === "swap") {
      [pair.leftTabId, pair.rightTabId] = [pair.rightTabId, pair.leftTabId];
      return { activeTabId: context.activeTabId, changed: true };
    }
    if (command.type === "exit") {
      this.pairs.delete(pair.id);
      return { activeTabId: context.activeTabId, changed: true };
    }

    const unsupported: never = command;
    throw new TypeError(
      `Unsupported Split View command: ${String((unsupported as { type?: unknown }).type)}`,
    );
  }

  pairForTab(tabId: TabId): SplitViewPairSnapshot | null {
    for (const pair of this.pairs.values()) {
      if (pair.leftTabId === tabId || pair.rightTabId === tabId)
        return clonePair(pair);
    }
    return null;
  }

  noteFocusedTab(tabId: TabId): void {
    const pair = this.mutablePairForTab(tabId);
    if (pair) pair.focusedTabId = tabId;
  }

  removeTab(tabId: TabId): TabId | null {
    const pair = this.mutablePairForTab(tabId);
    if (!pair) return null;
    const peer = pair.leftTabId === tabId ? pair.rightTabId : pair.leftTabId;
    this.pairs.delete(pair.id);
    return peer;
  }

  presentation(
    activeTabId: TabId,
    pageBounds: SplitViewRectangle,
    fullscreenTabId: TabId | null,
  ): SplitViewPresentation {
    const pair = this.pairForTab(activeTabId);
    if (!pair || fullscreenTabId) {
      const visibleTabId = fullscreenTabId ?? activeTabId;
      return {
        pair,
        panes: [{ tabId: visibleTabId, bounds: { ...pageBounds } }],
        divider: null,
        compact: false,
      };
    }

    const availableWidth = Math.max(0, pageBounds.width - SPLIT_DIVIDER_WIDTH);
    const compact =
      pageBounds.width < SPLIT_MIN_PANE_WIDTH * 2 + SPLIT_DIVIDER_WIDTH;
    if (compact) {
      return {
        pair,
        panes: [{ tabId: activeTabId, bounds: { ...pageBounds } }],
        divider: null,
        compact: true,
      };
    }

    const geometryMinimum = SPLIT_MIN_PANE_WIDTH / availableWidth;
    const effectiveRatio = Math.min(
      1 - geometryMinimum,
      Math.max(geometryMinimum, pair.ratio),
    );
    const leftWidth = Math.round(availableWidth * effectiveRatio);
    const rightWidth = availableWidth - leftWidth;
    const dividerX = pageBounds.x + leftWidth;
    return {
      pair,
      panes: [
        {
          tabId: pair.leftTabId,
          bounds: { ...pageBounds, width: leftWidth },
        },
        {
          tabId: pair.rightTabId,
          bounds: {
            x: dividerX + SPLIT_DIVIDER_WIDTH,
            y: pageBounds.y,
            width: rightWidth,
            height: pageBounds.height,
          },
        },
      ],
      divider: {
        x: dividerX,
        y: pageBounds.y,
        width: SPLIT_DIVIDER_WIDTH,
        height: pageBounds.height,
      },
      compact: false,
    };
  }

  private mutablePairForTab(tabId: TabId): SplitViewPairSnapshot | null {
    for (const pair of this.pairs.values()) {
      if (pair.leftTabId === tabId || pair.rightTabId === tabId) return pair;
    }
    return null;
  }
}
