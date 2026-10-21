import type { HyperdriveMode } from "../shared/browser";

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export function extensionActionSelected(
  openExtensionId: string | null,
  extensionId: string,
): boolean {
  return openExtensionId === extensionId;
}

export function isHyperdriveEnabled(mode: HyperdriveMode): boolean {
  return mode !== "off";
}

export function clampFloatingPosition(
  position: Point,
  surface: Size,
  viewport: Size,
  margin = 12,
): Point {
  return {
    x: Math.min(
      Math.max(margin, position.x),
      Math.max(margin, viewport.width - surface.width - margin),
    ),
    y: Math.min(
      Math.max(margin, position.y),
      Math.max(margin, viewport.height - surface.height - margin),
    ),
  };
}

export function tabHoverCardContent(tab: { title: string; url: string }): {
  title: string;
  host: string;
  url: string;
} {
  let host = tab.url;
  try {
    host = new URL(tab.url).hostname.replace(/^www\./, "");
  } catch {
    // Keep non-standard internal URLs readable.
  }
  return {
    title: tab.title || host || "New Tab",
    host,
    url: tab.url,
  };
}
