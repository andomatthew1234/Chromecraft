import { createHash, randomUUID } from "node:crypto";

import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentEvent,
  AgentEventType,
  AgentQueuedMessage,
  AgentRunCollectionSnapshot,
  AgentRunSnapshot,
  AgentRunStartRequest,
  AgentRunStatus,
  AgentSourceReference,
  AgentToolEffect,
} from "../../shared/agent";

export interface AgentImageInput {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: string;
}

export interface AgentToolCall {
  id: string;
  input: unknown;
}

export interface AgentModelTurn {
  reply: string | null;
  toolCalls: AgentToolCall[];
}

export interface AgentModelTurnInput {
  objective: string;
  initialContext: string;
  tools: AgentToolDescription[];
  transcript: AgentTranscriptEntry[];
  queuedMessages: string[];
  images: AgentImageInput[];
  sources: AgentSourceReference[];
  signal: AbortSignal;
}

export interface AgentModelAdapter {
  readonly supportsImages: boolean;
  turn(input: AgentModelTurnInput): Promise<AgentModelTurn>;
}

export interface AgentModelResolver {
  resolve(
    provider: "ollama" | "gemini",
    model: string,
  ): Promise<AgentModelAdapter>;
}

export interface AgentToolDescription {
  id: string;
  description: string;
  inputSchema: Record<string, unknown>;
  capability: string;
  effect: AgentToolEffect;
  requiresImages?: boolean;
}

export interface PreparedAgentToolCall {
  input: unknown;
  action: string;
  target: string;
  expectedEffect: string;
  risk: string;
  stateRevision: string | null;
}

export interface AgentToolExecutionResult {
  modelResult: unknown;
  eventType?: Extract<
    AgentEventType,
    "tab-inspected" | "article-read" | "screenshot-captured" | "tool-executed"
  >;
  eventLabel: string;
  eventDetail?: string | null;
  source?: AgentSourceReference;
  images?: AgentImageInput[];
  observationBytes?: number;
}

export interface AgentToolContext {
  runId: string;
  conversationId: string;
  signal: AbortSignal;
  now(): number;
}

export interface AgentSourceValidator {
  validate(
    sources: AgentSourceReference[],
    signal: AbortSignal,
  ): Promise<Set<string>>;
}

export interface AgentTool {
  readonly description: AgentToolDescription;
  prepare(
    input: unknown,
    context: AgentToolContext,
  ): Promise<PreparedAgentToolCall>;
  execute(
    prepared: PreparedAgentToolCall,
    context: AgentToolContext,
  ): Promise<AgentToolExecutionResult>;
}

export type AgentPermissionDecision = "allow" | "ask" | "deny";

export interface AgentApprovalPolicy {
  evaluate(input: {
    mode: "ask";
    tool: AgentToolDescription;
    prepared: PreparedAgentToolCall;
  }): AgentPermissionDecision;
}

export interface AgentRunStore {
  load(): Promise<AgentRunSnapshot[]>;
  save(runs: AgentRunSnapshot[]): Promise<void>;
}

export interface AgentRuntimeLimits {
  maximumModelTurns: number;
  maximumToolCalls: number;
  maximumRunDurationMs: number;
  maximumObservationBytes: number;
  maximumScreenshots: number;
  maximumQueuedMessages: number;
  maximumRepeatedToolCalls: number;
  maximumConsecutiveFailures: number;
  maximumStoredRuns: number;
  maximumStoredEvents: number;
}

export interface AgentRunInput extends AgentRunStartRequest {
  initialContext: string;
  initialImages: AgentImageInput[];
}

export type AgentTranscriptEntry =
  | { kind: "assistant"; text: string }
  | {
      kind: "tool-result";
      toolId: string;
      input: unknown;
      result: unknown;
      failed: boolean;
      sourceId: string | null;
    };

export interface AgentRuntimeOptions {
  models: AgentModelResolver;
  tools: AgentTool[];
  policy: AgentApprovalPolicy;
  store: AgentRunStore;
  sourceValidator?: AgentSourceValidator;
  limits?: Partial<AgentRuntimeLimits>;
  now?: () => number;
  id?: () => string;
}

const DEFAULT_LIMITS: AgentRuntimeLimits = {
  maximumModelTurns: 12,
  maximumToolCalls: 24,
  maximumRunDurationMs: 5 * 60_000,
  maximumObservationBytes: 96_000,
  maximumScreenshots: 3,
  maximumQueuedMessages: 8,
  maximumRepeatedToolCalls: 2,
  maximumConsecutiveFailures: 3,
  maximumStoredRuns: 20,
  maximumStoredEvents: 160,
};

const TERMINAL = new Set<AgentRunStatus>(["completed", "failed", "cancelled"]);

const TRANSITIONS: Record<AgentRunStatus, ReadonlySet<AgentRunStatus>> = {
  queued: new Set(["preparing", "cancelled", "failed"]),
  preparing: new Set(["thinking", "pausing", "cancelled", "failed"]),
  thinking: new Set([
    "tool-proposed",
    "completed",
    "pausing",
    "cancelled",
    "failed",
  ]),
  "tool-proposed": new Set([
    "awaiting-approval",
    "executing-tool",
    "thinking",
    "pausing",
    "cancelled",
    "failed",
  ]),
  "awaiting-approval": new Set([
    "executing-tool",
    "thinking",
    "pausing",
    "cancelled",
    "failed",
  ]),
  "executing-tool": new Set([
    "thinking",
    "tool-proposed",
    "pausing",
    "cancelled",
    "failed",
  ]),
  pausing: new Set(["paused", "cancelled", "failed"]),
  paused: new Set(["resuming", "cancelled", "failed"]),
  resuming: new Set([
    "preparing",
    "thinking",
    "tool-proposed",
    "awaiting-approval",
    "executing-tool",
    "cancelled",
    "failed",
  ]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

class CancelledRunError extends Error {}
class RunLimitError extends Error {}

interface AgentRunRecord {
  snapshot: AgentRunSnapshot;
  input: AgentRunInput;
  model: AgentModelAdapter | null;
  transcript: AgentTranscriptEntry[];
  pendingImages: AgentImageInput[];
  queuedMessages: AgentQueuedMessage[];
  activeAbort: AbortController | null;
  cancelRequested: boolean;
  pauseRequested: boolean;
  resumeStatus: AgentRunStatus;
  resumeWaiters: Array<() => void>;
  approvalWaiter: ((approved: boolean) => void) | null;
  approvalTimer: ReturnType<typeof setTimeout> | null;
  eventSequence: number;
  toolCalls: number;
  modelTurns: number;
  observationBytes: number;
  screenshotCount: number;
  consecutiveFailures: number;
  repeatedCalls: Map<string, number>;
  deadline: number;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Scout could not continue this research run.";
}

function statusLabel(status: AgentRunStatus): string {
  const labels: Record<AgentRunStatus, string> = {
    queued: "Queued",
    preparing: "Preparing research",
    thinking: "Scout is thinking",
    "tool-proposed": "Choosing the next source",
    "awaiting-approval": "Waiting for approval",
    "executing-tool": "Inspecting browser content",
    pausing: "Pausing safely",
    paused: "Research paused",
    resuming: "Resuming research",
    completed: "Research complete",
    failed: "Research stopped with an error",
    cancelled: "Research stopped",
  };
  return labels[status];
}

function removeInvalidCitations(text: string, sourceCount: number): string {
  return text.replace(/\[(\d{1,3})\]/gu, (match, value: string) => {
    const citation = Number(value);
    return citation >= 1 && citation <= sourceCount
      ? match
      : "[source reference unavailable]";
  });
}

function safeInputFingerprint(toolId: string, input: unknown): string {
  let encoded: string;
  try {
    const canonical = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonical);
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, canonical(child)]),
        );
      }
      return value;
    };
    encoded = JSON.stringify(canonical(input));
  } catch {
    encoded = "[unserializable]";
  }
  return createHash("sha256").update(`${toolId}\0${encoded}`).digest("hex");
}

function mergeSource(
  current: AgentSourceReference | undefined,
  incoming: AgentSourceReference,
): AgentSourceReference {
  if (!current) return clone(incoming);
  return {
    ...incoming,
    id: current.id,
    observationTypes: [
      ...new Set([...current.observationTypes, ...incoming.observationTypes]),
    ],
    complete: current.complete || incoming.complete,
  };
}

export class AskModeApprovalPolicy implements AgentApprovalPolicy {
  evaluate(input: {
    mode: "ask";
    tool: AgentToolDescription;
  }): AgentPermissionDecision {
    if (input.tool.effect === "observe") return "allow";
    if (
      input.tool.effect === "local-change" ||
      input.tool.effect === "external-side-effect"
    ) {
      return "ask";
    }
    return "deny";
  }
}

export class AgentRuntime {
  private readonly models: AgentModelResolver;
  private readonly tools: Map<string, AgentTool>;
  private readonly policy: AgentApprovalPolicy;
  private readonly store: AgentRunStore;
  private readonly sourceValidator: AgentSourceValidator | null;
  private readonly limits: AgentRuntimeLimits;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly records = new Map<string, AgentRunRecord>();
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly listeners = new Set<
    (snapshot: AgentRunCollectionSnapshot) => void
  >();
  private storedRuns: AgentRunSnapshot[] = [];
  private persistChain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: AgentRuntimeOptions) {
    this.models = options.models;
    this.tools = new Map(
      options.tools.map((tool) => [tool.description.id, tool] as const),
    );
    if (this.tools.size !== options.tools.length) {
      throw new TypeError("Agent tool IDs must be unique.");
    }
    this.policy = options.policy;
    this.store = options.store;
    this.sourceValidator = options.sourceValidator ?? null;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
  }

  get snapshot(): AgentRunCollectionSnapshot {
    const active = [...this.records.values()].map((record) => record.snapshot);
    const activeIds = new Set(active.map((run) => run.id));
    return {
      runs: clone(
        [...active, ...this.storedRuns.filter((run) => !activeIds.has(run.id))]
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .slice(0, this.limits.maximumStoredRuns),
      ),
    };
  }

  get hasActiveRun(): boolean {
    return [...this.records.values()].some(
      (record) => !TERMINAL.has(record.snapshot.status),
    );
  }

  async initialize(): Promise<void> {
    const loaded = await this.store.load();
    const now = this.now();
    this.storedRuns = loaded
      .slice(0, this.limits.maximumStoredRuns)
      .map((run) => {
        if (TERMINAL.has(run.status)) return clone(run);
        const interrupted = clone(run);
        interrupted.status = "failed";
        interrupted.statusLabel = "Research interrupted by browser restart";
        interrupted.updatedAt = now;
        interrupted.completedAt = now;
        interrupted.pendingApproval = null;
        interrupted.error =
          "This research run was interrupted when Chromecraft closed and was not resumed automatically.";
        interrupted.events = [
          ...interrupted.events.slice(-(this.limits.maximumStoredEvents - 1)),
          {
            id: this.id(),
            runId: interrupted.id,
            sequence:
              (interrupted.events.at(-1)?.sequence ??
                interrupted.events.length) + 1,
            timestamp: now,
            type: "run-failed",
            label: "Run interrupted",
            detail: interrupted.error,
            toolId: null,
            status: "error",
            metadata: {},
          },
        ];
        return interrupted;
      });
    await this.publish();
  }

  subscribe(
    listener: (snapshot: AgentRunCollectionSnapshot) => void,
  ): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  async start(input: AgentRunInput): Promise<AgentRunSnapshot> {
    this.assertAvailable();
    if (!input.objective.trim())
      throw new TypeError("A research objective is required.");
    if (
      [...this.records.values()].some(
        (record) =>
          record.snapshot.conversationId === input.conversationId &&
          !TERMINAL.has(record.snapshot.status),
      )
    ) {
      throw new Error("This conversation already has an active research run.");
    }
    const now = this.now();
    const runId = this.id();
    const snapshot: AgentRunSnapshot = {
      id: runId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      objective: input.objective.trim().slice(0, 16_000),
      permissionMode: "ask",
      provider: input.provider,
      model: input.model,
      status: "queued",
      statusLabel: statusLabel("queued"),
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      events: [],
      sources: [],
      pendingApproval: null,
      queuedMessages: [],
      finalText: null,
      error: null,
    };
    const record: AgentRunRecord = {
      snapshot,
      input: clone(input),
      model: null,
      transcript: [],
      pendingImages: clone(input.initialImages),
      queuedMessages: [],
      activeAbort: null,
      cancelRequested: false,
      pauseRequested: false,
      resumeStatus: "preparing",
      resumeWaiters: [],
      approvalWaiter: null,
      approvalTimer: null,
      eventSequence: 0,
      toolCalls: 0,
      modelTurns: 0,
      observationBytes: 0,
      screenshotCount: input.initialImages.length,
      consecutiveFailures: 0,
      repeatedCalls: new Map(),
      deadline: now + this.limits.maximumRunDurationMs,
    };
    this.records.set(runId, record);
    this.addEvent(record, {
      type: "run-started",
      label: "Research run started",
      detail: snapshot.objective.slice(0, 240),
      status: "working",
    });
    await this.publish();
    const task = this.run(record).finally(() => this.tasks.delete(runId));
    this.tasks.set(runId, task);
    return clone(snapshot);
  }

  async enqueue(runId: string, message: AgentQueuedMessage): Promise<void> {
    const record = this.requireActive(runId);
    if (record.queuedMessages.length >= this.limits.maximumQueuedMessages) {
      throw new Error(
        "This research run already has the maximum queued messages.",
      );
    }
    const text = message.text.trim();
    if (!text || text.length > 4_000) {
      throw new TypeError(
        "Queued research guidance must be 1–4,000 characters.",
      );
    }
    record.queuedMessages.push({
      id: message.id.slice(0, 128),
      text,
      createdAt: message.createdAt,
    });
    record.snapshot.queuedMessages = clone(record.queuedMessages);
    this.addEvent(record, {
      type: "message-queued",
      label: "Follow-up queued",
      detail: text.slice(0, 180),
      status: "info",
    });
    await this.publish();
  }

  async pause(runId: string): Promise<void> {
    const record = this.requireActive(runId);
    if (record.pauseRequested || record.snapshot.status === "paused") return;
    record.pauseRequested = true;
    record.resumeStatus =
      record.snapshot.status === "queued"
        ? "preparing"
        : record.snapshot.status;
    this.transition(record, "pausing");
    record.activeAbort?.abort(new DOMException("Paused", "AbortError"));
    if (record.snapshot.status === "pausing" && !record.activeAbort) {
      await this.enterPaused(record);
    } else {
      await this.publish();
    }
  }

  async resume(runId: string): Promise<void> {
    const record = this.requireActive(runId);
    if (record.snapshot.status !== "paused") {
      throw new Error("This research run is not paused.");
    }
    record.pauseRequested = false;
    this.transition(record, "resuming");
    this.addEvent(record, {
      type: "run-resumed",
      label: "Research resumed",
      detail: "Scout will revalidate browser observations before continuing.",
      status: "working",
    });
    const waiters = record.resumeWaiters.splice(0);
    waiters.forEach((resolve) => resolve());
    await this.publish();
  }

  async cancel(runId: string): Promise<void> {
    this.assertAvailable();
    const record = this.records.get(runId);
    if (!record) {
      if (this.storedRuns.some((run) => run.id === runId)) return;
      throw new Error("This Scout research run is no longer active.");
    }
    if (TERMINAL.has(record.snapshot.status)) return;
    record.cancelRequested = true;
    record.pauseRequested = false;
    record.queuedMessages = [];
    record.snapshot.queuedMessages = [];
    record.activeAbort?.abort(new DOMException("Cancelled", "AbortError"));
    record.approvalWaiter?.(false);
    record.approvalWaiter = null;
    if (record.approvalTimer) clearTimeout(record.approvalTimer);
    record.approvalTimer = null;
    record.resumeWaiters.splice(0).forEach((resolve) => resolve());
    if (!record.activeAbort) await this.finishCancelled(record);
    const task = this.tasks.get(runId);
    if (task) await task;
  }

  async respondToApproval(decision: AgentApprovalDecision): Promise<void> {
    const record = this.requireActive(decision.runId);
    const approval = record.snapshot.pendingApproval;
    if (
      !approval ||
      approval.id !== decision.approvalId ||
      approval.preparedActionHash !== decision.preparedActionHash ||
      approval.expiresAt < this.now() ||
      !record.approvalWaiter
    ) {
      throw new Error("This approval request is stale or no longer available.");
    }
    const resolve = record.approvalWaiter;
    record.approvalWaiter = null;
    if (record.approvalTimer) clearTimeout(record.approvalTimer);
    record.approvalTimer = null;
    record.snapshot.pendingApproval = null;
    this.addEvent(record, {
      type: "approval-resolved",
      label: decision.approved ? "Action approved" : "Action denied",
      detail: approval.action,
      toolId: approval.toolId,
      status: decision.approved ? "success" : "warning",
    });
    resolve(decision.approved);
    await this.publish();
  }

  async clearConversation(conversationId: string): Promise<void> {
    const active = [...this.records.values()].filter(
      (record) => record.snapshot.conversationId === conversationId,
    );
    for (const record of active) await this.cancel(record.snapshot.id);
    await Promise.all(
      active.map((record) => this.tasks.get(record.snapshot.id)),
    );
    this.storedRuns = this.storedRuns.filter(
      (run) => run.conversationId !== conversationId,
    );
    await this.publish();
  }

  async dispose(): Promise<void> {
    const activeRunIds = [...this.records.values()]
      .filter((record) => !TERMINAL.has(record.snapshot.status))
      .map((record) => record.snapshot.id);
    await Promise.all(activeRunIds.map((runId) => this.cancel(runId)));
    await Promise.all(activeRunIds.map((runId) => this.tasks.get(runId)));
    this.disposed = true;
    await this.persistChain;
    this.listeners.clear();
  }

  private async run(record: AgentRunRecord): Promise<void> {
    try {
      this.transition(record, "preparing");
      await this.publish();
      const model = await this.runAbortable(record, (signal) =>
        this.models
          .resolve(record.input.provider, record.input.model)
          .then((model) => {
            if (signal.aborted)
              throw new DOMException("Cancelled", "AbortError");
            return model;
          }),
      );
      record.model = model;
      if (record.pendingImages.length && !model.supportsImages) {
        record.pendingImages = [];
        this.addEvent(record, {
          type: "tool-failed",
          label: "Screenshot context skipped",
          detail:
            "The selected model does not support image input, so Scout did not claim to inspect it.",
          status: "warning",
        });
      }
      while (true) {
        this.checkLimits(record);
        await this.waitIfPaused(record);
        this.transition(record, "thinking");
        await this.publish();
        const queuedMessages = record.queuedMessages
          .splice(0)
          .map((item) => item.text);
        record.snapshot.queuedMessages = [];
        const images = record.pendingImages.splice(0);
        const visibleTools = [...this.tools.values()]
          .map((tool) => tool.description)
          .filter(
            (tool) => !tool.requiresImages || record.model!.supportsImages,
          );
        const turn = await this.runAbortable(record, (signal) =>
          record.model!.turn({
            objective: record.snapshot.objective,
            initialContext: record.input.initialContext,
            tools: visibleTools,
            transcript: clone(record.transcript),
            queuedMessages,
            images,
            sources: clone(record.snapshot.sources),
            signal,
          }),
        );
        record.modelTurns += 1;
        if (turn.reply) {
          record.transcript.push({
            kind: "assistant",
            text: turn.reply.slice(0, 16_000),
          });
        }
        if (!turn.toolCalls.length) {
          if (record.queuedMessages.length) {
            this.addEvent(record, {
              type: "message-queued",
              label: "Applying queued guidance",
              detail:
                "Scout received new guidance while the model was responding and will take another turn.",
              status: "info",
            });
            await this.publish();
            continue;
          }
          if (!turn.reply?.trim()) {
            throw new Error(
              "The selected model returned neither a research step nor a final answer. Try a more capable model.",
            );
          }
          await this.finishCompleted(record, turn.reply.trim());
          return;
        }
        this.addEvent(record, {
          type: "model-requested-information",
          label: "Scout requested more information",
          detail: `${turn.toolCalls.length} research ${turn.toolCalls.length === 1 ? "step" : "steps"}`,
          status: "working",
        });
        for (const call of turn.toolCalls.slice(0, 3)) {
          await this.executeTool(record, call);
        }
      }
    } catch (error) {
      if (record.cancelRequested || error instanceof CancelledRunError) {
        await this.finishCancelled(record);
        return;
      }
      await this.finishFailed(record, errorMessage(error));
    }
  }

  private async executeTool(
    record: AgentRunRecord,
    call: AgentToolCall,
  ): Promise<void> {
    this.checkLimits(record);
    if (record.toolCalls >= this.limits.maximumToolCalls) {
      throw new RunLimitError("Scout reached the research-tool limit.");
    }
    record.toolCalls += 1;
    const tool = this.tools.get(call.id);
    if (!tool) {
      await this.recordToolFailure(
        record,
        call,
        "Scout requested an unavailable research tool.",
      );
      return;
    }
    if (tool.description.requiresImages && !record.model?.supportsImages) {
      await this.recordToolFailure(
        record,
        call,
        "The selected model cannot inspect screenshots. Choose a compatible Gemini model to use this tool.",
      );
      return;
    }
    if (
      tool.description.requiresImages &&
      record.screenshotCount >= this.limits.maximumScreenshots
    ) {
      throw new RunLimitError("Scout reached the screenshot limit.");
    }
    this.transition(record, "tool-proposed");
    this.addEvent(record, {
      type: "tool-proposed",
      label: "Research step proposed",
      detail: tool.description.description,
      toolId: tool.description.id,
      status: "working",
    });
    await this.publish();
    let prepared: PreparedAgentToolCall;
    try {
      prepared = await this.runAbortable(record, (signal) =>
        tool.prepare(clone(call.input), this.toolContext(record, signal)),
      );
    } catch (error) {
      await this.recordToolFailure(record, call, errorMessage(error));
      return;
    }
    const fingerprint = safeInputFingerprint(call.id, prepared.input);
    const repeated = (record.repeatedCalls.get(fingerprint) ?? 0) + 1;
    record.repeatedCalls.set(fingerprint, repeated);
    if (repeated > this.limits.maximumRepeatedToolCalls) {
      throw new RunLimitError(
        `Scout repeated the same ${call.id} request too many times, so the run was stopped safely.`,
      );
    }
    const decision = this.policy.evaluate({
      mode: "ask",
      tool: tool.description,
      prepared,
    });
    if (decision === "deny") {
      await this.recordToolFailure(
        record,
        call,
        "Scout does not have permission to use this tool in Ask mode.",
      );
      return;
    }
    if (decision === "ask") {
      const approved = await this.requestApproval(record, tool, prepared);
      await this.waitIfPaused(record);
      this.checkLimits(record);
      if (!approved) {
        record.transcript.push({
          kind: "tool-result",
          toolId: call.id,
          input: clone(call.input),
          result: { ok: false, error: "The user denied this action." },
          failed: true,
          sourceId: null,
        });
        record.consecutiveFailures = 0;
        this.transition(record, "thinking");
        await this.publish();
        return;
      }
    }
    await this.waitIfPaused(record);
    this.transition(record, "executing-tool");
    await this.publish();
    try {
      const result = await this.runAbortable(record, (signal) =>
        tool.execute(prepared, this.toolContext(record, signal)),
      );
      const observationBytes =
        result.observationBytes ?? JSON.stringify(result.modelResult).length;
      record.observationBytes += Math.max(0, observationBytes);
      if (result.images?.length) {
        record.screenshotCount += result.images.length;
        record.pendingImages.push(...clone(result.images));
      }
      if (result.source) {
        const existingIndex = record.snapshot.sources.findIndex(
          (source) => source.id === result.source!.id,
        );
        const merged = mergeSource(
          existingIndex >= 0
            ? record.snapshot.sources[existingIndex]
            : undefined,
          result.source,
        );
        if (existingIndex >= 0) record.snapshot.sources[existingIndex] = merged;
        else record.snapshot.sources.push(merged);
        this.addEvent(record, {
          type: "source-recorded",
          label: "Source recorded",
          detail: merged.title,
          toolId: tool.description.id,
          status: "success",
          metadata: { hostname: merged.hostname, complete: merged.complete },
        });
      }
      record.transcript.push({
        kind: "tool-result",
        toolId: call.id,
        input: clone(call.input),
        result: clone(result.modelResult),
        failed: false,
        sourceId: result.source?.id ?? null,
      });
      record.consecutiveFailures = 0;
      this.addEvent(record, {
        type: result.eventType ?? "tool-executed",
        label: result.eventLabel,
        detail: result.eventDetail ?? null,
        toolId: tool.description.id,
        status: "success",
      });
      this.checkLimits(record);
      this.transition(record, "thinking");
      await this.publish();
    } catch (error) {
      if (record.cancelRequested || error instanceof CancelledRunError)
        throw error;
      if (error instanceof RunLimitError) throw error;
      await this.recordToolFailure(record, call, errorMessage(error));
    }
  }

  private async requestApproval(
    record: AgentRunRecord,
    tool: AgentTool,
    prepared: PreparedAgentToolCall,
  ): Promise<boolean> {
    const preparedActionHash = safeInputFingerprint(
      tool.description.id,
      prepared,
    );
    const requestedAt = this.now();
    const approval: AgentApprovalRequest = {
      id: this.id(),
      runId: record.snapshot.id,
      toolId: tool.description.id,
      preparedActionHash,
      requestedAt,
      expiresAt: Math.min(requestedAt + 5 * 60_000, record.deadline),
      action: prepared.action.slice(0, 240),
      target: prepared.target.slice(0, 240),
      expectedEffect: prepared.expectedEffect.slice(0, 500),
      risk: prepared.risk.slice(0, 500),
    };
    record.snapshot.pendingApproval = approval;
    this.transition(record, "awaiting-approval");
    this.addEvent(record, {
      type: "approval-requested",
      label: "Approval required",
      detail: approval.action,
      toolId: tool.description.id,
      status: "warning",
    });
    await this.publish();
    const approved = await new Promise<boolean>((resolve) => {
      record.approvalWaiter = resolve;
      record.approvalTimer = setTimeout(
        () => {
          if (record.approvalWaiter !== resolve) return;
          record.approvalWaiter = null;
          record.approvalTimer = null;
          record.snapshot.pendingApproval = null;
          resolve(false);
        },
        Math.max(1, approval.expiresAt - this.now()),
      );
    });
    if (record.cancelRequested) throw new CancelledRunError();
    return approved;
  }

  private async recordToolFailure(
    record: AgentRunRecord,
    call: AgentToolCall,
    message: string,
  ): Promise<void> {
    record.consecutiveFailures += 1;
    record.transcript.push({
      kind: "tool-result",
      toolId: call.id,
      input: clone(call.input),
      result: { ok: false, error: message.slice(0, 1_000) },
      failed: true,
      sourceId: null,
    });
    this.addEvent(record, {
      type: "tool-failed",
      label: "Research step unavailable",
      detail: message.slice(0, 500),
      toolId: call.id.slice(0, 128),
      status: "warning",
    });
    if (record.consecutiveFailures >= this.limits.maximumConsecutiveFailures) {
      throw new RunLimitError(
        "Scout encountered too many consecutive research failures and stopped safely.",
      );
    }
    this.transition(record, "thinking");
    await this.publish();
  }

  private async runAbortable<T>(
    record: AgentRunRecord,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    while (true) {
      this.checkCancellation(record);
      await this.waitIfPaused(record);
      const controller = new AbortController();
      record.activeAbort = controller;
      const remainingMs = record.deadline - this.now();
      if (remainingMs <= 0) {
        record.activeAbort = null;
        throw new RunLimitError("Scout reached the research time limit.");
      }
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
      let removeAbortListener: () => void = () => undefined;
      try {
        const interrupted = new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            reject(
              controller.signal.reason instanceof Error
                ? controller.signal.reason
                : new DOMException("Cancelled", "AbortError"),
            );
          };
          controller.signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () =>
            controller.signal.removeEventListener("abort", onAbort);
          deadlineTimer = setTimeout(() => {
            const error = new RunLimitError(
              "Scout reached the research time limit.",
            );
            controller.abort(error);
            reject(error);
          }, remainingMs);
        });
        return await Promise.race([operation(controller.signal), interrupted]);
      } catch (error) {
        if (record.cancelRequested) throw new CancelledRunError();
        if (record.pauseRequested) {
          await this.enterPaused(record);
          continue;
        }
        throw error;
      } finally {
        removeAbortListener();
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (record.activeAbort === controller) record.activeAbort = null;
      }
    }
  }

  private async waitIfPaused(record: AgentRunRecord): Promise<void> {
    this.checkCancellation(record);
    if (record.pauseRequested && record.snapshot.status !== "paused") {
      await this.enterPaused(record);
    }
    if (record.snapshot.status === "paused") {
      await new Promise<void>((resolve) => record.resumeWaiters.push(resolve));
      this.checkCancellation(record);
    }
    if (record.snapshot.status === "resuming") {
      this.transition(record, record.resumeStatus);
      await this.publish();
      await this.revalidateSources(record);
    }
  }

  private async revalidateSources(record: AgentRunRecord): Promise<void> {
    if (!this.sourceValidator || record.snapshot.sources.length === 0) return;
    const controller = new AbortController();
    record.activeAbort = controller;
    try {
      const stale = await this.sourceValidator.validate(
        clone(record.snapshot.sources),
        controller.signal,
      );
      if (stale.size === 0) return;
      record.snapshot.sources = record.snapshot.sources.filter(
        (source) => !stale.has(source.id),
      );
      record.transcript = record.transcript.filter(
        (entry) =>
          entry.kind === "assistant" ||
          !entry.sourceId ||
          !stale.has(entry.sourceId),
      );
      this.addEvent(record, {
        type: "tool-failed",
        label: "Changed sources will be checked again",
        detail: `${stale.size} browser ${stale.size === 1 ? "source changed" : "sources changed"} while research was paused.`,
        status: "warning",
      });
      await this.publish();
    } catch (error) {
      if (record.cancelRequested) throw new CancelledRunError();
      if (!record.pauseRequested) throw error;
      await this.enterPaused(record);
      await new Promise<void>((resolve) => record.resumeWaiters.push(resolve));
      this.checkCancellation(record);
      if (record.snapshot.status === "resuming") {
        this.transition(record, record.resumeStatus);
        await this.publish();
      }
      await this.revalidateSources(record);
    } finally {
      if (record.activeAbort === controller) record.activeAbort = null;
    }
  }

  private async enterPaused(record: AgentRunRecord): Promise<void> {
    if (record.snapshot.status !== "pausing") {
      this.transition(record, "pausing");
    }
    this.transition(record, "paused");
    this.addEvent(record, {
      type: "run-paused",
      label: "Research paused",
      detail: "No new research tools will start until you resume.",
      status: "warning",
    });
    await this.publish();
  }

  private checkLimits(record: AgentRunRecord): void {
    this.checkCancellation(record);
    if (this.now() > record.deadline) {
      throw new RunLimitError("Scout reached the research time limit.");
    }
    if (record.modelTurns >= this.limits.maximumModelTurns) {
      throw new RunLimitError("Scout reached the model-turn limit.");
    }
    if (record.observationBytes > this.limits.maximumObservationBytes) {
      throw new RunLimitError("Scout reached the page-content limit.");
    }
    if (record.screenshotCount > this.limits.maximumScreenshots) {
      throw new RunLimitError("Scout reached the screenshot limit.");
    }
  }

  private checkCancellation(record: AgentRunRecord): void {
    if (record.cancelRequested) throw new CancelledRunError();
  }

  private toolContext(
    record: AgentRunRecord,
    signal: AbortSignal,
  ): AgentToolContext {
    return {
      runId: record.snapshot.id,
      conversationId: record.snapshot.conversationId,
      signal,
      now: this.now,
    };
  }

  private transition(record: AgentRunRecord, next: AgentRunStatus): void {
    const current = record.snapshot.status;
    if (current === next) return;
    if (!TRANSITIONS[current].has(next)) {
      throw new Error(`Invalid Scout run transition: ${current} -> ${next}`);
    }
    record.snapshot.status = next;
    record.snapshot.statusLabel = statusLabel(next);
    record.snapshot.updatedAt = this.now();
    this.addEvent(record, {
      type: "status-changed",
      label: record.snapshot.statusLabel,
      detail: null,
      status:
        next === "failed"
          ? "error"
          : next === "paused" || next === "awaiting-approval"
            ? "warning"
            : TERMINAL.has(next)
              ? "success"
              : "working",
      metadata: { state: next },
    });
  }

  private addEvent(
    record: AgentRunRecord,
    event: Omit<
      AgentEvent,
      "id" | "runId" | "sequence" | "timestamp" | "metadata" | "toolId"
    > & {
      metadata?: AgentEvent["metadata"];
      toolId?: string | null;
    },
  ): void {
    record.snapshot.events.push({
      id: this.id(),
      runId: record.snapshot.id,
      sequence: ++record.eventSequence,
      timestamp: this.now(),
      metadata: {},
      toolId: null,
      ...event,
    });
    if (record.snapshot.events.length > this.limits.maximumStoredEvents) {
      record.snapshot.events.splice(
        0,
        record.snapshot.events.length - this.limits.maximumStoredEvents,
      );
    }
    record.snapshot.updatedAt = this.now();
  }

  private async finishCompleted(
    record: AgentRunRecord,
    finalText: string,
  ): Promise<void> {
    this.transition(record, "completed");
    record.snapshot.finalText = removeInvalidCitations(
      finalText,
      record.snapshot.sources.length,
    ).slice(0, 64_000);
    record.snapshot.completedAt = this.now();
    record.snapshot.pendingApproval = null;
    this.addEvent(record, {
      type: "run-completed",
      label: "Research complete",
      detail: `${record.snapshot.sources.length} ${record.snapshot.sources.length === 1 ? "source" : "sources"} inspected`,
      status: "success",
    });
    await this.archive(record);
  }

  private async finishFailed(
    record: AgentRunRecord,
    message: string,
  ): Promise<void> {
    if (!TERMINAL.has(record.snapshot.status)) {
      this.transition(record, "failed");
    }
    record.snapshot.error = message.slice(0, 1_000);
    record.snapshot.completedAt = this.now();
    record.snapshot.pendingApproval = null;
    this.addEvent(record, {
      type: "run-failed",
      label: "Research could not finish",
      detail: record.snapshot.error,
      status: "error",
    });
    await this.archive(record);
  }

  private async finishCancelled(record: AgentRunRecord): Promise<void> {
    if (TERMINAL.has(record.snapshot.status)) return;
    this.transition(record, "cancelled");
    record.snapshot.completedAt = this.now();
    record.snapshot.pendingApproval = null;
    record.snapshot.finalText = record.snapshot.sources.length
      ? `Research stopped after inspecting ${record.snapshot.sources.length} ${record.snapshot.sources.length === 1 ? "source" : "sources"}.`
      : "Research stopped before any sources were inspected.";
    this.addEvent(record, {
      type: "run-cancelled",
      label: "Research stopped",
      detail: record.snapshot.finalText,
      status: "warning",
    });
    await this.archive(record);
  }

  private async archive(record: AgentRunRecord): Promise<void> {
    record.activeAbort = null;
    record.approvalWaiter = null;
    if (record.approvalTimer) clearTimeout(record.approvalTimer);
    record.approvalTimer = null;
    this.storedRuns = [
      clone(record.snapshot),
      ...this.storedRuns.filter((run) => run.id !== record.snapshot.id),
    ].slice(0, this.limits.maximumStoredRuns);
    this.records.delete(record.snapshot.id);
    await this.publish();
  }

  private requireActive(runId: string): AgentRunRecord {
    this.assertAvailable();
    const record = this.records.get(runId);
    if (!record || TERMINAL.has(record.snapshot.status)) {
      throw new Error("This Scout research run is no longer active.");
    }
    return record;
  }

  private assertAvailable(): void {
    if (this.disposed)
      throw new Error("Scout research is no longer available.");
  }

  private async publish(): Promise<void> {
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(() => this.store.save(snapshot.runs))
      .catch((error) =>
        console.warn("Could not persist Scout research runs.", error),
      );
    await this.persistChain;
  }
}
