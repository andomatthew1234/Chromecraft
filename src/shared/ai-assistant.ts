export type AssistantConnectionState =
  | "unavailable"
  | "connecting"
  | "ready"
  | "thinking"
  | "generating"
  | "failed";

export type AssistantAttachmentKind =
  | "page"
  | "url"
  | "title"
  | "description"
  | "selected-text"
  | "screenshot"
  | "element";

export interface AssistantPageContext {
  tabId: string;
  url: string;
  displayUrl: string;
  title: string;
  description: string | null;
  selectedText: string | null;
  contentType: string | null;
}

export interface AssistantElementContext {
  tag: string;
  role: string | null;
  label: string | null;
  text: string | null;
  href: string | null;
  alt: string | null;
  placeholder: string | null;
  type: string | null;
  markup: string;
}

export interface AssistantAttachment {
  id: string;
  kind: AssistantAttachmentKind;
  label: string;
  detail: string | null;
  createdAt: number;
  data: {
    url?: string;
    title?: string;
    description?: string;
    selectedText?: string;
    screenshotDataUrl?: string;
    element?: AssistantElementContext;
  };
}

export interface AssistantSelectionRequest {
  requestId: string;
  kind: "screenshot" | "element";
}

export interface AssistantContextCaptured {
  requestId: string;
  attachment: AssistantAttachment;
}

/**
 * The UI-owned request envelope. A future local model adapter receives this
 * immutable snapshot rather than reading live tab state after the user sends.
 */
export interface AssistantMessageRequest {
  conversationId: string;
  messageId: string;
  prompt: string;
  createdAt: number;
  model: string | null;
  context: AssistantAttachment[];
}
