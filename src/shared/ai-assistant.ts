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

export type AssistantContextPreferences = Record<
  AssistantAttachmentKind,
  boolean
>;

export const SCOUT_CONTEXT_DEFAULTS_STORAGE_KEY =
  "chromecraft-ai-assistant-context-v1";
export const SCOUT_REDUCED_MOTION_STORAGE_KEY =
  "chromecraft-scout-reduced-motion-v1";

export const DEFAULT_ASSISTANT_CONTEXT: AssistantContextPreferences = {
  page: false,
  url: true,
  title: true,
  description: true,
  "selected-text": false,
  screenshot: false,
  element: false,
};

/**
 * The UI-owned request envelope. A future local model adapter receives this
 * immutable snapshot rather than reading live tab state after the user sends.
 */
export interface AssistantMessageRequest {
  conversationId: string;
  messageId: string;
  prompt: string;
  createdAt: number;
  provider: AiProviderId;
  model: string;
  context: AssistantAttachment[];
  history: AssistantConversationTurn[];
}
import type { AiProviderId } from "./ai-tools";

export interface AssistantConversationTurn {
  role: "user" | "assistant";
  text: string;
}

export interface AssistantMessageResponse {
  messageId: string;
  provider: AiProviderId;
  model: string;
  text: string;
  createdAt: number;
}
