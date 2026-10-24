import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

import { isAllowedWebUrl } from "../shared/navigation";

export interface PageContextMenuNavigationState {
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface PageContextMenuActions {
  goBack(): void;
  goForward(): void;
  reload(): void;
  openInNewTab(url: string): void;
  download(url: string): void;
  copyText(text: string): void | Promise<void>;
  copyImageAt(x: number, y: number): void;
  inspectAt(x: number, y: number): void;
  trySmartReader?(): void;
}

type MenuGroup = MenuItemConstructorOptions[];

export function buildPageContextMenu(
  params: ContextMenuParams,
  navigation: PageContextMenuNavigationState,
  actions: PageContextMenuActions,
): MenuItemConstructorOptions[] {
  const groups: MenuGroup[] = [];
  const linkUrl = params.linkURL.trim();
  const resourceUrl = params.srcURL.trim();

  if (linkUrl) {
    const linkItems: MenuGroup = [];
    if (isAllowedWebUrl(linkUrl)) {
      linkItems.push(
        {
          label: "Open link in new tab",
          click: () => actions.openInNewTab(linkUrl),
        },
        {
          label: "Save link as…",
          click: () => actions.download(linkUrl),
        },
      );
    }
    linkItems.push({
      label: "Copy link address",
      click: () => void actions.copyText(linkUrl),
    });
    groups.push(linkItems);
  }

  const mediaItems = buildMediaItems(params, resourceUrl, actions);
  if (mediaItems.length > 0) groups.push(mediaItems);

  const textItems = buildTextContextMenu(params);
  if (textItems.length > 0) groups.push(textItems);

  if (actions.trySmartReader) {
    groups.push([
      {
        label: "Try Smart Reader",
        click: actions.trySmartReader,
      },
    ]);
  }

  groups.push([
    {
      label: "Back",
      enabled: navigation.canGoBack,
      click: actions.goBack,
    },
    {
      label: "Forward",
      enabled: navigation.canGoForward,
      click: actions.goForward,
    },
    { label: "Reload", click: actions.reload },
  ]);

  groups.push([
    {
      label: "Inspect",
      click: () => actions.inspectAt(params.x, params.y),
    },
  ]);

  return joinGroups(groups);
}

export function buildTextContextMenu(
  params: ContextMenuParams,
): MenuItemConstructorOptions[] {
  if (params.isEditable) {
    return [
      { role: "undo", enabled: params.editFlags.canUndo },
      { role: "redo", enabled: params.editFlags.canRedo },
      { type: "separator" },
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { role: "delete", enabled: params.editFlags.canDelete },
      { type: "separator" },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    ];
  }
  return params.selectionText.trim()
    ? [{ role: "copy", enabled: params.editFlags.canCopy }]
    : [];
}

function buildMediaItems(
  params: ContextMenuParams,
  resourceUrl: string,
  actions: PageContextMenuActions,
): MenuGroup {
  if (!resourceUrl) return [];
  const isImage = params.mediaType === "image";
  const isAudio = params.mediaType === "audio";
  const isVideo = params.mediaType === "video";
  if (!isImage && !isAudio && !isVideo) return [];

  const noun = isImage ? "image" : isAudio ? "audio" : "video";
  const items: MenuGroup = [];
  if (isAllowedWebUrl(resourceUrl)) {
    items.push(
      {
        label: `Open ${noun} in new tab`,
        click: () => actions.openInNewTab(resourceUrl),
      },
      {
        label: `Save ${noun} as…`,
        click: () => actions.download(resourceUrl),
      },
    );
  }
  if (isImage && params.hasImageContents) {
    items.push({
      label: "Copy image",
      click: () => actions.copyImageAt(params.x, params.y),
    });
  }
  return items;
}

function joinGroups(groups: MenuGroup[]): MenuItemConstructorOptions[] {
  const menu: MenuItemConstructorOptions[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    if (menu.length > 0) menu.push({ type: "separator" });
    menu.push(...group);
  }
  return menu;
}
