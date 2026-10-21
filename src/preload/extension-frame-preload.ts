import { contextBridge, ipcRenderer } from "electron";

import {
  extensionHostChannels,
  type ExtensionHostMessage,
  type ExtensionWorkerMessage,
} from "../shared/extension-host-protocol";

if (globalThis.location.protocol === "chrome-extension:") {
  const queued: ExtensionHostMessage[] = [];
  const listeners = new Set<(message: ExtensionHostMessage) => void>();

  ipcRenderer.on(
    extensionHostChannels.frameHostMessage,
    (_event, message: ExtensionHostMessage) => {
      if (listeners.size === 0) {
        queued.push(message);
        return;
      }
      for (const listener of listeners) listener(message);
    },
  );

  const bridge = {
    send(message: ExtensionWorkerMessage): void {
      if (!message || typeof message !== "object") return;
      ipcRenderer.send(extensionHostChannels.frameMessage, message);
    },
    subscribe(listener: (message: ExtensionHostMessage) => void): void {
      if (typeof listener !== "function") return;
      listeners.add(listener);
      while (queued.length > 0) {
        const message = queued.shift();
        if (message) listener(message);
      }
    },
  };
  if (process.contextIsolated) {
    contextBridge.exposeInMainWorld("__chromecraftExtensionHost", bridge);
  } else {
    Object.defineProperty(globalThis, "__chromecraftExtensionHost", {
      value: bridge,
      configurable: false,
    });
  }
}
