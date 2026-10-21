import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  define: {
    CHROMECRAFT_UPDATE_FEED_URL: JSON.stringify(
      process.env.CHROMECRAFT_UPDATE_FEED_URL?.trim() ?? "",
    ),
  },
  build: {
    sourcemap: mode !== "production",
  },
}));
