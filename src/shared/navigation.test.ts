import { describe, expect, it } from "vitest";

import {
  isAllowedWebUrl,
  isNavigationInputAddress,
  resolveNavigationInput,
} from "./navigation";

describe("resolveNavigationInput", () => {
  it("keeps explicit HTTP and HTTPS URLs", () => {
    expect(resolveNavigationInput("https://example.com/docs")).toBe(
      "https://example.com/docs",
    );
    expect(resolveNavigationInput("http://example.com")).toBe(
      "http://example.com/",
    );
  });

  it("infers HTTPS for public hostnames", () => {
    expect(resolveNavigationInput("example.com/path")).toBe(
      "https://example.com/path",
    );
  });

  it("uses HTTP for local development hosts", () => {
    expect(resolveNavigationInput("localhost:4173/test")).toBe(
      "http://localhost:4173/test",
    );
    expect(resolveNavigationInput("127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080/",
    );
  });

  it("routes ordinary text to search", () => {
    expect(resolveNavigationInput("  electron browser architecture  ")).toBe(
      "https://duckduckgo.com/?q=electron%20browser%20architecture",
    );
  });

  it("ignores empty input and rejects unsafe schemes", () => {
    expect(resolveNavigationInput("   ")).toBeNull();
    expect(resolveNavigationInput("file:///etc/passwd")).toBeNull();
    expect(resolveNavigationInput("javascript:alert(1)")).toBeNull();
  });
});

describe("isAllowedWebUrl", () => {
  it("allows only HTTP and HTTPS", () => {
    expect(isAllowedWebUrl("https://example.com")).toBe(true);
    expect(isAllowedWebUrl("http://localhost:3000")).toBe(true);
    expect(isAllowedWebUrl("file:///tmp/test")).toBe(false);
    expect(isAllowedWebUrl("not a url")).toBe(false);
  });
});

describe("isNavigationInputAddress", () => {
  it("distinguishes typed addresses from search queries", () => {
    expect(isNavigationInputAddress("youtube.com")).toBe(true);
    expect(isNavigationInputAddress("https://example.com/path")).toBe(true);
    expect(isNavigationInputAddress("how to build a browser")).toBe(false);
    expect(isNavigationInputAddress("javascript:alert(1)")).toBe(false);
  });
});
