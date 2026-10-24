import { ipcRenderer } from "electron";

import { channels } from "../shared/channels";
import type {
  SmartReaderSummaryGenerateRequest,
  SmartReaderSummarySnapshot,
} from "../shared/smart-reader";

const STYLE = `
.scout-actions{display:flex;align-items:center;gap:8px}.scout-button{min-height:38px;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:0 15px;border:0;border-radius:999px;color:var(--ink);background:color-mix(in srgb,var(--link) 13%,var(--paper));font:600 13px/1 var(--font-sans);cursor:pointer}.scout-button:hover{background:color-mix(in srgb,var(--link) 19%,var(--paper))}.scout-button:focus-visible{outline:3px solid color-mix(in srgb,var(--link) 35%,transparent);outline-offset:2px}.scout-button.icon{width:38px;padding:0}.scout-sparkle{color:var(--link);font-size:19px}.scout-card{overflow:hidden;border:1px solid color-mix(in srgb,var(--link) 20%,var(--line));border-radius:22px;background:color-mix(in srgb,var(--link) 7%,var(--paper));box-shadow:0 7px 24px color-mix(in srgb,var(--ink) 8%,transparent);animation:scout-in 220ms cubic-bezier(.2,0,0,1)}.scout-card-header{display:flex;align-items:center;gap:10px;padding:16px 18px 10px}.scout-avatar{width:32px;height:32px;display:grid;place-items:center;border-radius:12px;color:var(--link);background:color-mix(in srgb,var(--link) 14%,var(--paper));font-size:18px}.scout-heading{min-width:0;display:grid;flex:1}.scout-heading strong{font:650 15px/1.25 var(--font-sans)}.scout-heading small{overflow:hidden;color:var(--muted);font:12px/1.35 var(--font-sans);text-overflow:ellipsis;white-space:nowrap}.scout-card-actions{display:flex;gap:2px}.scout-card-actions button{width:34px;height:34px;border:0;border-radius:50%;color:var(--muted);background:transparent;cursor:pointer}.scout-card-actions button:hover{color:var(--ink);background:color-mix(in srgb,var(--ink) 7%,transparent)}.scout-body{padding:4px 20px 18px}.scout-points{display:grid;gap:10px;margin:4px 0 0;padding-left:20px}.scout-points li{padding-left:3px;animation:scout-point-in 260ms both}.scout-points li:nth-child(2){animation-delay:45ms}.scout-points li:nth-child(3){animation-delay:90ms}.scout-points li:nth-child(4){animation-delay:135ms}.scout-points li:nth-child(5){animation-delay:180ms}.scout-disclosure{margin:13px 0 0;color:var(--muted);font:12px/1.45 var(--font-sans)}.scout-loading{display:grid;gap:12px;padding:18px}.scout-loading-row{display:flex;align-items:center;gap:11px}.scout-progress{height:3px;overflow:hidden;border-radius:999px;background:color-mix(in srgb,var(--link) 12%,var(--line))}.scout-progress:after{content:"";display:block;width:42%;height:100%;border-radius:inherit;background:var(--link);animation:scout-progress 1.2s ease-in-out infinite}.scout-error{display:grid;gap:11px;padding:18px}.scout-error p{margin:0;color:var(--muted)}.scout-footer{display:flex;flex-wrap:wrap;gap:7px;margin-top:14px}.scout-footer .scout-button{min-height:34px;background:transparent}.scout-settings{display:grid;gap:13px;margin-top:10px;padding:16px;border:1px solid var(--line);border-radius:18px;background:var(--paper);box-shadow:0 10px 28px color-mix(in srgb,var(--ink) 11%,transparent)}.scout-settings header{display:grid;gap:2px}.scout-settings header strong{font:650 15px/1.3 var(--font-sans)}.scout-settings header small,.scout-settings label{color:var(--muted);font:12px/1.4 var(--font-sans)}.scout-provider-row{display:grid;grid-template-columns:1fr 1fr;gap:7px}.scout-provider-row button{min-height:40px;border:1px solid var(--line);border-radius:13px;color:var(--ink);background:transparent;cursor:pointer}.scout-provider-row button[aria-pressed=true]{border-color:var(--link);background:color-mix(in srgb,var(--link) 10%,var(--paper))}.scout-settings select{width:100%;min-height:42px;padding:0 10px;border:1px solid var(--line);border-radius:12px;color:var(--ink);background:var(--paper);font:14px var(--font-sans)}.scout-settings-buttons{display:flex;justify-content:flex-end;gap:7px}.scout-cloud-note{margin:0;padding:10px 12px;border-radius:12px;color:var(--muted);background:color-mix(in srgb,#f7b955 16%,var(--paper));font:12px/1.45 var(--font-sans)}@keyframes scout-progress{from{transform:translateX(-120%)}to{transform:translateX(340%)}}@keyframes scout-in{from{opacity:0;transform:translateY(5px) scale(.99)}to{opacity:1;transform:none}}@keyframes scout-point-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}@media(max-width:520px){.scout-card-header{align-items:flex-start;flex-wrap:wrap}.scout-card-actions{margin-left:42px}.scout-provider-row{grid-template-columns:1fr}}@media(prefers-reduced-motion:reduce){.scout-card,.scout-points li,.scout-progress:after{animation:none}}
`;

let snapshot: SmartReaderSummarySnapshot | null = null;
let settingsOpen = false;
let expanded = false;
let draftProvider: "ollama" | "gemini" = "ollama";
let draftModel = "";

function button(label: string, action: string, icon?: string) {
  return `<button type="button" class="scout-button${icon ? " icon" : ""}" data-action="${action}" aria-label="${label}" title="${label}">${icon ?? label}</button>`;
}

function safeError() {
  return "Scout couldn't summarise this article. Check the selected model and try again.";
}

function renderSettings(root: HTMLElement, state: SmartReaderSummarySnapshot) {
  if (!settingsOpen) return;
  const panel = document.createElement("div");
  panel.className = "scout-settings";
  panel.innerHTML = `<header><strong>Summary model</strong><small>Choose where Scout reads this article.</small></header><div class="scout-provider-row"><button type="button" data-provider="ollama">Local Ollama</button><button type="button" data-provider="gemini">Google Gemini</button></div><label>Model<select data-model></select></label><p class="scout-cloud-note" hidden>Article text will be sent to Google for processing. Chromecraft sends only the extracted article and its metadata.</p><div class="scout-settings-buttons">${button("Refresh models", "refresh")}${button("Save", "save")}</div>`;
  root.append(panel);
  for (const providerButton of panel.querySelectorAll<HTMLButtonElement>(
    "[data-provider]",
  )) {
    const provider = providerButton.dataset.provider as "ollama" | "gemini";
    providerButton.setAttribute(
      "aria-pressed",
      String(provider === draftProvider),
    );
    providerButton.addEventListener("click", () => {
      draftProvider = provider;
      draftModel =
        state.providers[provider].selectedModel ??
        state.providers[provider].models[0]?.name ??
        "";
      render();
    });
  }
  const select = panel.querySelector<HTMLSelectElement>("[data-model]")!;
  const models = state.providers[draftProvider].models;
  if (models.length === 0) {
    const option = document.createElement("option");
    option.textContent = "No compatible models found";
    option.value = "";
    select.append(option);
  } else {
    for (const model of models) {
      const option = document.createElement("option");
      option.value = model.name;
      option.textContent = model.displayName?.trim() || model.name;
      option.selected = model.name === draftModel;
      select.append(option);
    }
  }
  select.addEventListener("change", () => {
    draftModel = select.value;
  });
  panel.querySelector<HTMLElement>(".scout-cloud-note")!.hidden =
    draftProvider !== "gemini";
}

function attach(root: HTMLElement) {
  const invoke = async (channel: string, value?: unknown) => {
    try {
      const next = (await ipcRenderer.invoke(channel, value)) as
        | SmartReaderSummarySnapshot
        | undefined;
      if (next) snapshot = next;
    } catch {
      // Provider details and raw IPC errors intentionally stay out of the page.
    }
    render();
  };
  root.querySelectorAll<HTMLElement>("[data-action]").forEach((control) => {
    control.addEventListener("click", async () => {
      const action = control.dataset.action;
      if (action === "settings") {
        settingsOpen = !settingsOpen;
        if (snapshot) {
          draftProvider = snapshot.provider;
          draftModel = snapshot.model ?? "";
        }
        render();
      } else if (action === "generate" || action === "retry") {
        if (!snapshot?.model) {
          settingsOpen = true;
          render();
          return;
        }
        const gemini = snapshot.providers.gemini;
        const cloudConsent =
          snapshot.provider !== "gemini" ||
          gemini.cloudConsentGranted === true ||
          window.confirm(
            "Send this extracted article text to Google Gemini to create a summary?",
          );
        if (!cloudConsent) return;
        await invoke(channels.generateSmartReaderSummary, {
          provider: snapshot.provider,
          model: snapshot.model,
          cloudConsent,
        } satisfies SmartReaderSummaryGenerateRequest);
      } else if (action === "cancel") {
        await invoke(channels.cancelSmartReaderSummary);
      } else if (action === "dismiss") {
        await invoke(channels.dismissSmartReaderSummary);
      } else if (action === "copy") {
        await invoke(channels.copySmartReaderSummary);
      } else if (action === "expand") {
        expanded = !expanded;
        render();
      } else if (action === "refresh") {
        await invoke(channels.refreshSmartReaderSummaryModels, draftProvider);
      } else if (action === "save" && draftModel) {
        await invoke(channels.setSmartReaderSummaryPreference, {
          provider: draftProvider,
          model: draftModel,
        });
        settingsOpen = false;
        render();
      }
    });
  });
}

function render() {
  const root = document.querySelector<HTMLElement>("[data-scout-summary-host]");
  if (!root || !snapshot) return;
  const state = snapshot;
  root.replaceChildren();
  if (state.stage === "idle") {
    root.innerHTML = `<div class="scout-actions"><button type="button" class="scout-button" data-action="generate"><span class="scout-sparkle" aria-hidden="true">✦</span>Summarise with Scout</button>${button("Summary model", "settings", "⚙")}</div>`;
  } else if (state.stage === "loading") {
    root.innerHTML = `<div class="scout-card scout-loading" role="status"><div class="scout-loading-row"><span class="scout-avatar" aria-hidden="true">✦</span><div class="scout-heading"><strong>Scout is reading this article…</strong><small>${state.provider === "gemini" ? "Google Gemini" : "Local Ollama"} · ${state.model ?? "Selected model"}</small></div>${button("Cancel", "cancel")}</div><div class="scout-progress" aria-hidden="true"></div></div>`;
  } else if (state.stage === "error") {
    root.innerHTML = `<div class="scout-card scout-error" role="alert"><div class="scout-heading"><strong>Scout couldn't finish</strong><small>${safeError()}</small></div><div class="scout-actions">${button("Retry", "retry")}${button("Change model", "settings")}</div></div>`;
  } else if (state.result) {
    const attribution = `${state.result.provider === "gemini" ? "Google Gemini" : "Local Ollama"} · ${state.result.model}`;
    root.innerHTML = `<div class="scout-card"><header class="scout-card-header"><span class="scout-avatar" aria-hidden="true">✦</span><span class="scout-heading"><strong>Scout overview</strong><small></small></span><span class="scout-card-actions">${button(expanded ? "Collapse" : "Expand", "expand", expanded ? "⌃" : "⌄")}${button("Copy summary", "copy", "⧉")}${button("Summary model", "settings", "⚙")}${button("Dismiss summary", "dismiss", "×")}</span></header><div class="scout-body"><ul class="scout-points"></ul>${state.result.coverage === "partial" ? '<p class="scout-disclosure">This overview sampled the full length of an unusually long article, so some detail may be omitted.</p>' : ""}<div class="scout-footer">${button("Regenerate", "generate")}</div></div></div>`;
    root.querySelector<HTMLElement>(".scout-heading small")!.textContent =
      attribution;
    const list = root.querySelector<HTMLUListElement>(".scout-points")!;
    const shown = expanded
      ? state.result.points
      : state.result.points.slice(0, 3);
    for (const point of shown) {
      const item = document.createElement("li");
      item.textContent = point;
      list.append(item);
    }
  }
  renderSettings(root, state);
  attach(root);
}

function initialize() {
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);
  ipcRenderer.on(channels.smartReaderSummaryChanged, (_event, value) => {
    snapshot = value as SmartReaderSummarySnapshot;
    render();
  });
  void ipcRenderer
    .invoke(channels.getSmartReaderSummary)
    .then((value) => {
      snapshot = value as SmartReaderSummarySnapshot;
      draftProvider = snapshot.provider;
      draftModel = snapshot.model ?? "";
      render();
    })
    .catch(() => undefined);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
} else {
  initialize();
}
