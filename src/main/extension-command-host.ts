export interface ExtensionCommandRegistration {
  id: string;
  manifest: Record<string, unknown>;
}

export interface ExtensionCommandDescriptor {
  name: string;
  description: string;
  shortcut: string;
}

export interface ExtensionCommandInput {
  key: string;
  code?: string;
  control: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface ExtensionCommandTab {
  id: number;
  url: string;
}

export interface ExtensionCommandInvocation {
  extensionId: string;
  command: string;
  reservedAction: boolean;
}

interface RegisteredCommand extends ExtensionCommandDescriptor {
  accelerator: string | null;
  reservedAction: boolean;
}

interface RegisteredExtension {
  sequence: number;
  activeTabPermission: boolean;
  commands: RegisteredCommand[];
  activeTabGrants: Map<number, string>;
}

const EXTENSION_ID = /^[a-p]{32}$/u;
const MAX_COMMANDS = 128;
const MAX_TEXT_LENGTH = 4_096;
const FUNCTION_KEY = /^F(?:[1-9]|1[0-2])$/u;
const LETTER_OR_DIGIT = /^[A-Z0-9]$/u;
const NAMED_KEYS = new Map([
  ["COMMA", "Comma"],
  ["PERIOD", "Period"],
  ["HOME", "Home"],
  ["END", "End"],
  ["PAGEUP", "PageUp"],
  ["PAGEDOWN", "PageDown"],
  ["SPACE", "Space"],
  ["INSERT", "Insert"],
  ["DELETE", "Delete"],
  ["UP", "Up"],
  ["DOWN", "Down"],
  ["LEFT", "Left"],
  ["RIGHT", "Right"],
  ["MEDIANEXTTRACK", "MediaNextTrack"],
  ["MEDIAPLAYPAUSE", "MediaPlayPause"],
  ["MEDIAPREVTRACK", "MediaPrevTrack"],
  ["MEDIASTOP", "MediaStop"],
]);

/**
 * Owns Chrome command parsing, platform selection, conflict assignment and
 * activeTab command grants. Keyboard capture and extension event delivery are
 * adapters; callers only register manifests, query descriptors and match input.
 */
export class ExtensionCommandHost {
  private readonly registrations = new Map<string, RegisteredExtension>();
  private readonly reservedAccelerators: Set<string>;
  private nextSequence = 1;

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    reservedAccelerators?: Iterable<string>,
  ) {
    this.reservedAccelerators = new Set(
      [...(reservedAccelerators ?? browserReservedShortcuts(platform))]
        .map((shortcut) => parseShortcut(shortcut, platform)?.accelerator)
        .filter((value): value is string => Boolean(value)),
    );
  }

  register(registration: ExtensionCommandRegistration): boolean {
    if (!EXTENSION_ID.test(registration.id))
      throw new Error("The extension id is invalid.");
    const existing = this.registrations.get(registration.id);
    const commands = commandsFromManifest(registration.manifest, this.platform);
    if (commands.length === 0) {
      this.registrations.delete(registration.id);
      this.assignAccelerators();
      return false;
    }
    this.registrations.set(registration.id, {
      sequence: existing?.sequence ?? this.nextSequence++,
      activeTabPermission: manifestPermissions(registration.manifest).has(
        "activeTab",
      ),
      commands,
      activeTabGrants: existing?.activeTabGrants ?? new Map(),
    });
    this.assignAccelerators();
    return true;
  }

  unregister(extensionId: string): void {
    if (!this.registrations.delete(extensionId)) return;
    this.assignAccelerators();
  }

  getAll(extensionId: string): ExtensionCommandDescriptor[] {
    return (this.registrations.get(extensionId)?.commands ?? []).map(
      ({ name, description, shortcut }) => ({ name, description, shortcut }),
    );
  }

  match(
    input: ExtensionCommandInput,
    tab: ExtensionCommandTab | null,
  ): ExtensionCommandInvocation | null {
    const accelerator = acceleratorFromInput(input, this.platform);
    if (!accelerator) return null;
    const registrations = [...this.registrations.entries()].sort(
      ([, left], [, right]) => left.sequence - right.sequence,
    );
    for (const [extensionId, registration] of registrations) {
      const command = registration.commands.find(
        (candidate) => candidate.accelerator === accelerator,
      );
      if (!command) continue;
      if (registration.activeTabPermission && tab) {
        const origin = activeTabOrigin(tab.url);
        if (origin) registration.activeTabGrants.set(tab.id, origin);
      }
      return {
        extensionId,
        command: command.name,
        reservedAction: command.reservedAction,
      };
    }
    return null;
  }

  hasActiveTabGrant(extensionId: string, tabId: number, url: string): boolean {
    const registration = this.registrations.get(extensionId);
    const origin = activeTabOrigin(url);
    return Boolean(
      registration &&
      origin &&
      registration.activeTabGrants.get(tabId) === origin,
    );
  }

  removeTab(tabId: number): void {
    for (const registration of this.registrations.values())
      registration.activeTabGrants.delete(tabId);
  }

  navigatedTab(tabId: number, url: string): void {
    const origin = activeTabOrigin(url);
    for (const registration of this.registrations.values()) {
      const granted = registration.activeTabGrants.get(tabId);
      if (granted && granted !== origin)
        registration.activeTabGrants.delete(tabId);
    }
  }

  private assignAccelerators(): void {
    const claimed = new Set(this.reservedAccelerators);
    const registrations = [...this.registrations.values()].sort(
      (left, right) => left.sequence - right.sequence,
    );
    for (const registration of registrations) {
      for (const command of registration.commands) {
        const candidate = command.accelerator;
        if (!candidate || claimed.has(candidate)) {
          command.accelerator = null;
          command.shortcut = "";
          continue;
        }
        claimed.add(candidate);
      }
    }
  }
}

function commandsFromManifest(
  manifest: Record<string, unknown>,
  platform: NodeJS.Platform,
): RegisteredCommand[] {
  const raw = manifest.commands;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const actionNames = new Set<string>();
  if (manifest.action) actionNames.add("_execute_action");
  if (manifest.browser_action) actionNames.add("_execute_browser_action");
  if (manifest.page_action) actionNames.add("_execute_page_action");
  return Object.entries(raw as Record<string, unknown>)
    .slice(0, MAX_COMMANDS)
    .filter(([name, value]) =>
      Boolean(
        name &&
        name.length <= 256 &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value),
      ),
    )
    .map(([name, value]) => {
      const details = value as Record<string, unknown>;
      const suggested = suggestedShortcut(details.suggested_key, platform);
      const parsed = suggested ? parseShortcut(suggested, platform) : null;
      const reserved = name.startsWith("_execute_");
      const reservedAction = reserved && actionNames.has(name);
      return {
        name,
        description: boundedDescription(details.description),
        shortcut: parsed && (!reserved || reservedAction) ? suggested : "",
        accelerator:
          parsed && (!reserved || reservedAction) ? parsed.accelerator : null,
        reservedAction,
      };
    });
}

function suggestedShortcut(raw: unknown, platform: NodeJS.Platform): string {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const values = raw as Record<string, unknown>;
  const key =
    platform === "win32" ? "windows" : platform === "darwin" ? "mac" : "linux";
  const selected = values[key] ?? values.default;
  return typeof selected === "string" ? selected : "";
}

function parseShortcut(
  shortcut: string,
  platform: NodeJS.Platform,
): { accelerator: string } | null {
  const parts = shortcut.split("+").map((part) => part.trim());
  if (parts.length < 1 || parts.some((part) => !part)) return null;
  const rawKey = parts.pop()!;
  const modifiers = new Set<string>();
  for (const raw of parts) {
    const modifier = raw.toLowerCase();
    if (modifier === "shift") modifiers.add("Shift");
    else if (modifier === "alt") modifiers.add("Alt");
    else if (modifier === "ctrl")
      modifiers.add(platform === "darwin" ? "Meta" : "Control");
    else if (modifier === "command" && platform === "darwin")
      modifiers.add("Meta");
    else if (modifier === "macctrl" && platform === "darwin")
      modifiers.add("Control");
    else return null;
  }
  const key = normalizedManifestKey(rawKey);
  if (!key) return null;
  const media = key.startsWith("Media");
  if (
    !media &&
    !FUNCTION_KEY.test(key) &&
    !modifiers.has("Control") &&
    !modifiers.has("Meta") &&
    !modifiers.has("Alt")
  ) {
    return null;
  }
  return { accelerator: canonicalAccelerator(modifiers, key) };
}

function acceleratorFromInput(
  input: ExtensionCommandInput,
  platform: NodeJS.Platform,
): string | null {
  const key = normalizedInputKey(input.key, input.code);
  if (!key) return null;
  const modifiers = new Set<string>();
  if (input.control) modifiers.add("Control");
  if (input.meta) modifiers.add("Meta");
  if (input.alt) modifiers.add("Alt");
  if (input.shift) modifiers.add("Shift");
  if (platform !== "darwin" && modifiers.has("Meta")) return null;
  return canonicalAccelerator(modifiers, key);
}

function normalizedManifestKey(raw: string): string | null {
  const upper = raw.toUpperCase();
  if (LETTER_OR_DIGIT.test(upper) || FUNCTION_KEY.test(upper)) return upper;
  return NAMED_KEYS.get(upper) ?? null;
}

function normalizedInputKey(rawKey: string, rawCode = ""): string | null {
  const key = rawKey.length === 1 ? rawKey.toUpperCase() : rawKey;
  if (LETTER_OR_DIGIT.test(key) || FUNCTION_KEY.test(key.toUpperCase()))
    return key.toUpperCase();
  const aliases = new Map<string, string>([
    [" ", "Space"],
    ["ArrowUp", "Up"],
    ["ArrowDown", "Down"],
    ["ArrowLeft", "Left"],
    ["ArrowRight", "Right"],
    [",", "Comma"],
    [".", "Period"],
  ]);
  const direct = aliases.get(rawKey) ?? NAMED_KEYS.get(rawKey.toUpperCase());
  if (direct) return direct;
  if (/^Key[A-Z]$/u.test(rawCode)) return rawCode.slice(3);
  if (/^Digit[0-9]$/u.test(rawCode)) return rawCode.slice(5);
  return null;
}

function canonicalAccelerator(modifiers: Set<string>, key: string): string {
  return ["Control", "Meta", "Alt", "Shift"]
    .filter((modifier) => modifiers.has(modifier))
    .concat(key)
    .join("+");
}

function manifestPermissions(manifest: Record<string, unknown>): Set<string> {
  return new Set(
    (Array.isArray(manifest.permissions) ? manifest.permissions : []).filter(
      (value): value is string => typeof value === "string",
    ),
  );
}

function boundedDescription(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, MAX_TEXT_LENGTH) : "";
}

function activeTabOrigin(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function browserReservedShortcuts(platform: NodeJS.Platform): string[] {
  const control = platform === "darwin" ? "Command" : "Ctrl";
  return [
    `${control}+L`,
    `${control}+T`,
    `${control}+W`,
    `${control}+F`,
    `${control}+R`,
    `${control}+0`,
    `${control}+Tab`,
    `${control}+Shift+T`,
    `${control}+Shift+P`,
    ...Array.from({ length: 9 }, (_, index) => `${control}+${index + 1}`),
    "Alt+D",
    "Alt+Left",
    "Alt+Right",
    "F5",
    "F6",
    "F11",
  ];
}
