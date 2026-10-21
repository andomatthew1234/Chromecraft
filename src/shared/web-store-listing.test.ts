import { describe, expect, it } from "vitest";

import { parseChromeWebStoreListingUrl } from "./web-store-listing";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const canonicalUrl = `https://chromewebstore.google.com/detail/${extensionId}`;

describe("parseChromeWebStoreListingUrl", () => {
  it.each([
    canonicalUrl,
    `${canonicalUrl}/`,
    `https://chromewebstore.google.com/detail/example/${extensionId}`,
    `https://chromewebstore.google.com/detail/category/example/${extensionId}`,
    `https://chromewebstore.google.com/detail/example/${extensionId}?hl=en-AU&utm_source=test#overview`,
    `https://chromewebstore.google.com:443/detail/example/${extensionId}`,
  ])("accepts a Chrome Web Store listing: %s", (value) => {
    expect(parseChromeWebStoreListingUrl(value)).toEqual({
      extensionId,
      canonicalUrl,
    });
  });

  it.each([
    "",
    "not a URL",
    `http://chromewebstore.google.com/detail/example/${extensionId}`,
    `https://chromewebstore.google.com.example/detail/example/${extensionId}`,
    `https://example.com/detail/example/${extensionId}`,
    `https://user@chromewebstore.google.com/detail/example/${extensionId}`,
    `https://user:password@chromewebstore.google.com/detail/example/${extensionId}`,
    `https://chromewebstore.google.com:444/detail/example/${extensionId}`,
    `https://chromewebstore.google.com/discover/example/${extensionId}`,
    `https://chromewebstore.google.com/foo/detail/example/${extensionId}`,
    `https://chromewebstore.google.com/detail/example/`,
    `https://chromewebstore.google.com/detail/example/${extensionId.slice(1)}`,
    `https://chromewebstore.google.com/detail/example/${extensionId}a`,
    "https://chromewebstore.google.com/detail/example/qrstuvwxyzabcdefqrstuvwxyzabcdef",
    `https://chromewebstore.google.com/detail/example/${extensionId.toUpperCase()}`,
    `https://chromewebstore.google.com/detail//${extensionId}`,
    `https://chromewebstore.google.com/detail/example/${extensionId}//`,
    `https://chromewebstore.google.com/detail/example/${extensionId}/unexpected`,
  ])("rejects a non-listing or unsafe URL: %s", (value) => {
    expect(parseChromeWebStoreListingUrl(value)).toBeNull();
  });

  it("removes query, fragment, slug, and trailing slash from the canonical URL", () => {
    const parsed = parseChromeWebStoreListingUrl(
      `https://chromewebstore.google.com/detail/tools/example/${extensionId}/?hl=en#reviews`,
    );

    expect(parsed?.canonicalUrl).toBe(canonicalUrl);
  });
});
