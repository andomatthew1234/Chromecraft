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
  "extension-tabs-lifecycle.json",
);
const logPath = path.join(artifactDirectory, "extension-tabs-lifecycle.log");
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
    !path.basename(resolvedProfile).startsWith("chromecraft-extension-tabs-")
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
        <head><meta charset="utf-8"><title>Tabs lifecycle fixture</title></head>
        <body><main><h1 id="fixture-ready">Tabs lifecycle fixture</h1></main></body>
      </html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not start the tabs lifecycle fixture.");
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
    name: "Chromecraft tabs lifecycle conformance",
    description:
      "Deterministic packaged test for the public chrome.tabs lifecycle seam.",
    version: extensionVersion,
    key: extensionKey,
    permissions: ["storage", "tabs"],
    background: { service_worker: "worker.js" },
  };
  const worker = `
const STORAGE_EVENTS = "tabsLifecycleEvents";
const STORAGE_STARTS = "tabsLifecycleStarts";
let events = [];
let writes = Promise.resolve();

const cleanTab = (tab) => ({
  id: tab?.id ?? null,
  active: tab?.active ?? null,
  title: tab?.title ?? null,
  url: tab?.url ?? null,
  status: tab?.status ?? null,
  windowId: tab?.windowId ?? null,
});

const record = (event) => {
  events.push(event);
  writes = writes.then(() => chrome.storage.local.set({ [STORAGE_EVENTS]: events }));
};

chrome.tabs.onCreated.addListener((tab) => {
  record({ type: "created", tabId: tab?.id ?? null, tab: cleanTab(tab) });
});
chrome.tabs.onActivated.addListener((activeInfo) => {
  record({
    type: "activated",
    tabId: activeInfo?.tabId ?? null,
    windowId: activeInfo?.windowId ?? null,
  });
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  record({
    type: "updated",
    tabId,
    changeInfo: { ...changeInfo },
    changeKeys: Object.keys(changeInfo ?? {}).sort(),
    tab: cleanTab(tab),
  });
});
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  record({
    type: "removed",
    tabId,
    windowId: removeInfo?.windowId ?? null,
    isWindowClosing: removeInfo?.isWindowClosing ?? null,
  });
});

const started = (async () => {
  const stored = await chrome.storage.local.get([STORAGE_EVENTS, STORAGE_STARTS]);
  events = Array.isArray(stored[STORAGE_EVENTS]) ? stored[STORAGE_EVENTS] : [];
  const starts = Number(stored[STORAGE_STARTS] ?? 0) + 1;
  await chrome.storage.local.set({ [STORAGE_STARTS]: starts });
  return starts;
})();

globalThis.__chromecraftTabsLifecycle = {
  reset: async () => {
    await started;
    await writes;
    events = [];
    await chrome.storage.local.set({ [STORAGE_EVENTS]: [] });
    return true;
  },
  snapshot: async () => {
    const starts = await started;
    await writes;
    const stored = await chrome.storage.local.get([STORAGE_EVENTS, STORAGE_STARTS]);
    return {
      starts,
      events: [...events],
      persistedEvents: stored[STORAGE_EVENTS] ?? [],
      persistedStarts: stored[STORAGE_STARTS] ?? null,
    };
  },
  inspectTabs: async (tabId) => {
    const all = await chrome.tabs.query({});
    const active = await chrome.tabs.query({ active: true });
    let byId = null;
    let getError = null;
    if (Number.isInteger(tabId)) {
      try {
        byId = await chrome.tabs.get(tabId);
      } catch (error) {
        getError = String(error);
      }
    }
    return {
      all: all.map(cleanTab),
      active: active.map(cleanTab),
      byId: byId ? cleanTab(byId) : null,
      getError,
    };
  },
};
`;
  await Promise.all([
    fs.writeFile(
      path.join(extensionRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    ),
    fs.writeFile(path.join(extensionRoot, "worker.js"), worker, "utf8"),
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

function check(name, passed, evidence, error = null) {
  return {
    name,
    passed,
    evidence,
    error: passed ? null : error,
  };
}

function eventSignature(event) {
  if (event.type === "updated") {
    return `${event.type}:${event.tabId}:${event.changeKeys.join(",")}`;
  }
  return `${event.type}:${event.tabId}`;
}

await fs.access(executable);
await fs.mkdir(artifactDirectory, { recursive: true });
const startedAt = new Date().toISOString();
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "chromecraft-extension-tabs-"),
);
const fixture = await startFixture();
await seedExtension(profile);
const debugPort = await findFreePort();
const child = spawn(
  executable,
  [
    `--chromecraft-user-data=${profile}`,
    `--user-data-dir=${profile}`,
    `--chromecraft-smoke-url=${fixture.origin}/baseline`,
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
let wakeWorker;
let fatalError = null;
let coreEvidence = null;
let wakeProbe = {
  attempted: false,
  passed: null,
  reason: "The worker termination probe did not run.",
};
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
    (value) =>
      Boolean(value?.browser?.activeTabId) &&
      value?.extensions?.initialized === true &&
      value.extensions.items.some(
        (item) => item.id === extensionId && item.ready === true,
      ),
    "the initialized extension and first browser tab",
    45_000,
  );
  const initialBrowserTabId = initialized.browser.activeTabId;
  const workerTarget = await waitForTarget(
    debugPort,
    (target) =>
      target.type === "service_worker" &&
      target.url.startsWith(`chrome-extension://${extensionId}/`),
    "the tabs lifecycle MV3 service worker",
    30_000,
  );
  worker = await CdpClient.connect(workerTarget.webSocketDebuggerUrl);
  await worker.send("Runtime.enable");
  await poll(
    () =>
      worker.evaluate(
        `Boolean(globalThis.__chromecraftTabsLifecycle?.snapshot)`,
      ),
    (value) => value === true,
    "the tabs lifecycle worker probe",
  );

  const baselineUrl = `${fixture.origin}/baseline`;
  await shell.evaluate(
    `window.chromecraft.navigate(${JSON.stringify(initialBrowserTabId)}, ${JSON.stringify(baselineUrl)})`,
  );
  await poll(
    () => shell.evaluate(`window.chromecraft.getSnapshot()`),
    (snapshot) => {
      const tab = snapshot?.tabs?.find(
        (item) => item.id === initialBrowserTabId,
      );
      return (
        tab?.url === baselineUrl &&
        tab?.title === "Tabs lifecycle fixture" &&
        tab?.isLoading === false
      );
    },
    "the initial browser tab to expose a real website WebContents",
  );

  const initialApi = await worker.evaluate(
    `globalThis.__chromecraftTabsLifecycle.inspectTabs()`,
  );
  const initialExtensionTabId = initialApi.active[0]?.id ?? null;
  const initialGet = await worker.evaluate(
    `globalThis.__chromecraftTabsLifecycle.inspectTabs(${JSON.stringify(initialExtensionTabId)})`,
  );
  const initialIdsConsistent =
    Number.isSafeInteger(initialExtensionTabId) &&
    initialExtensionTabId > 0 &&
    initialGet.byId?.id === initialExtensionTabId &&
    initialGet.all.some((tab) => tab.id === initialExtensionTabId);
  checks.push(
    check(
      "tabs.query and tabs.get agree on the initial active tab ID",
      initialIdsConsistent,
      { initialApi, initialGet },
      "The MV3 worker could not resolve one stable positive tab ID through both APIs.",
    ),
  );

  await worker.evaluate(`globalThis.__chromecraftTabsLifecycle.reset()`);
  const targetUrl = `${fixture.origin}/lifecycle-target`;
  const createdBrowserTabId = await shell.evaluate(
    `window.chromecraft.createTab(${JSON.stringify(targetUrl)})`,
  );
  await poll(
    () => shell.evaluate(`window.chromecraft.getSnapshot()`),
    (snapshot) => {
      const tab = snapshot?.tabs?.find(
        (item) => item.id === createdBrowserTabId,
      );
      return (
        tab?.url === targetUrl &&
        tab?.title === "Tabs lifecycle fixture" &&
        tab?.isLoading === false
      );
    },
    "the created tab to expose its website WebContents and finish loading",
  );
  const afterCreateApi = await worker.evaluate(
    `globalThis.__chromecraftTabsLifecycle.inspectTabs()`,
  );
  const createdExtensionTabId = afterCreateApi.active[0]?.id ?? null;
  const createdGet = await worker.evaluate(
    `globalThis.__chromecraftTabsLifecycle.inspectTabs(${JSON.stringify(createdExtensionTabId)})`,
  );
  const createdIdsConsistent =
    Number.isSafeInteger(createdExtensionTabId) &&
    createdExtensionTabId > 0 &&
    createdExtensionTabId !== initialExtensionTabId &&
    createdGet.byId?.id === createdExtensionTabId &&
    createdGet.byId?.active === true &&
    createdGet.all.some((tab) => tab.id === createdExtensionTabId);
  checks.push(
    check(
      "new active tab keeps one ID across tabs.query and tabs.get",
      createdIdsConsistent,
      { afterCreateApi, createdGet },
      "The newly created Browser Shell tab did not have one stable public extension tab ID.",
    ),
  );

  const afterNavigationApi = await worker.evaluate(
    `globalThis.__chromecraftTabsLifecycle.inspectTabs(${JSON.stringify(createdExtensionTabId)})`,
  );
  const lifecycleExtensionTabId = Number.isSafeInteger(createdExtensionTabId)
    ? createdExtensionTabId
    : (afterNavigationApi.active[0]?.id ?? null);
  const lifecycleGet =
    lifecycleExtensionTabId === createdExtensionTabId
      ? afterNavigationApi
      : await worker.evaluate(
          `globalThis.__chromecraftTabsLifecycle.inspectTabs(${JSON.stringify(lifecycleExtensionTabId)})`,
        );
  const navigationKeepsId =
    Number.isSafeInteger(createdExtensionTabId) &&
    lifecycleGet.byId?.id === createdExtensionTabId &&
    lifecycleGet.active[0]?.id === createdExtensionTabId &&
    lifecycleGet.byId?.url === targetUrl &&
    lifecycleGet.byId?.status === "complete";
  checks.push(
    check(
      "navigation preserves the tab ID and updates tabs.get",
      navigationKeepsId,
      { afterNavigationApi, lifecycleGet },
      "tabs.get/query did not retain the created tab ID and final navigation state.",
    ),
  );

  await shell.evaluate(
    `window.chromecraft.closeTab(${JSON.stringify(createdBrowserTabId)})`,
  );
  await poll(
    () => shell.evaluate(`window.chromecraft.getSnapshot()`),
    (snapshot) =>
      snapshot?.activeTabId === initialBrowserTabId &&
      !snapshot.tabs.some((tab) => tab.id === createdBrowserTabId),
    "the controlled tab to close and the initial tab to reactivate",
  );
  await delay(400);
  const finalEvents = await worker.evaluate(
    `globalThis.__chromecraftTabsLifecycle.snapshot()`,
  );
  const finalApi = await worker.evaluate(
    `globalThis.__chromecraftTabsLifecycle.inspectTabs(${JSON.stringify(lifecycleExtensionTabId)})`,
  );
  const actualSignatures = finalEvents.events.map(eventSignature);
  const expectedSignatures = [
    `created:${lifecycleExtensionTabId}`,
    `activated:${lifecycleExtensionTabId}`,
    `updated:${lifecycleExtensionTabId}:status,title,url`,
    `updated:${lifecycleExtensionTabId}:title`,
    `updated:${lifecycleExtensionTabId}:status`,
    `removed:${lifecycleExtensionTabId}`,
    `activated:${initialExtensionTabId}`,
  ];
  const exactOrder =
    actualSignatures.length === expectedSignatures.length &&
    actualSignatures.every(
      (signature, index) => signature === expectedSignatures[index],
    );
  coreEvidence = {
    initialBrowserTabId,
    initialExtensionTabId,
    createdBrowserTabId,
    createdExtensionTabId,
    lifecycleExtensionTabId,
    expectedSignatures,
    actualSignatures,
    events: finalEvents.events,
    persistedEvents: finalEvents.persistedEvents,
  };
  checks.push(
    check(
      "MV3 worker receives created, activated, updated, removed, and reactivated events in exact order",
      exactOrder,
      coreEvidence,
      actualSignatures.length === 0
        ? "The worker registered all four chrome.tabs listeners, but received no Browser Shell tab lifecycle events."
        : `Expected ${JSON.stringify(expectedSignatures)} but received ${JSON.stringify(actualSignatures)}.`,
    ),
  );

  const removalConsistent =
    Number.isSafeInteger(lifecycleExtensionTabId) &&
    !finalApi.all.some((tab) => tab.id === lifecycleExtensionTabId) &&
    finalApi.active[0]?.id === initialExtensionTabId &&
    finalApi.byId === null &&
    typeof finalApi.getError === "string";
  checks.push(
    check(
      "removed tab disappears from query and is rejected by tabs.get",
      removalConsistent,
      finalApi,
      "The removed tab ID remained queryable or tabs.get did not reject it.",
    ),
  );

  await worker.evaluate(`globalThis.__chromecraftTabsLifecycle.reset()`);
  worker.close();
  worker = null;
  try {
    const browserVersion = await fetchJson(
      `http://127.0.0.1:${debugPort}/json/version`,
    );
    if (typeof browserVersion.webSocketDebuggerUrl !== "string") {
      throw new Error("The browser DevTools endpoint did not expose a socket.");
    }
    const browser = await CdpClient.connect(
      browserVersion.webSocketDebuggerUrl,
    );
    try {
      const stopped = await browser.send("Target.closeTarget", {
        targetId: workerTarget.id,
      });
      if (stopped?.success !== true) {
        throw new Error(
          "CDP did not accept service-worker target termination.",
        );
      }
    } finally {
      browser.close();
    }
    await poll(
      () => targetList(debugPort),
      (targets) => !targets.some((target) => target.id === workerTarget.id),
      "the MV3 service worker to stop",
      10_000,
    );
    wakeProbe = {
      attempted: true,
      passed: false,
      reason: "No tab event restarted the stopped MV3 worker.",
    };
    const wakeBrowserTabId = await shell.evaluate(
      `window.chromecraft.createTab(${JSON.stringify(`${fixture.origin}/wake-target`)})`,
    );
    let wakeTarget = null;
    try {
      wakeTarget = await waitForTarget(
        debugPort,
        (target) =>
          target.type === "service_worker" &&
          target.id !== workerTarget.id &&
          target.url.startsWith(`chrome-extension://${extensionId}/`),
        "a tab event to wake the MV3 service worker",
        10_000,
      );
    } catch (error) {
      wakeProbe.reason =
        "The worker was stopped successfully, but a Browser Shell tab creation did not restart it within 10 seconds.";
    }
    if (wakeTarget) {
      wakeWorker = await CdpClient.connect(wakeTarget.webSocketDebuggerUrl);
      await wakeWorker.send("Runtime.enable");
      const wakeState = await poll(
        () =>
          wakeWorker.evaluate(
            `globalThis.__chromecraftTabsLifecycle.snapshot()`,
          ),
        (value) =>
          value?.starts >= 2 &&
          value.events.some(
            (event) =>
              event.type === "created" && Number.isInteger(event.tabId),
          ),
        "the restarted worker to persist the wake-causing tab event",
        10_000,
      ).catch((error) => ({ error: error.message }));
      const createdAfterWake = wakeState?.events?.find(
        (event) => event.type === "created",
      );
      wakeProbe = {
        attempted: true,
        passed:
          wakeState?.starts >= 2 && Number.isInteger(createdAfterWake?.tabId),
        reason:
          wakeState?.starts >= 2 && Number.isInteger(createdAfterWake?.tabId)
            ? null
            : "The worker restarted without receiving the wake-causing tabs.onCreated event.",
        wakeState,
      };
    }
    await shell.evaluate(
      `window.chromecraft.closeTab(${JSON.stringify(wakeBrowserTabId)})`,
    );
  } catch (error) {
    wakeProbe = {
      attempted: false,
      passed: null,
      reason: `Worker stop/wake was not feasible through this packaged runtime: ${error.message}`,
    };
  }
  checks.push({
    name: "stopped MV3 worker wakes for a tabs.onCreated event",
    passed: wakeProbe.passed,
    evidence: wakeProbe,
    error: wakeProbe.passed === false ? wakeProbe.reason : null,
    required: wakeProbe.attempted,
  });
} catch (error) {
  fatalError = error.stack ?? error.message;
} finally {
  wakeWorker?.close();
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
  extension: {
    id: extensionId,
    manifestVersion: 3,
    version: extensionVersion,
    fixtureOrigin: fixture.origin,
  },
  checks,
  coreEvidence,
  wakeProbe,
  fixtureRequests: fixture.requests,
  fatalError,
};
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await removeDisposableProfile(profile);
console.log(JSON.stringify(report, null, 2));
if (!report.success) process.exitCode = 1;
