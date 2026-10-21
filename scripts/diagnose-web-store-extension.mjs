import { execFile as execFileCallback, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
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
const reportPath = path.join(
  artifactDirectory,
  "web-store-extension-diagnostic.json",
);
const logPath = path.join(
  artifactDirectory,
  "web-store-extension-diagnostic.log",
);
const defaultExtensionId = "nngceckbapebfimnlniiiahkandclblb";
const defaultItemUrl = `https://chromewebstore.google.com/detail/bitwarden-password-manager/${defaultExtensionId}`;
const extensionIdPattern = /^[a-p]{32}$/u;

function argumentValue(name) {
  const prefix = `--${name}=`;
  return process.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

function parseStoreItemUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "chromewebstore.google.com" ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error("The diagnostic URL must be a Chrome Web Store HTTPS URL.");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const id = [...segments]
    .reverse()
    .find((segment) => extensionIdPattern.test(segment));
  if (!id) throw new Error("The Chrome Web Store URL has no extension id.");
  return {
    id,
    safeUrl: `https://chromewebstore.google.com/detail/${id}`,
  };
}

const requestedUrl = argumentValue("url") ?? defaultItemUrl;
const parsedStoreItem = parseStoreItemUrl(requestedUrl);
const requestedId = argumentValue("id") ?? parsedStoreItem.id;
if (!extensionIdPattern.test(requestedId)) {
  throw new Error("The requested extension id is invalid.");
}
if (requestedId !== parsedStoreItem.id) {
  throw new Error(
    "The requested extension id does not match the Web Store URL.",
  );
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

async function poll(operation, predicate, description, timeoutMs = 30_000) {
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
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for ${description}. ${lastError?.message ?? JSON.stringify(lastValue)}`,
  );
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(
        typeof event.data === "string" ? event.data : event.data.toString(),
      );
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      if (!message.method) return;
      for (const listener of this.listeners.get(message.method) ?? []) {
        listener(message.params ?? {});
      }
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

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description;
      throw new Error(description ?? response.exceptionDetails.text);
    }
    return response.result.value;
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

async function targetList(port) {
  return fetchJson(`http://127.0.0.1:${port}/json/list`);
}

async function waitForShellTarget(port) {
  const targets = await poll(
    () => targetList(port),
    (items) =>
      items.some(
        (target) =>
          target.type === "page" &&
          !target.url.startsWith("chrome-extension://") &&
          (target.url.startsWith("file://") ||
            target.url.includes("main_window")),
      ),
    "the Chromecraft shell target",
    45_000,
  );
  return targets.find(
    (target) =>
      target.type === "page" &&
      !target.url.startsWith("chrome-extension://") &&
      (target.url.startsWith("file://") || target.url.includes("main_window")),
  );
}

async function waitForPageTarget(port, url) {
  const targets = await poll(
    () => targetList(port),
    (items) =>
      items.some((target) => target.type === "page" && target.url === url),
    `the page target for ${url}`,
  );
  return targets.find((target) => target.type === "page" && target.url === url);
}

function remoteValue(argument) {
  if (Object.hasOwn(argument, "value")) return argument.value;
  return argument.description ?? argument.type ?? "<unavailable>";
}

async function inspectPopupRuntime(port, popupUrl) {
  const target = await waitForPageTarget(port, popupUrl);
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  const consoleMessages = [];
  const exceptions = [];
  const logEntries = [];
  const failedRequests = [];
  const responses = [];
  let loadEvents = 0;

  client.on("Runtime.consoleAPICalled", (event) => {
    consoleMessages.push({
      type: event.type,
      args: (event.args ?? []).map(remoteValue),
      url: event.stackTrace?.callFrames?.[0]?.url ?? null,
      lineNumber: event.stackTrace?.callFrames?.[0]?.lineNumber ?? null,
    });
  });
  client.on("Runtime.exceptionThrown", (event) => {
    exceptions.push({
      text: event.exceptionDetails?.text ?? null,
      description: event.exceptionDetails?.exception?.description ?? null,
      url: event.exceptionDetails?.url ?? null,
      lineNumber: event.exceptionDetails?.lineNumber ?? null,
      columnNumber: event.exceptionDetails?.columnNumber ?? null,
    });
  });
  client.on("Log.entryAdded", (event) => {
    logEntries.push({
      source: event.entry?.source ?? null,
      level: event.entry?.level ?? null,
      text: event.entry?.text ?? null,
      url: event.entry?.url ?? null,
      lineNumber: event.entry?.lineNumber ?? null,
    });
  });
  client.on("Network.loadingFailed", (event) => {
    failedRequests.push({
      requestId: event.requestId,
      errorText: event.errorText,
      canceled: event.canceled ?? false,
      blockedReason: event.blockedReason ?? null,
    });
  });
  client.on("Network.responseReceived", (event) => {
    responses.push({
      url: event.response?.url ?? null,
      status: event.response?.status ?? null,
      mimeType: event.response?.mimeType ?? null,
      fromDiskCache: event.response?.fromDiskCache ?? false,
      fromServiceWorker: event.response?.fromServiceWorker ?? false,
    });
  });
  client.on("Page.loadEventFired", () => {
    loadEvents += 1;
  });

  try {
    await Promise.all([
      client.send("Runtime.enable"),
      client.send("Log.enable"),
      client.send("Network.enable"),
      client.send("Page.enable"),
    ]);
    await client.send("Page.reload", { ignoreCache: false });
    await poll(
      () => client.evaluate("document.readyState"),
      (value) => value === "complete",
      "the extension popup document to finish reloading",
    );
    await delay(20_000);

    const dom = await client.evaluate(`(() => {
      const body = document.body;
      const root = document.querySelector("#root, app-root, #app");
      const spinner = document.querySelector(
        '[role="progressbar"], mat-spinner, .mat-mdc-progress-spinner, .spinner, .bwi-spinner',
      );
      const text = body?.innerText?.trim() ?? "";
      const apiNames = [
        "alarms", "contextMenus", "idle", "notifications", "offscreen",
        "privacy", "sidePanel", "tabs", "webNavigation",
        "webRequest", "webRequestAuthProvider", "windows"
      ];
      return {
        readyState: document.readyState,
        title: document.title,
        url: location.href,
        bodyText: text.slice(0, 2_000),
        bodyTextLength: text.length,
        bodyHtmlLength: body?.innerHTML?.length ?? 0,
        bodyHtml: body?.innerHTML?.slice(0, 2_000) ?? "",
        bodyChildCount: body?.childElementCount ?? 0,
        root: root ? {
          tagName: root.tagName,
          childElementCount: root.childElementCount,
          htmlLength: root.innerHTML.length,
          html: root.innerHTML.slice(0, 2_000),
          textLength: root.innerText?.trim().length ?? 0,
        } : null,
        spinnerPresent: Boolean(spinner),
        apiSurface: Object.fromEntries(apiNames.map((name) => [
          name,
          typeof globalThis.chrome?.[name]
        ])),
        methods: {
          tabsGetCurrent: typeof globalThis.chrome?.tabs?.getCurrent,
          tabsQuery: typeof globalThis.chrome?.tabs?.query,
          runtimeSendMessage: typeof globalThis.chrome?.runtime?.sendMessage,
          storageLocalGet: typeof globalThis.chrome?.storage?.local?.get,
          windowsGetCurrent: typeof globalThis.chrome?.windows?.getCurrent,
        },
      };
    })()`);
    const parsedPopupUrl = new URL(popupUrl);
    const extensionOrigin = `${parsedPopupUrl.protocol}//${parsedPopupUrl.host}`;
    const extensionTargets = (await targetList(port))
      .filter((item) => item.url.startsWith(extensionOrigin))
      .map((item) => ({ type: item.type, title: item.title, url: item.url }));
    return {
      dom,
      extensionTargets,
      loadEvents,
      consoleMessages,
      exceptions,
      logEntries,
      failedRequests,
      responses,
      meaningfulContent:
        dom.bodyTextLength > 0 &&
        (dom.root?.textLength ?? dom.bodyTextLength) > 0 &&
        !dom.spinnerPresent,
    };
  } finally {
    client.close();
  }
}

async function terminate(child) {
  if (!child?.pid || child.exitCode !== null) return;
  await execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    windowsHide: true,
  }).catch(() => child.kill());
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5_000),
  ]);
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function inspectExtensionStorage(profile, extensionId, version) {
  const storageRoot = path.join(profile, "extensions");
  const registryPath = path.join(storageRoot, "installed-extensions.json");
  const extensionRoot = path.join(storageRoot, extensionId);
  const versionRoot = path.join(extensionRoot, version);
  const summary = {
    registryInsideProfile: isInside(profile, registryPath),
    extensionRootInsideProfile: isInside(profile, extensionRoot),
    versionRootInsideProfile: isInside(profile, versionRoot),
    registryEntryMatches: false,
    manifestExists: false,
    allEntriesInsideProfile: true,
    symbolicLinks: 0,
    files: 0,
    directories: 0,
    bytes: 0,
  };

  const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  summary.registryEntryMatches =
    registry?.version === 1 &&
    registry.extensions?.length === 1 &&
    registry.extensions[0]?.id === extensionId &&
    registry.extensions[0]?.version === version &&
    registry.extensions[0]?.enabled === true;
  summary.manifestExists = await fs
    .access(path.join(versionRoot, "manifest.json"))
    .then(() => true)
    .catch(() => false);

  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (!isInside(profile, entryPath))
        summary.allEntriesInsideProfile = false;
      if (entry.isSymbolicLink()) {
        summary.symbolicLinks += 1;
        continue;
      }
      if (entry.isDirectory()) {
        summary.directories += 1;
        await walk(entryPath);
      } else if (entry.isFile()) {
        summary.files += 1;
        summary.bytes += (await fs.stat(entryPath)).size;
      }
    }
  }
  await walk(extensionRoot);
  summary.confined =
    summary.registryInsideProfile &&
    summary.extensionRootInsideProfile &&
    summary.versionRootInsideProfile &&
    summary.registryEntryMatches &&
    summary.manifestExists &&
    summary.allEntriesInsideProfile &&
    summary.symbolicLinks === 0;
  return summary;
}

async function inspectUninstalledStorage(profile, extensionId) {
  const storageRoot = path.join(profile, "extensions");
  const registryPath = path.join(storageRoot, "installed-extensions.json");
  const extensionRoot = path.join(storageRoot, extensionId);
  const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  const extensionRootRemoved = await fs
    .access(extensionRoot)
    .then(() => false)
    .catch((error) => error?.code === "ENOENT");
  return {
    registryInsideProfile: isInside(profile, registryPath),
    registryEmpty: registry?.version === 1 && registry.extensions?.length === 0,
    extensionRootRemoved,
  };
}

async function inspectAttemptStorage(profile, extensionId) {
  const storageRoot = path.join(profile, "extensions");
  const registryPath = path.join(storageRoot, "installed-extensions.json");
  const extensionRoot = path.join(storageRoot, extensionId);
  const summary = {
    storageRootInsideProfile: isInside(profile, storageRoot),
    registryInsideProfile: isInside(profile, registryPath),
    extensionRootInsideProfile: isInside(profile, extensionRoot),
    registryExists: false,
    registryExtensionIds: [],
    extensionRootExists: false,
    allEntriesInsideProfile: true,
    symbolicLinks: 0,
    files: 0,
    directories: 0,
    bytes: 0,
  };
  try {
    const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
    summary.registryExists = true;
    summary.registryExtensionIds = Array.isArray(registry?.extensions)
      ? registry.extensions
          .map((entry) => entry?.id)
          .filter((id) => typeof id === "string")
      : [];
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (!isInside(profile, entryPath))
        summary.allEntriesInsideProfile = false;
      if (entry.isSymbolicLink()) {
        summary.symbolicLinks += 1;
      } else if (entry.isDirectory()) {
        summary.directories += 1;
        await walk(entryPath);
      } else if (entry.isFile()) {
        summary.files += 1;
        summary.bytes += (await fs.stat(entryPath)).size;
      }
    }
  }

  try {
    await fs.access(extensionRoot);
    summary.extensionRootExists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await walk(storageRoot);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  summary.confined =
    summary.storageRootInsideProfile &&
    summary.registryInsideProfile &&
    summary.extensionRootInsideProfile &&
    summary.allEntriesInsideProfile &&
    summary.symbolicLinks === 0;
  return summary;
}

function extensionLoadWarnings(log) {
  const match = log.match(
    /ExtensionLoadWarning:[^\r\n]*(?:\r?\n\s{2}[^\r\n]*)*/u,
  );
  if (!match) return [];
  return match[0]
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean);
}

function redactText(value, profile) {
  if (typeof value !== "string") return value;
  let safe = value;
  const replacements = [
    [profile, "<TEMP_PROFILE>"],
    [root, "<WORKSPACE>"],
    [os.homedir(), "<HOME>"],
    [os.tmpdir(), "<TEMP>"],
  ];
  for (const [needle, replacement] of replacements) {
    if (!needle) continue;
    safe = safe.replaceAll(needle, replacement);
    safe = safe.replaceAll(needle.replaceAll("\\", "/"), replacement);
  }
  safe = safe.replaceAll(/https?:\/\/[^\s"'<>]+/giu, (candidate) => {
    try {
      const url = new URL(candidate.replace(/[),.;]+$/u, ""));
      url.username = "";
      url.password = "";
      url.search = url.search ? "?<REDACTED>" : "";
      url.hash = url.hash ? "#<REDACTED>" : "";
      return url.toString();
    } catch {
      return "<REDACTED_URL>";
    }
  });
  safe = safe.replace(
    /\b(token|access_token|refresh_token|authorization|auth|code|key)=([^\s&]+)/giu,
    "$1=<REDACTED>",
  );
  return safe;
}

function redactValue(value, profile) {
  if (typeof value === "string") return redactText(value, profile);
  if (Array.isArray(value))
    return value.map((item) => redactValue(item, profile));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactValue(item, profile),
      ]),
    );
  }
  return value;
}

async function removeDisposableProfile(profile) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const resolvedProfile = path.resolve(profile);
  if (
    path.dirname(resolvedProfile) !== temporaryRoot ||
    !path
      .basename(resolvedProfile)
      .startsWith("chromecraft-web-store-diagnostic-")
  ) {
    throw new Error("Refusing to remove a non-disposable extension profile.");
  }
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rm(resolvedProfile, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await delay(100 * (attempt + 1));
    }
  }
  throw lastError;
}

await fs.access(executable);
await fs.mkdir(artifactDirectory, { recursive: true });
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "chromecraft-web-store-diagnostic-"),
);
await fs.writeFile(
  path.join(profile, "preferences.json"),
  `${JSON.stringify(
    {
      restoreSession: false,
      ublockEnabled: false,
      hyperdriveMode: "off",
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const startedAt = new Date().toISOString();
const checks = [];
const cleanupErrors = [];
let child;
let shell;
let rawLog = "";
let installResult = null;
let snapshotAfterAttempt = null;
let installSucceeded = false;
let uninstallSucceeded = false;
let storageAfterAttempt = null;
let failure = null;
let cleanup = {
  uninstallAttempted: false,
  processTerminated: false,
  profileRemoved: false,
};

try {
  const debugPort = await findFreePort();
  child = spawn(
    executable,
    [
      `--chromecraft-user-data=${profile}`,
      `--user-data-dir=${profile}`,
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
  child.stdout.on("data", (chunk) => (rawLog += chunk.toString()));
  child.stderr.on("data", (chunk) => (rawLog += chunk.toString()));

  const shellTarget = await waitForShellTarget(debugPort);
  shell = await CdpClient.connect(shellTarget.webSocketDebuggerUrl);
  const initialSnapshot = await poll(
    () => shell.evaluate("window.chromecraft?.getExtensions()"),
    (value) =>
      value?.initialized === true &&
      value.operation === "idle" &&
      value.items?.length === 0,
    "an initialized empty extension manager",
  );
  checks.push({
    name: "starts-with-empty-disposable-registry",
    passed: true,
    snapshot: initialSnapshot,
  });

  installResult = await shell.evaluate(`(async () => {
    try {
      await window.chromecraft.installExtensionFromWebStore(${JSON.stringify(requestedUrl)});
      return { ok: true, error: null };
    } catch (error) {
      return {
        ok: false,
        error: {
          name: error?.name ?? "Error",
          message: error?.message ?? String(error),
          stack: error?.stack ?? null,
        },
      };
    }
  })()`);
  snapshotAfterAttempt = await poll(
    () => shell.evaluate("window.chromecraft.getExtensions()"),
    (value) => value?.initialized === true && value.operation === "idle",
    "the Web Store install operation to settle",
    120_000,
  );
  storageAfterAttempt = await inspectAttemptStorage(profile, requestedId);

  if (!installResult?.ok) {
    throw new Error(
      `Web Store install API failed: ${installResult?.error?.message ?? "Unknown failure."}`,
    );
  }

  const installed = snapshotAfterAttempt.items.find(
    (item) => item.id === requestedId,
  );
  if (!installed) {
    throw new Error(
      "The install API returned without registering the extension.",
    );
  }
  installSucceeded = true;
  checks.push({
    name: "real-web-store-api-installs-and-electron-loads-extension",
    passed:
      installed.enabled === true &&
      installed.ready === true &&
      installed.status === "ready",
    snapshot: installed,
    warnings: installed.warnings,
    scope:
      "Install and Electron load status only; extension features were not exercised.",
  });
  if (!checks.at(-1).passed) {
    throw new Error(
      `The extension registered but did not reach ready status (${installed.status}).`,
    );
  }

  if (installed.popupUrl) {
    const browserSnapshotBeforePopup = await shell.evaluate(
      "window.chromecraft.getSnapshot()",
    );
    await poll(
      () =>
        shell.evaluate(
          `Boolean(document.querySelector('[data-extension-action=${JSON.stringify(requestedId)}]'))`,
        ),
      Boolean,
      "the installed extension toolbar action to render",
    );
    const toolbarActivation = await shell.evaluate(
      `(() => {
        const button = document.querySelector(
          '[data-extension-action=${JSON.stringify(requestedId)}]',
        );
        if (!(button instanceof HTMLElement)) {
          return { clicked: false, anchor: null };
        }
        const rect = button.getBoundingClientRect();
        button.click();
        return {
          clicked: true,
          anchor: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
        };
      })()`,
    );
    if (!toolbarActivation.clicked) {
      throw new Error(
        "The installed extension toolbar action could not be clicked.",
      );
    }

    const popupOpenSnapshot = await poll(
      () => shell.evaluate("window.chromecraft.getExtensions()"),
      (value) => value?.popupExtensionId === requestedId,
      "the anchored extension popup state to become active",
    );
    const browserSnapshotWhilePopupOpen = await shell.evaluate(
      "window.chromecraft.getSnapshot()",
    );
    checks.push({
      name: "toolbar-action-opens-anchored-extension-popup-without-a-tab",
      passed:
        popupOpenSnapshot.popupExtensionId === requestedId &&
        browserSnapshotWhilePopupOpen.tabs.length ===
          browserSnapshotBeforePopup.tabs.length &&
        browserSnapshotWhilePopupOpen.activeTabId ===
          browserSnapshotBeforePopup.activeTabId,
      toolbarActivation,
      popupExtensionId: popupOpenSnapshot.popupExtensionId,
      before: {
        tabCount: browserSnapshotBeforePopup.tabs.length,
        activeTabId: browserSnapshotBeforePopup.activeTabId,
      },
      after: {
        tabCount: browserSnapshotWhilePopupOpen.tabs.length,
        activeTabId: browserSnapshotWhilePopupOpen.activeTabId,
      },
    });
    if (!checks.at(-1).passed) {
      throw new Error(
        "The extension toolbar action did not open an anchored popup without changing browser tabs.",
      );
    }

    let popupRuntime;
    let browserSnapshotAfterRuntime;
    let popupClosedSnapshot;
    let popupTargetRemoved = false;
    try {
      popupRuntime = await inspectPopupRuntime(debugPort, installed.popupUrl);
      browserSnapshotAfterRuntime = await shell.evaluate(
        "window.chromecraft.getSnapshot()",
      );
    } finally {
      await shell.evaluate("window.chromecraft.closeExtensionPopup()");
      popupClosedSnapshot = await poll(
        () => shell.evaluate("window.chromecraft.getExtensions()"),
        (value) => value?.popupExtensionId == null,
        "the anchored extension popup state to clear",
      );
      await poll(
        () => targetList(debugPort),
        (targets) =>
          !targets.some(
            (target) =>
              target.type === "page" && target.url === installed.popupUrl,
          ),
        "the anchored extension popup target to be destroyed",
      );
      popupTargetRemoved = true;
    }

    checks.push({
      name: "declared-extension-popup-renders-meaningful-content",
      passed:
        popupRuntime?.meaningfulContent === true &&
        browserSnapshotAfterRuntime?.tabs.length ===
          browserSnapshotBeforePopup.tabs.length &&
        browserSnapshotAfterRuntime?.activeTabId ===
          browserSnapshotBeforePopup.activeTabId,
      before: {
        tabCount: browserSnapshotBeforePopup.tabs.length,
        activeTabId: browserSnapshotBeforePopup.activeTabId,
      },
      after: {
        tabCount: browserSnapshotAfterRuntime?.tabs.length ?? null,
        activeTabId: browserSnapshotAfterRuntime?.activeTabId ?? null,
      },
      runtime: popupRuntime,
    });
    if (!checks.at(-1).passed) {
      throw new Error(
        "The anchored extension popup loaded but remained blank or stuck in its loading state.",
      );
    }

    checks.push({
      name: "anchored-extension-popup-closes-and-destroys-its-target",
      passed:
        popupClosedSnapshot?.popupExtensionId == null && popupTargetRemoved,
      popupExtensionId: popupClosedSnapshot?.popupExtensionId ?? null,
      popupTargetRemoved,
    });
    if (!checks.at(-1).passed) {
      throw new Error("The anchored extension popup did not close cleanly.");
    }
  }

  const storage = await inspectExtensionStorage(
    profile,
    requestedId,
    installed.version,
  );
  checks.push({
    name: "extension-files-and-registry-are-confined-to-disposable-profile",
    passed: storage.confined,
    storage,
  });
  if (!storage.confined) {
    throw new Error("Extension storage confinement verification failed.");
  }

  cleanup.uninstallAttempted = true;
  await shell.evaluate(
    `window.chromecraft.removeExtension(${JSON.stringify(requestedId)})`,
  );
  const removedSnapshot = await poll(
    () => shell.evaluate("window.chromecraft.getExtensions()"),
    (value) =>
      value?.initialized === true &&
      value.operation === "idle" &&
      !value.items?.some((item) => item.id === requestedId),
    "the installed extension to be removed",
  );
  const removedStorage = await inspectUninstalledStorage(profile, requestedId);
  uninstallSucceeded =
    removedStorage.registryInsideProfile &&
    removedStorage.registryEmpty &&
    removedStorage.extensionRootRemoved;
  checks.push({
    name: "successful-install-is-uninstalled",
    passed: uninstallSucceeded,
    snapshot: removedSnapshot,
    storage: removedStorage,
  });
  if (!uninstallSucceeded) {
    throw new Error("The extension did not uninstall cleanly.");
  }
} catch (error) {
  failure = error?.stack ?? error?.message ?? String(error);
} finally {
  if (installSucceeded && !uninstallSucceeded && shell) {
    cleanup.uninstallAttempted = true;
    try {
      await shell.evaluate(`(async () => {
        try {
          await window.chromecraft.removeExtension(${JSON.stringify(requestedId)});
          return true;
        } catch {
          return false;
        }
      })()`);
    } catch (error) {
      cleanupErrors.push(
        `Fallback uninstall failed: ${error?.message ?? error}`,
      );
    }
  }
  shell?.close();
  try {
    await terminate(child);
    cleanup.processTerminated = true;
  } catch (error) {
    cleanupErrors.push(`Process cleanup failed: ${error?.message ?? error}`);
  }
  try {
    await removeDisposableProfile(profile);
    cleanup.profileRemoved = await fs
      .access(profile)
      .then(() => false)
      .catch((error) => error?.code === "ENOENT");
  } catch (error) {
    cleanupErrors.push(`Profile cleanup failed: ${error?.message ?? error}`);
  }
}

const report = redactValue(
  {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    success:
      failure === null &&
      installSucceeded &&
      uninstallSucceeded &&
      cleanup.processTerminated &&
      cleanup.profileRemoved &&
      cleanupErrors.length === 0 &&
      checks.every((check) => check.passed),
    scope:
      "Chrome Web Store install, Electron load status, storage confinement, and uninstall only.",
    packagedExecutable: path.relative(root, executable),
    requestedExtension: {
      id: requestedId,
      itemUrl: parsedStoreItem.safeUrl,
      defaultFixture: requestedId === defaultExtensionId,
    },
    installResult,
    snapshotAfterAttempt,
    runtimeWarnings: extensionLoadWarnings(rawLog),
    storageAfterAttempt,
    checks,
    cleanup,
    cleanupErrors,
    failure,
  },
  profile,
);
await fs.writeFile(logPath, redactText(rawLog, profile), "utf8");
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (!report.success) process.exitCode = 1;
