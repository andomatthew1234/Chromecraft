import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  buildPageContextMenu,
  buildTextContextMenu,
  type PageContextMenuActions,
} from "./page-context-menu";

function context(
  overrides: Partial<ContextMenuParams> = {},
): ContextMenuParams {
  return {
    x: 12,
    y: 24,
    frame: null,
    linkURL: "",
    linkText: "",
    pageURL: "https://example.test/",
    frameURL: "https://example.test/",
    srcURL: "",
    mediaType: "none",
    hasImageContents: false,
    isEditable: false,
    selectionText: "",
    titleText: "",
    altText: "",
    suggestedFilename: "",
    selectionRect: { x: 0, y: 0, width: 0, height: 0 },
    selectionStartOffset: 0,
    referrerPolicy: { policy: "default", url: "" },
    misspelledWord: "",
    dictionarySuggestions: [],
    frameCharset: "utf-8",
    formControlType: "none",
    spellcheckEnabled: false,
    menuSourceType: "mouse",
    mediaFlags: {
      inError: false,
      isPaused: false,
      isMuted: false,
      hasAudio: false,
      isLooping: false,
      isControlsVisible: false,
      canToggleControls: false,
      canPrint: false,
      canSave: false,
      canShowPictureInPicture: false,
      isShowingPictureInPicture: false,
      canRotate: false,
      canLoop: false,
    },
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: false,
      canDelete: false,
      canSelectAll: true,
      canEditRichly: false,
    },
    ...overrides,
  };
}

function actions(): PageContextMenuActions {
  return {
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    openInNewTab: vi.fn(),
    download: vi.fn(),
    copyText: vi.fn(),
    copyImageAt: vi.fn(),
    inspectAt: vi.fn(),
  };
}

function labels(menu: MenuItemConstructorOptions[]): Array<string | undefined> {
  return menu.map((item) => item.label ?? item.role ?? item.type);
}

function click(menu: MenuItemConstructorOptions[], label: string): void {
  const item = menu.find((entry) => entry.label === label);
  expect(item?.click).toBeTypeOf("function");
  item?.click?.(undefined as never, undefined, undefined as never);
}

describe("buildPageContextMenu", () => {
  it("always provides browser navigation and inspection", () => {
    const handlers = actions();
    const menu = buildPageContextMenu(
      context(),
      { canGoBack: false, canGoForward: true },
      handlers,
    );

    expect(labels(menu)).toEqual([
      "Back",
      "Forward",
      "Reload",
      "separator",
      "Inspect",
    ]);
    expect(menu[0].enabled).toBe(false);
    expect(menu[1].enabled).toBe(true);

    click(menu, "Forward");
    click(menu, "Reload");
    click(menu, "Inspect");
    expect(handlers.goForward).toHaveBeenCalledOnce();
    expect(handlers.reload).toHaveBeenCalledOnce();
    expect(handlers.inspectAt).toHaveBeenCalledWith(12, 24);
  });

  it("adds editing roles using Chromium's capability flags", () => {
    const menu = buildPageContextMenu(
      context({
        isEditable: true,
        editFlags: {
          canUndo: true,
          canRedo: false,
          canCut: true,
          canCopy: true,
          canPaste: false,
          canDelete: true,
          canSelectAll: true,
          canEditRichly: false,
        },
      }),
      { canGoBack: false, canGoForward: false },
      actions(),
    );

    expect(labels(menu).slice(0, 9)).toEqual([
      "undo",
      "redo",
      "separator",
      "cut",
      "copy",
      "paste",
      "delete",
      "separator",
      "selectAll",
    ]);
    expect(menu.find((item) => item.role === "undo")?.enabled).toBe(true);
    expect(menu.find((item) => item.role === "redo")?.enabled).toBe(false);
    expect(menu.find((item) => item.role === "paste")?.enabled).toBe(false);
  });

  it("routes safe link commands while still allowing unsafe links to be copied", () => {
    const safeHandlers = actions();
    const safe = buildPageContextMenu(
      context({ linkURL: "https://example.test/path" }),
      { canGoBack: false, canGoForward: false },
      safeHandlers,
    );
    click(safe, "Open link in new tab");
    click(safe, "Save link as…");
    click(safe, "Copy link address");
    expect(safeHandlers.openInNewTab).toHaveBeenCalledWith(
      "https://example.test/path",
    );
    expect(safeHandlers.download).toHaveBeenCalledWith(
      "https://example.test/path",
    );
    expect(safeHandlers.copyText).toHaveBeenCalledWith(
      "https://example.test/path",
    );

    const unsafeHandlers = actions();
    const unsafe = buildPageContextMenu(
      context({ linkURL: "javascript:alert(1)" }),
      { canGoBack: false, canGoForward: false },
      unsafeHandlers,
    );
    expect(labels(unsafe)).not.toContain("Open link in new tab");
    expect(labels(unsafe)).not.toContain("Save link as…");
    click(unsafe, "Copy link address");
    expect(unsafeHandlers.copyText).toHaveBeenCalledWith("javascript:alert(1)");
  });

  it("adds image actions and preserves the click coordinates", () => {
    const handlers = actions();
    const menu = buildPageContextMenu(
      context({
        x: 44,
        y: 55,
        srcURL: "https://example.test/image.png",
        mediaType: "image",
        hasImageContents: true,
      }),
      { canGoBack: false, canGoForward: false },
      handlers,
    );

    click(menu, "Open image in new tab");
    click(menu, "Save image as…");
    click(menu, "Copy image");
    expect(handlers.openInNewTab).toHaveBeenCalledWith(
      "https://example.test/image.png",
    );
    expect(handlers.download).toHaveBeenCalledWith(
      "https://example.test/image.png",
    );
    expect(handlers.copyImageAt).toHaveBeenCalledWith(44, 55);
  });

  it("uses the native copy role for a non-editable selection", () => {
    const menu = buildPageContextMenu(
      context({
        selectionText: "selected text",
        editFlags: {
          canUndo: false,
          canRedo: false,
          canCut: false,
          canCopy: true,
          canPaste: false,
          canDelete: false,
          canSelectAll: false,
          canEditRichly: false,
        },
      }),
      { canGoBack: false, canGoForward: false },
      actions(),
    );

    expect(menu[0]).toMatchObject({ role: "copy", enabled: true });
  });

  it("keeps the browser chrome menu limited to text operations", () => {
    const menu = buildTextContextMenu(
      context({
        isEditable: true,
        linkURL: "https://example.test/",
        editFlags: {
          canUndo: false,
          canRedo: false,
          canCut: true,
          canCopy: true,
          canPaste: true,
          canDelete: true,
          canSelectAll: true,
          canEditRichly: false,
        },
      }),
    );

    expect(labels(menu)).toEqual([
      "undo",
      "redo",
      "separator",
      "cut",
      "copy",
      "paste",
      "delete",
      "separator",
      "selectAll",
    ]);
    expect(labels(menu)).not.toContain("Open link in new tab");
  });
});
