import {
  type FormEvent,
  useCallback,
  useEffect,
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
  if (snapshot.run.stage === "thinking")
    return ["Thinking", "thinking"] as const;
  if (snapshot.run.stage === "checking")
    return ["Model loading", "loading"] as const;
  if (snapshot.connection === "connected" && snapshot.selectedModel)
    return ["Ready for tab tools", "ready"] as const;
  return ["AI unavailable", "unavailable"] as const;
}

function AssistantCharacter({
  state,
}: {
  state: "idle" | "typing" | "thinking" | "success";
}) {
  const root = useRef<HTMLDivElement>(null);
  const target = useRef({ x: 0, y: 0 });
  const current = useRef({ x: 0, y: 0 });
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const element = root.current;
    if (!element || matchMedia("(prefers-reduced-motion: reduce)").matches)
      return;
    const render = () => {
      frame.current = null;
      current.current.x += (target.current.x - current.current.x) * 0.16;
      current.current.y += (target.current.y - current.current.y) * 0.16;
      element.style.setProperty(
        "--ai-eye-x",
        `${current.current.x.toFixed(2)}px`,
      );
      element.style.setProperty(
        "--ai-eye-y",
        `${current.current.y.toFixed(2)}px`,
      );
      if (
        Math.abs(target.current.x - current.current.x) > 0.05 ||
        Math.abs(target.current.y - current.current.y) > 0.05
      )
        frame.current = requestAnimationFrame(render);
    };
    const move = (event: globalThis.PointerEvent) => {
      const bounds = element.getBoundingClientRect();
      target.current = {
        x: Math.max(
          -3,
          Math.min(3, (event.clientX - bounds.left - bounds.width / 2) / 16),
        ),
        y: Math.max(
          -2,
          Math.min(2, (event.clientY - bounds.top - bounds.height / 2) / 20),
        ),
      };
      if (frame.current === null) frame.current = requestAnimationFrame(render);
    };
    const reset = () => {
      target.current = { x: 0, y: 0 };
      if (frame.current === null) frame.current = requestAnimationFrame(render);
    };
    addEventListener("pointermove", move, { passive: true });
    addEventListener("blur", reset);
    return () => {
      removeEventListener("pointermove", move);
      removeEventListener("blur", reset);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  return (
    <div
      className={`ai-character ai-character-${state}`}
      ref={root}
      aria-hidden="true"
    >
      <span className="ai-character-eye">
        <i />
      </span>
      <span className="ai-character-eye">
        <i />
      </span>
    </div>
  );
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
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [capturing, setCapturing] = useState<"screenshot" | "element" | null>(
    null,
  );
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [statusLabel, statusKind] = statusFor(aiTools);
  const currentConversation =
    conversations.find((item) => item.id === conversationId) ?? null;
  const included = useMemo(
    () => contextAttachments(page, choices, attachments),
    [attachments, choices, page],
  );

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

  useEffect(() => {
    return window.chromecraft.onAssistantContextCaptured(
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
    );
  }, []);

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
      if (event.key !== "Escape") return;
      if (capturing) {
        void window.chromecraft.cancelAssistantSelection();
        setCapturing(null);
        return;
      }
      setAttachmentMenuOpen(false);
      setContextOpen(false);
      setHistoryOpen(false);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [capturing]);

  const startCapture = async (kind: "screenshot" | "element") => {
    setAttachmentMenuOpen(false);
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
  };

  const newConversation = () => {
    setConversationId(identifier("chat"));
    setDraft("");
    setAttachments([]);
    setStatusNote(null);
    setHistoryOpen(false);
    textarea.current?.focus();
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
    // The future adapter receives this stable, per-message snapshot. General
    // conversation transport is intentionally not fabricated by this UI.
    void request;
    setDraft("");
    setStatusNote(
      aiTools.connection === "connected"
        ? "General chat is not connected yet. Your prompt is still in the composer."
        : "Chromecraft AI is unavailable. Start Ollama and choose a model to use tab tools.",
    );
    textarea.current?.focus();
  };

  const addSuggestion = (text: string) => {
    setDraft(text);
    setStatusNote(null);
    requestAnimationFrame(() => textarea.current?.focus());
  };

  const removeAttachment = (id: string) =>
    setAttachments((current) => current.filter((item) => item.id !== id));

  const characterState =
    capturing || aiTools.run.stage === "thinking"
      ? "thinking"
      : draft
        ? "typing"
        : "idle";

  return (
    <div className="ai-assistant-panel" data-capturing={capturing ?? undefined}>
      <header className="ai-assistant-header">
        <AssistantCharacter state={characterState} />
        <div className="ai-assistant-title">
          <strong>Chromecraft AI</strong>
          <span data-status={statusKind}>{statusLabel}</span>
        </div>
        <div className="ai-assistant-header-actions">
          <button
            type="button"
            onClick={() => setHistoryOpen((open) => !open)}
            aria-label="Conversation history"
            aria-expanded={historyOpen}
          >
            {icon("history")}
          </button>
          <button
            type="button"
            onClick={newConversation}
            aria-label="New conversation"
          >
            {icon("edit_square")}
          </button>
          <button
            type="button"
            onClick={close}
            aria-label="Close Chromecraft AI"
          >
            {icon("close")}
          </button>
        </div>
      </header>

      {historyOpen && (
        <section
          className="ai-history-popover"
          aria-label="Conversation history"
        >
          <div>
            <strong>Conversations</strong>
            <button type="button" onClick={newConversation}>
              {icon("add")} New chat
            </button>
          </div>
          {conversations.length === 0 ? (
            <p>No saved conversations yet.</p>
          ) : (
            conversations.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                onClick={() => {
                  setConversationId(conversation.id);
                  setDraft(conversation.draft);
                  setHistoryOpen(false);
                }}
              >
                <span>{conversation.title}</span>
                <small>
                  {new Date(conversation.updatedAt).toLocaleDateString()}
                </small>
              </button>
            ))
          )}
        </section>
      )}

      <div className="ai-assistant-scroll">
        {!currentConversation?.messages.length ? (
          <section className="ai-assistant-welcome">
            <AssistantCharacter state="idle" />
            <h3>Hey! What can I help you with?</h3>
            <p>
              Ask about this page, explore ideas, or get help with your browser.
            </p>
            <div className="ai-suggestions">
              <button
                type="button"
                onClick={() => addSuggestion("Summarise this page")}
              >
                {icon("summarize")} Summarise this page
              </button>
              <button
                type="button"
                onClick={() => addSuggestion("Explain something on this page")}
              >
                {icon("lightbulb")} Explain something on this page
              </button>
              <button
                type="button"
                onClick={() => addSuggestion("Help me understand this website")}
              >
                {icon("travel_explore")} Help me understand this website
              </button>
              <button type="button" onClick={onOrganiseTabs}>
                {icon("tab_group")} Organise my tabs
              </button>
            </div>
          </section>
        ) : (
          <section className="ai-message-list" aria-live="polite">
            {currentConversation.messages.map((message) => (
              <article className="ai-message ai-message-user" key={message.id}>
                <p>{message.text}</p>
                <small>
                  Not sent ·{" "}
                  {new Date(message.createdAt).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </small>
              </article>
            ))}
          </section>
        )}
      </div>

      <form className="ai-composer" onSubmit={submit}>
        {capturing && (
          <div className="ai-capture-status" role="status">
            {icon(capturing === "screenshot" ? "crop" : "ads_click")} Select{" "}
            {capturing === "screenshot" ? "an area" : "an element"} on the page.{" "}
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
        {included.length > 0 && (
          <div className="ai-context-chips" aria-label="Included context">
            {included.map((item) => (
              <span
                className="ai-context-chip"
                key={item.id}
                title={item.detail ?? item.label}
              >
                {icon(attachmentIcon(item.kind))}
                <span>
                  {item.kind === "page"
                    ? `This page · ${item.detail}`
                    : item.label}
                </span>
                {attachments.some(
                  (attachment) => attachment.id === item.id,
                ) && (
                  <button
                    type="button"
                    onClick={() => removeAttachment(item.id)}
                    aria-label={`Remove ${item.label}`}
                  >
                    {icon("close")}
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        <button
          className="ai-page-context"
          type="button"
          onClick={() => setContextOpen((open) => !open)}
          aria-expanded={contextOpen}
        >
          {icon("language")}{" "}
          <span>
            This page ·{" "}
            {page?.displayUrl ?? safeUrl(activeTab.url)?.display ?? "New tab"}
          </span>{" "}
          {icon("expand_more")}
        </button>
        {contextOpen && (
          <section className="ai-context-popover" aria-label="Included context">
            <header>
              <strong>Included context</strong>
              <button
                type="button"
                onClick={() => setContextOpen(false)}
                aria-label="Close included context"
              >
                {icon("close")}
              </button>
            </header>
            {(
              [
                "url",
                "title",
                "description",
                "selected-text",
                "screenshot",
                "element",
              ] as AssistantAttachmentKind[]
            ).map((kind) => (
              <label key={kind}>
                <span>
                  <b>
                    {
                      (
                        {
                          url: "Website URL",
                          title: "Page title",
                          description: "Page description",
                          "selected-text": "Selected text",
                          screenshot: "Screenshot attachment",
                          element: "Selected page element",
                        } as Record<string, string>
                      )[kind]
                    }
                  </b>
                  <small>
                    {kind === "url"
                      ? "Sensitive query parameters are removed."
                      : kind === "description"
                        ? "Only included when available."
                        : kind === "selected-text"
                          ? "Only highlighted text is included."
                          : kind === "screenshot"
                            ? "Captured only when you attach one."
                            : kind === "element"
                              ? "Uses a sanitised element summary."
                              : ""}
                  </small>
                </span>
                <input
                  type="checkbox"
                  checked={choices[kind]}
                  onChange={(event) => updateChoice(kind, event.target.checked)}
                />
              </label>
            ))}
            <footer>
              <button
                type="button"
                onClick={() => setChoices({ ...defaultChoices })}
              >
                Restore defaults
              </button>
              <button type="button" onClick={saveDefaults}>
                Save defaults
              </button>
            </footer>
          </section>
        )}
        {attachmentMenuOpen && (
          <section
            className="ai-attachment-menu"
            role="menu"
            aria-label="Add context"
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
                setAttachmentMenuOpen(false);
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
              onClick={() => {
                setAttachmentMenuOpen(false);
                setContextOpen(true);
              }}
            >
              {icon("tune")}
              <span>
                <b>Manage context</b>
                <small>Choose what information is included.</small>
              </span>
            </button>
          </section>
        )}
        <div className="ai-composer-surface">
          <button
            type="button"
            className="ai-composer-plus"
            onClick={() => setAttachmentMenuOpen((open) => !open)}
            aria-label="Add context"
            aria-expanded={attachmentMenuOpen}
          >
            {icon("add")}
          </button>
          <textarea
            ref={textarea}
            value={draft}
            rows={1}
            placeholder="Ask Chromecraft AI..."
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            aria-label="Ask Chromecraft AI"
          />
          <button
            type="submit"
            className="ai-send"
            disabled={!draft.trim()}
            aria-label="Send message"
          >
            {icon("arrow_upward")}
          </button>
        </div>
        {statusNote && (
          <p className="ai-status-note" role="status">
            {statusNote}
          </p>
        )}
      </form>
    </div>
  );
}
