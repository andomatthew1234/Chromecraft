import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AiModelSnapshot, AiProviderId } from "../shared/ai-tools";
import {
  calculateScoutModelPickerPosition,
  filterScoutModelChoices,
  nextScoutModelChoiceKey,
  ScoutModelPicker,
  type ScoutModelChoice,
} from "./ScoutModelPicker";

function choice(
  provider: AiProviderId,
  name: string,
  options: Partial<AiModelSnapshot & ScoutModelChoice> = {},
): ScoutModelChoice {
  return {
    provider,
    category: options.category,
    availability: options.availability,
    description: options.description,
    model: {
      name,
      displayName: options.displayName ?? name,
      size: options.size ?? null,
      modifiedAt: options.modifiedAt ?? null,
      family: options.family ?? null,
      parameterSize: options.parameterSize ?? null,
      recommended: options.recommended,
    },
  };
}

const choices: ScoutModelChoice[] = [
  choice("ollama", "llama-large", {
    category: "advanced",
    parameterSize: "70B",
  }),
  choice("gemini", "gemini-fast", {
    category: "fast",
    displayName: "Gemini Fast",
    recommended: true,
  }),
  choice("ollama", "qwen-balanced", {
    category: "balanced",
    displayName: "Qwen Balanced",
    recommended: true,
  }),
  choice("gemini", "gemini-retired", {
    availability: "unavailable",
    recommended: true,
  }),
];

describe("filterScoutModelChoices", () => {
  it("places available recommended models first while preserving discovery order", () => {
    expect(
      filterScoutModelChoices(choices, "").map((item) => item.model.name),
    ).toEqual([
      "gemini-fast",
      "qwen-balanced",
      "llama-large",
      "gemini-retired",
    ]);
  });

  it("filters by provider and model metadata without exposing irrelevant choices", () => {
    expect(
      filterScoutModelChoices(choices, "fast", "gemini").map(
        (item) => item.model.name,
      ),
    ).toEqual(["gemini-fast"]);
    expect(
      filterScoutModelChoices(choices, "70b", "ollama").map(
        (item) => item.model.name,
      ),
    ).toEqual(["llama-large"]);
  });
});

describe("nextScoutModelChoiceKey", () => {
  it("wraps arrow navigation and skips unavailable models", () => {
    expect(nextScoutModelChoiceKey(choices, "ollama:llama-large", 1)).toBe(
      "gemini:gemini-fast",
    );
    expect(nextScoutModelChoiceKey(choices, "gemini:gemini-fast", -1)).toBe(
      "ollama:llama-large",
    );
    expect(nextScoutModelChoiceKey(choices, null, "last")).toBe(
      "ollama:qwen-balanced",
    );
  });
});

describe("calculateScoutModelPickerPosition", () => {
  const anchor = {
    top: 700,
    right: 820,
    bottom: 752,
    left: 500,
    width: 320,
    height: 52,
  };

  it("moves above the trigger and remains inside a desktop viewport", () => {
    const position = calculateScoutModelPickerPosition(
      anchor,
      { width: 440, height: 480 },
      { width: 900, height: 800 },
    );

    expect(position.placement).toBe("above");
    expect(position.left).toBeGreaterThanOrEqual(12);
    expect(position.left + position.width).toBeLessThanOrEqual(888);
    expect(position.top).toBeGreaterThanOrEqual(12);
  });

  it("uses a viewport-safe bottom sheet on narrow windows", () => {
    const position = calculateScoutModelPickerPosition(
      anchor,
      { width: 440, height: 700 },
      { width: 390, height: 600 },
    );

    expect(position.placement).toBe("sheet");
    expect(position.width).toBe(366);
    expect(position.maxHeight).toBe(560);
    expect(position.top).toBe(28);
    expect(position.top + position.maxHeight).toBeLessThanOrEqual(588);
  });
});

describe("ScoutModelPicker", () => {
  it("renders an accessible selected trigger", () => {
    const markup = renderToStaticMarkup(
      <ScoutModelPicker
        choices={choices}
        value={{ provider: "gemini", model: "gemini-fast" }}
        onSelect={vi.fn()}
        label="Scout conversation model"
        helperText="Used for new Scout conversations."
      />,
    );

    expect(markup).toContain("Scout conversation model");
    expect(markup).toContain("Gemini Fast");
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Used for new Scout conversations.");
  });

  it("renders the open sheet with searchable listbox semantics and availability", () => {
    const markup = renderToStaticMarkup(
      <ScoutModelPicker
        choices={choices}
        value={{ provider: "gemini", model: "gemini-fast" }}
        onSelect={vi.fn()}
        defaultOpen
      />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('role="listbox"');
    expect(markup.match(/role="option"/g)).toHaveLength(4);
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain("Recommended");
    expect(markup).toContain("Unavailable");
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("Filter by provider");
  });
});
