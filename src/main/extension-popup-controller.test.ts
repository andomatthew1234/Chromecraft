import { describe, expect, it } from "vitest";

import { calculateExtensionPopupBounds } from "./extension-popup-controller";

describe("calculateExtensionPopupBounds", () => {
  it("right-aligns a full-size popup below its toolbar action", () => {
    const bounds = calculateExtensionPopupBounds(
      { getContentBounds: () => ({ x: 100, y: 50, width: 1280, height: 820 }) },
      { x: 1100, y: 52, width: 40, height: 40 },
    );

    expect(bounds).toEqual({
      x: 740,
      y: 98,
      width: 400,
      height: 600,
    });
  });

  it("clamps the popup inside a narrow parent window", () => {
    const bounds = calculateExtensionPopupBounds(
      { getContentBounds: () => ({ x: 20, y: 30, width: 360, height: 300 }) },
      { x: 330, y: 240, width: 30, height: 40 },
    );

    expect(bounds.x).toBeGreaterThanOrEqual(10);
    expect(bounds.y).toBeGreaterThanOrEqual(10);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(350);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(290);
  });

  it("rejects untrusted or unbounded anchor geometry", () => {
    expect(() =>
      calculateExtensionPopupBounds(
        { getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) },
        { x: Number.NaN, y: 0, width: 40, height: 40 },
      ),
    ).toThrow(/anchor/i);
    expect(() =>
      calculateExtensionPopupBounds(
        { getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) },
        { x: 0, y: 0, width: 20_000, height: 40 },
      ),
    ).toThrow(/anchor/i);
  });
});
