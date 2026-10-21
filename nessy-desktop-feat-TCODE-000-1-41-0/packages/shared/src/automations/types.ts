/**
 * Automation System Type Definitions
 *
 * All types, interfaces, and type exports for the automations system.
 */

import type { PermissionMode } from '../agent/mode-types.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';
// P6.828 — the ONE observation shape all three runtimes' hook runs reduce to.
// Type-only, and `hook-run-report.ts` imports nothing at all, so this adds no
// module edge at runtime and cannot form a cycle.
import type { HookRunObservation } from '../agent/hook-run-report.ts';
import type { BackgroundTaskEntryV1, SessionCronEntryV1 } from './hook-task-registry.ts';

// ============================================================================
// Event Types
// ============================================================================

/** App events - handled by Nessy */
export type AppEvent =
  | 'LabelAdd'
  | 'LabelRemove'
  | 'LabelConfigChange'
  | 'PermissionModeChange'
  | 'FlagChange'
  | 'SessionStatusChange'
  | 'SchedulerTick';

export interface AgentEventContractV1 {
  readonly version: 1;
  readonly event: string;
  readonly owner: string;
  readonly kind: 'decision' | 'observational';
  readonly ordering: string;
  readonly terminalDelivery: 'once-per-occurrence' | 'once-per-session' | 'once-per-turn';
  readonly correlation: 'session' | 'turn' | 'tool' | 'config';
  readonly redactedPayload: readonly string[];
}

/**
 * Documented Claude hook events this fork deliberately does NOT emit, each
 * mapped to the reason an author is shown wherever one is registered anyway.
 * The reason is prose rather than a code because every consumer here — the
 * automations schema, the hook-settings loader, the config validator and the
 * `automation_management` session tool — puts it in front of a human.
 *
 * `Setup` (R73 · f001). hooks.md#setup: "Fires only when you launch Claude Code
 * with `--init-only`, or with `--init` or `--maintenance` in non-interactive
 * mode with the `-p` flag. It doesn't fire on normal startup." Every occurrence
 * of the event is defined by a launch flag, and its matcher filters on which
 * flag it was (`init` | `maintenance`). Nessy has no such launch mode, so there
 * is no occurrence to project and no `trigger` value anywhere in the process.
 *
 * We used to emit it once per Pi runtime start — which is not an approximation
 * but the exact case the page excludes, and the page's own next sentence says
 * why that is harmful: "For per-session initialization, use SessionStart
 * instead." An author reaches for `Setup` precisely to keep CI-grade work (the
 * page's example is a dependency install) OFF the per-session path, so firing
 * it per session ran the one thing they asked us not to run.
 *
 * Building the launch modes was considered and rejected as disproportionate,
 * not impossible: the documented use case is a plugin's Setup hook, plugin
 * hooks only exist inside a pinned capability view
 * (`buildPinnedAgentAutomationSystem`), and that view is materialized by a
 * session — the same missing session-bootstrap route R73 recorded. A CLI mode
 * that ran only settings-file hooks would fire the wrong subset AND need a
 * direct command spawn outside the ProcessSupervisor isolation profile every
 * other hook command goes through. If a `--init-only` launch mode ever lands,
 * this entry comes out and the contract row goes back into the inventory below.
 */
export const UNEMITTED_HOOK_EVENT_REASONS: Readonly<Record<string, string>> = {
  Setup: 'Setup fires only under Claude Code\'s --init-only / -p --init / -p --maintenance launch modes, which Nessy does not have, so it would never run. Use SessionStart for per-session initialization.',
};

/** Single generated owner for the versioned Nessy lifecycle inventory. */
export const AGENT_EVENT_CONTRACTS_V1 = Object.freeze([
  // `Setup` is deliberately ABSENT from this inventory — see
  // `UNEMITTED_HOOK_EVENT_REASONS` above. This table is what Nessy emits, so an
  // event we cannot emit correctly does not get a row; that absence is what
  // removes it from `AGENT_EVENTS`, from the automations schema and from the
  // `AgentEvent` union, so no surface can register a hook that never fires.
  // hooks.md#instructionsloaded: "Fires when a CLAUDE.md or `.claude/rules/*.md`
  // file is loaded into context [...] at session start for eagerly-loaded files
  // and again later when files are lazily loaded". One occurrence per FILE, not
  // one per session — and the matcher runs against `load_reason`.
  { version: 1, event: 'InstructionsLoaded', owner: 'capability-context-builder', kind: 'observational', ordering: 'per instruction file, as it is loaded into context', terminalDelivery: 'once-per-occurrence', correlation: 'session', redactedPayload: ['file_path', 'memory_type', 'load_reason', 'globs', 'trigger_file_path', 'parent_file_path'] },
  // hooks.md#sessionstart lists five `source` values, two of which (`clear`,
  // `compact`) describe a mid-session restart. `compact` is the one the guide's
  // re-inject-after-compaction recipe matches on, so the event cannot be
  // once-per-session and cannot be owned by the subprocess bridge: the bridge
  // only sees `session_start`, and the host already emits and de-duplicates
  // SessionStart itself. The row now names the emitter that actually runs.
  // D1.202 · the FOUR resume/fork fields SDK 0.3.251 added to
  // `SessionStartHookInput`, and why this row's `redactedPayload` still reads
  // `['source']` alone. DECIDED: deliberately unread, with the reason at each
  // of the three layers that would have had to change.
  //
  // The fields, verbatim from `sdk.d.ts`, all four documented "resume/fork":
  // `seconds_since_last_response` ("seconds since the resumed transcript's last
  // assistant response"), `context_tokens` ("the resumed transcript's last
  // response input + cache_read + cache_creation + output tokens"),
  // `prompt_cache_likely_expired` ("seconds_since_last_response exceeds the
  // prompt-cache TTL, so the first request re-caches context_tokens") and
  // `estimated_cache_write_usd` ("estimated cost of re-caching context_tokens
  // on the session model — the managed modelPricing when set, otherwise list
  // price"). This fork resumes and forks constantly, so the row that raised
  // them was right to ask.
  //
  // (1) They are fields of the CHILD's SessionStart, and on claude the child's
  //     SessionStart does not reach our matchers — measured by W19-r's headless
  //     rig and now structural, since D1.155 moved that emission host-side and
  //     dropped the trusted copy. So the object carrying them is unreachable on
  //     that backend by construction rather than by oversight, and pi and codex
  //     have no counterpart to read at all.
  // (2) Two of the four are ALREADY decided-absent in this tree, for a reason
  //     that is theirs and not this row's: `estimated_cache_write_usd` needs
  //     vendor rates this fork ships no table for, which is exactly why
  //     `SessionManager.modelSwitchCostFields` withholds it and `pricing` from
  //     `PreModelSwitch` — a `0` there would be a false COST report. The SDK's
  //     own gloss says the same thing from the other side: it prices against
  //     "the managed modelPricing when set, otherwise list price", neither of
  //     which this host holds.
  // (3) `prompt_cache_likely_expired` is the INVERSE of a field the host
  //     already emits under another name. `modelSwitchCostFields` fills
  //     `prompt_cache_warm` ("a non-zero cacheReadTokens inside the TTL",
  //     absent rather than false when no turn has reported usage), from
  //     `cacheObservedAt` and the resolved `cache_ttl`. Adding a second
  //     spelling of one question is how two answers to one question drift —
  //     this file's own `PreModelSwitch` comment is the record of that
  //     happening once already.
  //
  // WHAT WAS OWED, and D1.218 paid both halves. The FIELD: `context_tokens` is
  // filled on a `resume` or a `fork` by `SessionManager`'s
  // `withSessionStartContextTokens`, in the one wrapper every host hook event on
  // all three runtimes passes through — so it is uniform by construction rather
  // than by three matching edits, and the call site still wins on conflict. The
  // NAMING DECISION in (3): `prompt_cache_warm` is KEPT and the vendor's inverse
  // spelling `prompt_cache_likely_expired` is never added — one or the other,
  // never both. It is the one this host already emits, it is already what a
  // `PreModelSwitch` matcher reads, and its absence carries a third state the
  // inverse cannot ("no turn has reported usage yet" is neither warm nor
  // expired). A hook wanting the vendor's question negates ours.
  { version: 1, event: 'SessionStart', owner: 'pi-agent', kind: 'observational', ordering: 'after setup and instructions before the first turn, and again after each completed compaction', terminalDelivery: 'once-per-occurrence', correlation: 'session', redactedPayload: ['source'] },
  { version: 1, event: 'UserPromptSubmit', owner: 'lifecycle-bridge', kind: 'observational', ordering: 'before prompt expansion, original prompt only', terminalDelivery: 'once-per-turn', correlation: 'turn', redactedPayload: ['prompt'] },
  // R73 · hooks.md#userpromptexpansion: "Runs when a user-typed command expands
  // into a prompt before reaching Claude." One occurrence per EXPANDED COMMAND,
  // not one per turn — a plain typed message expands nothing and produces none.
  // The owner moved off the subprocess bridge for the same reason
  // `InstructionsLoaded` did: only the host holds the command inventory the five
  // documented fields are read from, so the bridge could never populate them.
  { version: 1, event: 'UserPromptExpansion', owner: 'session-manager', kind: 'observational', ordering: 'when a user-typed command expands, before the expanded prompt is resolved or sent', terminalDelivery: 'once-per-occurrence', correlation: 'turn', redactedPayload: ['expansion_type', 'command_name', 'command_source'] },
  { version: 1, event: 'PreToolUse', owner: 'pi-agent tool executor', kind: 'decision', ordering: 'before tool execution and terminal permission receipt', terminalDelivery: 'once-per-occurrence', correlation: 'tool', redactedPayload: ['tool_name', 'tool_use_id'] },
  { version: 1, event: 'PermissionRequest', owner: 'pi permission-service', kind: 'decision', ordering: 'when interactive approval is required', terminalDelivery: 'once-per-occurrence', correlation: 'tool', redactedPayload: ['tool_name', 'decision_id'] },
  { version: 1, event: 'PermissionDenied', owner: 'pi permission-service', kind: 'observational', ordering: 'after a denied permission decision', terminalDelivery: 'once-per-occurrence', correlation: 'tool', redactedPayload: ['tool_name', 'decision_id', 'error_code'] },
  { version: 1, event: 'PostToolUse', owner: 'pi-agent tool executor', kind: 'observational', ordering: 'after a successful tool result', terminalDelivery: 'once-per-occurrence', correlation: 'tool', redactedPayload: ['tool_name', 'tool_use_id'] },
  { version: 1, event: 'PostToolUseFailure', owner: 'pi-agent tool executor', kind: 'observational', ordering: 'after a failed tool result', terminalDelivery: 'once-per-occurrence', correlation: 'tool', redactedPayload: ['tool_name', 'tool_use_id', 'error_code'] },
  { version: 1, event: 'PostToolBatch', owner: 'lifecycle-bridge', kind: 'observational', ordering: 'after all tool results in a Pi turn', terminalDelivery: 'once-per-turn', correlation: 'turn', redactedPayload: ['correlation_id', 'batch_count', 'error_count'] },
  // hooks.md#notification: "Notification hooks receive `message` with the
  // notification text, an optional `title`, and `notification_type` indicating
  // which type fired" — and the event "Matches on notification type". The row
  // previously listed only title+message, so the matcher had to fall back to
  // the free-text message: a `permission_prompt` matcher never fired and a
  // regex matcher substring-hit unrelated notifications.
  { version: 1, event: 'Notification', owner: 'pi-agent', kind: 'observational', ordering: 'when the agent surfaces a notification', terminalDelivery: 'once-per-occurrence', correlation: 'turn', redactedPayload: ['notification_type', 'title', 'message'] },
  // R32 · hooks.md#messagedisplay: "Runs while an assistant message streams to
  // the screen. […] each time a batch of newly completed lines is ready to
  // render, the hook runs once with those lines and Claude Code renders the
  // hook's replacement text in their place."
  //
  // `owner` is `session-manager` because the HOST owns the display boundary —
  // the batch boundary this fires on is `SessionManager.flushDelta`, not
  // anything the Pi subprocess or the lifecycle bridge can see. `kind` is
  // `observational` because ":1313 — MessageDisplay hooks have no decision
  // control. They can't block the message or change what is stored in the
  // transcript or sent to Claude."
  //
  // `terminalDelivery` is per-occurrence, not per-turn: a turn may stream
  // several assistant messages and each streams several batches. `final` is the
  // end-of-message signal, not an empty `delta` (":1294 — In interactive runs,
  // the final batch's delta is empty when the message ends on a newline, so
  // treat `final`, not a non-empty delta, as the end-of-message signal").
  { version: 1, event: 'MessageDisplay', owner: 'session-manager', kind: 'observational', ordering: 'per batch of completed assistant lines, while the message is displayed', terminalDelivery: 'once-per-occurrence', correlation: 'turn', redactedPayload: ['turn_id', 'message_id', 'index', 'final', 'delta'] },
  // P3.374 · hooks.md#premodelswitch / #postmodelswitch. Both arrived upstream
  // after the roster this inventory was last measured against and were DEFERRED
  // (`plugin.deferred.event_model_switch_no_emitter`) with an honest reason:
  // `SessionManager.updateSessionModel` is a real model-switch seam and we
  // emitted nothing on it. A fail-closed `PreModelSwitch` that never fires lets
  // through exactly the switches it was written to block, which is why this was
  // a defect rather than a missing nicety.
  //
  // `owner` is `session-manager` because the seam is the host's: the switch is
  // applied by `updateSessionModel` and reaches Pi, claude-runtime and codex
  // identically, through the one dispatcher all three share.
  //
  // `kind` is `decision` for Pre — "Can block the switch", and the page makes
  // it fail CLOSED ("A PreModelSwitch hook that doesn't respond before its
  // timeout blocks the switch") — and `observational` for Post, which "can't
  // block, because the model has already changed".
  //
  // The page's other five fields (`context_tokens`, `prompt_cache_warm`,
  // `cache_ttl`, `estimated_cache_write_usd`, `pricing`) describe what
  // re-sending the conversation costs on Anthropic's own pricing. TWO OF THE
  // FIVE are the ones this host has no honest value for — `estimated_cache_write_usd`
  // and `pricing` need vendor rates we do not have, and emitting a 0 would be a
  // false cost report to a hook written to show one. Absent, deliberately.
  //
  // CORRECTED 2026-09-11 (C4.22): this said THREE, counting `cache_ttl` among
  // them. It is not a price — the page defines it as the prompt-cache lifetime
  // Claude Code REQUESTS for the session, `"5m"` or `"1h"`, and this host
  // resolves that itself (`resolvePromptCacheTtl`) and already stamps it on
  // `tokenUsage.cache.ttl`. It is emitted now, and the same resolved lifetime
  // measures `prompt_cache_warm` instead of a five-minute constant.
  //
  // CORRECTED 2026-09-10 (P6.968): this comment said "no honest value for any of
  // them" and was false from P6.377 onward — `context_tokens` and
  // `prompt_cache_warm` are recoverable from `managed.tokenUsage`, and
  // `updateSessionModel` spreads `{@link modelSwitchCostFields}`'s answer into
  // the payload of BOTH events. The falsifying commit edited a different file,
  // which is exactly the shape AGENTS.md §Traps names: an assertion about
  // another module's behaviour has no guard and the module that falsifies it has
  // no reason to look here. The back-pointer is the repair; `SessionManager`
  // carries the reciprocal one.
  //
  // C3.208 (2026-09-12) — the declaration below now lists what is actually
  // emitted. It carried only the four identity fields while the cost fields were
  // spread into both payloads, which is a residue rather than a statement, and
  // P6.968's own correction named it. THREE cost fields, not the two the row was
  // written against: C4.22 had already made `cache_ttl` fillable the day before,
  // which is the same drift one layer down. The guard is in
  // `packages/server-core/src/sessions/SessionManager.model-switch-hooks.test.ts`
  // ("every field the emitter can produce is declared in the contract"), so the
  // next field this host learns to answer reddens a test instead of sitting
  // undeclared for two days. `estimated_cache_write_usd` and `pricing` stay
  // undeclared because they stay unemitted.
  { version: 1, event: 'PreModelSwitch', owner: 'session-manager', kind: 'decision', ordering: 'before a requested model switch is applied, awaited so a block can cancel it', terminalDelivery: 'once-per-occurrence', correlation: 'session', redactedPayload: ['from_model', 'to_model', 'requested_model', 'source', 'context_tokens', 'prompt_cache_warm', 'cache_ttl'] },
  { version: 1, event: 'PostModelSwitch', owner: 'session-manager', kind: 'observational', ordering: "after the session's model has changed", terminalDelivery: 'once-per-occurrence', correlation: 'session', redactedPayload: ['from_model', 'to_model', 'requested_model', 'source', 'context_tokens', 'prompt_cache_warm', 'cache_ttl'] },
  { version: 1, event: 'SubagentStart', owner: 'child-session-service', kind: 'observational', ordering: 'after reservation and before child runtime start', terminalDelivery: 'once-per-occurrence', correlation: 'session', redactedPayload: ['agent_id', 'agent_type'] },
  { version: 1, event: 'SubagentStop', owner: 'child-session-service', kind: 'observational', ordering: 'when a child session terminates', terminalDelivery: 'once-per-occurrence', correlation: 'session', redactedPayload: ['agent_id', 'agent_type'] },
  { version: 1, event: 'TaskCreated', owner: 'task-service', kind: 'decision', ordering: 'before the task creation is kept, so exit 2 rolls it back', terminalDelivery: 'once-per-occurrence', correlation: 'session', redactedPayload: ['task_id', 'task_subject'] },
  { version: 1, event: 'TaskCompleted', owner: 'task-service', kind: 'decision', ordering: 'before a task is marked completed, and again when a turn ends holding in-progress tasks', terminalDelivery: 'once-per-occurrence', correlation: 'session', redactedPayload: ['task_id', 'task_subject'] },
  // hooks.md:2414: "StopFailure hooks receive `error`, optional `error_details`,
  // and optional `last_assistant_message`." `error` is the documented
  // projection of Nessy's `ErrorCode`; `error_code` keeps the raw Nessy value.
  { version: 1, event: 'StopFailure', owner: 'pi-agent', kind: 'observational', ordering: 'after terminal turn failure and before Stop', terminalDelivery: 'once-per-turn', correlation: 'turn', redactedPayload: ['error', 'error_code', 'error_details', 'last_assistant_message'] },
  { version: 1, event: 'Stop', owner: 'pi-agent', kind: 'observational', ordering: 'when the current turn finishes', terminalDelivery: 'once-per-turn', correlation: 'turn', redactedPayload: [] },
  // hooks.md:2562: "CwdChanged hooks receive `old_cwd` and `new_cwd`", both
  // alongside the common `cwd` (the page's example carries `cwd` and `new_cwd`
  // with the same value). `previous_cwd` is the retained legacy alias.
  { version: 1, event: 'CwdChanged', owner: 'lifecycle-bridge', kind: 'observational', ordering: 'after effective working directory changes', terminalDelivery: 'once-per-occurrence', correlation: 'session', redactedPayload: ['cwd', 'new_cwd', 'old_cwd', 'previous_cwd'] },
  // R32 · hooks.md#directoryadded: "Runs after a working directory is added
  // mid-session, with the `/add-dir` command or the SDK `register_repo_root`
  // control request", and "DirectoryAdded fires after Claude Code has refreshed
  // sandbox and permission state, so sandboxed tools already see the new
  // directory when your hook runs." `kind` is `observational` because
  // "DirectoryAdded hooks have no decision control. They can't block the add,
  // which has already completed when the hook runs" (also hooks.md's
  // no-decision-control row). Payload is the documented `directory` + `source`.
  //
  // Nessy's only mid-session directory add is a hook's
  // `updatedPermissions.addDirectories` at session scope
  // (`PiAgent.applyPermissionRequestUpdates`), hence `owner: 'pi-agent'`; the
  // `--add-dir` startup flag is deliberately NOT this event ("Claude Code
  // doesn't fire this event for directories you pass with the `--add-dir`
  // startup flag; SessionStart covers those").
  { version: 1, event: 'DirectoryAdded', owner: 'pi-agent', kind: 'observational', ordering: 'after a working directory is added mid-session, once sandbox and permission state have been refreshed', terminalDelivery: 'once-per-occurrence', correlation: 'session', redactedPayload: ['directory', 'source'] },
  // hooks.md:2636: "FileChanged hooks receive `file_path` and `event`".
  // `path`/`change_kind` are the retained Nessy-legacy aliases — `path` was
  // emitted before this row ever named it, which is exactly the inventory drift
  // this table exists to prevent, so both are now declared.
  { version: 1, event: 'FileChanged', owner: 'lifecycle-bridge', kind: 'observational', ordering: 'after a file mutation completes', terminalDelivery: 'once-per-occurrence', correlation: 'tool', redactedPayload: ['file_path', 'event', 'path', 'change_kind'] },
  { version: 1, event: 'WorktreeCreate', owner: 'worktree-lease-service', kind: 'observational', ordering: 'after the path is selected and before the worktree is created; a hook may replace the path', terminalDelivery: 'once-per-occurrence', correlation: 'session', redactedPayload: [] },
  { version: 1, event: 'WorktreeRemove', owner: 'worktree-lease-service', kind: 'observational', ordering: 'after a worktree lease is removed', terminalDelivery: 'once-per-occurrence', correlation: 'session', redactedPayload: [] },
  // hooks.md#precompact / #postcompact: "The matcher value indicates whether
  // compaction was triggered manually or automatically" — `manual` for
  // `/compact`, `auto` for the context-window-full path — and the input field
  // carrying it is `trigger`. Both rows previously listed only `source`, which
  // carried Pi's own `manual | threshold | overflow` vocabulary under a name no
  // documented matcher reads; `trigger` is the documented projection of it and
  // `source` stays for the Pi detail.
  //
  // Each also carries its documented SECOND field: `custom_instructions` on
  // PreCompact (`hooks.md#precompact-input` — the `/compact` argument, and
  // `null` on the auto path AND on a manual compaction the user passed nothing
  // to; D1.115, re-read 2026-09-17) and `compact_summary` on PostCompact
  // (`hooks.md#postcompact-input` — the summary the compact operation
  // generated). `compact_summary` is conversation content, so
  // it is declared here rather than riding the payload undeclared.
  // R73 · the emission moved host-side so the compaction can WAIT on it:
  // hooks.md gives PreCompact a real block ("`PreCompact` | Yes | Blocks
  // compaction"), and the bridge's fire-and-forget sink had no return path for
  // one. The bridge still detects the occurrence — it asks the host and returns
  // Pi's `{ cancel: true }` — but `pi-agent` is what runs the hook.
  // `kind` stays `observational`: that axis is the permission receipt, not
  // blockability (PostToolUse, Stop and ConfigChange share the combination).
  { version: 1, event: 'PreCompact', owner: 'pi-agent', kind: 'observational', ordering: 'before context compaction, awaited so a block can skip it', terminalDelivery: 'once-per-occurrence', correlation: 'turn', redactedPayload: ['trigger', 'custom_instructions', 'source'] },
  { version: 1, event: 'PostCompact', owner: 'lifecycle-bridge', kind: 'observational', ordering: 'after context compaction', terminalDelivery: 'once-per-occurrence', correlation: 'turn', redactedPayload: ['trigger', 'compact_summary', 'source'] },
  // R73 · hooks.md#configchange: "Runs when a configuration file changes during
  // a session", and "ConfigChange hooks fire for changes to settings files,
  // managed policy settings, and skill files." That occurrence has TWO owners
  // now: the config watcher (`config/watcher.ts` → `SessionManager`) produces
  // the documented settings-file occurrences carrying `source`/`file_path`, and
  // `pi-agent` keeps producing Nessy's own runtime session-config commits
  // (`model`, `authType`, `thinkingLevel`, …), which are a Nessy extra with no
  // documented `source` and therefore only ever reach catch-all matchers.
  { version: 1, event: 'ConfigChange', owner: 'config-watcher + pi-agent', kind: 'observational', ordering: 'when a settings, managed-policy or skill file changes, and after runtime config commits', terminalDelivery: 'once-per-occurrence', correlation: 'config', redactedPayload: ['source', 'file_path', 'config_keys', 'config_digest'] },
  // R24: these two are Claude's `Elicitation`/`ElicitationResult`. Their payload
  // fields below are the documented ones (`hooks.md:2696`, `:2766`) as emitted
  // by pi-agent's real elicitation path, which is also the emitter that can
  // decide. The lifecycle-bridge ALSO emits both names per MCP tool call with
  // `mcp_server`/`mcp_tool`/`correlation_id` — a separate, misnamed surface
  // that predates R24 and is tracked independently; it is not what these rows
  // describe.
  { version: 1, event: 'McpElicitation', owner: 'pi-agent', kind: 'decision', ordering: 'when an MCP server requests user input, before any dialog', terminalDelivery: 'once-per-occurrence', correlation: 'tool', redactedPayload: ['mcp_server_name', 'message', 'mode', 'url', 'elicitation_id', 'requested_schema'] },
  { version: 1, event: 'McpResult', owner: 'lifecycle-bridge', kind: 'observational', ordering: 'after an external MCP interaction completes', terminalDelivery: 'once-per-occurrence', correlation: 'tool', redactedPayload: ['mcp_server', 'mcp_tool', 'correlation_id'] },
  { version: 1, event: 'ElicitationResult', owner: 'pi-agent', kind: 'decision', ordering: 'after the user answers, before the response reaches the server', terminalDelivery: 'once-per-occurrence', correlation: 'tool', redactedPayload: ['mcp_server_name', 'action', 'mode', 'elicitation_id', 'content'] },
  // hooks.md#sessionend: "Supports matchers to filter by exit reason. The
  // `reason` field in the hook input indicates why the session ended". The row
  // previously carried an empty payload, so the documented matcher had nothing
  // to read. Of the six documented values Nessy produces two — see
  // `SESSION_END_REASONS`.
  { version: 1, event: 'SessionEnd', owner: 'pi-agent', kind: 'observational', ordering: 'once at real session teardown', terminalDelivery: 'once-per-session', correlation: 'session', redactedPayload: ['reason'] },
] as const satisfies readonly AgentEventContractV1[]);

/** Agent events generated from the versioned contract inventory. */
export type AgentEvent = typeof AGENT_EVENT_CONTRACTS_V1[number]['event'];

export type AutomationEvent = AppEvent | AgentEvent;

export const APP_EVENTS: AppEvent[] = [
  'LabelAdd', 'LabelRemove', 'LabelConfigChange',
  'PermissionModeChange', 'FlagChange', 'SessionStatusChange', 'SchedulerTick'
];

export const AGENT_EVENTS: AgentEvent[] = AGENT_EVENT_CONTRACTS_V1.map(contract => contract.event);

/**
 * Runtime hook handler kinds, in this codebase's spelling (`mcp` is Claude's
 * `mcp_tool`).
 */
export type HookHandlerType = 'command' | 'http' | 'mcp' | 'prompt' | 'agent';

/**
 * P6.294 — which tier declared a hook, in the page's own layering order.
 *
 * `features-overview.md#understand-how-features-layer` is what these names
 * follow; `component` is this fork's own tier for a skill's or a subagent's
 * frontmatter hooks (R87), which has no page name because no vendor ships it.
 */
export type HookBindingTier = 'managed' | 'user' | 'project' | 'plugin' | 'component';

/**
 * P6.294 — one hook this session will ACTUALLY run, as it may be SHOWN.
 *
 * The row exists because there was no one place that lists them: the catalog
 * knows registrations, `AutomationsListPanel` renders user AUTOMATIONS, and the
 * project panel filters to `origin === 'native' && scope.kind === 'project'`,
 * so a user hook, a managed hook and a plugin hook were each invisible on some
 * surface. This is the projection of the MERGED system — the same four tier
 * configs `executeAgentEvent` consults, plus the component layer asked live.
 *
 * **What it deliberately does NOT carry, and why.** No command string, no
 * argument vector, no absolute path. That is the Safe-projection rule this
 * codebase applies to every capability view, and it is not cosmetic here: a
 * hook command is the most execution-shaped string in the config, and
 * {@link NativeResourceRef.absolutePath} is marked server-only precisely so it
 * never reaches a user view. {@link source} is therefore workspace-relative for
 * a project hook, bundle-relative for a plugin hook, and a bare file name for a
 * hook whose file lives outside the workspace (a user-global `hooks.json`) —
 * which is enough to FIND the declaration and never enough to leak where the
 * user's home directory is.
 */
export interface HookBindingView {
  event: AgentEvent;
  tier: HookBindingTier;
  /** `decision` is a stored inline verdict, which has no runner and no command. */
  handlerType: HookHandlerType | 'decision';
  /** The matcher's own name — `<plugin>/<hook-id>` for an imported hook. */
  name?: string;
  /** The authored matcher pattern; absent means every call of this event. */
  matcher?: string;
  /** hooks.md `if` filter, verbatim, when the author scoped it further. */
  ifRule?: string;
  /** Relative source path — see the type's note on what is withheld. */
  source?: string;
  /** `false` only when the author disabled the matcher without removing it. */
  enabled: boolean;
}

const ALL_HOOK_HANDLER_TYPES = ['command', 'http', 'mcp', 'prompt', 'agent'] as const satisfies readonly HookHandlerType[];
const OBSERVER_HOOK_HANDLER_TYPES = ['command', 'http', 'mcp'] as const satisfies readonly HookHandlerType[];
const LIFECYCLE_HOOK_HANDLER_TYPES = ['command', 'mcp'] as const satisfies readonly HookHandlerType[];

/**
 * hooks.md § Prompt-based hooks names thirteen "Events that support all five
 * hook types (`command`, `http`, `mcp_tool`, `prompt`, and `agent`)". Twelve of
 * them are events this inventory emits; `TeammateIdle` is the thirteenth and is
 * deliberately not emitted (see `plugins/hook-events.ts`), so it cannot appear in an
 * `AgentEvent`-keyed set.
 */
const ALL_TYPE_HOOK_EVENTS: ReadonlySet<AgentEvent> = new Set<AgentEvent>([
  'PermissionDenied',
  'PermissionRequest',
  'PostToolBatch',
  'PostToolUse',
  'PostToolUseFailure',
  'PreToolUse',
  'Stop',
  'SubagentStop',
  'TaskCompleted',
  'TaskCreated',
  'UserPromptExpansion',
  'UserPromptSubmit',
]);

/**
 * hooks.md: "`SessionStart` and `Setup` support `command` and `mcp_tool` hooks.
 * They don't support `http`, `prompt`, or `agent` hooks."
 *
 * `Setup` is one of the two named and is not here, because it is not an
 * `AgentEvent` at all — see `UNEMITTED_HOOK_EVENT_REASONS`. The restriction
 * still applies to it upstream, in the plugin adapter's own copy of this set.
 */
const LIFECYCLE_RESTRICTED_HOOK_EVENTS: ReadonlySet<AgentEvent> = new Set<AgentEvent>(['SessionStart']);

/**
 * Per-event hook-type support (hooks.md § Prompt-based hooks). Beside
 * {@link AGENT_EVENT_CONTRACTS_V1} because one module owns event facts: every
 * event outside the all-five list "supports `command`, `http`, and `mcp_tool`
 * hooks but not `prompt` or `agent`", and SessionStart drops `http` too.
 * `McpResult` has no Claude counterpart and takes the observer default, the
 * documented posture for every non-decision event.
 *
 * `MessageDisplay` takes the same default by INFERENCE, not by citation: as of
 * 2026-08-04 it is the one documented event that appears in NEITHER list on that
 * page (verified against `curl -sL …/hooks.md`, `:2860-2892`). Both of its worked
 * examples are `command` hooks, and it has no decision control, so the observer
 * trio is the conservative reading — a `prompt` or `agent` hook on it is refused
 * rather than run on a guess.
 */
export function hookTypesSupportedForEvent(event: AgentEvent): readonly HookHandlerType[] {
  if (ALL_TYPE_HOOK_EVENTS.has(event)) return ALL_HOOK_HANDLER_TYPES;
  if (LIFECYCLE_RESTRICTED_HOOK_EVENTS.has(event)) return LIFECYCLE_HOOK_HANDLER_TYPES;
  return OBSERVER_HOOK_HANDLER_TYPES;
}

/** True when hooks.md's support matrix lets `type` run on `event`. */
export function hookTypeSupportedForEvent(event: AgentEvent, type: HookHandlerType): boolean {
  return hookTypesSupportedForEvent(event).includes(type);
}

/**
 * `SessionEnd`'s documented exit-reason vocabulary (hooks.md#sessionend), which
 * is also its matcher vocabulary: `clear` "Session cleared with `/clear`
 * command", `resume` "Session switched via interactive `/resume`", `logout`
 * "User logged out", `prompt_input_exit` "User exited while prompt input was
 * visible", `other` "Other exit reasons".
 *
 * Nessy produces `clear` (a `clearHistory()` teardown) and `other` (every other
 * teardown: destroy, session deletion, session-manager cleanup). The remaining
 * three have no Nessy counterpart — Nessy has no interactive `/resume` session
 * switch, no account logout that ends a session and no prompt-input exit — so a
 * matcher naming one of them correctly never fires rather than firing on an
 * approximation.
 *
 * **P7.16/P7.1 · a sixth value was here and the vendor RETIRED it.**
 * `bypass_permissions_disabled` ("Bypass permissions mode was disabled") is gone
 * at the lift to `0.3.247`, and both denominators agree for once: the page's own
 * row for it now reads *"Removed in v2.1.234; Claude Code doesn't send it. Drop
 * it from your `SessionEnd` matchers"*, and the vendored binary scores **0** for
 * the string where it scored 8 at `2.1.233` (control `nessyNotARealSdkKey` → 0).
 * Dropped rather than kept-as-alias because this union is a MATCHER vocabulary,
 * not a parse surface: nothing in this fork ever emitted it (Nessy has no
 * bypass-permissions toggle that ends a session), so no stored matcher naming it
 * could ever have fired, and leaving it would offer a user a choice that is dead
 * on both sides.
 */
export const SESSION_END_REASONS = ['clear', 'resume', 'logout', 'prompt_input_exit', 'other'] as const;
export type SessionEndReason = typeof SESSION_END_REASONS[number];

/**
 * `ConfigChange`'s documented configuration-source vocabulary, which is also its
 * matcher vocabulary — hooks.md#configchange: "The matcher filters on the
 * configuration source", and the input carries it as `source` ("The `source`
 * field indicates which configuration type changed, and `file_path` provides
 * the path to the specific file that was modified"):
 *
 *   `user_settings`    — "`~/.claude/settings.json` changes"
 *   `project_settings` — "`.claude/settings.json` changes"
 *   `local_settings`   — "`.claude/settings.local.json` changes"
 *   `policy_settings`  — "Managed policy settings change"
 *   `skills`           — "A skill file in `.claude/skills/` changes"
 *
 * Nessy's mapping onto its own layout, produced by `ConfigWatcher`'s
 * `onSettingsSourceChange` and dispatched by `SessionManager`:
 *
 *   `user_settings`    — `<CONFIG_DIR>/config.json` and `<CONFIG_DIR>/hooks.json`
 *   `project_settings` — the workspace `config.json`, `hooks.json`,
 *                        `automations.json` and `permissions.json`
 *   `skills`           — `skills/{slug}/SKILL.md`
 *   `policy_settings`  — PRODUCED, since P6.463. `SessionManager`'s
 *                        `emitManagedPolicyConfigChange` dispatches one
 *                        `ConfigChange` per workspace on every ADOPTED managed
 *                        policy, carrying the changed KEY NAMES and no
 *                        `file_path` (the enforced policy is composed from two
 *                        admin sources, so naming either would be a guess).
 *                        Managed settings still arrive from the gateway
 *                        (`config/managed-delivery.ts`) rather than from a
 *                        watched file — what changed is that the refresh now
 *                        has an emitter riding it.
 *   `local_settings`   — NOT PRODUCED, and deliberately not invented: there is
 *                        no `.local` settings file anywhere in the Nessy tree,
 *                        so a matcher naming it correctly never fires rather
 *                        than firing on an approximation. This is the one
 *                        source of the five that is genuinely absent, and
 *                        `watcher-config-change-hook.test.ts` pins it.
 *
 * C3.101 — the `policy_settings` line above said "NOT PRODUCED … no emitter
 * rides that refresh yet" until 2026-09-11, and P6.463 had falsified it: that
 * producer is precisely why P6.289 had to pin the unblockable carve-out in
 * `SessionManager`'s `runConfigChangeHooks` (a `policy_settings` block is
 * ignored, per `hooks.md#configchange`, and the branch is reachable on a real
 * fleet rather than hypothetical). Same family as the trap AGENTS.md records
 * about a comment asserting what a DIFFERENT module does not do: nothing can
 * go red when the other module starts doing it, so the assertion rots silently
 * while the falsifying commit has no reason to look here.
 */
export const HOOK_CONFIG_CHANGE_SOURCES = [
  'user_settings', 'project_settings', 'local_settings', 'policy_settings', 'skills',
] as const;
export type HookConfigChangeSource = typeof HOOK_CONFIG_CHANGE_SOURCES[number];

/**
 * `Notification`'s documented type vocabulary (hooks.md#notification), which is
 * also its matcher vocabulary — the event "Matches on notification type", and
 * the input carries it as `notification_type`:
 *
 *   `permission_prompt`    — "Claude needs you to approve a tool use"
 *   `idle_prompt`          — "Claude is done and waiting for your next prompt"
 *   `auth_success`         — "Authentication completes"
 *   `elicitation_dialog`   — "An MCP server opens an elicitation form"
 *   `elicitation_complete` — "An MCP elicitation form is submitted or dismissed"
 *   `elicitation_response` — "An MCP elicitation response is sent back to the server"
 *   `agent_needs_input`    — "A background session starts waiting on your input"
 *   `agent_completed`      — "A background session finishes or fails"
 *   `elicitation_url_dialog`     — "An MCP server asks you to open a browser URL"
 *   `quota_auto_resume_fired`    — "Claude Code continues your task after a claude.ai usage limit paused it"
 *   `quota_auto_resume_stale`    — "A claude.ai usage limit reset while your computer slept"
 *   `quota_auto_resume_disabled` — "Claude Code ends its wait for a claude.ai usage limit without continuing"
 *
 * This list carried EIGHT until P6.293 and the page publishes TWELVE
 * (`hooks-guide.md#get-notified-when-claude-needs-input`, the same twelve in the
 * event table's `Notification` row). **The bundle-lag half of this paragraph is
 * DEAD** (C3.252, 2026-09-12): it read "The vendored SDK — `claudeCodeVersion
 * 2.1.233` — scores 0 for `quota_auto_resume` and `elicitation_url_dialog`, so
 * the BUNDLE lags the page here". At the vendored `claudeCodeVersion 2.1.247`
 * BOTH are in the native binary — `quota_auto_resume` 9 lines / 36 occurrences
 * and `elicitation_url_dialog` 3/3, both instruments named because they
 * disagree on a minified artefact (C3.294). All twelve stay accepted, and now
 * for the simplest possible reason rather than by AGENTS.md's union rule: the
 * page and the bundle AGREE on this list.
 *
 * Nessy produces exactly one of them today: `permission_prompt`, for `ask_user`,
 * which reaches the human through the permission-request channel and opens the
 * same blocking approval card. The other ELEVEN have no Nessy emitter, so a
 * matcher naming one correctly never fires — that is the honest outcome, not a
 * defect to paper over by relabelling `ask_user`. What P6.293 changes is that the
 * silence is no longer silent: see {@link HOOK_NOTIFICATION_TYPES_WITHOUT_EMITTER}.
 */
export const HOOK_NOTIFICATION_TYPES = [
  'permission_prompt', 'idle_prompt', 'auth_success', 'elicitation_dialog',
  'elicitation_url_dialog', 'elicitation_complete', 'elicitation_response',
  'agent_needs_input', 'agent_completed',
  'quota_auto_resume_fired', 'quota_auto_resume_stale', 'quota_auto_resume_disabled',
] as const;
export type HookNotificationType = typeof HOOK_NOTIFICATION_TYPES[number];

/**
 * The notification types this runtime never emits, and WHY — the honest half of
 * widening the vocabulary (P6.293). Shipping the four new names without this
 * would ADVERTISE them: a matcher that validates and can never run is worse than
 * one that is rejected, because nothing ever tells the author.
 *
 * Derived from the emitters, not from prose: `emitNotificationHook` in
 * `agent/pi-agent.ts` is the only producer on any runtime here and both of its
 * production call sites pass `permission_prompt`. Every other member of
 * {@link HOOK_NOTIFICATION_TYPES} therefore belongs in this map, and the
 * `notification-vocabulary` test pins exactly that complement so a future
 * emitter cannot be added without removing its row.
 *
 * Reason strings say what would have to become true, not merely "unsupported".
 */
export const HOOK_NOTIFICATION_TYPES_WITHOUT_EMITTER: Readonly<Record<string, string>> = {
  idle_prompt: 'Nessy has no idle timer on the composer, so nothing fires ~60s after a turn ends.',
  auth_success: 'Sign-in completes in the desktop settings surface, which does not reach the hook bus.',
  elicitation_dialog: 'MCP elicitation forms render in the renderer and emit no notification hook.',
  elicitation_url_dialog: 'Same surface as elicitation_dialog, and URL-mode elicitation is not wired here at all.',
  elicitation_complete: 'No elicitation completion is reported back onto the hook bus.',
  elicitation_response: 'No elicitation response is reported back onto the hook bus.',
  agent_needs_input: 'Gated upstream on the agent-view surface, which Nessy does not have.',
  agent_completed: 'Gated upstream on the agent-view surface, which Nessy does not have.',
  quota_auto_resume_fired: 'The claude.ai usage-limit auto-continue loop is inside the closed binary; the desktop drives the SDK and never sees it.',
  quota_auto_resume_stale: 'Same loop, same reason.',
  quota_auto_resume_disabled: 'Same loop, same reason.',
};

/**
 * The five effort levels a hook input may report, from hooks.md § Common input
 * fields (`:707`): "Object with a `level` field holding the active effort level
 * for the turn: `"low"`, `"medium"`, `"high"`, `"xhigh"`, or `"max"`."
 *
 * DELIBERATELY NOT `ThinkingLevel`. Nessy's own vocabulary carries a sixth
 * value, `off`, which the page does not list — a session at `off` reports NO
 * effort rather than a word no documented hook can branch on. Keeping the two
 * unions apart is what makes that impossible to get wrong by assignment.
 *
 * Nessy has no "ultracode" effort level (`ultracode` here is the workflow
 * trigger keyword, `workflows/workflow-keyword.ts`), so the page's "Ultracode
 * is not a distinct level and reports as `"xhigh"`" has no counterpart to map:
 * there is no level that could report as anything other than itself.
 */
export const HOOK_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type HookEffortLevel = typeof HOOK_EFFORT_LEVELS[number];

export function getAgentEventContractV1(event: string, version: number): typeof AGENT_EVENT_CONTRACTS_V1[number] {
  if (version !== 1) throw new Error(`Unsupported Nessy lifecycle version: ${version}`);
  const contract = AGENT_EVENT_CONTRACTS_V1.find(candidate => candidate.event === event);
  if (!contract) throw new Error(`Unknown Nessy lifecycle event: ${event}`);
  return contract;
}

// ============================================================================
// Action Definitions
// ============================================================================

/** A prompt action - sends a prompt to Nessy Desktop */
export interface PromptAction {
  type: 'prompt';
  prompt: string;
  /** LLM connection slug for the created session (falls back to default if not found) */
  llmConnection?: string;
  /** Model ID for the created session (falls back to provider default if invalid) */
  model?: string;
  /**
   * Thinking level for the created session.
   * When omitted, falls back to the workspace default (then DEFAULT_THINKING_LEVEL).
   */
  thinkingLevel?: ThinkingLevel;
  /** When true, create the prompt session in memory only. */
  ephemeral?: boolean;
}

/** HTTP method for webhook actions */
export type WebhookHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Body format for webhook actions */
export type WebhookBodyFormat = 'json' | 'form' | 'raw';

/** Authentication shorthand for webhook actions */
export type WebhookAuth =
  | { type: 'basic'; username: string; password: string }
  | { type: 'bearer'; token: string };

/** A webhook action - sends an HTTP request to an endpoint */
export interface WebhookAction {
  type: 'webhook';
  /** The URL to send the webhook to (http or https) */
  url: string;
  /** HTTP method (default: POST) */
  method?: WebhookHttpMethod;
  /** HTTP headers as key-value pairs */
  headers?: Record<string, string>;
  /** Body format: 'json' sends Content-Type application/json, 'form' URL-encodes, 'raw' sends as-is */
  bodyFormat?: WebhookBodyFormat;
  /** Request body — JSON object when bodyFormat is 'json' or 'form', string when 'raw' */
  body?: unknown;
  /** Capture response body in result (truncated to 4KB). Default: false */
  captureResponse?: boolean;
  /** Authentication shorthand (applied before custom headers) */
  auth?: WebhookAuth;
}

/** A lifecycle hook command. Hook-only: app-event automations do not execute this action type. */
export interface HookCommandAction {
  type: 'command';
  /** Shell command to run in the workspace/working directory. */
  command: string;
  /**
   * hooks.md § Exec form and shell form. When present, `command` is an
   * executable resolved on PATH and spawned directly with this argument
   * vector: "There is no shell, so each `args` element is one argument exactly
   * as written". When absent the hook stays shell form and `command` is the
   * whole shell string. Plugin hooks and hook documents set it (F1.1177).
   */
  args?: string[];
  /** Optional working directory for this hook command. Defaults to the session/workspace working directory. */
  cwd?: string;
  /** Extra non-secret environment variables, expanded from hook env first. */
  env?: Record<string, string>;
  /**
   * Timeout in milliseconds. Stored native automations default to 30s; an
   * imported hook carries hooks.md's resolved per-type/per-event budget.
   */
  timeoutMs?: number;
  /**
   * hooks.md § Common fields: "Custom spinner message displayed while the hook runs."
   * Not plugin-only since F1.1094: HookCommandActionSchema declares it too, so a Claude-shape hooks file or the ~/.claude/settings.json import keeps it.
   */
  statusMessage?: string;
  /** For PreToolUse, non-zero exit blocks unless this is false. Defaults to true. */
  blockOnNonZero?: boolean;
  /**
   * hooks.md § Command hook fields, `shell`: "Shell to use for this hook.
   * Accepts `"bash"` or `"powershell"`." Shell form only — the same row's
   * closing sentence is "Ignored when `args` is set", and exec form spawns the
   * executable directly. Absent keeps the platform default spawn. A requested
   * shell that is not installed is a stated execution error, never a silent
   * fallback to another shell.
   */
  shell?: 'bash' | 'powershell';
  /**
   * Background hook (hooks.md `async`): runs without blocking the event and its
   * output is never parsed for a decision — on blocking events it still runs
   * but can never block. Imported command hooks only.
   */
  async?: boolean;
  /**
   * hooks.md `asyncRewake` — implies {@link async} and changes only WHEN the
   * background run's output reaches the model.
   *
   * `hooks.md#command-hook-fields`, verbatim: *"If `true`, runs in the
   * background and wakes Claude on exit code 2. The hook's stderr, or stdout if
   * stderr is empty, is shown to Claude as a system reminder so it can react to
   * a long-running background failure"*. `hooks.md#limitations` gives the other
   * half: *"Hook output is delivered on the next conversation turn. If the
   * session is idle, the response waits until the next user interaction.
   * Exception: an `asyncRewake` hook that exits with code 2 wakes Claude
   * immediately even when the session is idle."*
   *
   * C3.301 — this field is why the action type carries the flag at all. The
   * executor cannot tell the two sinks apart without it, and until 2026-09-12
   * `pluginHookAction` dropped it here: the registration stored it, nothing
   * downstream could read it, and an `asyncRewake` hook therefore ran as a plain
   * background hook and woke nothing. Imported command hooks only.
   */
  asyncRewake?: boolean;
  /** UB12.67 — hooks.md `onFailure`; see {@link HookOnFailure}. */
  onFailure?: HookOnFailure;
}

/**
 * UB12.67 — what a FAILED `command` or `http` hook does to its action.
 *
 * `hooks.md#block-the-action-when-a-hook-fails` (curl'd 2026-10-16), verbatim:
 * *"To block the action instead, set `"onFailure": "block"` on a `command` or
 * `http` hook. The default value is `"continue"`."* Absent IS `"continue"`.
 * The executor (`executePluginHookAutomations`) owns the semantics; this field
 * only carries the author's choice from every tier that declares it.
 */
export type HookOnFailure = 'continue' | 'block';

/**
 * `defer` (hooks.md "Defer a tool call for later", R7 Task 5) suspends the
 * call for a later resume: honored only on the headless surface and only for
 * single-tool-call turns; consumers outside that window warn and ignore it.
 * Documented precedence: deny > defer > ask > allow.
 */
export type PreToolUseDecisionValue = 'allow' | 'ask' | 'block' | 'deny' | 'defer';

/**
 * `McpElicitation`/`ElicitationResult` answer (hooks.md §Elicitation, R24).
 * `accept` supplies/overrides the form values, `decline` fails the tool call,
 * `cancel` cancels the whole operation.
 */
export type McpElicitationAction = 'accept' | 'decline' | 'cancel';

export interface PreToolUseDecision {
  decision?: PreToolUseDecisionValue;
  /** Replacement tool input returned by a PreToolUse automation. */
  updatedInput?: Record<string, unknown>;
  /** Model-visible context to attach to the tool result. */
  additionalContext?: string;
  /** Replacement output returned by an observational PostToolUse hook. */
  updatedToolOutput?: string;
  /**
   * P7.14 — `PostToolUse` only (`hooks.md#annotate-a-result-for-the-auto-mode-classifier`,
   * arrived with the SDK lift to `0.3.247`): *"Return `classifierContext` to
   * send a short note about the tool call's result to the auto mode classifier
   * rather than to Claude. The classifier never receives tool results
   * themselves, so this field is the supported way to tell it something about
   * what a call returned before it reviews later actions."*
   *
   * NESTED ONLY: the page shows it under `hookSpecificOutput` and nowhere else,
   * unlike `additionalContext`, which it also shows at the top level.
   *
   * It is `PostToolUse` and NOT `PostToolUseFailure`, which is where it parts
   * company with {@link updatedToolOutput} beside it: the vendored
   * `PostToolUseFailureHookSpecificOutput` is `{ hookEventName;
   * additionalContext? }` and declares no such field, so the contract table
   * gives it to one of the two events the fork otherwise treats as one wire.
   */
  classifierContext?: string;
  /** Human-readable reason for ask/block decisions. */
  reason?: string;
  /**
   * PermissionRequest deny-only (hooks.md#permissionrequest): the hook asks
   * the host to abort the turn in addition to denying the prompt. Ignored
   * on any non-deny decision.
   */
  interrupt?: boolean;
  /**
   * PermissionRequest allow-only (hooks.md#permissionrequest): permission
   * updates the hook asks the host to apply — the documented six entry types,
   * of which this codebase applies the session-scoped subset (R15 Task 3).
   */
  updatedPermissions?: Array<Record<string, unknown>>;
  /**
   * PermissionDenied only (hooks.md#permissiondenied): re-run the permission
   * decision. Capped at ONE retry per tool call — an unbounded retry is a
   * prompt loop. The re-run goes through the full gate, so deny rules and
   * floors still apply.
   */
  retry?: boolean;
  /**
   * WorktreeCreate only (hooks.md, the path-return pattern): the path the
   * worktree should use. `command` hooks return it as the last non-empty stdout
   * line; `http` hooks as `hookSpecificOutput.worktreePath`. Validated against
   * the documented refusals by `resolveHookWorktreePath` before use.
   */
  worktreePath?: string;
  /**
   * `McpElicitation`/`ElicitationResult` only (hooks.md §Elicitation, R24):
   * `hookSpecificOutput.action`. On `McpElicitation` an action answers the MCP
   * server directly and the dialog never opens; on `ElicitationResult` it
   * settles the answer the user already gave.
   */
  elicitationAction?: McpElicitationAction;
  /**
   * `hookSpecificOutput.content` for the two elicitation events. On
   * `McpElicitation` it is the whole accepted form; on `ElicitationResult` it
   * "overrides the user's response values", i.e. a per-field override — fields
   * absent from it keep what the user typed.
   */
  elicitationContent?: Record<string, unknown>;
  /**
   * `MessageDisplay` only (hooks.md:1311): "`displayContent` | Text displayed in
   * place of the delta. Omit it to display the original".
   *
   * DISPLAY-ONLY, and the contract table is what enforces it — ":1273
   * MessageDisplay is display-only: the replacement text changes only what is
   * rendered on screen. The transcript and what Claude sees keep the original
   * text". It rides the wire as `SessionEvent.text_delta.displayDelta` /
   * `text_complete.displayText`; nothing on the persistence path ever reads it.
   */
  displayContent?: string;
  /**
   * `SessionStart` and `UserPromptSubmit` (hooks.md:1060 and :1266). On
   * SessionStart: "Sets the session title, with the same effect as `/rename`.
   * Use to name sessions automatically from the launch folder, git branch, or
   * worktree name. Applies when `source` is `"startup"`, `"resume"`, or
   * `"fork"`; ignored on `"clear"` and `"compact"`". On UserPromptSubmit:
   * "Sets the session title. Use to name sessions automatically based on the
   * prompt content".
   *
   * The source gate is a property of the INPUT, not of the event, so it cannot
   * live in the per-event surface table; it is applied on the way out of each
   * executor by `applySessionStartTitleSourceGate`.
   */
  sessionTitle?: string;
  /**
   * `SessionStart` only (hooks.md:1059): "String used as the first user message
   * of the session. Applies in non-interactive mode with the `-p` flag, where
   * it becomes the first turn even if no prompt is provided. If a prompt is
   * provided, it follows as the next turn. Unlike `additionalContext`, which
   * attaches to an existing turn, this creates the turn".
   */
  initialUserMessage?: string;
  /**
   * `SessionStart` only (hooks.md:1062): "Boolean. When `true`, Claude Code
   * re-scans the skill and command directories after the SessionStart hooks
   * complete, so skills the hook installed are available in the same session,
   * starting with the first prompt".
   */
  reloadSkills?: boolean;
  /**
   * `SessionStart` (hooks.md:1061): "Array of absolute paths to watch for
   * FileChanged events during this session".
   *
   * `CwdChanged` (:2572) and `FileChanged` (:2651) document the same field as a
   * REPLACEMENT of the dynamic watch list; neither carries it on its surface,
   * because Nessy's `FileChanged` fires when a file-mutating tool completes
   * rather than from a disk watcher, so there is no dynamic list for those two
   * events to replace — recorded at
   * `docs/superpowers/plans/2026-07-29-inert-unit-b.md:329-331`. Parsed and
   * carried so the SessionStart contract is whole; it configures nothing until
   * a real path watcher exists.
   */
  watchPaths?: readonly string[];
}

export interface PreToolUseDecisionAction extends PreToolUseDecision {
  type: 'decision';
}

/**
 * A plugin prompt-hook action (B1). Hook-only: injects a literal one-shot
 * body as observational hidden context (`additionalContext`) on the bound
 * event through the existing decision path — never a subprocess, never a
 * second prompt-assembly owner. App-event automations never emit this.
 */
export interface PluginPromptHookAction {
  type: 'plugin-prompt';
  prompt: string;
  /** Model requested for the prompt-decision runner (hooks.md `model`, R22). */
  model?: string;
  /** Stored-inert `continueOnBlock` (R22); R9's per-event matrix consumes it. */
  continueOnBlock?: boolean;
  /** Per-hook timeout bounding the prompt-decision runner (clamped, R22). */
  timeoutMs?: number;
  /** hooks.md § Common fields: spinner label shown while the hook runs. */
  statusMessage?: string;
}

/**
 * A plugin agent-hook action (B1): spawns a declared sub-agent through the injected child-session
 * runner — never a new spawn authority, inert with no runner. App-event automations never emit it.
 */
export interface PluginAgentHookAction {
  type: 'plugin-agent';
  agentName: string;
  /** F1.209 — hooks.md#common-fields `timeout`, RESOLVED (declared, else 60 s), in ms. */
  timeoutMs?: number;
  /** hooks.md § Common fields: spinner label shown while the hook runs. */
  statusMessage?: string;
}

/**
 * A plugin mcp_tool-hook action (B2): calls a fully-qualified pool tool (`mcp__<server>__<tool>`, no
 * short alias) through the injected MCP-pool runner; inert with no runner. Never an app-event action.
 */
export interface PluginMcpToolHookAction {
  type: 'plugin-mcp-tool';
  mcpTool: string;
  mcpArgs?: Record<string, unknown>;
  /** F1.209 — hooks.md#common-fields `timeout`, RESOLVED (declared, else 600 s; 30 s on some events), in ms. */
  timeoutMs?: number;
  /** hooks.md § Common fields: spinner label shown while the hook runs. */
  statusMessage?: string;
}

/**
 * A plugin http-hook action (B2): fires a bounded HTTP request through the injected network runner
 * (the webhook executor) ONLY under an explicit network permission contract — with no runner the
 * request never fires (denial has no side effect). App-event automations never emit this.
 */
export interface PluginHttpHookAction {
  type: 'plugin-http';
  /** F1.209 — hooks.md#common-fields `timeout`, RESOLVED (declared, else 600 s; 30 s on some events), in ms. */
  timeoutMs?: number;
  http: {
    url: string;
    method?: WebhookHttpMethod;
    headers?: Record<string, string>;
    body?: unknown;
    /** Header env-interpolation allowlist (R22); intersected with the managed key. */
    allowedEnvVars?: string[];
  };
  /** hooks.md § Common fields: spinner label shown while the hook runs. */
  statusMessage?: string;
  /** UB12.67 — hooks.md `onFailure`; see {@link HookOnFailure}. Never set on a native `webhook`. */
  onFailure?: HookOnFailure;
}

/**
 * The five universal hook output fields (hooks.md § Universal output). Every
 * event's hook may return them, independently of which decision pattern the
 * event speaks, and `continue: false` "takes precedence over any event-specific
 * decision fields".
 */
export interface HookUniversalOutput {
  /** `false` stops the agent entirely; it outranks the event's own decision. */
  continue?: boolean;
  /** Shown to the USER and deliberately never fed to the model. */
  stopReason?: string;
  /** Hides the hook's stdout from the transcript. */
  suppressOutput?: boolean;
  /** A warning surfaced to the user. */
  systemMessage?: string;
  /** OSC-allowlisted terminal escape; anything else is dropped whole. */
  terminalSequence?: string;
}

/**
 * A hook run that failed WITHOUT blocking (hooks.md § Exit code output: "Any
 * other exit code is a non-blocking error for most hook events. The transcript
 * shows a `<hook name> hook error` notice followed by the first line of stderr,
 * so you can identify the cause without `--debug`. Execution continues and the
 * full stderr is written to the debug log.").
 *
 * Carrying it on the execution result rather than swallowing it is the whole
 * point: before this, a crashed hook returned `undefined` and both consumers
 * merged nothing, so a security hook that failed to start permitted the call
 * with no signal anywhere.
 */
export interface HookErrorNotice {
  /** Matcher name — the `<hook name>` half of the documented notice. */
  hookName: string;
  /** The event whose hook failed. */
  event: string;
  /** Process exit code; `null`/absent when the command never ran. */
  exitCode?: number | null;
  /** First line of redacted stderr: the transcript half. */
  summary: string;
  /** Full redacted stderr: the debug-log half. Omitted when equal to `summary`. */
  detail?: string;
}

export interface AgentEventExecutionResult {
  matchedCount: number;
  decision?: PreToolUseDecision;
  /** Merged universal output of every hook that ran for this event. */
  universal?: HookUniversalOutput;
  /** Non-blocking hook failures this event produced, in execution order. */
  hookErrors?: readonly HookErrorNotice[];
  /**
   * Whether any hook this event dispatched failed to RUN successfully — a
   * non-zero exit, a timeout, or no execution authority at all (P6.292).
   *
   * Distinct from {@link hookErrors}, which is the user-facing notice list and
   * is deliberately EMPTY when a failure was turned into a block (the block
   * reports it instead). It is also distinct from a `decision: block` a hook
   * printed on a successful exit: that is a hook doing its job, not a failure.
   * `once` consumption is the reader that needs the difference — `hooks.md`
   * §Common fields: "A run that fails, blocks with exit code 2, or times out
   * leaves the hook in place".
   */
  hookRunFailed?: boolean;
  /**
   * P6.828 — one row per host hook this event RAN (any kind since F1.9), successes
   * included, AND per hook it observed NOT running (F1.449): a notice raised before
   * any ran (F1.9), and a command hook with no execution authority — off `PreToolUse`
   * from its notice (F1.232), on it from its fail-closed block, which has none (F1.270).
   *
   * {@link hookErrors} could not carry them: it is the user-facing notice list
   * and a hook that ran clean produces no notice at all, so the run history
   * assembled from it was honest but permanently one-sided — and deriving a
   * success from {@link matchedCount} would claim a per-hook fact the result
   * does not have (a matcher can match and dispatch nothing, and a dedupe can
   * collapse two matches into one run). The observation shape is the runtimes'
   * shared one, so a host hook and the same hook running natively on claude or
   * codex reach `HookRunStore` through one door and read identically.
   *
   * Absent, rather than empty, when there is no row at all (nothing ran and nothing
   * was observed not running): an empty array and "this event does not report runs"
   * are different facts, and only the first one may be shown as "nothing ran".
   */
  hookRuns?: readonly HookRunObservation[];
}

export type AutomationAction =
  | PromptAction
  | WebhookAction | ScriptAction
  | HookCommandAction
  | PreToolUseDecisionAction
  | PluginPromptHookAction
  | PluginAgentHookAction
  | PluginMcpToolHookAction
  | PluginHttpHookAction;

// ============================================================================
// Condition Types
// ============================================================================

/** Time-of-day and day-of-week condition */
export interface TimeCondition {
  condition: 'time';
  /** Start time in 24h HH:MM format */
  after?: string;
  /** End time in 24h HH:MM format */
  before?: string;
  /** Days of week (3-letter lowercase: mon, tue, wed, thu, fri, sat, sun) */
  weekday?: string[];
  /** IANA timezone (falls back to matcher timezone, then system local) */
  timezone?: string;
}

/** State/field check condition with HA-style from/to for transitions */
export interface StateCondition {
  condition: 'state';
  /** Field name to check (e.g. 'permissionMode', 'sessionStatus', 'labels', 'isFlagged') */
  field: string;
  /** Exact value match */
  value?: unknown;
  /** Transition: previous value (mapped via TRANSITION_FIELDS) */
  from?: unknown;
  /** Transition: new value (mapped via TRANSITION_FIELDS) */
  to?: unknown;
  /** Array membership check */
  contains?: string;
  /** Negation: matches anything except this value */
  not_value?: unknown;
}

/** Logical composition condition (and/or/not) */
export interface LogicalCondition {
  condition: 'and' | 'or' | 'not';
  conditions: AutomationCondition[];
}

/** Union of all condition types */
export type AutomationCondition = TimeCondition | StateCondition | LogicalCondition;

// ============================================================================
// Semantic Condition
// ============================================================================

/**
 * Yes/no question the decision model answers before a prompt action starts a
 * session (Settings > AI > Decision model, toggle `automationConditions`). The
 * run is skipped when the "yes" probability is below `threshold` (default 0.5).
 * Inert when the decision model is off or unavailable: the automation runs as
 * it would without the condition.
 *
 * UB6.9 — ported from craft-agents-oss `v0.15.1:packages/shared/src/automations/types.ts`
 * (first shipped v0.14.0; unchanged through v0.15.1; Apache-2.0).
 */
export interface SemanticCondition {
  question: string;
  threshold?: number;
}

// ============================================================================
// Matcher Definition
// ============================================================================

export interface AutomationMatcher {
  /** Short 6-character hex ID for stable identification across config changes. */
  id?: string;
  /** Optional display name. If omitted, derived from the first action. */
  name?: string;
  /** Regex pattern for matching event data (not used for SchedulerTick) */
  matcher?: string;
  /**
   * `'claude'` selects the imported-plugin two-mode matcher (a plain
   * alternation list of names is compared exactly; anything containing other
   * characters stays an unanchored regex; `*` matches all). It is set only by
   * `pluginHookMatcher` for imported plugin hooks. Absent means today's
   * unanchored-regex behaviour, which every stored native automation was
   * written against — flipping that default would silently re-scope saved
   * automations.
   */
  matchMode?: 'claude';
  /**
   * Imported-hook `if` filter (hooks.md): one permission-rule string gating
   * execution on tool events; fail-open on evaluation trouble, and a hook
   * with `if` never runs on non-tool events. Set only by `pluginHookMatcher`.
   */
  ifRule?: string;
  /**
   * Directory a source-anchored (`/x`) path rule inside {@link ifRule} resolves
   * against. permissions.md anchors `/path` "at a directory associated with the
   * settings source that defines it"; for a plugin hook that source is the
   * plugin's own installed bundle, not the project. A hook ships with the files
   * it is about, and anchoring at the project root would let `Edit(/**)` read as
   * narrow while matching the whole workspace.
   *
   * Without it, `compilePermissionDslV1` cannot compile a source anchor at all
   * and the filter fails open — the hook runs on every tool call.
   */
  ifSourceRoot?: string;
  /** Cron expression for SchedulerTick events (5-field format) */
  cron?: string;
  /** IANA timezone for cron evaluation (e.g., "Europe/Budapest", "America/New_York") */
  timezone?: string;
  /** Permission mode for sessions created by prompt actions. */
  permissionMode?: PermissionMode;
  /**
   * Give each run of this task its own isolated Git worktree instead of the
   * live checkout.
   *
   * desktop-scheduled-tasks.md:34 — "By default, scheduled tasks run against
   * whatever state your working directory is in, including uncommitted changes.
   * Enable the worktree toggle when creating the task to give each run its own
   * isolated Git worktree, the same way parallel sessions work." Default off,
   * and a property of the TASK, not of one instruction.
   */
  worktree?: boolean;
  /** Labels to apply to sessions created by prompt actions */
  labels?: string[];
  /** Whether this automation matcher is enabled. Defaults to true. Set to false to disable without removing. */
  enabled?: boolean;
  /** Optional conditions that must all pass (AND) after matcher matches, before actions fire */
  conditions?: AutomationCondition[];
  /** Optional decision-model condition checked before prompt actions start a session */
  semanticCondition?: SemanticCondition;
  actions: AutomationAction[];
}

export interface AutomationsConfig {
  automations: Partial<Record<AutomationEvent, AutomationMatcher[]>>;
}

// ============================================================================
// Action Results
// ============================================================================

/** References parsed from a prompt (@name for sources and skills) */
export interface PromptReferences {
  /**
   * All @name references found in the prompt.
   * These could be sources (@linear, @github) or skills (@commit, @review-pr).
   * The caller should resolve which are sources vs skills based on available configurations.
   */
  mentions: string[];
}

/** Result of a prompt action - returns the prompt to be executed by caller */
export interface PromptActionResult {
  type: 'prompt';
  prompt: string;
  /** The expanded prompt with environment variables substituted */
  expandedPrompt: string;
  /** References to sources and skills found in the prompt */
  references: PromptReferences;
}

/** Result of a webhook action */
export interface WebhookActionResult {
  type: 'webhook';
  /** The URL that was called */
  url: string;
  /** HTTP status code from the response */
  statusCode: number;
  /** Whether the request was successful (2xx status) */
  success: boolean;
  /** Error message if the request failed */
  error?: string;
  /** Number of attempts made (1 = no retry, 2+ = retried) */
  attempts?: number;
  /** Total duration including retries, in ms */
  durationMs?: number;
  /** Captured response body (only when captureResponse is true, truncated to 4KB) */
  responseBody?: string;
}

export interface HookCommandActionResult {
  type: 'command';
  command: string;
  success: boolean;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout?: string;
  stderr?: string;
  output?: string;
  error?: string;
  timedOut?: boolean;
  truncated?: boolean; /** F1.863 — the host refused to start it: nothing ran (see `refusedHookIsNonBlocking`). */ refusedBeforeStart?: boolean;
}

export interface PreToolUseDecisionActionResult extends PreToolUseDecision {
  type: 'decision';
}

export type ActionExecutionResult = PromptActionResult | WebhookActionResult | HookCommandActionResult | PreToolUseDecisionActionResult | ScriptActionResult;

/** A pending prompt with its metadata */
export interface PendingPrompt {
  /** The session ID this prompt should be sent to */
  sessionId: string | undefined;
  /** The automation matcher ID this prompt originated from */
  matcherId?: string;
  /** Human-readable automation name (from matcher.name or derived fallback) */
  automationName?: string;
  /** The expanded prompt text */
  prompt: string;
  /**
   * All @mentions found in the prompt (sources and skills).
   * The caller should resolve which are sources vs skills based on available configurations.
   */
  mentions: string[];
  /** Labels to apply to the created session */
  labels?: string[];
  /** Permission mode for the created session (from matcher config) */
  permissionMode?: PermissionMode;
  /** LLM connection slug for the created session (falls back to default if not found) */
  llmConnection?: string;
  /** Model ID for the created session (falls back to provider default if invalid) */
  model?: string;
  /** Thinking level for the created session (falls back to workspace default when omitted) */
  thinkingLevel?: ThinkingLevel;
  /** When true, create the prompt session in memory only. */
  ephemeral?: boolean;
  /** Run this task in its own isolated worktree (desktop-scheduled-tasks.md:34). */
  worktree?: boolean;
  /**
   * Epoch ms of the scheduled occurrence this run is catching up for; absent on
   * an ordinary run.
   *
   * desktop-scheduled-tasks.md:74 — "Desktop shows a notification when a
   * catch-up run starts." Carrying the occurrence rather than a bare boolean is
   * what lets that notification say WHICH run was missed, which is the point of
   * the paragraph that follows it ("A task scheduled for 9am might run at 11pm
   * if your computer was asleep all day").
   */
  catchUpForOccurrenceAt?: number;
  /**
   * Event that fired the matcher, and its payload — carried on EVERY prompt
   * (UB4.8). Upstream v0.14.0+ sets these only under a `semanticCondition`, so
   * its loop guard protects only those matchers; the host reads
   * `eventPayload.sessionId` on every prompt, which is what lets the loop guard
   * protect a self-labelling matcher with no condition too. (UB6.9 carries
   * `semanticCondition` on the same always-set shape.)
   */
  semanticCondition?: SemanticCondition;
  event?: string;
  eventPayload?: Record<string, unknown>;
}

export interface AutomationResult {
  event: string;
  matched: number;
  results: ActionExecutionResult[];
  /** Prompts that should be executed by Nessy Desktop (with metadata) */
  pendingPrompts: PendingPrompt[];
}

// ============================================================================
// Validation Types
// ============================================================================

/** Internal validation result that includes the parsed config */
export type AutomationsValidationResult = {
  valid: boolean;
  errors: string[];
  /**
   * Non-fatal matcher diagnostics, formatted `path: message` like {@link errors}.
   *
   * C3.90 — this validator always RAISED warnings and its object-shaped entry
   * point dropped them on the floor, so the diagnostics reached only the file
   * validators (`/doctor`, the `config-validate` tool) and never the three paths
   * that LOAD a config. Optional because the schema-failure branch returns
   * before any matcher is examined and has none to report.
   */
  warnings?: string[];
  config: AutomationsConfig | null;
};

// ============================================================================
// SDK Types
// ============================================================================

/**
 * SDK automation input type - union of all possible SDK event inputs
 */
export interface SdkAutomationInput {
  hook_event_name: string;
  /**
   * C3.197 (QM2 = A, owner 2026-09-11) — the prompt this hook run belongs to.
   *
   * `hooks.md` § Common input fields, verbatim: *"`prompt_id` | UUID
   * identifying the user prompt currently being processed. Matches the
   * `prompt.id` attribute on OpenTelemetry events, so you can correlate hook
   * output with telemetry for a single prompt. Absent until the first user
   * input."*
   *
   * Filled by `BaseAgent`'s one hook funnel — see `withPromptId` there for why
   * the host fills it and what of the page's sentence is not yet true.
   */
  prompt_id?: string;
  /**
   * Common input field (hooks.md `:707`): "Object with a `level` field holding
   * the active effort level for the turn: `"low"`, `"medium"`, `"high"`,
   * `"xhigh"`, or `"max"`. If the requested model effort exceeds what the
   * current model supports, this is the downgraded level the model actually
   * used. […] Present for events that fire within a tool-use context, such as
   * `PreToolUse`, `PostToolUse`, `Stop`, and `SubagentStop`, when the current
   * model supports the effort parameter. The level is also available to hook
   * commands and the Bash tool as the `$CLAUDE_EFFORT` environment variable."
   *
   * An OBJECT, not a bare string: `effort: "high"` would satisfy a grep and
   * still break the documented `jq -r '.effort.level'`.
   *
   * OPTIONAL, and its absence means "no level to report" — never `medium`. It
   * is withheld outside a tool-use context, when the model does not support the
   * effort parameter, and when the session's level is Nessy's `off`.
   */
  effort?: { level: HookEffortLevel };
  // Tool events
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: string;
  tool_use_id?: string;
  /** PermissionRequest input (hooks.md#permissionrequest; carries NO tool_use_id). */
  permission_mode?: string;
  /** PermissionRequest "always allow" options the dialog would offer (R15 Task 3). */
  permission_suggestions?: Array<Record<string, unknown>>;
  // Session events
  /**
   * Matcher field for FOUR different events, each with its own closed
   * vocabulary — the union is deliberately left as `string` because the
   * vocabularies are disjoint per event and a reader always knows which event
   * it holds:
   *
   * - `SessionStart` — `startup | resume | clear | compact`.
   * - `DirectoryAdded` — `slash_command | register_repo_root`.
   * - `ConfigChange` — the five `HOOK_CONFIG_CHANGE_SOURCES` values
   *   (hooks.md#configchange: "The matcher filters on the configuration
   *   source"). Nessy's own runtime session-config occurrences carry NO
   *   `source`, so they reach catch-all matchers only.
   * - `PreCompact`/`PostCompact` — the raw Pi compaction reason, kept beside
   *   the documented `trigger` rather than replacing it.
   * - `PreModelSwitch`/`PostModelSwitch` (D1.217) — `command | picker | sdk`,
   *   and `PostModelSwitch` adds `auto | resume`. The host sends `sdk` for a
   *   user-driven switch through `SessionManager.updateSessionModel` (the
   *   reason is at that site) and `auto` for the one switch it makes on its
   *   own, a runtime switch carrying the session's model across
   *   (`SessionManager.flushPendingModelSwitchHook`). **Do not invent a sixth
   *   value for "the runtime did it": the page already named two**
   *   (`hooks.md#postmodelswitch-input`).
   *
   *   Two exclusions belong with the vocabulary, because they are what stops a
   *   parity build from manufacturing a divergence. `hooks.md#premodelswitch`:
   *   Claude Code *"doesn't run PreModelSwitch hooks for switches it makes on
   *   its own … Those changes reach PostModelSwitch only"* — so an `auto`
   *   occurrence is `PostModelSwitch` ALONE. And `hooks.md#postmodelswitch`:
   *   *"Claude Code doesn't run PostModelSwitch hooks when a model from a
   *   fallback model chain serves a turn, because that substitution lasts one
   *   turn and leaves the session's model unchanged"* — which is exactly what
   *   `resolveFallbackModelChain` does on pi and codex, and what claude's
   *   `model_refusal_fallback` reports, so NONE of those three mints an event.
   */
  source?: string;
  /**
   * D1.218 — `SessionStart` on a `resume` or a `fork`, the ONE of the SDK's four
   * resume/fork fields this host can answer honestly.
   *
   * `sdk.d.ts` 0.3.251 glosses it as the resumed transcript's last response
   * input + cache_read + cache_creation + output tokens, which is the same
   * figure `SessionManager.modelSwitchCostFields` already computes for
   * `PreModelSwitch` and the renderer's context meter already shows. Filled by
   * `SessionManager.withSessionStartContextTokens`, in the one wrapper every
   * host hook event on all three runtimes passes through, so a hook author gets
   * the same answer after a runtime switch.
   *
   * ABSENT rather than `0` when no turn has reported usage, on the same rule
   * `prompt_cache_warm` keeps: "no reading" and "an empty context" are different
   * answers and a hook must be able to tell them apart.
   *
   * ITS THREE SIBLINGS STAY UNREAD and the reasons are in `EVENT_INVENTORY`'s
   * `SessionStart` comment above, not restated here — including the naming
   * decision that keeps `prompt_cache_warm` and refuses its inverse spelling.
   */
  context_tokens?: number;
  /**
   * D1.217 — `PreModelSwitch` / `PostModelSwitch`. `hooks.md#premodelswitch-input`:
   * *"The model the request named: an alias such as `opus`, a full model ID, or
   * `null` when the request was for the default model"*, and
   * `#postmodelswitch-input` adds *"`requested_model` is `null` when `source` is
   * `auto`"* — which is the host's own case, where nobody named a model.
   *
   * `null` is a VALUE here and not an absence, so the type carries it: absent
   * means the event does not have the field, `null` means the request named
   * nothing. `from_model` / `to_model` reach the same payload through
   * `runModelSwitchHook`'s `Record<string, unknown>` and are deliberately not
   * mirrored here — this one is declared because the D1.217 flush builds its
   * payload as an `SdkAutomationInput` directly, with no lease to borrow.
   * (UB12.102: `to_model` IS declared now, below, because the matcher reads it.)
   */
  requested_model?: string | null;
  /**
   * UB12.102 — `PreModelSwitch` / `PostModelSwitch`, `hooks.md#premodelswitch-input`:
   * *"Model ID the switch changes to. The matcher compares against this model's
   * canonical name"*. Declared because `getMatchValueForSdkInput` reads it
   * (`modelSwitchCanonicalName`); absent when a switch clears the session model.
   */
  to_model?: string;
  model?: string;
  /**
   * `PreCompact` / `PostCompact` matcher field (hooks.md#precompact): "The
   * matcher value indicates whether compaction was triggered manually or
   * automatically" — `manual` for `/compact`, `auto` for the context-window
   * path. Pi's own `session_before_compact`/`session_compact` reason
   * (`manual | threshold | overflow`) projects onto it; the raw Pi value stays
   * on `source`.
   *
   * hooks.md also names `trigger` as `Setup`'s matcher field, with the
   * unrelated vocabulary `init | maintenance`. That is why the union here is
   * only the compaction pair: `Setup` is not an event we emit at all, so the
   * second vocabulary has no producer to widen this for — see
   * `UNEMITTED_HOOK_EVENT_REASONS`.
   */
  trigger?: 'manual' | 'auto';
  /**
   * `PreCompact` payload. `hooks.md#precompact-input`, verbatim 2026-09-17:
   * "In addition to the common input fields, PreCompact hooks receive
   * `trigger` and `custom_instructions`. For `manual`, `custom_instructions`
   * contains what the user passes into `/compact` and is `null` when they pass
   * nothing. For `auto`, `custom_instructions` is `null`."
   *
   * NULL, not absent and not empty — the page's own JSON example under that
   * heading carries `"custom_instructions": null` on a `"trigger": "manual"`
   * payload.
   *
   * D1.115 — this declaration said `string` and quoted an OLDER sentence
   * ending "is empty" beside a `""` example, and the fork emitted `''` to
   * match it. The page moved both to `null`, and it moved FURTHER than the row
   * that noticed: the manual-with-nothing case is `null` too, so `''` was
   * wrong on both triggers rather than only on `auto`. The line-shaped
   * citation this docblock carried is dropped rather than renumbered — a page
   * anchor is part of the published link contract and a line number has a
   * measured half-life of about two days.
   */
  custom_instructions?: string | null;
  /**
   * `PostCompact` payload (hooks.md:2810): "In addition to the common input
   * fields, PostCompact hooks receive `trigger` and `compact_summary`. The
   * `compact_summary` field contains the conversation summary generated by the
   * compact operation."
   *
   * This is CONVERSATION CONTENT reaching a hook process. `hookCommandStdinPayload`
   * records the deliberate decision that hook stdin is unredacted and redaction
   * lives on the output path, so this is consistent — but a webhook action on
   * `PostCompact` now ships a conversation summary off-machine.
   */
  compact_summary?: string;
  /**
   * `SessionEnd` matcher field (hooks.md#sessionend): why the session ended.
   * See `SESSION_END_REASONS` for the documented vocabulary and which values
   * Nessy produces. Also carried, unrelated to the matcher, by the
   * permission-service `PermissionRequest`/`PermissionDenied` emissions as the
   * human-readable denial reason.
   */
  reason?: string;
  // Subagent events
  agent_id?: string;
  agent_type?: string;
  // Durable interaction events. hooks.md:2068 / :2123 — TaskCreated and
  // TaskCompleted receive `task_id`, `task_subject`, and optionally
  // `task_description`, `teammate_name` and `team_name`.
  task_id?: string;
  task_subject?: string;
  task_description?: string;
  teammate_name?: string;
  /** Deprecated upstream: session-derived team name. */
  team_name?: string;
  // User prompt events
  prompt?: string;
  /**
   * `UserPromptExpansion` payload (hooks.md#userpromptexpansion): "In addition
   * to the common input fields, UserPromptExpansion hooks receive
   * `expansion_type`, `command_name`, `command_args`, `command_source`, and the
   * original `prompt` string. The `expansion_type` field is `slash_command` for
   * skill and custom commands, or `mcp_prompt` for MCP server prompts."
   *
   * `command_name` is also the event's MATCHER field ("Matches on
   * `command_name`. Leave the matcher empty to fire on every prompt-type
   * command"), read by `getMatchValueForSdkInput`.
   *
   * `command_source` is reported with Nessy's own `CustomSlashCommandSource`
   * vocabulary (`nessy-agent | agents | plugin | skill | mcp | workflow`).
   * hooks.md names no vocabulary for it beyond the single example value
   * `"plugin"`, which our spelling matches; the values with no documented
   * counterpart keep their Nessy spelling rather than being bent onto a word
   * the page never uses.
   */
  expansion_type?: 'slash_command' | 'mcp_prompt';
  command_name?: string;
  command_args?: string;
  command_source?: string;
  // Notification events
  message?: string;
  title?: string;
  /**
   * `Notification` matcher field (hooks.md#notification: the event "Matches on
   * notification type" and the input carries `notification_type` "indicating
   * which type fired"). See `HOOK_NOTIFICATION_TYPES`.
   */
  notification_type?: HookNotificationType;
  // Working-directory change events
  /**
   * `CwdChanged` payload (hooks.md:2562): "In addition to the common input
   * fields, CwdChanged hooks receive `old_cwd` and `new_cwd`."
   *
   * `new_cwd` MIRRORS the common `cwd` — the page's own JSON example carries
   * both holding the same value — so it is an alias, not a second fact.
   * `previous_cwd` is the retained Nessy-legacy spelling of `old_cwd`: both are
   * emitted, and neither is removed, because stored automations and hook
   * scripts were authored against the old name.
   */
  cwd?: string;
  previous_cwd?: string;
  old_cwd?: string;
  new_cwd?: string;
  /**
   * `DirectoryAdded` payload, verbatim from hooks.md#directoryadded: `directory`
   * is the "Absolute path of the directory that was added". Its companion is the
   * shared `source` above, whose documented vocabulary for THIS event is
   * `"slash_command"` for `/add-dir` or `"register_repo_root"` for the SDK
   * control request — the matcher reads it ("how the directory was added").
   */
  directory?: string;
  /**
   * `MessageDisplay` payload, verbatim from hooks.md:1285-1294:
   *
   *   `turn_id`    — "UUID of the current turn"
   *   `message_id` — "UUID of the assistant message being displayed. Stable
   *                  across every batch of the same message. This is not the API
   *                  `msg_…` id, so it can't be correlated with transcript
   *                  message ids"
   *   `index`      — "Zero-based index of this batch within the message"
   *   `final`      — "`true` on the message's last batch. Each message has
   *                  exactly one final batch"
   *   `delta`      — "The newly completed lines since the prior batch,
   *                  terminating newlines included. Always whole lines, except
   *                  the final batch which may end mid-line."
   *
   * `final` is the end-of-message signal, NOT a non-empty `delta` — the final
   * batch's delta is empty when the message ends on a newline.
   */
  turn_id?: string;
  message_id?: string;
  index?: number;
  final?: boolean;
  delta?: string;
  // Filesystem change events
  /**
   * `FileChanged` payload. hooks.md:2636 — "In addition to the common input
   * fields, FileChanged hooks receive `file_path` and `event`": `file_path` is
   * the "Absolute path to the file that changed" (the same key
   * `InstructionsLoaded` uses, documented below) and `event` is `"change"` for
   * a modified file, `"add"` for a created file, `"unlink"` for a deleted file.
   *
   * `unlink` is currently UNREACHABLE: the emitter fires on completion of a
   * file-mutating tool, not on a disk watch, and no tool in that set deletes.
   *
   * `path` and `change_kind` are Nessy-legacy ALIASES kept permanently —
   * `path` mirrors `file_path`, `change_kind` names the mutating tool and has
   * no documented counterpart.
   */
  path?: string;
  change_kind?: string;
  event?: 'change' | 'add' | 'unlink';
  /**
   * `InstructionsLoaded` payload, verbatim from hooks.md#instructionsloaded.
   * The event fires ONCE PER LOADED FILE, and the matcher runs against
   * `load_reason`.
   *
   *   `file_path`         — absolute path to the instruction file loaded
   *   `memory_type`       — `User` | `Project` | `Local` | `Managed`
   *   `load_reason`       — `session_start` | `nested_traversal` |
   *                         `path_glob_match` | `include` | `compact`
   *   `globs`             — the file's `paths:` frontmatter patterns; present
   *                         only for `path_glob_match` loads
   *   `trigger_file_path` — the file whose access triggered a lazy load
   *   `parent_file_path`  — the instruction file that included this one
   *
   * Shared with two other events: `FileChanged` matches on this path's
   * BASENAME, and `ConfigChange` carries it as the documented optional
   * companion of `source` ("`file_path` provides the path to the specific file
   * that was modified").
   */
  file_path?: string;
  memory_type?: 'User' | 'Project' | 'Local' | 'Managed';
  load_reason?: 'session_start' | 'nested_traversal' | 'path_glob_match' | 'include' | 'compact';
  globs?: string[];
  trigger_file_path?: string;
  parent_file_path?: string;
  // MCP interaction events (elicitation / tool result)
  /**
   * NOT an elicitation field. Carried by the lifecycle-bridge `McpElicitation`
   * / `McpResult` / `ElicitationResult` emissions, which fire per MCP TOOL CALL
   * and are a separate (misnamed) surface from the real elicitation hooks
   * below. Documented elicitation payloads use `mcp_server_name`.
   */
  mcp_server?: string;
  mcp_tool?: string;
  /**
   * `McpElicitation` (Claude's `Elicitation`) and `ElicitationResult` payloads,
   * verbatim from `hooks.md:2696` and `:2766`:
   *
   *   Elicitation       — `mcp_server_name`, `message`, and optional `mode`,
   *                       `url`, `elicitation_id`, `requested_schema`.
   *   ElicitationResult — `mcp_server_name`, `action`, and optional `mode`,
   *                       `elicitation_id`, `content`.
   *
   * Neither carries `tool_name`, `tool_input` or `tool_use_id`, and
   * `ElicitationResult` carries no `message`. There is no `schema`,
   * `user_response`, `form_schema` or `form_state` field on either — earlier
   * revisions of this comment claimed otherwise and were wrong; re-read the
   * page rather than trusting a summary of it.
   */
  mcp_server_name?: string;
  /** `'form' | 'url'` — which elicitation mode the server asked for. */
  mode?: string;
  /** Elicitation, url mode only: the URL the user is sent to. */
  url?: string;
  elicitation_id?: string;
  /** Elicitation only: the server's `requestedSchema`. */
  requested_schema?: Record<string, unknown>;
  /** `ElicitationResult` only: the action the user took. */
  action?: McpElicitationAction;
  /** `ElicitationResult` only: the form values the user provided. */
  content?: Record<string, unknown>;
  // Error events
  /**
   * `StopFailure` payload (hooks.md:2414): "StopFailure hooks receive `error`,
   * optional `error_details`, and optional `last_assistant_message`. The
   * `error` field identifies the error type and is used for matcher
   * filtering." `error` carries the DOCUMENTED vocabulary only —
   * `rate_limit`, `overloaded`, `authentication_failed`,
   * `oauth_org_not_allowed`, `billing_error`, `invalid_request`,
   * `model_not_found`, `server_error`, `max_output_tokens`, `unknown` — which
   * is a PROJECTION of Nessy's own `ErrorCode`, not a rename of it. The raw
   * Nessy code stays on `error_code`.
   *
   * `PostToolUseFailure` / `PermissionDenied` also carry `error` with Nessy's
   * own free-form failure text; only `StopFailure` is bound to the closed
   * vocabulary above.
   */
  error?: string;
  /** `StopFailure`: "Additional details about the error, when available". */
  error_details?: string;
  /** Versioned lifecycle correlation and redacted aggregate fields. */
  lifecycle_version?: 1;
  correlation_id?: string;
  batch_count?: number;
  error_count?: number;
  outcome?: 'success' | 'failure' | 'cancelled';
  error_code?: string;
  config_keys?: string[];
  config_digest?: string;
  /**
   * `Stop` / `SubagentStop` payload (hooks.md `:2190`, `:2044`).
   *
   *   `stop_hook_active`       — `true` "when Claude Code is already continuing
   *                              as a result of a stop hook" (`:2190`).
   *   `last_assistant_message` — the text of the just-finished response. `:2192`
   *                              says to prefer it over `transcript_path`
   *                              because "the transcript file isn't guaranteed
   *                              to include the final message at Stop time".
   *   `background_tasks`       — `:2194`. Present and EMPTY when nothing is in
   *                              flight, never absent.
   *   `session_crons`          — `:2194`, `:2210`. Same presence rule.
   *
   * On `SubagentStop` both arrays are the PARENT session's (`:2046`).
   *
   * `SubagentStop` adds one more (`:2048`):
   *
   *   `agent_transcript_path`  — "the subagent's own transcript", as opposed to
   *                              `transcript_path`, which is "the main
   *                              session's transcript". Claude nests it under a
   *                              `subagents/` folder; a Nessy child session is a
   *                              real session, so its transcript is its own
   *                              session file.
   *
   * `StopFailure` REDEFINES `last_assistant_message` (hooks.md:2420): "The
   * rendered error text shown in the conversation. Unlike `Stop` and
   * `SubagentStop`, where this field holds Claude's conversational output, for
   * `StopFailure` it contains the API error string itself, such as `"API Error:
   * Rate limit reached"`." So on that one event the field is the error text,
   * never the model's output.
   */
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  /**
   * P6.300 — `hooks.md`'s COMMON input field, and the one every event carries:
   * *"Path to conversation JSON. The transcript file is written asynchronously
   * and may lag the in-memory conversation, so it may not yet include the
   * current turn's most recent messages when a hook fires."*
   *
   * Filled centrally in `BaseAgent.emitAutomationEvent`, so it reaches a hook on
   * all three runtimes and cannot say different things on each. It is THIS
   * session's transcript; `agent_transcript_path` below is a subagent's own, and
   * on `SubagentStop` both are present and they are different files.
   */
  transcript_path?: string;
  agent_transcript_path?: string;
  background_tasks?: readonly BackgroundTaskEntryV1[];
  session_crons?: readonly SessionCronEntryV1[];
}

/**
 * SDK automation callback signature (mirrors the Claude SDK's `SyncHookJSONOutput`).
 *
 * Two corrections, both made because the previous shape did not merely fail to
 * describe the SDK — it FORCED a defect:
 *
 * 1. **`continue` is optional in the SDK and was required here.** A hook that
 *    wanted to deny one tool call had no way to say so without also setting
 *    `continue`, and `hooks.md` says `continue: false` "stops processing
 *    entirely … Takes precedence over any event-specific decision fields". So
 *    every blocked tool ended the whole turn. Measured on claude-runtime: in
 *    Explore mode a refused write produced no assistant message at all.
 * 2. **`hookSpecificOutput` was missing the two fields that deny a single call.**
 *    Per the same page's § PreToolUse decision control, PreToolUse "returns its
 *    decision inside a `hookSpecificOutput` object" with `permissionDecision`
 *    and `permissionDecisionReason`, the latter "shown to Claude" for a deny —
 *    which is precisely how the agent learns what to tell the user.
 *
 * Both fields are optional, so every existing caller still typechecks; what
 * changes is that denying one tool is now expressible.
 *
 * P3.163 adds the three remaining UNIVERSAL fields. `SyncHookJSONOutput` in the
 * vendored bundle declares five — `continue`, `suppressOutput`, `stopReason`,
 * `systemMessage`, `terminalSequence` — and this shape carried two, so
 * {@link HookUniversalOutput} had three fields with nowhere to land on the
 * Claude path. `systemMessage` is also where a non-blocking hook failure
 * surfaces: hooks.md#json-output calls it the "Warning message shown to the
 * user. In [Agent SDK] and [`--output-format stream-json`] output, it can
 * arrive as an [`SDKInformationalMessage`]", which is the SDK-side spelling of
 * the transcript notice `SessionManager.reportHookErrors` writes on the host
 * path — and that reporter never runs for hooks dispatched through
 * `buildSdkHooks`.
 */
export interface SdkAutomationCallbackResult {
  continue?: boolean;
  /**
   * The SDK's TOP-LEVEL decision, which is a two-value union and not ours
   * (P3.177).
   *
   * This declared `'block' | 'allow' | 'ask' | 'deny'` — three values the SDK
   * has never heard of, and one it has. The vendored bundle is the denominator
   * for MEMBERSHIP and it is unambiguous: `SyncHookJSONOutput` in
   * `@anthropic-ai/claude-agent-sdk/sdk.d.ts` declares
   * `decision?: 'approve' | 'block'`. The page is NARROWER still —
   * hooks.md#top-level-decision: "The only value for `decision` is `"block"`.
   * To allow the action to proceed, omit `decision` from your JSON, or exit 0
   * without any JSON at all" — so `'approve'` is a value the bundle accepts and
   * the page no longer advertises.
   *
   * THAT ANCHOR IS CORRECT AND `check-doc-anchors.ts` REPORTS IT DEAD (P2.472).
   * It is a `<Tab title="Top-level decision">` id, not a markdown heading —
   * re-verified against the rendered page 2026-08-31, and AGAIN 2026-09-03 when
   * a lane relayed a request to re-cite it: exactly one of that page's 1 151
   * `id="…"` values (1 148 on the earlier reading — a page count is a reading
   * with a date), no numeric twin (`top-level-decision-2` → 0), nonsense
   * control 0, positive control `bash-if-matching` → 1, and the companion
   * `id="panel-top-level-decision-0"` is the Tab panel that proves the shape.
   * The markdown still carries the quoted sentence verbatim beside
   * `<Tab title="Top-level decision">`. The
   * guard deliberately does not slugify tab titles, because titles repeat and a
   * duplicate takes a numeric suffix no slug rule predicts, and a wrong slug in
   * its snapshot would let it BLESS a dead citation while a missing one only
   * over-reports. So the finding is the guard's blind spot, not this citation:
   * do NOT silence it by re-pointing this at a coarser enclosing heading.
   *
   * The union below follows the BUNDLE, because a type that refuses a value the
   * runtime accepts is a compile error where a type that accepts a value the
   * runtime ignores is only dead code.
   *
   * `'allow'`, `'ask'` and `'deny'` are gone because there is nowhere for them
   * to land. hooks.md#pretooluse-decision-control's note is where the confusion
   * came from: "PreToolUse previously used top-level `decision` and `reason`
   * fields, but these are deprecated for this event. Use
   * `hookSpecificOutput.permissionDecision` and
   * `hookSpecificOutput.permissionDecisionReason` instead. The deprecated values
   * `"approve"` and `"block"` map to `"allow"` and `"deny"` respectively." So
   * allow/deny are the PERMISSION vocabulary — `permissionDecision` below — and
   * `"ask"` was never a top-level value in either vocabulary.
   *
   * Latent until P3.176: the translator discarded every PreToolUse decision
   * except a block, so no value in the old union could travel. Sequenced first
   * on purpose, so that widening the translator cannot let a hook author write a
   * word our type accepts and the SDK has never seen.
   */
  decision?: 'approve' | 'block';
  reason?: string;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  terminalSequence?: string;
  hookSpecificOutput?: {
    hookEventName: AgentEvent;
    /**
     * PreToolUse's own four-value vocabulary — byte-identical to the bundle's
     * `HookPermissionDecision` (`sdk.d.ts`: `'allow' | 'deny' | 'ask' |
     * 'defer'`) and to hooks.md#decision-control's row for the event:
     * "`permissionDecision` (allow/deny/ask/defer)". P3.176 is what finally
     * gives three of the four a writer on the Claude path.
     */
    permissionDecision?: 'allow' | 'deny' | 'ask' | 'defer';
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
    updatedToolOutput?: string;
    /**
     * P7.14 — `PostToolUse`'s note for the auto-mode classifier, declared by
     * the vendored `PostToolUseHookSpecificOutput` since the lift to `0.3.247`
     * and mirrored here so an automation's note reaches the SDK instead of
     * being dropped by the translator. P6.302's marker test in
     * `config/__tests__/claude-vendored-sdk-contract.test.ts` is what waited
     * for it.
     *
     * The MIRROR is a flattened union (see this object's own docblock), so the
     * field is optional here and belongs to one event only — the forwarder in
     * `plugins/hooks-automation.ts` is what keeps it on `PostToolUse`.
     */
    classifierContext?: string;
    /**
     * WorktreeCreate's member of the same union (P2.495), and the only field on
     * this object the binary reads back on the CALLBACK route.
     *
     * The vendored `@anthropic-ai/claude-agent-sdk/sdk.d.ts` declares
     * `WorktreeCreateHookSpecificOutput` as
     * `{ hookEventName: 'WorktreeCreate'; worktreePath: string }` and unions it
     * into `SyncHookJSONOutput['hookSpecificOutput']`. So the field is part of
     * the typed SDK API, the callback route that returns it is correct, and
     * what was missing was only this mirror — which matters, because the other
     * reading of the same gap would have meant the whole worktree seam does not
     * work. It does; see `worktree-hooks.ts` for the measured binary branch that
     * consumes it.
     *
     * **Added here rather than by module augmentation, and that is the whole
     * reason this is an edit to a hot shared file:** an interface augmentation
     * can ADD a member, it cannot WIDEN one that already exists, and
     * `hookSpecificOutput` already exists — so nothing outside this file can
     * reach inside that object literal.
     *
     * OPTIONAL here where the SDK's own member has it REQUIRED, because this
     * mirror flattens a discriminated union into one bag: `permissionDecision`
     * is PreToolUse's, `updatedToolOutput` is PostToolUse's, and each is
     * optional for the same reason. The required-ness lives with the event, and
     * the event is `hookEventName` above — the binary's branch is gated on it,
     * so a `worktreePath` without the matching `hookEventName` is not read at
     * all.
     */
    worktreePath?: string;
  };
}

export type SdkAutomationCallback = (
  input: SdkAutomationInput,
  toolUseId: string,
  options: { signal?: AbortSignal }
) => Promise<SdkAutomationCallbackResult>;

/**
 * SDK automation matcher format (matches Claude SDK HookCallbackMatcher type)
 * Note: The `hooks` field name is kept as-is to match the Claude SDK interface.
 */
export interface SdkAutomationCallbackMatcher {
  matcher?: string;
  timeout?: number;
  hooks: SdkAutomationCallback[];
}

export interface AgentAutomationSystem {
  /** Host wrapper owns one FIFO shared by agent and service-originated events. */
  readonly serializesAgentEvents?: true;
  executeAgentEvent(event: AgentEvent, input: SdkAutomationInput, signal?: AbortSignal): Promise<AgentEventExecutionResult>;
  buildSdkHooks?(options?: SdkHooksBuildOptions): Partial<Record<AgentEvent, SdkAutomationCallbackMatcher[]>>;
  /**
   * Whether any registered matcher could run for this event — the same configs
   * `executeAgentEvent` consults, without running anything.
   *
   * R32 needs it and nothing else does yet. `MessageDisplay` fires on the
   * assistant-text streaming path, and hooks.md:1271 makes the emission
   * BLOCKING — "Claude Code holds each batch until your hook returns" — so
   * honouring it means holding a display batch at the line boundary. Asking
   * first is what keeps that cost off a session with no such hook, which is
   * every session today: the alternative is an awaited round trip per 50 ms
   * delta batch for everyone, and line-granular instead of token-granular
   * streaming, to discover a matcher count of zero.
   *
   * Optional: a host that cannot answer is read as "unknown", and the emitter
   * then falls back to firing per time-batch without holding anything.
   */
  hasAgentEventMatchers?(event: AgentEvent): boolean;
  /**
   * P2.496 — did the USER tier turn all hooks off?
   *
   * `settings-reference.md#disableallhooks` exempts our own registrations by
   * name: *"In any other settings file: Claude Code disables user, project,
   * local, and plugin hooks; managed hooks, Agent SDK hooks, and hooks from
   * plugins force-enabled in managed `enabledPlugins` keep running."* So a host
   * that registers hooks straight into the SDK — which is what
   * `claude-agent.ts` does — is outside the switch by the vendor's stated
   * intent, not by a leak. The owner's decision is that our OWN additions
   * should stand down anyway, because a user who turns hooks off reasonably
   * believes hooks are off. A NARROWING, and only ever a narrowing.
   *
   * Why the flag has to exist at all, measured rather than assumed: the
   * effective value was a local of `buildPinnedAgentAutomationSystem` and this
   * interface had no reader, so the registration site could not ask. An empty
   * `buildSdkHooks()` cannot stand in — it is indistinguishable from "no
   * automations configured", which is the far more common case and the one the
   * builder answers with `undefined`.
   *
   * TRUE means the user tier's switch is engaged. It does NOT mean nothing is
   * running: managed-distributed plugin hooks survive it (only the managed
   * level of the key stops those), so a system can carry both this flag and a
   * live plugin tier.
   *
   * Two consumers must never read it, and the reason is a permission boundary
   * rather than a style: `disableAllHooks` governs hooks, a status line and a
   * file-suggestion command, never a permission decision. Routing it into the
   * `PreToolUse` gate would turn a convenience switch into a permission
   * widening, and the `PermissionDenied` matcher is an audit record — a switch
   * that silences an audit trail is worse than one that changes nothing.
   *
   * Optional, and absent is read as "unknown", never as `false`: a host that
   * cannot answer must not have its hooks silenced by a default.
   */
  readonly userTierDisableAllHooks?: boolean;
  /**
   * P6.294 — every hook this session will actually run, grouped by nothing and
   * ordered by tier, for a read-only view. See {@link HookBindingView} for what
   * it withholds.
   *
   * Optional because the two implementations answer differently by
   * construction: the plugin-scoped system knows all four tiers plus the live
   * component layer, and a host that cannot enumerate must say so by absence
   * rather than by an empty array, which would read as "no hooks are
   * configured" — the same distinction `userTierDisableAllHooks` exists for.
   */
  describeHookBindings?(): readonly HookBindingView[];
}

/**
 * F1.223 (P-WJu-3) — what a host may hand {@link AgentAutomationSystem.buildSdkHooks}.
 *
 * `onHookRun` receives every `AgentEventExecutionResult` an SDK callback
 * produced, BEFORE it is translated into the SDK's own answer — which carries no
 * `hookRuns` — so the runs a claude child calls back can reach the host's
 * `/hooks` run history, as every run the host dispatches already does. The
 * host's automation wrapper passes its recorder; a caller passing nothing gets
 * the map it always got.
 */
export interface SdkHooksBuildOptions {
  onHookRun?: (result: AgentEventExecutionResult) => void;
}

/**
 * R87 — the component-scoped (skill/agent frontmatter) hook layer, consulted at
 * DISPATCH time rather than captured in the once-per-generation automation
 * snapshot.
 *
 * hooks.md § Hooks in skills and agents: these hooks "are scoped to the
 * component's lifecycle and only run when that component is active" and are
 * "cleaned up when it finishes". The automation system is built once per
 * capability generation, so it cannot carry a layer that appears and disappears
 * within a turn — the layer is therefore a reader over the host's live set of
 * active components (`BaseAgent.activeSkillInvocations`), not a frozen config.
 *
 * The `once` tier is separated from the always-on tier so a consumed once-hook
 * ("runs once per session then is removed") can be dropped without touching the
 * hooks that keep firing while the component stays active. `once` is honoured
 * for SKILL frontmatter only (hooks.md, the `once` field: "ignored in settings
 * files and agent frontmatter").
 */
export interface ComponentHookLayer {
  /**
   * Non-`once` component hooks that could match this event, or `undefined`.
   *
   * R87b widened this with the dispatch INPUT, which the skill layer ignores.
   * The subagent layer needs it: a parent session can hold several live
   * children, their terminal events are not serialized with each other, and a
   * `SubagentStop` carries `agent_id`. Without the input a sibling's completion
   * would run this child's frontmatter `Stop` hook, which is exactly what
   * "only run while that specific subagent is active" forbids.
   */
  matchersFor(event: AgentEvent, input?: SdkAutomationInput): AutomationsConfig | undefined;
  /** Unconsumed `once` component hooks for this event, or `undefined`. */
  onceMatchersFor(event: AgentEvent, input?: SdkAutomationInput): AutomationsConfig | undefined;
  /** Mark this event's `once` hooks consumed once they have actually run. */
  consumeOnce(event: AgentEvent): void;
  /**
   * Whether any component hook (once or always) could match this event. Asked
   * WITHOUT an input, because its one caller is the perf gate
   * (`hasAgentEventMatchers`) that decides whether an event is worth building a
   * payload for at all — a "could match" predicate, deliberately not the
   * per-dispatch decision `matchersFor` makes.
   */
  hasMatchers(event: AgentEvent): boolean;
}

// ============================================================================
// Session Metadata
// ============================================================================

/**
 * Lightweight session metadata for diffing.
 * Only includes fields that trigger automations.
 */
export interface SessionMetadataSnapshot {
  permissionMode?: string;
  labels?: string[];
  isFlagged?: boolean;
  sessionStatus?: string;
  /** Session name (user-defined or auto-generated) */
  sessionName?: string;
}

// ============================================================================
// Script action (UA8.1, adapted from craft-agents-oss v0.13.4:packages/shared/src/automations/types.ts, Apache-2.0)
// ============================================================================

/** Runtime a script action executes under (resolved via `resolveScriptRuntime`). */
export type ScriptActionRuntime = 'bun' | 'node' | 'python3';

/**
 * A script action — spawns a workspace-local script via argv (never a shell). App events only: the host
 * `AutomationSystem`'s `ScriptHandler` runs it; on an agent event it never runs (validation warns).
 *
 * Security model (spec §15, adapted from upstream):
 * - The script path is workspace-relative and must stay within the workspace (symlink-aware, at run time).
 * - It runs ONLY through `runApprovedScript` (`script-executor.ts`): the bytes are read once, their sha256 must
 *   match a host-approvals ledger entry bound to `{ path, sha256, args, runtime }`, and those exact bytes run from
 *   a private 0700 copy. An unapproved or changed script is refused and the refusal is recorded in history.
 * - The child env is an ALLOWLIST (`buildScriptEnv` in `utils.ts`): platform essentials plus the named `NESSY_*`
 *   context keys — no prefix pass-through of `process.env` (upstream's `CRAFT_*` loop is dropped, reason (b)).
 * - Runs of the same matcher never overlap (per-matcher concurrency lock).
 */
export interface ScriptAction {
  type: 'script';
  /** Script path relative to the workspace root */
  script: string;
  /** Extra argv appended after the script path */
  args?: string[];
  /** Script runtime (default: 'bun') */
  runtime?: ScriptActionRuntime;
  /** Per-run timeout in ms (default 60_000, clamped to [1_000, 900_000]) */
  timeoutMs?: number;
  /**
   * Page slug this script refreshes. When set, the env carries `NESSY_PAGE_SLUG` / `_DIR` / `_DATA_DIR`, and the
   * outcome is recorded on the page's page.json (the completion marker the config watcher turns into a change).
   */
  page?: string;
}

/** Result of a script action */
export interface ScriptActionResult {
  type: 'script';
  /** Workspace-relative script path as configured */
  script: string;
  /** Whether the run completed with exit code 0 */
  success: boolean;
  /** Exit code, or null when the process was killed (timeout) or never spawned */
  exitCode: number | null;
  /** True when the run was refused before spawning (path, runtime, approval or managed-policy refusal) */
  blocked?: boolean;
  /** True when the run was skipped because the matcher was still running */
  skipped?: boolean;
  /** True when the process was killed after exceeding its timeout */
  timedOut?: boolean;
  /** Captured stdout (capped) */
  stdout: string;
  /** Captured stderr, or the refusal / spawn error (capped) */
  stderr: string;
  durationMs: number;
  /** Page slug when this run refreshed a page */
  page?: string;
}

/**
 * UA12.33 — the `inert` member of {@link HookBindingView}, merged here rather
 * than added in place: the interface sits above this file's highest doc-cited
 * line (1801), and a net insertion there moves every anchor under it
 * (wi16/common.md item 6, the hot-file rule). Declaration merging keeps the
 * safe-projection docblock where its readers cite it.
 *
 * True marks an action the binding view must not present as live: a `script`
 * action on an agent event never runs — the host ScriptHandler takes App
 * events only (`automations/handlers/script-handler.ts`) and the runtime hook
 * dispatch (`plugins/hooks-automation.ts`) runs no `script` either, so
 * validation only warns (`automations/validation.ts`). Marked rather than
 * hidden, for the same reason a disabled matcher is. The full list of cases
 * lives on ONE predicate, `isInertHookBinding` (`plugins/hooks-automation.ts`):
 * beside the script it marks a native `prompt` action on an agent event
 * (UB12.49) and a `webhook` where hooks.md withholds `http` (UB12.28).
 */
export interface HookBindingView {
  /** UA12.33 — see the merged block above; absent means the action can run. */
  inert?: boolean;
}

/**
 * Deprecated event name aliases: an old name is accepted when a config is read and rewritten to its canonical name.
 * Lives here (a module with type-only imports) so the session tools' fallback path (`session-tools-core`'s
 * `automation-management.ts`, F1.1212) reads the same table as the schema (`schemas.ts`, which re-exports it) without
 * a runtime edge into zod. Appended at the end of this file because its lines are cited by number.
 */
export const DEPRECATED_EVENT_ALIASES: Record<string, string> = {
  'TodoStateChange': 'SessionStatusChange',
};

/**
 * F1.1265 (the final sitting's D-21) — the TEXT of an `automation_list` answer: the count sentence, then one
 * compact line per automation (`<id> · <name> · <event> · mode <permissionMode> · enabled|disabled`). The list
 * used to live only in `structuredContent`, which a model reading the text content never sees, so "Found 2
 * automation(s)." told it nothing it could act on. ONE formatter for the three copies of the tool (the claude
 * in-process manager, the session MCP server's, session-tools-core's fallback), so they cannot drift. Bounded:
 * past {@link AUTOMATION_LIST_TEXT_MAX_LINES} lines the rest is counted, and `structuredContent` keeps all of them.
 * An absent `permissionMode` reads `default` (the automation runs in the session's default mode).
 */
export const AUTOMATION_LIST_TEXT_MAX_LINES = 50;

export function formatAutomationListText(
  automations: ReadonlyArray<{ automationId?: unknown; event?: unknown; enabled: boolean; automation?: unknown }>,
): string {
  const lines = [`Found ${automations.length} automation(s).`];
  for (const entry of automations.slice(0, AUTOMATION_LIST_TEXT_MAX_LINES)) {
    const automation = (entry.automation ?? {}) as { name?: unknown; permissionMode?: unknown };
    const name = typeof automation.name === 'string' && automation.name.trim() ? automation.name.trim() : '(no name)';
    const mode = typeof automation.permissionMode === 'string' ? automation.permissionMode : 'default';
    lines.push(`- ${String(entry.automationId)} · ${name} · ${String(entry.event)} · mode ${mode} · ${entry.enabled ? 'enabled' : 'disabled'}`);
  }
  const rest = automations.length - AUTOMATION_LIST_TEXT_MAX_LINES;
  if (rest > 0) lines.push(`… and ${rest} more (all of them are in the result's structured content).`);
  return lines.join('\n');
}
