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

function createHyperdriveStar(initial = true) {
  return {
    angle: Math.random() * Math.PI * 2,
    depth: initial ? Math.random() : 0.015 + Math.random() * 0.025,
    speed: 0.7 + Math.random() * 0.75,
    tone: hyperdriveTones[Math.floor(Math.random() * hyperdriveTones.length)],
  };
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
  const starCount = hyperdriveWidth < 721 ? 92 : 180;
  hyperdriveStars = Array.from({ length: starCount }, () =>
    createHyperdriveStar(true),
  );
  renderHyperdrive(0, true);
}

function renderHyperdrive(time, staticFrame = false) {
  hyperdriveFrame = undefined;
  if (!hyperdriveContext || !hyperdriveWidth || !hyperdriveHeight) return;

  const delta = hyperdriveLastTime
    ? Math.min(40, Math.max(0, time - hyperdriveLastTime))
    : 16;
  hyperdriveLastTime = time;
  hyperdriveContext.fillStyle = "#050509";
  hyperdriveContext.fillRect(0, 0, hyperdriveWidth, hyperdriveHeight);

  const centerX = hyperdriveWidth * 0.5;
  const centerY = hyperdriveHeight * 0.5;
  const maxRadius = Math.hypot(hyperdriveWidth, hyperdriveHeight) * 0.62;
  hyperdriveContext.lineCap = "round";

  hyperdriveStars.forEach((star, index) => {
    if (!staticFrame && !reduceMotion) {
      star.depth += delta * 0.00019 * star.speed * (0.72 + star.depth * 2.4);
    }
    if (star.depth > 1) {
      hyperdriveStars[index] = createHyperdriveStar(false);
      return;
    }

    const headRadius = 12 + Math.pow(star.depth, 2.05) * maxRadius;
    const tailDepth = Math.max(0, star.depth - (0.018 + star.depth * 0.075));
    const tailRadius = 12 + Math.pow(tailDepth, 2.05) * maxRadius;
    const verticalScale = 0.72;
    const headX = centerX + Math.cos(star.angle) * headRadius;
    const headY = centerY + Math.sin(star.angle) * headRadius * verticalScale;
    const tailX = centerX + Math.cos(star.angle) * tailRadius;
    const tailY = centerY + Math.sin(star.angle) * tailRadius * verticalScale;
    const opacity = 0.16 + star.depth * 0.78;

    hyperdriveContext.strokeStyle = `rgba(${star.tone}, ${opacity})`;
    hyperdriveContext.lineWidth = 0.6 + star.depth * 2.4;
    hyperdriveContext.beginPath();
    hyperdriveContext.moveTo(tailX, tailY);
    hyperdriveContext.lineTo(headX, headY);
    hyperdriveContext.stroke();
  });

  if (!staticFrame && !reduceMotion && hyperdriveVisible) {
    hyperdriveFrame = window.requestAnimationFrame(renderHyperdrive);
  }
}

if (hyperdriveCanvas && hyperdriveContext && hyperdriveStage) {
  resizeHyperdrive();
  window.addEventListener("resize", resizeHyperdrive);

  if (reduceMotion) {
    hyperdriveStage.classList.add("is-engaged");
  } else {
    const hyperdriveObserver = new IntersectionObserver(
      ([entry]) => {
        hyperdriveVisible = entry.isIntersecting;
        hyperdriveStage.classList.toggle("is-engaged", hyperdriveVisible);
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
  clearSilenceTimers();
});
