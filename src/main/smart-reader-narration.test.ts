import { describe, expect, it } from "vitest";

import { splitNarrationText } from "./tab-manager";

describe("Smart Reader narration segmentation", () => {
  it("keeps ordered text bounded without duplicates", () => {
    const text = [
      "First paragraph has two sentences. It stays first.",
      "Second paragraph follows the first.",
      "Third paragraph is last.",
    ].join("\n\n");
    const segments = splitNarrationText(text, 58);
    expect(segments.every((segment) => segment.length <= 58)).toBe(true);
    expect(segments.join(" ")).toContain("First paragraph");
    expect(segments.join(" ").indexOf("Second paragraph")).toBeLessThan(
      segments.join(" ").indexOf("Third paragraph"),
    );
    expect(segments.join(" ").match(/Third paragraph/g)).toHaveLength(1);
  });
});
