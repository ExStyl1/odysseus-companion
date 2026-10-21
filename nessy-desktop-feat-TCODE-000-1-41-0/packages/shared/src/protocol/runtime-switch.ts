/**
 * The vocabulary of a runtime switch — shared, because both ends need it.
 */

import type { ModelProvider } from '../config/models'

/**
 * How much a connection change costs the session. Declared in `shared/protocol`
 * and not in `server-core` because the RENDERER needs it for the confirmation
 * copy, and the renderer cannot import server-core. The classifier that
 * produces it lives in server-core; only the vocabulary is shared.
 */
export type RuntimeSwitchKind = 'model' | 'connection-same-runtime' | 'connection-cross-runtime'

/**
 * What a cross-runtime switch will carry, decided BEFORE the switch runs so the
 * confirmation modal can promise it.
 *
 * Three tiers, and the distinction between them is what the modal says out
 * loud:
 *
 * - `native` — the whole conversation crosses as model-visible history, tool
 *   calls and their results included. Only ever chosen when the target
 *   runtime's native carry is actually implemented AND the payload fits the
 *   target model's context window (`planHistoryCarry` in
 *   `packages/server-core/src/sessions/runtime-switch.ts`).
 * - `anchor` — the target already holds its own anchor, so it resumes its OWN
 *   real transcript and the trimmed text tail carries only what it missed.
 *   Nothing is rebuilt, and the modal must NOT promise "full history" here: for
 *   a returning leg there is no new carry to promise.
 * - `text` — today's handoff: a trimmed text summary of the most recent
 *   messages, with no tool rows. Chosen when the payload does not fit, when the
 *   target's context window cannot be resolved at all, and on every runtime
 *   whose native carry is not built yet — since T1a that is everything except
 *   `codex-runtime`, and T2 adds `anthropic`.
 *
 * Lives in `shared/protocol` for the same reason {@link RuntimeSwitchKind}
 * does: the renderer renders the promise and cannot import server-core.
 */
export type HistoryCarryPlan = 'native' | 'anchor' | 'text'

/**
 * WHY the plan is what it is — the half of the switch decision that used to
 * reach nobody.
 *
 * P3.266: `planHistoryCarry` has always computed this beside the plan, and its
 * own field comment said it plainly — *"Not rendered — logged"*. So a switch
 * that fell back to the trimmed text tail shortened the user's conversation and
 * gave no reason for it, on a screen that was already asking them to decide.
 * The three degrading values below are different events with different answers:
 * one is *this pair of runtimes cannot do better*, one is *we could not size
 * your model*, and one is *your conversation is too big for it*. Only the last
 * is something the user can act on, which is exactly why collapsing them into a
 * silent `text` was the wrong trade.
 *
 * Lives here rather than in `server-core/sessions/runtime-switch.ts` for the
 * same reason {@link HistoryCarryPlan} does — the renderer draws the promise and
 * cannot import server-core — and the planner's own decision type now READS this
 * union instead of restating it, so the two cannot drift.
 *
 * - `fits` — the payload fits the target's window; the plan is `native` and
 *   there is nothing to explain.
 * - `target-already-anchored` — the target holds its own anchor and resumes its
 *   own transcript; the plan is `anchor`, and the anchor copy already says it.
 * - `no-native-carry-implemented` — the target runtime has no native carry, so
 *   the tier is a property of the PAIR and not of this conversation. Nothing the
 *   user can change today.
 * - `context-window-unknown` — the target model's context window could not be
 *   resolved at all, so no fit could be judged and the safe tier was taken.
 * - `context-window-unenforced` — a window resolved, but nothing will enforce
 *   it on the target, so proactive compaction stays off there.
 * - `does-not-fit` — the window is known and the conversation is larger than it.
 *   The one reason a user can act on: continue on a model with a bigger window,
 *   or accept the summary.
 */
export type HistoryCarryReason =
  | 'fits'
  | 'target-already-anchored'
  | 'no-native-carry-implemented'
  | 'context-window-unknown'
  | 'context-window-unenforced'
  | 'does-not-fit'

/**
 * The read-only answer to "what would happen if I switched to this connection?"
 *
 * Returned by the `previewRuntimeSwitch` session command, which runs the same
 * transcript load and the same planner the switch itself runs and then does
 * nothing else — no teardown, no boundary, no mutation. It exists because the
 * confirmation modal is computed entirely in the renderer and, before this,
 * there was no pre-switch server round trip at all: the only wire surface was
 * `sessions:command {type:'switchRuntime'}`, sent AFTER the user said yes.
 */
export interface RuntimeSwitchPreview {
  kind: RuntimeSwitchKind
  /** Whether the session has a transcript worth carrying at all. */
  hasHistory: boolean
  /**
   * Omitted for every tier that carries nothing to decide — a model change, a
   * same-runtime switch (the runtime keeps its own thread), and a session with
   * no history.
   */
  historyCarry?: HistoryCarryPlan
  /**
   * Why {@link RuntimeSwitchPreview.historyCarry} is what it is (P3.266).
   *
   * Optional for exactly the reason the plan is: a preview that did not answer
   * must leave the modal saying LESS, never guessing. An older server that
   * predates this field omits it and the dialog renders as it did before —
   * the same lenient shape the durable switch marker already uses, and it
   * matters for the same reason (a remote session or the iOS app can be talking
   * to a build newer or older than itself).
   */
  historyCarryReason?: HistoryCarryReason
}

/**
 * What stops EXECUTING when a session's runtime changes — as opposed to what
 * stops being listed, which is nothing.
 *
 * The capability layer does not switch: it is destroyed and re-resolved, and
 * the inventory comes back byte-identical because the resolver reads the
 * provider in only a handful of places. The execution does not come back. A
 * plugin therefore stays enabled and looks healthy while its language server is
 * gone, its background monitor is dead, and four of its five hook action kinds
 * fire and return nothing. Nothing else in the product can say that, so the
 * switch says it.
 *
 * Names only, and always the names the user sees in the plugin's own card — a
 * count alone cannot be checked against anything.
 */
export interface CapabilityDelta {
  /** `monitorId` of every plugin monitor that was running and will not be. */
  stoppedMonitors: string[]
  /** `lspId` of every plugin language server that was provisioned and will not be. */
  lostLsp: string[]
  /**
   * Hook ACTION kinds that will be collected and never executed. Command hooks
   * run on every runtime and are never listed here.
   */
  inertHookKinds: string[]
  /**
   * P3.350 — hook EVENTS this session has a registration for and the target
   * runtime is MEASURED never to reach, in `AGENT_EVENTS` order.
   *
   * A different fact from {@link inertHookKinds}, and strictly worse: that
   * field answers *which action kinds lose their runner*, and excludes command
   * hooks by construction because a command runner is supplied on every
   * runtime. This one answers *which moments stop happening at all* — so a
   * `command` hook on `PreToolUse` or `PermissionRequest`, a control that gates
   * tool calls, appears here and could appear nowhere before.
   *
   * Derived from `automations/runtime-hook-events.ts`, which only ever claims
   * what it has measured: an unmeasured runtime column contributes nothing, so
   * this list can never tell a user a working hook is dead.
   */
  inertHookEvents: string[]
  /**
   * The target runtime's OWN config keys for the moments in
   * {@link inertHookEvents} that it reaches natively — P6.14's honesty half.
   *
   * Without it "stops firing" reads as "cannot work here", and for codex that
   * is false for most of the list: the binary hooks the moment itself under
   * `[hooks.<Event>]` and what is absent is our projection into its config.
   * Empty when the target has no native route for any of them.
   */
  nativeHookEventRoutes: string[]
  /**
   * P3.340 — the session loses the host's post-edit diagnostics and the
   * `format` tool (`HOST_EDIT_TOOLING_SUPPORT`).
   *
   * Not a plugin capability and not in any catalogue, which is why it needs a
   * field of its own: nothing else in the product could say it, and the only
   * previous statement that they are Pi-only was the injection condition
   * itself.
   */
  hostEditToolingLost: boolean
}

export interface RuntimeSwitchResult {
  kind: RuntimeSwitchKind
  /**
   * How the conversation reached the runtime taking over.
   *
   * - `runtime-anchor` — the target resumed its own SDK conversation; no text
   *   crossed. Same-runtime switches, and cross-runtime ones with no history.
   * - `handoff` — the target had never run this session, so the transcript
   *   crossed as text.
   * - `anchor-and-handoff` — **both**, and it is the normal shape of a RETURN
   *   leg. The target resumes the conversation it left (its anchor is kept for
   *   exactly that: `SessionManager.clearRuntimeScopedSessionState`), and the
   *   span produced while it was away crosses as text on top. Only that span:
   *   handing over the whole transcript would deliver everything the resumed
   *   thread already holds a second time, which is what RTS-3 measured on
   *   packaged 1.26.1 before the trim in `getRuntimeHandoffMessages`.
   * - `none` — nothing to carry.
   * - `native-inject` — the target accepted the missed span as model-visible
   *   history over its own RPC (Codex `thread/inject_items`); no text crossed.
   *   T1a of `docs/superpowers/plans/2026-08-20-cross-runtime-history-carry.md`.
   * - `native-transcript` — the target's own on-disk session transcript was
   *   rebuilt and verified before it resumed (Claude). T2 of the same plan.
   *
   * The four original members keep exactly their meanings. A native path that
   * FAILS reports `handoff`, because the text fallback is what actually
   * crossed — every value here records what happened, never what was
   * attempted.
   *
   * Nothing renders this today; it is the switch's own account of what it did,
   * read by tests and the session log.
   */
  contextCarried: 'runtime-anchor' | 'handoff' | 'anchor-and-handoff' | 'none' | 'native-inject' | 'native-transcript'
  model: string
  /**
   * The model the session was on BEFORE the switch, when it was on one.
   *
   * A switch keeps the user's model whenever the target can serve it — the
   * three gateway cards share one catalogue, so that is the common case — and
   * falls back to the target's own default when it cannot. Carrying makes a
   * switch quieter; this field is what keeps quieter from becoming opaque.
   *
   * Reported whenever there WAS a previous model, not only when it changed:
   * the honest wire answer is "here is what the session was on", and the
   * renderer owns the comparison against {@link RuntimeSwitchResult.model}.
   * Equal means nothing moved and the user is told nothing; different is the
   * one case worth a toast, and the copy names both ends.
   */
  previousModel?: string
  /**
   * Names of image attachments already in this session's transcript that the
   * TARGET integration declares it cannot read
   * (`ComposerCapabilities.attachments.images === 'no'`). Deduplicated, and
   * omitted entirely when there are none.
   *
   * Reported rather than acted on: the switch does not delete anything. It is
   * the one thing about the move the user cannot see for themselves — the
   * transcript still shows the images, and the new runtime will never receive
   * them.
   */
  droppedAttachments?: string[]
  /** Filled by Task 13. Background children stopped to make the switch safe. */
  stoppedChildren?: string[]
  /**
   * P6.113 — the COMMAND LINES of the background shells the switch killed.
   *
   * `strictDrainSessionForMutation` kills every background shell to make the
   * switch safe, exactly as it stops the children above, and until this field
   * nothing said so: the task chips disappear with the session's rows and the
   * commands were only ever held in a runtime map that the switch then clears.
   *
   * Names, never a count — the rule {@link CapabilityDelta}'s own header states
   * and the reason this is a list: the command is what the user recognises, and
   * a count can be checked against nothing.
   *
   * HERE rather than on {@link CapabilityDelta}, measured: the drain runs for
   * every switch KIND, so a same-runtime connection change kills these shells
   * too, while `describeCapabilityDelta` returns `undefined` whenever
   * `from === to`. A capability delta is a difference between two runtimes; this
   * is a casualty of the teardown, which is what `stoppedChildren` already is.
   *
   * Deliberately NOT the background AGENT tasks. That half is blocked on the
   * per-runtime rows that expose their ids and descriptions (P6.109 landed
   * claude's; codex's is P6.111), and a field that named one runtime's tasks
   * while silently omitting another's would be a new divergence rather than a
   * closed gap. Omitted entirely when there are none.
   */
  stoppedBackgroundShells?: string[]
  /**
   * Filled by Task 17. What stops executing on the target runtime. Omitted
   * entirely when nothing does — which is every switch back onto Pi, and every
   * switch on a session with no plugin peripherals.
   */
  capabilityDelta?: CapabilityDelta
  /** Provider the session left, when it changed. */
  from?: ModelProvider
  to?: ModelProvider
}
