import { describe, expect, it } from "vitest";

import type { AssistantMessageRequest } from "../../shared/ai-assistant";
import { buildAssistantPrompt } from "./controller";

function request(
  text: string,
  provider: "ollama" | "gemini",
): AssistantMessageRequest {
  return {
    conversationId: "conversation",
    messageId: "message",
    prompt: "What are the main points?",
    createdAt: 1,
    provider,
    model: "model",
    history: [],
    context: [
      {
        id: "article",
        kind: "full-reader-article",
        label: "Full Reader Article",
        detail: "Test article",
        createdAt: 1,
        data: {
          readerArticle: {
            tabId: "tab",
            revision: 2,
            url: "https://example.com/article",
            title: "Test article",
            siteName: "Example",
            byline: "Author",
            publishedTime: null,
            headings: ["Beginning", "Ending"],
            text,
            complete: true,
          },
        },
      },
    ],
  };
}

describe("Reader article context budgeting", () => {
  it("includes a short captured article in full and fences it as untrusted", () => {
    const result = buildAssistantPrompt(request("First. Second.", "ollama"));
    expect(result.coverageNotice).toBeNull();
    expect(result.prompt).toContain("Coverage: FULL captured article");
    expect(result.prompt).toContain("<untrusted_reader_article>");
    expect(result.prompt).toContain("First. Second.");
  });

  it("samples long articles in source order and explicitly reports partial coverage", () => {
    const text = Array.from(
      { length: 2_000 },
      (_, index) =>
        `Sentence ${String(index).padStart(4, "0")} contains detail.`,
    ).join(" ");
    const result = buildAssistantPrompt(request(text, "ollama"));
    expect(result.coverageNotice).toContain("partial");
    expect(result.prompt).toContain("Coverage: PARTIAL");
    expect(result.prompt.indexOf("Sentence 0000")).toBeLessThan(
      result.prompt.indexOf("Sentence 1999"),
    );
  });
});
