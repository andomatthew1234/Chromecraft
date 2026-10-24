import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import { extractSmartReaderArticleFromDocument } from "./smart-reader-extraction";

const paragraph =
  "Smart Reader keeps the original page alive while presenting the important article content in a calm, readable layout. ".repeat(
    8,
  );

function documentFor(body: string, head = "") {
  return new JSDOM(
    `<!doctype html><html><head><title>A useful guide</title>${head}</head><body>${body}</body></html>`,
    { url: "https://example.com/guides/reader" },
  );
}

describe("Smart Reader extraction", () => {
  it("preserves semantic article content and resolves safe resources", () => {
    const dom = documentFor(
      `<nav>Navigation links</nav><article><h1>A useful guide</h1><p>${paragraph}</p><h2 id="details">Details</h2><p><a href="#details">Jump to details</a></p><ul><li>One</li><li>Two</li></ul><figure><img src="../image.png" alt="Diagram"><figcaption>A diagram</figcaption></figure><pre><code>const ready = true;</code></pre><table><tbody><tr><th>Mode</th><td>Reader</td></tr></tbody></table><a href="/next">Next</a></article>`,
      '<meta name="author" content="Alex"><meta property="article:published_time" content="2026-10-24">',
    );
    const article = extractSmartReaderArticleFromDocument(
      dom.window.document,
      dom.window.location.href,
      false,
    );
    expect(article?.title).toContain("A useful guide");
    expect(article?.publishedTime).toBe("2026-10-24");
    expect(article?.content).toContain("<table>");
    expect(article?.content).toContain("<pre>");
    expect(article?.content).toContain('src="https://example.com/image.png"');
    expect(article?.content).toContain('href="https://example.com/next"');
    expect(article?.content).toContain('id="details"');
    expect(article?.content).toContain('href="#details"');
    dom.window.close();
  });

  it("removes active and unsafe content", () => {
    const dom = documentFor(
      `<article><h1>Safe story</h1><p>${paragraph}</p><script>globalThis.pwned=true</script><img src="javascript:alert(1)" onerror="alert(1)"><a href="javascript:alert(1)" style="color:red">bad</a><iframe srcdoc="bad"></iframe><form action="https://evil.example"><input></form></article>`,
    );
    const article = extractSmartReaderArticleFromDocument(
      dom.window.document,
      dom.window.location.href,
      false,
    );
    expect(article).not.toBeNull();
    expect(article?.content).not.toMatch(
      /script|iframe|form|input|onerror|javascript:|style=/iu,
    );
    dom.window.close();
  });

  it("keeps navigation-heavy pages unavailable unless manual extraction succeeds", () => {
    const dom = documentFor(
      `<main><h1>Search</h1>${Array.from({ length: 30 }, (_, index) => `<a href="/${index}">Result ${index}</a>`).join("")}</main>`,
    );
    expect(
      extractSmartReaderArticleFromDocument(
        dom.window.document,
        dom.window.location.href,
        false,
      ),
    ).toBeNull();
    expect(
      extractSmartReaderArticleFromDocument(
        dom.window.document,
        dom.window.location.href,
        true,
      ),
    ).toBeNull();
    dom.window.close();
  });

  it("rejects a link-heavy search page with a result description in manual mode", () => {
    const dom = documentFor(
      `<main><h1>Search results</h1><p>${"A short result description with a little supporting context. ".repeat(3)}</p>${Array.from({ length: 30 }, (_, index) => `<a href="/${index}">Detailed search result number ${index} with linked summary text</a>`).join("")}</main>`,
    );
    expect(
      extractSmartReaderArticleFromDocument(
        dom.window.document,
        dom.window.location.href,
        true,
      ),
    ).toBeNull();
    dom.window.close();
  });
});
