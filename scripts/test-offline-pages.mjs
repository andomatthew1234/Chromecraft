import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import WebSocket from "ws";

const root = process.cwd();
const executable = path.resolve(
  process.env.CHROMECRAFT_EXECUTABLE ??
    path.join(root, "out", "Chromecraft-win32-x64", "chromecraft.exe"),
);
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "chromecraft-offline-pages-test-"),
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
  if (!port) throw new Error("Could not reserve a port.");
  return port;
}

async function poll(read, accept, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (accept(last)) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}: ${String(last)}`);
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

async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return response.json();
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await new Promise((resolve) => killer.once("exit", resolve));
  } else {
    child.kill("SIGKILL");
  }

  if (child.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
}

const fixturePort = await freePort();
const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;
const fixtureServer = http.createServer((request, response) => {
  if (request.url === "/style.css") {
    response.writeHead(200, { "content-type": "text/css" });
    response.end("body { background-color: rgb(12, 34, 56); color: white; }");
    return;
  }
  if (request.url === "/pixel.svg") {
    response.writeHead(200, { "content-type": "image/svg+xml" });
    response.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="lime"/></svg>',
    );
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
    <html><head><title>Offline fixture</title><link rel="stylesheet" href="/style.css"></head>
    <body><h1 id="saved-heading">Saved for later</h1><img id="saved-image" src="/pixel.svg">
    <script>window.__offlineScriptExecuted = true;</script></body></html>`);
});
await new Promise((resolve, reject) => {
  fixtureServer.once("error", reject);
  fixtureServer.listen(fixturePort, "127.0.0.1", resolve);
});

const debuggingPort = await freePort();
const child = spawn(
  executable,
  [
    `--chromecraft-user-data=${profile}`,
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debuggingPort}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
  ],
  { cwd: root, windowsHide: true, stdio: "ignore" },
);

let shell;
let archive;
try {
  const shellTarget = await poll(
    () => targets(debuggingPort),
    (items) =>
      items.some(
        (item) =>
          item.type === "page" &&
          item.title === "Chromecraft" &&
          item.webSocketDebuggerUrl,
      ),
    "the Chromecraft shell target",
  ).then((items) =>
    items.find(
      (item) =>
        item.type === "page" &&
        item.title === "Chromecraft" &&
        item.webSocketDebuggerUrl,
    ),
  );
  shell = await CdpClient.connect(shellTarget.webSocketDebuggerUrl);
  await poll(
    () => shell.evaluate("Boolean(window.chromecraft)"),
    Boolean,
    "the shell API",
  );

  const tabId = await shell.evaluate(
    `window.chromecraft.createTab(${JSON.stringify(fixtureUrl)})`,
  );
  await poll(
    () =>
      shell.evaluate(`window.chromecraft.getSnapshot().then(snapshot => {
        const tab = snapshot.tabs.find(candidate => candidate.id === ${JSON.stringify(tabId)});
        return Boolean(tab && !tab.isLoading && tab.url === ${JSON.stringify(fixtureUrl)});
      })`),
    Boolean,
    "the fixture page",
  );

  await poll(
    () =>
      shell.evaluate("Boolean(document.querySelector('.omnibox-site-button'))"),
    Boolean,
    "the page actions button",
  );
  await shell.evaluate(
    "document.querySelector('.omnibox-site-button').click()",
  );
  const menuCopy = await shell.evaluate(
    "document.querySelector('.page-actions-popover')?.textContent ?? ''",
  );
  for (const label of ["Page Security", "Save for later", "Share page"]) {
    if (!menuCopy.includes(label))
      throw new Error(`Page action is missing: ${label}`);
  }
  await shell.evaluate(
    "[...document.querySelectorAll('.page-action-row')].find(button => button.textContent.includes('Share page')).click()",
  );
  await poll(
    () =>
      shell.evaluate(
        "[...document.querySelectorAll('.page-action-row')].some(button => button.textContent.includes('Create QR'))",
      ),
    Boolean,
    "the Create QR action",
  );
  await shell.evaluate(
    "[...document.querySelectorAll('.page-action-row')].find(button => button.textContent.includes('Create QR')).click()",
  );
  await poll(
    () =>
      shell.evaluate(
        "document.querySelector('.page-qr-view img')?.src.startsWith('data:image/png') === true",
      ),
    Boolean,
    "a locally generated QR code",
  );
  await shell.evaluate(
    "document.querySelector('.omnibox-site-button').click()",
  );

  const entry = await shell.evaluate(
    `window.chromecraft.savePageForOffline(${JSON.stringify(tabId)})`,
  );
  if (!entry?.id || !entry.archiveUrl.startsWith("chromecraft-offline://")) {
    throw new Error(`Offline capture failed: ${JSON.stringify(entry)}`);
  }
  await shell.evaluate(
    `window.chromecraft.openOfflinePages(${JSON.stringify(entry.id)})`,
  );
  const cardText = await poll(
    () =>
      shell.evaluate(
        "document.querySelector('.offline-page-card')?.textContent ?? ''",
      ),
    (value) =>
      value.includes("Offline fixture") && value.includes("Open offline"),
    "the Offline Pages card",
  );

  await new Promise((resolve) => fixtureServer.close(resolve));
  await shell.evaluate(
    `window.chromecraft.openOfflinePage(${JSON.stringify(entry.id)})`,
  );
  const archiveTarget = await poll(
    () => targets(debuggingPort),
    (items) =>
      items.some(
        (item) => item.url === entry.archiveUrl && item.webSocketDebuggerUrl,
      ),
    "the offline archive tab",
  ).then((items) => items.find((item) => item.url === entry.archiveUrl));
  archive = await CdpClient.connect(archiveTarget.webSocketDebuggerUrl);
  const replay = await poll(
    () =>
      archive.evaluate(`(() => ({
        heading: document.querySelector('#saved-heading')?.textContent ?? '',
        imageLoaded: document.querySelector('#saved-image')?.complete === true && document.querySelector('#saved-image')?.naturalWidth > 0,
        background: getComputedStyle(document.body).backgroundColor,
        scriptRan: window.__offlineScriptExecuted === true
      }))()`),
    (value) => value.heading === "Saved for later" && value.imageLoaded,
    "the fully rendered offline copy",
  );
  if (replay.background !== "rgb(12, 34, 56)") {
    throw new Error(`Offline stylesheet did not load: ${replay.background}`);
  }
  if (replay.scriptRan)
    throw new Error("Saved page scripts were not disabled.");

  console.log(
    JSON.stringify(
      {
        pass: true,
        entry: { id: entry.id, fileSize: entry.fileSize },
        menu: menuCopy.replaceAll(/\s+/g, " ").trim(),
        card: cardText.replaceAll(/\s+/g, " ").trim(),
        replay,
      },
      null,
      2,
    ),
  );
} finally {
  archive?.close();
  shell?.close();
  if (fixtureServer.listening) {
    await new Promise((resolve) => fixtureServer.close(resolve));
  }
  await stopProcess(child);
  await fs.rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}
