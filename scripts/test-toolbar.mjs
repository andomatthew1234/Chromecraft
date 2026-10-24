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
    const activeTab = document.querySelector('.tab.active');
    const plus = document.querySelector('.new-tab-button').getBoundingClientRect();
    const tabSearch = document.querySelector('.tab-search-button').getBoundingClientRect();
    const toolbar = document.querySelector('.toolbar');
    const dots = [...document.querySelectorAll('.toolbar-status-dot')]
      .map((dot) => dot.getBoundingClientRect())
      .map(({ width, height }) => ({ width, height }));
    const activeTabStyle = activeTab ? getComputedStyle(activeTab) : null;
    const toolbarStyle = toolbar ? getComputedStyle(toolbar) : null;
    return {
      adjacent: plus.left - tab.right >= 0 && plus.left - tab.right <= 12,
      plusInsideScroller: document.querySelector('.new-tab-button').parentElement.classList.contains('tab-scroller'),
      selectedTabMerged: Boolean(
        activeTab && toolbar && activeTab.getBoundingClientRect().bottom === toolbar.getBoundingClientRect().top &&
        activeTabStyle?.borderBottomLeftRadius === '0px' &&
        activeTabStyle?.borderBottomRightRadius === '0px' &&
        activeTabStyle.backgroundColor === toolbarStyle?.backgroundColor,
      ),
      searchByWindowControls: tabSearch.right > innerWidth - 200,
      dots
    };
  })()`);
  if (
    !layout.adjacent ||
    !layout.plusInsideScroller ||
    !layout.selectedTabMerged ||
    !layout.searchByWindowControls
  ) {
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

  const groupSetup = await cdp.evaluate(`(async () => {
    const ids = [];
    for (let index = 0; index < 8; index += 1) ids.push(await window.chromecraft.createTab());
    const firstGroupId = await window.chromecraft.createTabGroup(
      [ids[0], ids[2], ids[4], ids[6]],
      "Long research group name",
      "blue",
    );
    const secondGroupId = await window.chromecraft.createTabGroup(
      [ids[1], ids[3], ids[5]],
      "Planning",
      "pink",
    );
    await window.chromecraft.activateTab(ids[1]);
    return { ids, firstGroupId, secondGroupId };
  })()`);
  await poll(
    () => cdp.evaluate("document.querySelectorAll('.tab-group').length"),
    (count) => count === 2,
    "two rendered tab groups",
  );
  const groupVisual = await cdp.evaluate(`(() => {
    const groups = [...document.querySelectorAll('.tab-group')];
    const pills = [...document.querySelectorAll('.tab-group-pill')];
    const groupedTabs = [...document.querySelectorAll('.tab-group .tab')];
    const firstGroupStyle = getComputedStyle(groups[0]);
    const firstPillStyle = getComputedStyle(pills[0]);
    const activeTab = document.querySelector('.tab-group .tab.active');
    activeTab?.scrollIntoView({ inline: 'center', block: 'nearest' });
    const activeStyle = activeTab ? getComputedStyle(activeTab) : null;
    const activeShoulder = activeTab ? getComputedStyle(activeTab, '::before') : null;
    const activeContour = activeTab?.querySelector('.tab-target');
    return {
      groupCount: groups.length,
      groupedTabCount: groupedTabs.length,
      groupBackground: firstGroupStyle.backgroundColor,
      pillHeight: pills[0].getBoundingClientRect().height,
      pillRadius: firstPillStyle.borderRadius,
      pillBackground: firstPillStyle.backgroundColor,
      pillBackgrounds: pills.map((pill) => getComputedStyle(pill).backgroundColor),
      groupIndicators: [...document.querySelectorAll('.tab-group-toggle > .material-icon')].map((icon) => icon.textContent),
      stripScrollable: document.querySelector('.tab-scroller').scrollWidth > document.querySelector('.tab-scroller').clientWidth,
      normalTabShape: groupedTabs.every((tab) => getComputedStyle(tab).borderTopLeftRadius !== '9999px'),
      activeRadius: activeStyle?.borderTopLeftRadius,
      activeShoulder: activeShoulder?.content,
      activeContourWidth: activeContour ? getComputedStyle(activeContour, '::after').borderTopWidth : null,
    };
  })()`);
  if (
    groupVisual.groupCount !== 2 ||
    groupVisual.groupedTabCount !== 7 ||
    groupVisual.groupBackground !== "rgba(0, 0, 0, 0)" ||
    groupVisual.pillHeight > 30 ||
    new Set(groupVisual.pillBackgrounds).size !== 2 ||
    groupVisual.groupIndicators.some(
      (icon) => icon.includes("up") || icon.includes("down"),
    ) ||
    !groupVisual.normalTabShape ||
    groupVisual.activeRadius !== "12px" ||
    groupVisual.activeShoulder === "none" ||
    groupVisual.activeContourWidth !== "2px"
  ) {
    throw new Error(
      `Tab-group visual regression: ${JSON.stringify(groupVisual)}`,
    );
  }

  await cdp.evaluate(`(() => {
    const pill = document.querySelector('.tab-group-pill');
    const rect = pill.getBoundingClientRect();
    pill.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.bottom,
    }));
  })()`);
  const groupMenu = await poll(
    () =>
      cdp.evaluate(`(() => {
      const menu = document.querySelector('.tab-group-menu');
      if (!menu) return null;
      const rect = menu.getBoundingClientRect();
      return {
        text: menu.textContent,
        insideViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      };
    })()`),
    (value) =>
      value?.insideViewport &&
      value.text.includes("New tab in group") &&
      value.text.includes("Collapse group"),
    "the group context menu",
  );
  await cdp.evaluate("document.body.click()");

  const beforeCollapse = await cdp.evaluate("window.chromecraft.getSnapshot()");
  await cdp.evaluate(
    `window.chromecraft.updateTabGroup(${JSON.stringify(groupSetup.firstGroupId)}, { collapsed: true })`,
  );
  const collapsed = await poll(
    () =>
      cdp.evaluate(`(async () => {
      const snapshot = await window.chromecraft.getSnapshot();
      const group = snapshot.tabGroups.find((item) => item.id === ${JSON.stringify(groupSetup.firstGroupId)});
      return {
        collapsed: group?.collapsed,
        tabCount: snapshot.tabs.length,
        visibleMembers: document.querySelectorAll('.tab-group.group-blue .tab:not(.concealed)').length,
        inertMembers: [...document.querySelectorAll('.tab-group.group-blue .tab.concealed')]
          .every((tab) => tab.inert && tab.getAttribute('aria-hidden') === 'true'),
        activeTabId: snapshot.activeTabId,
      };
    })()`),
    (value) =>
      value?.collapsed && value.visibleMembers === 0 && value.inertMembers,
    "the group to collapse without destroying tabs",
  );
  if (collapsed.tabCount !== beforeCollapse.tabs.length) {
    throw new Error("Collapsing a tab group destroyed one or more tabs.");
  }

  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const groupScreenshotPath = path.join(profile, "tab-groups-toolbar.png");
  await fs.writeFile(
    groupScreenshotPath,
    Buffer.from(screenshot.data, "base64"),
  );

  console.log(
    JSON.stringify(
      {
        pass: true,
        layout,
        menu,
        findBefore,
        findAfter,
        hoverCard,
        groupVisual,
        groupMenu,
        collapsed,
        groupScreenshotPath,
      },
      null,
      2,
    ),
  );
} finally {
  cdp?.close();
  await stop(child);
}
