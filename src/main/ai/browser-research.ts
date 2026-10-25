export interface BrowserResearchTab {
  tabId: string;
  windowId: string;
  title: string;
  url: string;
  hostname: string;
  active: boolean;
  readerAvailable: boolean;
  faviconDataUrl: string | null;
  /** Stable identity for the current document/navigation. */
  documentRevision: string;
  /** Revision of the content captured by an observation. */
  observationRevision: string;
}

export interface BrowserPageObservation {
  tab: BrowserResearchTab;
  text: string;
  headings: string[];
  complete: boolean;
}

export interface BrowserReaderObservation extends BrowserPageObservation {
  author: string | null;
  siteName: string | null;
  publishedTime: string | null;
  offset: number;
  nextOffset: number | null;
}

export interface BrowserScreenshotObservation {
  tab: BrowserResearchTab;
  mimeType: "image/png";
  data: string;
}

export interface BrowserResearchAdapter {
  listTabs(signal: AbortSignal): Promise<BrowserResearchTab[]>;
  inspectMetadata(
    tabId: string,
    expectedRevision: string,
    signal: AbortSignal,
  ): Promise<BrowserResearchTab>;
  readPageExcerpt(
    tabId: string,
    expectedRevision: string,
    maximumCharacters: number,
    signal: AbortSignal,
  ): Promise<BrowserPageObservation>;
  readReaderArticle(
    tabId: string,
    expectedRevision: string,
    offset: number,
    maximumCharacters: number,
    signal: AbortSignal,
  ): Promise<BrowserReaderObservation>;
  captureScreenshot(
    tabId: string,
    expectedRevision: string,
    signal: AbortSignal,
  ): Promise<BrowserScreenshotObservation>;
  currentDocumentRevision(tabId: string): string | null;
  currentRevision(tabId: string): string | null;
  openTab(tabId: string, fallbackUrl: string): Promise<void>;
}
