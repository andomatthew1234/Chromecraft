import { describe, expect, it, vi } from "vitest";

import { OllamaClient } from "./ollama-client";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OllamaClient", () => {
  it("discovers installed models only through the fixed loopback endpoint", async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({
          models: [
            {
              name: "qwen3:4b",
              size: 2_500_000,
              modified_at: "2026-10-23T00:00:00Z",
              details: { family: "qwen3", parameter_size: "4B" },
            },
          ],
        }),
    );
    const client = new OllamaClient(request as unknown as typeof fetch);

    await expect(client.listModels()).resolves.toEqual([
      {
        name: "qwen3:4b",
        size: 2_500_000,
        modifiedAt: "2026-10-23T00:00:00Z",
        family: "qwen3",
        parameterSize: "4B",
      },
    ]);
    expect(request).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/tags",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it("requests deterministic structured output and parses the assistant JSON", async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ message: { content: '{"groups":[]}' } }),
    );
    const client = new OllamaClient(request as unknown as typeof fetch);
    const signal = new AbortController().signal;

    await expect(
      client.chatStructured({
        model: "qwen3:4b",
        system: "System",
        prompt: "Prompt",
        schema: { type: "object" },
        signal,
      }),
    ).resolves.toEqual({ groups: [] });
    const [, options] = request.mock.calls[0];
    const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
    expect(request.mock.calls[0][0]).toBe("http://127.0.0.1:11434/api/chat");
    expect(body).toMatchObject({
      model: "qwen3:4b",
      stream: false,
      think: false,
      format: { type: "object" },
      options: { temperature: 0.1, num_ctx: 4_096, num_predict: 2_048 },
    });
  });

  it("installs a model only after the caller explicitly requests it", async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ status: "success" }),
    );
    const client = new OllamaClient(request as unknown as typeof fetch);

    await expect(
      client.installModel("qwen3:1.7b", new AbortController().signal),
    ).resolves.toBeUndefined();

    const [, options] = request.mock.calls[0];
    expect(request.mock.calls[0][0]).toBe("http://127.0.0.1:11434/api/pull");
    expect(JSON.parse(String(options?.body))).toEqual({
      model: "qwen3:1.7b",
      stream: false,
    });
  });

  it("rejects non-JSON services running on Ollama's port", async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("not ollama", {
          headers: { "content-type": "text/plain" },
        }),
    );
    const client = new OllamaClient(request as unknown as typeof fetch);

    await expect(client.listModels()).rejects.toThrow("did not return JSON");
  });

  it("does not start a request for an already-cancelled operation", async () => {
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ models: [] }),
    );
    const client = new OllamaClient(request as unknown as typeof fetch);
    const controller = new AbortController();
    controller.abort();

    await expect(client.listModels(controller.signal)).rejects.toThrow(
      "Cancelled",
    );
    expect(request).not.toHaveBeenCalled();
  });
});
