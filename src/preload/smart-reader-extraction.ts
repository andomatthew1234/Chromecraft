import createDOMPurify from "dompurify";
import { Readability, isProbablyReaderable } from "@mozilla/readability";

import type { SmartReaderArticle } from "../shared/smart-reader";
import type { SmartReaderSection } from "../shared/smart-reader";

const MAX_CONTENT_LENGTH = 5 * 1024 * 1024;
const ALLOWED_TAGS = [
  "a",
  "abbr",
  "article",
  "aside",
  "b",
  "blockquote",
  "br",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "picture",
  "pre",
  "q",
  "s",
  "samp",
  "section",
  "small",
  "source",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "u",
  "ul",
  "var",
] as const;

const ALLOWED_ATTR = [
  "alt",
  "cite",
  "colspan",
  "datetime",
  "height",
  "href",
  "id",
  "name",
  "rowspan",
  "scope",
  "src",
  "title",
  "width",
] as const;

function cleanText(
  value: string | null | undefined,
  max: number,
): string | null {
  const cleaned = value?.replace(/\s+/gu, " ").trim() ?? "";
  return cleaned ? cleaned.slice(0, max) : null;
}

function readPublishedTime(document: Document): string | null {
  const selectors = [
    'meta[property="article:published_time"]',
    'meta[name="date"]',
    'meta[name="pubdate"]',
    'meta[itemprop="datePublished"]',
  ];
  for (const selector of selectors) {
    const value = cleanText(
      document.querySelector<HTMLMetaElement>(selector)?.content,
      200,
    );
    if (value) return value;
  }
  return null;
}

function allowedUrl(
  raw: string,
  sourceUrl: string,
  kind: "link" | "image",
): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (kind === "link" && value.startsWith("#")) return value.slice(0, 2_048);
  if (
    kind === "image" &&
    /^data:image\/(?:avif|gif|jpeg|png|webp);base64,/iu.test(value)
  ) {
    return value.length <= 1_000_000 ? value : null;
  }
  try {
    const url = new URL(value, sourceUrl);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
    if (
      kind === "link" &&
      (url.protocol === "mailto:" || url.protocol === "tel:")
    ) {
      return url.href;
    }
  } catch {
    // Removed below.
  }
  return null;
}

function sanitizeArticle(
  content: string,
  sourceUrl: string,
  ownerDocument: Document,
): string {
  const purifier = createDOMPurify(ownerDocument.defaultView!);
  const sanitized = purifier.sanitize(content, {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTR],
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    FORBID_ATTR: ["style", "srcdoc", "ping"],
    FORBID_TAGS: [
      "audio",
      "button",
      "embed",
      "form",
      "iframe",
      "input",
      "link",
      "meta",
      "object",
      "script",
      "select",
      "style",
      "svg",
      "template",
      "textarea",
      "video",
    ],
    RETURN_DOM_FRAGMENT: true,
  });

  for (const element of sanitized.querySelectorAll<HTMLElement>("*")) {
    for (const attribute of [...element.attributes]) {
      if (attribute.name.toLowerCase().startsWith("on")) {
        element.removeAttribute(attribute.name);
      }
    }
    for (const attributeName of ["id", "name"] as const) {
      const value = element.getAttribute(attributeName);
      if (
        value !== null &&
        (!value.trim() ||
          value.length > 512 ||
          /[\u0000-\u001f\u007f]/u.test(value))
      ) {
        element.removeAttribute(attributeName);
      }
    }
  }
  for (const anchor of sanitized.querySelectorAll<HTMLAnchorElement>("a")) {
    const href = allowedUrl(
      anchor.getAttribute("href") ?? "",
      sourceUrl,
      "link",
    );
    if (href) anchor.setAttribute("href", href);
    else anchor.removeAttribute("href");
    anchor.setAttribute("rel", "noopener noreferrer");
  }
  for (const image of sanitized.querySelectorAll<HTMLImageElement>("img")) {
    const src = allowedUrl(image.getAttribute("src") ?? "", sourceUrl, "image");
    if (src) image.setAttribute("src", src);
    else image.removeAttribute("src");
    image.setAttribute("loading", "lazy");
    image.setAttribute("decoding", "async");
    image.setAttribute("referrerpolicy", "no-referrer");
  }
  for (const source of sanitized.querySelectorAll<HTMLSourceElement>(
    "source",
  )) {
    const src = allowedUrl(
      source.getAttribute("src") ?? "",
      sourceUrl,
      "image",
    );
    if (src) source.setAttribute("src", src);
    else source.removeAttribute("src");
  }

  const wrapper = ownerDocument.createElement("div");
  wrapper.append(sanitized);
  return wrapper.innerHTML.slice(0, MAX_CONTENT_LENGTH);
}

function assignHeadingAnchors(container: HTMLElement): SmartReaderSection[] {
  const used = new Set<string>();
  const sections: SmartReaderSection[] = [];
  for (const heading of container.querySelectorAll<HTMLHeadingElement>(
    "h1, h2, h3, h4",
  )) {
    const text = cleanText(heading.textContent, 500);
    if (!text) continue;
    const existing = heading.id.trim();
    const base =
      (existing && !used.has(existing)
        ? existing
        : text
            .normalize("NFKD")
            .toLowerCase()
            .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
            .replace(/^-+|-+$/gu, "")
            .slice(0, 72)) || "section";
    let id = existing && !used.has(existing) ? existing : `reader-${base}`;
    let suffix = 2;
    while (used.has(id)) id = `reader-${base}-${suffix++}`;
    used.add(id);
    heading.id = id;
    const level = Math.min(4, Math.max(1, Number(heading.tagName.slice(1)))) as
      | 1
      | 2
      | 3
      | 4;
    sections.push({ id, text, level });
    if (sections.length >= 100) break;
  }
  return sections;
}

export function extractSmartReaderArticleFromDocument(
  sourceDocument: Document,
  sourceUrl: string,
  force: boolean,
): SmartReaderArticle | null {
  if (!/^https?:\/\//u.test(sourceUrl)) return null;
  if (
    !force &&
    !isProbablyReaderable(sourceDocument, {
      minContentLength: 140,
      minScore: 18,
      visibilityChecker: () => true,
    })
  ) {
    return null;
  }

  const parsed = new Readability(sourceDocument.cloneNode(true) as Document, {
    charThreshold: force ? 80 : 260,
    keepClasses: false,
  }).parse();
  const title = cleanText(parsed?.title, 1_000);
  const textLength = parsed?.textContent?.trim().length ?? 0;
  if (!parsed?.content || !title || textLength < (force ? 80 : 260))
    return null;
  let content = sanitizeArticle(parsed.content, sourceUrl, sourceDocument);
  if (!content) return null;
  const qualityProbe = sourceDocument.createElement("div");
  qualityProbe.innerHTML = content;
  const extractedTextLength = qualityProbe.textContent?.trim().length ?? 0;
  const linkedTextLength = [...qualityProbe.querySelectorAll("a")].reduce(
    (total, anchor) => total + (anchor.textContent?.trim().length ?? 0),
    0,
  );
  if (
    extractedTextLength < (force ? 80 : 260) ||
    linkedTextLength / Math.max(1, extractedTextLength) > 0.5
  ) {
    return null;
  }
  const sections = assignHeadingAnchors(qualityProbe);
  content = qualityProbe.innerHTML.slice(0, MAX_CONTENT_LENGTH);

  const normalizedText = (qualityProbe.textContent ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  return {
    title,
    byline: cleanText(parsed.byline, 500),
    publishedTime: readPublishedTime(sourceDocument),
    siteName: cleanText(parsed.siteName, 300),
    excerpt: cleanText(parsed.excerpt, 1_000),
    content,
    textContent: normalizedText.slice(0, 1_000_000),
    textContentTruncated: normalizedText.length > 1_000_000,
    headings: [...qualityProbe.querySelectorAll("h1, h2, h3, h4, h5, h6")]
      .map((heading) => cleanText(heading.textContent, 500))
      .filter((heading): heading is string => Boolean(heading))
      .slice(0, 100),
    sections,
    textLength,
    sourceUrl,
  };
}
