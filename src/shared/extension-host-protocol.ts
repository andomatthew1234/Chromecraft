export const extensionHostChannels = {
  workerReady: "chromecraft:extension-host:worker-ready",
  workerMessage: "chromecraft:extension-host:worker-message",
  hostMessage: "chromecraft:extension-host:host-message",
  observerRequest: "chromecraft:extension-host:observer-request",
} as const;

export const EXTENSION_NETWORK_OBSERVER_ID = "goaacilmcfclhamijaapihfhmhahcjgj";
export const EXTENSION_NETWORK_OBSERVER_ORIGIN = `chrome-extension://${EXTENSION_NETWORK_OBSERVER_ID}`;

export interface ExtensionWebRequestFilter {
  urls: string[];
  types?: string[];
  tabId?: number;
  windowId?: number;
}

export interface ExtensionWebRequestSubscriptionsMessage {
  type: "webRequest-subscriptions";
  eventName: "onBeforeRequest";
  filters: ExtensionWebRequestFilter[];
}

export interface ExtensionWorkerReadyMessage {
  type: "worker-ready";
}

export type ExtensionWorkerMessage =
  | ExtensionWebRequestSubscriptionsMessage
  | ExtensionWorkerReadyMessage;

export interface ExtensionHostReadyMessage {
  type: "host-ready";
}

export interface ExtensionWebRequestEventDetails {
  requestId: string;
  url: string;
  method: string;
  frameId: number;
  parentFrameId: number;
  tabId: number;
  type: string;
  timeStamp: number;
  initiator?: string;
}

export interface ExtensionWebRequestEventMessage {
  type: "webRequest-event";
  eventName: "onBeforeRequest";
  details: ExtensionWebRequestEventDetails;
}

export type ExtensionHostMessage =
  | ExtensionHostReadyMessage
  | ExtensionWebRequestEventMessage;
