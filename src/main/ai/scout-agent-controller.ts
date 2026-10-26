import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  AgentRunCommand,
  AgentRunSnapshot,
  AgentRunStartRequest,
  ScoutAgentSnapshot,
  ScoutPermissionMode,
} from "../../shared/agent";
import { buildAssistantPrompt } from "./controller";
import type { BrowserResearchAdapter } from "./browser-research";
import {
  AgentRuntime,
  AskModeApprovalPolicy,
  type AgentImageInput,
  type AgentModelResolver,
} from "./agent-runtime";
import { JsonAgentRunStore } from "./agent-run-store";
import { ResearchToolSet } from "./research-tools";

export interface ScoutAgentControllerOptions {
  settingsFilePath: string;
  runStorePath: string;
  models: AgentModelResolver;
  browser: BrowserResearchAdapter;
  onChange?: (snapshot: ScoutAgentSnapshot) => void;
}

function availableMode(value: unknown): value is "chat" | "ask" {
  return value === "chat" || value === "ask";
}

function screenshotInputs(request: AgentRunStartRequest): AgentImageInput[] {
  return request.context
    .filter((attachment) => attachment.kind === "screenshot")
    .flatMap((attachment) => {
      const match = attachment.data.screenshotDataUrl?.match(
        /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=]+)$/iu,
      );
      if (!match || match[2].length > 2_000_000) return [];
      return [
        {
          mimeType: match[1].toLowerCase() as AgentImageInput["mimeType"],
          data: match[2],
        },
      ];
    })
    .slice(0, 3);
}

export class ScoutAgentController {
  private readonly settingsFilePath: string;
  private readonly browser: BrowserResearchAdapter;
  private readonly tools: ResearchToolSet;
  private readonly runtime: AgentRuntime;
  private readonly onChange?: (snapshot: ScoutAgentSnapshot) => void;
  private permissionMode: ScoutPermissionMode = "chat";
  private researchCloudConsentGranted = false;
  private unsubscribe: (() => void) | null = null;
  private writeCounter = 0;
  private disposed = false;

  constructor(options: ScoutAgentControllerOptions) {
    this.settingsFilePath = path.resolve(options.settingsFilePath);
    this.browser = options.browser;
    this.onChange = options.onChange;
    this.tools = new ResearchToolSet(options.browser);
    this.runtime = new AgentRuntime({
      models: options.models,
      tools: this.tools.tools,
      policy: new AskModeApprovalPolicy(),
      store: new JsonAgentRunStore(options.runStorePath),
      sourceValidator: this.tools,
    });
  }

  get snapshot(): ScoutAgentSnapshot {
    return {
      permissionMode: this.permissionMode,
      researchCloudConsentGranted: this.researchCloudConsentGranted,
      ...this.runtime.snapshot,
    };
  }

  async initialize(): Promise<void> {
    try {
      const stored = JSON.parse(
        await fs.readFile(this.settingsFilePath, "utf8"),
      ) as Record<string, unknown>;
      if (availableMode(stored.permissionMode)) {
        this.permissionMode = stored.permissionMode;
      }
      this.researchCloudConsentGranted =
        stored.researchCloudConsentGranted === true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("Could not load Scout agent settings.", error);
      }
    }
    await this.runtime.initialize();
    this.unsubscribe = this.runtime.subscribe(() => this.emit());
    this.emit();
  }

  async start(request: AgentRunStartRequest): Promise<AgentRunSnapshot> {
    this.assertAvailable();
    if (this.permissionMode !== "ask") {
      throw new Error("Select Research mode before starting browser research.");
    }
    if (
      !request.objective.trim() ||
      request.objective.length > 16_000 ||
      request.context.length > 20 ||
      request.history.length > 24
    ) {
      throw new TypeError(
        "This Scout research request is too large or incomplete.",
      );
    }
    if (request.provider === "gemini" && !this.researchCloudConsentGranted) {
      if (!request.cloudConsent) {
        throw new Error(
          "Confirm that open-tab titles and relevant webpage information may be sent to Google before starting Gemini research.",
        );
      }
      this.researchCloudConsentGranted = true;
      await this.persistSettings();
      this.emit();
    }
    const built = buildAssistantPrompt({
      conversationId: request.conversationId,
      messageId: request.messageId,
      prompt: request.objective,
      createdAt: request.createdAt,
      provider: request.provider,
      model: request.model,
      context:
        request.provider === "ollama"
          ? request.context.filter(
              (attachment) => attachment.kind !== "screenshot",
            )
          : request.context,
      history: request.history,
    });
    const initialContext =
      request.provider === "gemini"
        ? built.prompt.replace(
            "A screenshot is attached, but this Scout version cannot inspect image pixels yet.",
            "A user-selected browser-tab screenshot is attached for visual analysis.",
          )
        : built.prompt;
    return this.runtime.start({
      ...request,
      initialContext,
      initialImages: screenshotInputs(request),
    });
  }

  async command(command: AgentRunCommand): Promise<void> {
    this.assertAvailable();
    switch (command.type) {
      case "set-mode":
        await this.setMode(command.mode);
        return;
      case "clear-conversation":
        await this.runtime.clearConversation(command.conversationId);
        return;
      case "pause":
        await this.runtime.pause(command.runId);
        return;
      case "resume":
        await this.runtime.resume(command.runId);
        return;
      case "cancel":
        await this.runtime.cancel(command.runId);
        return;
      case "enqueue":
        await this.runtime.enqueue(command.runId, command.message);
        return;
      case "approval":
        await this.runtime.respondToApproval(command.decision);
        return;
      case "open-source": {
        try {
          await this.tools.openSource(command.runId, command.sourceId);
        } catch {
          const source = this.runtime.snapshot.runs
            .find((run) => run.id === command.runId)
            ?.sources.find((item) => item.id === command.sourceId);
          if (!source)
            throw new Error("This research source is no longer available.");
          await this.browser.openTab("", source.url);
        }
        return;
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.runtime.dispose();
    this.disposed = true;
  }

  private async setMode(mode: ScoutPermissionMode): Promise<void> {
    if (mode === "smart-approval" || mode === "automated") {
      throw new Error(
        `${mode === "smart-approval" ? "Smart approval" : "Automated"} is coming soon. Your current mode was not changed.`,
      );
    }
    if (!availableMode(mode))
      throw new TypeError("Choose a supported Scout mode.");
    this.permissionMode = mode;
    await this.persistSettings();
    this.emit();
  }

  private async persistSettings(): Promise<void> {
    await fs.mkdir(path.dirname(this.settingsFilePath), { recursive: true });
    const temporary = `${this.settingsFilePath}.${process.pid}.${this.writeCounter++}.tmp`;
    await fs.writeFile(
      temporary,
      `${JSON.stringify(
        {
          version: 1,
          permissionMode: this.permissionMode,
          researchCloudConsentGranted: this.researchCloudConsentGranted,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    try {
      await fs.rename(temporary, this.settingsFilePath);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      await fs.rm(this.settingsFilePath, { force: true });
      await fs.rename(temporary, this.settingsFilePath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private emit(): void {
    this.onChange?.(structuredClone(this.snapshot));
  }

  private assertAvailable(): void {
    if (this.disposed)
      throw new Error("Scout research is no longer available.");
  }
}
