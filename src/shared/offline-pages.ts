export type OfflinePageSaveStage = "idle" | "saving" | "complete" | "failed";

export interface OfflinePageEntrySnapshot {
  id: string;
  title: string;
  sourceUrl: string;
  archiveUrl: string;
  savedAt: number;
  fileSize: number;
  thumbnailUrl: string | null;
  available: boolean;
}

export interface OfflinePageSaveSnapshot {
  stage: OfflinePageSaveStage;
  tabId: string | null;
  title: string | null;
  sourceUrl: string | null;
  entryId: string | null;
  error: string | null;
}

export interface OfflinePagesSnapshot {
  items: OfflinePageEntrySnapshot[];
  save: OfflinePageSaveSnapshot;
}

export const emptyOfflinePageSave = (): OfflinePageSaveSnapshot => ({
  stage: "idle",
  tabId: null,
  title: null,
  sourceUrl: null,
  entryId: null,
  error: null,
});

export function offlinePageArchiveUrl(id: string): string {
  return `chromecraft-offline://${id}/index.html`;
}

export function offlinePageThumbnailUrl(id: string): string {
  return `chromecraft-offline://${id}/thumbnail.png`;
}
