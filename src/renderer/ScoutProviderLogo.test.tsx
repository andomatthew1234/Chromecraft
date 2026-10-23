import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GeminiApiWordmark, GeminiLogo, OllamaLogo } from "./ScoutProviderLogo";

describe("ScoutProviderLogo", () => {
  it("renders bundled provider artwork without remote runtime requests", () => {
    const markup = renderToStaticMarkup(
      <>
        <GeminiLogo />
        <OllamaLogo />
        <GeminiApiWordmark />
      </>,
    );

    expect(markup).toContain("gemini-sparkle.png");
    expect(markup).toContain("ollama.svg");
    expect(markup).toContain("gemini-api.svg");
    expect(markup).not.toContain("https://");
  });

  it("keeps compact marks decorative and the wordmark labelled", () => {
    const compact = renderToStaticMarkup(
      <>
        <GeminiLogo />
        <OllamaLogo />
      </>,
    );
    const wordmark = renderToStaticMarkup(<GeminiApiWordmark />);

    expect(compact.match(/aria-hidden="true"/g)).toHaveLength(2);
    expect(compact).not.toContain('alt="Google Gemini"');
    expect(wordmark).toContain('alt="Gemini API"');
  });
});
