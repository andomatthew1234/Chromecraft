import type { OllamaModelSnapshot } from "../../shared/ai-tools";
import type {
  StructuredGenerationRequest,
  StructuredModelProvider,
} from "./structured-provider";

const OLLAMA_ORIGIN = "http://127.0.0.1:11434" as const;
const MODEL_LIST_LIMIT = 2 * 1024 ** 2;
const CHAT_RESPONSE_LIMIT = 1024 ** 2;
const MODEL_LIST_TIMEOUT_MS = 4_000;
const CHAT_TIMEOUT_MS = 120_000;
const MODEL_INSTALL_TIMEOUT_MS = 15 * 60_000;

type FetchLike = typeof fetch;

export type OllamaChatRequest = StructuredGenerationRequest;

function cleanText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maximum ? text : null;
}

async function readLimited(response: Response, maximum: number) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new Error("Ollama returned more data than Chromecraft accepts.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function requestSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Ollama took too long to respond.")),
    timeoutMs,
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

async function parseJsonResponse(
  response: Response,
  maximum: number,
): Promise<unknown> {
  if (!response.ok) {
    const detail = (await readLimited(response, 32_768)).trim();
    throw new Error(
      detail
        ? `Ollama returned ${response.status}: ${detail.slice(0, 500)}`
        : `Ollama returned HTTP ${response.status}.`,
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLocaleLowerCase().includes("application/json")) {
    throw new Error("The process on Ollama's port did not return JSON.");
  }
  const body = await readLimited(response, maximum);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("Ollama returned malformed JSON.");
  }
}

/** Fixed-loopback adapter for the local Ollama HTTP interface. */
export class OllamaClient implements StructuredModelProvider {
  readonly endpoint = OLLAMA_ORIGIN;

  constructor(private readonly request: FetchLike = fetch) {}

  async listModels(signal?: AbortSignal): Promise<OllamaModelSnapshot[]> {
    const scoped = requestSignal(signal, MODEL_LIST_TIMEOUT_MS);
    try {
      if (scoped.signal.aborted)
        throw new DOMException("Cancelled", "AbortError");
      const response = await this.request(`${OLLAMA_ORIGIN}/api/tags`, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: scoped.signal,
      });
      const value = await parseJsonResponse(response, MODEL_LIST_LIMIT);
      const listing =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)
          : null;
      const models =
        listing && Array.isArray(listing.models) ? listing.models : null;
      if (!models) throw new Error("Ollama returned an invalid model list.");
      return models.slice(0, 200).flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const model = entry as Record<string, unknown>;
        const name = cleanText(model.name ?? model.model, 256);
        if (!name) return [];
        const details =
          model.details && typeof model.details === "object"
            ? (model.details as Record<string, unknown>)
            : {};
        const size =
          typeof model.size === "number" &&
          Number.isSafeInteger(model.size) &&
          model.size >= 0
            ? model.size
            : null;
        return [
          {
            name,
            size,
            modifiedAt: cleanText(model.modified_at, 128),
            family: cleanText(details.family, 128),
            parameterSize: cleanText(details.parameter_size, 64),
          },
        ];
      });
    } catch (error) {
      if (scoped.signal.aborted) {
        if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
        throw new Error("Ollama did not respond in time.");
      }
      throw error;
    } finally {
      scoped.dispose();
    }
  }

  async installModel(modelName: string, signal: AbortSignal): Promise<void> {
    const model = cleanText(modelName, 256);
    if (!model) throw new TypeError("A valid Ollama model is required.");
    const scoped = requestSignal(signal, MODEL_INSTALL_TIMEOUT_MS);
    try {
      const response = await this.request(`${OLLAMA_ORIGIN}/api/pull`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        redirect: "error",
        signal: scoped.signal,
        body: JSON.stringify({ model, stream: false }),
      });
      const value = await parseJsonResponse(response, CHAT_RESPONSE_LIMIT);
      if (
        !value ||
        typeof value !== "object" ||
        (value as { status?: unknown }).status !== "success"
      ) {
        throw new Error("Ollama did not confirm the model installation.");
      }
    } catch (error) {
      if (scoped.signal.aborted) {
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        throw new Error("The Ollama model download took too long.");
      }
      throw error;
    } finally {
      scoped.dispose();
    }
  }

  async chatStructured(request: OllamaChatRequest): Promise<unknown> {
    const model = cleanText(request.model, 256);
    if (!model) throw new TypeError("A valid Ollama model is required.");
    const scoped = requestSignal(request.signal, CHAT_TIMEOUT_MS);
    try {
      if (scoped.signal.aborted)
        throw new DOMException("Cancelled", "AbortError");
      const response = await this.request(`${OLLAMA_ORIGIN}/api/chat`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        redirect: "error",
        signal: scoped.signal,
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.prompt },
          ],
          stream: false,
          format: request.schema,
          think: false,
          keep_alive: "60s",
          options: {
            temperature: 0.1,
            num_ctx: 4_096,
            num_predict: 2_048,
          },
        }),
      });
      const value = await parseJsonResponse(response, CHAT_RESPONSE_LIMIT);
      if (!value || typeof value !== "object") {
        throw new Error("Ollama returned an invalid chat response.");
      }
      const reply = value as Record<string, unknown>;
      const message =
        reply.message && typeof reply.message === "object"
          ? (reply.message as Record<string, unknown>)
          : null;
      const content = cleanText(message?.content, CHAT_RESPONSE_LIMIT);
      if (!content) throw new Error("Ollama returned an empty response.");
      try {
        return JSON.parse(content) as unknown;
      } catch {
        throw new Error("Ollama did not return the requested structured JSON.");
      }
    } catch (error) {
      if (scoped.signal.aborted) {
        if (request.signal.aborted)
          throw new DOMException("Cancelled", "AbortError");
        throw new Error("Ollama took too long to organise these tabs.");
      }
      throw error;
    } finally {
      scoped.dispose();
    }
  }
}
