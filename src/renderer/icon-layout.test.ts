import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("icon alignment", () => {
  it("centres the shared Material icon box and sizes enlarged Smart Download icons", () => {
    const sharedStyles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );
    const smartDownloadsStyles = readFileSync(
      new URL("./smart-downloads.css", import.meta.url),
      "utf8",
    );
    const galleryStyles = readFileSync(
      new URL("./gallery.css", import.meta.url),
      "utf8",
    );

    expect(sharedStyles).toMatch(
      /\.material-icon\s*\{[\s\S]*?display:\s*inline-grid;[\s\S]*?place-items:\s*center;[\s\S]*?line-height:\s*1;/,
    );
    expect(smartDownloadsStyles).toMatch(
      /\.smart-downloads-hero-icon \.material-icon\s*\{[\s\S]*?width:\s*34px;[\s\S]*?height:\s*34px;[\s\S]*?font-size:\s*34px;/,
    );
    expect(smartDownloadsStyles).toMatch(
      /\.smart-empty > \.material-icon\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;[\s\S]*?font-size:\s*44px;/,
    );
    for (const [selector, size] of [
      ["\\.gallery-preview--missing \\.material-icon", 42],
      ["\\.gallery-play-indicator \\.material-icon", 30],
      ["\\.gallery-player-error \\.material-icon", 52],
    ]) {
      expect(galleryStyles).toMatch(
        new RegExp(
          `${selector}\\s*\\{[\\s\\S]*?width:\\s*${size}px;[\\s\\S]*?height:\\s*${size}px;[\\s\\S]*?font-size:\\s*${size}px;`,
        ),
      );
    }
  });
});
