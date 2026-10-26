import type { MouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function safeWebUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function ScoutMarkdown({
  text,
  afterResearch = false,
}: {
  text: string;
  afterResearch?: boolean;
}) {
  return (
    <div
      className={`scout-markdown${afterResearch ? " scout-markdown-after-research" : ""}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => safeWebUrl(url) ?? ""}
        components={{
          a: ({ children, href }) => {
            const safeHref = safeWebUrl(href);
            if (!safeHref) {
              return (
                <span className="scout-markdown-invalid-link">{children}</span>
              );
            }
            return (
              <a
                href={safeHref}
                data-scout-link={safeHref}
                onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                  event.preventDefault();
                  void window.chromecraft.createTab(safeHref);
                }}
              >
                {children}
              </a>
            );
          },
          img: ({ alt }) =>
            alt ? (
              <span className="scout-markdown-image-alt">Image: {alt}</span>
            ) : null,
          table: ({ children }) => (
            <div className="scout-markdown-table-scroll">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
