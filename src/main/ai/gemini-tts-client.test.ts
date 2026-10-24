import { describe, expect, it, vi } from "vitest";

import { GeminiTtsClient, GEMINI_TTS_MODEL } from "./gemini-tts-client";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GeminiTtsClient", () => {
  it("uses the dedicated TTS model and returns real audio data", async () => {
    const wav = Buffer.from("RIFF\0\0\0\0WAVE", "binary").toString("base64");
    const request = vi.fn().mockResolvedValue(
      json({
        candidates: [
          {
            content: {
              parts: [{ inlineData: { mimeType: "audio/wav", data: wav } }],
            },
          },
        ],
      }),
    );
    const client = new GeminiTtsClient(
      "secret",
      request as unknown as typeof fetch,
    );
    await expect(
      client.synthesize(
        "An article passage.",
        "Kore",
        new AbortController().signal,
      ),
    ).resolves.toEqual({ mimeType: "audio/wav", data: wav });

    expect(request.mock.calls[0][0]).toContain(
      `/models/${GEMINI_TTS_MODEL}:generateContent`,
    );
    expect(request.mock.calls[0][0]).not.toContain("secret");
    const body = JSON.parse(request.mock.calls[0][1].body as string);
    expect(body.generationConfig).toMatchObject({
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
      },
    });
    expect(body.contents[0].parts).toEqual([
      {
        text: "An article passage.",
        speech_metadata: { style: "clear, calm narration" },
      },
    ]);
  });

  it("reports quota failures without exposing credentials", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(json({ error: { message: "quota" } }, 429));
    await expect(
      new GeminiTtsClient(
        "secret",
        request as unknown as typeof fetch,
      ).synthesize("Text", "Kore", new AbortController().signal),
    ).rejects.toThrow("quota");
  });
});
