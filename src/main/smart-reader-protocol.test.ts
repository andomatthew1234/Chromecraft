import { describe, expect, it, vi } from "vitest";

import {
  parseSmartReaderUrl,
  registerSmartReaderProtocol,
  renderSmartReaderDocument,
  SmartReaderDocumentStore,
} from "./smart-reader-protocol";

const article = {
  title: "A <safe> article",
  byline: "Morgan",
  publishedTime: "2026-10-24",
  siteName: "Example",
  excerpt: "A concise introduction.",
  content: "<p>Already sanitized content.</p>",
  textContent: "Already sanitized content.",
  headings: [],
  textLength: 320,
  sourceUrl: "https://example.com/article",
};

describe("Smart Reader protocol", () => {
  it("serves opaque, scriptless documents with restrictive headers", async () => {
    let handler: ((request: Request) => Response | Promise<Response>) | null =
      null;
    const browserSession = {
      protocol: {
        handle: vi.fn(
          (
            _scheme: string,
            next: (request: Request) => Response | Promise<Response>,
          ) => {
            handler = next;
          },
        ),
      },
    };
    const store = new SmartReaderDocumentStore();
    const url = store.put(
      renderSmartReaderDocument(article, {
        theme: "warm",
        font: "serif",
        textScale: 1.1,
      }),
    );
    registerSmartReaderProtocol(browserSession as never, store);
    expect(parseSmartReaderUrl(url)).not.toBeNull();
    const response = await handler!(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "script-src 'none'",
    );
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
    const html = await response.text();
    expect(html).toContain('data-theme="warm"');
    expect(html).toContain("A &lt;safe&gt; article");
    expect(html).toContain("data-reader-tools-host");
    expect(html.indexOf("data-reader-tools-host")).toBeLessThan(
      html.indexOf('class="reader-header"'),
    );
    expect(html.indexOf("data-scout-summary-host")).toBeLessThan(
      html.indexOf("data-smart-reader-article"),
    );
  });

  it("rejects malformed tokens and write methods", async () => {
    let handler: ((request: Request) => Response | Promise<Response>) | null =
      null;
    const store = new SmartReaderDocumentStore();
    registerSmartReaderProtocol(
      {
        protocol: {
          handle: (_scheme: string, next: typeof handler) => {
            handler = next;
          },
        },
      } as never,
      store,
    );
    expect(parseSmartReaderUrl("chromecraft-reader://../article")).toBeNull();
    const response = await handler!(
      new Request("chromecraft-reader://missing/article", { method: "POST" }),
    );
    expect(response.status).toBe(405);
  });
});
