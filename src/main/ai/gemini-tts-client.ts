const GEMINI_ORIGIN = "https://generativelanguage.googleapis.com";
const RESPONSE_LIMIT = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 90_000;

export const GEMINI_TTS_MODEL = "gemini-3.8-flash-lite-tts";
export const GEMINI_TTS_VOICES = [
  "Kore",
  "Aoede",
  "Iapetus",
  "Schedar",
  "Achird",
  "Sulafat",
] as const;

type FetchLike = typeof fetch;

function findAudio(value: unknown): { mimeType: string; data: string } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const data = typeof record.data === "string" ? record.data : null;
  const mimeType =
    typeof record.mime_type === "string"
      ? record.mime_type
      : typeof record.mimeType === "string"
        ? record.mimeType
        : null;
  if (data && mimeType?.startsWith("audio/")) return { data, mimeType };
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const match = findAudio(item);
        if (match) return match;
      }
    } else {
      const match = findAudio(child);
      if (match) return match;
    }
  }
  return null;
}

export class GeminiTtsClient {
  constructor(
    private readonly apiKey: string,
    private readonly request: FetchLike = fetch,
  ) {}

  async synthesize(
    text: string,
    voice: string,
    signal: AbortSignal,
  ): Promise<{ mimeType: string; data: string }> {
    if (!text.trim() || text.length > 6_000) {
      throw new TypeError("Narration segments must contain 1-6000 characters.");
    }
    if (!(GEMINI_TTS_VOICES as readonly string[]).includes(voice)) {
      throw new TypeError("Choose a supported Gemini voice.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Gemini voice generation timed out.")),
      REQUEST_TIMEOUT_MS,
    );
    const cancel = () => controller.abort(signal.reason);
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    try {
      const response = await this.request(
        `${GEMINI_ORIGIN}/v1beta/models/${encodeURIComponent(GEMINI_TTS_MODEL)}:generateContent`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-goog-api-key": this.apiKey,
          },
          redirect: "error",
          signal: controller.signal,
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text,
                    speech_metadata: {
                      style: "clear, calm narration",
                    },
                  },
                ],
              },
            ],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
              },
            },
          }),
        },
      );
      const body = await response.text();
      if (body.length > RESPONSE_LIMIT) {
        throw new Error("Gemini returned an unexpectedly large audio segment.");
      }
      let value: unknown;
      try {
        value = JSON.parse(body) as unknown;
      } catch {
        throw new Error("Gemini returned malformed audio data.");
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
            "Gemini voice quota is limited. Check billing or retry later.",
          );
        }
        throw new Error(
          typeof detail === "string"
            ? `Gemini voice generation failed: ${detail.slice(0, 300)}`
            : `Gemini voice generation returned HTTP ${response.status}.`,
        );
      }
      const audio = findAudio(value);
      if (!audio || !/^[a-z0-9+/=]+$/iu.test(audio.data)) {
        throw new Error("Gemini returned no playable voice audio.");
      }
      const decoded = Buffer.from(audio.data, "base64");
      if (decoded.byteLength < 12 || decoded.byteLength > 12 * 1024 * 1024) {
        throw new Error("Gemini returned an invalid audio segment.");
      }
      if (
        audio.mimeType === "audio/wav" &&
        (decoded.subarray(0, 4).toString("ascii") !== "RIFF" ||
          decoded.subarray(8, 12).toString("ascii") !== "WAVE")
      ) {
        throw new Error("Gemini returned a malformed WAV segment.");
      }
      return audio;
    } catch (error) {
      if (controller.signal.aborted) {
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        throw new Error("Gemini voice generation timed out.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
    }
  }
}
