import { execFile as execFileCallback, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
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
const extensionId = "nngceckbapebfimnlniiiahkandclblb";
const artifactDirectory = path.join(root, ".artifacts", "extensions");
const reportPath = path.join(
  artifactDirectory,
  "real-profile-bitwarden-window-bridge.json",
);
const browserDataPath = path.join(
  process.env.APPDATA ?? "",
  "Chromecraft",
  "browser-data.json",
);

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

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
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("The DevTools target closed."));
      }
      this.pending.clear();
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
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
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text,
      );
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

const targetList = (port) => fetchJson(`http://127.0.0.1:${port}/json/list`);

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

function relaunchNormally() {
  const child = spawn(executable, [], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
}

function safeLogLines(log, pattern) {
  return log
    .split(/\r?\n/u)
    .filter((line) => pattern.test(line))
    .map((line) =>
      line
        .replace(/access_token=[^\s&"]+/giu, "access_token=[REDACTED]")
        .replaceAll(process.env.USERPROFILE ?? "", "<HOME>"),
    )
    .slice(0, 50);
}

await fs.access(executable);
await fs.mkdir(artifactDirectory, { recursive: true });
const startedAt = new Date().toISOString();
const debugPort = await findFreePort();
const browserDataBackup = await fs
  .readFile(browserDataPath)
  .then((data) => ({ existed: true, data }))
  .catch((error) => {
    if (error?.code === "ENOENT") return { existed: false, data: null };
    throw error;
  });

let child;
let shell;
let worker;
let bridgePage;
let bridgeWindowId;
let rawLog = "";
let failure = null;
let result = {};

try {
  child = spawn(
    executable,
    [
      `--remote-debugging-port=${debugPort}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
    ],
    {
      cwd: root,
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    },
  );
  child.stdout.on("data", (chunk) => (rawLog += chunk.toString()));
  child.stderr.on("data", (chunk) => (rawLog += chunk.toString()));

  const shellTarget = await waitForShellTarget(debugPort);
  shell = await CdpClient.connect(shellTarget.webSocketDebuggerUrl);
  const extensions = await poll(
    () => shell.evaluate("window.chromecraft?.getExtensions()"),
    (value) =>
      value?.initialized === true &&
      value.operation === "idle" &&
      value.items?.some(
        (item) => item.id === extensionId && item.enabled && item.ready,
      ),
    "Bitwarden to load from the real profile",
    60_000,
  );
  const browserBefore = await shell.evaluate(
    "window.chromecraft.getSnapshot()",
  );
  const beforeIds = browserBefore.tabs.map((tab) => tab.id);
  const activeUrl = browserBefore.tabs.find(
    (tab) => tab.id === browserBefore.activeTabId,
  )?.url;
  if (activeUrl?.startsWith("http")) {
    await poll(
      () => targetList(debugPort),
      (items) => items.some((target) => target.url === activeUrl),
      "the active web page used by the restricted bridge content script",
      45_000,
    );
    await delay(500);
  }

  const targetsBefore = await targetList(debugPort);
  const workerTarget = targetsBefore.find(
    (target) =>
      target.type === "service_worker" &&
      target.url.startsWith(`chrome-extension://${extensionId}/`),
  );
  if (!workerTarget)
    throw new Error("Bitwarden service worker is unavailable.");
  worker = await CdpClient.connect(workerTarget.webSocketDebuggerUrl);
  await worker.send("Runtime.enable");

  const created = await worker.evaluate(`(async () => {
    const value = await chrome.windows.create({
      url: chrome.runtime.getURL("popup/index.html?uilocation=popout#/lock"),
      type: "popup",
      focused: true,
      width: 420,
      height: 630
    });
    return {
      api: {
        create: typeof chrome.windows?.create,
        update: typeof chrome.windows?.update,
        remove: typeof chrome.windows?.remove
      },
      value
    };
  })()`);
  bridgeWindowId = created?.value?.id;
  if (!Number.isInteger(bridgeWindowId)) {
    throw new Error(`Invalid created window: ${JSON.stringify(created)}`);
  }

  const bridgeTarget = await poll(
    () => targetList(debugPort),
    (items) =>
      items.find((target) => {
        try {
          const url = new URL(target.url);
          return (
            target.type === "page" &&
            url.hostname === extensionId &&
            url.pathname === "/popup/index.html" &&
            url.searchParams.get("uilocation") === "popout"
          );
        } catch {
          return false;
        }
      }),
    "the extension BrowserWindow target",
  ).then((items) =>
    items.find((target) => {
      try {
        const url = new URL(target.url);
        return (
          target.type === "page" &&
          url.hostname === extensionId &&
          url.pathname === "/popup/index.html" &&
          url.searchParams.get("uilocation") === "popout"
        );
      } catch {
        return false;
      }
    }),
  );
  bridgePage = await CdpClient.connect(bridgeTarget.webSocketDebuggerUrl);
  await Promise.all([
    bridgePage.send("Runtime.enable"),
    bridgePage.send("Page.enable"),
  ]);
  const rendered = await poll(
    () =>
      bridgePage.evaluate(`(() => {
        const root = document.querySelector("app-root, #root, #app");
        return {
          readyState: document.readyState,
          title: document.title,
          windowName: globalThis.name,
          bodyTextLength: document.body?.innerText?.trim().length ?? 0,
          rootTextLength: root?.innerText?.trim().length ?? 0,
          buttonCount: document.querySelectorAll("button").length,
          formCount: document.querySelectorAll("form").length,
          inputCount: document.querySelectorAll("input").length,
          focused: document.hasFocus(),
          outerWidth,
          outerHeight
        };
      })()`),
    (value) =>
      value?.readyState === "complete" &&
      value.title === "Bitwarden" &&
      value.bodyTextLength > 0 &&
      value.rootTextLength > 0 &&
      value.outerWidth > 0 &&
      value.outerHeight > 0,
    "rendered Bitwarden UI in a nonzero native window",
  );
  const tabsWhileOpen = await shell.evaluate(
    "window.chromecraft.getSnapshot()",
  );
  const updated = await worker.evaluate(`(async () => {
    return chrome.windows.update(${JSON.stringify(bridgeWindowId)}, {
      focused: true,
      width: 430,
      height: 640
    });
  })()`);
  await delay(300);
  const boundsAfterUpdate = await bridgePage.evaluate(`({
    focused: document.hasFocus(),
    outerWidth,
    outerHeight
  })`);
  bridgePage.close();
  bridgePage = null;
  await worker.evaluate(`(async () => {
    await chrome.windows.remove(${JSON.stringify(bridgeWindowId)});
    return true;
  })()`);
  const targetsAfterRemove = await poll(
    () => targetList(debugPort),
    (items) => !items.some((target) => target.id === bridgeTarget.id),
    "the extension BrowserWindow target to be destroyed",
  );
  bridgeWindowId = null;
  const tabsAfterRemove = await shell.evaluate(
    "window.chromecraft.getSnapshot()",
  );
  result = {
    extension: extensions.items.find((item) => item.id === extensionId),
    created,
    rendered,
    updated,
    boundsAfterUpdate,
    separateTargetCreated: !targetsBefore.some(
      (target) => target.id === bridgeTarget.id,
    ),
    targetDestroyed: !targetsAfterRemove.some(
      (target) => target.id === bridgeTarget.id,
    ),
    tabsUnchangedWhileOpen:
      JSON.stringify(tabsWhileOpen.tabs.map((tab) => tab.id)) ===
        JSON.stringify(beforeIds) &&
      tabsWhileOpen.activeTabId === browserBefore.activeTabId,
    tabsUnchangedAfterRemove:
      JSON.stringify(tabsAfterRemove.tabs.map((tab) => tab.id)) ===
        JSON.stringify(beforeIds) &&
      tabsAfterRemove.activeTabId === browserBefore.activeTabId,
    credentialCeremonyInvoked: false,
  };
} catch (error) {
  failure = error?.stack ?? error?.message ?? String(error);
} finally {
  bridgePage?.close();
  if (worker && Number.isInteger(bridgeWindowId)) {
    await worker
      .evaluate(`chrome.windows.remove(${JSON.stringify(bridgeWindowId)})`)
      .catch(() => undefined);
  }
  worker?.close();
  shell?.close();
  await terminate(child);
  if (browserDataBackup.existed) {
    const restorePath = `${browserDataPath}.${process.pid}.restore`;
    await fs.mkdir(path.dirname(browserDataPath), { recursive: true });
    await fs.writeFile(restorePath, browserDataBackup.data);
    await fs.rename(restorePath, browserDataPath);
  } else {
    await fs.rm(browserDataPath, { force: true });
  }
  relaunchNormally();
}

const runtimeErrors = safeLogLines(
  rawLog,
  /Extension Error:|Service worker registration failed|Uncaught(?: \(in promise\))?|^\s+Message:/u,
);
const success =
  failure === null &&
  result.separateTargetCreated === true &&
  result.targetDestroyed === true &&
  result.tabsUnchangedWhileOpen === true &&
  result.tabsUnchangedAfterRemove === true &&
  result.credentialCeremonyInvoked === false &&
  result.rendered?.outerWidth > 0 &&
  result.rendered?.outerHeight > 0 &&
  result.rendered?.bodyTextLength > 0;
const report = {
  schemaVersion: 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  success,
  packagedExecutable: path.relative(root, executable),
  ...result,
  runtimeErrors,
  failure,
  relaunchedNormally: true,
};
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (!success) process.exitCode = 1;
