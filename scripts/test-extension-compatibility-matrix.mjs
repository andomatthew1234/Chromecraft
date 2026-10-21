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
const reportPath = path.join(
  artifactDirectory,
  "extension-compatibility-matrix.json",
);
const logPath = path.join(
  artifactDirectory,
  "extension-compatibility-matrix.log",
);
const extensionVersion = "1.0.0";
const manifestName = "Chromecraft extension capability matrix";
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
      }, 15_000);
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
    !path.basename(resolvedProfile).startsWith("chromecraft-extension-matrix-")
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
    if (requestUrl.pathname === "/observed.json") {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ observed: true }));
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(`<!doctype html>
      <html lang="en">
        <head><meta charset="utf-8"><title>Extension capability matrix</title></head>
        <body><main><h1 id="fixture-ready">Capability fixture</h1></main></body>
      </html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not start the compatibility fixture.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
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
    name: manifestName,
    description:
      "Behavioral compatibility fixture; not a load-only smoke test.",
    version: extensionVersion,
    key: extensionKey,
    permissions: ["storage", "tabs", "scripting", "webRequest"],
    host_permissions: ["http://127.0.0.1/*"],
    background: { service_worker: "worker.js" },
    action: { default_popup: "popup.html" },
    content_scripts: [
      {
        matches: ["http://127.0.0.1/*"],
        js: ["content.js"],
        run_at: "document_end",
      },
    ],
  };
  const worker = `
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.url.includes("/observed.json")) {
      chrome.storage.local.set({ observedRequestUrl: details.url });
    }
  },
  { urls: ["http://127.0.0.1/*"] }
);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.kind !== "matrix-ping") return false;
  chrome.storage.local.set({ lastMessageSender: sender?.id ?? null }).then(() => {
    sendResponse({ kind: "matrix-pong", extensionId: chrome.runtime.id });
  });
  return true;
});
`;
  const content = `
(async () => {
  const result = { extensionId: chrome.runtime.id };
  try {
    await chrome.storage.local.set({ contentStorageProbe: "stored" });
    const stored = await chrome.storage.local.get("contentStorageProbe");
    result.storage = stored.contentStorageProbe;
  } catch (error) {
    result.storageError = String(error);
  }
  try {
    result.message = await chrome.runtime.sendMessage({ kind: "matrix-ping" });
  } catch (error) {
    result.messageError = String(error);
  }
  document.documentElement.dataset.chromecraftCapabilityMatrix = JSON.stringify(result);
})();
`;
  const popup = `<!doctype html>
<html><head><meta charset="utf-8"><title>Capability matrix popup</title></head>
<body><main id="popup-ready"><pre id="result">pending</pre></main>
<script src="popup.js"></script></body></html>`;
  const popupScript = `
(async () => {
  const result = { extensionId: chrome.runtime.id };
  try { result.manifestName = chrome.runtime.getManifest().name; }
  catch (error) { result.manifestError = String(error); }
  try {
    const tabs = await chrome.tabs.query({ active: true });
    result.tabCount = tabs.length;
    result.activeTabId = tabs[0]?.id ?? null;
  } catch (error) { result.tabsError = String(error); }
  try {
    result.storage = (await chrome.storage.local.get("contentStorageProbe")).contentStorageProbe;
  } catch (error) { result.storageError = String(error); }
  document.querySelector("#result").textContent = JSON.stringify(result);
  document.documentElement.dataset.matrixReady = "true";
})();
`;
  await Promise.all([
    fs.writeFile(
      path.join(extensionRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    ),
    fs.writeFile(path.join(extensionRoot, "worker.js"), worker, "utf8"),
    fs.writeFile(path.join(extensionRoot, "content.js"), content, "utf8"),
    fs.writeFile(path.join(extensionRoot, "popup.html"), popup, "utf8"),
    fs.writeFile(path.join(extensionRoot, "popup.js"), popupScript, "utf8"),
  ]);
  await fs.writeFile(
    path.join(profile, "extensions", "installed-extensions.json"),
    `${JSON.stringify(
      {
        version: 1,
        extensions: [
          {
            id: extensionId,
            version: extensionVersion,
            enabled: true,
            sourceUrl: `https://chromewebstore.google.com/detail/${extensionId}`,
          },
        ],
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

function capability(category, name, passed, evidence, error = null) {
  return { category, name, passed, evidence, error };
}

async function capture(capabilities, category, name, operation, predicate) {
  try {
    const evidence = await operation();
    const passed = Boolean(predicate(evidence));
    capabilities.push(
      capability(
        category,
        name,
        passed,
        evidence,
        passed ? null : "Observed behavior did not satisfy the capability.",
      ),
    );
    return evidence;
  } catch (error) {
    capabilities.push(
      capability(category, name, false, null, error?.message ?? String(error)),
    );
    return null;
  }
}

await fs.access(executable);
await fs.mkdir(artifactDirectory, { recursive: true });
const startedAt = new Date().toISOString();
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "chromecraft-extension-matrix-"),
);
const fixture = await startFixture();
await seedExtension(profile);
const debugPort = await findFreePort();
const child = spawn(
  executable,
  [
    `--chromecraft-user-data=${profile}`,
    `--user-data-dir=${profile}`,
    `--chromecraft-smoke-url=${fixture.origin}/fixture`,
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

const capabilities = [];
let shell;
let page;
let worker;
let popup;
let fatalError = null;
let activeExtensionTabId = null;
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
  const initial = await poll(
    () =>
      shell.evaluate(`(async () => ({
        browser: await window.chromecraft?.getSnapshot(),
        extensions: await window.chromecraft?.getExtensions()
      }))()`),
    (value) =>
      Boolean(value?.browser?.activeTabId) &&
      value?.extensions?.initialized === true,
    "the initialized extension manager",
    45_000,
  );
  await capture(
    capabilities,
    "lifecycle",
    "persisted MV3 extension loads ready",
    async () =>
      initial.extensions.items.find((item) => item.id === extensionId) ?? null,
    (item) => item?.ready === true && item?.enabled === true,
  );

  await shell.evaluate(
    `window.chromecraft.navigate(${JSON.stringify(initial.browser.activeTabId)}, ${JSON.stringify(`${fixture.origin}/fixture`)})`,
  );

  const pageTarget = await waitForTarget(
    debugPort,
    (target) =>
      target.type === "page" && target.url === `${fixture.origin}/fixture`,
    "the local fixture page",
  );
  page = await CdpClient.connect(pageTarget.webSocketDebuggerUrl);
  const pageState = await capture(
    capabilities,
    "content scripts",
    "declared content script executes in matching page",
    () =>
      poll(
        () =>
          page.evaluate(`(() => ({
            ready: Boolean(document.querySelector("#fixture-ready")),
            value: document.documentElement.dataset.chromecraftCapabilityMatrix ?? null
          }))()`),
        (value) => value?.ready && typeof value.value === "string",
        "the content-script result",
      ),
    (value) => value?.ready && typeof value.value === "string",
  );
  let contentResult = null;
  try {
    contentResult = JSON.parse(pageState?.value ?? "null");
  } catch {
    contentResult = null;
  }
  capabilities.push(
    capability(
      "storage",
      "content script writes and reads storage.local",
      contentResult?.storage === "stored",
      contentResult,
      contentResult?.storage === "stored"
        ? null
        : (contentResult?.storageError ?? "No storage round-trip result."),
    ),
  );
  capabilities.push(
    capability(
      "runtime messaging",
      "content script round-trips a message through the MV3 worker",
      contentResult?.message?.kind === "matrix-pong" &&
        contentResult?.message?.extensionId === extensionId,
      contentResult?.message ?? contentResult,
      contentResult?.message?.kind === "matrix-pong"
        ? null
        : (contentResult?.messageError ?? "No worker response."),
    ),
  );

  const workerTarget = await waitForTarget(
    debugPort,
    (target) =>
      target.type === "service_worker" &&
      target.url.startsWith(`chrome-extension://${extensionId}/`),
    "the MV3 service worker",
  ).catch(() => null);
  capabilities.push(
    capability(
      "background",
      "MV3 service worker starts",
      Boolean(workerTarget),
      workerTarget ? { type: workerTarget.type, url: workerTarget.url } : null,
      workerTarget ? null : "No service-worker target appeared.",
    ),
  );
  if (workerTarget) {
    worker = await CdpClient.connect(workerTarget.webSocketDebuggerUrl);
    await worker.send("Runtime.enable");
    const tabsResult = await capture(
      capabilities,
      "tabs",
      "tabs.query returns the active browser tab",
      () =>
        worker.evaluate(`(async () => {
          try {
            const tabs = await chrome.tabs.query({ active: true });
            return { ok: true, count: tabs.length, tab: tabs[0] ?? null };
          } catch (error) {
            return { ok: false, error: String(error) };
          }
        })()`),
      (value) =>
        value?.ok === true &&
        value.count > 0 &&
        Number.isInteger(value.tab?.id),
    );
    activeExtensionTabId = tabsResult?.tab?.id ?? null;
    await capture(
      capabilities,
      "scripting",
      "scripting.executeScript runs in the active tab",
      () =>
        worker.evaluate(`(async () => {
          try {
            const [tab] = await chrome.tabs.query({ active: true });
            if (!Number.isInteger(tab?.id)) return { ok: false, error: "No active tab id." };
            const results = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => {
                document.documentElement.dataset.chromecraftScriptingProbe = "executed";
                return location.href;
              }
            });
            return { ok: true, results };
          } catch (error) {
            return { ok: false, error: String(error) };
          }
        })()`),
      (value) => value?.ok === true && Array.isArray(value.results),
    );
    const scriptingDom = await page.evaluate(
      `document.documentElement.dataset.chromecraftScriptingProbe ?? null`,
    );
    const scriptingCapability = capabilities.find(
      (item) => item.name === "scripting.executeScript runs in the active tab",
    );
    if (scriptingCapability?.passed && scriptingDom !== "executed") {
      scriptingCapability.passed = false;
      scriptingCapability.error =
        "The API resolved, but the target document was not modified.";
      scriptingCapability.evidence = {
        apiResult: scriptingCapability.evidence,
        documentMarker: scriptingDom,
      };
    } else if (scriptingCapability) {
      scriptingCapability.evidence = {
        apiResult: scriptingCapability.evidence,
        documentMarker: scriptingDom,
      };
    }
    await page.evaluate(
      `fetch(${JSON.stringify(`${fixture.origin}/observed.json?probe=webRequest`)}, { cache: "no-store" }).then((response) => response.json())`,
    );
    await capture(
      capabilities,
      "network observation",
      "webRequest observes a matching page request",
      () =>
        poll(
          () =>
            worker.evaluate(`(async () => {
              const value = await chrome.storage.local.get("observedRequestUrl");
              return value.observedRequestUrl ?? null;
            })()`),
          (value) =>
            typeof value === "string" && value.includes("/observed.json"),
          "the webRequest observation",
        ),
      (value) => typeof value === "string" && value.includes("/observed.json"),
    );
  } else {
    for (const [category, name] of [
      ["tabs", "tabs.query returns the active browser tab"],
      ["scripting", "scripting.executeScript runs in the active tab"],
      ["network observation", "webRequest observes a matching page request"],
    ]) {
      capabilities.push(
        capability(
          category,
          name,
          false,
          null,
          "Blocked because the MV3 service worker did not start.",
        ),
      );
    }
  }

  const actionClicked = await shell.evaluate(`(() => {
    const action = document.querySelector(${JSON.stringify(
      `[data-extension-action="${extensionId}"]`,
    )});
    if (!(action instanceof HTMLButtonElement)) return false;
    action.click();
    return true;
  })()`);
  const popupTarget = actionClicked
    ? await waitForTarget(
        debugPort,
        (target) =>
          target.type === "page" &&
          target.url === `chrome-extension://${extensionId}/popup.html`,
        "the extension action popup",
      ).catch(() => null)
    : null;
  let popupResult = null;
  if (popupTarget) {
    popup = await CdpClient.connect(popupTarget.webSocketDebuggerUrl);
    popupResult = await poll(
      () =>
        popup.evaluate(`(() => ({
          ready: document.documentElement.dataset.matrixReady === "true",
          result: document.querySelector("#result")?.textContent ?? null
        }))()`),
      (value) => value?.ready === true && typeof value.result === "string",
      "the popup capability result",
    ).catch(() => null);
  }
  let parsedPopupResult = null;
  try {
    parsedPopupResult = JSON.parse(popupResult?.result ?? "null");
  } catch {
    parsedPopupResult = null;
  }
  capabilities.push(
    capability(
      "toolbar action",
      "declared action opens a rendered anchored popup",
      Boolean(
        popupTarget &&
        popupResult?.ready &&
        parsedPopupResult?.extensionId === extensionId,
      ),
      { actionClicked, popupUrl: popupTarget?.url ?? null, parsedPopupResult },
      popupTarget && popupResult?.ready
        ? null
        : "No fully rendered anchored popup appeared.",
    ),
  );
  capabilities.push(
    capability(
      "popup APIs",
      "popup reads manifest, active tabs, and shared storage",
      parsedPopupResult?.manifestName === manifestName &&
        parsedPopupResult?.tabCount > 0 &&
        parsedPopupResult?.activeTabId === activeExtensionTabId &&
        parsedPopupResult?.storage === "stored",
      { ...parsedPopupResult, expectedActiveTabId: activeExtensionTabId },
      parsedPopupResult?.manifestName === manifestName &&
        parsedPopupResult?.tabCount > 0 &&
        parsedPopupResult?.activeTabId === activeExtensionTabId &&
        parsedPopupResult?.storage === "stored"
        ? null
        : "One or more popup API behaviors failed.",
    ),
  );
} catch (error) {
  fatalError = error?.stack ?? error?.message ?? String(error);
} finally {
  popup?.close();
  worker?.close();
  page?.close();
  shell?.close();
  await terminate(child);
  await fixture.close();
  await fs.writeFile(logPath, log, "utf8");
}

const failed = capabilities.filter((item) => !item.passed);
const report = {
  schemaVersion: 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  success:
    fatalError === null && failed.length === 0 && capabilities.length === 10,
  packagedExecutable: path.relative(root, executable),
  fixture: {
    extensionId,
    manifestVersion: 3,
    origin: fixture.origin,
    requests: fixture.requests,
  },
  summary: {
    passed: capabilities.length - failed.length,
    failed: failed.length,
    total: capabilities.length,
  },
  capabilities,
  fatalError,
};
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await removeDisposableProfile(profile);
console.log(JSON.stringify(report, null, 2));
if (!report.success) process.exitCode = 1;
