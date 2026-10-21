import { describe, expect, it } from "vitest";

import {
  selectSidebarTool,
  sidebarMenuActionLabel,
  sidebarWidth,
} from "./sidebar";

describe("sidebar interaction model", () => {
  it("opens and illuminates a tool that is not active", () => {
    expect(selectSidebarTool(null, "bookmarks")).toBe("bookmarks");
    expect(selectSidebarTool("bookmarks", "history")).toBe("history");
  });

  it("closes and deilluminates the currently active tool", () => {
    expect(selectSidebarTool("bookmarks", "bookmarks")).toBeNull();
  });

  it("describes the C menu action from whole-sidebar visibility", () => {
    expect(sidebarMenuActionLabel(true)).toBe("Collapse sidebar");
    expect(sidebarMenuActionLabel(false)).toBe("Expand sidebar");
  });

  it("allocates no page space when detached and only rail space without a panel", () => {
    expect(sidebarWidth(false, true)).toBe(0);
    expect(sidebarWidth(true, false)).toBe(54);
    expect(sidebarWidth(true, true)).toBe(286);
  });
});
