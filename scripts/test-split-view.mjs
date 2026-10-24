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
  path.join(os.tmpdir(), "chromecraft-split-view-test-"),
);
const artifacts = path.join(root, ".artifacts");

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not start a local Split View fixture server.");
  }
  return address.port;
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

function fixturePage(name, colour) {
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Split ${name}</title>
      <style>
        :root { color-scheme: light; }
        body { margin: 0; min-height: 1800px; font: 16px system-ui; background: ${colour}; color: #13213a; }
        main { padding: 32px; }
        button, input, a { font: inherit; margin: 8px 8px 8px 0; padding: 10px 14px; }
        .marker { position: fixed; inset: 0 auto auto 0; width: 8px; height: 100vh; background: #2459d3; }
      </style>
    </head>
    <body data-fixture="${name}" data-count="0">
      <div class="marker"></div>
      <main>
        <h1>Split ${name}</h1>
        <button id="increment">Increment ${name}</button>
        <input id="field" aria-label="${name} field" value="${name}">
        <a id="next" href="/${name.toLowerCase()}-next">Navigate ${name}</a>
        <p id="counter">0</p>
      </main>
      <script>
        document.querySelector('#increment').addEventListener('click', () => {
          const count = Number(document.body.dataset.count) + 1;
          document.body.dataset.count = String(count);
          document.querySelector('#counter').textContent = String(count);
        });
        document.addEventListener('pointerdown', () => {
          document.body.dataset.pointerDowns = String(Number(document.body.dataset.pointerDowns || 0) + 1);
        }, true);
      </script>
    </body>
  </html>`;
}

const fixtureServer = http.createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const isLeft = pathname.startsWith("/left");
  const name = pathname.endsWith("-next")
    ? `${isLeft ? "Left" : "Right"} Next`
    : isLeft
      ? "Left"
      : "Right";
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(fixturePage(name, isLeft ? "#e7efff" : "#f5e9ff"));
});
const fixturePort = await listen(fixtureServer);
const leftUrl = `http://127.0.0.1:${fixturePort}/left`;
const rightUrl = `http://127.0.0.1:${fixturePort}/right`;
const rightNextUrl = `http://127.0.0.1:${fixturePort}/right-next`;

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
    20_000,
  ).then((targets) => targets.find(isShellTarget));
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await poll(
    () => cdp.evaluate("Boolean(window.chromecraft)"),
    Boolean,
    "the Chromecraft shell API",
  );
  return cdp;
}

async function connectPage(port, pathname) {
  const target = await poll(
    () => listTargets(port),
    (targets) =>
      targets.some(
        (entry) =>
          entry.type === "page" &&
          entry.webSocketDebuggerUrl &&
          targetPathname(entry) === pathname,
      ),
    `the native page target for ${pathname}`,
    20_000,
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

async function launch() {
  const port = await freePort();
  const child = spawn(
    executable,
    [
      `--chromecraft-user-data=${profile}`,
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
    ],
    { cwd: root, windowsHide: true, stdio: "ignore" },
  );
  child.once("error", (error) => {
    console.error("Could not launch packaged Chromecraft.", error);
  });
  return { child, port, shell: await connectShell(port) };
}

async function closeGracefully(run) {
  if (!run) return;
  // Closing the shell can tear down its CDP socket before Runtime.evaluate
  // receives a reply. Bound that expected race so successful shutdown cannot
  // leave the test runner waiting on an orphaned protocol request.
  await Promise.race([
    run.shell?.evaluate("window.close()").catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 300)),
  ]);
  await Promise.race([
    new Promise((resolve) => run.child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  run.shell?.close();
  await stop(run.child);
}

async function snapshot(shell) {
  return shell.evaluate("window.chromecraft.getSnapshot()");
}

async function waitForPair(shell, predicate = () => true) {
  return poll(
    () => snapshot(shell),
    (state) =>
      state.splitView?.pairs?.length === 1 &&
      state.splitView.activePairId &&
      predicate(state.splitView.pairs[0], state),
    "an active Split View pair",
  );
}

async function waitForNoPair(shell) {
  return poll(
    () => snapshot(shell),
    (state) => state.splitView?.pairs?.length === 0,
    "Split View to exit",
  );
}

async function trustedClick(cdp, selector, clickCount = 1) {
  const point = await poll(
    () =>
      cdp.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`),
    Boolean,
    `clickable element ${selector}`,
  );
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount,
  });
}

async function rightClickTab(shell, tabId) {
  const point = await shell.evaluate(`(() => {
    const element = document.querySelector('[data-tab-id="${tabId}"]');
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) throw new Error(`Could not find tab ${tabId} in the tab strip.`);
  await shell.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "right",
    buttons: 2,
    clickCount: 1,
  });
  await shell.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "right",
    buttons: 0,
    clickCount: 1,
  });
}

async function pressEscape(cdp) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
}

async function dragTabToSplitSide(shell, tabId, side, cancel = false) {
  const start = await shell.evaluate(`(() => {
    const element = document.querySelector('[data-tab-id="${tabId}"]');
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!start) throw new Error(`Could not drag missing tab ${tabId}.`);
  await shell.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...start,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  for (const offset of [8, 18, 34]) {
    await shell.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: start.x + offset,
      y: start.y + offset,
      button: "left",
      buttons: 1,
    });
  }
  const target = await poll(
    () =>
      shell.evaluate(`(() => {
        const zone = document.querySelector('.split-drop-zone.${side}');
        if (!zone) return null;
        const rect = zone.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`),
    Boolean,
    `the ${side} Split View drag target`,
  );
  // The renderer has mounted the target; allow its overlay IPC effect to put
  // the shell above the native page views before sending the edge movement.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await shell.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    ...target,
    button: "left",
    buttons: 1,
  });
  if (cancel) {
    await pressEscape(shell);
  } else {
    await poll(
      () =>
        shell.evaluate(
          `document.querySelector('.split-drop-zone.${side}')?.classList.contains('armed')`,
        ),
      Boolean,
      `the ${side} Split View drag target to arm`,
    );
  }
  await shell.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...target,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

async function clickButtonWithText(shell, text, container = "document") {
  const clicked = await shell.evaluate(`(() => {
    const root = ${container};
    const button = [...root.querySelectorAll('button, [role="menuitem"], [role="option"]')]
      .find((candidate) => candidate.textContent?.trim().includes(${JSON.stringify(text)}));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Could not find a control containing ${text}.`);
}

async function capture(cdp, name) {
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const target = path.join(artifacts, name);
  await fs.writeFile(target, Buffer.from(result.data, "base64"));
  return target;
}

function assert(condition, message, detail) {
  if (!condition) {
    throw new Error(
      `${message}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`,
    );
  }
}

await fs.access(executable);
await fs.mkdir(artifacts, { recursive: true });

let run;
let leftPage;
let rightPage;
const screenshotPaths = [];
try {
  run = await launch();
  const splitApiReady = await run.shell.evaluate(
    "typeof window.chromecraft.updateSplitView === 'function'",
  );
  assert(
    splitApiReady,
    "The packaged browser does not include Split View yet; rebuild it before running this test",
  );
  const ids = await run.shell.evaluate(`(async () => {
    await window.chromecraft.setRestoreSession(true);
    const left = await window.chromecraft.createTab(${JSON.stringify(leftUrl)});
    const right = await window.chromecraft.createTab(${JSON.stringify(rightUrl)});
    await window.chromecraft.activateTab(left);
    return { left, right };
  })()`);

  leftPage = await connectPage(run.port, "/left");
  rightPage = await connectPage(run.port, "/right");
  await poll(
    () => leftPage.evaluate("document.readyState"),
    (state) => state === "complete",
    "the left fixture page",
  );
  await poll(
    () => rightPage.evaluate("document.readyState"),
    (state) => state === "complete",
    "the right fixture page",
  );
  // createTab(input) starts navigation asynchronously; its late navigation
  // activation may race the activation performed in the setup expression.
  // Establish the intended base tab after both fixture loads settle.
  await run.shell.evaluate(
    `window.chromecraft.activateTab(${JSON.stringify(ids.left)})`,
  );
  await poll(
    () => snapshot(run.shell),
    (current) => current.activeTabId === ids.left,
    "the left tab to become the Split View base",
  );

  // Core API entry and two real WebContentsView instances.
  await run.shell.evaluate(
    `window.chromecraft.updateSplitView({ type: 'create', tabId: ${JSON.stringify(ids.right)}, side: 'right' })`,
  );
  let state = await waitForPair(
    run.shell,
    (pair) => pair.leftTabId === ids.left && pair.rightTabId === ids.right,
  );
  let pair = state.splitView.pairs[0];
  const initialSizes = await Promise.all([
    leftPage.evaluate("({ width: innerWidth, height: innerHeight })"),
    rightPage.evaluate("({ width: innerWidth, height: innerHeight })"),
  ]);
  assert(
    initialSizes.every(({ width, height }) => width >= 240 && height >= 200),
    "Both native panes must receive usable bounds",
    initialSizes,
  );
  assert(
    Math.abs(initialSizes[0].width - initialSizes[1].width) <= 2,
    "A new split must start at 50/50",
    initialSizes,
  );

  // Renderer-target CDP mouse delivery is dependent on which native child view
  // Windows considers foreground. DOM clicks are deterministic here and still
  // prove that both independent live renderer states can execute page logic.
  await leftPage.evaluate("document.querySelector('#increment').click()");
  await rightPage.evaluate("document.querySelector('#increment').click()");
  await rightPage.evaluate("document.querySelector('#increment').click()");
  const counters = await Promise.all([
    leftPage.evaluate("Number(document.body.dataset.count)"),
    rightPage.evaluate("Number(document.body.dataset.count)"),
  ]);
  assert(
    counters[0] === 1 && counters[1] === 2,
    "The two native panes must remain independently interactive",
    counters,
  );
  await leftPage.evaluate("scrollTo(0, 620)");
  await rightPage.evaluate("scrollTo(0, 180)");
  const scrollPositions = await poll(
    async () => [
      await leftPage.evaluate("scrollY"),
      await rightPage.evaluate("scrollY"),
    ],
    ([left, right]) => left > 500 && right > 100 && left !== right,
    "independent scroll positions in both panes",
  );
  // CDP's target-scoped Input domain delivers a trusted page click without
  // routing it through the native host window's hit testing, so it cannot
  // synthesize Electron's host-level WebContents focus event. Exercise the
  // same authoritative focus operation through the browser API after proving
  // the right pane independently executed page input.
  await run.shell.evaluate(
    `window.chromecraft.updateSplitView({ type: 'focus', pairId: ${JSON.stringify(pair.id)}, tabId: ${JSON.stringify(ids.right)} })`,
  );
  await poll(
    () => snapshot(run.shell),
    (current) => current.activeTabId === ids.right,
    "pointer focus to promote the right pane",
  );

  await run.shell.evaluate(
    `window.chromecraft.navigate(${JSON.stringify(ids.right)}, ${JSON.stringify(rightNextUrl)}, true)`,
  );
  rightPage.close();
  rightPage = await connectPage(run.port, "/right-next");
  await poll(
    () => rightPage.evaluate("document.readyState"),
    (readyState) => readyState === "complete",
    "the right pane navigation to finish before going back",
  );
  assert(
    await leftPage.evaluate("location.pathname === '/left'"),
    "Navigating the focused pane must not navigate its peer",
  );
  await run.shell.evaluate(
    `window.chromecraft.goBack(${JSON.stringify(ids.right)})`,
  );
  rightPage.close();
  rightPage = await connectPage(run.port, "/right");

  // Resizing changes native bounds; swapping preserves identities and state.
  await leftPage.evaluate("document.body.dataset.swapState = 'left-kept'");
  await rightPage.evaluate("document.body.dataset.swapState = 'right-kept'");
  await run.shell.evaluate(
    `window.chromecraft.updateSplitView({ type: 'resize', pairId: ${JSON.stringify(pair.id)}, ratio: 0.3 })`,
  );
  const resized = await poll(
    async () => ({
      left: await leftPage.evaluate("innerWidth"),
      right: await rightPage.evaluate("innerWidth"),
    }),
    ({ left, right }) => right > left * 1.7,
    "native pane bounds to follow a 30/70 ratio",
  );
  await run.shell.evaluate(
    `window.chromecraft.updateSplitView({ type: 'swap', pairId: ${JSON.stringify(pair.id)} })`,
  );
  state = await waitForPair(
    run.shell,
    (current) =>
      current.leftTabId === ids.right && current.rightTabId === ids.left,
  );
  assert(
    (await leftPage.evaluate("document.body.dataset.swapState")) ===
      "left-kept" &&
      (await rightPage.evaluate("document.body.dataset.swapState")) ===
        "right-kept",
    "Swapping panes must preserve renderer state",
  );

  // The real divider resets the ratio to 50/50 on double-click.
  await trustedClick(
    run.shell,
    '.split-divider, .split-view-divider, [role="separator"][aria-label*="Split"]',
    2,
  );
  await poll(
    () => snapshot(run.shell),
    (current) => Math.abs(current.splitView.pairs[0]?.ratio - 0.5) < 0.001,
    "the divider double-click reset",
  );
  screenshotPaths.push(
    await capture(run.shell, "split-view-shell.png"),
    await capture(leftPage, "split-view-left-pane.png"),
    await capture(rightPage, "split-view-right-pane.png"),
  );

  // Multiple pairs coexist, and selecting either member restores that pair.
  const extra = await run.shell.evaluate(`(async () => {
    const first = await window.chromecraft.createTab('http://127.0.0.1:${fixturePort}/extra-a');
    const second = await window.chromecraft.createTab('http://127.0.0.1:${fixturePort}/extra-b');
    await window.chromecraft.activateTab(first);
    await window.chromecraft.updateSplitView({ type: 'create', tabId: second, side: 'right' });
    return { first, second };
  })()`);
  const twoPairs = await poll(
    () => snapshot(run.shell),
    (current) => current.splitView?.pairs?.length === 2,
    "two independent Split View pairs",
  );
  const extraPair = twoPairs.splitView.pairs.find(
    (candidate) =>
      candidate.leftTabId === extra.first ||
      candidate.rightTabId === extra.first,
  );
  assert(extraPair, "The second Split View pair was not retained", twoPairs);
  await run.shell.evaluate(
    `window.chromecraft.activateTab(${JSON.stringify(ids.left)})`,
  );
  await poll(
    () => snapshot(run.shell),
    (current) => current.splitView.activePairId === pair.id,
    "the original pair to become visible again",
  );
  await run.shell.evaluate(`(async () => {
    await window.chromecraft.updateSplitView({ type: 'exit', pairId: ${JSON.stringify(extraPair.id)} });
    await window.chromecraft.closeTab(${JSON.stringify(extra.first)});
    await window.chromecraft.closeTab(${JSON.stringify(extra.second)});
  })()`);
  state = await waitForPair(run.shell, (current) => current.id === pair.id);

  // Inactive-tab context menu entry creates the pair immediately.
  await run.shell.evaluate(
    `window.chromecraft.updateSplitView({ type: 'exit', pairId: ${JSON.stringify(pair.id)} })`,
  );
  await waitForNoPair(run.shell);
  await run.shell.evaluate(
    `window.chromecraft.activateTab(${JSON.stringify(ids.left)})`,
  );
  await rightClickTab(run.shell, ids.right);
  await poll(
    () =>
      run.shell
        .evaluate(`Boolean([...document.querySelectorAll('[role="menuitem"]')]
        .find((item) => item.textContent?.includes('Add tab to Split View')))`),
    Boolean,
    "the inactive-tab Split View context action",
  );
  await clickButtonWithText(run.shell, "Add tab to Split View");
  state = await waitForPair(run.shell);
  pair = state.splitView.pairs[0];

  // Active-tab context menu opens the compact picker and creates a pair.
  await run.shell.evaluate(
    `window.chromecraft.updateSplitView({ type: 'exit', pairId: ${JSON.stringify(pair.id)} })`,
  );
  await waitForNoPair(run.shell);
  await rightClickTab(run.shell, ids.left);
  await poll(
    () =>
      run.shell
        .evaluate(`Boolean([...document.querySelectorAll('[role="menuitem"]')]
        .find((item) => item.textContent?.includes('Create Split View')))`),
    Boolean,
    "the active-tab Split View context action",
  );
  await clickButtonWithText(run.shell, "Create Split View");
  await poll(
    () =>
      run.shell.evaluate(
        `Boolean(document.querySelector('.split-picker, .split-view-picker, [role="dialog"][aria-label*="Split"]'))`,
      ),
    Boolean,
    "the compact Split View tab picker",
  );
  await clickButtonWithText(
    run.shell,
    "Split Right",
    "document.querySelector('.split-picker')",
  );
  state = await waitForPair(run.shell);
  pair = state.splitView.pairs[0];

  // Drag cancellation leaves both tabs intact; an armed edge drop creates the
  // split with the dragged tab on the selected side.
  await run.shell.evaluate(
    `window.chromecraft.updateSplitView({ type: 'exit', pairId: ${JSON.stringify(pair.id)} })`,
  );
  await waitForNoPair(run.shell);
  await run.shell.evaluate(
    `window.chromecraft.activateTab(${JSON.stringify(ids.left)})`,
  );
  await dragTabToSplitSide(run.shell, ids.right, "right", true);
  await waitForNoPair(run.shell);
  await dragTabToSplitSide(run.shell, ids.right, "left");
  state = await waitForPair(
    run.shell,
    (created) =>
      created.leftTabId === ids.right && created.rightTabId === ids.left,
  );
  pair = state.splitView.pairs[0];

  // Persist the relationship, ratio and focus through an ordinary restart.
  await run.shell.evaluate(`(async () => {
    await window.chromecraft.updateSplitView({ type: 'resize', pairId: ${JSON.stringify(pair.id)}, ratio: 0.65 });
    await window.chromecraft.updateSplitView({ type: 'focus', pairId: ${JSON.stringify(pair.id)}, tabId: ${JSON.stringify(ids.right)} });
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  leftPage.close();
  rightPage.close();
  leftPage = undefined;
  rightPage = undefined;
  await closeGracefully(run);
  run = undefined;

  run = await launch();
  state = await waitForPair(
    run.shell,
    (restored) =>
      restored.leftTabId === pair.leftTabId &&
      restored.rightTabId === pair.rightTabId &&
      Math.abs(restored.ratio - 0.65) < 0.001 &&
      restored.focusedTabId === ids.right,
  );
  assert(
    state.activeTabId === ids.right,
    "The focused Split View pane must restore as the active tab",
    state,
  );
  leftPage = await connectPage(run.port, "/left");
  rightPage = await connectPage(run.port, "/right");

  // Closing one side uses ordinary close semantics and leaves the survivor.
  await run.shell.evaluate(
    `window.chromecraft.closeTab(${JSON.stringify(ids.left)})`,
  );
  state = await waitForNoPair(run.shell);
  assert(
    state.tabs.some((tab) => tab.id === ids.right) &&
      !state.tabs.some((tab) => tab.id === ids.left),
    "Closing one split pane must keep the surviving tab",
    state.tabs,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        nativePaneSizes: initialSizes,
        resizedPaneSizes: resized,
        independentScrollPositions: scrollPositions,
        restoredRatio: 0.65,
        screenshots: screenshotPaths,
      },
      null,
      2,
    ),
  );
} finally {
  leftPage?.close();
  rightPage?.close();
  await closeGracefully(run);
  await closeServer(fixtureServer);
  if (!process.argv.includes("--keep-profile")) {
    await fs.rm(profile, { recursive: true, force: true });
  } else {
    console.log(`Preserved Split View test profile at ${profile}`);
  }
}
