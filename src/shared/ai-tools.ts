import type { TabGroupColor } from "./browser";

export const AI_TOOL_IDS = ["organise-tabs"] as const;

export type AiToolId = (typeof AI_TOOL_IDS)[number];

export type AiRunStage =
  | "idle"
  | "checking"
  | "thinking"
  | "ready"
  | "applying"
  | "complete"
  | "failed"
  | "cancelled";

export interface OllamaModelSnapshot {
  name: string;
  size: number | null;
  modifiedAt: string | null;
  family: string | null;
  parameterSize: string | null;
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
  provider: "ollama";
  endpoint: "http://127.0.0.1:11434";
  connection: "unknown" | "connected" | "unavailable";
  models: OllamaModelSnapshot[];
  selectedModel: string | null;
  error: string | null;
  run: AiRunSnapshot;
}

export interface OrganiseTabsProposalGroup {
  name: string;
  color: TabGroupColor;
  tabIds: string[];
  tabTitles: string[];
}

export interface OrganiseTabsProposal {
  id: string;
  toolId: "organise-tabs";
  model: string;
  createdAt: number;
  groups: OrganiseTabsProposalGroup[];
  ungroupedTabIds: string[];
  ungroupedTabTitles: string[];
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
