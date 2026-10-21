import { createHash } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = process.cwd();
const executable = path.join(
  root,
  "out",
  "Chromecraft-win32-x64",
  "chromecraft.exe",
);
const artifactDirectory = path.join(root, ".artifacts", "extensions");
const reportPath = path.join(artifactDirectory, "extension-actions.json");
const logPath = path.join(artifactDirectory, "extension-actions.log");
const extensionVersion = "1.0.0";
const keys = {
  action:
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAodUvL1S/bYu8yZIJwOFyIbRXlhVGoDyswPoHyFFT/hrBOVJMh+zfjkyjGsdTQQIb/ll5sJ2v0SKtTevnkCCxejHSk7sMBhMStB6VBgfCGDM2y4aA1FVYpW4OFCWVderfvQYCU0bA70acAlUDGOebXawQvc53AiQtUV33R2NPIIvYsu8tz9SiwcqB9pQzvf+uliXkKx+G/1xY12s5FvfFSsg32Fb/afUhLivOc3P27PIqy7XXQ6W1KduTctpnoQfmhplfnNWEMZcCq2oPz7QTR9evB4v/WJYwopnU95BrNLc8/sJVMFfpKvL+DaVrVUEPaiHvGa5ET95dEHS0fACQhQIDAQAB",
  browserAction:
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvlgkP62CnQApoP1HoTt6516c+SfgfVWKRqev8qhIJLnP/D6Lwmutc601+Sy9q7Yt3JyoVTUGAqmWNI5sHhS0Yubq5kbv7tc4faAO7BPSke8NDfDjLiSKCEdl4LZ0WcTYaGMynibynd+zKy6u2RgHW/goClPum36AOSwMTbMINXGlJCNd79Pk0I+MBlkUBYYM/7ayaZsCh3ABl5wZ8fhyNQKxO+DrZaM1PsVCrg5hWckYtikY3oNkETCHJ5Uek4iro4lQeZU77SWfBE96xSABmnRt45ljLY/dNfDfaq+kSyU3LYeLfCSU0ofsWiRLDz9fZh+PoHr6phEoViKZHasnzwIDAQAB",
  pageAction:
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApFBF9+FnksG/xig9aITZvdTaKYw9D3WuVt56W/aaNHDtDywWZUUAjSsnpF/KbRH2Qdc0I6if15edklHx0vLNhOMbl3jV9bhkUxS4DZmEfZ9kp533Ll2lErCxyXSZaILcRBlDgLXWUT7cS+NvQY9lA/g5kM7P8l6fu9gXO+NJDiLQBYHZplZG67q3WSeyREJHmbnc2Y3gLHFZnj21Zpy5BEwkTLY59+F8FqMEzygeqmlE/tiUHMdwS74Okc298Qh3Z44aMC0CCoVbDkuhnJOddQJunS0P2NhJUQWAd0pg+MLufN75LJPpYdd6ylrGEK2lkOtYIKvG5u1EO3VB9whRVwIDAQAB",
};

function extensionIdFromKey(base64Key) {
  return [
    ...createHash("sha256")
      .update(Buffer.from(base64Key, "base64"))
      .digest()
      .subarray(0, 16),
  ]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode("a".charCodeAt(0) + nibble))
    .join("");
}

const ids = Object.fromEntries(
  Object.entries(keys).map(([name, key]) => [name, extensionIdFromKey(key)]),
);
const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function poll(operation, predicate, description, timeoutMs = 20_000) {
  const startedAt = Date.now();
  let lastValue;
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastValue = await operation();
      if (predicate(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await delay(75);
  }
  throw new Error(
    `Timed out waiting for ${description}. ${lastError?.message ?? JSON.stringify(lastValue)}`,
  );
}

async function findFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string") {
    throw new Error("Could not reserve a DevTools port.");
  }
  return address.port;
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out.`));
      }, 20_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
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
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    }
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return response.json();
}

const targetList = (port) => fetchJson(`http://127.0.0.1:${port}/json/list`);

async function waitForTarget(port, predicate, description, timeoutMs = 30_000) {
  const targets = await poll(
    () => targetList(port),
    (items) => items.some(predicate),
    description,
    timeoutMs,
  );
  return targets.find(predicate);
}

async function terminate(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
    }).catch(() => child.kill());
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5_000),
  ]);
}

async function removeDisposableProfile(profile) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const resolvedProfile = path.resolve(profile);
  if (
    path.dirname(resolvedProfile) !== temporaryRoot ||
    !path.basename(resolvedProfile).startsWith("chromecraft-extension-actions-")
  ) {
    throw new Error("Refusing to remove a non-disposable extension profile.");
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rm(resolvedProfile, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 9) throw error;
      await delay(100 * (attempt + 1));
    }
  }
}

async function startFixture() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(requestUrl.pathname + requestUrl.search);
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(`<!doctype html>
      <html lang="en">
        <head><meta charset="utf-8"><title>Action conformance fixture</title></head>
        <body><main><h1 id="fixture-ready">Action conformance fixture</h1></main></body>
      </html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not start the action conformance fixture.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const popupHtml = (name) => `<!doctype html>
<html data-popup-ready="${name}"><head><meta charset="utf-8"><title>${name}</title></head>
<body><main id="popup-ready">${name}</main></body></html>`;

function probeSource(namespaceName, probeName, includeBadge, includeIsEnabled) {
  return `
const api = chrome[${JSON.stringify(namespaceName)}];
const invoke = (method, argument, omitArgument = false) => new Promise((resolve) => {
  if (!api || typeof api[method] !== "function") {
    resolve({ ok: false, error: method + " is unavailable" });
    return;
  }
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(result);
  };
  const timer = setTimeout(() => finish({ ok: false, error: method + " callback timed out" }), 1000);
  try {
    const callback = (value) => {
      const error = chrome.runtime.lastError;
      finish(error ? { ok: false, error: error.message } : { ok: true, value });
    };
    const returned = omitArgument
      ? api[method](callback)
      : api[method](argument, callback);
    if (returned && typeof returned.then === "function") {
      returned.then(
        (value) => finish({ ok: true, value }),
        (error) => finish({ ok: false, error: String(error) })
      );
    }
  } catch (error) {
    finish({ ok: false, error: String(error) });
  }
});
const read = async (tabId) => {
  const details = Number.isInteger(tabId) ? { tabId } : {};
  const result = {
    title: await invoke("getTitle", details),
    popup: await invoke("getPopup", details),
  };
  if (${JSON.stringify(includeBadge)}) {
    result.badgeText = await invoke("getBadgeText", details);
    result.badgeBackgroundColor = await invoke("getBadgeBackgroundColor", details);
  }
  if (${JSON.stringify(includeIsEnabled)}) {
    result.enabled = await invoke("isEnabled", tabId, !Number.isInteger(tabId));
  }
  return result;
};
chrome.tabs?.onCreated?.addListener(() => {});
globalThis[${JSON.stringify(probeName)}] = {
  surface: () => ({
    namespace: typeof api,
    setTitle: typeof api?.setTitle,
    getTitle: typeof api?.getTitle,
    setPopup: typeof api?.setPopup,
    getPopup: typeof api?.getPopup,
    setBadgeText: typeof api?.setBadgeText,
    getBadgeText: typeof api?.getBadgeText,
    setBadgeBackgroundColor: typeof api?.setBadgeBackgroundColor,
    getBadgeBackgroundColor: typeof api?.getBadgeBackgroundColor,
    enable: typeof api?.enable,
    disable: typeof api?.disable,
    isEnabled: typeof api?.isEnabled,
    openPopup: typeof api?.openPopup,
    show: typeof api?.show,
    hide: typeof api?.hide,
  }),
  read,
  setGlobal: async () => ({
    title: await invoke("setTitle", { title: "Global action title" }),
    popup: await invoke("setPopup", { popup: "global-popup.html" }),
    badgeText: await invoke("setBadgeText", { text: "42" }),
    badgeBackgroundColor: await invoke("setBadgeBackgroundColor", { color: [12, 34, 56, 255] }),
    disable: await invoke("disable", undefined, true),
  }),
  setPerTab: async (tabId) => ({
    title: await invoke("setTitle", { tabId, title: "Per-tab action title" }),
    popup: await invoke("setPopup", { tabId, popup: "per-tab-popup.html" }),
    badgeText: await invoke("setBadgeText", { tabId, text: "T" }),
    badgeBackgroundColor: await invoke("setBadgeBackgroundColor", { tabId, color: "#112233" }),
    enable: await invoke("enable", tabId),
  }),
  setPersistentState: async (tabId) => ({
    title: await invoke("setTitle", { title: "Persistent global title" }),
    popup: await invoke("setPopup", { popup: "persistent-popup.html" }),
    badgeText: await invoke("setBadgeText", { text: "P" }),
    badgeBackgroundColor: await invoke("setBadgeBackgroundColor", { color: [70, 80, 90, 255] }),
    enable: await invoke("enable", undefined, true),
    tabTitle: await invoke("setTitle", { tabId, title: "Persistent tab title" }),
    tabPopup: await invoke("setPopup", { tabId, popup: "per-tab-popup.html" }),
  }),
  disableTab: (tabId) => invoke("disable", tabId),
  enableGlobal: () => invoke("enable", undefined, true),
  openPopup: () => invoke("openPopup", {}),
  show: (tabId) => invoke("show", tabId),
  hide: (tabId) => invoke("hide", tabId),
};
`;
}

async function writeExtension(profile, id, manifest, files) {
  const extensionRoot = path.join(profile, "extensions", id, extensionVersion);
  await fs.mkdir(extensionRoot, { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(extensionRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    ),
    ...Object.entries(files).map(([name, contents]) =>
      fs.writeFile(path.join(extensionRoot, name), contents, "utf8"),
    ),
  ]);
}

async function seedExtensions(profile) {
  await writeExtension(
    profile,
    ids.action,
    {
      manifest_version: 3,
      name: "Chromecraft action conformance",
      description: "Packaged behavioral fixture for chrome.action.",
      version: extensionVersion,
      key: keys.action,
      permissions: ["storage", "tabs"],
      background: { service_worker: "worker.js" },
      action: {
        default_title: "Manifest action title",
        default_popup: "default-popup.html",
      },
    },
    {
      "worker.js": probeSource(
        "action",
        "__chromecraftActionProbe",
        true,
        true,
      ),
      "default-popup.html": popupHtml("default-popup"),
      "global-popup.html": popupHtml("global-popup"),
      "per-tab-popup.html": popupHtml("per-tab-popup"),
      "persistent-popup.html": popupHtml("persistent-popup"),
    },
  );
  await writeExtension(
    profile,
    ids.browserAction,
    {
      manifest_version: 2,
      name: "Chromecraft browserAction conformance",
      version: extensionVersion,
      key: keys.browserAction,
      permissions: ["tabs"],
      background: { scripts: ["background.js"], persistent: true },
      browser_action: {
        default_title: "Manifest browserAction title",
        default_popup: "default-popup.html",
      },
    },
    {
      "background.js": probeSource(
        "browserAction",
        "__chromecraftBrowserActionProbe",
        true,
        false,
      ),
      "default-popup.html": popupHtml("browser-action-popup"),
      "global-popup.html": popupHtml("browser-action-global-popup"),
      "per-tab-popup.html": popupHtml("browser-action-tab-popup"),
      "persistent-popup.html": popupHtml("browser-action-persistent-popup"),
    },
  );
  await writeExtension(
    profile,
    ids.pageAction,
    {
      manifest_version: 2,
      name: "Chromecraft pageAction conformance",
      version: extensionVersion,
      key: keys.pageAction,
      permissions: ["tabs"],
      background: { scripts: ["background.js"], persistent: true },
      page_action: {
        default_title: "Manifest pageAction title",
        default_popup: "default-popup.html",
      },
    },
    {
      "background.js": probeSource(
        "pageAction",
        "__chromecraftPageActionProbe",
        false,
        false,
      ),
      "default-popup.html": popupHtml("page-action-popup"),
      "global-popup.html": popupHtml("page-action-global-popup"),
      "per-tab-popup.html": popupHtml("page-action-tab-popup"),
      "persistent-popup.html": popupHtml("page-action-persistent-popup"),
    },
  );
  await fs.writeFile(
    path.join(profile, "extensions", "installed-extensions.json"),
    `${JSON.stringify(
      {
        version: 1,
        extensions: Object.entries(ids).map(([name, id]) => ({
          id,
          version: extensionVersion,
          enabled: true,
          sourceUrl: `https://chromewebstore.google.com/detail/${name}/${id}`,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(profile, "preferences.json"),
    `${JSON.stringify(
      { restoreSession: false, ublockEnabled: false, hyperdriveMode: "off" },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function check(name, passed, evidence, error = null, required = true) {
  return { name, passed, evidence, error: passed ? null : error, required };
}

const value = (result) => (result?.ok ? result.value : undefined);
const popupEndsWith = (result, filename) =>
  result?.ok === true &&
  typeof result.value === "string" &&
  result.value.endsWith(`/${filename}`);
const colorEquals = (result, expected) =>
  result?.ok === true &&
  Array.isArray(result.value) &&
  result.value.length === expected.length &&
  result.value.every((channel, index) => channel === expected[index]);

const toolbarExpression = (extensionId) => `(() => {
  const button = document.querySelector(${JSON.stringify(`[data-extension-action="${extensionId}"]`)});
  if (!(button instanceof HTMLButtonElement)) return null;
  const badge = button.querySelector("[data-extension-action-badge]");
  return {
    title: button.title,
    ariaLabel: button.getAttribute("aria-label"),
    disabled: button.disabled,
    badgeText: badge?.textContent ?? null,
    badgeBackground: badge ? getComputedStyle(badge).backgroundColor : null,
  };
})()`;

async function settledToolbarState(
  shell,
  extensionId,
  predicate,
  timeoutMs = 3_000,
) {
  try {
    return await poll(
      () => shell.evaluate(toolbarExpression(extensionId)),
      predicate,
      `toolbar state for extension ${extensionId}`,
      timeoutMs,
    );
  } catch {
    return shell.evaluate(toolbarExpression(extensionId));
  }
}

await fs.access(executable);
await fs.mkdir(artifactDirectory, { recursive: true });
const startedAt = new Date().toISOString();
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "chromecraft-extension-actions-"),
);
const fixture = await startFixture();
await seedExtensions(profile);
const debugPort = await findFreePort();
const child = spawn(
  executable,
  [
    `--chromecraft-user-data=${profile}`,
    `--user-data-dir=${profile}`,
    `--chromecraft-smoke-url=${fixture.origin}/first`,
    `--remote-debugging-port=${debugPort}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
  ],
  {
    cwd: root,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  },
);
let log = "";
child.stdout.on("data", (chunk) => (log += chunk.toString()));
child.stderr.on("data", (chunk) => (log += chunk.toString()));

const checks = [];
let shell;
let worker;
let restartedWorker;
let browserActionBackground;
let pageActionBackground;
let popup;
let fatalError = null;
let actionEvidence = null;
let restartEvidence = null;
try {
  const shellTarget = await waitForTarget(
    debugPort,
    (target) =>
      target.type === "page" &&
      !target.url.startsWith("chrome-extension://") &&
      (target.url.startsWith("file://") || target.url.includes("main_window")),
    "the Chromecraft shell target",
    45_000,
  );
  shell = await CdpClient.connect(shellTarget.webSocketDebuggerUrl);
  const initialized = await poll(
    () =>
      shell.evaluate(`(async () => ({
        browser: await window.chromecraft?.getSnapshot(),
        extensions: await window.chromecraft?.getExtensions()
      }))()`),
    (result) =>
      Boolean(result?.browser?.activeTabId) &&
      result?.extensions?.initialized === true &&
      Object.values(ids).every((id) =>
        result.extensions.items.some(
          (item) => item.id === id && item.ready === true,
        ),
      ),
    "all action conformance extensions to become ready",
    45_000,
  );
  const firstBrowserTabId = initialized.browser.activeTabId;
  await shell.evaluate(
    `window.chromecraft.navigate(${JSON.stringify(firstBrowserTabId)}, ${JSON.stringify(`${fixture.origin}/first`)})`,
  );
  await poll(
    () => shell.evaluate(`window.chromecraft.getSnapshot()`),
    (snapshot) => {
      const tab = snapshot?.tabs?.find((item) => item.id === firstBrowserTabId);
      return tab?.url === `${fixture.origin}/first` && tab?.isLoading === false;
    },
    "the first fixture tab to finish loading",
  );

  const workerTarget = await waitForTarget(
    debugPort,
    (target) =>
      target.type === "service_worker" &&
      target.url.startsWith(`chrome-extension://${ids.action}/`),
    "the chrome.action MV3 service worker",
  );
  worker = await CdpClient.connect(workerTarget.webSocketDebuggerUrl);
  await worker.send("Runtime.enable");
  await poll(
    () => worker.evaluate(`Boolean(globalThis.__chromecraftActionProbe)`),
    (ready) => ready === true,
    "the action worker probe",
  );

  const surface = await worker.evaluate(
    `globalThis.__chromecraftActionProbe.surface()`,
  );
  const requiredActionMethods = [
    "setTitle",
    "getTitle",
    "setPopup",
    "getPopup",
    "setBadgeText",
    "getBadgeText",
    "setBadgeBackgroundColor",
    "getBadgeBackgroundColor",
    "enable",
    "disable",
    "isEnabled",
    "openPopup",
  ];
  checks.push(
    check(
      "chrome.action exposes the complete state and popup method surface",
      surface.namespace === "object" &&
        requiredActionMethods.every((name) => surface[name] === "function"),
      surface,
      "One or more required chrome.action methods are unavailable.",
    ),
  );

  const [firstExtensionTab] = await worker.evaluate(
    `chrome.tabs.query({ active: true })`,
  );
  const firstExtensionTabId = firstExtensionTab?.id ?? null;
  const baseline = await worker.evaluate(
    `globalThis.__chromecraftActionProbe.read(${JSON.stringify(firstExtensionTabId)})`,
  );
  const baselinePassed =
    value(baseline.title) === "Manifest action title" &&
    popupEndsWith(baseline.popup, "default-popup.html") &&
    value(baseline.badgeText) === "" &&
    value(baseline.enabled) === true;
  checks.push(
    check(
      "chrome.action getters expose manifest defaults",
      baselinePassed,
      baseline,
      "Manifest title, popup, empty badge, or enabled default did not round-trip.",
    ),
  );

  const globalSet = await worker.evaluate(
    `globalThis.__chromecraftActionProbe.setGlobal()`,
  );
  const globalState = await worker.evaluate(
    `globalThis.__chromecraftActionProbe.read(${JSON.stringify(firstExtensionTabId)})`,
  );
  const globalPassed =
    Object.values(globalSet).every((result) => result.ok === true) &&
    value(globalState.title) === "Global action title" &&
    popupEndsWith(globalState.popup, "global-popup.html") &&
    value(globalState.badgeText) === "42" &&
    colorEquals(globalState.badgeBackgroundColor, [12, 34, 56, 255]) &&
    value(globalState.enabled) === false;
  checks.push(
    check(
      "global action title, popup, badge, color, and enablement round-trip",
      globalPassed,
      { setters: globalSet, state: globalState },
      "One or more global action setters were not observable through the matching getter.",
    ),
  );

  const secondBrowserTabId = await shell.evaluate(
    `window.chromecraft.createTab(${JSON.stringify(`${fixture.origin}/second`)})`,
  );
  await poll(
    () => shell.evaluate(`window.chromecraft.getSnapshot()`),
    (snapshot) => {
      const tab = snapshot?.tabs?.find(
        (item) => item.id === secondBrowserTabId,
      );
      return (
        tab?.url === `${fixture.origin}/second` && tab?.isLoading === false
      );
    },
    "the second fixture tab to finish loading",
  );
  const activeAfterCreate = await worker.evaluate(
    `chrome.tabs.query({ active: true })`,
  );
  const secondExtensionTabId = activeAfterCreate[0]?.id ?? null;
  const perTabSet = await worker.evaluate(
    `globalThis.__chromecraftActionProbe.setPerTab(${JSON.stringify(firstExtensionTabId)})`,
  );
  const firstState = await worker.evaluate(
    `globalThis.__chromecraftActionProbe.read(${JSON.stringify(firstExtensionTabId)})`,
  );
  const secondState = await worker.evaluate(
    `globalThis.__chromecraftActionProbe.read(${JSON.stringify(secondExtensionTabId)})`,
  );
  const perTabPassed =
    firstExtensionTabId !== secondExtensionTabId &&
    Object.values(perTabSet).every((result) => result.ok === true) &&
    value(firstState.title) === "Per-tab action title" &&
    popupEndsWith(firstState.popup, "per-tab-popup.html") &&
    value(firstState.badgeText) === "T" &&
    colorEquals(firstState.badgeBackgroundColor, [17, 34, 51, 255]) &&
    value(firstState.enabled) === true &&
    value(secondState.title) === "Global action title" &&
    popupEndsWith(secondState.popup, "global-popup.html") &&
    value(secondState.badgeText) === "42" &&
    value(secondState.enabled) === false;
  actionEvidence = {
    firstBrowserTabId,
    firstExtensionTabId,
    secondBrowserTabId,
    secondExtensionTabId,
    setters: perTabSet,
    firstState,
    secondState,
  };
  checks.push(
    check(
      "per-tab action state overrides global state without leaking to another tab",
      perTabPassed,
      actionEvidence,
      "Per-tab title, popup, badge, color, or enabled state was not isolated from global state.",
    ),
  );

  const disabled = await worker.evaluate(
    `globalThis.__chromecraftActionProbe.disableTab(${JSON.stringify(firstExtensionTabId)})`,
  );
  const disabledState = await worker.evaluate(
    `globalThis.__chromecraftActionProbe.read(${JSON.stringify(firstExtensionTabId)})`,
  );
  const enabledGlobal = await worker.evaluate(
    `globalThis.__chromecraftActionProbe.enableGlobal()`,
  );
  const afterGlobalEnable = await worker.evaluate(
    `Promise.all([
      globalThis.__chromecraftActionProbe.read(${JSON.stringify(firstExtensionTabId)}),
      globalThis.__chromecraftActionProbe.read(${JSON.stringify(secondExtensionTabId)})
    ])`,
  );
  checks.push(
    check(
      "action enable, disable, and isEnabled honor global and per-tab scopes",
      disabled.ok === true &&
        value(disabledState.enabled) === false &&
        enabledGlobal.ok === true &&
        afterGlobalEnable.every((state) => value(state.enabled) === true),
      { disabled, disabledState, enabledGlobal, afterGlobalEnable },
      "Enablement changes did not round-trip at both scopes.",
    ),
  );

  await worker.evaluate(
    `globalThis.__chromecraftActionProbe.setPerTab(${JSON.stringify(firstExtensionTabId)})`,
  );
  await shell.evaluate(
    `window.chromecraft.activateTab(${JSON.stringify(firstBrowserTabId)})`,
  );
  const toolbarState = await settledToolbarState(
    shell,
    ids.action,
    (state) =>
      state?.title === "Per-tab action title" && state?.badgeText === "T",
  );
  checks.push(
    check(
      "Browser Shell toolbar renders active-tab title, badge, color, and enabled state",
      toolbarState.title === "Per-tab action title" &&
        toolbarState.disabled === false &&
        toolbarState.badgeText === "T" &&
        typeof toolbarState.badgeBackground === "string" &&
        toolbarState.badgeBackground.length > 0,
      toolbarState,
      "The Browser Shell action button did not render the extension-owned active-tab state.",
    ),
  );

  const openPopupResult = await worker.evaluate(
    `globalThis.__chromecraftActionProbe.openPopup()`,
  );
  const popupTarget = await waitForTarget(
    debugPort,
    (target) =>
      target.type === "page" &&
      target.url === `chrome-extension://${ids.action}/per-tab-popup.html`,
    "programmatic chrome.action.openPopup to show the per-tab popup",
    5_000,
  ).catch(() => null);
  let popupState = null;
  if (popupTarget) {
    popup = await CdpClient.connect(popupTarget.webSocketDebuggerUrl);
    popupState = await popup.evaluate(`({
      ready: document.documentElement.dataset.popupReady,
      text: document.querySelector("#popup-ready")?.textContent ?? null
    })`);
  }
  checks.push(
    check(
      "chrome.action.openPopup opens the active tab's dynamic popup",
      openPopupResult.ok === true &&
        popupTarget !== null &&
        popupState?.ready === "per-tab-popup",
      { openPopupResult, popupUrl: popupTarget?.url ?? null, popupState },
      "openPopup did not produce a rendered anchored popup using the active tab override.",
    ),
  );
  popup?.close();
  popup = null;
  await shell.evaluate(`window.chromecraft.closeExtensionPopup()`);

  const persistentSet = await worker.evaluate(
    `globalThis.__chromecraftActionProbe.setPersistentState(${JSON.stringify(firstExtensionTabId)})`,
  );
  worker.close();
  worker = null;
  const browserVersion = await fetchJson(
    `http://127.0.0.1:${debugPort}/json/version`,
  );
  const browser = await CdpClient.connect(browserVersion.webSocketDebuggerUrl);
  let workerStopped = false;
  try {
    const stopped = await browser.send("Target.closeTarget", {
      targetId: workerTarget.id,
    });
    workerStopped = stopped?.success === true;
  } finally {
    browser.close();
  }
  if (workerStopped) {
    await poll(
      () => targetList(debugPort),
      (targets) => !targets.some((target) => target.id === workerTarget.id),
      "the action worker to stop",
      10_000,
    );
  }
  const wakeBrowserTabId = await shell.evaluate(
    `window.chromecraft.createTab(${JSON.stringify(`${fixture.origin}/wake`)})`,
  );
  const restartedTarget = workerStopped
    ? await waitForTarget(
        debugPort,
        (target) =>
          target.type === "service_worker" &&
          target.id !== workerTarget.id &&
          target.url.startsWith(`chrome-extension://${ids.action}/`),
        "a tab event to restart the action worker",
        10_000,
      ).catch(() => null)
    : null;
  let restartedState = null;
  if (restartedTarget) {
    restartedWorker = await CdpClient.connect(
      restartedTarget.webSocketDebuggerUrl,
    );
    await restartedWorker.send("Runtime.enable");
    restartedState = await poll(
      () =>
        restartedWorker.evaluate(
          `globalThis.__chromecraftActionProbe?.read(${JSON.stringify(firstExtensionTabId)})`,
        ),
      (state) => Boolean(state),
      "the restarted worker action state probe",
      10_000,
    ).catch((error) => ({ error: error.message }));
  }
  restartEvidence = {
    persistentSet,
    workerStopped,
    restartedTarget: restartedTarget
      ? { id: restartedTarget.id, url: restartedTarget.url }
      : null,
    restartedState,
  };
  const persisted =
    workerStopped &&
    restartedTarget !== null &&
    Object.values(persistentSet).every((result) => result.ok === true) &&
    value(restartedState?.title) === "Persistent tab title" &&
    popupEndsWith(restartedState?.popup, "per-tab-popup.html") &&
    value(restartedState?.badgeText) === "P" &&
    colorEquals(restartedState?.badgeBackgroundColor, [70, 80, 90, 255]) &&
    value(restartedState?.enabled) === true;
  checks.push(
    check(
      "action state survives MV3 service-worker termination and restart",
      persisted,
      restartEvidence,
      "Browser-owned action state was lost or unavailable after the worker restarted.",
      workerStopped,
    ),
  );
  await shell.evaluate(
    `window.chromecraft.closeTab(${JSON.stringify(wakeBrowserTabId)})`,
  );

  const targets = await targetList(debugPort);
  const browserActionTarget = targets.find(
    (target) =>
      target.url.startsWith(`chrome-extension://${ids.browserAction}/`) &&
      target.type !== "service_worker",
  );
  if (browserActionTarget) {
    browserActionBackground = await CdpClient.connect(
      browserActionTarget.webSocketDebuggerUrl,
    );
    await browserActionBackground.send("Runtime.enable");
  }
  const browserActionSurface = browserActionBackground
    ? await browserActionBackground.evaluate(
        `globalThis.__chromecraftBrowserActionProbe?.surface()`,
      )
    : null;
  const browserActionSet = browserActionBackground
    ? await browserActionBackground.evaluate(
        `globalThis.__chromecraftBrowserActionProbe?.setGlobal()`,
      )
    : null;
  const browserActionState = browserActionBackground
    ? await browserActionBackground.evaluate(
        `globalThis.__chromecraftBrowserActionProbe?.read()`,
      )
    : null;
  const browserActionToolbar = await settledToolbarState(
    shell,
    ids.browserAction,
    (state) => state?.disabled === true,
  );
  checks.push(
    check(
      "MV2 chrome.browserAction aliases preserve dynamic action state",
      browserActionSurface?.namespace === "object" &&
        browserActionSet &&
        Object.values(browserActionSet).every((result) => result.ok === true) &&
        value(browserActionState?.title) === "Global action title" &&
        popupEndsWith(browserActionState?.popup, "global-popup.html") &&
        value(browserActionState?.badgeText) === "42" &&
        colorEquals(
          browserActionState?.badgeBackgroundColor,
          [12, 34, 56, 255],
        ) &&
        browserActionToolbar?.disabled === true,
      {
        target: browserActionTarget
          ? { type: browserActionTarget.type, url: browserActionTarget.url }
          : null,
        surface: browserActionSurface,
        setters: browserActionSet,
        state: browserActionState,
        toolbar: browserActionToolbar,
      },
      "The legacy browserAction namespace did not expose equivalent state behavior.",
    ),
  );

  const pageActionTarget = targets.find(
    (target) =>
      target.url.startsWith(`chrome-extension://${ids.pageAction}/`) &&
      target.type !== "service_worker",
  );
  if (pageActionTarget) {
    pageActionBackground = await CdpClient.connect(
      pageActionTarget.webSocketDebuggerUrl,
    );
    await pageActionBackground.send("Runtime.enable");
  }
  const pageActionSurface = pageActionBackground
    ? await pageActionBackground.evaluate(
        `globalThis.__chromecraftPageActionProbe?.surface()`,
      )
    : null;
  const pageActionSet = pageActionBackground
    ? await pageActionBackground.evaluate(
        `globalThis.__chromecraftPageActionProbe?.setPerTab(${JSON.stringify(firstExtensionTabId)})`,
      )
    : null;
  const pageActionState = pageActionBackground
    ? await pageActionBackground.evaluate(
        `globalThis.__chromecraftPageActionProbe?.read(${JSON.stringify(firstExtensionTabId)})`,
      )
    : null;
  let pageActionVisibility = null;
  if (pageActionBackground) {
    const hide = await pageActionBackground.evaluate(
      `globalThis.__chromecraftPageActionProbe?.hide(${JSON.stringify(firstExtensionTabId)})`,
    );
    const afterHide = await settledToolbarState(
      shell,
      ids.pageAction,
      (state) => state?.disabled === true,
    );
    const show = await pageActionBackground.evaluate(
      `globalThis.__chromecraftPageActionProbe?.show(${JSON.stringify(firstExtensionTabId)})`,
    );
    const afterShow = await settledToolbarState(
      shell,
      ids.pageAction,
      (state) => state?.disabled === false,
    );
    pageActionVisibility = { hide, afterHide, show, afterShow };
  }
  checks.push(
    check(
      "MV2 chrome.pageAction aliases preserve title, popup, show, and hide behavior",
      pageActionSurface?.namespace === "object" &&
        pageActionSet?.title?.ok === true &&
        pageActionSet?.popup?.ok === true &&
        value(pageActionState?.title) === "Per-tab action title" &&
        popupEndsWith(pageActionState?.popup, "per-tab-popup.html") &&
        pageActionVisibility?.hide?.ok === true &&
        pageActionVisibility?.afterHide?.disabled === true &&
        pageActionVisibility?.show?.ok === true &&
        pageActionVisibility?.afterShow?.disabled === false,
      {
        target: pageActionTarget
          ? { type: pageActionTarget.type, url: pageActionTarget.url }
          : null,
        surface: pageActionSurface,
        setters: pageActionSet,
        state: pageActionState,
        visibility: pageActionVisibility,
      },
      "The legacy pageAction namespace did not preserve title, popup, and visibility operations.",
    ),
  );
} catch (error) {
  fatalError = error.stack ?? error.message;
} finally {
  popup?.close();
  pageActionBackground?.close();
  browserActionBackground?.close();
  restartedWorker?.close();
  worker?.close();
  shell?.close();
  await terminate(child);
  await fixture.close();
  await fs.writeFile(logPath, log, "utf8");
}

const requiredChecks = checks.filter((item) => item.required !== false);
const failedChecks = requiredChecks.filter((item) => item.passed !== true);
const report = {
  schemaVersion: 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  success: fatalError === null && failedChecks.length === 0,
  packagedExecutable: path.relative(root, executable),
  fixture: {
    extensionVersion,
    ids,
    origin: fixture.origin,
    requests: fixture.requests,
  },
  summary: {
    passed: requiredChecks.length - failedChecks.length,
    failed: failedChecks.length,
    total: requiredChecks.length,
  },
  checks,
  actionEvidence,
  restartEvidence,
  fatalError,
};
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await removeDisposableProfile(profile);
console.log(JSON.stringify(report, null, 2));
if (!report.success) process.exitCode = 1;
