import { ipcRenderer } from "electron";

import { channels } from "../shared/channels";
import type {
  SmartReaderSummaryGenerateRequest,
  SmartReaderSummarySnapshot,
} from "../shared/smart-reader";
import geminiLogoSource from "../renderer/assets/providers/gemini-sparkle.svg?raw";
import ollamaLogoSource from "../renderer/assets/providers/ollama.svg?raw";
import { initializeSmartReaderFeatures } from "./smart-reader-features";

type Provider = "ollama" | "gemini";
type OpenSurface = "provider" | "settings" | "consent" | null;

const STYLE = `
.scout-shell{position:relative;display:grid;gap:12px}.scout-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.scout-control{min-height:40px;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:0 15px;border:0;border-radius:999px;color:var(--ink);background:color-mix(in srgb,var(--ink) 7%,var(--paper));font:650 13px/1 var(--font-sans);cursor:pointer;transition:background 160ms ease,transform 160ms ease,box-shadow 160ms ease}.scout-control:hover{background:color-mix(in srgb,var(--link) 14%,var(--paper));transform:translateY(-1px)}.scout-control:active{transform:scale(.97)}.scout-control:focus-visible,.scout-icon-button:focus-visible,.scout-menu-button:focus-visible{outline:3px solid color-mix(in srgb,var(--link) 35%,transparent);outline-offset:2px}.scout-control.primary{color:var(--paper);background:var(--link);box-shadow:0 4px 12px color-mix(in srgb,var(--link) 25%,transparent)}.scout-control.primary:hover{background:color-mix(in srgb,var(--link) 88%,var(--ink))}.scout-control.icon-only{width:40px;padding:0}.scout-control[disabled]{opacity:.55;cursor:default;transform:none}.scout-icon{width:20px;height:20px;display:block;flex:0 0 auto}.scout-provider-mark{width:19px;height:19px;display:grid;place-items:center;border-radius:7px;background:color-mix(in srgb,var(--link) 12%,var(--paper))}.scout-menu{position:absolute;z-index:12;top:48px;left:0;width:min(320px,calc(100vw - 32px));padding:8px;border:1px solid color-mix(in srgb,var(--ink) 10%,var(--line));border-radius:18px;background:color-mix(in srgb,var(--paper) 96%,transparent);box-shadow:0 16px 42px color-mix(in srgb,var(--ink) 18%,transparent);backdrop-filter:blur(18px);animation:scout-pop 170ms cubic-bezier(.2,0,0,1);transform-origin:top left}.scout-menu.settings{left:auto;right:0;width:min(360px,calc(100vw - 32px))}.scout-menu-title{display:grid;gap:2px;padding:10px 11px 8px}.scout-menu-title strong{font:700 15px/1.3 var(--font-sans)}.scout-menu-title small{color:var(--muted);font:12px/1.4 var(--font-sans)}.scout-menu-section{display:grid;gap:5px;padding:6px}.scout-menu-section+.scout-menu-section{border-top:1px solid var(--line)}.scout-menu-label{padding:6px 8px 2px;color:var(--muted);font:650 11px/1.2 var(--font-sans);text-transform:uppercase}.scout-menu-button{width:100%;min-height:46px;display:flex;align-items:center;gap:11px;padding:8px 10px;border:0;border-radius:13px;color:var(--ink);background:transparent;text-align:left;cursor:pointer}.scout-menu-button:hover{background:color-mix(in srgb,var(--link) 9%,transparent)}.scout-menu-button[aria-checked=true]{background:color-mix(in srgb,var(--link) 13%,var(--paper))}.scout-menu-copy{display:grid;gap:2px;min-width:0;flex:1}.scout-menu-copy strong{font:650 13px/1.3 var(--font-sans)}.scout-menu-copy small{overflow:hidden;color:var(--muted);font:11px/1.35 var(--font-sans);text-overflow:ellipsis;white-space:nowrap}.scout-card{overflow:hidden;border:1px solid color-mix(in srgb,var(--link) 18%,var(--line));border-radius:22px;background:color-mix(in srgb,var(--link) 6%,var(--paper));box-shadow:0 8px 28px color-mix(in srgb,var(--ink) 9%,transparent);animation:scout-card-in 220ms cubic-bezier(.2,0,0,1)}.scout-card-header{display:flex;align-items:center;gap:11px;padding:16px 16px 11px}.scout-avatar{width:36px;height:32px;position:relative;display:flex;align-items:center;justify-content:space-evenly;flex:0 0 auto;border-radius:14px 14px 12px 12px;background:#242834;box-shadow:inset 0 1px 0 #ffffff24}.scout-eye{width:9px;height:13px;border-radius:50%;background:#e9ffff;box-shadow:0 0 7px #68eadb}.scout-heading{min-width:0;display:grid;flex:1;gap:2px}.scout-heading strong{font:700 15px/1.25 var(--font-sans)}.scout-heading small{overflow:hidden;color:var(--muted);font:12px/1.35 var(--font-sans);text-overflow:ellipsis;white-space:nowrap}.scout-card-actions{display:flex;gap:2px}.scout-icon-button{width:36px;height:36px;display:grid;place-items:center;border:0;border-radius:50%;color:var(--muted);background:transparent;cursor:pointer;transition:background 150ms ease,color 150ms ease,transform 150ms ease}.scout-icon-button:hover{color:var(--ink);background:color-mix(in srgb,var(--ink) 8%,transparent)}.scout-icon-button:active{transform:scale(.92)}.scout-body{padding:2px 20px 17px}.scout-body[hidden]{display:none}.scout-points{display:grid;gap:11px;margin:4px 0 0;padding-left:20px}.scout-points li{padding-left:3px;animation:scout-point-in 240ms both}.scout-points li::marker{color:var(--link)}.scout-disclosure{margin:13px 0 0;color:var(--muted);font:12px/1.45 var(--font-sans)}.scout-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:15px}.scout-footer .scout-control{min-height:34px;background:transparent}.scout-status{display:flex;align-items:center;gap:10px;margin:0 16px 14px;padding:10px 12px;border-radius:14px;color:var(--muted);background:color-mix(in srgb,var(--link) 10%,var(--paper));font:600 12px/1.4 var(--font-sans)}.scout-status.error{color:color-mix(in srgb,#b3261e 82%,var(--ink));background:color-mix(in srgb,#ffdad6 62%,var(--paper))}.scout-pulse{width:19px;height:19px;position:relative;flex:0 0 auto;border-radius:8px;background:#242834}.scout-pulse:after{content:"";position:absolute;inset:5px;border-radius:50%;background:#72eadc;animation:scout-think 1.1s ease-in-out infinite}.scout-status-actions{display:flex;gap:5px;margin-left:auto}.scout-status-actions button{min-height:30px;padding:0 10px}.scout-empty{display:grid;gap:12px;padding:18px}.scout-empty p{margin:0;color:var(--muted);font:14px/1.5 var(--font-sans)}.scout-dialog-backdrop{position:fixed;z-index:1000;inset:0;display:grid;place-items:center;padding:20px;background:#0008;backdrop-filter:blur(5px);animation:scout-fade 150ms ease}.scout-dialog{width:min(440px,100%);display:grid;gap:15px;padding:22px;border-radius:26px;color:var(--ink);background:var(--paper);box-shadow:0 28px 80px #0006;animation:scout-dialog-in 210ms cubic-bezier(.2,0,0,1)}.scout-dialog-icon{width:46px;height:46px;display:grid;place-items:center;border-radius:16px;color:var(--link);background:color-mix(in srgb,var(--link) 13%,var(--paper))}.scout-dialog h2{margin:0;font:700 22px/1.2 var(--font-sans)}.scout-dialog p{margin:0;color:var(--muted);font:14px/1.55 var(--font-sans)}.scout-dialog-actions{display:flex;justify-content:flex-end;gap:8px}.scout-dialog-actions .scout-control{min-height:38px}.scout-warning{margin:0 6px 6px;padding:10px 11px;border-radius:12px;color:var(--muted);background:color-mix(in srgb,#f7b955 15%,var(--paper));font:12px/1.4 var(--font-sans)}@keyframes scout-pop{from{opacity:0;transform:translateY(-5px) scale(.98)}to{opacity:1;transform:none}}@keyframes scout-card-in{from{opacity:0;transform:translateY(6px) scale(.99)}to{opacity:1;transform:none}}@keyframes scout-point-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}@keyframes scout-dialog-in{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}@keyframes scout-fade{from{opacity:0}to{opacity:1}}@keyframes scout-think{0%,100%{opacity:.45;transform:scale(.7)}50%{opacity:1;transform:scale(1)}}@media(max-width:560px){.scout-actions{gap:6px}.scout-control{padding:0 12px}.scout-control.provider span:last-child{max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.scout-card-header{align-items:flex-start;flex-wrap:wrap}.scout-card-actions{margin-left:47px}.scout-menu.settings{left:0;right:auto}.scout-dialog-actions{flex-direction:column-reverse}.scout-dialog-actions .scout-control{width:100%}}@media(prefers-reduced-motion:reduce){.scout-control,.scout-icon-button,.scout-menu,.scout-card,.scout-points li,.scout-dialog-backdrop,.scout-dialog,.scout-pulse:after{animation:none!important;transition:none!important}}
/* Keep the compact toolbar controls on one shared Material surface shape. */
.scout-actions>.scout-control.icon-only{border-radius:14px}
`;

const SUMMARY_MOTION_STYLE = `
.scout-actions{gap:8px;flex-wrap:nowrap}.scout-actions>.scout-control{height:40px;min-height:40px}.scout-control.provider.icon-only{width:40px;padding:0;border-radius:14px}.scout-provider-logo{width:22px;height:22px;display:block;flex:0 0 auto}.scout-provider-logo.ollama{color:var(--ink)}.scout-provider-mark{width:28px;height:28px;border-radius:9px;background:color-mix(in srgb,var(--link) 8%,var(--paper))}.scout-provider-mark .scout-provider-logo{width:21px;height:21px}.scout-menu{animation:scout-menu-descend 220ms cubic-bezier(.2,0,0,1);transform-origin:top left}.scout-card{animation:none;background:color-mix(in srgb,var(--link) 7%,var(--paper));transform-origin:top center;will-change:height}.scout-card-header{min-height:40px;padding:14px 16px 11px}.scout-content-frame{display:grid;grid-template-rows:1fr;opacity:1;min-height:0}.scout-content-inner{min-height:0;overflow:hidden}.scout-card[data-expanded=false] .scout-content-frame{grid-template-rows:0fr;opacity:0;pointer-events:none}.scout-body{padding-top:5px}.scout-points li{animation:none}.scout-avatar{overflow:hidden;isolation:isolate}.scout-eye{position:relative;transform-origin:center}.scout-eye::after{content:"";position:absolute;left:3px;top:4px;width:3px;height:4px;border-radius:50%;background:#73e8de;box-shadow:0 0 4px #73e8de}.scout-avatar.blinking .scout-eye{animation:scout-eye-close 170ms cubic-bezier(.2,0,0,1)}.scout-avatar[data-mood=thinking] .scout-eye::after{animation:scout-pupil-think 1.45s ease-in-out infinite}.scout-avatar.success .scout-eye{animation:scout-happy-blink 520ms cubic-bezier(.2,0,0,1)}.scout-avatar.success{animation:scout-happy-bob 520ms cubic-bezier(.2,0,0,1)}[data-scout-animation-paused=true] .scout-avatar,[data-scout-animation-paused=true] .scout-avatar *{animation-play-state:paused!important}.scout-processing{animation:scout-soft-pulse 1.45s ease-in-out infinite}.scout-reveal-copy{will-change:opacity,transform}.scout-summary-enter{will-change:height,opacity}.scout-status{margin-top:2px}.scout-empty-error{padding:18px}.scout-empty-error .scout-actions{margin-top:12px;flex-wrap:wrap}@keyframes scout-menu-descend{from{opacity:0;transform:translateY(-12px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}@keyframes scout-eye-close{0%,100%{transform:scaleY(1)}48%,58%{transform:scaleY(.08)}}@keyframes scout-pupil-think{0%,100%{transform:translate(-1px,0)}35%{transform:translate(1px,-1px)}70%{transform:translate(0,1px)}}@keyframes scout-happy-blink{0%,100%{transform:scaleY(1)}35%,65%{transform:scaleY(.18) translateY(2px)}}@keyframes scout-happy-bob{0%,100%{transform:translateY(0)}45%{transform:translateY(-2px)}}@keyframes scout-soft-pulse{0%,100%{opacity:.72}50%{opacity:1}}@media(max-width:560px){.scout-actions{gap:6px}.scout-actions>.scout-control.primary{min-width:0;padding-inline:12px}.scout-card-header{align-items:center;flex-wrap:nowrap}.scout-card-actions{margin-left:0}.scout-card-actions .scout-icon-button{width:32px;height:32px}.scout-heading small{max-width:34vw}}@media(prefers-reduced-motion:reduce){.scout-menu,.scout-avatar,.scout-avatar *,.scout-processing{animation:none!important;transition:none!important}}
`;

let snapshot: SmartReaderSummarySnapshot | null = null;
let openSurface: OpenSurface = null;
let expanded = true;
let copied = false;
let localError: string | null = null;
let focusAction: string | null = null;
let copyTimer: ReturnType<typeof setTimeout> | null = null;
let blinkTimer: ReturnType<typeof setTimeout> | null = null;
let blinkEndTimer: ReturnType<typeof setTimeout> | null = null;
let successTimer: ReturnType<typeof setTimeout> | null = null;
let renderedStage: SmartReaderSummarySnapshot["stage"] | null = null;
let renderedResultTimestamp: number | null = null;
let renderedExpanded = expanded;
let rootIsVisible = true;
let summaryObserver: IntersectionObserver | null = null;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

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
} as const;

function icon(name: keyof typeof paths) {
  return `<svg class="scout-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${paths[name]}"></path></svg>`;
}

function scoutAvatar(thinking = false) {
  return `<span class="scout-avatar" data-mood="${thinking ? "thinking" : "idle"}" aria-hidden="true"><span class="scout-eye"></span><span class="scout-eye"></span></span>`;
}

function providerLabel(provider: Provider) {
  return provider === "gemini" ? "Google Gemini" : "Ollama";
}

function prepareProviderLogo(source: string, className: string) {
  return source
    .replace(
      "<svg ",
      `<svg class="scout-provider-logo ${className}" aria-hidden="true" focusable="false" `,
    )
    .replaceAll('fill="black"', 'fill="currentColor"');
}

const providerLogos: Record<Provider, string> = {
  gemini: prepareProviderLogo(geminiLogoSource, "gemini"),
  ollama: prepareProviderLogo(ollamaLogoSource, "ollama"),
};

function providerIcon(provider: Provider) {
  return providerLogos[provider];
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
  const provider = providerLabel(state.provider);
  return `<div class="scout-actions" aria-label="Scout overview controls">${actionButton(label, state.stage === "loading" ? "cancel" : "generate", state.stage === "loading" ? "stop" : "auto", "primary")}<button type="button" class="scout-control provider icon-only" data-action="provider" data-active-provider="${state.provider}" aria-label="Summary provider: ${provider}" title="Summary provider: ${provider}" aria-haspopup="menu" aria-expanded="${openSurface === "provider"}">${providerIcon(state.provider)}</button><button type="button" class="scout-control icon-only" data-action="settings" aria-label="Summary settings" title="Summary settings" aria-haspopup="dialog" aria-expanded="${openSurface === "settings"}">${icon("settings")}</button></div>`;
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
    if (state.stage === "loading") {
      return `<article class="scout-card scout-card-loading scout-summary-enter" data-expanded="true" data-summary-state="loading"><header class="scout-card-header">${scoutAvatar(true)}<span class="scout-heading"><strong>Scout overview</strong><small>${providerLabel(state.provider)} · reading this article</small></span></header><div class="scout-content-frame"><div class="scout-content-inner scout-reveal-copy"><div class="scout-status scout-processing" role="status"><span class="scout-pulse" aria-hidden="true"></span>Finding the key points and shaping your overview.<span class="scout-status-actions">${actionButton("Cancel", "cancel")}</span></div></div></div></article>`;
    }
    if (state.stage === "error")
      return `<div class="scout-card scout-card-error"><div class="scout-empty-error" role="alert"><div class="scout-heading"><strong>Scout couldn't finish</strong><small>${friendlyError(state)}</small></div><div class="scout-actions">${actionButton("Retry", "generate", "refresh")}${actionButton("Open settings", "open-settings", "settings")}</div></div></div>`;
    return "";
  }
  const attribution = `${providerLabel(result.provider)} · ${escapeMarkup(result.model)}`;
  const points = result.points.map(() => "<li></li>").join("");
  const processing =
    state.stage === "loading"
      ? `<div class="scout-status scout-processing" role="status"><span class="scout-pulse" aria-hidden="true"></span>Updating this overview…<span class="scout-status-actions">${actionButton("Cancel", "cancel")}</span></div>`
      : state.error
        ? `<div class="scout-status error" role="alert">${friendlyError(state)}<span class="scout-status-actions">${actionButton("Retry", "generate", "refresh")}</span></div>`
        : "";
  return `<article class="scout-card scout-card-ready" data-expanded="${expanded}" data-summary-state="${state.stage}" data-generated-at="${result.generatedAt}"><header class="scout-card-header">${scoutAvatar(state.stage === "loading")}<span class="scout-heading"><strong>Scout overview</strong><small>${attribution}</small></span><span class="scout-card-actions">${iconButton(expanded ? "Collapse summary" : "Expand summary", "expand", expanded ? "up" : "chevron")}${iconButton(copied ? "Copied" : "Copy summary", "copy", copied ? "check" : "copy")}${iconButton("Summary settings", "settings", "settings")}${iconButton("Dismiss summary", "dismiss", "close")}</span></header><div class="scout-content-frame" aria-hidden="${!expanded}"><div class="scout-content-inner"><div class="scout-body scout-reveal-copy"><ul class="scout-points">${points}</ul>${result.coverage === "partial" ? '<p class="scout-disclosure">This overview sampled an unusually long article, so some detail may be omitted.</p>' : ""}<div class="scout-footer">${actionButton("Regenerate", "generate", "refresh")}</div></div>${processing}</div></div></article>`;
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

function motionEnabled() {
  return !document.hidden && rootIsVisible && !reducedMotion.matches;
}

function clearBlinkSchedule() {
  if (blinkTimer) clearTimeout(blinkTimer);
  if (blinkEndTimer) clearTimeout(blinkEndTimer);
  blinkTimer = null;
  blinkEndTimer = null;
}

function scheduleBlink() {
  if (blinkTimer || !motionEnabled()) return;
  const thinking = snapshot?.stage === "loading";
  const delay = thinking
    ? 1_500 + Math.random() * 1_900
    : 3_000 + Math.random() * 4_000;
  blinkTimer = setTimeout(() => {
    blinkTimer = null;
    if (!motionEnabled()) return;
    const avatar = document.querySelector<HTMLElement>(
      "[data-scout-summary-host] .scout-avatar",
    );
    avatar?.classList.add("blinking");
    blinkEndTimer = setTimeout(() => {
      avatar?.classList.remove("blinking");
      blinkEndTimer = null;
      scheduleBlink();
    }, 180);
  }, delay);
}

function updateAnimationState(root?: HTMLElement | null) {
  const host =
    root ?? document.querySelector<HTMLElement>("[data-scout-summary-host]");
  const paused = !motionEnabled();
  if (host) host.dataset.scoutAnimationPaused = String(paused);
  if (paused) clearBlinkSchedule();
  else scheduleBlink();
}

function animateElement(
  element: HTMLElement,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
) {
  if (!motionEnabled()) return;
  const animation = element.animate(keyframes, {
    fill: "both",
    ...options,
  });
  void animation.finished
    .catch(() => undefined)
    .finally(() => animation.cancel());
}

function animateSummaryTransition(
  root: HTMLElement,
  previousCardHeight: number,
  hadCard: boolean,
  previousStage: SmartReaderSummarySnapshot["stage"] | null,
  previousTimestamp: number | null,
  wasExpanded: boolean,
) {
  const card = root.querySelector<HTMLElement>(".scout-card");
  if (!card || !motionEnabled() || !snapshot) return;

  const nextHeight = card.getBoundingClientRect().height;
  const expansionChanged = wasExpanded !== expanded && Boolean(snapshot.result);
  if (
    hadCard &&
    previousCardHeight > 0 &&
    Math.abs(nextHeight - previousCardHeight) > 1
  ) {
    animateElement(
      card,
      [{ height: `${previousCardHeight}px` }, { height: `${nextHeight}px` }],
      {
        duration: expansionChanged ? 300 : 340,
        easing: "cubic-bezier(.2,.75,.2,1)",
      },
    );
  } else if (!hadCard) {
    const headerHeight =
      card.querySelector<HTMLElement>(".scout-card-header")?.offsetHeight ?? 48;
    animateElement(
      card,
      [
        { height: `${headerHeight}px`, opacity: 0.86 },
        { height: `${nextHeight}px`, opacity: 1 },
      ],
      { duration: 360, easing: "cubic-bezier(.2,.75,.2,1)" },
    );
  }

  const revealCopy = card.querySelector<HTMLElement>(".scout-reveal-copy");
  const nextTimestamp = snapshot.result?.generatedAt ?? null;
  const resultChanged =
    nextTimestamp !== null && nextTimestamp !== previousTimestamp;
  if (revealCopy && (resultChanged || !hadCard || expansionChanged)) {
    const collapsing = expansionChanged && !expanded;
    animateElement(
      revealCopy,
      collapsing
        ? [
            { opacity: 1, transform: "translateY(0)" },
            { opacity: 0, transform: "translateY(-5px)" },
          ]
        : [
            { opacity: 0, transform: "translateY(8px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
      {
        duration: collapsing ? 170 : 240,
        delay: collapsing ? 0 : 70,
        easing: "cubic-bezier(.2,0,0,1)",
      },
    );
  }

  if (previousStage === "loading" && snapshot.stage === "ready") {
    const avatar = card.querySelector<HTMLElement>(".scout-avatar");
    avatar?.classList.add("success");
    if (successTimer) clearTimeout(successTimer);
    successTimer = setTimeout(() => {
      document
        .querySelector<HTMLElement>("[data-scout-summary-host] .scout-avatar")
        ?.classList.remove("success");
      successTimer = null;
    }, 620);
  }
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
  if (openSurface === "provider") {
    const trigger = actions.querySelector<HTMLElement>(
      '[data-action="provider"]',
    );
    const shell = root.querySelector<HTMLElement>(".scout-shell");
    if (trigger && shell) {
      const available = Math.max(0, shell.clientWidth - menu.offsetWidth);
      menu.style.left = `${Math.min(trigger.offsetLeft, available)}px`;
    }
  }
}

function render(restoreFocus = false) {
  const root = document.querySelector<HTMLElement>("[data-scout-summary-host]");
  if (!root || !snapshot) return;
  const previousCard = root.querySelector<HTMLElement>(".scout-card");
  const previousCardHeight = previousCard?.getBoundingClientRect().height ?? 0;
  const hadCard = Boolean(previousCard);
  const previousStage = renderedStage;
  const previousTimestamp = renderedResultTimestamp;
  const wasExpanded = renderedExpanded;
  root.innerHTML = `<div class="scout-shell">${renderActionRow(snapshot)}${renderProviderMenu(snapshot)}${renderSettingsMenu(snapshot)}${renderResult(snapshot)}</div>${renderConsent()}`;
  attach(root);
  placeOpenMenu(root);
  animateSummaryTransition(
    root,
    previousCardHeight,
    hadCard,
    previousStage,
    previousTimestamp,
    wasExpanded,
  );
  renderedStage = snapshot.stage;
  renderedResultTimestamp = snapshot.result?.generatedAt ?? null;
  renderedExpanded = expanded;
  updateAnimationState(root);
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
  style.textContent = `${STYLE}${SUMMARY_MOTION_STYLE}.scout-menu{max-height:min(620px,calc(100vh - 120px));overflow:auto}`;
  document.head.append(style);
  const host = document.querySelector<HTMLElement>("[data-scout-summary-host]");
  if (host && "IntersectionObserver" in window) {
    summaryObserver = new IntersectionObserver((entries) => {
      rootIsVisible = entries[0]?.isIntersecting ?? true;
      updateAnimationState(host);
    });
    summaryObserver.observe(host);
  }
  document.addEventListener("visibilitychange", () => updateAnimationState());
  window.addEventListener("pagehide", () => {
    rootIsVisible = false;
    updateAnimationState();
  });
  window.addEventListener("pageshow", () => {
    rootIsVisible = true;
    updateAnimationState();
  });
  reducedMotion.addEventListener("change", () => updateAnimationState());
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
