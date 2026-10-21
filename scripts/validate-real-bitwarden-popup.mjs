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
const extensionId = "nngceckbapebfimnlniiiahkandclblb";
const artifactDirectory = path.join(root, ".artifacts", "extensions");
const reportPath = path.join(
  artifactDirectory,
  "real-profile-bitwarden-popup.json",
);
const logPath = path.join(
  artifactDirectory,
  "real-profile-bitwarden-popup.log",
);
const lifecyclePath = path.join(
  artifactDirectory,
  "real-profile-bitwarden-popup-lifecycle.json",
);
const browserDataPath = path.join(
  process.env.APPDATA ?? "",
  "Chromecraft",
  "browser-data.json",
);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

async function startPasskeyFixture() {
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const server = http.createServer((request, response) => {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'",
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(
      '<!doctype html><html><head><meta charset="utf-8"><title>Passkey hook probe</title></head><body><main id="probe-ready">Passkey hook probe</main></body></html>',
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not start the passkey fixture server.");
  }
  return {
    url: `http://localhost:${address.port}/bitwarden-passkey-probe/${nonce}`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
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

async function waitForPopupTarget(port, popupUrl) {
  const targets = await poll(
    () => targetList(port),
    (items) =>
      items.some((target) => target.type === "page" && target.url === popupUrl),
    "the anchored extension popup target",
  );
  return targets.find(
    (target) => target.type === "page" && target.url === popupUrl,
  );
}

function safeErrorText(value) {
  if (typeof value !== "string") return String(value ?? "");
  return value
    .replaceAll(os.homedir(), "<HOME>")
    .replaceAll(root, "<WORKSPACE>")
    .replaceAll(root.replaceAll("\\", "/"), "<WORKSPACE>")
    .replaceAll(/https?:\/\/[^\s"'<>]+/giu, (candidate) => {
      try {
        const url = new URL(candidate.replace(/[),.;]+$/u, ""));
        return `${url.protocol}//${url.host}/<REDACTED>`;
      } catch {
        return "<REDACTED_URL>";
      }
    })
    .slice(0, 4_000);
}

function extensionRuntimeDiagnostics(log) {
  const lines = log.split(/\r?\n/u);
  return {
    errors: lines
      .filter(
        (line) =>
          /Extension Error:|Service worker registration failed|Uncaught(?: \(in promise\))?|^\s+Message:/u.test(
            line,
          ) &&
          (line.includes(extensionId) ||
            /Extension Error:|Service worker registration failed|^\s+Message:/u.test(
              line,
            )),
      )
      .map(safeErrorText)
      .slice(0, 50),
    informational: lines
      .filter(
        (line) =>
          line.includes(extensionId) &&
          /WebAssembly|WASM SDK|State version|Managed configuration|WebPush|SignalR|TargetingRulesDataService/u.test(
            line,
          ),
      )
      .map(safeErrorText)
      .slice(0, 50),
  };
}

function extensionTargets(items) {
  const prefix = `chrome-extension://${extensionId}/`;
  return items
    .filter((item) => item.url?.startsWith(prefix))
    .map((item) => ({
      type: item.type,
      title: item.title,
      url: item.url.split(/[?#]/u, 1)[0],
    }));
}

function sameDocumentUrl(actual, expected) {
  try {
    const actualUrl = new URL(actual);
    const expectedUrl = new URL(expected);
    return (
      actualUrl.protocol === expectedUrl.protocol &&
      actualUrl.hostname === expectedUrl.hostname &&
      actualUrl.pathname === expectedUrl.pathname
    );
  } catch {
    return false;
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

async function relaunchNormally() {
  const child = spawn(executable, [], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
}

await fs.access(executable);
await fs.mkdir(artifactDirectory, { recursive: true });

const running = await execFile(
  "tasklist",
  ["/FI", "IMAGENAME eq chromecraft.exe", "/FO", "CSV", "/NH"],
  {
    windowsHide: true,
  },
).then(({ stdout }) => stdout.includes("chromecraft.exe"));
if (running) {
  throw new Error(
    "Chromecraft is already running. Close it before the real-profile popup validation.",
  );
}

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
let popup;
let browserCdp;
let extensionWorker;
let bridgeWindowId;
let passkeyFixture;
let rawLog = "";
let failure = null;
let reportData = {};
let relaunchedNormally = false;

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
  const extensionsBefore = await poll(
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
  const bitwarden = extensionsBefore.items.find(
    (item) => item.id === extensionId,
  );
  if (!bitwarden?.popupUrl) {
    throw new Error("The installed Bitwarden extension has no popup URL.");
  }

  const browserBefore = await shell.evaluate(
    "window.chromecraft.getSnapshot()",
  );
  const targetsBefore = await targetList(debugPort);
  const activePageUrl = browserBefore.tabs.find(
    (tab) => tab.id === browserBefore.activeTabId,
  )?.url;
  const inspectedPageTarget = targetsBefore.find((target) => {
    try {
      const url = new URL(target.url);
      return (
        target.type === "page" &&
        target.url === activePageUrl &&
        /^https?:$/u.test(url.protocol)
      );
    } catch {
      return false;
    }
  });
  let credentialsInspection = null;
  if (inspectedPageTarget) {
    const inspectedPage = await CdpClient.connect(
      inspectedPageTarget.webSocketDebuggerUrl,
    );
    try {
      credentialsInspection = await inspectedPage.evaluate(`(() => {
        const get = navigator.credentials?.get;
        const source = typeof get === "function"
          ? Function.prototype.toString.call(get)
          : "";
        return {
          origin: location.origin,
          functionType: typeof get,
          functionName: typeof get === "function" ? get.name : null,
          functionLength: typeof get === "function" ? get.length : null,
          nativeLike: /\\[native code\\]/u.test(source),
          bitwardenWrapperName: typeof get === "function" && get.name === "getWebAuthnCredential",
          ownMethod: Object.prototype.hasOwnProperty.call(navigator.credentials ?? {}, "get")
        };
      })()`);
    } finally {
      inspectedPage.close();
    }
  }
  const lifecycleStartedAt = Date.now();
  const browserVersion = await fetchJson(
    `http://127.0.0.1:${debugPort}/json/version`,
  );
  browserCdp = await CdpClient.connect(browserVersion.webSocketDebuggerUrl);
  const initialTargetIds = new Set(targetsBefore.map((target) => target.id));
  const targetEvents = [];
  const recordTargetEvent = (kind, event) => {
    const info = event.targetInfo;
    const targetId = info?.targetId ?? event.targetId ?? null;
    if (targetId && initialTargetIds.has(targetId)) return;
    targetEvents.push({
      milliseconds: Date.now() - lifecycleStartedAt,
      kind,
      targetId,
      type: info?.type ?? null,
      title: info?.title ?? null,
      url: info?.url?.split(/[?#]/u, 1)[0] ?? null,
      status: event.status ?? null,
      errorCode: event.errorCode ?? null,
    });
  };
  browserCdp.on("Target.targetCreated", (event) =>
    recordTargetEvent("created", event),
  );
  browserCdp.on("Target.targetInfoChanged", (event) =>
    recordTargetEvent("changed", event),
  );
  browserCdp.on("Target.targetDestroyed", (event) =>
    recordTargetEvent("destroyed", event),
  );
  browserCdp.on("Target.targetCrashed", (event) =>
    recordTargetEvent("crashed", event),
  );
  await browserCdp.send("Target.setDiscoverTargets", { discover: true });

  await shell.evaluate(`(() => {
    const events = [];
    const record = (type) => events.push({ type, milliseconds: performance.now() });
    for (const type of ["blur", "focus", "resize", "pointerdown"]) {
      addEventListener(type, () => record(type), { capture: true });
    }
    window.__chromecraftPopupProbe = { state: "pending", error: null, events };
    void window.chromecraft.toggleExtensionPopup(
      ${JSON.stringify(extensionId)},
      { x: 900, y: 52, width: 40, height: 40 }
    ).then(
      () => { window.__chromecraftPopupProbe.state = "resolved"; },
      (error) => {
        window.__chromecraftPopupProbe.state = "rejected";
        window.__chromecraftPopupProbe.error = error?.message ?? String(error);
      }
    );
    return true;
  })()`);

  const lifecycleSamples = [];
  let popupTarget = null;
  let previousSignature = "";
  while (Date.now() - lifecycleStartedAt < 5_250) {
    const [extensionState, targets, shellProbe] = await Promise.all([
      shell.evaluate("window.chromecraft.getExtensions()"),
      targetList(debugPort),
      shell.evaluate("window.__chromecraftPopupProbe"),
    ]);
    const matchingTarget = targets.find(
      (target) =>
        target.type === "page" &&
        sameDocumentUrl(target.url, bitwarden.popupUrl),
    );
    if (!popupTarget && matchingTarget) popupTarget = matchingTarget;
    const extensionTargetSnapshot = extensionTargets(targets);
    const signature = JSON.stringify({
      popupExtensionId: extensionState?.popupExtensionId ?? null,
      extensionTargetSnapshot,
      state: shellProbe?.state ?? null,
      error: shellProbe?.error ?? null,
      eventCount: shellProbe?.events?.length ?? 0,
    });
    if (signature !== previousSignature) {
      lifecycleSamples.push({
        milliseconds: Date.now() - lifecycleStartedAt,
        popupExtensionId: extensionState?.popupExtensionId ?? null,
        extensionTargets: extensionTargetSnapshot,
        promise: shellProbe,
      });
      previousSignature = signature;
    }
    if (
      Date.now() - lifecycleStartedAt > 250 &&
      shellProbe?.state !== "pending" &&
      extensionState?.popupExtensionId === null &&
      !matchingTarget
    ) {
      break;
    }
    await delay(10);
  }
  const extensionsOpen = await shell.evaluate(
    "window.chromecraft.getExtensions()",
  );
  const browserOpen = await shell.evaluate("window.chromecraft.getSnapshot()");
  const targetsOpen = await targetList(debugPort);
  const lifecycleElapsedMs = Date.now() - lifecycleStartedAt;
  const popupStillTargeted = targetsOpen.some(
    (target) =>
      target.type === "page" && sameDocumentUrl(target.url, bitwarden.popupUrl),
  );
  const stayedOpenFiveSeconds =
    lifecycleElapsedMs >= 5_000 &&
    extensionsOpen?.popupExtensionId === extensionId &&
    popupStillTargeted;
  await fs.writeFile(
    lifecyclePath,
    `${JSON.stringify(
      {
        sampledAt: new Date().toISOString(),
        popupTargetObserved: Boolean(popupTarget),
        popupExtensionIdAfterSampling: extensionsOpen?.popupExtensionId ?? null,
        lifecycleSamples,
        targetEvents,
        lifecycleElapsedMs,
        stayedOpenFiveSeconds,
        credentialsInspection,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  if (!popupTarget) {
    reportData = {
      extension: {
        id: bitwarden.id,
        name: bitwarden.name,
        version: bitwarden.version,
        ready: bitwarden.ready,
        status: bitwarden.status,
        popupUrl: bitwarden.popupUrl,
      },
      lifecycle: { samples: lifecycleSamples, targetEvents },
      popupState: {
        before: extensionsBefore.popupExtensionId,
        open: extensionsOpen.popupExtensionId,
      },
      tabs: {
        beforeIds: browserBefore.tabs.map((tab) => tab.id),
        openIds: browserOpen.tabs.map((tab) => tab.id),
        activeBefore: browserBefore.activeTabId,
        activeOpen: browserOpen.activeTabId,
      },
      targets: {
        before: extensionTargets(targetsBefore),
        open: extensionTargets(targetsOpen),
      },
    };
    throw new Error(
      "The anchored popup target was destroyed before CDP could attach.",
    );
  }

  const consoleErrors = [];
  const exceptions = [];
  const failedRequests = [];
  popup = await CdpClient.connect(popupTarget.webSocketDebuggerUrl);
  popup.on("Runtime.consoleAPICalled", (event) => {
    if (!new Set(["error", "warning", "assert"]).has(event.type)) return;
    consoleErrors.push({
      type: event.type,
      message: safeErrorText(
        (event.args ?? [])
          .map((argument) => argument.value ?? argument.description ?? "")
          .join(" | "),
      ),
      source:
        event.stackTrace?.callFrames?.[0]?.url?.split(/[?#]/u, 1)[0] ?? null,
      lineNumber: event.stackTrace?.callFrames?.[0]?.lineNumber ?? null,
    });
  });
  popup.on("Runtime.exceptionThrown", (event) => {
    exceptions.push({
      message: safeErrorText(
        event.exceptionDetails?.exception?.description ??
          event.exceptionDetails?.text ??
          "Unknown exception",
      ),
      source: event.exceptionDetails?.url?.split(/[?#]/u, 1)[0] ?? null,
      lineNumber: event.exceptionDetails?.lineNumber ?? null,
    });
  });
  popup.on("Network.loadingFailed", (event) => {
    failedRequests.push({
      errorText: event.errorText,
      canceled: event.canceled ?? false,
      blockedReason: event.blockedReason ?? null,
    });
  });
  await Promise.all([
    popup.send("Runtime.enable"),
    popup.send("Network.enable"),
    popup.send("Page.enable"),
  ]);
  const rendered = await poll(
    () =>
      popup.evaluate(`(() => {
        const body = document.body;
        const root = document.querySelector("app-root, #root, #app");
        const spinner = document.querySelector("#loading, .bwi-spinner, [role=progressbar]");
        const spinnerStyle = spinner ? getComputedStyle(spinner) : null;
        const spinnerRect = spinner?.getBoundingClientRect();
        const spinnerVisible = Boolean(
          spinner &&
          spinnerStyle?.display !== "none" &&
          spinnerStyle?.visibility !== "hidden" &&
          Number(spinnerStyle?.opacity ?? "1") > 0 &&
          spinnerRect &&
          spinnerRect.width > 0 &&
          spinnerRect.height > 0
        );
        const visibleInputs = [...document.querySelectorAll("input")].filter((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        });
        return {
          readyState: document.readyState,
          title: document.title,
          bodyTextLength: body?.innerText?.trim().length ?? 0,
          bodyHtmlLength: body?.innerHTML?.length ?? 0,
          rootChildCount: root?.childElementCount ?? 0,
          rootTextLength: root?.innerText?.trim().length ?? 0,
          spinnerPresent: Boolean(spinner),
          spinnerVisible,
          buttonCount: document.querySelectorAll("button").length,
          formCount: document.querySelectorAll("form").length,
          visibleInputCount: visibleInputs.length,
          inputTypes: [...new Set(visibleInputs.map((element) => element.type || "text"))].sort(),
          compat: {
            webNavigation: typeof chrome?.webNavigation,
            webNavigationOnCommitted: typeof chrome?.webNavigation?.onCommitted?.addListener,
            tabsGetCurrent: typeof chrome?.tabs?.getCurrent,
            windowsGetCurrent: typeof chrome?.windows?.getCurrent,
          },
        };
      })()`),
    (value) =>
      value?.readyState === "complete" &&
      value.bodyTextLength > 0 &&
      value.rootTextLength > 0 &&
      value.spinnerVisible === false &&
      (value.formCount > 0 ||
        value.buttonCount > 0 ||
        value.visibleInputCount > 0),
    "Bitwarden's meaningful popup UI to replace the loading spinner",
    30_000,
  );

  const targetsRendered = await targetList(debugPort);
  await shell.evaluate("window.chromecraft.closeExtensionPopup()");
  const extensionsClosed = await poll(
    () => shell.evaluate("window.chromecraft.getExtensions()"),
    (value) => value?.popupExtensionId === null,
    "the popup state to close",
  );
  const targetsClosed = await poll(
    () => targetList(debugPort),
    (items) =>
      !items.some((item) => sameDocumentUrl(item.url, bitwarden.popupUrl)),
    "the popup WebContents target to be destroyed",
  );
  const browserClosed = await shell.evaluate(
    "window.chromecraft.getSnapshot()",
  );

  const bridgeTargetsBefore = await targetList(debugPort);
  const workerTarget = bridgeTargetsBefore.find(
    (target) =>
      target.type === "service_worker" &&
      target.url.startsWith(`chrome-extension://${extensionId}/`),
  );
  if (!workerTarget) {
    throw new Error(
      "Bitwarden's service-worker DevTools target is unavailable.",
    );
  }
  extensionWorker = await CdpClient.connect(workerTarget.webSocketDebuggerUrl);
  await extensionWorker.send("Runtime.enable");
  const bridgeCreated = await extensionWorker.evaluate(`(async () => {
    const details = {
      url: chrome.runtime.getURL("popup/index.html?uilocation=popout#/lock"),
      type: "popup",
      focused: true,
      width: 420,
      height: 630
    };
    const created = await chrome.windows.create(details);
    return {
      apiTypes: {
        create: typeof chrome.windows?.create,
        update: typeof chrome.windows?.update,
        remove: typeof chrome.windows?.remove
      },
      created
    };
  })()`);
  bridgeWindowId = bridgeCreated?.created?.id;
  if (!Number.isInteger(bridgeWindowId)) {
    throw new Error(
      `chrome.windows.create returned no integer window id: ${JSON.stringify(bridgeCreated)}`,
    );
  }
  const bridgeTarget = await poll(
    () => targetList(debugPort),
    (items) =>
      items.find((target) => {
        try {
          const url = new URL(target.url);
          return (
            target.type === "page" &&
            url.protocol === "chrome-extension:" &&
            url.hostname === extensionId &&
            url.pathname === "/popup/index.html" &&
            url.searchParams.get("uilocation") === "popout"
          );
        } catch {
          return false;
        }
      }),
    "the separate Bitwarden extension BrowserWindow target",
  ).then((items) =>
    items.find((target) => {
      try {
        const url = new URL(target.url);
        return (
          target.type === "page" &&
          url.protocol === "chrome-extension:" &&
          url.hostname === extensionId &&
          url.pathname === "/popup/index.html" &&
          url.searchParams.get("uilocation") === "popout"
        );
      } catch {
        return false;
      }
    }),
  );
  const bridgePage = await CdpClient.connect(bridgeTarget.webSocketDebuggerUrl);
  let bridgeRendered;
  try {
    await bridgePage.send("Runtime.enable");
    bridgeRendered = await poll(
      () =>
        bridgePage.evaluate(`(() => {
          const root = document.querySelector("app-root, #root, #app");
          const visibleInputs = [...document.querySelectorAll("input")].filter((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          });
          return {
            readyState: document.readyState,
            title: document.title,
            windowName: globalThis.name,
            bodyTextLength: document.body?.innerText?.trim().length ?? 0,
            rootTextLength: root?.innerText?.trim().length ?? 0,
            buttonCount: document.querySelectorAll("button").length,
            formCount: document.querySelectorAll("form").length,
            visibleInputCount: visibleInputs.length,
            inputTypes: [...new Set(visibleInputs.map((element) => element.type || "text"))].sort(),
            focused: document.hasFocus(),
            outerWidth,
            outerHeight
          };
        })()`),
      (value) =>
        value?.readyState === "complete" &&
        value.title === "Bitwarden" &&
        value.bodyTextLength > 0 &&
        value.rootTextLength > 0,
      "the separate Bitwarden extension BrowserWindow to render meaningful UI",
    );
  } finally {
    bridgePage.close();
  }
  const tabsDuringBridge = await shell.evaluate(
    "window.chromecraft.getSnapshot()",
  );
  const bridgeUpdated = await extensionWorker.evaluate(`(async () => {
    return chrome.windows.update(${JSON.stringify(bridgeWindowId)}, {
      focused: true,
      width: 430,
      height: 640
    });
  })()`);
  await extensionWorker.evaluate(`(async () => {
    await chrome.windows.remove(${JSON.stringify(bridgeWindowId)});
    return true;
  })()`);
  const bridgeTargetsAfterRemove = await poll(
    () => targetList(debugPort),
    (items) => !items.some((target) => target.id === bridgeTarget.id),
    "the separate Bitwarden extension BrowserWindow target to be destroyed",
  );
  bridgeWindowId = null;
  const tabsAfterBridge = await shell.evaluate(
    "window.chromecraft.getSnapshot()",
  );

  passkeyFixture = await startPasskeyFixture();
  const passkeyTabId = await shell.evaluate(
    `window.chromecraft.createTab(${JSON.stringify(passkeyFixture.url)})`,
  );
  await poll(
    () => shell.evaluate("window.chromecraft.getSnapshot()"),
    (snapshot) =>
      snapshot?.activeTabId === passkeyTabId &&
      snapshot.tabs?.some(
        (tab) => tab.id === passkeyTabId && tab.url === passkeyFixture.url,
      ),
    "the temporary localhost passkey probe tab to become active",
  );
  const passkeyTarget = await poll(
    () => targetList(debugPort),
    (items) =>
      items.find(
        (item) => item.type === "page" && item.url === passkeyFixture.url,
      ),
    "the temporary localhost passkey probe target",
  ).then((items) =>
    items.find(
      (item) => item.type === "page" && item.url === passkeyFixture.url,
    ),
  );
  const passkeyPage = await CdpClient.connect(
    passkeyTarget.webSocketDebuggerUrl,
  );
  let passkeyHook;
  try {
    await passkeyPage.send("Runtime.enable");
    passkeyHook = await poll(
      () =>
        passkeyPage.evaluate(`(() => {
          const credentials = navigator.credentials;
          const describe = (fn) => {
            const source = typeof fn === "function"
              ? Function.prototype.toString.call(fn)
              : "";
            return {
              type: typeof fn,
              name: typeof fn === "function" ? fn.name : null,
              length: typeof fn === "function" ? fn.length : null,
              nativeLike: /\\[native code\\]/u.test(source),
              mentionsBitwardenRequest:
                /Credential(Get|Creation)Request|fallbackRequested/u.test(source)
            };
          };
          const get = credentials?.get;
          const create = credentials?.create;
          return {
            readyState: document.readyState,
            marker: document.querySelector("#probe-ready")?.textContent ?? null,
            origin: location.origin,
            secureContext: isSecureContext,
            publicKeyCredentialType: typeof PublicKeyCredential,
            get: describe(get),
            create: describe(create),
            getIsOwnMethod: Object.prototype.hasOwnProperty.call(credentials ?? {}, "get"),
            createIsOwnMethod: Object.prototype.hasOwnProperty.call(credentials ?? {}, "create"),
            wrapped:
              get?.name === "getWebAuthnCredential" &&
              create?.name === "createWebAuthnCredential"
          };
        })()`),
      (value) =>
        value?.readyState === "complete" &&
        value.marker === "Passkey hook probe",
      "the temporary localhost passkey probe document",
    );
  } finally {
    passkeyPage.close();
  }
  // Allow Bitwarden's document-start content scripts to finish their passive
  // startup messaging before the disposable tab is removed. This avoids
  // manufacturing a frame-removed error during diagnostic teardown.
  await delay(1_000);
  await shell.evaluate(`(async () => {
    const originalTabId = ${JSON.stringify(browserBefore.activeTabId)};
    const passkeyTabId = ${JSON.stringify(passkeyTabId)};
    const snapshot = await window.chromecraft.getSnapshot();
    if (snapshot.tabs.some((tab) => tab.id === originalTabId)) {
      await window.chromecraft.activateTab(originalTabId);
    }
    if (snapshot.tabs.some((tab) => tab.id === passkeyTabId)) {
      await window.chromecraft.closeTab(passkeyTabId);
    }
  })()`);
  const browserAfterPasskey = await poll(
    () => shell.evaluate("window.chromecraft.getSnapshot()"),
    (snapshot) =>
      snapshot?.activeTabId === browserBefore.activeTabId &&
      JSON.stringify(snapshot.tabs.map((tab) => tab.id)) ===
        JSON.stringify(browserBefore.tabs.map((tab) => tab.id)),
    "the original tab set and active tab to be restored",
  );
  await passkeyFixture.close();
  passkeyFixture = null;

  const beforeIds = browserBefore.tabs.map((tab) => tab.id);
  const openIds = browserOpen.tabs.map((tab) => tab.id);
  const closedIds = browserClosed.tabs.map((tab) => tab.id);
  reportData = {
    extension: {
      id: bitwarden.id,
      name: bitwarden.name,
      version: bitwarden.version,
      ready: bitwarden.ready,
      status: bitwarden.status,
      popupUrl: bitwarden.popupUrl,
    },
    popupState: {
      before: extensionsBefore.popupExtensionId,
      open: extensionsOpen.popupExtensionId,
      closed: extensionsClosed.popupExtensionId,
    },
    tabs: {
      beforeIds,
      openIds,
      closedIds,
      activeBefore: browserBefore.activeTabId,
      activeOpen: browserOpen.activeTabId,
      activeClosed: browserClosed.activeTabId,
      unchangedWhileOpen:
        JSON.stringify(beforeIds) === JSON.stringify(openIds) &&
        browserBefore.activeTabId === browserOpen.activeTabId,
      unchangedAfterClose:
        JSON.stringify(beforeIds) === JSON.stringify(closedIds) &&
        browserBefore.activeTabId === browserClosed.activeTabId,
    },
    targets: {
      before: extensionTargets(targetsBefore),
      open: extensionTargets(targetsOpen),
      rendered: extensionTargets(targetsRendered),
      closed: extensionTargets(targetsClosed),
      popupCreated:
        !targetsBefore.some((item) =>
          sameDocumentUrl(item.url, bitwarden.popupUrl),
        ) &&
        targetsOpen.some((item) =>
          sameDocumentUrl(item.url, bitwarden.popupUrl),
        ),
      popupDestroyed: !targetsClosed.some((item) =>
        sameDocumentUrl(item.url, bitwarden.popupUrl),
      ),
    },
    lifecycle: { samples: lifecycleSamples, targetEvents },
    stayedOpenFiveSeconds,
    lifecycleElapsedMs,
    credentialsInspection,
    extensionWindowBridge: {
      apiTypes: bridgeCreated.apiTypes,
      created: bridgeCreated.created,
      rendered: bridgeRendered,
      updated: bridgeUpdated,
      separateTargetCreated: !bridgeTargetsBefore.some(
        (target) => target.id === bridgeTarget.id,
      ),
      targetDestroyed: !bridgeTargetsAfterRemove.some(
        (target) => target.id === bridgeTarget.id,
      ),
      chromecraftTabsUnchangedWhileOpen:
        JSON.stringify(tabsDuringBridge.tabs.map((tab) => tab.id)) ===
          JSON.stringify(beforeIds) &&
        tabsDuringBridge.activeTabId === browserBefore.activeTabId,
      chromecraftTabsUnchangedAfterRemove:
        JSON.stringify(tabsAfterBridge.tabs.map((tab) => tab.id)) ===
          JSON.stringify(beforeIds) &&
        tabsAfterBridge.activeTabId === browserBefore.activeTabId,
      credentialCeremonyInvoked: false,
    },
    passkeyHook: {
      ...passkeyHook,
      invokedCredentialOperation: false,
      temporaryTabClosed: !browserAfterPasskey.tabs.some(
        (tab) => tab.id === passkeyTabId,
      ),
      originalTabStateRestored:
        browserAfterPasskey.activeTabId === browserBefore.activeTabId &&
        JSON.stringify(browserAfterPasskey.tabs.map((tab) => tab.id)) ===
          JSON.stringify(beforeIds),
      browserDataFileRestoredAfterExit: true,
    },
    rendered,
    consoleErrors,
    exceptions,
    failedRequests,
  };
} catch (error) {
  failure = error?.stack ?? error?.message ?? String(error);
} finally {
  popup?.close();
  if (extensionWorker && Number.isInteger(bridgeWindowId)) {
    await extensionWorker
      .evaluate(`chrome.windows.remove(${JSON.stringify(bridgeWindowId)})`)
      .catch(() => undefined);
  }
  extensionWorker?.close();
  browserCdp?.close();
  shell?.close();
  await passkeyFixture?.close().catch(() => undefined);
  await terminate(child);
  if (browserDataBackup.existed) {
    const restorePath = `${browserDataPath}.${process.pid}.restore`;
    await fs.mkdir(path.dirname(browserDataPath), { recursive: true });
    await fs.writeFile(restorePath, browserDataBackup.data);
    await fs.rename(restorePath, browserDataPath);
  } else {
    await fs.rm(browserDataPath, { force: true });
  }
  await relaunchNormally();
  relaunchedNormally = true;
}

const runtimeDiagnostics = extensionRuntimeDiagnostics(rawLog);
const success =
  failure === null &&
  reportData.tabs?.unchangedWhileOpen === true &&
  reportData.tabs?.unchangedAfterClose === true &&
  reportData.targets?.popupCreated === true &&
  reportData.targets?.popupDestroyed === true &&
  reportData.stayedOpenFiveSeconds === true &&
  reportData.rendered?.spinnerVisible === false &&
  reportData.rendered?.bodyTextLength > 0 &&
  reportData.extensionWindowBridge?.separateTargetCreated === true &&
  reportData.extensionWindowBridge?.targetDestroyed === true &&
  reportData.extensionWindowBridge?.chromecraftTabsUnchangedWhileOpen ===
    true &&
  reportData.extensionWindowBridge?.chromecraftTabsUnchangedAfterRemove ===
    true &&
  reportData.extensionWindowBridge?.credentialCeremonyInvoked === false &&
  reportData.passkeyHook?.wrapped === true &&
  reportData.passkeyHook?.invokedCredentialOperation === false &&
  reportData.passkeyHook?.temporaryTabClosed === true &&
  reportData.passkeyHook?.originalTabStateRestored === true &&
  reportData.exceptions?.length === 0 &&
  runtimeDiagnostics.errors.length === 0;
const report = {
  schemaVersion: 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  success,
  scope:
    "Real user profile; Bitwarden anchored popup lifecycle, same-extension chrome.windows bridge, initial rendered UI, and passive localhost passkey-hook inspection. Vault unlock, autofill, and credential operations are not exercised.",
  packagedExecutable: path.relative(root, executable),
  ...reportData,
  runtimeErrors: runtimeDiagnostics.errors,
  runtimeInformational: runtimeDiagnostics.informational,
  failure: failure ? safeErrorText(failure) : null,
  relaunchedNormally,
};
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await fs.writeFile(
  logPath,
  [
    "[runtime errors]",
    ...runtimeDiagnostics.errors,
    "",
    "[informational]",
    ...runtimeDiagnostics.informational,
  ].join("\n"),
  "utf8",
);
console.log(JSON.stringify(report, null, 2));
if (!success) process.exitCode = 1;
