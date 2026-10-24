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

  it("offers stable Gemini tiers while excluding unsupported models", () => {
    expect(
      scoutPowerChoices("gemini", [
        model("gemini-2.5-flash-lite", null, true),
        model("gemini-2.5-flash"),
        model("gemini-2.5-pro"),
        model("gemini-2.5-flash-preview"),
        model("text-embedding-004"),
      ]).map((choice) => choice.model),
    ).toEqual(["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.5-pro"]);
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
