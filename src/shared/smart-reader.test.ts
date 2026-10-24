import { describe, expect, it } from "vitest";

import { normalizeSmartReaderAppearance } from "./smart-reader";

describe("normalizeSmartReaderAppearance", () => {
  it("validates themes, fonts, and text scale bounds", () => {
    expect(
      normalizeSmartReaderAppearance({
        theme: "warm",
        font: "sans",
        textScale: 4,
      }),
    ).toEqual({ theme: "warm", font: "sans", textScale: 1.35 });
    expect(
      normalizeSmartReaderAppearance({ theme: "unsafe", textScale: 0 }),
    ).toEqual({ theme: "system", font: "serif", textScale: 0.8 });
  });
});
