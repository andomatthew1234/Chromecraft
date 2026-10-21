import { describe, expect, it } from "vitest";

import {
  clampFloatingPosition,
  extensionActionSelected,
  isHyperdriveEnabled,
  tabHoverCardContent,
} from "./toolbar-model";

describe("toolbar model", () => {
  it("illuminates only the extension whose popup is open", () => {
    expect(extensionActionSelected(null, "bitwarden")).toBe(false);
    expect(extensionActionSelected("shazam", "bitwarden")).toBe(false);
    expect(extensionActionSelected("bitwarden", "bitwarden")).toBe(true);
  });

  it("maps Hyperdrive preference state to a simple on/off indicator", () => {
    expect(isHyperdriveEnabled("off")).toBe(false);
    expect(isHyperdriveEnabled("balanced")).toBe(true);
    expect(isHyperdriveEnabled("aggressive")).toBe(true);
  });

  it("keeps a dragged floating surface inside the viewport", () => {
    expect(
      clampFloatingPosition(
        { x: -40, y: 900 },
        { width: 380, height: 96 },
        { width: 1_200, height: 800 },
        12,
      ),
    ).toEqual({ x: 12, y: 692 });
  });

  it("builds a useful tab preview without exposing a native title tooltip", () => {
    expect(
      tabHoverCardContent({
        title: "Material Design 3",
        url: "https://m3.material.io/components",
      }),
    ).toEqual({
      title: "Material Design 3",
      host: "m3.material.io",
      url: "https://m3.material.io/components",
    });
  });
});
