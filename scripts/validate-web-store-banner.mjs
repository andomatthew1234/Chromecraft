import { execFile as execFileCallback, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = process.cwd();
const executable = path.join(
  root,
  "out",
  "Chromecraft-win32-x64",
  "chromecraft.exe",
);
const extensionId = "nngceckbapebfimnlniiiahkandclblb";
const listingUrl = `https://chromewebstore.google.com/detail/bitwarden-password-manager/${extensionId}`;
const artifactDirectory = path.join(root, ".artifacts", "extensions");
const reportPath = path.join(artifactDirectory, "web-store-banner.json");
const screenshotPath = path.join(
  artifactDirectory,
  "web-store-banner-shell.png",
);
const reviewScreenshotPath = path.join(
  artifactDirectory,
  "web-store-banner-review.png",
);
const installedScreenshotPath = path.join(
  artifactDirectory,
  "web-store-banner-installed.png",
);

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
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string") {
    throw new Error("Could not reserve a DevTools port.");
  }
  return address.port;
}

async function poll(operation, predicate, description, timeoutMs = 30_000) {
  const startedAt = Date.now();
  let lastValue;
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastValue = await operation();
      if (predicate(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await delay(75);
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
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text,
      );
    }
    return response.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function targetList(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok)
    throw new Error(`DevTools returned HTTP ${response.status}.`);
  return response.json();
}

async function terminate(child) {
  if (!child?.pid || child.exitCode !== null) return;
  await execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    windowsHide: true,
  }).catch(() => child.kill());
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5_000),
  ]);
}

await fs.access(executable);
await fs.mkdir(artifactDirectory, { recursive: true });
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "chromecraft-web-store-banner-"),
);
await fs.writeFile(
  path.join(profile, "preferences.json"),
  `${JSON.stringify({ restoreSession: false, ublockEnabled: false }, null, 2)}\n`,
  "utf8",
);

let child;
let shell;
let page;
let log = "";
let report;
try {
  const debugPort = await findFreePort();
  child = spawn(
    executable,
    [
      `--chromecraft-user-data=${profile}`,
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`,
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
  child.stdout.on("data", (chunk) => (log += chunk.toString()));
  child.stderr.on("data", (chunk) => (log += chunk.toString()));

  const shellTarget = await poll(
    () => targetList(debugPort),
    (targets) =>
      targets.some(
        (target) =>
          target.type === "page" &&
          (target.url.startsWith("file://") ||
            target.url.includes("main_window")),
      ),
    "the Chromecraft shell target",
  ).then((targets) =>
    targets.find(
      (target) =>
        target.type === "page" &&
        (target.url.startsWith("file://") ||
          target.url.includes("main_window")),
    ),
  );
  shell = await CdpClient.connect(shellTarget.webSocketDebuggerUrl);
  const initial = await poll(
    () => shell.evaluate("window.chromecraft?.getSnapshot()"),
    (snapshot) => Boolean(snapshot?.activeTabId),
    "the browser shell to initialize",
  );
  await shell.evaluate(
    `window.chromecraft.navigate(${JSON.stringify(initial.activeTabId)}, ${JSON.stringify(listingUrl)})`,
  );

  const shown = await poll(
    () =>
      shell.evaluate(`(async () => {
        const snapshot = await window.chromecraft.getSnapshot();
        const banner = document.querySelector(".extension-install-banner");
        const button = banner?.querySelector(".extension-install-banner__button--filled");
        const style = banner ? getComputedStyle(banner) : null;
        const rect = banner?.getBoundingClientRect();
        return {
          snapshot,
          banner: banner ? {
            text: banner.textContent,
            state: banner.getAttribute("data-state"),
            button: button?.textContent ?? null,
            height: rect?.height ?? null,
            backgroundImage: style?.backgroundImage ?? null,
          } : null,
        };
      })()`),
    (value) =>
      value?.snapshot?.webStoreListing?.extensionId === extensionId &&
      value.snapshot.chromeHeight - value.snapshot.baseChromeHeight === 88 &&
      value?.banner?.state === "available" &&
      value.banner.button?.includes("Review & install") &&
      value.banner.height === 88 &&
      value.banner.backgroundImage !== "none",
    "the browser-owned Web Store banner",
  );

  const pageTarget = await poll(
    () => targetList(debugPort),
    (targets) =>
      targets.some(
        (target) =>
          target.type === "page" &&
          target.url.includes(extensionId) &&
          target.url.startsWith("https://chromewebstore.google.com/"),
      ),
    "the Chrome Web Store page target",
    45_000,
  ).then((targets) =>
    targets.find(
      (target) =>
        target.type === "page" &&
        target.url.includes(extensionId) &&
        target.url.startsWith("https://chromewebstore.google.com/"),
    ),
  );
  page = await CdpClient.connect(pageTarget.webSocketDebuggerUrl);
  const pageUntouched = await page.evaluate(
    `!document.querySelector(".extension-install-banner")`,
  );

  const metadataShown = await poll(
    () =>
      shell.evaluate(`(async () => {
        const snapshot = await window.chromecraft.getSnapshot();
        return {
          title: snapshot.webStoreListing?.title ?? null,
          description: snapshot.webStoreListing?.description ?? null,
          bannerText: document.querySelector(".extension-install-banner")?.textContent ?? null,
        };
      })()`),
    (value) =>
      /bitwarden/iu.test(value?.title ?? "") &&
      /bitwarden/iu.test(value?.bannerText ?? ""),
    "the listing overview metadata",
    45_000,
  );

  await shell.send("Page.enable");
  const capture = await shell.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  await fs.writeFile(screenshotPath, Buffer.from(capture.data, "base64"));

  const reviewStarted = await shell.evaluate(`(() => {
    window.__chromecraftBannerProgress = [];
    window.__chromecraftBannerProgressCleanup = window.chromecraft.onExtensions(
      (snapshot) => window.__chromecraftBannerProgress.push({
        operation: snapshot.operation,
        stage: snapshot.progress?.stage ?? null,
        label: snapshot.progress?.label ?? null,
        percent: snapshot.progress?.percent ?? null,
      }),
    );
    const button = document.querySelector(
      ".extension-install-banner__button--filled",
    );
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  if (!reviewStarted)
    throw new Error("The Review & install action was unavailable.");

  const review = await poll(
    () =>
      shell.evaluate(`(async () => {
        const extensions = await window.chromecraft.getExtensions();
        const dialog = document.querySelector(".material-dialog");
        const banner = document.querySelector(".extension-install-banner");
        return {
          extensions,
          dialogText: dialog?.textContent ?? null,
          bannerState: banner?.getAttribute("data-state") ?? null,
          progress: window.__chromecraftBannerProgress ?? [],
        };
      })()`),
    (value) =>
      value?.extensions?.operation === "idle" &&
      value.extensions.items?.length === 0 &&
      value.bannerState === "awaiting-confirmation" &&
      /install bitwarden/iu.test(value.dialogText ?? "") &&
      /permissions/iu.test(value.dialogText ?? ""),
    "the verified extension review dialog",
    120_000,
  );
  const observedStages = new Set(review.progress.map((item) => item.stage));
  if (
    !observedStages.has("downloading") ||
    !observedStages.has("verifying") ||
    !observedStages.has("preparing")
  ) {
    throw new Error(
      `The live review progress was incomplete: ${JSON.stringify(review.progress)}`,
    );
  }
  const reviewCapture = await shell.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  await fs.writeFile(
    reviewScreenshotPath,
    Buffer.from(reviewCapture.data, "base64"),
  );

  const packageWasNotPublishedBeforeConfirmation = await fs
    .access(path.join(profile, "extensions", extensionId))
    .then(() => false)
    .catch((error) => error?.code === "ENOENT");
  if (!packageWasNotPublishedBeforeConfirmation) {
    throw new Error("Reviewing published extension files before confirmation.");
  }

  const installConfirmed = await shell.evaluate(`(() => {
    const buttons = document.querySelectorAll(".dialog-actions button");
    const install = buttons.item(buttons.length - 1);
    if (!(install instanceof HTMLButtonElement)) return false;
    install.click();
    return true;
  })()`);
  if (!installConfirmed) {
    throw new Error("The install confirmation was unavailable.");
  }
  const installed = await poll(
    () =>
      shell.evaluate(`(async () => {
        const extensions = await window.chromecraft.getExtensions();
        const banner = document.querySelector(".extension-install-banner");
        return {
          extensions,
          bannerState: banner?.getAttribute("data-state") ?? null,
          bannerText: banner?.textContent ?? null,
          progress: window.__chromecraftBannerProgress ?? [],
        };
      })()`),
    (value) =>
      value?.extensions?.operation === "idle" &&
      value.extensions.items?.some(
        (item) => item.id === extensionId && item.ready === true,
      ) &&
      value.bannerState === "installed" &&
      /installed/iu.test(value.bannerText ?? ""),
    "the installed banner state",
    60_000,
  );
  const installedStages = new Set(installed.progress.map((item) => item.stage));
  if (!installedStages.has("installing") || !installedStages.has("finishing")) {
    throw new Error(
      `The live installation progress was incomplete: ${JSON.stringify(installed.progress)}`,
    );
  }
  const installedCapture = await shell.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
  });
  await fs.writeFile(
    installedScreenshotPath,
    Buffer.from(installedCapture.data, "base64"),
  );

  await shell.evaluate(
    `document.querySelector(".extension-install-banner__button--danger")?.click()`,
  );
  await poll(
    () =>
      shell.evaluate(`document.querySelector(".material-dialog")?.textContent`),
    (text) => /remove bitwarden/iu.test(text ?? ""),
    "the removal confirmation",
  );
  await shell.evaluate(
    `document.querySelector(".dialog-actions .destructive-action")?.click()`,
  );
  const removed = await poll(
    () =>
      shell.evaluate(`(async () => {
        const extensions = await window.chromecraft.getExtensions();
        const banner = document.querySelector(".extension-install-banner");
        return {
          extensions,
          bannerState: banner?.getAttribute("data-state") ?? null,
          bannerText: banner?.textContent ?? null,
        };
      })()`),
    (value) =>
      value?.extensions?.operation === "idle" &&
      value.extensions.items?.every((item) => item.id !== extensionId) &&
      value.bannerState === "available",
    "the confirmed extension removal",
  );
  await shell.evaluate("window.__chromecraftBannerProgressCleanup?.()");
  const packageWasRemoved = await fs
    .access(path.join(profile, "extensions", extensionId))
    .then(() => false)
    .catch((error) => error?.code === "ENOENT");
  if (!packageWasRemoved) {
    throw new Error("Removing the extension left its package in the profile.");
  }

  await shell.evaluate(
    `document.querySelector(".extension-install-banner__dismiss")?.click()`,
  );
  const dismissed = await poll(
    () =>
      shell.evaluate(`(async () => {
        const snapshot = await window.chromecraft.getSnapshot();
        return {
          chromeHeight: snapshot.chromeHeight,
          baseChromeHeight: snapshot.baseChromeHeight,
          listing: snapshot.webStoreListing,
          bannerPresent: Boolean(document.querySelector(".extension-install-banner")),
        };
      })()`),
    (value) =>
      value?.listing === null &&
      value.chromeHeight === value.baseChromeHeight &&
      value.bannerPresent === false,
    "the tab-scoped banner dismissal",
  );

  report = {
    success: pageUntouched === true,
    listingUrl,
    shown,
    metadataShown,
    pageUntouched,
    review,
    packageWasNotPublishedBeforeConfirmation,
    installed,
    removed,
    packageWasRemoved,
    dismissed,
    screenshotPath: path.relative(root, screenshotPath),
    reviewScreenshotPath: path.relative(root, reviewScreenshotPath),
    installedScreenshotPath: path.relative(root, installedScreenshotPath),
  };
} catch (error) {
  report = {
    success: false,
    listingUrl,
    error: error?.stack ?? error?.message ?? String(error),
    log,
  };
} finally {
  page?.close();
  shell?.close();
  await terminate(child);
  const resolvedProfile = path.resolve(profile);
  const temporaryRoot = path.resolve(os.tmpdir());
  if (
    path.dirname(resolvedProfile) === temporaryRoot &&
    path.basename(resolvedProfile).startsWith("chromecraft-web-store-banner-")
  ) {
    await fs.rm(resolvedProfile, { recursive: true, force: true });
  }
}

await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (!report.success) process.exitCode = 1;
