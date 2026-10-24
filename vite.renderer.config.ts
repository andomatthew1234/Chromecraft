import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        index: "index.html",
        "performance-centre": "performance-centre.html",
      },
    },
  },
});
