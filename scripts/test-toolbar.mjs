import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
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
  throw new Error(
    `Timed out waiting for ${description}: ${JSON.stringify(last)}`,
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
let zoomServer;
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

  if (process.argv.includes("--source-styles")) {
    const sourceStyles = await fs.readFile(
      path.join(root, "src/renderer/styles.css"),
      "utf8",
    );
    await cdp.evaluate(`(() => {
      for (const sheet of document.styleSheets) {
        if ([...sheet.cssRules].some((rule) => rule.selectorText === '.tab.active')) sheet.disabled = true;
      }
      const style = document.createElement('style');
      style.textContent = ${JSON.stringify(sourceStyles)};
      document.head.append(style);
    })()`);
  }

  const screenshots = [];
  const settle = () => new Promise((resolve) => setTimeout(resolve, 240));
  const capture = async (name, stripOnly = false) => {
    await settle();
    const screenshot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      ...(stripOnly
        ? {
            clip: {
              x: 0,
              y: 0,
              width: await cdp.evaluate("innerWidth"),
              height: 110,
              scale: 1,
            },
          }
        : {}),
    });
    const screenshotPath = path.join(profile, `${name}.png`);
    await fs.writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
    screenshots.push(screenshotPath);
  };
  const dismiss = async () => {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await cdp.evaluate(
      "document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))",
    );
  };
  await cdp.evaluate("document.documentElement.dataset.theme = 'light'");
  await settle();

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
      plusInsideFrame: document.querySelector('.new-tab-button').parentElement.classList.contains('tab-scroller-frame') && !document.querySelector('.new-tab-button').parentElement.classList.contains('tab-scroller'),
      fittingStripHasNoScrollControls: document.querySelectorAll('.tab-scroll-control').length === 0,
      selectedTabMerged: Boolean(
        activeTab && toolbar && activeTab.getBoundingClientRect().bottom === toolbar.getBoundingClientRect().top &&
        activeTabStyle?.borderBottomLeftRadius === '0px' &&
        activeTabStyle?.borderBottomRightRadius === '0px' &&
        getComputedStyle(activeTab, '::before').backgroundColor === toolbarStyle?.backgroundColor,
      ),
      searchByWindowControls: tabSearch.right > innerWidth - 200,
      dots
    };
  })()`);
  if (
    !layout.adjacent ||
    !layout.plusInsideFrame ||
    !layout.fittingStripHasNoScrollControls ||
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
  await capture("01-ungrouped-active-light");

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

  await dismiss();
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
  await cdp.evaluate(
    "document.querySelector('button[aria-label=\"Close find\"]')?.click()",
  );
  await dismiss();
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 500,
    y: 500,
  });

  const groupSetup = await cdp.evaluate(`(async () => {
    const initialIds = (await window.chromecraft.getSnapshot()).tabs.map((tab) => tab.id);
    const ids = [];
    for (let index = 0; index < 3; index += 1) ids.push(await window.chromecraft.createTab());
    await window.chromecraft.closeTabs(initialIds);
    const firstGroupId = await window.chromecraft.createTabGroup(
      [ids[0], ids[2]],
      "Research",
      "blue",
    );
    const secondGroupId = await window.chromecraft.createTabGroup(
      [ids[1]],
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
  await settle();
  const geometryDefects = await cdp.evaluate(`(() => {
    const active = document.querySelector('.tab.active');
    return {
      activeCount: document.querySelectorAll('.tab.active').length,
      inactiveMemberShadows: [...document.querySelectorAll('.tab-group .tab:not(.active)')]
        .map((tab) => getComputedStyle(tab).boxShadow),
      partialContour: getComputedStyle(active.querySelector('.tab-target'), '::after').borderTopWidth,
    };
  })()`);
  if (
    geometryDefects.activeCount !== 1 ||
    geometryDefects.inactiveMemberShadows.some((shadow) => shadow !== "none") ||
    geometryDefects.partialContour !== "0px"
  ) {
    throw new Error(
      `Tab strip geometry regression: ${JSON.stringify(geometryDefects)}`,
    );
  }
  const groupVisual = await cdp.evaluate(`(() => {
    const groups = [...document.querySelectorAll('.tab-group')];
    const pills = [...document.querySelectorAll('.tab-group-pill')];
    const groupedTabs = [...document.querySelectorAll('.tab-group .tab')];
    const firstGroupStyle = getComputedStyle(groups[0]);
    const firstPillStyle = getComputedStyle(pills[0]);
    const activeTab = document.querySelector('.tab-group .tab.active');
    activeTab?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
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
    groupVisual.groupedTabCount !== 3 ||
    groupVisual.groupBackground !== "rgba(0, 0, 0, 0)" ||
    groupVisual.pillHeight > 30 ||
    new Set(groupVisual.pillBackgrounds).size !== 2 ||
    groupVisual.groupIndicators.some(
      (icon) => icon.includes("up") || icon.includes("down"),
    ) ||
    !groupVisual.normalTabShape ||
    groupVisual.activeRadius !== "12px" ||
    groupVisual.activeShoulder === "none" ||
    groupVisual.activeContourWidth !== "0px"
  ) {
    throw new Error(
      `Tab-group visual regression: ${JSON.stringify(groupVisual)}`,
    );
  }
  await capture("02-adjacent-groups-active-and-inactive");

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
  await dismiss();

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
        memberWidths: [...document.querySelectorAll('.tab-group.group-blue .tab')].map((tab) => tab.getBoundingClientRect().width),
        unusedWidth: document.querySelector('.tab-group.group-blue').getBoundingClientRect().width - document.querySelector('.tab-group.group-blue .tab-group-pill').getBoundingClientRect().width,
        activeTabId: snapshot.activeTabId,
      };
    })()`),
    (value) =>
      value?.collapsed &&
      value.visibleMembers === 0 &&
      value.inertMembers &&
      value.memberWidths.every((width) => width === 0) &&
      value.unusedWidth <= 4,
    "the group to collapse without destroying tabs",
  );
  if (collapsed.tabCount !== beforeCollapse.tabs.length) {
    throw new Error("Collapsing a tab group destroyed one or more tabs.");
  }

  await capture("03-collapsed-group");
  await cdp.evaluate(
    `window.chromecraft.updateTabGroup(${JSON.stringify(groupSetup.firstGroupId)}, { collapsed: false })`,
  );
  await poll(
    () =>
      cdp.evaluate(
        "[...document.querySelectorAll('.tab-group.group-blue .tab')].every((tab) => !tab.inert && tab.getBoundingClientRect().width >= 100)",
      ),
    Boolean,
    "expanded group member widths",
  );

  const geometry = () =>
    cdp.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.tab:not(.concealed)')];
    const active = tabs.find((tab) => tab.classList.contains('active'));
    const surface = getComputedStyle(active, '::before');
    const toolbar = document.querySelector('.toolbar');
    const inactive = tabs.filter((tab) => tab !== active);
    return {
      activeCount: document.querySelectorAll('.tab.active').length,
      ariaSelectedCount: document.querySelectorAll('.tab-target[aria-selected="true"]').length,
      merged: Math.abs(active.getBoundingClientRect().bottom - toolbar.getBoundingClientRect().top) < 0.1 && surface.backgroundColor === getComputedStyle(toolbar).backgroundColor,
      maskedSurface: surface.maskImage !== 'none' && surface.left === '-8px' && surface.right === '-8px' && surface.pointerEvents === 'none',
      noOtherContours: tabs.every((tab) => getComputedStyle(tab, '::after').content === 'none' && getComputedStyle(tab.querySelector('.tab-target'), '::after').content === 'none'),
      noTabBorders: tabs.every((tab) => {
        const style = getComputedStyle(tab);
        return style.boxShadow === 'none' && style.outlineStyle === 'none' && ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'].every((side) => style[side] === '0px');
      }),
      inactiveFloating: inactive.every((tab) => tab.getBoundingClientRect().height === 32 && toolbar.getBoundingClientRect().top - tab.getBoundingClientRect().bottom >= 2.9 && getComputedStyle(tab, '::before').content === 'none'),
      activeAboveAdjacent: inactive.every((tab) => Number(getComputedStyle(active).zIndex) > (Number(getComputedStyle(tab).zIndex) || 0)),
      dragRegions: getComputedStyle(document.querySelector('.tab-strip')).getPropertyValue('-webkit-app-region') === 'drag' && [...document.querySelectorAll('.tab-strip button, .tab-strip .tab')].every((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region') === 'no-drag'),
    };
  })()`);
  const assertGeometry = async (scenario) => {
    await settle();
    const result = await geometry();
    if (
      result.activeCount !== 1 ||
      result.ariaSelectedCount !== 1 ||
      Object.entries(result).some(
        ([key, value]) => !key.endsWith("Count") && value !== true,
      )
    ) {
      throw new Error(
        `${scenario} geometry regression: ${JSON.stringify(result)}`,
      );
    }
    return result;
  };
  await assertGeometry("Expanded adjacent groups");

  const pointFor = async (selector) => {
    await cdp.evaluate(
      `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'instant' })`,
    );
    await settle();
    return cdp.evaluate(`(() => {
      const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
  };
  const hoveredPoint = await pointFor(
    ".tab-group .tab:not(.active) .tab-target",
  );
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    ...hoveredPoint,
  });
  await assertGeometry("Hovered inactive group member");
  await capture("04-hovered-inactive-tab");
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...hoveredPoint,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...hoveredPoint,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await settle();
  const pointerFocus = await cdp.evaluate(
    "document.querySelectorAll('.tab-target:focus-visible, .tab-close:focus-visible').length",
  );
  if (pointerFocus !== 0)
    throw new Error(
      `Pointer selection unexpectedly produced ${pointerFocus} keyboard focus rings.`,
    );
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 500,
    y: 500,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
  });
  const keyboardFocus = await poll(
    () =>
      cdp.evaluate(`(() => {
    const targets = [...document.querySelectorAll('.tab-target:focus-visible')];
    return { count: targets.length, inset: targets.length === 1 && getComputedStyle(targets[0]).outlineOffset === '-4px', visible: targets.length === 1 && getComputedStyle(targets[0]).outlineStyle !== 'none' };
  })()`),
    (value) => value.count === 1 && value.inset && value.visible,
    "a single inset keyboard-only focus ring",
  );
  await assertGeometry("Keyboard focused tab");
  await capture("05-keyboard-focused-tab");
  await cdp.evaluate(
    `window.chromecraft.selectTabs(${JSON.stringify([groupSetup.ids[0], groupSetup.ids[2]])}, 'replace')`,
  );
  await assertGeometry("Multiple selected group members");
  const multiSelection = await cdp.evaluate(
    "document.querySelectorAll('.tab.selected').length",
  );
  if (multiSelection !== 2)
    throw new Error(`Expected two selected tabs, found ${multiSelection}.`);
  await capture("06-multi-selection-single-active");
  await cdp.evaluate("document.activeElement?.blur()");
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 500,
    y: 500,
  });
  await cdp.evaluate(
    `window.chromecraft.activateTab(${JSON.stringify(groupSetup.ids[1])})`,
  );

  const visualMatrix = [];
  let nativeWindow;
  let nativeResizeUnavailable;
  try {
    nativeWindow = await cdp.send("Browser.getWindowForTarget", {
      targetId: target.id,
    });
  } catch (error) {
    nativeResizeUnavailable = error.message;
  }
  // Device scale emulation exercises fractional rasterisation without changing
  // the user's real Windows display configuration. Explicit theme selectors
  // exercise both existing CSS palettes; there is no dark-mode preference API.
  for (const theme of ["light", "dark"]) {
    await cdp.evaluate(
      `document.documentElement.dataset.theme = ${JSON.stringify(theme)}`,
    );
    for (const deviceScaleFactor of [1, 1.25, 1.5]) {
      for (const width of [1280, 800, 760]) {
        if (nativeWindow) {
          await cdp.send("Browser.setWindowBounds", {
            windowId: nativeWindow.windowId,
            bounds: { width, height: 820, windowState: "normal" },
          });
          await settle();
        }
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 820,
          deviceScaleFactor,
          mobile: false,
        });
        await pointFor(".tab.active .tab-target");
        if (width === 1280)
          await cdp.evaluate(
            "document.querySelector('.tab-scroller').scrollLeft = 0",
          );
        const result = await assertGeometry(
          `${theme}, ${width}px, ${deviceScaleFactor} scale`,
        );
        visualMatrix.push({
          theme,
          width,
          simulatedDeviceScaleFactor: deviceScaleFactor,
          nativeWindowResized: Boolean(nativeWindow),
          ...result,
        });
        if (nativeWindow) {
          const searchInside = await cdp.evaluate(
            "document.querySelector('.tab-search-button').getBoundingClientRect().right <= innerWidth",
          );
          if (!searchInside)
            throw new Error(
              `Search Tabs escaped the ${width}px resized viewport.`,
            );
        }
        await capture(`matrix-${theme}-${width}-${deviceScaleFactor}`);
        if (width === 1280 && deviceScaleFactor === 1)
          await capture(`tab-strip-${theme}-1280`, true);
      }
    }
  }
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  if (nativeWindow)
    await cdp.send("Browser.setWindowBounds", {
      windowId: nativeWindow.windowId,
      bounds: { width: 1280, height: 820, windowState: "normal" },
    });
  await cdp.evaluate("document.documentElement.dataset.theme = 'light'");
  await settle();
  await cdp.evaluate(`(() => {
    const source = document.querySelector('.tab-group.group-blue .tab-group-pill');
    const destination = document.querySelector('.tab-group.group-pink');
    const dataTransfer = new DataTransfer();
    const bounds = destination.getBoundingClientRect();
    const eventOptions = { bubbles: true, cancelable: true, dataTransfer, clientX: bounds.right - 2, clientY: bounds.top + bounds.height / 2 };
    source.dispatchEvent(new DragEvent('dragstart', eventOptions));
    destination.dispatchEvent(new DragEvent('dragenter', eventOptions));
    destination.dispatchEvent(new DragEvent('dragover', eventOptions));
    destination.dispatchEvent(new DragEvent('drop', eventOptions));
    source.dispatchEvent(new DragEvent('dragend', eventOptions));
  })()`);
  const groupDrag = await poll(
    () =>
      cdp.evaluate(`(async () => {
    const snapshot = await window.chromecraft.getSnapshot();
    return snapshot.tabs.map((tab) => ({ id: tab.id, groupId: tab.groupId }));
  })()`),
    (tabs) =>
      tabs.length === 3 &&
      tabs[0].groupId === groupSetup.secondGroupId &&
      tabs[1].id === groupSetup.ids[0] &&
      tabs[2].id === groupSetup.ids[2] &&
      tabs.slice(1).every((tab) => tab.groupId === groupSetup.firstGroupId),
    "HTML group drag to reorder the intact group",
  );
  await assertGeometry("After group drag");
  const zoomTab = await cdp.evaluate(
    "(async () => (await window.chromecraft.getSnapshot()).activeTabId)()",
  );
  zoomServer = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(
      "<!doctype html><title>Local zoom fixture</title><p>Tab geometry zoom fixture</p>",
    );
  });
  await new Promise((resolve) => zoomServer.listen(0, "127.0.0.1", resolve));
  const zoomUrl = `http://127.0.0.1:${zoomServer.address().port}/zoom`;
  await cdp.evaluate(
    `window.chromecraft.navigate(${JSON.stringify(zoomTab)}, ${JSON.stringify(zoomUrl)})`,
  );
  await poll(
    () =>
      cdp.evaluate(
        `(async () => (await window.chromecraft.getSnapshot()).tabs.find((tab) => tab.id === ${JSON.stringify(zoomTab)})?.title)()`,
      ),
    (title) => title === "Local zoom fixture",
    "the local web-page zoom fixture",
  );
  await settle();
  const beforeZoom = await cdp.evaluate(
    "JSON.stringify([...document.querySelectorAll('.tab')].map((tab) => { const r = tab.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }))",
  );
  for (const factor of [1.25, 1.5, 1]) {
    await cdp.evaluate(
      `window.chromecraft.setZoom(${JSON.stringify(zoomTab)}, ${factor})`,
    );
    await assertGeometry(`Web page zoom ${factor}`);
    const afterZoom = await cdp.evaluate(
      "JSON.stringify([...document.querySelectorAll('.tab')].map((tab) => { const r = tab.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }))",
    );
    if (beforeZoom !== afterZoom)
      throw new Error(
        `Page zoom ${factor} changed browser tab-strip geometry.`,
      );
  }

  const overflowTabIds = await cdp.evaluate(`(async () => {
    const ids = [];
    for (let index = 0; index < 14; index += 1) {
      ids.push(await window.chromecraft.createTab());
    }
    await window.chromecraft.activateTab(ids[0]);
    return ids;
  })()`);
  const tabOverflow = await poll(
    () =>
      cdp.evaluate(`(() => {
        const scroller = document.querySelector('.tab-scroller');
        const controls = [...document.querySelectorAll('.tab-scroll-control')];
        const tabs = [...document.querySelectorAll('.tab:not(.concealed)')];
        const plus = document.querySelector('.new-tab-button');
        const plusRect = plus?.getBoundingClientRect();
        return {
          overflows: scroller.scrollWidth > scroller.clientWidth + 1,
          controlCount: controls.length,
          leftDisabled: controls[0]?.disabled,
          rightDisabled: controls[1]?.disabled,
          minTabWidth: Math.min(...tabs.map((tab) => tab.getBoundingClientRect().width)),
          maxTabWidth: Math.max(...tabs.map((tab) => tab.getBoundingClientRect().width)),
          faviconsPreserved: tabs.every((tab) => tab.querySelector('.tab-favicon')),
          closeButtonsPreserved: tabs.every((tab) => tab.querySelector('.tab-close')),
          newTabVisible: Boolean(plusRect && plusRect.left >= 0 && plusRect.right <= innerWidth),
          groupLabels: [...document.querySelectorAll('.tab-group-pill')].map((pill) => {
            const rect = pill.getBoundingClientRect();
            return { text: pill.textContent, width: rect.width, left: rect.left, right: rect.right };
          }),
        };
      })()`),
    (value) =>
      value?.overflows &&
      value.controlCount === 2 &&
      (!value.leftDisabled || !value.rightDisabled) &&
      value.minTabWidth <= 84 &&
      value.faviconsPreserved &&
      value.closeButtonsPreserved &&
      value.newTabVisible &&
      value.groupLabels.every((label) => label.width >= 48),
    "tabs to shrink before exposing two usable overflow controls",
  );
  await capture("07-many-tabs-overflow-controls", true);
  await cdp.evaluate(
    "document.querySelector('.tab-scroll-control.next')?.click()",
  );
  const tabOverflowAfterScroll = await poll(
    () =>
      cdp.evaluate(`(() => {
        const scroller = document.querySelector('.tab-scroller');
        const previous = document.querySelector('.tab-scroll-control.previous');
        return { scrollLeft: scroller.scrollLeft, previousDisabled: previous?.disabled };
      })()`),
    (value) => value?.scrollLeft > 20 && value.previousDisabled === false,
    "the right tab-scroll control to reveal later tabs",
  );
  await cdp.evaluate(
    `window.chromecraft.activateTab(${JSON.stringify(overflowTabIds.at(-1))})`,
  );
  const activeOverflowTabVisible = await poll(
    () =>
      cdp.evaluate(`(() => {
        const active = document.querySelector('.tab.active').getBoundingClientRect();
        const scroller = document.querySelector('.tab-scroller').getBoundingClientRect();
        return active.left >= scroller.left - 1 && active.right <= scroller.right + 1;
      })()`),
    Boolean,
    "an activated overflow tab to scroll into view",
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
        geometryDefects,
        keyboardFocus,
        pointerFocus,
        multiSelection,
        groupDrag,
        tabOverflow,
        tabOverflowAfterScroll,
        activeOverflowTabVisible,
        visualMatrix,
        nativeResizeUnavailable,
        sourceStyleOverride: process.argv.includes("--source-styles"),
        screenshots,
      },
      null,
      2,
    ),
  );
} finally {
  cdp?.close();
  await stop(child);
  zoomServer?.closeAllConnections();
  await new Promise((resolve) =>
    zoomServer ? zoomServer.close(resolve) : resolve(),
  );
}
