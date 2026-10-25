import type {
  AssistantAttachment,
  AssistantConversationTurn,
} from "./ai-assistant";
import type { AiProviderId } from "./ai-tools";

export const SCOUT_PERMISSION_MODES = [
  "chat",
  "ask",
  "smart-approval",
  "automated",
] as const;

export type ScoutPermissionMode = (typeof SCOUT_PERMISSION_MODES)[number];

export type AgentRunStatus =
  | "queued"
  | "preparing"
  | "thinking"
  | "tool-proposed"
  | "awaiting-approval"
  | "executing-tool"
  | "pausing"
  | "paused"
  | "resuming"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentToolEffect =
  | "observe"
  | "local-change"
  | "external-side-effect";

export type AgentEventType =
  | "run-started"
  | "status-changed"
  | "model-requested-information"
  | "tool-proposed"
  | "tab-inspected"
  | "article-read"
  | "screenshot-captured"
  | "source-recorded"
  | "approval-requested"
  | "approval-resolved"
  | "tool-executed"
  | "tool-failed"
  | "message-queued"
  | "run-paused"
  | "run-resumed"
  | "run-cancelled"
  | "run-completed"
  | "run-failed";

export type AgentDisplayMetadata = Record<
  string,
  string | number | boolean | null
>;

export interface AgentEvent {
  id: string;
  runId: string;
  sequence: number;
  timestamp: number;
  type: AgentEventType;
  label: string;
  detail: string | null;
  toolId: string | null;
  status: "info" | "working" | "success" | "warning" | "error";
  metadata: AgentDisplayMetadata;
}

export type AgentObservationType =
  | "metadata"
  | "page-excerpt"
  | "reader-article"
  | "screenshot";

export interface AgentSourceReference {
  id: string;
  title: string;
  url: string;
  hostname: string;
  faviconDataUrl: string | null;
  capturedAt: number;
  complete: boolean;
  observationTypes: AgentObservationType[];
}

export interface AgentApprovalRequest {
  id: string;
  runId: string;
  toolId: string;
  preparedActionHash: string;
  requestedAt: number;
  expiresAt: number;
  action: string;
  target: string;
  expectedEffect: string;
  risk: string;
}

export interface AgentRunSnapshot {
  id: string;
  conversationId: string;
  messageId: string;
  objective: string;
  permissionMode: "ask";
  provider: AiProviderId;
  model: string;
  status: AgentRunStatus;
  statusLabel: string;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  events: AgentEvent[];
  sources: AgentSourceReference[];
  pendingApproval: AgentApprovalRequest | null;
  queuedMessages: AgentQueuedMessage[];
  finalText: string | null;
  error: string | null;
}

export interface AgentRunCollectionSnapshot {
  runs: AgentRunSnapshot[];
}

export interface ScoutAgentSnapshot extends AgentRunCollectionSnapshot {
  permissionMode: ScoutPermissionMode;
  researchCloudConsentGranted: boolean;
}

export interface AgentRunStartRequest {
  conversationId: string;
  messageId: string;
  objective: string;
  createdAt: number;
  provider: AiProviderId;
  model: string;
  context: AssistantAttachment[];
  history: AssistantConversationTurn[];
  cloudConsent: boolean;
}

export interface AgentQueuedMessage {
  id: string;
  text: string;
  createdAt: number;
}

export interface AgentApprovalDecision {
  runId: string;
  approvalId: string;
  preparedActionHash: string;
  approved: boolean;
}

export type AgentRunCommand =
  | { type: "set-mode"; mode: ScoutPermissionMode }
  | { type: "clear-conversation"; conversationId: string }
  | { type: "pause"; runId: string }
  | { type: "resume"; runId: string }
  | { type: "cancel"; runId: string }
  | { type: "open-source"; runId: string; sourceId: string }
  | { type: "enqueue"; runId: string; message: AgentQueuedMessage }
  | { type: "approval"; decision: AgentApprovalDecision };
