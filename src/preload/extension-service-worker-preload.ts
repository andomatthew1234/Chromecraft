import { contextBridge, ipcRenderer } from "electron";
import {
  extensionHostChannels,
  type ExtensionHostMessage,
  type ExtensionWorkerMessage,
} from "../shared/extension-host-protocol";

const queuedHostMessages: ExtensionHostMessage[] = [];
const queuedWorkerMessages: ExtensionWorkerMessage[] = [];
const listeners = new Set<(message: ExtensionHostMessage) => void>();
let hostReady = false;

function deliver(message: ExtensionHostMessage): void {
  if (listeners.size === 0) {
    queuedHostMessages.push(message);
    return;
  }
  for (const listener of listeners) listener(message);
}

ipcRenderer.on(
  extensionHostChannels.hostMessage,
  (_event, message: ExtensionHostMessage) => deliver(message),
);

ipcRenderer.on(extensionHostChannels.workerReady, () => {
  hostReady = true;
  deliver({ type: "host-ready" });
  while (queuedWorkerMessages.length > 0) {
    const message = queuedWorkerMessages.shift();
    if (message) ipcRenderer.send(extensionHostChannels.workerMessage, message);
  }
});

contextBridge.exposeInMainWorld("__chromecraftExtensionHost", {
  send(message: ExtensionWorkerMessage): void {
    if (!message || typeof message !== "object") return;
    if (!hostReady && message.type === "action-command") {
      queuedWorkerMessages.push(message);
      return;
    }
    ipcRenderer.send(extensionHostChannels.workerMessage, message);
  },
  subscribe(listener: (message: ExtensionHostMessage) => void): void {
    if (typeof listener !== "function") return;
    listeners.add(listener);
    while (queuedHostMessages.length > 0) {
      const queued = queuedHostMessages.shift();
      if (queued) listener(queued);
    }
  },
});

ipcRenderer.send(extensionHostChannels.workerMessage, {
  type: "worker-ready",
} satisfies ExtensionWorkerMessage);
