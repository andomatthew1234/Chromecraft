import { describe, expect, it } from "vitest";

import {
  recommendedExtensions,
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
