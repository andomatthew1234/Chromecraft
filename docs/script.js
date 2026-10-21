const words = ["Browse", "Play", "Stream", "Ask", "Call", "Work"];
const wordElement = document.querySelector(".rotating-word");

let wordIndex = 0;

function rotateWord() {
  if (
    !wordElement ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
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

window.setInterval(rotateWord, 1000);

const colorSlider = document.querySelector(".appearance-slider");
const sliderValue = document.querySelector(".slider-value");

if (colorSlider && sliderValue) {
  colorSlider.addEventListener("input", () => {
    sliderValue.value = `${colorSlider.value}%`;
    sliderValue.textContent = `${colorSlider.value}%`;
  });
}

const materialTabs = document.querySelectorAll(".material-tabs button");
const materialChip = document.querySelector(".material-chip");

materialTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    materialTabs.forEach((candidate) => {
      const isActive = candidate === tab;
      candidate.classList.toggle("active", isActive);
      candidate.setAttribute("aria-pressed", String(isActive));
    });
  });
});

materialChip?.addEventListener("click", () => {
  const isSelected = materialChip.getAttribute("aria-pressed") === "true";
  materialChip.setAttribute("aria-pressed", String(!isSelected));
  materialChip.classList.toggle("is-selected", !isSelected);
});

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

function resizeCanvas() {
  if (!canvas || !context) return;

  const bounds = canvas.getBoundingClientRect();
  pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
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
  if (!context || !width || !height) return;

  context.clearRect(0, 0, width, height);
  const isMobile = width < 721;
  const baseline = height * (isMobile ? 0.77 : 0.62);
  const minDimension = Math.min(width, height);
  const count = isMobile ? 10 : 14;

  for (let index = 0; index < count; index += 1) {
    const progress = index / (count - 1);
    const x = -minDimension * 0.06 + progress * (width + minDimension * 0.12);
    const wave = Math.sin(progress * Math.PI * 2.3 + time * 0.00045);
    const radiusBase = minDimension * (0.014 + progress * 0.095);
    const radius = radiusBase * (1 + Math.sin(time * 0.0011 + index) * 0.06);
    const y = baseline - radius * 0.54 + wave * minDimension * 0.075;
    const stretch = 0.62 + (index % 4) * 0.12;

    drawDot(
      x,
      y,
      radius * 1.55,
      stretch,
      palette[(index + 1) % palette.length],
      0.5,
      time,
    );
    drawDot(
      x - radius * 0.12,
      y + radius * 0.04,
      radius,
      stretch,
      palette[index % palette.length],
      0.78,
      time,
    );
    drawDot(
      x + radius * 0.13,
      y - radius * 0.08,
      radius * 0.55,
      stretch,
      palette[(index + 3) % palette.length],
      0.48,
      time,
    );
  }

  animationFrame = window.requestAnimationFrame(render);
}

if (canvas && context) {
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
  animationFrame = window.requestAnimationFrame(render);
}

window.addEventListener("beforeunload", () =>
  window.cancelAnimationFrame(animationFrame),
);
