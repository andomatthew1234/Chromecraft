import { describe, expect, it } from "vitest";

import {
  isAllowedGeminiSetupUrl,
  isGeminiApiKeyCandidate,
  normalizeOnboardingViewBounds,
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
});
