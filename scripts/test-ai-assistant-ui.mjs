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
const tempRoot = await fs.realpath(os.tmpdir());
const profile = await fs.mkdtemp(
  path.join(tempRoot, "chromecraft-ai-ui-test-"),
);
const screenshotPath = path.join(
  root,
  ".artifacts",
  "ai-assistant-refinement.png",
);
const contextScreenshotPath = path.join(
  root,
  ".artifacts",
  "ai-assistant-context-short-window.png",
);
const darkScreenshotPath = path.join(
  root,
  ".artifacts",
  "ai-assistant-dark-reduced-motion.png",
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

async function poll(operation, predicate, description, timeoutMs = 12_000) {
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
  const detail = typeof last === "object" ? JSON.stringify(last) : String(last);
  throw new Error(`Timed out waiting for ${description}: ${detail}`);
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
  { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
child.stderr?.on("data", (chunk) => process.stderr.write(chunk));

let cdp;
let loggedTargets = false;
try {
  cdp = await poll(
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      if (!loggedTargets && targets.length > 0) {
        loggedTargets = true;
        console.log(
          "CDP targets:",
          targets.map(({ type, title, url }) => ({ type, title, url })),
        );
      }
      for (const target of targets.filter(
        (entry) =>
          entry.type === "page" &&
          entry.webSocketDebuggerUrl &&
          (entry.title === "Chromecraft" ||
            entry.url.includes("main_window/index.html")),
      )) {
        const candidate = await CdpClient.connect(target.webSocketDebuggerUrl);
        try {
          if (
            await candidate.evaluate(
              'Boolean(document.querySelector(".app-shell"))',
            )
          ) {
            return candidate;
          }
        } catch {
          // Extension and webpage targets do not expose the trusted shell bridge.
        }
        candidate.close();
      }
      return null;
    },
    Boolean,
    "the Chromecraft shell target",
    60_000,
  );
  console.log("Connected to the rendered Chromecraft shell.");
  const hasAssistantButton = await cdp.evaluate(
    "Boolean(document.querySelector('button[aria-label=\"Scout\"]'))",
  );
  if (!hasAssistantButton) {
    console.error(
      "Assistant navigation was initially unavailable:",
      await cdp.evaluate(`({
        url: location.href,
        readyState: document.readyState,
        root: document.querySelector('#root')?.outerHTML,
        scripts: [...document.scripts].map((script) => script.src),
        body: document.body.innerText.slice(0, 600),
        buttons: [...document.querySelectorAll('button')].map((button) => ({
          label: button.getAttribute('aria-label'),
          text: button.textContent?.trim().slice(0, 80),
        })).slice(0, 30),
      })`),
    );
    await cdp.evaluate(
      "document.querySelector('button[aria-label=\"Chromecraft menu\"]')?.click()",
    );
    await poll(
      () =>
        cdp.evaluate(`Boolean([...document.querySelectorAll('[role="menuitem"]')]
          .find((item) => item.textContent?.includes('Expand sidebar')))`),
      Boolean,
      "the Expand sidebar action",
    );
    await cdp.evaluate(`([...document.querySelectorAll('[role="menuitem"]')]
      .find((item) => item.textContent?.includes('Expand sidebar')))?.click()`);
  }
  await poll(
    () =>
      cdp.evaluate(
        "Boolean(document.querySelector('button[aria-label=\"Scout\"]'))",
      ),
    Boolean,
    "the assistant navigation button",
  );
  await cdp.evaluate(`
    document.querySelector('button[aria-label="Scout"]')?.click()
  `);
  await poll(
    () =>
      cdp.evaluate('Boolean(document.querySelector(".ai-assistant-panel"))'),
    Boolean,
    "the assistant panel",
  );

  const widthResults = [];
  for (const width of [280, 320, 360, 420, 500]) {
    await cdp.evaluate(`(() => {
      document.documentElement.style.setProperty('--sidebar-width', '${width}px');
      const sidebar = document.querySelector('.sidebar');
      if (sidebar) {
        sidebar.style.transition = 'none';
        sidebar.style.width = '${width}px';
      }
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 360));
    const result = await cdp.evaluate(`(() => {
      const panel = document.querySelector('.ai-assistant-panel').getBoundingClientRect();
      const composer = document.querySelector('.ai-composer').getBoundingClientRect();
      const surface = document.querySelector('.ai-composer-surface').getBoundingClientRect();
      const textarea = document.querySelector('.ai-composer textarea').getBoundingClientRect();
      const send = document.querySelector('.ai-send').getBoundingClientRect();
      return {
        width: ${width},
        panel: { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom },
        composer: { left: composer.left, right: composer.right, top: composer.top, bottom: composer.bottom },
        surface: { left: surface.left, right: surface.right, top: surface.top, bottom: surface.bottom },
        textarea: { left: textarea.left, right: textarea.right, top: textarea.top, bottom: textarea.bottom },
        send: { left: send.left, right: send.right, top: send.top, bottom: send.bottom },
        scrollWidth: document.querySelector('.ai-assistant-panel').scrollWidth,
        clientWidth: document.querySelector('.ai-assistant-panel').clientWidth,
      };
    })()`);
    assert(
      result.composer.bottom <= result.panel.bottom + 0.5,
      `${width}px composer escaped the panel`,
    );
    assert(
      result.surface.bottom <= result.panel.bottom + 0.5,
      `${width}px composer surface was clipped`,
    );
    assert(
      result.send.right <= result.surface.right + 0.5,
      `${width}px send button overlapped the edge`,
    );
    assert(
      result.textarea.right <= result.surface.right + 0.5,
      `${width}px textarea overflowed`,
    );
    assert(
      result.scrollWidth <= result.clientWidth + 1,
      `${width}px assistant overflowed horizontally`,
    );
    assert(
      Math.abs(result.panel.right - result.panel.left - (width - 54)) < 2,
      `${width}px assistant panel did not reach its requested width`,
    );
    widthResults.push(result);
  }

  const avatarCounts = await cdp.evaluate(`({
    animated: document.querySelectorAll('.ai-character').length,
    staticAvatars: document.querySelectorAll('.ai-static-avatar').length,
    labelledByValid: Boolean(document.getElementById(
      document.querySelector('#sidebar-panel')?.getAttribute('aria-labelledby')
    )),
  })`);
  assert(
    avatarCounts.animated === 1,
    "Welcome screen must have exactly one animated avatar",
  );
  assert(
    avatarCounts.staticAvatars >= 2,
    "Rail and header need static assistant avatars",
  );
  assert(
    avatarCounts.labelledByValid,
    "Assistant panel accessible label is missing",
  );

  const heights = [];
  for (const lines of [1, 3, 5, 6]) {
    const value = Array.from(
      { length: lines },
      (_, index) => `Line ${index + 1}`,
    ).join("\n");
    await cdp.evaluate(`(() => {
      const textarea = document.querySelector('.ai-composer textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, ${JSON.stringify(value)});
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 340));
    heights.push(
      await cdp.evaluate(`(() => {
        const textarea = document.querySelector('.ai-composer textarea');
        return { lines: ${lines}, height: textarea.getBoundingClientRect().height, overflowY: getComputedStyle(textarea).overflowY };
      })()`),
    );
  }
  console.log("Textarea measurements:", heights);
  assert(
    heights[2].height > heights[0].height,
    "Textarea did not grow through five lines",
  );
  assert(
    Math.abs(heights[3].height - heights[2].height) < 2,
    "Textarea grew beyond five lines",
  );
  assert(
    heights[3].overflowY === "auto",
    "Six-line textarea did not enable internal scrolling",
  );

  await cdp.evaluate(`(() => {
    document.documentElement.style.setProperty('--sidebar-width', '280px');
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) {
      sidebar.style.width = '280px';
      sidebar.style.bottom = '300px';
    }
  })()`);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-motion", value: "no-preference" },
      { name: "prefers-color-scheme", value: "light" },
    ],
  });
  await cdp.evaluate("document.documentElement.dataset.theme = 'light'");
  await new Promise((resolve) => setTimeout(resolve, 360));
  const shortWindowContainment = await cdp.evaluate(`(() => {
    const panel = document.querySelector('.ai-assistant-panel').getBoundingClientRect();
    const composer = document.querySelector('.ai-composer').getBoundingClientRect();
    const surface = document.querySelector('.ai-composer-surface').getBoundingClientRect();
    return {
      panelBottom: panel.bottom,
      composerBottom: composer.bottom,
      surfaceBottom: surface.bottom,
      panelHeight: panel.height,
    };
  })()`);
  assert(
    shortWindowContainment.composerBottom <=
      shortWindowContainment.panelBottom + 0.5 &&
      shortWindowContainment.surfaceBottom <=
        shortWindowContainment.panelBottom + 0.5,
    "Short-window composer was clipped",
  );

  await cdp.evaluate("document.querySelector('.ai-page-context')?.click()");
  const popoverBounds = await poll(
    () =>
      cdp.evaluate(`(() => {
        const popover = document.querySelector('.ai-attachment-menu');
        const panel = document.querySelector('.ai-assistant-panel');
        if (!popover || !panel) return null;
        const p = popover.getBoundingClientRect();
        const b = panel.getBoundingClientRect();
        const a = document.querySelector('.ai-page-context').getBoundingClientRect();
        return {
          left: p.left, right: p.right, top: p.top, bottom: p.bottom,
          anchorTop: a.top, anchorBottom: a.bottom,
          inlineTop: popover.style.top, inlineMaxHeight: popover.style.maxHeight,
          visibility: popover.style.visibility,
          panelLeft: b.left, panelRight: b.right, panelTop: b.top, panelBottom: b.bottom,
          viewportWidth: innerWidth, viewportHeight: innerHeight,
          actionCount: popover.querySelectorAll('.ai-attachment-actions > button').length,
          hasIncludedSection: Boolean(popover.querySelector('.ai-context-menu-section')),
        };
      })()`),
    (value) =>
      Boolean(
        value &&
        value.visibility === "visible" &&
        value.inlineMaxHeight !== "0px",
      ),
    "the context and attachment menu",
  );
  console.log("Context popover measurements:", popoverBounds);
  assert(
    popoverBounds.left >= popoverBounds.panelLeft - 0.5,
    "Context popover escaped the panel on the left",
  );
  assert(
    popoverBounds.right <= popoverBounds.panelRight + 0.5,
    "Context popover escaped the panel on the right",
  );
  assert(
    popoverBounds.top >= Math.max(0, popoverBounds.panelTop) - 0.5,
    "Context popover escaped above the window",
  );
  assert(
    popoverBounds.bottom <=
      Math.min(popoverBounds.viewportHeight, popoverBounds.panelBottom) + 0.5,
    "Context popover escaped below the window",
  );
  assert(
    popoverBounds.actionCount === 3 && popoverBounds.hasIncludedSection,
    "Context actions or included-items section are missing",
  );

  const contextScreenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
  });
  await fs.writeFile(
    contextScreenshotPath,
    Buffer.from(contextScreenshot.data, "base64"),
  );

  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
  });
  await poll(
    () => cdp.evaluate('!document.querySelector(".ai-attachment-menu")'),
    Boolean,
    "the context and attachment menu to close",
  );
  const focusRestored = await cdp.evaluate(
    "document.activeElement?.classList.contains('ai-page-context')",
  );
  assert(focusRestored, "Escape did not restore focus to the context trigger");

  await cdp.evaluate("document.querySelector('.ai-composer-plus')?.click()");
  await poll(
    () =>
      cdp.evaluate(`(() => {
        const menu = document.querySelector('.ai-attachment-menu');
        return Boolean(menu && menu.style.visibility === 'visible');
      })()`),
    Boolean,
    "the attachment menu",
  );
  const firstMenuLabel = await cdp.evaluate(
    "document.activeElement?.textContent?.trim()",
  );
  assert(
    firstMenuLabel?.includes("Capture screenshot"),
    "The attachment menu did not focus its first action",
  );
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
  });
  await poll(
    () => cdp.evaluate('!document.querySelector(".ai-attachment-menu")'),
    Boolean,
    "the attachment menu to close",
  );
  assert(
    await cdp.evaluate(
      "document.activeElement?.classList.contains('ai-composer-plus')",
    ),
    "Attachment-menu focus did not return to the plus button",
  );

  await cdp.evaluate("document.querySelector('.ai-power-button')?.click()");
  const powerBounds = await poll(
    () =>
      cdp.evaluate(`(() => {
        const popover = document.querySelector('.ai-power-popover');
        const panel = document.querySelector('.ai-assistant-panel');
        if (!popover || !panel) return null;
        const p = popover.getBoundingClientRect();
        const b = panel.getBoundingClientRect();
        return {
          left: p.left, right: p.right, top: p.top, bottom: p.bottom,
          visibility: popover.style.visibility,
          panelLeft: b.left, panelRight: b.right, panelTop: b.top, panelBottom: b.bottom,
          viewportHeight: innerHeight,
          providerCount: popover.querySelectorAll('.ai-provider-switch button').length,
        };
      })()`),
    (value) => Boolean(value && value.visibility === "visible"),
    "the Scout Power popover",
  );
  assert(
    powerBounds.left >= powerBounds.panelLeft - 0.5 &&
      powerBounds.right <= powerBounds.panelRight + 0.5 &&
      powerBounds.top >= Math.max(0, powerBounds.panelTop) - 0.5 &&
      powerBounds.bottom <=
        Math.min(powerBounds.viewportHeight, powerBounds.panelBottom) + 0.5,
    "Scout Power escaped the available panel bounds",
  );
  assert(
    powerBounds.providerCount === 2,
    "Scout Power provider switch is missing",
  );
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
  });
  await poll(
    () => cdp.evaluate('!document.querySelector(".ai-power-popover")'),
    Boolean,
    "Scout Power to close",
  );

  await cdp.evaluate(`(() => {
    document.documentElement.style.setProperty('--sidebar-width', '500px');
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) {
      sidebar.style.width = '500px';
      sidebar.style.bottom = '0px';
    }
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 360));

  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
  });
  await fs.writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));

  const lightSurfaceToken = await cdp.evaluate(
    "getComputedStyle(document.documentElement).getPropertyValue('--md-surface-container-low').trim()",
  );
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-color-scheme", value: "dark" },
    ],
  });
  await cdp.evaluate("document.documentElement.dataset.theme = 'dark'");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const themeAndMotion = await cdp.evaluate(`(() => ({
    lightSurfaceToken: ${JSON.stringify(lightSurfaceToken)},
    darkSurfaceToken: getComputedStyle(document.documentElement).getPropertyValue('--md-surface-container-low').trim(),
    panelAnimation: getComputedStyle(document.querySelector('.ai-assistant-panel')).animationName,
    avatarAnimation: getComputedStyle(document.querySelector('.ai-character')).animationName,
    scrollBehavior: getComputedStyle(document.querySelector('.ai-assistant-scroll')).scrollBehavior,
  }))()`);
  console.log("Theme and motion:", themeAndMotion);
  assert(
    themeAndMotion.darkSurfaceToken !== themeAndMotion.lightSurfaceToken,
    "Dark theme did not change the assistant surface token",
  );
  assert(
    themeAndMotion.panelAnimation === "none" &&
      themeAndMotion.avatarAnimation === "none" &&
      themeAndMotion.scrollBehavior === "auto",
    "Reduced-motion mode left assistant animation enabled",
  );
  const darkScreenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
  });
  await fs.writeFile(
    darkScreenshotPath,
    Buffer.from(darkScreenshot.data, "base64"),
  );

  console.log(
    JSON.stringify(
      {
        passed: true,
        widthResults,
        avatarCounts,
        heights,
        popoverBounds,
        screenshotPath,
        contextScreenshotPath,
        darkScreenshotPath,
        shortWindowContainment,
        themeAndMotion,
      },
      null,
      2,
    ),
  );
} finally {
  cdp?.close();
  await stop(child);
  const resolvedProfile = path.resolve(profile);
  const relativeProfile = path.relative(tempRoot, resolvedProfile);
  if (
    relativeProfile &&
    !relativeProfile.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativeProfile)
  ) {
    await fs.rm(resolvedProfile, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 250,
    });
  }
}
