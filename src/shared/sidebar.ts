export const SIDEBAR_DETACHED_WIDTH = 0;
export const SIDEBAR_RAIL_WIDTH = 54;
export const SIDEBAR_PANEL_WIDTH = 286;

export type SidebarTool =
  | "bookmarks"
  | "history"
  | "downloads"
  | "extensions"
  | "settings";

export function selectSidebarTool(
  activeTool: SidebarTool | null,
  selectedTool: SidebarTool,
): SidebarTool | null {
  return activeTool === selectedTool ? null : selectedTool;
}

export function sidebarMenuActionLabel(sidebarAttached: boolean) {
  return sidebarAttached ? "Collapse sidebar" : "Expand sidebar";
}

export function sidebarWidth(
  sidebarAttached: boolean,
  panelOpen: boolean,
): number {
  if (!sidebarAttached) return SIDEBAR_DETACHED_WIDTH;
  return panelOpen ? SIDEBAR_PANEL_WIDTH : SIDEBAR_RAIL_WIDTH;
}
