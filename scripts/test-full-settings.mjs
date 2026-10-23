import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const executable = path.resolve(
  process.env.CHROMECRAFT_EXECUTABLE ??
    path.join(root, "out", "Chromecraft-win32-x64", "chromecraft.exe"),
);
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "chromecraft-full-settings-test-"),
);
const artifacts = {
  light: path.join(root, ".artifacts", "full-settings-light.png"),
  dark: path.join(root, ".artifacts", "full-settings-dark.png"),
  narrow: path.join(root, ".artifacts", "full-settings-narrow.png"),
};

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Could not reserve a debugging port.");
  return port;
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(
        typeof event.data === "string" ? event.data : event.data.toString(),
      );
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("CDP connection timed out.")),
        5_000,
      );
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener("error", reject, { once: true });
    });
    return new CdpClient(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function poll(operation, predicate, description, timeoutMs = 10_000) {
  const startedAt = Date.now();
  let last;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      last = await operation();
      if (predicate(last)) return last;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const detail = typeof last === "object" ? JSON.stringify(last) : String(last);
  throw new Error(`Timed out waiting for ${description}: ${detail}`);
}

async function stop(child) {
  if (!child?.pid || child.exitCode !== null) return;
  const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
  await new Promise((resolve) => killer.once("exit", resolve));
}

async function launch() {
  const port = await freePort();
  const child = spawn(
    executable,
    [
      `--chromecraft-user-data=${profile}`,
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
    ],
    { cwd: root, windowsHide: true, stdio: "ignore" },
  );
  const target = await poll(
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      return response.json();
    },
    (targets) =>
      targets.some(
        (entry) =>
          entry.type === "page" &&
          (entry.url.startsWith("file://") ||
            entry.url.includes("main_window")) &&
          entry.webSocketDebuggerUrl,
      ),
    "the Chromecraft shell target",
    20_000,
  ).then((targets) =>
    targets.find(
      (entry) =>
        entry.type === "page" &&
        (entry.url.startsWith("file://") ||
          entry.url.includes("main_window")) &&
        entry.webSocketDebuggerUrl,
    ),
  );
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await poll(
    () => cdp.evaluate("Boolean(window.chromecraft)"),
    Boolean,
    "the shell API",
  );
  return { child, cdp };
}

async function capture(cdp, targetPath) {
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
  });
  await fs.writeFile(targetPath, Buffer.from(screenshot.data, "base64"));
}

async function openFullSettings(cdp) {
  await poll(
    () =>
      cdp.evaluate(
        "Boolean(document.querySelector('button[aria-label=\"Settings\"]'))",
      ),
    Boolean,
    "the Settings sidebar control",
  );
  await cdp.evaluate(
    "document.querySelector('button[aria-label=\"Settings\"]')?.click()",
  );
  await poll(
    () =>
      cdp.evaluate(
        'Boolean(document.querySelector(".quick-settings-sidebar"))',
      ),
    Boolean,
    "Quick settings",
  );
  await cdp.evaluate(
    'document.querySelector(".quick-setting-open-all")?.click()',
  );
  await poll(
    () =>
      cdp.evaluate('Boolean(document.querySelector(".full-settings-page"))'),
    Boolean,
    "Full Settings",
  );
}

async function openSmartDownloadsFromGallery(cdp) {
  await cdp.evaluate("window.chromecraft.openGallery() ");
  await poll(
    () => cdp.evaluate("Boolean(document.querySelector('.gallery-page'))"),
    Boolean,
    "My Gallery",
  );
  const gallery = await cdp.evaluate(`(() => ({
    manage: [...document.querySelectorAll('button')].some((button) =>
      button.textContent?.includes('Manage My Gallery')
    ),
    bannerTitle: document.querySelector('#gallery-smart-downloads-title')?.textContent,
    bannerSubtitle: document.querySelector('.gallery-smart-downloads-copy p')?.textContent,
    action: document.querySelector('.gallery-smart-downloads-action')?.textContent?.trim(),
  }))()`);
  if (
    !gallery.manage ||
    gallery.bannerTitle !== "Set up Smart Downloads?" ||
    gallery.bannerSubtitle !==
      "Automatically download from your favorite creators" ||
    !gallery.action?.includes("Check Smart Downloads")
  ) {
    throw new Error(
      `Unexpected Smart Downloads Gallery entry points: ${JSON.stringify(gallery)}`,
    );
  }
  await cdp.evaluate(
    "document.querySelector('.gallery-smart-downloads-action')?.click()",
  );
  const navigation = await poll(
    () =>
      cdp.evaluate(`(() => ({
        pageVisible: Boolean(document.querySelector('.smart-downloads-page')),
        detail: document.querySelector('.full-settings-detail')?.getAttribute('data-settings-detail'),
        heading: document.querySelector('.smart-downloads-page h2')?.textContent,
      }))()`),
    (state) =>
      state.pageVisible &&
      state.detail === "downloads" &&
      state.heading === "Smart Downloads",
    "Gallery to Smart Downloads Settings navigation",
  );
  await cdp.evaluate(`(() => {
    document.querySelector('.smart-downloads-hero .smart-icon-button')?.click();
    document.querySelector('[data-settings-category="general"]')?.click();
  })()`);
  await poll(
    () =>
      cdp.evaluate(
        "document.querySelector('.full-settings-detail')?.getAttribute('data-settings-detail')",
      ),
    (detail) => detail === "general",
    "General Settings after Gallery validation",
  );
  return { gallery, navigation };
}

async function selectCategory(cdp, category) {
  await cdp.evaluate(
    `document.querySelector('[data-settings-category="${category}"]')?.click()`,
  );
  await poll(
    () =>
      cdp.evaluate(
        "document.querySelector('.full-settings-detail')?.getAttribute('data-settings-detail')",
      ),
    (value) => value === category,
    `${category} settings`,
  );
}

async function toggleSetting(cdp, settingId, readExpression, description) {
  const before = await cdp.evaluate(readExpression);
  await poll(
    () =>
      cdp.evaluate(`(() => {
        const input = document.querySelector('#setting-${settingId} input[type="checkbox"]');
        return input && !input.disabled ? input.checked : null;
      })()`),
    (value) => value === before,
    `${description} control to become ready`,
  );
  await cdp.evaluate(
    `document.querySelector('#setting-${settingId} input[type="checkbox"]')?.click()`,
  );
  const after = await poll(
    () => cdp.evaluate(readExpression),
    (value) => value !== before,
    `${description} to update`,
  );
  return { before, after };
}

async function restoreToggle(cdp, settingId, readExpression, expected) {
  const current = await cdp.evaluate(readExpression);
  if (current === expected) return;
  await poll(
    () =>
      cdp.evaluate(`(() => {
        const input = document.querySelector('#setting-${settingId} input[type="checkbox"]');
        return input && !input.disabled ? input.checked : null;
      })()`),
    (value) => value === current,
    `${settingId} control to reflect its updated value`,
  );
  await cdp.evaluate(
    `document.querySelector('#setting-${settingId} input[type="checkbox"]')?.click()`,
  );
  await poll(
    () => cdp.evaluate(readExpression),
    (value) => value === expected,
    `${settingId} to restore`,
  );
}

await fs.access(executable);
await fs.mkdir(path.dirname(artifacts.light), { recursive: true });
let app;
let expectedRestoreSession;
try {
  app = await launch();
  const galleryEntryPoints = await openSmartDownloadsFromGallery(app.cdp);

  const initialLayout = await app.cdp.evaluate(`(() => {
    const detail = document.querySelector('.full-settings-detail');
    return {
      categories: [...document.querySelectorAll('[data-settings-category]')].map(
        (item) => item.getAttribute('data-settings-category')
      ),
      active: document.querySelector('[data-settings-category].active')?.getAttribute('data-settings-category'),
      detail: detail?.getAttribute('data-settings-detail'),
      horizontalOverflow: Boolean(detail && detail.scrollWidth > detail.clientWidth + 1),
      settingsVisible: document.querySelectorAll('[data-setting-id]').length,
    };
  })()`);
  const expectedCategories = [
    "general",
    "privacy",
    "appearance",
    "downloads",
    "hyperdrive",
    "extensions",
    "advanced",
  ];
  if (
    JSON.stringify(initialLayout.categories) !==
      JSON.stringify(expectedCategories) ||
    initialLayout.active !== "general" ||
    initialLayout.detail !== "general" ||
    initialLayout.horizontalOverflow ||
    initialLayout.settingsVisible !== 3
  ) {
    throw new Error(
      `Unexpected initial Settings layout: ${JSON.stringify(initialLayout)}`,
    );
  }

  const categoryChecks = {};
  for (const category of expectedCategories) {
    await app.cdp.evaluate(
      `document.querySelector('[data-settings-category="${category}"]')?.click()`,
    );
    categoryChecks[category] = await poll(
      () =>
        app.cdp.evaluate(`(() => {
          const detail = document.querySelector('.full-settings-detail');
          return {
            detail: detail?.getAttribute('data-settings-detail'),
            active: document.querySelector('[data-settings-category].active')?.getAttribute('data-settings-category'),
            cards: document.querySelectorAll('.settings-category-content > .settings-card').length,
            horizontalOverflow: Boolean(detail && detail.scrollWidth > detail.clientWidth + 1),
          };
        })()`),
      (state) =>
        state.detail === category &&
        state.active === category &&
        state.cards > 0 &&
        !state.horizontalOverflow,
      `${category} category`,
    );
  }

  await selectCategory(app.cdp, "downloads");
  await app.cdp.evaluate(
    "document.querySelector('#setting-smart-downloads button')?.click()",
  );
  const smartDownloads = await poll(
    () =>
      app.cdp.evaluate(`(async () => ({
        pageVisible: Boolean(document.querySelector('.smart-downloads-page')),
        heading: document.querySelector('.smart-downloads-page h2')?.textContent,
        snapshot: await window.chromecraft.getSmartDownloads(),
        horizontalOverflow: (() => {
          const page = document.querySelector('.smart-downloads-page');
          return Boolean(page && page.scrollWidth > page.clientWidth + 1);
        })(),
      }))()`),
    (state) =>
      state.pageVisible &&
      state.heading === "Smart Downloads" &&
      state.snapshot?.config?.enabled === false &&
      state.snapshot?.config?.storageQuotaBytes > 0 &&
      !state.horizontalOverflow,
    "the packaged Smart Downloads page and IPC snapshot",
  );
  await app.cdp.evaluate(
    "document.querySelector('.smart-downloads-hero .smart-icon-button')?.click()",
  );
  await poll(
    () =>
      app.cdp.evaluate(
        "Boolean(document.querySelector('#setting-smart-downloads'))",
      ),
    Boolean,
    "return to Downloads settings",
  );

  await app.cdp.evaluate(`(() => {
    const input = document.querySelector('.settings-search input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, 'RAM reserve');
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const searchResult = await poll(
    () =>
      app.cdp.evaluate(`(() => {
        const results = [...document.querySelectorAll('.settings-search-results [role="option"]')];
        return {
          count: results.length,
          label: results[0]?.querySelector('strong')?.textContent,
        };
      })()`),
    (state) => state.count === 1 && state.label === "Maximum RAM to reserve",
    "the RAM search result",
  );
  await app.cdp.evaluate(
    "document.querySelector('.settings-search-results [role=\"option\"]')?.click()",
  );
  const searchNavigation = await poll(
    () =>
      app.cdp.evaluate(`(() => ({
        category: document.querySelector('.full-settings-detail')?.getAttribute('data-settings-detail'),
        highlighted: Boolean(document.querySelector('#setting-hyperdrive-ram.setting-search-target')),
        focused: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.id,
      }))()`),
    (state) =>
      state.category === "hyperdrive" &&
      state.highlighted &&
      ["Hyperdrive RAM reserve", "setting-hyperdrive-ram"].includes(
        state.focused,
      ),
    "search navigation and focus",
  );

  await app.cdp.evaluate(`(() => {
    document.querySelector('.settings-search-clear')?.click();
    document.querySelector('[data-settings-category="hyperdrive"]')?.click();
    const detail = document.querySelector('.full-settings-detail');
    if (detail) detail.scrollTop = 0;
  })()`);

  await capture(app.cdp, artifacts.light);
  await app.cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
  await capture(app.cdp, artifacts.dark);
  const darkSurface = await app.cdp.evaluate(
    "getComputedStyle(document.documentElement).getPropertyValue('--md-surface').trim()",
  );
  await app.cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 700,
    height: 860,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const narrowLayout = await poll(
    () =>
      app.cdp.evaluate(`(() => {
        const nav = document.querySelector('.settings-category-nav');
        const layout = document.querySelector('.full-settings-layout');
        const detail = document.querySelector('.full-settings-detail');
        return {
          navDirection: nav ? getComputedStyle(nav).flexDirection : null,
          layoutColumns: layout ? getComputedStyle(layout).gridTemplateColumns : null,
          viewportWidth: innerWidth,
          horizontalOverflow: Boolean(detail && detail.scrollWidth > detail.clientWidth + 1),
        };
      })()`),
    (state) =>
      state.viewportWidth === 700 &&
      state.navDirection === "row" &&
      !state.horizontalOverflow,
    "the compact Settings layout",
  );
  await capture(app.cdp, artifacts.narrow);
  await app.cdp.send("Emulation.clearDeviceMetricsOverride");
  await app.cdp.send("Emulation.setEmulatedMedia", { features: [] });

  const preference = (key) =>
    `window.chromecraft.getSnapshot().then((snapshot) => snapshot.preferences.${key})`;
  const controlChecks = {};

  await selectCategory(app.cdp, "general");
  controlChecks.restoreSession = await toggleSetting(
    app.cdp,
    "restore-session",
    preference("restoreSession"),
    "Restore tabs on launch",
  );
  expectedRestoreSession = controlChecks.restoreSession.after;
  for (const [settingId, key, description] of [
    ["bookmarks-bar", "bookmarkBarVisible", "Bookmarks bar"],
    ["browser-sidebar", "sidebarAttached", "Browser sidebar"],
  ]) {
    controlChecks[settingId] = await toggleSetting(
      app.cdp,
      settingId,
      preference(key),
      description,
    );
    if (settingId === "browser-sidebar") {
      await app.cdp.evaluate(
        `window.chromecraft.setSidebarAttached(${controlChecks[settingId].before})`,
      );
      await poll(
        () => app.cdp.evaluate(preference(key)),
        (value) => value === controlChecks[settingId].before,
        "Browser sidebar to restore",
      );
    } else {
      await restoreToggle(
        app.cdp,
        settingId,
        preference(key),
        controlChecks[settingId].before,
      );
    }
  }

  await selectCategory(app.cdp, "privacy");
  await poll(
    () =>
      app.cdp.evaluate(
        "Boolean(document.querySelector('#setting-ublock-origin input:not(:disabled)'))",
      ),
    Boolean,
    "uBlock Origin to become ready",
  );
  for (const [settingId, expression, description] of [
    [
      "ublock-origin",
      "window.chromecraft.getSnapshot().then((snapshot) => snapshot.ublock.enabled)",
      "uBlock Origin",
    ],
    [
      "live-search-suggestions",
      preference("remoteSearchSuggestionsEnabled"),
      "Live search suggestions",
    ],
  ]) {
    controlChecks[settingId] = await toggleSetting(
      app.cdp,
      settingId,
      expression,
      description,
    );
    await restoreToggle(
      app.cdp,
      settingId,
      expression,
      controlChecks[settingId].before,
    );
  }

  await selectCategory(app.cdp, "appearance");
  const originalTheme = await app.cdp.evaluate(preference("newTabTheme"));
  const nextTheme = originalTheme === "minimal" ? "overworld" : "minimal";
  await app.cdp.evaluate(`(() => {
    const select = document.querySelector('#setting-new-tab-theme select');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(select, '${nextTheme}');
    select?.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await poll(
    () => app.cdp.evaluate(preference("newTabTheme")),
    (value) => value === nextTheme,
    "the new tab theme to update",
  );
  controlChecks.theme = { before: originalTheme, after: nextTheme };

  await selectCategory(app.cdp, "hyperdrive");
  const originalMode = await app.cdp.evaluate(preference("hyperdriveMode"));
  if (originalMode === "off") {
    await app.cdp.evaluate(
      "document.querySelector('#setting-hyperdrive-enabled input[type=\"checkbox\"]')?.click()",
    );
    await poll(
      () => app.cdp.evaluate(preference("hyperdriveMode")),
      (value) => value === "balanced",
      "Hyperdrive to enable",
    );
  }
  await app.cdp.evaluate(`(() => {
    const select = document.querySelector('#setting-hyperdrive-mode select');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(select, 'aggressive');
    select?.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await poll(
    () => app.cdp.evaluate(preference("hyperdriveMode")),
    (value) => value === "aggressive",
    "Hyperdrive performance mode to update",
  );
  const originalRam = await app.cdp.evaluate(
    preference("hyperdriveRamBudgetMb"),
  );
  const nextRam = originalRam === 512 ? 576 : 512;
  await app.cdp.evaluate(`(() => {
    const range = document.querySelector('#setting-hyperdrive-ram input[type="range"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(range, '${nextRam}');
    range?.dispatchEvent(new Event('input', { bubbles: true }));
    range?.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await poll(
    () => app.cdp.evaluate(preference("hyperdriveRamBudgetMb")),
    (value) => value === nextRam,
    "the Hyperdrive RAM reserve to update",
  );
  if (
    !(await app.cdp.evaluate(
      preference("hyperdriveCrossSitePreloadingEnabled"),
    ))
  ) {
    await toggleSetting(
      app.cdp,
      "hyperdrive-cross-site",
      preference("hyperdriveCrossSitePreloadingEnabled"),
      "Cross-site preparation",
    );
  }
  controlChecks.hyperdriveSearch = await toggleSetting(
    app.cdp,
    "hyperdrive-search",
    preference("hyperdriveSearchPreloadingEnabled"),
    "Search destination preparation",
  );
  controlChecks.hyperdrive = {
    originalMode,
    originalRam,
    testedMode: "aggressive",
    testedRam: nextRam,
  };

  await selectCategory(app.cdp, "extensions");
  controlChecks.extensionDeveloperMode = await toggleSetting(
    app.cdp,
    "extension-developer-mode",
    preference("extensionDeveloperMode"),
    "Extension developer mode",
  );
  await restoreToggle(
    app.cdp,
    "extension-developer-mode",
    preference("extensionDeveloperMode"),
    controlChecks.extensionDeveloperMode.before,
  );

  await selectCategory(app.cdp, "advanced");
  const exclusionsBefore = await app.cdp.evaluate(
    preference("hyperdriveExcludedHosts"),
  );
  await app.cdp.evaluate(`(() => {
    const input = document.querySelector('#setting-hyperdrive-exclusions input');
    input?.focus();
    input?.select();
  })()`);
  await app.cdp.send("Input.insertText", { text: "settings-test.example" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await app.cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await app.cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  const exclusionsAfter = await poll(
    () => app.cdp.evaluate(preference("hyperdriveExcludedHosts")),
    (value) => Array.isArray(value) && value.includes("settings-test.example"),
    "Hyperdrive exclusions to update",
  );
  controlChecks.hyperdriveExclusions = {
    before: exclusionsBefore,
    after: exclusionsAfter,
  };
  for (const [settingId, key, description] of [
    ["hyperdrive-monitor", "hyperdriveMonitorOpen", "Hyperdrive Monitor"],
  ]) {
    controlChecks[settingId] = await toggleSetting(
      app.cdp,
      settingId,
      preference(key),
      description,
    );
    await restoreToggle(
      app.cdp,
      settingId,
      preference(key),
      controlChecks[settingId].before,
    );
  }
  const clearSpeculationAvailable = await app.cdp.evaluate(
    "Boolean(document.querySelector('#setting-clear-speculative-work button:not(:disabled)'))",
  );
  if (!clearSpeculationAvailable) {
    throw new Error(
      "Clear speculative work should be available while Hyperdrive is on.",
    );
  }
  await app.cdp.evaluate(
    "document.querySelector('#setting-clear-speculative-work button')?.click()",
  );

  app.cdp.close();
  await stop(app.child);
  app = await launch();
  const persistedRestoreSession = await poll(
    () =>
      app.cdp.evaluate(
        "window.chromecraft.getSnapshot().then((snapshot) => snapshot.preferences.restoreSession)",
      ),
    (value) => value === expectedRestoreSession,
    "the setting to persist after restart",
  );

  console.log(
    JSON.stringify(
      {
        pass: true,
        initialLayout,
        galleryEntryPoints,
        categoryChecks,
        smartDownloads,
        searchResult,
        searchNavigation,
        darkSurface,
        narrowLayout,
        controlChecks,
        persistedRestoreSession,
        artifacts,
      },
      null,
      2,
    ),
  );
} finally {
  app?.cdp?.close();
  await stop(app?.child);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => undefined);
}
