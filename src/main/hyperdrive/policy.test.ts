import { describe, expect, it } from "vitest";

import { evaluateSpeculationEligibility } from "./policy";

describe("evaluateSpeculationEligibility", () => {
  it("allows safe same-site HTTP navigation up to prefetch", () => {
    const result = evaluateSpeculationEligibility(
      "https://example.com/start",
      "/article",
    );

    expect(result).toMatchObject({
      eligible: true,
      reason: "eligible",
      maxTier: "prefetch",
      sameOrigin: true,
      sameSite: true,
      sensitive: false,
    });
    expect(result.url?.href).toBe("https://example.com/article");
  });

  it("treats www and the bare host as the same conservative site", () => {
    expect(
      evaluateSpeculationEligibility(
        "https://www.example.com/a",
        "https://example.com/b",
      ).eligible,
    ).toBe(true);
  });

  it("blocks cross-site requests by default and permits explicit opt-in", () => {
    const blocked = evaluateSpeculationEligibility(
      "https://example.com/",
      "https://different.test/page",
    );
    const allowed = evaluateSpeculationEligibility(
      "https://example.com/",
      "https://different.test/page",
      { allowCrossSite: true },
    );

    expect(blocked.reason).toBe("cross-site-disabled");
    expect(allowed.eligible).toBe(true);
  });

  it.each(["logout", "checkout", "payments", "delete", "oauth"])(
    "blocks the sensitive %s path segment",
    (segment) => {
      expect(
        evaluateSpeculationEligibility(
          "https://example.com/home",
          `https://example.com/${segment}`,
        ),
      ).toMatchObject({
        eligible: false,
        reason: "sensitive-path",
        sensitive: true,
      });
    },
  );

  it("blocks private ChatGPT conversations", () => {
    expect(
      evaluateSpeculationEligibility(
        "https://chatgpt.com/",
        "https://chatgpt.com/c/private-id",
      ).reason,
    ).toBe("sensitive-path");
  });

  it.each([
    "http://localhost/admin",
    "http://app.local/",
    "http://router.lan/",
    "http://service.internal/",
    "http://127.0.0.1/",
    "http://10.20.30.40/",
    "http://100.64.0.1/",
    "http://169.254.10.20/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://224.0.0.1/",
    "http://[::1]/",
    "http://[fe80::1]/",
  ])("blocks private or local-network target %s by default", (target) => {
    expect(
      evaluateSpeculationEligibility("http://example.com/", target, {
        allowCrossSite: true,
      }),
    ).toMatchObject({
      eligible: false,
      reason: "private-network",
      sensitive: true,
    });
  });

  it("requires an explicit private-network opt-in independently of cross-site opt-in", () => {
    const privateOnly = evaluateSpeculationEligibility(
      "http://192.168.1.20/home",
      "http://192.168.1.20/status",
      { allowPrivateNetworks: true },
    );
    const privateCrossSite = evaluateSpeculationEligibility(
      "http://example.com/",
      "http://192.168.1.20/status",
      { allowCrossSite: true, allowPrivateNetworks: true },
    );

    expect(privateOnly).toMatchObject({
      eligible: true,
      reason: "eligible",
      sameSite: true,
    });
    expect(privateCrossSite).toMatchObject({
      eligible: true,
      reason: "eligible",
      sameSite: false,
    });
  });

  it("blocks credential-bearing and token-bearing URLs", () => {
    expect(
      evaluateSpeculationEligibility(
        "https://example.com/",
        "https://name:secret@example.com/page",
      ).reason,
    ).toBe("credentials-in-url");
    expect(
      evaluateSpeculationEligibility(
        "https://example.com/",
        "https://example.com/page?access_token=secret",
      ).reason,
    ).toBe("sensitive-query");
  });

  it("blocks authentication hosts unless sensitive-site access is explicit", () => {
    const blocked = evaluateSpeculationEligibility(
      "https://accounts.example.com/start",
      "https://accounts.example.com/continue",
    );
    const allowed = evaluateSpeculationEligibility(
      "https://accounts.example.com/start",
      "https://accounts.example.com/continue",
      { allowSensitiveSites: true },
    );
    expect(blocked.reason).toBe("sensitive-domain");
    expect(allowed.eligible).toBe(true);
  });

  it("never speculates a likely state-changing endpoint", () => {
    expect(
      evaluateSpeculationEligibility(
        "https://example.com/",
        "https://example.com/logout",
        { allowSensitiveSites: true },
      ).reason,
    ).toBe("sensitive-path");
    expect(
      evaluateSpeculationEligibility(
        "https://example.com/",
        "https://example.com/endpoint?action=delete",
        { allowSensitiveSites: true },
      ).reason,
    ).toBe("sensitive-query");
  });

  it.each(["password", "reset", "subscribe", "purchase", "admin", "invite"])(
    "blocks the additional sensitive %s path segment",
    (segment) => {
      expect(
        evaluateSpeculationEligibility(
          "https://example.com/",
          `https://example.com/${segment}`,
        ),
      ).toMatchObject({
        eligible: false,
        reason: "sensitive-path",
        sensitive: true,
      });
    },
  );

  it("does not let sensitive-site permission enable state-changing paths", () => {
    for (const path of ["/admin", "/delete", "/signout", "/transfer"]) {
      expect(
        evaluateSpeculationEligibility(
          "https://example.com/",
          `https://example.com${path}`,
          { allowSensitiveSites: true },
        ).reason,
      ).toBe("sensitive-path");
    }
  });

  it("blocks same-document fragments, executable schemes, and downloads", () => {
    expect(
      evaluateSpeculationEligibility(
        "https://example.com/page#one",
        "https://example.com/page#two",
      ).reason,
    ).toBe("same-document");
    expect(
      evaluateSpeculationEligibility(
        "https://example.com/",
        "javascript:alert(1)",
      ).reason,
    ).toBe("unsupported-scheme");
    expect(
      evaluateSpeculationEligibility(
        "https://example.com/",
        "https://example.com/releases/app.exe?download=1",
      ).reason,
    ).toBe("download-like-url");
  });

  it("does not turn HTTPS intent into speculative plaintext traffic", () => {
    expect(
      evaluateSpeculationEligibility(
        "https://example.com/",
        "http://example.com/page",
      ).reason,
    ).toBe("insecure-downgrade");
  });

  it("honours exact and subdomain site exclusions", () => {
    const options = { disabledHosts: ["example.com"] };
    expect(
      evaluateSpeculationEligibility(
        "https://news.example.com/",
        "https://cdn.news.example.com/asset",
        options,
      ).reason,
    ).toBe("site-disabled");
  });
});
