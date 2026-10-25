import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ScoutMarkdown } from "./ScoutMarkdown";

describe("ScoutMarkdown", () => {
  it("renders assistant Markdown instead of displaying its punctuation", () => {
    const markup = renderToStaticMarkup(
      <ScoutMarkdown
        text={[
          "## Comparison",
          "",
          "1. **280 A-RGB**",
          "   - Larger *140 mm* fans",
          "2. ~~Older~~ **360**",
        ].join("\n")}
      />,
    );

    expect(markup).toContain("<h2>Comparison</h2>");
    expect(markup).toContain("<ol>");
    expect(markup).toContain("<strong>280 A-RGB</strong>");
    expect(markup).toContain("<em>140 mm</em>");
    expect(markup).toContain("<del>Older</del>");
    expect(markup).not.toContain("**280 A-RGB**");
  });

  it("supports GFM tables, task lists, blockquotes, and fenced code", () => {
    const markup = renderToStaticMarkup(
      <ScoutMarkdown
        text={[
          "> Grounded comparison",
          "",
          "| Cooler | Price |",
          "| --- | ---: |",
          "| 280 | $139 |",
          "",
          "- [x] Compared",
          "",
          "```txt",
          "38 mm radiator",
          "```",
        ].join("\n")}
      />,
    );

    expect(markup).toContain("<blockquote>");
    expect(markup).toContain("<table>");
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain("<pre>");
    expect(markup).toContain("38 mm radiator");
  });

  it("does not render raw HTML, remote images, or unsafe links", () => {
    const markup = renderToStaticMarkup(
      <ScoutMarkdown
        text={[
          '<script>alert("no")</script>',
          '<iframe src="https://tracker.example"></iframe>',
          "![tracking pixel](https://tracker.example/pixel.png)",
          "[unsafe](javascript:alert(1))",
          "[local](file:///secret.txt)",
          "[relative](/account)",
          "[safe](https://example.com/specs)",
        ].join("\n\n")}
      />,
    );

    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("<iframe");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain('href="javascript:');
    expect(markup).not.toContain('href="file:');
    expect(markup).not.toContain('href="/account"');
    expect(markup).toContain('data-scout-link="https://example.com/specs"');
  });
});
