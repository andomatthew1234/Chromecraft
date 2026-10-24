import { contextBridge, ipcRenderer } from "electron";

import type {
  PerformanceAction,
  PerformanceCentreApi,
  PerformanceCentreSnapshot,
  PerformanceRefreshInterval,
} from "../shared/performance-centre";
import { channels } from "../shared/channels";

const api: PerformanceCentreApi = {
  getSnapshot: () =>
    ipcRenderer.invoke(
      channels.getPerformanceCentre,
    ) as Promise<PerformanceCentreSnapshot>,
  setRefreshInterval: (interval: PerformanceRefreshInterval) =>
    ipcRenderer.invoke(
      channels.setPerformanceCentreRefreshInterval,
      interval,
    ) as Promise<void>,
  performAction: (action: PerformanceAction) =>
    ipcRenderer.invoke(channels.runPerformanceCentreAction, action),
  close: () => ipcRenderer.invoke(channels.closePerformanceCentre),
  onSnapshot: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: PerformanceCentreSnapshot,
    ) => listener(snapshot);
    ipcRenderer.on(channels.performanceCentreChanged, handler);
    return () =>
      ipcRenderer.removeListener(channels.performanceCentreChanged, handler);
  },
};

contextBridge.exposeInMainWorld("performanceCentre", api);

declare global {
  interface Window {
    performanceCentre: PerformanceCentreApi;
  }
}
