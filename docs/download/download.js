const platformButtons = document.querySelectorAll(".platform-option");
const statusRegion = document.querySelector(".download-status");
const editionName = document.body.dataset.edition || "Chromecraft";
const isNitroPage = document.body.classList.contains("nitro");
const terminalPlatform = document.querySelector("[data-terminal-platform]");
const terminalBuild = document.querySelector("[data-terminal-build]");
const terminalStatus = document.querySelector("[data-terminal-status]");
const terminalIndicator = document.querySelector(".nitro-terminal-bar b");

platformButtons.forEach((button) => {
  button.addEventListener("click", () => {
    platformButtons.forEach((candidate) => {
      const isSelected = candidate === button;
      candidate.classList.toggle("selected", isSelected);
      candidate.setAttribute("aria-pressed", String(isSelected));

      if (isNitroPage) {
        const badge = candidate.querySelector(".coming-badge");
        if (badge) {
          badge.textContent = isSelected ? "Platform selected" : "Coming soon";
        }
      }
    });

    if (isNitroPage) {
      if (terminalPlatform) {
        terminalPlatform.textContent = button.dataset.platform.toUpperCase();
      }
      if (terminalBuild) terminalBuild.textContent = "QUEUED";
      if (terminalStatus) terminalStatus.textContent = "COMING SOON";
      if (terminalIndicator) terminalIndicator.textContent = "MODULE LOCKED";
    }

    if (statusRegion) {
      statusRegion.textContent = `${editionName} for ${button.dataset.platform} is coming soon.`;
      statusRegion.classList.add("visible");
    }
  });
});

if (isNitroPage) {
  const atmosphere = document.querySelector(".nitro-atmosphere");
  const counters = [...document.querySelectorAll("[data-nitro-counter]")];
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  if (reduceMotion) {
    counters.forEach((counter) => {
      counter.textContent = counter.dataset.nitroCounter;
    });
  } else {
    const counterStart = performance.now();
    const counterDuration = 1100;

    function updateCounters(now) {
      const progress = Math.min((now - counterStart) / counterDuration, 1);
      const easedProgress = 1 - Math.pow(1 - progress, 3);
      counters.forEach((counter) => {
        const target = Number(counter.dataset.nitroCounter);
        counter.textContent = String(
          Math.round(target * easedProgress),
        ).padStart(counter.closest(".nitro-hud-primary") ? 3 : 1, "0");
      });
      if (progress < 1) requestAnimationFrame(updateCounters);
    }

    requestAnimationFrame(updateCounters);
  }

  if (atmosphere && !reduceMotion) {
    let pointerFrame = 0;
    let pointerX = window.innerWidth / 2;
    let pointerY = window.innerHeight * 0.34;

    window.addEventListener(
      "pointermove",
      (event) => {
        pointerX = event.clientX;
        pointerY = event.clientY;
        if (pointerFrame) return;
        pointerFrame = requestAnimationFrame(() => {
          atmosphere.style.setProperty(
            "--nitro-pointer-x",
            `${(pointerX / window.innerWidth) * 100}%`,
          );
          atmosphere.style.setProperty(
            "--nitro-pointer-y",
            `${(pointerY / window.innerHeight) * 100}%`,
          );
          pointerFrame = 0;
        });
      },
      { passive: true },
    );
  }
}
