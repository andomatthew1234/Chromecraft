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
const reportPath = path.join(artifactDirectory, "extension-commands.json");
const logPath = path.join(artifactDirectory, "extension-commands.log");
const extensionVersion = "1.0.0";
const keys = {
  mv3Primary:
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAodUvL1S/bYu8yZIJwOFyIbRXlhVGoDyswPoHyFFT/hrBOVJMh+zfjkyjGsdTQQIb/ll5sJ2v0SKtTevnkCCxejHSk7sMBhMStB6VBgfCGDM2y4aA1FVYpW4OFCWVderfvQYCU0bA70acAlUDGOebXawQvc53AiQtUV33R2NPIIvYsu8tz9SiwcqB9pQzvf+uliXkKx+G/1xY12s5FvfFSsg32Fb/afUhLivOc3P27PIqy7XXQ6W1KduTctpnoQfmhplfnNWEMZcCq2oPz7QTR9evB4v/WJYwopnU95BrNLc8/sJVMFfpKvL+DaVrVUEPaiHvGa5ET95dEHS0fACQhQIDAQAB",
  mv3Collision:
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvlgkP62CnQApoP1HoTt6516c+SfgfVWKRqev8qhIJLnP/D6Lwmutc601+Sy9q7Yt3JyoVTUGAqmWNI5sHhS0Yubq5kbv7tc4faAO7BPSke8NDfDjLiSKCEdl4LZ0WcTYaGMynibynd+zKy6u2RgHW/goClPum36AOSwMTbMINXGlJCNd79Pk0I+MBlkUBYYM/7ayaZsCh3ABl5wZ8fhyNQKxO+DrZaM1PsVCrg5hWckYtikY3oNkETCHJ5Uek4iro4lQeZU77SWfBE96xSABmnRt45ljLY/dNfDfaq+kSyU3LYeLfCSU0ofsWiRLDz9fZh+PoHr6phEoViKZHasnzwIDAQAB",
  mv2BrowserAction:
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApFBF9+FnksG/xig9aITZvdTaKYw9D3WuVt56W/aaNHDtDywWZUUAjSsnpF/KbRH2Qdc0I6if15edklHx0vLNhOMbl3jV9bhkUxS4DZmEfZ9kp533Ll2lErCxyXSZaILcRBlDgLXWUT7cS+NvQY9lA/g5kM7P8l6fu9gXO+NJDiLQBYHZplZG67q3WSeyREJHmbnc2Y3gLHFZnj21Zpy5BEwkTLY59+F8FqMEzygeqmlE/tiUHMdwS74Okc298Qh3Z44aMC0CCoVbDkuhnJOddQJunS0P2NhJUQWAd0pg+MLufN75LJPpYdd6ylrGEK2lkOtYIKvG5u1EO3VB9whRVwIDAQAB",
  mv2PageAction:
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvt7IX8iBfIE9HG7abGYSGrkQwVifos45Y0q1e0rFxFQ5p03h4yHBdS66PM1ZkyJ4wwfITVusv+xvORGUcDnzqr13QArfIpKUNC+cZCSaojFxly1XUB1eIG855hc/GnvT5cmWQe7dDCxLc6FKMOEPrLS3um+LEVzsSTwE5JT6uJhTOUvVzNJiDL+cWe6JSNWl5+iSDB/l3P/lHbzS1dADA7f/CbhgzRurlsqMfNBEOthyVhhSQV/Z9qIsaeDq2c9t8zJhcdH6z0lYSuxQYmusZzdUHQBdaWAsvlBaFxH4GbmmyO0ATiC6UcPDR2Ph9KuCtPSdm9u8KLYygRHerWCDaQIDAQAB",
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
    !path
      .basename(resolvedProfile)
      .startsWith("chromecraft-extension-commands-")
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
      <html lang="en"><head><meta charset="utf-8"><title>Command conformance fixture</title></head>
      <body><main><h1 id="fixture-ready">Command conformance fixture</h1></main></body></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not start the command conformance fixture.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function probeSource(probeName, actionNamespace) {
  return `
const commandStorageKey = ${JSON.stringify(`chromecraft-commands-${probeName}`)};
const actionStorageKey = ${JSON.stringify(`chromecraft-actions-${probeName}`)};
const storageGet = (key) => new Promise((resolve) => chrome.storage.local.get(key, (items) => resolve(items?.[key] ?? [])));
const storageSet = (key, value) => new Promise((resolve) => chrome.storage.local.set({ [key]: value }, resolve));
const append = async (key, value) => {
  const records = await storageGet(key);
  records.push(value);
  await storageSet(key, records);
};
const invoke = (receiver, method, argument, omitArgument = false) => new Promise((resolve) => {
  if (!receiver || typeof receiver[method] !== "function") {
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
  const timer = setTimeout(() => finish({ ok: false, error: method + " callback timed out" }), 1500);
  try {
    const callback = (value) => {
      const error = chrome.runtime.lastError;
      finish(error ? { ok: false, error: error.message } : { ok: true, value });
    };
    const returned = omitArgument ? receiver[method](callback) : receiver[method](argument, callback);
    if (returned && typeof returned.then === "function") {
      returned.then((value) => finish({ ok: true, value }), (error) => finish({ ok: false, error: String(error) }));
    }
  } catch (error) {
    finish({ ok: false, error: String(error) });
  }
});
chrome.commands?.onCommand?.addListener(async (command, commandTab) => {
  const tabs = await chrome.tabs.query({ active: true });
  const tab = commandTab ?? tabs[0] ?? null;
  await append(commandStorageKey, {
    command,
    tab: tab ? { id: tab.id, url: tab.url, title: tab.title, active: tab.active, windowId: tab.windowId } : null,
    at: Date.now()
  });
});
const action = chrome[${JSON.stringify(actionNamespace)}];
action?.onClicked?.addListener(async (tab) => {
  await append(actionStorageKey, {
    tab: { id: tab?.id ?? null, url: tab?.url ?? null, title: tab?.title ?? null, active: tab?.active ?? null, windowId: tab?.windowId ?? null },
    at: Date.now()
  });
});
globalThis[${JSON.stringify(probeName)}] = {
  surface: () => ({
    namespace: typeof chrome.commands,
    getAll: typeof chrome.commands?.getAll,
    onCommand: typeof chrome.commands?.onCommand,
    onCommandAddListener: typeof chrome.commands?.onCommand?.addListener,
    actionNamespace: typeof action,
    actionOnClicked: typeof action?.onClicked?.addListener,
  }),
  getAll: () => invoke(chrome.commands, "getAll", undefined, true),
  commandRecords: () => storageGet(commandStorageKey),
  actionRecords: () => storageGet(actionStorageKey),
  reset: async () => {
    await storageSet(commandStorageKey, []);
    await storageSet(actionStorageKey, []);
    return true;
  },
  setPopup: (popup, tabId) => invoke(action, "setPopup", Number.isInteger(tabId) ? { tabId, popup } : { popup }),
  show: (tabId) => invoke(action, "show", tabId),
};
`;
}

const popupHtml = (name) =>
  `<!doctype html><html data-popup-ready="${name}"><head><meta charset="utf-8"><title>${name}</title></head><body><main id="popup-ready">${name}</main></body></html>`;

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
    ids.mv3Primary,
    {
      manifest_version: 3,
      name: "Chromecraft MV3 commands primary",
      version: extensionVersion,
      key: keys.mv3Primary,
      permissions: ["storage", "tabs"],
      background: { service_worker: "worker.js" },
      action: {
        default_title: "MV3 command action",
        default_popup: "action-popup.html",
      },
      commands: {
        "primary-command": {
          suggested_key: { default: "Ctrl+Shift+Y" },
          description: "Run the primary command",
        },
        _execute_action: { suggested_key: { default: "Ctrl+Shift+U" } },
      },
    },
    {
      "worker.js": probeSource("__commandsMv3Primary", "action"),
      "action-popup.html": popupHtml("mv3-action-popup"),
    },
  );
  await writeExtension(
    profile,
    ids.mv3Collision,
    {
      manifest_version: 3,
      name: "Chromecraft MV3 commands collision",
      version: extensionVersion,
      key: keys.mv3Collision,
      permissions: ["storage", "tabs"],
      background: { service_worker: "worker.js" },
      commands: {
        "collision-command": {
          suggested_key: { default: "Ctrl+Shift+Y" },
          description: "Compete for the primary shortcut",
        },
        "isolated-command": {
          suggested_key: { default: "Alt+Shift+K" },
          description: "Run only in the collision fixture",
        },
      },
    },
    {
      "worker.js": probeSource("__commandsMv3Collision", "action"),
    },
  );
  await writeExtension(
    profile,
    ids.mv2BrowserAction,
    {
      manifest_version: 2,
      name: "Chromecraft MV2 browser commands",
      version: extensionVersion,
      key: keys.mv2BrowserAction,
      permissions: ["storage", "tabs"],
      background: { scripts: ["background.js"], persistent: true },
      browser_action: { default_title: "MV2 browser action" },
      commands: {
        "legacy-browser-command": {
          suggested_key: { default: "Alt+Shift+M" },
          description: "Run the MV2 browser command",
        },
        _execute_browser_action: {
          suggested_key: { default: "Alt+Shift+B" },
        },
      },
    },
    {
      "background.js": probeSource(
        "__commandsMv2BrowserAction",
        "browserAction",
      ),
    },
  );
  await writeExtension(
    profile,
    ids.mv2PageAction,
    {
      manifest_version: 2,
      name: "Chromecraft MV2 page commands",
      version: extensionVersion,
      key: keys.mv2PageAction,
      permissions: ["storage", "tabs"],
      background: { scripts: ["background.js"], persistent: true },
      page_action: { default_title: "MV2 page action" },
      commands: {
        "legacy-page-command": {
          suggested_key: { default: "Alt+Shift+N" },
          description: "Run the MV2 page command",
        },
        _execute_page_action: {
          suggested_key: { default: "Alt+Shift+P" },
        },
      },
    },
    {
      "background.js": probeSource("__commandsMv2PageAction", "pageAction"),
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

function check(name, passed, evidence, error = null) {
  return {
    name,
    passed,
    evidence,
    error: passed ? null : error,
    required: true,
  };
}

async function connectProbe(port, id, type, probeName) {
  const target = await waitForTarget(
    port,
    (candidate) =>
      candidate.type === type &&
      candidate.url.startsWith(`chrome-extension://${id}/`),
    `${probeName} target`,
  );
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await poll(
    () => client.evaluate(`Boolean(globalThis[${JSON.stringify(probeName)}])`),
    (ready) => ready === true,
    `${probeName} readiness`,
  );
  return { target, client };
}

async function readRecords(client, probeName, method) {
  if (!client) return [];
  return (
    (await client.evaluate(
      `globalThis[${JSON.stringify(probeName)}]?.[${JSON.stringify(method)}]?.()`,
    )) ?? []
  );
}

async function waitForRecords(
  client,
  probeName,
  method,
  count,
  timeoutMs = 2_000,
) {
  try {
    return await poll(
      () => readRecords(client, probeName, method),
      (records) => Array.isArray(records) && records.length >= count,
      `${probeName}.${method} to contain ${count} record(s)`,
      timeoutMs,
    );
  } catch {
    return readRecords(client, probeName, method);
  }
}

const modifierBits = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

async function dispatchShortcut(client, shortcut) {
  const parts = shortcut.split("+");
  const final = parts.at(-1);
  const modifiers = parts.slice(0, -1).reduce((value, part) => {
    const key = part.toLowerCase();
    return value | (modifierBits[key] ?? 0);
  }, 0);
  const code = final.length === 1 ? `Key${final.toUpperCase()}` : final;
  const virtualKeyCode =
    final.length === 1 ? final.toUpperCase().charCodeAt(0) : 0;
  const params = {
    key: final.length === 1 ? final.toUpperCase() : final,
    code,
    modifiers,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
  };
  await client.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    ...params,
  });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
  return { shortcut, ...params };
}

const commandByName = (result, name) =>
  result?.ok && Array.isArray(result.value)
    ? result.value.find((command) => command.name === name)
    : null;

await fs.access(executable);
await fs.mkdir(artifactDirectory, { recursive: true });
const startedAt = new Date().toISOString();
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "chromecraft-extension-commands-"),
);
const fixture = await startFixture();
await seedExtensions(profile);
const debugPort = await findFreePort();
const fixtureUrl = `${fixture.origin}/commands`;
const child = spawn(
  executable,
  [
    `--chromecraft-user-data=${profile}`,
    `--user-data-dir=${profile}`,
    `--chromecraft-smoke-url=${fixtureUrl}`,
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
const clients = [];
let shell;
let page;
let fatalError = null;
const runtimeEvidence = {};
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
    "all command conformance extensions to become ready",
    45_000,
  );
  const browserTabId = initialized.browser.activeTabId;
  await shell.evaluate(
    `window.chromecraft.navigate(${JSON.stringify(browserTabId)}, ${JSON.stringify(fixtureUrl)})`,
  );
  await poll(
    () => shell.evaluate(`window.chromecraft.getSnapshot()`),
    (snapshot) => {
      const tab = snapshot?.tabs?.find((item) => item.id === browserTabId);
      return tab?.url === fixtureUrl && tab?.isLoading === false;
    },
    "the command fixture tab to finish loading",
  );
  const pageTarget = await waitForTarget(
    debugPort,
    (target) => target.type === "page" && target.url === fixtureUrl,
    "the command fixture page target",
  );
  page = await CdpClient.connect(pageTarget.webSocketDebuggerUrl);
  await page.send("Runtime.enable");

  const probes = {
    mv3Primary: await connectProbe(
      debugPort,
      ids.mv3Primary,
      "service_worker",
      "__commandsMv3Primary",
    ),
    mv3Collision: await connectProbe(
      debugPort,
      ids.mv3Collision,
      "service_worker",
      "__commandsMv3Collision",
    ),
    mv2BrowserAction: await connectProbe(
      debugPort,
      ids.mv2BrowserAction,
      "page",
      "__commandsMv2BrowserAction",
    ),
    mv2PageAction: await connectProbe(
      debugPort,
      ids.mv2PageAction,
      "page",
      "__commandsMv2PageAction",
    ),
  };
  clients.push(...Object.values(probes).map(({ client }) => client));

  const probeNames = {
    mv3Primary: "__commandsMv3Primary",
    mv3Collision: "__commandsMv3Collision",
    mv2BrowserAction: "__commandsMv2BrowserAction",
    mv2PageAction: "__commandsMv2PageAction",
  };
  const surfaces = {};
  const commandLists = {};
  for (const [name, probe] of Object.entries(probes)) {
    surfaces[name] = await probe.client.evaluate(
      `globalThis[${JSON.stringify(probeNames[name])}].surface()`,
    );
    commandLists[name] = await probe.client.evaluate(
      `globalThis[${JSON.stringify(probeNames[name])}].getAll()`,
    );
  }
  checks.push(
    check(
      "chrome.commands exposes getAll and onCommand in MV3 and MV2 backgrounds",
      Object.values(surfaces).every(
        (surface) =>
          surface.namespace === "object" &&
          surface.getAll === "function" &&
          surface.onCommand === "object" &&
          surface.onCommandAddListener === "function",
      ),
      surfaces,
      "At least one MV3 or MV2 background is missing the public commands API surface.",
    ),
  );
  const primaryCommand = commandByName(
    commandLists.mv3Primary,
    "primary-command",
  );
  const primaryActionCommand = commandByName(
    commandLists.mv3Primary,
    "_execute_action",
  );
  checks.push(
    check(
      "chrome.commands.getAll returns MV3 names, descriptions, and assigned shortcuts",
      primaryCommand?.description === "Run the primary command" &&
        primaryCommand?.shortcut === "Ctrl+Shift+Y" &&
        primaryActionCommand?.shortcut === "Ctrl+Shift+U",
      commandLists.mv3Primary,
      "MV3 manifest command metadata did not round-trip through getAll.",
    ),
  );
  const legacyCommand = commandByName(
    commandLists.mv2BrowserAction,
    "legacy-browser-command",
  );
  const legacyActionCommand = commandByName(
    commandLists.mv2BrowserAction,
    "_execute_browser_action",
  );
  const pageCommand = commandByName(
    commandLists.mv2PageAction,
    "legacy-page-command",
  );
  const legacyPageActionCommand = commandByName(
    commandLists.mv2PageAction,
    "_execute_page_action",
  );
  checks.push(
    check(
      "chrome.commands.getAll returns MV2 custom commands and reserved action aliases",
      legacyCommand?.shortcut === "Alt+Shift+M" &&
        legacyActionCommand?.shortcut === "Alt+Shift+B" &&
        pageCommand?.shortcut === "Alt+Shift+N" &&
        legacyPageActionCommand?.shortcut === "Alt+Shift+P",
      {
        browserAction: commandLists.mv2BrowserAction,
        pageAction: commandLists.mv2PageAction,
      },
      "MV2 manifest commands or reserved action aliases were absent from getAll.",
    ),
  );

  await Promise.all(
    Object.entries(probes).map(([name, probe]) =>
      probe.client.evaluate(
        `globalThis[${JSON.stringify(probeNames[name])}].reset()`,
      ),
    ),
  );
  const primaryKey = await dispatchShortcut(page, "Ctrl+Shift+Y");
  const [primaryRecords, collisionRecords] = await Promise.all([
    waitForRecords(
      probes.mv3Primary.client,
      probeNames.mv3Primary,
      "commandRecords",
      1,
    ),
    waitForRecords(
      probes.mv3Collision.client,
      probeNames.mv3Collision,
      "commandRecords",
      1,
    ),
  ]);
  const collisionDeliveries = [
    ...primaryRecords.map((record) => ({ owner: "mv3Primary", ...record })),
    ...collisionRecords.map((record) => ({ owner: "mv3Collision", ...record })),
  ].filter((record) =>
    ["primary-command", "collision-command"].includes(record.command),
  );
  checks.push(
    check(
      "a colliding shortcut has exactly one deterministic extension owner",
      collisionDeliveries.length === 1 &&
        ((primaryCommand?.shortcut === "Ctrl+Shift+Y" &&
          commandByName(commandLists.mv3Collision, "collision-command")
            ?.shortcut === "") ||
          (primaryCommand?.shortcut === "" &&
            commandByName(commandLists.mv3Collision, "collision-command")
              ?.shortcut === "Ctrl+Shift+Y")),
      {
        key: primaryKey,
        getAll: {
          primary: commandLists.mv3Primary,
          collision: commandLists.mv3Collision,
        },
        deliveries: collisionDeliveries,
      },
      "The colliding shortcut was unowned, multiply delivered, or getAll did not expose the collision assignment.",
    ),
  );

  await probes.mv3Collision.client.evaluate(
    `globalThis.${probeNames.mv3Collision}.reset()`,
  );
  await probes.mv3Primary.client.evaluate(
    `globalThis.${probeNames.mv3Primary}.reset()`,
  );
  const isolationKey = await dispatchShortcut(page, "Alt+Shift+K");
  const isolatedRecords = await waitForRecords(
    probes.mv3Collision.client,
    probeNames.mv3Collision,
    "commandRecords",
    1,
  );
  const primaryAfterIsolation = await readRecords(
    probes.mv3Primary.client,
    probeNames.mv3Primary,
    "commandRecords",
  );
  checks.push(
    check(
      "real keyboard input dispatches onCommand only to the owning extension",
      isolatedRecords.length === 1 &&
        isolatedRecords[0]?.command === "isolated-command" &&
        primaryAfterIsolation.length === 0,
      {
        key: isolationKey,
        ownerRecords: isolatedRecords,
        otherExtensionRecords: primaryAfterIsolation,
      },
      "The unique shortcut was not delivered exactly once to its owning extension.",
    ),
  );

  const [activeExtensionTab] = await probes.mv3Primary.client.evaluate(
    `chrome.tabs.query({ active: true })`,
  );
  const activeExtensionTabId = activeExtensionTab?.id ?? null;
  await probes.mv3Primary.client.evaluate(
    `globalThis.${probeNames.mv3Primary}.reset()`,
  );
  const popupKey = await dispatchShortcut(page, "Ctrl+Shift+U");
  const popupTarget = await waitForTarget(
    debugPort,
    (target) =>
      target.type === "page" &&
      target.url === `chrome-extension://${ids.mv3Primary}/action-popup.html`,
    "the reserved action command popup",
    2_000,
  ).catch(() => null);
  await delay(200);
  const popupActionRecords = await readRecords(
    probes.mv3Primary.client,
    probeNames.mv3Primary,
    "actionRecords",
  );
  const popupCommandRecords = await readRecords(
    probes.mv3Primary.client,
    probeNames.mv3Primary,
    "commandRecords",
  );
  checks.push(
    check(
      "_execute_action opens its popup and suppresses onClicked and onCommand",
      popupTarget !== null &&
        popupActionRecords.length === 0 &&
        popupCommandRecords.length === 0,
      {
        key: popupKey,
        popupUrl: popupTarget?.url ?? null,
        actionRecords: popupActionRecords,
        commandRecords: popupCommandRecords,
      },
      "The reserved MV3 action command did not follow Chrome popup semantics.",
    ),
  );
  await shell.evaluate(`window.chromecraft.closeExtensionPopup()`);

  const clearPopup = await probes.mv3Primary.client.evaluate(
    `globalThis.${probeNames.mv3Primary}.setPopup("", ${JSON.stringify(activeExtensionTabId)})`,
  );
  await probes.mv3Primary.client.evaluate(
    `globalThis.${probeNames.mv3Primary}.reset()`,
  );
  const clickKey = await dispatchShortcut(page, "Ctrl+Shift+U");
  const clickRecords = await waitForRecords(
    probes.mv3Primary.client,
    probeNames.mv3Primary,
    "actionRecords",
    1,
  );
  const reservedCommandRecords = await readRecords(
    probes.mv3Primary.client,
    probeNames.mv3Primary,
    "commandRecords",
  );
  checks.push(
    check(
      "popup-less _execute_action dispatches onClicked with the authoritative active tab",
      clearPopup?.ok === true &&
        clickRecords.length === 1 &&
        clickRecords[0]?.tab?.id === activeExtensionTabId &&
        clickRecords[0]?.tab?.url === fixtureUrl &&
        clickRecords[0]?.tab?.title === "Command conformance fixture" &&
        clickRecords[0]?.tab?.active === true &&
        Number.isInteger(clickRecords[0]?.tab?.windowId) &&
        reservedCommandRecords.length === 0,
      {
        clearPopup,
        key: clickKey,
        actionRecords: clickRecords,
        commandRecords: reservedCommandRecords,
      },
      "The reserved MV3 action command did not route through the action host with the active tab payload.",
    ),
  );

  await probes.mv2BrowserAction.client.evaluate(
    `globalThis.${probeNames.mv2BrowserAction}.reset()`,
  );
  const browserActionKey = await dispatchShortcut(page, "Alt+Shift+B");
  const browserActionRecords = await waitForRecords(
    probes.mv2BrowserAction.client,
    probeNames.mv2BrowserAction,
    "actionRecords",
    1,
  );
  const browserReservedCommands = await readRecords(
    probes.mv2BrowserAction.client,
    probeNames.mv2BrowserAction,
    "commandRecords",
  );
  checks.push(
    check(
      "MV2 _execute_browser_action routes through browserAction onClicked",
      browserActionRecords.length === 1 &&
        browserActionRecords[0]?.tab?.id === activeExtensionTabId &&
        browserActionRecords[0]?.tab?.url === fixtureUrl &&
        browserReservedCommands.length === 0,
      {
        key: browserActionKey,
        actionRecords: browserActionRecords,
        commandRecords: browserReservedCommands,
      },
      "The MV2 browser-action alias was not routed through the legacy action host.",
    ),
  );

  await probes.mv2PageAction.client.evaluate(
    `globalThis.${probeNames.mv2PageAction}.reset()`,
  );
  const showPageAction = await probes.mv2PageAction.client.evaluate(
    `globalThis.${probeNames.mv2PageAction}.show(${JSON.stringify(activeExtensionTabId)})`,
  );
  const pageActionKey = await dispatchShortcut(page, "Alt+Shift+P");
  const pageActionRecords = await waitForRecords(
    probes.mv2PageAction.client,
    probeNames.mv2PageAction,
    "actionRecords",
    1,
  );
  const pageReservedCommands = await readRecords(
    probes.mv2PageAction.client,
    probeNames.mv2PageAction,
    "commandRecords",
  );
  checks.push(
    check(
      "MV2 _execute_page_action routes through a shown pageAction onClicked",
      showPageAction?.ok === true &&
        pageActionRecords.length === 1 &&
        pageActionRecords[0]?.tab?.id === activeExtensionTabId &&
        pageActionRecords[0]?.tab?.url === fixtureUrl &&
        pageReservedCommands.length === 0,
      {
        showPageAction,
        key: pageActionKey,
        actionRecords: pageActionRecords,
        commandRecords: pageReservedCommands,
      },
      "The MV2 page-action alias was not routed through the visible legacy page action.",
    ),
  );

  await probes.mv2BrowserAction.client.evaluate(
    `globalThis.${probeNames.mv2BrowserAction}.reset()`,
  );
  const legacyKey = await dispatchShortcut(page, "Alt+Shift+M");
  const legacyRecords = await waitForRecords(
    probes.mv2BrowserAction.client,
    probeNames.mv2BrowserAction,
    "commandRecords",
    1,
  );
  checks.push(
    check(
      "real keyboard input dispatches a custom command to an MV2 background page",
      legacyRecords.length === 1 &&
        legacyRecords[0]?.command === "legacy-browser-command" &&
        legacyRecords[0]?.tab?.id === activeExtensionTabId,
      { key: legacyKey, records: legacyRecords },
      "The MV2 custom command did not reach its persistent background page.",
    ),
  );

  await probes.mv3Collision.client.evaluate(
    `globalThis.${probeNames.mv3Collision}.reset()`,
  );
  const stoppedWorkerTargetId = probes.mv3Collision.target.id;
  probes.mv3Collision.client.close();
  clients.splice(clients.indexOf(probes.mv3Collision.client), 1);
  probes.mv3Collision.client = null;
  const browserVersion = await fetchJson(
    `http://127.0.0.1:${debugPort}/json/version`,
  );
  const browser = await CdpClient.connect(browserVersion.webSocketDebuggerUrl);
  let workerStopped = false;
  try {
    const stopped = await browser.send("Target.closeTarget", {
      targetId: stoppedWorkerTargetId,
    });
    workerStopped = stopped?.success === true;
  } finally {
    browser.close();
  }
  if (workerStopped) {
    await poll(
      () => targetList(debugPort),
      (targets) =>
        !targets.some((target) => target.id === stoppedWorkerTargetId),
      "the MV3 command worker to stop",
      10_000,
    );
  }
  const wakeKey = await dispatchShortcut(page, "Alt+Shift+K");
  const observedRestart = workerStopped
    ? await waitForTarget(
        debugPort,
        (target) =>
          target.type === "service_worker" &&
          target.id !== stoppedWorkerTargetId &&
          target.url.startsWith(`chrome-extension://${ids.mv3Collision}/`),
        "the keyboard command to wake the stopped MV3 worker",
        4_000,
      ).catch(() => null)
    : null;
  let inspectionWakeUsed = false;
  let inspectionTarget = observedRestart;
  if (workerStopped && !inspectionTarget) {
    inspectionWakeUsed = true;
    await shell.evaluate(
      `window.chromecraft.createTab(${JSON.stringify(`${fixture.origin}/inspection-wake`)})`,
    );
    inspectionTarget = await waitForTarget(
      debugPort,
      (target) =>
        target.type === "service_worker" &&
        target.id !== stoppedWorkerTargetId &&
        target.url.startsWith(`chrome-extension://${ids.mv3Collision}/`),
      "the MV3 worker to wake for persisted command inspection",
      10_000,
    ).catch(() => null);
  }
  let restartedRecords = [];
  if (inspectionTarget) {
    const restarted = await CdpClient.connect(
      inspectionTarget.webSocketDebuggerUrl,
    );
    clients.push(restarted);
    await restarted.send("Runtime.enable");
    await poll(
      () =>
        restarted.evaluate(`Boolean(globalThis.${probeNames.mv3Collision})`),
      (ready) => ready === true,
      "the restarted MV3 command probe",
      10_000,
    );
    restartedRecords = await waitForRecords(
      restarted,
      probeNames.mv3Collision,
      "commandRecords",
      1,
      3_000,
    );
  }
  checks.push(
    check(
      "a real keyboard shortcut wakes a stopped MV3 worker and delivers onCommand",
      workerStopped &&
        observedRestart !== null &&
        restartedRecords.length === 1 &&
        restartedRecords[0]?.command === "isolated-command",
      {
        key: wakeKey,
        workerStopped,
        stoppedWorkerTargetId,
        commandRestartObserved: observedRestart !== null,
        inspectionWakeUsed,
        restartedTarget: inspectionTarget
          ? { id: inspectionTarget.id, url: inspectionTarget.url }
          : null,
        records: restartedRecords,
      },
      "The command did not itself restart the stopped worker and deliver onCommand exactly once.",
    ),
  );
  runtimeEvidence.activeExtensionTabId = activeExtensionTabId;
  runtimeEvidence.browserTabId = browserTabId;
} catch (error) {
  fatalError = error.stack ?? error.message;
} finally {
  for (const client of clients) client?.close();
  page?.close();
  shell?.close();
  await terminate(child);
  await fixture.close();
  await fs.writeFile(logPath, log, "utf8");
}

const failedChecks = checks.filter((item) => item.passed !== true);
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
    passed: checks.length - failedChecks.length,
    failed: failedChecks.length,
    total: checks.length,
  },
  checks,
  runtimeEvidence,
  fatalError,
};
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await removeDisposableProfile(profile);
console.log(JSON.stringify(report, null, 2));
if (!report.success) process.exitCode = 1;
