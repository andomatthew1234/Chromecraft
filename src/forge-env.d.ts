/// <reference types="vite/client" />

import type { ChromecraftApi } from "./shared/browser";

declare global {
  const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
  const MAIN_WINDOW_VITE_NAME: string;
  const CHROMECRAFT_UPDATE_FEED_URL: string;

  interface Window {
    chromecraft: ChromecraftApi;
  }
}

export {};
