export const extensionHostChannels = {
  workerReady: "chromecraft:extension-host:worker-ready",
  workerMessage: "chromecraft:extension-host:worker-message",
  hostMessage: "chromecraft:extension-host:host-message",
  observerRequest: "chromecraft:extension-host:observer-request",
  frameMessage: "chromecraft:extension-host:frame-message",
  frameHostMessage: "chromecraft:extension-host:frame-host-message",
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

export type ExtensionActionNamespace =
  | "action"
  | "browserAction"
  | "pageAction";

export type ExtensionActionMethod =
  | "enable"
  | "disable"
  | "isEnabled"
  | "show"
  | "hide"
  | "setTitle"
  | "getTitle"
  | "setPopup"
  | "getPopup"
  | "setBadgeText"
  | "getBadgeText"
  | "setBadgeBackgroundColor"
  | "getBadgeBackgroundColor"
  | "setBadgeTextColor"
  | "getBadgeTextColor"
  | "setIcon"
  | "getUserSettings"
  | "openPopup";

export interface ExtensionActionCommandMessage {
  type: "action-command";
  requestId: string;
  namespace: ExtensionActionNamespace;
  method: ExtensionActionMethod;
  details?: unknown;
}

export interface ExtensionActionSubscriptionsMessage {
  type: "action-subscriptions";
  namespaces: ExtensionActionNamespace[];
}

export interface ExtensionActionEventAckMessage {
  type: "action-event-ack";
  eventId: string;
}

export interface ExtensionCommandsSubscriptionsMessage {
  type: "commands-subscriptions";
  listening: boolean;
}

export interface ExtensionCommandsGetAllMessage {
  type: "commands-get-all";
  requestId: string;
}

export interface ExtensionCommandsEventAckMessage {
  type: "commands-event-ack";
  eventId: string;
}

export type ExtensionTabsEventName =
  | "onCreated"
  | "onActivated"
  | "onUpdated"
  | "onRemoved";

export interface ExtensionTabsSubscriptionsMessage {
  type: "tabs-subscriptions";
  events: ExtensionTabsEventName[];
}

export type ExtensionWorkerMessage =
  | ExtensionWebRequestSubscriptionsMessage
  | ExtensionTabsSubscriptionsMessage
  | ExtensionActionSubscriptionsMessage
  | ExtensionActionEventAckMessage
  | ExtensionCommandsSubscriptionsMessage
  | ExtensionCommandsGetAllMessage
  | ExtensionCommandsEventAckMessage
  | ExtensionActionCommandMessage
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

export interface ExtensionTabsEventMessage {
  type: "tabs-event";
  eventName: ExtensionTabsEventName;
  args: unknown[];
}

export interface ExtensionTabsSnapshotMessage {
  type: "tabs-snapshot";
  tabs: Array<Record<string, unknown>>;
}

export interface ExtensionActionResultMessage {
  type: "action-result";
  requestId: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface ExtensionActionEventMessage {
  type: "action-event";
  eventId: string;
  namespace: ExtensionActionNamespace;
  eventName: "onClicked";
  args: unknown[];
}

export interface ExtensionCommandsResultMessage {
  type: "commands-result";
  requestId: string;
  commands: Array<{ name: string; description: string; shortcut: string }>;
}

export interface ExtensionCommandsEventMessage {
  type: "commands-event";
  eventId: string;
  command: string;
  tab?: Record<string, unknown>;
}

export type ExtensionHostMessage =
  | ExtensionHostReadyMessage
  | ExtensionWebRequestEventMessage
  | ExtensionTabsEventMessage
  | ExtensionTabsSnapshotMessage
  | ExtensionActionEventMessage
  | ExtensionActionResultMessage
  | ExtensionCommandsResultMessage
  | ExtensionCommandsEventMessage;
