import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const executable = path.resolve(
  process.env.CHROMECRAFT_EXECUTABLE ??
    path.join(root, "out", "Chromecraft-win32-x64", "chromecraft.exe"),
);
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "chromecraft-toolbar-test-"),
);

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
      userGesture: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function poll(operation, predicate, description, timeoutMs = 10_000) {
  const startedAt = Date.now();
  let last;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      last = await operation();
      if (predicate(last)) return last;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}: ${String(last)}`);
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

let cdp;
try {
  const isShellTarget = (entry) =>
    entry.type === "page" &&
    entry.webSocketDebuggerUrl &&
    entry.title === "Chromecraft" &&
    (entry.url.startsWith("file:") || entry.url.startsWith("http://localhost"));
  const target = await poll(
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      return response.json();
    },
    (targets) => targets.some(isShellTarget),
    "the Chromecraft shell target",
    20_000,
  ).then((targets) => targets.find(isShellTarget));
  cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await poll(
    () => cdp.evaluate("Boolean(window.chromecraft)"),
    Boolean,
    "the shell API",
  );
  await poll(
    () =>
      cdp.evaluate(
        "Boolean(document.querySelector('.tab') && document.querySelector('.new-tab-button'))",
      ),
    Boolean,
    "the initial browser chrome",
  );

  const layout = await cdp.evaluate(`(() => {
    const tab = [...document.querySelectorAll('.tab')].at(-1).getBoundingClientRect();
    const plus = document.querySelector('.new-tab-button').getBoundingClientRect();
    const dots = [...document.querySelectorAll('.toolbar-status-dot')]
      .map((dot) => dot.getBoundingClientRect())
      .map(({ width, height }) => ({ width, height }));
    return {
      adjacent: plus.left - tab.right >= 0 && plus.left - tab.right <= 12,
      plusInsideScroller: document.querySelector('.new-tab-button').parentElement.classList.contains('tab-scroller'),
      dots
    };
  })()`);
  if (!layout.adjacent || !layout.plusInsideScroller) {
    throw new Error(`New-tab placement regression: ${JSON.stringify(layout)}`);
  }
  if (
    layout.dots.length !== 2 ||
    layout.dots.some(
      (dot) =>
        dot.width !== layout.dots[0].width ||
        dot.height !== layout.dots[0].height,
    )
  ) {
    throw new Error(`Status-dot sizing regression: ${JSON.stringify(layout)}`);
  }

  const sidebarBefore = await cdp.evaluate(`(async () => {
    const { sidebarAttached, sidebarOpen } = (await window.chromecraft.getSnapshot()).preferences;
    return { sidebarAttached, sidebarOpen };
  })()`);
  await cdp.evaluate(
    `document.querySelector('button[aria-label^="Extensions."]')?.click()`,
  );
  const menu = await poll(
    () =>
      cdp.evaluate(`(() => {
        const button = document.querySelector('button[aria-label^="Extensions."]');
        const menu = document.querySelector('.extensions-menu');
        if (!button || !menu) return null;
        const anchor = button.getBoundingClientRect();
        const surface = menu.getBoundingClientRect();
        return { below: surface.top >= anchor.bottom, expanded: button.getAttribute('aria-expanded') };
      })()`),
    (value) => value?.below && value.expanded === "true",
    "the anchored extensions menu",
  );
  const sidebarAfter = await cdp.evaluate(`(async () => {
    const { sidebarAttached, sidebarOpen } = (await window.chromecraft.getSnapshot()).preferences;
    return { sidebarAttached, sidebarOpen };
  })()`);
  if (JSON.stringify(sidebarBefore) !== JSON.stringify(sidebarAfter)) {
    throw new Error("Opening the extensions menu changed sidebar state.");
  }

  await cdp.evaluate(`document.body.click()`);
  await cdp.evaluate(
    `document.querySelector('button[aria-label="Find in page"]')?.click()`,
  );
  const findBefore = await poll(
    () =>
      cdp.evaluate(`(() => {
        const bar = document.querySelector('.find-bar');
        const handle = document.querySelector('.find-drag-handle');
        if (!bar || !handle) return null;
        const rect = bar.getBoundingClientRect();
        const grip = handle.getBoundingClientRect();
        return { x: rect.x, y: rect.y, gripX: grip.x + grip.width / 2, gripY: grip.y + grip.height / 2, label: handle.textContent };
      })()`),
    Boolean,
    "the Find in page drag handle",
  );
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: findBefore.gripX,
    y: findBefore.gripY,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: findBefore.gripX - 120,
    y: findBefore.gripY + 80,
    button: "left",
    buttons: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: findBefore.gripX - 120,
    y: findBefore.gripY + 80,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  const findAfter = await poll(
    () =>
      cdp.evaluate(`(() => {
        const rect = document.querySelector('.find-bar').getBoundingClientRect();
        return { x: rect.x, y: rect.y };
      })()`),
    (rect) =>
      Math.abs(rect.x - findBefore.x) > 40 &&
      Math.abs(rect.y - findBefore.y) > 40,
    "the Find in page surface to move",
  );

  const tabPoint = await cdp.evaluate(`(() => {
    const rect = document.querySelector('.tab').getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: tabPoint.x,
    y: tabPoint.y,
  });
  const hoverCard = await poll(
    () =>
      cdp.evaluate(`(() => {
        const card = document.querySelector('.tab-hover-card');
        return card ? { text: card.textContent, nativeTitle: document.querySelector('.tab-target')?.hasAttribute('title') } : null;
      })()`),
    (value) => Boolean(value?.text) && value.nativeTitle === false,
    "the Material tab hover card",
  );

  console.log(
    JSON.stringify(
      { pass: true, layout, menu, findBefore, findAfter, hoverCard },
      null,
      2,
    ),
  );
} finally {
  cdp?.close();
  await stop(child);
}
