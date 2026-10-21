const platformButtons = document.querySelectorAll(".platform-option");
const statusRegion = document.querySelector(".download-status");
const editionName = document.body.dataset.edition || "Chromecraft";

platformButtons.forEach((button) => {
  button.addEventListener("click", () => {
    platformButtons.forEach((candidate) => {
      const isSelected = candidate === button;
      candidate.classList.toggle("selected", isSelected);
      candidate.setAttribute("aria-pressed", String(isSelected));
    });

    if (statusRegion) {
      statusRegion.textContent = `${editionName} for ${button.dataset.platform} is coming soon.`;
      statusRegion.classList.add("visible");
    }
  });
});
