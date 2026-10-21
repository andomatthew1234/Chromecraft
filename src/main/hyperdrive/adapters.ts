import type { AdaptedCandidate, LinkCandidate, SiteAdapterId } from "./model";

export interface SiteAdapter {
  id: SiteAdapterId;
  /** Stable, narrow selectors an integration may use when collecting visible links. */
  selectors: readonly string[];
  matches(url: URL): boolean;
  classify(current: URL, candidate: URL, link: LinkCandidate): AdaptedCandidate;
}

function result(
  adapterId: SiteAdapterId | "generic",
  category: string,
  priority: number,
  reasons: readonly string[],
  options: { sensitive?: boolean; suppressSpeculation?: boolean } = {},
): AdaptedCandidate {
  return {
    adapterId,
    category,
    priority,
    reasons,
    sensitive: options.sensitive ?? false,
    suppressSpeculation: options.suppressSpeculation ?? false,
  };
}

function hostEqualsOrSubdomain(hostname: string, expected: string): boolean {
  const host = hostname.toLocaleLowerCase();
  return host === expected || host.endsWith(`.${expected}`);
}

const googleAdapter: SiteAdapter = {
  id: "google",
  selectors: ["#search a[href]", "a[data-ved][href]"],
  matches: (url) =>
    /^(?:[^.]+\.)*google\.(?:[a-z]{2,24}|com\.[a-z]{2}|co\.[a-z]{2})$/iu.test(
      url.hostname,
    ),
  classify(current, candidate, link) {
    if (link.alreadySpeculated) {
      return result(
        "google",
        "already-speculated",
        0,
        ["Site already prepared link"],
        {
          suppressSpeculation: true,
        },
      );
    }
    if (candidate.pathname === "/url") {
      return result(
        "google",
        "redirect-wrapper",
        0,
        ["Opaque redirect wrapper"],
        {
          suppressSpeculation: true,
        },
      );
    }
    if (candidate.origin !== current.origin) {
      return result("google", "search-result", 0.22, ["Google search result"]);
    }
    if (candidate.pathname === "/search") {
      return result("google", "related-search", 0.11, [
        "Google related search",
      ]);
    }
    return result("google", "google-navigation", 0.03, ["Google navigation"]);
  },
};

const youtubeAdapter: SiteAdapter = {
  id: "youtube",
  selectors: [
    "a#thumbnail[href]",
    "a#video-title[href]",
    "a.yt-simple-endpoint[href]",
  ],
  matches: (url) =>
    hostEqualsOrSubdomain(url.hostname, "youtube.com") ||
    url.hostname.toLocaleLowerCase() === "youtu.be",
  classify(_current, candidate, link) {
    if (link.alreadySpeculated) {
      return result(
        "youtube",
        "already-speculated",
        0,
        ["Site already prepared link"],
        {
          suppressSpeculation: true,
        },
      );
    }
    if (candidate.pathname === "/watch" && candidate.searchParams.has("v")) {
      return result("youtube", "video", 0.25, ["YouTube video"]);
    }
    if (candidate.pathname.startsWith("/shorts/")) {
      return result("youtube", "short", 0.2, ["YouTube short"]);
    }
    if (/^\/(?:@|channel\/|c\/|user\/)/u.test(candidate.pathname)) {
      return result("youtube", "channel", 0.1, ["YouTube channel"]);
    }
    return result("youtube", "youtube-navigation", 0.04, [
      "YouTube navigation",
    ]);
  },
};

const chatGptAdapter: SiteAdapter = {
  id: "chatgpt",
  selectors: ["nav a[href]", "main a[href]"],
  matches: (url) =>
    hostEqualsOrSubdomain(url.hostname, "chatgpt.com") ||
    url.hostname.toLocaleLowerCase() === "chat.openai.com",
  classify(_current, candidate) {
    const firstSegment = candidate.pathname.split("/").filter(Boolean)[0];
    if (
      firstSegment === "c" ||
      firstSegment === "g" ||
      firstSegment === "share"
    ) {
      return result(
        "chatgpt",
        "private-conversation",
        0,
        ["Private ChatGPT content requires explicit permission"],
        { sensitive: true, suppressSpeculation: true },
      );
    }
    return result("chatgpt", "chatgpt-navigation", 0.02, [
      "ChatGPT navigation",
    ]);
  },
};

const githubAdapter: SiteAdapter = {
  id: "github",
  selectors: [
    "main a[href]",
    "[data-testid='repositories-list'] a[href]",
    "a[data-hovercard-type][href]",
  ],
  matches: (url) => hostEqualsOrSubdomain(url.hostname, "github.com"),
  classify(_current, candidate, link) {
    if (link.alreadySpeculated) {
      return result(
        "github",
        "already-speculated",
        0,
        ["Site already prepared link"],
        {
          suppressSpeculation: true,
        },
      );
    }
    const segments = candidate.pathname.split("/").filter(Boolean);
    if (
      segments.length >= 2 &&
      !["settings", "marketplace", "features"].includes(segments[0])
    ) {
      const detail = segments[2];
      const category =
        detail === "pull" || detail === "pulls"
          ? "pull-request"
          : detail === "issues"
            ? "issue"
            : "repository";
      const priority = category === "repository" ? 0.18 : 0.15;
      return result("github", category, priority, [`GitHub ${category}`]);
    }
    return result("github", "github-navigation", 0.04, ["GitHub navigation"]);
  },
};

const wikipediaAdapter: SiteAdapter = {
  id: "wikipedia",
  selectors: [
    "#mw-content-text a[href^='/wiki/']",
    "#bodyContent a[href^='/wiki/']",
  ],
  matches: (url) => hostEqualsOrSubdomain(url.hostname, "wikipedia.org"),
  classify(_current, candidate) {
    if (candidate.pathname.startsWith("/wiki/Special:")) {
      return result(
        "wikipedia",
        "special-page",
        0,
        ["Wikipedia special page"],
        {
          suppressSpeculation: true,
        },
      );
    }
    if (candidate.pathname.startsWith("/wiki/")) {
      return result("wikipedia", "article", 0.2, ["Wikipedia article"]);
    }
    return result("wikipedia", "wikipedia-navigation", 0.03, [
      "Wikipedia navigation",
    ]);
  },
};

export const HYPERDRIVE_SITE_ADAPTERS: readonly SiteAdapter[] = [
  googleAdapter,
  youtubeAdapter,
  chatGptAdapter,
  githubAdapter,
  wikipediaAdapter,
];

export function resolveSiteCandidateUrl(
  currentUrl: string,
  candidateUrl: string,
): string {
  try {
    const current = new URL(currentUrl);
    const candidate = new URL(candidateUrl, current);
    candidate.hash = "";
    if (
      !googleAdapter.matches(current) ||
      candidate.origin !== current.origin ||
      candidate.pathname !== "/url"
    ) {
      return candidate.href;
    }
    for (const key of ["url", "q"] as const) {
      const wrappedValue = candidate.searchParams.get(key);
      if (!wrappedValue) continue;
      try {
        const destination = new URL(wrappedValue);
        if (
          (destination.protocol === "https:" ||
            destination.protocol === "http:") &&
          !destination.username &&
          !destination.password
        ) {
          destination.hash = "";
          return destination.href;
        }
      } catch {
        // Keep the original wrapper when its destination is not an absolute URL.
      }
    }
    return candidate.href;
  } catch {
    return candidateUrl;
  }
}

export function findSiteAdapter(currentUrl: string): SiteAdapter | undefined {
  let current: URL;
  try {
    current = new URL(currentUrl);
  } catch {
    return undefined;
  }
  return HYPERDRIVE_SITE_ADAPTERS.find((adapter) => adapter.matches(current));
}

export function adaptLinkCandidate(
  currentUrl: string,
  candidate: LinkCandidate,
): AdaptedCandidate {
  try {
    const current = new URL(currentUrl);
    const target = new URL(candidate.url, current);
    const adapter = HYPERDRIVE_SITE_ADAPTERS.find((entry) =>
      entry.matches(current),
    );
    if (!adapter) {
      return result("generic", "link", 0, ["Visible link"], {
        suppressSpeculation: candidate.alreadySpeculated === true,
      });
    }
    return adapter.classify(current, target, candidate);
  } catch {
    return result("generic", "invalid", 0, ["Invalid URL"], {
      suppressSpeculation: true,
    });
  }
}
