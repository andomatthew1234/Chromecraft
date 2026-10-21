import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { UblockSnapshot } from "../shared/browser";
import type { UblockService } from "./ublock-service";
import type { TabManager } from "./tab-manager";
import type { DownloadManager } from "./download-manager";

interface SmokeOptions {
  reportPath: string;
  screenshotPath: string;
  shellScreenshotPath: string;
  fixtureUrl: string;
  liveUrl?: string;
  startedAt: number;
}

interface SmokeReport {
  success: boolean;
  platform: NodeJS.Platform;
  arch: string;
  shellReadyMs: number;
  fixtureNavigationMs: number | null;
  liveNavigationMs: number | null;
  fixtureLoaded: boolean;
  livePageLoaded: boolean;
  adScriptLoaded: boolean | null;
  ublockDashboardLoaded: boolean;
  shortcutsWorked: boolean;
  tabLoadingIndicatorWorked: boolean;
  omniboxLocalAutocompleteWorked: boolean;
  omniboxKeyboardWorked: boolean;
  omniboxMouseWorked: boolean;
  remoteSearchSuggestionsWorked: boolean;
  staleSuggestionsProtected: boolean;
  sidebarInteractionsWorked: boolean;
  stage2ActionsWorked: boolean;
  downloadWorked: boolean;
  tabsAfterLifecycle: number;
  viewsAfterLifecycle: number;
  ublock: UblockSnapshot;
  memory: Electron.ProcessMemoryInfo;
  errors: string[];
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs)
      throw new Error(`Timed out waiting for ${description}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function retryUntil<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started <= timeoutMs) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out waiting for ${description}.`, {
    cause: lastError,
  });
}

async function saveCaptureIfAvailable(
  filePath: string,
  capture: () => Promise<Buffer>,
  description: string,
): Promise<void> {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, await retryUntil(capture, 1_000, description));
  } catch (error) {
    console.warn(`Skipped ${description}; capture is unavailable.`, error);
  }
}

function namedCapturePath(basePath: string, name: string): string {
  const parsed = path.parse(basePath);
  return path.join(parsed.dir, `${parsed.name}-${name}${parsed.ext}`);
}

async function waitForShellPaint(manager: TabManager): Promise<void> {
  await manager.evaluateShell<boolean>(`(() => {
    let marker = document.querySelector("[data-smoke-capture-marker]");
    if (!marker) {
      marker = document.createElement("span");
      marker.setAttribute("data-smoke-capture-marker", "");
      marker.setAttribute("aria-hidden", "true");
      marker.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:.001;pointer-events:none";
      document.body.append(marker);
    }
    marker.textContent = String(Date.now());
    return Boolean(marker.getBoundingClientRect());
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function setOmniboxValue(
  manager: TabManager,
  value: string,
): Promise<void> {
  const changed = await manager.evaluateShell<boolean>(`(() => {
    const input = document.querySelector(".omnibox");
    if (!(input instanceof HTMLInputElement)) return false;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    valueSetter?.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: ${JSON.stringify(value.slice(-1))}
    }));
    return true;
  })()`);
  if (!changed) throw new Error("The Omnibox input was unavailable.");
}

export async function runSmokeTest(
  manager: TabManager,
  ublock: UblockService,
  downloads: DownloadManager,
  options: SmokeOptions,
): Promise<SmokeReport> {
  const shellReadyMs = Math.round(performance.now() - options.startedAt);
  const errors: string[] = [];
  let fixtureNavigationMs: number | null = null;
  let liveNavigationMs: number | null = null;
  let fixtureLoaded = false;
  let livePageLoaded = false;
  let adScriptLoaded: boolean | null = null;
  let ublockDashboardLoaded = false;
  let shortcutsWorked = false;
  let tabLoadingIndicatorWorked = false;
  let omniboxLocalAutocompleteWorked = false;
  let omniboxKeyboardWorked = false;
  let omniboxMouseWorked = false;
  let remoteSearchSuggestionsWorked = false;
  let staleSuggestionsProtected = false;
  let stage2ActionsWorked = false;
  let sidebarInteractionsWorked = false;
  let downloadWorked = false;

  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await saveCaptureIfAvailable(
      options.shellScreenshotPath,
      () => manager.captureShell(),
      "the shell screenshot",
    );

    const initialTabCount = manager.snapshot.tabs.length;
    manager.sendShellShortcut("T", ["control"]);
    await waitFor(
      () => manager.snapshot.tabs.length === initialTabCount + 1,
      5_000,
      "Ctrl+T to create a tab",
    );
    manager.sendShellShortcut("W", ["control"]);
    await waitFor(
      () => manager.snapshot.tabs.length === initialTabCount,
      5_000,
      "Ctrl+W to close a tab",
    );
    manager.sendShellShortcut("L", ["control"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    shortcutsWorked = await manager.evaluateShell<boolean>(
      'document.activeElement?.getAttribute("aria-label") === "Address and search"',
    );
    if (!shortcutsWorked) throw new Error("Ctrl+L did not focus the omnibox.");

    const firstTab = manager.snapshot.activeTabId;
    const fixtureStart = performance.now();
    const loadingIndicatorUrl = new URL(options.fixtureUrl);
    loadingIndicatorUrl.searchParams.set("loading-indicator", "1");
    await manager.navigate(firstTab, loadingIndicatorUrl.href);
    tabLoadingIndicatorWorked = await retryUntil(
      async () => {
        const visible = await manager.evaluateShell<boolean>(
          'Boolean(document.querySelector(".tab.active .expressive-loading--compact svg animate"))',
        );
        if (!visible)
          throw new Error(
            "The active loading tab has no expressive indicator.",
          );
        return true;
      },
      1_000,
      "the Material 3 Expressive tab loading indicator",
    );
    await saveCaptureIfAvailable(
      namedCapturePath(options.shellScreenshotPath, "tab-loading"),
      () => manager.captureShell(),
      "the tab loading indicator screenshot",
    );
    await waitFor(
      () => {
        const tab = manager.snapshot.tabs.find(
          (candidate) => candidate.id === firstTab,
        );
        return Boolean(
          tab && !tab.isLoading && tab.title === "Chromecraft fixture",
        );
      },
      20_000,
      "the deterministic fixture page",
    );
    fixtureNavigationMs = Math.round(performance.now() - fixtureStart);
    fixtureLoaded = true;
    adScriptLoaded = await manager.evaluateActive<boolean>(
      "Boolean(window.adScriptLoaded)",
    );

    await manager.evaluateActive<void>(`(() => {
      const link = document.createElement("a");
      link.href = ${JSON.stringify(new URL("/download", options.fixtureUrl).href)};
      link.download = "chromecraft-smoke.txt";
      document.body.append(link);
      link.click();
      link.remove();
    })()`);
    await waitFor(
      () => downloads.snapshot.some((item) => item.state === "completed"),
      10_000,
      "a completed browser download",
    );
    const completedDownload = downloads.snapshot.find(
      (item) => item.state === "completed",
    );
    downloadWorked = Boolean(completedDownload?.filename);
    if (!downloadWorked) throw new Error("The download did not complete.");

    await manager.evaluateShell<boolean>(`window.chromecraft.addBookmark({
      title: "Chromecraft fixture",
      url: ${JSON.stringify(options.fixtureUrl)},
      folder: "Visual QA"
    }).then(() => true)`);
    const autocompleteUrl = new URL(options.fixtureUrl);
    autocompleteUrl.hostname = "youtube.test";
    await manager.evaluateShell<boolean>(`window.chromecraft.addBookmark({
      title: "YouTube Test",
      url: ${JSON.stringify(autocompleteUrl.href)},
      folder: "Autocomplete QA"
    }).then(() => true)`);
    await manager.evaluateShell<boolean>(`window.chromecraft.addQuickLink({
      title: "Fixture",
      url: ${JSON.stringify(options.fixtureUrl)}
    }).then(() => true)`);
    manager.setChromeOverlayOpen(true);
    const visualViews = ["Bookmarks", "History", "Downloads", "Settings"];
    for (const viewName of visualViews) {
      await manager.evaluateShell<boolean>(`(() => {
        const button = [...document.querySelectorAll("button")].find(
          (candidate) => candidate.getAttribute("aria-label") === ${JSON.stringify(viewName)}
        );
        button?.click();
        return Boolean(button);
      })()`);
      await waitForShellPaint(manager);
      await saveCaptureIfAvailable(
        namedCapturePath(options.shellScreenshotPath, viewName.toLowerCase()),
        () => manager.captureShell(),
        `the ${viewName.toLowerCase()} panel screenshot`,
      );
    }

    const visualNewTab = manager.createTab();
    await waitForShellPaint(manager);
    await saveCaptureIfAvailable(
      namedCapturePath(options.shellScreenshotPath, "new-tab"),
      () => manager.captureShell(),
      "the populated new-tab screenshot",
    );
    manager.resizeWindowForSmoke(800, 620);
    await waitForShellPaint(manager);
    await saveCaptureIfAvailable(
      namedCapturePath(options.shellScreenshotPath, "narrow"),
      () => manager.captureShell(),
      "the narrow-window screenshot",
    );
    manager.setWindowMaximizedForSmoke(true);
    await waitForShellPaint(manager);
    await saveCaptureIfAvailable(
      namedCapturePath(options.shellScreenshotPath, "maximized"),
      () => manager.captureShell(),
      "the maximized-window screenshot",
    );
    manager.setWindowMaximizedForSmoke(false);
    manager.resizeWindowForSmoke(1280, 820);
    await waitForShellPaint(manager);
    manager.sendShellShortcut("L", ["control"]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await setOmniboxValue(manager, "you");
    omniboxLocalAutocompleteWorked = await retryUntil(
      async () => {
        const state = await manager.evaluateShell<{
          value: string;
          selectionStart: number | null;
          selectionEnd: number | null;
          focused: boolean;
          localFirst: boolean;
        }>(`(() => {
          const input = document.querySelector(".omnibox");
          const first = document.querySelector("#omnibox-option-0");
          if (!(input instanceof HTMLInputElement)) return null;
          return {
            value: input.value,
            selectionStart: input.selectionStart,
            selectionEnd: input.selectionEnd,
            focused: document.activeElement === input,
            localFirst: first?.getAttribute("data-kind") === "url"
          };
        })()`);
        const worked =
          state?.value === "youtube.test" &&
          state.selectionStart === 3 &&
          state.selectionEnd === "youtube.test".length &&
          state.focused &&
          state.localFirst;
        if (!worked)
          throw new Error("Inline local URL autocomplete is not ready.");
        return true;
      },
      2_000,
      "inline local URL autocomplete",
    );
    await saveCaptureIfAvailable(
      namedCapturePath(options.shellScreenshotPath, "omnibox-suggestions"),
      () => manager.captureShell(),
      "the local omnibox suggestions screenshot",
    );
    manager.sendShellShortcut("Tab", []);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const tabAccepted = await manager.evaluateShell<boolean>(`(() => {
      const input = document.querySelector(".omnibox");
      return input instanceof HTMLInputElement &&
        input.value === "youtube.test" &&
        input.selectionStart === input.value.length &&
        input.selectionEnd === input.value.length &&
        document.activeElement === input;
    })()`);

    await setOmniboxValue(manager, "you");
    await new Promise((resolve) => setTimeout(resolve, 80));
    const suffixWasReplaced = await manager.evaluateShell<boolean>(`(() => {
      const input = document.querySelector(".omnibox");
      if (!(input instanceof HTMLInputElement)) return false;
      input.setRangeText(
        "x",
        input.selectionStart ?? input.value.length,
        input.selectionEnd ?? input.value.length,
        "end"
      );
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "x"
      }));
      return true;
    })()`);
    const replacementSettled = await retryUntil(
      async () => {
        const settled = await manager.evaluateShell<boolean>(`(() => {
          const input = document.querySelector(".omnibox");
          return input instanceof HTMLInputElement && input.value === "youx";
        })()`);
        if (!settled) throw new Error("Replacement input has not settled.");
        return true;
      },
      1_000,
      "replacement input to settle",
    );

    await setOmniboxValue(manager, "you");
    await new Promise((resolve) => setTimeout(resolve, 80));
    manager.sendShellShortcut("Right", []);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const rightAccepted = await manager.evaluateShell<boolean>(`(() => {
      const input = document.querySelector(".omnibox");
      return input instanceof HTMLInputElement &&
        input.value === "youtube.test" &&
        input.selectionStart === input.value.length &&
        input.selectionEnd === input.value.length;
    })()`);
    manager.sendShellShortcut("Down", []);
    const arrowWorked = await retryUntil(
      async () => {
        const worked = await manager.evaluateShell<boolean>(`(() => {
          const input = document.querySelector(".omnibox");
          return input instanceof HTMLInputElement &&
            document.activeElement === input &&
            input.getAttribute("aria-activedescendant") === "omnibox-option-1";
        })()`);
        if (!worked) throw new Error("Arrow selection has not settled.");
        return true;
      },
      1_000,
      "arrow selection to settle",
    );
    manager.sendShellShortcut("Escape", []);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const escapeWorked = await manager.evaluateShell<boolean>(`(() => {
      const input = document.querySelector(".omnibox");
      return input instanceof HTMLInputElement &&
        document.activeElement === input &&
        !document.querySelector(".omnibox-suggestions");
    })()`);
    omniboxKeyboardWorked =
      tabAccepted &&
      suffixWasReplaced &&
      replacementSettled &&
      rightAccepted &&
      arrowWorked &&
      escapeWorked;
    if (!omniboxKeyboardWorked) {
      throw new Error(
        `The Omnibox keyboard interaction smoke check failed: ${JSON.stringify({
          tabAccepted,
          suffixWasReplaced,
          replacementSettled,
          rightAccepted,
          arrowWorked,
          escapeWorked,
        })}`,
      );
    }

    await setOmniboxValue(manager, "you");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const mouseHighlighted = await manager.evaluateShell<boolean>(`(() => {
      const input = document.querySelector(".omnibox");
      const option = document.querySelector("#omnibox-option-1");
      option?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      return input instanceof HTMLInputElement && document.activeElement === input;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const hoverSelected = await manager.evaluateShell<boolean>(`(() => {
      const input = document.querySelector(".omnibox");
      return input instanceof HTMLInputElement &&
        input.getAttribute("aria-activedescendant") === "omnibox-option-1";
    })()`);
    await manager.evaluateShell<boolean>(`(() => {
      const option = document.querySelector("#omnibox-option-0");
      if (!(option instanceof HTMLButtonElement)) return false;
      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      option.click();
      return true;
    })()`);
    await waitFor(
      () => {
        const tab = manager.snapshot.tabs.find(
          (candidate) => candidate.id === visualNewTab,
        );
        return Boolean(
          tab && !tab.isLoading && tab.url.includes("youtube.test"),
        );
      },
      10_000,
      "mouse navigation to the highlighted local suggestion",
    );
    omniboxMouseWorked = mouseHighlighted && hoverSelected;
    if (!omniboxMouseWorked)
      throw new Error("The Omnibox mouse interaction smoke check failed.");

    await manager.navigate(visualNewTab, options.fixtureUrl);
    await waitFor(
      () => {
        const tab = manager.snapshot.tabs.find(
          (candidate) => candidate.id === visualNewTab,
        );
        return Boolean(tab && !tab.isLoading);
      },
      10_000,
      "returning from the autocomplete fixture",
    );
    manager.sendShellShortcut("L", ["control"]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await setOmniboxValue(manager, "you");
    await new Promise((resolve) => setTimeout(resolve, 100));
    manager.sendShellShortcut("Enter", []);
    await waitFor(
      () => {
        const tab = manager.snapshot.tabs.find(
          (candidate) => candidate.id === visualNewTab,
        );
        return Boolean(
          tab && !tab.isLoading && tab.url.includes("youtube.test"),
        );
      },
      10_000,
      "Enter navigation to the inline local completion",
    );
    await manager.navigate(visualNewTab, options.fixtureUrl);
    await waitFor(
      () => {
        const tab = manager.snapshot.tabs.find(
          (candidate) => candidate.id === visualNewTab,
        );
        return Boolean(tab && !tab.isLoading);
      },
      10_000,
      "returning after the Enter autocomplete check",
    );
    manager.sendShellShortcut("L", ["control"]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    if (manager.snapshot.preferences.remoteSearchSuggestionsEnabled) {
      await setOmniboxValue(manager, "phase14 old");
      await new Promise((resolve) => setTimeout(resolve, 320));
      await setOmniboxValue(manager, "phase14 new");
      remoteSearchSuggestionsWorked = await retryUntil(
        async () => {
          const state = await manager.evaluateShell<{
            hasNew: boolean;
            hasOld: boolean;
            localFirst: boolean;
          }>(`(() => {
            const remote = [...document.querySelectorAll('[data-kind="remote-search"] strong')]
              .map((item) => item.textContent ?? "");
            return {
              hasNew: remote.some((text) => text.includes("phase14 new result")),
              hasOld: remote.some((text) => text.includes("phase14 old result")),
              localFirst: document.querySelector("#omnibox-option-0")
                ?.getAttribute("data-kind") !== "remote-search"
            };
          })()`);
          if (!state.hasNew || state.hasOld || !state.localFirst)
            throw new Error(
              "Remote suggestions are not current and local-first.",
            );
          return true;
        },
        3_000,
        "fresh remote search suggestions",
      );
      await new Promise((resolve) => setTimeout(resolve, 800));
      staleSuggestionsProtected = await manager.evaluateShell<boolean>(`(() => {
        const remote = [...document.querySelectorAll('[data-kind="remote-search"] strong')]
          .map((item) => item.textContent ?? "");
        return remote.some((text) => text.includes("phase14 new result")) &&
          !remote.some((text) => text.includes("phase14 old result"));
      })()`);
      await saveCaptureIfAvailable(
        namedCapturePath(options.shellScreenshotPath, "omnibox-remote"),
        () => manager.captureShell(),
        "the remote Omnibox suggestions screenshot",
      );
    } else {
      await setOmniboxValue(manager, "phase14 provider");
      await new Promise((resolve) => setTimeout(resolve, 500));
      remoteSearchSuggestionsWorked = await manager.evaluateShell<boolean>(
        "!document.querySelector('[data-kind=\"remote-search\"]')",
      );
      staleSuggestionsProtected = true;
    }
    if (!remoteSearchSuggestionsWorked || !staleSuggestionsProtected)
      throw new Error("The Omnibox remote privacy/staleness check failed.");
    manager.sendShellShortcut("Escape", []);
    manager.sendShellShortcut("P", ["control", "shift"]);
    await waitForShellPaint(manager);
    await saveCaptureIfAvailable(
      namedCapturePath(options.shellScreenshotPath, "command-palette"),
      () => manager.captureShell(),
      "the command-palette screenshot",
    );
    manager.sendShellShortcut("Escape", []);
    manager.setChromeOverlayOpen(true);
    await manager.evaluateShell<boolean>(`(() => {
      const tab = document.querySelector(".tab.active");
      tab?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 180,
        clientY: 28
      }));
      return Boolean(tab);
    })()`);
    await waitForShellPaint(manager);
    await saveCaptureIfAvailable(
      namedCapturePath(options.shellScreenshotPath, "tab-menu"),
      () => manager.captureShell(),
      "the tab-menu screenshot",
    );
    manager.sendShellShortcut("Escape", []);
    await manager.evaluateShell<boolean>(`(() => {
      const brand = document.querySelector('button[aria-label="Chromecraft menu"]');
      brand?.click();
      return Boolean(brand);
    })()`);
    await waitForShellPaint(manager);
    const collapseMenuReady = await manager.evaluateShell<boolean>(`(() => {
      const menu = document.querySelector('[role="menu"][aria-label="Chromecraft menu"]');
      const action = [...document.querySelectorAll('[role="menuitem"]')].find(
        (candidate) => candidate.textContent?.includes('Collapse sidebar')
      );
      return Boolean(menu && action);
    })()`);
    if (!collapseMenuReady)
      throw new Error("The Chromecraft menu did not expose Collapse sidebar.");
    const updatesMenuReady = await manager.evaluateShell<boolean>(`(() => {
      const action = [...document.querySelectorAll('[role="menuitem"]')].find(
        (candidate) => candidate.textContent?.includes('Updates and versions')
      );
      return Boolean(action);
    })()`);
    if (!updatesMenuReady)
      throw new Error(
        "The Chromecraft menu did not expose Updates and versions.",
      );
    await saveCaptureIfAvailable(
      namedCapturePath(options.shellScreenshotPath, "chromecraft-menu"),
      () => manager.captureShell(),
      "the Chromecraft menu screenshot",
    );
    await manager.evaluateShell<boolean>(`(() => {
      const action = [...document.querySelectorAll('[role="menuitem"]')].find(
        (candidate) => candidate.textContent?.includes('Updates and versions')
      );
      action?.click();
      return Boolean(action);
    })()`);
    await waitForShellPaint(manager);
    const updatesPageReady = await manager.evaluateShell<boolean>(`Boolean(
      document.querySelector('.updates-page') &&
      [...document.querySelectorAll('button')].some(
        (button) => button.textContent?.includes('Check for updates')
      )
    )`);
    if (!updatesPageReady)
      throw new Error("The Updates and versions page did not open.");
    await saveCaptureIfAvailable(
      namedCapturePath(options.shellScreenshotPath, "updates-and-versions"),
      () => manager.captureShell(),
      "the Updates and versions screenshot",
    );
    await manager.evaluateShell<boolean>(`(() => {
      const back = document.querySelector('button[aria-label="Back to browsing"]');
      back?.click();
      return Boolean(back);
    })()`);
    await manager.evaluateShell<boolean>(`(() => {
      const brand = document.querySelector('button[aria-label="Chromecraft menu"]');
      brand?.click();
      return Boolean(brand);
    })()`);
    await waitForShellPaint(manager);
    await manager.evaluateShell<boolean>(`(() => {
      const action = [...document.querySelectorAll('[role="menuitem"]')].find(
        (candidate) => candidate.textContent?.includes('Collapse sidebar')
      );
      action?.click();
      return Boolean(action);
    })()`);
    await waitFor(
      () => !manager.snapshot.preferences.sidebarAttached,
      5_000,
      "the sidebar to detach",
    );
    const sidebarFullyHidden = await retryUntil(
      async () => {
        const hidden = await manager.evaluateShell<boolean>(
          '!document.querySelector(".sidebar")',
        );
        if (!hidden) throw new Error("The sidebar is still rendered.");
        return true;
      },
      3_000,
      "the detached sidebar DOM",
    );
    await manager.evaluateShell<boolean>(`(() => {
      const brand = document.querySelector('button[aria-label="Chromecraft menu"]');
      brand?.click();
      return Boolean(brand);
    })()`);
    await waitForShellPaint(manager);
    const expandMenuReady = await manager.evaluateShell<boolean>(`(() => {
      const action = [...document.querySelectorAll('[role="menuitem"]')].find(
        (candidate) => candidate.textContent?.includes('Expand sidebar')
      );
      action?.click();
      return Boolean(action);
    })()`);
    if (!expandMenuReady)
      throw new Error("The Chromecraft menu did not expose Expand sidebar.");
    await waitFor(
      () => manager.snapshot.preferences.sidebarAttached,
      5_000,
      "the sidebar to reattach",
    );
    const sidebarRestored = await retryUntil(
      async () => {
        const restored = await manager.evaluateShell<boolean>(
          'Boolean(document.querySelector(".sidebar"))',
        );
        if (!restored) throw new Error("The sidebar is not rendered yet.");
        return true;
      },
      3_000,
      "the reattached sidebar DOM",
    );
    await manager.evaluateShell<boolean>(`(() => {
      const history = [...document.querySelectorAll("button")].find(
        (candidate) => candidate.getAttribute("aria-label") === "History"
      );
      history?.click();
      return Boolean(history);
    })()`);
    await waitFor(
      () => manager.snapshot.preferences.sidebarOpen,
      5_000,
      "the History sidebar tool to open",
    );
    const historyOpened = await retryUntil(
      async () => {
        const open = await manager.evaluateShell<boolean>(`(() => {
          const history = document.querySelector('button[aria-label="History"]');
          return Boolean(history?.classList.contains('active') && document.querySelector('#sidebar-panel'));
        })()`);
        if (!open) throw new Error("History is not visibly open yet.");
        return true;
      },
      3_000,
      "the History sidebar panel",
    );
    await manager.evaluateShell<boolean>(`(() => {
      const history = document.querySelector('button[aria-label="History"]');
      history?.click();
      return Boolean(history);
    })()`);
    await waitFor(
      () => !manager.snapshot.preferences.sidebarOpen,
      5_000,
      "the active sidebar tool to close",
    );
    const historyClosed = await retryUntil(
      async () => {
        const closed = await manager.evaluateShell<boolean>(`(() => {
          const history = document.querySelector('button[aria-label="History"]');
          return Boolean(
            document.querySelector('.sidebar.rail-only') &&
            !history?.classList.contains('active') &&
            !document.querySelector('#sidebar-panel')
          );
        })()`);
        if (!closed) throw new Error("History is not visibly closed yet.");
        return true;
      },
      3_000,
      "the closed History sidebar panel",
    );
    await manager.evaluateShell<boolean>(`(() => {
      const history = document.querySelector('button[aria-label="History"]');
      history?.click();
      return Boolean(history);
    })()`);
    await waitFor(
      () => manager.snapshot.preferences.sidebarOpen,
      5_000,
      "the History sidebar tool to reopen",
    );
    await waitForShellPaint(manager);
    sidebarInteractionsWorked =
      sidebarFullyHidden && sidebarRestored && historyOpened && historyClosed;
    if (!sidebarInteractionsWorked)
      throw new Error(
        `The sidebar interaction state machine did not settle correctly (${JSON.stringify({ sidebarFullyHidden, sidebarRestored, historyOpened, historyClosed })}).`,
      );
    await manager.evaluateShell<boolean>(`(() => {
      const clearAll = [...document.querySelectorAll(".panel-actions button")].find(
        (candidate) => candidate.textContent?.trim() === "All"
      );
      clearAll?.click();
      return Boolean(clearAll);
    })()`);
    await waitForShellPaint(manager);
    await saveCaptureIfAvailable(
      namedCapturePath(options.shellScreenshotPath, "dialog"),
      () => manager.captureShell(),
      "the Material confirmation dialog screenshot",
    );
    manager.sendShellShortcut("Escape", []);
    manager.closeTab(visualNewTab);
    manager.activateTab(firstTab);
    await waitForShellPaint(manager);
    manager.sendShellShortcut("F", ["control"]);
    manager.setChromeOverlayOpen(true);
    await waitForShellPaint(manager);
    const findVisible = await manager.evaluateShell<boolean>(
      'Boolean(document.querySelector(".find-bar"))',
    );
    if (!findVisible) throw new Error("The browser find bar did not open.");
    await saveCaptureIfAvailable(
      namedCapturePath(options.shellScreenshotPath, "find"),
      () => manager.captureShell(),
      "the find-bar screenshot",
    );
    manager.sendShellShortcut("Escape", []);
    manager.setChromeOverlayOpen(false);

    const secondTab = manager.createTab(`${options.fixtureUrl}?page=second`);
    await waitFor(
      () => {
        const tab = manager.snapshot.tabs.find(
          (candidate) => candidate.id === secondTab,
        );
        return Boolean(
          tab && !tab.isLoading && tab.title === "Chromecraft fixture",
        );
      },
      20_000,
      "a second independent tab",
    );
    manager.activateTab(firstTab);
    manager.closeTab(secondTab);

    manager.setZoom(firstTab, 1.25);
    manager.toggleMute(firstTab);
    const duplicateTab = await manager.duplicateTab(firstTab);
    await waitFor(
      () =>
        manager.snapshot.tabs.some(
          (tab) => tab.id === duplicateTab && !tab.isLoading,
        ),
      20_000,
      "a duplicated tab",
    );
    manager.closeTab(duplicateTab);
    const reopenedTab = await manager.reopenClosedTab();
    if (!reopenedTab) throw new Error("Recently closed tab could not reopen.");
    await waitFor(
      () =>
        manager.snapshot.tabs.some(
          (tab) => tab.id === reopenedTab && !tab.isLoading,
        ),
      20_000,
      "the reopened tab",
    );
    manager.closeTab(reopenedTab);
    manager.activateTab(firstTab);
    manager.toggleMute(firstTab);
    manager.setZoom(firstTab, 1);
    await manager.setSidebarOpen(false);
    await manager.setSidebarOpen(true);
    stage2ActionsWorked =
      manager.snapshot.tabs.length === initialTabCount &&
      manager.snapshot.tabs.some(
        (tab) =>
          tab.id === firstTab && tab.zoomFactor === 1 && tab.isMuted === false,
      );
    if (!stage2ActionsWorked) {
      throw new Error(
        "Stage 2A tab or sidebar actions did not settle cleanly.",
      );
    }

    if (options.liveUrl) {
      const liveStart = performance.now();
      await manager.navigate(firstTab, options.liveUrl);
      await waitFor(
        () => {
          const tab = manager.snapshot.tabs.find(
            (candidate) => candidate.id === firstTab,
          );
          return Boolean(
            tab &&
            !tab.isLoading &&
            !tab.error &&
            tab.url.startsWith("https://"),
          );
        },
        30_000,
        `live page ${options.liveUrl}`,
      );
      liveNavigationMs = Math.round(performance.now() - liveStart);
      livePageLoaded = true;
    }

    await saveCaptureIfAvailable(
      options.screenshotPath,
      () => manager.captureActivePage(),
      "the active-page screenshot",
    );

    if (ublock.snapshot.ready) {
      manager.openUblockDashboard();
      await waitFor(
        () => {
          const tab = manager.snapshot.tabs.find(
            (candidate) => candidate.id === manager.snapshot.activeTabId,
          );
          return Boolean(
            tab &&
            !tab.isLoading &&
            !tab.error &&
            tab.url.startsWith("chrome-extension://"),
          );
        },
        20_000,
        "the uBlock Origin dashboard",
      );
      ublockDashboardLoaded = await manager.evaluateActive<boolean>(
        'document.readyState === "complete" && document.body !== null',
      );
      const dashboardTabId = manager.snapshot.activeTabId;
      manager.closeTab(dashboardTabId);
    }
  } catch (error) {
    errors.push(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  }

  const report: SmokeReport = {
    success:
      errors.length === 0 &&
      fixtureLoaded &&
      sidebarInteractionsWorked &&
      stage2ActionsWorked &&
      tabLoadingIndicatorWorked &&
      omniboxLocalAutocompleteWorked &&
      omniboxKeyboardWorked &&
      omniboxMouseWorked &&
      remoteSearchSuggestionsWorked &&
      staleSuggestionsProtected &&
      downloadWorked &&
      (!options.liveUrl || livePageLoaded) &&
      (!ublock.snapshot.ready || ublockDashboardLoaded),
    platform: process.platform,
    arch: process.arch,
    shellReadyMs,
    fixtureNavigationMs,
    liveNavigationMs,
    fixtureLoaded,
    livePageLoaded,
    adScriptLoaded,
    ublockDashboardLoaded,
    shortcutsWorked,
    tabLoadingIndicatorWorked,
    omniboxLocalAutocompleteWorked,
    omniboxKeyboardWorked,
    omniboxMouseWorked,
    remoteSearchSuggestionsWorked,
    staleSuggestionsProtected,
    sidebarInteractionsWorked,
    stage2ActionsWorked,
    downloadWorked,
    tabsAfterLifecycle: manager.snapshot.tabs.length,
    viewsAfterLifecycle: manager.liveViewCount,
    ublock: ublock.snapshot,
    memory: await process.getProcessMemoryInfo(),
    errors,
  };

  await fs.mkdir(path.dirname(options.reportPath), { recursive: true });
  await fs.writeFile(
    options.reportPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  return report;
}
