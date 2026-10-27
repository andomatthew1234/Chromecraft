import { describe, expect, it } from "vitest";

import {
  recommendedExtensions,
  hasDownloadedOnboardingUpdate,
  updateAiSetupChoices,
} from "./OnboardingExperience";

describe("Chromecraft onboarding", () => {
  it("offers the requested extensions through canonical Web Store URLs", () => {
    expect(
      recommendedExtensions.map(({ id, included }) => ({ id, included })),
    ).toEqual([
      { id: "ublock-origin", included: true },
      { id: "nngceckbapebfimnlniiiahkandclblb", included: undefined },
      { id: "dimkjjladgaekdlfebknbaooicmfalke", included: undefined },
      { id: "pcfcokpgaghaahjkfjpnonbgfppkbhmn", included: undefined },
      { id: "hlkiamolkbbnaleecldindlfddhlfhgj", included: undefined },
    ]);
    for (const extension of recommendedExtensions.filter(
      (candidate) => !candidate.included,
    )) {
      expect(extension.itemUrl).toBe(
        `https://chromewebstore.google.com/detail/${extension.id}`,
      );
    }
  });

  it("shows the restart page only for a downloaded application update", () => {
    const base = {
      status: "ready",
      canRestart: true,
      results: [
        {
          kind: "application",
          state: "ready",
          requiresRestart: true,
        },
      ],
    };
    expect(hasDownloadedOnboardingUpdate(base as never)).toBe(true);
    expect(
      hasDownloadedOnboardingUpdate({
        ...base,
        canRestart: false,
      } as never),
    ).toBe(false);
    expect(
      hasDownloadedOnboardingUpdate({
        ...base,
        results: [{ kind: "extension", state: "installed" }],
      } as never),
    ).toBe(false);
  });

  it("allows both AI providers while keeping skip exclusive", () => {
    let choices = updateAiSetupChoices(new Set(), "gemini");
    choices = updateAiSetupChoices(choices, "ollama");
    expect([...choices]).toEqual(["gemini", "ollama"]);

    choices = updateAiSetupChoices(choices, "skip");
    expect([...choices]).toEqual(["skip"]);

    choices = updateAiSetupChoices(choices, "gemini");
    expect([...choices]).toEqual(["gemini"]);
  });
});
