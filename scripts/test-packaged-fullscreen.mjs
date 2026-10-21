import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const platform =
  process.argv
    .find((value) => value.startsWith("--platform="))
    ?.slice("--platform=".length) ?? process.platform;
const root = process.cwd();
const executable = path.resolve(
  process.env.CHROMECRAFT_EXECUTABLE ??
    path.join(
      root,
      "out",
      platform === "win32" ? "chromecraft-win32-x64" : "chromecraft-linux-x64",
      platform === "win32" ? "chromecraft.exe" : "chromecraft",
    ),
);
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "chromecraft-fullscreen-test-"),
);

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not start a fullscreen fixture server.");
  return address.port;
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data.toString());
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
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function poll(operation, predicate, description, timeoutMs = 12_000) {
  const startedAt = Date.now();
  let last;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      last = await operation();
      if (predicate(last)) return last;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(`Timed out waiting for ${description}: ${String(last)}`);
}

async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return response.json();
}

async function trustedClick(cdp, selector) {
  const point = await poll(
    () =>
      cdp.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`),
    Boolean,
    `fixture control ${selector}`,
  );
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

async function pressKey(cdp, key, code = key) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key,
    code,
    windowsVirtualKeyCode: key === "Escape" ? 27 : 122,
    nativeVirtualKeyCode: key === "Escape" ? 27 : 122,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: key === "Escape" ? 27 : 122,
    nativeVirtualKeyCode: key === "Escape" ? 27 : 122,
  });
}

async function stop(child) {
  if (!child?.pid || child.exitCode !== null) return;
  child.kill(platform === "win32" ? undefined : "SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode !== null) return;
  if (platform !== "win32") {
    child.kill("SIGKILL");
    return;
  }
  const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
  await new Promise((resolve) => killer.once("exit", resolve));
}

let framePort = 0;
const frameServer = http.createServer((_request, response) => {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "permissions-policy": "fullscreen=*",
  });
  response.end(`<!doctype html><html><body style="margin:0"><button id="frame-fullscreen" style="width:100vw;height:100vh">Frame fullscreen</button><script>
    document.querySelector('#frame-fullscreen').addEventListener('click', () => document.documentElement.requestFullscreen());
  </script></body></html>`);
});
framePort = await listen(frameServer);

const mainServer = http.createServer((_request, response) => {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "permissions-policy": "fullscreen=*, pointer-lock=*, screen-wake-lock=*",
  });
  response.end(`<!doctype html><html><head><title>Fullscreen fixture</title><style>
    body { font: 16px system-ui; margin: 24px; } button { width: 220px; height: 60px; margin: 8px; }
    iframe { display:block; width:320px; height:120px; margin:8px; border:2px solid #555; }
  </style></head><body>
    <button id="page-fullscreen">Page fullscreen</button>
    <button id="pointer-lock">Pointer lock</button>
    <button id="keyboard-lock">Keyboard lock</button>
    <button id="wake-lock">Wake lock</button>
    <iframe id="opaque-frame" sandbox="allow-scripts" allow="fullscreen" src="http://127.0.0.1:${framePort}/frame"></iframe>
    <script>
      document.addEventListener('click', (event) => { document.body.dataset.lastClicked = event.target.id; }, true);
      document.querySelector('#page-fullscreen').addEventListener('click', async (event) => {
        document.body.dataset.pageClickTrusted = String(event.isTrusted);
        document.body.dataset.userActivation = String(navigator.userActivation?.isActive);
        try {
          await document.documentElement.requestFullscreen();
          document.body.dataset.fullscreenResult = 'granted';
        } catch (error) { document.body.dataset.fullscreenResult = error.name + ': ' + error.message; }
      });
      document.querySelector('#pointer-lock').addEventListener('click', (event) => {
        document.body.dataset.pointerClickTrusted = String(event.isTrusted);
        document.body.requestPointerLock();
      });
      document.querySelector('#keyboard-lock').addEventListener('click', async () => {
        if (!navigator.keyboard?.lock) { document.body.dataset.keyboardLock = 'unsupported'; return; }
        try {
          await document.documentElement.requestFullscreen();
          await navigator.keyboard.lock(['KeyW']);
          document.body.dataset.keyboardLock = 'granted';
        } catch (error) { document.body.dataset.keyboardLock = error.name; }
      });
      document.querySelector('#wake-lock').addEventListener('click', async (event) => {
        document.body.dataset.wakeClickTrusted = String(event.isTrusted);
        document.body.dataset.wakeLock = 'pending';
        try { window.wakeLock = await navigator.wakeLock.request('screen'); document.body.dataset.wakeLock = 'granted'; }
        catch (error) { document.body.dataset.wakeLock = error.name; }
      });
    </script>
  </body></html>`);
});
const mainPort = await listen(mainServer);
const fixtureUrl = `http://127.0.0.1:${mainPort}/main`;

await fs.access(executable);
const debugPort = await freePort();
const child = spawn(
  executable,
  [
    `--chromecraft-user-data=${profile}`,
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    "--remote-debugging-address=127.0.0.1",
    "--chromecraft-smoke-allow-site-permissions",
    "--no-first-run",
  ],
  { cwd: root, stdio: "ignore" },
);

let shell;
let page;
let stage = "connect to the browser shell";
try {
  const shellTarget = await poll(
    () => targets(debugPort),
    (entries) =>
      entries.find(
        (entry) =>
          entry.type === "page" &&
          entry.webSocketDebuggerUrl &&
          entry.url.startsWith("file:"),
      ),
    "the Chromecraft shell target",
    20_000,
  ).then((entries) =>
    entries.find(
      (entry) =>
        entry.type === "page" &&
        entry.webSocketDebuggerUrl &&
        entry.url.startsWith("file:"),
    ),
  );
  shell = await CdpClient.connect(shellTarget.webSocketDebuggerUrl);
  await poll(
    () => shell.evaluate("Boolean(window.chromecraft)"),
    Boolean,
    "the trusted shell API",
  );
  await shell.evaluate(`(async () => {
    const snapshot = await window.chromecraft.getSnapshot();
    await window.chromecraft.navigate(snapshot.activeTabId, ${JSON.stringify(fixtureUrl)});
  })()`);

  stage = "connect to the website fixture";
  const pageTarget = await poll(
    () => targets(debugPort),
    (entries) => entries.find((entry) => entry.url === fixtureUrl),
    "the fullscreen fixture target",
  ).then((entries) => entries.find((entry) => entry.url === fixtureUrl));
  page = await CdpClient.connect(pageTarget.webSocketDebuggerUrl);
  await page.send("Page.bringToFront");

  stage = "test main-frame fullscreen";
  await trustedClick(page, "#page-fullscreen");
  await poll(
    () => page.evaluate("Boolean(document.fullscreenElement)"),
    Boolean,
    "main-frame fullscreen",
  );
  await poll(
    () => shell.evaluate("document.visibilityState"),
    (state) => state === "hidden",
    "the browser shell to hide",
  );
  await pressKey(page, "Escape", "Escape");
  await poll(
    () => page.evaluate("document.fullscreenElement === null"),
    Boolean,
    "Escape to leave fullscreen",
  );
  await poll(
    () => shell.evaluate("document.visibilityState"),
    (state) => state === "visible",
    "the browser shell to return",
  );

  stage = "test an opaque cross-origin iframe";
  await trustedClick(page, "#opaque-frame");
  await poll(
    () => page.evaluate("document.fullscreenElement?.tagName ?? null"),
    (tagName) => tagName === "IFRAME",
    "opaque cross-origin iframe fullscreen",
  );
  await pressKey(page, "Escape", "Escape");
  await poll(
    () => page.evaluate("document.fullscreenElement === null"),
    Boolean,
    "iframe fullscreen exit",
  );

  stage = "test F11 state restoration";
  await pressKey(page, "F11", "F11");
  await poll(
    () => shell.evaluate("document.visibilityState"),
    (state) => state === "hidden",
    "F11 browser fullscreen",
  );
  await trustedClick(page, "#page-fullscreen");
  await poll(
    () => page.evaluate("Boolean(document.fullscreenElement)"),
    Boolean,
    "website fullscreen over F11 fullscreen",
  );
  await pressKey(page, "Escape", "Escape");
  await poll(
    () => page.evaluate("document.fullscreenElement === null"),
    Boolean,
    "website fullscreen exit over F11",
  );
  await poll(
    () => shell.evaluate("document.visibilityState"),
    (state) => state === "hidden",
    "the previous F11 fullscreen state to be restored",
  );
  await pressKey(page, "F11", "F11");
  await poll(
    () => shell.evaluate("document.visibilityState"),
    (state) => state === "visible",
    "F11 fullscreen exit",
  );

  stage = "test pointer lock";
  await trustedClick(page, "#pointer-lock");
  await poll(
    () => page.evaluate("Boolean(document.pointerLockElement)"),
    Boolean,
    "pointer lock permission",
  );
  await pressKey(page, "Escape", "Escape");
  await poll(
    () => page.evaluate("document.pointerLockElement === null"),
    Boolean,
    "pointer lock release",
  );

  stage = "test keyboard lock";
  await trustedClick(page, "#keyboard-lock");
  const keyboardLock = await poll(
    () => page.evaluate("document.body.dataset.keyboardLock ?? null"),
    Boolean,
    "keyboard lock decision",
  );
  if (keyboardLock !== "granted" && keyboardLock !== "unsupported")
    throw new Error(`Keyboard lock was not granted: ${keyboardLock}`);
  if (keyboardLock === "granted") {
    await pressKey(page, "Escape", "Escape");
    await poll(
      () => page.evaluate("document.fullscreenElement === null"),
      Boolean,
      "keyboard lock fullscreen exit",
    );
    await poll(
      () => shell.evaluate("document.visibilityState"),
      (state) => state === "visible",
      "browser chrome after keyboard lock",
    );
  }

  stage = "test screen wake lock";
  await page.send("Page.bringToFront");
  await trustedClick(page, "#wake-lock");
  const wakeLock = await poll(
    () => page.evaluate("document.body.dataset.wakeLock ?? null"),
    (value) => value && value !== "pending",
    "screen wake lock decision",
  );
  if (wakeLock !== "granted")
    throw new Error(`Wake lock was not granted: ${wakeLock}`);

  stage = "test tab-switch cleanup";
  await trustedClick(page, "#page-fullscreen");
  await poll(
    () => page.evaluate("Boolean(document.fullscreenElement)"),
    Boolean,
    "fullscreen before tab switch",
  );
  const firstTabId = await shell.evaluate(
    "window.chromecraft.getSnapshot().then((snapshot) => snapshot.activeTabId)",
  );
  const secondTabId = await shell.evaluate(
    "window.chromecraft.createTab('https://example.com/')",
  );
  await poll(
    () => page.evaluate("document.fullscreenElement === null"),
    Boolean,
    "tab switch to leave fullscreen",
  );
  await shell.evaluate(
    `window.chromecraft.activateTab(${JSON.stringify(firstTabId)})`,
  );
  const fullscreenRevived = await page.evaluate(
    "Boolean(document.fullscreenElement)",
  );
  if (fullscreenRevived)
    throw new Error("Fullscreen revived after tab switch.");
  await shell.evaluate(
    `window.chromecraft.closeTab(${JSON.stringify(secondTabId)})`,
  );

  console.log(
    JSON.stringify(
      {
        pass: true,
        mainFrameFullscreen: true,
        opaqueCrossOriginIframeFullscreen: true,
        pointerLock: true,
        keyboardLock,
        screenWakeLock: true,
        f11StateRestoration: true,
        tabSwitchCleanup: true,
      },
      null,
      2,
    ),
  );
} catch (error) {
  let pageDiagnostics = null;
  try {
    pageDiagnostics = await page?.evaluate(
      "({ url: location.href, readyState: document.readyState, focus: document.hasFocus(), visibility: document.visibilityState, userActivation: navigator.userActivation ? { active: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive } : null, dataset: { ...document.body.dataset } })",
    );
  } catch {
    // The page may already be gone.
  }
  console.error(
    JSON.stringify({
      pass: false,
      stage,
      error: error instanceof Error ? error.message : String(error),
      pageDiagnostics,
    }),
  );
  process.exitCode = 1;
} finally {
  page?.close();
  shell?.close();
  await stop(child);
  await closeServer(mainServer);
  await closeServer(frameServer);
  await fs.rm(profile, { recursive: true, force: true });
}
