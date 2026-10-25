# From co.work to Scout: a practical agentic AI architecture

## Executive summary

co.work proves several important interaction patterns that can make Scout genuinely agentic: it can repeatedly ask a model what to do next, execute a bounded tool, return the result to the model, pause for approval, accept queued follow-up work, cancel an in-flight run, and resume after a tool result. Those patterns are worth carrying forward.

The Python application itself should not be embedded in Chromecraft. Scout already has a stronger host architecture: an Electron main process owns browser capabilities, the React shell is separated from remote web content, IPC calls are restricted to the trusted shell, Gemini credentials use encrypted operating-system storage, and the existing tab organiser already demonstrates preview/apply/undo with stale-state detection. The best route is to implement a native TypeScript `AgentRuntime` in the main process and adapt co.work's concepts to those existing boundaries.

The recommended first release is a read-only browser research agent. It should be able to inspect user-selected tabs, read bounded page or Reader content, compare sources, and produce a cited answer while exposing every tool call in a run timeline. The next release can add approval-gated actions such as opening or grouping tabs. Form submission, messages, purchases, downloads, account changes, shell commands, and workspace writes should remain unavailable until each has a narrow capability, a preview, and an explicit policy.

## Scope and method

This report is based on direct source inspection of:

- `C:\Users\muman\OneDrive\Other\Documents\Coding\co.work.gem\app.py`
- `C:\Users\muman\OneDrive\Other\Documents\Coding\co.work.gem\coding_tools.py`
- `C:\Users\muman\OneDrive\Other\Documents\Coding\co.work.gem\static\app.js`
- Scout's current main-process, shared-type, preload, renderer, AI-provider, and tab-management modules in this repository.

The design uses the following vocabulary:

- **Module:** a unit with a public interface and hidden implementation.
- **Seam:** the boundary where one module talks to another.
- **Adapter:** one implementation of a seam, such as Gemini, Ollama, or a deterministic test model.
- **Deep module:** a small public interface hiding substantial orchestration and policy.

The objective is not to reproduce every co.work feature. It is to extract the high-leverage foundations, keep Scout's stronger safety properties, and identify a staged route to a dependable browser agent.

## 1. What co.work already built

### 1.1 A genuine multi-step tool loop

co.work's central capability is the loop in `app.py` around lines 945–1434. It appends a user turn, supplies tool declarations, sends the full conversation to Gemini, records the model turn, executes the first supported function call, appends a structured function response, and asks the model to continue. It exits only when the model returns a response without another supported tool call.

That is the core distinction between a chat assistant and an agent. Scout currently makes one structured generation call for one response. co.work can observe, act, observe the result, revise its approach, and continue.

Useful details include:

- Tool results are returned as structured function-response turns rather than flattened into prose (`app.py`, lines 223–231).
- The complete model turn is retained before executing a function, including provider-managed search parts (`app.py`, lines 1133–1138).
- Cancellation rolls back the partially appended history for that run (`app.py`, lines 1436–1439).
- Output is bounded before being returned to the model (`app.py`, lines 205–209).
- Model fallback and per-family timeouts are treated as runtime concerns rather than UI concerns (`app.py`, lines 103–129 and 520–603).

### 1.2 Permission modes and approval pauses

co.work defines Plan, Ask, Safe Implementation, and Autopilot modes. The important foundation is not the mode names; it is that an agent run can enter a waiting state, display a concrete proposal, receive a response tied to a request ID, and then continue the same tool loop.

The approval implementation covers:

- exact commands with an explanation and working directory;
- code changes with a unified diff and addition/deletion counts;
- screen control with a concrete task and explanation;
- cancellation while approval is pending;
- rejecting stale or duplicate approval responses (`app.py`, lines 1806–1818).

The Safe mode has two review routes. A deterministic allow-list recognizes a small set of read-only command shapes (`app.py`, lines 265–304). Everything else may be reviewed by a distinct model, and any reviewer failure falls back to human approval (`app.py`, lines 333–392). A separate set of server-side guards forces confirmation for obviously risky syntax (`app.py`, lines 235–262).

This layered, fail-closed shape is useful. The specific regexes are not a sufficient browser safety system and should not be copied as the authority.

### 1.3 Bounded workspace tools

`coding_tools.py` is the most reusable part of co.work conceptually. It supplies purpose-built list, read, search, prepare-edit, and apply-edit operations instead of making the model express every task as a shell command.

The module provides several strong invariants:

- paths are resolved against a user-selected workspace and cannot escape it (`coding_tools.py`, lines 25–40);
- symlinks and common dependency/generated directories are skipped (`coding_tools.py`, lines 67–80);
- file sizes, directory listings, reads, and search results are bounded (`coding_tools.py`, lines 9–17 and 83–180);
- replace operations require the old text to match exactly once (`coding_tools.py`, lines 184–215);
- the proposed change includes a bounded unified diff (`coding_tools.py`, lines 217–245);
- apply verifies a SHA-256 hash so a file changed after preview cannot be overwritten (`coding_tools.py`, lines 248–256);
- writes use a same-directory temporary file, flush, `fsync`, and atomic replacement (`coding_tools.py`, lines 258–277).

This prepare/preview/apply pattern closely matches Scout's existing tab organiser and is an excellent general pattern for browser and workspace mutations.

### 1.4 Queueing, steering, cancellation, and visible progress

co.work maintains a message queue with editable, removable, reorderable items (`app.py`, lines 1466–1591 and 1724–1773). The current run can be stopped while remaining work pauses, then the queue can resume (`app.py`, lines 1776–1803). The renderer receives explicit status events for thinking, inspecting code, reviewing safety, editing, running commands, and completion.

This makes the agent legible. Users can distinguish a model delay from a permission wait or a tool execution. Scout should adopt the event model, but persist it as typed run events rather than a loose collection of Socket.IO event names.

### 1.5 Optional provider-managed search and computer use

co.work can add Google Search to the model request and preserve provider-side invocation parts. It also has a separate Computer Use preview that captures screenshots and emits Windows input events only after the primary assistant requests screen control and the user approves it.

These features prove the orchestration path, but the desktop-wide implementation is too broad for Scout's first agentic release. A browser-native agent should prefer semantic browser tools—inspect tab, read page, activate tab, click a described element—over raw coordinates. Raw computer use should be a later, separately granted capability.

## 2. co.work limitations that should not be carried forward

co.work is a useful prototype, not a production host architecture.

| Prototype choice                                                               | Why Scout should not copy it                                                                                                                                                              |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One global `session_state` dictionary (`app.py`, lines 35–50)                  | It mixes all histories, approvals, processes, and queue state into a singleton. Scout needs run IDs, per-conversation ownership, explicit state transitions, and recoverable persistence. |
| Hard-coded Flask secret and wildcard Socket.IO origins (`app.py`, lines 31–33) | A browser agent must not expose local capabilities to arbitrary origins. Scout already has a trusted-shell IPC boundary.                                                                  |
| API keys submitted in message payloads (`app.py`, lines 1549–1577)             | Secrets should remain in the main process. Scout already uses Electron `safeStorage` through `GeminiCredentialStore`.                                                                     |
| Raw shell command as a general tool                                            | It gives the model a very broad capability and makes policy classification difficult. Purpose-built browser and workspace tools should be the default.                                    |
| Regex plus model review as the main safety authority                           | A model reviewer is useful as advice, not authorization. Capability policy must be deterministic and enforced at the tool boundary.                                                       |
| Desktop-wide coordinate control                                                | It is brittle, hard to preview, and may affect another application. Browser-scoped semantic actions are safer and more reliable.                                                          |
| Flask development server and `debug=True`                                      | Scout should remain an in-process Electron feature with no extra localhost control surface.                                                                                               |
| Volatile in-memory history                                                     | Runs, approvals, and audit records need deliberate retention, redaction, deletion, and crash recovery rules.                                                                              |

There are also implementation limitations worth correcting during the redesign: only the first custom function call in a model turn is executed; approval state supports only one pending request globally; the queue contains credentials in memory; and tool schemas, tool policy, execution, and UI event emission are coupled inside one large function.

## 3. What Scout already has

Scout is not starting from zero. Its current foundations are stronger than co.work in several areas.

### 3.1 A secure host boundary

Chromecraft separates the local React browser shell from separately managed remote website contents, as recorded in ADR 0003. Main-process IPC handlers verify that the sender is the trusted shell (`src/main/main.ts`, lines 366–369 and 386–390). This is the correct place to own agent capabilities.

No web page should be able to invoke an agent tool directly. The model proposes a call to the main-process runtime; the runtime applies policy; a narrow adapter uses `TabManager`; and only a sanitized result returns to the model.

### 3.2 Explicit, bounded context capture

Scout already captures URL, title, description, selected text, selected elements, screenshots, and full Reader articles through typed attachments (`src/shared/ai-assistant.ts`, lines 9–115). The main process validates attachment count and total payload size (`src/main/main.ts`, lines 1093–1148), while `TabManager` checks that the active document did not change during capture (`src/main/tab-manager.ts`, lines 932–988).

The assistant prompt already labels page and Reader text as untrusted and tells the model to ignore embedded instructions (`src/main/ai/controller.ts`, lines 202–257 and 836–849). This is an important defense against prompt injection and should become structured provenance on every observation, not just prompt prose.

### 3.3 Provider adapters and secure credentials

`StructuredModelProvider` gives Scout a common Gemini/Ollama seam, though it currently exposes only model listing and one structured completion (`src/main/ai/structured-provider.ts`, lines 1–14). Gemini credentials are encrypted using Electron `safeStorage`, and cloud use has an explicit consent state.

This provider seam should be deepened to support agent turns and tool-call continuations, rather than bypassed with a separate co.work service.

### 3.4 An existing safe mutation pattern

`OrganiseTabsTool` already follows a strong workflow:

1. capture a bounded live context;
2. ask the provider for a structured proposal;
3. validate every referenced tab and group;
4. show a preview;
5. refuse apply if the tab revision changed;
6. apply through `TabManager`;
7. expose undo.

See `src/main/ai/organise-tabs-tool.ts`, lines 282–437. This is a better basis for agent tools than co.work's general command runner. The agent should call the same validated domain operation, not synthesize private IPC calls or manipulate web contents directly.

### 3.5 The current gap

`AiToolsController.sendAssistantMessage` builds one prompt, performs one `chatStructured` request, validates one `{ reply }` result, and returns (`src/main/ai/controller.ts`, lines 806–875). Conversation storage belongs to the renderer's `localStorage`, and cancellation is tied to one active message.

In short, Scout has good context, provider, security, and mutation primitives, but it does not yet have a run engine that can:

- request and execute multiple tools;
- pause and resume on approval;
- expose a typed event timeline;
- accept queued or steering messages;
- enforce capability policy per run;
- persist partial run state safely;
- recover from a renderer reload or application restart.

## 4. Recommended architecture

### 4.1 One deep `AgentRuntime` module

Create a main-process `AgentRuntime` with a deliberately small interface:

```ts
interface AgentRuntime {
  start(input: AgentRunInput): Promise<AgentRunSnapshot>;
  respondToApproval(input: ApprovalDecision): Promise<void>;
  enqueue(runId: string, message: AgentQueuedMessage): Promise<void>;
  cancel(runId: string): Promise<void>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
}
```

This interface is the primary test surface. It hides provider turns, tool schemas, tool-result continuation, retries, context budgets, queue transitions, approval waits, cancellation, persistence, and audit events. Do not expose each internal step as a new renderer IPC method.

Suggested internal state machine:

```text
queued -> preparing -> model_turn -> tool_proposed
                               |          |
                               |          +-> awaiting_approval -> executing_tool
                               |                                  |
                               +----------------------------------+
                                                                  v
                                                            model_turn

model_turn -> completed | failed | cancelled
```

Persist transitions as append-only `AgentEvent` records and derive the UI snapshot from them. This gives crash diagnostics, a replayable test fixture, and a clear audit trail without storing hidden reasoning.

### 4.2 Internal seams

| Seam                    | Responsibility                                                        | First adapters                                                         |
| ----------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `AgentModelAdapter`     | Produce assistant text or typed tool calls; accept typed tool results | Gemini, Ollama, deterministic fake for tests                           |
| `AgentTool`             | Describe schema, risk, preview, execute, and result sanitation        | Read Page, List Tabs, Activate Tab, Open Tab, Organise Tabs            |
| `ApprovalPolicy`        | Deterministically decide allow, deny, or ask                          | Browser policy plus fake policy for tests                              |
| `BrowserAgentAdapter`   | Translate narrow tools into `TabManager` operations                   | Production `TabManager`; in-memory fake                                |
| `ContextAssembler`      | Budget, provenance-tag, and snapshot page/Reader/tab context          | Current attachment and Reader capture infrastructure                   |
| `AgentRunStore`         | Store runs, events, approvals, and queue metadata atomically          | JSON/SQLite production store; in-memory test store                     |
| `WorkspaceAgentAdapter` | Optional user-selected filesystem capabilities                        | TypeScript port of co.work's bounded coding tools; temp-directory fake |

Only introduce a seam where both production and test implementations are useful. This keeps interfaces from multiplying without leverage.

### 4.3 Tool contract

Each tool should carry policy metadata rather than leaving risk judgment to prompt wording:

```ts
interface AgentTool<Input, Preview, Output> {
  readonly id: string;
  readonly inputSchema: JsonSchema;
  readonly effect: "observe" | "local-change" | "external-side-effect";
  readonly capability: AgentCapability;
  preview(input: Input, context: ToolContext): Promise<Preview>;
  execute(prepared: PreparedToolCall<Input, Preview>): Promise<Output>;
  sanitize(output: Output): ModelToolResult;
}
```

Prepared calls should contain a state revision or observation token. Mutation tools must refuse execution when the target changed after preview. Reversible tools should return an undo token.

## 5. Features to bring into Scout

### 5.1 Read-only multi-tab research

This should be the first vertical slice. A user could ask, "Compare the return policies in these three tabs" or "Summarize the strongest arguments across my open articles." Scout would:

1. snapshot the user-selected tab IDs;
2. inspect titles, URLs, and bounded page or Reader content;
3. record each observation as a source-tagged tool result;
4. ask for another observation if evidence is incomplete;
5. produce an answer that identifies its sources and coverage limits.

Initial tools:

- `list_tabs`
- `inspect_tab_metadata`
- `read_page_excerpt`
- `read_reader_article`
- `search_open_tabs`

All can be observation-only and auto-allowed. Pages remain untrusted data. A page cannot grant tools, change goals, or override policy.

### 5.2 Approval-gated browser actions

The second slice adds narrow actions:

- activate or open a tab;
- close one or more tabs with an explicit preview and reopen support;
- group/reorganize tabs through the existing preview/apply/undo tool;
- navigate a tab to a visible URL;
- download a file to an explicitly chosen destination.

Actions should appear inline in the Scout timeline with target, effect, policy decision, result, and undo where available. Approval IDs must be bound to run ID, tool ID, prepared input hash, and expiry time so a response cannot approve a changed action.

### 5.3 Semantic page interaction

Later, add page-scoped tools based on a sanitized accessibility/DOM snapshot:

- find interactive elements;
- click a specific stable element reference;
- enter text in a specific field;
- scroll a specific page;
- wait for a document change and re-observe.

Do not start with arbitrary JavaScript execution. Element references should expire on navigation or document revision. Password, payment, authentication, message-send, upload, account-change, and form-submit actions should be separately classified and normally require an explicit approval immediately before the external side effect.

### 5.4 Queue and steering

Bring across co.work's editable queue, but model it per conversation/run:

- **Queue:** work to start after the current run.
- **Steer:** an instruction incorporated at the next safe model boundary.
- **Cancel:** terminate current model and tool activity without deleting queued work.
- **Pause:** stop dispatching new queued work.

The UI should show clear run states such as Reading tab, Waiting for approval, Applying tab plan, and Cancelled. Avoid exposing private chain-of-thought; show concise action rationales and concrete inputs/results.

### 5.5 Workspace/code agent

After the browser agent is stable, Scout could optionally attach a user-selected project folder. Port the invariants from `coding_tools.py` into TypeScript rather than invoking the Python module:

- real-path containment within the selected workspace;
- no symlink traversal;
- bounded list/read/search;
- exact single-match replacements;
- diff preview;
- optimistic concurrency hash;
- atomic write;
- optional Git checkpoint and post-change verification.

This capability should be off by default and granted to a specific folder. Shell execution, package installation, Git writes, and network commands should be separate capabilities, not implied by filesystem access.

## 6. Safety and trust model

### 6.1 Deterministic policy is authoritative

The runtime should decide policy from the tool ID, normalized input, granted scope, current browser state, and effect class. A secondary AI reviewer may explain or flag unusual proposals, but it must never expand authority or turn a denied action into an allowed one.

Recommended defaults:

| Action class                                                         | Default                                                                |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Read user-selected tab metadata/content                              | Allow for this run                                                     |
| Read unrelated tabs                                                  | Ask to broaden tab scope                                               |
| Activate/open a tab                                                  | Allow or lightweight approval, configurable                            |
| Close/group/move tabs                                                | Preview; approval for destructive close, undo for grouping             |
| Navigate to a new origin                                             | Show destination; ask when sensitive or initiated indirectly           |
| Type ordinary text without submitting                                | Ask first until trust UX is proven                                     |
| Submit forms, send messages, upload files, change accounts/settings  | Always ask immediately before the effect                               |
| Payment, financial transfer, password/secret entry, security changes | Deny initially; design dedicated flows later                           |
| Workspace write                                                      | Diff preview and approval unless a tightly scoped session grant exists |
| Shell command                                                        | Unavailable initially; dedicated capability later                      |

### 6.2 Capability grants must be narrow

A grant should specify:

- run and conversation;
- tool/capability;
- tab IDs or origin set;
- workspace root if applicable;
- read versus mutation access;
- expiry and maximum uses.

"Autopilot" should not mean unrestricted access. If the label is retained, it should mean that explicitly low-risk tools may proceed under a visible, revocable capability grant.

### 6.3 Treat observations as hostile

Every page-derived result should carry provenance such as tab ID, origin, document revision, capture time, completeness, and trust level. Model adapters should serialize observations inside explicit untrusted-data boundaries. Tool-call arguments must be validated independently; copying an instruction from a page does not make it authorized.

### 6.4 Bound resources

Enforce maximum model turns, tool calls, wall-clock duration, observation bytes, screenshots, queued tasks, and repeated failures. Detect identical repeated tool calls and stop with an explanation. Network/model fallback must never silently switch from local Ollama to cloud Gemini because that changes the privacy boundary.

## 7. Reuse map

| co.work foundation                        | Decision                                | Scout destination                                   |
| ----------------------------------------- | --------------------------------------- | --------------------------------------------------- |
| Repeated model/tool/result loop           | Rebuild natively                        | Main-process `AgentRuntime`                         |
| Function-response conversation continuity | Preserve                                | `AgentModelAdapter` protocol                        |
| Approval pause with request ID            | Strengthen                              | Typed `ApprovalRequest` bound to prepared call hash |
| Deterministic read-only allow-list        | Generalize                              | `ApprovalPolicy` capability matrix                  |
| Independent safety reviewer               | Optional advisory layer                 | Explanation/flagging only; never grants authority   |
| Editable work queue                       | Preserve per run/conversation           | `AgentRunStore` and Scout timeline UI               |
| Bounded code list/read/search             | Port to TypeScript                      | Optional `WorkspaceAgentAdapter`                    |
| Diff plus optimistic concurrency          | Preserve                                | All mutation tools where possible                   |
| Atomic file replacement                   | Preserve                                | Workspace write implementation                      |
| Model fallback chain                      | Preserve only within same privacy class | Provider adapter/runtime policy                     |
| Provider-side web search                  | Optional, explicit cloud feature        | Model adapter capability with consent               |
| Desktop coordinate control                | Defer                                   | Later isolated computer-use capability              |
| Flask/Socket.IO server                    | Reject                                  | Electron IPC/event delivery                         |
| Global singleton session                  | Reject                                  | Run-indexed state machine and store                 |
| API key in renderer payload               | Reject                                  | Existing encrypted main-process credential store    |
| Raw shell as primary action tool          | Reject for initial releases             | Narrow domain tools                                 |

## 8. Delivery roadmap

### Phase 0 — runtime protocol and tests

Build the shared run/event/tool types, state machine, fake model adapter, fake browser adapter, in-memory store, and policy tests. Acceptance criteria: deterministic replay of a multi-tool run; cancellation at every state; stale approvals rejected; hard limits enforced.

### Phase 1 — read-only research agent

Add selected-tab scope, tab listing, metadata, page excerpts, Reader content, source provenance, and the timeline UI. Acceptance criteria: a multi-tab comparison uses at least two tool turns, cites the correct tabs, reports partial coverage, and cannot mutate browser state.

### Phase 2 — safe browser mutations

Adapt tab activation/opening and the current tab organiser. Add preview cards, approvals, stale-state refusal, and undo. Acceptance criteria: model output cannot reference an unknown tab; changed state invalidates a proposal; denial resumes the run without applying it.

### Phase 3 — semantic page interaction

Add accessibility/DOM observation and stable element actions. Begin with navigation and non-submitting interactions. Acceptance criteria: element references expire on document change; untrusted page text cannot approve an action; sensitive side effects are blocked or explicitly approved.

### Phase 4 — durable queue and optional workspace tools

Persist run events and queued messages, support renderer/application recovery, then port the bounded filesystem tools behind folder-scoped grants. Acceptance criteria: no workspace escape through symlinks or path tricks; stale edits fail; writes are atomic; applicable project checks can be attached to the run.

### Phase 5 — advanced integrations

Evaluate provider web search, downloads, carefully scoped shell tools, and browser-only or desktop Computer Use. Each should be introduced as a new capability with its own threat model, tests, and consent UX—not as a flag that broadens every run.

## 9. Testing strategy

Test at the `AgentRuntime` interface, which should be the narrowest stable surface:

- scripted fake-model tests for text -> tool -> result -> tool -> final answer;
- policy matrix tests for every tool and sensitive argument variant;
- stale prepared-call and stale document-revision tests;
- cancellation tests during model generation, approval, execution, and queue transition;
- prompt-injection fixtures where page content requests tools or claims approval;
- repeat-call, turn-count, byte-budget, and timeout limit tests;
- renderer tests for timeline ordering, approval focus, denial, queue editing, and recovery;
- integration tests using fake `TabManager` state before packaged Electron smoke tests.

The current tab organiser tests are a useful model because they exercise structured-output validation, stale snapshots, apply, replacement, and undo. New agent tools should follow the same replace-don't-layer discipline: when the runtime supersedes the one-shot assistant path, its tests should replace redundant controller tests rather than preserving two independent orchestration systems indefinitely.

## 10. Recommended first implementation

Build **Scout Research Run** first:

> "Use these selected tabs to answer my question. Inspect more than one page when necessary, show which pages were read, and tell me when content was unavailable or incomplete."

Why this is the right slice:

- It demonstrates real multi-step agency rather than another one-shot prompt.
- It uses Scout's existing context and Reader foundations.
- It stays inside Chromecraft's browser boundary.
- It provides obvious user value before risky automation.
- It forces the event protocol, tool registry, provider continuation, provenance, limits, cancellation, and UI timeline to become real.
- It can be tested deterministically without granting mutation privileges.

After that works, connect the existing tab organiser as the first mutation tool. It already has the correct preview/apply/revision/undo properties, so it validates the approval architecture without introducing arbitrary page control.

## Conclusion

co.work's lasting value is its orchestration model, not its Flask implementation. It demonstrates that the assistant can become a controllable run: inspect, propose, wait, act, observe, continue, and accept more work. Chromecraft already supplies the harder product foundations—browser-native capabilities, trusted IPC, isolated web content, encrypted credentials, explicit context, and a proven reversible tool.

The most effective plan is therefore to deepen Scout around one small `AgentRuntime` interface, keep every capability in the main process, use typed and revision-bound tools, and deliver read-only multi-tab research before action-taking. That produces a useful agent quickly while leaving a clean path to tab actions, semantic page interaction, queued tasks, workspace coding, and eventually carefully scoped computer use.
