import { describe, expect, it } from "vitest";

import { browserThemeClass } from "./theme";

describe("browserThemeClass", () => {
  it("exposes every saved colour theme on the Browser Shell", () => {
    expect(browserThemeClass("overworld")).toBe("color-theme-overworld");
    expect(browserThemeClass("nether")).toBe("color-theme-nether");
    expect(browserThemeClass("end")).toBe("color-theme-end");
    expect(browserThemeClass("minimal")).toBe("color-theme-minimal");
  });
});
