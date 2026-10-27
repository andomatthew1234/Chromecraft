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
  path.join(os.tmpdir(), "chromecraft-sidebar-test-"),
);
const screenshotPath = path.join(root, ".artifacts", "sidebar-menu.png");
const updatesScreenshotPath = path.join(
  root,
  ".artifacts",
  "updates-and-versions.png",
);
const quickSettingsScreenshotPath = path.join(
  root,
  ".artifacts",
  "quick-settings-sidebar.png",
);
const galleryScreenshotPath = path.join(
  root,
  ".artifacts",
  "gallery-sidebar.png",
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
await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
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
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      return response.json();
    },
    (targets) =>
      targets.some(
        (entry) =>
          entry.type === "page" &&
          (entry.url.startsWith("file://") ||
            entry.url.includes("main_window")) &&
          entry.webSocketDebuggerUrl,
      ),
    "the Chromecraft shell target",
    20_000,
  ).then((targets) =>
    targets.find(
      (entry) =>
        entry.type === "page" &&
        (entry.url.startsWith("file://") ||
          entry.url.includes("main_window")) &&
        entry.webSocketDebuggerUrl,
    ),
  );
  cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await poll(
    () => cdp.evaluate("Boolean(window.chromecraft)"),
    Boolean,
    "the shell API",
  );
  await poll(
    () => cdp.evaluate('Boolean(document.querySelector(".sidebar"))'),
    Boolean,
    "the initial sidebar",
  );

  await cdp.evaluate(
    "document.querySelector('button[aria-label=\"Chromecraft menu\"]')?.click()",
  );
  await poll(
    () =>
      cdp.evaluate(`Boolean([...document.querySelectorAll('[role="menuitem"]')]
        .find((item) => item.textContent?.includes('Collapse sidebar')))`),
    Boolean,
    "the Collapse sidebar menu action",
  );
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
  });
  await fs.writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));

  await cdp.evaluate(`([...document.querySelectorAll('[role="menuitem"]')]
    .find((item) => item.textContent?.includes('Updates and versions')))?.click()`);
  const updatesPageReady = await poll(
    () =>
      cdp.evaluate(`Boolean(
        document.querySelector('.update-centre') &&
        document.querySelector('[data-category="extensions"]') &&
        document.querySelector('[data-category="dependencies"]') &&
        document.querySelector('[data-category="chromecraft"]') &&
        [...document.querySelectorAll('button')].some(
          (button) => button.textContent?.includes('Update All')
        )
      )`),
    Boolean,
    "the Updates and versions page",
  );
  const versionsInitiallyHidden = await cdp.evaluate(`
    !document.querySelector('#version-info') &&
    Boolean([...document.querySelectorAll('button')].find(
      (button) => button.textContent?.includes('Technical details')
    ))
  `);
  if (!versionsInitiallyHidden) {
    throw new Error("Installed versions must stay hidden until requested.");
  }
  await cdp.evaluate(`([...document.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('Technical details')))?.click()`);
  const versionsRevealed = await poll(
    () => cdp.evaluate("Boolean(document.querySelector('#version-info'))"),
    Boolean,
    "the installed version information",
  );
  await cdp.evaluate(`([...document.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('Update All')))?.click()`);
  const portableUpdateStatus = await poll(
    () =>
      cdp.evaluate(
        `document.querySelector('.update-status-card')?.getAttribute('data-status')`,
      ),
    (status) => status === "partial",
    "the portable-build update status",
  );
  const updatesScreenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
  });
  await fs.writeFile(
    updatesScreenshotPath,
    Buffer.from(updatesScreenshot.data, "base64"),
  );
  await cdp.evaluate(
    "document.querySelector('button[aria-label=\"Back to browsing\"]')?.click()",
  );
  await cdp.evaluate(
    "document.querySelector('button[aria-label=\"Chromecraft menu\"]')?.click()",
  );

  await cdp.evaluate(`([...document.querySelectorAll('[role="menuitem"]')]
    .find((item) => item.textContent?.includes('Collapse sidebar')))?.click()`);
  await poll(
    () =>
      cdp.evaluate(`(async () => ({
        attached: (await window.chromecraft.getSnapshot()).preferences.sidebarAttached,
        sidebarPresent: Boolean(document.querySelector('.sidebar'))
      }))()`),
    (state) => !state.attached && !state.sidebarPresent,
    "the sidebar to disappear completely",
  );

  await cdp.evaluate(
    "document.querySelector('button[aria-label=\"Chromecraft menu\"]')?.click()",
  );
  await poll(
    () =>
      cdp.evaluate(`Boolean([...document.querySelectorAll('[role="menuitem"]')]
        .find((item) => item.textContent?.includes('Expand sidebar')))`),
    Boolean,
    "the Expand sidebar menu action",
  );
  await cdp.evaluate(`([...document.querySelectorAll('[role="menuitem"]')]
    .find((item) => item.textContent?.includes('Expand sidebar')))?.click()`);
  await poll(
    () =>
      cdp.evaluate(`(async () => ({
        attached: (await window.chromecraft.getSnapshot()).preferences.sidebarAttached,
        sidebarPresent: Boolean(document.querySelector('.sidebar'))
      }))()`),
    (state) => state.attached && state.sidebarPresent,
    "the sidebar to reattach",
  );

  await cdp.evaluate(
    "document.querySelector('button[aria-label=\"YouTube & My Gallery\"]')?.click()",
  );
  const gallerySidebarState = await poll(
    () =>
      cdp.evaluate(`(() => {
        const panel = document.querySelector('.gallery-sidebar-panel');
        const action = document.querySelector('.gallery-sidebar-open');
        const title = action?.querySelector('strong');
        const heading = document.querySelector('.gallery-sidebar-heading');
        return {
          present: Boolean(panel && action && heading),
          horizontalOverflow: Boolean(panel && panel.scrollWidth > panel.clientWidth + 1),
          actionHeight: action?.getBoundingClientRect().height ?? 0,
          actionTitleFits: Boolean(title && title.scrollWidth <= title.clientWidth + 1),
        };
      })()`),
    (state) =>
      state.present &&
      !state.horizontalOverflow &&
      state.actionHeight >= 47 &&
      state.actionHeight <= 52 &&
      state.actionTitleFits,
    "the compact Gallery sidebar layout",
  );
  const galleryScreenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
  });
  await fs.writeFile(
    galleryScreenshotPath,
    Buffer.from(galleryScreenshot.data, "base64"),
  );

  await cdp.evaluate(
    "document.querySelector('button[aria-label=\"Extensions\"]')?.click()",
  );
  const extensionsSidebarWidth = await poll(
    () =>
      cdp.evaluate(
        "document.querySelector('.sidebar.panel-open')?.getBoundingClientRect().width || 0",
      ),
    (width) => width >= 354 && width <= 366,
    "the Extensions sidebar to reach its open width",
  );
  await cdp.evaluate(
    "document.querySelector('button[aria-label=\"Settings\"]')?.click()",
  );
  const quickSettingsState = await poll(
    () =>
      cdp.evaluate(`(async () => {
        const sidebar = document.querySelector('.sidebar');
        const panel = document.querySelector('.quick-settings-sidebar');
        const grid = document.querySelector('.quick-settings-grid');
        const tiles = [...document.querySelectorAll('.quick-setting-tile')];
        const panelBox = panel?.getBoundingClientRect();
        return {
          sidebarOpen: (await window.chromecraft.getSnapshot()).preferences.sidebarOpen,
          settingsActive: Boolean(document.querySelector('button[aria-label="Settings"].active')),
          title: document.querySelector('#sidebar-panel-title')?.textContent,
          width: sidebar?.getBoundingClientRect().width ?? 0,
          tileCount: tiles.length,
          hasOverlay: Boolean(document.querySelector('.quick-settings-layer')),
          horizontalOverflow: Boolean(grid && grid.scrollWidth > grid.clientWidth),
          verticalOverflow: Boolean(grid && grid.scrollHeight > grid.clientHeight + 1),
          tilesContained: Boolean(panelBox && tiles.every((tile) => {
            const box = tile.getBoundingClientRect();
            return box.left >= panelBox.left && box.right <= panelBox.right + 0.5;
          })),
        };
      })()`),
    (state) =>
      state.sidebarOpen &&
      state.settingsActive &&
      state.title === "Quick settings" &&
      Math.abs(state.width - extensionsSidebarWidth) < 0.5 &&
      state.tileCount === 5 &&
      !state.hasOverlay &&
      !state.horizontalOverflow &&
      !state.verticalOverflow &&
      state.tilesContained,
    "Quick settings to render inside the standard sidebar",
  );
  const quickSettingsScreenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
  });
  await fs.writeFile(
    quickSettingsScreenshotPath,
    Buffer.from(quickSettingsScreenshot.data, "base64"),
  );

  await cdp.evaluate(
    "document.querySelector('button[aria-label=\"History\"]')?.click()",
  );
  await poll(
    () =>
      cdp.evaluate(`Boolean(
        document.querySelector('button[aria-label="History"].active') &&
        document.querySelector('#sidebar-panel')
      )`),
    Boolean,
    "History to open and illuminate",
  );
  await cdp.evaluate(
    "document.querySelector('button[aria-label=\"History\"]')?.click()",
  );
  const toggledClosed = await poll(
    () =>
      cdp.evaluate(`(async () => ({
        panelOpen: (await window.chromecraft.getSnapshot()).preferences.sidebarOpen,
        railOnly: Boolean(document.querySelector('.sidebar.rail-only')),
        active: Boolean(document.querySelector('.sidebar-rail button.active')),
        panel: Boolean(document.querySelector('#sidebar-panel'))
      }))()`),
    (state) =>
      !state.panelOpen && state.railOnly && !state.active && !state.panel,
    "History to close and deilluminate",
  );

  await cdp.evaluate(
    "document.querySelector('button[aria-label=\"Collapse sidebar\"]')?.click()",
  );
  const railCollapse = await poll(
    () =>
      cdp.evaluate(`(async () => ({
        attached: (await window.chromecraft.getSnapshot()).preferences.sidebarAttached,
        sidebarPresent: Boolean(document.querySelector('.sidebar'))
      }))()`),
    (state) => !state.attached && !state.sidebarPresent,
    "the rail Collapse sidebar control to detach the sidebar",
  );

  console.log(
    JSON.stringify(
      {
        pass: true,
        updatesPageReady,
        versionsInitiallyHidden,
        versionsRevealed,
        portableUpdateStatus,
        extensionsSidebarWidth,
        quickSettingsState,
        gallerySidebarState,
        toggledClosed,
        railCollapse,
        screenshotPath,
        updatesScreenshotPath,
        quickSettingsScreenshotPath,
        galleryScreenshotPath,
      },
      null,
      2,
    ),
  );
} finally {
  cdp?.close();
  await stop(child);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => undefined);
}
