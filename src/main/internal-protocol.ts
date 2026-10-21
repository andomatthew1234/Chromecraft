import type { Session } from "electron";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function registerInternalProtocol(browserSession: Session): void {
  browserSession.protocol.handle("chromecraft", (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "error") {
      return new Response("Not found", { status: 404 });
    }

    const failedUrl = escapeHtml(
      url.searchParams.get("url") ?? "the requested page",
    );
    const description = escapeHtml(
      url.searchParams.get("description") ?? "The page could not be loaded.",
    );
    const html = `<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
          <title>Page unavailable</title>
          <style>
            :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
            body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #f4f5f7; color: #202124; }
            main { width: min(34rem, calc(100% - 3rem)); }
            h1 { font-size: 1.8rem; margin-bottom: .5rem; }
            p { line-height: 1.55; }
            code { overflow-wrap: anywhere; }
            @media (prefers-color-scheme: dark) { body { background: #202124; color: #e8eaed; } }
          </style>
        </head>
        <body><main><h1>Page unavailable</h1><p>${description}</p><p><code>${failedUrl}</code></p><p>Check the address or your connection, then use Reload.</p></main></body>
      </html>`;

    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    });
  });
}
