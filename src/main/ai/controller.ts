import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  AiToolApplyResult,
  AiToolId,
  AiToolProposal,
  AiToolsSnapshot,
} from "../../shared/ai-tools";
import { OllamaClient } from "./ollama-client";

export interface PreparedAiTool {
  proposal: AiToolProposal;
  apply: () => Promise<AiToolApplyResult>;
}

export interface AiToolDefinition {
  id: AiToolId;
  preview(input: {
    model: string;
    ollama: OllamaClient;
    signal: AbortSignal;
  }): Promise<PreparedAiTool>;
  undo(): Promise<AiToolApplyResult>;
  isUndoRetryable?(error: unknown): boolean;
}

export interface AiToolsControllerOptions {
  stateFilePath: string;
  ollama: OllamaClient;
  tools: AiToolDefinition[];
  onChange?: (snapshot: AiToolsSnapshot) => void;
}

function idleRun(): AiToolsSnapshot["run"] {
  return {
    operationId: null,
    toolId: null,
    stage: "idle",
    label: "Ready",
    error: null,
    proposalId: null,
    undoAvailable: false,
  };
}

function message(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "The AI tool could not finish.";
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Owns local model discovery, typed AI-tool execution and operation state. */
export class AiToolsController {
  private readonly stateFilePath: string;
  private readonly ollama: OllamaClient;
  private readonly tools: Map<AiToolId, AiToolDefinition>;
  private readonly onChange?: AiToolsControllerOptions["onChange"];
  private state: AiToolsSnapshot;
  private abortController: AbortController | null = null;
  private prepared: { tool: AiToolDefinition; value: PreparedAiTool } | null =
    null;
  private lastAppliedTool: AiToolDefinition | null = null;
  private disposed = false;
  private writeCounter = 0;

  constructor(options: AiToolsControllerOptions) {
    this.stateFilePath = path.resolve(options.stateFilePath);
    this.ollama = options.ollama;
    this.tools = new Map(options.tools.map((tool) => [tool.id, tool]));
    this.onChange = options.onChange;
    this.state = {
      provider: "ollama",
      endpoint: "http://127.0.0.1:11434",
      connection: "unknown",
      models: [],
      selectedModel: null,
      error: null,
      run: idleRun(),
    };
    if (this.tools.size !== options.tools.length) {
      throw new Error("AI tool identifiers must be unique.");
    }
  }

  get snapshot(): AiToolsSnapshot {
    return structuredClone(this.state);
  }

  async initialize(): Promise<void> {
    try {
      const stored = JSON.parse(
        await fs.readFile(this.stateFilePath, "utf8"),
      ) as { selectedModel?: unknown };
      if (
        typeof stored.selectedModel === "string" &&
        stored.selectedModel.length > 0 &&
        stored.selectedModel.length <= 256
      ) {
        this.state.selectedModel = stored.selectedModel;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("Could not read AI tool preferences.", error);
      }
    }
    this.emit();
  }

  async refreshModels(): Promise<AiToolsSnapshot> {
    this.assertAvailable();
    this.assertNotBusy();
    const operationId = randomUUID();
    const controller = new AbortController();
    this.abortController = controller;
    this.state.run = {
      ...idleRun(),
      operationId,
      stage: "checking",
      label: "Checking Ollama",
    };
    this.state.error = null;
    this.emit();
    try {
      const models = await this.ollama.listModels(controller.signal);
      this.state.connection = "connected";
      this.state.models = models;
      if (!this.state.selectedModel && models[0]) {
        this.state.selectedModel = models[0].name;
        await this.persist();
      }
      this.state.error =
        models.length === 0
          ? "Ollama is running, but no models are installed."
          : this.state.selectedModel &&
              !models.some((model) => model.name === this.state.selectedModel)
            ? `The selected model “${this.state.selectedModel}” is not installed.`
            : null;
      this.state.run = idleRun();
    } catch (error) {
      if (isAbort(error)) {
        this.state.run = {
          ...idleRun(),
          stage: "cancelled",
          label: "Cancelled",
        };
      } else {
        this.state.connection = "unavailable";
        this.state.models = [];
        this.state.error =
          "Chromecraft could not reach Ollama at 127.0.0.1:11434. Start Ollama, then try again.";
        this.state.run = {
          ...idleRun(),
          stage: "failed",
          label: "Ollama unavailable",
          error: message(error),
        };
      }
    } finally {
      if (this.abortController === controller) this.abortController = null;
      this.emit();
    }
    return this.snapshot;
  }

  async setModel(model: string): Promise<AiToolsSnapshot> {
    this.assertAvailable();
    this.assertNotBusy();
    if (
      typeof model !== "string" ||
      model.length === 0 ||
      model.length > 256 ||
      !this.state.models.some((candidate) => candidate.name === model)
    ) {
      throw new TypeError("Choose an installed Ollama model.");
    }
    this.state.selectedModel = model;
    this.state.error = null;
    this.prepared = null;
    this.state.run = idleRun();
    await this.persist();
    this.emit();
    return this.snapshot;
  }

  async preview(toolId: AiToolId): Promise<AiToolProposal> {
    this.assertAvailable();
    this.assertNotBusy();
    if (this.state.connection !== "connected" || !this.state.models.length) {
      await this.refreshModels();
    }
    const model = this.state.selectedModel;
    if (!model || !this.state.models.some((item) => item.name === model)) {
      throw new Error(
        "Choose an installed Ollama model before using AI tools.",
      );
    }
    const tool = this.tools.get(toolId);
    if (!tool) throw new TypeError("Unknown AI tool.");
    const operationId = randomUUID();
    const controller = new AbortController();
    this.abortController = controller;
    this.prepared = null;
    this.state.run = {
      ...idleRun(),
      operationId,
      toolId,
      stage: "thinking",
      label: "Ollama is organising your tabs",
    };
    this.emit();
    try {
      const prepared = await tool.preview({
        model,
        ollama: this.ollama,
        signal: controller.signal,
      });
      if (
        prepared.proposal.toolId !== toolId ||
        !prepared.proposal.id ||
        prepared.proposal.id.length > 128
      ) {
        throw new Error("The AI tool returned an invalid proposal.");
      }
      this.prepared = { tool, value: prepared };
      this.state.run = {
        ...this.state.run,
        stage: "ready",
        label: "Plan ready to review",
        proposalId: prepared.proposal.id,
      };
      this.emit();
      return structuredClone(prepared.proposal);
    } catch (error) {
      if (isAbort(error)) {
        this.state.run = {
          ...idleRun(),
          toolId,
          stage: "cancelled",
          label: "Cancelled",
        };
      } else {
        this.state.run = {
          ...idleRun(),
          toolId,
          stage: "failed",
          label: "Could not organise tabs",
          error: message(error),
        };
      }
      this.emit();
      throw error;
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
  }

  async apply(proposalId: string): Promise<AiToolApplyResult> {
    this.assertAvailable();
    this.assertNotBusy();
    const prepared = this.prepared;
    if (!prepared || prepared.value.proposal.id !== proposalId) {
      throw new Error("This AI proposal is no longer available.");
    }
    this.state.run = {
      ...this.state.run,
      stage: "applying",
      label: "Applying the tab plan",
      error: null,
    };
    this.emit();
    try {
      const result = await prepared.value.apply();
      this.prepared = null;
      this.lastAppliedTool = prepared.tool;
      this.state.run = {
        ...idleRun(),
        toolId: prepared.tool.id,
        stage: "complete",
        label: result.summary,
        undoAvailable: result.undoAvailable,
      };
      this.emit();
      return result;
    } catch (error) {
      this.state.run = {
        ...idleRun(),
        toolId: prepared.tool.id,
        stage: "failed",
        label: "The tab plan was not applied",
        error: message(error),
      };
      this.emit();
      throw error;
    }
  }

  cancel(): void {
    if (!this.abortController) return;
    this.abortController.abort();
    this.abortController = null;
  }

  async undo(): Promise<AiToolApplyResult> {
    this.assertAvailable();
    this.assertNotBusy();
    const tool = this.lastAppliedTool;
    if (!tool || !this.state.run.undoAvailable) {
      throw new Error("There is no AI action to undo.");
    }
    this.state.run = {
      ...this.state.run,
      stage: "applying",
      label: "Restoring the previous tab layout",
    };
    this.emit();
    try {
      const result = await tool.undo();
      this.lastAppliedTool = null;
      this.state.run = {
        ...idleRun(),
        toolId: tool.id,
        stage: "complete",
        label: result.summary,
      };
      this.emit();
      return result;
    } catch (error) {
      const retryable = tool.isUndoRetryable?.(error) ?? true;
      if (!retryable) this.lastAppliedTool = null;
      this.state.run = {
        ...idleRun(),
        toolId: tool.id,
        stage: "failed",
        label: "Could not restore the previous layout",
        error: message(error),
        undoAvailable: retryable,
      };
      this.emit();
      throw error;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.abortController?.abort();
    this.abortController = null;
    this.prepared = null;
  }

  private assertAvailable(): void {
    if (this.disposed) throw new Error("AI tools are no longer available.");
  }

  private assertNotBusy(): void {
    if (["checking", "thinking", "applying"].includes(this.state.run.stage)) {
      throw new Error("Another AI operation is already running.");
    }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });
    const temporary = `${this.stateFilePath}.${process.pid}.${this.writeCounter++}.tmp`;
    await fs.writeFile(
      temporary,
      `${JSON.stringify({ selectedModel: this.state.selectedModel }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    try {
      await fs.rename(temporary, this.stateFilePath);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      await fs.rm(this.stateFilePath, { force: true });
      await fs.rename(temporary, this.stateFilePath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private emit(): void {
    this.onChange?.(this.snapshot);
  }
}
