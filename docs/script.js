const words = ["Browse", "Play", "Stream", "Ask", "Call", "Work"];
const wordElement = document.querySelector(".rotating-word");
const reducedMotionQuery = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
);
const reduceMotion = reducedMotionQuery.matches;

if (!reduceMotion) {
  document.documentElement.classList.add("motion-ready");
}

let wordIndex = 0;

function rotateWord() {
  if (!wordElement || reduceMotion) {
    return;
  }

  wordElement.classList.add("is-leaving");
  window.setTimeout(() => {
    wordIndex = (wordIndex + 1) % words.length;
    wordElement.textContent = words[wordIndex];
    wordElement.classList.remove("is-leaving");
    wordElement.classList.add("is-entering");
    window.setTimeout(() => wordElement.classList.remove("is-entering"), 220);
  }, 190);
}

if (!reduceMotion) {
  window.setInterval(rotateWord, 1000);
}

const root = document.documentElement;
const hero = document.querySelector(".hero");
const motionSections = [...document.querySelectorAll(".feature")];
const progressBar = document.querySelector(".scroll-progress span");
const materialSection = document.querySelector(".feature-material");
const colorSlider = document.querySelector(".appearance-slider");
const sliderValue = document.querySelector(".slider-value");
let sliderTouched = false;
let scrollFrame;

function clamp(value, min = 0, max = 1) {
  return Math.min(Math.max(value, min), max);
}

function easeOutCubic(value) {
  return 1 - Math.pow(1 - value, 3);
}

function updateScrollMotion() {
  scrollFrame = undefined;
  if (reduceMotion) return;

  const viewportHeight = window.innerHeight;
  const documentHeight = document.documentElement.scrollHeight - viewportHeight;
  const pageProgress = documentHeight > 0 ? window.scrollY / documentHeight : 0;
  progressBar?.style.setProperty(
    "--page-progress",
    String(clamp(pageProgress)),
  );

  if (hero) {
    const heroProgress = clamp(
      window.scrollY / Math.max(hero.offsetHeight * 0.78, 1),
    );
    root.style.setProperty("--hero-opacity", String(1 - heroProgress * 0.72));
    root.style.setProperty("--hero-shift", `${heroProgress * -72}px`);
    root.style.setProperty("--hero-scale", String(1 - heroProgress * 0.035));
    root.style.setProperty("--header-shift", `${heroProgress * -28}px`);
    root.style.setProperty("--dots-opacity", String(1 - heroProgress * 0.4));
    root.style.setProperty("--dots-shift", `${heroProgress * 90}px`);
    root.style.setProperty("--dots-scale", String(1 + heroProgress * 0.08));
  }

  motionSections.forEach((section) => {
    const bounds = section.getBoundingClientRect();
    const entry = clamp(
      (viewportHeight * 0.92 - bounds.top) / (viewportHeight * 0.72),
    );
    const easedEntry = easeOutCubic(entry);
    const travel = clamp(
      (viewportHeight - bounds.top) / (viewportHeight + bounds.height),
    );
    const departure = clamp(
      (-bounds.top - bounds.height * 0.55) / (bounds.height * 0.35),
    );
    const opacity = clamp(easedEntry - departure * 0.5);
    const depth = (0.5 - travel) * 2;
    const isActive =
      bounds.top < viewportHeight * 1.2 &&
      bounds.bottom > -viewportHeight * 0.2;

    section.classList.toggle("is-motion-active", isActive);

    section.style.setProperty("--section-opacity", opacity.toFixed(3));
    section.style.setProperty("--section-line", easedEntry.toFixed(3));
    section.style.setProperty("--copy-x", `${(1 - easedEntry) * -34}px`);
    section.style.setProperty(
      "--copy-y",
      `${(1 - easedEntry) * 64 + departure * -18}px`,
    );
    section.style.setProperty("--visual-x", `${(1 - easedEntry) * 44}px`);
    section.style.setProperty(
      "--visual-y",
      `${(1 - easedEntry) * 84 + depth * 16}px`,
    );
    section.style.setProperty(
      "--visual-tilt",
      `${(1 - easedEntry) * 4 + depth * 1.2}deg`,
    );
    section.style.setProperty("--visual-turn", `${(1 - easedEntry) * -3}deg`);
    section.style.setProperty(
      "--visual-scale",
      String(0.92 + easedEntry * 0.08 - departure * 0.015),
    );
    section.style.setProperty("--accent-size", `${easedEntry * 100}%`);
    section.style.setProperty(
      "--privacy-core-scale",
      String(0.72 + easedEntry * 0.28),
    );
    section.style.setProperty("--preview-dot-shift", `${depth * -34}px`);

    const scanResolved = easeOutCubic(clamp((travel - 0.16) / 0.34));
    const scanRed = Math.round(241 + (25 - 241) * scanResolved);
    const scanGreen = Math.round(135 + (115 - 135) * scanResolved);
    const scanBlue = Math.round(111 + (85 - 111) * scanResolved);
    section.style.setProperty(
      "--scan-alert",
      `rgb(${scanRed}, ${scanGreen}, ${scanBlue})`,
    );
    section.style.setProperty(
      "--scan-status-opacity",
      String(0.2 + scanResolved * 0.8),
    );
    section.style.setProperty(
      "--scan-status-shift",
      `${(1 - scanResolved) * 10}px`,
    );

    const queueProgress = easeOutCubic(clamp((entry - 0.3) / 0.7));
    section.style.setProperty(
      "--queue-opacity",
      String(0.22 + queueProgress * 0.78),
    );
    section.style.setProperty("--queue-shift", `${(1 - queueProgress) * 28}px`);

    if (
      section === materialSection &&
      colorSlider &&
      sliderValue &&
      !sliderTouched
    ) {
      const value = Math.round(
        22 + easeOutCubic(clamp((entry - 0.12) / 0.88)) * 46,
      );
      colorSlider.value = String(value);
      sliderValue.value = `${value}%`;
      sliderValue.textContent = `${value}%`;
    }
  });
}

function requestScrollMotion() {
  if (!scrollFrame) {
    scrollFrame = window.requestAnimationFrame(updateScrollMotion);
  }
}

if (!reduceMotion) {
  updateScrollMotion();
  window.addEventListener("scroll", requestScrollMotion, { passive: true });
  window.addEventListener("resize", requestScrollMotion);
  document.fonts?.ready.then(requestScrollMotion);
}

const youtubeUtilities = document.querySelector(".youtube-utilities");
const youtubeUtilitiesJourney = document.querySelector(
  ".youtube-utilities-journey",
);
const youtubeUtilitySteps = [
  ...document.querySelectorAll("[data-youtube-utility]"),
];
const youtubeUtilityVisuals = [
  ...document.querySelectorAll("[data-youtube-utility-visual]"),
];
let activeYoutubeUtility = 0;
let youtubeUtilityFrame;

function showYoutubeUtility(index, focus = false) {
  const next = Math.min(
    Math.max(Number(index) || 0, 0),
    youtubeUtilitySteps.length - 1,
  );
  if (!youtubeUtilities || !youtubeUtilitySteps.length) return;

  activeYoutubeUtility = next;
  youtubeUtilities.style.setProperty("--youtube-active", String(next));
  youtubeUtilitySteps.forEach((step, stepIndex) => {
    const active = stepIndex === next;
    step.classList.toggle("is-active", active);
    step.setAttribute("aria-selected", String(active));
    step.tabIndex = active ? 0 : -1;
  });
  youtubeUtilityVisuals.forEach((visual, visualIndex) => {
    const active = visualIndex === next;
    visual.classList.toggle("is-active", active);
    visual.setAttribute("aria-hidden", String(!active));
  });

  if (focus) youtubeUtilitySteps[next]?.focus();
}

function updateYoutubeUtilityFromScroll() {
  youtubeUtilityFrame = undefined;
  if (
    !youtubeUtilitiesJourney ||
    reduceMotion ||
    window.matchMedia("(max-width: 900px)").matches
  ) {
    return;
  }

  const bounds = youtubeUtilitiesJourney.getBoundingClientRect();
  const travel = Math.max(bounds.height - window.innerHeight, 1);
  const progress = clamp(-bounds.top / travel);
  const next = Math.min(2, Math.floor(progress * 3));
  if (next !== activeYoutubeUtility) showYoutubeUtility(next);
}

function requestYoutubeUtilityUpdate() {
  if (!youtubeUtilityFrame) {
    youtubeUtilityFrame = window.requestAnimationFrame(
      updateYoutubeUtilityFromScroll,
    );
  }
}

youtubeUtilitySteps.forEach((step, index) => {
  step.addEventListener("click", () => showYoutubeUtility(index));
  step.addEventListener("keydown", (event) => {
    if (
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    ) {
      return;
    }
    event.preventDefault();
    const direction = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1;
    const next =
      (activeYoutubeUtility + direction + youtubeUtilitySteps.length) %
      youtubeUtilitySteps.length;
    showYoutubeUtility(next, true);
  });
});

if (youtubeUtilitiesJourney && !reduceMotion) {
  showYoutubeUtility(0);
  updateYoutubeUtilityFromScroll();
  window.addEventListener("scroll", requestYoutubeUtilityUpdate, {
    passive: true,
  });
  window.addEventListener("resize", requestYoutubeUtilityUpdate);
}

if (colorSlider && sliderValue) {
  colorSlider.addEventListener("pointerdown", () => {
    sliderTouched = true;
  });
  colorSlider.addEventListener("keydown", () => {
    sliderTouched = true;
  });
  colorSlider.addEventListener("input", () => {
    sliderValue.value = `${colorSlider.value}%`;
    sliderValue.textContent = `${colorSlider.value}%`;
  });
}

const materialTabs = document.querySelectorAll(".material-tabs button");
const materialChip = document.querySelector(".material-chip");
const materialPanel = document.querySelector(".material-content");
const materialPanelTitle = document.querySelector(".m3-panel-title");
const materialOverline = document.querySelector(".m3-overline");
const segmentedButtons = document.querySelectorAll(".m3-segmented button");
const materialModes = {
  color: ["Dynamic theme", "Make it yours"],
  shape: ["Shape system", "Express every surface"],
  type: ["Type scale", "Tune your rhythm"],
};

function selectMaterialTab(tab) {
  materialTabs.forEach((candidate) => {
    const isActive = candidate === tab;
    candidate.classList.toggle("active", isActive);
    candidate.setAttribute("aria-selected", String(isActive));
    candidate.tabIndex = isActive ? 0 : -1;
  });

  const mode = tab.dataset.mode || "color";
  const [overline, title] = materialModes[mode];
  if (materialPanel) {
    materialPanel.dataset.mode = mode;
    materialPanel.setAttribute("aria-labelledby", tab.id);
  }
  if (materialPanelTitle) materialPanelTitle.textContent = title;
  if (materialOverline) materialOverline.textContent = overline;
}

materialTabs.forEach((tab) => {
  tab.addEventListener("click", () => selectMaterialTab(tab));
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const currentIndex = [...materialTabs].indexOf(tab);
    const nextIndex =
      (currentIndex + direction + materialTabs.length) % materialTabs.length;
    materialTabs[nextIndex].focus();
    selectMaterialTab(materialTabs[nextIndex]);
  });
});

segmentedButtons.forEach((button) => {
  button.addEventListener("click", () => {
    segmentedButtons.forEach((candidate) => {
      const isSelected = candidate === button;
      candidate.classList.toggle("selected", isSelected);
      candidate.setAttribute("aria-pressed", String(isSelected));
    });
  });
});

materialChip?.addEventListener("click", () => {
  const isSelected = materialChip.getAttribute("aria-pressed") === "true";
  materialChip.setAttribute("aria-pressed", String(!isSelected));
  materialChip.classList.toggle("is-selected", !isSelected);
});

const extensionsSection = document.querySelector(".extensions-showcase");
const extensionsStage = document.querySelector(".extensions-stage");
const extensionsRing = document.querySelector(".extensions-ring");
const extensionTiles = [...document.querySelectorAll(".extension-tile")];
const extensionTileStates = extensionTiles.map(() => ({
  hover: 0,
  tiltX: 0,
  tiltY: 0,
}));
let extensionsFrame;
let extensionsVisible = false;
let extensionsProgress = reduceMotion ? 1 : 0;
let extensionsTargetRotation = reduceMotion ? 18 : 0;
let extensionsRotation = extensionsTargetRotation;
let extensionsDragOffset = 0;
let extensionsVelocity = 0;
let extensionsLastTime = 0;
let extensionsRadiusX = 440;
let extensionsRadiusY = 290;
let extensionsDepth = 170;
let extensionsPointerId;
let extensionsPointerAxis;
let extensionsPointerStartX = 0;
let extensionsPointerStartY = 0;
let extensionsPointerLastX = 0;
let extensionsPointerLastTime = 0;
let extensionsDragging = false;

function extensionEase(value) {
  const resolved = clamp(value);
  return resolved * resolved * (3 - 2 * resolved);
}

function extensionPhase(start, end) {
  return extensionEase((extensionsProgress - start) / (end - start));
}

function updateExtensionsProgress() {
  if (!extensionsSection || !extensionsStage) return;

  if (reduceMotion) {
    extensionsProgress = 1;
    extensionsTargetRotation = 18;
  } else {
    const bounds = extensionsSection.getBoundingClientRect();
    const scrollDistance = Math.max(1, bounds.height - window.innerHeight);
    extensionsProgress =
      bounds.top >= 0 ? 0 : clamp(-bounds.top / scrollDistance);
    extensionsTargetRotation = extensionPhase(0.24, 1) * 540;
  }

  const copy = extensionPhase(0.04, 0.18);
  const halo = extensionPhase(0.08, 0.3);
  extensionsStage.style.setProperty(
    "--extensions-copy-opacity",
    copy.toFixed(4),
  );
  extensionsStage.style.setProperty(
    "--extensions-copy-shift",
    `${((1 - copy) * 24).toFixed(2)}px`,
  );
  extensionsStage.style.setProperty(
    "--extensions-halo-opacity",
    halo.toFixed(4),
  );
  extensionsStage.style.setProperty(
    "--extensions-halo-scale",
    (0.76 + halo * 0.24).toFixed(4),
  );
  extensionsStage.style.setProperty(
    "--extensions-particles-opacity",
    extensionPhase(0.12, 0.35).toFixed(4),
  );
}

function resizeExtensionsShowcase() {
  const width = window.innerWidth;
  const height = window.innerHeight;

  if (width <= 720) {
    extensionsRadiusX = Math.min(width * 0.4, 158);
    extensionsRadiusY = Math.min(height * 0.31, 260);
    extensionsDepth = 86;
  } else if (width <= 1000) {
    extensionsRadiusX = Math.min(width * 0.39, 360);
    extensionsRadiusY = Math.min(height * 0.33, 285);
    extensionsDepth = 135;
  } else {
    extensionsRadiusX = Math.min(width * 0.36, 500);
    extensionsRadiusY = Math.min(height * 0.31, 300);
    extensionsDepth = 180;
  }

  updateExtensionsProgress();
}

function renderExtensionsShowcase(time = 0, staticFrame = false) {
  extensionsFrame = undefined;
  if (!extensionsStage || !extensionTiles.length) return;

  const delta = extensionsLastTime
    ? Math.min(40, Math.max(0, time - extensionsLastTime))
    : 16;
  extensionsLastTime = time;

  if (!reduceMotion && !extensionsDragging) {
    extensionsDragOffset += extensionsVelocity * (delta / 16);
    extensionsVelocity *= Math.pow(0.92, delta / 16);
    if (Math.abs(extensionsVelocity) < 0.002) extensionsVelocity = 0;
  }

  const targetRotation = extensionsTargetRotation + extensionsDragOffset;
  extensionsRotation +=
    (targetRotation - extensionsRotation) * (staticFrame ? 1 : 0.095);

  extensionTiles.forEach((tile, index) => {
    const entranceStart = 0.08 + index * 0.022;
    const assembled = reduceMotion
      ? 1
      : extensionEase((extensionsProgress - entranceStart) / 0.2);
    const angle =
      -90 + index * (360 / extensionTiles.length) + extensionsRotation;
    const radians = (angle * Math.PI) / 180;
    const depthPosition = (Math.sin(radians) + 1) * 0.5;
    const state = extensionTileStates[index];
    state.hover +=
      ((tile.matches(":hover") || tile.matches(":focus-visible") ? 1 : 0) -
        state.hover) *
      0.16;

    const orbitX = Math.cos(radians) * extensionsRadiusX * assembled;
    const orbitY = Math.sin(radians) * extensionsRadiusY * assembled;
    const orbitZ = Math.sin(radians) * extensionsDepth * assembled;
    const idle = reduceMotion ? 0 : Math.sin(time * 0.0011 + index * 1.7) * 4;
    const hoverLift = state.hover * 72;
    const baseScale = 0.76 + depthPosition * 0.24;
    const entranceScale = 0.38 + assembled * 0.62;
    const scale = baseScale * entranceScale + state.hover * 0.1;
    const orbitTiltY = Math.cos(radians) * -10;
    const orbitTiltX = Math.sin(radians) * 4;

    tile.style.opacity = assembled.toFixed(4);
    tile.style.zIndex = String(Math.round(20 + depthPosition * 80));
    tile.style.filter = `brightness(${(0.74 + depthPosition * 0.34 + state.hover * 0.14).toFixed(3)})`;
    tile.style.transform = `translate3d(calc(-50% + ${orbitX.toFixed(2)}px), calc(-50% + ${(orbitY + idle).toFixed(2)}px), ${(orbitZ + hoverLift - (1 - assembled) * 360).toFixed(2)}px) rotateX(${(orbitTiltX + state.tiltX * state.hover).toFixed(2)}deg) rotateY(${(orbitTiltY + state.tiltY * state.hover).toFixed(2)}deg) rotateZ(${(Math.cos(radians) * 4).toFixed(2)}deg) scale(${scale.toFixed(4)})`;
  });

  if (!staticFrame && !reduceMotion && extensionsVisible) {
    extensionsFrame = window.requestAnimationFrame(renderExtensionsShowcase);
  }
}

function requestExtensionsFrame() {
  if (extensionsFrame || reduceMotion || !extensionsVisible) return;
  extensionsFrame = window.requestAnimationFrame(renderExtensionsShowcase);
}

function handleExtensionsScroll() {
  updateExtensionsProgress();
  requestExtensionsFrame();
}

function extensionTileFromEvent(event) {
  const tile = event.target.closest?.(".extension-tile");
  return tile && extensionsRing?.contains(tile) ? tile : null;
}

function handleExtensionPointerOver(event) {
  const tile = extensionTileFromEvent(event);
  if (!tile || tile.contains(event.relatedTarget)) return;
  requestExtensionsFrame();
}

function handleExtensionPointerOut(event) {
  const tile = extensionTileFromEvent(event);
  if (!tile || tile.contains(event.relatedTarget)) return;
  const state = extensionTileStates[extensionTiles.indexOf(tile)];
  if (state && !tile.matches(":focus-visible")) {
    state.tiltX = 0;
    state.tiltY = 0;
  }
}

function handleExtensionPointerDown(event) {
  if (
    !extensionsRing ||
    (event.pointerType === "mouse" && event.button !== 0)
  ) {
    return;
  }

  extensionsPointerId = event.pointerId;
  extensionsPointerAxis = undefined;
  extensionsPointerStartX = event.clientX;
  extensionsPointerStartY = event.clientY;
  extensionsPointerLastX = event.clientX;
  extensionsPointerLastTime = performance.now();
  extensionsVelocity = 0;
  extensionsRing.setPointerCapture(event.pointerId);
}

function handleExtensionPointerMove(event) {
  const tile = extensionTileFromEvent(event);
  if (tile && !extensionsDragging) {
    const bounds = tile.getBoundingClientRect();
    const state = extensionTileStates[extensionTiles.indexOf(tile)];
    if (state) {
      state.tiltX =
        clamp((event.clientY - bounds.top) / bounds.height, 0, 1) * -12 + 6;
      state.tiltY =
        clamp((event.clientX - bounds.left) / bounds.width, 0, 1) * 12 - 6;
    }
  }

  if (event.pointerId !== extensionsPointerId || !extensionsRing) return;
  const totalX = event.clientX - extensionsPointerStartX;
  const totalY = event.clientY - extensionsPointerStartY;

  if (!extensionsPointerAxis && Math.hypot(totalX, totalY) > 7) {
    extensionsPointerAxis = Math.abs(totalX) > Math.abs(totalY) ? "x" : "y";
    extensionsDragging = extensionsPointerAxis === "x";
    extensionsRing.classList.toggle("is-dragging", extensionsDragging);
  }

  if (extensionsPointerAxis !== "x") return;
  event.preventDefault();
  const now = performance.now();
  const deltaX = event.clientX - extensionsPointerLastX;
  const deltaTime = Math.max(8, now - extensionsPointerLastTime);
  extensionsDragOffset += deltaX * 0.48;
  extensionsVelocity = (deltaX / deltaTime) * 7.5;
  extensionsPointerLastX = event.clientX;
  extensionsPointerLastTime = now;
  requestExtensionsFrame();
}

function releaseExtensionsPointer(event) {
  if (event.pointerId !== extensionsPointerId || !extensionsRing) return;
  if (extensionsRing.hasPointerCapture(event.pointerId)) {
    extensionsRing.releasePointerCapture(event.pointerId);
  }
  extensionsPointerId = undefined;
  extensionsPointerAxis = undefined;
  extensionsDragging = false;
  extensionsRing.classList.remove("is-dragging");
  requestExtensionsFrame();
}

function handleExtensionFocus() {
  requestExtensionsFrame();
}

function cleanupExtensionsShowcase() {
  window.cancelAnimationFrame(extensionsFrame);
  window.removeEventListener("scroll", handleExtensionsScroll);
  window.removeEventListener("resize", resizeExtensionsShowcase);
  extensionsRing?.removeEventListener(
    "pointerover",
    handleExtensionPointerOver,
  );
  extensionsRing?.removeEventListener("pointerout", handleExtensionPointerOut);
  extensionsRing?.removeEventListener(
    "pointerdown",
    handleExtensionPointerDown,
  );
  extensionsRing?.removeEventListener(
    "pointermove",
    handleExtensionPointerMove,
  );
  extensionsRing?.removeEventListener("pointerup", releaseExtensionsPointer);
  extensionsRing?.removeEventListener(
    "pointercancel",
    releaseExtensionsPointer,
  );
  extensionsRing?.removeEventListener("focusin", handleExtensionFocus);
  extensionsRing?.removeEventListener("focusout", handleExtensionFocus);
}

if (
  extensionsSection &&
  extensionsStage &&
  extensionsRing &&
  extensionTiles.length
) {
  resizeExtensionsShowcase();
  renderExtensionsShowcase(0, true);

  if (!reduceMotion) {
    window.addEventListener("scroll", handleExtensionsScroll, {
      passive: true,
    });
    window.addEventListener("resize", resizeExtensionsShowcase);
    extensionsRing.addEventListener("pointerover", handleExtensionPointerOver);
    extensionsRing.addEventListener("pointerout", handleExtensionPointerOut);
    extensionsRing.addEventListener("pointerdown", handleExtensionPointerDown);
    extensionsRing.addEventListener("pointermove", handleExtensionPointerMove);
    extensionsRing.addEventListener("pointerup", releaseExtensionsPointer);
    extensionsRing.addEventListener("pointercancel", releaseExtensionsPointer);
    extensionsRing.addEventListener("focusin", handleExtensionFocus);
    extensionsRing.addEventListener("focusout", handleExtensionFocus);

    const extensionsObserver = new IntersectionObserver(
      ([entry]) => {
        extensionsVisible = entry.isIntersecting;
        updateExtensionsProgress();
        if (extensionsVisible) {
          extensionsLastTime = 0;
          requestExtensionsFrame();
        } else if (extensionsFrame) {
          window.cancelAnimationFrame(extensionsFrame);
          extensionsFrame = undefined;
        }
      },
      { rootMargin: "120px", threshold: 0.01 },
    );
    extensionsObserver.observe(extensionsStage);
  }
}

const sidebarShowcase = document.querySelector(".sidebar-showcase");
const sidebarProductFrame = document.querySelector(".sidebar-product-frame");
const sidebarFinePointer = window.matchMedia(
  "(hover: hover) and (pointer: fine)",
);
let sidebarObserver;
let sidebarVisible = false;
let sidebarParallaxFrame;
let sidebarTiltFrame;
let sidebarPointerX = 0.5;
let sidebarPointerY = 0.5;

function updateSidebarParallax() {
  sidebarParallaxFrame = undefined;
  if (!sidebarShowcase || !sidebarVisible || reduceMotion) return;
  const bounds = sidebarShowcase.getBoundingClientRect();
  const viewportCenter = window.innerHeight * 0.5;
  const sectionCenter = bounds.top + bounds.height * 0.5;
  const distance = clamp(
    (viewportCenter - sectionCenter) / (window.innerHeight + bounds.height),
    -0.5,
    0.5,
  );
  sidebarShowcase.style.setProperty(
    "--sidebar-parallax",
    `${(distance * 28).toFixed(2)}px`,
  );
}

function requestSidebarParallax() {
  if (sidebarParallaxFrame || !sidebarVisible || reduceMotion) return;
  sidebarParallaxFrame = window.requestAnimationFrame(updateSidebarParallax);
}

function renderSidebarTilt() {
  sidebarTiltFrame = undefined;
  if (!sidebarProductFrame) return;
  const tiltX = (0.5 - sidebarPointerY) * 5;
  const tiltY = (sidebarPointerX - 0.5) * 6;
  sidebarProductFrame.style.setProperty(
    "--sidebar-tilt-x",
    `${tiltX.toFixed(2)}deg`,
  );
  sidebarProductFrame.style.setProperty(
    "--sidebar-tilt-y",
    `${tiltY.toFixed(2)}deg`,
  );
  sidebarProductFrame.style.setProperty(
    "--sidebar-light-x",
    `${(sidebarPointerX * 100).toFixed(1)}%`,
  );
  sidebarProductFrame.style.setProperty(
    "--sidebar-light-y",
    `${(sidebarPointerY * 100).toFixed(1)}%`,
  );
}

function handleSidebarPointerMove(event) {
  if (!sidebarProductFrame) return;
  const bounds = sidebarProductFrame.getBoundingClientRect();
  sidebarPointerX = clamp((event.clientX - bounds.left) / bounds.width);
  sidebarPointerY = clamp((event.clientY - bounds.top) / bounds.height);
  if (!sidebarTiltFrame) {
    sidebarTiltFrame = window.requestAnimationFrame(renderSidebarTilt);
  }
}

function handleSidebarPointerEnter() {
  sidebarProductFrame?.classList.add("is-hovered");
}

function handleSidebarPointerLeave() {
  sidebarPointerX = 0.5;
  sidebarPointerY = 0.5;
  sidebarProductFrame?.classList.remove("is-hovered");
  if (!sidebarTiltFrame) {
    sidebarTiltFrame = window.requestAnimationFrame(renderSidebarTilt);
  }
}

function cleanupSidebarShowcase() {
  sidebarObserver?.disconnect();
  window.cancelAnimationFrame(sidebarParallaxFrame);
  window.cancelAnimationFrame(sidebarTiltFrame);
  window.removeEventListener("scroll", requestSidebarParallax);
  window.removeEventListener("resize", requestSidebarParallax);
  sidebarProductFrame?.removeEventListener(
    "pointerenter",
    handleSidebarPointerEnter,
  );
  sidebarProductFrame?.removeEventListener(
    "pointermove",
    handleSidebarPointerMove,
  );
  sidebarProductFrame?.removeEventListener(
    "pointerleave",
    handleSidebarPointerLeave,
  );
}

if (sidebarShowcase) {
  if (reduceMotion) {
    sidebarShowcase.classList.add("is-visible");
  } else {
    sidebarObserver = new IntersectionObserver(
      ([entry]) => {
        sidebarVisible = entry.isIntersecting;
        if (sidebarVisible) {
          sidebarShowcase.classList.add("is-visible");
          requestSidebarParallax();
        }
      },
      { rootMargin: "80px", threshold: 0.18 },
    );
    sidebarObserver.observe(sidebarShowcase);
    window.addEventListener("scroll", requestSidebarParallax, {
      passive: true,
    });
    window.addEventListener("resize", requestSidebarParallax);
  }

  if (!reduceMotion && sidebarFinePointer.matches && sidebarProductFrame) {
    sidebarProductFrame.addEventListener(
      "pointerenter",
      handleSidebarPointerEnter,
    );
    sidebarProductFrame.addEventListener(
      "pointermove",
      handleSidebarPointerMove,
    );
    sidebarProductFrame.addEventListener(
      "pointerleave",
      handleSidebarPointerLeave,
    );
  }
}

const scoutShowcase = document.querySelector(".scout-showcase");
const scoutGallery = document.querySelector(".scout-gallery");
const scoutFeatureSlides = [
  ...document.querySelectorAll(".scout-feature-slide"),
];
const scoutShots = [...document.querySelectorAll(".scout-shot")];
const scoutProgressButtons = [...document.querySelectorAll("[data-scout-go]")];
const scoutArrowButtons = [
  ...document.querySelectorAll("[data-scout-direction]"),
];
const scoutPlayToggle = document.querySelector(".scout-play-toggle");
const scoutCarouselStatus = document.querySelector(".scout-carousel-status");
const scoutSlideNames = scoutFeatureSlides.map(
  (slide) => slide.querySelector("h3")?.textContent?.trim() ?? "Scout feature",
);
let scoutObserver;
let scoutVisible = false;
let scoutActiveIndex = 0;
let scoutTimer;
let scoutUserPaused = false;
let scoutFocusInside = false;
let scoutDragStart;
const scoutDuration = 6500;

function scoutShouldPlay() {
  const playToggleFocused = document.activeElement === scoutPlayToggle;
  return (
    scoutVisible &&
    !reduceMotion &&
    !scoutUserPaused &&
    (!scoutFocusInside || playToggleFocused) &&
    !document.hidden
  );
}

const agenticShowcase = document.querySelector(".agentic-showcase");
const agenticPanels = [...document.querySelectorAll("[data-agentic-panel]")];
const agenticTabs = [...document.querySelectorAll("[data-agentic-slide]")];
const agenticArrows = [
  ...document.querySelectorAll("[data-agentic-direction]"),
];
const agenticStatus = document.querySelector(".agentic-status");
const tabsComparison = document.querySelector(".tabs-comparison");
const tabsComparisonRange = document.querySelector(".tabs-comparison-range");
let activeAgenticSlide = 0;

function showAgenticSlide(index, { focus = false, announce = false } = {}) {
  if (!agenticPanels.length || !agenticTabs.length) return;
  activeAgenticSlide = (index + agenticPanels.length) % agenticPanels.length;

  agenticPanels.forEach((panel, panelIndex) => {
    const active = panelIndex === activeAgenticSlide;
    panel.classList.toggle("is-active", active);
    panel.setAttribute("aria-hidden", String(!active));
  });

  agenticTabs.forEach((tab, tabIndex) => {
    const active = tabIndex === activeAgenticSlide;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });

  if (focus) agenticTabs[activeAgenticSlide]?.focus();
  if (announce && agenticStatus) {
    const name =
      agenticTabs[activeAgenticSlide]
        ?.querySelector("strong")
        ?.textContent?.trim() ?? "Feature";
    agenticStatus.textContent = `${name}, slide ${activeAgenticSlide + 1} of ${agenticPanels.length}`;
  }
}

function handleAgenticKeydown(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    return;
  }
  event.preventDefault();
  if (event.key === "Home") {
    showAgenticSlide(0, { focus: true, announce: true });
  } else if (event.key === "End") {
    showAgenticSlide(agenticPanels.length - 1, {
      focus: true,
      announce: true,
    });
  } else {
    const direction = event.key === "ArrowRight" ? 1 : -1;
    showAgenticSlide(activeAgenticSlide + direction, {
      focus: true,
      announce: true,
    });
  }
}

if (agenticShowcase && agenticPanels.length && agenticTabs.length) {
  agenticTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      showAgenticSlide(Number(tab.dataset.agenticSlide), { announce: true });
    });
    tab.addEventListener("keydown", handleAgenticKeydown);
  });
  agenticArrows.forEach((button) => {
    button.addEventListener("click", () => {
      showAgenticSlide(
        activeAgenticSlide + Number(button.dataset.agenticDirection),
        { announce: true },
      );
    });
  });
  showAgenticSlide(0);
}

if (tabsComparison && tabsComparisonRange) {
  const updateTabsComparison = () => {
    tabsComparison.style.setProperty(
      "--tabs-compare",
      `${tabsComparisonRange.value}%`,
    );
  };
  tabsComparisonRange.addEventListener("input", updateTabsComparison);
  updateTabsComparison();
}

function updateScoutPauseState() {
  if (!scoutShowcase || !scoutPlayToggle) return;
  const transientPause =
    (scoutFocusInside && document.activeElement !== scoutPlayToggle) ||
    document.hidden;
  scoutShowcase.classList.toggle("is-paused", scoutUserPaused);
  scoutShowcase.classList.toggle(
    "is-transient-paused",
    transientPause && !scoutUserPaused,
  );
  scoutPlayToggle.setAttribute("aria-pressed", String(scoutUserPaused));
  scoutPlayToggle.setAttribute(
    "aria-label",
    scoutUserPaused ? "Play Scout slideshow" : "Pause Scout slideshow",
  );
  scoutPlayToggle.title = scoutUserPaused
    ? "Play slideshow"
    : "Pause slideshow";
  const icon = scoutPlayToggle.querySelector(".material-symbols-rounded");
  if (icon) icon.textContent = scoutUserPaused ? "play_arrow" : "pause";
}

function restartScoutProgress() {
  const progress =
    scoutProgressButtons[scoutActiveIndex]?.querySelector("span");
  if (!progress) return;
  progress.style.animation = "none";
  void progress.offsetWidth;
  progress.style.animation = "";
}

function scheduleScoutAdvance() {
  window.clearTimeout(scoutTimer);
  scoutTimer = undefined;
  updateScoutPauseState();
  if (!scoutShouldPlay()) return;
  scoutTimer = window.setTimeout(() => {
    showScoutSlide(scoutActiveIndex + 1);
  }, scoutDuration);
}

function showScoutSlide(index, { announce = false } = {}) {
  if (!scoutFeatureSlides.length) return;
  scoutActiveIndex =
    (index + scoutFeatureSlides.length) % scoutFeatureSlides.length;

  scoutFeatureSlides.forEach((slide, slideIndex) => {
    const isActive = slideIndex === scoutActiveIndex;
    slide.hidden = !isActive;
    slide.classList.toggle("is-active", isActive);
    slide.setAttribute("aria-hidden", String(!isActive));
  });

  scoutShots.forEach((shot, shotIndex) => {
    const distance =
      (shotIndex - scoutActiveIndex + scoutShots.length) % scoutShots.length;
    shot.classList.remove("is-active", "is-next", "is-far", "is-previous");
    shot.classList.add(
      ["is-active", "is-next", "is-far", "is-previous"][distance],
    );
    const isActive = distance === 0;
    shot.setAttribute("aria-current", isActive ? "true" : "false");
    shot.tabIndex = isActive ? 0 : -1;
  });

  scoutProgressButtons.forEach((button, buttonIndex) => {
    if (buttonIndex === scoutActiveIndex) {
      button.setAttribute("aria-current", "true");
    } else {
      button.removeAttribute("aria-current");
    }
  });
  restartScoutProgress();

  if (announce && scoutCarouselStatus) {
    scoutCarouselStatus.textContent = `${scoutSlideNames[scoutActiveIndex]}, slide ${scoutActiveIndex + 1} of ${scoutFeatureSlides.length}`;
  }
  scheduleScoutAdvance();
}

function setScoutTransientPause(kind, active) {
  if (kind === "focus") scoutFocusInside = active;
  if (!active) restartScoutProgress();
  scheduleScoutAdvance();
}

function handleScoutGalleryKeydown(event) {
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    showScoutSlide(scoutActiveIndex - 1, { announce: true });
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    showScoutSlide(scoutActiveIndex + 1, { announce: true });
  } else if (event.key === "Home") {
    event.preventDefault();
    showScoutSlide(0, { announce: true });
  } else if (event.key === "End") {
    event.preventDefault();
    showScoutSlide(scoutFeatureSlides.length - 1, { announce: true });
  }
}

function handleScoutPointerDown(event) {
  scoutDragStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
}

function handleScoutPointerUp(event) {
  if (!scoutDragStart || scoutDragStart.id !== event.pointerId) return;
  const deltaX = event.clientX - scoutDragStart.x;
  const deltaY = event.clientY - scoutDragStart.y;
  scoutDragStart = undefined;
  if (Math.abs(deltaX) < 48 || Math.abs(deltaX) < Math.abs(deltaY) * 1.25) {
    return;
  }
  showScoutSlide(scoutActiveIndex + (deltaX < 0 ? 1 : -1), {
    announce: true,
  });
}

function cleanupScoutShowcase() {
  scoutObserver?.disconnect();
  window.clearTimeout(scoutTimer);
  document.removeEventListener("visibilitychange", scheduleScoutAdvance);
  scoutGallery?.removeEventListener("keydown", handleScoutGalleryKeydown);
  scoutGallery?.removeEventListener("pointerdown", handleScoutPointerDown);
  scoutGallery?.removeEventListener("pointerup", handleScoutPointerUp);
}

if (
  scoutShowcase &&
  scoutGallery &&
  scoutFeatureSlides.length &&
  scoutShots.length
) {
  scoutObserver = new IntersectionObserver(
    ([entry]) => {
      scoutVisible = entry.isIntersecting;
      if (scoutVisible) {
        scoutShowcase.classList.add("is-visible");
        restartScoutProgress();
      }
      scheduleScoutAdvance();
    },
    { rootMargin: "100px", threshold: 0.18 },
  );
  scoutObserver.observe(scoutShowcase);

  scoutProgressButtons.forEach((button) => {
    button.addEventListener("click", () => {
      showScoutSlide(Number(button.dataset.scoutGo), { announce: true });
    });
  });
  scoutArrowButtons.forEach((button) => {
    button.addEventListener("click", () => {
      showScoutSlide(scoutActiveIndex + Number(button.dataset.scoutDirection), {
        announce: true,
      });
    });
  });
  scoutShots.forEach((shot) => {
    shot.addEventListener("click", () => {
      showScoutSlide(Number(shot.dataset.scoutSlide), { announce: true });
    });
  });
  scoutPlayToggle?.addEventListener("click", () => {
    scoutUserPaused = !scoutUserPaused;
    if (!scoutUserPaused) restartScoutProgress();
    scheduleScoutAdvance();
  });

  scoutShowcase.addEventListener("focusin", () =>
    setScoutTransientPause("focus", true),
  );
  scoutShowcase.addEventListener("focusout", () => {
    window.setTimeout(() => {
      setScoutTransientPause(
        "focus",
        scoutShowcase.contains(document.activeElement),
      );
    }, 0);
  });
  scoutGallery.addEventListener("keydown", handleScoutGalleryKeydown);
  scoutGallery.addEventListener("pointerdown", handleScoutPointerDown);
  scoutGallery.addEventListener("pointerup", handleScoutPointerUp);
  document.addEventListener("visibilitychange", scheduleScoutAdvance);

  showScoutSlide(0);
}

const hyperdriveSection = document.querySelector(".hyperdrive-feature");
const hyperdriveStage = document.querySelector(".hyperdrive-stage");
const hyperdriveCanvas = document.querySelector(".hyperdrive-field");
const hyperdriveContext = hyperdriveCanvas?.getContext("2d");
const hyperdriveTones = [
  "255, 255, 255",
  "115, 224, 208",
  "191, 210, 255",
  "255, 148, 122",
];
let hyperdriveWidth = 0;
let hyperdriveHeight = 0;
let hyperdriveRatio = 1;
let hyperdriveFrame;
let hyperdriveLastTime = 0;
let hyperdriveVisible = false;
let hyperdriveStars = [];
let hyperdriveProgress = reduceMotion ? 1 : 0;
let hyperdriveScrollFrame;

function createHyperdriveStar(mode = "intro") {
  return {
    angle: Math.random() * Math.PI * 2,
    depth:
      mode === "stable"
        ? Math.random()
        : mode === "respawn"
          ? 0.015 + Math.random() * 0.025
          : 0.008 + Math.random() * 0.12,
    speed: 0.7 + Math.random() * 0.75,
    tone: hyperdriveTones[Math.floor(Math.random() * hyperdriveTones.length)],
  };
}

function smoothstep(value) {
  const resolved = clamp(value);
  return resolved * resolved * (3 - 2 * resolved);
}

function hyperdrivePhase(start, end) {
  return smoothstep((hyperdriveProgress - start) / (end - start));
}

function setHyperdriveReveal(name, value, shift) {
  if (!hyperdriveStage) return;
  hyperdriveStage.style.setProperty(
    `--hyperdrive-${name}-opacity`,
    value.toFixed(4),
  );
  hyperdriveStage.style.setProperty(
    `--hyperdrive-${name}-shift`,
    `${((1 - value) * shift).toFixed(2)}px`,
  );
}

function seedHyperdriveStars(mode = "intro") {
  const starCount = hyperdriveWidth < 721 ? 92 : 180;

  if (hyperdriveStars.length > starCount) {
    hyperdriveStars.length = starCount;
  }

  while (hyperdriveStars.length < starCount) {
    hyperdriveStars.push(createHyperdriveStar(mode));
  }
}

function resizeHyperdrive() {
  if (!hyperdriveCanvas || !hyperdriveContext) return;
  const bounds = hyperdriveCanvas.getBoundingClientRect();
  hyperdriveWidth = bounds.width;
  hyperdriveHeight = bounds.height;
  hyperdriveRatio = Math.min(
    window.devicePixelRatio || 1,
    hyperdriveWidth < 721 ? 1.5 : 1.75,
  );
  hyperdriveCanvas.width = Math.round(hyperdriveWidth * hyperdriveRatio);
  hyperdriveCanvas.height = Math.round(hyperdriveHeight * hyperdriveRatio);
  hyperdriveContext.setTransform(hyperdriveRatio, 0, 0, hyperdriveRatio, 0, 0);
  seedHyperdriveStars(
    reduceMotion || hyperdriveProgress >= 0.67 ? "stable" : "intro",
  );
  renderHyperdrive(0, true);
}

function getHyperdriveMotion() {
  if (reduceMotion) {
    return {
      alpha: 0.58,
      speed: 0,
      trailBase: 0.018,
      trailDepth: 0.075,
      travel: 0,
    };
  }

  if (hyperdriveProgress < 0.12) {
    return {
      alpha: 0,
      speed: 0,
      trailBase: 0.001,
      trailDepth: 0.002,
      travel: 0,
    };
  }

  if (hyperdriveProgress < 0.29) {
    const ignition = hyperdrivePhase(0.12, 0.29);
    return {
      alpha: easeOutCubic(ignition),
      speed: 0.05 + Math.pow(ignition, 3) * 0.6,
      trailBase: 0.001 + ignition * 0.004,
      trailDepth: 0.002 + ignition * 0.014,
      travel: ignition * 0.02,
    };
  }

  if (hyperdriveProgress < 0.52) {
    const jump = hyperdrivePhase(0.29, 0.52);
    const acceleration = Math.pow(jump, 3);
    return {
      alpha: 1,
      speed: 0.65 + acceleration * 5.35,
      trailBase: 0.005 + easeOutCubic(jump) * 0.012,
      trailDepth: 0.016 + easeOutCubic(jump) * 0.2,
      travel: 0.02 + easeOutCubic(jump) * 0.8,
    };
  }

  if (hyperdriveProgress < 0.67) {
    const settle = easeOutCubic(hyperdrivePhase(0.52, 0.67));
    return {
      alpha: 1,
      speed: 6 - settle * 5,
      trailBase: 0.017 + settle * 0.001,
      trailDepth: 0.216 - settle * 0.141,
      travel: 0.82 + settle * 0.18,
    };
  }

  return {
    alpha: 1,
    speed: 1,
    trailBase: 0.018,
    trailDepth: 0.075,
    travel: 0,
  };
}

function renderHyperdrive(time, staticFrame = false) {
  hyperdriveFrame = undefined;
  if (!hyperdriveContext || !hyperdriveWidth || !hyperdriveHeight) return;

  const delta = hyperdriveLastTime
    ? Math.min(40, Math.max(0, time - hyperdriveLastTime))
    : 16;
  hyperdriveLastTime = time;
  const spaceTone = Math.round(5 * hyperdrivePhase(0.5, 0.67));
  const spaceBlue = Math.round(9 * hyperdrivePhase(0.5, 0.67));
  hyperdriveContext.fillStyle = `rgb(${spaceTone}, ${spaceTone}, ${spaceBlue})`;
  hyperdriveContext.fillRect(0, 0, hyperdriveWidth, hyperdriveHeight);

  const motion = getHyperdriveMotion();
  const centerX = hyperdriveWidth * 0.5;
  const centerY = hyperdriveHeight * 0.5;
  const maxRadius = Math.hypot(hyperdriveWidth, hyperdriveHeight) * 0.62;
  hyperdriveContext.lineCap = "round";

  if (motion.alpha > 0) {
    hyperdriveStars.forEach((star, index) => {
      if (!staticFrame && !reduceMotion) {
        star.depth +=
          delta *
          0.00019 *
          star.speed *
          motion.speed *
          (0.72 + star.depth * 2.4);
      }
      if (star.depth > 1) {
        hyperdriveStars[index] = createHyperdriveStar("respawn");
        return;
      }

      const visualDepth = (star.depth + motion.travel) % 1;
      const headRadius = 12 + Math.pow(visualDepth, 2.05) * maxRadius;
      const tailDepth = Math.max(
        0,
        visualDepth - (motion.trailBase + visualDepth * motion.trailDepth),
      );
      const tailRadius = 12 + Math.pow(tailDepth, 2.05) * maxRadius;
      const verticalScale = 0.72;
      const headX = centerX + Math.cos(star.angle) * headRadius;
      const headY = centerY + Math.sin(star.angle) * headRadius * verticalScale;
      const tailX = centerX + Math.cos(star.angle) * tailRadius;
      const tailY = centerY + Math.sin(star.angle) * tailRadius * verticalScale;
      const opacity = (0.16 + visualDepth * 0.78) * motion.alpha;

      hyperdriveContext.strokeStyle = `rgba(${star.tone}, ${opacity})`;
      hyperdriveContext.lineWidth =
        (0.6 + visualDepth * 2.4) * (1 + Math.max(0, motion.speed - 1) * 0.055);
      hyperdriveContext.beginPath();
      hyperdriveContext.moveTo(tailX, tailY);
      hyperdriveContext.lineTo(headX, headY);
      hyperdriveContext.stroke();
    });
  }

  if (!staticFrame && !reduceMotion && hyperdriveVisible) {
    hyperdriveFrame = window.requestAnimationFrame(renderHyperdrive);
  }
}

function updateHyperdriveScroll() {
  hyperdriveScrollFrame = undefined;
  if (!hyperdriveSection || !hyperdriveStage) return;

  if (reduceMotion) {
    hyperdriveProgress = 1;
  } else {
    const bounds = hyperdriveSection.getBoundingClientRect();
    const scrollDistance = Math.max(1, bounds.height - window.innerHeight);
    hyperdriveProgress =
      bounds.top >= 0 ? 0 : clamp(-bounds.top / scrollDistance);
  }

  setHyperdriveReveal("kicker", hyperdrivePhase(0.67, 0.74), 12);
  setHyperdriveReveal("title", hyperdrivePhase(0.72, 0.82), 24);
  setHyperdriveReveal("summary", hyperdrivePhase(0.78, 0.88), 18);
  setHyperdriveReveal("privacy", hyperdrivePhase(0.84, 0.94), 14);
  setHyperdriveReveal("path", hyperdrivePhase(0.9, 1), 12);

  const flashDistance = Math.abs(hyperdriveProgress - 0.5) / 0.055;
  const flash = reduceMotion ? 0 : Math.max(0, 1 - flashDistance) * 0.13;
  hyperdriveStage.style.setProperty("--hyperdrive-flash", flash.toFixed(4));
}

function requestHyperdriveScroll() {
  if (hyperdriveScrollFrame) return;
  hyperdriveScrollFrame = window.requestAnimationFrame(updateHyperdriveScroll);
}

function handleHyperdriveResize() {
  resizeHyperdrive();
  updateHyperdriveScroll();
}

if (
  hyperdriveSection &&
  hyperdriveCanvas &&
  hyperdriveContext &&
  hyperdriveStage
) {
  updateHyperdriveScroll();
  resizeHyperdrive();
  window.addEventListener("resize", handleHyperdriveResize);

  if (!reduceMotion) {
    window.addEventListener("scroll", requestHyperdriveScroll, {
      passive: true,
    });
    const hyperdriveObserver = new IntersectionObserver(
      ([entry]) => {
        hyperdriveVisible = entry.isIntersecting;
        requestHyperdriveScroll();
        if (hyperdriveVisible && !hyperdriveFrame) {
          hyperdriveLastTime = 0;
          hyperdriveFrame = window.requestAnimationFrame(renderHyperdrive);
        } else if (!hyperdriveVisible && hyperdriveFrame) {
          window.cancelAnimationFrame(hyperdriveFrame);
          hyperdriveFrame = undefined;
        }
      },
      { rootMargin: "100px", threshold: 0.15 },
    );
    hyperdriveObserver.observe(hyperdriveStage);
  }
}

const silenceSection = document.querySelector(".silence-feature");
const silenceStage = document.querySelector(".silence-stage");
const silenceWord = document.querySelector(".silence-word");
const emailStack = document.querySelector(".email-stack");
const emailCount = document.querySelector(".email-count");
const silenceToggle = document.querySelector(".silence-toggle");
const silenceReveal = document.querySelector(".silence-reveal");
const silenceStatus = document.querySelector(".silence-status");
const silenceTimers = new Set();
const emailSenders = [
  "Design team",
  "Build report",
  "News digest",
  "Calendar",
  "Project update",
  "Account alert",
  "Social",
  "Shared document",
];
const emailSubjects = [
  "New comment on your draft",
  "Your daily summary is ready",
  "Meeting moved by 15 minutes",
  "You have 8 new mentions",
  "A new sign-in was detected",
  "Three files were shared with you",
  "This week in your inbox",
  "Quick question before you go",
];
let silenceHasStarted = false;
let silenceComplete = false;
let floodTimer;
let unreadCount = 0;

function scheduleSilence(callback, delay) {
  const timer = window.setTimeout(() => {
    silenceTimers.delete(timer);
    callback();
  }, delay);
  silenceTimers.add(timer);
  return timer;
}

function clearSilenceTimers() {
  silenceTimers.forEach((timer) => window.clearTimeout(timer));
  silenceTimers.clear();
  window.clearInterval(floodTimer);
  floodTimer = undefined;
}

function showSilenceWord(word) {
  if (!silenceWord) return;
  silenceWord.classList.remove("is-entering");
  silenceWord.textContent = word;
  window.requestAnimationFrame(() => {
    silenceWord.classList.add("is-entering");
    scheduleSilence(() => silenceWord.classList.remove("is-entering"), 340);
  });
}

function createEmailNotification(index) {
  const notification = document.createElement("div");
  const icon = document.createElement("span");
  const message = document.createElement("span");
  const sender = document.createElement("strong");
  const subject = document.createElement("small");

  notification.className = "email-notification";
  icon.className = "material-symbols-rounded";
  icon.textContent = "mail";
  sender.textContent = emailSenders[index % emailSenders.length];
  subject.textContent = emailSubjects[index % emailSubjects.length];
  message.append(sender, subject);
  notification.append(icon, message);
  return notification;
}

function startEmailFlood() {
  if (!silenceSection || !emailStack || !emailCount) return;
  emailStack.replaceChildren();
  unreadCount = 0;
  emailCount.textContent = "0 unread";
  silenceSection.classList.add("is-flooding");

  floodTimer = window.setInterval(() => {
    const notification = createEmailNotification(unreadCount);
    emailStack.prepend(notification);
    unreadCount += 1;
    emailCount.textContent = `${unreadCount} unread`;

    if (unreadCount >= 100) {
      window.clearInterval(floodTimer);
      floodTimer = undefined;
    }
  }, 20);
}

function setQuietMode(isQuiet, announce = true) {
  if (!silenceSection || !silenceToggle || !silenceReveal) return;
  silenceSection.classList.toggle("is-silent", isQuiet);
  silenceToggle.setAttribute("aria-pressed", String(isQuiet));
  silenceToggle.setAttribute(
    "aria-label",
    isQuiet ? "Turn off quiet mode" : "Turn on quiet mode",
  );
  silenceReveal.setAttribute("aria-hidden", String(!isQuiet));

  if (announce && silenceStatus) {
    silenceStatus.textContent = isQuiet
      ? "Notifications silenced."
      : "Notifications restored.";
  }
}

function finishSilenceStory(announce = true) {
  window.clearInterval(floodTimer);
  floodTimer = undefined;
  silenceComplete = true;
  setQuietMode(true, announce);
}

function startSilenceStory() {
  if (silenceHasStarted || silenceComplete || !silenceSection) return;
  silenceHasStarted = true;
  silenceSection.classList.add("is-active");
  showSilenceWord("Turn.");
  scheduleSilence(() => showSilenceWord("It."), 500);
  scheduleSilence(() => showSilenceWord("OFF."), 1000);
  scheduleSilence(startEmailFlood, 1150);
  scheduleSilence(() => finishSilenceStory(true), 3400);
}

silenceToggle?.addEventListener("click", () => {
  const nextQuietState = silenceToggle.getAttribute("aria-pressed") !== "true";
  clearSilenceTimers();
  silenceComplete = nextQuietState;
  silenceHasStarted = true;
  setQuietMode(nextQuietState, true);
});

if (silenceSection && silenceStage) {
  if (reduceMotion) {
    if (silenceWord) silenceWord.textContent = "OFF.";
    silenceHasStarted = true;
    silenceComplete = true;
    setQuietMode(true, false);
  } else {
    const silenceObserver = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) startSilenceStory();
      },
      { threshold: 0.55 },
    );
    silenceObserver.observe(silenceStage);
  }
}

const canvas = document.querySelector(".dot-field");
const context = canvas?.getContext("2d");
const palette = [
  [252, 105, 79],
  [100, 21, 67],
  [79, 215, 199],
  [76, 211, 160],
  [89, 174, 209],
];

let width = 0;
let height = 0;
let pixelRatio = 1;
let animationFrame;
let canvasVisible = true;

function resizeCanvas() {
  if (!canvas || !context) return;

  const bounds = canvas.getBoundingClientRect();
  pixelRatio = Math.min(window.devicePixelRatio || 1, width < 721 ? 1.5 : 2);
  width = bounds.width;
  height = bounds.height;
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
}

function drawDot(x, y, radius, stretch, color, alpha, time) {
  if (!context) return;

  const wobble = Math.sin(time * 0.001 + x * 0.009) * radius * 0.05;
  const gradient = context.createRadialGradient(
    x - radius * 0.25,
    y - radius * 0.25,
    radius * 0.06,
    x,
    y,
    radius,
  );
  const [red, green, blue] = color;
  gradient.addColorStop(0, `rgba(${red}, ${green}, ${blue}, ${alpha})`);
  gradient.addColorStop(
    0.44,
    `rgba(${red}, ${green}, ${blue}, ${alpha * 0.76})`,
  );
  gradient.addColorStop(
    0.78,
    `rgba(${red}, ${green}, ${blue}, ${alpha * 0.25})`,
  );
  gradient.addColorStop(1, `rgba(${red}, ${green}, ${blue}, 0)`);

  context.save();
  context.filter = "blur(7px)";
  context.fillStyle = gradient;
  context.beginPath();
  context.ellipse(x, y + wobble, radius * stretch, radius, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function render(time) {
  animationFrame = undefined;
  if (!context || !width || !height) return;

  context.clearRect(0, 0, width, height);
  const animationTime = reduceMotion ? 0 : time;
  const isMobile = width < 721;
  const baseline = height * (isMobile ? 0.77 : 0.62);
  const minDimension = Math.min(width, height);
  const count = isMobile ? 10 : 14;

  for (let index = 0; index < count; index += 1) {
    const progress = index / (count - 1);
    const x = -minDimension * 0.06 + progress * (width + minDimension * 0.12);
    const wave = Math.sin(progress * Math.PI * 2.3 + animationTime * 0.00045);
    const radiusBase = minDimension * (0.014 + progress * 0.095);
    const radius =
      radiusBase * (1 + Math.sin(animationTime * 0.0011 + index) * 0.06);
    const y = baseline - radius * 0.54 + wave * minDimension * 0.075;
    const stretch = 0.62 + (index % 4) * 0.12;

    drawDot(
      x,
      y,
      radius * 1.55,
      stretch,
      palette[(index + 1) % palette.length],
      0.5,
      animationTime,
    );
    drawDot(
      x - radius * 0.12,
      y + radius * 0.04,
      radius,
      stretch,
      palette[index % palette.length],
      0.78,
      animationTime,
    );
    drawDot(
      x + radius * 0.13,
      y - radius * 0.08,
      radius * 0.55,
      stretch,
      palette[(index + 3) % palette.length],
      0.48,
      animationTime,
    );
  }

  if (!reduceMotion && canvasVisible) {
    animationFrame = window.requestAnimationFrame(render);
  }
}

if (canvas && context) {
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
  animationFrame = window.requestAnimationFrame(render);

  if (!reduceMotion) {
    const canvasObserver = new IntersectionObserver(
      ([entry]) => {
        canvasVisible = entry.isIntersecting;
        if (canvasVisible && !animationFrame) {
          animationFrame = window.requestAnimationFrame(render);
        } else if (!canvasVisible && animationFrame) {
          window.cancelAnimationFrame(animationFrame);
          animationFrame = undefined;
        }
      },
      { rootMargin: "120px" },
    );
    canvasObserver.observe(canvas);
  }
}

window.addEventListener("beforeunload", () => {
  window.cancelAnimationFrame(animationFrame);
  window.cancelAnimationFrame(hyperdriveFrame);
  window.cancelAnimationFrame(hyperdriveScrollFrame);
  cleanupExtensionsShowcase();
  cleanupSidebarShowcase();
  cleanupScoutShowcase();
  clearSilenceTimers();
});
