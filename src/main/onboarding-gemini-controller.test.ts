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

  it("opens setup in a real Chromecraft tab and detects a copied key", async () => {
    vi.useFakeTimers();
    const copiedKey = `AIza${"a".repeat(35)}`;
    const emit = vi.fn();
    const openInApp = vi.fn().mockResolvedValue(undefined);
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const closeInApp = vi.fn();
    const controller = new OnboardingGeminiController({
      readClipboardText: vi.fn().mockResolvedValue(copiedKey),
      openInApp,
      openExternal,
      closeInApp,
      setInAppBounds: vi.fn(),
      commitKey: vi.fn(),
      emit,
    });

    try {
      const started = await controller.start();
      expect(openInApp).toHaveBeenCalledWith(
        "https://aistudio.google.com/apikey",
      );
      expect(openExternal).not.toHaveBeenCalled();
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
      expect(closeInApp).toHaveBeenCalledOnce();
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it("stops listening when the in-app tab handoff fails", async () => {
    const emit = vi.fn();
    const controller = new OnboardingGeminiController({
      readClipboardText: vi.fn().mockResolvedValue(""),
      openInApp: vi.fn().mockRejectedValue(new Error("No browser")),
      openExternal: vi.fn(),
      closeInApp: vi.fn(),
      setInAppBounds: vi.fn(),
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

  it("forwards frame bounds and keeps clipboard detection alive for the external fallback", async () => {
    const closeInApp = vi.fn();
    const setInAppBounds = vi.fn();
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const controller = new OnboardingGeminiController({
      readClipboardText: vi.fn().mockResolvedValue(""),
      openInApp: vi.fn().mockResolvedValue(undefined),
      openExternal,
      closeInApp,
      setInAppBounds,
      commitKey: vi.fn(),
      emit: vi.fn(),
    });

    await controller.start();
    controller.setBounds({ x: 420, y: 120, width: 640, height: 500 });
    expect(setInAppBounds).toHaveBeenCalledWith({
      x: 420,
      y: 120,
      width: 640,
      height: 500,
    });

    await controller.openExternal();
    expect(closeInApp).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith(
      "https://aistudio.google.com/apikey",
    );
    controller.dispose();
  });
});
