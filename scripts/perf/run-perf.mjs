import { spawn, execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";

const execFile = promisify(execFileCallback);
const root = process.cwd();
const SCHEMA_VERSION = 1;
const DEFAULT_TAB_COUNTS = [1, 5, 10, 20];
const MAX_LOG_BYTES = 512 * 1024;

function parseInteger(value, name, minimum = 0) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}.`);
  }
  return parsed;
}

function parseArguments(argv) {
  const values = new Map();
  let help = false;
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (!argument.startsWith("--") || !argument.includes("=")) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const [name, ...rest] = argument.slice(2).split("=");
    values.set(name, rest.join("="));
  }

  const platform = values.get("platform") ?? process.platform;
  if (platform !== "win32" && platform !== "linux") {
    throw new Error("--platform must be win32 or linux.");
  }

  const modes = (values.get("modes") ?? "enabled,disabled")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    modes.length === 0 ||
    modes.some((mode) => mode !== "enabled" && mode !== "disabled")
  ) {
    throw new Error("--modes must contain enabled, disabled, or both.");
  }

  const tabCounts = (values.get("tab-counts") ?? DEFAULT_TAB_COUNTS.join(","))
    .split(",")
    .map((value) => parseInteger(value.trim(), "--tab-counts", 1));
  if (
    tabCounts.length === 0 ||
    tabCounts.some((value, index) => index > 0 && value <= tabCounts[index - 1])
  ) {
    throw new Error("--tab-counts must be unique ascending positive integers.");
  }
  if (!tabCounts.includes(1)) {
    throw new Error("--tab-counts must include 1.");
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDirectory = path.resolve(
    values.get("output") ?? path.join(root, ".artifacts", "perf", stamp),
  );
  const defaultExecutable =
    platform === "win32"
      ? path.join(root, "out", "Chromecraft-win32-x64", "chromecraft.exe")
      : path.join(root, "out", "Chromecraft-linux-x64", "chromecraft");

  const known = new Set([
    "platform",
    "modes",
    "runs",
    "warmups",
    "interaction-samples",
    "idle-sample-ms",
    "settle-ms",
    "fixture-delay-ms",
    "tab-counts",
    "output",
    "executable",
  ]);
  for (const name of values.keys()) {
    if (!known.has(name)) throw new Error(`Unknown option: --${name}`);
  }

  return {
    help,
    platform,
    modes,
    runs: parseInteger(values.get("runs") ?? "5", "--runs", 1),
    warmups: parseInteger(values.get("warmups") ?? "1", "--warmups"),
    interactionSamples: parseInteger(
      values.get("interaction-samples") ?? "7",
      "--interaction-samples",
      1,
    ),
    idleSampleMs: parseInteger(
      values.get("idle-sample-ms") ?? "2000",
      "--idle-sample-ms",
      250,
    ),
    settleMs: parseInteger(values.get("settle-ms") ?? "750", "--settle-ms", 0),
    fixtureDelayMs: parseInteger(
      values.get("fixture-delay-ms") ?? "0",
      "--fixture-delay-ms",
      0,
    ),
    tabCounts,
    outputDirectory,
    executable: path.resolve(values.get("executable") ?? defaultExecutable),
  };
}

function printHelp() {
  console.log(`Chromecraft packaged-app performance harness

Usage:
  node scripts/perf/run-perf.mjs [options]

Options:
  --platform=win32|linux        Packaged target (default: current platform)
  --modes=enabled,disabled      uBlock modes (default: both)
  --runs=N                      Measured launches per mode (default: 5)
  --warmups=N                   Unmeasured profile warmups per mode (default: 1)
  --interaction-samples=N       Repetitions for interaction metrics (default: 7)
  --idle-sample-ms=N            CPU sampling interval per tab count (default: 2000)
  --settle-ms=N                 Settle delay before resource samples (default: 750)
  --fixture-delay-ms=N          Deterministic server response delay (default: 0)
  --tab-counts=1,5,10,20        Loaded-tab resource points
  --executable=PATH             Override packaged executable
  --output=PATH                 Output directory

The default output is .artifacts/perf/<timestamp>/performance.json.`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function quantile(sorted, fraction) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function summarize(samples, unit) {
  const finite = samples
    .filter(Number.isFinite)
    .map(Number)
    .sort((a, b) => a - b);
  if (finite.length === 0) return { unit, count: 0 };
  return {
    unit,
    count: finite.length,
    min: round(finite[0]),
    median: round(quantile(finite, 0.5)),
    p95: round(quantile(finite, 0.95)),
    max: round(finite.at(-1)),
    mean: round(finite.reduce((sum, value) => sum + value, 0) / finite.length),
  };
}

async function findFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a loopback port.");
  }
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

function fixtureHtml(caseName) {
  const safeCase = caseName.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Chromecraft perf ${safeCase}</title>
    <link rel="stylesheet" href="/style.css?case=${safeCase}">
  </head>
  <body>
    <main><h1>Chromecraft deterministic workload</h1><div id="rows"></div></main>
    <script src="/app.js?case=${safeCase}"></script>
  </body>
</html>`;
}

const fixtureCss = `
*{box-sizing:border-box}body{margin:0;background:#f2f5ef;color:#1d2b1f;font:14px system-ui,sans-serif}
main{max-width:960px;margin:auto;padding:28px}h1{margin:0 0 22px}.row{display:grid;grid-template-columns:90px 1fr 110px;gap:12px;padding:8px 10px;border-bottom:1px solid #d7dfd3;background:#fff}.row:nth-child(2n){background:#f7faf5}.meter{height:8px;margin-top:5px;border-radius:5px;background:linear-gradient(90deg,#4b7d3a var(--fill),#dce5d8 var(--fill))}
`;

const fixtureScript = `
(() => {
  const fragment = document.createDocumentFragment();
  let checksum = 2166136261;
  for (let index = 0; index < 240; index += 1) {
    checksum ^= index + 31;
    checksum = Math.imul(checksum, 16777619) >>> 0;
    const row = document.createElement("section");
    row.className = "row";
    const percent = checksum % 101;
    row.innerHTML = "<strong>Row " + index + "</strong><span>Deterministic content " + checksum + "<div class='meter' style='--fill:" + percent + "%'></div></span><span>" + percent + "%</span>";
    fragment.appendChild(row);
  }
  document.querySelector("#rows").appendChild(fragment);
  document.documentElement.dataset.perfReady = "true";
  window.__chromecraftPerfChecksum = checksum;
})();
`;

async function startFixtureServer(responseDelayMs) {
  let requests = 0;
  const server = http.createServer(async (request, response) => {
    requests += 1;
    if (responseDelayMs > 0) await delay(responseDelayMs);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let body;
    let contentType;
    if (url.pathname === "/fixture") {
      body = fixtureHtml(url.searchParams.get("case") ?? "default");
      contentType = "text/html; charset=utf-8";
    } else if (url.pathname === "/style.css") {
      body = fixtureCss;
      contentType = "text/css; charset=utf-8";
    } else if (url.pathname === "/app.js") {
      body = fixtureScript;
      contentType = "application/javascript; charset=utf-8";
    } else if (url.pathname === "/favicon.ico") {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    } else {
      body = "Not found";
      contentType = "text/plain; charset=utf-8";
      response.statusCode = 404;
    }
    response.setHeader("content-type", contentType);
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-length", Buffer.byteLength(body));
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not start the deterministic fixture server.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    get requests() {
      return requests;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

let WebSocketImplementation;
async function getWebSocketImplementation() {
  if (WebSocketImplementation) return WebSocketImplementation;
  if (typeof globalThis.WebSocket === "function") {
    WebSocketImplementation = globalThis.WebSocket;
    return WebSocketImplementation;
  }
  try {
    const module = await import("ws");
    WebSocketImplementation = module.WebSocket;
    return WebSocketImplementation;
  } catch {
    throw new Error(
      "This harness requires Node.js 22+ (global WebSocket) or the installed ws package.",
    );
  }
}

class CdpClient {
  constructor(socket, url) {
    this.socket = socket;
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("close", () =>
      this.rejectPending("CDP socket closed."),
    );
    socket.addEventListener("error", () =>
      this.rejectPending("CDP socket failed."),
    );
  }

  static async connect(url, timeoutMs = 5_000) {
    const WebSocketClass = await getWebSocketImplementation();
    const socket = new WebSocketClass(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out connecting to ${url}.`)),
        timeoutMs,
      );
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error(`Could not connect to ${url}.`));
        },
        { once: true },
      );
    });
    return new CdpClient(socket, url);
  }

  onMessage(data) {
    let message;
    try {
      message = JSON.parse(typeof data === "string" ? data : data.toString());
    } catch {
      return;
    }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(`${message.error.message} (${pending.method})`));
    } else {
      pending.resolve(message.result);
    }
  }

  rejectPending(reason) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  send(method, params = {}, timeoutMs = 10_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, awaitPromise = true, timeoutMs = 10_000) {
    const response = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise,
        returnByValue: true,
        userGesture: true,
      },
      timeoutMs,
    );
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description;
      throw new Error(detail ?? response.exceptionDetails.text);
    }
    return response.result.value;
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // The browser may have closed the connection first.
    }
  }
}

async function fetchJson(url, timeoutMs = 1_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return response.json();
}

async function waitForShellTarget(port, deadlineMs = 30_000) {
  const started = performance.now();
  let lastError;
  while (performance.now() - started < deadlineMs) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const target = targets.find(
        (candidate) =>
          candidate.type === "page" &&
          !candidate.url.startsWith("chrome-extension://") &&
          (candidate.url.startsWith("file://") ||
            candidate.url.includes("main_window")),
      );
      if (target?.webSocketDebuggerUrl) return target;
    } catch (error) {
      lastError = error;
    }
    await delay(40);
  }
  throw new Error(
    `Timed out waiting for Chromecraft's shell target.${lastError ? ` Last error: ${lastError.message}` : ""}`,
  );
}

async function connectToShellTarget(port, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let client;
    try {
      const target = await waitForShellTarget(port);
      client = await CdpClient.connect(target.webSocketDebuggerUrl, 10_000);
      // Runtime.evaluate does not require Runtime.enable. Enabling the whole
      // domain can stall briefly while a just-created renderer reports every
      // execution context, which is observer overhead rather than browser
      // readiness and must not be charged to startup.
      return client;
    } catch (error) {
      lastError = error;
      client?.close();
      if (attempt < attempts) await delay(100 * attempt);
    }
  }
  throw new Error(
    `Could not attach to Chromecraft's shell target after ${attempts} attempts: ${lastError?.message ?? "unknown error"}`,
  );
}

async function poll(operation, predicate, description, timeoutMs = 10_000) {
  const started = performance.now();
  let lastValue;
  let lastError;
  while (performance.now() - started < timeoutMs) {
    try {
      lastValue = await operation();
      if (predicate(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await delay(5);
  }
  const suffix = lastError
    ? ` Last error: ${lastError.message}`
    : ` Last value: ${JSON.stringify(lastValue)}`;
  throw new Error(`Timed out waiting for ${description}.${suffix}`);
}

function appendLog(current, chunk) {
  const next = current + chunk.toString();
  return next.length > MAX_LOG_BYTES ? next.slice(-MAX_LOG_BYTES) : next;
}

async function launchBrowser(executable, profile, ublockEnabled) {
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(
    path.join(profile, "preferences.json"),
    `${JSON.stringify({ ublockEnabled }, null, 2)}\n`,
    "utf8",
  );
  const port = await findFreePort();
  const args = [
    `--chromecraft-user-data=${profile}`,
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
  ];
  const startedAt = performance.now();
  const child = spawn(executable, args, {
    cwd: root,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let log = "";
  let exited = false;
  let exitCode = null;
  child.stdout.on("data", (chunk) => (log = appendLog(log, chunk)));
  child.stderr.on("data", (chunk) => (log = appendLog(log, chunk)));
  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      resolve({ code, signal });
    });
  });
  const earlyError = new Promise((_, reject) => {
    child.once("error", reject);
  });

  let shell;
  try {
    await Promise.race([
      waitForShellTarget(port),
      earlyError,
      exitPromise.then(({ code, signal }) => {
        throw new Error(
          `Chromecraft exited before CDP became ready (code ${code}, signal ${signal}).`,
        );
      }),
    ]);
    shell = await connectToShellTarget(port);
    const readiness = await poll(
      () =>
        shell.evaluate(`(async () => {
          if (!window.chromecraft) return null;
          const snapshot = await window.chromecraft.getSnapshot();
          const shellReady = Boolean(document.querySelector('[aria-label="Address and search"]'));
          return { snapshot, shellReady };
        })()`),
      (value) => Boolean(value?.shellReady && value.snapshot?.activeTabId),
      "the browser API and shell DOM",
      20_000,
    );
    return {
      child,
      port,
      shell,
      profile,
      startedAt,
      startupReadyMs: round(performance.now() - startedAt),
      readiness,
      exitPromise,
      get exited() {
        return exited;
      },
      get exitCode() {
        return exitCode;
      },
      get log() {
        return log;
      },
    };
  } catch (error) {
    await terminateProcess(child.pid, child, exitPromise, exited);
    throw new Error(`${error.message}\n${log}`);
  }
}

async function terminateProcess(rootPid, child, exitPromise, alreadyExited) {
  if (!rootPid || alreadyExited) return;
  if (process.platform === "win32") {
    try {
      await execFile("taskkill", ["/PID", String(rootPid), "/T", "/F"], {
        windowsHide: true,
      });
    } catch {
      try {
        child.kill();
      } catch {
        // The exact spawned process already exited.
      }
    }
  } else {
    try {
      child.kill("SIGTERM");
    } catch {
      // The exact spawned process already exited.
    }
  }
  await Promise.race([exitPromise, delay(5_000)]);
}

async function closeBrowser(browser) {
  try {
    const version = await fetchJson(
      `http://127.0.0.1:${browser.port}/json/version`,
    );
    if (version.webSocketDebuggerUrl) {
      const client = await CdpClient.connect(version.webSocketDebuggerUrl);
      void client.send("Browser.close").catch(() => undefined);
      await Promise.race([browser.exitPromise, delay(5_000)]);
      client.close();
    }
  } catch {
    // Fall through to exact process-tree termination.
  }
  browser.shell?.close();
  await terminateProcess(
    browser.child.pid,
    browser.child,
    browser.exitPromise,
    browser.exited,
  );
}

async function getSnapshot(shell) {
  return shell.evaluate("window.chromecraft.getSnapshot()");
}

async function waitForTab(
  shell,
  tabId,
  predicate,
  description,
  timeoutMs = 15_000,
) {
  return poll(
    async () => {
      const snapshot = await getSnapshot(shell);
      return snapshot.tabs.find((tab) => tab.id === tabId) ?? null;
    },
    (tab) => Boolean(tab && predicate(tab)),
    description,
    timeoutMs,
  );
}

async function measureNewTab(shell, samples) {
  const mainAckMs = [];
  const shellStateMs = [];
  for (let index = 0; index < samples; index += 1) {
    const before = await getSnapshot(shell);
    const started = performance.now();
    const tabId = await shell.evaluate("window.chromecraft.createTab()");
    mainAckMs.push(round(performance.now() - started));
    await poll(
      () =>
        shell.evaluate(
          `document.querySelectorAll('[role="tab"]').length === ${before.tabs.length + 1}`,
        ),
      Boolean,
      "the new tab to appear in shell state",
    );
    shellStateMs.push(round(performance.now() - started));
    await shell.evaluate(
      `window.chromecraft.closeTab(${JSON.stringify(tabId)})`,
    );
    await poll(
      () =>
        shell.evaluate(
          `document.querySelectorAll('[role="tab"]').length === ${before.tabs.length}`,
        ),
      Boolean,
      "the temporary new tab to close",
    );
  }
  return { mainAckMs, shellStateMs };
}

async function measureOmniboxFocus(shell, samples) {
  const focusProxyMs = [];
  for (let index = 0; index < samples; index += 1) {
    const point = await shell.evaluate(`(() => {
      const input = document.querySelector('[aria-label="Address and search"]');
      if (!input) return null;
      const rect = input.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!point)
      throw new Error("Could not locate the omnibox for its focus proxy.");
    await shell.evaluate(
      `(() => { document.activeElement?.blur(); document.body.focus(); return true; })()`,
    );
    const started = performance.now();
    await shell.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await shell.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await poll(
      () =>
        shell.evaluate(
          `document.activeElement?.getAttribute('aria-label') === 'Address and search'`,
        ),
      Boolean,
      "a pointer action to focus the omnibox",
    );
    focusProxyMs.push(round(performance.now() - started));
  }
  return { focusProxyMs };
}

async function measureOmniboxInput(shell, samples) {
  const feedbackMs = [];
  await shell.evaluate(`(() => {
    const input = document.querySelector('[aria-label="Address and search"]');
    input?.focus();
    input?.select();
    return Boolean(input);
  })()`);
  let expected = "";
  for (let index = 0; index < samples; index += 1) {
    const text = String(index % 10);
    const started = performance.now();
    await shell.send("Input.insertText", { text });
    expected += text;
    await poll(
      () =>
        shell.evaluate(
          `document.querySelector('[aria-label="Address and search"]')?.value === ${JSON.stringify(expected)}`,
        ),
      Boolean,
      "omnibox input feedback",
    );
    feedbackMs.push(round(performance.now() - started));
  }
  return { feedbackMs };
}

async function readPageNavigationTiming(port, targetUrl) {
  try {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    const target = targets.find(
      (candidate) =>
        candidate.type === "page" &&
        (candidate.url === targetUrl || candidate.url.startsWith(targetUrl)),
    );
    if (!target?.webSocketDebuggerUrl) return null;
    const client = await CdpClient.connect(target.webSocketDebuggerUrl);
    try {
      const value = await client.evaluate(`(() => {
        const entry = performance.getEntriesByType('navigation')[0];
        if (!entry) return null;
        return {
          durationMs: entry.duration,
          domContentLoadedMs: entry.domContentLoadedEventEnd,
          responseEndMs: entry.responseEnd,
          ready: document.documentElement.dataset.perfReady === 'true'
        };
      })()`);
      return value
        ? {
            durationMs: round(value.durationMs),
            domContentLoadedMs: round(value.domContentLoadedMs),
            responseEndMs: round(value.responseEndMs),
            ready: Boolean(value.ready),
          }
        : null;
    } finally {
      client.close();
    }
  } catch {
    return null;
  }
}

async function measureScrollSmoothness(port, targetUrl) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  const target = targets.find(
    (candidate) =>
      candidate.type === "page" &&
      (candidate.url === targetUrl || candidate.url.startsWith(targetUrl)),
  );
  if (!target?.webSocketDebuggerUrl) return null;
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    return await client.evaluate(
      `new Promise((resolve) => {
      const intervals = [];
      const durationTarget = 800;
      const maximumScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
      let startedAt;
      let previous;
      scrollTo(0, 0);
      requestAnimationFrame(function frame(timestamp) {
        if (startedAt === undefined) {
          startedAt = timestamp;
        } else {
          intervals.push(timestamp - previous);
        }
        previous = timestamp;
        const progress = Math.min(1, (timestamp - startedAt) / durationTarget);
        scrollTo(0, maximumScroll * progress);
        if (progress < 1) {
          requestAnimationFrame(frame);
          return;
        }
        const sorted = intervals.slice().sort((left, right) => left - right);
        const percentile = (value) => {
          if (sorted.length === 0) return 0;
          const position = (sorted.length - 1) * value;
          const lower = Math.floor(position);
          const upper = Math.ceil(position);
          if (lower === upper) return sorted[lower];
          return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
        };
        const median = percentile(0.5);
        const longFrameThreshold = Math.max(median * 1.5, median + 4);
        const longFrames = intervals.filter((value) => value > longFrameThreshold).length;
        scrollTo(0, 0);
        resolve({
          frameCount: intervals.length,
          medianFrameIntervalMs: median,
          p95FrameIntervalMs: percentile(0.95),
          longFramePercent: intervals.length === 0 ? 0 : longFrames / intervals.length * 100,
          durationMs: timestamp - startedAt,
          scrollDistancePx: maximumScroll
        });
      });
    })`,
      true,
      3_000,
    );
  } catch {
    // Chromium may suspend animation frames for an occluded benchmark window.
    // In that environment, reporting no sample is more honest than fabricating
    // a scrolling result from timers that do not represent presented frames.
    return null;
  } finally {
    client.close();
  }
}

async function measureNavigation(browser, origin, samples, runLabel) {
  const initiationSnapshotMs = [];
  const shellCompleteMs = [];
  const browserNavigationDurationMs = [];
  const domContentLoadedMs = [];
  let activeTabId = (await getSnapshot(browser.shell)).activeTabId;
  let lastTarget = null;

  for (let index = 0; index < samples; index += 1) {
    const caseName = `${runLabel}-nav-${index}`;
    const target = `${origin}/fixture?case=${encodeURIComponent(caseName)}`;
    lastTarget = target;
    const expectedTitle = `Chromecraft perf ${caseName}`;
    const started = performance.now();
    await browser.shell.evaluate(`(() => {
      void window.chromecraft.navigate(
        ${JSON.stringify(activeTabId)},
        ${JSON.stringify(target)}
      );
      return true;
    })()`);
    await waitForTab(
      browser.shell,
      activeTabId,
      (tab) => tab.url === target,
      "navigation initiation to become observable in browser state",
    );
    initiationSnapshotMs.push(round(performance.now() - started));
    await waitForTab(
      browser.shell,
      activeTabId,
      (tab) =>
        tab.url === target &&
        !tab.isLoading &&
        !tab.error &&
        tab.title === expectedTitle,
      "the deterministic local page to finish loading",
      20_000,
    );
    shellCompleteMs.push(round(performance.now() - started));
    const browserTiming = await readPageNavigationTiming(browser.port, target);
    if (browserTiming?.ready) {
      browserNavigationDurationMs.push(browserTiming.durationMs);
      domContentLoadedMs.push(browserTiming.domContentLoadedMs);
    }
    activeTabId = (await getSnapshot(browser.shell)).activeTabId;
  }
  return {
    initiationSnapshotMs,
    shellCompleteMs,
    browserNavigationDurationMs,
    domContentLoadedMs,
    activeTabId,
    lastTarget,
  };
}

async function createLoadedTab(shell, origin, caseName) {
  const target = `${origin}/fixture?case=${encodeURIComponent(caseName)}`;
  const tabId = await shell.evaluate(
    `window.chromecraft.createTab(${JSON.stringify(target)})`,
  );
  await waitForTab(
    shell,
    tabId,
    (tab) =>
      tab.url === target &&
      !tab.isLoading &&
      !tab.error &&
      tab.title === `Chromecraft perf ${caseName}`,
    `loaded tab ${caseName}`,
    20_000,
  );
  return tabId;
}

async function measureTabSwitch(shell, tabIds, samples) {
  if (tabIds.length < 2) return { mainAckMs: [], shellStateMs: [] };
  const mainAckMs = [];
  const shellStateMs = [];
  let selected = 0;
  for (let index = 0; index < samples; index += 1) {
    selected = selected === 0 ? 1 : 0;
    const tabId = tabIds[selected];
    const snapshot = await getSnapshot(shell);
    const expectedTitle = snapshot.tabs.find((tab) => tab.id === tabId)?.title;
    if (!expectedTitle)
      throw new Error(`Could not find switch target ${tabId}.`);
    const started = performance.now();
    await shell.evaluate(
      `window.chromecraft.activateTab(${JSON.stringify(tabId)})`,
    );
    mainAckMs.push(round(performance.now() - started));
    await poll(
      () =>
        shell.evaluate(
          `document.querySelector('[role="tab"][aria-selected="true"]')?.title === ${JSON.stringify(expectedTitle)}`,
        ),
      Boolean,
      "the active tab to update in shell state",
    );
    shellStateMs.push(round(performance.now() - started));
  }
  return { mainAckMs, shellStateMs };
}

async function windowsProcessSnapshot(rootPid) {
  const script = `
$ErrorActionPreference = 'Stop'
$rootPid = ${rootPid}
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
$wanted = [System.Collections.Generic.HashSet[int]]::new()
[void]$wanted.Add($rootPid)
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($row in $all) {
    if ($wanted.Contains([int]$row.ParentProcessId) -and -not $wanted.Contains([int]$row.ProcessId)) {
      [void]$wanted.Add([int]$row.ProcessId)
      $changed = $true
    }
  }
}
$result = @()
foreach ($processId in $wanted) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -ne $process) {
    $result += [PSCustomObject]@{
      pid = [int]$process.Id
      name = [string]$process.ProcessName
      cpuSeconds = if ($null -eq $process.CPU) { 0 } else { [double]$process.CPU }
      workingSetBytes = [long]$process.WorkingSet64
      privateBytes = [long]$process.PrivateMemorySize64
    }
  }
}
ConvertTo-Json -InputObject @($result) -Compress
`;
  const { stdout } = await execFile(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout.trim() || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

let linuxClockTicks;
async function getLinuxClockTicks() {
  if (linuxClockTicks) return linuxClockTicks;
  const { stdout } = await execFile("getconf", ["CLK_TCK"]);
  linuxClockTicks = Number.parseInt(stdout.trim(), 10);
  if (!Number.isFinite(linuxClockTicks)) {
    throw new Error("Could not determine Linux CLK_TCK.");
  }
  return linuxClockTicks;
}

async function linuxProcessSnapshot(rootPid) {
  const clockTicks = await getLinuxClockTicks();
  const entries = await fs.readdir("/proc", { withFileTypes: true });
  const rows = [];
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        const pid = Number.parseInt(entry.name, 10);
        try {
          const [stat, status] = await Promise.all([
            fs.readFile(`/proc/${pid}/stat`, "utf8"),
            fs.readFile(`/proc/${pid}/status`, "utf8"),
          ]);
          const closingParen = stat.lastIndexOf(")");
          const fields = stat
            .slice(closingParen + 2)
            .trim()
            .split(/\s+/);
          const name = status.match(/^Name:\s+(.+)$/m)?.[1] ?? "unknown";
          const workingSetKb = Number.parseInt(
            status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] ?? "0",
            10,
          );
          rows.push({
            pid,
            parentPid: Number.parseInt(fields[1], 10),
            name,
            cpuSeconds:
              (Number.parseInt(fields[11], 10) +
                Number.parseInt(fields[12], 10)) /
              clockTicks,
            workingSetBytes: workingSetKb * 1024,
            privateBytes: null,
          });
        } catch {
          // Processes can exit while /proc is being sampled.
        }
      }),
  );
  const wanted = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (wanted.has(row.parentPid) && !wanted.has(row.pid)) {
        wanted.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => wanted.has(row.pid));
}

async function processSnapshot(rootPid) {
  if (process.platform === "win32") return windowsProcessSnapshot(rootPid);
  if (process.platform === "linux") return linuxProcessSnapshot(rootPid);
  throw new Error("Process resource sampling supports Windows and Linux only.");
}

function aggregateProcessSnapshot(rows) {
  return {
    processCount: rows.length,
    workingSetBytes: rows.reduce(
      (total, row) => total + Number(row.workingSetBytes ?? 0),
      0,
    ),
    privateBytes: rows.some((row) => row.privateBytes === null)
      ? null
      : rows.reduce((total, row) => total + Number(row.privateBytes ?? 0), 0),
    cpuSeconds: rows.reduce(
      (total, row) => total + Number(row.cpuSeconds ?? 0),
      0,
    ),
    processes: rows
      .map((row) => ({
        pid: Number(row.pid),
        name: row.name,
        workingSetBytes: Number(row.workingSetBytes ?? 0),
        privateBytes:
          row.privateBytes === null ? null : Number(row.privateBytes ?? 0),
      }))
      .sort((left, right) => left.pid - right.pid),
  };
}

async function measureResources(rootPid, sampleMs) {
  const firstStarted = performance.now();
  const firstRows = await processSnapshot(rootPid);
  const firstFinished = performance.now();
  await delay(sampleMs);
  const secondStarted = performance.now();
  const secondRows = await processSnapshot(rootPid);
  const secondFinished = performance.now();
  const first = aggregateProcessSnapshot(firstRows);
  const second = aggregateProcessSnapshot(secondRows);
  const elapsedSeconds =
    ((secondStarted + secondFinished) / 2 -
      (firstStarted + firstFinished) / 2) /
    1000;
  const cpuSeconds = Math.max(0, second.cpuSeconds - first.cpuSeconds);
  const percentOfOneCore = (cpuSeconds / elapsedSeconds) * 100;
  return {
    memory: {
      processCount: second.processCount,
      workingSetBytes: second.workingSetBytes,
      privateBytes: second.privateBytes,
      processes: second.processes,
    },
    idleCpu: {
      sampleMs: round(elapsedSeconds * 1000),
      cpuSeconds: round(cpuSeconds, 6),
      percentOfOneCore: round(percentOfOneCore),
      percentOfMachine: round(percentOfOneCore / os.cpus().length),
    },
  };
}

async function runWarmup(options, mode, profile, fixture, index, logDirectory) {
  let browser;
  try {
    browser = await launchBrowser(
      options.executable,
      profile,
      mode === "enabled",
    );
    const snapshot = await getSnapshot(browser.shell);
    const tabId = snapshot.activeTabId;
    const caseName = `${mode}-warmup-${index}`;
    const target = `${fixture.origin}/fixture?case=${caseName}`;
    await browser.shell.evaluate(
      `window.chromecraft.navigate(${JSON.stringify(tabId)}, ${JSON.stringify(target)})`,
    );
    await waitForTab(
      browser.shell,
      tabId,
      (tab) => tab.url === target && !tab.isLoading && !tab.error,
      "warmup fixture navigation",
      20_000,
    );
    await delay(options.settleMs);
    return {
      success: true,
      index,
      startupReadyMs: browser.startupReadyMs,
      ublock: (await getSnapshot(browser.shell)).ublock,
    };
  } catch (error) {
    return { success: false, index, error: error.stack ?? error.message };
  } finally {
    if (browser) {
      await fs.writeFile(
        path.join(logDirectory, `${mode}-warmup-${index}.log`),
        browser.log,
        "utf8",
      );
      await closeBrowser(browser);
    }
  }
}

async function runMeasured(
  options,
  mode,
  profile,
  fixture,
  runIndex,
  logDirectory,
) {
  const runLabel = `${mode}-run-${runIndex}`;
  let browser;
  const run = {
    success: false,
    mode,
    runIndex,
    startedAt: new Date().toISOString(),
    metrics: null,
    error: null,
  };
  try {
    browser = await launchBrowser(
      options.executable,
      profile,
      mode === "enabled",
    );
    const initialSnapshot = await getSnapshot(browser.shell);
    const ublockAtShellReady = initialSnapshot.ublock;
    if (ublockAtShellReady.enabled !== (mode === "enabled")) {
      throw new Error(
        `Requested uBlock ${mode}, but browser reported enabled=${ublockAtShellReady.enabled}.`,
      );
    }
    if (mode === "disabled" && ublockAtShellReady.ready) {
      throw new Error("uBlock disabled run unexpectedly loaded the extension.");
    }

    const newTab = await measureNewTab(
      browser.shell,
      options.interactionSamples,
    );
    const omnibox = await measureOmniboxFocus(
      browser.shell,
      options.interactionSamples,
    );
    const omniboxInput = await measureOmniboxInput(
      browser.shell,
      options.interactionSamples,
    );
    let ublock = ublockAtShellReady;
    let protectionReadyMs = null;
    if (mode === "enabled") {
      const protectedSnapshot = await poll(
        () => getSnapshot(browser.shell),
        (snapshot) => snapshot.ublock.ready || Boolean(snapshot.ublock.error),
        "uBlock Origin protection readiness",
        20_000,
      );
      ublock = protectedSnapshot.ublock;
      protectionReadyMs = round(performance.now() - browser.startedAt);
      if (!ublock.ready || ublock.version !== "1.75.0") {
        throw new Error(
          `uBlock enabled run was not ready with version 1.75.0: ${JSON.stringify(ublock)}.`,
        );
      }
    }
    const navigation = await measureNavigation(
      browser,
      fixture.origin,
      options.interactionSamples,
      runLabel,
    );
    const scrollSmoothness = navigation.lastTarget
      ? await measureScrollSmoothness(browser.port, navigation.lastTarget)
      : null;

    const tabIds = [navigation.activeTabId];
    const resources = {};
    let tabSwitch = { mainAckMs: [], shellStateMs: [] };
    for (const targetCount of options.tabCounts) {
      while (tabIds.length < targetCount) {
        const ordinal = tabIds.length + 1;
        tabIds.push(
          await createLoadedTab(
            browser.shell,
            fixture.origin,
            `${runLabel}-tab-${ordinal}`,
          ),
        );
      }
      if (tabIds.length >= 2 && tabSwitch.mainAckMs.length === 0) {
        tabSwitch = await measureTabSwitch(
          browser.shell,
          tabIds,
          options.interactionSamples,
        );
      }
      await delay(options.settleMs);
      resources[String(targetCount)] = await measureResources(
        browser.child.pid,
        options.idleSampleMs,
      );
    }

    const retainedTabId = tabIds[0];
    await browser.shell.evaluate(
      `window.chromecraft.activateTab(${JSON.stringify(retainedTabId)})`,
    );
    for (const tabId of tabIds.slice(1)) {
      await browser.shell.evaluate(
        `window.chromecraft.closeTab(${JSON.stringify(tabId)})`,
      );
    }
    await poll(
      () => getSnapshot(browser.shell),
      (snapshot) =>
        snapshot.tabs.length === 1 && snapshot.activeTabId === retainedTabId,
      "loaded tabs to close and release",
      20_000,
    );
    await delay(Math.max(options.settleMs, 1_000));
    const resourcesAfterClose = await measureResources(
      browser.child.pid,
      options.idleSampleMs,
    );

    const finalSnapshot = await getSnapshot(browser.shell);
    run.success = true;
    run.metrics = {
      startupReadyMs: browser.startupReadyMs,
      protectionReadyMs,
      ublockAtShellReady,
      ublock,
      newTab,
      omnibox,
      omniboxInput,
      navigation: {
        initiationSnapshotMs: navigation.initiationSnapshotMs,
        shellCompleteMs: navigation.shellCompleteMs,
        browserNavigationDurationMs: navigation.browserNavigationDurationMs,
        domContentLoadedMs: navigation.domContentLoadedMs,
      },
      scrollSmoothness,
      tabSwitch,
      resources,
      resourcesAfterClose,
      finalTabCount: finalSnapshot.tabs.length,
    };
  } catch (error) {
    run.error = error.stack ?? error.message;
  } finally {
    if (browser) {
      await fs.writeFile(
        path.join(logDirectory, `${runLabel}.log`),
        browser.log,
        "utf8",
      );
      await closeBrowser(browser);
      run.exitCode = browser.exitCode;
    }
    run.finishedAt = new Date().toISOString();
  }
  return run;
}

function modeAggregates(runs, tabCounts) {
  const successful = runs.filter((run) => run.success && run.metrics);
  const flatten = (selector) => successful.flatMap(selector);
  const aggregate = {
    successfulRuns: successful.length,
    failedRuns: runs.length - successful.length,
    startupReady: summarize(
      successful.map((run) => run.metrics.startupReadyMs),
      "ms",
    ),
    protectionReady: summarize(
      successful
        .map((run) => run.metrics.protectionReadyMs)
        .filter((value) => Number.isFinite(value)),
      "ms",
    ),
    newTabMainAck: summarize(
      flatten((run) => run.metrics.newTab.mainAckMs),
      "ms",
    ),
    newTabShellState: summarize(
      flatten((run) => run.metrics.newTab.shellStateMs),
      "ms",
    ),
    omniboxFocusProxy: summarize(
      flatten((run) => run.metrics.omnibox.focusProxyMs),
      "ms",
    ),
    omniboxInputFeedback: summarize(
      flatten((run) => run.metrics.omniboxInput.feedbackMs),
      "ms",
    ),
    tabSwitchMainAck: summarize(
      flatten((run) => run.metrics.tabSwitch.mainAckMs),
      "ms",
    ),
    tabSwitchShellState: summarize(
      flatten((run) => run.metrics.tabSwitch.shellStateMs),
      "ms",
    ),
    navigationInitiationSnapshot: summarize(
      flatten((run) => run.metrics.navigation.initiationSnapshotMs),
      "ms",
    ),
    localPageShellComplete: summarize(
      flatten((run) => run.metrics.navigation.shellCompleteMs),
      "ms",
    ),
    localPageBrowserNavigation: summarize(
      flatten((run) => run.metrics.navigation.browserNavigationDurationMs),
      "ms",
    ),
    localPageDomContentLoaded: summarize(
      flatten((run) => run.metrics.navigation.domContentLoadedMs),
      "ms",
    ),
    scrollMedianFrameInterval: summarize(
      successful.map(
        (run) => run.metrics.scrollSmoothness?.medianFrameIntervalMs,
      ),
      "ms",
    ),
    scrollP95FrameInterval: summarize(
      successful.map((run) => run.metrics.scrollSmoothness?.p95FrameIntervalMs),
      "ms",
    ),
    scrollLongFrames: summarize(
      successful.map((run) => run.metrics.scrollSmoothness?.longFramePercent),
      "percent",
    ),
    resourcesAfterClose: {
      processCount: summarize(
        successful.map(
          (run) => run.metrics.resourcesAfterClose.memory.processCount,
        ),
        "processes",
      ),
      workingSet: summarize(
        successful.map(
          (run) => run.metrics.resourcesAfterClose.memory.workingSetBytes,
        ),
        "bytes",
      ),
      privateMemory: summarize(
        successful.map(
          (run) => run.metrics.resourcesAfterClose.memory.privateBytes,
        ),
        "bytes",
      ),
      idleCpuOneCore: summarize(
        successful.map(
          (run) => run.metrics.resourcesAfterClose.idleCpu.percentOfOneCore,
        ),
        "percent",
      ),
    },
    resources: {},
  };
  for (const count of tabCounts) {
    const points = successful
      .map((run) => run.metrics.resources[String(count)])
      .filter(Boolean);
    aggregate.resources[String(count)] = {
      processCount: summarize(
        points.map((point) => point.memory.processCount),
        "processes",
      ),
      workingSet: summarize(
        points.map((point) => point.memory.workingSetBytes),
        "bytes",
      ),
      privateMemory: summarize(
        points.map((point) => point.memory.privateBytes),
        "bytes",
      ),
      idleCpuOneCore: summarize(
        points.map((point) => point.idleCpu.percentOfOneCore),
        "percent",
      ),
      idleCpuMachine: summarize(
        points.map((point) => point.idleCpu.percentOfMachine),
        "percent",
      ),
    };
  }
  return aggregate;
}

function printSummary(report) {
  for (const mode of report.config.modes) {
    const aggregate = report.aggregates[mode];
    console.log(
      `\n${mode} (${aggregate.successfulRuns}/${report.config.runs} successful runs)`,
    );
    const rows = [
      ["startup ready", aggregate.startupReady],
      ["uBlock protection ready", aggregate.protectionReady],
      ["new tab shell state", aggregate.newTabShellState],
      ["tab switch shell state", aggregate.tabSwitchShellState],
      ["omnibox focus proxy", aggregate.omniboxFocusProxy],
      ["omnibox input feedback", aggregate.omniboxInputFeedback],
      ["navigation initiation", aggregate.navigationInitiationSnapshot],
      ["local page shell complete", aggregate.localPageShellComplete],
      ["browser navigation timing", aggregate.localPageBrowserNavigation],
      ["scroll p95 frame interval", aggregate.scrollP95FrameInterval],
      ["scroll long frames", aggregate.scrollLongFrames],
    ];
    for (const [name, metric] of rows) {
      console.log(
        `  ${name.padEnd(29)} median ${String(metric.median ?? "n/a").padStart(9)} ${metric.unit}; p95 ${metric.p95 ?? "n/a"}`,
      );
    }
    for (const count of report.config.tabCounts) {
      const resource = aggregate.resources[String(count)];
      const memoryMb =
        resource.workingSet.count > 0
          ? round(resource.workingSet.median / 1024 / 1024, 1)
          : "n/a";
      console.log(
        `  ${String(count).padStart(2)} loaded tabs                 median ${String(memoryMb).padStart(9)} MiB RSS; idle CPU ${resource.idleCpuOneCore.median ?? "n/a"}% of one core`,
      );
    }
    const afterCloseMb =
      aggregate.resourcesAfterClose.workingSet.count > 0
        ? round(
            aggregate.resourcesAfterClose.workingSet.median / 1024 / 1024,
            1,
          )
        : "n/a";
    console.log(
      `  after closing to 1 tab         median ${String(afterCloseMb).padStart(9)} MiB RSS; idle CPU ${aggregate.resourcesAfterClose.idleCpuOneCore.median ?? "n/a"}% of one core`,
    );
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  await fs.access(options.executable);
  await fs.mkdir(options.outputDirectory, { recursive: true });
  const logDirectory = path.join(options.outputDirectory, "logs");
  const profileDirectory = path.join(options.outputDirectory, "profiles");
  await fs.mkdir(logDirectory, { recursive: true });
  await fs.mkdir(profileDirectory, { recursive: true });
  const fixture = await startFixtureServer(options.fixtureDelayMs);
  const startedAt = new Date().toISOString();
  const report = {
    schemaVersion: SCHEMA_VERSION,
    success: false,
    startedAt,
    finishedAt: null,
    config: {
      platform: options.platform,
      modes: options.modes,
      runs: options.runs,
      warmups: options.warmups,
      interactionSamples: options.interactionSamples,
      idleSampleMs: options.idleSampleMs,
      settleMs: options.settleMs,
      fixtureDelayMs: options.fixtureDelayMs,
      tabCounts: options.tabCounts,
      executable: options.executable,
      outputDirectory: options.outputDirectory,
    },
    machine: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      node: process.version,
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    methodology: {
      startup:
        "spawn to first CDP-observable shell DOM plus successful browser snapshot",
      newTab:
        "context-bridge IPC acknowledgement and React shell tab-count observation",
      tabSwitch:
        "context-bridge IPC acknowledgement and React aria-selected observation; not paint latency",
      omnibox:
        "CDP pointer dispatch on the address input to shell activeElement observation; input-focus proxy, not click-to-paint",
      navigationInitiation:
        "navigation command issue to requested URL becoming observable in browser snapshot",
      localPageLoad:
        "deterministic loopback no-store HTML/CSS/JS; external shell completion and Navigation Timing",
      memory:
        "sum of resident working sets across the exact spawned Electron process tree",
      idleCpu:
        "process-tree CPU-time delta over a quiet sampling interval; one-core and whole-machine percentages",
    },
    fixture: { origin: fixture.origin, requests: 0 },
    warmups: {},
    runs: {},
    aggregates: {},
    failures: [],
  };
  const reportPath = path.join(options.outputDirectory, "performance.json");

  try {
    for (const mode of options.modes) {
      console.log(`\nPreparing uBlock ${mode} profile...`);
      const profile = path.join(profileDirectory, mode);
      await fs.mkdir(profile, { recursive: true });
      report.warmups[mode] = [];
      report.runs[mode] = [];
      for (let index = 1; index <= options.warmups; index += 1) {
        const warmup = await runWarmup(
          options,
          mode,
          profile,
          fixture,
          index,
          logDirectory,
        );
        report.warmups[mode].push(warmup);
        if (!warmup.success) {
          report.failures.push(`${mode} warmup ${index}: ${warmup.error}`);
        }
      }
      for (let index = 1; index <= options.runs; index += 1) {
        console.log(
          `Running uBlock ${mode} benchmark ${index}/${options.runs}...`,
        );
        const run = await runMeasured(
          options,
          mode,
          profile,
          fixture,
          index,
          logDirectory,
        );
        report.runs[mode].push(run);
        if (!run.success) {
          report.failures.push(`${mode} run ${index}: ${run.error}`);
        }
        await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      }
      report.aggregates[mode] = modeAggregates(
        report.runs[mode],
        options.tabCounts,
      );
    }
  } finally {
    report.fixture.requests = fixture.requests;
    await fixture.close();
    report.finishedAt = new Date().toISOString();
    report.success = report.failures.length === 0;
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  printSummary(report);
  console.log(`\nReport: ${reportPath}`);
  if (!report.success) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
