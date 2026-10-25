import {
  type FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { AiToolsSnapshot } from "../shared/ai-tools";
import type { AiProviderId } from "../shared/ai-tools";
import { activeProviderSnapshot, scoutPowerChoices } from "../shared/ai-power";
import type {
  AssistantAttachment,
  AssistantAttachmentKind,
  AssistantContextCaptured,
  AssistantMessageRequest,
  AssistantPageContext,
} from "../shared/ai-assistant";
import {
  DEFAULT_ASSISTANT_CONTEXT,
  SCOUT_CONTEXT_DEFAULTS_STORAGE_KEY,
  SCOUT_REDUCED_MOTION_STORAGE_KEY,
} from "../shared/ai-assistant";
import type { BrowserTabSnapshot } from "../shared/browser";
import type {
  AgentRunSnapshot,
  ScoutAgentSnapshot,
  ScoutPermissionMode,
} from "../shared/agent";
import {
  AnimatedAssistantAvatar,
  StaticAssistantAvatar,
} from "./AssistantAvatar";
import { AssistantPopover } from "./AssistantPopover";
import { ScoutAgentTimeline } from "./ScoutAgentTimeline";
import "./ai-assistant.css";

const HISTORY_STORAGE_KEY = "chromecraft-ai-assistant-history-v1";
const MAX_HISTORY = 24;
const TERMINAL_AGENT_STATES = new Set(["completed", "failed", "cancelled"]);
const EMPTY_SCOUT_AGENT: ScoutAgentSnapshot = {
  permissionMode: "chat",
  researchCloudConsentGranted: false,
  runs: [],
};

export interface AssistantCommandLaunch {
  id: number;
  prompt: string;
}

type ContextChoices = Record<AssistantAttachmentKind, boolean>;
type ConversationMessage = {
  id: string;
  text: string;
  createdAt: number;
  attachments: AssistantAttachment[];
  role: "user" | "assistant";
  status: "complete" | "thinking" | "error";
  model?: string;
};
type Conversation = {
  id: string;
  title: string;
  updatedAt: number;
  messages: ConversationMessage[];
  draft: string;
};
type PendingAssistantPrompt = {
  request: AssistantMessageRequest;
  assistantMessage: ConversationMessage;
  targetConversationId: string;
};
type OpenPopover = "attachments" | "history" | "more" | "power" | "mode" | null;

function icon(name: string) {
  return (
    <span className="material-icon material-symbols-rounded" aria-hidden="true">
      {name}
    </span>
  );
}

function identifier(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function readDefaults(): ContextChoices {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(SCOUT_CONTEXT_DEFAULTS_STORAGE_KEY) ?? "",
    ) as Partial<ContextChoices> | null;
    return { ...DEFAULT_ASSISTANT_CONTEXT, ...parsed };
  } catch {
    return { ...DEFAULT_ASSISTANT_CONTEXT };
  }
}

function readHistory(): Conversation[] {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(HISTORY_STORAGE_KEY) ?? "",
    ) as Conversation[] | null;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .slice(0, MAX_HISTORY)
      .filter(
        (conversation) =>
          Boolean(conversation) &&
          typeof conversation.id === "string" &&
          typeof conversation.title === "string" &&
          Array.isArray(conversation.messages),
      )
      .map((conversation) => ({
        ...conversation,
        messages: conversation.messages.slice(-100).map((message) => ({
          ...message,
          role: message.role === "assistant" ? "assistant" : "user",
          status: message.status === "error" ? "error" : ("complete" as const),
        })),
      }));
  } catch {
    return [];
  }
}

function safeUrl(raw: string): { value: string; display: string } | null {
  try {
    const value = new URL(raw);
    if (value.protocol !== "http:" && value.protocol !== "https:") return null;
    value.username = "";
    value.password = "";
    value.search = "";
    value.hash = "";
    return { value: value.href, display: `${value.hostname}${value.pathname}` };
  } catch {
    return null;
  }
}

export function contextAttachments(
  page: AssistantPageContext | null,
  choices: ContextChoices,
  attachments: AssistantAttachment[],
): AssistantAttachment[] {
  const items: AssistantAttachment[] = [];
  if (page) {
    const url = safeUrl(page.url);
    if (choices.url && url) {
      items.push({
        id: `url-${page.tabId}`,
        kind: "url",
        label: "Website URL",
        detail: url.display,
        createdAt: Date.now(),
        data: { url: url.value },
      });
    }
    if (choices.title && page.title) {
      items.push({
        id: `title-${page.tabId}`,
        kind: "title",
        label: "Page title",
        detail: page.title.slice(0, 120),
        createdAt: Date.now(),
        data: { title: page.title.slice(0, 240) },
      });
    }
    if (choices.description && page.description) {
      items.push({
        id: `description-${page.tabId}`,
        kind: "description",
        label: "Page description",
        detail: page.description.slice(0, 120),
        createdAt: Date.now(),
        data: { description: page.description.slice(0, 600) },
      });
    }
    if (choices["selected-text"] && page.selectedText) {
      items.push({
        id: `selection-${page.tabId}`,
        kind: "selected-text",
        label: "Selected text",
        detail: page.selectedText.slice(0, 120),
        createdAt: Date.now(),
        data: { selectedText: page.selectedText.slice(0, 2_000) },
      });
    }
  }
  return [...items, ...attachments.filter((item) => choices[item.kind])];
}

function attachmentIcon(kind: AssistantAttachmentKind) {
  return (
    {
      page: "language",
      url: "link",
      title: "title",
      description: "article",
      "selected-text": "format_quote",
      screenshot: "crop",
      element: "ads_click",
      "full-reader-article": "auto_stories",
    } satisfies Record<AssistantAttachmentKind, string>
  )[kind];
}

function statusFor(snapshot: AiToolsSnapshot) {
  const provider = activeProviderSnapshot(snapshot);
  if (provider.connection === "connected" && provider.selectedModel) {
    return [
      snapshot.provider === "ollama" ? "Ready · Local" : "Ready · Gemini",
      "ready",
    ] as const;
  }
  if (snapshot.provider === "gemini") {
    return [
      snapshot.gemini.apiKeyConfigured
        ? "Gemini unavailable"
        : "Gemini key required",
      "unavailable",
    ] as const;
  }
  return ["Local AI unavailable", "unavailable"] as const;
}

function pageContextError(error: unknown): string {
  const detail = error instanceof Error ? error.message.toLowerCase() : "";
  if (/load|loading|finish/u.test(detail)) {
    return "Page still loading — Scout needs this page to finish before it can inspect it.";
  }
  if (/internal|new tab|unsupported|cannot be captured/u.test(detail)) {
    return "Page context is unavailable here. You can still ask Scout a general question.";
  }
  return "Scout couldn't inspect this page. You can still ask without page context.";
}

function responseError(error: unknown, provider: AiProviderId): string {
  const detail = error instanceof Error ? error.message.toLowerCase() : "";
  if (/quota|usage|rate/u.test(detail)) {
    return "Gemini usage is temporarily limited. Check quota or try again later.";
  }
  if (/key|auth/u.test(detail)) {
    return "Gemini could not authenticate. Check the API key in Scout settings.";
  }
  if (/model/u.test(detail)) {
    return "That model is unavailable. Choose another in Scout Power.";
  }
  if (/stopped|cancel/u.test(detail)) return "Response stopped.";
  return provider === "ollama"
    ? "Scout could not reach local AI. Start Ollama or choose another model."
    : "Scout could not reach Gemini. Check the connection and try again.";
}

export function AiAssistantPanel({
  activeTab,
  aiTools,
  scoutAgent = EMPTY_SCOUT_AGENT,
  close,
  onOrganiseTabs,
  onOpenSettings,
  initialAttachment,
  onInitialAttachmentConsumed,
  initialCommand,
  onInitialCommandConsumed,
}: {
  activeTab: BrowserTabSnapshot;
  aiTools: AiToolsSnapshot;
  scoutAgent?: ScoutAgentSnapshot;
  close: () => void;
  onOrganiseTabs: () => void;
  onOpenSettings: () => void;
  initialAttachment?: AssistantAttachment | null;
  onInitialAttachmentConsumed?: () => void;
  initialCommand?: AssistantCommandLaunch | null;
  onInitialCommandConsumed?: () => void;
}) {
  const [conversations, setConversations] =
    useState<Conversation[]>(readHistory);
  const [conversationId, setConversationId] = useState<string>(() =>
    identifier("chat"),
  );
  const [draft, setDraft] = useState("");
  const [page, setPage] = useState<AssistantPageContext | null>(null);
  const [attachments, setAttachments] = useState<AssistantAttachment[]>([]);
  const [choices, setChoices] = useState<ContextChoices>(readDefaults);
  const [openPopover, setOpenPopover] = useState<OpenPopover>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [capturing, setCapturing] = useState<"screenshot" | "element" | null>(
    null,
  );
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [powerBusy, setPowerBusy] = useState(false);
  const [powerError, setPowerError] = useState<string | null>(null);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [readerPreview, setReaderPreview] =
    useState<AssistantAttachment | null>(null);
  const [researchConsentChecked, setResearchConsentChecked] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const plusButtonRef = useRef<HTMLButtonElement>(null);
  const contextButtonRef = useRef<HTMLButtonElement>(null);
  const attachmentAnchorRef = useRef<HTMLElement>(null);
  const powerButtonRef = useRef<HTMLButtonElement>(null);
  const modeButtonRef = useRef<HTMLButtonElement>(null);
  const powerChangeRef = useRef(0);
  const automaticallyRefreshedProviderRef = useRef<AiProviderId | null>(null);
  const handledCommandRef = useRef<number | null>(null);

  const [providerStatusLabel, providerStatusKind] = statusFor(aiTools);
  const currentConversation =
    conversations.find((item) => item.id === conversationId) ?? null;
  const currentRuns = scoutAgent.runs
    .filter((run) => run.conversationId === conversationId)
    .sort((left, right) => right.createdAt - left.createdAt);
  const activeRun =
    currentRuns.find((run) => !TERMINAL_AGENT_STATES.has(run.status)) ?? null;
  const agentBusy = Boolean(activeRun);
  const statusLabel = activeRun
    ? activeRun.statusLabel
    : sending
      ? "Thinking"
      : providerStatusLabel;
  const statusKind = activeRun || sending ? "thinking" : providerStatusKind;
  const included = useMemo(
    () => contextAttachments(page, choices, attachments),
    [attachments, choices, page],
  );
  const visibleContextChips = useMemo(
    () =>
      included.filter((item) =>
        [
          "selected-text",
          "screenshot",
          "element",
          "full-reader-article",
        ].includes(item.kind),
      ),
    [included],
  );
  const pageDisplay =
    page?.displayUrl ?? safeUrl(activeTab.url)?.display ?? "New tab";
  const providerState = activeProviderSnapshot(aiTools);
  const powerChoices = useMemo(
    () =>
      scoutPowerChoices(
        aiTools.provider,
        providerState.models,
        providerState.selectedModel,
      ),
    [aiTools.provider, providerState.models, providerState.selectedModel],
  );
  const displayedModel = pendingModel ?? providerState.selectedModel;
  const powerIndex = Math.max(
    0,
    powerChoices.findIndex((choice) => choice.model === displayedModel),
  );
  const powerChoice = powerChoices[powerIndex] ?? null;

  const refreshPage = useCallback(async () => {
    try {
      const next = await window.chromecraft.getAssistantPageContext(
        activeTab.id,
      );
      setPage(next);
      return next;
    } catch {
      setPage(null);
      return null;
    }
  }, [activeTab.id]);

  useEffect(() => {
    void refreshPage();
  }, [refreshPage, activeTab.url]);

  useEffect(() => {
    document.documentElement.dataset.scoutReducedMotion =
      localStorage.getItem(SCOUT_REDUCED_MOTION_STORAGE_KEY) === "true"
        ? "true"
        : "false";
  }, []);

  useEffect(() => {
    if (!initialAttachment) return;
    setAttachments((current) => [
      ...current.filter((item) => item.kind !== "full-reader-article"),
      initialAttachment,
    ]);
    setChoices((current) => ({
      ...current,
      url: false,
      title: false,
      description: false,
      "selected-text": false,
      "full-reader-article": true,
    }));
    setStatusNote("Full Reader Article added to this prompt.");
    onInitialAttachmentConsumed?.();
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [initialAttachment, onInitialAttachmentConsumed]);

  useEffect(() => {
    const refreshDefaults = () => setChoices(readDefaults());
    addEventListener("scout-context-defaults-changed", refreshDefaults);
    return () =>
      removeEventListener("scout-context-defaults-changed", refreshDefaults);
  }, []);

  useEffect(() => {
    const clearHistory = () => {
      for (const conversation of conversations) {
        void window.chromecraft.commandScoutAgent({
          type: "clear-conversation",
          conversationId: conversation.id,
        });
      }
      setConversations([]);
      setConversationId(identifier("chat"));
      setDraft("");
      setOpenPopover(null);
      setStatusNote("Local conversation history cleared.");
    };
    addEventListener("scout-history-cleared", clearHistory);
    return () => removeEventListener("scout-history-cleared", clearHistory);
  }, [conversations]);

  useEffect(() => {
    if (!powerBusy) setPendingModel(null);
  }, [powerBusy, providerState.selectedModel]);

  useEffect(
    () =>
      window.chromecraft.onAssistantContextCaptured(
        (captured: AssistantContextCaptured) => {
          setCapturing(null);
          setAttachments((current) => [
            ...current.filter((item) => item.kind !== captured.attachment.kind),
            captured.attachment,
          ]);
          setChoices((current) => ({
            ...current,
            [captured.attachment.kind]: true,
          }));
          setStatusNote(`${captured.attachment.label} added to this prompt.`);
        },
      ),
    [],
  );

  useEffect(() => {
    if (scoutAgent.runs.length === 0) return;
    setConversations((current) =>
      current.map((conversation) => {
        const runs = scoutAgent.runs.filter(
          (run) => run.conversationId === conversation.id,
        );
        if (runs.length === 0) return conversation;
        return {
          ...conversation,
          updatedAt: Math.max(
            conversation.updatedAt,
            ...runs.map((run) => run.updatedAt),
          ),
          messages: conversation.messages.map((message) => {
            const run = runs.find(
              (item) => `reply-${item.messageId}` === message.id,
            );
            if (!run) return message;
            if (!TERMINAL_AGENT_STATES.has(run.status)) {
              return { ...message, status: "thinking" as const };
            }
            return {
              ...message,
              text:
                run.finalText ??
                run.error ??
                "Scout could not complete this research run.",
              createdAt: run.completedAt ?? run.updatedAt,
              status:
                run.status === "failed"
                  ? ("error" as const)
                  : ("complete" as const),
              model: run.model,
            };
          }),
        };
      }),
    );
  }, [scoutAgent.runs]);

  useEffect(() => {
    localStorage.setItem(
      HISTORY_STORAGE_KEY,
      JSON.stringify(
        conversations.slice(0, MAX_HISTORY).map((conversation) => ({
          ...conversation,
          messages: conversation.messages.map((message) => ({
            ...message,
            // Screenshots and extracted page data remain in memory only.
            attachments: message.attachments.map(
              ({ data: _data, ...attachment }) => ({
                ...attachment,
                detail: null,
                data: {},
              }),
            ),
          })),
        })),
      ),
    );
  }, [conversations]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !capturing) return;
      void window.chromecraft.cancelAssistantSelection();
      setCapturing(null);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [capturing]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const resize = () => {
      textarea.style.height = "auto";
      const computed = getComputedStyle(textarea);
      const lineHeight = Number.parseFloat(computed.lineHeight) || 20;
      const padding =
        Number.parseFloat(computed.paddingTop) +
        Number.parseFloat(computed.paddingBottom);
      const maxHeight = lineHeight * 5 + padding;
      const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
      textarea.style.height = `${Math.max(lineHeight + padding, nextHeight)}px`;
      textarea.style.overflowY =
        textarea.scrollHeight > maxHeight ? "auto" : "hidden";
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [draft]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !currentConversation?.messages.length) return;
    if (nearBottomRef.current) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    }
  }, [currentConversation?.messages.length, conversationId]);

  const setOnlyPopover = (popover: Exclude<OpenPopover, null>) => {
    setOpenPopover((current) => (current === popover ? null : popover));
  };

  const refreshPowerModels = async (provider: AiProviderId) => {
    if (
      powerBusy ||
      sending ||
      (provider === "gemini" && !aiTools.gemini.apiKeyConfigured)
    ) {
      return;
    }
    setPowerBusy(true);
    setPowerError(null);
    try {
      const next = await window.chromecraft.refreshAiModels(provider);
      const updated = activeProviderSnapshot(next, provider);
      if (updated.error) setPowerError(updated.error);
    } catch {
      setPowerError(
        provider === "ollama"
          ? "Scout could not reach Ollama. Start Ollama and try again."
          : "Scout could not connect to Gemini. Check the API key in Settings.",
      );
    } finally {
      setPowerBusy(false);
    }
  };

  const togglePowerPopover = () => {
    const opening = openPopover !== "power";
    setOnlyPopover("power");
    if (opening) void refreshPowerModels(aiTools.provider);
  };

  useEffect(() => {
    const provider = aiTools.provider;
    if (
      automaticallyRefreshedProviderRef.current === provider ||
      powerBusy ||
      sending ||
      (providerState.connection === "connected" &&
        providerState.models.length > 0) ||
      (provider === "gemini" && !aiTools.gemini.apiKeyConfigured)
    ) {
      if (
        providerState.connection === "connected" &&
        providerState.models.length > 0
      ) {
        automaticallyRefreshedProviderRef.current = provider;
      }
      return;
    }
    automaticallyRefreshedProviderRef.current = provider;
    void refreshPowerModels(provider);
  }, [
    aiTools.gemini.apiKeyConfigured,
    aiTools.provider,
    providerState.connection,
    providerState.models.length,
  ]);

  const startCapture = async (kind: "screenshot" | "element") => {
    setOpenPopover(null);
    setStatusNote(null);
    try {
      await window.chromecraft.startAssistantSelection(kind);
      setCapturing(kind);
    } catch (error) {
      setStatusNote(pageContextError(error));
    }
  };

  const updateChoice = (kind: AssistantAttachmentKind, checked: boolean) => {
    setChoices((current) => ({ ...current, [kind]: checked }));
  };

  const selectProvider = async (provider: AiProviderId) => {
    if (provider === aiTools.provider || powerBusy) return;
    setPowerBusy(true);
    setPowerError(null);
    setPendingModel(null);
    try {
      let next = await window.chromecraft.setAiProvider(provider);
      const canRefresh = provider === "ollama" || next.gemini.apiKeyConfigured;
      if (canRefresh) {
        next = await window.chromecraft.refreshAiModels(provider);
      }
      const updated = activeProviderSnapshot(next, provider);
      if (updated.error) setPowerError(updated.error);
    } catch {
      setPowerError(
        provider === "ollama"
          ? "Scout could not reach Ollama. Start Ollama and try again."
          : "Scout could not connect to Gemini. Check the API key in Settings.",
      );
    } finally {
      setPowerBusy(false);
    }
  };

  const selectPowerModel = async (index: number) => {
    const choice = powerChoices[index];
    if (!choice || choice.model === displayedModel || powerBusy) return;
    const change = ++powerChangeRef.current;
    setPendingModel(choice.model);
    setPowerBusy(true);
    setPowerError(null);
    try {
      await window.chromecraft.setAiModel(aiTools.provider, choice.model);
      if (powerChangeRef.current === change) {
        setStatusNote(`${choice.displayName} selected for new Scout requests.`);
      }
    } catch {
      if (powerChangeRef.current === change) {
        setPowerError("That model is no longer available. Refresh the list.");
        setPendingModel(null);
      }
    } finally {
      if (powerChangeRef.current === change) setPowerBusy(false);
    }
  };

  const selectPermissionMode = async (mode: ScoutPermissionMode) => {
    try {
      await window.chromecraft.commandScoutAgent({ type: "set-mode", mode });
      setOpenPopover(null);
      setStatusNote(
        mode === "ask"
          ? "Ask mode can inspect relevant eligible tabs for research."
          : "Chat mode selected. Scout will only use context you choose.",
      );
    } catch (error) {
      setStatusNote(
        error instanceof Error
          ? error.message
          : "That Scout mode is not available yet.",
      );
      setOpenPopover(null);
    }
  };

  const newConversation = () => {
    if (activeMessageId) {
      void window.chromecraft.cancelAssistantMessage(activeMessageId);
    }
    setConversationId(identifier("chat"));
    setDraft("");
    setAttachments([]);
    setChoices(readDefaults());
    setStatusNote(null);
    setOpenPopover(null);
    nearBottomRef.current = true;
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const beginPrompt = (
    promptValue: string,
    targetConversationId = conversationId,
    promptContext = included,
    historyMessages = currentConversation?.messages ?? [],
    allowWhileCancelling = false,
  ): PendingAssistantPrompt | null => {
    const prompt = promptValue.trim();
    const model = displayedModel;
    if (!prompt || (sending && !allowWhileCancelling) || powerBusy) return null;
    if (!model) {
      setDraft(prompt);
      setStatusNote("Choose an available model in Scout Power first.");
      setOpenPopover("power");
      void refreshPowerModels(aiTools.provider);
      return null;
    }
    const request: AssistantMessageRequest = {
      conversationId: targetConversationId,
      messageId: identifier("message"),
      prompt,
      createdAt: Date.now(),
      provider: aiTools.provider,
      model,
      context: structuredClone(promptContext),
      history: historyMessages
        .filter((message) => message.status === "complete")
        .map((message) => ({ role: message.role, text: message.text }))
        .slice(-12),
    };
    const message: ConversationMessage = {
      id: request.messageId,
      text: request.prompt,
      createdAt: request.createdAt,
      attachments: request.context,
      role: "user",
      status: "complete",
      model: request.model,
    };
    const assistantMessage: ConversationMessage = {
      id: `reply-${request.messageId}`,
      text: "",
      createdAt: request.createdAt,
      attachments: [],
      role: "assistant",
      status: "thinking",
      model: request.model,
    };
    nearBottomRef.current = true;
    setConversations((current) => {
      const existing = current.find((item) => item.id === targetConversationId);
      const conversation: Conversation = {
        id: targetConversationId,
        title: existing?.title ?? prompt.slice(0, 56),
        updatedAt: request.createdAt,
        messages: [
          ...(existing?.messages ?? []),
          message,
          assistantMessage,
        ].slice(-100),
        draft: "",
      };
      return [
        conversation,
        ...current.filter((item) => item.id !== targetConversationId),
      ].slice(0, MAX_HISTORY);
    });
    setDraft("");
    setAttachments([]);
    setChoices(readDefaults());
    setStatusNote(null);
    setSending(true);
    setActiveMessageId(request.messageId);
    requestAnimationFrame(() => textareaRef.current?.focus());
    return { request, assistantMessage, targetConversationId };
  };

  const dispatchPrompt = ({
    request,
    assistantMessage,
    targetConversationId,
  }: PendingAssistantPrompt) => {
    void window.chromecraft
      .sendAssistantMessage(request)
      .then((response) => {
        setConversations((current) =>
          current.map((conversation) =>
            conversation.id !== targetConversationId
              ? conversation
              : {
                  ...conversation,
                  updatedAt: response.createdAt,
                  messages: conversation.messages.map((entry) =>
                    entry.id === assistantMessage.id
                      ? {
                          ...entry,
                          text: response.text,
                          createdAt: response.createdAt,
                          status: "complete" as const,
                          model: response.model,
                        }
                      : entry,
                  ),
                },
          ),
        );
      })
      .catch((error: unknown) => {
        const friendly = responseError(error, request.provider);
        setConversations((current) =>
          current.map((conversation) =>
            conversation.id !== targetConversationId
              ? conversation
              : {
                  ...conversation,
                  messages: conversation.messages.map((entry) =>
                    entry.id === assistantMessage.id
                      ? {
                          ...entry,
                          text: friendly,
                          status: "error" as const,
                        }
                      : entry,
                  ),
                },
          ),
        );
      })
      .finally(() => {
        setSending(false);
        setActiveMessageId((current) =>
          current === request.messageId ? null : current,
        );
        requestAnimationFrame(() => textareaRef.current?.focus());
      });
  };

  const dispatchResearchPrompt = ({
    request,
    assistantMessage,
    targetConversationId,
  }: PendingAssistantPrompt) => {
    void window.chromecraft
      .startScoutAgent({
        conversationId: request.conversationId,
        messageId: request.messageId,
        objective: request.prompt,
        createdAt: request.createdAt,
        provider: request.provider,
        model: request.model,
        context: request.context,
        history: request.history,
        cloudConsent:
          request.provider !== "gemini" ||
          scoutAgent.researchCloudConsentGranted ||
          researchConsentChecked,
      })
      .catch((error: unknown) => {
        const friendly =
          error instanceof Error && error.message
            ? error.message
            : responseError(error, request.provider);
        setConversations((current) =>
          current.map((conversation) =>
            conversation.id !== targetConversationId
              ? conversation
              : {
                  ...conversation,
                  messages: conversation.messages.map((entry) =>
                    entry.id === assistantMessage.id
                      ? { ...entry, text: friendly, status: "error" as const }
                      : entry,
                  ),
                },
          ),
        );
      })
      .finally(() => {
        setSending(false);
        setActiveMessageId((current) =>
          current === request.messageId ? null : current,
        );
        requestAnimationFrame(() => textareaRef.current?.focus());
      });
  };

  const sendPrompt = (
    promptValue: string,
    targetConversationId = conversationId,
    promptContext = included,
    historyMessages = currentConversation?.messages ?? [],
    allowWhileCancelling = false,
  ) => {
    const pending = beginPrompt(
      promptValue,
      targetConversationId,
      promptContext,
      historyMessages,
      allowWhileCancelling,
    );
    if (!pending) return false;
    if (scoutAgent.permissionMode === "ask") {
      dispatchResearchPrompt(pending);
    } else {
      dispatchPrompt(pending);
    }
    return true;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (scoutAgent.permissionMode === "ask" && activeRun) {
      const text = draft.trim();
      if (!text) return;
      void window.chromecraft
        .commandScoutAgent({
          type: "enqueue",
          runId: activeRun.id,
          message: { id: identifier("queue"), text, createdAt: Date.now() },
        })
        .then(() => {
          setDraft("");
          setStatusNote("Follow-up queued for this research run.");
        })
        .catch((error: unknown) =>
          setStatusNote(
            error instanceof Error
              ? error.message
              : "Could not queue that follow-up.",
          ),
        );
      return;
    }
    if (
      scoutAgent.permissionMode === "ask" &&
      aiTools.provider === "gemini" &&
      !scoutAgent.researchCloudConsentGranted &&
      !researchConsentChecked
    ) {
      setStatusNote(
        "Confirm Gemini research processing before starting this run.",
      );
      return;
    }
    sendPrompt(draft);
  };

  useEffect(() => {
    if (
      !initialCommand ||
      handledCommandRef.current === initialCommand.id ||
      !initialCommand.prompt.trim()
    ) {
      return;
    }
    handledCommandRef.current = initialCommand.id;
    const nextConversationId = identifier("chat");
    const defaults = readDefaults();
    setConversationId(nextConversationId);
    setAttachments([]);
    setChoices(defaults);
    setOpenPopover(null);
    setStatusNote(null);
    setSending(false);
    setActiveMessageId(null);
    nearBottomRef.current = true;
    const previousMessageId = activeMessageId;
    const pending = beginPrompt(
      initialCommand.prompt,
      nextConversationId,
      [],
      [],
      true,
    );
    if (!pending) {
      onInitialCommandConsumed?.();
      return;
    }
    let cancelled = false;
    void (async () => {
      if (previousMessageId) {
        await window.chromecraft
          .cancelAssistantMessage(previousMessageId)
          .catch(() => undefined);
      }
      let commandPage = page;
      if (!commandPage) {
        commandPage = await window.chromecraft
          .getAssistantPageContext(activeTab.id)
          .catch(() => null);
      }
      if (cancelled) return;
      const commandContext = contextAttachments(commandPage, defaults, []);
      const request = {
        ...pending.request,
        context: structuredClone(commandContext),
      };
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id !== nextConversationId
            ? conversation
            : {
                ...conversation,
                messages: conversation.messages.map((message) =>
                  message.id === request.messageId
                    ? { ...message, attachments: request.context }
                    : message,
                ),
              },
        ),
      );
      if (scoutAgent.permissionMode === "ask") {
        dispatchResearchPrompt({ ...pending, request });
      } else {
        dispatchPrompt({ ...pending, request });
      }
      onInitialCommandConsumed?.();
    })();
    return () => {
      cancelled = true;
    };
  }, [initialCommand?.id]);

  const addSuggestion = (text: string) => {
    setDraft(text);
    setStatusNote(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const removeContext = (item: AssistantAttachment) => {
    if (attachments.some((attachment) => attachment.id === item.id)) {
      setAttachments((current) =>
        current.filter((entry) => entry.id !== item.id),
      );
    } else {
      updateChoice(item.kind, false);
    }
  };

  const copyMessage = async (message: ConversationMessage) => {
    try {
      await navigator.clipboard.writeText(message.text);
      setStatusNote("Message copied.");
    } catch {
      setStatusNote("Could not copy this message.");
    }
  };

  const runForMessage = (messageId: string): AgentRunSnapshot | null =>
    currentRuns.find((run) => `reply-${run.messageId}` === messageId) ?? null;

  const characterState =
    capturing || sending || agentBusy ? "thinking" : draft ? "typing" : "idle";
  const composerWillStop = sending || Boolean(activeRun && !draft.trim());

  return (
    <div className="ai-assistant-panel" ref={panelRef}>
      <header className="ai-assistant-header">
        <StaticAssistantAvatar className="ai-header-avatar" size={32} />
        <div className="ai-assistant-title">
          <strong id="sidebar-panel-title">Scout</strong>
          <span data-status={statusKind}>{statusLabel}</span>
        </div>
        <div className="ai-assistant-header-actions">
          <button
            ref={historyButtonRef}
            type="button"
            onClick={() => setOnlyPopover("history")}
            title="Conversation history"
            aria-label="Conversation history"
            aria-haspopup="dialog"
            aria-expanded={openPopover === "history"}
          >
            {icon("history")}
          </button>
          <button
            className="ai-new-conversation-action"
            type="button"
            onClick={newConversation}
            title="New conversation"
            aria-label="New conversation"
          >
            {icon("edit_square")}
          </button>
          <button
            ref={moreButtonRef}
            type="button"
            onClick={() => setOnlyPopover("more")}
            title="More options"
            aria-label="More options"
            aria-haspopup="menu"
            aria-expanded={openPopover === "more"}
          >
            {icon("more_vert")}
          </button>
          <button
            type="button"
            onClick={close}
            title="Close sidebar"
            aria-label="Close Scout"
          >
            {icon("close")}
          </button>
        </div>
      </header>

      {openPopover === "history" && (
        <AssistantPopover
          anchorRef={historyButtonRef}
          boundaryRef={panelRef}
          className="ai-history-popover"
          idealWidth={296}
          label="Conversation history"
          onClose={() => setOpenPopover(null)}
          placement="bottom"
        >
          <div className="ai-popover-heading">
            <strong>Conversations</strong>
            <button type="button" onClick={newConversation}>
              {icon("add")} New chat
            </button>
          </div>
          <div className="ai-history-list">
            {conversations.length === 0 ? (
              <p>No saved conversations yet.</p>
            ) : (
              conversations.map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  aria-current={
                    conversation.id === conversationId ? "page" : undefined
                  }
                  onClick={() => {
                    setConversationId(conversation.id);
                    setDraft(conversation.draft);
                    setOpenPopover(null);
                    nearBottomRef.current = true;
                    requestAnimationFrame(() => textareaRef.current?.focus());
                  }}
                >
                  <span>{conversation.title}</span>
                  <small>
                    {new Date(conversation.updatedAt).toLocaleDateString()}
                  </small>
                </button>
              ))
            )}
          </div>
        </AssistantPopover>
      )}

      {openPopover === "more" && (
        <AssistantPopover
          anchorRef={moreButtonRef}
          boundaryRef={panelRef}
          className="ai-more-popover"
          idealWidth={236}
          label="More options"
          onClose={() => setOpenPopover(null)}
          placement="bottom"
          role="menu"
        >
          <button type="button" role="menuitem" onClick={newConversation}>
            {icon("edit_square")} <span>New conversation</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpenPopover(null);
              onOrganiseTabs();
            }}
          >
            {icon("tab_group")} <span>Organise my tabs</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void refreshPage();
              setOpenPopover(null);
              setStatusNote("Page context refreshed.");
            }}
          >
            {icon("refresh")} <span>Refresh page context</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpenPopover(null);
              onOpenSettings();
            }}
          >
            {icon("settings")} <span>Scout settings</span>
          </button>
        </AssistantPopover>
      )}

      <div className="ai-conversation-region">
        <div
          className="ai-assistant-scroll"
          ref={scrollRef}
          onScroll={(event) => {
            const target = event.currentTarget;
            const nearBottom =
              target.scrollHeight - target.scrollTop - target.clientHeight < 48;
            nearBottomRef.current = nearBottom;
            setShowScrollBottom(!nearBottom);
          }}
        >
          {!currentConversation?.messages.length ? (
            <section className="ai-assistant-welcome">
              <AnimatedAssistantAvatar state={characterState} />
              <h3>Hey! What can I help you with?</h3>
              <p>
                Ask about this page, explore ideas, or get help with your
                browser.
              </p>
              <div className="ai-suggestions">
                <button
                  type="button"
                  onClick={() => addSuggestion("Summarise this page")}
                >
                  {icon("summarize")} <span>Summarise this page</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    addSuggestion("Explain something on this page")
                  }
                >
                  {icon("lightbulb")}{" "}
                  <span>Explain something on this page</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    addSuggestion("Help me understand this website")
                  }
                >
                  {icon("travel_explore")}{" "}
                  <span>Help me understand this website</span>
                </button>
                <button type="button" onClick={onOrganiseTabs}>
                  {icon("tab_group")} <span>Organise my tabs</span>
                </button>
              </div>
            </section>
          ) : (
            <section className="ai-message-list" aria-live="polite">
              {currentConversation.messages.map((message) => (
                <article
                  className={`ai-message ai-message-${message.role} ${
                    message.status === "error" ? "ai-message-error" : ""
                  }`}
                  key={message.id}
                  aria-busy={message.status === "thinking" || undefined}
                >
                  {message.role === "assistant" && (
                    <StaticAssistantAvatar
                      className="ai-message-avatar"
                      size={24}
                    />
                  )}
                  {message.status === "thinking" ? (
                    <div className="ai-thinking-indicator" role="status">
                      <span />
                      <span />
                      <span />
                      <span className="sr-only">Scout is thinking</span>
                    </div>
                  ) : (
                    <p>{message.text}</p>
                  )}
                  {message.role === "assistant" &&
                    runForMessage(message.id) && (
                      <ScoutAgentTimeline
                        run={runForMessage(message.id)!}
                        command={(command) =>
                          window.chromecraft.commandScoutAgent(command)
                        }
                        onError={setStatusNote}
                      />
                    )}
                  <footer>
                    <small>
                      {message.status === "error"
                        ? "Could not complete"
                        : message.role === "assistant"
                          ? (message.model ?? "Scout")
                          : "You"}{" "}
                      ·{" "}
                      {new Date(message.createdAt).toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </small>
                    {message.status !== "thinking" && (
                      <button
                        type="button"
                        onClick={() => void copyMessage(message)}
                        aria-label="Copy message"
                        title="Copy message"
                      >
                        {icon("content_copy")}
                      </button>
                    )}
                  </footer>
                </article>
              ))}
            </section>
          )}
        </div>
        {showScrollBottom && (
          <button
            type="button"
            className="ai-scroll-bottom"
            onClick={() => {
              const scroller = scrollRef.current;
              nearBottomRef.current = true;
              setShowScrollBottom(false);
              scroller?.scrollTo({
                top: scroller.scrollHeight,
                behavior: "smooth",
              });
            }}
            aria-label="Scroll to latest message"
            title="Scroll to latest message"
          >
            {icon("arrow_downward")}
          </button>
        )}
      </div>

      <form className="ai-composer" onSubmit={submit}>
        {(capturing ||
          visibleContextChips.length > 0 ||
          statusNote ||
          (scoutAgent.permissionMode === "ask" &&
            aiTools.provider === "gemini" &&
            !scoutAgent.researchCloudConsentGranted)) && (
          <div className="ai-composer-extras">
            {capturing && (
              <div className="ai-capture-status" role="status">
                {icon(capturing === "screenshot" ? "crop" : "ads_click")}
                <span>
                  Select {capturing === "screenshot" ? "an area" : "an element"}
                  .
                </span>
                <button
                  type="button"
                  onClick={() => {
                    void window.chromecraft.cancelAssistantSelection();
                    setCapturing(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            )}
            {visibleContextChips.length > 0 && (
              <div className="ai-context-chips" aria-label="Included context">
                {visibleContextChips.map((item) => (
                  <span
                    className="ai-context-chip"
                    key={item.id}
                    title={item.detail ?? item.label}
                  >
                    {icon(attachmentIcon(item.kind))}
                    <button
                      type="button"
                      className="ai-context-chip-preview"
                      disabled={item.kind !== "full-reader-article"}
                      onClick={() =>
                        item.kind === "full-reader-article" &&
                        setReaderPreview(item)
                      }
                    >
                      {item.kind === "full-reader-article"
                        ? `Full article · ${item.detail ?? "Article"}`
                        : item.label}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeContext(item)}
                      aria-label={`Remove ${item.label}`}
                    >
                      {icon("close")}
                    </button>
                  </span>
                ))}
              </div>
            )}
            {readerPreview?.data.readerArticle && (
              <section
                className="ai-reader-preview"
                role="dialog"
                aria-label="Full Reader Article preview"
              >
                <header>
                  <span>{icon("auto_stories")}</span>
                  <span>
                    <strong>{readerPreview.data.readerArticle.title}</strong>
                    <small>
                      {readerPreview.data.readerArticle.siteName ??
                        new URL(readerPreview.data.readerArticle.url).hostname}
                    </small>
                  </span>
                  <button
                    type="button"
                    onClick={() => setReaderPreview(null)}
                    aria-label="Close article preview"
                  >
                    {icon("close")}
                  </button>
                </header>
                <p>
                  {readerPreview.data.readerArticle.text.slice(0, 700)}
                  {readerPreview.data.readerArticle.text.length > 700
                    ? "…"
                    : ""}
                </p>
                <small>
                  Preview abbreviated ·{" "}
                  {readerPreview.data.readerArticle.text.length.toLocaleString()}{" "}
                  captured characters are attached. Very long articles may be
                  partially included to fit the selected model.
                </small>
                <button
                  type="button"
                  onClick={() =>
                    void window.chromecraft.createTab(
                      readerPreview.data.readerArticle!.url,
                    )
                  }
                >
                  {icon("open_in_new")} Open source
                </button>
              </section>
            )}
            {statusNote && (
              <p className="ai-status-note" role="status">
                {statusNote}
              </p>
            )}
            {scoutAgent.permissionMode === "ask" &&
              aiTools.provider === "gemini" &&
              !scoutAgent.researchCloudConsentGranted && (
                <label className="scout-research-consent">
                  <input
                    type="checkbox"
                    checked={researchConsentChecked}
                    onChange={(event) =>
                      setResearchConsentChecked(event.target.checked)
                    }
                  />
                  <span>
                    <strong>Allow Gemini research</strong>
                    <small>
                      Open-tab titles and relevant content from the tabs Scout
                      chooses may be sent to Google. Full unrelated pages are
                      not uploaded.
                    </small>
                  </span>
                </label>
              )}
          </div>
        )}

        <div className="ai-composer-surface">
          <textarea
            ref={textareaRef}
            value={draft}
            rows={1}
            placeholder="Ask Scout..."
            onChange={(event) => {
              setDraft(event.target.value);
              setStatusNote(null);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            aria-label="Ask Scout"
          />
          <div className="ai-composer-toolbar">
            <button
              ref={plusButtonRef}
              type="button"
              className="ai-composer-plus"
              onClick={(event) => {
                attachmentAnchorRef.current = event.currentTarget;
                setOnlyPopover("attachments");
              }}
              aria-label="Add context"
              title="Add context"
              aria-haspopup="dialog"
              aria-expanded={openPopover === "attachments"}
            >
              {icon("add")}
            </button>
            <button
              ref={contextButtonRef}
              className="ai-page-context"
              type="button"
              onClick={(event) => {
                attachmentAnchorRef.current = event.currentTarget;
                setOnlyPopover("attachments");
              }}
              aria-haspopup="dialog"
              aria-expanded={openPopover === "attachments"}
              title={`Included context for ${pageDisplay}`}
            >
              {icon("language")}
              <span>This page</span>
              {included.length > 0 && (
                <small aria-label={`${included.length} context items`}>
                  {included.length}
                </small>
              )}
            </button>
            <button
              ref={modeButtonRef}
              type="button"
              className="scout-mode-button"
              onClick={() => setOnlyPopover("mode")}
              aria-label={`Scout permission mode: ${scoutAgent.permissionMode}`}
              title="Scout permission mode"
              aria-haspopup="menu"
              aria-expanded={openPopover === "mode"}
              data-mode={scoutAgent.permissionMode}
            >
              {icon(
                scoutAgent.permissionMode === "ask" ? "travel_explore" : "chat",
              )}
              <span>
                {scoutAgent.permissionMode === "ask" ? "Ask" : "Chat"}
              </span>
            </button>
            <span className="ai-composer-toolbar-spacer" />
            <button
              ref={powerButtonRef}
              type="button"
              className="ai-power-button"
              onClick={togglePowerPopover}
              aria-label="Scout Power"
              title="Scout Power"
              aria-haspopup="dialog"
              aria-expanded={openPopover === "power"}
              data-provider={aiTools.provider}
            >
              {icon("speed")}
            </button>
            <button
              type={composerWillStop ? "button" : "submit"}
              className="ai-send"
              disabled={(!draft.trim() || powerBusy) && !composerWillStop}
              aria-label={
                composerWillStop
                  ? "Stop response"
                  : activeRun
                    ? "Queue follow-up"
                    : "Send message"
              }
              title={
                composerWillStop
                  ? "Stop response"
                  : activeRun
                    ? "Queue follow-up"
                    : "Send message"
              }
              onClick={
                composerWillStop
                  ? () => {
                      if (activeRun) {
                        void window.chromecraft.commandScoutAgent({
                          type: "cancel",
                          runId: activeRun.id,
                        });
                      } else if (activeMessageId) {
                        void window.chromecraft.cancelAssistantMessage(
                          activeMessageId,
                        );
                      }
                    }
                  : undefined
              }
            >
              {icon(composerWillStop ? "stop" : "arrow_upward")}
            </button>
          </div>
        </div>

        {openPopover === "attachments" && (
          <AssistantPopover
            anchorRef={attachmentAnchorRef}
            boundaryRef={panelRef}
            className="ai-attachment-menu"
            idealWidth={328}
            label="Context and attachments"
            onClose={() => setOpenPopover(null)}
          >
            <header className="ai-popover-heading">
              <div>
                <strong>Add context</strong>
                <small>Only for this message</small>
              </div>
            </header>
            <div className="ai-attachment-actions">
              <button
                type="button"
                autoFocus
                onClick={() => void startCapture("screenshot")}
              >
                {icon("crop")}
                <span>
                  <b>Capture screenshot</b>
                  <small>Select an area of the current page.</small>
                </span>
              </button>
              <button
                type="button"
                onClick={() => void startCapture("element")}
              >
                {icon("ads_click")}
                <span>
                  <b>Select page element</b>
                  <small>Point to something to ask about it.</small>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  void refreshPage().then((next) => {
                    if (next?.selectedText) {
                      updateChoice("selected-text", true);
                      setStatusNote("Selected text added to this message.");
                    } else {
                      setStatusNote(
                        "Highlight text on the webpage, then add selected text again.",
                      );
                    }
                  });
                  setOpenPopover(null);
                }}
              >
                {icon("format_quote")}
                <span>
                  <b>Include selected text</b>
                  <small>Use highlighted text from the webpage.</small>
                </span>
              </button>
            </div>
            <div className="ai-context-menu-section">
              <strong>Included in this message</strong>
              {included.length ? (
                <div className="ai-context-menu-list">
                  {included.map((item) => (
                    <div className="ai-context-menu-row" key={item.id}>
                      {icon(attachmentIcon(item.kind))}
                      <span>
                        <b>{item.label}</b>
                        {item.detail && <small>{item.detail}</small>}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${item.label}`}
                        title={`Remove ${item.label}`}
                        onClick={() => removeContext(item)}
                      >
                        {icon("remove")}
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p>No page context is included. Your prompt is always sent.</p>
              )}
            </div>
            {(
              ["url", "title", "description"] as AssistantAttachmentKind[]
            ).some((kind) => !choices[kind]) && (
              <details className="ai-add-context-details">
                <summary>{icon("add")} Add page context</summary>
                <div>
                  {(
                    ["url", "title", "description"] as AssistantAttachmentKind[]
                  )
                    .filter((kind) => !choices[kind])
                    .map((kind) => {
                      const label = {
                        url: "Page URL",
                        title: "Page title",
                        description: "Page description",
                      } as Partial<Record<AssistantAttachmentKind, string>>;
                      return (
                        <button
                          type="button"
                          key={kind}
                          onClick={() => updateChoice(kind, true)}
                        >
                          {icon(attachmentIcon(kind))}
                          <span>{label[kind]}</span>
                        </button>
                      );
                    })}
                </div>
              </details>
            )}
          </AssistantPopover>
        )}

        {openPopover === "mode" && (
          <AssistantPopover
            anchorRef={modeButtonRef}
            boundaryRef={panelRef}
            className="scout-mode-popover"
            idealWidth={344}
            label="Scout permission mode"
            onClose={() => setOpenPopover(null)}
            role="menu"
          >
            <header className="scout-mode-heading">
              <span>{icon("tune")}</span>
              <span>
                <strong>Permission mode</strong>
                <small>Choose what Scout may do for new requests.</small>
              </span>
            </header>
            <div className="scout-mode-options">
              {(
                [
                  {
                    mode: "chat",
                    icon: "chat",
                    name: "Chat",
                    description:
                      "Talk with Scout and share context when you choose.",
                    available: true,
                  },
                  {
                    mode: "ask",
                    icon: "travel_explore",
                    name: "Ask",
                    description:
                      "Let Scout inspect browser tabs and research with you.",
                    available: true,
                  },
                  {
                    mode: "smart-approval",
                    icon: "verified_user",
                    name: "Smart approval",
                    description: "Automatically handle safe actions.",
                    available: false,
                  },
                  {
                    mode: "automated",
                    icon: "rocket_launch",
                    name: "Automated",
                    description: "Let Scout carry out authorised tasks.",
                    available: false,
                  },
                ] as const
              ).map((choice) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={scoutAgent.permissionMode === choice.mode}
                  data-selected={scoutAgent.permissionMode === choice.mode}
                  key={choice.mode}
                  onClick={() => void selectPermissionMode(choice.mode)}
                >
                  <span className="scout-mode-option-icon">
                    {icon(choice.icon)}
                  </span>
                  <span>
                    <b>{choice.name}</b>
                    <small>{choice.description}</small>
                    {!choice.available && <em>Coming soon</em>}
                  </span>
                  {scoutAgent.permissionMode === choice.mode && icon("check")}
                </button>
              ))}
            </div>
            <footer>
              Mode changes apply to new runs. Existing research keeps its
              original permissions.
            </footer>
          </AssistantPopover>
        )}

        {openPopover === "power" && (
          <AssistantPopover
            anchorRef={powerButtonRef}
            boundaryRef={panelRef}
            className="ai-power-popover"
            idealWidth={328}
            label="Scout Power"
            onClose={() => setOpenPopover(null)}
          >
            <header className="ai-power-heading">
              <span className="ai-power-heading-icon">{icon("speed")}</span>
              <span>
                <strong>Scout Power</strong>
                <small>
                  Choose where Scout runs and how much power to use.
                </small>
              </span>
            </header>
            <div
              className="ai-provider-switch"
              role="group"
              aria-label="AI provider"
            >
              <button
                type="button"
                aria-pressed={aiTools.provider === "ollama"}
                onClick={() => void selectProvider("ollama")}
                disabled={powerBusy}
              >
                Local AI
              </button>
              <button
                type="button"
                aria-pressed={aiTools.provider === "gemini"}
                onClick={() => void selectProvider("gemini")}
                disabled={powerBusy}
              >
                Gemini Online
              </button>
            </div>
            <div className="ai-power-model">
              {powerChoice ? (
                <>
                  <div className="ai-power-model-label" aria-live="polite">
                    <span>{powerChoice.category}</span>
                    <strong>{powerChoice.displayName}</strong>
                    {powerChoice.detail && <small>{powerChoice.detail}</small>}
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, powerChoices.length - 1)}
                    step={1}
                    value={powerIndex}
                    disabled={powerBusy || powerChoices.length < 2}
                    aria-label="Scout model power"
                    aria-valuetext={`${powerChoice.category}: ${powerChoice.displayName}`}
                    onChange={(event) =>
                      void selectPowerModel(Number(event.target.value))
                    }
                  />
                  <div className="ai-power-range-labels" aria-hidden="true">
                    <span>Faster</span>
                    <span>More capable</span>
                  </div>
                </>
              ) : (
                <div className="ai-power-empty">
                  <strong>
                    {aiTools.provider === "ollama"
                      ? "No compatible local models"
                      : "No Gemini models available"}
                  </strong>
                  <p>
                    {aiTools.provider === "ollama"
                      ? "Start Ollama and install a text model. Scout checks automatically."
                      : "Add a Gemini API key in Scout settings. Scout checks automatically."}
                  </p>
                </div>
              )}
              {aiTools.provider === "gemini" && (
                <div className="ai-power-cloud-note">
                  <p>
                    {icon("cloud")}
                    Gemini sends prompts, conversation history, and selected
                    page context to Google and may use paid quota.
                  </p>
                </div>
              )}
              {powerError && (
                <p className="ai-power-error" role="alert">
                  {powerError}
                </p>
              )}
            </div>
            <footer className="ai-power-footer">
              <button
                type="button"
                disabled={
                  powerBusy ||
                  (aiTools.provider === "gemini" &&
                    !aiTools.gemini.apiKeyConfigured)
                }
                onClick={() => void refreshPowerModels(aiTools.provider)}
              >
                {icon("refresh")} Refresh models
              </button>
              <button type="button" onClick={onOpenSettings}>
                {icon("settings")} Settings
              </button>
            </footer>
          </AssistantPopover>
        )}
      </form>
    </div>
  );
}
