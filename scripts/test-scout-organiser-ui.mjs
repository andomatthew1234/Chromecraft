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
  path.join(await fs.realpath(os.tmpdir()), "chromecraft-organiser-ui-"),
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

async function capture(cdp, name) {
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const target = path.join(artifactDir, name);
  await fs.writeFile(target, Buffer.from(screenshot.data, "base64"));
  return target;
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

let cdp;
try {
  const target = await poll(
    () =>
      fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
        response.json(),
      ),
    (targets) =>
      targets.some(
        (entry) =>
          entry.type === "page" &&
          entry.url.startsWith("file://") &&
          entry.webSocketDebuggerUrl,
      ),
    "the Chromecraft shell",
  ).then((targets) =>
    targets.find(
      (entry) =>
        entry.type === "page" &&
        entry.url.startsWith("file://") &&
        entry.webSocketDebuggerUrl,
    ),
  );
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  cdp = new CdpClient(socket);
  await poll(
    () => cdp.evaluate('Boolean(document.querySelector(".app-shell"))'),
    Boolean,
    "the rendered browser shell",
  );
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.evaluate(
    "document.querySelector('button[aria-label=\"Chromecraft menu\"]')?.click()",
  );
  await poll(
    () =>
      cdp.evaluate(`Boolean([...document.querySelectorAll('[role="menuitem"]')]
        .find((item) => item.textContent?.includes('Organise tabs')))`),
    Boolean,
    "the Organise tabs menu action",
  );
  await cdp.evaluate(`([...document.querySelectorAll('[role="menuitem"]')]
    .find((item) => item.textContent?.includes('Organise tabs')))?.click()`);
  await poll(
    () => cdp.evaluate('Boolean(document.querySelector(".ai-tools-panel"))'),
    Boolean,
    "the Scout organiser",
  );
  const setup = await cdp.evaluate(`(() => {
    const panel = document.querySelector('.ai-tools-panel');
    const methods = [...panel.querySelectorAll('.scout-method-grid > button')];
    const bounds = panel.getBoundingClientRect();
    return {
      labels: methods.map((button) => button.textContent.trim()),
      pressed: methods.filter((button) => button.getAttribute('aria-pressed') === 'true').length,
      hasModelControl: Boolean(panel.querySelector('.ai-compact-model')),
      overflow: panel.scrollWidth - panel.clientWidth,
      bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
    };
  })()`);
  assert(
    setup.labels.length === 3,
    "Expected exactly three organisation methods.",
  );
  assert(setup.pressed === 1, "Expected exactly one selected method.");
  assert(
    setup.hasModelControl,
    "The selected AI method should expose model configuration.",
  );
  assert(setup.overflow <= 1, "The organiser overflowed horizontally.");
  const setupScreenshot = await capture(cdp, "scout-organiser-setup.png");

  await cdp.evaluate(`([...document.querySelectorAll('.scout-method-grid > button')]
    .find((button) => button.textContent?.includes('Sort by website')))?.click()`);
  await poll(
    () =>
      cdp.evaluate(`document.querySelector('.scout-method-grid > button[aria-pressed="true"]')
        ?.textContent?.includes('Sort by website')`),
    Boolean,
    "website sorting selection",
  );
  assert(
    !(await cdp.evaluate(
      'Boolean(document.querySelector("#organiser-model"))',
    )),
    "Website sorting should not show model configuration.",
  );

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 720,
    height: 560,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  const compactExpression = `(() => {
      const panel = document.querySelector('.ai-tools-panel');
      const bounds = panel.getBoundingClientRect();
      return {
        right: bounds.right,
        bottom: bounds.bottom,
        overflow: panel.scrollWidth - panel.clientWidth,
        animation: getComputedStyle(panel).animationName,
        footerVisible: Boolean(document.querySelector('.ai-tools-footer')),
      };
    })()`;
  const compact = await poll(
    () => cdp.evaluate(compactExpression),
    (value) => value.right <= 720 && value.bottom <= 560,
    "compact organiser relayout",
  );
  assert(compact.right <= 720, "Compact organiser escaped the viewport width.");
  assert(
    compact.bottom <= 560,
    "Compact organiser escaped the viewport height.",
  );
  assert(compact.overflow <= 1, "Compact organiser overflowed horizontally.");
  assert(
    compact.animation === "none",
    "Reduced motion did not disable dialog animation.",
  );
  assert(compact.footerVisible, "Compact organiser footer is missing.");
  const compactScreenshot = await capture(
    cdp,
    "scout-organiser-compact-reduced-motion.png",
  );
  console.log(
    JSON.stringify(
      { setup, compact, setupScreenshot, compactScreenshot },
      null,
      2,
    ),
  );
} finally {
  cdp?.socket.close();
  if (child.exitCode === null) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await new Promise((resolve) => killer.once("exit", resolve));
  }
  await fs.rm(profile, { recursive: true, force: true }).catch(() => undefined);
}
