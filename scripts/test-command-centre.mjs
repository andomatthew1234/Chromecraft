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
      platform === "win32" ? "Chromecraft-win32-x64" : "Chromecraft-linux-x64",
      platform === "win32" ? "chromecraft.exe" : "chromecraft",
    ),
);
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "chromecraft-command-centre-test-"),
);
const artifacts = path.join(root, ".artifacts");
const screenshotPaths = {
  tabs: path.join(artifacts, "command-centre-tabs.png"),
  scout: path.join(artifacts, "command-centre-scout.png"),
  web: path.join(artifacts, "command-centre-web-search.png"),
  narrow: path.join(artifacts, "command-centre-narrow.png"),
};
const SCOUT_MODEL = "chromecraft-command-test:latest";
const SCOUT_REPLY = "Scout completed the deterministic Command Centre test.";

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not start a deterministic test server.");
  }
  return address.port;
}

async function closeServer(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

function fixturePage(name) {
  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${name} Workspace</title>
        <style>
          body { margin: 0; padding: 32px; min-height: 1200px; font: 16px system-ui; background: #f7f8ff; color: #17223b; }
          main { max-width: 720px; margin: auto; }
          kbd { padding: 2px 6px; border: 1px solid #9ba4b8; border-radius: 6px; background: white; }
          input, button { min-height: 42px; padding: 0 12px; font: inherit; }
        </style>
      </head>
      <body data-fixture="${name}">
        <main>
          <h1>${name} Workspace</h1>
          <p>Deterministic Command Centre fixture for ${name}.</p>
          <p>Open the browser-owned interface with <kbd>Ctrl</kbd> + <kbd>K</kbd>.</p>
          <input aria-label="Fixture field" value="${name} draft">
          <button id="page-action">Page action</button>
        </main>
      </body>
    </html>`;
}

const fixtureServer = http.createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const name = pathname.includes("beta")
    ? "Beta"
    : pathname.includes("gamma")
      ? "Gamma"
      : "Alpha";
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(fixturePage(name));
});
const fixturePort = await listen(fixtureServer);
const fixtureUrls = {
  alpha: `http://127.0.0.1:${fixturePort}/alpha`,
  beta: `http://127.0.0.1:${fixturePort}/beta`,
  gamma: `http://127.0.0.1:${fixturePort}/gamma`,
};

const ollamaRequests = [];
const ollamaServer = http.createServer(async (request, response) => {
  const knownRoute = request.url === "/api/tags" || request.url === "/api/chat";
  if (!knownRoute) {
    request.resume();
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Unknown deterministic route" }));
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  ollamaRequests.push({
    method: request.method,
    url: request.url,
    body: body.slice(0, 16_384),
    bodyLength: body.length,
  });
  if (request.method === "GET" && request.url === "/api/tags") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        models: [
          {
            name: SCOUT_MODEL,
            model: SCOUT_MODEL,
            size: 128,
            modified_at: "2026-10-25T00:00:00.000Z",
            details: { family: "command-test", parameter_size: "test" },
          },
        ],
      }),
    );
    return;
  }
  if (request.method === "POST" && request.url === "/api/chat") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        message: {
          role: "assistant",
          content: JSON.stringify({ reply: SCOUT_REPLY }),
        },
        done: true,
      }),
    );
    return;
  }
  response.writeHead(405, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "Unsupported deterministic method" }));
});

try {
  await listen(ollamaServer, 11_434);
} catch (error) {
  await closeServer(fixtureServer);
  const detail = error instanceof Error ? error.message : String(error);
  throw new Error(
    `Command Centre Scout E2E requires the deterministic loopback Ollama fixture on 127.0.0.1:11434. Stop the existing service and retry. ${detail}`,
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
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("CDP target closed."));
      }
      this.pending.clear();
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
      }, 10_000);
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
  const detail = typeof last === "object" ? JSON.stringify(last) : String(last);
  throw new Error(`Timed out waiting for ${description}: ${detail}`);
}

function assert(condition, message, detail) {
  if (!condition) {
    throw new Error(
      `${message}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`,
    );
  }
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok)
    throw new Error(`CDP target list returned ${response.status}.`);
  return response.json();
}

function isShellTarget(target) {
  return (
    target.type === "page" &&
    target.webSocketDebuggerUrl &&
    (target.title === "Chromecraft" ||
      target.url.startsWith("file:") ||
      target.url.includes("main_window"))
  );
}

function targetPathname(target) {
  try {
    return new URL(target.url).pathname;
  } catch {
    return null;
  }
}

async function connectShell(port) {
  const target = await poll(
    () => listTargets(port),
    (targets) => targets.some(isShellTarget),
    "the Chromecraft shell target",
    30_000,
  ).then((targets) => targets.find(isShellTarget));
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await poll(
    () => cdp.evaluate("Boolean(window.chromecraft)"),
    Boolean,
    "the trusted shell API",
  );
  return cdp;
}

async function connectFixturePage(port, pathname) {
  const target = await poll(
    () => listTargets(port),
    (targets) =>
      targets.some(
        (entry) =>
          entry.type === "page" &&
          entry.webSocketDebuggerUrl &&
          targetPathname(entry) === pathname,
      ),
    `the webpage target for ${pathname}`,
    30_000,
  ).then((targets) =>
    targets.find(
      (entry) =>
        entry.type === "page" &&
        entry.webSocketDebuggerUrl &&
        targetPathname(entry) === pathname,
    ),
  );
  return CdpClient.connect(target.webSocketDebuggerUrl);
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

async function closeRun(run) {
  if (!run) return;
  await Promise.race([
    run.shell?.evaluate("window.close()").catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 300)),
  ]);
  run.shell?.close();
  await stop(run.child);
}

async function launch() {
  const debugPort = await freePort();
  const child = spawn(
    executable,
    [
      `--chromecraft-user-data=${profile}`,
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
      "--remote-debugging-address=127.0.0.1",
      "--disable-background-networking",
      "--host-resolver-rules=MAP duckduckgo.com 127.0.0.1, MAP *.duckduckgo.com 127.0.0.1, EXCLUDE localhost",
      "--no-first-run",
    ],
    { cwd: root, windowsHide: true, stdio: "ignore" },
  );
  return { child, debugPort, shell: await connectShell(debugPort) };
}

async function pressKey(cdp, key, options = {}) {
  const code = options.code ?? key;
  const windowsVirtualKeyCode =
    options.windowsVirtualKeyCode ??
    (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  const modifiers =
    (options.control ? 2 : 0) |
    (options.alt ? 1 : 0) |
    (options.shift ? 8 : 0) |
    (options.meta ? 4 : 0);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key,
    code,
    modifiers,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    modifiers,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
  });
}

async function typeText(cdp, text) {
  await cdp.send("Input.insertText", { text });
}

async function openFromWebpage(page, shell) {
  await page.send("Page.bringToFront");
  await pressKey(page, "k", {
    code: "KeyK",
    control: platform !== "darwin",
    meta: platform === "darwin",
    windowsVirtualKeyCode: 75,
  });
  return poll(
    () =>
      shell.evaluate(
        `Boolean(document.querySelector('[role="dialog"][aria-label="Command Centre"]'))`,
      ),
    Boolean,
    "Ctrl+K from a webpage to open Command Centre",
  );
}

async function inputState(shell) {
  return shell.evaluate(`(() => {
    const input = document.querySelector('input[aria-label="Command Centre input"]');
    return input ? { value: input.value, placeholder: input.placeholder } : null;
  })()`);
}

async function replaceInput(shell, value) {
  const focused = await shell.evaluate(`(() => {
    const input = document.querySelector('input[aria-label="Command Centre input"]');
    if (!input) return false;
    input.focus();
    input.select();
    return true;
  })()`);
  if (!focused) throw new Error("Command Centre input is unavailable.");
  await typeText(shell, value);
}

async function chooseNamedControl(shell, label) {
  const clicked = await shell.evaluate(`(() => {
    const root = document.querySelector('[role="dialog"][aria-label="Command Centre"]');
    const target = [...(root?.querySelectorAll('button, [role="option"]') ?? [])]
      .find((entry) => entry.textContent?.trim().includes(${JSON.stringify(label)}));
    if (!target) return false;
    target.click();
    return true;
  })()`);
  if (!clicked)
    throw new Error(`Command Centre control ${label} was not found.`);
}

async function waitForPlaceholder(shell, placeholder) {
  return poll(
    () => inputState(shell),
    (input) => input?.placeholder === placeholder,
    `Command Centre mode ${placeholder}`,
  );
}

async function selectFilteredTabWithKeyboard(shell, expectedTitle) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const selected = await shell.evaluate(`(() => {
      const row = document.querySelector(
        '[data-command-centre-kind="tab"][aria-selected="true"]'
      );
      return row?.textContent?.trim() ?? null;
    })()`);
    if (selected?.includes(expectedTitle)) return selected;
    await pressKey(shell, "ArrowDown", {
      code: "ArrowDown",
      windowsVirtualKeyCode: 40,
    });
  }
  throw new Error(
    `Keyboard navigation did not select the filtered tab ${expectedTitle}.`,
  );
}

async function capture(shell, targetPath) {
  const screenshot = await shell.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await fs.writeFile(targetPath, Buffer.from(screenshot.data, "base64"));
}

async function commandCentreGeometry(shell) {
  return shell.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Command Centre"]');
    if (!dialog) return null;
    const rect = dialog.getBoundingClientRect();
    const input = dialog.querySelector('input[aria-label="Command Centre input"]');
    const selected = dialog.querySelector('[role="option"][aria-selected="true"]');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      scrollWidth: dialog.scrollWidth,
      clientWidth: dialog.clientWidth,
      inputVisible: Boolean(input && input.getBoundingClientRect().height > 0),
      selectedText: selected?.textContent?.trim() ?? null,
    };
  })()`);
}

await fs.access(executable);
await fs.mkdir(artifacts, { recursive: true });
await fs.writeFile(
  path.join(profile, "preferences.json"),
  `${JSON.stringify(
    {
      restoreSession: false,
      sidebarAttached: false,
      sidebarOpen: false,
      searchEngine: "duckduckgo",
      ublockEnabled: false,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
await fs.writeFile(
  path.join(profile, "ai-tools.json"),
  `${JSON.stringify(
    {
      provider: "ollama",
      organiserProvider: "ollama",
      ollamaModel: SCOUT_MODEL,
      organiserOllamaModel: SCOUT_MODEL,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

let run;
let alphaPage;
try {
  run = await launch();
  const tabs = await run.shell.evaluate(`(async () => {
    const alpha = await window.chromecraft.createTab(${JSON.stringify(fixtureUrls.alpha)});
    const beta = await window.chromecraft.createTab(${JSON.stringify(fixtureUrls.beta)});
    const gamma = await window.chromecraft.createTab(${JSON.stringify(fixtureUrls.gamma)});
    return { alpha, beta, gamma };
  })()`);
  alphaPage = await connectFixturePage(run.debugPort, "/alpha");
  await poll(
    () => alphaPage.evaluate("document.readyState"),
    (readyState) => readyState === "complete",
    "the active webpage fixture",
  );
  await run.shell.evaluate(
    `window.chromecraft.activateTab(${JSON.stringify(tabs.alpha)})`,
  );
  await poll(
    () => run.shell.evaluate("window.chromecraft.getSnapshot()"),
    (snapshot) => snapshot.activeTabId === tabs.alpha,
    "the Alpha fixture tab to become active",
  );

  const ai = await run.shell.evaluate(`(async () => {
    const refreshed = await window.chromecraft.refreshAiModels('ollama');
    await window.chromecraft.setAiProvider('ollama');
    await window.chromecraft.setAiModel('ollama', ${JSON.stringify(SCOUT_MODEL)});
    return refreshed;
  })()`);
  assert(
    ai.ollama.connection === "connected" &&
      ai.ollama.models.some((model) => model.name === SCOUT_MODEL),
    "The deterministic Scout model did not connect",
    ai.ollama,
  );
  const scoutPreflight = await run.shell.evaluate(`window.chromecraft
    .sendAssistantMessage({
      conversationId: 'command-centre-preflight',
      messageId: 'command-centre-preflight',
      prompt: 'Verify the deterministic Command Centre provider.',
      createdAt: Date.now(),
      provider: 'ollama',
      model: ${JSON.stringify(SCOUT_MODEL)},
      context: [],
      history: [],
    })
    .then((response) => ({ ok: true, response }))
    .catch((error) => ({ ok: false, error: String(error?.message ?? error) }))`);
  assert(
    scoutPreflight.ok && scoutPreflight.response?.text === SCOUT_REPLY,
    "The deterministic Scout provider preflight failed",
    scoutPreflight,
  );

  await openFromWebpage(alphaPage, run.shell);
  const initialInput = await inputState(run.shell);
  assert(
    initialInput?.placeholder === "Ask Scout...",
    "Command Centre did not open with Scout selected",
    initialInput,
  );
  const fixedRows = await run.shell.evaluate(`(() =>
    [...document.querySelectorAll(
      '[role="dialog"][aria-label="Command Centre"] [role="option"]'
    )].slice(0, 2).map((row) => ({
      name: row.querySelector('strong')?.textContent?.trim(),
      selected: row.getAttribute('aria-selected'),
    }))
  )()`);
  assert(
    fixedRows[0]?.name === "Ask Scout" &&
      fixedRows[0]?.selected === "true" &&
      fixedRows[1]?.name === "Search the web",
    "Command Centre fixed actions do not expose the expected accessible rows",
    fixedRows,
  );

  // The tab filter is separate from Scout/web drafts and keyboard traversal
  // selects a filtered tab rather than silently executing another mode.
  await pressKey(run.shell, "ArrowDown", {
    code: "ArrowDown",
    windowsVirtualKeyCode: 40,
  });
  await pressKey(run.shell, "ArrowDown", {
    code: "ArrowDown",
    windowsVirtualKeyCode: 40,
  });
  await waitForPlaceholder(run.shell, "Filter open tabs...");
  await replaceInput(run.shell, "Beta");
  const filteredTabs = await poll(
    () =>
      run.shell.evaluate(`(() => [...document.querySelectorAll(
        '[role="dialog"][aria-label="Command Centre"] [data-command-centre-kind="tab"]'
      )].map((row) => ({ text: row.textContent?.trim(), selected: row.getAttribute('aria-selected') })))()`),
    (rows) =>
      rows.length === 1 &&
      rows[0].text.includes("Beta Workspace") &&
      !rows[0].text.includes("Alpha Workspace"),
    "tab filtering to show only Beta",
  );
  const selectedTab = await selectFilteredTabWithKeyboard(
    run.shell,
    "Beta Workspace",
  );
  await capture(run.shell, screenshotPaths.tabs);
  await pressKey(run.shell, "Enter", {
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await poll(
    () => run.shell.evaluate("window.chromecraft.getSnapshot()"),
    (snapshot) => snapshot.activeTabId === tabs.beta,
    "Enter to activate the selected tab",
  );

  // Reconnect to the currently visible page and verify Ctrl+K toggles closed.
  alphaPage.close();
  alphaPage = await connectFixturePage(run.debugPort, "/beta");
  await openFromWebpage(alphaPage, run.shell);
  await pressKey(run.shell, "k", {
    code: "KeyK",
    control: platform !== "darwin",
    meta: platform === "darwin",
    windowsVirtualKeyCode: 75,
  });
  await poll(
    () =>
      run.shell.evaluate(
        `!document.querySelector('[role="dialog"][aria-label="Command Centre"]')`,
      ),
    Boolean,
    "Ctrl+K to toggle Command Centre closed",
  );
  await openFromWebpage(alphaPage, run.shell);
  await pressKey(run.shell, "Escape", {
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await poll(
    () =>
      run.shell.evaluate(
        `!document.querySelector('[role="dialog"][aria-label="Command Centre"]')`,
      ),
    Boolean,
    "Escape to close Command Centre",
  );

  // Scout and web search keep independent drafts while changing modes.
  await openFromWebpage(alphaPage, run.shell);
  await chooseNamedControl(run.shell, "Ask Scout");
  await waitForPlaceholder(run.shell, "Ask Scout...");
  await replaceInput(run.shell, "Explain the deterministic fixture");
  await chooseNamedControl(run.shell, "Search the web");
  await waitForPlaceholder(run.shell, "Search the web...");
  await replaceInput(run.shell, "material browser command centre");
  await chooseNamedControl(run.shell, "Ask Scout");
  const scoutDraft = await waitForPlaceholder(run.shell, "Ask Scout...");
  assert(
    scoutDraft.value === "Explain the deterministic fixture",
    "Scout draft was lost when changing modes",
    scoutDraft,
  );
  await chooseNamedControl(run.shell, "Search the web");
  const webDraft = await waitForPlaceholder(run.shell, "Search the web...");
  assert(
    webDraft.value === "material browser command centre",
    "Web-search draft was lost when changing modes",
    webDraft,
  );
  await capture(run.shell, screenshotPaths.web);

  // Switch once more to prove the Scout draft remains independent, then submit
  // it to the deterministic local provider. Command Centre intentionally closes
  // and hands the prompt to the normal Scout panel.
  await chooseNamedControl(run.shell, "Ask Scout");
  const retainedScout = await waitForPlaceholder(run.shell, "Ask Scout...");
  assert(
    retainedScout.value === "Explain the deterministic fixture",
    "Scout draft was lost after revisiting the web-search draft",
    retainedScout,
  );
  await pressKey(run.shell, "Enter", {
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await poll(
    () =>
      run.shell.evaluate(
        `document.querySelector('.sidebar-panel')?.textContent ?? ''`,
      ),
    (text) => text.includes(SCOUT_REPLY),
    "the deterministic Scout response in the normal assistant panel",
    20_000,
  );
  assert(
    ollamaRequests.some(
      (request) =>
        request.url === "/api/chat" &&
        request.body.includes("Explain the deterministic fixture"),
    ),
    "Command Centre did not send the Scout prompt to the selected model",
    ollamaRequests,
  );
  await capture(run.shell, screenshotPaths.scout);

  // Close the regular Scout panel, reopen Command Centre from the live page,
  // and submit through the configured DuckDuckGo engine. Search opens and
  // focuses a new tab while leaving the originating page intact.
  const closedScout = await run.shell.evaluate(`(() => {
    const button = document.querySelector('button[aria-label="Close Scout"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(closedScout, "Scout did not expose its normal close control");
  await openFromWebpage(alphaPage, run.shell);
  await chooseNamedControl(run.shell, "Search the web");
  await waitForPlaceholder(run.shell, "Search the web...");
  await replaceInput(run.shell, "material browser command centre");
  await pressKey(run.shell, "Enter", {
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  const searchSnapshot = await poll(
    () => run.shell.evaluate("window.chromecraft.getSnapshot()"),
    (snapshot) => {
      const active = snapshot.tabs.find(
        (tab) => tab.id === snapshot.activeTabId,
      );
      return (
        active !== undefined &&
        active.id !== tabs.beta &&
        snapshot.tabs.some(
          (tab) => tab.id === tabs.beta && tab.url === fixtureUrls.beta,
        ) &&
        active.url.includes("duckduckgo.com") &&
        active.url.includes("material")
      );
    },
    "web search through the configured engine",
  );
  assert(
    searchSnapshot.preferences.searchEngine === "duckduckgo",
    "The web search did not use the configured engine",
    searchSnapshot.preferences,
  );

  // Validate actual native resizing as well as a high-density emulation pass.
  await run.shell.evaluate(
    `window.chromecraft.activateTab(${JSON.stringify(tabs.gamma)})`,
  );
  await poll(
    () => run.shell.evaluate("window.chromecraft.getSnapshot()"),
    (snapshot) => snapshot.activeTabId === tabs.gamma,
    "the Gamma fixture tab to become active",
  );
  alphaPage.close();
  alphaPage = await connectFixturePage(run.debugPort, "/gamma");
  await openFromWebpage(alphaPage, run.shell);
  const shellTarget = (await listTargets(run.debugPort)).find(isShellTarget);
  let browserWindow = null;
  let nativeResizeUnavailable = null;
  try {
    browserWindow = await run.shell.send("Browser.getWindowForTarget", {
      targetId: shellTarget?.id,
    });
  } catch (error) {
    nativeResizeUnavailable =
      error instanceof Error ? error.message : String(error);
  }
  if (browserWindow) {
    await run.shell.send("Browser.setWindowBounds", {
      windowId: browserWindow.windowId,
      bounds: { width: 720, height: 620, windowState: "normal" },
    });
  }
  await run.shell.send("Emulation.setDeviceMetricsOverride", {
    width: 720,
    height: 620,
    deviceScaleFactor: 1.5,
    mobile: false,
  });
  const narrowGeometry = await poll(
    () => commandCentreGeometry(run.shell),
    (geometry) => geometry?.viewport.width === 720,
    "the narrow Command Centre viewport",
  );
  assert(
    narrowGeometry.rect.left >= 0 &&
      narrowGeometry.rect.right <= narrowGeometry.viewport.width &&
      narrowGeometry.rect.top >= 0 &&
      narrowGeometry.rect.bottom <= narrowGeometry.viewport.height &&
      narrowGeometry.scrollWidth <= narrowGeometry.clientWidth + 1 &&
      narrowGeometry.inputVisible,
    "Command Centre overflowed its narrow viewport",
    narrowGeometry,
  );
  await capture(run.shell, screenshotPaths.narrow);
  await run.shell.send("Emulation.clearDeviceMetricsOverride");

  console.log(
    JSON.stringify(
      {
        ok: true,
        filteredTabs,
        selectedTab,
        scoutRequests: ollamaRequests.filter(
          (request) => request.url === "/api/chat",
        ).length,
        configuredSearchEngine: searchSnapshot.preferences.searchEngine,
        nativeWindowResized: Boolean(browserWindow),
        nativeResizeUnavailable,
        narrowGeometry,
        screenshots: Object.values(screenshotPaths),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        commandCentreFailure:
          error instanceof Error ? error.message : String(error),
        ollamaRequests,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  alphaPage?.close();
  await closeRun(run);
  await closeServer(ollamaServer);
  await closeServer(fixtureServer);
  if (!process.argv.includes("--keep-profile")) {
    await fs.rm(profile, { recursive: true, force: true });
  } else {
    console.log(`Preserved Command Centre test profile at ${profile}`);
  }
}
