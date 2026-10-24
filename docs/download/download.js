const platformButtons = document.querySelectorAll(".platform-option");
const statusRegion = document.querySelector(".download-status");
const editionName = document.body.dataset.edition || "Chromecraft";
const isNitroPage = document.body.classList.contains("nitro");
const isVanillaPage = document.body.classList.contains("vanilla");
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

      if (isVanillaPage) {
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

    if (isVanillaPage) {
      const selectionPanel = document.querySelector(".vanilla-selection-panel");
      const selectionName = document.querySelector("[data-vanilla-selection]");
      const selectionCopy = document.querySelector(
        "[data-vanilla-selection-copy]",
      );
      const selectionStatus = document.querySelector(
        "[data-vanilla-selection-status]",
      );

      selectionPanel?.classList.add("has-selection");
      if (selectionName) {
        selectionName.textContent = `Vanilla for ${button.dataset.platform}`;
      }
      if (selectionCopy) {
        selectionCopy.textContent = `${button.dataset.platform} support is in the works.`;
      }
      if (selectionStatus) selectionStatus.textContent = "Coming soon";
    }

    if (statusRegion) {
      statusRegion.textContent = `${editionName} for ${button.dataset.platform} is coming soon.`;
      statusRegion.classList.add("visible");
    }
  });
});

if (isVanillaPage) {
  const paletteButtons = [
    ...document.querySelectorAll(".vanilla-palette [data-vanilla-theme]"),
  ];
  const atmosphere = document.querySelector(".vanilla-atmosphere");
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  paletteButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const theme = button.dataset.vanillaTheme;
      document.body.dataset.vanillaTheme = theme;
      paletteButtons.forEach((candidate) => {
        const selected = candidate === button;
        candidate.classList.toggle("is-selected", selected);
        candidate.setAttribute("aria-pressed", String(selected));
      });
    });
  });

  if (!reduceMotion && atmosphere) {
    let atmosphereFrame = 0;
    let pointerX = window.innerWidth * 0.72;
    let pointerY = window.innerHeight * 0.28;

    window.addEventListener(
      "pointermove",
      (event) => {
        pointerX = event.clientX;
        pointerY = event.clientY;
        if (atmosphereFrame) return;
        atmosphereFrame = requestAnimationFrame(() => {
          atmosphere.style.setProperty(
            "--vanilla-pointer-x",
            `${(pointerX / window.innerWidth) * 100}%`,
          );
          atmosphere.style.setProperty(
            "--vanilla-pointer-y",
            `${(pointerY / window.innerHeight) * 100}%`,
          );
          atmosphereFrame = 0;
        });
      },
      { passive: true },
    );
  }

  if (!reduceMotion) {
    platformButtons.forEach((button) => {
      let cardFrame = 0;
      let cardX = 0;
      let cardY = 0;

      button.addEventListener(
        "pointermove",
        (event) => {
          const bounds = button.getBoundingClientRect();
          cardX = event.clientX - bounds.left;
          cardY = event.clientY - bounds.top;
          if (cardFrame) return;
          cardFrame = requestAnimationFrame(() => {
            button.style.setProperty("--vanilla-card-x", `${cardX}px`);
            button.style.setProperty("--vanilla-card-y", `${cardY}px`);
            cardFrame = 0;
          });
        },
        { passive: true },
      );

      button.addEventListener("pointerleave", () => {
        button.style.setProperty("--vanilla-card-x", "50%");
        button.style.setProperty("--vanilla-card-y", "50%");
      });
    });
  }
}

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
