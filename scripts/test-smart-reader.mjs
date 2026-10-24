import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
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
  path.join(os.tmpdir(), "chromecraft-reader-test-"),
);
const paragraph =
  "Smart Reader extracts the useful story while keeping the live website untouched underneath. ".repeat(
    12,
  );

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string") throw new Error("No free port.");
  return address.port;
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
        () => reject(new Error("CDP connection timeout.")),
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
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await operation();
      if (predicate(last)) return last;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(
    `Timed out waiting for ${description}: ${JSON.stringify(last)}`,
  );
}

async function targets(port) {
  return fetch(`http://127.0.0.1:${port}/json/list`).then((response) =>
    response.json(),
  );
}

async function stop(child) {
  if (!child.pid || child.exitCode !== null) return;
  const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
  await new Promise((resolve) => killer.once("exit", resolve));
}

const fixturePort = await freePort();
const fixtureServer = createServer((request, response) => {
  if (request.url === "/image.png") {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xf6qAAAAAElFTkSuQmCC",
        "base64",
      ),
    );
    return;
  }
  if (request.url === "/nonarticle") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      "<!doctype html><title>Search</title><nav>" +
        Array.from(
          { length: 40 },
          (_, index) => `<a href='/${index}'>Result ${index}</a>`,
        ).join("") +
        "</nav>",
    );
    return;
  }
  if (request.url === "/delayed") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      `<!doctype html><title>Delayed article</title><main id="root">Loading…</main><script>setTimeout(()=>{document.querySelector('#root').innerHTML='<article><h1>Delayed article</h1><p>${paragraph}</p><p>${paragraph}</p></article>'},9500)</script>`,
    );
    return;
  }
  response.writeHead(200, { "content-type": "text/html" });
  response.end(
    `<!doctype html><html><head><title>Reader fixture</title><meta name="author" content="Chromecraft Test"><meta property="article:published_time" content="2026-10-24"></head><body><input id="preserved" value="initial"><div style="height:900px"></div><article><h1>Reader fixture</h1><p>${paragraph}</p><h2>Code and data</h2><pre><code>const reader = true;</code></pre><table><tbody><tr><th>Feature</th><td>Preserved</td></tr></tbody></table><img src="/image.png" alt="Fixture pixel"><a href="#details">Jump</a><h2 id="details">Details</h2><p>${paragraph}</p></article></body></html>`,
  );
});
await new Promise((resolve, reject) => {
  fixtureServer.once("error", reject);
  fixtureServer.listen(fixturePort, "127.0.0.1", resolve);
});

const debugPort = await freePort();
const child = spawn(
  executable,
  [
    `--chromecraft-user-data=${profile}`,
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
  ],
  { cwd: root, windowsHide: true, stdio: "ignore" },
);

let shell;
let source;
let reader;
try {
  const shellTarget = await poll(
    () => targets(debugPort),
    (items) =>
      items.some(
        (item) => item.type === "page" && item.title === "Chromecraft",
      ),
    "Chromecraft shell",
    20_000,
  ).then((items) =>
    items.find((item) => item.type === "page" && item.title === "Chromecraft"),
  );
  shell = await CdpClient.connect(shellTarget.webSocketDebuggerUrl);
  await poll(
    () => shell.evaluate("Boolean(window.chromecraft)"),
    Boolean,
    "shell API",
  );
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/article`;
  await shell.evaluate(
    `(async()=>{const snapshot=await window.chromecraft.getSnapshot();await window.chromecraft.navigate(snapshot.activeTabId,${JSON.stringify(fixtureUrl)},true)})()`,
  );
  const sourceTarget = await poll(
    () => targets(debugPort),
    (items) => items.some((item) => item.url === fixtureUrl),
    "fixture target",
  ).then((items) => items.find((item) => item.url === fixtureUrl));
  source = await CdpClient.connect(sourceTarget.webSocketDebuggerUrl);
  await poll(
    () => source.evaluate("Boolean(document.querySelector('#preserved'))"),
    Boolean,
    "fixture document",
  );
  await source.evaluate(
    "document.querySelector('#preserved').value='keep me';scrollTo(0,620);true",
  );
  await poll(
    () =>
      shell.evaluate(
        "Boolean(document.querySelector('[data-smart-reader-button]'))",
      ),
    Boolean,
    "Reader toolbar button",
  );
  const placement = await shell.evaluate(
    `(()=>{const o=document.querySelector('.omnibox-form').getBoundingClientRect();const b=document.querySelector('[data-smart-reader-button]').getBoundingClientRect();return {gap:b.left-o.right,overlap:b.left<o.right,inside:b.right<=innerWidth}})()`,
  );
  if (
    placement.overlap ||
    !placement.inside ||
    placement.gap < 0 ||
    placement.gap > 16
  ) {
    throw new Error(
      `Reader button placement regression: ${JSON.stringify(placement)}`,
    );
  }
  const toolbarLayouts = [];
  for (const { width, height, deviceScaleFactor, buttonWidth } of [
    { width: 1366, height: 900, deviceScaleFactor: 1, buttonWidth: 40 },
    { width: 640, height: 700, deviceScaleFactor: 1.5, buttonWidth: 38 },
  ]) {
    await shell.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const layout = await shell.evaluate(
      `(()=>{const toolbar=document.querySelector('.toolbar');const omnibox=document.querySelector('.omnibox-form');const button=document.querySelector('[data-smart-reader-button]');const cluster=document.querySelector('.reader-toolbar-cluster');if(!toolbar||!omnibox||!button||!cluster)return null;const t=toolbar.getBoundingClientRect(),o=omnibox.getBoundingClientRect(),b=button.getBoundingClientRect(),c=cluster.getBoundingClientRect();return {width:innerWidth,toolbarHeight:t.height,toolbarScrollHeight:toolbar.scrollHeight,buttonWidth:b.width,buttonHeight:b.height,buttonInside:b.top>=t.top&&b.bottom<=t.bottom,centerAligned:Math.abs((b.top+b.height/2)-(o.top+o.height/2))<1,afterOmnibox:b.left>=o.right&&b.left-o.right<=16,clusterHeight:c.height,hasLabel:Boolean(document.querySelector('.reader-button-label'))}})()`,
    );
    if (
      !layout ||
      !layout.buttonInside ||
      !layout.centerAligned ||
      !layout.afterOmnibox ||
      layout.toolbarScrollHeight > Math.ceil(layout.toolbarHeight) ||
      Math.abs(layout.buttonWidth - buttonWidth) > 0.1 ||
      layout.hasLabel
    ) {
      throw new Error(
        `Reader toolbar layout regression: ${JSON.stringify(layout)}`,
      );
    }
    toolbarLayouts.push(layout);
  }
  await shell.send("Emulation.clearDeviceMetricsOverride");
  await shell.evaluate(
    "document.querySelector('[data-smart-reader-button]').click()",
  );
  const readerTarget = await poll(
    () => targets(debugPort),
    (items) =>
      items.some((item) => item.url.startsWith("chromecraft-reader://")),
    "isolated Reader target",
  ).then((items) =>
    items.find((item) => item.url.startsWith("chromecraft-reader://")),
  );
  reader = await CdpClient.connect(readerTarget.webSocketDebuggerUrl);
  const articleState = await poll(
    () =>
      reader.evaluate(
        `(()=>({title:document.querySelector('h1')?.textContent,table:Boolean(document.querySelector('table')),code:Boolean(document.querySelector('pre code')),image:Boolean(document.querySelector('img')),fragmentTarget:Boolean(document.querySelector('#details')),fragmentLink:document.querySelector('a[href^="#"]')?.getAttribute('href'),summaryButton:document.querySelector('[data-action="generate"]')?.textContent?.trim(),scriptCount:document.scripts.length,overflow:document.documentElement.scrollWidth>innerWidth}))()`,
      ),
    (value) => value.title === "Reader fixture",
    "rendered Reader article",
  );
  if (
    !articleState.table ||
    !articleState.code ||
    !articleState.image ||
    !articleState.fragmentTarget ||
    articleState.fragmentLink !== "#details" ||
    articleState.summaryButton !== "✦Summarise with Scout" ||
    articleState.scriptCount ||
    articleState.overflow
  ) {
    throw new Error(
      `Reader content regression: ${JSON.stringify(articleState)}`,
    );
  }
  const summarySettings = await reader.evaluate(
    `(()=>{document.querySelector('[data-action="settings"]')?.click();return {ollama:[...document.querySelectorAll('[data-provider]')].some(button=>button.textContent==='Local Ollama'),gemini:[...document.querySelectorAll('[data-provider]')].some(button=>button.textContent==='Google Gemini'),cloudDisclosure:document.querySelector('.scout-cloud-note')?.textContent}})()`,
  );
  if (!summarySettings.ollama || !summarySettings.gemini) {
    throw new Error(
      `Reader summary settings regression: ${JSON.stringify(summarySettings)}`,
    );
  }
  await poll(
    () =>
      shell.evaluate(
        "Boolean(document.querySelector('[data-smart-reader-appearance-button]'))",
      ),
    Boolean,
    "active Reader toolbar state",
  );
  await shell.evaluate(
    "document.querySelector('[data-smart-reader-appearance-button]').click()",
  );
  const popoverBounds = await poll(
    () =>
      shell.evaluate(
        `(()=>{const p=document.querySelector('[data-smart-reader-appearance]');if(!p)return null;const r=p.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width}})()`,
      ),
    Boolean,
    "appearance popover",
  );
  const viewport = await shell.evaluate(
    "({width:innerWidth,height:innerHeight})",
  );
  if (
    popoverBounds.left < 0 ||
    popoverBounds.top < 0 ||
    popoverBounds.right > viewport.width ||
    popoverBounds.bottom > viewport.height
  ) {
    throw new Error(
      `Appearance popover clipped: ${JSON.stringify({ popoverBounds, viewport })}`,
    );
  }
  await shell.evaluate("document.querySelector('.reader-theme-warm').click()");
  await poll(
    () =>
      reader.evaluate(
        "getComputedStyle(document.documentElement).getPropertyValue('--paper').trim()",
      ),
    (value) => value === "#f4ecd8",
    "warm Reader theme",
  );
  await shell.evaluate(
    "document.querySelector('[data-smart-reader-button]').click()",
  );
  await poll(
    () =>
      shell.evaluate(
        "document.querySelector('[data-smart-reader-button]')?.getAttribute('data-active')",
      ),
    (value) => value === "false",
    "Reader exit",
  );
  const preserved = await source.evaluate(
    "({value:document.querySelector('#preserved').value,scrollY})",
  );
  if (preserved.value !== "keep me" || preserved.scrollY < 500) {
    throw new Error(
      `Original page state was not preserved: ${JSON.stringify(preserved)}`,
    );
  }
  const screenshot = await reader.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const screenshotPath = path.join(profile, "smart-reader-warm.png");
  await fs.writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
  const delayedUrl = `http://127.0.0.1:${fixturePort}/delayed`;
  await shell.evaluate(
    `(async()=>{const snapshot=await window.chromecraft.getSnapshot();await window.chromecraft.navigate(snapshot.activeTabId,${JSON.stringify(delayedUrl)},true)})()`,
  );
  await poll(
    () =>
      shell.evaluate(
        `(async()=>{const snapshot=await window.chromecraft.getSnapshot();const tab=snapshot.tabs.find(item=>item.id===snapshot.activeTabId);return {url:tab?.url,availability:tab?.reader?.availability,button:Boolean(document.querySelector('[data-smart-reader-button]'))}})()`,
      ),
    (value) =>
      value.url === delayedUrl &&
      value.availability === "available" &&
      value.button,
    "dynamic article detection",
    20_000,
  );
  const nonarticleUrl = `http://127.0.0.1:${fixturePort}/nonarticle`;
  const nonarticleTabId = await shell.evaluate(
    `(async()=>{const snapshot=await window.chromecraft.getSnapshot();await window.chromecraft.navigate(snapshot.activeTabId,${JSON.stringify(nonarticleUrl)},true);return snapshot.activeTabId})()`,
  );
  await poll(
    () =>
      shell.evaluate(
        `(async()=>{const snapshot=await window.chromecraft.getSnapshot();const tab=snapshot.tabs.find(item=>item.id===snapshot.activeTabId);return {url:tab?.url,availability:tab?.reader?.availability,button:Boolean(document.querySelector('[data-smart-reader-button]'))}})()`,
      ),
    (value) =>
      value.url === nonarticleUrl &&
      value.availability === "unavailable" &&
      !value.button,
    "non-article rejection",
  );
  const manualNegative = await shell.evaluate(
    `(async()=>window.chromecraft.trySmartReader(${JSON.stringify(nonarticleTabId)},{theme:'system',font:'serif',textScale:1}))()`,
  );
  if (manualNegative.active || manualNegative.availability === "available") {
    throw new Error(
      `Manual Reader created a false-positive surface: ${JSON.stringify(manualNegative)}`,
    );
  }
  const realSites = [];
  if (process.argv.includes("--real-sites")) {
    for (const url of [
      "https://en.wikipedia.org/wiki/History_of_the_Internet",
      "https://developer.mozilla.org/en-US/docs/Web/API/Document_Object_Model/Introduction",
    ]) {
      const startedAt = Date.now();
      try {
        await shell.evaluate(
          `(async()=>{const snapshot=await window.chromecraft.getSnapshot();await window.chromecraft.navigate(snapshot.activeTabId,${JSON.stringify(url)},true)})()`,
        );
        await poll(
          () =>
            shell.evaluate(
              `(async()=>{const snapshot=await window.chromecraft.getSnapshot();const tab=snapshot.tabs.find(item=>item.id===snapshot.activeTabId);return {url:tab?.url,availability:tab?.reader?.availability,button:Boolean(document.querySelector('[data-smart-reader-button]'))}})()`,
            ),
          (value) => value.button && value.availability === "available",
          `Reader availability for ${url}`,
          25_000,
        );
        realSites.push({
          url,
          status: "available",
          elapsedMs: Date.now() - startedAt,
        });
      } catch (error) {
        realSites.push({ url, status: "unavailable", detail: error.message });
      }
    }
    if (!realSites.some((item) => item.status === "available")) {
      throw new Error(
        `No real-world Reader check succeeded: ${JSON.stringify(realSites)}`,
      );
    }
  }
  process.stdout.write(
    `${JSON.stringify({ placement, articleState, preserved, dynamicDetection: "available", nonArticle: manualNegative.availability, screenshotPath, realSites }, null, 2)}\n`,
  );
} finally {
  reader?.close();
  source?.close();
  shell?.close();
  await stop(child);
  await new Promise((resolve) => fixtureServer.close(resolve));
}
