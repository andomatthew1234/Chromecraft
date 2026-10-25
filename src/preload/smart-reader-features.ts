import { ipcRenderer } from "electron";

import { channels } from "../shared/channels";
import type {
  SmartReaderCommand,
  SmartReaderGeminiSegment,
  SmartReaderGeminiSession,
  SmartReaderNarrationCapabilities,
  SmartReaderToolbarAction,
  SmartReaderToolbarState,
} from "../shared/smart-reader";

const STYLE = `
.reader-progress-track{position:fixed;z-index:80;inset:0 0 auto;height:3px;pointer-events:none;opacity:0;transition:opacity 160ms}.reader-progress-track.visible{opacity:1}.reader-progress-value{width:0;height:100%;background:var(--link);box-shadow:0 1px 6px color-mix(in srgb,var(--link) 45%,transparent);transition:width 100ms linear}.reader-resume{position:fixed;z-index:58;top:88px;left:50%;display:flex;align-items:center;gap:8px;padding:8px 10px 8px 14px;border:1px solid var(--line);border-radius:999px;color:var(--ink);background:var(--paper);box-shadow:0 8px 28px color-mix(in srgb,var(--ink) 14%,transparent);font:600 13px/1 var(--font-sans);transform:translateX(-50%);animation:reader-feature-in 180ms ease}.reader-resume button{min-height:32px;padding:0 12px;border:0;border-radius:999px;color:var(--paper);background:var(--link);font:inherit;cursor:pointer}.reader-resume .dismiss{width:32px;padding:0;color:var(--muted);background:transparent}
.reader-nav{position:fixed;z-index:65;inset:18px auto 18px 18px;width:min(300px,calc(100vw - 36px));display:grid;grid-template-rows:auto minmax(0,1fr);overflow:hidden;border:1px solid var(--line);border-radius:22px;color:var(--ink);background:color-mix(in srgb,var(--paper) 96%,transparent);box-shadow:0 14px 44px color-mix(in srgb,var(--ink) 16%,transparent);font-family:var(--font-sans);transform:translateX(calc(-100% - 28px));opacity:0;transition:transform 220ms cubic-bezier(.2,0,0,1),opacity 180ms;backdrop-filter:blur(18px)}.reader-nav.open{transform:none;opacity:1}.reader-nav header{display:flex;align-items:center;gap:10px;padding:14px;border-bottom:1px solid var(--line)}.reader-nav header strong{flex:1;font-size:14px}.reader-nav button{border:0;color:inherit;background:transparent;cursor:pointer}.reader-nav-close{width:34px;height:34px;border-radius:50%!important}.reader-nav-list{overflow:auto;padding:8px}.reader-nav-list button{width:100%;min-height:38px;display:block;padding:7px 10px;border-radius:11px;color:var(--muted);font:13px/1.35 var(--font-sans);text-align:left}.reader-nav-list button:hover{color:var(--ink);background:color-mix(in srgb,var(--ink) 6%,transparent)}.reader-nav-list button.active{color:var(--link);background:color-mix(in srgb,var(--link) 12%,var(--paper));font-weight:650}.reader-nav-empty{margin:18px;color:var(--muted);font:13px/1.5 var(--font-sans)}
.reader-audio{position:fixed;z-index:68;top:18px;right:18px;width:min(348px,calc(100vw - 36px));display:none;gap:13px;padding:15px;border:1px solid var(--line);border-radius:22px;color:var(--ink);background:color-mix(in srgb,var(--paper) 97%,transparent);box-shadow:0 14px 44px color-mix(in srgb,var(--ink) 16%,transparent);font:13px/1.4 var(--font-sans);backdrop-filter:blur(18px);animation:reader-feature-in 180ms ease}.reader-audio.open{display:grid}.reader-audio header{display:flex;align-items:center;gap:9px}.reader-audio header strong{flex:1;font-size:15px}.reader-audio button,.reader-audio select{min-height:38px;border:0;border-radius:12px;color:inherit;background:color-mix(in srgb,var(--ink) 7%,var(--paper));font:600 13px var(--font-sans);cursor:pointer}.reader-audio button:disabled{opacity:.45;cursor:default}.reader-audio-close{width:36px}.reader-audio-modes{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:3px;border-radius:14px;background:color-mix(in srgb,var(--ink) 5%,var(--paper))}.reader-audio-modes button{min-width:0;min-height:36px;padding:0 5px;background:transparent}.reader-audio-modes button[aria-pressed=true]{color:var(--paper);background:var(--link)}.reader-audio-fields{display:grid;grid-template-columns:1fr 90px;gap:8px}.reader-audio label{display:grid;gap:4px;color:var(--muted);font-size:11px}.reader-audio select{width:100%;min-width:0;padding:0 8px}.reader-audio-controls{display:flex;gap:7px}.reader-audio-controls button{flex:1}.reader-audio-status{margin:0;color:var(--muted)}.reader-audio-progress{height:4px;overflow:hidden;border-radius:999px;background:color-mix(in srgb,var(--ink) 9%,transparent)}.reader-audio-progress>span{display:block;width:0;height:100%;background:var(--link);transition:width 150ms}.reader-audio-cloud{display:grid;gap:8px;padding:10px;border-radius:13px;background:color-mix(in srgb,#f3b53f 14%,var(--paper))}.reader-audio-cloud p{margin:0}.reader-audio-cloud label{display:flex;align-items:flex-start;gap:7px;color:var(--ink);font-size:12px}.reader-audio-local{padding:10px;border-radius:13px;color:var(--muted);background:color-mix(in srgb,var(--ink) 5%,var(--paper))}.reader-audio-local p{margin:0 0 6px}.reader-audio [hidden]{display:none!important}.reader-feature-symbol{font-family:'Material Symbols Rounded','Segoe UI Symbol',sans-serif;font-size:20px}
@keyframes reader-feature-in{from{opacity:0;transform:translateY(-6px) scale(.98)}to{opacity:1;transform:none}}@media(min-width:1120px){body.reader-nav-open .reader{transform:translateX(120px);transition:transform 220ms cubic-bezier(.2,0,0,1)}}@media(max-width:700px){.reader-nav{inset:8px auto 8px 8px;width:min(310px,calc(100vw - 16px))}.reader-audio{top:8px;right:8px;width:calc(100vw - 16px)}}@media(prefers-reduced-motion:reduce){.reader-progress-track,.reader-progress-value,.reader-nav,body.reader-nav-open .reader,.reader-audio,.reader-resume{animation:none;transition:none}}
`;

const TOOLBAR_STYLE = `
.reader-tools{position:sticky;z-index:60;top:12px;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;margin-bottom:clamp(28px,5vh,46px);padding:9px 10px 9px 14px;border:1px solid color-mix(in srgb,var(--line) 76%,transparent);border-radius:24px;color:var(--ink);background:color-mix(in srgb,var(--paper) 74%,transparent);box-shadow:0 10px 32px color-mix(in srgb,var(--ink) 11%,transparent),inset 0 1px 0 color-mix(in srgb,#fff 58%,transparent);font-family:var(--font-sans);backdrop-filter:blur(22px) saturate(145%);-webkit-backdrop-filter:blur(22px) saturate(145%);transition:padding 180ms cubic-bezier(.2,0,0,1),border-radius 180ms cubic-bezier(.2,0,0,1),box-shadow 180ms ease}.reader-tools.is-condensed{padding-block:6px;border-radius:20px;box-shadow:0 7px 24px color-mix(in srgb,var(--ink) 12%,transparent)}.reader-tools-copy{min-width:0;display:grid;gap:1px}.reader-tools-copy strong{font-size:13px;line-height:1.25;letter-spacing:.01em}.reader-tools-copy small{overflow:hidden;color:var(--muted);font-size:11px;line-height:1.3;text-overflow:ellipsis;white-space:nowrap;transition:opacity 150ms ease,max-height 180ms ease}.reader-tools.is-condensed .reader-tools-copy small{max-height:0;opacity:0}.reader-tools-actions{display:flex;align-items:center;gap:4px}.reader-tool-button{width:40px;height:40px;position:relative;display:grid;place-items:center;flex:0 0 auto;padding:0;border:0;border-radius:14px;color:var(--muted);background:transparent;cursor:pointer;transition:color 150ms ease,background 150ms ease,transform 150ms ease}.reader-tool-button:hover{color:var(--ink);background:color-mix(in srgb,var(--link) 10%,var(--paper))}.reader-tool-button:active{transform:scale(.94)}.reader-tool-button[aria-pressed=true]{color:var(--link);background:color-mix(in srgb,var(--link) 15%,var(--paper))}.reader-tool-button:focus-visible,.reader-popover button:focus-visible{outline:3px solid color-mix(in srgb,var(--link) 34%,transparent);outline-offset:2px}.reader-tool-button svg,.reader-popover svg{width:21px;height:21px;display:block;fill:currentColor}.reader-tool-button[data-reader-save].confirmed{animation:reader-save-confirm 360ms cubic-bezier(.2,0,0,1)}.reader-tools-more{display:none}.reader-popover{position:absolute;z-index:72;top:calc(100% + 8px);right:8px;width:min(330px,calc(100vw - 28px));padding:8px;border:1px solid color-mix(in srgb,var(--line) 82%,transparent);border-radius:20px;color:var(--ink);background:color-mix(in srgb,var(--paper) 92%,transparent);box-shadow:0 18px 48px color-mix(in srgb,var(--ink) 18%,transparent);backdrop-filter:blur(24px) saturate(135%);-webkit-backdrop-filter:blur(24px) saturate(135%);animation:reader-popover-in 170ms cubic-bezier(.2,0,0,1)}.reader-popover[hidden]{display:none}.reader-popover header{display:grid;gap:2px;padding:8px 10px 10px}.reader-popover header strong{font-size:14px}.reader-popover header small{color:var(--muted);font-size:11px}.reader-appearance-themes{display:grid;grid-template-columns:repeat(4,1fr);gap:5px}.reader-appearance-themes button,.reader-fonts button,.reader-size button,.reader-more-action{min-height:40px;border:0;border-radius:12px;color:var(--ink);background:color-mix(in srgb,var(--ink) 6%,var(--paper));font:600 12px/1.2 var(--font-sans);cursor:pointer}.reader-appearance-themes button{display:grid;place-items:center;gap:3px;padding:7px 3px}.reader-appearance-themes button span{font-family:var(--font-serif);font-size:17px}.reader-appearance-themes button[aria-pressed=true],.reader-fonts button[aria-pressed=true]{color:var(--paper);background:var(--link)}.reader-appearance-section{display:grid;gap:7px;padding:8px 9px;border-top:1px solid color-mix(in srgb,var(--line) 72%,transparent)}.reader-appearance-section>span{color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}.reader-size,.reader-fonts{display:grid;grid-template-columns:1fr auto 1fr;gap:5px;align-items:center}.reader-fonts{grid-template-columns:1fr 1fr}.reader-size output{min-width:52px;text-align:center;font-size:12px;font-weight:650}.reader-more-list{display:grid;gap:4px}.reader-more-action{width:100%;display:flex;align-items:center;gap:10px;padding:0 12px;text-align:left}.reader-more-action span{flex:1}.reader-more-action[aria-checked=true]{color:var(--link);background:color-mix(in srgb,var(--link) 14%,var(--paper))}.reader-tool-status{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.reader-tools,.reader-popover{background:var(--paper)}}
@keyframes reader-popover-in{from{opacity:0;transform:translateY(-6px) scale(.98)}to{opacity:1;transform:none}}@keyframes reader-save-confirm{40%{transform:scale(1.12)}100%{transform:none}}
@media(max-width:620px){.reader-tools{top:8px;padding-left:11px;border-radius:20px}.reader-tools-copy small{display:none}.reader-tools-actions{gap:2px}.reader-tools-condensable{display:none}.reader-tools-more{display:grid}.reader-resume{top:76px;max-width:calc(100vw - 24px)}}
@media(max-width:390px){.reader-tools-copy strong{font-size:12px}.reader-tool-button{width:37px;height:37px;border-radius:12px}.reader-tools-actions{gap:0}}
@media(prefers-reduced-motion:reduce){.reader-tools,.reader-tools-copy small,.reader-tool-button,.reader-popover{animation:none!important;transition:none!important}}
.reader-tools{display:block;padding:0;border:0;background:transparent;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none}.reader-tools-surface{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;padding:9px 10px 9px 14px;border:1px solid color-mix(in srgb,var(--line) 76%,transparent);border-radius:24px;background:color-mix(in srgb,var(--paper) 74%,transparent);box-shadow:0 10px 32px color-mix(in srgb,var(--ink) 11%,transparent),inset 0 1px 0 color-mix(in srgb,#fff 58%,transparent);backdrop-filter:blur(22px) saturate(145%);-webkit-backdrop-filter:blur(22px) saturate(145%);transition:padding 180ms cubic-bezier(.2,0,0,1),border-radius 180ms cubic-bezier(.2,0,0,1),box-shadow 180ms ease}.reader-tools.is-condensed .reader-tools-surface{padding-block:6px;border-radius:20px;box-shadow:0 7px 24px color-mix(in srgb,var(--ink) 12%,transparent)}.reader-tools-guide{display:grid;gap:2px;padding:10px 16px 0;color:var(--muted);transition:opacity 150ms ease,max-height 180ms ease,padding 180ms ease}.reader-tools-guide strong{color:var(--ink);font-size:12px;line-height:1.3}.reader-tools-guide small{font-size:11px;line-height:1.4}.reader-tools.is-condensed .reader-tools-guide{max-height:0;overflow:hidden;padding-block:0;opacity:0}.reader-popover{max-height:calc(100vh - 90px);overflow:auto}@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.reader-tools-surface{background:var(--paper)}}@media(max-width:620px){.reader-tools{padding-left:0}.reader-tools-surface{padding-left:11px;border-radius:20px}.reader-tools-guide{display:none}}@media(prefers-reduced-motion:reduce){.reader-tools-surface,.reader-tools-guide{animation:none!important;transition:none!important}}
`;

function speechSegments(article: HTMLElement): string[] {
  const blocks = [
    ...article.querySelectorAll<HTMLElement>(
      "h1,h2,h3,h4,p,li,blockquote,figcaption",
    ),
  ]
    .filter((element) => !element.parentElement?.closest("li,blockquote"))
    .map((element) => element.textContent?.replace(/\s+/gu, " ").trim() ?? "")
    .filter(Boolean);
  const result: string[] = [];
  for (const block of blocks) {
    let current = "";
    for (const sentence of block.split(/(?<=[.!?])\s+/u)) {
      if (current && current.length + sentence.length + 1 > 620) {
        result.push(current);
        current = "";
      }
      if (sentence.length > 620) {
        if (current) result.push(current);
        current = "";
        for (let offset = 0; offset < sentence.length; offset += 620) {
          result.push(sentence.slice(offset, offset + 620));
        }
      } else current = current ? `${current} ${sentence}` : sentence;
    }
    if (current) result.push(current);
  }
  return result;
}

const toolIconPaths = {
  appearance: "M4 5h16v2H4V5zm3 4h10v2H7V9zm-3 4h16v2H4v-2zm3 4h10v2H7v-2z",
  save: "M6 3h12a2 2 0 0 1 2 2v16l-8-3.5L4 21V5a2 2 0 0 1 2-2zm0 2v12.95l6-2.63 6 2.63V5H6z",
  saved:
    "M6 3h12a2 2 0 0 1 2 2v16l-8-3.5L4 21V5a2 2 0 0 1 2-2zm4.6 10.8 5.7-5.7-1.4-1.4-4.3 4.3-2.1-2.1-1.4 1.4 3.5 3.5z",
  progress:
    "M12 2a10 10 0 1 1-7.07 2.93L6.34 6.34A8 8 0 1 0 12 4V2zm-1 5h2v6h-2V7zm0 8h2v2h-2v-2z",
  scout:
    "M12 2l1.6 4.4L18 8l-4.4 1.6L12 14l-1.6-4.4L6 8l4.4-1.6L12 2zm6 11 1.1 2.9L22 17l-2.9 1.1L18 21l-1.1-2.9L14 17l2.9-1.1L18 13zM5 13l1.1 2.9L9 17l-2.9 1.1L5 21l-1.1-2.9L1 17l2.9-1.1L5 13z",
  narration:
    "M5 9v6h4l5 4V5L9 9H5zm11.5.1a5 5 0 0 1 0 5.8l-1.4-1.4a3 3 0 0 0 0-3l1.4-1.4zm2.8-2.8a9 9 0 0 1 0 11.4l-1.4-1.4a7 7 0 0 0 0-8.6l1.4-1.4z",
  navigation: "M4 5h16v2H4V5zm0 6h10v2H4v-2zm0 6h16v2H4v-2zm13-7 4 2-4 2v-4z",
  more: "M6 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm6 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm6 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4z",
} as const;

function toolIcon(name: keyof typeof toolIconPaths): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${toolIconPaths[name]}"></path></svg>`;
}

function installToolbar(host: HTMLElement) {
  const toolbar = document.createElement("section");
  toolbar.className = "reader-tools";
  toolbar.setAttribute("aria-label", "Smart Reader tools");
  toolbar.innerHTML = `<div class="reader-tools-copy"><strong>Smart Reader</strong><small>Shape the page, listen, save, or ask Scout.</small></div><div class="reader-tools-actions"><button type="button" class="reader-tool-button" data-reader-appearance aria-label="Reading appearance" aria-haspopup="dialog" aria-expanded="false" title="Reading appearance">${toolIcon("appearance")}</button><button type="button" class="reader-tool-button" data-reader-save aria-label="Save article" aria-pressed="false" title="Save article">${toolIcon("save")}</button><button type="button" class="reader-tool-button reader-tools-condensable" data-reader-progress aria-label="Show reading progress" aria-pressed="false" title="Reading progress">${toolIcon("progress")}</button><button type="button" class="reader-tool-button" data-reader-scout aria-label="Ask Scout about this article" title="Ask Scout about this article">${toolIcon("scout")}</button><button type="button" class="reader-tool-button reader-tools-condensable" data-reader-narration aria-label="Read aloud" aria-pressed="false" title="Read aloud">${toolIcon("narration")}</button><button type="button" class="reader-tool-button reader-tools-condensable" data-reader-navigation aria-label="Article navigation" aria-pressed="false" title="Article navigation">${toolIcon("navigation")}</button><button type="button" class="reader-tool-button reader-tools-more" data-reader-more aria-label="More Reader tools" aria-haspopup="menu" aria-expanded="false" title="More Reader tools">${toolIcon("more")}</button></div><section class="reader-popover reader-appearance-popover" data-reader-appearance-popover role="dialog" aria-label="Reading appearance" hidden><header><strong>Reading appearance</strong><small>Changes are remembered for every article.</small></header><div class="reader-appearance-section"><span>Paper</span><div class="reader-appearance-themes"><button type="button" data-theme="system"><span>Aa</span>System</button><button type="button" data-theme="light"><span>Aa</span>Light</button><button type="button" data-theme="warm"><span>Aa</span>Warm</button><button type="button" data-theme="dark"><span>Aa</span>Dark</button></div></div><div class="reader-appearance-section"><span>Text size</span><div class="reader-size"><button type="button" data-size="decrease" aria-label="Decrease text size">A−</button><output data-reader-scale>100%</output><button type="button" data-size="increase" aria-label="Increase text size">A+</button></div></div><div class="reader-appearance-section"><span>Typeface</span><div class="reader-fonts"><button type="button" data-font="serif">Serif</button><button type="button" data-font="sans">Sans</button></div></div></section><section class="reader-popover reader-more-popover" data-reader-more-popover role="menu" aria-label="More Reader tools" hidden><header><strong>More Reader tools</strong><small>Article controls</small></header><div class="reader-more-list"><button type="button" class="reader-more-action" data-more-action="progress" role="menuitemcheckbox" aria-checked="false">${toolIcon("progress")}<span>Reading progress</span></button><button type="button" class="reader-more-action" data-more-action="narration" role="menuitemcheckbox" aria-checked="false">${toolIcon("narration")}<span>Read aloud</span></button><button type="button" class="reader-more-action" data-more-action="navigation" role="menuitemcheckbox" aria-checked="false">${toolIcon("navigation")}<span>Article navigation</span></button></div></section><p class="reader-tool-status" data-reader-tool-status role="status" aria-live="polite"></p>`;
  const statusNode = toolbar.querySelector<HTMLElement>(
    "[data-reader-tool-status]",
  )!;
  const surface = document.createElement("div");
  surface.className = "reader-tools-surface";
  for (const child of [...toolbar.children]) {
    if (child !== statusNode) surface.append(child);
  }
  const copy = surface.querySelector<HTMLElement>(".reader-tools-copy");
  if (copy) copy.innerHTML = "<strong>Smart Reader</strong>";
  const guide = document.createElement("div");
  guide.className = "reader-tools-guide";
  guide.innerHTML =
    "<strong>Reader tools</strong><small>Adjust the reading view, save articles, listen aloud, or ask Scout about this story.</small>";
  toolbar.prepend(surface);
  surface.after(guide);
  host.replaceChildren(toolbar);

  const appearancePopover = toolbar.querySelector<HTMLElement>(
    "[data-reader-appearance-popover]",
  )!;
  const morePopover = toolbar.querySelector<HTMLElement>(
    "[data-reader-more-popover]",
  )!;
  const appearanceButton = toolbar.querySelector<HTMLButtonElement>(
    "[data-reader-appearance]",
  )!;
  const moreButton =
    toolbar.querySelector<HTMLButtonElement>("[data-reader-more]")!;
  const status = toolbar.querySelector<HTMLElement>(
    "[data-reader-tool-status]",
  )!;
  let state: SmartReaderToolbarState | null = null;
  let running = false;

  const setPopover = (next: "appearance" | "more" | null) => {
    const previous = !appearancePopover.hidden
      ? "appearance"
      : !morePopover.hidden
        ? "more"
        : null;
    appearancePopover.hidden = next !== "appearance";
    morePopover.hidden = next !== "more";
    appearanceButton.setAttribute(
      "aria-expanded",
      String(next === "appearance"),
    );
    moreButton.setAttribute("aria-expanded", String(next === "more"));
    if (next) {
      const panel = next === "appearance" ? appearancePopover : morePopover;
      requestAnimationFrame(() =>
        panel.querySelector<HTMLButtonElement>("button")?.focus(),
      );
    } else if (
      previous &&
      document.activeElement instanceof Node &&
      (appearancePopover.contains(document.activeElement) ||
        morePopover.contains(document.activeElement))
    ) {
      (previous === "appearance" ? appearanceButton : moreButton).focus();
    }
  };
  const render = () => {
    if (!state) return;
    const save =
      toolbar.querySelector<HTMLButtonElement>("[data-reader-save]")!;
    save.setAttribute("aria-pressed", String(state.saved));
    save.setAttribute(
      "aria-label",
      state.saved ? "Remove from saved articles" : "Save article",
    );
    save.title = state.saved ? "Saved for later" : "Save article";
    save.innerHTML = toolIcon(state.saved ? "saved" : "save");
    const states = {
      progress: state.progressVisible,
      narration: state.narrationOpen,
      navigation: state.navigationOpen,
    };
    for (const [name, pressed] of Object.entries(states)) {
      toolbar
        .querySelectorAll<HTMLElement>(
          `[data-reader-${name}],[data-more-action=${name}]`,
        )
        .forEach((button) => {
          if (button.hasAttribute("data-more-action")) {
            button.setAttribute("aria-checked", String(pressed));
          } else {
            button.setAttribute("aria-pressed", String(pressed));
          }
        });
    }
    toolbar
      .querySelectorAll<HTMLButtonElement>("[data-theme]")
      .forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.theme === state?.appearance.theme),
        ),
      );
    toolbar
      .querySelectorAll<HTMLButtonElement>("[data-font]")
      .forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.font === state?.appearance.font),
        ),
      );
    toolbar.querySelector<HTMLOutputElement>("[data-reader-scale]")!.value =
      `${Math.round(state.appearance.textScale * 100)}%`;
  };
  const run = async (action: SmartReaderToolbarAction, message?: string) => {
    if (running) return;
    running = true;
    try {
      state = (await ipcRenderer.invoke(
        channels.runSmartReaderToolbarAction,
        action,
      )) as SmartReaderToolbarState;
      render();
      if (message) status.textContent = message;
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : "That Reader action failed.";
    } finally {
      running = false;
    }
  };
  appearanceButton.addEventListener("click", () =>
    setPopover(appearancePopover.hidden ? "appearance" : null),
  );
  moreButton.addEventListener("click", () =>
    setPopover(morePopover.hidden ? "more" : null),
  );
  toolbar
    .querySelector<HTMLButtonElement>("[data-reader-save]")!
    .addEventListener("click", async (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      await run(
        { type: "toggle-saved" },
        state?.saved ? "Removed from saved articles." : "Saved for later.",
      );
      button.classList.remove("confirmed");
      requestAnimationFrame(() => button.classList.add("confirmed"));
    });
  toolbar
    .querySelector<HTMLButtonElement>("[data-reader-progress]")!
    .addEventListener(
      "click",
      () =>
        void run({
          type: "set-progress-visible",
          visible: !(state?.progressVisible ?? false),
        }),
    );
  toolbar
    .querySelector<HTMLButtonElement>("[data-reader-scout]")!
    .addEventListener(
      "click",
      () => void run({ type: "ask-scout" }, "Opening Scout with this article."),
    );
  toolbar
    .querySelector<HTMLButtonElement>("[data-reader-narration]")!
    .addEventListener("click", () => void run({ type: "toggle-narration" }));
  toolbar
    .querySelector<HTMLButtonElement>("[data-reader-navigation]")!
    .addEventListener("click", () => void run({ type: "toggle-navigation" }));
  toolbar
    .querySelectorAll<HTMLButtonElement>("[data-theme]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        if (!state) return;
        void run({
          type: "set-appearance",
          appearance: {
            ...state.appearance,
            theme: button.dataset
              .theme as SmartReaderToolbarState["appearance"]["theme"],
          },
        });
      }),
    );
  toolbar.querySelectorAll<HTMLButtonElement>("[data-font]").forEach((button) =>
    button.addEventListener("click", () => {
      if (!state) return;
      void run({
        type: "set-appearance",
        appearance: {
          ...state.appearance,
          font: button.dataset
            .font as SmartReaderToolbarState["appearance"]["font"],
        },
      });
    }),
  );
  toolbar.querySelectorAll<HTMLButtonElement>("[data-size]").forEach((button) =>
    button.addEventListener("click", () => {
      if (!state) return;
      const delta = button.dataset.size === "increase" ? 0.05 : -0.05;
      void run({
        type: "set-appearance",
        appearance: {
          ...state.appearance,
          textScale: Math.min(
            1.35,
            Math.max(0.8, state.appearance.textScale + delta),
          ),
        },
      });
    }),
  );
  toolbar
    .querySelectorAll<HTMLButtonElement>("[data-more-action]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        setPopover(null);
        const action = button.dataset.moreAction;
        if (action === "progress") {
          void run({
            type: "set-progress-visible",
            visible: !(state?.progressVisible ?? false),
          });
        } else if (action === "narration") {
          void run({ type: "toggle-narration" });
        } else if (action === "navigation") {
          void run({ type: "toggle-navigation" });
        }
      }),
    );
  document.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Node && toolbar.contains(event.target)) return;
    setPopover(null);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setPopover(null);
  });
  document.addEventListener("reader-panel-state", (event) => {
    if (!state || !(event instanceof CustomEvent)) return;
    const detail = event.detail as { kind?: string; open?: boolean };
    if (detail.kind === "navigation")
      state.navigationOpen = detail.open === true;
    if (detail.kind === "narration") state.narrationOpen = detail.open === true;
    render();
  });
  let frame = 0;
  addEventListener(
    "scroll",
    () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        toolbar.classList.toggle("is-condensed", scrollY > 72);
      });
    },
    { passive: true },
  );
  void ipcRenderer
    .invoke(channels.getSmartReaderToolbar)
    .then((value) => {
      state = value as SmartReaderToolbarState;
      render();
    })
    .catch((error: unknown) => {
      status.textContent =
        error instanceof Error
          ? error.message
          : "Reader tools are unavailable.";
    });
}

function installProgress(article: HTMLElement) {
  const track = document.createElement("div");
  track.className = "reader-progress-track";
  track.innerHTML = '<div class="reader-progress-value"></div>';
  document.body.append(track);
  const value = track.firstElementChild as HTMLElement;
  let frame = 0;
  let lastSent = 0;
  const update = () => {
    frame = 0;
    const maximum = Math.max(
      0,
      document.documentElement.scrollHeight - innerHeight,
    );
    const ratio =
      maximum <= 0 ? 1 : Math.min(1, Math.max(0, scrollY / maximum));
    value.style.width = `${ratio * 100}%`;
    if (Date.now() - lastSent >= 1_000) {
      lastSent = Date.now();
      ipcRenderer.send(channels.smartReaderProgressChanged, ratio);
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  addEventListener("scroll", schedule, { passive: true });
  addEventListener("resize", schedule, { passive: true });
  new ResizeObserver(schedule).observe(article);
  article
    .querySelectorAll("img")
    .forEach((image) =>
      image.addEventListener("load", schedule, { once: true }),
    );
  schedule();
  return {
    setVisible(visible: boolean, resumeProgress: number | null) {
      track.classList.toggle("visible", visible);
      schedule();
      document.querySelector(".reader-resume")?.remove();
      if (resumeProgress === null) return;
      const resume = document.createElement("div");
      resume.className = "reader-resume";
      resume.innerHTML = `<span>Continue from ${Math.round(resumeProgress * 100)}%?</span><button type="button" data-resume>Continue</button><button type="button" class="dismiss" aria-label="Dismiss">×</button>`;
      resume.querySelector("[data-resume]")?.addEventListener("click", () => {
        scrollTo({
          top:
            resumeProgress *
            Math.max(0, document.documentElement.scrollHeight - innerHeight),
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        });
        resume.remove();
      });
      resume
        .querySelector(".dismiss")
        ?.addEventListener("click", () => resume.remove());
      document.body.append(resume);
    },
    schedule,
  };
}

function installNavigation(
  article: HTMLElement,
  progress: { schedule(): void },
) {
  const nav = document.createElement("aside");
  nav.className = "reader-nav";
  nav.setAttribute("aria-label", "Article navigation");
  nav.innerHTML =
    '<header><strong>In this article</strong><button type="button" class="reader-nav-close" aria-label="Close article navigation">×</button></header><div class="reader-nav-list"></div>';
  document.body.append(nav);
  const list = nav.querySelector<HTMLElement>(".reader-nav-list")!;
  const headings = [
    ...article.querySelectorAll<HTMLHeadingElement>(
      "h1[id],h2[id],h3[id],h4[id]",
    ),
  ];
  const buttons = new Map<Element, HTMLButtonElement>();
  const close = (notify = true) => {
    const wasOpen = nav.classList.contains("open");
    nav.classList.remove("open");
    document.body.classList.remove("reader-nav-open");
    document.dispatchEvent(
      new CustomEvent("reader-panel-state", {
        detail: { kind: "navigation", open: false },
      }),
    );
    if (notify && wasOpen) {
      ipcRenderer.send(channels.smartReaderPanelClosed, "navigation");
    }
  };
  if (!headings.length) {
    list.innerHTML =
      '<p class="reader-nav-empty">No sections available for this article.</p>';
  }
  for (const heading of headings) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = heading.textContent?.trim() || "Untitled section";
    button.style.paddingLeft = `${10 + Math.max(0, Number(heading.tagName.slice(1)) - 1) * 13}px`;
    button.addEventListener("click", () => {
      heading.scrollIntoView({
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "start",
      });
      if (innerWidth < 700) close();
      progress.schedule();
    });
    buttons.set(heading, button);
    list.append(button);
  }
  const observer = new IntersectionObserver(
    (entries) => {
      const current = entries
        .filter((entry) => entry.isIntersecting)
        .sort(
          (left, right) =>
            left.boundingClientRect.top - right.boundingClientRect.top,
        )[0];
      if (!current) return;
      buttons.forEach((button) => button.classList.remove("active"));
      buttons.get(current.target)?.classList.add("active");
    },
    { rootMargin: "-12% 0px -72%", threshold: [0, 1] },
  );
  headings.forEach((heading) => observer.observe(heading));
  nav
    .querySelector(".reader-nav-close")
    ?.addEventListener("click", () => close());
  return {
    toggle() {
      const open = !nav.classList.contains("open");
      nav.classList.toggle("open", open);
      document.body.classList.toggle("reader-nav-open", open);
      document.dispatchEvent(
        new CustomEvent("reader-panel-state", {
          detail: { kind: "navigation", open },
        }),
      );
    },
    close,
  };
}

function installNarration(article: HTMLElement) {
  const panel = document.createElement("section");
  panel.className = "reader-audio";
  panel.setAttribute("aria-label", "Read aloud");
  panel.innerHTML = `<header><strong>Read aloud</strong><button type="button" class="reader-audio-close" aria-label="Close Read aloud">×</button></header><div class="reader-audio-modes" role="tablist"><button type="button" data-mode="standard" aria-pressed="true">Standard</button><button type="button" data-mode="gemini" aria-pressed="false">Gemini</button><button type="button" data-mode="local" aria-pressed="false">Local AI</button></div><div class="reader-audio-fields"><label>Voice<select data-voice></select></label><label>Speed<select data-rate><option value="0.8">0.8×</option><option value="1" selected>1×</option><option value="1.2">1.2×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label></div><div class="reader-audio-cloud" hidden><p>Article text is sent to Google Gemini. Generation may use paid API quota. Audio stays in memory only for this Reader session.</p><label><input type="checkbox" data-cloud-consent> I understand and want to generate this voiceover.</label><button type="button" data-generate>Generate voiceover</button></div><div class="reader-audio-local" hidden></div><div class="reader-audio-controls"><button type="button" data-play>Play</button><button type="button" data-pause disabled>Pause</button><button type="button" data-stop disabled>Stop</button></div><div class="reader-audio-progress"><span></span></div><p class="reader-audio-status" role="status">Ready to read this article.</p>`;
  document.body.append(panel);
  const voice = panel.querySelector<HTMLSelectElement>("[data-voice]")!;
  const rate = panel.querySelector<HTMLSelectElement>("[data-rate]")!;
  const status = panel.querySelector<HTMLElement>(".reader-audio-status")!;
  const bar = panel.querySelector<HTMLElement>(".reader-audio-progress span")!;
  const play = panel.querySelector<HTMLButtonElement>("[data-play]")!;
  const pause = panel.querySelector<HTMLButtonElement>("[data-pause]")!;
  const stop = panel.querySelector<HTMLButtonElement>("[data-stop]")!;
  const cloud = panel.querySelector<HTMLElement>(".reader-audio-cloud")!;
  const local = panel.querySelector<HTMLElement>(".reader-audio-local")!;
  const segments = speechSegments(article);
  let mode: "standard" | "gemini" | "local" = "standard";
  let systemIndex = 0;
  let systemPaused = false;
  let systemRun = 0;
  let disposed = false;
  let capabilities: SmartReaderNarrationCapabilities | null = null;
  let gemini: SmartReaderGeminiSession | null = null;
  let geminiIndex = 0;
  let audio: HTMLAudioElement | null = null;
  let audioUrl: string | null = null;

  const setProgress = (ratio: number) => {
    bar.style.width = `${Math.min(1, Math.max(0, ratio)) * 100}%`;
  };
  const populateSystemVoices = () => {
    const installed = speechSynthesis.getVoices();
    voice.replaceChildren();
    installed.forEach((entry, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `${entry.name} (${entry.lang})`;
      voice.append(option);
    });
    if (!installed.length) {
      const option = document.createElement("option");
      option.textContent = "No system voices available";
      voice.append(option);
      play.disabled = true;
      status.textContent = "System speech is unavailable on this device.";
    } else play.disabled = false;
  };
  populateSystemVoices();
  speechSynthesis.addEventListener("voiceschanged", populateSystemVoices);
  const stopSystem = () => {
    systemRun += 1;
    speechSynthesis.cancel();
    systemIndex = 0;
    systemPaused = false;
    pause.textContent = "Pause";
  };
  const speakNext = (run: number) => {
    if (run !== systemRun) return;
    if (disposed || systemIndex >= segments.length) {
      status.textContent = "Finished reading.";
      play.textContent = "Play again";
      pause.disabled = true;
      stop.disabled = true;
      setProgress(1);
      systemIndex = 0;
      return;
    }
    const utterance = new SpeechSynthesisUtterance(segments[systemIndex]);
    const installed = speechSynthesis.getVoices();
    utterance.voice = installed[Number(voice.value)] ?? null;
    utterance.lang = utterance.voice?.lang ?? document.documentElement.lang;
    utterance.rate = Number(rate.value);
    utterance.onboundary = (event) =>
      run === systemRun &&
      setProgress(
        (systemIndex +
          event.charIndex / Math.max(1, segments[systemIndex].length)) /
          Math.max(1, segments.length),
      );
    utterance.onend = () => {
      if (run !== systemRun) return;
      systemIndex += 1;
      setProgress(systemIndex / Math.max(1, segments.length));
      speakNext(run);
    };
    utterance.onerror = () => {
      status.textContent =
        "System speech stopped unexpectedly. Try another installed voice.";
      pause.disabled = true;
    };
    status.textContent = `Reading part ${systemIndex + 1} of ${segments.length}.`;
    play.textContent = "Restart";
    pause.disabled = false;
    stop.disabled = false;
    speechSynthesis.speak(utterance);
  };
  const clearAudio = () => {
    audio?.pause();
    audio = null;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = null;
  };
  const stopGemini = async () => {
    clearAudio();
    if (gemini) {
      await ipcRenderer
        .invoke(channels.cancelSmartReaderGeminiNarration, gemini.id)
        .catch(() => undefined);
    }
    gemini = null;
    geminiIndex = 0;
  };
  const playGeminiPart = async () => {
    if (!gemini) return;
    status.textContent = `Generating part ${geminiIndex + 1} of ${gemini.segmentCount}…`;
    play.disabled = true;
    try {
      const segment = (await ipcRenderer.invoke(
        channels.getSmartReaderGeminiSegment,
        gemini.id,
        geminiIndex,
      )) as SmartReaderGeminiSegment;
      const bytes = Uint8Array.from(atob(segment.audioBase64), (character) =>
        character.charCodeAt(0),
      );
      clearAudio();
      audioUrl = URL.createObjectURL(
        new Blob([bytes], { type: segment.mimeType }),
      );
      audio = new Audio(audioUrl);
      audio.playbackRate = Number(rate.value);
      audio.ontimeupdate = () => {
        if (!audio || !Number.isFinite(audio.duration)) return;
        setProgress(
          (geminiIndex + audio.currentTime / Math.max(0.1, audio.duration)) /
            segment.segmentCount,
        );
      };
      audio.onended = () => {
        geminiIndex += 1;
        setProgress(geminiIndex / segment.segmentCount);
        if (geminiIndex < segment.segmentCount) void playGeminiPart();
        else {
          status.textContent =
            "Gemini voiceover finished. Generated audio was cleared from memory.";
          play.disabled = false;
          void stopGemini();
        }
      };
      if (document.visibilityState === "hidden") {
        status.textContent = `Part ${geminiIndex + 1} is ready. Return to this tab and press Resume.`;
        pause.textContent = "Resume";
      } else {
        await audio.play();
        status.textContent = `Playing part ${geminiIndex + 1} of ${segment.segmentCount}.`;
      }
      pause.disabled = false;
      stop.disabled = false;
    } catch (error) {
      status.textContent =
        error instanceof Error
          ? error.message
          : "Gemini voice generation failed.";
      play.disabled = false;
    }
  };
  const showMode = async (next: typeof mode) => {
    if (next !== mode) {
      stopSystem();
      await stopGemini();
      setProgress(0);
    }
    mode = next;
    panel
      .querySelectorAll<HTMLButtonElement>("[data-mode]")
      .forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.mode === mode),
        ),
      );
    cloud.hidden = mode !== "gemini";
    local.hidden = mode !== "local";
    rate.closest("label")!.hidden = mode === "local";
    voice.closest("label")!.hidden = mode === "local";
    play.hidden = mode !== "standard";
    if (mode === "standard") {
      populateSystemVoices();
      status.textContent =
        "Uses installed system voices. Article text stays on this device.";
      play.textContent = "Play";
      return;
    }
    capabilities ??= (await ipcRenderer.invoke(
      channels.getSmartReaderNarrationCapabilities,
    )) as SmartReaderNarrationCapabilities;
    if (mode === "gemini") {
      voice.replaceChildren(
        ...capabilities.gemini.voices.map((name) => {
          const option = document.createElement("option");
          option.value = name;
          option.textContent = name;
          return option;
        }),
      );
      status.textContent = capabilities.gemini.available
        ? `Ready to generate with ${capabilities.gemini.model}.`
        : capabilities.gemini.reason || "Gemini voiceover unavailable.";
      panel.querySelector<HTMLButtonElement>("[data-generate]")!.disabled =
        !capabilities.gemini.available;
    } else {
      local.innerHTML = `<p>${capabilities.local.reason}</p><small>${capabilities.local.setupHint}</small>`;
      status.textContent = "Local AI voiceover is unavailable in this build.";
    }
  };
  panel
    .querySelectorAll<HTMLButtonElement>("[data-mode]")
    .forEach((button) =>
      button.addEventListener(
        "click",
        () => void showMode(button.dataset.mode as typeof mode),
      ),
    );
  const closePanel = (notify = true) => {
    const wasOpen = panel.classList.contains("open");
    panel.classList.remove("open");
    document.dispatchEvent(
      new CustomEvent("reader-panel-state", {
        detail: { kind: "narration", open: false },
      }),
    );
    if (notify && wasOpen) {
      ipcRenderer.send(channels.smartReaderPanelClosed, "narration");
    }
  };
  panel
    .querySelector(".reader-audio-close")
    ?.addEventListener("click", () => closePanel());
  panel
    .querySelector<HTMLButtonElement>("[data-generate]")!
    .addEventListener("click", async () => {
      if (
        !panel.querySelector<HTMLInputElement>("[data-cloud-consent]")!.checked
      ) {
        status.textContent =
          "Confirm the Gemini privacy and cost notice first.";
        return;
      }
      try {
        gemini = (await ipcRenderer.invoke(
          channels.startSmartReaderGeminiNarration,
          { voice: voice.value, cloudConsent: true },
        )) as SmartReaderGeminiSession;
        geminiIndex = 0;
        await playGeminiPart();
      } catch (error) {
        status.textContent =
          error instanceof Error
            ? error.message
            : "Gemini voice generation failed.";
      }
    });
  play.addEventListener("click", () => {
    if (mode !== "standard") return;
    stopSystem();
    const run = systemRun;
    setProgress(0);
    speakNext(run);
  });
  pause.addEventListener("click", () => {
    if (mode === "standard") {
      if (systemPaused) {
        speechSynthesis.resume();
        systemPaused = false;
        pause.textContent = "Pause";
        status.textContent = `Reading part ${systemIndex + 1} of ${segments.length}.`;
      } else {
        speechSynthesis.pause();
        systemPaused = true;
        pause.textContent = "Resume";
        status.textContent = "Paused.";
      }
    } else if (audio) {
      if (audio.paused) {
        void audio.play();
        pause.textContent = "Pause";
      } else {
        audio.pause();
        pause.textContent = "Resume";
      }
    }
  });
  stop.addEventListener("click", () => {
    stopSystem();
    void stopGemini();
    setProgress(0);
    status.textContent = "Narration stopped.";
    play.disabled = false;
    pause.disabled = true;
    stop.disabled = true;
  });
  return {
    toggle() {
      const open = panel.classList.toggle("open");
      document.dispatchEvent(
        new CustomEvent("reader-panel-state", {
          detail: { kind: "narration", open },
        }),
      );
    },
    pause() {
      if (speechSynthesis.speaking && !speechSynthesis.paused) {
        speechSynthesis.pause();
        systemPaused = true;
        pause.textContent = "Resume";
        status.textContent = "Paused when the tab was hidden.";
      }
      audio?.pause();
    },
    stop() {
      stopSystem();
      void stopGemini();
      closePanel(false);
    },
    dispose() {
      disposed = true;
      stopSystem();
      void stopGemini();
      speechSynthesis.removeEventListener(
        "voiceschanged",
        populateSystemVoices,
      );
    },
    close() {
      closePanel();
    },
  };
}

export function initializeSmartReaderFeatures(): void {
  const article = document.querySelector<HTMLElement>(
    "[data-smart-reader-article]",
  );
  if (!article) return;
  const style = document.createElement("style");
  style.textContent = `${STYLE}${TOOLBAR_STYLE}`;
  document.head.append(style);
  const progress = installProgress(article);
  const navigation = installNavigation(article, progress);
  const narration = installNarration(article);
  const toolbarHost = document.querySelector<HTMLElement>(
    "[data-reader-tools-host]",
  );
  if (toolbarHost) installToolbar(toolbarHost);
  ipcRenderer.on(channels.smartReaderCommand, (_event, value) => {
    const command = value as SmartReaderCommand;
    if (command.type === "set-progress-visible") {
      progress.setVisible(command.visible, command.resumeProgress);
    } else if (command.type === "toggle-navigation") navigation.toggle();
    else if (command.type === "toggle-narration") narration.toggle();
    else if (command.type === "pause-narration") narration.pause();
    else if (command.type === "stop-narration") narration.stop();
  });
  addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    navigation.close();
    narration.close();
  });
  addEventListener("pagehide", () => narration.dispose(), { once: true });
}
