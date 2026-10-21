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
const artifacts = path.join(root, ".artifacts", "extensions");
const reportPath = path.join(artifacts, "packaged-extension-smoke.json");
const logPath = path.join(artifacts, "packaged-extension-smoke.log");
const extensionVersion = "1.0.0";
const extensionKey =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAodUvL1S/bYu8yZIJwOFyIbRXlhVGoDyswPoHyFFT/hrBOVJMh+zfjkyjGsdTQQIb/ll5sJ2v0SKtTevnkCCxejHSk7sMBhMStB6VBgfCGDM2y4aA1FVYpW4OFCWVderfvQYCU0bA70acAlUDGOebXawQvc53AiQtUV33R2NPIIvYsu8tz9SiwcqB9pQzvf+uliXkKx+G/1xY12s5FvfFSsg32Fb/afUhLivOc3P27PIqy7XXQ6W1KduTctpnoQfmhplfnNWEMZcCq2oPz7QTR9evB4v/WJYwopnU95BrNLc8/sJVMFfpKvL+DaVrVUEPaiHvGa5ET95dEHS0fACQhQIDAQAB";

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

const extensionId = extensionIdFromKey(extensionKey);

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
    await delay(50);
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
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text);
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

async function targetList(port) {
  return fetchJson(`http://127.0.0.1:${port}/json/list`);
}

async function waitForTarget(port, predicate, description) {
  const targets = await poll(
    () => targetList(port),
    (items) => items.some(predicate),
    description,
    30_000,
  );
  return targets.find(predicate);
}

async function terminate(child) {
  if (!child.pid || child.exitCode !== null) return;
  await execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    windowsHide: true,
  }).catch(() => child.kill());
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
    !path.basename(resolvedProfile).startsWith("chromecraft-extension-smoke-")
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

async function startFixture() {
  let origin;
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://publisher.test");
    requests.push(url.pathname + url.search);
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Extension smoke ${url.searchParams.get("phase") ?? "unknown"}</title></head><body><main><h1 id="fixture-ready">Extension fixture</h1><p id="phase">${url.searchParams.get("phase") ?? "unknown"}</p></main></body></html>`,
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not start the extension fixture.");
  }
  origin = `http://publisher.test:${address.port}`;
  return {
    origin,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function seedExtension(profile) {
  const extensionRoot = path.join(
    profile,
    "extensions",
    extensionId,
    extensionVersion,
  );
  await fs.mkdir(extensionRoot, { recursive: true });
  const manifest = {
    manifest_version: 3,
    name: "Chromecraft packaged extension smoke",
    description: "Deterministic local extension lifecycle fixture.",
    version: extensionVersion,
    key: extensionKey,
    background: { service_worker: "background.mjs", type: "module" },
    action: { default_popup: "popup.html" },
    content_scripts: [
      {
        matches: ["http://publisher.test/*"],
        js: ["content.js"],
        run_at: "document_end",
      },
    ],
  };
  await Promise.all([
    fs.writeFile(
      path.join(extensionRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    ),
    fs.writeFile(
      path.join(extensionRoot, "content.js"),
      `document.documentElement.dataset.chromecraftExtensionSmoke = chrome.runtime.id;\nconst marker = document.createElement("meta");\nmarker.id = "chromecraft-extension-smoke-marker";\nmarker.dataset.extensionId = chrome.runtime.id;\ndocument.head.append(marker);\nchrome.runtime.sendMessage({ type: "chromecraft-module-worker-probe" }, (response) => {\n  document.documentElement.dataset.chromecraftModuleWorker = response?.marker ?? "missing";\n  document.documentElement.dataset.chromecraftModuleCapabilities = JSON.stringify(response?.capabilities ?? {});\n});\n`,
      "utf8",
    ),
    fs.writeFile(
      path.join(extensionRoot, "background.mjs"),
      `import { marker } from "./worker-dependency.mjs";\nchrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {\n  if (message?.type !== "chromecraft-module-worker-probe") return false;\n  sendResponse({\n    marker,\n    capabilities: {\n      actionSetBadgeText: typeof chrome.action?.setBadgeText,\n      alarmsCreate: typeof chrome.alarms?.create,\n      commandsGetAll: typeof chrome.commands?.getAll,\n      contextMenusCreate: typeof chrome.contextMenus?.create,\n      cookiesGet: typeof chrome.cookies?.get,\n      downloadsDownload: typeof chrome.downloads?.download,\n      idleQueryState: typeof chrome.idle?.queryState,\n      notificationsCreate: typeof chrome.notifications?.create,\n      offscreenCreateDocument: typeof chrome.offscreen?.createDocument,\n      scriptingExecuteScript: typeof chrome.scripting?.executeScript,\n      sidePanelSetOptions: typeof chrome.sidePanel?.setOptions,\n      webNavigationOnCommitted: typeof chrome.webNavigation?.onCommitted?.addListener\n    }\n  });\n  return false;\n});\n`,
      "utf8",
    ),
    fs.writeFile(
      path.join(extensionRoot, "worker-dependency.mjs"),
      'export const marker = "module-worker-ready";\n',
      "utf8",
    ),
    fs.writeFile(
      path.join(extensionRoot, "popup.html"),
      '<!doctype html><html><head><meta charset="utf-8"><title>Extension popup fixture</title></head><body><main id="popup-ready">Anchored extension popup</main></body></html>',
      "utf8",
    ),
  ]);
  const registry = {
    version: 1,
    extensions: [
      {
        id: extensionId,
        version: extensionVersion,
        enabled: true,
        sourceUrl: `https://chromewebstore.google.com/detail/${extensionId}`,
      },
    ],
  };
  await fs.writeFile(
    path.join(profile, "extensions", "installed-extensions.json"),
    `${JSON.stringify(registry, null, 2)}\n`,
    "utf8",
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
  return extensionRoot;
}

async function navigateAndInspect(shell, page, tabId, url, expectedInjection) {
  await shell.evaluate(
    `window.chromecraft.navigate(${JSON.stringify(tabId)}, ${JSON.stringify(url)})`,
  );
  return poll(
    () =>
      page.evaluate(`(() => ({
        href: location.href,
        ready: document.readyState === "complete",
        fixtureReady: Boolean(document.querySelector("#fixture-ready")),
        marker: document.documentElement.dataset.chromecraftExtensionSmoke ?? null,
        metaMarker: document.querySelector("#chromecraft-extension-smoke-marker")?.dataset.extensionId ?? null,
        moduleWorker: document.documentElement.dataset.chromecraftModuleWorker ?? null,
        moduleCapabilities: JSON.parse(document.documentElement.dataset.chromecraftModuleCapabilities ?? "{}"),
      }))()`),
    (value) =>
      value?.href === url &&
      value.ready === true &&
      value.fixtureReady === true &&
      (expectedInjection
        ? value.marker === extensionId &&
          value.metaMarker === extensionId &&
          value.moduleWorker === "module-worker-ready"
        : value.marker === null &&
          value.metaMarker === null &&
          value.moduleWorker === null),
    `${expectedInjection ? "extension injection" : "an uninjected fresh document"} at ${url}`,
  );
}

await fs.access(executable);
await fs.mkdir(artifacts, { recursive: true });
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "chromecraft-extension-smoke-"),
);
const extensionRoot = await seedExtension(profile);
const fixture = await startFixture();
const debugPort = await findFreePort();
const child = spawn(
  executable,
  [
    `--chromecraft-user-data=${profile}`,
    `--user-data-dir=${profile}`,
    `--chromecraft-smoke-url=${fixture.origin}/fixture?phase=bootstrap`,
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

let shell;
let page;
const checks = [];
const startedAt = new Date().toISOString();
let failure = null;
try {
  const shellTarget = await waitForTarget(
    debugPort,
    (target) =>
      target.type === "page" &&
      !target.url.startsWith("chrome-extension://") &&
      (target.url.startsWith("file://") || target.url.includes("main_window")),
    "the Chromecraft shell target",
  );
  shell = await CdpClient.connect(shellTarget.webSocketDebuggerUrl);
  const initial = await poll(
    () =>
      shell.evaluate(`(async () => ({
        browser: await window.chromecraft?.getSnapshot(),
        extensions: await window.chromecraft?.getExtensions(),
      }))()`),
    (value) =>
      Boolean(value?.browser?.activeTabId) &&
      value?.extensions?.initialized === true &&
      value?.extensions?.items?.length === 1 &&
      value.extensions.items[0].id === extensionId &&
      value.extensions.items[0].status === "ready",
    "a ready preinstalled extension",
  );
  checks.push({
    name: "preinstalled-registry-loads-ready",
    passed: true,
    snapshot: initial.extensions.items[0],
  });

  const tabId = initial.browser.activeTabId;
  const enabledUrl = `${fixture.origin}/fixture?phase=enabled`;
  await shell.evaluate(
    `window.chromecraft.navigate(${JSON.stringify(tabId)}, ${JSON.stringify(enabledUrl)})`,
  );
  const pageTarget = await waitForTarget(
    debugPort,
    (target) => target.type === "page" && target.url === enabledUrl,
    "the extension fixture target",
  );
  page = await CdpClient.connect(pageTarget.webSocketDebuggerUrl);
  const enabledDocument = await poll(
    () =>
      page.evaluate(`(() => ({
        href: location.href,
        marker: document.documentElement.dataset.chromecraftExtensionSmoke ?? null,
        metaMarker: document.querySelector("#chromecraft-extension-smoke-marker")?.dataset.extensionId ?? null,
        moduleWorker: document.documentElement.dataset.chromecraftModuleWorker ?? null,
        moduleCapabilities: JSON.parse(document.documentElement.dataset.chromecraftModuleCapabilities ?? "{}"),
      }))()`),
    (value) =>
      value?.href === enabledUrl &&
      value.marker === extensionId &&
      value.metaMarker === extensionId &&
      value.moduleWorker === "module-worker-ready",
    "the content script and module worker markers",
  );
  checks.push({
    name: "content-script-executes",
    passed: true,
    document: enabledDocument,
  });

  const actionOpened = await shell.evaluate(`(() => {
    const action = document.querySelector(${JSON.stringify(`[data-extension-action="${extensionId}"]`)});
    if (!(action instanceof HTMLButtonElement)) return false;
    action.click();
    return true;
  })()`);
  if (!actionOpened) {
    throw new Error("The installed extension has no toolbar action button.");
  }
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  const popupTarget = await waitForTarget(
    debugPort,
    (target) => target.type === "page" && target.url === popupUrl,
    "the anchored extension popup target",
  );
  const popupPage = await CdpClient.connect(popupTarget.webSocketDebuggerUrl);
  const popupDocument = await poll(
    () =>
      popupPage.evaluate(`(() => ({
        ready: document.readyState === "complete",
        marker: document.querySelector("#popup-ready")?.textContent ?? null,
      }))()`),
    (value) =>
      value?.ready === true && value.marker === "Anchored extension popup",
    "rendered extension popup content",
  );
  const popupState = await poll(
    () =>
      shell.evaluate(`(async () => ({
        actionExpanded: document.querySelector(${JSON.stringify(`[data-extension-action="${extensionId}"]`)})?.getAttribute("aria-expanded") === "true",
        browser: await window.chromecraft.getSnapshot(),
        extensions: await window.chromecraft.getExtensions(),
      }))()`),
    (value) =>
      value?.actionExpanded === true &&
      value?.extensions?.popupExtensionId === extensionId &&
      value?.browser?.activeTabId === tabId &&
      value?.browser?.tabs?.length === initial.browser.tabs.length,
    "the stable anchored extension popup state",
  );
  const browserWithPopup = popupState.browser;
  popupPage.close();
  if (
    !popupState.actionExpanded ||
    popupState.extensions.popupExtensionId !== extensionId ||
    browserWithPopup.activeTabId !== tabId ||
    browserWithPopup.tabs.length !== initial.browser.tabs.length
  ) {
    throw new Error(
      "The extension popup did not remain anchored outside the tab strip.",
    );
  }
  checks.push({
    name: "toolbar-action-opens-rendered-anchored-popup",
    passed: true,
    popupDocument,
    tabCount: browserWithPopup.tabs.length,
  });

  const actionToggledClosed = await shell.evaluate(`(() => {
    const action = document.querySelector(${JSON.stringify(`[data-extension-action="${extensionId}"]`)});
    if (!(action instanceof HTMLButtonElement)) return false;
    action.click();
    return true;
  })()`);
  if (!actionToggledClosed) {
    throw new Error(
      "The extension toolbar action could not be toggled closed.",
    );
  }
  const closedPopupSnapshot = await poll(
    () => shell.evaluate("window.chromecraft.getExtensions()"),
    (value) => value?.popupExtensionId == null,
    "the toggled extension popup state to clear",
  );
  await poll(
    () => targetList(debugPort),
    (targets) =>
      !targets.some(
        (target) => target.type === "page" && target.url === popupUrl,
      ),
    "the toggled extension popup target to close",
  );
  checks.push({
    name: "toolbar-action-second-click-closes-popup",
    passed: true,
    popupExtensionId: closedPopupSnapshot.popupExtensionId,
  });

  await shell.evaluate(
    `window.chromecraft.setExtensionEnabled(${JSON.stringify(extensionId)}, false)`,
  );
  const disabledSnapshot = await poll(
    () => shell.evaluate("window.chromecraft.getExtensions()"),
    (value) =>
      value?.items?.length === 1 &&
      value.items[0].enabled === false &&
      value.items[0].status === "disabled",
    "the disabled extension snapshot",
  );
  const disabledDocument = await navigateAndInspect(
    shell,
    page,
    tabId,
    `${fixture.origin}/fixture?phase=disabled`,
    false,
  );
  checks.push({
    name: "disable-unloads-and-stops-injection",
    passed: true,
    snapshot: disabledSnapshot.items[0],
    document: disabledDocument,
  });

  await shell.evaluate(
    `window.chromecraft.setExtensionEnabled(${JSON.stringify(extensionId)}, true)`,
  );
  const reenabledSnapshot = await poll(
    () => shell.evaluate("window.chromecraft.getExtensions()"),
    (value) =>
      value?.items?.length === 1 &&
      value.items[0].enabled === true &&
      value.items[0].status === "ready",
    "the re-enabled extension snapshot",
  );
  const reenabledDocument = await navigateAndInspect(
    shell,
    page,
    tabId,
    `${fixture.origin}/fixture?phase=reenabled`,
    true,
  );
  checks.push({
    name: "reenable-reloads-and-restores-injection",
    passed: true,
    snapshot: reenabledSnapshot.items[0],
    document: reenabledDocument,
  });

  await shell.evaluate(
    `window.chromecraft.removeExtension(${JSON.stringify(extensionId)})`,
  );
  const removedSnapshot = await poll(
    () => shell.evaluate("window.chromecraft.getExtensions()"),
    (value) => value?.initialized === true && value?.items?.length === 0,
    "the empty extension registry",
  );
  const removedFromDisk = await fs
    .access(extensionRoot)
    .then(() => false)
    .catch((error) => error?.code === "ENOENT");
  if (!removedFromDisk) {
    throw new Error("The uninstalled extension directory still exists.");
  }
  const uninstalledDocument = await navigateAndInspect(
    shell,
    page,
    tabId,
    `${fixture.origin}/fixture?phase=uninstalled`,
    false,
  );
  checks.push({
    name: "uninstall-removes-registry-files-and-injection",
    passed: true,
    snapshot: removedSnapshot,
    removedFromDisk,
    document: uninstalledDocument,
  });
} catch (error) {
  failure = error.stack ?? error.message;
} finally {
  page?.close();
  shell?.close();
  await terminate(child);
  await fixture.close();
  await fs.writeFile(logPath, log, "utf8");
}

if (
  failure === null &&
  /ExtensionLoadWarning[\s\S]{0,400}(?:__chromecraft|chromecraft-compat|chromecraft-background)/iu.test(
    log,
  )
) {
  failure =
    "Electron rejected or warned about a browser-owned compatibility resource.";
}

const report = {
  schemaVersion: 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  success: failure === null && checks.length === 7,
  packagedExecutable: path.relative(root, executable),
  extension: {
    id: extensionId,
    manifestVersion: 3,
    backgroundWorkerType: "module",
    version: extensionVersion,
    fixtureOrigin: fixture.origin,
  },
  checks,
  fixtureRequests: fixture.requests,
  failure,
};
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await removeDisposableProfile(profile);
console.log(JSON.stringify(report, null, 2));
if (!report.success) process.exitCode = 1;
