import { describe, expect, it } from "vitest";

import { isResearchEligibleUrl } from "./research-origin-policy";

describe("research origin policy", () => {
  it("allows ordinary public web pages", () => {
    expect(
      isResearchEligibleUrl("https://example.com/articles/product-review"),
    ).toBe(true);
    expect(isResearchEligibleUrl("http://localhost:3000/docs")).toBe(true);
  });

  it("rejects non-web, credentialed, and sensitive surfaces", () => {
    const restricted = [
      "file:///C:/secret.txt",
      "https://user:password@example.com/",
      "https://accounts.google.com/ServiceLogin",
      "https://mail.google.com/mail/u/0/#inbox",
      "https://secure.example-bank.test/dashboard",
      "https://secure-login.example.test/",
      "https://example.test/login.html",
      "https://www.paypal.com/myaccount/summary",
      "https://shop.example.test/checkout",
      "https://example.test/callback?access_token=secret",
      "https://example.test/#inbox",
    ];
    for (const value of restricted) {
      expect(isResearchEligibleUrl(value), value).toBe(false);
    }
  });
});
