import { describe, expect, it, vi } from "vitest";

import { GeminiClient } from "./gemini-client";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GeminiClient", () => {
  it("discovers supported stable text models and ranks Flash-Lite deliberately", async () => {
    const request = vi.fn().mockResolvedValue(
      json({
        models: [
          {
            name: "models/gemini-2.5-flash",
            displayName: "Gemini 2.5 Flash",
            supportedGenerationMethods: ["generateContent"],
          },
          {
            name: "models/gemini-3.5-flash-lite",
            displayName: "Gemini 3.5 Flash-Lite",
            supportedGenerationMethods: ["generateContent"],
          },
          {
            name: "models/gemini-4-preview",
            displayName: "Preview",
            supportedGenerationMethods: ["generateContent"],
          },
          {
            name: "models/gemini-99-unknown",
            displayName: "Unknown text model",
            supportedGenerationMethods: ["generateContent"],
          },
          {
            name: "models/gemini-embedding-001",
            displayName: "Embedding",
            supportedGenerationMethods: ["embedContent"],
          },
        ],
      }),
    );

    const models = await new GeminiClient(
      "secret-key",
      request as unknown as typeof fetch,
    ).listModels();

    expect(models.map((model) => model.name)).toEqual([
      "gemini-3.5-flash-lite",
      "gemini-2.5-flash",
    ]);
    expect(request.mock.calls[0][0]).not.toContain("secret-key");
    expect(request.mock.calls[0][1].headers["x-goog-api-key"]).toBe(
      "secret-key",
    );
  });

  it.each([
    [
      400,
      { error: { message: "Invalid thinking budget" } },
      "Gemini returned 400: Invalid thinking budget",
    ],
    [403, { error: { message: "invalid" } }, "rejected this Gemini API key"],
    [429, { error: { message: "rate exceeded" } }, "rate-limiting"],
    [429, { error: { message: "quota exhausted" } }, "quota is exhausted"],
    [404, { error: { message: "missing" } }, "model is no longer available"],
  ])("returns actionable errors for HTTP %i", async (status, body, message) => {
    const request = vi.fn().mockResolvedValue(json(body, status));
    const client = new GeminiClient(
      "secret",
      request as unknown as typeof fetch,
    );

    await expect(client.listModels()).rejects.toThrow(message);
  });

  it("requests schema-constrained JSON without incompatible thinking controls", async () => {
    const request = vi.fn().mockResolvedValue(
      json({
        candidates: [
          {
            content: {
              parts: [{ text: '{"groups":[],"ungroupedTabIds":[]}' }],
            },
          },
        ],
      }),
    );
    const client = new GeminiClient(
      "secret",
      request as unknown as typeof fetch,
    );
    const schema = { type: "object" };

    await expect(
      client.chatStructured({
        model: "gemini-3.5-flash-lite",
        system: "System",
        prompt: "Prompt",
        schema,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ groups: [], ungroupedTabIds: [] });

    const body = JSON.parse(request.mock.calls[0][1].body as string);
    expect(request.mock.calls[0][0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
    );
    expect(body.generationConfig).toMatchObject({
      responseMimeType: "application/json",
      responseJsonSchema: schema,
    });
    expect(body.generationConfig).not.toHaveProperty("thinkingConfig");
    expect(body.generationConfig).not.toHaveProperty("temperature");
  });

  it("never invents a fallback model that the Gemini API did not list", async () => {
    const request = vi.fn().mockResolvedValue(
      json({
        models: [
          {
            name: "models/gemini-2.5-flash-lite",
            displayName: "Gemini 2.5 Flash-Lite",
            supportedGenerationMethods: ["generateContent"],
          },
        ],
      }),
    );

    const models = await new GeminiClient(
      "secret-key",
      request as unknown as typeof fetch,
    ).listModels();

    expect(models.map((model) => model.name)).toEqual([
      "gemini-2.5-flash-lite",
    ]);
  });
});
