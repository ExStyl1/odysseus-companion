/**
 * CodexEventAdapter — maps codex app-server (v2) server notifications to Nessy
 * `AgentEvent`s. Promotes the Phase 1 spike mapper into a typed
 * `BaseEventAdapter` subclass, reusing the inherited tool_start/tool_result +
 * output-accumulation helpers.
 *
 * Method + item field names are the real ones from
 * `@nessy-agent/codex-protocol` `generated/v2` (rust-v0.148.0), recorded in
 * 01-spike.md — not guessed.
 *
 * P3.294 — reasoning DOES reach this adapter, and until this row both branches
 * dropped it. The paragraph that stood here said the opposite ("reasoning never
 * reaches this adapter … the app-server only forwards final assistant text +
 * tool calls"), and it was refuted end to end: shipped
 * `darwin-arm64/codex-app-server` -> the REAL `codex-responses-adapter` -> a
 * stub upstream emitting `reasoning_content` (W2-c 2026-09-03, re-run by W2-s).
 * What actually arrives, verbatim off the wire:
 *
 * ```
 * item/started   {"item":{"type":"reasoning","id":"reasoning_resp_…","summary":[],"content":[]}}
 * item/completed {"item":{"type":"reasoning","id":"reasoning_resp_…","summary":[],
 *                 "content":["weighing the options and deciding."]}}
 * ```
 *
 * So the text is on the COMPLETED item and the started item is empty — which is
 * why only `item/completed` carries a reasoning branch below. None of the three
 * `item/reasoning/*` delta families is emitted by this binary (measured on the
 * same run; they stay classified in `codex-notification-families.ts` with that
 * reason). Rendered through the SAME surface Pi and claude use — `text_complete`
 * with `isIntermediate` + `isThinking` — so a switch shows the same row.
 *
 * P3.295 — the plan reaches this adapter too, on `turn/plan/updated`, and the
 * `update_plan` tool call itself produces NO thread item at all (measured on the
 * same rig: a real `update_plan` call yielded exactly one `turn/plan/updated`
 * and no `item/started`/`item/completed` for the call). So the notification is
 * the only channel, and the row it produces here is synthesized rather than
 * mirrored — see {@link CodexEventAdapter.planUpdateEvents}.
 */
import type { AgentEvent, AgentTerminalReason } from '@nessy-agent/core/types';
import type {
  OrchestrationAgentStatus,
  OrchestrationProgress,
  OrchestrationProgressAgent,
} from '@nessy-agent/core';
import { BaseEventAdapter } from '../base-event-adapter.ts';
import { CodexAutoReviewBreaker } from './auto-review-breaker.ts';
import { CodexAutoCompactionThrashGuard } from './auto-compaction-thrash-guard.ts';
import {
  CODEX_STRICT_REVIEW_REQUIRED_METHOD,
  describeGuardianReviewAction,
  describeStrictReviewRequired,
} from '@nessy-agent/codex-agent-server';
import { CODEX_PLAN_TOOL_NAME } from '../../../utils/toolNames.ts';
import { reportHookRun, type HookRunObservation, type HookRunOutcome } from '../../hook-run-report.ts';
import { scrubToolResultPayload } from '../../tool-result-secret-scan.ts';

/**
 * D1.350 — codex's OWN best-effort parse of the command it is about to run.
 *
 * Generated/v2 `CommandAction`, verbatim: `{type:'read', command, name, path} |
 * {type:'listFiles', command, path} | {type:'search', command, query, path} |
 * {type:'unknown', command}`, and `ThreadItem`'s `commandExecution` variant
 * declares it as `commandActions: Array<CommandAction>` — *"A best-effort
 * parsing of the command to understand the action(s) it will perform. This
 * returns a list of CommandAction objects because a single shell command may be
 * composed of many commands piped together."*
 *
 * ## Why the host wants it, which is not obvious from the type
 *
 * The `command` this adapter publishes is codex's LOGIN-SHELL re-spelling —
 * `/bin/zsh -lc 'cat target.txt'` — which no host command reader can parse
 * (measured by WI-aw, D1.342). The action carries the UNWRAPPED command and,
 * for a `read`, an ABSOLUTE path codex resolved itself. So this is the only
 * channel on which a host consumer can learn what a codex shell command did,
 * and it was being dropped on the floor.
 *
 * ## ONE parse, two readers — which is the whole point of the row
 *
 * {@link CodexEventAdapter} puts the result on the `tool_start` frame's input
 * and `CodexAgent.creditCodexFileRead` calls this same function on the item, so
 * a divergence between the transcript's account of a command and the
 * read-before-write ledger's is not expressible. It is a shared FUNCTION rather
 * than the ledger consuming the emitted frame, and the reason is measured
 * rather than stylistic: `AgentEvent`'s `input` is typed
 * `Record<string, unknown>` (`packages/core/src/types/message.ts`), so reading
 * the value back out of a frame means narrowing it a SECOND time — two parsers
 * with a cast between them, which is the shape the row exists to remove. The
 * credit also runs above `eventAdapter.adapt()` in `handleNotification`, beside
 * the checkpoint producer and for the same reason, so consuming the frame would
 * have reordered the notification handler as well.
 *
 * The narrow view is local rather than imported from `@nessy-agent/codex-protocol`,
 * which is the house style of every sibling declaration in this block: the
 * generated union is the contract, and what arrives is untyped JSON that
 * {@link readCodexCommandActions} validates.
 */
export type CodexCommandAction =
  | { type: 'read'; command: string; name?: string | null; path?: string | null }
  | { type: 'listFiles'; command: string; path?: string | null }
  | { type: 'search'; command: string; query?: string | null; path?: string | null }
  | { type: 'unknown'; command: string };

/** The four `CommandAction` discriminants the generated union declares. */
const CODEX_COMMAND_ACTION_TYPES: ReadonlySet<string> =
  new Set(['read', 'listFiles', 'search', 'unknown']);

/**
 * Read `commandExecution.commandActions` off a raw ThreadItem, validated.
 *
 * Returns `[]` for anything that is not an array of well-formed actions, and
 * DROPS an individual entry whose `type` is not one of the four the contract
 * declares or whose `command` is not a non-empty string. A future fifth member
 * is therefore invisible here rather than admitted untyped — the same
 * protocol-drift posture {@link mapCollabAgentStatus} takes, in the direction
 * that suits a reader which must not act on a shape it cannot name.
 */
export function readCodexCommandActions(item: unknown): readonly CodexCommandAction[] {
  if (!item || typeof item !== 'object') return [];
  const raw = (item as { commandActions?: unknown }).commandActions;
  if (!Array.isArray(raw)) return [];
  const actions: CodexCommandAction[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const type = record.type;
    const command = record.command;
    if (typeof type !== 'string' || !CODEX_COMMAND_ACTION_TYPES.has(type)) continue;
    if (typeof command !== 'string' || !command) continue;
    actions.push({ ...record, type, command } as CodexCommandAction);
  }
  return actions;
}

/** Narrow views of the generated v2 ThreadItem variants we consume. */
interface CommandExecutionItem {
  type: 'commandExecution';
  id: string;
  command: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  /** D1.350 · see {@link CodexCommandAction}; read through {@link readCodexCommandActions}. */
  commandActions?: readonly CodexCommandAction[];
}
interface AgentMessageItem {
  type: 'agentMessage';
  id: string;
  text: string;
}
interface FileChangeItem {
  type: 'fileChange';
  id: string;
  changes: unknown;
  status?: string;
}
/**
 * `mcpToolCall` — generated/v2 `ThreadItem`: `{ type, id, server, tool, status,
 * arguments, appContext, mcpAppResourceUri?, pluginId, result, error, durationMs }`.
 * `status` is `McpToolCallStatus` ("inProgress" | "completed" | "failed"),
 * `result` is `McpToolCallResult` (`{ content, structuredContent, _meta }`) and
 * `error` is `McpToolCallError` (`{ message }`). Only the fields a transcript row
 * needs are narrowed here.
 */
interface McpToolCallItem {
  type: 'mcpToolCall';
  id: string;
  server: string;
  tool: string;
  status?: string;
  arguments?: unknown;
  result?: { content?: unknown; structuredContent?: unknown } | null;
  error?: { message?: string } | null;
}
/**
 * `collabAgentToolCall` — generated/v2 `ThreadItem`: `{ type, id, tool, status,
 * senderThreadId, receiverThreadIds, prompt, model, reasoningEffort, agents }`.
 * `tool` is `CollabAgentTool` ("spawnAgent" | "sendInput" | "resumeAgent" |
 * "wait" | "closeAgent"), `status` is "inProgress" | "completed" | "failed",
 * and `agents` maps a thread id to `{ status, message }`.
 */
interface CollabToolCallItem {
  type: 'collabAgentToolCall';
  id: string;
  tool: string;
  status?: string;
  receiverThreadIds?: string[];
  prompt?: string | null;
  model?: string | null;
  // `agentsStates` is the pinned generated spelling (`CollabAgentState` per
  // thread); `agents` is the shape this adapter and its tests were built
  // against. The binding lags the binary both ways, so both are read.
  agentsStates?: Record<string, { status?: string; message?: string | null } | undefined>;
  agents?: Record<string, { status?: string; message?: string | null } | undefined>;
}
/**
 * `imageView` — generated/v2 `ThreadItem`: `{ "type": "imageView", id, path }`.
 * `path` is a `LegacyAppPathString`, whose own doc comment says deserialization
 * "accept[s] any UTF-8 string without interpreting or validating it" and that
 * "[r]elative path text remains valid" — so it is carried VERBATIM rather than
 * resolved here: this adapter has no working directory to resolve against, and
 * inventing one would point the preview at the wrong file instead of showing
 * the load error the renderer already has for a path it cannot read.
 */
interface ImageViewItem {
  type: 'imageView';
  id: string;
  path?: string;
}
/**
 * `imageGeneration` — generated/v2 `ThreadItem`: `{ "type": "imageGeneration" }
 * & ImageGenerationItem`, i.e. `{ id, status, revisedPrompt, result,
 * transparentBackground?, failure, savedPath? }` (generated/ImageGenerationItem.ts).
 * `savedPath` is an `AbsolutePathBuf` and `failure` an `ImageGenerationFailure`
 * — today a single member, `{ "type": "usageLimitExceeded", limitId, resetsAt }`.
 * `result` is deliberately NOT narrowed: the contract types it `string` with no
 * doc comment, so what it holds is unknown and guessing at it is how a payload
 * gets misrendered.
 */
interface ImageGenerationItem {
  type: 'imageGeneration';
  id: string;
  status?: string;
  revisedPrompt?: string | null;
  failure?: { type?: string; limitId?: string; resetsAt?: number | null } | null;
  savedPath?: string;
}
/**
 * `reasoning` — generated/v2 `ThreadItem`: `{ type, id, content: string[],
 * summary: string[] }`, both arrays defaulting to `[]` in the vendored schema
 * (`ReasoningThreadItem`). `content` is the model's own reasoning; `summary` is
 * the provider's summarized form, which is what a first-party model returns when
 * the raw reasoning is withheld. Both are read, `content` first — see
 * {@link CodexEventAdapter.reasoningItemEvents}.
 */
interface ReasoningItem {
  type: 'reasoning';
  id: string;
  content?: string[];
  summary?: string[];
}
/**
 * `plan` — generated/v2 `ThreadItem`: `{ type, id, text }`, and the schema calls
 * it *"EXPERIMENTAL - proposed plan item content. The completed plan item is
 * authoritative and may not match the concatenation of `PlanDelta` text."* That
 * sentence is the whole handling rule: the deltas stream, the completed item
 * replaces them — exactly how `agentMessage` is already treated here.
 */
interface PlanItem {
  type: 'plan';
  id: string;
  text?: string;
}
type ImageItem = ImageViewItem | ImageGenerationItem;
type ThreadItemLike =
  | CommandExecutionItem
  | AgentMessageItem
  | FileChangeItem
  | CollabToolCallItem
  | McpToolCallItem
  | ImageItem
  | ReasoningItem
  | PlanItem
  | { type: string; id: string };

interface ItemNotification {
  item?: ThreadItemLike;
}

function isCommandExec(item: ThreadItemLike | undefined): item is CommandExecutionItem {
  return !!item && item.type === 'commandExecution';
}
function isAgentMessage(item: ThreadItemLike | undefined): item is AgentMessageItem {
  return !!item && item.type === 'agentMessage';
}
function isFileChange(item: ThreadItemLike | undefined): item is FileChangeItem {
  return !!item && item.type === 'fileChange';
}
function isMcpToolCall(item: ThreadItemLike | undefined): item is McpToolCallItem {
  return !!item && item.type === 'mcpToolCall';
}
function isCollabToolCall(item: ThreadItemLike | undefined): item is CollabToolCallItem {
  return !!item && item.type === 'collabAgentToolCall';
}
function isImageItem(item: ThreadItemLike | undefined): item is ImageItem {
  return !!item && (item.type === 'imageView' || item.type === 'imageGeneration');
}
/**
 * P3.308 · the ONE signature that says codex accepted a permission profile it
 * cannot build a sandbox from.
 *
 * `error building bubblewrap command` is the whole recogniser, and it is a
 * mechanism name rather than a message: bubblewrap is how codex builds its
 * Linux sandbox, so a failure to CONSTRUCT the command means no sandboxed
 * process can start at all. Matched case-insensitively and nowhere near the
 * glob text, which varies with whatever pattern provoked it.
 *
 * Driven on the real Linux binary (`scripts/platform-rig/run-linux-codex-probe.mjs`,
 * `rust-v0.148.0` aarch64-musl, 2026-09-03) rather than read from a source
 * string — the four arms and their two controls are in
 * {@link CodexEventAdapter.sandboxConstructionFailureEvents}.
 */
const CODEX_SANDBOX_CONSTRUCTION_SIGNATURE = 'error building bubblewrap command';

/** The offending glob, when codex named one, for the operator line. */
function codexUnreadableGlob(output: string): string | null {
  const match = /unreadable glob `([^`]{1,200})`/.exec(output);
  return match?.[1] ?? null;
}

function isReasoningItem(item: ThreadItemLike | undefined): item is ReasoningItem {
  return !!item && item.type === 'reasoning';
}
function isPlanItem(item: ThreadItemLike | undefined): item is PlanItem {
  return !!item && item.type === 'plan';
}

/**
 * P3.295 · one codex plan step → the host's todo shape.
 *
 * The two spellings are NOT the same and reading only one of them is how this
 * would have shipped empty: the `update_plan` TOOL SCHEMA (captured off the wire
 * from the tools codex offers) enumerates `pending | in_progress | completed`,
 * while `TurnPlanUpdatedNotification` re-spells the middle one **camelCase** —
 * `TurnPlanStepStatus = "pending" | "inProgress" | "completed"`, and the live
 * notification carried `"status":"inProgress"`. The host's card
 * (`TodoListCard.normalizeTodo`) accepts only the snake_case set and DROPS a
 * step whose status it cannot read, so the un-mapped spelling would have painted
 * a plan missing exactly its in-progress step.
 *
 * Total by construction, and the default direction is the conservative one: an
 * unrecognised future member degrades to `pending` — "a step whose status we
 * cannot read has not been observed to finish" — rather than being dropped,
 * which would silently shorten the plan. Same rule and same reason as
 * {@link mapCollabAgentStatus}.
 */
function mapCodexPlanStatus(status: unknown): 'pending' | 'in_progress' | 'completed' {
  switch (status) {
    case 'completed': return 'completed';
    case 'inProgress':
    case 'in_progress': return 'in_progress';
    default: return 'pending';
  }
}

/**
 * The transcript row's tool name for a collab call — the WIRE spelling the
 * model used, not the camelCase item enum. The mapping is pinned by the
 * bundled binary's own rollout records (`spawn_agent`, `wait_agent` observed
 * live on the CDX-ROLES gate); an unmapped future member falls back to the
 * item's own spelling rather than dropping the row.
 */
export const COLLAB_TOOL_WIRE_NAMES: Record<string, string> = {
  spawnAgent: 'spawn_agent',
  sendInput: 'send_input',
  resumeAgent: 'resume_agent',
  wait: 'wait_agent',
  closeAgent: 'close_agent',
};

/** One line per target agent: `<threadId>: <status> — <message>`. */
function collabAgentsSummary(item: CollabToolCallItem): string {
  return Object.entries(item.agentsStates ?? item.agents ?? {})
    .map(([threadId, state]) => `${threadId}: ${state?.status ?? 'unknown'}${state?.message ? ` — ${state.message}` : ''}`)
    .join('\n');
}

/**
 * P3.4 · one spawn call's live progress, mapped into the shape the subagent
 * card consumes. Keyed by the collab tool-call item id (`toolUseId`, the
 * transcript row the card attaches to) and carrying the PARENT turn the spawn
 * ran on (`turnId`, what `task_progress` is keyed by). `agents` is insertion-
 * ordered so the card lists agents in spawn order.
 */
interface CodexOrchestrationRun {
  toolUseId: string;
  turnId: string | null;
  agents: Map<string, OrchestrationProgressAgent>;
}

/**
 * `CollabAgentStatus` (or a bare thread lifecycle word) → the
 * `OrchestrationProgress` status vocabulary. Total by construction: an
 * unrecognised future member degrades to `running` — a spawned agent that is
 * emitting anything is live — rather than throwing, per the protocol-drift rule.
 */
function mapCollabAgentStatus(status: string | undefined): OrchestrationAgentStatus {
  switch (status) {
    case 'pendingInit': return 'queued';
    case 'running': return 'running';
    case 'completed':
    case 'shutdown': return 'done';
    case 'errored':
    case 'notFound': return 'error';
    case 'interrupted': return 'aborted';
    default: return 'running';
  }
}

/**
 * Is this a ThreadItem whose start is a tool invocation, so a child's
 * `item/started` should bump its `toolCalls`? `agentMessage`, `reasoning`,
 * `plan` and the like are not tool calls and must not be counted.
 */
function isToolItem(item: ThreadItemLike | undefined): boolean {
  return !!item && (
    item.type === 'commandExecution'
    || item.type === 'fileChange'
    || item.type === 'mcpToolCall'
    || item.type === 'dynamicToolCall'
    || item.type === 'webSearch'
  );
}

/**
 * The transcript row's tool name, built VERBATIM from the item's own `server` +
 * `tool` — deliberately NOT through the base `buildMcpToolName()` helper.
 *
 * The tool name in the transcript is the one place a user can read a wire name
 * (docs/testing/cdp-live-checklist.md, `MCP-W2`), and what the UI keys on (a rule
 * and a hook read it shifted, F1.272/F1.274) — so it is codex's RAW `(server, tool)` pair,
 * `mcp__sources__<wire>__<tool>`, against `mcp__<wire>__<tool>` on Pi and Claude.
 * It is NOT the name the codex model typed (F1.217 corrected this block, which
 * said it was): codex hands its model `<wire>__<tool>` sanitized, inside an
 * `mcp__sources` namespace (`capabilities/mcp-wire-name.ts`,
 * `codexModelToolName`, measured on the shipped binary by F1.155), and routes
 * the call back to the server under the tool's own name — which is why the item
 * carries `server: 'sources'` and the UNSANITIZED `tool: '<wire>__<tool>'`,
 * hyphens and all. The bundled `session` server is the same shape: its rows
 * read `mcp__session__<tool>`, byte-identical to Pi's and Claude's host rows,
 * while its model is handed the bare `<tool>` inside `mcp__session`.
 *
 * `buildMcpToolName()` drops the `sources` segment for pool tools — right for Pi,
 * where the pool server IS the tool's server, and wrong here: it would print a
 * pair this runtime's item never carried. `resolveToolDisplayMeta()` (server-core)
 * shifts one segment past the bridge, so the row carries the real server's icon.
 */
function mcpRowToolName(item: McpToolCallItem): string {
  return `mcp__${item.server}__${item.tool}`;
}

/** Text from an `McpToolCallResult.content` array (MCP content blocks); JSON when none is text. */
function extractMcpResultText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const texts = content
    .filter((c): c is { text: string } =>
      !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text'
      && typeof (c as { text?: unknown }).text === 'string')
    .map((c) => c.text);
  if (texts.length > 0) return texts.join('\n');
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** A plain non-empty object, or undefined — mirrors the Pi adapter's structuredContent guard. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length > 0 ? record : undefined;
}

/**
 * The renderer's OWN inline-image shape, reused rather than reinvented: a fenced
 * ```image-preview block whose JSON carries an on-disk `src`
 * (`packages/ui/src/components/markdown/MarkdownImageBlock.tsx`, documented in
 * `apps/electron/resources/docs/image-preview.md`). It is the same block the Pi
 * side already emits for a browser screenshot (`agent/pi-agent.ts`, the
 * `browser_tool` arm), and the same one `prompts/system.ts` teaches every model
 * to write — so a codex image lands on a path the transcript has rendered since
 * before this adapter existed, with no new renderer type and no protocol change.
 *
 * `title` is omitted on purpose: the block's own default header ("Image
 * Preview") is already right, and a title invented here would be an untranslated
 * user-facing string for no gain (see the no-i18n rule below).
 */
function imagePreviewBlock(src: string): string {
  return ['```image-preview', JSON.stringify({ src }, null, 2), '```'].join('\n');
}

/**
 * One line describing a failed generation. Assembled from whatever the failure
 * object actually carries, so a future `ImageGenerationFailure` member reads
 * sensibly instead of being mistaken for the only one that exists today.
 *
 * `resetsAt` is printed VERBATIM. The generated contract gives it no unit and no
 * doc comment — unlike `ItemStartedNotification.startedAtMs`, which names its
 * unit — so formatting it as a date would be a guess, and a wrong "resets at"
 * time is worse than a raw number.
 */
function imageGenerationFailureMessage(failure: ImageGenerationItem['failure']): string {
  const parts: string[] = [];
  if (failure?.type) parts.push(failure.type);
  if (failure?.limitId) parts.push(`limit ${failure.limitId}`);
  if (typeof failure?.resetsAt === 'number') parts.push(`resetsAt ${failure.resetsAt}`);
  return parts.length > 0 ? `Image generation failed: ${parts.join(', ')}` : 'Image generation failed';
}

/**
 * The events one image item produces. `phase` matters for exactly one thing: an
 * `imageGeneration` still running has neither a `savedPath` nor a `failure`, and
 * that is normal at `item/started` and a reportable dead end at
 * `item/completed`.
 *
 * EVERY non-image outcome rides `info` + `level: 'warning'`, and the level is not
 * a judgement about severity — it is the only durable one. `SessionManager`'s
 * `case 'info'` persists an info event ONLY under `event.level === 'warning'`
 * (plus the `startsWith('Compacted')` special case); `level: 'error'` is sent to
 * the renderer and never appended, so it disappears on reload — which is the
 * very silent loss this mapping exists to end. `claude-agent.ts` states the same
 * finding at its own emit site: "`info` + `level: 'warning'` is the one channel
 * from here that reaches a person … (so it survives a reload)".
 *
 * `type: 'error'` is disqualified for a different reason: the renderer's
 * `handleError` sets `isProcessing: false`, clears the status chip and marks
 * every still-running tool failed — it ends the visible turn, which a failed
 * image inside an otherwise healthy turn must not do. The severity therefore
 * lives in the WORDS ("failed" vs "completed without …"), exactly as it does for
 * the compaction pair above.
 *
 * Like the rest of this adapter, NOTHING here is translated — see the same rule
 * spelled out at the head of `backend/claude/event-adapter.ts`: the internal
 * `status`/`info` shapes are frozen contracts with no type field and the session
 * layer matches them by keyword, so running adapter strings through i18n breaks
 * the renderer silently.
 */
function imageItemEvents(item: ImageItem, phase: 'started' | 'completed', turnId?: string): AgentEvent[] {
  // P3.9 · `turnId` here is a PER-MESSAGE identity minted by
  // {@link CodexEventAdapter.messageIdentity}, not the codex turn id. This
  // comment used to say the opposite ("they carry the codex TURN id"), and that
  // was the whole bug: every non-stream completion in a turn travelled under one
  // id, so the renderer — which looks an assistant bubble up by that id, and
  // falls back to «the last streaming assistant message» when it has none —
  // could not tell an image apart from the answer it arrived beside. Measured on
  // the pre-fix tree: an image completing while the answer streamed REPLACED the
  // streamed text (permanently, when the turn ended without the message's own
  // `item/completed`), and with a turn id in play the second completion replaced
  // the first outright. Persistence was never affected — SessionManager appends
  // every completion — so a reload recovered what the live transcript had lost.
  if (item.type === 'imageView') {
    const path = typeof item.path === 'string' ? item.path.trim() : '';
    if (path) return [{ type: 'text_complete', text: imagePreviewBlock(path), turnId }];
    // A blank/whitespace path is a dead end just like a path-less generation
    // below, and it gets the same durable notice rather than a silent `[]` —
    // dropping it is the failure mode this whole mapping exists to end. But only
    // once the item is DONE: `renderImageItem` closes an item on the first
    // notification that produces any event, so warning at `started` retired the
    // item and threw away the `completed` notification that carried the real
    // path — the image then never rendered at all. Same phase gate the
    // generation arm below already had, for the same reason.
    if (phase === 'started') return [];
    return [{ type: 'info', message: 'Image view arrived without a path', level: 'warning' }];
  }
  const savedPath = typeof item.savedPath === 'string' ? item.savedPath.trim() : '';
  if (savedPath) {
    // The revised prompt is the image's own caption — the one piece of the item
    // a reader needs to tell two generations apart.
    const prompt = typeof item.revisedPrompt === 'string' ? item.revisedPrompt.trim() : '';
    const block = imagePreviewBlock(savedPath);
    return [{ type: 'text_complete', text: prompt ? `${prompt}\n\n${block}` : block, turnId }];
  }
  // P3.14 · every remaining arm is a TERMINAL verdict on an item that has no
  // image, so none of them may fire before the item is done. The failure arm
  // below used to sit outside this gate: a `started` notification already
  // carrying `failure` (or `status: 'failed'`) emitted the warning, and
  // `renderImageItem` retires an item on the first notification that produces
  // any event — so the `completed` notification carrying the real `savedPath`
  // was dropped and a recovered generation rendered nothing. Same shape, and
  // the same fix, as the blank-path arm above.
  if (phase === 'started') return [];
  // As on `mcpToolCall`, a populated `failure` and a `failed` status are
  // independent signals and either one is a failure.
  if (item.failure || item.status === 'failed') {
    return [{ type: 'info', message: imageGenerationFailureMessage(item.failure), level: 'warning' }];
  }
  return [{ type: 'info', message: 'Image generation completed without a saved image path', level: 'warning' }];
}

/**
 * Token-usage payload (`thread/tokenUsage/updated`) — consumed by the agent,
 * not emitted here.
 *
 * The wire is **camelCase**. This type used to say `input_tokens`, and the
 * reader believed it, so every codex turn recorded zero tokens: the key was
 * never present. The belief was circular — the only evidence for snake_case was
 * this hand-written type, cited by a comment at the reader.
 *
 * Settled against the generated contract
 * (`codex-protocol/generated/v2/TokenUsageBreakdown.ts`: `totalTokens`,
 * `inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens`,
 * `reasoningOutputTokens`) AND against the shipped `codex-app-server` binary,
 * because a generated file can be stale where the binary cannot. Both casings
 * exist in that binary, which is why counting occurrences would have decided it
 * wrongly — they sit in different string tables:
 *
 * - camelCase, beside `modelContextWindow`, `approvalPolicy`, `sandboxPolicy`
 *   — the app-server protocol table, in the contract's exact field order.
 * - snake_case, beside `struct TokenUsage with N elements` and
 *   `codex.turn.token_usage.*` — the rollout-log struct and OTel span
 *   attributes, both different types that never reach this socket.
 * - `model_context_window` beside `sandbox_mode` — config.toml keys.
 *
 * The snake_case members below are a defensive fallback, not a belief: an older
 * app-server than the one we bundle would cost nothing to keep reading.
 */
export interface CodexTokenUsageBreakdown {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /**
   * P6.446 · the two counters codex has reported all along and this type
   * declared neither of, so every codex turn recorded a cache reading of zero —
   * indistinguishable from a provider that does no caching, on the runtime this
   * product ships by default. Both are non-optional in the generated contract
   * (`codex-protocol/generated/v2/TokenUsageBreakdown.ts`); optional here
   * because this type is also fed the legacy shape below.
   */
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  /** Pre-camelCase wire. Read, never written. */
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
}

export interface CodexTokenUsage {
  total?: CodexTokenUsageBreakdown;
  last?: CodexTokenUsageBreakdown;
  modelContextWindow?: number | null;
}

/** One breakdown figure, preferring the contract's casing over the legacy one. */
export function readCodexTokenCount(
  breakdown: CodexTokenUsageBreakdown | undefined,
  field: 'input' | 'output' | 'cacheRead' | 'cacheWrite',
): number {
  const value = field === 'input'
    ? breakdown?.inputTokens ?? breakdown?.input_tokens
    : field === 'output'
      ? breakdown?.outputTokens ?? breakdown?.output_tokens
      : field === 'cacheRead'
        ? breakdown?.cachedInputTokens ?? breakdown?.cached_input_tokens
        : breakdown?.cacheWriteInputTokens ?? breakdown?.cache_write_input_tokens;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * P6.446 — one codex turn's usage, in the shape `UsageTracker.recordMessageUsage`
 * defines, INCLUDING the two cache counters.
 *
 * Native-first step 1 succeeds outright here: codex reports both counters and
 * always did; our reader declared neither and dropped both, so `/usage` could
 * not answer whether caching was working on the runtime this product ships by
 * default.
 *
 * ## The conversion, and why it is a subtraction
 *
 * The two sides count DIFFERENT things and both are internally consistent:
 *
 * - codex, `codex-rs/protocol/src/protocol.rs` at `rust-v0.150.1` (STRONG tier,
 *   the source the shipped binary is built from): `non_cached_input()` is
 *   `input_tokens - cached_input()`. So `inputTokens` is the WHOLE input, cached
 *   half included.
 * - this host's tracker, `core/usage-tracker.ts`, follows the Anthropic
 *   convention and computes `totalInput = inputTokens + cacheRead +
 *   cacheCreation` — its `inputTokens` is the NON-cached part.
 *
 * Carrying codex's numbers across unconverted would therefore bill the cached
 * half twice: codex's own 1000/700/100 turn would read as 1800 input. The
 * subtraction is what leaves the total identical to the figure codex itself
 * reports, which is exactly the control the row's `done_means` asks for.
 *
 * `Math.max(0, …)` is not decoration: the two fields arrive on the same
 * notification but nothing in the contract forbids a future release from
 * counting the write half outside `input_tokens`, and a negative input would
 * corrupt every downstream total rather than fail visibly.
 */
export function readCodexMessageUsage(breakdown: CodexTokenUsageBreakdown | undefined): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
} {
  const cacheReadTokens = readCodexTokenCount(breakdown, 'cacheRead');
  const cacheCreationTokens = readCodexTokenCount(breakdown, 'cacheWrite');
  return {
    inputTokens: Math.max(0, readCodexTokenCount(breakdown, 'input') - cacheReadTokens - cacheCreationTokens),
    outputTokens: readCodexTokenCount(breakdown, 'output'),
    cacheReadTokens,
    cacheCreationTokens,
  };
}

function isContextCompaction(item: unknown): item is { type: 'contextCompaction'; id: string } {
  return typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'contextCompaction';
}

/**
 * The pair of events a compaction produces, identical in wording to the Pi
 * adapter's — because the session layer routes on the WORDS, not on a field:
 * a status containing "Compacting" becomes `statusType: 'compacting'`, and an
 * info starting with "Compacted" becomes `statusType: 'compaction_complete'`,
 * which is what persists the transcript row and refreshes the context badge.
 *
 * Codex reports compaction only in the PAST tense — neither
 * `thread/compacted` (`{threadId, turnId}`) nor the `contextCompaction` item
 * (`{type, id}`) carries a token figure, and there is no start notification at
 * all. So the status here is momentary, immediately superseded by the info row;
 * it exists so a codex session goes through the same state transition as the
 * other two runtimes rather than silently skipping it. No figures are invented:
 * the drop is visible in the next `thread/tokenUsage/updated`.
 *
 * P6.55 · these two rows stay byte-identical, and the thrash notice is APPENDED
 * as a third event rather than folded into either of them — precisely because
 * the session layer routes on the words. See
 * {@link CODEX_AUTO_COMPACTION_THRASHING_NOTICE_PREFIX}.
 */
function compactionEvents(trigger?: 'manual' | 'auto'): AgentEvent[] {
  return [
    { type: 'status', message: 'Compacting context...' },
    { type: 'info', message: 'Compacted context to fit within limits', ...(trigger ? { compactionTrigger: trigger } : {}) },
  ];
}

/**
 * Opening words of the durable notice a tripped thrash guard adds after the
 * compaction pair.
 *
 * It deliberately does NOT begin with "Compacted" and does not contain
 * "Compacting": those are the two keywords `SessionManager` routes the pair
 * above on, and a third row wearing either would be re-read as a compaction
 * lifecycle event instead of the warning it is.
 *
 * Wording follows the vendor's own account of the same stop
 * (`troubleshooting.md#auto-compaction-stops-with-a-thrashing-error`: *"automatic
 * compaction succeeded but a file or tool output immediately refilled the
 * context window several times in a row"*) and carries its first three recovery
 * steps, because a stop the user cannot act on is only half an answer.
 */
export const CODEX_AUTO_COMPACTION_THRASHING_NOTICE_PREFIX =
  'Auto-compaction is thrashing:';

/**
 * The shared wire value, spelled once here rather than inline, and pinned to the
 * vocabulary by `satisfies` so a rename in `core` fails this file instead of
 * shipping a reason the renderer and the session store do not recognise.
 */
const AUTO_COMPACTION_THRASHING_REASON = 'auto_compaction_thrashing' satisfies AgentTerminalReason;

/**
 * P6.449 · the name a person would use for a codex hook.
 *
 * codex identifies a hook by its `sourcePath` (an `AbsolutePathBuf`) rather than
 * by a name of its own, so the basename is the closest honest label. Returns
 * `undefined` when there is no usable path, which leaves `hookRunLabel` on the
 * event name — its own documented answer, not a fallback invented here.
 */
function hookSourceLabel(sourcePath: unknown): string | undefined {
  if (typeof sourcePath !== 'string') return undefined;
  const base = sourcePath.split(/[\\/]/).filter(Boolean).pop();
  return base && base.length > 0 ? base : undefined;
}

/**
 * P6.443 — codex's own error vocabulary projected onto the terminal-reason
 * vocabulary the transcript already renders.
 *
 * ## What was silent
 *
 * A codex turn stopped by a provider error ended with a bare
 * `{ type: 'complete' }`: the `error` notification produced a `codex: …` line
 * and the turn's VERDICT said nothing, while the same ending on claude names
 * itself through `CLAUDE_RESULT_SUBTYPE_REASON`. Measured at
 * `base-agent.ts`'s cost latch, codex stamped no `terminalIsError` and no
 * qualifying `terminalReason` — 0 and 0, against claude 2 and pi 1.
 *
 * ## The source vocabulary, read from the union rather than from prose
 *
 * `CodexErrorInfo` (`packages/codex-protocol/generated/v2/CodexErrorInfo.ts`,
 * `rust-v0.148.0`): the plain variants are strings and four carry an HTTP status
 * as a single-key object (`httpConnectionFailed`, `responseStreamConnectionFailed`,
 * `responseStreamDisconnected`, `responseTooManyFailedAttempts`), plus
 * `activeTurnNotSteerable`.
 *
 * ## The row's M5-codex clause is REFUTED, and the search is why it was believed
 *
 * That clause reads: *"none — searched `packages/codex-protocol/generated/v2`
 * (562 files) for refus/decline/reject; hits are approval decisions only"*. The
 * search is accurate and its conclusion is not: codex publishes **two** refusal
 * codes, `cyberPolicy` and `misalignmentPolicyViolation`, and neither name
 * contains any of those three stems. A stem search cannot find a vocabulary that
 * names itself after the POLICY rather than after the act.
 *
 * ## Deliberately narrow, in the same spirit as
 * {@link CODEX_ERROR_INFO_TO_DOCUMENTED_STOP_FAILURE}
 *
 * The two policy codes are `provider_refusal`; every other terminal error is
 * `provider_error`, which is exactly what claude's own map does with its
 * unrecognised subtypes ("a cap is a stop, not a crash").
 *
 * `sessionBudgetExceeded` is deliberately NOT mapped to `max_budget_usd`. The
 * union gives it no unit and no doc comment, and the copy behind
 * `max_budget_usd` names a DOLLAR budget the user set. Naming a budget that may
 * not be one, and that the user may never have set, is the confident-wrong-answer
 * shape this fork keeps finding — so it lands on `provider_error` with the
 * codex code still readable beside it.
 *
 * There is no codex code for a turn CAP: nothing in the union corresponds to
 * `max_agent_turns`, so that member stays unreachable on this runtime and the
 * absence is a fact about codex rather than a gap here.
 */
const CODEX_ERROR_INFO_TERMINAL_REASON = Object.freeze({
  cyberPolicy: 'provider_refusal',
  misalignmentPolicyViolation: 'provider_refusal',
} as Readonly<Record<string, AgentTerminalReason>>);

/**
 * The terminal reason for one codex `ErrorNotification`, or `undefined` when the
 * caller has decided the error is not terminal.
 *
 * The CALLER decides terminality — `willRetry` and the `turnId` check live in
 * `codex-agent.ts` and are already computed there — because a retrying error is
 * a turn that is still going, and an error naming another turn on this thread
 * did not end this one. Stamping either would report a stop that did not happen.
 */
export function codexTerminalReasonForError(codexErrorInfo: unknown): AgentTerminalReason {
  const code = typeof codexErrorInfo === 'string'
    ? codexErrorInfo
    : codexErrorInfo && typeof codexErrorInfo === 'object'
      && Object.keys(codexErrorInfo as Record<string, unknown>).length === 1
      ? Object.keys(codexErrorInfo as Record<string, unknown>)[0]!
      : undefined;
  return (code === undefined ? undefined : CODEX_ERROR_INFO_TERMINAL_REASON[code]) ?? 'provider_error';
}

function autoCompactionThrashingNotice(refills: number): AgentEvent {
  return {
    type: 'info',
    level: 'warning',
    message: `${CODEX_AUTO_COMPACTION_THRASHING_NOTICE_PREFIX} the context refilled to the limit`
      + ` immediately after each of the last ${refills} compactions, so this turn stops instead of`
      + ' looping. Read the oversized file in smaller ranges, run /compact with a focus that drops'
      + ' the large output, or run /clear.',
  };
}

/**
 * Narrowed view of codex's [UNSTABLE] auto-review guardian payload
 * (`GuardianApprovalReview` on the `item/autoApprovalReview/*` notifications;
 * the generated docblock says "This shape is expected to change soon"). Only the
 * fields a status line needs are read, and every read tolerates their absence —
 * protocol-drift posture, degrade never throw.
 */
interface GuardianApprovalReviewLike {
  // GuardianApprovalReviewStatus: "inProgress" | "approved" | "denied" | "timedOut" | "aborted".
  status?: string;
  // GuardianRiskLevel: "low" | "medium" | "high" | "critical".
  riskLevel?: string | null;
  rationale?: string | null;
}

/** ` [risk: high]` when the review carries a risk level, else `''`. */
function guardianRiskSuffix(review: GuardianApprovalReviewLike | undefined): string {
  const risk = typeof review?.riskLevel === 'string' ? review.riskLevel.trim() : '';
  return risk ? ` [risk: ${risk}]` : '';
}

/** `: <rationale>` when the review carries one, else `''`. */
function guardianRationaleSuffix(review: GuardianApprovalReviewLike | undefined): string {
  const rationale = typeof review?.rationale === 'string' ? review.rationale.trim() : '';
  return rationale ? `: ${rationale}` : '';
}

/**
 * P2.417 · WHAT the guardian just decided about, shaped so a denial sentence can
 * take it as its object.
 *
 * Both `item/autoApprovalReview/*` notifications carry a REQUIRED `action`
 * beside the `review` (generated `Item…ReviewCompletedNotification`, ts-rs
 * output from the codex source at `rust-v0.148.0` — strong evidence about the
 * SHAPE; whether the frames arrive at all is a separate, unmeasured question
 * P2.407 left standing, because the guardian variants that motivated it need
 * codex's managed proxy running). Until this row it was read in exactly one
 * place, `CodexAgent`'s debug receipt, so the VERDICT reached the user and the
 * SUBJECT did not: "Auto-review denied this action", with "this action" naming
 * nothing to act on.
 *
 * {@link describeGuardianReviewAction} is the single describer for all six
 * `GuardianApprovalReviewAction` variants and is exported from the approval
 * bridge precisely so this site adopts it instead of growing a second, drifting
 * copy. Its output is a VERB phrase — "run `ls` in /repo", "reach
 * api.example.com:443 over https", "call MCP tool github/create_issue" — so it
 * is fronted with "the request to" rather than dropped in bare, and an unknown
 * seventh variant from a future binary still yields its bare `type` rather than
 * an empty string.
 *
 * Falls back to the frozen `this action` when the payload carries no readable
 * action, so the sentence survives protocol drift unchanged — degrade, never
 * throw, like every other read in this file.
 */
function guardianActionPhrase(action: unknown): string {
  const described = describeGuardianReviewAction(action);
  return described ? `the request to ${described}` : 'this action';
}

/**
 * P3.3 — a background terminal, normalised from the `thread/backgroundTerminals/list`
 * result into the one shape {@link CodexEventAdapter.syncBackgroundTerminals} diffs.
 *
 * WHAT IS PINNED AND WHAT IS NOT, measured off the shipped binary
 * (`apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`, `grep -ac`
 * with `thread/start`=3 / `turn/start`=4 / `command/exec`=11 as the positive
 * control and two absent method names as the negative control):
 *
 * - The three methods DO ship. The binary's method table reads verbatim
 *   `…thread/memoryMode/set memory/reset thread/backgroundTerminals/clean
 *   thread/backgroundTerminals/list thread/backgroundTerminals/terminate…`.
 *   The PINNED TS BINDINGS lag it — `codex-protocol` (rust-v0.148.0) generates
 *   none of them — which is the protocol-drift case, not an absent feature.
 * - The REQUEST params are pinned by arity: the binary declares
 *   `struct ThreadBackgroundTerminalsListParams with 3 elements`,
 *   `…TerminateParams with 2 elements`, `…CleanParams with 1 element`.
 * - The RESPONSE entry has NO named struct in the binary (`BackgroundTerminalInfo`,
 *   `…Summary`, `…Entry`, `…ListResponse` all 0 hits) and no embedded JSON schema
 *   mentions a terminal, so the entry's field NAMES are genuinely not statically
 *   discoverable. Tolerance is therefore kept HERE and only here — but it is now
 *   evidence-led rather than speculative: every candidate below is a string that
 *   actually occurs in the binary (`command` 377, `status` 460, `running` 165,
 *   `exited` 34, `startedAt` 12, `exitCode` 6, `processId` 14, `processHandle` 4,
 *   `sessionId` 13), and `terminalId` — which the first version of this file
 *   guessed and used — was REMOVED because it occurs **0** times.
 *
 * A shape this cannot read parses to "no terminals": the same silent no-op a
 * missing method produces, never a throw.
 */
export interface CodexBackgroundTerminal {
  /** The app-server's terminal handle — becomes the chip's `shellId`/`taskId`. */
  id: string;
  /**
   * WHICH KEY the id arrived under, carried so `terminate` can echo the
   * app-server's own spelling back instead of guessing one.
   *
   * This is the fix for a real defect: the first version sent
   * `{ threadId, terminalId }`, and `terminalId` does not exist in the binary at
   * all — so every Stop would have been rejected. Since the entry's id key is
   * only knowable at runtime, the response teaches us the name and the request
   * reuses it. See `CodexAgent.stopBackgroundTask`.
   */
  idKey: string;
  /** The command line, when the list carries one — the chip's label. */
  command?: string;
  /** Whether the entry reports the process has ended (present-but-exited). */
  exited: boolean;
  /** Terminal status for the `task_completed` we synthesise on exit. */
  status: 'completed' | 'failed' | 'stopped';
}

/**
 * The id field names we accept on a list entry, in priority order.
 *
 * `processId` IS FIRST BECAUSE IT IS THE MEASURED ONE. A live stdio run against
 * the shipped binary answered `terminate {id}` with ``missing field `processId` ``,
 * so `processId` is the real parameter and every other spelling here is only a
 * fallback for a future binary. It used to be second, which cost one guaranteed
 * wasted round-trip on the true wire.
 *
 * `terminalId` is deliberately absent (0 occurrences in the binary — the original
 * guess, and it was wrong). This is also the candidate list `stopBackgroundTask`
 * walks when an entry taught it no key.
 */
export const CODEX_BACKGROUND_TERMINAL_ID_KEYS = ['processId', 'id', 'processHandle', 'sessionId'] as const;

/**
 * A usable id string from a wire value.
 *
 * NUMBERS ARE ACCEPTED, and that is a fix rather than laxity: the measured field
 * is `processId` and the binary requires it to be **digit-parseable** (it answers
 * ``invalid background terminal process id: invalid digit found in string`` for a
 * non-numeric one). A wire that sends that PID as a JSON number — entirely
 * plausible for a field with those semantics — used to be dropped silently by a
 * string-only read: no chip, and no debug line either, the one failure mode that
 * leaves this feature both inert and undiagnosable.
 *
 * Non-finite numbers are refused: `NaN`/`Infinity` stringify into something no
 * `terminate` could ever accept.
 */
function readWireId(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  return undefined;
}

/** First non-empty string among the candidates, else `undefined`. */
function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

/**
 * Pull the terminal array out of a `thread/backgroundTerminals/list` result. The
 * result may itself be an array, or wrap it under one of a few likely keys.
 */
export function extractCodexBackgroundTerminals(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    // `terminals` first (the method's own noun); `items` and `data` are the
    // envelope spellings this app-server uses elsewhere alongside `cursor` /
    // `nextCursor`, both of which occur in the binary.
    for (const key of ['terminals', 'backgroundTerminals', 'items', 'processes', 'data']) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [];
}

/**
 * The paging cursor on a `thread/backgroundTerminals/list` result, or `null` when
 * the listing is complete.
 *
 * Measured: the binary answers `list {threadId}` with `{"data":[],"nextCursor":null}`,
 * so both the envelope key and the cursor field are real rather than inferred.
 * A non-null cursor means the page is a PREFIX of the terminal set — which is why
 * {@link CodexEventAdapter.syncBackgroundTerminals} must not read absence from it.
 */
export function readCodexBackgroundTerminalsCursor(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  for (const key of ['nextCursor', 'cursor']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

/** Normalise one raw list entry, or `null` when it carries no usable id. */
export function normalizeCodexBackgroundTerminal(raw: unknown): CodexBackgroundTerminal | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  // Take the id AND remember its key — `terminate` echoes the spelling back.
  //
  // A DIGIT-PARSEABLE candidate WINS over an earlier non-numeric one, because the
  // binary rejects a non-numeric process id outright (`invalid digit found in
  // string`). So an entry carrying both `id: "sh-a"` and `processId: 4242` must
  // address the terminal as 4242 — picking `"sh-a"` would produce a chip whose
  // Stop can never succeed, and that refusal is not a shape error, so no
  // fallback would rescue it.
  let id: string | undefined;
  let idKey: string = CODEX_BACKGROUND_TERMINAL_ID_KEYS[0];
  for (const key of CODEX_BACKGROUND_TERMINAL_ID_KEYS) {
    const candidate = readWireId(record[key]);
    if (!candidate) continue;
    const numeric = /^\d+$/.test(candidate);
    if (!id || (numeric && !/^\d+$/.test(id))) { id = candidate; idKey = key; }
    if (numeric) break;
  }
  if (!id) return null;
  const command = firstNonEmptyString(record.command, record.commandLine, record.cmd);
  const exitCode = typeof record.exitCode === 'number'
    ? record.exitCode
    : typeof record.exit_code === 'number'
      ? record.exit_code
      : undefined;
  const statusStr = typeof record.status === 'string' ? record.status.toLowerCase() : undefined;
  const running = typeof record.running === 'boolean' ? record.running : undefined;
  const exitedFlag = typeof record.exited === 'boolean' ? record.exited : undefined;
  const exited = exitCode !== undefined
    || exitedFlag === true
    || running === false
    || statusStr === 'exited' || statusStr === 'completed' || statusStr === 'failed'
    || statusStr === 'done' || statusStr === 'stopped' || statusStr === 'killed'
    || statusStr === 'terminated';
  const status: 'completed' | 'failed' | 'stopped' =
    (exitCode !== undefined && exitCode !== 0) || statusStr === 'failed'
      ? 'failed'
      : statusStr === 'stopped' || statusStr === 'killed' || statusStr === 'terminated'
        ? 'stopped'
        : 'completed';
  return { id, idKey, ...(command ? { command } : {}), exited, status };
}

export class CodexEventAdapter extends BaseEventAdapter {
  /**
   * P6.643 - one runtime-native hook run, handed to the session's run store.
   *
   * A settable field rather than a constructor argument because this adapter is
   * built as a field initializer with no options bag (`codex-agent.ts`), and a
   * new constructor parameter would have been a wider change than the one line
   * that sets this. Inert when nobody set it; `BaseAgent.recordHookRun` is what
   * a caller assigns.
   */
  onHookRun?: (observation: HookRunObservation) => void;

  /**
   * P6.574 — the codex arm of the host secret scan.
   *
   * Every codex tool result this adapter emits is built here (Bash, Edit, MCP,
   * the collab calls, web search, the plan tool and the never-completed
   * refusal), so the override is the one seam that no future call site can walk
   * past — which is what the Pi arm's *"outside the early return"* rule is about
   * one layer up. It runs BEFORE anything downstream truncates or stores the
   * text, and it is the only place a codex result can be reached before the
   * model's next turn reads it: codex reports a completed item and we hand the
   * text straight on.
   *
   * Native asked (step 1): codex has NO secret scan of its own — the shipped
   * binary at `rust-v0.148.0` carries no rule table, and the one that exists is
   * inside the vendored claude binary and reachable by no setting. So this is
   * the host's single scanner (step 2) wired, not a second mechanism built.
   *
   * P6.753 — `structuredContent` is scanned TOO, and the limit this docblock
   * used to state is retired rather than deleted, because the reason it gave was
   * measurably wrong in both halves. It said the record is "a machine payload
   * our renderer reads": nothing in this tree reads
   * `tool_result.structuredContent` by name (measured 2026-09-08). It said
   * rewriting values would corrupt shapes the UI parses: a string leaf is
   * replaced by a string, keys and non-string leaves are returned by identity,
   * so no shape moves. The record is where an MCP tool's own payload arrives
   * (`item.result.structuredContent`), it is persisted with the session, and a
   * credential reaching it was carried in full.
   */
  protected override createToolResult(
    id: string,
    toolName: string,
    result: string,
    isError: boolean,
    parentToolUseId?: string,
    structuredContent?: Record<string, unknown>,
  ): AgentEvent {
    const scrubbed = scrubToolResultPayload(result, structuredContent);
    return super.createToolResult(
      id,
      toolName,
      scrubbed.text,
      isError,
      parentToolUseId,
      scrubbed.structuredContent,
    );
  }

  /** Collab calls that saw `item/started` and no `item/completed` yet. */
  private readonly openCollabCalls = new Map<string, string>();

  /** Image items already reported this turn, keyed `type:id` — see {@link renderImageItem}. */
  private readonly renderedImageItems = new Set<string>();

  /**
   * P3.295 · how many plan updates this turn has already painted.
   *
   * `TurnPlanUpdatedNotification` carries no item id — it is a turn-level
   * notification, not a thread item — so the synthesized row needs an id of its
   * own, and it must differ per update or the second plan would overwrite the
   * first instead of appearing beside it. Turn-scoped, cleared in
   * {@link onTurnStart}, and combined with the turn identity in
   * {@link planUpdateEvents} so two turns cannot collide either.
   */
  private planUpdatesThisTurn = 0;

  /**
   * P3.4 · model-driven parallel agents. A `spawn_agent` collab call introduces
   * child threads that stream over the SAME connection; the agent attributes
   * their notifications to a foreign thread and drops them from the parent
   * transcript. These two maps let the adapter re-admit that child traffic as
   * `OrchestrationProgress` instead: `orchestrationRuns` holds one run per spawn
   * call (keyed by its collab item id), `childThreadToRun` says which run a child
   * thread belongs to. Turn-scoped — a spawn and its wait live inside one parent
   * turn — so both clear in {@link onTurnStart}, exactly like `openCollabCalls`.
   */
  private readonly orchestrationRuns = new Map<string, CodexOrchestrationRun>();
  private readonly childThreadToRun = new Map<string, string>();

  /**
   * P3.2 · per-turn denial breaker for codex's native auto-review guardian. It
   * only COUNTS the `denied` verdicts codex streams and reports when the same
   * 3-consecutive / 10-of-50 pattern codex's own breaker trips on emerges;
   * codex remains the authority, and it INTERRUPTS the turn (F1.388).
   */
  private readonly autoReviewBreaker = new CodexAutoReviewBreaker();

  /**
   * P6.55 · per-turn guard for a context that refills straight after every
   * compaction. Codex reports compaction only in the past tense and never
   * surfaces the overflow error Pi's guard reads, so a refill is inferred from
   * a compaction that follows another with no user message between them — see
   * {@link CodexAutoCompactionThrashGuard} for why the floor is one compaction
   * and not zero.
   */
  private readonly autoCompactionThrashGuard = new CodexAutoCompactionThrashGuard();

  /**
   * P2.437 · set on the single compaction that trips the guard, cleared by the
   * one read. See {@link consumeAutoCompactionThrashTrip}.
   */
  private autoCompactionThrashTrip = false;

  /**
   * P2.437 · has the compaction loop JUST tripped, and has nobody acted yet?
   *
   * Exposed because the guard can only OBSERVE. Its notice says "this turn stops
   * instead of looping", and until this row nothing stopped it — the adapter has
   * no control channel by construction, so `CodexAgent` reads this and sends
   * `turn/interrupt`.
   *
   * An EDGE that the reader consumes, deliberately, rather than the guard's
   * latched `isTripped`. A latched flag would make every later notification in
   * the turn look like a fresh trip, forcing the reader to keep its own
   * "already acted" state — and two pieces of state for one event is how they
   * drift apart. Measured while this row was written: a reader latching on the
   * TURN ID re-interrupted the next turn, because the guard's own reset runs on
   * `startTurn()` and not on the `turn/started` notification.
   */
  consumeAutoCompactionThrashTrip(): boolean {
    if (!this.autoCompactionThrashTrip) return false;
    this.autoCompactionThrashTrip = false;
    return true;
  }

  /**
   * P2.417 · the `action` of the most recent DENIED auto-review, so `/approve`
   * can name what it just overruled.
   *
   * It is remembered here because {@link notifyGuardianOverride} is invoked
   * without arguments from both of `CodexAgent`'s `/approve` arms and the
   * override itself carries no action. The semantics deliberately match
   * `CodexAgent.relayGuardianOverride`'s `event ?? this.lastGuardianDeniedEvent`
   * — both name the LATEST denial, so the notice the user reads and the
   * assessment event the app-server replays are the same one. Like that field it
   * is NOT cleared at a turn boundary or on override: clearing it would silence
   * the notice exactly while the relay still had something to replay.
   */
  private lastGuardianDeniedAction: unknown = undefined;

  /**
   * P3.3 · background terminals we have already announced to the renderer, keyed
   * by the app-server's terminal id. Value carries the command so a diff never
   * has to re-read it.
   *
   * This is PER-CONNECTION state, NOT per-turn: a background terminal outlives
   * the turn that spawned it, so it must survive {@link onTurnStart}. It is
   * cleared only when the runtime is torn down and re-probed — the agent calls
   * {@link resetBackgroundTerminals} from `teardownRuntime`, because a fresh
   * app-server starts with an empty terminal set and stale ids would strand a
   * chip that can never be stopped.
   */
  private readonly knownBackgroundTerminals = new Map<string, { command?: string; idKey: string }>();

  /**
   * P3.308 · has this SESSION already been told its sandbox cannot be built?
   *
   * Session-scoped and NOT cleared in {@link onTurnStart}, for the same reason
   * `knownBackgroundTerminals` is not: the condition is a property of the
   * config the runtime started with, so it holds for every command of every
   * turn until the runtime is rebuilt. Measured, the failure is TOTAL — a plain
   * read of a non-secret file dies with the identical error — so a per-command
   * notice would put one line on the transcript for every tool call the model
   * makes while nothing works.
   */
  private reportedSandboxConstructionFailure = false;

  constructor() {
    super('codex-runtime');
  }

  /**
   * P6.443 · the terminal reason a codex `ErrorNotification` named for THIS
   * turn, waiting for `turn/completed` to carry it.
   *
   * Set by `codex-agent.ts`, which is where terminality is already decided
   * (`willRetry !== true` AND the error names the active turn). Cleared on turn
   * start as well as on consumption: a turn that ended without a
   * `turn/completed` must not leak its verdict onto the next one, which is the
   * same reason `openCollabCalls` clears here.
   */
  private pendingTerminalReason: AgentTerminalReason | undefined;

  /**
   * P6.443 · record the verdict for the turn in flight.
   *
   * A setter rather than a return value from `adapt`, because the notification
   * that decides it (`error`) and the notification that carries it
   * (`turn/completed`) are two messages, and only the agent knows whether the
   * first one was terminal. Last one wins: a turn that produced two terminal
   * errors ends on the one that actually ended it.
   */
  noteTerminalError(reason: AgentTerminalReason): void {
    this.pendingTerminalReason = reason;
  }

  protected onTurnStart(): void {
    this.pendingTerminalReason = undefined;
    this.openCollabCalls.clear();
    this.renderedImageItems.clear();
    this.planUpdatesThisTurn = 0;
    this.orchestrationRuns.clear();
    this.childThreadToRun.clear();
    this.autoReviewBreaker.resetTurn();
    this.autoCompactionThrashGuard.resetTurn();
    this.autoCompactionThrashTrip = false;
    // `knownBackgroundTerminals` is deliberately NOT cleared here — see its field.
  }

  /**
   * P6.449 · one codex hook run, in the host's shared vocabulary.
   *
   * ## The status mapping, and the one member the union was widened for (F1.515)
   *
   * `HookRunStatus` is `running | completed | failed | blocked | stopped`.
   * {@link HookRunOutcome}'s own docblock says a runtime reporting something
   * else *"maps into the nearest of these at its own adapter rather than
   * widening this union, so the report's rules stay total"* — so the mapping
   * lives here:
   *
   * | codex | host | why |
   * | --- | --- | --- |
   * | `completed` | `success` | the transcript stays quiet, by the page's rule |
   * | `failed` | `error` | |
   * | `blocked` | `blocked` | F1.515: a REFUSAL (a PermissionRequest deny, an exit 2 with a reason) — a verdict, not a crash, so the report says the hook blocked the action and never "failed" (it mapped to `error`, the nearest member, until then); `statusMessage` still goes FIRST, so codex's own sentence says what it blocked. |
   * | `stopped` | `cancelled` | the run did not finish; usually the turn was interrupted |
   * | `running` | — | unreachable: only `hook/completed` is read |
   *
   * ## The entries are NOT stdout and stderr, and pretending they are would invent
   *
   * `HookOutputEntryKind` is `warning | stop | feedback | context | error` — a
   * CLASSIFICATION, not a stream. Splitting it into the observation's
   * `stdout`/`stderr` would manufacture a distinction codex does not publish and
   * would put a `feedback` entry on one side or the other by guess. They go to
   * `output` — the field that exists for "a stream the runtime already reduced
   * to one string" — each line labelled with its own kind, so the classification
   * survives instead of being flattened away.
   */
  private hookRunEvents(params: Record<string, unknown>): AgentEvent[] {
    const run = (params as { run?: Record<string, unknown> }).run;
    if (!run || typeof run !== 'object') return [];
    const status = typeof run.status === 'string' ? run.status : '';
    if (status === 'running') return [];
    const outcome: HookRunOutcome = status === 'completed'
      ? 'success'
      : status === 'stopped'
        ? 'cancelled'
        : status === 'blocked' ? 'blocked' : 'error'; // F1.515 — a refusal is not a failure

    const statusMessage = typeof run.statusMessage === 'string' ? run.statusMessage.trim() : '';
    const entries = Array.isArray(run.entries) ? run.entries : [];
    const lines = [
      ...(statusMessage ? [statusMessage] : []),
      ...entries.flatMap(entry => {
        const text = typeof (entry as { text?: unknown })?.text === 'string'
          ? (entry as { text: string }).text.trim()
          : '';
        if (!text) return [];
        const kind = typeof (entry as { kind?: unknown })?.kind === 'string'
          ? (entry as { kind: string }).kind
          : 'output';
        return [`[${kind}] ${text}`];
      }),
    ];

    const event = typeof run.eventName === 'string' ? run.eventName : 'hook';
    // P6.643 - built once, used twice: the transcript line and the session's
    // hook-run store. `onHookRun` is set by the agent that owns the store and is
    // inert when nobody set it.
    const observation: HookRunObservation = {
      runtime: 'codex',
      event,
      // codex names a hook by its FILE rather than by a name of its own, so the
      // basename is the closest thing to "what a person would call this hook".
      // Absent leaves `hookRunLabel` on the event name, which is its own answer.
      ...(hookSourceLabel(run.sourcePath) ? { name: hookSourceLabel(run.sourcePath) } : {}),
      outcome,
      ...(lines.length > 0 ? { output: lines.join('\n') } : {}),
    };
    this.onHookRun?.(observation);
    const report = reportHookRun(observation);
    // No new event type: `info`'s `level` already carries the persistence
    // decision this host makes (`warning` survives a reload, `info` does not),
    // and the report picked it.
    return report.message
      ? [{ type: 'info', message: report.message, level: report.level }]
      : [];
  }

  /**
   * P6.55 · one observed compaction: the unchanged pair, plus — on the single
   * call that trips the guard — a durable warning naming the loop.
   *
   * Both of codex's compaction channels route through here (the
   * `contextCompaction` item a newer app-server sends, and the deprecated
   * `thread/compacted` notification the bundled one still sends), so a server
   * that emits either one is counted, and a server that emits BOTH for one
   * compaction is the single shape this cannot tell apart. Measured against the
   * contract, it does not have to: the deprecation note ("Use `ContextCompaction`
   * item type instead") is what makes the two alternatives rather than a pair,
   * and the `thread/compacted` branch's own comment records that a given
   * app-server uses one or the other.
   */
  /**
   * P6.118 · a compaction was observed and the agent has not minted its hook yet.
   *
   * Set in {@link observedCompaction}, which is the single funnel BOTH compaction
   * channels route through — the `contextCompaction` item and the deprecated
   * `thread/compacted` notification — so an agent-side predicate re-deriving
   * "was this a compaction?" from the method and params would be a second copy
   * of that routing, free to drift from it. Consumed exactly like
   * {@link consumeAutoCompactionThrashTrip}, whose shape this follows.
   */
  private observedCompactionPending = false;

  /** P6.118 · take the pending compaction, if any. Reading clears it. */
  consumeObservedCompaction(): boolean {
    if (!this.observedCompactionPending) return false;
    this.observedCompactionPending = false;
    return true;
  }

  private observedCompaction(): AgentEvent[] {
    const tripped = this.autoCompactionThrashGuard.recordCompaction();
    this.observedCompactionPending = true;
    // P2.437 · arm the edge the agent consumes to send `turn/interrupt`. Set
    // here rather than derived from `isTripped`, so it fires once per trip
    // rather than once per notification after it.
    if (tripped) this.autoCompactionThrashTrip = true;
    const events = compactionEvents(this.observedCompactionTrigger());
    return tripped
      ? [...events, autoCompactionThrashingNotice(this.autoCompactionThrashGuard.refills)]
      : events;
  }

  /**
   * P3.9 · the identity ONE assistant message travels under, on both its deltas
   * and its completion.
   *
   * It rides the `turnId` field because that field is the only identity channel
   * this wire has: `SessionManager` forwards `turnId` and `parentToolUseId` to
   * the renderer and mints its own `messageId` at completion time, so an id
   * invented here reaches the renderer only through `turnId`. Pi has done
   * exactly this since long before codex existed — `nextSubTurnId('m')` /
   * `nextSubTurnId('thinking')` in `backend/pi/event-adapter.ts` build
   * `<turn>__m0`, `<turn>__thinking1` — and Claude does the equivalent by
   * assigning `currentTurnId = message.id` at `message_start`. Codex was the
   * only backend still stamping one id (in production, NO id: no call site
   * passes `startTurn` an id) on every message in a turn.
   *
   * Shape: `<turn base>__<kind>:<item key>`.
   * - The item key comes from the notification's own item id, so the deltas of
   *   an `agentMessage` (`AgentMessageDeltaNotification.itemId`) and its
   *   completion (`ThreadItem.id`) agree without any state kept here.
   * - The base MUST be turn-unique, because the renderer's lookup scans the
   *   WHOLE transcript, not the current turn: item ids are only documented
   *   unique within an item type, and a base that repeated across turns would
   *   let a new message update an old one — worse than the collision this
   *   fixes. `ItemStartedNotification` / `ItemCompletedNotification` /
   *   `AgentMessageDeltaNotification` all carry codex's own `turnId`, which is
   *   the real thing; `this.currentTurnId` wins when a call site did pass one,
   *   and the inherited per-adapter `turnIndex` is the last resort so the base
   *   is never constant.
   * - The kind segment keeps an `imageView` and an `imageGeneration` that share
   *   an id apart, the same reason `renderedImageItems` keys by type as well.
   *
   * Nothing downstream reads `turnId` as "a turn": `turn-utils.ts` states it
   * "intentionally ignore[s] turnId for grouping", the Claude branch anchor is
   * gated on `isClaudeMessageUuid`, and the R32 `MessageDisplay` cursor is
   * per-message already.
   */
  private messageIdentity(params: Record<string, unknown>, kind: string, itemKey: string): string {
    const wireTurnId = typeof params.turnId === 'string' && params.turnId ? params.turnId : null;
    const base = this.currentTurnId ?? wireTurnId ?? `turn${this.turnIndex}`;
    return `${base}__${kind}:${itemKey}`;
  }

  /**
   * An image item is reported ONCE per turn: the FIRST notification that
   * produces ANY event marks the item rendered, and every later notification
   * for that item is dropped. "Any event" is literal — a failure notice or a
   * path-less warning closes the item just as a preview block does, so a dead
   * end is never repeated either.
   *
   * Both `ItemStartedNotification` and `ItemCompletedNotification` are typed
   * `{ item: ThreadItem, … }`, and neither the generated contract nor this
   * adapter's own live evidence says which item types get a `started` — so
   * keying on one notification would either drop the image (if only the other
   * arrives) or show it twice. The key set decides instead, and it is
   * turn-scoped like `openCollabCalls`: a later turn's image is never mistaken
   * for history.
   *
   * The key carries the item TYPE as well as the id. Ids are only documented
   * unique within an item type, so a bare id would let an `imageView` silence a
   * same-id `imageGeneration` in the same turn.
   */
  private renderImageItem(item: ImageItem, phase: 'started' | 'completed', params: Record<string, unknown>): AgentEvent[] {
    const key = `${item.type}:${item.id}`;
    if (this.renderedImageItems.has(key)) return [];
    const events = imageItemEvents(item, phase, this.messageIdentity(params, 'img', key));
    if (events.length > 0) this.renderedImageItems.add(key);
    return events;
  }

  /**
   * P3.308 — codex accepted the permission profile and then could not build a
   * sandbox from it, so NOTHING in this session can run.
   *
   * ## The shape of the defect, and why it needed a different platform to see
   *
   * `verifyPermissionProfileAccepted` (`codex-agent.ts`) refuses a session whose
   * profile the binary threw away, keyed on `permissionProfile/list` reporting
   * `allowed: false`. That is the darwin signal and it is the RIGHT one there.
   * On Linux the same class of bad profile is reported **`allowed: true`** and
   * kills every sandboxed exec instead — a control that OVER-controls, with the
   * opposite sign from the fail-open the detector was built for, and completely
   * silent in band.
   *
   * ## Driven on the real Linux binary, four arms, two of them controls
   *
   * `scripts/platform-rig/run-linux-codex-probe.mjs` — `rust-v0.148.0`
   * aarch64-unknown-linux-musl, in `docker run --network none`, 2026-09-03:
   *
   * | arm | `permissionProfile/list` | read the decoy `.env` | read a plain file |
   * | --- | --- | --- | --- |
   * | no profile (CONTROL) | absent | exit 0, `SECRET=decoy-value` — leaks | exit 0, content |
   * | a deny on something else (CONTROL) | `allowed: true` | exit 0, `SECRET=decoy-value` — leaks | exit 0, content |
   * | root-anchored `/**` + `/.env` | **`allowed: true`** | exit 1, `error building bubblewrap command: Fatal error: unreadable glob …` | **exit 1, the SAME error** |
   * | P3.175's `:workspace_roots` + `**` + `/.env` | `allowed: true` | exit 0, **empty stdout — denied** | exit 0, content |
   *
   * Both controls leak the decoy, which is what makes the third row a reading
   * rather than a dead rig. The third row's second column is the whole finding:
   * a PLAIN read of a non-secret file dies too, so this is not a deny doing its
   * job — it is the sandbox failing to exist.
   *
   * ## Why this is a recogniser and not a signature edit
   *
   * There is nothing to widen. `permissionProfile/list` answers `allowed: true`,
   * which is the only in-band signal the startup check has, and it is TRUE — the
   * profile really was accepted. The failure lives one layer down, at sandbox
   * construction, and surfaces only in the output of a command that tried to
   * run. So the honest fix reads that output.
   *
   * ## And why a fourth column of that table is the reason it must be recognised
   *
   * A denied read on Linux is **exit 0 with empty stdout** (the fourth arm),
   * where darwin's seatbelt answers `Operation not permitted`. A host that
   * recognised a denial by its darwin error text would read the Linux denial as
   * a success — so "look at the text" is exactly the instinct that fails here,
   * and this method deliberately keys on the CONSTRUCTION mechanism instead.
   *
   * Durable `info` + `level: 'warning'` — the one family the session layer
   * persists, per the `imageItemEvents` docblock — because a session that cannot
   * run a command is not something to discover by scrolling. Once per session.
   */
  private sandboxConstructionFailureEvents(output: string): AgentEvent[] {
    if (this.reportedSandboxConstructionFailure) return [];
    if (!output.toLowerCase().includes(CODEX_SANDBOX_CONSTRUCTION_SIGNATURE)) return [];
    this.reportedSandboxConstructionFailure = true;
    const glob = codexUnreadableGlob(output);
    return [{
      type: 'info',
      level: 'warning',
      message: 'Codex ACCEPTED THIS SESSION\'S PERMISSION PROFILE AND THEN COULD NOT BUILD A SANDBOX '
        + 'FROM IT, so every command in this session fails before it starts — this is not one command '
        + 'failing. The profile check passed because it asks whether the profile was accepted, and it '
        + 'was; the sandbox is constructed later and separately.'
        + (glob ? ` The pattern codex could not expand is \`${glob}\`.` : '')
        + ' A filesystem deny anchored at the filesystem root cannot be expanded on Linux; the'
        + ' portable spelling is the same pattern under `:workspace_roots`.',
    }];
  }

  /**
   * P3.294 · codex's reasoning, on the SAME surface Pi and claude already use.
   *
   * Native-first: nothing is built here. Codex publishes the reasoning item, and
   * `text_complete` + `isIntermediate` + `isThinking` is the shape both other
   * runtimes already emit (`backend/claude/event-adapter.ts::extractThinkingEvents`,
   * `backend/pi/event-adapter.ts::flushThinking`), so the renderer draws the same
   * `thinking` activity — a different icon, and deliberately out of the collapsed
   * turn preview, because reasoning costs the user an explicit expand
   * (`core/types/message.ts::isThinking`). A switch now shows the same thing.
   *
   * `content` first, then `summary`, and never both: they are two renderings of
   * the same reasoning, and a provider that withholds the raw text answers with
   * a summary instead. Emitting both would print the model's thinking twice on
   * whichever provider fills both arrays.
   *
   * One event PER ENTRY rather than one joined blob, matching claude's
   * per-block rows; empty and whitespace-only entries yield nothing, so a
   * withheld or redacted reasoning cannot produce a blank row. The turnId MUST
   * differ from the message's own — the renderer looks a `text_complete` up by
   * turnId across the transcript, so a shared id would let the final answer
   * overwrite the reasoning row (claude's adapter records the same trap).
   */
  private reasoningItemEvents(item: ReasoningItem, params: Record<string, unknown>): AgentEvent[] {
    const source = (item.content?.length ? item.content : item.summary) ?? [];
    const events: AgentEvent[] = [];
    source.forEach((raw, index) => {
      const text = typeof raw === 'string' ? raw : '';
      if (!text.trim()) return;
      events.push({
        type: 'text_complete',
        text,
        isIntermediate: true,
        isThinking: true,
        turnId: this.messageIdentity(params, 'thinking', `${item.id}#${index}`),
      });
    });
    return events;
  }

  /**
   * P3.295 · the plan, on the host's plan/todo surface.
   *
   * The surface is a TOOL ROW: both host plan views key on the tool name —
   * `TodoListCard.isTodoWriteActivity` (the inline card) and
   * `packages/ui/chat/task-checklist.ts` (the `/tasks` checklist panel) — and
   * read `toolInput.todos`. Pi and claude reach it by calling a tool. Codex
   * cannot: measured on the shipped binary, a real `update_plan` call produces
   * `turn/plan/updated` and **no thread item at all**, so there is no row to
   * mirror and this one is synthesized from the notification.
   *
   * Named `update_plan`, which is codex's OWN tool name and the one the model
   * actually called — not `TodoWrite`. Two reasons, and the second is the
   * measured one: this adapter's standing rule is that a transcript row shows
   * codex's own name for the call ({@link mcpRowToolName}), and the same session
   * may ALSO carry a bridged `mcp__session__TodoWrite`, so borrowing that name
   * would make the native plan indistinguishable from the bridged tool. Both
   * host views were taught the second name instead; "newest wins" already
   * decides between them.
   *
   * The steps ride BOTH the input and the result, deliberately: the card reads
   * `toolInput.todos` and falls back to parsing `{todos}` out of the result, and
   * a row recovered from storage may have only one of the two.
   */
  private planUpdateEvents(params: Record<string, unknown>): AgentEvent[] {
    const steps = Array.isArray(params.plan) ? params.plan : [];
    const todos = steps.flatMap((raw) => {
      const step = (raw ?? {}) as { step?: unknown; status?: unknown };
      const content = typeof step.step === 'string' ? step.step.trim() : '';
      return content ? [{ content, status: mapCodexPlanStatus(step.status) }] : [];
    });
    // An update carrying no readable step is not a plan; painting an empty card
    // would tell the user the model cleared its plan when it did not.
    if (todos.length === 0) return [];
    const explanation = typeof params.explanation === 'string' ? params.explanation.trim() : '';
    const id = this.messageIdentity(params, 'plan', String(this.planUpdatesThisTurn++));
    return [
      this.createToolStart(id, CODEX_PLAN_TOOL_NAME, {
        todos,
        ...(explanation ? { explanation } : {}),
      }),
      this.createToolResult(id, CODEX_PLAN_TOOL_NAME, JSON.stringify({ todos }), false),
    ];
  }

  /**
   * P3.295 · the EXPERIMENTAL streamed plan item, handled exactly as
   * `agentMessage` is: the deltas stream under one identity and the completed
   * item replaces them, because the schema says outright that the completed item
   * "is authoritative and may not match the concatenation of `PlanDelta` text".
   *
   * Intermediate, never final: this is the model narrating its plan between tool
   * calls, so it must not be eligible for promotion into the response bubble.
   * NOT marked `isThinking` — it is a stated plan, not withheld reasoning, and
   * the two draw different rows on purpose.
   *
   * Measured absent on this fork's wire and handled anyway, which is the honest
   * order: a real `update_plan` run emitted no `plan` item and no
   * `item/plan/delta`, and `from-chat-stream.ts` synthesizes only `message` and
   * `function_call` items, so nothing on the gateway path can produce one today.
   * A first-party Responses upstream can, and the cost of being ready is six
   * lines against a silent drop.
   */
  private planItemText(item: PlanItem, params: Record<string, unknown>): AgentEvent[] {
    const text = typeof item.text === 'string' ? item.text : '';
    if (!text.trim()) return [];
    return [{
      type: 'text_complete',
      text,
      isIntermediate: true,
      turnId: this.messageIdentity(params, 'planitem', item.id),
    }];
  }

  /**
   * Map one app-server notification to zero or more AgentEvents. Unknown
   * methods / unmapped item types return `[]`. `thread/tokenUsage/updated` is
   * intentionally NOT mapped here — the agent routes it into its UsageTracker.
   */
  adapt(method: string, params: unknown): AgentEvent[] {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'item/agentMessage/delta': {
        const delta = typeof p.delta === 'string' ? p.delta : '';
        // `itemId` is required by `AgentMessageDeltaNotification`; the literal
        // stand-in keeps a contract-violating notification's deltas keyed
        // consistently WITHIN the turn rather than splitting the message.
        const itemId = typeof p.itemId === 'string' && p.itemId ? p.itemId : 'unknown';
        return delta ? [{ type: 'text_delta', text: delta, turnId: this.messageIdentity(p, 'msg', itemId) }] : [];
      }
      case 'item/commandExecution/outputDelta': {
        const itemId = typeof p.itemId === 'string' ? p.itemId : '';
        const delta = typeof p.delta === 'string' ? p.delta : '';
        if (itemId && delta) this.accumulateOutput(itemId, delta);
        return [];
      }
      // P3.295 · the EXPERIMENTAL plan-item stream. Same identity its completed
      // item will carry, so the renderer finalizes the row it streamed rather
      // than leaving a second one behind — the `agentMessage` pair's rule, and
      // the schema's own warning that the completed item is the authoritative
      // one is exactly why the pair works this way.
      case 'item/plan/delta': {
        const delta = typeof p.delta === 'string' ? p.delta : '';
        const itemId = typeof p.itemId === 'string' && p.itemId ? p.itemId : 'unknown';
        return delta
          ? [{ type: 'text_delta', text: delta, turnId: this.messageIdentity(p, 'planitem', itemId) }]
          : [];
      }
      // P3.295 · the plan itself, structured, and the ONLY channel that carries
      // it on this fork's wire — see `planUpdateEvents`.
      case 'turn/plan/updated':
        return this.planUpdateEvents(p);
      case 'item/started': {
        const item = (p as ItemNotification).item;
        if (isCommandExec(item)) {
          // C3.309 — `'Bash'` is READ by a second module, so a rename here is not
          // local. `uncoveredRewindCategories`
          // (`apps/electron/src/renderer/utils/rewind-report.ts`) lower-cases a
          // transcript row's `toolName` into `UNCHECKPOINTED_COMMAND_TOOLS` to
          // warn that a rewind cannot restore a file a SHELL command rewrote —
          // codex's checkpoint producer is on `apply_patch` (C3.67), the same
          // scope Pi's and claude's file-tool producers have. Spell this anything
          // else and the warning stops firing on codex while Pi and claude keep
          // theirs, silently. The agreement is driven from both ends in
          // `apps/electron/src/renderer/utils/__tests__/codex-shell-edit-rewind-category.test.ts`
          // (the back-pointer P6.551's lesson asks for: this is where the
          // falsifying edit happens).
          // D1.350 · and codex's own classification of that command beside it.
          // Measured on the staged `codex-app-server` (rust-v0.154.0): the field
          // is populated at `item/started` already, identically to
          // `item/completed`, so the frame that opens the row can carry it.
          // Omitted when empty, so a row for a command codex did not classify
          // is byte-identical to what it was before this row.
          const commandActions = readCodexCommandActions(item);
          return [this.createToolStart(item.id, 'Bash', {
            command: item.command,
            ...(commandActions.length > 0 ? { commandActions } : {}),
          })];
        }
        if (isFileChange(item)) {
          return [this.createToolStart(item.id, 'Edit', { changes: item.changes })];
        }
        if (isMcpToolCall(item)) {
          return [this.createToolStart(item.id, mcpRowToolName(item), asRecord(item.arguments) ?? {})];
        }
        if (isCollabToolCall(item)) {
          // A codex agent role spawns a REAL subagent thread, and until this
          // mapping the whole exchange was invisible in the chat — unlike Pi
          // (agent panel + subtask pair) and Claude (Agent tool row).
          const name = COLLAB_TOOL_WIRE_NAMES[item.tool] ?? item.tool;
          this.openCollabCalls.set(item.id, name);
          // P3.4 · learn which child threads this call introduces so their
          // otherwise-foreign notifications can be re-admitted as orchestration
          // progress. Bookkeeping only — the tool row emitted below is unchanged.
          this.registerCollabSpawn(item, p);
          return [this.createToolStart(item.id, name, {
            ...(item.prompt ? { prompt: item.prompt } : {}),
            ...(item.model ? { model: item.model } : {}),
            ...(item.receiverThreadIds?.length ? { agents: item.receiverThreadIds } : {}),
          })];
        }
        if (isImageItem(item)) return this.renderImageItem(item, 'started', p);
        // F1.623 · codex's own hosted search — see {@link webSearchRowInput}.
        if (isWebSearchItem(item)) return [this.createToolStart(item.id, 'WebSearch', webSearchRowInput(item))];
        // P3.294 · a reasoning item's `content`/`summary` are BOTH `[]` at
        // `started` on the shipped binary (measured verbatim, see the file
        // header), so there is nothing to render yet and rendering the same item
        // twice is the failure the `item/completed` branch avoids by being the
        // only one. A `plan` item is empty here for the same reason.
        return [];
      }
      case 'item/completed': {
        const item = (p as ItemNotification).item;
        if (isCommandExec(item)) {
          // F1.1268 — codex's own status says a command it never ran (`declined`: the user refused its escalation) or
          // could not run (`failed`) — neither has an exit code, so the code alone read both as success.
          const unrun = item.status === 'declined' || item.status === 'failed' ? item.status : undefined;
          const output = this.consumeOutput(item.id) ?? item.aggregatedOutput ?? unrun ?? '';
          const isError = typeof item.exitCode === 'number' ? item.exitCode !== 0 : unrun !== undefined;
          return [
            this.createToolResult(item.id, 'Bash', output, isError),
            // P3.308 · the row is BEFORE the row: a command that failed because
            // no sandbox could be built is not a failed command, it is a session
            // that cannot run anything. Emitted after the tool result so the
            // transcript still shows what was attempted.
            ...this.sandboxConstructionFailureEvents(output),
          ];
        }
        if (isFileChange(item)) {
          const isError = item.status === 'failed' || item.status === 'declined'; // F1.1268 — `PatchApplyStatus` has `declined` too
          return [this.createToolResult(item.id, 'Edit', item.status ?? 'applied', isError)];
        }
        if (isMcpToolCall(item)) {
          // `error` and a `failed` status are independent signals: the item can
          // fail with no error object, and a populated `error` is a failure even
          // if the status did not say so.
          const isError = item.status === 'failed' || !!item.error;
          const result = isError
            ? (item.error?.message || extractMcpResultText(item.result?.content) || 'MCP tool call failed')
            : extractMcpResultText(item.result?.content);
          return [
            this.createToolResult(
              item.id,
              mcpRowToolName(item),
              result,
              isError,
              undefined,
              asRecord(item.result?.structuredContent),
            ),
          ];
        }
        if (isAgentMessage(item)) {
          // Same identity its deltas carried — `AgentMessageDeltaNotification`'s
          // `itemId` IS this item's `id`, so the renderer finalizes the bubble
          // it streamed instead of adopting whichever one streamed last.
          //
          // P6.102 · and codex's OWN turn id beside it, when the notification
          // carried one. `turnId` above is a per-MESSAGE identity minted by
          // {@link CodexEventAdapter.messageIdentity} — it has to be, or two
          // messages in one turn overwrite each other in the renderer — so it
          // cannot serve as `thread/fork`'s `lastTurnId`. Stating the wire value
          // in its own field keeps the host off this adapter's private format:
          // the alternative was splitting `<base>__<kind>:<id>` in
          // `SessionManager`, which would also silently accept the synthetic
          // `turn<n>` fallback base as if it were a real codex turn.
          // The WIRE value only, deliberately narrower than
          // {@link CodexEventAdapter.messageIdentity}'s base. That base prefers
          // `this.currentTurnId` and falls back to a synthetic `turn<n>`, and
          // NEITHER is a codex turn: `currentTurnId` is whatever a call site
          // passed to `startTurn` (no production caller passes one — codex's
          // single site is `codex-agent.ts`'s bare `startTurn()`), and `turn<n>`
          // is this adapter's own counter. A render identity may be invented; a
          // `lastTurnId` may not, because the server would either refuse it or,
          // worse, resolve it to a turn the user did not point at.
          const wireTurnId = typeof p.turnId === 'string' && p.turnId ? p.turnId : undefined;
          return [{
            type: 'text_complete',
            text: item.text,
            turnId: this.messageIdentity(p, 'msg', item.id),
            ...(wireTurnId ? { runtimeTurnId: wireTurnId } : {}),
          }];
        }
        if (isContextCompaction(item)) return this.observedCompaction();
        if (isCollabToolCall(item)) {
          this.openCollabCalls.delete(item.id);
          // P3.4 · a completed collab call carries each target's latest state;
          // fold it into the run so the final progress snapshot is current.
          this.registerCollabSpawn(item, p);
          const isError = item.status === 'failed';
          const summary = collabAgentsSummary(item);
          const result = summary
            || (item.receiverThreadIds?.length ? `agents: ${item.receiverThreadIds.join(', ')}` : (item.status ?? 'completed'));
          return [this.createToolResult(item.id, COLLAB_TOOL_WIRE_NAMES[item.tool] ?? item.tool, result, isError)];
        }
        if (isImageItem(item)) return this.renderImageItem(item, 'completed', p);
        if (isWebSearchItem(item)) {
          // F1.623 · the start AGAIN, now carrying the query codex only knows
          // at completion (SessionManager merges a repeated start into the
          // row), then the result. See {@link webSearchRowInput}.
          return [
            this.createToolStart(item.id, 'WebSearch', webSearchRowInput(item)),
            this.createToolResult(item.id, 'WebSearch', webSearchResultText(item), false),
          ];
        }
        if (isReasoningItem(item)) return this.reasoningItemEvents(item, p);
        if (isPlanItem(item)) return this.planItemText(item, p);
        return [];
      }
      // P3.2 · codex's NATIVE auto-review guardian. Every notification of this
      // family died in `default:` before this row — the three that existed then
      // (`item/autoApprovalReview/{started,completed}` and `guardianWarning`),
      // and `autoApprovalReview/strictReviewRequired`, which arrived with
      // `rust-v0.150.1` and is handled below by P6.1065. The count is
      // deliberately not written as a number: this family has grown once and a
      // number beside a `case` list ages without anything pointing at it.
      // Surfaced on the status/info family the
      // existing consumers read — momentary `status` for the in-flight review and
      // the routine approval, durable `info` + `level: 'warning'` for a denial,
      // a warning, or a timeout/abort (the ONE channel `SessionManager` persists,
      // per the `imageItemEvents` docblock). No new event shape; no i18n (the
      // session layer keyword-matches these frozen strings).
      case 'item/autoApprovalReview/started':
        // Momentary — a review is in flight, immediately superseded by its
        // completion. Mirrors the transient `Compacting context...` status.
        this.autoReviewPhaseShown = true; // F1.1150 — a phase label, cleared by the completion below
        return [{ type: 'status', message: 'Auto-reviewing this action...', phase: true }];
      case 'item/autoApprovalReview/completed': {
        const shown = this.autoReviewPhaseShown; this.autoReviewPhaseShown = false; // F1.1150 — clear only a label this review put up
        return [...(shown ? [{ type: 'status' as const, message: '', phase: true as const }] : []), ...this.guardianReviewCompleted(
          (p as { review?: GuardianApprovalReviewLike }).review,
          (p as { action?: unknown }).action,
        )];
      }
      // P6.1065 · the FOURTH notification of this family, and the one that was
      // still dying in `default:`. It is not a verdict — it is codex's own
      // reviewer saying its cached assessment cannot answer and a strict review
      // is required for this turn. DURABLE + `warning` for the reason the denial
      // line above is: a safety demand that survives a reload is the point, and
      // nothing supersedes it within the turn the way the momentary `status`
      // lines are superseded.
      //
      // {@link describeStrictReviewRequired} is the single sentence, and it sits
      // in the approval bridge beside `describeGuardianReviewAction` — same
      // vocabulary, one place — with the source reading of WHEN the frame fires
      // and the measured reason it cannot arrive on a session yet.
      case CODEX_STRICT_REVIEW_REQUIRED_METHOD: {
        const demand = describeStrictReviewRequired(p);
        return demand ? [{ type: 'info', message: demand, level: 'warning' }] : [];
      }
      case 'guardianWarning': {
        // `GuardianWarningNotification = { threadId, message }` — a concise
        // warning meant for the user; durable so it survives a reload.
        const warning = typeof p.message === 'string' ? p.message.trim() : '';
        return warning ? [{ type: 'info', message: `Guardian: ${warning}`, level: 'warning' }] : [];
      }
      // Deprecated in the contract ("Use `ContextCompaction` item type instead")
      // but still emitted by the app-server we bundle, so both arrive here and
      // both are handled. The item branch above is the one a newer server uses.
      case 'thread/compacted':
        return this.observedCompaction();
      // P6.449 · codex's own hook-run channel, READ.
      //
      // `HookCompletedNotification = { threadId, turnId, run: HookRunSummary }`
      // and `HookRunSummary` carries `eventName`, `handlerType`, `scope`,
      // `sourcePath`, `source`, `status`, `statusMessage`, `durationMs` and
      // `entries: HookOutputEntry[]`. So codex has the structured shape claude's
      // `SDKHookResponseMessage` has, by another name — what neither supplies is
      // AGREEMENT, which is why both go through `reportHookRun`.
      //
      // `hook/started` is deliberately NOT read: its `run.status` is `running`,
      // it carries no outcome, and there is nothing to report until the
      // completion arrives. Holding the started run to pair it with its
      // completion needs a per-session run store — the host VIEW half, which
      // W7-s2 recorded as a row of its own.
      case 'hook/completed':
        return this.hookRunEvents(p);
      case 'turn/completed': {
        // A REFUSED collab call (unknown agent_type) gets `item/started` and
        // never an `item/completed` — measured live on the CDX-ROLES gate —
        // so without this close-out its transcript row spins forever.
        const dangling = [...this.openCollabCalls].map(([id, name]) =>
          this.createToolResult(id, name, 'The runtime sent no completion for this call — it was refused before an agent existed.', true));
        this.openCollabCalls.clear();
        // P6.55 · a turn whose context refilled after every summary ends NAMED.
        // The reason is the shared wire value Pi's guard already produces, so
        // the same ending reads the same on both runtimes.
        // P6.443 · the turn's VERDICT, not just the error line above it. A
        // terminal `ErrorNotification` recorded by `codex-agent.ts` names this
        // ending in the same vocabulary a claude run uses, so the transcript
        // renders the same one-line notice on both. The thrash guard keeps
        // precedence: it describes an ending the error stream cannot, and P6.55
        // already made that reason read identically on both runtimes.
        const errorReason = this.pendingTerminalReason;
        this.pendingTerminalReason = undefined;
        return [
          ...dangling,
          this.autoCompactionThrashGuard.isTripped
            ? { type: 'complete', terminalReason: AUTO_COMPACTION_THRASHING_REASON }
            : errorReason
              ? { type: 'complete', terminalReason: errorReason }
              : { type: 'complete' },
        ];
      }
      case 'thread/started': {
        // P3.4 · `ThreadStartedNotification = { thread }` carries no top-level
        // `threadId`, so it is not foreign and reaches here. When it announces a
        // thread we already know as one of our spawned children (`parentThreadId`
        // set, and in a run's roster), adopt its `agentNickname`/`agentRole` as
        // the card label and surface an early roster snapshot. A thread we do not
        // recognise — the parent's own start, or an unrelated one — is ignored.
        const thread = (p as { thread?: {
          id?: unknown; parentThreadId?: unknown; agentRole?: unknown; agentNickname?: unknown;
        } }).thread;
        const childId = typeof thread?.id === 'string' ? thread.id : '';
        if (!childId) return [];
        const runId = this.childThreadToRun.get(childId);
        if (!runId) return [];
        const run = this.orchestrationRuns.get(runId);
        if (!run) return [];
        const agent = this.ensureAgent(run, childId);
        const nickname = typeof thread?.agentNickname === 'string' ? thread.agentNickname : '';
        const role = typeof thread?.agentRole === 'string' ? thread.agentRole : '';
        if (nickname || role) agent.label = nickname || role;
        if (role) agent.agentType = role;
        return [this.progressEvent(run)];
      }
      default:
        return [];
    }
  }

  /** F1.1150 — the in-flight review's phase label is up (`item/autoApprovalReview/started`), so its completion clears it. */
  private autoReviewPhaseShown = false;

  /**
   * The verdict half of codex's auto-review. `approved` is the routine happy
   * path and rides a momentary `status` (the action itself is already in the
   * transcript); `denied` and every non-terminal/error status ride a durable
   * `info` + `level: 'warning'` so they survive a reload. The breaker counts
   * ONLY `denied` — mirroring "3 consecutive judge denies" — and its one-shot
   * trip signal appends the fall-back notice exactly once.
   *
   * P2.417 · the two DURABLE lines — the denial and the non-terminal
   * timeout/abort — name the action via {@link guardianActionPhrase}. The two
   * momentary `status` lines (`Auto-reviewing this action...` and the approved
   * verdict) deliberately do NOT, and that is the stated residue of this row:
   * they are superseded within the same turn and nothing is being withheld from
   * a user who needs to act, whereas a warning that survives a reload and names
   * nobody is the defect the row exists to close.
   */
  private guardianReviewCompleted(review: GuardianApprovalReviewLike | undefined, action?: unknown): AgentEvent[] {
    const status = typeof review?.status === 'string' ? review.status : '';
    if (status === 'approved') {
      this.autoReviewBreaker.recordCompletedReview(false);
      return [{ type: 'status', message: `Auto-review approved this action${guardianRiskSuffix(review)}` }];
    }
    if (status === 'denied') {
      this.lastGuardianDeniedAction = action;
      const tripped = this.autoReviewBreaker.recordCompletedReview(true);
      const events: AgentEvent[] = [{
        type: 'info',
        message: `Auto-review denied ${guardianActionPhrase(action)}`
          + `${guardianRationaleSuffix(review)}${guardianRiskSuffix(review)}`,
        level: 'warning',
      }];
      if (tripped) {
        events.push({
          type: 'info',
          message: `Auto-review has denied ${this.autoReviewBreaker.deniedInWindow} actions, so Codex is interrupting the turn.`,
          level: 'warning',
        });
      }
      return events;
    }
    // timedOut / aborted / any unknown future status: durable notice, and NOT a
    // denial for the breaker (only `denied` counts), so it resets the run.
    this.autoReviewBreaker.recordCompletedReview(false);
    const label = status || 'completed';
    return [{
      type: 'info',
      message: `Auto-review ${label} for ${guardianActionPhrase(action)}${guardianRationaleSuffix(review)}`,
      level: 'warning',
    }];
  }

  /**
   * P3.2 · the `/approve` override entry point. When the user overrules a
   * guardian-denied action (codex's `thread/approveGuardianDeniedAction`, surfaced
   * as `/approve`), the human has won: the breaker closes and its counters clear
   * so surfacing resumes from a clean slate. Returns a durable notice recording
   * the override. The caller that maps `/approve` to
   * `thread/approveGuardianDeniedAction` (CodexAgent) invokes this alongside the
   * request; nothing else drives the breaker's override.
   *
   * P2.417 · it NAMES what was overruled. `action` is accepted for a caller that
   * has the denial in hand; with none, it falls back to
   * {@link lastGuardianDeniedAction} — the same "latest denial" the relay
   * replays — and with neither the sentence is byte-identical to the one this
   * notice has always carried, so an unreadable payload costs nothing.
   */
  notifyGuardianOverride(action?: unknown): AgentEvent[] {
    this.autoReviewBreaker.override();
    const overruled = describeGuardianReviewAction(
      action === undefined ? this.lastGuardianDeniedAction : action,
    );
    return [{
      type: 'info',
      message: overruled
        ? `You approved a guardian-denied request to ${overruled}; auto-review will resume for the rest of this turn.`
        : 'You approved a guardian-denied action; auto-review will resume for the rest of this turn.',
      level: 'warning',
    }];
  }

  /**
   * Re-admit a notification the agent has attributed to a FOREIGN thread when
   * that thread is one of our own spawned children — mapping it to an
   * `OrchestrationProgress` snapshot on a `task_progress` event, keyed by the
   * PARENT turn and anchored to the spawn's transcript row. A thread in no run's
   * roster (a server-side compaction thread, another session, a grandchild we
   * have no anchor for) returns `[]`, so the agent's foreign-thread drop still
   * covers everything genuinely foreign.
   *
   * It never finishes the parent turn, pushes assistant text, or moves the
   * parent's usage — those are exactly what the foreign filter protects and this
   * runs INSIDE that filter. It only reports child progress.
   */
  adaptForeignChildThread(method: string, params: unknown): AgentEvent[] {
    const p = (params ?? {}) as Record<string, unknown>;
    const childId = typeof p.threadId === 'string' ? p.threadId : '';
    if (!childId) return [];
    const runId = this.childThreadToRun.get(childId);
    if (!runId) return [];
    const run = this.orchestrationRuns.get(runId);
    if (!run) return [];
    const agent = this.ensureAgent(run, childId);
    const now = new Date().toISOString();
    agent.lastActivity = now;
    switch (method) {
      case 'turn/started':
        agent.status = 'running';
        if (!agent.startedAt) agent.startedAt = now;
        break;
      case 'turn/completed':
        // A child turn ending is not the child ending — it may take more turns.
        // Mark it done only if nothing later re-opens it (a fresh turn/started
        // flips it back to running); the collab `agentsStates` is the authority
        // on terminal state and lands on the parent thread.
        agent.status = 'done';
        agent.endedAt = now;
        break;
      case 'thread/tokenUsage/updated': {
        const usage = CodexEventAdapter.readTokenUsage(p);
        const breakdown = usage?.total ?? usage?.last;
        if (breakdown) {
          agent.tokensIn = readCodexTokenCount(breakdown, 'input');
          agent.tokensOut = readCodexTokenCount(breakdown, 'output');
        }
        break;
      }
      case 'item/started':
        if (agent.status === 'queued') agent.status = 'running';
        if (!agent.startedAt) agent.startedAt = now;
        if (isToolItem((p as ItemNotification).item)) {
          agent.toolCalls = (agent.toolCalls ?? 0) + 1;
        }
        break;
      case 'item/completed':
        // Tool calls are counted at start; completion only refreshes liveness.
        break;
      case 'thread/status/changed': {
        const status = (p as { status?: { type?: unknown } }).status?.type;
        if (status === 'active' && agent.status === 'queued') agent.status = 'running';
        else if (status === 'systemError') agent.status = 'error';
        break;
      }
      case 'error':
        agent.status = 'error';
        break;
      default:
        // An unmapped child notification still counts as liveness (lastActivity
        // above) but changes nothing else — degrade, never drop the run.
        break;
    }
    return [this.progressEvent(run)];
  }

  /**
   * Learn the child roster a collab call introduces. Pure bookkeeping — it emits
   * nothing, so the collab tool row the adapter already produces is unchanged.
   * Each NEW child is anchored to the collab call that first names it; a later
   * `wait`/`send_input` on the same children reuses that anchor rather than
   * opening a second run.
   *
   * `receiverThreadIds` is the authoritative id list ("the newly spawned agent"
   * ids, a required array). The per-agent state lives under `agentsStates` in the
   * pinned generated type but under `agents` in the shape this adapter and its
   * tests were built against — the binding lags the binary both ways, so BOTH
   * are read and the union of keys taken.
   */
  private registerCollabSpawn(item: CollabToolCallItem, params: Record<string, unknown>): void {
    const states = item.agentsStates ?? item.agents ?? {};
    const childIds = new Set<string>([
      ...(item.receiverThreadIds ?? []),
      ...Object.keys(states),
    ]);
    if (childIds.size === 0) return;
    // UA12.99 — a spawn's children join the SESSION-scoped roster too (a failed spawn started nothing).
    if (item.tool === 'spawnAgent' && item.status !== 'failed') for (const childId of childIds) this.registerSpawnedChild(childId);
    const turnId = typeof params.turnId === 'string' && params.turnId ? params.turnId : this.currentTurnId;
    for (const childId of childIds) {
      let runId = this.childThreadToRun.get(childId);
      if (!runId) {
        runId = item.id;
        this.childThreadToRun.set(childId, runId);
      }
      let run = this.orchestrationRuns.get(runId);
      if (!run) {
        run = { toolUseId: runId, turnId, agents: new Map<string, OrchestrationProgressAgent>() };
        this.orchestrationRuns.set(runId, run);
      } else if (run.turnId === null && turnId !== null) {
        run.turnId = turnId;
      }
      const agent = this.ensureAgent(run, childId);
      const state = states[childId];
      if (state?.status) agent.status = mapCollabAgentStatus(state.status);
    }
  }

  /**
   * UA12.99 · the `spawn_agent` children of this SESSION, each with whether its turn is running now.
   *
   * The maps above are turn-scoped (a spawn and its `wait` live in one parent turn), but a child the parent did not
   * wait for outlives that turn, and codex does not wake the parent when it ends: read at `rust-v0.159.3` (the shipped
   * `codex-app-server 0.159.3`), `LocalAgentControl::notify_parent_of_terminal_turn`
   * (`core/src/agent/control/completion.rs`) queues the result as an `InterAgentCommunication` with
   * `trigger_turn: false`, and the legacy path `inject_fragment_without_turn` (`core/src/agent/control.rs`) — the
   * parent reads it at its NEXT turn. So the host counts the child itself, from the child's own lifecycle, which
   * reaches `CodexAgent.handleNotification`'s foreign-thread branch whether or not a parent turn is open
   * ({@link noteSpawnedChildLifecycle}). Only `spawnAgent` registers: it always starts a child turn, so its end is
   * always announced; `listAgents`/`resumeAgent` can name children that start nothing, which would latch.
   * A lifecycle seen BEFORE the spawn's `item/completed` names the child (a fast child) is kept in
   * `unclaimedChildRunning` and claimed at registration. Both maps are bounded.
   *
   * Like {@link knownBackgroundTerminals} this is PER-CONNECTION state: the children are threads inside the
   * app-server process, so a teardown (`/clear`, a restart) kills them with it and no `turn/completed` or
   * `thread/closed` can arrive for them afterwards. {@link resetBackgroundTerminals} — which `teardownRuntime`
   * already calls — forgets both maps, or a child alive at the teardown would read as running for the agent's life
   * and hold a board node's settlement gate forever. Residue, stated: a lifecycle notification lost on a LIVE
   * connection still latches the SETTLEMENT level (nothing reconciles the roster from a thread listing; the node's
   * own deadline bounds it) — the liveness level is bounded instead ({@link freshRunningSpawnedChildCount}).
   *
   * UA12.191 · each entry also keeps whether the child has run a turn yet (`turnSeen`: a `systemError` before any
   * turn is an init failure that ends it) and when it last sent ANY notification (`lastSeenAt`, the liveness bound).
   */
  private readonly spawnedChildRunning = new Map<string, SpawnedChildState>();
  private readonly unclaimedChildRunning = new Map<string, boolean>();
  private static readonly SPAWNED_CHILD_MEMORY = 256;

  /**
   * UA12.191 (P-LF-5-1) · how long a running child may stay SILENT (no notification of its thread at all) and still
   * hold its session against the idle reaper and the live-agent ceiling ({@link freshRunningSpawnedChildCount}).
   * Equal to the idle reaper's default TTL (`DEFAULT_IDLE_AGENT_TTL_MS`, `server-core` `live-agent-ceiling.ts`, not
   * importable from here): a child that says nothing for as long as the reaper waits for an idle session is treated as
   * the reaper treats that session, so a roster entry whose end never arrives delays a reap by at most this long, once.
   * Residue, stated: a child turn that streams nothing for longer (one silent `sleep 3600` tool call) stops counting
   * there and its session may be reaped while it runs, exactly as before UA12.191.
   */
  static readonly SPAWNED_CHILD_LIVENESS_BOUND_MS = 30 * 60_000;

  private registerSpawnedChild(childId: string): void {
    if (this.spawnedChildRunning.has(childId)) return;
    const seen = this.unclaimedChildRunning.get(childId);
    this.unclaimedChildRunning.delete(childId);
    // Spawned and not yet seen: pending init counts as running. A verdict seen before the spawn named it is kept.
    this.spawnedChildRunning.set(childId, { running: seen ?? true, turnSeen: seen !== undefined, lastSeenAt: Date.now() });
    CodexEventAdapter.boundMemory(this.spawnedChildRunning);
  }

  /**
   * UA12.99 · a foreign thread's lifecycle, forwarded by `CodexAgent` beside F1.493's: `turn/started` → running;
   * `turn/completed` (any status) → not running (a child turn ending is not the child ending — a later `send_input`
   * re-opens it); `thread/closed` → forgotten. A thread no spawn named only waits in the unclaimed map, so a review or
   * compaction thread never counts.
   *
   * UA12.191 (P-LF-5-3) · `thread/status/changed` `systemError` from a child that has run NO turn → not running: read
   * at `rust-v0.159.3`, `ThreadWatchManager::note_system_error` (`app-server/src/thread_status.rs`, called on every
   * `EventMsg::Error` by `bespoke_event_handling.rs`) clears the thread's `running` flag, so a child that failed before
   * its first turn (and is never closed) ends there instead of holding a node. Inside a running turn it is ignored:
   * codex raises errors that leave the turn going (`CodexErrorInfo::affects_turn_status` is false for
   * `ActiveTurnNotSteerable` and `ThreadRollbackFailed`), and that turn's `turn/completed` ends it either way. Every
   * notification of a spawned child, whatever its method, renews its liveness (`lastSeenAt`).
   *
   * UA12.204 (P-LG-4-1) · a GRANDCHILD: with `[agents].max_depth` above 1 a child can spawn its own child, and only the
   * parent thread's collab items ({@link registerCollabSpawn}) registered, so a node settled while the grandchild ran.
   * A registered child's own `item/completed` `spawnAgent` (not failed) registers the children it names, so the roster
   * follows any depth; a spawn from a thread no spawn named (a review or compaction thread) registers nothing.
   */
  noteSpawnedChildLifecycle(method: string, params: unknown): void {
    const threadId = (params as { threadId?: unknown } | null | undefined)?.threadId;
    if (typeof threadId !== 'string' || threadId.length === 0) return;
    const child = this.spawnedChildRunning.get(threadId);
    if (child) child.lastSeenAt = Date.now();
    if (method === 'item/completed') {
      const item = (params as { item?: ThreadItemLike }).item;
      if (!child || !isCollabToolCall(item) || item.tool !== 'spawnAgent' || item.status === 'failed') return;
      const grandchildIds = new Set([...(item.receiverThreadIds ?? []), ...Object.keys(item.agentsStates ?? item.agents ?? {})]);
      for (const grandchildId of grandchildIds) if (grandchildId !== threadId) this.registerSpawnedChild(grandchildId);
      return;
    } else if (method === 'thread/closed') {
      this.spawnedChildRunning.delete(threadId);
      this.unclaimedChildRunning.set(threadId, false);
    } else if (method === 'turn/started' || method === 'turn/completed') {
      const running = method === 'turn/started';
      if (child) { child.running = running; child.turnSeen = true; } else this.unclaimedChildRunning.set(threadId, running);
    } else if (method === 'thread/status/changed'
      && (params as { status?: { type?: unknown } }).status?.type === 'systemError') {
      if (child) { if (!child.turnSeen) child.running = false; } else if (!this.unclaimedChildRunning.has(threadId)) this.unclaimedChildRunning.set(threadId, false);
    } else return;
    CodexEventAdapter.boundMemory(this.unclaimedChildRunning);
  }

  /** UA12.99 · how many of this session's `spawn_agent` children are running a turn now (the settlement level). */
  get runningSpawnedChildCount(): number {
    let running = 0;
    for (const child of this.spawnedChildRunning.values()) if (child.running) running += 1;
    return running;
  }

  /**
   * UA12.191 (P-LF-5-1) · the running children that have sent a notification within
   * {@link SPAWNED_CHILD_LIVENESS_BOUND_MS} of `now` — the part of the roster `CodexAgent.backgroundWorkCount` (the idle
   * reaper's and the ceiling's liveness level) counts. Time-bounded, so it cannot latch: an entry whose end never
   * arrives drops out once it has been silent for the bound, and any later notification of the child brings it back.
   */
  freshRunningSpawnedChildCount(now: number = Date.now()): number {
    let running = 0;
    for (const child of this.spawnedChildRunning.values()) {
      if (child.running && now - child.lastSeenAt < CodexEventAdapter.SPAWNED_CHILD_LIVENESS_BOUND_MS) running += 1;
    }
    return running;
  }

  /** Drop the oldest entries past {@link SPAWNED_CHILD_MEMORY} (a Map iterates in insertion order). */
  private static boundMemory(map: Map<string, unknown>): void {
    while (map.size > CodexEventAdapter.SPAWNED_CHILD_MEMORY) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) return;
      map.delete(oldest);
    }
  }

  /** Get-or-create the progress row for one child thread within a run. */
  private ensureAgent(run: CodexOrchestrationRun, childId: string): OrchestrationProgressAgent {
    let agent = run.agents.get(childId);
    if (!agent) {
      agent = { id: childId, label: childId, agentType: 'subagent', status: 'queued', tokensIn: 0, tokensOut: 0 };
      run.agents.set(childId, agent);
    }
    return agent;
  }

  /** A defensive copy of a run's current state as an `OrchestrationProgress`. */
  private buildOrchestrationSnapshot(run: CodexOrchestrationRun): OrchestrationProgress {
    return {
      kind: 'subagent',
      runId: run.toolUseId,
      agents: [...run.agents.values()].map(agent => ({ ...agent })),
    };
  }

  /** The `task_progress` carrier for a run, keyed by its anchor row and parent turn. */
  private progressEvent(run: CodexOrchestrationRun): AgentEvent {
    return {
      type: 'task_progress',
      toolUseId: run.toolUseId,
      orchestrationProgress: this.buildOrchestrationSnapshot(run),
      ...(run.turnId ? { turnId: run.turnId } : {}),
    };
  }

  /**
   * F1.467 — did the HOST ask for the compaction this adapter just observed?
   *
   * Neither of codex's compaction channels says which compaction it was, at the pinned
   * tag (`packages/codex-protocol/manifest.json`): the `contextCompaction` item is
   * `{ type, id }`, the deprecated `thread/compacted` is `{ threadId, turnId }`, and no
   * `Turn` field names a compact turn. The host knows — it asks with `thread/compact/start`
   * — so `codex-agent.ts` sets this to read `manualCompactionRequestedForTurn`, the SAME
   * flag its `PostCompact` hook reads (P6.118), consulted before the hook clears it: the
   * info's `compactionTrigger` and the hook's `trigger` cannot disagree. A settable field for
   * `onHookRun`'s reason (no options bag). Unset — the adapter driven alone — the info stays
   * UNSTAMPED: nothing here can say, and `SessionManager`'s F1.241 gate (`!== 'auto'`) keeps
   * its old reading for a runtime that cannot say.
   */
  isManualCompactionRequested?: () => boolean;

  /** F1.467 — the trigger to stamp, or `undefined` when no host was asked (see above). */
  private observedCompactionTrigger(): 'manual' | 'auto' | undefined {
    if (!this.isManualCompactionRequested) return undefined;
    return this.isManualCompactionRequested() ? 'manual' : 'auto';
  }

  /**
   * P3.3 · reconcile the app-server's current background-terminal list against
   * what we have already announced, returning the existing chip events — the
   * SAME shapes Pi and Claude produce from a backgrounded Bash tool
   * (`shell_backgrounded` / `task_completed` in `tool-matching.ts`), NOT a new
   * codex-specific event.
   *
   * - A terminal we have not seen before → `shell_backgrounded`. The chip row
   *   (`App.tsx:handleBackgroundTaskEvent`) keys the row `id` off `shellId`, and
   *   `SessionManager`'s `shell_backgrounded` case records the handle in
   *   `backgroundShellCommands`.
   * - A terminal that has since exited or dropped out of the list →
   *   `task_completed` with `taskId === shellId`, which is exactly the id the
   *   chip row filters on (`t.id !== evt.taskId`), so the row disappears.
   *
   * A short-lived terminal that appears already-exited in one poll emits both
   * events in order (appeared, then completed) — correct, and harmless.
   *
   * `listResult` is the RAW `thread/backgroundTerminals/list` result; parsing it
   * here (rather than in the agent) keeps the whole synthesis unit-testable
   * without a transport.
   */
  syncBackgroundTerminals(listResult: unknown, options?: { complete?: boolean }): AgentEvent[] {
    const terminals = extractCodexBackgroundTerminals(listResult)
      .map(normalizeCodexBackgroundTerminal)
      .filter((terminal): terminal is CodexBackgroundTerminal => terminal !== null);
    // A TRUNCATED PAGE IS NOT EVIDENCE OF ABSENCE. `nextCursor` is measured on
    // the real wire, and reading a prefix as the whole set produced a wrong
    // user-visible state: with `a` and `b` already known, a page of just `[a]`
    // plus a cursor emitted `task_completed` for `b` — the chip vanished while
    // the process was still running, then re-announced on the next poll. The
    // caller may assert completeness after following the cursor itself; absent
    // that, the result's own cursor decides.
    const complete = options?.complete ?? (readCodexBackgroundTerminalsCursor(listResult) === null);
    const events: AgentEvent[] = [];

    // First sight → announce.
    for (const terminal of terminals) {
      if (this.knownBackgroundTerminals.has(terminal.id)) continue;
      this.knownBackgroundTerminals.set(terminal.id, { command: terminal.command, idKey: terminal.idKey });
      events.push({
        type: 'shell_backgrounded',
        toolUseId: `codex-bgterm:${terminal.id}`,
        shellId: terminal.id,
        ...(terminal.command ? { command: terminal.command, intent: terminal.command } : {}),
      });
    }

    // Exit (present-but-ended) or disappearance → complete and forget.
    //
    // Only DISAPPEARANCE needs the whole set; a terminal that is present and
    // reports its own exit is self-evident on any page, so that arm still fires
    // while paging is incomplete.
    const currentById = new Map(terminals.map(terminal => [terminal.id, terminal]));
    for (const id of [...this.knownBackgroundTerminals.keys()]) {
      const current = currentById.get(id);
      const goneOrExited = current === undefined ? complete : current.exited;
      if (!goneOrExited) continue;
      this.knownBackgroundTerminals.delete(id);
      events.push({
        type: 'task_completed',
        taskId: id,
        status: current?.status ?? 'completed',
      });
    }

    return events;
  }

  /**
   * P6.111 · how many background terminals this connection has announced and not
   * yet retired — the level `CodexAgent.backgroundWorkCount()` reports to the
   * idle reaper and the live-agent ceiling.
   *
   * The map is the only record there is: codex has no between-turns event
   * channel, so membership moves only when {@link observeBackgroundTerminals}
   * runs. That is what makes the AGENT's refresh (not this getter) the half that
   * earns the fix — a count read out of a map nobody refreshed is a level frozen
   * at the last turn boundary.
   */
  get backgroundTerminalCount(): number {
    return this.knownBackgroundTerminals.size;
  }

  /** P3.3 · whether `id` is a background terminal we have announced and not yet completed. */
  isKnownBackgroundTerminal(id: string): boolean {
    return this.knownBackgroundTerminals.has(id);
  }

  /**
   * P3.3 · the key the app-server used for this terminal's id in its own `list`
   * response, so a `terminate` request can name the field the binary expects
   * rather than a guessed one. `undefined` when the id was never announced.
   */
  backgroundTerminalIdKey(id: string): string | undefined {
    return this.knownBackgroundTerminals.get(id)?.idKey;
  }

  /**
   * P3.3 · forget every announced terminal — called when the runtime is torn down. UA12.99 · and every `spawn_agent`
   * child of the roster, which died with the same app-server (see {@link spawnedChildRunning}).
   */
  resetBackgroundTerminals(): void {
    this.knownBackgroundTerminals.clear();
    this.spawnedChildRunning.clear();
    this.unclaimedChildRunning.clear();
  }

  /** Extract the token-usage payload from a thread/tokenUsage/updated notification. */
  static readTokenUsage(params: unknown): CodexTokenUsage | null {
    const usage = (params as { tokenUsage?: CodexTokenUsage } | undefined)?.tokenUsage;
    return usage ?? null;
  }
}

/**
 * F1.623 · `webSearch` — codex's OWN hosted web search, generated
 * `WebSearchItem` (`{ id, query, action: WebSearchAction | null, results }`,
 * generated/WebSearchItem.ts) with `WebSearchAction` from generated/v2:
 * `search {query, queries}` · `openPage {url}` · `findInPage {url, pattern}` ·
 * `other`. Native-first: codex already emits the item, so this is a mapping,
 * not a mechanism. Until this row both arms returned nothing, and since F1.570
 * turned codex's search on for the ChatGPT (Codex) card its searches were
 * invisible there while Pi and Claude show a `WebSearch` row.
 *
 * The lifecycle, read in openai/codex rust-v0.156.1 (`core/src/session/turn.rs`,
 * `core/src/event_mapping.rs`, `core/src/web_search.rs`): `item/started` fires
 * at `response.output_item.added`, when the action is not known yet, so it
 * carries `query: ""` and `{type:'other'}`; `item/completed` carries `query` =
 * codex's own one-line detail of the action (`web_search_action_detail`: the
 * query, `"<first> ..."` for several, the URL for a page, `'<pattern>' in <url>`
 * for a find). That detail is what the row shows — codex's wording, not ours.
 * Because the query only exists at completion, the completed arm re-emits the
 * start with it, the dual-event shape `SessionManager`'s `tool_start` arm
 * merges into the existing row (it is how the Claude SDK delivers a tool's
 * input).
 *
 * Named `WebSearch`, the name Claude's row and Pi's (`permissionName`) carry,
 * so the run summary, the display name and a `WebSearch` PostToolUse hook
 * matcher treat it as they do there. The item has no status or error field, so
 * the result is never an error.
 */
interface WebSearchThreadItem {
  type: 'webSearch';
  id: string;
  query?: string | null;
  action?: { type?: string; queries?: unknown } | null;
  results?: unknown[] | null;
}

function isWebSearchItem(item: ThreadItemLike | undefined): item is WebSearchThreadItem {
  return !!item && item.type === 'webSearch';
}

/** Every query of a `search` action, when codex sent a list. */
function webSearchQueries(item: WebSearchThreadItem): string[] {
  const action = item.action;
  if (action?.type !== 'search' || !Array.isArray(action.queries)) return [];
  return action.queries.filter((q): q is string => typeof q === 'string' && q.length > 0);
}

/**
 * The row's input: codex's `query` detail, and the whole list beside it when a
 * search ran several (the detail then reads `"<first> ..."`). Empty at start.
 */
function webSearchRowInput(item: WebSearchThreadItem): Record<string, unknown> {
  const query = typeof item.query === 'string' ? item.query : '';
  const queries = webSearchQueries(item);
  return {
    ...(query ? { query } : {}),
    ...(queries.length > 1 ? { queries } : {}),
  };
}

/**
 * The row's result. Hosted search hands its results to the MODEL only — the
 * item carries none — so the text says so instead of looking empty. `results`
 * is filled only by codex's standalone search, and it is opaque JSON by
 * codex's own contract ("so new result fields and result types can pass
 * through"), so it is passed through verbatim, not reshaped into links.
 * Both action spellings are read: generated/v2 is camelCase, the core
 * binding (generated/WebSearchAction.ts) snake_case.
 */
function webSearchResultText(item: WebSearchThreadItem): string {
  const detail = typeof item.query === 'string' ? item.query : '';
  const queries = webSearchQueries(item);
  let line: string;
  switch (item.action?.type) {
    case 'search':
      line = queries.length > 1 ? `Searched:\n${queries.map((q) => `- ${q}`).join('\n')}` : `Searched: ${detail}`;
      break;
    case 'openPage':
    case 'open_page':
      line = `Opened: ${detail}`;
      break;
    case 'findInPage':
    case 'find_in_page':
      line = `Found in page: ${detail}`;
      break;
    default:
      line = detail ? `Web search: ${detail}` : 'Web search';
  }
  if (Array.isArray(item.results) && item.results.length > 0) {
    let json: string;
    try {
      json = JSON.stringify(item.results, null, 2);
    } catch {
      json = String(item.results);
    }
    return `${line}\n\n${json}`;
  }
  return `${line}\n\nCodex gives its search results to the model only; they are not reported to this app.`;
}

/** UA12.191 · one `spawn_agent` child of the session roster (`CodexEventAdapter.spawnedChildRunning`). */
interface SpawnedChildState {
  /** Running a turn now (or spawned and not yet seen: pending init). */
  running: boolean;
  /** It has started or ended a turn — a later `systemError` is then a turn's, not an init failure. */
  turnSeen: boolean;
  /** `Date.now()` of its last notification of any method — the liveness bound reads it. */
  lastSeenAt: number;
}
