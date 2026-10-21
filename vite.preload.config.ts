import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  build: {
    sourcemap: mode !== "production",
  },
}));
