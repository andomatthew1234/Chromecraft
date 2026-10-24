import { describe, expect, it, vi } from "vitest";

import {
  faviconLimits,
  resolveFaviconDataUrl,
  safeFaviconDataUrl,
} from "./favicon";

function response(bytes: number[], contentType: string | null) {
  return {
    ok: true,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? contentType : null,
    },
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  };
}

describe("favicon resolution", () => {
  it("uses Chromium-provided data image URLs without a network request", async () => {
    const fetcher = vi.fn();
    const icon =
      "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'/%3E";

    await expect(
      resolveFaviconDataUrl([icon], "https://example.com/", fetcher),
    ).resolves.toBe(icon);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fetches arbitrary website favicon URLs through the browser profile", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        response([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png"),
      );

    const resolved = await resolveFaviconDataUrl(
      ["/assets/site-icon"],
      "https://example.com/articles/one",
      fetcher,
    );

    expect(resolved).toMatch(/^data:image\/png;base64,/u);
    expect(fetcher).toHaveBeenCalledWith(
      "https://example.com/assets/site-icon",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("supports page-scoped blob favicons and rejects unsafe values", async () => {
    const blobIcon = "data:image/png;base64,iVBORw0KGgo=";
    await expect(
      resolveFaviconDataUrl(
        ["blob:https://example.com/icon"],
        "https://example.com/",
        vi.fn(),
        vi.fn().mockResolvedValue(blobIcon),
      ),
    ).resolves.toBe(blobIcon);
    expect(
      safeFaviconDataUrl("data:text/html,<script>bad()</script>"),
    ).toBeNull();
    expect(
      safeFaviconDataUrl(
        `data:image/png;base64,${"A".repeat(faviconLimits.maxDataUrlLength)}`,
      ),
    ).toBeNull();
  });

  it("rejects successful responses that are not images", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        response([...Buffer.from("<!doctype html>")], "text/html"),
      );

    await expect(
      resolveFaviconDataUrl(
        ["https://example.com/not-an-icon"],
        "https://example.com/",
        fetcher,
      ),
    ).resolves.toBeNull();
  });
});
