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

async function startFixture(label = "primary") {
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
        <head><meta charset="utf-8"><title>Action conformance fixture: ${label}</title></head>
        <body data-fixture="${label}"><main><h1 id="fixture-ready">Action conformance fixture: ${label}</h1></main></body>
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
const clickStorageKey = ${JSON.stringify(`chromecraft-clicks-${namespaceName}`)};
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
const storageGet = (key) => new Promise((resolve) => {
  chrome.storage.local.get(key, (items) => resolve(items?.[key] ?? []));
});
const storageSet = (key, value) => new Promise((resolve) => {
  chrome.storage.local.set({ [key]: value }, () => resolve());
});
const attemptInjection = async (tabId, marker) => {
  if (!chrome.scripting?.executeScript) {
    return { ok: false, error: "chrome.scripting.executeScript is unavailable" };
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (value) => {
        document.documentElement.dataset.chromecraftActionClick = value;
        return location.href;
      },
      args: [marker],
    });
    return { ok: true, results };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
};
if (api?.onClicked?.addListener) {
  api.onClicked.addListener(async (tab) => {
    const record = {
      tab: {
        id: tab?.id ?? null,
        url: tab?.url ?? null,
        title: tab?.title ?? null,
        active: tab?.active ?? null,
        windowId: tab?.windowId ?? null,
        index: tab?.index ?? null,
        status: tab?.status ?? null,
      },
      injection: ${JSON.stringify(namespaceName)} === "action"
        ? await attemptInjection(tab?.id, "clicked-" + Date.now())
        : { ok: true, skipped: true },
    };
    const clicks = await storageGet(clickStorageKey);
    clicks.push(record);
    await storageSet(clickStorageKey, clicks);
  });
}
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
    onClicked: typeof api?.onClicked,
    onClickedAddListener: typeof api?.onClicked?.addListener,
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
  configurePopupLess: async (tabId) => ({
    globalPopup: await invoke("setPopup", { popup: "" }),
    tabPopup: await invoke("setPopup", { tabId, popup: "" }),
    globalEnable: typeof api?.enable === "function"
      ? await invoke("enable", undefined, true)
      : { ok: true, skipped: true },
    tabEnable: typeof api?.enable === "function"
      ? await invoke("enable", tabId)
      : { ok: true, skipped: true },
  }),
  setPopupForTab: (tabId, popup) => invoke("setPopup", { tabId, popup }),
  clicks: () => storageGet(clickStorageKey),
  resetClicks: async () => {
    await storageSet(clickStorageKey, []);
    return { ok: true };
  },
  attemptInjection,
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
      permissions: ["storage", "tabs", "scripting", "activeTab"],
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
      permissions: ["storage", "tabs"],
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
      permissions: ["storage", "tabs"],
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

async function dispatchRealToolbarClick(shell, extensionId) {
  const hitTarget = await shell.evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(
      `[data-extension-action="${extensionId}"]`,
    )});
    if (!(button instanceof HTMLButtonElement)) return null;
    const rect = button.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
      disabled: button.disabled,
      popupExpanded: button.getAttribute("aria-expanded"),
    };
  })()`);
  if (!hitTarget || hitTarget.width <= 0 || hitTarget.height <= 0) {
    return { dispatched: false, hitTarget };
  }
  await shell.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: hitTarget.x,
    y: hitTarget.y,
  });
  await shell.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: hitTarget.x,
    y: hitTarget.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await shell.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: hitTarget.x,
    y: hitTarget.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  return { dispatched: true, hitTarget };
}

async function readClicks(client, probeName) {
  if (!client) return [];
  return (
    (await client.evaluate(
      `globalThis[${JSON.stringify(probeName)}]?.clicks?.()`,
    )) ?? []
  );
}

async function waitForClicks(client, probeName, count, timeoutMs = 3_000) {
  try {
    return await poll(
      () => readClicks(client, probeName),
      (clicks) => Array.isArray(clicks) && clicks.length >= count,
      `${probeName} to record ${count} toolbar click(s)`,
      timeoutMs,
    );
  } catch {
    return readClicks(client, probeName);
  }
}

async function connectPage(port, url, description) {
  const target = await waitForTarget(
    port,
    (candidate) => candidate.type === "page" && candidate.url === url,
    description,
  );
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  return { target, client };
}

await fs.access(executable);
await fs.mkdir(artifactDirectory, { recursive: true });
const startedAt = new Date().toISOString();
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "chromecraft-extension-actions-"),
);
const fixture = await startFixture("primary");
const crossOriginFixture = await startFixture("cross-origin");
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
let actionClickWorker;
let activePage;
let crossOriginPage;
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
    await shell.evaluate(
      `window.chromecraft.activateTab(${JSON.stringify(firstBrowserTabId)})`,
    );
    await settledToolbarState(
      shell,
      ids.pageAction,
      (state) => state?.title === "Per-tab action title",
    );
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

  // Toolbar-click conformance is tested at the packaged Browser Shell boundary.
  // Input.dispatchMouseEvent is used instead of HTMLElement.click(), so the
  // browser receives an actual trusted pointer gesture at the rendered action.
  await shell.evaluate(
    `window.chromecraft.activateTab(${JSON.stringify(firstBrowserTabId)})`,
  );
  const currentActionTarget = await waitForTarget(
    debugPort,
    (target) =>
      target.type === "service_worker" &&
      target.url.startsWith(`chrome-extension://${ids.action}/`),
    "an active chrome.action worker for click conformance",
  );
  actionClickWorker = await CdpClient.connect(
    currentActionTarget.webSocketDebuggerUrl,
  );
  await actionClickWorker.send("Runtime.enable");
  await poll(
    () =>
      actionClickWorker.evaluate(
        `Boolean(globalThis.__chromecraftActionProbe)`,
      ),
    (ready) => ready === true,
    "the action click probe",
  );
  const clickSurface = await actionClickWorker.evaluate(
    `globalThis.__chromecraftActionProbe.surface()`,
  );
  checks.push(
    check(
      "chrome.action.onClicked exposes a listener surface",
      clickSurface.onClicked === "object" &&
        clickSurface.onClickedAddListener === "function",
      clickSurface,
      "chrome.action.onClicked.addListener is unavailable.",
    ),
  );

  const popupLessConfiguration = await actionClickWorker.evaluate(
    `globalThis.__chromecraftActionProbe.configurePopupLess(${JSON.stringify(firstExtensionTabId)})`,
  );
  await actionClickWorker.evaluate(
    `globalThis.__chromecraftActionProbe.resetClicks()`,
  );
  const primaryUrl = `${fixture.origin}/first`;
  const primaryConnection = await connectPage(
    debugPort,
    primaryUrl,
    "the primary action fixture page",
  );
  activePage = primaryConnection.client;
  const beforeClickInjection = await actionClickWorker.evaluate(
    `globalThis.__chromecraftActionProbe.attemptInjection(${JSON.stringify(firstExtensionTabId)}, "before-click")`,
  );
  const beforeClickMarker = await activePage.evaluate(
    `document.documentElement.dataset.chromecraftActionClick ?? null`,
  );
  const popupLessToolbar = await settledToolbarState(
    shell,
    ids.action,
    (state) => state?.disabled === false,
  );
  const firstRealClick = await dispatchRealToolbarClick(shell, ids.action);
  const firstClickRecords = await waitForClicks(
    actionClickWorker,
    "__chromecraftActionProbe",
    1,
    5_000,
  );
  const firstClick = firstClickRecords[0] ?? null;
  const afterClickMarker = await activePage.evaluate(
    `document.documentElement.dataset.chromecraftActionClick ?? null`,
  );
  checks.push(
    check(
      "popup-less MV3 toolbar click dispatches onClicked with the real active tab",
      popupLessToolbar?.disabled === false &&
        firstRealClick.dispatched === true &&
        firstClickRecords.length === 1 &&
        firstClick?.tab?.id === firstExtensionTabId &&
        firstClick?.tab?.url === primaryUrl &&
        firstClick?.tab?.title === "Action conformance fixture: primary" &&
        firstClick?.tab?.active === true &&
        Number.isInteger(firstClick?.tab?.windowId) &&
        Number.isInteger(firstClick?.tab?.index),
      {
        configuration: popupLessConfiguration,
        toolbar: popupLessToolbar,
        pointer: firstRealClick,
        records: firstClickRecords,
      },
      "The popup-less Browser Shell action did not deliver one onClicked event with the authoritative active-tab payload.",
    ),
  );
  checks.push(
    check(
      "activeTab is unavailable before a click and permits scripting after the real click",
      beforeClickInjection?.ok === false &&
        beforeClickMarker === null &&
        firstClick?.injection?.ok === true &&
        typeof afterClickMarker === "string" &&
        afterClickMarker.startsWith("clicked-"),
      {
        beforeClickInjection,
        beforeClickMarker,
        clickInjection: firstClick?.injection ?? null,
        afterClickMarker,
      },
      "The action click did not establish a temporary, observable activeTab scripting grant (or scripting was over-granted before the click).",
    ),
  );

  activePage.close();
  activePage = null;
  const crossOriginUrl = `${crossOriginFixture.origin}/after-navigation`;
  await shell.evaluate(
    `window.chromecraft.navigate(${JSON.stringify(firstBrowserTabId)}, ${JSON.stringify(crossOriginUrl)})`,
  );
  await poll(
    () => shell.evaluate(`window.chromecraft.getSnapshot()`),
    (snapshot) => {
      const tab = snapshot?.tabs?.find((item) => item.id === firstBrowserTabId);
      return tab?.url === crossOriginUrl && tab?.isLoading === false;
    },
    "the active tab to finish its cross-origin navigation",
  );
  const crossConnection = await connectPage(
    debugPort,
    crossOriginUrl,
    "the cross-origin action fixture page",
  );
  crossOriginPage = crossConnection.client;
  const afterNavigationInjection = await actionClickWorker.evaluate(
    `globalThis.__chromecraftActionProbe.attemptInjection(${JSON.stringify(firstExtensionTabId)}, "after-navigation")`,
  );
  const afterNavigationMarker = await crossOriginPage.evaluate(
    `document.documentElement.dataset.chromecraftActionClick ?? null`,
  );
  checks.push(
    check(
      "activeTab scripting grant is revoked on cross-origin navigation",
      firstClick?.injection?.ok === true &&
        afterNavigationInjection?.ok === false &&
        afterNavigationMarker === null,
      {
        grantedByClick: firstClick?.injection ?? null,
        afterNavigationInjection,
        afterNavigationMarker,
        crossOriginUrl,
      },
      "The extension retained scripting access after the granted tab crossed origins.",
    ),
  );

  const closeRevocationUrl = `${fixture.origin}/close-revocation`;
  const closeRevocationBrowserTabId = await shell.evaluate(
    `window.chromecraft.createTab(${JSON.stringify(closeRevocationUrl)})`,
  );
  await poll(
    () => shell.evaluate(`window.chromecraft.getSnapshot()`),
    (snapshot) => {
      const tab = snapshot?.tabs?.find(
        (item) => item.id === closeRevocationBrowserTabId,
      );
      return tab?.url === closeRevocationUrl && tab?.isLoading === false;
    },
    "the close-revocation fixture tab",
  );
  const [closeRevocationExtensionTab] = await actionClickWorker.evaluate(
    `chrome.tabs.query({ active: true })`,
  );
  const closeRevocationExtensionTabId = closeRevocationExtensionTab?.id ?? null;
  await actionClickWorker.evaluate(
    `globalThis.__chromecraftActionProbe.configurePopupLess(${JSON.stringify(closeRevocationExtensionTabId)})`,
  );
  const closeTabClick = await dispatchRealToolbarClick(shell, ids.action);
  const closeTabRecords = await waitForClicks(
    actionClickWorker,
    "__chromecraftActionProbe",
    2,
    5_000,
  );
  await shell.evaluate(
    `window.chromecraft.closeTab(${JSON.stringify(closeRevocationBrowserTabId)})`,
  );
  const afterCloseInjection = await actionClickWorker.evaluate(
    `globalThis.__chromecraftActionProbe.attemptInjection(${JSON.stringify(closeRevocationExtensionTabId)}, "after-close")`,
  );
  checks.push(
    check(
      "activeTab scripting grant is discarded when the granted tab closes",
      closeTabClick.dispatched === true &&
        closeTabRecords.some(
          (record) =>
            record?.tab?.id === closeRevocationExtensionTabId &&
            record?.injection?.ok === true,
        ) &&
        afterCloseInjection?.ok === false,
      {
        tabId: closeRevocationExtensionTabId,
        pointer: closeTabClick,
        records: closeTabRecords,
        afterCloseInjection,
      },
      "The close-path did not first grant and then revoke access to the clicked tab.",
    ),
  );

  await shell.evaluate(
    `window.chromecraft.activateTab(${JSON.stringify(firstBrowserTabId)})`,
  );
  await actionClickWorker.evaluate(
    `globalThis.__chromecraftActionProbe.resetClicks()`,
  );
  const popupConfiguration = await actionClickWorker.evaluate(
    `globalThis.__chromecraftActionProbe.setPopupForTab(${JSON.stringify(firstExtensionTabId)}, "per-tab-popup.html")`,
  );
  const popupClick = await dispatchRealToolbarClick(shell, ids.action);
  const clickPopupTarget = await waitForTarget(
    debugPort,
    (target) =>
      target.type === "page" &&
      target.url === `chrome-extension://${ids.action}/per-tab-popup.html`,
    "the click-opened action popup",
    5_000,
  ).catch(() => null);
  await delay(300);
  const popupSuppressedClicks = await readClicks(
    actionClickWorker,
    "__chromecraftActionProbe",
  );
  checks.push(
    check(
      "a configured popup opens and suppresses chrome.action.onClicked",
      popupConfiguration?.ok === true &&
        popupClick.dispatched === true &&
        clickPopupTarget !== null &&
        popupSuppressedClicks.length === 0,
      {
        popupConfiguration,
        pointer: popupClick,
        popupUrl: clickPopupTarget?.url ?? null,
        clickRecords: popupSuppressedClicks,
      },
      "The click failed to open the configured popup, or incorrectly dispatched onClicked as well.",
    ),
  );
  await shell.evaluate(`window.chromecraft.closeExtensionPopup()`);

  await actionClickWorker.evaluate(
    `globalThis.__chromecraftActionProbe.configurePopupLess(${JSON.stringify(firstExtensionTabId)})`,
  );
  await actionClickWorker.evaluate(
    `globalThis.__chromecraftActionProbe.resetClicks()`,
  );
  const disableForSuppression = await actionClickWorker.evaluate(
    `globalThis.__chromecraftActionProbe.disableTab(${JSON.stringify(firstExtensionTabId)})`,
  );
  const disabledToolbar = await settledToolbarState(
    shell,
    ids.action,
    (state) => state?.disabled === true,
  );
  const disabledClick = await dispatchRealToolbarClick(shell, ids.action);
  await delay(300);
  const disabledClickRecords = await readClicks(
    actionClickWorker,
    "__chromecraftActionProbe",
  );
  checks.push(
    check(
      "disabled toolbar actions suppress onClicked",
      disableForSuppression?.ok === true &&
        disabledToolbar?.disabled === true &&
        disabledClick.dispatched === true &&
        disabledClickRecords.length === 0,
      {
        disableForSuppression,
        toolbar: disabledToolbar,
        pointer: disabledClick,
        clickRecords: disabledClickRecords,
      },
      "A disabled action remained interactive or delivered an onClicked event.",
    ),
  );

  const browserActionConfiguration = await browserActionBackground?.evaluate(
    `globalThis.__chromecraftBrowserActionProbe.configurePopupLess(${JSON.stringify(firstExtensionTabId)})`,
  );
  await browserActionBackground?.evaluate(
    `globalThis.__chromecraftBrowserActionProbe.resetClicks()`,
  );
  const browserActionClick = await dispatchRealToolbarClick(
    shell,
    ids.browserAction,
  );
  const browserActionClicks = await waitForClicks(
    browserActionBackground,
    "__chromecraftBrowserActionProbe",
    1,
    5_000,
  );
  checks.push(
    check(
      "popup-less MV2 browserAction dispatches onClicked with the active tab",
      browserActionConfiguration &&
        Object.values(browserActionConfiguration).every(
          (result) => result?.ok === true,
        ) &&
        browserActionClick.dispatched === true &&
        browserActionClicks.length === 1 &&
        browserActionClicks[0]?.tab?.id === firstExtensionTabId &&
        browserActionClicks[0]?.tab?.url === crossOriginUrl &&
        browserActionClicks[0]?.tab?.active === true,
      {
        configuration: browserActionConfiguration,
        pointer: browserActionClick,
        records: browserActionClicks,
      },
      "The legacy popup-less browserAction did not receive exactly one authoritative click event.",
    ),
  );

  const pageActionConfiguration = await pageActionBackground?.evaluate(
    `globalThis.__chromecraftPageActionProbe.configurePopupLess(${JSON.stringify(firstExtensionTabId)})`,
  );
  await pageActionBackground?.evaluate(
    `globalThis.__chromecraftPageActionProbe.resetClicks()`,
  );
  const pageActionShow = await pageActionBackground?.evaluate(
    `globalThis.__chromecraftPageActionProbe.show(${JSON.stringify(firstExtensionTabId)})`,
  );
  const visiblePageActionToolbar = await settledToolbarState(
    shell,
    ids.pageAction,
    (state) => state?.disabled === false,
  );
  const pageActionClick = await dispatchRealToolbarClick(shell, ids.pageAction);
  const visiblePageActionClicks = await waitForClicks(
    pageActionBackground,
    "__chromecraftPageActionProbe",
    1,
    5_000,
  );
  const pageActionHide = await pageActionBackground?.evaluate(
    `globalThis.__chromecraftPageActionProbe.hide(${JSON.stringify(firstExtensionTabId)})`,
  );
  const hiddenPageActionToolbar = await settledToolbarState(
    shell,
    ids.pageAction,
    (state) => state?.disabled === true,
  );
  const hiddenPageActionClick = await dispatchRealToolbarClick(
    shell,
    ids.pageAction,
  );
  await delay(300);
  const hiddenPageActionClicks = await readClicks(
    pageActionBackground,
    "__chromecraftPageActionProbe",
  );
  checks.push(
    check(
      "MV2 pageAction dispatches only while shown and suppresses clicks while hidden",
      pageActionConfiguration?.globalPopup?.ok === true &&
        pageActionConfiguration?.tabPopup?.ok === true &&
        pageActionShow?.ok === true &&
        visiblePageActionToolbar?.disabled === false &&
        pageActionClick.dispatched === true &&
        visiblePageActionClicks.length === 1 &&
        visiblePageActionClicks[0]?.tab?.id === firstExtensionTabId &&
        pageActionHide?.ok === true &&
        hiddenPageActionToolbar?.disabled === true &&
        hiddenPageActionClick.dispatched === true &&
        hiddenPageActionClicks.length === 1,
      {
        configuration: pageActionConfiguration,
        show: pageActionShow,
        visibleToolbar: visiblePageActionToolbar,
        visiblePointer: pageActionClick,
        visibleRecords: visiblePageActionClicks,
        hide: pageActionHide,
        hiddenToolbar: hiddenPageActionToolbar,
        hiddenPointer: hiddenPageActionClick,
        hiddenRecords: hiddenPageActionClicks,
      },
      "The page action did not dispatch exactly once while shown and remain silent while hidden.",
    ),
  );

  // Stop the MV3 worker only after all direct-worker checks. The click itself
  // must be the event that restarts it; no tab event is used as a wake surrogate.
  await actionClickWorker.evaluate(
    `globalThis.__chromecraftActionProbe.configurePopupLess(${JSON.stringify(firstExtensionTabId)})`,
  );
  await actionClickWorker.evaluate(
    `globalThis.__chromecraftActionProbe.resetClicks()`,
  );
  await actionClickWorker.evaluate(
    `globalThis.__chromecraftActionProbe.enableGlobal()`,
  );
  const workerBeforeClickWake = currentActionTarget.id;
  actionClickWorker.close();
  actionClickWorker = null;
  const browserVersionForClickWake = await fetchJson(
    `http://127.0.0.1:${debugPort}/json/version`,
  );
  const browserForClickWake = await CdpClient.connect(
    browserVersionForClickWake.webSocketDebuggerUrl,
  );
  let clickWorkerStopped = false;
  try {
    const stopped = await browserForClickWake.send("Target.closeTarget", {
      targetId: workerBeforeClickWake,
    });
    clickWorkerStopped = stopped?.success === true;
  } finally {
    browserForClickWake.close();
  }
  if (clickWorkerStopped) {
    await poll(
      () => targetList(debugPort),
      (targets) =>
        !targets.some((target) => target.id === workerBeforeClickWake),
      "the action worker to stop before the wake click",
      10_000,
    );
  }
  const stoppedWorkerClick = await dispatchRealToolbarClick(shell, ids.action);
  const clickObservedTarget = clickWorkerStopped
    ? await waitForTarget(
        debugPort,
        (target) =>
          target.type === "service_worker" &&
          target.id !== workerBeforeClickWake &&
          target.url.startsWith(`chrome-extension://${ids.action}/`),
        "the action click to restart its stopped MV3 worker",
        4_000,
      ).catch(() => null)
    : null;
  let inspectionWakeUsed = false;
  let clickRestartedTarget = clickObservedTarget;
  if (clickWorkerStopped && !clickRestartedTarget) {
    inspectionWakeUsed = true;
    await shell.evaluate(
      `window.chromecraft.createTab(${JSON.stringify(`${fixture.origin}/wake-inspection`)})`,
    );
    clickRestartedTarget = await waitForTarget(
      debugPort,
      (target) =>
        target.type === "service_worker" &&
        target.id !== workerBeforeClickWake &&
        target.url.startsWith(`chrome-extension://${ids.action}/`),
      "the action worker to wake for persisted click inspection",
      10_000,
    ).catch(() => null);
  }
  let restartedClickRecords = [];
  if (clickRestartedTarget) {
    actionClickWorker = await CdpClient.connect(
      clickRestartedTarget.webSocketDebuggerUrl,
    );
    await actionClickWorker.send("Runtime.enable");
    await poll(
      () =>
        actionClickWorker.evaluate(
          `Boolean(globalThis.__chromecraftActionProbe)`,
        ),
      (ready) => ready === true,
      "the click-restarted action probe",
      10_000,
    );
    restartedClickRecords = await waitForClicks(
      actionClickWorker,
      "__chromecraftActionProbe",
      1,
      5_000,
    );
  }
  checks.push(
    check(
      "popup-less action click wakes a stopped MV3 worker and delivers onClicked",
      clickWorkerStopped &&
        stoppedWorkerClick.dispatched === true &&
        clickRestartedTarget !== null &&
        restartedClickRecords.length === 1 &&
        restartedClickRecords[0]?.tab?.id === firstExtensionTabId &&
        restartedClickRecords[0]?.tab?.url === crossOriginUrl,
      {
        workerStopped: clickWorkerStopped,
        stoppedWorkerTargetId: workerBeforeClickWake,
        pointer: stoppedWorkerClick,
        clickWorkerObserved: clickObservedTarget !== null,
        inspectionWakeUsed,
        restartedTarget: clickRestartedTarget
          ? {
              id: clickRestartedTarget.id,
              url: clickRestartedTarget.url,
            }
          : null,
        records: restartedClickRecords,
      },
      "The real toolbar click did not restart the stopped worker and deliver the click exactly once.",
    ),
  );
} catch (error) {
  fatalError = error.stack ?? error.message;
} finally {
  popup?.close();
  crossOriginPage?.close();
  activePage?.close();
  actionClickWorker?.close();
  pageActionBackground?.close();
  browserActionBackground?.close();
  restartedWorker?.close();
  worker?.close();
  shell?.close();
  await terminate(child);
  await fixture.close();
  await crossOriginFixture.close();
  await fs.writeFile(logPath, log, "utf8");
}

const requiredChecks = checks.filter((item) => item.required !== false);
const failedChecks = requiredChecks.filter((item) => item.passed !== true);
const report = {
  schemaVersion: 2,
  startedAt,
  finishedAt: new Date().toISOString(),
  success: fatalError === null && failedChecks.length === 0,
  packagedExecutable: path.relative(root, executable),
  fixture: {
    extensionVersion,
    ids,
    origin: fixture.origin,
    crossOrigin: crossOriginFixture.origin,
    requests: fixture.requests,
    crossOriginRequests: crossOriginFixture.requests,
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
