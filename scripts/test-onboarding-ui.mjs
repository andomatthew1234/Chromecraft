import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
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
  path.join(os.tmpdir(), "chromecraft-onboarding-test-"),
);
const artifactDirectory = path.join(root, ".artifacts");
const testLocalAi = process.env.CHROMECRAFT_TEST_ONBOARDING_LOCAL_AI === "1";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string") {
    throw new Error("Could not reserve a debugging port.");
  }
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out.`));
      }, 10_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
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
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(
    `Timed out waiting for ${description}: ${JSON.stringify(last)}`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function screenshot(cdp, name) {
  await new Promise((resolve) => setTimeout(resolve, 420));
  const result = await cdp.send("Page.captureScreenshot", { format: "png" });
  const target = path.join(artifactDirectory, name);
  await fs.writeFile(target, Buffer.from(result.data, "base64"));
  return target;
}

async function click(cdp, selector) {
  const clicked = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return false;
    element.click();
    return true;
  })()`);
  assert(clicked, `Could not click ${selector}.`);
}

async function assertPage(cdp, heading) {
  const page = await poll(
    () =>
      cdp.evaluate(`(() => ({
        heading: document.querySelector('.onboarding-page h1')?.textContent?.trim(),
        shellWidth: document.querySelector('.onboarding-shell')?.clientWidth ?? 0,
        shellScrollWidth: document.querySelector('.onboarding-shell')?.scrollWidth ?? 0,
        bodyWidth: document.body.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        visibleButtons: [...document.querySelectorAll('.onboarding-page button')]
          .filter((button) => button.getBoundingClientRect().height > 0).length,
      }))()`),
    (result) => result.heading === heading,
    heading,
  );
  assert(page.visibleButtons > 0, `${heading} has no visible controls.`);
  assert(
    page.shellScrollWidth <= page.shellWidth + 1 &&
      page.bodyScrollWidth <= page.bodyWidth + 1,
    `${heading} overflows horizontally: ${JSON.stringify(page)}`,
  );
  return page;
}

async function stop(child) {
  if (!child.pid || child.exitCode !== null) return;
  const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
  await new Promise((resolve) => killer.once("exit", resolve));
}

async function removeProfile() {
  const retryableCodes = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fs.rm(profile, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!retryableCodes.has(error?.code) || attempt === 59) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

await fs.access(executable);
await fs.mkdir(artifactDirectory, { recursive: true });
const port = await freePort();
const child = spawn(
  executable,
  [
    `--chromecraft-user-data=${profile}`,
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--chromecraft-show-onboarding",
    "--no-first-run",
  ],
  { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
child.stderr?.on("data", (chunk) => process.stderr.write(chunk));

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
    "the Chromecraft shell",
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
  await assertPage(cdp, "Get to know us.");
  const featureScreenshot = await screenshot(cdp, "onboarding-features.png");

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 760,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const narrowPage = await assertPage(cdp, "Get to know us.");
  assert(
    narrowPage.viewportWidth <= 760,
    `The narrow viewport did not resize: ${JSON.stringify(narrowPage)}`,
  );
  const narrowScreenshot = await screenshot(
    cdp,
    "onboarding-features-narrow.png",
  );
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await new Promise((resolve) => setTimeout(resolve, 250));

  await click(cdp, ".onboarding-footer .onboarding-button.filled");
  await assertPage(cdp, "Choose some essentials.");
  const essentialsScreenshot = await screenshot(
    cdp,
    "onboarding-essentials.png",
  );

  await click(cdp, ".onboarding-footer .onboarding-button.filled");
  await assertPage(cdp, "Let's work out AI.");
  await click(cdp, ".onboarding-choice-card.choice-gemini");
  const choiceState = await cdp.evaluate(`(() => ({
    pressed: document.querySelector('.choice-gemini')?.getAttribute('aria-pressed'),
    continueDisabled: document.querySelector('.onboarding-footer .onboarding-button.filled')?.disabled,
  }))()`);
  assert(
    choiceState.pressed === "true",
    "Gemini choice did not become selected.",
  );
  assert(
    choiceState.continueDisabled === false,
    "Gemini setup did not become available.",
  );
  const aiScreenshot = await screenshot(cdp, "onboarding-ai.png");

  await click(cdp, ".onboarding-footer .onboarding-button.filled");
  await assertPage(cdp, "Let's setup Gemini powered intelligence.");
  const geminiScreenshot = await screenshot(cdp, "onboarding-gemini-intro.png");
  const geminiSetupChoices = await cdp.evaluate(`(() => ({
    external: document.querySelector('[data-gemini-setup="external"]')?.textContent?.trim(),
    embedded: document.querySelector('[data-gemini-setup="embedded"]')?.textContent?.trim(),
  }))()`);
  assert(
    geminiSetupChoices.external?.includes("Use my signed-in browser"),
    `The fast Gemini setup route was not presented first: ${JSON.stringify(geminiSetupChoices)}`,
  );
  assert(
    geminiSetupChoices.embedded?.includes("Set up inside Chromecraft"),
    `The embedded Gemini setup fallback was missing: ${JSON.stringify(geminiSetupChoices)}`,
  );
  await click(cdp, '[data-gemini-setup="embedded"]');
  const guideBounds = await poll(
    () =>
      cdp.evaluate(`(() => {
        const frame = document.querySelector('.onboarding-native-frame');
        if (!frame) return null;
        const bounds = frame.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height };
      })()`),
    (bounds) => bounds?.width >= 320 && bounds?.height >= 240,
    "the embedded Gemini setup frame",
  );
  assert(guideBounds.width >= 320, "Gemini setup frame is too narrow.");
  const guideScreenshot = await screenshot(cdp, "onboarding-gemini-guide.png");

  await click(cdp, '[aria-label="Back to AI choices"]');
  await assertPage(cdp, "Let's work out AI.");
  let localAiScreenshot;
  if (testLocalAi) {
    await click(cdp, ".onboarding-choice-card.choice-gemini");
    await click(cdp, ".onboarding-choice-card.choice-ollama");
    await click(cdp, ".onboarding-footer .onboarding-button.filled");
    await assertPage(
      cdp,
      "Let's setup Local AI powered by Ollama on your device.",
    );
    await poll(
      () =>
        cdp.evaluate(
          `document.querySelectorAll('.onboarding-setup-tile').length`,
        ),
      (tileCount) => tileCount === 3,
      "the Local AI setup tiles",
    );
    localAiScreenshot = await screenshot(cdp, "onboarding-local-ai.png");
    await click(cdp, ".onboarding-footer .onboarding-button.text");
    await assertPage(cdp, "Let's work out AI.");
  }
  await click(cdp, ".onboarding-choice-card.choice-skip");
  const skipState = await cdp.evaluate(`(() => ({
    skipPressed: document.querySelector('.choice-skip')?.getAttribute('aria-pressed'),
    geminiPressed: document.querySelector('.choice-gemini')?.getAttribute('aria-pressed'),
  }))()`);
  assert(skipState.skipPressed === "true", "Skip AI did not become selected.");
  assert(
    skipState.geminiPressed === "false",
    "Selecting Skip AI did not clear the Gemini selection.",
  );
  await click(cdp, ".onboarding-footer .onboarding-button.filled");
  await assertPage(cdp, "Use recommended settings or change them.");
  const settingsDefaults = await cdp.evaluate(`(() => ({
    switches: [...document.querySelectorAll('.onboarding-setting-row input')]
      .map((input) => ({ checked: input.checked, label: input.getAttribute('aria-label') })),
  }))()`);
  assert(
    JSON.stringify(settingsDefaults.switches.map((input) => input.checked)) ===
      JSON.stringify([true, true, true, true, false]),
    `Recommended settings defaults were unexpected: ${JSON.stringify(settingsDefaults)}`,
  );
  const settingsScreenshot = await screenshot(
    cdp,
    "onboarding-recommended-settings.png",
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        screenshots: [
          featureScreenshot,
          narrowScreenshot,
          essentialsScreenshot,
          aiScreenshot,
          geminiScreenshot,
          guideScreenshot,
          ...(localAiScreenshot ? [localAiScreenshot] : []),
          settingsScreenshot,
        ],
      },
      null,
      2,
    ),
  );
} finally {
  cdp?.close();
  await stop(child);
  await removeProfile();
}
