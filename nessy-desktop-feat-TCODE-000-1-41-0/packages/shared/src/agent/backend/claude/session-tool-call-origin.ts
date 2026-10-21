/**
 * F1.475 — WHICH model tool call a claude session tool is running for, carried from the SDK's in-process MCP
 * handler to the host code that call reaches, so a host card can say whose it is.
 *
 * ## Why the host needs it
 *
 * A turn-bound host card (the Monitor ws/command prompt, `archive_session`'s prompt) is declined when the turn
 * that raised it ends (F1.208 / F1.263) — stamped with that turn's `processingGeneration` since F1.401. A claude
 * BACKGROUND subagent inherits `mcp__session__Monitor` and `archive_session` and outlives its parent turn by
 * design (P6.793), so its card raised while a LATER parent turn runs was stamped with that turn and cancelled
 * "because the turn ended" by a turn that never raised it. The host had no way to tell: a session tool reaches it
 * with the session key and nothing else.
 *
 * ## The handle, measured rather than assumed (vendored `claude` 2.1.251, WJ-yy 2026-09-24)
 *
 * The binary's MCP client sends `_meta: { "claudecode/toolUseId": <tool_use id> }` on every `tools/call`, and the
 * SDK hands it to an in-process tool handler as `extra._meta`. The PreToolUse hook for the SAME call carries the
 * same `tool_use_id` and — only inside a subagent — its `agent_id` (`sdk.d.ts`, `BaseHookInput.agent_id`:
 * "Present only when the hook fires from within a subagent"). A real run (a main-thread call, a background
 * `Agent` whose subagent calls the same tool) read: handler meta `toolu_main_whoami` / `toolu_sub_whoami`, hook
 * `agent_id` absent / `a4cad016e2165d3af`, and that same id as the stream's `task_started` / `task_notification`
 * `task_id` and SubagentStop's `agent_id`. So the tool-use id is the join key, the agent id is the subagent's
 * task id, and its `task_notification` (status `completed`, or `stopped` after `stopTask` or an interrupt) is
 * when it ended.
 *
 * ## Why an async-local scope and not a parameter
 *
 * The call crosses four layers that every runtime shares — the registry handler `(ctx, args)`, the tool
 * context's port (`ctx.monitor.start(input)`, the self-management bindings), the host's port object and the
 * host's authorize method — and on codex the same ports are served over the loopback bridge whose request body
 * is a wire contract. Threading one claude-only field through all of them widens four signatures for one
 * runtime. The scope is set in exactly ONE place (`registryTool` in `session-scoped-tools.ts`, around the
 * handler) and read in exactly one (the host's raise-site stamp), and a read with no scope — Pi, a composer card, a
 * test — answers `undefined`, which is today's behaviour byte for byte. Codex sets it too since F1.493 (2): its
 * bridge runs each request inside the scope, carrying codex's `_meta.callId` and `_meta.threadId` across the socket.
 *
 * It carries the SESSION id beside the tool-use id, and the host reads it only for a card of that session: a
 * scope inherited by work started inside a tool call (a child session's turn, say) cannot stamp another
 * session's card.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface SessionToolCallOrigin {
  /** The session whose session-tool server received the call. */
  readonly sessionId: string;
  /** The model's `tool_use` id, from the MCP request's `_meta["claudecode/toolUseId"]` (codex: its `_meta.callId`). */
  readonly toolUseId: string;
  /**
   * F1.493 (2) — codex only: the thread that made the call (`_meta.threadId`), which is a spawned subagent's own
   * thread when a subagent called the tool. It reaches the host over the loopback bridge
   * (`backend/codex/session-callback-bridge.ts` runs each request inside this scope), and the codex agent answers
   * the host's `subagentOfToolUse(toolUseId, threadId)` from it. Absent on claude, whose agent maps the tool-use id.
   */
  readonly threadId?: string;
  /**
   * F1.631 — codex only: the turn the call was made in (`_meta["x-codex-turn-metadata"].turn_id`), MEASURED on the
   * shipped binary (0.159.3) to EQUAL the `turn/started` `turn.id` the codex agent keeps as its active turn id. The
   * host's raise sites read it to refuse a main-thread card whose turn ended while the raise was in flight
   * (F1.406's codex residue). Absent on claude and Pi, and absent when codex's `_meta` names no turn id.
   */
  readonly turnId?: string;
}

/** The `_meta` key the vendored binary's MCP client writes the tool-use id under (`grep -aoF … | wc -l` → 4 at 2.1.251). */
export const CLAUDE_TOOL_USE_ID_META_KEY = 'claudecode/toolUseId';

const scope = new AsyncLocalStorage<SessionToolCallOrigin>();

/**
 * The origin an in-process MCP handler's `extra` names, or `undefined` when it names none (an older binary, a
 * call that did not come from a model `tool_use`, a malformed value).
 */
export function sessionToolCallOriginOf(sessionId: string, extra: unknown): SessionToolCallOrigin | undefined {
  const meta = (extra as { _meta?: unknown } | null | undefined)?._meta;
  const toolUseId = (meta as Record<string, unknown> | null | undefined)?.[CLAUDE_TOOL_USE_ID_META_KEY];
  return typeof toolUseId === 'string' && toolUseId.length > 0 ? { sessionId, toolUseId } : undefined;
}

/**
 * Run `action` with `origin` in scope. With no origin it runs with NO scope rather than an inherited one: a
 * call that names no tool-use id must not borrow the id of whatever tool call its async context descends from.
 */
export function runInSessionToolCall<T>(origin: SessionToolCallOrigin | undefined, action: () => T): T {
  return origin ? scope.run(origin, action) : scope.exit(action);
}

/** The session-tool call the current async context is running for, when it is one of `sessionId`'s. */
export function currentSessionToolCall(sessionId: string): SessionToolCallOrigin | undefined {
  const origin = scope.getStore();
  return origin && origin.sessionId === sessionId ? origin : undefined;
}
