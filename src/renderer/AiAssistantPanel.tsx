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
import type {
  AssistantAttachment,
  AssistantAttachmentKind,
  AssistantContextCaptured,
  AssistantMessageRequest,
  AssistantPageContext,
} from "../shared/ai-assistant";
import type { BrowserTabSnapshot } from "../shared/browser";
import {
  AnimatedAssistantAvatar,
  StaticAssistantAvatar,
} from "./AssistantAvatar";
import { AssistantPopover } from "./AssistantPopover";
import "./ai-assistant.css";

const HISTORY_STORAGE_KEY = "chromecraft-ai-assistant-history-v1";
const DEFAULTS_STORAGE_KEY = "chromecraft-ai-assistant-context-v1";
const MAX_HISTORY = 24;

type ContextChoices = Record<AssistantAttachmentKind, boolean>;
type ConversationMessage = {
  id: string;
  text: string;
  createdAt: number;
  attachments: AssistantAttachment[];
};
type Conversation = {
  id: string;
  title: string;
  updatedAt: number;
  messages: ConversationMessage[];
  draft: string;
};
type OpenPopover = "attachments" | "context" | "history" | "more" | null;

const defaultChoices: ContextChoices = {
  page: true,
  url: true,
  title: true,
  description: true,
  "selected-text": false,
  screenshot: false,
  element: false,
};

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
      localStorage.getItem(DEFAULTS_STORAGE_KEY) ?? "",
    ) as Partial<ContextChoices> | null;
    return { ...defaultChoices, ...parsed };
  } catch {
    return { ...defaultChoices };
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
      );
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
    if (choices.page) {
      items.push({
        id: `page-${page.tabId}`,
        kind: "page",
        label: "Page",
        detail: page.displayUrl,
        createdAt: Date.now(),
        data: { url: url?.value, title: page.title.slice(0, 240) },
      });
    }
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
    } satisfies Record<AssistantAttachmentKind, string>
  )[kind];
}

function statusFor(snapshot: AiToolsSnapshot) {
  if (["checking", "thinking", "applying"].includes(snapshot.run.stage)) {
    return ["Thinking", "thinking"] as const;
  }
  if (snapshot.connection === "connected" && snapshot.selectedModel) {
    return ["Ready", "ready"] as const;
  }
  return ["Local AI unavailable", "unavailable"] as const;
}

export function AiAssistantPanel({
  activeTab,
  aiTools,
  close,
  onOrganiseTabs,
}: {
  activeTab: BrowserTabSnapshot;
  aiTools: AiToolsSnapshot;
  close: () => void;
  onOrganiseTabs: () => void;
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

  const panelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const plusButtonRef = useRef<HTMLButtonElement>(null);
  const contextButtonRef = useRef<HTMLButtonElement>(null);

  const [statusLabel, statusKind] = statusFor(aiTools);
  const currentConversation =
    conversations.find((item) => item.id === conversationId) ?? null;
  const included = useMemo(
    () => contextAttachments(page, choices, attachments),
    [attachments, choices, page],
  );
  const visibleContextChips = useMemo(
    () =>
      included.filter((item) =>
        ["selected-text", "screenshot", "element"].includes(item.kind),
      ),
    [included],
  );
  const pageDisplay =
    page?.displayUrl ?? safeUrl(activeTab.url)?.display ?? "New tab";

  const refreshPage = useCallback(async () => {
    try {
      const next = await window.chromecraft.getAssistantPageContext(
        activeTab.id,
      );
      setPage(next);
    } catch {
      setPage(null);
    }
  }, [activeTab.id]);

  useEffect(() => {
    void refreshPage();
  }, [refreshPage, activeTab.url]);

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
    localStorage.setItem(
      HISTORY_STORAGE_KEY,
      JSON.stringify(
        conversations.slice(0, MAX_HISTORY).map((conversation) => ({
          ...conversation,
          messages: conversation.messages.map((message) => ({
            ...message,
            // Screenshots and extracted page data remain in memory only.
            attachments: message.attachments.map(
              ({ data: _data, ...attachment }) => ({ ...attachment, data: {} }),
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

  const startCapture = async (kind: "screenshot" | "element") => {
    setOpenPopover(null);
    setStatusNote(null);
    try {
      await window.chromecraft.startAssistantSelection(kind);
      setCapturing(kind);
    } catch (error) {
      setStatusNote(
        error instanceof Error
          ? error.message
          : "This page cannot be captured.",
      );
    }
  };

  const updateChoice = (kind: AssistantAttachmentKind, checked: boolean) => {
    setChoices((current) => ({ ...current, [kind]: checked }));
  };

  const saveDefaults = () => {
    localStorage.setItem(DEFAULTS_STORAGE_KEY, JSON.stringify(choices));
    setStatusNote("Saved as the default included context.");
    setOpenPopover(null);
    requestAnimationFrame(() => contextButtonRef.current?.focus());
  };

  const newConversation = () => {
    setConversationId(identifier("chat"));
    setDraft("");
    setAttachments([]);
    setStatusNote(null);
    setOpenPopover(null);
    nearBottomRef.current = true;
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const prompt = draft.trim();
    if (!prompt) return;
    const request: AssistantMessageRequest = {
      conversationId,
      messageId: identifier("message"),
      prompt,
      createdAt: Date.now(),
      model: aiTools.selectedModel,
      context: structuredClone(included),
    };
    const message: ConversationMessage = {
      id: request.messageId,
      text: request.prompt,
      createdAt: request.createdAt,
      attachments: request.context,
    };
    nearBottomRef.current = true;
    setConversations((current) => {
      const existing = current.find((item) => item.id === conversationId);
      const conversation: Conversation = {
        id: conversationId,
        title: existing?.title ?? prompt.slice(0, 56),
        updatedAt: request.createdAt,
        messages: [...(existing?.messages ?? []), message],
        draft: "",
      };
      return [
        conversation,
        ...current.filter((item) => item.id !== conversationId),
      ].slice(0, MAX_HISTORY);
    });
    // General conversation transport is intentionally not fabricated here.
    void request;
    setDraft("");
    setStatusNote(
      aiTools.connection === "connected"
        ? "Saved locally. General AI chat is not connected yet."
        : "Saved locally. Start Ollama and choose a model to use local AI tools.",
    );
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

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

  const characterState =
    capturing || aiTools.run.stage === "thinking"
      ? "thinking"
      : draft
        ? "typing"
        : "idle";

  return (
    <div className="ai-assistant-panel" ref={panelRef}>
      <header className="ai-assistant-header">
        <StaticAssistantAvatar className="ai-header-avatar" size={32} />
        <div className="ai-assistant-title">
          <strong id="sidebar-panel-title">Chromecraft AI</strong>
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
            aria-label="Close Chromecraft AI"
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
                  className="ai-message ai-message-user"
                  key={message.id}
                >
                  <p>{message.text}</p>
                  <footer>
                    <small>
                      Saved locally ·{" "}
                      {new Date(message.createdAt).toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </small>
                    <button
                      type="button"
                      onClick={() => void copyMessage(message)}
                      aria-label="Copy message"
                      title="Copy message"
                    >
                      {icon("content_copy")}
                    </button>
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
        {(capturing || visibleContextChips.length > 0 || statusNote) && (
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
                    <span>{item.label}</span>
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
            {statusNote && (
              <p className="ai-status-note" role="status">
                {statusNote}
              </p>
            )}
          </div>
        )}

        <div className="ai-composer-surface">
          <textarea
            ref={textareaRef}
            value={draft}
            rows={1}
            placeholder="Ask Chromecraft AI..."
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
            aria-label="Ask Chromecraft AI"
          />
          <div className="ai-composer-toolbar">
            <button
              ref={plusButtonRef}
              type="button"
              className="ai-composer-plus"
              onClick={() => setOnlyPopover("attachments")}
              aria-label="Add context"
              title="Add context"
              aria-haspopup="menu"
              aria-expanded={openPopover === "attachments"}
            >
              {icon("add")}
            </button>
            <button
              ref={contextButtonRef}
              className="ai-page-context"
              type="button"
              onClick={() => setOnlyPopover("context")}
              aria-haspopup="dialog"
              aria-expanded={openPopover === "context"}
              title={`Included context for ${pageDisplay}`}
            >
              {icon("language")}
              <span>This page</span>
              {icon("expand_more")}
            </button>
            <span className="ai-composer-toolbar-spacer" />
            <button
              type="submit"
              className="ai-send"
              disabled={!draft.trim()}
              aria-label="Send message"
              title="Send message"
            >
              {icon("arrow_upward")}
            </button>
          </div>
        </div>

        {openPopover === "context" && (
          <AssistantPopover
            anchorRef={contextButtonRef}
            boundaryRef={panelRef}
            className="ai-context-popover"
            idealWidth={328}
            label="Included context"
            onClose={() => setOpenPopover(null)}
          >
            <header className="ai-popover-heading">
              <div>
                <strong>Included context</strong>
                <small>{pageDisplay}</small>
              </div>
              <button
                type="button"
                onClick={() => {
                  setOpenPopover(null);
                  requestAnimationFrame(() =>
                    contextButtonRef.current?.focus(),
                  );
                }}
                aria-label="Close included context"
              >
                {icon("close")}
              </button>
            </header>
            <div className="ai-context-options">
              {(
                [
                  "url",
                  "title",
                  "description",
                  "selected-text",
                  "screenshot",
                  "element",
                ] as AssistantAttachmentKind[]
              ).map((kind) => {
                const labels = {
                  url: ["Website URL", "Sensitive query details are removed."],
                  title: ["Page title", "The title shown by this tab."],
                  description: [
                    "Page description",
                    "Included when the page provides one.",
                  ],
                  "selected-text": [
                    "Selected text",
                    "Only highlighted text is included.",
                  ],
                  screenshot: [
                    "Screenshot attachment",
                    "Captured only when you attach one.",
                  ],
                  element: [
                    "Selected page element",
                    "A sanitised element summary.",
                  ],
                } satisfies Record<
                  Exclude<AssistantAttachmentKind, "page">,
                  [string, string]
                >;
                if (kind === "page") return null;
                return (
                  <label key={kind}>
                    <span>
                      <b>{labels[kind][0]}</b>
                      <small>{labels[kind][1]}</small>
                    </span>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={choices[kind]}
                      onChange={(event) =>
                        updateChoice(kind, event.target.checked)
                      }
                    />
                  </label>
                );
              })}
            </div>
            <footer className="ai-context-popover-footer">
              <button
                type="button"
                onClick={() => setChoices({ ...defaultChoices })}
              >
                Restore defaults
              </button>
              <button type="button" onClick={saveDefaults}>
                Save as default
              </button>
            </footer>
          </AssistantPopover>
        )}

        {openPopover === "attachments" && (
          <AssistantPopover
            anchorRef={plusButtonRef}
            boundaryRef={panelRef}
            className="ai-attachment-menu"
            idealWidth={296}
            label="Add context"
            onClose={() => setOpenPopover(null)}
            role="menu"
          >
            <button
              type="button"
              role="menuitem"
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
              role="menuitem"
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
              role="menuitem"
              onClick={() => {
                updateChoice("selected-text", true);
                void refreshPage();
                setOpenPopover(null);
              }}
            >
              {icon("format_quote")}
              <span>
                <b>Include selected text</b>
                <small>Use highlighted text from the webpage.</small>
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => setOpenPopover("context")}
            >
              {icon("tune")}
              <span>
                <b>Manage context</b>
                <small>Choose what information is included.</small>
              </span>
            </button>
          </AssistantPopover>
        )}
      </form>
    </div>
  );
}
