import { execFile as execFileCallback, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = process.cwd();
const executable = path.join(
  root,
  "out",
  "Chromecraft-win32-x64",
  "chromecraft.exe",
);
const outputDirectory = path.join(
  root,
  ".artifacts",
  "hyperdrive",
  "google-wikipedia-trace",
);
const profileRoot = path.resolve(
  os.tmpdir(),
  "chromecraft-google-hyperdrive-trace",
);
const profile = path.resolve(profileRoot, `profile-${Date.now()}`);
const reportPath = path.join(outputDirectory, "trace.json");
const searchUrl = "https://www.google.com/search?q=Hello+Wikipedia&hl=en";

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
  if (!address || typeof address === "string") {
    throw new Error("Could not reserve a CDP port.");
  }
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}.`);
  return response.json();
}

async function poll(operation, predicate, description, timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs;
  let lastValue;
  let lastError;
  while (performance.now() < deadline) {
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
    this.events = [];
    socket.addEventListener("message", (event) => this.onMessage(event.data));
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new CdpClient(socket);
  }

  onMessage(data) {
    const message = JSON.parse(
      typeof data === "string" ? data : data.toString(),
    );
    if (!message.id) {
      this.events.push(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  send(method, params = {}, timeoutMs = 20_000) {
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
    this.socket.close();
  }
}

async function waitForTarget(port, predicate, description) {
  const targets = await poll(
    () => fetchJson(`http://127.0.0.1:${port}/json/list`),
    (items) => items.some(predicate),
    description,
  );
  return targets.find(predicate);
}

async function terminate(child) {
  if (child.exitCode !== null || !child.pid) return;
  await execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    windowsHide: true,
  }).catch(() => child.kill());
}

function publicHeaders(headers) {
  const allowed = new Set([
    "age",
    "cache-control",
    "content-type",
    "date",
    "etag",
    "expires",
    "last-modified",
    "location",
    "vary",
  ]);
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) =>
      allowed.has(name.toLowerCase()),
    ),
  );
}

function redactDiagnosticText(value) {
  return String(value ?? "")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<REDACTED-IP>")
    .replace(/([?&][a-z0-9_-]+=)[^&\s\"]+/gi, "$1<REDACTED>");
}

function publicDiagnosticUrl(value) {
  try {
    const url = new URL(value);
    if (url.pathname.startsWith("/sorry/"))
      return `${url.origin}${url.pathname}`;
    return redactDiagnosticText(url.href);
  } catch {
    return redactDiagnosticText(value);
  }
}

function sanitizeObservedPage(page) {
  if (!page) return null;
  return {
    href: publicDiagnosticUrl(page.href),
    title: redactDiagnosticText(page.title),
    text: redactDiagnosticText(page.text),
    links: (page.links ?? []).map((link) => ({
      href: publicDiagnosticUrl(link.href),
      text: redactDiagnosticText(link.text),
    })),
  };
}

function documentNetworkEvents(events) {
  return events
    .filter(
      (event) =>
        (event.method === "Network.requestWillBeSent" ||
          event.method === "Network.responseReceived") &&
        event.params?.type === "Document",
    )
    .map((event) => {
      if (event.method === "Network.requestWillBeSent") {
        return {
          event: "request",
          requestId: event.params.requestId,
          url: event.params.request?.url,
          redirectFrom: event.params.redirectResponse?.url ?? null,
          redirectStatus: event.params.redirectResponse?.status ?? null,
        };
      }
      return {
        event: "response",
        requestId: event.params.requestId,
        url: event.params.response?.url,
        status: event.params.response?.status,
        fromDiskCache: event.params.response?.fromDiskCache ?? false,
        fromPrefetchCache: event.params.response?.fromPrefetchCache ?? false,
        headers: publicHeaders(event.params.response?.headers),
      };
    });
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error(
      "This trace script currently launches the Windows package.",
    );
  }
  if (!profile.startsWith(`${profileRoot}${path.sep}`)) {
    throw new Error("Trace profile escaped its temporary root.");
  }
  await fs.access(executable);
  await fs.mkdir(profile, { recursive: true });
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(
    path.join(profile, "preferences.json"),
    `${JSON.stringify(
      {
        ublockEnabled: true,
        restoreSession: false,
        hyperdriveMode: "balanced",
        hyperdriveRamBudgetMb: 256,
        hyperdriveCrossSitePreloadingEnabled: true,
        hyperdriveSearchPreloadingEnabled: false,
        hyperdriveMonitorOpen: true,
      },
      null,
      2,
    )}\n`,
  );
  const port = await findFreePort();
  const child = spawn(
    executable,
    [
      `--chromecraft-user-data=${profile}`,
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
    ],
    { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk.toString()));
  child.stderr.on("data", (chunk) => (log += chunk.toString()));
  let shell;
  let page;
  const report = {
    success: false,
    searchUrl,
    result: null,
    beforeClick: null,
    afterNavigation: null,
    navigation: null,
    documentNetworkEvents: [],
    observedPage: null,
    limitation: null,
    error: null,
  };
  try {
    const shellTarget = await waitForTarget(
      port,
      (target) =>
        target.type === "page" &&
        !target.url.startsWith("chrome-extension://") &&
        (target.url.startsWith("file://") ||
          target.url.includes("main_window")),
      "Chromecraft shell",
    );
    shell = await CdpClient.connect(shellTarget.webSocketDebuggerUrl);
    const startup = await poll(
      () =>
        shell.evaluate(`(async () => {
          if (!window.chromecraft) return null;
          return {
            browser: await window.chromecraft.getSnapshot(),
            hyperdrive: await window.chromecraft.getHyperdriveSnapshot()
          };
        })()`),
      (value) =>
        value?.browser?.activeTabId &&
        value?.browser?.ublock?.ready === true &&
        value?.hyperdrive?.mode === "balanced",
      "Chromecraft, uBlock and Hyperdrive startup",
      30_000,
    );
    const tabId = startup.browser.activeTabId;
    await shell.evaluate(
      `window.chromecraft.navigate(${JSON.stringify(tabId)}, ${JSON.stringify(searchUrl)})`,
    );
    const pageTarget = await waitForTarget(
      port,
      (target) => target.type === "page" && target.url.includes("google.com/"),
      "Google results tab",
    );
    page = await CdpClient.connect(pageTarget.webSocketDebuggerUrl);
    await page.send("Runtime.enable");
    await page.send("Page.enable");
    await page.send("Network.enable");
    const result = await poll(
      () =>
        page.evaluate(`(() => {
          const links = [...document.querySelectorAll('a[href]')];
          for (const anchor of links) {
            let url;
            try { url = new URL(anchor.href, location.href); } catch { continue; }
            const wrapped = url.searchParams.get('url') || url.searchParams.get('q');
            let destination = url;
            if (url.pathname === '/url' && wrapped) {
              try { destination = new URL(wrapped); } catch {}
            }
            if (!/(^|\\.)wikipedia\\.org$/i.test(destination.hostname)) continue;
            const rect = anchor.getBoundingClientRect();
            if (rect.width < 8 || rect.height < 8) continue;
            return {
              href: anchor.href,
              destination: destination.href,
              title: anchor.textContent?.replace(/\\s+/g, ' ').trim() || anchor.getAttribute('aria-label'),
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            };
          }
          return null;
        })()`),
      Boolean,
      "a visible Wikipedia Google result",
      20_000,
    );
    report.result = result;
    const center = {
      x: result.rect.x + result.rect.width / 2,
      y: result.rect.y + result.rect.height / 2,
    };
    for (const fraction of [0, 0.35, 0.7, 1]) {
      await page.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 12 + (center.x - 12) * fraction,
        y: 12 + (center.y - 12) * fraction,
        button: "none",
        pointerType: "mouse",
      });
      await delay(80);
    }
    report.beforeClick = await poll(
      () => shell.evaluate("window.chromecraft.getHyperdriveSnapshot()"),
      (snapshot) =>
        snapshot?.destinations?.some(
          (destination) =>
            destination.host.endsWith("wikipedia.org") &&
            ["prefetched", "blocked", "failed", "deduplicated"].includes(
              destination.state,
            ),
        ),
      "Hyperdrive preparation outcome",
      15_000,
    );
    const prepared = report.beforeClick.destinations.find((destination) =>
      destination.host.endsWith("wikipedia.org"),
    );
    if (prepared?.state !== "prefetched") {
      report.limitation = `Google result preparation ended in ${prepared?.state ?? "no state"}: ${prepared?.reason ?? "no reason"}`;
      return;
    }
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
    report.navigation = await poll(
      () =>
        page.evaluate(`(() => {
          const navigation = performance.getEntriesByType('navigation')[0];
          const paint = performance.getEntriesByName('first-contentful-paint')[0];
          return {
            href: location.href,
            readyState: document.readyState,
            transferSize: navigation?.transferSize ?? null,
            encodedBodySize: navigation?.encodedBodySize ?? null,
            responseStartMs: navigation?.responseStart ?? null,
            domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
            durationMs: navigation?.duration ?? null,
            firstContentfulPaintMs: paint?.startTime ?? null
          };
        })()`),
      (value) =>
        value?.readyState === "complete" &&
        /(^|\.)wikipedia\.org$/i.test(new URL(value.href).hostname),
      "Wikipedia navigation completion",
      30_000,
    );
    report.navigation.clickToLoadMs = performance.now() - clickedAt;
    report.afterNavigation = await shell.evaluate(
      "window.chromecraft.getHyperdriveSnapshot()",
    );
    report.documentNetworkEvents = documentNetworkEvents(page.events);
    report.success = true;
  } catch (error) {
    report.error = error.stack ?? error.message;
    const observedPage = await page
      ?.evaluate(
        `(() => ({
        href: location.href,
        title: document.title,
        text: document.body?.innerText?.slice(0, 1200) ?? '',
        links: [...document.querySelectorAll('a[href]')].slice(0, 30).map((anchor) => ({
          href: anchor.href,
          text: anchor.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 160) ?? ''
        }))
      }))()`,
      )
      .catch(() => null);
    report.observedPage = sanitizeObservedPage(observedPage);
    report.limitation ??=
      "Public Google results are variable and may present consent, bot checks, or different result markup.";
  } finally {
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    page?.close();
    shell?.close();
    await terminate(child);
    await fs
      .rm(profile, { recursive: true, force: true })
      .catch(() => undefined);
  }
  console.log(JSON.stringify({ reportPath, ...report }, null, 2));
  if (!report.success) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
