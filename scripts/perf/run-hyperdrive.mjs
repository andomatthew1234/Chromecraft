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
const schemaVersion = 1;
const allowedModes = ["off", "balanced", "aggressive", "maximum"];

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function integer(value, name, minimum) {
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
  const known = new Set([
    "platform",
    "modes",
    "runs",
    "fixture-delay-ms",
    "preparation-window-ms",
    "settle-ms",
    "output",
    "executable",
    "app",
    "seed",
    "ublock",
  ]);
  for (const name of values.keys()) {
    if (!known.has(name)) throw new Error(`Unknown option: --${name}`);
  }
  const platform = values.get("platform") ?? process.platform;
  if (platform !== "win32" && platform !== "linux") {
    throw new Error("--platform must be win32 or linux.");
  }
  const modes = (values.get("modes") ?? allowedModes.join(","))
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (
    modes.length === 0 ||
    new Set(modes).size !== modes.length ||
    modes.some((mode) => !allowedModes.includes(mode))
  ) {
    throw new Error(
      "--modes must be a unique comma-separated subset of off,balanced,aggressive,maximum.",
    );
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDirectory = path.resolve(
    values.get("output") ?? path.join(root, ".artifacts", "hyperdrive", stamp),
  );
  const defaultExecutable =
    platform === "win32"
      ? path.join(root, "out", "Chromecraft-win32-x64", "chromecraft.exe")
      : path.join(root, "out", "Chromecraft-linux-x64", "chromecraft");
  const ublock = values.get("ublock") ?? "disabled";
  if (ublock !== "enabled" && ublock !== "disabled") {
    throw new Error("--ublock must be enabled or disabled.");
  }
  return {
    help,
    platform,
    modes,
    runs: integer(values.get("runs") ?? "3", "--runs", 1),
    fixtureDelayMs: integer(
      values.get("fixture-delay-ms") ?? "180",
      "--fixture-delay-ms",
      0,
    ),
    preparationWindowMs: integer(
      values.get("preparation-window-ms") ?? "1000",
      "--preparation-window-ms",
      100,
    ),
    settleMs: integer(values.get("settle-ms") ?? "250", "--settle-ms", 0),
    seed: integer(values.get("seed") ?? "20261015", "--seed", 1),
    outputDirectory,
    executable: path.resolve(values.get("executable") ?? defaultExecutable),
    app: values.has("app") ? path.resolve(values.get("app")) : null,
    ublock,
  };
}

function printHelp() {
  console.log(`Chromecraft Hyperdrive packaged-app benchmark

Usage:
  node scripts/perf/run-hyperdrive.mjs [options]

Options:
  --platform=win32|linux          Packaged target (default: current platform)
  --modes=off,balanced,...        Modes to compare (default: all four)
  --runs=N                        Fresh-profile trials per mode (default: 3)
  --fixture-delay-ms=N            Target document delay (default: 180)
  --preparation-window-ms=N       Equal pointer-to-click window (default: 1000)
  --settle-ms=N                   Post-navigation settle time (default: 250)
  --seed=N                        Deterministic interleaving seed
  --ublock=enabled|disabled       Run with bundled content blocking (default: disabled)
  --executable=PATH               Override packaged executable
  --app=PATH                      App path when launching the raw Electron binary
  --output=PATH                   Output directory

The harness uses a deterministic local HTTP fixture addressed as publisher.test,
trusted CDP pointer input, fresh profiles, server counters, Navigation Timing,
and process-tree samples. It never labels a fetch as prerender or estimates time
saved. Cache reuse requires a completed pre-click fetch, no extra navigation
request, and navigation transferSize=0.`);
}

async function findFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not reserve a loopback port.");
  }
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

function targetHtml(trialId) {
  const body = "Hyperdrive deterministic payload. ".repeat(2_048);
  const query = `trial=${encodeURIComponent(trialId)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Hyperdrive target ${trialId}</title><link rel="stylesheet" href="/assets/site.css?${query}"><script defer src="/assets/app.js?${query}"></script></head><body><main><h1 id="ready">Target ready</h1><img src="/assets/hero.svg?${query}" width="640" height="240" alt="Deterministic landscape"><p>${body}</p></main></body></html>`;
}

function startHtml(origin, trialId) {
  const destination = `${origin}/target?trial=${encodeURIComponent(trialId)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Hyperdrive start ${trialId}</title><style>body{margin:0;font:16px system-ui;background:#f5f7f2}main{min-height:100vh;display:flex;gap:24px;align-items:center;justify-content:center}a{display:inline-flex;padding:24px 34px;border-radius:28px;background:#d7f2ce;color:#163815;font-weight:700;text-decoration:none}.secondary{background:#e7e9e4}</style></head><body><main><a class="secondary" href="/other-a?trial=${encodeURIComponent(trialId)}">Other page</a><a id="destination" href="${destination}">Open deterministic target</a><a class="secondary" href="/other-b?trial=${encodeURIComponent(trialId)}">Another page</a></main></body></html>`;
}

async function startFixture(delayMs) {
  const trials = new Map();
  let origin;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://publisher.test");
    const trialId = url.searchParams.get("trial") ?? "unknown";
    const trial = trials.get(trialId) ?? {
      targetRequests: 0,
      targetCompletions: 0,
      targetBytes: 0,
      firstTargetStartedAt: null,
      firstTargetCompletedAt: null,
      resourceRequests: 0,
      resourceBytes: 0,
    };
    trials.set(trialId, trial);
    if (url.pathname === "/start") {
      const body = startHtml(origin, trialId);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }
    if (url.pathname === "/target") {
      trial.targetRequests += 1;
      trial.firstTargetStartedAt ??= performance.now();
      if (delayMs > 0) await delay(delayMs);
      const body = targetHtml(trialId);
      const bytes = Buffer.byteLength(body);
      trial.targetBytes += bytes;
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=300",
        "content-length": bytes,
      });
      response.end(body, () => {
        trial.targetCompletions += 1;
        trial.firstTargetCompletedAt ??= performance.now();
      });
      return;
    }
    if (url.pathname.startsWith("/assets/")) {
      trial.resourceRequests += 1;
      if (delayMs > 0) await delay(Math.min(45, Math.ceil(delayMs / 4)));
      const asset =
        url.pathname === "/assets/site.css"
          ? {
              type: "text/css; charset=utf-8",
              body: "body{margin:0;background:#f5f7f2;color:#1a1c19;font:16px system-ui}main{max-width:72rem;margin:auto;padding:3rem}img{display:block;max-width:100%;border-radius:24px}#ready{color:#315d28}",
            }
          : url.pathname === "/assets/app.js"
            ? {
                type: "text/javascript; charset=utf-8",
                body: "addEventListener('load',()=>requestAnimationFrame(()=>requestAnimationFrame(()=>{document.documentElement.dataset.hyperdriveReady='true'})),{once:true});",
              }
            : {
                type: "image/svg+xml",
                body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240"><rect width="640" height="240" fill="#d7f2ce"/><path d="M0 190L160 70l110 90 100-80 270 110v50H0z" fill="#315d28"/></svg>',
              };
      const bytes = Buffer.byteLength(asset.body);
      trial.resourceBytes += bytes;
      response.writeHead(200, {
        "content-type": asset.type,
        "cache-control": "public, max-age=300",
        "content-length": bytes,
      });
      response.end(asset.body);
      return;
    }
    if (url.pathname === "/other-a" || url.pathname === "/other-b") {
      const body =
        "<!doctype html><title>Other page</title><p>Not selected.</p>";
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not start fixture server.");
  }
  origin = `http://publisher.test:${address.port}`;
  return {
    origin,
    snapshot(trialId) {
      return {
        targetRequests: 0,
        targetCompletions: 0,
        targetBytes: 0,
        firstTargetStartedAt: null,
        firstTargetCompletedAt: null,
        resourceRequests: 0,
        resourceBytes: 0,
        ...(trials.get(trialId) ?? {}),
      };
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
    WebSocketClass = (await import("ws")).WebSocket;
  }
  return WebSocketClass;
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("close", () => this.rejectAll("CDP closed."));
    socket.addEventListener("error", () => this.rejectAll("CDP failed."));
  }

  static async connect(url) {
    const WebSocket = await websocketClass();
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("CDP timed out.")),
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
          reject(new Error("CDP connection failed."));
        },
        { once: true },
      );
    });
    return new CdpClient(socket);
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
    try {
      this.socket.close();
    } catch {
      // The browser may already have closed it.
    }
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}.`);
  return response.json();
}

async function poll(operation, predicate, description, timeoutMs = 15_000) {
  const startedAt = performance.now();
  let lastValue;
  let lastError;
  while (performance.now() - startedAt < timeoutMs) {
    try {
      lastValue = await operation();
      if (predicate(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await delay(20);
  }
  throw new Error(
    `Timed out waiting for ${description}. ${lastError?.message ?? JSON.stringify(lastValue)}`,
  );
}

async function targetList(port) {
  return fetchJson(`http://127.0.0.1:${port}/json/list`);
}

async function waitForTarget(port, predicate, description) {
  return poll(
    () => targetList(port),
    (targets) => targets.find(predicate),
    description,
    30_000,
  ).then((targets) => targets.find(predicate));
}

async function terminate(child) {
  if (child.exitCode !== null || !child.pid) return;
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

async function launch(options, fixture, profile, mode) {
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(
    path.join(profile, "preferences.json"),
    `${JSON.stringify(
      {
        ublockEnabled: options.ublock === "enabled",
        restoreSession: false,
        hyperdriveMode: mode,
        hyperdriveRamBudgetMb: 256,
        hyperdriveCrossSitePreloadingEnabled: false,
        hyperdriveSearchPreloadingEnabled: false,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const port = await findFreePort();
  const child = spawn(
    options.executable,
    [
      ...(options.app ? [options.app] : []),
      `--chromecraft-user-data=${profile}`,
      `--user-data-dir=${profile}`,
      `--chromecraft-smoke-url=${fixture.origin}/start?trial=bootstrap`,
      `--remote-debugging-port=${port}`,
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
  try {
    const shellTarget = await waitForTarget(
      port,
      (target) =>
        target.type === "page" &&
        !target.url.startsWith("chrome-extension://") &&
        (target.url.startsWith("file://") ||
          target.url.includes("main_window")),
      "Chromecraft shell target",
    );
    const shell = await CdpClient.connect(shellTarget.webSocketDebuggerUrl);
    await poll(
      () =>
        shell.evaluate(`(async () => {
          if (!window.chromecraft) return null;
          const browser = await window.chromecraft.getSnapshot();
          const hyperdrive = await window.chromecraft.getHyperdriveSnapshot();
          return { browser, hyperdrive };
        })()`),
      (value) => {
        const browserReady = Boolean(
          value?.browser?.activeTabId && value?.hyperdrive?.mode === mode,
        );
        return options.ublock === "enabled"
          ? browserReady &&
              value?.browser?.ublock?.enabled === true &&
              value?.browser?.ublock?.ready === true
          : browserReady;
      },
      `Hyperdrive ${mode} startup`,
      20_000,
    );
    return {
      child,
      port,
      shell,
      get log() {
        return log;
      },
    };
  } catch (error) {
    await terminate(child);
    throw new Error(`${error.message}\n${log}`);
  }
}

async function windowsProcessSnapshot(rootPid) {
  const script = `
$ErrorActionPreference = 'Stop'
$rootPid = ${rootPid}
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
$wanted = [System.Collections.Generic.HashSet[int]]::new()
[void]$wanted.Add($rootPid)
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($row in $all) {
    if ($wanted.Contains([int]$row.ParentProcessId) -and -not $wanted.Contains([int]$row.ProcessId)) {
      [void]$wanted.Add([int]$row.ProcessId); $changed = $true
    }
  }
}
$result = @()
foreach ($processId in $wanted) {
  $p = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -ne $p) {
    $result += [PSCustomObject]@{ pid=[int]$p.Id; cpuSeconds=if($null -eq $p.CPU){0}else{[double]$p.CPU}; workingSetBytes=[long]$p.WorkingSet64; privateBytes=[long]$p.PrivateMemorySize64 }
  }
}
ConvertTo-Json -InputObject @($result) -Compress`;
  const { stdout } = await execFile(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout.trim() || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

let clockTicks;
async function linuxProcessSnapshot(rootPid) {
  if (!clockTicks) {
    clockTicks = Number.parseInt(
      (await execFile("getconf", ["CLK_TCK"])).stdout,
    );
  }
  const rows = [];
  const entries = await fs.readdir("/proc", { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        const pid = Number(entry.name);
        try {
          const [stat, status] = await Promise.all([
            fs.readFile(`/proc/${pid}/stat`, "utf8"),
            fs.readFile(`/proc/${pid}/status`, "utf8"),
          ]);
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
          rows.push({
            pid,
            parentPid: Number(fields[1]),
            cpuSeconds: (Number(fields[11]) + Number(fields[12])) / clockTicks,
            workingSetBytes:
              Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] ?? 0) * 1024,
            privateBytes: null,
          });
        } catch {
          // Processes may exit while /proc is sampled.
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
  const rows =
    process.platform === "win32"
      ? await windowsProcessSnapshot(rootPid)
      : await linuxProcessSnapshot(rootPid);
  return {
    processCount: rows.length,
    workingSetBytes: rows.reduce(
      (sum, row) => sum + Number(row.workingSetBytes ?? 0),
      0,
    ),
    privateBytes: rows.some((row) => row.privateBytes === null)
      ? null
      : rows.reduce((sum, row) => sum + Number(row.privateBytes ?? 0), 0),
    cpuSeconds: rows.reduce((sum, row) => sum + Number(row.cpuSeconds ?? 0), 0),
  };
}

function navigationTimingExpression() {
  return `(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    const paint = performance.getEntriesByName('first-contentful-paint')[0];
    return {
      href: location.href,
      ready: document.documentElement.dataset.hyperdriveReady === 'true',
      responseStartMs: navigation?.responseStart ?? null,
      domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
      durationMs: navigation?.duration ?? null,
      transferSize: navigation?.transferSize ?? null,
      encodedBodySize: navigation?.encodedBodySize ?? null,
      activationStart: navigation?.activationStart ?? null,
      firstContentfulPaintMs: paint?.startTime ?? null
    };
  })()`;
}

async function runTrial(options, fixture, mode, ordinal) {
  const trialId = `${mode}-${ordinal}-${Date.now()}`;
  const profileRoot = path.resolve(
    os.tmpdir(),
    "chromecraft-hyperdrive-profiles",
  );
  const profile = path.resolve(profileRoot, trialId);
  if (!profile.startsWith(`${profileRoot}${path.sep}`)) {
    throw new Error("Benchmark profile escaped its temporary root.");
  }
  const logPath = path.join(options.outputDirectory, "logs", `${trialId}.log`);
  let browser;
  let page;
  try {
    browser = await launch(options, fixture, profile, mode);
    const browserState = await browser.shell.evaluate(
      "window.chromecraft.getSnapshot()",
    );
    const tabId = browserState.activeTabId;
    const startUrl = `${fixture.origin}/start?trial=${encodeURIComponent(trialId)}`;
    const targetUrl = `${fixture.origin}/target?trial=${encodeURIComponent(trialId)}`;
    await browser.shell.evaluate(
      `window.chromecraft.navigate(${JSON.stringify(tabId)}, ${JSON.stringify(startUrl)})`,
    );
    const pageTarget = await waitForTarget(
      browser.port,
      (target) => target.type === "page" && target.url === startUrl,
      "fixture start page",
    );
    page = await CdpClient.connect(pageTarget.webSocketDebuggerUrl);
    await page.send("Runtime.enable");
    await page.send("Page.enable");
    const rect = await poll(
      () =>
        page.evaluate(`(() => {
          const rect = document.querySelector('#destination')?.getBoundingClientRect();
          return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
        })()`),
      (value) => Boolean(value?.width),
      "fixture link geometry",
    );
    const beforeResources = await processSnapshot(browser.child.pid);
    const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    const pointerStartedAt = performance.now();
    for (const fraction of [0, 0.3, 0.6, 0.82, 1]) {
      await page.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 12 + (center.x - 12) * fraction,
        y: 12 + (center.y - 12) * fraction,
        button: "none",
        pointerType: "mouse",
      });
      await delay(55);
    }

    let prefetchCompletedBeforeClick = false;
    const waitUntilClick = Math.max(
      0,
      options.preparationWindowMs - (performance.now() - pointerStartedAt),
    );
    if (mode !== "off") {
      try {
        await poll(
          () => fixture.snapshot(trialId),
          (snapshot) => snapshot.targetCompletions > 0,
          "a completed speculative target request",
          waitUntilClick,
        );
        prefetchCompletedBeforeClick = true;
      } catch {
        // A mode may legitimately decide this candidate is below its threshold.
      }
    }
    const remainingBeforeClick = Math.max(
      0,
      options.preparationWindowMs - (performance.now() - pointerStartedAt),
    );
    if (remainingBeforeClick > 0) await delay(remainingBeforeClick);
    const beforeClickFixture = fixture.snapshot(trialId);
    const hyperdriveBeforeClick = await browser.shell.evaluate(
      "window.chromecraft.getHyperdriveSnapshot()",
    );
    const clickedAt = performance.now();
    await page.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: center.x,
      y: center.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
      pointerType: "mouse",
    });
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: center.x,
      y: center.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
      pointerType: "mouse",
    });
    let timing = await poll(
      () => page.evaluate(navigationTimingExpression()),
      (value) => value?.href === targetUrl && value.ready,
      "the clicked target to become usable",
      20_000,
    );
    const clickToUsableMs = performance.now() - clickedAt;
    await delay(options.settleMs);
    const settledTiming = await page.evaluate(navigationTimingExpression());
    if (settledTiming?.href === targetUrl && settledTiming.ready) {
      timing = settledTiming;
    }
    const afterFixture = fixture.snapshot(trialId);
    const hyperdriveAfter = await browser.shell.evaluate(
      "window.chromecraft.getHyperdriveSnapshot()",
    );
    const afterResources = await processSnapshot(browser.child.pid);
    const reuseProven = Boolean(
      prefetchCompletedBeforeClick &&
      beforeClickFixture.targetRequests === 1 &&
      afterFixture.targetRequests === beforeClickFixture.targetRequests &&
      timing.transferSize === 0,
    );
    const acceptanceFailures = [];
    if (mode === "off") {
      if (beforeClickFixture.targetRequests !== 0)
        acceptanceFailures.push(
          "Off mode made a speculative document request.",
        );
      if (afterFixture.targetRequests !== 1)
        acceptanceFailures.push(
          "Off mode did not perform exactly one navigation request.",
        );
      if (timing.transferSize === 0)
        acceptanceFailures.push(
          "Off mode unexpectedly reported a zero-transfer navigation.",
        );
    } else {
      if (!prefetchCompletedBeforeClick)
        acceptanceFailures.push(
          "Document prefetch did not complete before click.",
        );
      if (beforeClickFixture.targetRequests !== 1)
        acceptanceFailures.push(
          "Expected exactly one pre-click document request.",
        );
      if (afterFixture.targetRequests !== 1)
        acceptanceFailures.push(
          "Navigation issued a duplicate document request.",
        );
      if (timing.transferSize !== 0)
        acceptanceFailures.push(
          "Navigation did not report HTTP-cache delivery.",
        );
      if (timing.activationStart !== 0)
        acceptanceFailures.push(
          "Unexpected prerender activation was reported.",
        );
      if (hyperdriveAfter.metrics.cacheReuseSuccesses < 1)
        acceptanceFailures.push(
          "Controller did not record cache reuse evidence.",
        );
      if (
        !hyperdriveAfter.destinations.some(
          (destination) =>
            destination.state === "cache-reused" && destination.reused === true,
        )
      )
        acceptanceFailures.push(
          "Destination did not reach cache-reused state.",
        );
    }
    const reusedDocumentBytes = reuseProven
      ? Number(timing.encodedBodySize ?? 0)
      : 0;
    return {
      success: true,
      accepted: acceptanceFailures.length === 0,
      acceptanceFailures,
      trialId,
      mode,
      pointerToClickMs: round(clickedAt - pointerStartedAt),
      clickToUsableMs: round(clickToUsableMs),
      fixture: {
        targetRequestsBeforeClick: beforeClickFixture.targetRequests,
        targetRequestsAfterNavigation: afterFixture.targetRequests,
        targetCompletionsBeforeClick: beforeClickFixture.targetCompletions,
        totalTargetBytes: afterFixture.targetBytes,
        resourceRequests: afterFixture.resourceRequests,
        resourceBytes: afterFixture.resourceBytes,
        speculativeBytes: beforeClickFixture.targetBytes,
        wastedSpeculativeBytes: Math.max(
          0,
          beforeClickFixture.targetBytes - reusedDocumentBytes,
        ),
      },
      prefetchCompletedBeforeClick,
      reuseProven,
      navigationTiming: timing,
      hyperdriveBeforeClick,
      hyperdriveAfter,
      processResources: {
        before: beforeResources,
        after: afterResources,
        workingSetDeltaBytes:
          afterResources.workingSetBytes - beforeResources.workingSetBytes,
        privateBytesDelta:
          afterResources.privateBytes === null ||
          beforeResources.privateBytes === null
            ? null
            : afterResources.privateBytes - beforeResources.privateBytes,
        cpuSeconds: round(
          Math.max(0, afterResources.cpuSeconds - beforeResources.cpuSeconds),
          6,
        ),
      },
    };
  } catch (error) {
    return {
      success: false,
      trialId,
      mode,
      error: error.stack ?? error.message,
    };
  } finally {
    page?.close();
    if (browser) {
      await fs.writeFile(logPath, browser.log, "utf8");
      browser.shell.close();
      await terminate(browser.child);
    }
    await fs
      .rm(profile, { recursive: true, force: true })
      .catch(() => undefined);
  }
}

function seededShuffle(values, seed) {
  let state = seed >>> 0;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  return shuffled;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? round(sorted[middle])
    : round((sorted[middle - 1] + sorted[middle]) / 2);
}

function aggregate(trials, mode) {
  const successful = trials.filter(
    (trial) => trial.success && trial.mode === mode,
  );
  return {
    attempted: trials.filter((trial) => trial.mode === mode).length,
    successful: successful.length,
    accepted: successful.filter((trial) => trial.accepted).length,
    provenReuseCount: successful.filter((trial) => trial.reuseProven).length,
    completedPrefetchCount: successful.filter(
      (trial) => trial.prefetchCompletedBeforeClick,
    ).length,
    clickToUsableMedianMs: median(
      successful.map((trial) => trial.clickToUsableMs),
    ),
    navigationDurationMedianMs: median(
      successful.map((trial) => trial.navigationTiming.durationMs),
    ),
    transferSizeMedianBytes: median(
      successful.map((trial) => trial.navigationTiming.transferSize),
    ),
    speculativeBytesMedian: median(
      successful.map((trial) => trial.fixture.speculativeBytes),
    ),
    wastedSpeculativeBytesMedian: median(
      successful.map((trial) => trial.fixture.wastedSpeculativeBytes),
    ),
    processWorkingSetDeltaMedianBytes: median(
      successful.map((trial) => trial.processResources.workingSetDeltaBytes),
    ),
    operationCpuMedianSeconds: median(
      successful.map((trial) => trial.processResources.cpuSeconds),
    ),
    rankingTimeMedianMs: median(
      successful.map(
        (trial) => trial.hyperdriveBeforeClick.metrics.rankingTimeMs,
      ),
    ),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  await fs.access(options.executable);
  await fs.mkdir(path.join(options.outputDirectory, "logs"), {
    recursive: true,
  });
  await fs.mkdir(path.join(options.outputDirectory, "profiles"), {
    recursive: true,
  });
  const fixture = await startFixture(options.fixtureDelayMs);
  const schedule = seededShuffle(
    Array.from({ length: options.runs }, () => options.modes).flat(),
    options.seed,
  );
  const report = {
    schemaVersion,
    success: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    config: {
      ...options,
      help: undefined,
      outputDirectory: options.outputDirectory,
      executable: options.executable,
      app: options.app,
      schedule,
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
      fixture:
        "Deterministic publisher.test HTTP document served from loopback with a configurable response delay and cacheable target.",
      isolation: `Every trial launches the ${options.app ? "development Electron app" : "packaged app"} with a fresh profile; mode order is deterministically interleaved.`,
      pointer: `Chrome DevTools Protocol Input.dispatchMouseEvent supplies trusted movement, hover and click input to the actual tab renderer; every mode receives the same ${options.preparationWindowMs} ms pointer-to-click preparation window.`,
      reuseProof:
        "Reuse is true only when a target fetch completed before click, navigation added no target request, and navigation transferSize was zero. Duplicate speculative requests remain visible and their redundant bytes count as wasted.",
      readiness:
        "Prefetched means document bytes completed. The harness never reports Ready or prerender activation; activationStart is recorded as evidence.",
      memory:
        "Resident/private bytes are external process-tree observations. Hyperdrive per-destination memory remains an estimate.",
      cpu: "CPU seconds are the process-tree delta from immediately before pointer movement through post-navigation settle; they are not an idle CPU percentage.",
      timeSaved:
        "Not calculated. Raw mode distributions are reported; no counterfactual per-navigation saving is invented.",
    },
    trials: [],
    aggregates: {},
    failures: [],
  };
  const reportPath = path.join(options.outputDirectory, "hyperdrive.json");
  try {
    const modeOrdinals = new Map();
    for (const mode of schedule) {
      const ordinal = (modeOrdinals.get(mode) ?? 0) + 1;
      modeOrdinals.set(mode, ordinal);
      console.log(
        `Running Hyperdrive ${mode} trial ${ordinal}/${options.runs}...`,
      );
      const trial = await runTrial(options, fixture, mode, ordinal);
      report.trials.push(trial);
      if (!trial.success)
        report.failures.push(`${mode} ${ordinal}: ${trial.error}`);
      else if (!trial.accepted)
        report.failures.push(
          `${mode} ${ordinal}: ${trial.acceptanceFailures.join(" ")}`,
        );
      await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    }
    for (const mode of options.modes) {
      report.aggregates[mode] = aggregate(report.trials, mode);
    }
  } finally {
    await fixture.close();
    report.finishedAt = new Date().toISOString();
    report.success = report.failures.length === 0;
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(`\nHyperdrive report: ${reportPath}`);
  for (const [mode, result] of Object.entries(report.aggregates)) {
    console.log(
      `${mode.padEnd(10)} click-to-usable median ${String(result.clickToUsableMedianMs).padStart(8)} ms; proven reuse ${result.provenReuseCount}/${result.successful}`,
    );
  }
  if (!report.success) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
