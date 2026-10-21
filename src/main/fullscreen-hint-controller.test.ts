import { describe, expect, it } from "vitest";

import { calculateFullscreenHintBounds } from "./fullscreen-hint-controller";

describe("calculateFullscreenHintBounds", () => {
  it("centres a desktop-sized disclosure without covering the full page", () => {
    expect(calculateFullscreenHintBounds(1280)).toEqual({
      x: 430,
      y: 12,
      width: 420,
      height: 58,
    });
  });

  it("keeps the disclosure within a narrow viewport", () => {
    expect(calculateFullscreenHintBounds(300)).toEqual({
      x: 12,
      y: 12,
      width: 276,
      height: 58,
    });
    expect(calculateFullscreenHintBounds(0)).toEqual({
      x: 0,
      y: 12,
      width: 0,
      height: 58,
    });
  });
});
