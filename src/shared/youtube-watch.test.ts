import { describe, expect, it } from "vitest";

import { parseYouTubeWatchUrl } from "./youtube-watch";

describe("parseYouTubeWatchUrl", () => {
  it("accepts a normal watch URL including extra query and hash data", () => {
    expect(
      parseYouTubeWatchUrl(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42#details",
      ),
    ).toEqual({
      videoId: "dQw4w9WgXcQ",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42#details",
    });
  });

  it.each([
    "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
    "https://user@www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com:444/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watchlater?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/watch?v=bad id",
  ])("rejects non-watch or unsafe URL %s", (url) => {
    expect(parseYouTubeWatchUrl(url)).toBeNull();
  });
});
