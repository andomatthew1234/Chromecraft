import { ipcRenderer } from "electron";

import { channels } from "../shared/channels";
import type {
  SmartReaderSummaryGenerateRequest,
  SmartReaderSummarySnapshot,
} from "../shared/smart-reader";
import { initializeSmartReaderFeatures } from "./smart-reader-features";

type Provider = "ollama" | "gemini";
type OpenSurface = "provider" | "settings" | "consent" | null;

const STYLE = `
.scout-shell{position:relative;display:grid;gap:12px}.scout-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.scout-control{min-height:40px;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:0 15px;border:0;border-radius:999px;color:var(--ink);background:color-mix(in srgb,var(--ink) 7%,var(--paper));font:650 13px/1 var(--font-sans);cursor:pointer;transition:background 160ms ease,transform 160ms ease,box-shadow 160ms ease}.scout-control:hover{background:color-mix(in srgb,var(--link) 14%,var(--paper));transform:translateY(-1px)}.scout-control:active{transform:scale(.97)}.scout-control:focus-visible,.scout-icon-button:focus-visible,.scout-menu-button:focus-visible{outline:3px solid color-mix(in srgb,var(--link) 35%,transparent);outline-offset:2px}.scout-control.primary{color:var(--paper);background:var(--link);box-shadow:0 4px 12px color-mix(in srgb,var(--link) 25%,transparent)}.scout-control.primary:hover{background:color-mix(in srgb,var(--link) 88%,var(--ink))}.scout-control.icon-only{width:40px;padding:0}.scout-control[disabled]{opacity:.55;cursor:default;transform:none}.scout-icon{width:20px;height:20px;display:block;flex:0 0 auto}.scout-provider-mark{width:19px;height:19px;display:grid;place-items:center;border-radius:7px;background:color-mix(in srgb,var(--link) 12%,var(--paper))}.scout-menu{position:absolute;z-index:12;top:48px;left:0;width:min(320px,calc(100vw - 32px));padding:8px;border:1px solid color-mix(in srgb,var(--ink) 10%,var(--line));border-radius:18px;background:color-mix(in srgb,var(--paper) 96%,transparent);box-shadow:0 16px 42px color-mix(in srgb,var(--ink) 18%,transparent);backdrop-filter:blur(18px);animation:scout-pop 170ms cubic-bezier(.2,0,0,1);transform-origin:top left}.scout-menu.settings{left:auto;right:0;width:min(360px,calc(100vw - 32px))}.scout-menu-title{display:grid;gap:2px;padding:10px 11px 8px}.scout-menu-title strong{font:700 15px/1.3 var(--font-sans)}.scout-menu-title small{color:var(--muted);font:12px/1.4 var(--font-sans)}.scout-menu-section{display:grid;gap:5px;padding:6px}.scout-menu-section+.scout-menu-section{border-top:1px solid var(--line)}.scout-menu-label{padding:6px 8px 2px;color:var(--muted);font:650 11px/1.2 var(--font-sans);text-transform:uppercase}.scout-menu-button{width:100%;min-height:46px;display:flex;align-items:center;gap:11px;padding:8px 10px;border:0;border-radius:13px;color:var(--ink);background:transparent;text-align:left;cursor:pointer}.scout-menu-button:hover{background:color-mix(in srgb,var(--link) 9%,transparent)}.scout-menu-button[aria-checked=true]{background:color-mix(in srgb,var(--link) 13%,var(--paper))}.scout-menu-copy{display:grid;gap:2px;min-width:0;flex:1}.scout-menu-copy strong{font:650 13px/1.3 var(--font-sans)}.scout-menu-copy small{overflow:hidden;color:var(--muted);font:11px/1.35 var(--font-sans);text-overflow:ellipsis;white-space:nowrap}.scout-card{overflow:hidden;border:1px solid color-mix(in srgb,var(--link) 18%,var(--line));border-radius:22px;background:color-mix(in srgb,var(--link) 6%,var(--paper));box-shadow:0 8px 28px color-mix(in srgb,var(--ink) 9%,transparent);animation:scout-card-in 220ms cubic-bezier(.2,0,0,1)}.scout-card-header{display:flex;align-items:center;gap:11px;padding:16px 16px 11px}.scout-avatar{width:36px;height:32px;position:relative;display:flex;align-items:center;justify-content:space-evenly;flex:0 0 auto;border-radius:14px 14px 12px 12px;background:#242834;box-shadow:inset 0 1px 0 #ffffff24}.scout-eye{width:9px;height:13px;border-radius:50%;background:#e9ffff;box-shadow:0 0 7px #68eadb}.scout-heading{min-width:0;display:grid;flex:1;gap:2px}.scout-heading strong{font:700 15px/1.25 var(--font-sans)}.scout-heading small{overflow:hidden;color:var(--muted);font:12px/1.35 var(--font-sans);text-overflow:ellipsis;white-space:nowrap}.scout-card-actions{display:flex;gap:2px}.scout-icon-button{width:36px;height:36px;display:grid;place-items:center;border:0;border-radius:50%;color:var(--muted);background:transparent;cursor:pointer;transition:background 150ms ease,color 150ms ease,transform 150ms ease}.scout-icon-button:hover{color:var(--ink);background:color-mix(in srgb,var(--ink) 8%,transparent)}.scout-icon-button:active{transform:scale(.92)}.scout-body{padding:2px 20px 17px}.scout-body[hidden]{display:none}.scout-points{display:grid;gap:11px;margin:4px 0 0;padding-left:20px}.scout-points li{padding-left:3px;animation:scout-point-in 240ms both}.scout-points li::marker{color:var(--link)}.scout-disclosure{margin:13px 0 0;color:var(--muted);font:12px/1.45 var(--font-sans)}.scout-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:15px}.scout-footer .scout-control{min-height:34px;background:transparent}.scout-status{display:flex;align-items:center;gap:10px;margin:0 16px 14px;padding:10px 12px;border-radius:14px;color:var(--muted);background:color-mix(in srgb,var(--link) 10%,var(--paper));font:600 12px/1.4 var(--font-sans)}.scout-status.error{color:color-mix(in srgb,#b3261e 82%,var(--ink));background:color-mix(in srgb,#ffdad6 62%,var(--paper))}.scout-pulse{width:19px;height:19px;position:relative;flex:0 0 auto;border-radius:8px;background:#242834}.scout-pulse:after{content:"";position:absolute;inset:5px;border-radius:50%;background:#72eadc;animation:scout-think 1.1s ease-in-out infinite}.scout-status-actions{display:flex;gap:5px;margin-left:auto}.scout-status-actions button{min-height:30px;padding:0 10px}.scout-empty{display:grid;gap:12px;padding:18px}.scout-empty p{margin:0;color:var(--muted);font:14px/1.5 var(--font-sans)}.scout-dialog-backdrop{position:fixed;z-index:1000;inset:0;display:grid;place-items:center;padding:20px;background:#0008;backdrop-filter:blur(5px);animation:scout-fade 150ms ease}.scout-dialog{width:min(440px,100%);display:grid;gap:15px;padding:22px;border-radius:26px;color:var(--ink);background:var(--paper);box-shadow:0 28px 80px #0006;animation:scout-dialog-in 210ms cubic-bezier(.2,0,0,1)}.scout-dialog-icon{width:46px;height:46px;display:grid;place-items:center;border-radius:16px;color:var(--link);background:color-mix(in srgb,var(--link) 13%,var(--paper))}.scout-dialog h2{margin:0;font:700 22px/1.2 var(--font-sans)}.scout-dialog p{margin:0;color:var(--muted);font:14px/1.55 var(--font-sans)}.scout-dialog-actions{display:flex;justify-content:flex-end;gap:8px}.scout-dialog-actions .scout-control{min-height:38px}.scout-warning{margin:0 6px 6px;padding:10px 11px;border-radius:12px;color:var(--muted);background:color-mix(in srgb,#f7b955 15%,var(--paper));font:12px/1.4 var(--font-sans)}@keyframes scout-pop{from{opacity:0;transform:translateY(-5px) scale(.98)}to{opacity:1;transform:none}}@keyframes scout-card-in{from{opacity:0;transform:translateY(6px) scale(.99)}to{opacity:1;transform:none}}@keyframes scout-point-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}@keyframes scout-dialog-in{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}@keyframes scout-fade{from{opacity:0}to{opacity:1}}@keyframes scout-think{0%,100%{opacity:.45;transform:scale(.7)}50%{opacity:1;transform:scale(1)}}@media(max-width:560px){.scout-actions{gap:6px}.scout-control{padding:0 12px}.scout-control.provider span:last-child{max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.scout-card-header{align-items:flex-start;flex-wrap:wrap}.scout-card-actions{margin-left:47px}.scout-menu.settings{left:0;right:auto}.scout-dialog-actions{flex-direction:column-reverse}.scout-dialog-actions .scout-control{width:100%}}@media(prefers-reduced-motion:reduce){.scout-control,.scout-icon-button,.scout-menu,.scout-card,.scout-points li,.scout-dialog-backdrop,.scout-dialog,.scout-pulse:after{animation:none!important;transition:none!important}}
`;

let snapshot: SmartReaderSummarySnapshot | null = null;
let openSurface: OpenSurface = null;
let expanded = true;
let copied = false;
let localError: string | null = null;
let focusAction: string | null = null;
let copyTimer: ReturnType<typeof setTimeout> | null = null;

const paths = {
  auto: "M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3zm6 10l1.1 2.9L22 17l-2.9 1.1L18 21l-1.1-2.9L14 17l2.9-1.1L18 13zM5 13l1.4 3.6L10 18l-3.6 1.4L5 23l-1.4-3.6L0 18l3.6-1.4L5 13z",
  settings:
    "M19.1 12.9c.04-.3.06-.6.06-.9s-.02-.61-.07-.91l1.92-1.5-1.82-3.15-2.25.9a7.5 7.5 0 0 0-1.56-.91L15.04 4h-3.63l-.36 2.42c-.56.23-1.08.53-1.56.9l-2.25-.89-1.82 3.15 1.92 1.5c-.04.3-.06.61-.06.92s.02.61.06.91l-1.92 1.5 1.82 3.15 2.25-.9c.48.38 1 .68 1.56.91l.36 2.43h3.63l.36-2.43c.56-.23 1.08-.53 1.56-.9l2.25.89 1.82-3.15-1.92-1.51zM13.23 15.2A3.2 3.2 0 1 1 13.23 8.8a3.2 3.2 0 0 1 0 6.4z",
  chevron: "M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6 1.4-1.4z",
  up: "m7.4 15.4-1.4-1.4 6-6 6 6-1.4 1.4-4.6-4.6-4.6 4.6z",
  copy: "M8 7V4h12v13h-3v3H4V7h4zm2 0h7v8h1V6h-8v1zm-4 2v9h9V9H6z",
  close:
    "M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4 6.4 5z",
  refresh:
    "M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.76-4.24L13 11h8V3l-3.3 3.3z",
  stop: "M6 6h12v12H6z",
  check: "m9.2 16.6-4.1-4.1L6.5 11l2.7 2.8 8.3-8.3L19 7l-9.8 9.6z",
  external:
    "M14 4h6v6h-2V7.4l-7.3 7.3-1.4-1.4L16.6 6H14V4zM5 6h6v2H7v9h9v-4h2v6H5V6z",
  cloud:
    "M19.4 10.1A7 7 0 0 0 6.1 8.4 5.5 5.5 0 0 0 6.5 19H19a4.5 4.5 0 0 0 .4-8.9zM19 17H6.5a3.5 3.5 0 0 1 .4-7l1 .1.3-1A5 5 0 0 1 18 11.4v.7h1a2.5 2.5 0 0 1 0 5z",
  computer: "M4 4h16v12H4V4zm2 2v8h12V6H6zm3 12h6v2H9v-2z",
} as const;

function icon(name: keyof typeof paths) {
  return `<svg class="scout-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${paths[name]}"></path></svg>`;
}

function scoutAvatar() {
  return '<span class="scout-avatar" aria-hidden="true"><span class="scout-eye"></span><span class="scout-eye"></span></span>';
}

function providerLabel(provider: Provider) {
  return provider === "gemini" ? "Google Gemini" : "Local AI";
}

function providerIcon(provider: Provider) {
  return provider === "gemini" ? icon("auto") : icon("computer");
}

function escapeMarkup(value: string) {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

function actionButton(
  label: string,
  action: string,
  iconName?: keyof typeof paths,
  className = "",
) {
  return `<button type="button" class="scout-control ${className}" data-action="${action}">${iconName ? icon(iconName) : ""}<span>${label}</span></button>`;
}

function iconButton(
  label: string,
  action: string,
  iconName: keyof typeof paths,
) {
  return `<button type="button" class="scout-icon-button" data-action="${action}" aria-label="${label}" title="${label}">${icon(iconName)}</button>`;
}

function friendlyError(state: SmartReaderSummarySnapshot) {
  const detail = (state.error ?? localError ?? "").toLowerCase();
  if (detail.includes("api key") || detail.includes("authenticate"))
    return "Gemini needs an API key before Scout can use it.";
  if (detail.includes("quota") || detail.includes("rate"))
    return "Gemini usage is temporarily limited. Check your quota or try again later.";
  if (detail.includes("ollama") || detail.includes("local ai"))
    return "Scout could not reach Ollama. Start Ollama, then try again.";
  if (detail.includes("model"))
    return "No compatible model is available. Refresh models or choose another provider.";
  return "Scout couldn't finish this overview. Try again or switch provider.";
}

function renderActionRow(state: SmartReaderSummarySnapshot) {
  const label =
    state.stage === "loading"
      ? "Generating..."
      : state.result
        ? "Regenerate summary"
        : "Generate summary";
  return `<div class="scout-actions" aria-label="Scout overview controls">${actionButton(label, state.stage === "loading" ? "cancel" : "generate", state.stage === "loading" ? "stop" : "auto", "primary")}<button type="button" class="scout-control provider" data-action="provider" aria-haspopup="menu" aria-expanded="${openSurface === "provider"}"><span class="scout-provider-mark">${providerIcon(state.provider)}</span><span>${providerLabel(state.provider)}</span>${icon("chevron")}</button><button type="button" class="scout-control icon-only" data-action="settings" aria-label="Summary settings" title="Summary settings" aria-haspopup="dialog" aria-expanded="${openSurface === "settings"}">${icon("settings")}</button></div>`;
}

function renderProviderMenu(state: SmartReaderSummarySnapshot) {
  if (openSurface !== "provider") return "";
  const option = (provider: Provider, description: string) =>
    `<button type="button" role="menuitemradio" aria-checked="${state.provider === provider}" class="scout-menu-button" data-provider="${provider}"><span class="scout-provider-mark">${providerIcon(provider)}</span><span class="scout-menu-copy"><strong>${providerLabel(provider)}</strong><small>${description}</small></span>${state.provider === provider ? icon("check") : ""}</button>`;
  return `<div class="scout-menu" role="menu" aria-label="AI provider"><div class="scout-menu-title"><strong>Choose AI provider</strong><small>Your choice is remembered for Reader summaries.</small></div><div class="scout-menu-section">${option("ollama", "Private models running on this device")}${option("gemini", "Fast cloud models using your API key")}</div></div>`;
}

function renderSettingsMenu(state: SmartReaderSummarySnapshot) {
  if (openSurface !== "settings") return "";
  const provider = state.providers[state.provider];
  const modelOption = (value: string | null, label: string, detail: string) =>
    `<button type="button" role="radio" aria-checked="${state.model === value}" class="scout-menu-button" data-model="${escapeMarkup(value ?? "")}"><span class="scout-menu-copy"><strong>${escapeMarkup(label)}</strong><small>${escapeMarkup(detail)}</small></span>${state.model === value ? icon("check") : ""}</button>`;
  const warning =
    state.provider === "gemini" && provider.apiKeyConfigured === false
      ? '<p class="scout-warning">Add a Gemini API key before generating an overview.</p>'
      : provider.connection === "unavailable" && provider.models.length === 0
        ? `<p class="scout-warning">${state.provider === "ollama" ? "Start Ollama, then refresh available models." : "Gemini is unavailable. Check your connection and API key."}</p>`
        : "";
  const choices = [
    modelOption(
      null,
      "Automatic (recommended)",
      "Scout picks a lightweight compatible model",
    ),
    ...provider.models.map((model) =>
      modelOption(
        model.name,
        model.displayName?.trim() || model.name,
        model.recommended ? "Recommended" : model.name,
      ),
    ),
  ].join("");
  const revoke =
    state.provider === "gemini" && provider.cloudConsentGranted
      ? `<button type="button" class="scout-menu-button" data-action="revoke-consent">${icon("cloud")}<span class="scout-menu-copy"><strong>Revoke article access</strong><small>Ask again before sending article text to Gemini</small></span></button>`
      : "";
  const providerChoice = (value: Provider) =>
    `<button type="button" role="radio" aria-checked="${state.provider === value}" class="scout-menu-button" data-provider="${value}"><span class="scout-provider-mark">${providerIcon(value)}</span><span class="scout-menu-copy"><strong>${providerLabel(value)}</strong></span>${state.provider === value ? icon("check") : ""}</button>`;
  return `<div class="scout-menu settings" role="dialog" aria-label="Summary settings"><div class="scout-menu-title"><strong>Summary settings</strong><small>${providerLabel(state.provider)} · advanced controls</small></div>${warning}<div class="scout-menu-section" role="radiogroup" aria-label="AI provider"><span class="scout-menu-label">Provider</span>${providerChoice("ollama")}${providerChoice("gemini")}</div><div class="scout-menu-section" role="radiogroup" aria-label="Summary model"><span class="scout-menu-label">Model</span>${choices}</div><div class="scout-menu-section"><span class="scout-menu-label">Advanced</span><button type="button" class="scout-menu-button" data-action="refresh">${icon("refresh")}<span class="scout-menu-copy"><strong>Refresh available models</strong><small>Check ${providerLabel(state.provider)} now</small></span></button><button type="button" class="scout-menu-button" data-action="open-settings">${icon("external")}<span class="scout-menu-copy"><strong>Open Scout settings</strong><small>Providers, API keys and model setup</small></span></button>${revoke}</div></div>`;
}

function renderResult(state: SmartReaderSummarySnapshot) {
  const result = state.result;
  if (!result) {
    if (state.stage === "loading")
      return `<div class="scout-card"><div class="scout-empty" role="status">${scoutAvatar()}<div class="scout-heading"><strong>Scout is summarising this article...</strong><small>${providerLabel(state.provider)} · choosing the best available model</small></div></div><div class="scout-status"><span class="scout-pulse" aria-hidden="true"></span>Reading the article and finding the key points.<span class="scout-status-actions">${actionButton("Cancel", "cancel")}</span></div></div>`;
    if (state.stage === "error")
      return `<div class="scout-card"><div class="scout-empty" role="alert"><div class="scout-heading"><strong>Scout couldn't finish</strong><small>${friendlyError(state)}</small></div><div class="scout-actions">${actionButton("Retry", "generate", "refresh")}${actionButton("Open settings", "open-settings", "settings")}</div></div></div>`;
    return "";
  }
  const attribution = `${providerLabel(result.provider)} · ${escapeMarkup(result.model)}`;
  const points = (expanded ? result.points : result.points.slice(0, 3))
    .map(() => "<li></li>")
    .join("");
  const processing =
    state.stage === "loading"
      ? `<div class="scout-status" role="status"><span class="scout-pulse" aria-hidden="true"></span>Scout is summarising this article...<span class="scout-status-actions">${actionButton("Cancel", "cancel")}</span></div>`
      : state.error
        ? `<div class="scout-status error" role="alert">${friendlyError(state)}<span class="scout-status-actions">${actionButton("Retry", "generate", "refresh")}</span></div>`
        : "";
  return `<article class="scout-card"><header class="scout-card-header">${scoutAvatar()}<span class="scout-heading"><strong>Scout overview</strong><small>${attribution}</small></span><span class="scout-card-actions">${iconButton(expanded ? "Collapse summary" : "Expand summary", "expand", expanded ? "up" : "chevron")}${iconButton(copied ? "Copied" : "Copy summary", "copy", copied ? "check" : "copy")}${iconButton("Summary settings", "settings", "settings")}${iconButton("Dismiss summary", "dismiss", "close")}</span></header><div class="scout-body"${expanded ? "" : " hidden"}><ul class="scout-points">${points}</ul>${result.coverage === "partial" ? '<p class="scout-disclosure">This overview sampled an unusually long article, so some detail may be omitted.</p>' : ""}<div class="scout-footer">${actionButton("Regenerate", "generate", "refresh")}</div></div>${processing}</article>`;
}

function renderConsent() {
  if (openSurface !== "consent") return "";
  return `<div class="scout-dialog-backdrop"><section class="scout-dialog" role="alertdialog" aria-modal="true" aria-labelledby="scout-consent-title" aria-describedby="scout-consent-copy"><span class="scout-dialog-icon">${icon("cloud")}</span><h2 id="scout-consent-title">Let Gemini read this article?</h2><p id="scout-consent-copy">Google Gemini processes the article text you choose to summarise. Your browser history, cookies and passwords are not included.</p><p>You can revoke this permission any time from Summary settings.</p><div class="scout-dialog-actions">${actionButton("Not now", "deny-consent")}${actionButton("Allow and summarise", "allow-consent", "auto", "primary")}</div></section></div>`;
}

async function invoke(channel: string, value?: unknown) {
  try {
    const next = (await ipcRenderer.invoke(channel, value)) as
      | SmartReaderSummarySnapshot
      | undefined;
    if (next) snapshot = next;
    localError = null;
  } catch {
    localError = "Scout couldn't complete that request.";
  }
  render();
}

async function generate(cloudConsent = false) {
  if (!snapshot) return;
  if (
    snapshot.provider === "gemini" &&
    snapshot.providers.gemini.apiKeyConfigured !== false &&
    snapshot.providers.gemini.cloudConsentGranted !== true &&
    !cloudConsent
  ) {
    focusAction = "generate";
    openSurface = "consent";
    render();
    return;
  }
  openSurface = null;
  await invoke(channels.generateSmartReaderSummary, {
    provider: snapshot.provider,
    model: snapshot.model,
    cloudConsent,
  } satisfies SmartReaderSummaryGenerateRequest);
}

async function handleAction(action: string) {
  if (!snapshot) return;
  if (action === "provider" || action === "settings") {
    focusAction = action;
    openSurface = openSurface === action ? null : action;
    render();
  } else if (action === "generate") await generate();
  else if (action === "cancel") await invoke(channels.cancelSmartReaderSummary);
  else if (action === "dismiss")
    await invoke(channels.dismissSmartReaderSummary);
  else if (action === "copy") {
    await invoke(channels.copySmartReaderSummary);
    copied = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copied = false;
      render();
    }, 1600);
    render();
  } else if (action === "expand") {
    expanded = !expanded;
    render();
  } else if (action === "refresh")
    await invoke(channels.refreshSmartReaderSummaryModels, snapshot.provider);
  else if (action === "allow-consent") {
    await invoke(channels.setSmartReaderSummaryConsent, true);
    await generate(true);
  } else if (action === "deny-consent") {
    openSurface = null;
    render(true);
  } else if (action === "revoke-consent")
    await invoke(channels.setSmartReaderSummaryConsent, false);
  else if (action === "open-settings") {
    openSurface = null;
    await ipcRenderer.invoke(channels.openSmartReaderSummarySettings);
    render();
  }
}

function attach(root: HTMLElement) {
  root
    .querySelectorAll<HTMLElement>("[data-action]")
    .forEach((control) =>
      control.addEventListener(
        "click",
        () => void handleAction(control.dataset.action ?? ""),
      ),
    );
  root
    .querySelectorAll<HTMLButtonElement>("[data-provider]")
    .forEach((control) =>
      control.addEventListener("click", async () => {
        openSurface = null;
        await invoke(channels.setSmartReaderSummaryPreference, {
          provider: control.dataset.provider as Provider,
          model: null,
        });
      }),
    );
  root.querySelectorAll<HTMLButtonElement>("[data-model]").forEach((control) =>
    control.addEventListener("click", async () => {
      await invoke(channels.setSmartReaderSummaryPreference, {
        provider: snapshot?.provider,
        model: control.dataset.model || null,
      });
    }),
  );
  const source = snapshot?.result?.points ?? [];
  root
    .querySelectorAll<HTMLLIElement>(".scout-points li")
    .forEach((point, index) => {
      point.textContent = source[index] ?? "";
    });
}

function placeOpenMenu(root: HTMLElement) {
  const menu = root.querySelector<HTMLElement>(".scout-menu");
  const actions = root.querySelector<HTMLElement>(".scout-actions");
  if (!menu || !actions) return;
  const bounds = actions.getBoundingClientRect();
  const spaceBelow = Math.max(120, window.innerHeight - bounds.bottom - 12);
  const spaceAbove = Math.max(120, bounds.top - 12);
  const desired = Math.min(menu.scrollHeight, 480);
  if (spaceBelow >= Math.min(desired, 280) || spaceBelow >= spaceAbove) {
    menu.style.top = "48px";
    menu.style.maxHeight = `${spaceBelow}px`;
  } else {
    const height = Math.min(desired, spaceAbove);
    menu.style.top = `${-height - 8}px`;
    menu.style.maxHeight = `${height}px`;
  }
}

function render(restoreFocus = false) {
  const root = document.querySelector<HTMLElement>("[data-scout-summary-host]");
  if (!root || !snapshot) return;
  root.innerHTML = `<div class="scout-shell">${renderActionRow(snapshot)}${renderProviderMenu(snapshot)}${renderSettingsMenu(snapshot)}${renderResult(snapshot)}</div>${renderConsent()}`;
  attach(root);
  placeOpenMenu(root);
  if (openSurface === "consent")
    root
      .querySelector<HTMLButtonElement>('[data-action="allow-consent"]')
      ?.focus();
  else if (restoreFocus && focusAction)
    root
      .querySelector<HTMLButtonElement>(`[data-action="${focusAction}"]`)
      ?.focus();
}

function initialize() {
  initializeSmartReaderFeatures();
  const style = document.createElement("style");
  style.textContent = `${STYLE}.scout-menu{max-height:min(620px,calc(100vh - 120px));overflow:auto}`;
  document.head.append(style);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !openSurface) return;
    event.preventDefault();
    openSurface = null;
    render(true);
  });
  document.addEventListener("pointerdown", (event) => {
    if (openSurface !== "provider" && openSurface !== "settings") return;
    const target = event.target;
    if (target instanceof Element && target.closest(".scout-shell")) return;
    openSurface = null;
    render(true);
  });
  ipcRenderer.on(channels.smartReaderSummaryChanged, (_event, value) => {
    snapshot = value as SmartReaderSummarySnapshot;
    render();
  });
  void ipcRenderer.invoke(channels.getSmartReaderSummary).then((value) => {
    snapshot = value as SmartReaderSummarySnapshot;
    render();
  });
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
else initialize();
