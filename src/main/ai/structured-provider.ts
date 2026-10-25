import type { AiModelSnapshot } from "../../shared/ai-tools";

export interface StructuredGenerationRequest {
  model: string;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  signal: AbortSignal;
  images?: Array<{
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    data: string;
  }>;
  contextTokens?: number;
}

export interface StructuredModelProvider {
  listModels(signal?: AbortSignal): Promise<AiModelSnapshot[]>;
  chatStructured(request: StructuredGenerationRequest): Promise<unknown>;
}
