import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const executable = path.join(
  root,
  "out",
  "Chromecraft-win32-x64",
  "chromecraft.exe",
);
const profile = path.join(root, ".artifacts", "profile-settings-scroll-repro");
const screenshotPath = path.join(
  root,
  ".artifacts",
  "settings-scroll-fixed.png",
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
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text);
    }
    return result.result.value;
  }

  close() {
    this.socket.close();
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
await fs.rm(profile, { recursive: true, force: true });
await fs.mkdir(profile, { recursive: true });
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
    () => cdp.evaluate("document.querySelectorAll('button').length"),
    (count) => count > 0,
    "the browser shell UI",
  );
  const result = await cdp.evaluate(`(async () => {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const settingsButton = [...document.querySelectorAll('button')].find((button) =>
      [button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent]
        .filter(Boolean)
        .some((value) => /settings/i.test(value))
    );
    if (!settingsButton) {
      return {
        pass: false,
        reason: 'No Settings button was found.',
        controls: [...document.querySelectorAll('button, [role="button"], a')]
          .slice(0, 40)
          .map((element) => ({
            tag: element.tagName,
            className: String(element.className),
            ariaLabel: element.getAttribute('aria-label'),
            title: element.getAttribute('title'),
            text: element.textContent?.trim(),
          })),
      };
    }
    settingsButton.click();
    await delay(100);
    const hyperdriveHeading = [...document.querySelectorAll('*')]
      .filter((element) => {
        const text = element.textContent?.trim() ?? '';
        return /performance/i.test(text) && /hyperdrive/i.test(text);
      })
      .sort((left, right) =>
        (left.textContent?.length ?? 0) - (right.textContent?.length ?? 0)
      )[0];
    if (!hyperdriveHeading) {
      return {
        pass: false,
        reason: 'The Hyperdrive settings section was not rendered.',
        text: document.body.innerText.slice(0, 4000),
      };
    }
    const ancestors = [];
    let element = hyperdriveHeading;
    while (element) {
      const style = getComputedStyle(element);
      ancestors.push({
        className: String(element.className),
        overflowY: style.overflowY,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      });
      element = element.parentElement;
    }
    const scrollContainer = ancestors.find((entry) =>
      ['auto', 'scroll'].includes(entry.overflowY) &&
      entry.scrollHeight > entry.clientHeight
    );
    if (!scrollContainer) {
      return {
        pass: false,
        reason: 'No vertically scrollable ancestor owns the overflowing settings content.',
        ancestors,
      };
    }
    const node = [...hyperdriveHeading.parentElement.querySelectorAll('*'), hyperdriveHeading.parentElement]
      .find((candidate) => {
        const style = getComputedStyle(candidate);
        return ['auto', 'scroll'].includes(style.overflowY) && candidate.scrollHeight > candidate.clientHeight;
      }) ?? (() => {
        let candidate = hyperdriveHeading;
        while (candidate) {
          const style = getComputedStyle(candidate);
          if (['auto', 'scroll'].includes(style.overflowY) && candidate.scrollHeight > candidate.clientHeight) return candidate;
          candidate = candidate.parentElement;
        }
        return null;
      })();
    if (!node) return { pass: false, reason: 'Scrollable ancestor could not be resolved.' };
    node.scrollTop = node.scrollHeight;
    await delay(50);
    const masterSwitch = document.querySelector('input[aria-label="Hyperdrive enabled"]');
    const ramSlider = document.querySelector('input[type="range"][aria-label="Hyperdrive RAM reserve"]');
    const devSwitch = document.querySelector('input[aria-label="Hyperdrive Dev mode"]');
    const controlsPresent = masterSwitch instanceof HTMLInputElement &&
      ramSlider instanceof HTMLInputElement &&
      devSwitch instanceof HTMLInputElement;
    if (!controlsPresent) {
      return {
        pass: false,
        reason: 'One or more requested Hyperdrive controls are missing.',
        scrollTop: node.scrollTop,
        masterSwitchFound: masterSwitch instanceof HTMLInputElement,
        ramSliderFound: ramSlider instanceof HTMLInputElement,
        devSwitchFound: devSwitch instanceof HTMLInputElement,
      };
    }
    masterSwitch.click();
    await delay(100);
    const activeRamSlider = document.querySelector('input[type="range"][aria-label="Hyperdrive RAM reserve"]');
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    valueSetter?.call(activeRamSlider, '512');
    activeRamSlider?.dispatchEvent(new Event('input', { bubbles: true }));
    activeRamSlider?.dispatchEvent(new Event('change', { bubbles: true }));
    devSwitch.click();
    await delay(150);
    const snapshot = await window.chromecraft.getSnapshot();
    const behaviorPass = snapshot.preferences.hyperdriveMode === 'balanced' &&
      snapshot.preferences.hyperdriveRamBudgetMb === 512 &&
      snapshot.preferences.hyperdriveMonitorOpen === true;
    return {
      pass: node.scrollTop > 0 && behaviorPass,
      reason: node.scrollTop <= 0
        ? 'The settings panel rejected programmatic vertical scrolling.'
        : !behaviorPass
          ? 'A requested Hyperdrive control did not update persisted browser state.'
          : null,
      scrollTop: node.scrollTop,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      masterSwitchFound: true,
      ramSliderFound: true,
      devSwitchFound: true,
      preferences: {
        hyperdriveMode: snapshot.preferences.hyperdriveMode,
        hyperdriveRamBudgetMb: snapshot.preferences.hyperdriveRamBudgetMb,
        hyperdriveMonitorOpen: snapshot.preferences.hyperdriveMonitorOpen,
        hyperdriveDeveloperMode: snapshot.preferences.hyperdriveDeveloperMode,
      },
    };
  })()`);
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
  });
  await fs.writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
  console.log(JSON.stringify({ ...result, screenshotPath }, null, 2));
  if (!result.pass) process.exitCode = 1;
} finally {
  cdp?.close();
  await stop(child);
}
