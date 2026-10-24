import type { AiModelSnapshot } from "../../shared/ai-tools";
import type {
  StructuredGenerationRequest,
  StructuredModelProvider,
} from "./structured-provider";

const GEMINI_ORIGIN = "https://generativelanguage.googleapis.com";
const RESPONSE_LIMIT = 1024 ** 2;
const REQUEST_TIMEOUT_MS = 45_000;
const SCOUT_GEMINI_MODELS: ReadonlyArray<AiModelSnapshot> = [
  {
    name: "gemini-flash-lite-latest",
    displayName: "Flash-Lite",
    size: null,
    modifiedAt: null,
    family: "Gemini",
    parameterSize: null,
    recommended: true,
  },
  {
    name: "gemini-flash-latest",
    displayName: "Flash",
    size: null,
    modifiedAt: null,
    family: "Gemini",
    parameterSize: null,
  },
  {
    name: "gemini-pro-latest",
    displayName: "Pro",
    size: null,
    modifiedAt: null,
    family: "Gemini",
    parameterSize: null,
  },
  {
    name: "gemini-4-argon",
    displayName: "Gemini 4 Argon",
    size: null,
    modifiedAt: null,
    family: "Gemini",
    parameterSize: null,
  },
];
const SCOUT_GEMINI_MODEL_IDS = new Set(
  SCOUT_GEMINI_MODELS.map((model) => model.name),
);

type FetchLike = typeof fetch;

function scopedSignal(parent: AbortSignal | undefined) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Gemini took too long to respond.")),
    REQUEST_TIMEOUT_MS,
  );
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abort);
    },
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (body.length > RESPONSE_LIMIT) {
    throw new Error("Gemini returned more data than Chromecraft accepts.");
  }
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    throw new Error("Gemini returned malformed JSON.");
  }
  if (!response.ok) {
    const detail =
      value && typeof value === "object"
        ? (value as { error?: { message?: unknown } }).error?.message
        : null;
    if (response.status === 401 || response.status === 403) {
      throw new Error("Google rejected this Gemini API key.");
    }
    if (response.status === 429) {
      throw new Error(
        typeof detail === "string" && /quota/iu.test(detail)
          ? "Gemini API quota is exhausted. Check billing or try again later."
          : "Gemini is rate-limiting requests. Wait a moment and try again.",
      );
    }
    if (response.status === 404) {
      throw new Error("The selected Gemini model is no longer available.");
    }
    throw new Error(
      typeof detail === "string"
        ? `Gemini returned ${response.status}: ${detail.slice(0, 300)}`
        : `Gemini returned HTTP ${response.status}.`,
    );
  }
  if (!value || typeof value !== "object") {
    throw new Error("Gemini returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

export class GeminiClient implements StructuredModelProvider {
  constructor(
    private readonly apiKey: string,
    private readonly request: FetchLike = fetch,
  ) {}

  async listModels(signal?: AbortSignal): Promise<AiModelSnapshot[]> {
    const scoped = scopedSignal(signal);
    try {
      const response = await this.request(
        `${GEMINI_ORIGIN}/v1beta/models?pageSize=1`,
        {
          headers: {
            accept: "application/json",
            "x-goog-api-key": this.apiKey,
          },
          redirect: "error",
          signal: scoped.signal,
        },
      );
      await readJson(response);
      return SCOUT_GEMINI_MODELS.map((model) => ({ ...model }));
    } catch (error) {
      if (scoped.signal.aborted) {
        if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
        throw new Error("Gemini did not respond in time.");
      }
      throw error;
    } finally {
      scoped.dispose();
    }
  }

  async chatStructured(request: StructuredGenerationRequest): Promise<unknown> {
    if (!SCOUT_GEMINI_MODEL_IDS.has(request.model)) {
      throw new TypeError("Choose a supported Gemini model.");
    }
    const scoped = scopedSignal(request.signal);
    try {
      const response = await this.request(
        `${GEMINI_ORIGIN}/v1beta/models/${encodeURIComponent(request.model)}:generateContent`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-goog-api-key": this.apiKey,
          },
          redirect: "error",
          signal: scoped.signal,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.system }] },
            contents: [{ role: "user", parts: [{ text: request.prompt }] }],
            generationConfig: {
              maxOutputTokens: 2_048,
              responseMimeType: "application/json",
              responseJsonSchema: request.schema,
            },
          }),
        },
      );
      const value = await readJson(response);
      const candidates = Array.isArray(value.candidates)
        ? value.candidates
        : [];
      const first = candidates[0] as
        | { content?: { parts?: Array<{ text?: unknown }> } }
        | undefined;
      const text = first?.content?.parts?.find(
        (part) => typeof part.text === "string",
      )?.text;
      if (typeof text !== "string" || !text.trim()) {
        throw new Error("Gemini returned an empty structured response.");
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error("Gemini did not return the requested structured JSON.");
      }
    } catch (error) {
      if (scoped.signal.aborted) {
        if (request.signal.aborted)
          throw new DOMException("Cancelled", "AbortError");
        throw new Error("Gemini took too long to organise these tabs.");
      }
      throw error;
    } finally {
      scoped.dispose();
    }
  }
}
