import { describe, expect, it } from "vitest";

import type { AiModelSnapshot } from "./ai-tools";
import { scoutPowerChoices } from "./ai-power";

function model(
  name: string,
  parameterSize: string | null = null,
  recommended = false,
): AiModelSnapshot {
  return {
    name,
    displayName: name,
    size: null,
    modifiedAt: null,
    family: null,
    parameterSize,
    recommended,
  };
}

describe("scoutPowerChoices", () => {
  it("uses real compatible local models ordered from lighter to larger", () => {
    expect(
      scoutPowerChoices("ollama", [
        model("nomic-embed-text", "0.3B"),
        model("llama3:70b", "70B"),
        model("qwen3:1.7b", "1.7B"),
        model("qwen3:8b", "8B"),
      ]).map((choice) => [choice.model, choice.category]),
    ).toEqual([
      ["qwen3:1.7b", "Fastest"],
      ["qwen3:8b", "Balanced"],
      ["llama3:70b", "Most capable"],
    ]);
  });

  it("offers exactly the latest Gemini aliases plus Gemini 4 Argon", () => {
    expect(
      scoutPowerChoices("gemini", [
        model("gemini-flash-lite-latest", null, true),
        model("gemini-flash-latest"),
        model("gemini-pro-latest"),
        model("gemini-4-argon"),
        model("gemini-3.8-flash"),
        model("text-embedding-004"),
      ]).map((choice) => choice.model),
    ).toEqual([
      "gemini-flash-lite-latest",
      "gemini-flash-latest",
      "gemini-pro-latest",
      "gemini-4-argon",
    ]);
  });

  it("keeps an existing selected model representable in a four-step dial", () => {
    const choices = scoutPowerChoices(
      "ollama",
      [1, 2, 3, 4, 5, 6].map((size) => model(`model-${size}`, `${size}B`)),
      "model-2",
    );

    expect(choices).toHaveLength(4);
    expect(choices.map((choice) => choice.model)).toContain("model-2");
  });
});
