import { contextBridge, ipcRenderer } from "electron";

import {
  EXTENSION_NETWORK_OBSERVER_ORIGIN,
  extensionHostChannels,
} from "../shared/extension-host-protocol";

if (globalThis.location?.origin === EXTENSION_NETWORK_OBSERVER_ORIGIN) {
  const observer = {
    emit(details: unknown): void {
      if (!details || typeof details !== "object") return;
      ipcRenderer.send(extensionHostChannels.observerRequest, details);
    },
  };
  if (process.contextIsolated) {
    contextBridge.exposeInMainWorld("__chromecraftNetworkObserver", observer);
  } else {
    Object.defineProperty(globalThis, "__chromecraftNetworkObserver", {
      value: Object.freeze(observer),
      configurable: false,
      writable: false,
    });
  }
}
