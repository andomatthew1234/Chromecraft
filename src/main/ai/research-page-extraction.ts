export function buildResearchPageExtractionScript(
  maximumCharacters: number,
): string {
  const limit = Math.max(
    1_001,
    Math.min(24_001, Math.trunc(maximumCharacters)),
  );
  return `(() => {
    const maximum = ${limit};
    const excluded = "script,style,noscript,template,input,textarea,select,option,[hidden],[aria-hidden='true']";
    const chunks = [];
    let used = 0;
    const root = document.body;
    if (root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (used < maximum) {
        const node = walker.nextNode();
        if (!node) break;
        const parent = node.parentElement;
        if (!parent || parent.closest(excluded)) continue;
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const text = (node.textContent || "").replace(/\\s+/g, " ").trim();
        if (!text) continue;
        const remaining = maximum - used;
        chunks.push(text.slice(0, remaining));
        used += Math.min(text.length, remaining) + 1;
      }
    }
    const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
      .filter((node) => !node.closest(excluded))
      .filter((node) => {
        const style = getComputedStyle(node);
        return style.display !== "none" && style.visibility !== "hidden";
      })
      .map((node) => (node.textContent || "").replace(/\\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 32);
    return { text: chunks.join(" ").slice(0, maximum), headings };
  })()`;
}
