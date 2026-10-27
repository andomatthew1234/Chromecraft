import { describe, expect, it, vi } from "vitest";

import {
  OnboardingGeminiController,
  isAllowedGeminiSetupUrl,
  isGeminiApiKeyCandidate,
  normalizeOnboardingViewBounds,
  persistGeminiSetupSession,
  prepareGeminiSetupSession,
} from "./onboarding-gemini-controller";

describe("Gemini onboarding boundaries", () => {
  it("accepts complete Gemini API keys without normalising clipboard text", () => {
    expect(isGeminiApiKeyCandidate(`AIza${"a".repeat(35)}`)).toBe(true);
    expect(isGeminiApiKeyCandidate(` AIza${"a".repeat(35)}`)).toBe(false);
    expect(isGeminiApiKeyCandidate("AIza-short")).toBe(false);
    expect(isGeminiApiKeyCandidate(`AIza${"a".repeat(101)}`)).toBe(false);
    expect(isGeminiApiKeyCandidate("not-a-key")).toBe(false);
  });

  it("confines the embedded browser to approved HTTPS Google hosts", () => {
    expect(isAllowedGeminiSetupUrl("https://aistudio.google.com/apikey")).toBe(
      true,
    );
    expect(isAllowedGeminiSetupUrl("https://accounts.google.com/signin")).toBe(
      true,
    );
    expect(isAllowedGeminiSetupUrl("http://aistudio.google.com/apikey")).toBe(
      false,
    );
    expect(
      isAllowedGeminiSetupUrl("https://aistudio.google.com.evil.test/apikey"),
    ).toBe(false);
    expect(isAllowedGeminiSetupUrl("javascript:alert(1)")).toBe(false);
  });

  it("clamps valid renderer bounds and rejects unsafe geometry", () => {
    expect(
      normalizeOnboardingViewBounds(
        { x: 950, y: 700, width: 480, height: 360 },
        { x: 0, y: 0, width: 1_200, height: 800 },
      ),
    ).toEqual({ x: 708, y: 428, width: 480, height: 360 });

    expect(() =>
      normalizeOnboardingViewBounds(
        { x: 0, y: 0, width: 200, height: 360 },
        { x: 0, y: 0, width: 1_200, height: 800 },
      ),
    ).toThrow("invalid");
    expect(() =>
      normalizeOnboardingViewBounds(
        { x: Number.NaN, y: 0, width: 480, height: 360 },
        { x: 0, y: 0, width: 1_200, height: 800 },
      ),
    ).toThrow("invalid");
  });

  it("preconnects only after Gemini setup is explicitly started", () => {
    const preconnect = vi.fn();

    prepareGeminiSetupSession({ preconnect });

    expect(preconnect).toHaveBeenCalledTimes(2);
    expect(preconnect).toHaveBeenNthCalledWith(1, {
      url: "https://aistudio.google.com/apikey",
      numSockets: 2,
    });
    expect(preconnect).toHaveBeenNthCalledWith(2, {
      url: "https://accounts.google.com/",
      numSockets: 1,
    });
  });

  it("flushes the persistent browser session after closing embedded setup", () => {
    const flushStorageData = vi.fn();

    persistGeminiSetupSession({ flushStorageData });

    expect(flushStorageData).toHaveBeenCalledOnce();
  });

  it("detects a copied key while setup continues in the default browser", async () => {
    vi.useFakeTimers();
    const copiedKey = `AIza${"a".repeat(35)}`;
    const emit = vi.fn();
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const controller = new OnboardingGeminiController(
      {
        on: vi.fn(),
        removeListener: vi.fn(),
      } as never,
      {
        flushStorageData: vi.fn(),
      } as never,
      {
        readClipboardText: vi.fn().mockResolvedValue(copiedKey),
        openExternal,
        commitKey: vi.fn(),
        emit,
      },
    );

    try {
      await controller.openExternal();
      expect(openExternal).toHaveBeenCalledWith(
        "https://aistudio.google.com/apikey",
      );
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
});
