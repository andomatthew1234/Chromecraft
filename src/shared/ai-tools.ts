import type { TabGroupColor } from "./browser";

export const AI_TOOL_IDS = ["organise-tabs"] as const;
export const AI_PROVIDER_IDS = ["ollama", "gemini"] as const;
export const AI_GROUPING_MODES = ["smart", "website"] as const;

export type AiToolId = (typeof AI_TOOL_IDS)[number];
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];
export type AiGroupingMode = (typeof AI_GROUPING_MODES)[number];

export type AiRunStage =
  | "idle"
  | "checking"
  | "preparing"
  | "connecting"
  | "loading"
  | "thinking"
  | "validating"
  | "ready"
  | "applying"
  | "complete"
  | "failed"
  | "cancelled";

export interface AiModelSnapshot {
  name: string;
  displayName?: string | null;
  size: number | null;
  modifiedAt: string | null;
  family: string | null;
  parameterSize: string | null;
  recommended?: boolean;
}

export type OllamaModelSnapshot = AiModelSnapshot;

export interface AiProviderSnapshot {
  connection: "unknown" | "connected" | "unavailable";
  models: AiModelSnapshot[];
  selectedModel: string | null;
  error: string | null;
}

export interface GeminiProviderSnapshot extends AiProviderSnapshot {
  apiKeyConfigured: boolean;
  secureStorageAvailable: boolean;
  sessionOnly: boolean;
  cloudConsentGranted: boolean;
}

export interface AiRunSnapshot {
  operationId: string | null;
  toolId: AiToolId | null;
  stage: AiRunStage;
  label: string;
  error: string | null;
  proposalId: string | null;
  undoAvailable: boolean;
}

export interface AiToolsSnapshot {
  provider: AiProviderId;
  preferredGroupingMode: AiGroupingMode;
  eligibleTabCount: number;
  cloudDataPreview: Array<{ title: string; hostname: string }>;
  ollama: AiProviderSnapshot & { endpoint: "http://127.0.0.1:11434" };
  gemini: GeminiProviderSnapshot;
  run: AiRunSnapshot;
  endpoint: "http://127.0.0.1:11434";
  connection: "unknown" | "connected" | "unavailable";
  models: AiModelSnapshot[];
  selectedModel: string | null;
  error: string | null;
}

export interface OrganiseTabsRequest {
  provider: AiProviderId;
  model: string;
  groupingMode: AiGroupingMode;
  customInstructions?: string;
  rememberCustomInstructions?: boolean;
  cloudConsent: boolean;
}

export interface GeminiApiKeyUpdate {
  apiKey: string;
  persist: boolean;
}

export interface OrganiseTabsProposalGroup {
  name: string;
  color: TabGroupColor;
  tabIds: string[];
  tabTitles: string[];
  tabFavicons: Array<string | null>;
}

export interface OrganiseTabsProposal {
  id: string;
  toolId: "organise-tabs";
  provider: AiProviderId | "website";
  model: string;
  createdAt: number;
  groups: OrganiseTabsProposalGroup[];
  ungroupedTabIds: string[];
  ungroupedTabTitles: string[];
  ungroupedTabFavicons: Array<string | null>;
  preservedTabCount: number;
  summary: string;
  warnings: string[];
}

export type AiToolProposal = OrganiseTabsProposal;

export interface AiToolApplyResult {
  toolId: AiToolId;
  summary: string;
  organisedTabCount: number;
  groupCount: number;
  undoAvailable: boolean;
}
