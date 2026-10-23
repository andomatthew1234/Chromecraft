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
const useDefaultProfile = process.env.CHROMECRAFT_USE_DEFAULT_PROFILE === "1";
const keepOpen = process.env.CHROMECRAFT_KEEP_OPEN === "1";
const profile = useDefaultProfile
  ? null
  : await fs.mkdtemp(path.join(os.tmpdir(), "chromecraft-gallery-ui-test-"));
const artifacts = {
  desktop: path.join(root, ".artifacts", "gallery-desktop.png"),
  dark: path.join(root, ".artifacts", "gallery-dark.png"),
  narrow: path.join(root, ".artifacts", "gallery-narrow.png"),
  player: path.join(root, ".artifacts", "gallery-player.png"),
};

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

async function poll(operation, predicate, description, timeoutMs = 15_000) {
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
  throw new Error(
    `Timed out waiting for ${description}: ${JSON.stringify(last)}`,
  );
}

async function stop(child) {
  if (!child?.pid || child.exitCode !== null) return;
  const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
  await new Promise((resolve) => killer.once("exit", resolve));
}

async function capture(cdp, file) {
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  await fs.writeFile(file, Buffer.from(screenshot.data, "base64"));
}

function readLayoutExpression() {
  return `(() => {
    const page = document.querySelector('.gallery-page');
    const collection = document.querySelector('.gallery-collection');
    const brokenImages = [...document.querySelectorAll('.gallery-page img')]
      .filter((image) => image.complete && image.naturalWidth === 0).length;
    return {
      title: document.querySelector('.gallery-hero h1')?.textContent,
      cards: document.querySelectorAll('.gallery-card').length,
      setupBanner: Boolean(document.querySelector('.gallery-smart-downloads-banner')),
      statusBanner: Boolean(document.querySelector('.gallery-status-banner')),
      repairAction: Boolean(document.querySelector('.gallery-repair-button')),
      nativeSelects: document.querySelectorAll('.gallery-page select').length,
      brokenImages,
      pageOverflow: Boolean(page && page.scrollWidth > page.clientWidth + 1),
      collectionOverflow: Boolean(collection && collection.scrollWidth > collection.clientWidth + 1),
      width: page?.clientWidth ?? 0,
    };
  })()`;
}

await fs.access(executable);
await fs.mkdir(path.dirname(artifacts.desktop), { recursive: true });
const port = await freePort();
const args = [
  `--remote-debugging-port=${port}`,
  "--remote-debugging-address=127.0.0.1",
  "--no-first-run",
];
if (profile) {
  args.unshift(`--user-data-dir=${profile}`);
  args.unshift(`--chromecraft-user-data=${profile}`);
}
const child = spawn(executable, args, {
  cwd: root,
  windowsHide: true,
  stdio: "ignore",
});

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
  await cdp.evaluate("window.chromecraft.openGallery()");
  await poll(
    () => cdp.evaluate("Boolean(document.querySelector('.gallery-page'))"),
    Boolean,
    "My Gallery",
  );

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 940,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const desktop = await cdp.evaluate(readLayoutExpression());
  await capture(cdp, artifacts.desktop);

  const hasSortTrigger = await cdp.evaluate(
    "Boolean(document.querySelector('.gallery-select-trigger'))",
  );
  let sortMenuAccessible = null;
  if (hasSortTrigger) {
    await cdp.evaluate(
      "document.querySelector('.gallery-select-trigger')?.click()",
    );
    sortMenuAccessible = await poll(
      () => cdp.evaluate("Boolean(document.querySelector('[role=listbox]'))"),
      Boolean,
      "the Gallery sort menu",
    );
    await cdp.evaluate(
      "document.querySelector('.gallery-select-trigger')?.click()",
    );
  }

  const hasCardMenu = await cdp.evaluate(
    "Boolean(document.querySelector('.gallery-menu-trigger'))",
  );
  let cardMenuAccessible = null;
  if (hasCardMenu) {
    await cdp.evaluate(
      "document.querySelector('.gallery-menu-trigger')?.click()",
    );
    cardMenuAccessible = await poll(
      () => cdp.evaluate("Boolean(document.querySelector('[role=menu]'))"),
      Boolean,
      "a Gallery card menu",
    );
    await cdp.evaluate(
      "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))",
    );
  }

  await cdp.evaluate("document.documentElement.dataset.theme = 'dark'");
  await new Promise((resolve) => setTimeout(resolve, 200));
  await capture(cdp, artifacts.dark);
  await cdp.evaluate("delete document.documentElement.dataset.theme");

  const canOpenRepair = await cdp.evaluate(
    "!document.querySelector('.gallery-repair-button')?.disabled",
  );
  let repairDialogAccessible = null;
  if (canOpenRepair) {
    await cdp.evaluate(
      "document.querySelector('.gallery-repair-button')?.click()",
    );
    repairDialogAccessible = await poll(
      () =>
        cdp.evaluate(`(() => ({
          dialog: Boolean(document.querySelector('#gallery-repair-title')),
          local: [...document.querySelectorAll('.gallery-repair-dialog button')]
            .some((button) => button.textContent?.includes('Repair locally')),
          remote: [...document.querySelectorAll('.gallery-repair-dialog button')]
            .some((button) => button.textContent?.includes('Fetch originals')),
        }))()`),
      (state) => state.dialog && state.local && state.remote,
      "the Gallery repair consent dialog",
    );
    await cdp.evaluate(
      "document.querySelector('.gallery-repair-dialog .tonal-button')?.click()",
    );
  }

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 820,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 350));
  const narrow = await cdp.evaluate(readLayoutExpression());
  await capture(cdp, artifacts.narrow);

  let player = null;
  if (narrow.cards > 0) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 820,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.evaluate("document.querySelector('.gallery-card-main')?.click()");
    player = await poll(
      () =>
        cdp.evaluate(`(() => {
          const page = document.querySelector('.gallery-player-page');
          const video = document.querySelector('.gallery-player-stage video');
          return {
            visible: Boolean(page),
            title: document.querySelector('.gallery-player-heading h1')?.textContent,
            scrubber: Boolean(document.querySelector('.gallery-media-scrubber')),
            play: Boolean(document.querySelector('[aria-label="Play video"], [aria-label="Pause video"]')),
            pip: Boolean(document.querySelector('[aria-label="Picture in picture"]')),
            fullscreen: Boolean(document.querySelector('[aria-label="Enter fullscreen"]')),
            mediaBound: video?.getAttribute('src')?.startsWith('chromecraft-media://video/') ?? false,
            overflow: Boolean(page && page.scrollWidth > page.clientWidth + 1),
          };
        })()`),
      (state) =>
        state.visible &&
        state.scrubber &&
        state.play &&
        state.pip &&
        state.fullscreen &&
        state.mediaBound &&
        !state.overflow,
      "the Gallery player controls and local media",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await capture(cdp, artifacts.player);
  }

  for (const [name, state] of Object.entries({ desktop, narrow })) {
    if (
      state.title !== "My Gallery" ||
      !state.repairAction ||
      state.nativeSelects !== 0 ||
      state.brokenImages !== 0 ||
      state.pageOverflow ||
      state.collectionOverflow
    ) {
      throw new Error(
        `Invalid ${name} Gallery layout: ${JSON.stringify(state)}`,
      );
    }
  }

  console.log(
    JSON.stringify(
      {
        pass: true,
        profile: useDefaultProfile ? "default" : "isolated",
        desktop,
        narrow,
        sortMenuAccessible,
        cardMenuAccessible,
        repairDialogAccessible,
        player,
        artifacts,
      },
      null,
      2,
    ),
  );
} finally {
  cdp?.close();
  if (!keepOpen) await stop(child);
  if (profile) {
    await fs
      .rm(profile, { recursive: true, force: true })
      .catch(() => undefined);
  }
}
