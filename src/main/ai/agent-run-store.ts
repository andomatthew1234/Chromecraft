import { promises as fs } from "node:fs";
import path from "node:path";

import type { AgentRunSnapshot } from "../../shared/agent";
import type { AgentRunStore } from "./agent-runtime";

const MAX_STORE_BYTES = 2 * 1024 * 1024;

function normalizedRun(run: AgentRunSnapshot): AgentRunSnapshot {
  return {
    ...structuredClone(run),
    events: run.events.slice(-160).map((event, index) => ({
      ...event,
      sequence: Number.isInteger(event.sequence) ? event.sequence : index + 1,
    })),
    sources: run.sources.map((source) => ({
      ...source,
      faviconDataUrl:
        (source.faviconDataUrl?.length ?? 0) <= 32_000
          ? source.faviconDataUrl
          : null,
    })),
    queuedMessages: Array.isArray(run.queuedMessages)
      ? run.queuedMessages.slice(0, 8)
      : [],
  };
}

function encodeRuns(runs: AgentRunSnapshot[]): string {
  return `${JSON.stringify({ version: 1, runs }, null, 2)}\n`;
}

function isRunSnapshot(value: unknown): value is AgentRunSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value as Partial<AgentRunSnapshot>;
  return (
    typeof run.id === "string" &&
    typeof run.conversationId === "string" &&
    typeof run.messageId === "string" &&
    typeof run.objective === "string" &&
    typeof run.status === "string" &&
    typeof run.createdAt === "number" &&
    typeof run.updatedAt === "number" &&
    Array.isArray(run.events) &&
    Array.isArray(run.sources)
  );
}

export class JsonAgentRunStore implements AgentRunStore {
  private writeCounter = 0;

  constructor(private readonly filePath: string) {}

  async load(): Promise<AgentRunSnapshot[]> {
    try {
      const stat = await fs.stat(this.filePath);
      if (stat.size > MAX_STORE_BYTES) {
        throw new Error("Scout research history is too large to load safely.");
      }
      const value = JSON.parse(await fs.readFile(this.filePath, "utf8")) as {
        runs?: unknown;
      };
      if (!Array.isArray(value?.runs)) return [];
      return value.runs.filter(isRunSnapshot).slice(0, 20).map(normalizedRun);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      console.warn("Could not load Scout research history.", error);
      return [];
    }
  }

  async save(runs: AgentRunSnapshot[]): Promise<void> {
    const bounded = runs.slice(0, 20).map(normalizedRun);
    let document = encodeRuns(bounded);
    while (
      Buffer.byteLength(document, "utf8") > MAX_STORE_BYTES &&
      bounded.length > 1
    ) {
      bounded.pop();
      document = encodeRuns(bounded);
    }
    if (Buffer.byteLength(document, "utf8") > MAX_STORE_BYTES && bounded[0]) {
      bounded[0] = {
        ...bounded[0],
        finalText: bounded[0].finalText?.slice(0, 16_000) ?? null,
        events: bounded[0].events.slice(-80),
        sources: bounded[0].sources.map((source) => ({
          ...source,
          faviconDataUrl: null,
        })),
      };
      document = encodeRuns(bounded);
    }
    if (Buffer.byteLength(document, "utf8") > MAX_STORE_BYTES) {
      throw new Error("Scout research history exceeded its storage limit.");
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${this.writeCounter++}.tmp`;
    await fs.writeFile(temporary, document, { encoding: "utf8", flag: "wx" });
    try {
      await fs.rename(temporary, this.filePath);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      await fs.rm(this.filePath, { force: true });
      await fs.rename(temporary, this.filePath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export class MemoryAgentRunStore implements AgentRunStore {
  private runs: AgentRunSnapshot[];

  constructor(initial: AgentRunSnapshot[] = []) {
    this.runs = structuredClone(initial);
  }

  async load(): Promise<AgentRunSnapshot[]> {
    return structuredClone(this.runs);
  }

  async save(runs: AgentRunSnapshot[]): Promise<void> {
    this.runs = structuredClone(runs);
  }
}
