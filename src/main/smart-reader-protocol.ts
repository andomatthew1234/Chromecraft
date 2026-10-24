import { randomUUID } from "node:crypto";

import type { Session } from "electron";

import type {
  SmartReaderAppearance,
  SmartReaderArticle,
} from "../shared/smart-reader";

export const SMART_READER_SCHEME = "chromecraft-reader";
const TOKEN_PATTERN = /^[a-f0-9-]{36}$/u;
const MAX_DOCUMENT_BYTES = 6 * 1024 * 1024;
const MAX_STORE_BYTES = 32 * 1024 * 1024;
const CSP = [
  "default-src 'none'",
  "img-src https: http: data:",
  "style-src 'unsafe-inline'",
  "script-src 'none'",
  "connect-src 'none'",
  "font-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

interface StoredReaderDocument {
  html: string;
  bytes: number;
  touchedAt: number;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pageTheme(theme: SmartReaderAppearance["theme"]): string {
  return theme === "warm" ? "warm" : theme;
}

export function renderSmartReaderDocument(
  article: SmartReaderArticle,
  appearance: SmartReaderAppearance,
): string {
  const metadata = [article.byline, article.publishedTime, article.siteName]
    .filter(Boolean)
    .map((value) => `<span>${escapeHtml(value ?? "")}</span>`)
    .join("<span class=dot aria-hidden=true>•</span>");
  return `<!doctype html>
<html lang="en" data-theme="${pageTheme(appearance.theme)}" data-font="${appearance.font}" style="--reader-scale:${appearance.textScale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${escapeHtml(article.title)}</title>
<style>
:root{color-scheme:light dark;--paper:#fffdfa;--ink:#24221f;--muted:#68635c;--line:#ddd8ce;--link:#155ab6;--code:#f1eee8;--font-serif:Charter,"Iowan Old Style","Palatino Linotype",Georgia,serif;--font-sans:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;background:var(--paper);color:var(--ink)}
:root[data-theme=light]{color-scheme:light;--paper:#fffdfa;--ink:#24221f;--muted:#68635c;--line:#ddd8ce;--link:#155ab6;--code:#f1eee8}
:root[data-theme=warm]{color-scheme:light;--paper:#f4ecd8;--ink:#302b23;--muted:#716758;--line:#d7c9ad;--link:#75521b;--code:#e9ddc3}
:root[data-theme=dark]{color-scheme:dark;--paper:#171717;--ink:#e7e1d7;--muted:#aaa39a;--line:#45413c;--link:#a8c7fa;--code:#242321}
@media(prefers-color-scheme:dark){:root[data-theme=system]{--paper:#171717;--ink:#e7e1d7;--muted:#aaa39a;--line:#45413c;--link:#a8c7fa;--code:#242321}}
*{box-sizing:border-box}html{min-height:100%;background:var(--paper)}body{min-height:100%;margin:0;background:var(--paper);color:var(--ink);font-family:var(--font-serif);font-size:calc(19px * var(--reader-scale));line-height:1.72;text-rendering:optimizeLegibility}html[data-font=sans] body{font-family:var(--font-sans);line-height:1.65}
.reader{width:min(720px,calc(100% - clamp(32px,8vw,112px)));margin:0 auto;padding:clamp(42px,8vh,88px) 0 104px}.reader-header{margin:0 0 clamp(32px,6vh,56px);padding-bottom:24px;border-bottom:1px solid var(--line)}h1{margin:0 0 16px;font-family:var(--font-serif);font-size:clamp(2.1rem,5vw,3.45rem);font-weight:650;line-height:1.08;letter-spacing:-.025em;text-wrap:balance}html[data-font=sans] h1{font-family:var(--font-sans)}.meta{display:flex;flex-wrap:wrap;gap:6px 10px;color:var(--muted);font-family:var(--font-sans);font-size:.78em;line-height:1.45}.dot{opacity:.6}.excerpt{margin:16px 0 0;color:var(--muted);font-style:italic}
.scout-summary-host{display:block;margin:-20px 0 32px;font-family:var(--font-sans);font-size:16px;line-height:1.5}.article-body{overflow-wrap:anywhere}.article-body>:first-child{margin-top:0}.article-body p{margin:1.1em 0}.article-body h2,.article-body h3,.article-body h4{margin:1.85em 0 .65em;font-family:var(--font-serif);line-height:1.2;text-wrap:balance}html[data-font=sans] :is(.article-body h2,.article-body h3,.article-body h4){font-family:var(--font-sans)}.article-body h2{font-size:1.62em}.article-body h3{font-size:1.3em}.article-body :is(ul,ol){padding-left:1.45em}.article-body li{margin:.45em 0}.article-body a{color:var(--link);text-decoration-thickness:.08em;text-underline-offset:.16em}.article-body a:hover{text-decoration-thickness:.13em}.article-body blockquote{margin:1.5em 0;padding:.2em 0 .2em 1.15em;border-left:4px solid var(--line);color:var(--muted)}.article-body figure{margin:2em min(0px,calc((680px - 100%)/-2));text-align:center}.article-body img{display:block;max-width:100%;height:auto;margin:1.6em auto;border-radius:12px}.article-body figcaption{margin:.75em auto 0;color:var(--muted);font-family:var(--font-sans);font-size:.78em}.article-body pre{max-width:100%;overflow:auto;padding:18px;border:1px solid var(--line);border-radius:12px;background:var(--code);font:calc(.78em * var(--reader-scale))/1.55 ui-monospace,"Cascadia Code",Consolas,monospace}.article-body code{padding:.12em .28em;border-radius:5px;background:var(--code);font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:.86em}.article-body pre code{padding:0;background:transparent;font-size:inherit}.article-body table{display:block;max-width:100%;overflow:auto;border-collapse:collapse;margin:1.6em 0;font-family:var(--font-sans);font-size:.84em}.article-body :is(th,td){padding:10px 12px;border:1px solid var(--line);text-align:left}.article-body th{background:var(--code)}hr{margin:2.2em 0;border:0;border-top:1px solid var(--line)}
@media(max-width:620px){.reader{width:calc(100% - 32px);padding-top:36px}h1{font-size:2rem}.article-body figure{margin-inline:0}}
@media(prefers-reduced-motion:no-preference){body{animation:reader-in 220ms cubic-bezier(.2,0,0,1)}@keyframes reader-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}}
</style>
</head>
<body data-smart-reader-surface><main class="reader"><header class="reader-header"><h1>${escapeHtml(article.title)}</h1>${metadata ? `<div class="meta">${metadata}</div>` : ""}${article.excerpt ? `<p class="excerpt">${escapeHtml(article.excerpt)}</p>` : ""}</header><section class="scout-summary-host" data-scout-summary-host aria-label="Scout article summary"></section><article class="article-body" data-smart-reader-article>${article.content}</article></main></body>
</html>`;
}

export class SmartReaderDocumentStore {
  private readonly documents = new Map<string, StoredReaderDocument>();
  private totalBytes = 0;

  put(html: string): string {
    const bytes = Buffer.byteLength(html, "utf8");
    if (bytes > MAX_DOCUMENT_BYTES) {
      throw new Error("The extracted article is too large for Smart Reader.");
    }
    const token = randomUUID();
    this.documents.set(token, { html, bytes, touchedAt: Date.now() });
    this.totalBytes += bytes;
    this.trim();
    return `${SMART_READER_SCHEME}://${token}/article`;
  }

  get(token: string): string | null {
    const document = this.documents.get(token);
    if (!document) return null;
    document.touchedAt = Date.now();
    return document.html;
  }

  removeUrl(value: string | null): void {
    const token = value ? parseSmartReaderUrl(value) : null;
    if (!token) return;
    const document = this.documents.get(token);
    if (!document) return;
    this.totalBytes -= document.bytes;
    this.documents.delete(token);
  }

  clear(): void {
    this.documents.clear();
    this.totalBytes = 0;
  }

  private trim(): void {
    if (this.totalBytes <= MAX_STORE_BYTES) return;
    const entries = [...this.documents.entries()].sort(
      (a, b) => a[1].touchedAt - b[1].touchedAt,
    );
    for (const [token, document] of entries) {
      this.documents.delete(token);
      this.totalBytes -= document.bytes;
      if (this.totalBytes <= MAX_STORE_BYTES) break;
    }
  }
}

export function parseSmartReaderUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== `${SMART_READER_SCHEME}:` ||
      !TOKEN_PATTERN.test(url.hostname) ||
      url.pathname !== "/article" ||
      url.username ||
      url.password ||
      url.port ||
      url.search
    ) {
      return null;
    }
    return url.hostname;
  } catch {
    return null;
  }
}

function errorResponse(status: number, message: string, extra?: HeadersInit) {
  return new Response(message, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "text/plain; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
}

export function registerSmartReaderProtocol(
  browserSession: Session,
  store: SmartReaderDocumentStore,
): void {
  browserSession.protocol.handle(SMART_READER_SCHEME, (request) => {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return errorResponse(405, "Method not allowed", { allow: "GET, HEAD" });
    }
    const token = parseSmartReaderUrl(request.url);
    const html = token ? store.get(token) : null;
    if (!html) return errorResponse(404, "Reader document not found");
    const headers = {
      "cache-control": "private, no-store",
      "content-security-policy": CSP,
      "content-type": "text/html; charset=utf-8",
      "cross-origin-resource-policy": "same-origin",
      "permissions-policy":
        "camera=(), microphone=(), geolocation=(), display-capture=()",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    };
    return new Response(method === "HEAD" ? null : html, {
      status: 200,
      headers,
    });
  });
}
