import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AnimatedAssistantAvatar } from "./AssistantAvatar";

describe("AnimatedAssistantAvatar", () => {
  it("renders the decorative thinking scene with a bulb and three pages", () => {
    const markup = renderToStaticMarkup(
      <AnimatedAssistantAvatar state="thinking" variant="inline" />,
    );

    expect(markup).toContain("ai-character-stage-thinking");
    expect(markup).toContain("ai-character-stage-inline");
    expect(markup).toContain("ai-thinking-bulb");
    expect(markup).toContain("lightbulb");
    expect(markup.match(/class="ai-thinking-page"/g)).toHaveLength(3);
    expect(markup).toContain('aria-hidden="true"');
  });

  it("keeps decorative thinking objects out of the idle state", () => {
    const markup = renderToStaticMarkup(
      <AnimatedAssistantAvatar state="idle" />,
    );

    expect(markup).toContain("ai-character-stage-hero");
    expect(markup).not.toContain("ai-thinking-bulb");
    expect(markup).not.toContain("ai-thinking-page-orbit");
  });
});
