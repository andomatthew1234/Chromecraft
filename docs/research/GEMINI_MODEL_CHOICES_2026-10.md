# Gemini model choices for Scout (24 October 2026)

## Recommendation

Expose exactly four choices in Scout's Gemini picker:

| User-facing choice | API model ID               | Behaviour                                                 |
| ------------------ | -------------------------- | --------------------------------------------------------- |
| Flash-Lite         | `gemini-flash-lite-latest` | Google-maintained alias for the latest Flash-Lite release |
| Flash              | `gemini-flash-latest`      | Google-maintained alias for the latest Flash release      |
| Pro                | `gemini-pro-latest`        | Google-maintained alias for the latest Pro release        |
| Gemini 4 Argon     | `gemini-4-argon`           | Fixed ID for Google's current most capable frontier model |

The first three should be product-owned virtual choices rather than every concrete model returned by `models.list`. Google's API reference explicitly identifies all three `-latest` names as aliases for the latest release of their respective variation. Google warns that these aliases are hot-swapped and may resolve to stable, preview, or experimental releases, with two weeks' notice for breaking changes. That matches the requested automatic-upgrade behaviour, but it is intentionally less deterministic than pinning a stable version. [Interactions API reference](https://ai.google.dev/api/interactions-api) and [model version naming](https://ai.google.dev/gemini-api/docs/models#model-version-patterns).

The official name and ID for the fourth choice are **Gemini 4 Argon** and `gemini-4-argon`, not “Argon 4.” Google describes it as its latest and most capable model and documents it for both the current Interactions API and the legacy `generateContent` endpoint. [Gemini 4 Argon guide](https://ai.google.dev/gemini-api/docs/generate-content/latest-model) and [Interactions API supported models](https://ai.google.dev/gemini-api/docs/interactions-overview#supported-models--agents).

## Current concrete releases

- Gemini 3.8 Flash (`gemini-3.8-flash`) is the current flagship stable Flash model. Gemini 3.7 Flash is deprecated and requests are redirected to 3.8. [Gemini models](https://ai.google.dev/gemini-api/docs/models) and [Gemini API release notes](https://ai.google.dev/gemini-api/docs/changelog#october-2026).
- Gemini 3.5 Flash-Lite (`gemini-3.5-flash-lite`) is the current stable, cost-efficient Flash-Lite release. [Gemini models](https://ai.google.dev/gemini-api/docs/models).
- Gemini 3.1 Pro (`gemini-3.1-pro-preview`) is the currently documented Pro endpoint. It is a preview model, while the `gemini-pro-latest` alias is the suitable choice when Scout is expressly meant to follow the latest Pro automatically. [Gemini models](https://ai.google.dev/gemini-api/docs/models) and [Interactions API reference](https://ai.google.dev/api/interactions-api).
- Gemini 4 Argon (`gemini-4-argon`) became generally available on 13 October 2026. It is not available on the free tier. [Gemini API release notes](https://ai.google.dev/gemini-api/docs/changelog#october-2026) and [Gemini 4 Argon guide](https://ai.google.dev/gemini-api/docs/generate-content/latest-model#pricing).

## Implementation implications

1. Do not populate the Gemini selector by rendering every compatible model returned from `models.list`; render the four curated choices above.
2. Still refresh account model availability automatically. Use the result to mark a curated choice unavailable when the API key/account cannot access its model, rather than replacing the curated list with raw model entries.
3. Keep the three `-latest` aliases as the request IDs. Do not resolve and persist their current concrete targets, or Scout will stop following future releases.
4. Treat Argon separately because it has a fixed endpoint and paid-tier restriction. A failed availability check should produce a clear unavailable/plan message without preventing use of the other three choices.
5. The existing REST `generateContent` integration can call `gemini-4-argon`; Google supplies an official `v1beta/models/gemini-4-argon:generateContent` example. Its newer long-output and thinking controls are optional for ordinary Scout chat, although the documented default thinking level is `medium`. [Gemini 4 Argon quickstart](https://ai.google.dev/gemini-api/docs/generate-content/latest-model#quickstart).

## Source quality note

Only first-party Google AI documentation and API references were used. No assumptions were made from screenshots, community posts, or third-party model lists.
