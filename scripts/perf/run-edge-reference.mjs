import { execFile as execFileCallback, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = process.cwd();
const DEFAULT_EDGE =
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DEFAULT_OUTPUT = path.join(root, ".artifacts", "perf", "edge-reference");
const TAB_COUNTS = [1, 5, 10, 20];

function integer(value, name, minimum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}.`);
  }
  return parsed;
}

function argumentsFor(argv) {
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
  const known = new Set(["edge", "output", "runs", "settle-ms"]);
  for (const name of values.keys()) {
    if (!known.has(name)) throw new Error(`Unknown option: --${name}`);
  }
  return {
    help,
    edge: path.resolve(values.get("edge") ?? DEFAULT_EDGE),
    output: path.resolve(values.get("output") ?? DEFAULT_OUTPUT),
    runs: integer(values.get("runs") ?? "5", "--runs", 1),
    settleMs: integer(values.get("settle-ms") ?? "750", "--settle-ms", 0),
  };
}

function help() {
  console.log(`Microsoft Edge local-page reference benchmark

Usage:
  node scripts/perf/run-edge-reference.mjs [options]

Options:
  --runs=N          Fresh-profile launches (default: 5)
  --settle-ms=N     Delay before each RSS sample (default: 750)
  --edge=PATH       Edge executable override
  --output=PATH     Output directory (default: .artifacts/perf/edge-reference)

This is a non-apples-to-apples reference. It does not reproduce Chromecraft's
shell, extension configuration, startup lifecycle, or tab implementation.`);
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
  const sorted = samples
    .filter(Number.isFinite)
    .map(Number)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return { unit, count: 0 };
  return {
    unit,
    count: sorted.length,
    min: round(sorted[0]),
    median: round(quantile(sorted, 0.5)),
    p95: round(quantile(sorted, 0.95)),
    max: round(sorted.at(-1)),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a loopback port.");
  }
  await new Promise((resolve) => server.close(resolve));
  return address.port;
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

function fixtureHtml(caseName) {
  const safe = caseName.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Edge reference ${safe}</title>
    <link rel="stylesheet" href="/style.css?case=${safe}">
  </head>
  <body>
    <main><h1>Chromecraft deterministic workload</h1><div id="rows"></div></main>
    <script src="/app.js?case=${safe}"></script>
  </body>
</html>`;
}

async function fixtureServer() {
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let body;
    let type;
    if (url.pathname === "/fixture") {
      body = fixtureHtml(url.searchParams.get("case") ?? "default");
      type = "text/html; charset=utf-8";
    } else if (url.pathname === "/style.css") {
      body = fixtureCss;
      type = "text/css; charset=utf-8";
    } else if (url.pathname === "/app.js") {
      body = fixtureScript;
      type = "application/javascript; charset=utf-8";
    } else if (url.pathname === "/favicon.ico") {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    } else {
      response.statusCode = 404;
      body = "Not found";
      type = "text/plain; charset=utf-8";
    }
    response.setHeader("content-type", type);
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

let WebSocketClass;
async function websocketClass() {
  if (WebSocketClass) return WebSocketClass;
  if (typeof globalThis.WebSocket === "function") {
    WebSocketClass = globalThis.WebSocket;
  } else {
    const module = await import("ws");
    WebSocketClass = module.WebSocket;
  }
  return WebSocketClass;
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => this.message(event.data));
    socket.addEventListener("close", () =>
      this.rejectAll("CDP socket closed."),
    );
    socket.addEventListener("error", () =>
      this.rejectAll("CDP socket failed."),
    );
  }

  static async connect(url) {
    const Implementation = await websocketClass();
    const socket = new Implementation(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`CDP timeout: ${url}`)),
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
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error(`CDP connection failed: ${url}`));
        },
        { once: true },
      );
    });
    return new Cdp(socket);
  }

  message(data) {
    let message;
    try {
      message = JSON.parse(typeof data === "string" ? data : data.toString());
    } catch {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  rejectAll(reason) {
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
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
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
    try {
      this.socket.close();
    } catch {
      // Edge may close the debugger connection first.
    }
  }
}

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return response.json();
}

async function poll(operation, predicate, description, timeoutMs = 20_000) {
  const started = performance.now();
  let last;
  let error;
  while (performance.now() - started < timeoutMs) {
    try {
      last = await operation();
      if (predicate(last)) return last;
    } catch (caught) {
      error = caught;
    }
    await delay(10);
  }
  throw new Error(
    `Timed out waiting for ${description}. ${error ? error.message : JSON.stringify(last)}`,
  );
}

async function browserEndpoint(port) {
  return poll(
    () => json(`http://127.0.0.1:${port}/json/version`),
    (value) => Boolean(value.webSocketDebuggerUrl),
    "Edge's browser debugger endpoint",
    30_000,
  );
}

async function pageTarget(port, targetId) {
  return poll(
    async () => {
      const targets = await json(`http://127.0.0.1:${port}/json/list`);
      return targets.find((target) => target.id === targetId) ?? null;
    },
    (target) => Boolean(target?.webSocketDebuggerUrl),
    `page target ${targetId}`,
  );
}

async function readyPage(port, targetId) {
  const target = await pageTarget(port, targetId);
  const page = await Cdp.connect(target.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  await poll(
    () =>
      page.evaluate(`({
        complete: document.readyState === 'complete',
        ready: document.documentElement.dataset.perfReady === 'true'
      })`),
    (value) => value.complete && value.ready,
    `deterministic page ${targetId} to become DOM-ready`,
  );
  const timing = await page.evaluate(`(() => {
    const entry = performance.getEntriesByType('navigation')[0];
    return entry ? {
      durationMs: entry.duration,
      domContentLoadedMs: entry.domContentLoadedEventEnd,
      responseEndMs: entry.responseEnd
    } : null;
  })()`);
  page.close();
  return {
    url: target.url,
    timing: timing
      ? {
          durationMs: round(timing.durationMs),
          domContentLoadedMs: round(timing.domContentLoadedMs),
          responseEndMs: round(timing.responseEndMs),
        }
      : null,
  };
}

async function processTree(rootPid) {
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
  const processes = (Array.isArray(parsed) ? parsed : [parsed]).sort(
    (left, right) => left.pid - right.pid,
  );
  return {
    processCount: processes.length,
    workingSetBytes: processes.reduce(
      (total, item) => total + Number(item.workingSetBytes),
      0,
    ),
    privateBytes: processes.reduce(
      (total, item) => total + Number(item.privateBytes),
      0,
    ),
    processes,
  };
}

async function terminate(instance) {
  if (!instance || instance.exited) return;
  try {
    const endpoint = await json(
      `http://127.0.0.1:${instance.port}/json/version`,
    );
    const browser = await Cdp.connect(endpoint.webSocketDebuggerUrl);
    void browser.send("Browser.close").catch(() => undefined);
    await Promise.race([instance.exitPromise, delay(5_000)]);
    browser.close();
  } catch {
    // Exact process-tree termination below is the fallback.
  }
  if (!instance.exited) {
    try {
      await execFile(
        "taskkill",
        ["/PID", String(instance.child.pid), "/T", "/F"],
        { windowsHide: true },
      );
    } catch {
      try {
        instance.child.kill();
      } catch {
        // The exact spawned Edge process already exited.
      }
    }
    await Promise.race([instance.exitPromise, delay(5_000)]);
  }
}

async function runOnce(options, fixture, runIndex) {
  const profile = path.join(options.output, "profiles", `run-${runIndex}`);
  await fs.mkdir(profile, { recursive: true });
  const port = await freePort();
  const initialUrl = `${fixture.origin}/fixture?case=edge-run-${runIndex}-tab-1`;
  const launchArguments = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--new-window",
    initialUrl,
  ];
  const started = performance.now();
  const child = spawn(options.edge, launchArguments, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let exited = false;
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk.toString()));
  child.stderr.on("data", (chunk) => (log += chunk.toString()));
  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });
  const instance = {
    child,
    port,
    exitPromise,
    get exited() {
      return exited;
    },
  };
  const run = {
    runIndex,
    success: false,
    startedAt: new Date().toISOString(),
    profile,
    launchArguments,
    startupDomReadyMs: null,
    initialNavigationTiming: null,
    allTabNavigationDurationMs: [],
    resources: {},
    edgeVersion: null,
    error: null,
  };

  try {
    const version = await browserEndpoint(port);
    run.edgeVersion = version.Browser ?? null;
    const control = await Cdp.connect(version.webSocketDebuggerUrl);
    const initialTarget = await poll(
      async () => {
        const targets = await json(`http://127.0.0.1:${port}/json/list`);
        return targets.find((target) => target.url === initialUrl) ?? null;
      },
      (target) => Boolean(target?.id && target.webSocketDebuggerUrl),
      "the initial Edge fixture target",
    );
    const initialPage = await readyPage(port, initialTarget.id);
    run.startupDomReadyMs = round(performance.now() - started);
    run.initialNavigationTiming = initialPage.timing;
    if (initialPage.timing) {
      run.allTabNavigationDurationMs.push(initialPage.timing.durationMs);
    }

    const targets = await control.send("Target.getTargets");
    for (const target of targets.targetInfos) {
      if (target.type === "page" && target.targetId !== initialTarget.id) {
        await control.send("Target.closeTarget", { targetId: target.targetId });
      }
    }

    const tabIds = [initialTarget.id];
    for (const count of TAB_COUNTS) {
      while (tabIds.length < count) {
        const ordinal = tabIds.length + 1;
        const url = `${fixture.origin}/fixture?case=edge-run-${runIndex}-tab-${ordinal}`;
        const created = await control.send("Target.createTarget", { url });
        tabIds.push(created.targetId);
        const page = await readyPage(port, created.targetId);
        if (page.timing) {
          run.allTabNavigationDurationMs.push(page.timing.durationMs);
        }
      }
      await delay(options.settleMs);
      run.resources[String(count)] = await processTree(child.pid);
    }
    control.close();
    run.success = true;
  } catch (error) {
    run.error = `${error.stack ?? error.message}\n${log}`;
  } finally {
    await terminate(instance);
    run.finishedAt = new Date().toISOString();
  }
  return run;
}

function aggregate(runs) {
  const successful = runs.filter((run) => run.success);
  const resources = {};
  for (const count of TAB_COUNTS) {
    const samples = successful
      .map((run) => run.resources[String(count)])
      .filter(Boolean);
    resources[String(count)] = {
      processCount: summarize(
        samples.map((sample) => sample.processCount),
        "processes",
      ),
      workingSet: summarize(
        samples.map((sample) => sample.workingSetBytes),
        "bytes",
      ),
      privateMemory: summarize(
        samples.map((sample) => sample.privateBytes),
        "bytes",
      ),
    };
  }
  return {
    successfulRuns: successful.length,
    failedRuns: runs.length - successful.length,
    startupDomReady: summarize(
      successful.map((run) => run.startupDomReadyMs),
      "ms",
    ),
    initialNavigationDuration: summarize(
      successful.map((run) => run.initialNavigationTiming?.durationMs),
      "ms",
    ),
    initialDomContentLoaded: summarize(
      successful.map((run) => run.initialNavigationTiming?.domContentLoadedMs),
      "ms",
    ),
    allTabNavigationDuration: summarize(
      successful.flatMap((run) => run.allTabNavigationDurationMs),
      "ms",
    ),
    resources,
  };
}

function printSummary(report) {
  const metrics = report.aggregates;
  console.log(
    `\nEdge reference (${metrics.successfulRuns}/${report.config.runs} successful runs)`,
  );
  console.log(
    `  launch -> local DOM ready    median ${metrics.startupDomReady.median} ms; p95 ${metrics.startupDomReady.p95}`,
  );
  console.log(
    `  initial Navigation Timing   median ${metrics.initialNavigationDuration.median} ms; p95 ${metrics.initialNavigationDuration.p95}`,
  );
  for (const count of TAB_COUNTS) {
    const item = metrics.resources[String(count)];
    const mib = round(item.workingSet.median / 1024 / 1024, 1);
    console.log(
      `  ${String(count).padStart(2)} loaded tabs              median ${String(mib).padStart(8)} MiB process-tree RSS; p95 ${round(item.workingSet.p95 / 1024 / 1024, 1)} MiB`,
    );
  }
  console.log(
    `\nReport: ${path.join(report.config.output, "performance.json")}`,
  );
  console.log(
    "Warning: this reference is not apples-to-apples with Chromecraft's shell/uBlock configuration.",
  );
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error(
      "The Microsoft Edge reference runner currently supports Windows only.",
    );
  }
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) {
    help();
    return;
  }
  await fs.access(options.edge);
  await fs.mkdir(path.join(options.output, "profiles"), { recursive: true });
  const fixture = await fixtureServer();
  const report = {
    schemaVersion: 1,
    success: false,
    warning:
      "Non-apples-to-apples reference: Edge does not use Chromecraft's Electron shell, uBlock Origin setup, tab model, profile lifecycle, or exact browser configuration.",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    config: {
      edge: options.edge,
      output: options.output,
      runs: options.runs,
      settleMs: options.settleMs,
      tabCounts: TAB_COUNTS,
      profilePolicy: "fresh isolated profile per measured launch",
      loopbackOnlyFixture: true,
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
        "process spawn to document.readyState complete and deterministic fixture marker observed over loopback CDP",
      navigationTiming:
        "Navigation Timing duration from each deterministic no-store loopback page",
      memory:
        "sum of resident working sets across the exact spawned Edge process tree after settling",
    },
    fixture: { origin: fixture.origin, requests: 0 },
    runs: [],
    aggregates: null,
    failures: [],
  };
  const reportPath = path.join(options.output, "performance.json");

  try {
    for (let index = 1; index <= options.runs; index += 1) {
      console.log(`Running Edge reference ${index}/${options.runs}...`);
      const run = await runOnce(options, fixture, index);
      report.runs.push(run);
      if (!run.success) report.failures.push(`run ${index}: ${run.error}`);
      await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    }
    report.aggregates = aggregate(report.runs);
  } finally {
    report.fixture.requests = fixture.requests;
    await fixture.close();
    report.finishedAt = new Date().toISOString();
    report.success = report.failures.length === 0;
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  printSummary(report);
  if (!report.success) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
