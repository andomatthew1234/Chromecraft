import type { AiProviderId } from "../../shared/ai-tools";
import type { AgentModelAdapter, AgentModelResolver } from "./agent-runtime";
import { StructuredAgentModelAdapter } from "./agent-model-adapter";
import type { AiToolsController } from "./controller";
import { GeminiClient } from "./gemini-client";
import type { GeminiCredentialStore } from "./gemini-credential-store";
import type { OllamaClient } from "./ollama-client";

export class ScoutAgentModelResolver implements AgentModelResolver {
  constructor(
    private readonly aiTools: AiToolsController,
    private readonly ollama: OllamaClient,
    private readonly credentials: GeminiCredentialStore,
  ) {}

  async resolve(
    provider: AiProviderId,
    model: string,
  ): Promise<AgentModelAdapter> {
    let state =
      provider === "ollama"
        ? this.aiTools.snapshot.ollama
        : this.aiTools.snapshot.gemini;
    if (
      state.connection !== "connected" ||
      !state.models.some((candidate) => candidate.name === model)
    ) {
      const refreshed = await this.aiTools.refreshModels(provider);
      state = provider === "ollama" ? refreshed.ollama : refreshed.gemini;
    }
    if (
      state.connection !== "connected" ||
      !state.models.some((candidate) => candidate.name === model)
    ) {
      throw new Error(
        state.error ??
          (provider === "ollama"
            ? "Scout could not use that Ollama model. Make sure Ollama is running and choose an available model."
            : "Scout could not use that Gemini model. Check Scout Power and try again."),
      );
    }
    if (provider === "ollama") {
      return new StructuredAgentModelAdapter(this.ollama, model, false);
    }
    const apiKey = await this.credentials.get();
    if (!apiKey)
      throw new Error("Add a Gemini API key in Scout settings first.");
    return new StructuredAgentModelAdapter(
      new GeminiClient(apiKey),
      model,
      true,
    );
  }
}
