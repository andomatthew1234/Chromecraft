import { describe, expect, it, vi } from "vitest";

import {
  OnboardingGeminiController,
  isGeminiApiKeyCandidate,
} from "./onboarding-gemini-controller";

describe("Gemini onboarding boundaries", () => {
  it("accepts complete Gemini API keys without normalising clipboard text", () => {
    expect(isGeminiApiKeyCandidate(`AIza${"a".repeat(35)}`)).toBe(true);
    expect(isGeminiApiKeyCandidate(` AIza${"a".repeat(35)}`)).toBe(false);
    expect(isGeminiApiKeyCandidate("AIza-short")).toBe(false);
    expect(isGeminiApiKeyCandidate(`AIza${"a".repeat(101)}`)).toBe(false);
    expect(isGeminiApiKeyCandidate("not-a-key")).toBe(false);
  });

  it("opens setup in the default browser and detects a copied key", async () => {
    vi.useFakeTimers();
    const copiedKey = `AIza${"a".repeat(35)}`;
    const emit = vi.fn();
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const controller = new OnboardingGeminiController({
      readClipboardText: vi.fn().mockResolvedValue(copiedKey),
      openExternal,
      commitKey: vi.fn(),
      emit,
    });

    try {
      const started = await controller.start();
      expect(openExternal).toHaveBeenCalledWith(
        "https://aistudio.google.com/apikey",
      );
      expect(started).toEqual({
        state: "listening",
        stageId: null,
        maskedKey: null,
      });
      expect(emit).toHaveBeenLastCalledWith({
        state: "listening",
        stageId: null,
        maskedKey: null,
      });

      await vi.advanceTimersByTimeAsync(650);

      expect(emit).toHaveBeenLastCalledWith({
        state: "detected",
        stageId: expect.any(String),
        maskedKey: "AIza••••••aaaa",
      });
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it("stops listening when the browser handoff fails", async () => {
    const emit = vi.fn();
    const controller = new OnboardingGeminiController({
      readClipboardText: vi.fn().mockResolvedValue(""),
      openExternal: vi.fn().mockRejectedValue(new Error("No browser")),
      commitKey: vi.fn(),
      emit,
    });

    await expect(controller.start()).rejects.toThrow("No browser");
    expect(emit).toHaveBeenLastCalledWith({
      state: "idle",
      stageId: null,
      maskedKey: null,
    });
    controller.dispose();
  });
});
