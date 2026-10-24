import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const root = process.cwd();
const executable = path.resolve(
  process.env.CHROMECRAFT_EXECUTABLE ??
    path.join(root, "out", "Chromecraft-win32-x64", "chromecraft.exe"),
);
const profile = await fs.mkdtemp(
  path.join(await fs.realpath(os.tmpdir()), "chromecraft-performance-centre-"),
);
const artifactDir = path.join(root, ".artifacts");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Could not reserve a debugging port.");
  return port;
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
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
      socket.once("open", resolve);
      socket.once("error", reject);
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
}

async function poll(operation, predicate, description, timeoutMs = 20_000) {
  const startedAt = Date.now();
  let last;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      last = await operation();
      if (predicate(last)) return last;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out waiting for ${description}: ${String(last)}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function stop(child) {
  if (!child.pid || child.exitCode !== null) return;
  const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
  await new Promise((resolve) => killer.once("exit", resolve));
}

await fs.access(executable);
await fs.mkdir(artifactDir, { recursive: true });
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

let shellClient;
let performanceClient;
try {
  const listTargets = () =>
    fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
      response.json(),
    );
  const shellTarget = await poll(
    listTargets,
    (targets) =>
      targets.some(
        (target) =>
          target.type === "page" &&
          target.url.startsWith("file://") &&
          !target.url.includes("performance-centre") &&
          target.webSocketDebuggerUrl,
      ),
    "the Chromecraft shell",
  ).then((targets) =>
    targets.find(
      (target) =>
        target.type === "page" &&
        target.url.startsWith("file://") &&
        !target.url.includes("performance-centre") &&
        target.webSocketDebuggerUrl,
    ),
  );
  shellClient = await CdpClient.connect(shellTarget.webSocketDebuggerUrl);
  await shellClient.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Escape",
    code: "Escape",
    modifiers: 8,
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await shellClient.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    modifiers: 8,
  });

  const performanceTarget = await poll(
    listTargets,
    (targets) =>
      targets.some(
        (target) =>
          target.type === "page" &&
          target.url.includes("performance-centre.html") &&
          target.webSocketDebuggerUrl,
      ),
    "Performance Centre after Shift + Esc",
  ).then((targets) =>
    targets.find(
      (target) =>
        target.type === "page" &&
        target.url.includes("performance-centre.html") &&
        target.webSocketDebuggerUrl,
    ),
  );
  performanceClient = await CdpClient.connect(
    performanceTarget.webSocketDebuggerUrl,
  );
  const snapshot = await poll(
    () =>
      performanceClient.evaluate(`(() => ({
        title: document.querySelector('h1')?.textContent,
        processCount: document.querySelectorAll('.task-table tbody > tr:not(.child-row)').length,
        cpu: document.querySelector('.summary-metric strong')?.textContent,
        api: Boolean(window.performanceCentre)
      }))()`),
    (value) =>
      value.api &&
      value.title === "Performance Centre" &&
      value.processCount > 0 &&
      value.cpu !== "—",
    "a real second process sample",
  );

  await shellClient.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Escape",
    code: "Escape",
    modifiers: 8,
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await shellClient.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    modifiers: 8,
  });
  const singletonCount = (await listTargets()).filter((target) =>
    target.url.includes("performance-centre.html"),
  ).length;
  assert(
    singletonCount === 1,
    "Shift + Esc created more than one Performance Centre window.",
  );

  await shellClient.evaluate(
    "document.querySelector('button[aria-label=\"Chromecraft menu\"]')?.click()",
  );
  const menuEntry = await shellClient.evaluate(`(() => {
    const item = [...document.querySelectorAll('[role="menuitem"]')]
      .find((entry) => entry.textContent?.includes('Performance Centre'));
    return item?.textContent?.replace(/\\s+/g, ' ').trim() ?? '';
  })()`);
  assert(
    menuEntry.includes("Shift + Esc"),
    "The C menu entry or shortcut label is missing.",
  );
  await shellClient.evaluate(`([...document.querySelectorAll('[role="menuitem"]')]
    .find((entry) => entry.textContent?.includes('Performance Centre')))?.click()`);

  for (const [width, height] of [
    [850, 580],
    [640, 420],
  ]) {
    await performanceClient.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const layout = await performanceClient.evaluate(`(() => ({
      width: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
      height: document.documentElement.scrollHeight,
      viewportHeight: document.documentElement.clientHeight
    }))()`);
    assert(
      layout.width <= layout.viewport,
      `Performance Centre overflowed horizontally at ${width}px.`,
    );
    assert(
      layout.height <= layout.viewportHeight,
      `Performance Centre overflowed vertically at ${height}px.`,
    );
  }

  await performanceClient.evaluate(`(() => {
    const input = document.querySelector('.performance-search input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'definitely-no-such-task');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await poll(
    () =>
      performanceClient.evaluate(
        "Boolean(document.querySelector('.empty-state'))",
      ),
    Boolean,
    "the search empty state",
  );
  await performanceClient.evaluate(`(() => {
    const input = document.querySelector('.performance-search input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('th:nth-child(2) button')?.click();
  })()`);
  const screenshot = await performanceClient.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const screenshotPath = path.join(artifactDir, "performance-centre.png");
  await fs.writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));

  await performanceClient.evaluate(
    "void window.performanceCentre.close(); true",
  );
  await poll(
    listTargets,
    (targets) =>
      !targets.some((target) => target.url.includes("performance-centre.html")),
    "Performance Centre to close",
  );
  const shellStillOpen = (await listTargets()).some(
    (target) => target.id === shellTarget.id,
  );
  assert(shellStillOpen, "Closing Performance Centre also closed Chromecraft.");

  console.log(
    JSON.stringify(
      {
        success: true,
        openedByShortcut: true,
        singletonCount,
        menuEntry,
        processCount: snapshot.processCount,
        cpu: snapshot.cpu,
        responsive: true,
        search: true,
        shellStillOpen,
        screenshotPath,
      },
      null,
      2,
    ),
  );
} finally {
  shellClient?.socket.close();
  performanceClient?.socket.close();
  await stop(child);
  await fs
    .rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 200,
    })
    .catch(() => undefined);
}
