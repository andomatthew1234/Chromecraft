import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  AiGroupingMode,
  AiProviderId,
  AiProviderSnapshot,
  AiToolApplyResult,
  AiToolsSnapshot,
  GeminiApiKeyUpdate,
  GeminiProviderSnapshot,
  OrganiseTabsProposal,
  OrganiseTabsRequest,
} from "../../shared/ai-tools";
import { GeminiClient } from "./gemini-client";
import { GeminiCredentialStore } from "./gemini-credential-store";
import {
  type InternalOrganiseTabsProposal,
  OrganiseTabsTool,
} from "./organise-tabs-tool";
import { OllamaClient } from "./ollama-client";

const OLLAMA_ENDPOINT = "http://127.0.0.1:11434" as const;
const RECOMMENDED_OLLAMA = "qwen3:1.7b";

export interface AiToolsControllerOptions {
  stateFilePath: string;
  ollama: OllamaClient;
  credentials: GeminiCredentialStore;
  organiseTabs: OrganiseTabsTool;
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

function emptyProvider(): AiProviderSnapshot {
  return {
    connection: "unknown",
    models: [],
    selectedModel: null,
    error: null,
  };
}

function emptyGemini(secureStorageAvailable: boolean): GeminiProviderSnapshot {
  return {
    ...emptyProvider(),
    apiKeyConfigured: false,
    secureStorageAvailable,
    sessionOnly: false,
    cloudConsentGranted: false,
  };
}

function ollamaRank(name: string, size: number | null): number {
  if (name === RECOMMENDED_OLLAMA) return 0;
  const lowered = name.toLowerCase();
  if (/qwen.*(?:1\.7b|0\.8b|1b|2b)/u.test(lowered)) return 10;
  if (/qwen.*(?:3b|4b)/u.test(lowered)) return 20;
  if (size !== null && size <= 4 * 1024 ** 3) return 30;
  return 100;
}

function chooseOllamaModel(
  models: AiProviderSnapshot["models"],
): string | null {
  return (
    [...models]
      .sort(
        (left, right) =>
          ollamaRank(left.name, left.size) - ollamaRank(right.name, right.size),
      )
      .find((model) => ollamaRank(model.name, model.size) < 100)?.name ?? null
  );
}

function validProvider(value: unknown): value is AiProviderId {
  return value === "ollama" || value === "gemini";
}

function validGrouping(value: unknown): value is AiGroupingMode {
  return value === "smart" || value === "website";
}

export class AiToolsController {
  private readonly stateFilePath: string;
  private readonly ollama: OllamaClient;
  private readonly credentials: GeminiCredentialStore;
  private readonly organiseTabs: OrganiseTabsTool;
  private readonly onChange?: AiToolsControllerOptions["onChange"];
  private provider: AiProviderId = "ollama";
  private organiserProvider: AiProviderId = "ollama";
  private organiserModels: Record<AiProviderId, string | null> = {
    ollama: null,
    gemini: null,
  };
  private preferredGroupingMode: AiGroupingMode = "smart";
  private ollamaState: AiProviderSnapshot = emptyProvider();
  private geminiState: GeminiProviderSnapshot;
  private run = idleRun();
  private abortController: AbortController | null = null;
  private prepared: InternalOrganiseTabsProposal | null = null;
  private disposed = false;
  private writeCounter = 0;

  constructor(options: AiToolsControllerOptions) {
    this.stateFilePath = path.resolve(options.stateFilePath);
    this.ollama = options.ollama;
    this.credentials = options.credentials;
    this.organiseTabs = options.organiseTabs;
    this.onChange = options.onChange;
    this.geminiState = emptyGemini(options.credentials.secureStorageAvailable);
  }

  get snapshot(): AiToolsSnapshot {
    const active =
      this.provider === "ollama" ? this.ollamaState : this.geminiState;
    return structuredClone({
      provider: this.provider,
      organiserProvider: this.organiserProvider,
      organiserModels: this.organiserModels,
      preferredGroupingMode: this.preferredGroupingMode,
      eligibleTabCount: this.organiseTabs.eligibleTabCount,
      cloudDataPreview: this.organiseTabs.cloudDataPreview,
      ollama: { ...this.ollamaState, endpoint: OLLAMA_ENDPOINT },
      gemini: this.geminiState,
      run: this.run,
      endpoint: OLLAMA_ENDPOINT,
      connection: active.connection,
      models: active.models,
      selectedModel: active.selectedModel,
      error: active.error,
    });
  }

  async initialize(): Promise<void> {
    try {
      const stored = JSON.parse(
        await fs.readFile(this.stateFilePath, "utf8"),
      ) as Record<string, unknown> | null;
      if (stored && validProvider(stored.provider))
        this.provider = stored.provider;
      this.organiserProvider =
        stored && validProvider(stored.organiserProvider)
          ? stored.organiserProvider
          : this.provider;
      if (stored && validGrouping(stored.preferredGroupingMode)) {
        this.preferredGroupingMode = stored.preferredGroupingMode;
      }
      if (stored && typeof stored.ollamaModel === "string") {
        this.ollamaState.selectedModel = stored.ollamaModel.slice(0, 256);
      }
      if (stored && typeof stored.geminiModel === "string") {
        this.geminiState.selectedModel = stored.geminiModel.slice(0, 128);
      }
      this.organiserModels.ollama =
        stored && typeof stored.organiserOllamaModel === "string"
          ? stored.organiserOllamaModel.slice(0, 256)
          : this.ollamaState.selectedModel;
      this.organiserModels.gemini =
        stored && typeof stored.organiserGeminiModel === "string"
          ? stored.organiserGeminiModel.slice(0, 128)
          : this.geminiState.selectedModel;
      this.geminiState.cloudConsentGranted =
        stored?.cloudConsentGranted === true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("Could not read AI tool preferences.", error);
      }
    }
    this.geminiState.apiKeyConfigured = Boolean(await this.credentials.get());
    this.emit();
  }

  async setProvider(provider: AiProviderId): Promise<AiToolsSnapshot> {
    this.assertNotBusy();
    this.provider = provider;
    this.prepared = null;
    this.run = idleRun();
    await this.persist();
    this.emit();
    return this.snapshot;
  }

  async setOrganiserProvider(provider: AiProviderId): Promise<AiToolsSnapshot> {
    this.assertNotBusy();
    this.organiserProvider = provider;
    this.prepared = null;
    this.run = idleRun();
    await this.persist();
    this.emit();
    return this.snapshot;
  }

  async setGroupingMode(mode: AiGroupingMode): Promise<AiToolsSnapshot> {
    this.assertNotBusy();
    this.preferredGroupingMode = mode;
    await this.persist();
    this.emit();
    return this.snapshot;
  }

  async refreshModels(
    provider: AiProviderId = this.provider,
  ): Promise<AiToolsSnapshot> {
    this.assertAvailable();
    this.assertNotBusy();
    const operationId = randomUUID();
    const controller = new AbortController();
    this.abortController = controller;
    this.run = {
      ...idleRun(),
      operationId,
      stage: "checking",
      label: provider === "ollama" ? "Checking Ollama" : "Checking Gemini",
    };
    this.emit();
    try {
      if (provider === "ollama") {
        const models = await this.ollama.listModels(controller.signal);
        const preferred = chooseOllamaModel(models);
        this.ollamaState = {
          connection: "connected",
          models,
          selectedModel:
            this.ollamaState.selectedModel &&
            models.some(
              (model) => model.name === this.ollamaState.selectedModel,
            )
              ? this.ollamaState.selectedModel
              : preferred,
          error:
            models.length === 0
              ? "Ollama is running, but no models are installed."
              : preferred
                ? null
                : "No suitably small local model is installed.",
        };
        this.organiserModels.ollama =
          this.organiserModels.ollama &&
          models.some((model) => model.name === this.organiserModels.ollama)
            ? this.organiserModels.ollama
            : preferred;
      } else {
        const apiKey = await this.credentials.get();
        if (!apiKey) throw new Error("Add a Gemini API key in Settings first.");
        const models = await new GeminiClient(apiKey).listModels(
          controller.signal,
        );
        this.geminiState = {
          ...this.geminiState,
          connection: "connected",
          models,
          selectedModel:
            this.geminiState.selectedModel &&
            models.some(
              (model) => model.name === this.geminiState.selectedModel,
            )
              ? this.geminiState.selectedModel
              : (models.find((model) => model.recommended)?.name ??
                models[0]?.name ??
                null),
          error: models.length
            ? null
            : "No compatible Gemini text models were found.",
        };
        this.organiserModels.gemini =
          this.organiserModels.gemini &&
          models.some((model) => model.name === this.organiserModels.gemini)
            ? this.organiserModels.gemini
            : (models.find((model) => model.recommended)?.name ??
              models[0]?.name ??
              null);
      }
      this.run = idleRun();
      await this.persist();
    } catch (error) {
      if (isAbort(error)) {
        this.run = { ...idleRun(), stage: "cancelled", label: "Cancelled" };
      } else {
        const detail = message(error);
        if (provider === "ollama") {
          this.ollamaState = {
            ...this.ollamaState,
            connection: "unavailable",
            models: [],
            error:
              "Chromecraft could not reach Ollama. Start Ollama, then try again.",
          };
        } else {
          this.geminiState = {
            ...this.geminiState,
            connection: "unavailable",
            models: [],
            error: detail,
          };
        }
        this.run = {
          ...idleRun(),
          stage: "failed",
          label: `${provider === "ollama" ? "Ollama" : "Gemini"} unavailable`,
          error: detail,
        };
      }
    } finally {
      if (this.abortController === controller) this.abortController = null;
      this.emit();
    }
    return this.snapshot;
  }

  async installRecommendedOllamaModel(): Promise<AiToolsSnapshot> {
    this.assertAvailable();
    this.assertNotBusy();
    const operationId = randomUUID();
    const controller = new AbortController();
    this.abortController = controller;
    this.run = {
      ...idleRun(),
      operationId,
      stage: "loading",
      label: `Installing ${RECOMMENDED_OLLAMA}`,
    };
    this.emit();
    try {
      await this.ollama.installModel(RECOMMENDED_OLLAMA, controller.signal);
      this.run = idleRun();
    } catch (error) {
      this.run = isAbort(error)
        ? {
            ...idleRun(),
            stage: "cancelled",
            label: "Model installation cancelled",
          }
        : {
            ...idleRun(),
            stage: "failed",
            label: "Could not install the recommended model",
            error: message(error),
          };
      this.emit();
      throw error;
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
    return this.refreshModels("ollama");
  }

  async setModel(
    provider: AiProviderId,
    model: string,
  ): Promise<AiToolsSnapshot> {
    this.assertNotBusy();
    const state = provider === "ollama" ? this.ollamaState : this.geminiState;
    if (!state.models.some((candidate) => candidate.name === model)) {
      throw new TypeError(
        `Choose an available ${provider === "ollama" ? "Ollama" : "Gemini"} model.`,
      );
    }
    state.selectedModel = model;
    state.error = null;
    this.prepared = null;
    this.run = idleRun();
    await this.persist();
    this.emit();
    return this.snapshot;
  }

  async setOrganiserModel(
    provider: AiProviderId,
    model: string,
  ): Promise<AiToolsSnapshot> {
    this.assertNotBusy();
    const state = provider === "ollama" ? this.ollamaState : this.geminiState;
    if (!state.models.some((candidate) => candidate.name === model)) {
      throw new TypeError(
        `Choose an available ${provider === "ollama" ? "Ollama" : "Gemini"} model.`,
      );
    }
    this.organiserModels[provider] = model;
    this.prepared = null;
    this.run = idleRun();
    await this.persist();
    this.emit();
    return this.snapshot;
  }

  async setGeminiApiKey(update: GeminiApiKeyUpdate): Promise<AiToolsSnapshot> {
    this.assertNotBusy();
    const apiKey = update.apiKey.trim();
    if (
      !apiKey ||
      apiKey.length > 512 ||
      /[\u0000-\u001f\u007f]/u.test(apiKey)
    ) {
      throw new TypeError("Enter a valid Gemini API key.");
    }
    await this.credentials.set(apiKey, update.persist);
    this.geminiState = {
      ...this.geminiState,
      apiKeyConfigured: true,
      sessionOnly: !update.persist,
      connection: "unknown",
      error: null,
    };
    this.emit();
    const snapshot = await this.refreshModels("gemini");
    if (snapshot.gemini.connection !== "connected") {
      throw new Error(
        snapshot.gemini.error ?? "Chromecraft could not connect to Gemini.",
      );
    }
    return snapshot;
  }

  async removeGeminiApiKey(): Promise<AiToolsSnapshot> {
    this.assertNotBusy();
    await this.credentials.remove();
    this.geminiState = emptyGemini(this.credentials.secureStorageAvailable);
    this.organiserModels.gemini = null;
    this.prepared = null;
    this.run = idleRun();
    await this.persist();
    this.emit();
    return this.snapshot;
  }

  async preview(request: OrganiseTabsRequest): Promise<OrganiseTabsProposal> {
    this.assertAvailable();
    this.assertNotBusy();
    this.validateRequest(request);
    if (request.groupingMode === "smart") {
      const state =
        request.provider === "ollama" ? this.ollamaState : this.geminiState;
      if (
        state.connection !== "connected" ||
        !state.models.some((model) => model.name === request.model)
      ) {
        const refreshed = await this.refreshModels(request.provider);
        const nextState =
          request.provider === "ollama" ? refreshed.ollama : refreshed.gemini;
        if (
          nextState.connection !== "connected" ||
          !nextState.models.some((model) => model.name === request.model)
        ) {
          throw new Error(
            nextState.error ?? "The selected AI model is not available.",
          );
        }
      }
    }
    if (
      request.groupingMode === "smart" &&
      request.provider === "gemini" &&
      !this.geminiState.cloudConsentGranted
    ) {
      if (!request.cloudConsent) {
        throw new Error("Confirm cloud processing before using Gemini.");
      }
      this.geminiState.cloudConsentGranted = true;
      await this.persist();
    }
    const operationId = randomUUID();
    const controller = new AbortController();
    this.abortController = controller;
    this.prepared = null;
    this.run = {
      ...idleRun(),
      operationId,
      toolId: "organise-tabs",
      stage: "preparing",
      label: "Preparing tabs",
    };
    this.emit();
    try {
      const apiKey =
        request.provider === "gemini" ? await this.credentials.get() : null;
      const provider =
        request.groupingMode === "website"
          ? null
          : request.provider === "ollama"
            ? this.ollama
            : apiKey
              ? new GeminiClient(apiKey)
              : null;
      this.run = {
        ...this.run,
        stage: request.groupingMode === "website" ? "validating" : "thinking",
        label:
          request.groupingMode === "website"
            ? "Preparing website groups"
            : "Analysing tab titles",
      };
      this.emit();
      const prepared = await this.organiseTabs.preview(
        request,
        provider,
        controller.signal,
      );
      if (this.abortController !== controller || controller.signal.aborted) {
        throw new DOMException("Cancelled", "AbortError");
      }
      this.prepared = prepared;
      this.run = {
        ...this.run,
        stage: "ready",
        label: "Ready for review",
        proposalId: prepared.publicProposal.id,
      };
      this.emit();
      return structuredClone(prepared.publicProposal);
    } catch (error) {
      this.run = isAbort(error)
        ? {
            ...idleRun(),
            toolId: "organise-tabs",
            stage: "cancelled",
            label: "Cancelled",
          }
        : {
            ...idleRun(),
            toolId: "organise-tabs",
            stage: "failed",
            label: "Could not organise tabs",
            error: message(error),
          };
      this.emit();
      throw error;
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
  }

  async apply(edited: OrganiseTabsProposal): Promise<AiToolApplyResult> {
    this.assertAvailable();
    this.assertNotBusy();
    const prepared = this.prepared;
    if (!prepared || prepared.publicProposal.id !== edited.id) {
      throw new Error("This tab proposal is no longer available.");
    }
    this.run = {
      ...this.run,
      stage: "applying",
      label: "Applying approved groups",
      error: null,
    };
    this.emit();
    try {
      const result = await this.organiseTabs.apply(prepared, edited);
      this.prepared = null;
      this.run = {
        ...idleRun(),
        toolId: "organise-tabs",
        stage: "complete",
        label: result.summary,
        undoAvailable: result.undoAvailable,
        organisedTabCount: result.organisedTabCount,
        groupCount: result.groupCount,
      };
      this.emit();
      return result;
    } catch (error) {
      this.run = {
        ...idleRun(),
        toolId: "organise-tabs",
        stage: "failed",
        label: "The tab plan was not applied",
        error: message(error),
      };
      this.emit();
      throw error;
    }
  }

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  async undo(): Promise<AiToolApplyResult> {
    this.assertAvailable();
    this.assertNotBusy();
    if (!this.run.undoAvailable)
      throw new Error("There is no AI action to undo.");
    this.run = {
      ...this.run,
      stage: "applying",
      label: "Restoring the previous tab layout",
    };
    this.emit();
    try {
      const result = await this.organiseTabs.undo();
      this.run = {
        ...idleRun(),
        toolId: "organise-tabs",
        stage: "complete",
        label: result.summary,
      };
      this.emit();
      return result;
    } catch (error) {
      const retryable = this.organiseTabs.isUndoRetryable(error);
      this.run = {
        ...idleRun(),
        toolId: "organise-tabs",
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

  private validateRequest(request: OrganiseTabsRequest): void {
    if (
      !validProvider(request.provider) ||
      !validGrouping(request.groupingMode)
    ) {
      throw new TypeError("Choose a supported tab organisation option.");
    }
    if (
      request.model.length > 256 ||
      (request.customInstructions?.length ?? 0) > 1_000
    ) {
      throw new TypeError("The tab organisation request is too large.");
    }
    if (request.groupingMode === "smart" && !request.model) {
      throw new TypeError("Choose a model before organising tabs.");
    }
    if (
      request.groupingMode === "smart" &&
      request.provider === "gemini" &&
      !this.geminiState.apiKeyConfigured
    ) {
      throw new Error("Add a Gemini API key in Settings first.");
    }
  }

  private assertAvailable(): void {
    if (this.disposed) throw new Error("AI tools are no longer available.");
  }

  private assertNotBusy(): void {
    if (
      [
        "checking",
        "preparing",
        "connecting",
        "loading",
        "thinking",
        "validating",
        "applying",
      ].includes(this.run.stage)
    ) {
      throw new Error("Another AI operation is already running.");
    }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });
    const temporary = `${this.stateFilePath}.${process.pid}.${this.writeCounter++}.tmp`;
    const preferences = {
      provider: this.provider,
      organiserProvider: this.organiserProvider,
      preferredGroupingMode: this.preferredGroupingMode,
      ollamaModel: this.ollamaState.selectedModel,
      geminiModel: this.geminiState.selectedModel,
      organiserOllamaModel: this.organiserModels.ollama,
      organiserGeminiModel: this.organiserModels.gemini,
      cloudConsentGranted: this.geminiState.cloudConsentGranted,
    };
    await fs.writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
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
