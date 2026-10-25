import { describe, expect, it, vi } from "vitest";

import { GeminiClient } from "./gemini-client";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GeminiClient", () => {
  it("returns only Scout's four current Gemini choices after validating the key", async () => {
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

    expect(models.map((model) => [model.name, model.displayName])).toEqual([
      ["gemini-flash-lite-latest", "Flash-Lite"],
      ["gemini-flash-latest", "Flash"],
      ["gemini-pro-latest", "Pro"],
      ["gemini-4-argon", "Gemini 4 Argon"],
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
        model: "gemini-flash-lite-latest",
        system: "System",
        prompt: "Prompt",
        schema,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ groups: [], ungroupedTabIds: [] });

    const body = JSON.parse(request.mock.calls[0][1].body as string);
    expect(request.mock.calls[0][0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent",
    );
    expect(body.generationConfig).toMatchObject({
      responseMimeType: "application/json",
      responseJsonSchema: schema,
    });
    expect(body.generationConfig).not.toHaveProperty("thinkingConfig");
    expect(body.generationConfig).not.toHaveProperty("temperature");
  });

  it("attaches bounded tab screenshots as Gemini inline data", async () => {
    const request = vi.fn().mockResolvedValue(
      json({
        candidates: [{ content: { parts: [{ text: '{"reply":"seen"}' }] } }],
      }),
    );
    const client = new GeminiClient(
      "secret",
      request as unknown as typeof fetch,
    );
    await client.chatStructured({
      model: "gemini-flash-latest",
      system: "System",
      prompt: "Inspect the attached tab",
      schema: { type: "object" },
      signal: new AbortController().signal,
      images: [{ mimeType: "image/png", data: "cG5n" }],
    });
    const body = JSON.parse(String(request.mock.calls[0][1].body));
    expect(body.contents[0].parts).toEqual([
      { text: "Inspect the attached tab" },
      { inlineData: { mimeType: "image/png", data: "cG5n" } },
    ]);
  });

  it("keeps the latest aliases instead of pinning concrete list results", async () => {
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
      "gemini-flash-lite-latest",
      "gemini-flash-latest",
      "gemini-pro-latest",
      "gemini-4-argon",
    ]);
  });

  it("rejects Gemini model IDs outside the curated choices", async () => {
    const client = new GeminiClient(
      "secret",
      vi.fn() as unknown as typeof fetch,
    );

    await expect(
      client.chatStructured({
        model: "gemini-2.5-pro",
        system: "System",
        prompt: "Prompt",
        schema: { type: "object" },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("supported Gemini model");
  });
});
