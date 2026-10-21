/**
 * Which hook events actually FIRE on which runtime — the per-runtime event
 * table this tree did not have.
 *
 * ## Why it exists
 *
 * A plugin's hooks are imported once and are runtime-agnostic: the format
 * adapters translate a manifest, and the result is registered onto whatever
 * session the user happens to be on. Whether an event ever OCCURS, however, is
 * a property of the runtime. On codex those two facts disagree, and until this
 * file the disagreement was invisible: a codex session registers a
 * `PostToolUse` hook, reports the plugin installed and enabled, and the hook
 * cannot fire — because `codex-agent.ts` emits four events and `PostToolUse` is
 * not among them.
 *
 * The obvious repair — declare `PostToolUse` a deferral in
 * `DEFERRED_EXTERNAL_HOOK_EVENT_REASONS` beside `Setup` — is WRONG, and
 * measuring that is the first thing this file records. That table is consulted
 * by `mapExternalHookEventName` at IMPORT time, which knows no runtime; `Setup`
 * belongs there because it can fire nowhere, while `PostToolUse` fires on Pi
 * from `pi-agent.ts`'s tool executor and on claude-runtime through the SDK. A
 * global deferral would therefore have deleted a working capability on two
 * runtimes to describe an absence on a third — the failure mode AGENTS.md's
 * read-don't-invent rule names. The runtime-scoped answer is this table, read
 * where a session's hooks are REGISTERED.
 *
 * ## Three measured columns, and one deliberately empty
 *
 * `codex-runtime`, `anthropic` and `pi` are filled in; `nestor-cloud-agent` is
 * not, and that is a decision rather than a table half-written. What each
 * column's evidence CAN support differs, which is why they are described
 * separately instead of counted:
 *
 *  - **codex** is measurable. The emitters are our own `codex-agent.ts` plus
 *    `base-agent.ts` and the host, and where the answer depends on the binary
 *    it is `github.com/openai/codex` at the tag we ship. Every cell below is a
 *    reading of a source file named in its note.
 *  - **anthropic** was NOT, and is now measured in ONE DIRECTION ONLY (P6.89).
 *    Our own emissions are half of it; the other half is the SDK, which is a
 *    closed bundle, so "this event never fires there" is still not a claim we
 *    can make — a false "never fires" is worse than no claim, because the
 *    diagnostic it feeds would tell a user their working hook is dead. What the
 *    SDK DOES publish is the positive: `HookEvent` declares the events a hook
 *    may be registered on, and the shipped binary carries one
 *    `hook_event_name` payload-construction site per union member, each
 *    awaiting the hook runner. That is enough to record `emitted`, and never
 *    enough to record `unwired` or `unreachable`.
 *    {@link ANTHROPIC_HOOK_EVENT_EMISSION} says which cells rest on which.
 *  - **pi** was that same "measurable but not measured", and is measured since
 *    P6.90. Its vocabulary arrives from three surfaces, not one — `pi-agent.ts`,
 *    the `pi-agent-server` lifecycle bridge, and the host session layer — and
 *    the column came out `emitted` in every cell, which is a result only
 *    because each cell cites the handler it was read from.
 *    {@link PI_HOOK_EVENT_EMISSION} says where, and what each `emitted` does
 *    NOT claim.
 *  - **nestor-cloud-agent** is measurable and still not measured. Left
 *    unclaimed rather than guessed.
 *
 * `MEASURED_HOOK_EVENT_COLUMNS` is `satisfies Record<AgentProvider, boolean>`,
 * so adding a runtime is a compile-time decision at this file rather than a
 * silent default — the property `runtime-vocabulary.ts` exists to make
 * enforceable.
 *
 * ## The four verdicts are four different things
 *
 * `unwired` and `unreachable` must never be recorded as one. The first is work
 * we have not done; the second is work that has no subject. A row that collapses
 * them tells whoever reads it next that a buildable feature is impossible, or
 * that an impossible one is merely pending.
 *
 * ## What the native-first question found
 *
 * Asked before any cell was written to `unwired`: does codex already have the
 * mechanism? **It does.** `packages/codex-protocol/generated/v2/HookEventName.ts`
 * — generated from the codex source at the tag we ship, and agreed by
 * `HooksToml` and `ManagedHooksRequirements` — is TWELVE events (it was one
 * fewer until the 2026-09-11 lift to `rust-v0.150.1`, which added the last of
 * them; upstream #40511):
 *
 *   `preToolUse` `permissionRequest` `postToolUse` `preCompact` `postCompact`
 *   `sessionStart` `sessionEnd` `userPromptSubmit` `subagentStart`
 *   `subagentStop` `stop` `interrupt`
 *
 * ELEVEN of those twelve are also one of OUR events, name for name.
 * `interrupt` is the exception and the first of its kind: codex's vocabulary
 * with no `AgentEvent` counterpart, the mirror image of the two named below.
 * {@link CODEX_ONLY_HOOK_EVENTS} is where that asymmetry is spelled, and it
 * says why the answer is to name it rather than to mint an event for it.
 *
 * So five of the cells below marked `unwired` name a moment codex's own binary
 * already fires a hook on, and the cheapest route to them is codex's inline
 * `[hooks]` table rather than a host-side emitter.
 *
 * P6.14 took that route and spelled it at the bottom of this file
 * ({@link CODEX_NATIVE_HOOK_EVENTS}, {@link hookEventNativeRoute}); the writer
 * that can now emit such a table is `config-writer.ts`'s `buildCodexHooksToml`.
 * The cells below are unchanged and stay accurate: they say what OUR emitters
 * do, and our emitters still do nothing for those five. What changed is that
 * the alternative is no longer only a note — the vocabulary is reachable, and a
 * diagnostic can name the exact key a fix would be written under.
 *
 * Note also what codex's twelve do NOT contain: `postToolUseFailure` and
 * `stopFailure` are OUR vocabulary, not codex's, so those two can only ever be
 * minted host-side from the item stream.
 *
 * A prose count is exactly the thing this repo keeps getting wrong beside a
 * generated list — read the enum, not this comment, if the two disagree.
 */
import type { AgentProvider } from '../agent/backend/types.ts';
import { AGENT_EVENTS, type AgentEvent } from './types.ts';

export type HookEventEmissionKind =
  /** Measured: something emits this event on this runtime, so a hook can fire. */
  | 'emitted'
  /**
   * Measured: nothing emits it here, and the OCCURRENCE EXISTS — the runtime
   * reaches the moment the event describes. Buildable; the note says from what.
   */
  | 'unwired'
  /**
   * Measured: nothing reaches the moment AS THIS FORK DRIVES THE RUNTIME, so
   * there is nothing to emit from. Not buildable without first building the
   * underlying capability. The note must say whether the runtime's own binary
   * has the moment — `subagentStart` is in codex's own `HookEventName` and is
   * still `unreachable` here, because our codex sessions spawn no subagent.
   */
  | 'unreachable'
  /** No claim. The default for every column we have not measured. */
  | 'unmeasured';

export interface HookEventEmission {
  kind: HookEventEmissionKind;
  /** Where the verdict was read. Never a restatement of the kind. */
  note: string;
}

const UNMEASURED_LIFECYCLE: HookEventEmission = {
  kind: 'unmeasured',
  note: 'not measured on codex: a session-bracketing event, deprioritised against the in-turn events by the 2026-08-28 scope narrowing',
};

/**
 * Codex, measured at HEAD. Emitters cited by file; an absence is an absence of
 * an emitter, checked with `grep -a` over `codex-agent.ts`, `base-agent.ts` and
 * `SessionManager.ts` (the only three files that call `emitAutomationEvent` /
 * `executeAgentEvent` in production).
 */
const CODEX_HOOK_EVENT_EMISSION: Record<AgentEvent, HookEventEmission> = {
  // --- emitted: the four in `codex-agent.ts` the ledger counted ---
  SessionStart: { kind: 'emitted', note: 'codex-agent.ts, before the first turn is assembled' },
  UserPromptSubmit: { kind: 'emitted', note: 'codex-agent.ts, ahead of the block check that can end the turn' },
  Stop: { kind: 'emitted', note: 'codex-agent.ts `emitStopHookOnce`' },
  SessionEnd: { kind: 'emitted', note: 'codex-agent.ts `emitSessionEndOnce`, with the documented exit reason' },

  // --- emitted, and NOT counted by the "exactly four" reading: these come from
  // BaseAgent and the host, which codex shares. The ledger's G1/G4 cells counted
  // `codex-agent.ts` alone.
  InstructionsLoaded: { kind: 'emitted', note: 'base-agent.ts `emitInstructionsLoaded`, on the shared instruction-loading path every backend uses' },
  McpElicitation: { kind: 'emitted', note: 'base-agent.ts `handleMcpElicitation` — "shared by every backend"; CodexAgent registers the handler in its constructor' },
  ElicitationResult: { kind: 'emitted', note: 'base-agent.ts `handleMcpElicitation`, same registration' },
  MessageDisplay: { kind: 'emitted', note: 'SessionManager, opened from `text_delta` / `text_complete`, which codex produces like every runtime' },
  UserPromptExpansion: { kind: 'emitted', note: 'SessionManager `emitUserPromptExpansion`, on the host slash-command path with no provider gate' },

  // --- unwired: the occurrence exists on codex and nothing emits ---
  PreToolUse: {
    kind: 'unwired',
    note: "`preToolUse` is in codex's own HookEventName enum, and codex additionally runs our approval bridge per tool call (`floorVerdict`, `consultPermissionRules`); `runPreToolUseChecks` and the PreToolUse emission are pi-agent.ts-only. P3.335 minted the two POST events and deliberately LEFT THIS ONE: its whole contract is that it can deny, the only place a codex call can still be stopped is the approval bridge, and codex does not raise that bridge under `dangerFullAccess` or auto-approval — so a report-only emission would move this cell to `emitted` while its deny enforced nothing",
  },
  // P3.335 · minted HOST-side from the adapter's own `tool_result` stream, with
  // Pi's payload field for field, after the owner closed the native `[hooks]`
  // route (2026-08-29) — see `CodexAgent.noteCodexToolCallForHooks` for the
  // three residues, of which two are named on the event itself.
  PostToolUse: {
    kind: 'emitted',
    note: "codex-agent.ts `noteCodexToolCallForHooks`, from the `item/completed` tool result the transcript is built from, carrying `tool_input` remembered off the matching `tool_start`. RESIDUE: `updatedToolOutput` and a `block` decision cannot be honoured — the item is already committed when the notification arrives — and both are reported on the debug channel rather than dropped",
  },
  PostToolUseFailure: {
    kind: 'emitted',
    note: "same emitter, split off the adapter's `isError` exactly as Pi and nestor-cloud split theirs; carries `error` rather than `tool_response`, which is Pi's own shape",
  },
  PermissionRequest: {
    kind: 'unwired',
    note: "`permissionRequest` is in codex's own HookEventName enum, and codex already surfaces approvals through `onPermissionRequest`; only pi-agent.ts emits the event. The in-turn one to read twice: it bears on what the agent may do, not merely on what is reported",
  },
  PermissionDenied: {
    kind: 'emitted',
    note: "P6.579 · codex-agent.ts `emitCodexPermissionDeniedHook`, minted host-side on Pi's OWN two eligible causes and no others — the `dontAsk` denial of a would-prompt action, and codex's `item/autoApprovalReview/completed` denial, which is the judge Pi calls the guardian. A floor refusal, the `deniedPaths` refusal and a user `deny` rule stay silent here exactly as they do on Pi. Still our vocabulary and not codex's: codex's `HookEventName` values have no counterpart. RESIDUE: Pi honours the documented `{retry: true}` output and codex cannot — our answer is a synchronous response and the review verdict is a past-tense notification — so this fires and forgets",
  },
  StopFailure: {
    kind: 'emitted',
    note: "P6.118 · codex-agent.ts `emitCodexStopFailureHookOnce`, minted host-side from `ErrorNotification` on the TERMINAL arm only (`willRetry !== true`, and the error must name the active turn), once per turn, with Pi's four fields — `error` projected from codex's own `CodexErrorInfo` onto the documented ten, the raw code beside it on `error_code`, which is what the matcher reads first. Still our vocabulary and not codex's: codex's `HookEventName` values have no counterpart",
  },
  PreCompact: {
    kind: 'unwired',
    note: "`preCompact` is in codex's own HookEventName enum, and codex has its own `thread/compact/start` arm; only pi-agent.ts emits the event. P6.118 minted its sibling and deliberately left this one: codex reports compaction only in the PAST tense (`event-adapter.ts`'s compaction docblock — there is no start notification at all), so the only moment to hang it on is our own `/compact` request, which fires on the manual path and never on the automatic one",
  },
  PostCompact: {
    kind: 'emitted',
    note: "P6.118 · codex-agent.ts `emitCodexPostCompactHook`, minted host-side off `CodexEventAdapter.consumeObservedCompaction()` — the single funnel both compaction channels already route through (the `contextCompaction` item and the deprecated `thread/compacted` notification). Pi's fields exactly; `compact_summary` is `''` because codex publishes no summary on either channel (`ThreadItem` carries `{ type, id }`), which is Pi's own value when its compaction entry has none. `postCompact` IS in codex's own hook vocabulary, but the native `[hooks]` route stays closed by the 2026-08-29 ruling, so this is P3.335's host-side seam",
  },

  // --- unreachable: codex has no such moment ---
  SubagentStart: {
    kind: 'unreachable',
    note: "`subagentStart` IS in codex's own HookEventName enum, so the binary has the moment — but our codex sessions spawn no subagent (`/subtask` withheld; `thread/fork` re-forks the thread and produces no background subagent) and the host emitter hangs off the `provider === 'pi'` child-session port, so nothing reaches it as we drive codex",
  },
  SubagentStop: {
    kind: 'unreachable',
    note: "`subagentStop` is likewise in codex's own enum; same absent subagent lifecycle on our side, same Pi-gated host emitter",
  },
  WorktreeCreate: {
    kind: 'unreachable',
    note: "not in codex's own hook vocabulary, and a codex session can never enter the worktree isolation state (`worktreeGateContext()` is called from pi-agent.ts and, since P6.839, claude-agent.ts — never from codex), so no worktree is ever created for it to hook",
  },
  WorktreeRemove: { kind: 'unreachable', note: 'same absent worktree lifecycle' },

  // --- emitted, host-side, so identical on all three runtimes (P3.374) ---
  PreModelSwitch: {
    kind: 'emitted',
    note: "SessionManager.updateSessionModel, awaited before the switch is applied — the seam is the HOST's, so codex gets it on the same line Pi and claude-runtime do. Not in codex's own HookEventName values, which carry no model-switch event at all; this is a host event, not a projection of a native one",
  },
  PostModelSwitch: {
    kind: 'emitted',
    note: "SessionManager.updateSessionModel, after the model has changed. Same host seam. Its documented context (exit-0 plain stdout or `additionalContext`) is kept as the session's pending model-switch context and added to the next prompt by the host send path (UB12.69), so codex gets it on the same line Pi and claude-runtime do",
  },

  // --- unmeasured ---
  PostToolBatch: {
    kind: 'unmeasured',
    note: 'not measured: whether the codex item stream carries a batch boundary at all is a question about the binary, and the answer belongs in the codex source, not here',
  },
  TaskCreated: {
    kind: 'unmeasured',
    note: "not measured: the host task service is built under `provider === 'pi'`, yet codex's Stop already reads `hookTaskRegistryPort` — the two disagree and the disagreement was not resolved",
  },
  TaskCompleted: { kind: 'unmeasured', note: 'same unresolved disagreement as TaskCreated' },
  McpResult: { kind: 'unmeasured', note: "not measured: nothing on the codex path emits it and codex's own vocabulary has no counterpart. This note said \"no production emitter on any runtime\" until P6.90 measured Pi and found one — lifecycle-bridge.ts's `tool_execution_end` — so the absence is codex's, not the event's" },
  ConfigChange: UNMEASURED_LIFECYCLE,
  CwdChanged: UNMEASURED_LIFECYCLE,
  DirectoryAdded: UNMEASURED_LIFECYCLE,
  FileChanged: UNMEASURED_LIFECYCLE,
  Notification: UNMEASURED_LIFECYCLE,
};

/**
 * P6.89 — claude-runtime, measured in ONE DIRECTION.
 *
 * ## What the evidence is, and what it is not
 *
 * The SDK is a closed bundle, so an ABSENCE cannot be measured here. What CAN
 * be measured is the presence, and the runtime publishes it twice:
 *
 *  - **its own declaration.** `sdk.d.ts:837` `export declare type HookEvent =
 *    'PreToolUse' | … | 'MessageDisplay'` — 31 names — consumed as
 *    `hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>`. That is the
 *    native-first answer for this row: the runtime already has the mechanism,
 *    and the column is a reading of it rather than something we built.
 *  - **the shipped binary.** `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`
 *    (306,981,408 bytes when this was written; 197,171,680 at `0.3.251`, a size
 *    being a reading with a date) carries ONE `hook_event_name` payload
 *    construction per union member, keyed by that member's own name, each
 *    feeding an awaited hook runner; the
 *    `WorktreeRemove` cell quotes its site verbatim so the shape is on the page.
 *    CONTROL, run on the same command: our four events that were NOT in the
 *    union — `McpElicitation`, `McpResult`, `PreModelSwitch`, `PostModelSwitch`
 *    — scored 0, as did an invented name. So the probe distinguishes.
 *
 *    **Re-taken 2026-09-13 on `0.3.251` (C3.380's lift), and TWO of that control
 *    moved from 0 to 1.** The union is 33 names now, not 31: `PreModelSwitch`
 *    and `PostModelSwitch` joined it, and the binary constructs
 *    `hook_event_name:"PreModelSwitch"` and `…"PostModelSwitch"` at one site
 *    each — the same shape every other cell cites. Needle counts, both
 *    instruments named (`grep -acF` lines / `grep -aoF … | wc -l` occurrences),
 *    the needle in every case being the payload construction (the
 *    `hook_event_name` key with the event's own quoted name), never the bare
 *    name: PreModelSwitch 1/1 and PostModelSwitch 1/1, against the positive
 *    control WorktreeRemove 1/1 and the negative `nessyNotARealHookEvent` 0/0.
 *    The control that still holds is the OTHER two: the same construction for
 *    McpElicitation scores 0/0 and for McpResult 0/0.
 *
 *    Two cautions, both paid on this lift. The BARE name `McpElicitation` scores
 *    5/5 in the binary and is no evidence of an event at all — which is why the
 *    needle is the construction. And the needle is deliberately NOT SPELLED in
 *    its matched form anywhere in this file: the test beside it scans this
 *    module for that exact literal and requires every hit to be a real union
 *    member, so a correction that quotes the needle for a name the union lacks
 *    re-creates the very finding it is repairing (AGENTS.md §Traps).
 *
 * Neither route can yield `unwired` or `unreachable`, and no cell below carries
 * one. `includeHookEvents` cannot help either: our own measured comment at
 * `claude-agent.ts` records that the `z.type==='callback'` branch, where
 * SDK-registered host hooks run, returns without touching either emitter — so
 * that channel proves emission and never absence.
 *
 * ## The result, stated because it is the row's own answer
 *
 * Every event in our vocabulary except `McpResult` is `emitted` on claude:
 * most through the SDK's own dispatch, the rest host-side (`PreToolUse`, which
 * `mergeClaudeSdkHooks` deliberately routes through the host pipeline instead,
 * plus `McpElicitation`, which the SDK still does not have; the two
 * model-switch events joined the SDK's union at `0.3.251` and stay host-emitted
 * here — see the cells). Do not read a COUNT out of this sentence; it has moved
 * once already. So `hookEventsThatNeverFire('anthropic')` is empty — not because the
 * column is silent, which was the state P6.86 exists to caveat, but because it
 * was measured and nothing is lost. A switch report can now say so.
 */
const ANTHROPIC_HOOK_EVENT_EMISSION: Record<AgentEvent, HookEventEmission> = {
  InstructionsLoaded: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"InstructionsLoaded"` at one site that awaits the hook runner; also emitted host-side by base-agent.ts `emitInstructionsLoaded`, which every backend shares, so this cell holds on both halves',
  },
  SessionStart: {
    kind: 'emitted',
    note: 'D1.155 — HOST-SIDE since then, and the note it replaces was true of the RUNTIME and false of this fork\'s hooks. The three declaration-backed facts still hold (`HookEvent` declares it; the shipped binary constructs `hook_event_name:"SessionStart"` at one site that awaits its hook runner; `includeHookEvents` reports settings-tier `SessionStart` hooks), and none of them was about OUR matchers: W19-r\'s headless rig drove a host `hooks.json` `SessionStart` hook on all three runtimes and claude was the only silent one, although `sdk.mjs`\'s `initialize` serialises every event\'s matchers to the child with no per-event filter. `claude-agent.ts` now emits it once per session before the turn is assembled, with the same `source` discriminator pi and codex use, and `mergeClaudeSdkHooks` drops the trusted copy so the migration cannot become a duplication',
  },
  UserPromptSubmit: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"UserPromptSubmit"` at one site that awaits the hook runner',
  },
  UserPromptExpansion: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"UserPromptExpansion"` at one site that awaits the hook runner; also emitted host-side by SessionManager on the slash-command path with no provider gate',
  },
  PreToolUse: {
    kind: 'emitted',
    note: 'emitted host-side on this backend rather than through the SDK registration: `mergeClaudeSdkHooks` DROPS the trusted `PreToolUse` bucket on purpose (claude-agent.ts) and `runClaudePreToolUseHookPipeline` calls `executeAgentEvent(\'PreToolUse\', …)` instead, over the same four config tiers plus the component layer. The SDK declares the event too and the binary has its construction site, so both routes exist and the host one is the live one',
  },
  PermissionRequest: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"PermissionRequest"` at one site that awaits the hook runner',
  },
  PermissionDenied: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"PermissionDenied"` at one site that awaits the hook runner; claude-agent.ts additionally registers an internal matcher on it as an audit record',
  },
  PostToolUse: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"PostToolUse"` at one site that awaits the hook runner',
  },
  PostToolUseFailure: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"PostToolUseFailure"` at one site that awaits the hook runner',
  },
  PostToolBatch: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"PostToolBatch"` at one site that awaits the hook runner. RESIDUE, stated rather than implied: a construction site is not a reachability proof for OUR configuration — this is the positive half only, and the negative is not claimable against a closed bundle',
  },
  Notification: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"Notification"` at one site that awaits the hook runner. Same residue as PostToolBatch: the site exists in the binary; whether our headless drive reaches it is not measured, and an `unwired` here would be a claim the bundle cannot support',
  },
  MessageDisplay: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"MessageDisplay"` at one site that awaits the hook runner; also emitted host-side by SessionManager from `text_delta` / `text_complete`, which claude produces like every runtime',
  },
  PreModelSwitch: {
    kind: 'emitted',
    note: 'host event: SessionManager.updateSessionModel `runModelSwitchHook`, awaited before the switch is applied, with no provider gate — which is what makes the three runtimes answer alike. It was NOT a projection of a native one and it still is not, but the second half of that sentence has EXPIRED: at `0.3.251` (2026-09-13, C3.380) the SDK union carries `PreModelSwitch` and the binary constructs `hook_event_name:"PreModelSwitch"` at one site, where both scored 0 at `0.3.247`. What this cell records is unchanged — the emission you get here is the host\'s — and whether to ALSO register the vendor\'s own was a switch verdict, DECIDED by D1.165 and now structural: both names are in `claude-agent.ts`\'s `CLAUDE_HOST_EMITTED_HOOK_EVENTS`, so a user matcher is not handed to the child. The reason is not duplication — a switch this fork drives is applied by respawning with a new `Options.model`, so the child never switches into it — it is that the child\'s own occurrences (a fallback, an auto-downgrade) would give that matcher a SECOND set of firings on claude alone, with a documented veto, that codex cannot have at all',
  },
  PostModelSwitch: {
    kind: 'emitted',
    note: 'same host seam, after the model has changed; the SDK union and the binary gained it at `0.3.251` on the same lift as its sibling, and the same switch verdict was taken for both (D1.165 — declined, structurally, in `CLAUDE_HOST_EMITTED_HOOK_EVENTS`). Its documented context (exit-0 plain stdout or `additionalContext`) reaches the next request through the host send path on every runtime (UB12.69): the host keeps it as the session\'s pending model-switch context, the last switch\'s only',
  },
  SubagentStart: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"SubagentStart"` at one site that awaits the hook runner; claude-agent.ts also registers a debug matcher on it, withheld when the user\'s `disableAllHooks` is set. Unlike codex, this fork DOES spawn claude subagents, so the moment occurs',
  },
  SubagentStop: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"SubagentStop"` at one site that awaits the hook runner; `withClaudeHostTaskRegistry` decorates this event\'s matchers with the host\'s task registry, which presupposes the SDK dispatching it',
  },
  TaskCreated: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"TaskCreated"` at one site that awaits the hook runner. Note the disagreement recorded on codex\'s cell does not arise here: the moment is the SDK\'s, not the Pi-gated host task service\'s',
  },
  TaskCompleted: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"TaskCompleted"` at one site that awaits the hook runner, same as TaskCreated',
  },
  StopFailure: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"StopFailure"` at one site that awaits the hook runner. Our vocabulary AND the SDK\'s — unlike codex, whose own list has no counterpart',
  },
  Stop: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"Stop"` at one site that awaits the hook runner; `withClaudeHostTaskRegistry` enriches this event\'s payload with the host\'s cron and background records, which presupposes the dispatch',
  },
  CwdChanged: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"CwdChanged"` at one site that awaits the hook runner',
  },
  DirectoryAdded: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"DirectoryAdded"` at one site that awaits the hook runner',
  },
  FileChanged: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"FileChanged"` at one site that awaits the hook runner',
  },
  WorktreeCreate: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"WorktreeCreate"` at one site that awaits the hook runner; and this fork uses that dispatch as its own creation seam — `withClaudeWorktreeHooks` registers a host matcher whose return value the binary takes as the worktree path (`hooks.md#worktreecreate`), so the firing is load-bearing rather than incidental',
  },
  WorktreeRemove: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"WorktreeRemove"` at one site that awaits the hook runner; the sampled site reads `let l={...my(e,Yt()),hook_event_name:"WorktreeRemove",worktree_path:t},c=await QB({session:e,hookInput:l,timeoutMs:My})` — quoted because it is the shape every one of these cells was read from',
  },
  PreCompact: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"PreCompact"` at one site that awaits the hook runner',
  },
  PostCompact: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"PostCompact"` at one site that awaits the hook runner',
  },
  ConfigChange: {
    kind: 'emitted',
    note: '`HookEvent` declares it (sdk.d.ts:837) and the shipped binary constructs `hook_event_name:"ConfigChange"` at one site that awaits the hook runner; also emitted host-side by SessionManager with no provider gate',
  },
  McpElicitation: {
    kind: 'emitted',
    note: 'host-side only, and the SPELLINGS DIVERGE: base-agent.ts `handleMcpElicitation` emits it through `emitAutomationEvent` on the shared path ClaudeAgent reaches via its `onElicitation` option, while the SDK\'s own name for the moment is `Elicitation` (0 occurrences of `McpElicitation` in the binary). `format-adapters.ts` already translates a claude plugin\'s `Elicitation` to this name at import; the SDK-registered key would not match, and the host emitter is why the hook still fires',
  },
  McpResult: {
    kind: 'unmeasured',
    note: "not measured: nothing on the claude path emits it and the SDK's `HookEvent` union has no counterpart (0 occurrences in the binary). This note said \"no production emitter on ANY runtime\" until P6.90 measured Pi and found one — lifecycle-bridge.ts's `tool_execution_end`, which is Pi-only, so the claim was invisible from here. Deliberately the same verdict codex's cell carries: recording `unwired` on one runtime and `unmeasured` on the other would make the switch report name a difference that is not there",
  },
  ElicitationResult: {
    kind: 'emitted',
    note: 'both halves: base-agent.ts emits it host-side from the same elicitation path, and unlike its sibling the SDK spells it identically — `ElicitationResult` is in the union and the binary has its construction site',
  },
  SessionEnd: {
    kind: 'emitted',
    note: 'D1.155 — HOST-SIDE since then, from `claude-agent.ts`\'s `emitSessionEndOnce` through an `endLifecycle` override, with the documented exit reason and the same start-latch guard codex uses. The declaration is unchanged and was never the question (`HookEvent` declares it and the shipped binary constructs `hook_event_name:"SessionEnd"` at one site that awaits its hook runner); what W19-r measured is that nothing reached OUR matchers — claude answered SIGTERM 143 and SIGINT 130 with the process tree gone both times and `SessionEnd` ABSENT both times, where pi ran it on SIGTERM. A user\'s cleanup hook is the ordinary use of this event, so the absence was silent and total',
  },
};

/**
 * P6.90 — Pi, measured at HEAD, and the column that comes out ALL `emitted`.
 *
 * ## Why that is a result rather than a rubber stamp
 *
 * The row that opened this measurement named its own failure signal: *"an
 * all-`emitted` Pi column with no citations is the failure signal"*. So every
 * cell below carries the file and the HANDLER the verdict was read from, and
 * the verdicts were reached by walking `AGENT_EVENTS` against the three emitter
 * surfaces a Pi session actually has, rather than by assuming the runtime this
 * fork was built around covers its own vocabulary:
 *
 *  - **the host agent**, `pi-agent.ts` — 24 emission sites, the largest set in
 *    the tree, and the file the codex column names over and over in the form
 *    *"only pi-agent.ts emits the event"*. Those sentences are the codex
 *    column's own testimony about this one.
 *  - **the subprocess lifecycle bridge**,
 *    `pi-agent-server/src/extensions/lifecycle-bridge.ts`, whose
 *    `automation_event` lines arrive on `handleLine` and are re-emitted
 *    host-side. Two of its names are dropped ON ARRIVAL as echoes
 *    (`PI_ECHO_DROPPED_AGENT_EVENTS`) and a third is consumed as a flag, so for
 *    those the host is the live emitter and the bridge is not — the cells say
 *    which, because "the bridge sends it" and "a hook can fire" are different
 *    facts here.
 *  - **the host session layer**, `SessionManager.ts` and `base-agent.ts`, which
 *    every runtime shares — except for the six events whose only producer hangs
 *    off a port constructed under `provider === 'pi'`.
 *
 * ## The six cells that are Pi's ALONE
 *
 * `SubagentStart`, `SubagentStop`, `WorktreeCreate`, `WorktreeRemove`,
 * `TaskCreated` and `TaskCompleted` reach a hook only through
 * `piChildSessionPort` and the Pi task service, and BOTH are built behind
 * `provider === 'pi'` (`SessionManager.createManagedRuntime`'s
 * `piPermissionService` gate). On codex those same six are `unreachable` or
 * `unmeasured` and the difference between the two columns is exactly that gate.
 * Recorded `emitted` here because the verdict is per RUNTIME: a Pi session
 * reaches the moment, and a hook registered on it fires.
 *
 * ## What this column does NOT claim
 *
 * `emitted` means *a hook registered on this event can fire on a Pi session*,
 * not *it fires on every turn*. Several cells are conditional by construction —
 * `CwdChanged` only on a cwd delta, `FileChanged` only for a mutating tool that
 * succeeded, `DirectoryAdded` only for a root not already registered,
 * `McpResult` only for a tool whose name resolves to an MCP server. The
 * four-verdict vocabulary has no cell for *fires under a condition*, and
 * minting one would change the meaning of the other two columns, so the
 * condition is stated in the note instead.
 *
 * Nothing here is `unwired` or `unreachable`, so `hookEventsThatNeverFire('pi')`
 * is empty — the same shape `anthropic` has after P6.89, and for a different
 * reason: on claude an absence is unmeasurable, on Pi every moment was found
 * to have a producer. `nestor-cloud-agent` is now the only unmeasured column,
 * which is what P6.86's caveat is left to cover.
 */
const PI_HOOK_EVENT_EMISSION: Record<AgentEvent, HookEventEmission> = {
  InstructionsLoaded: {
    kind: 'emitted',
    note: "base-agent.ts `emitInstructionsLoaded`, on the shared instruction-loading path every backend uses. NOT the subprocess: lifecycle-bridge.ts's `session_start` handler records why it stopped emitting it — \"this subprocess has no instruction inventory, so the only event it could ever produce was one content-free session-scoped ping\"",
  },
  SessionStart: {
    kind: 'emitted',
    note: "pi-agent.ts `chatImpl` (first turn of a session) and `emitPostCompactSessionStart` (the documented post-compaction occurrence), both awaited so a decision is read. The bridge emits its own from `pi.on('session_start')`, and `handleLine`'s `automation_event` case consumes THAT one as the `_sessionStartEmitted` flag instead of re-firing it — one emission per occurrence, host-side",
  },
  UserPromptSubmit: {
    kind: 'emitted',
    note: "pi-agent.ts's prompt gate over `PI_PROMPT_GATE_EVENTS`, awaited BEFORE the prompt is sent, which is what makes the documented block able to stop the turn. The bridge's `before_agent_start` copy is dropped on arrival by `PI_ECHO_DROPPED_AGENT_EVENTS` — it would run the hook a second time for the same turn and could not act on the answer",
  },
  UserPromptExpansion: {
    kind: 'emitted',
    note: 'SessionManager `emitUserPromptExpansion`, on the host slash-command path with no provider gate, called before the command is resolved so a block can still prevent the expansion. R73 removed the bridge\'s per-turn copy and left the name in the drop list so an older packaged Pi bundle cannot revive it',
  },
  PreToolUse: {
    kind: 'emitted',
    note: "pi-agent.ts `handlePreToolUseRequest` → `runPreToolUseChecks`, awaited while the SUBPROCESS BLOCKS on the answer. That is the difference from codex's cell, which is `unwired` precisely because a report-only emission would move it to `emitted` while its deny enforced nothing: here the deny is the answer the subprocess waits for",
  },
  PermissionRequest: {
    kind: 'emitted',
    note: "pi-agent.ts, from the permission band, with the documented input. SessionManager's R15 note is the corroboration and the boundary: the Pi permission service deliberately fires NEITHER this event nor `PermissionDenied`, because the band already does and a forwarder made every prompt fire both a second time with a payload carrying neither `tool_input` nor `permission_mode`",
  },
  PermissionDenied: {
    kind: 'emitted',
    note: 'pi-agent.ts, same permission band, on the deny path — our own vocabulary, which codex has no counterpart for and does not emit',
  },
  PostToolUse: {
    kind: 'emitted',
    note: "pi-agent.ts `handlePostToolUseRequest`, run BEFORE Pi commits the tool result to model context, so `updatedToolOutput` is honoured through `resolveHookToolOutputRewrite`. Codex's cell is `emitted` too and cannot honour it — the item is already committed when the notification arrives — so the two columns agree on the kind and differ on the residue",
  },
  PostToolUseFailure: {
    kind: 'emitted',
    note: "pi-agent.ts `handlePostToolUseRequest`, the same handler split off `req.isError` — carries `error` rather than `tool_response`. This is the shape codex's own two POST cells were built to match, so it is Pi that defines the payload the other runtimes are read against",
  },
  PostToolBatch: {
    kind: 'emitted',
    note: "lifecycle-bridge.ts `pi.on('turn_end')`, once per turn with `batch_count` and `error_count` read off the turn's own `toolResults`. The cell codex leaves `unmeasured` — whether its item stream carries a batch boundary at all is a question about the binary — so the two columns are not comparable here and neither pretends to be",
  },
  Notification: {
    kind: 'emitted',
    note: 'pi-agent.ts `emitNotificationHook`, carrying the documented `notification_type` a matcher reads plus the free-text `title`/`message`; fire-and-forget through `emitAutomationEventDetached`, which is the shape that has a failure channel',
  },
  MessageDisplay: {
    kind: 'emitted',
    note: 'SessionManager, opened from `text_delta` / `text_complete`. Host-side and provider-blind, which is why the codex cell cites the same emitter',
  },
  PreModelSwitch: {
    kind: 'emitted',
    note: "SessionManager `runModelSwitchHook` from `updateSessionModel`, awaited before the switch is applied and fail-CLOSED on a block, per the page's own default. The seam is the host's, so Pi gets it on the same line the other two runtimes do — and through `withPinnedConfigChange`, because a model switch happens between turns and `agentAutomationSystem` is a per-turn object",
  },
  PostModelSwitch: {
    kind: 'emitted',
    note: 'SessionManager `runModelSwitchHook`, after the model has changed; cannot block. Same host seam: its documented context (exit-0 plain stdout or `additionalContext`) is kept as the session\'s pending model-switch context and added to the next prompt by the host send path, as on the other two runtimes (UB12.69)',
  },
  SubagentStart: {
    kind: 'emitted',
    note: "SessionManager `executePiChildStartAutomation`, reached through `piChildSessionPort`, which is constructed only when `provider === 'pi'`. Pi is the runtime that HAS the subagent lifecycle: codex's identical cell is `unreachable` for that reason and not for a missing emitter",
  },
  SubagentStop: {
    kind: 'emitted',
    note: 'SessionManager `executePiChildTerminalAutomation`, same Pi-only port, dispatched after the fork result is recorded in the transcript so a blocking decision cannot erase what the child answered; carries `stop_hook_active`, `agent_id`, `agent_type` and the child session file as the subagent transcript',
  },
  TaskCreated: {
    kind: 'emitted',
    note: "SessionManager `executePiTaskAutomationEvent`, from the `TaskService` built under `provider === 'pi'`, with `task_id` / `task_subject` / `task_description`. Codex's cell is `unmeasured` over an unresolved disagreement between that gate and its own `hookTaskRegistryPort` read — the disagreement is about codex and does not touch this column",
  },
  TaskCompleted: {
    kind: 'emitted',
    note: 'SessionManager `executePiTaskAutomationEvent`, same emitter, and the one whose `finally` releases the retained automation authority — so the event is not merely emitted, it is the thing the task lifecycle is closed on',
  },
  StopFailure: {
    kind: 'emitted',
    note: 'pi-agent.ts, once per turn (`stopFailureHookEmittedForTurn`), from the failed-turn path with the documented `error` mapped through `toDocumentedStopFailureError` plus `error_code` and the bounded `error_details`. Our own vocabulary — codex\'s own list still has no counterpart, but since P6.118 the codex COLUMN emits it too, minted host-side from `ErrorNotification`',
  },
  Stop: {
    kind: 'emitted',
    note: 'pi-agent.ts `emitStopHookOnce`, the same once-per-turn shape codex\'s cell cites',
  },
  CwdChanged: {
    kind: 'emitted',
    note: "lifecycle-bridge.ts `pi.on('user_bash')`, on a cwd DELTA only, carrying `new_cwd` plus `old_cwd` and its permanent read-path alias `previous_cwd`. Conditional by construction, and the condition is the documented occurrence: a directory that did not change is not a change",
  },
  DirectoryAdded: {
    kind: 'emitted',
    note: "pi-agent.ts, on `register_repo_root` and only when the root is new, with `source: 'register_repo_root'` — the page's other value, `slash_command`, is unproducible because Nessy has no `/add-dir`",
  },
  FileChanged: {
    kind: 'emitted',
    note: "lifecycle-bridge.ts `pi.on('tool_execution_end')` for a tool in `FILE_MUTATING_TOOLS` that did not error, with the documented `add` / `change` split taken from an existence probe at `tool_execution_start` — the only moment the distinction is observable. `unlink` is unreachable under this trigger and the handler says so",
  },
  WorktreeCreate: {
    kind: 'emitted',
    note: "SessionManager's `emitWorktree` on the Pi child-session port, `agent_type: 'worktree'`, carrying the lease id, path and branch — and the ONE event on this column with a return channel: hooks.md exempts it from exit-2-only, so a `block`/`deny` decision aborts creation through the lease service's own abort path",
  },
  WorktreeRemove: {
    kind: 'emitted',
    note: "SessionManager's `emitWorktree`, the same callback on the same Pi-only port, on the release half of the lease lifecycle",
  },
  PreCompact: {
    kind: 'emitted',
    note: "pi-agent.ts `handlePreCompactRequest`, AWAITED: the subprocess sends `pre_compact_request` and blocks on the verdict, so the documented block really cancels the compaction. The bridge's own `emit('PreCompact')` is the fallback and is never taken — both `createSession` sites pass `requestCompactionDecision`, and the bridge fires one or the other, never both",
  },
  PostCompact: {
    kind: 'emitted',
    note: "lifecycle-bridge.ts `pi.on('session_compact')`, with `compact_summary` read off the compaction entry Pi already saved rather than recomputed",
  },
  ConfigChange: {
    kind: 'emitted',
    note: 'two producers: pi-agent.ts `emitConfigChangeHook`, with `config_keys` and a digest, whose block is advisory because the config is already committed; and SessionManager on the host config path. Codex\'s cell is `unmeasured` under the 2026-08-28 scope narrowing, not absent',
  },
  McpElicitation: {
    kind: 'emitted',
    note: "two producers: base-agent.ts `handleMcpElicitation` on the shared path every backend reaches, and lifecycle-bridge.ts `pi.on('tool_execution_start')` for a tool whose name resolves to an MCP server, which carries `correlation_id` so the result can be paired with it",
  },
  McpResult: {
    kind: 'emitted',
    note: "lifecycle-bridge.ts `pi.on('tool_execution_end')` for an MCP tool, with the `correlation_id` carried from the matching start. THIS CELL REFUTES a sentence the other two columns carried until P6.90 — that the event \"has no production emitter on any runtime\". It has exactly one, it is Pi's subprocess bridge, and because that bridge is Pi-only the claim was invisible from either of the runtimes it was written on; both notes are corrected rather than left standing",
  },
  ElicitationResult: {
    kind: 'emitted',
    note: "base-agent.ts `handleMcpElicitation` host-side, plus THREE bridge sites: `success` and `failure` off `tool_execution_end`, and `cancelled` for anything still pending at `session_shutdown` — so the outcome field is total rather than success-only",
  },
  SessionEnd: {
    kind: 'emitted',
    note: 'pi-agent.ts `emitSessionEndOnce`, with the documented exit reason, and ordered behind `Stop` because `emitAutomationEvent` orders by call rather than completion',
  },
};

/**
 * Which columns carry a claim. `satisfies Record<AgentProvider, boolean>` so a
 * new runtime cannot inherit `false` silently — adding one is a decision taken
 * here, in front of the reasons above.
 */
const MEASURED_HOOK_EVENT_COLUMNS = {
  'codex-runtime': true,
  anthropic: true,
  pi: true,
  'nestor-cloud-agent': false,
} as const satisfies Record<AgentProvider, boolean>;

const UNMEASURED_RUNTIME: HookEventEmission = {
  kind: 'unmeasured',
  note: 'this runtime has no measured column in runtime-hook-events.ts',
};

/**
 * A measured column that has no cell for THIS event. Distinct from
 * {@link UNMEASURED_RUNTIME} on purpose: "we measured this runtime and not this
 * moment" and "we measured nothing here" are different facts, and a reader who
 * cannot tell them apart cannot tell a half-filled column from an absent one.
 */
const UNMEASURED_EVENT: HookEventEmission = {
  kind: 'unmeasured',
  note: 'this runtime has a measured column in runtime-hook-events.ts, and no cell for this event in it',
};

/**
 * One runtime's column. `Partial` because a column may be filled event by
 * event; a missing cell answers {@link UNMEASURED_EVENT} rather than another
 * runtime's verdict.
 */
export type HookEventEmissionTable = Partial<Record<AgentEvent, HookEventEmission>>;

/**
 * P6.88 — the tables, KEYED BY PROVIDER.
 *
 * The lookup below used to read `CODEX_HOOK_EVENT_EMISSION` whatever provider
 * it was handed, which was correct only for as long as exactly one column was
 * `true`: flipping a second column would have reported codex's verdicts as that
 * runtime's, and this file's own header calls a false claim worse than no
 * claim. Keyed by provider, a column that is `true` and empty answers
 * `unmeasured` for every event instead.
 *
 * `satisfies Record<AgentProvider, HookEventEmissionTable>` so a new runtime is
 * a decision taken here, in the same place {@link MEASURED_HOOK_EVENT_COLUMNS}
 * makes it.
 */
const HOOK_EVENT_EMISSION_TABLES = {
  'codex-runtime': CODEX_HOOK_EVENT_EMISSION,
  anthropic: ANTHROPIC_HOOK_EVENT_EMISSION,
  pi: PI_HOOK_EVENT_EMISSION,
  'nestor-cloud-agent': {},
} as const satisfies Record<AgentProvider, HookEventEmissionTable>;

/**
 * The lookup with the column handed in — the seam the "measured column, empty
 * table" pin drives, because {@link MEASURED_HOOK_EVENT_COLUMNS} is a `const`
 * and a test cannot flip it. `undefined` is the unmeasured-COLUMN case.
 */
export function hookEventEmissionFrom(
  table: HookEventEmissionTable | undefined,
  event: AgentEvent,
): HookEventEmission {
  if (!table) return UNMEASURED_RUNTIME;
  return table[event] ?? UNMEASURED_EVENT;
}

/**
 * P6.86 — whether this runtime's column carries a claim at all.
 *
 * Exported because the ABSENCE of a claim is a fact a caller may owe its user,
 * and it is unreadable from the four verdicts: an unmeasured column and a
 * measured column with nothing inert both answer `[]` from
 * {@link hookEventsThatNeverFire}, and a switch report built on that alone
 * cannot tell "nothing is lost" from "we never looked".
 *
 * Today every provider that can be a switch TARGET answers `true` — codex
 * (P6.11), anthropic (P6.89) and pi (P6.90) — and the one `false`,
 * `nestor-cloud-agent`, is refused as a target by name before any delta is
 * computed (`SessionManager.switchSessionRuntime` throws
 * `CONNECTION_NOT_SWITCHABLE`). So the caveat has no reachable subject, which is
 * why it is a PIN rather than a user-visible line: see the assertion in
 * `runtime-switch-session.test.ts`, which goes red the day a runtime is added
 * with no column, and that is the day the line has to be written.
 */
export function hookEventColumnMeasured(provider: AgentProvider): boolean {
  return MEASURED_HOOK_EVENT_COLUMNS[provider];
}

/** What we have measured about `event` on `provider`. Never guesses. */
export function hookEventEmission(provider: AgentProvider, event: AgentEvent): HookEventEmission {
  const table = MEASURED_HOOK_EVENT_COLUMNS[provider] ? HOOK_EVENT_EMISSION_TABLES[provider] : undefined;
  return hookEventEmissionFrom(table, event);
}

/**
 * True only when we have MEASURED that the event cannot fire here. An
 * unmeasured column answers `false`, so a diagnostic built on this can never
 * tell a user a working hook is dead.
 */
export function hookEventNeverFires(provider: AgentProvider, event: AgentEvent): boolean {
  const kind = hookEventEmission(provider, event).kind;
  return kind === 'unwired' || kind === 'unreachable';
}

/** Every event measured not to fire on `provider`, in `AGENT_EVENTS` order. */
export function hookEventsThatNeverFire(provider: AgentProvider): readonly AgentEvent[] {
  return AGENT_EVENTS.filter(event => hookEventNeverFires(provider, event));
}

// ---------------------------------------------------------------------------
// P6.14 — codex's OWN hook vocabulary, and the one place it is spelled
// ---------------------------------------------------------------------------

/**
 * The keys a codex `[hooks]` table may be keyed by that are ALSO one of our
 * events — eleven of codex's twelve.
 *
 * ## Two spellings, and the trap between them
 *
 * codex names each of its events TWICE, in two different cases, and reading the
 * wrong one produces a config key the binary silently ignores:
 *
 *  - **the WIRE spelling** is lowerCamel — `preToolUse`, `postToolUse`, … — and
 *    lives in `packages/codex-protocol/generated/v2/HookEventName.ts`. That is
 *    what a `HookMetadata` notification carries back.
 *  - **the CONFIG spelling** is PascalCase — `PreToolUse`, `PostToolUse`, … —
 *    and is what a `[hooks]` table is keyed by. Two generated artifacts agree
 *    on it: `config-schema.json`'s `definitions.HooksToml.properties`, and
 *    `ManagedHooksRequirements`, whose field names ARE codex's own list.
 *
 * The list below is the CONFIG spelling, because a `[hooks]` table is the only
 * thing it is for. `runtime-hook-events.test.ts` pins it against the generated
 * `HookEventName` and against `config-schema.json` — as a PARTITION with
 * {@link CODEX_ONLY_HOOK_EVENTS}, so a codex bump that renames or adds an event
 * fails a test here rather than emitting a dead key, and cannot be satisfied by
 * quietly dropping the new name into neither list.
 *
 * ## Why it is `satisfies readonly AgentEvent[]`
 *
 * Measured, and it is the load-bearing surprise of this row: where our
 * vocabularies overlap at all, **our event names and codex's config keys are
 * the SAME STRINGS.** There is no translation table to get wrong — only a
 * membership test. The `satisfies` clause is what keeps that true: rename one
 * of our events and this file stops compiling, rather than the identity quietly
 * becoming a lie. It is also why the twelfth cannot simply be appended here —
 * see {@link CODEX_ONLY_HOOK_EVENTS}.
 *
 * ## What this does NOT claim
 *
 * That the event OCCURS in a Nessy codex session. `SubagentStart` is one of
 * these and is `unreachable` above, because our codex sessions spawn no
 * subagent. Membership here is about the CONFIG VOCABULARY — which keys the
 * binary will parse — and nothing else.
 */
export const CODEX_NATIVE_HOOK_EVENTS = [
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'Stop',
] as const satisfies readonly AgentEvent[];

/** One of the shared keys a codex `[hooks]` table may be keyed by. */
export type CodexNativeHookEvent = (typeof CODEX_NATIVE_HOOK_EVENTS)[number];

const CODEX_NATIVE_HOOK_EVENT_SET: ReadonlySet<string> = new Set(CODEX_NATIVE_HOOK_EVENTS);

/**
 * The codex `[hooks]` keys that are codex's vocabulary and NOT ours — today,
 * exactly one.
 *
 * ## Why this list exists rather than a twelfth `AgentEvent`
 *
 * `interrupt` arrived with `rust-v0.150.1` (upstream #40511: a command or an
 * MCP handler run when an active top-level turn is interrupted). It cannot be
 * appended to {@link CODEX_NATIVE_HOOK_EVENTS}, which is
 * `satisfies readonly AgentEvent[]` — that constant's whole claim is the
 * name-for-name identity, and appending a string our union does not have would
 * not compile. So the question the arrival really asks is whether to MINT an
 * `AgentEvent` for it, and the native-first rule answers no on its second half
 * rather than its first:
 *
 *  - codex has the mechanism. Pi and claude have no counterpart — neither
 *    runtime publishes an interruption hook moment — so an event minted for it
 *    would fire on exactly one runtime out of three, which is the switch-safety
 *    problem itself.
 *  - a new `AgentEvent` is not one line: it is the automations contract table,
 *    the registration surfaces, the per-runtime emission columns and the
 *    matcher vocabulary, bought for a capability no host surface asks for.
 *
 * So the residue is made HONEST instead of uniform: codex can be keyed
 * `Interrupt` by its own config and nothing of ours ever will be, and this
 * constant is where a reader meets that fact. It is a DECLINE with a reason, in
 * the shape P3.255 used for background terminals — not an oversight, and not a
 * todo. What would reopen it: a counterpart on a second runtime, or a host
 * surface that wants to run something when a turn is interrupted.
 *
 * ## What it is for mechanically
 *
 * `runtime-hook-events.test.ts` asserts that this list and
 * {@link CODEX_NATIVE_HOOK_EVENTS} PARTITION the generated `HookEventName` —
 * every codex key is in exactly one of them — so the next codex event to arrive
 * reddens a test instead of disappearing into the gap between two lists. Its
 * members are asserted there to be absent from `AGENT_EVENTS`, which is the
 * property that makes the split mean anything.
 *
 * ## I2.22 asked for a `runtime-switch-costs.ts` row as well, and there is not
 * one to write (measured 2026-09-17 at `rust-v0.154.0`, where the enum is still
 * twelve — `HookEventName`, `ManagedHooksRequirements` and `config-schema.json`'s
 * `HooksToml` all agree)
 *
 * The row's reasoning is sound in general — *"an unrecorded native-only route is
 * a silent divergence"* — and it does not reach this case, for a reason that
 * module states itself. Its admission rule is *"only a difference a real user
 * would hit and be surprised by … an internal type-level difference is not a
 * switch cost"*, and a user cannot reach `Interrupt` from anywhere in this
 * product: no `AgentEvent` exists for it, so no automation can target it, and
 * `buildCodexHooksToml` refuses a plan that is not host-authored, so a
 * hand-written `[hooks]` table cannot smuggle one in either. Nothing is lost on
 * any leg of a switch, because nothing was ever available on the codex leg.
 * Adding a row would be adding one that can never fire — the exact defect
 * `webSearch`'s removal is recorded there to avoid.
 *
 * The AGENTS.md half of the row is also already done: §"Upstream Docs Are
 * Contracts" enumerates TWELVE and names this constant. What is stale there is
 * the version stamp beside the enumeration, not the count.
 */
export const CODEX_ONLY_HOOK_EVENTS = ['Interrupt'] as const;

/** A codex `[hooks]` key with no `AgentEvent` counterpart. */
export type CodexOnlyHookEvent = (typeof CODEX_ONLY_HOOK_EVENTS)[number];

/**
 * The codex `[hooks]` key for one of our events, or `undefined` when codex has
 * no counterpart.
 *
 * `PostToolUseFailure`, `PermissionDenied` and `StopFailure` are OUR vocabulary
 * and answer `undefined` — codex's own list has no counterpart, so those three
 * can only ever be minted host-side from the item stream. That distinction is
 * the whole reason this is a lookup and not a cast. The asymmetry runs the
 * other way too, and {@link CODEX_ONLY_HOOK_EVENTS} carries it.
 */
export function codexNativeHookEvent(event: AgentEvent): CodexNativeHookEvent | undefined {
  return CODEX_NATIVE_HOOK_EVENT_SET.has(event) ? (event as CodexNativeHookEvent) : undefined;
}

/**
 * The runtime's OWN mechanism for an event nothing of ours emits — the
 * native-first question, answered where the verdict is already recorded.
 *
 * Today there is exactly one such route and it is codex's inline `[hooks]`
 * table. Returning the config key rather than a boolean is deliberate: a
 * diagnostic that says "codex hooks this as `PreCompact`" tells the reader what
 * to go and write, and a bare `true` does not.
 *
 * `undefined` covers three different situations on purpose — a runtime with no
 * measured column, an event that DOES fire here, and an event codex's own
 * vocabulary lacks. None of the three is a route, and a caller acting on the
 * presence of a route needs no more than that.
 */
export function hookEventNativeRoute(
  provider: AgentProvider,
  event: AgentEvent,
): CodexNativeHookEvent | undefined {
  if (provider !== 'codex-runtime') return undefined;
  if (!hookEventNeverFires(provider, event)) return undefined;
  return codexNativeHookEvent(event);
}
