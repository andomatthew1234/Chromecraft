import { ipcRenderer } from "electron";

import { channels } from "../shared/channels";
import type {
  SmartReaderCommand,
  SmartReaderGeminiSegment,
  SmartReaderGeminiSession,
  SmartReaderNarrationCapabilities,
} from "../shared/smart-reader";

const STYLE = `
.reader-progress-track{position:fixed;z-index:80;inset:0 0 auto;height:3px;pointer-events:none;opacity:0;transition:opacity 160ms}.reader-progress-track.visible{opacity:1}.reader-progress-value{width:0;height:100%;background:var(--link);box-shadow:0 1px 6px color-mix(in srgb,var(--link) 45%,transparent);transition:width 100ms linear}.reader-resume{position:fixed;z-index:70;top:18px;left:50%;display:flex;align-items:center;gap:8px;padding:8px 10px 8px 14px;border:1px solid var(--line);border-radius:999px;color:var(--ink);background:var(--paper);box-shadow:0 8px 28px color-mix(in srgb,var(--ink) 14%,transparent);font:600 13px/1 var(--font-sans);transform:translateX(-50%);animation:reader-feature-in 180ms ease}.reader-resume button{min-height:32px;padding:0 12px;border:0;border-radius:999px;color:var(--paper);background:var(--link);font:inherit;cursor:pointer}.reader-resume .dismiss{width:32px;padding:0;color:var(--muted);background:transparent}
.reader-nav{position:fixed;z-index:65;inset:18px auto 18px 18px;width:min(300px,calc(100vw - 36px));display:grid;grid-template-rows:auto minmax(0,1fr);overflow:hidden;border:1px solid var(--line);border-radius:22px;color:var(--ink);background:color-mix(in srgb,var(--paper) 96%,transparent);box-shadow:0 14px 44px color-mix(in srgb,var(--ink) 16%,transparent);font-family:var(--font-sans);transform:translateX(calc(-100% - 28px));opacity:0;transition:transform 220ms cubic-bezier(.2,0,0,1),opacity 180ms;backdrop-filter:blur(18px)}.reader-nav.open{transform:none;opacity:1}.reader-nav header{display:flex;align-items:center;gap:10px;padding:14px;border-bottom:1px solid var(--line)}.reader-nav header strong{flex:1;font-size:14px}.reader-nav button{border:0;color:inherit;background:transparent;cursor:pointer}.reader-nav-close{width:34px;height:34px;border-radius:50%!important}.reader-nav-list{overflow:auto;padding:8px}.reader-nav-list button{width:100%;min-height:38px;display:block;padding:7px 10px;border-radius:11px;color:var(--muted);font:13px/1.35 var(--font-sans);text-align:left}.reader-nav-list button:hover{color:var(--ink);background:color-mix(in srgb,var(--ink) 6%,transparent)}.reader-nav-list button.active{color:var(--link);background:color-mix(in srgb,var(--link) 12%,var(--paper));font-weight:650}.reader-nav-empty{margin:18px;color:var(--muted);font:13px/1.5 var(--font-sans)}
.reader-audio{position:fixed;z-index:68;top:18px;right:18px;width:min(348px,calc(100vw - 36px));display:none;gap:13px;padding:15px;border:1px solid var(--line);border-radius:22px;color:var(--ink);background:color-mix(in srgb,var(--paper) 97%,transparent);box-shadow:0 14px 44px color-mix(in srgb,var(--ink) 16%,transparent);font:13px/1.4 var(--font-sans);backdrop-filter:blur(18px);animation:reader-feature-in 180ms ease}.reader-audio.open{display:grid}.reader-audio header{display:flex;align-items:center;gap:9px}.reader-audio header strong{flex:1;font-size:15px}.reader-audio button,.reader-audio select{min-height:38px;border:0;border-radius:12px;color:inherit;background:color-mix(in srgb,var(--ink) 7%,var(--paper));font:600 13px var(--font-sans);cursor:pointer}.reader-audio button:disabled{opacity:.45;cursor:default}.reader-audio-close{width:36px}.reader-audio-modes{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:3px;border-radius:14px;background:color-mix(in srgb,var(--ink) 5%,var(--paper))}.reader-audio-modes button{min-width:0;min-height:36px;padding:0 5px;background:transparent}.reader-audio-modes button[aria-pressed=true]{color:var(--paper);background:var(--link)}.reader-audio-fields{display:grid;grid-template-columns:1fr 90px;gap:8px}.reader-audio label{display:grid;gap:4px;color:var(--muted);font-size:11px}.reader-audio select{width:100%;min-width:0;padding:0 8px}.reader-audio-controls{display:flex;gap:7px}.reader-audio-controls button{flex:1}.reader-audio-status{margin:0;color:var(--muted)}.reader-audio-progress{height:4px;overflow:hidden;border-radius:999px;background:color-mix(in srgb,var(--ink) 9%,transparent)}.reader-audio-progress>span{display:block;width:0;height:100%;background:var(--link);transition:width 150ms}.reader-audio-cloud{display:grid;gap:8px;padding:10px;border-radius:13px;background:color-mix(in srgb,#f3b53f 14%,var(--paper))}.reader-audio-cloud p{margin:0}.reader-audio-cloud label{display:flex;align-items:flex-start;gap:7px;color:var(--ink);font-size:12px}.reader-audio-local{padding:10px;border-radius:13px;color:var(--muted);background:color-mix(in srgb,var(--ink) 5%,var(--paper))}.reader-audio-local p{margin:0 0 6px}.reader-audio [hidden]{display:none!important}.reader-feature-symbol{font-family:'Material Symbols Rounded','Segoe UI Symbol',sans-serif;font-size:20px}
@keyframes reader-feature-in{from{opacity:0;transform:translateY(-6px) scale(.98)}to{opacity:1;transform:none}}@media(min-width:1120px){body.reader-nav-open .reader{transform:translateX(120px);transition:transform 220ms cubic-bezier(.2,0,0,1)}}@media(max-width:700px){.reader-nav{inset:8px auto 8px 8px;width:min(310px,calc(100vw - 16px))}.reader-audio{top:8px;right:8px;width:calc(100vw - 16px)}}@media(prefers-reduced-motion:reduce){.reader-progress-track,.reader-progress-value,.reader-nav,body.reader-nav-open .reader,.reader-audio,.reader-resume{animation:none;transition:none}}
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
      panel.classList.toggle("open");
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
  style.textContent = STYLE;
  document.head.append(style);
  const progress = installProgress(article);
  const navigation = installNavigation(article, progress);
  const narration = installNarration(article);
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
