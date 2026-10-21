/**
 * Was the in-flight turn actually disturbed when the user sent mid-stream?
 *
 * `wasInterrupted` is a one-shot flag: the next turn opens by telling the model
 * its previous reply was cut off. That is true after a failed steer ON A BACKEND
 * WHOSE FALLBACK ABORTS — `BaseAgent.redirect`'s default fires
 * `forceAbort(AbortReason.Redirect)`, and so do Pi's and Claude's overrides — and
 * false on the queue path, where `redirect()` is never called and the current
 * turn runs to natural completion. The code's own comment at the call site says
 * as much: "For 'queue': skip redirect entirely. The current turn is
 * undisturbed."
 *
 * It used to be set unconditionally, so a queued follow-up made the agent treat
 * its own FINISHED response as interrupted — and since `midStreamBehavior`
 * defaults to `'queue'` on every gateway connection, that was the common path,
 * not an edge case. Upstream v0.11.2 fixed the same shape.
 *
 * THE SECOND ARGUMENT EXISTS BECAUSE "steer" STOPPED IMPLYING "ABORTED".
 * `'steer'` was a safe proxy for "the backend interrupted" only while every
 * backend that could be asked to steer aborted when it could not. `CodexAgent`
 * broke that: its `redirect()` returns `false` for "there is no turn to steer"
 * WITHOUT interrupting anything (its own test asserts no `turn/interrupt`
 * reaches the wire), and codex's default flipped to `'steer'` in the same
 * change. Keyed on the configured behaviour alone, the flag was then stamped on
 * a turn nothing had touched — exactly the lie this module was written to
 * remove, through a new door. The honest question is "did the BACKEND
 * interrupt?", and the answer is backend-dependent, so the backend answers it.
 */

/** The behavior actually applied to this send, after workflow/follow-up forcing. */
export type MidStreamBehavior = 'steer' | 'queue'

/**
 * The backend half of the question: when this agent's `redirect()` returns
 * `false`, did it interrupt the in-flight turn on the way out?
 *
 * Read structurally, and defaulting to `true` when the backend does not answer,
 * because `BaseAgent.redirect`'s default IS an abort: a backend that says nothing
 * is one that inherited that default (or overrode it the same way, as Pi and
 * Claude both do). Only a backend whose `false` is inert declares itself, and
 * today that is `CodexAgent.redirectFallbackInterruptsTurn()`.
 *
 * A null agent answers `false`: `redirect()` was never called on anything, so
 * nothing was interrupted.
 *
 * BOTH INERT BACKENDS NOW DECLARE THEMSELVES, and the member is on the
 * `AgentBackend` contract (`packages/shared/src/agent/backend/types.ts`) rather
 * than being matched structurally here. `NestorCloudAgent.redirect` is also a
 * bare `return false`, so under the default above it read as interrupting —
 * unreachable at its own `'queue'` default, and reachable the moment a user sets
 * that connection to `'steer'` in Settings. "Unreachable by default" is not a
 * reason to leave a wrong answer in place, especially for a flag whose whole
 * effect is what the NEXT turn tells the model about its own history: this exact
 * lie has now been introduced twice by inference, once from the configured
 * behaviour and once from a default that guessed for a backend that never spoke.
 * A new backend whose fallback does not abort must say so on the contract.
 */
export function backendInterruptsOnFailedSteer(
  agent: {
    redirect(message: string): boolean
    redirectFallbackInterruptsTurn?: () => boolean
  } | null | undefined,
): boolean {
  if (!agent) return false
  if (typeof agent.redirectFallbackInterruptsTurn === 'function') {
    return agent.redirectFallbackInterruptsTurn()
  }
  return true
}

/**
 * @param effectiveBehavior - the behaviour actually applied to this send
 * @param backendInterrupted - {@link backendInterruptsOnFailedSteer} for the
 *   agent whose `redirect()` returned false. Both halves must hold: `'queue'`
 *   never calls `redirect()` at all, and a backend whose fallback is inert
 *   disturbed nothing even when it was called.
 */
export function queuedSendInterruptedTurn(
  effectiveBehavior: MidStreamBehavior,
  backendInterrupted: boolean,
): boolean {
  return effectiveBehavior === 'steer' && backendInterrupted
}

/**
 * P6.480 — which follow-up behaviour THIS send actually gets.
 *
 * Three inputs and a strict precedence, extracted from `SessionManager`'s
 * mid-stream branch so the ordering is testable without a live manager. It is
 * the ordering that carries the safety, not the override:
 *
 * 1. **A workflow invocation is always `'queue'`.** Steering forwards text into
 *    the current model turn and would discard the host-resolved structured
 *    payload, so the chord may not overrule it — a user pressing a shortcut has
 *    not asked to downgrade a workflow command to prose.
 * 2. **A follow-up racing send-start is always `'queue'`.** There is no
 *    in-flight turn to steer into yet; the override would name a destination
 *    that does not exist.
 * 2b. **A send after Stop, while the stopped turn drains, is always `'queue'`**
 *    (F1.335, DECIDED by the controller 2026-09-23: host-uniform). The turn the
 *    user stopped is no destination either — a steer reached a dying turn on
 *    every runtime, and on Claude a PreToolUse hook of it.
 * 3. **A payload `redirect()` cannot carry is always `'queue'`** (F1.244) — for
 *    the reason rule 1 gives: the steer is a text door, and the attachments or
 *    model-affecting options would be dropped while the transcript shows them
 *    delivered. See {@link canSteerTextPayload}.
 * 3b. **A send behind a queued payload that cannot be steered is `'queue'`**
 *    (F1.338, DECIDED by the controller 2026-09-23: FIFO — order is what the user
 *    typed). Rule 3 queues the attachment message; without this a text follow-up
 *    ("what is on line 3 of it?") was steered into the running turn AHEAD of the
 *    file it refers to. Above the chord for the same reason: a shortcut asks for
 *    the other behaviour, not for a reordering. Scope: only an UNSTEERABLE row
 *    holds a send back ({@link queueHoldsUnsteerablePayload}); a text-only row the
 *    user queued on purpose does not, so a correction still reaches the turn.
 * 4. **Otherwise the caller's one-message override**, and only then the
 *    connection's resolved default.
 *
 * The stored setting is untouched by construction: nothing here writes, and the
 * override reaches this function as an argument rather than through the config.
 * That is the row's *"the STORED setting is unchanged after the send"* clause,
 * held by shape rather than by an assertion somewhere else.
 *
 * NO RUNTIME HAS THIS. codex offers Enter-vs-Tab inside its own TUI, which this
 * product does not use; neither Pi nor the Claude SDK exposes a per-send hint.
 * So it is host-supplied uniformly for all three — native-first step (2) — and
 * the switch cost is nil BECAUSE it is the host's, which is the point of putting
 * it here rather than in a backend.
 *
 * @param connectionDefault - `resolveMidStreamBehavior(connection)`, or the
 *   `'steer'` fallback when no connection resolves.
 */
export function effectiveMidStreamBehavior(input: {
  connectionDefault: MidStreamBehavior
  override?: MidStreamBehavior | undefined
  workflowInvocation: boolean
  followUpDuringSendStart: boolean
  /** {@link canSteerTextPayload} for this send. Required, so a caller cannot forget it. */
  steerableTextPayload: boolean
  /** F1.338 — {@link queueHoldsUnsteerablePayload} over the queue as it stands. Required, likewise. */
  unsteerableQueuedAhead: boolean
  /** F1.335 — `managed.stopRequested`: the user pressed Stop and the turn is still draining. Required, likewise. */
  stopRequested: boolean
}): MidStreamBehavior {
  if (input.workflowInvocation) return 'queue'
  if (input.followUpDuringSendStart) return 'queue'
  if (input.stopRequested) return 'queue'
  if (!input.steerableTextPayload) return 'queue'
  if (input.unsteerableQueuedAhead) return 'queue'
  return input.override ?? input.connectionDefault
}

/**
 * F1.338 — does the queue already hold a row a steer could not have carried?
 *
 * The same two tests the send itself passes: a workflow invocation (rule 1) and a
 * payload {@link canSteerTextPayload} refuses (rule 3). Such a row can only reach
 * the model as the NEXT turn, so anything sent after it must wait its turn too —
 * see rule 3b of {@link effectiveMidStreamBehavior}. F1.337: `sendQueuedNow`
 * asks the same question of the ONE row the user pressed "Steer" on, so a queued
 * workflow row is kept in place there too instead of being steered as prose.
 */
export function queueHoldsUnsteerablePayload(
  queue: ReadonlyArray<{
    attachments?: readonly unknown[] | null
    storedAttachments?: readonly unknown[] | null
    options?: object | null
    workflowInvocation?: unknown
  }>,
): boolean {
  return queue.some(entry =>
    entry.workflowInvocation !== undefined
    || !canSteerTextPayload(entry.attachments, entry.storedAttachments, entry.options))
}

/**
 * The options that do not change what the MODEL receives, so a text steer loses
 * nothing by not carrying them. Derived from this product's `SendMessageOptions`
 * (`packages/shared/src/protocol/dto.ts`), read 2026-09-23, key by key:
 *
 * - `skillSlugs`, `badges` — presentation. No reader on the send path consumes
 *   them (the mention itself rides the message text). Upstream queues a
 *   non-empty `skillSlugs` because ITS backend reads them; ours does not.
 * - `optimisticMessageId` — the renderer's own id for the bubble.
 * - `origin` — already spent: it gates the workflow keyword, whose directive is
 *   folded into the very text `redirect()` receives.
 * - `midStreamOverride` — the steer-or-queue choice itself.
 *
 * Everything else with a value takes the queue: `outputSchema` today (it rides
 * the turn's chat options, which a steer never reaches), and any option added
 * later until someone decides it is neutral and adds it HERE.
 *
 * `hidden` (UB2.14) is neutral only as `false` — a plain send spelled out, as
 * in upstream v0.15.1's `canSteerTextPayload` (`key === 'hidden' && value ===
 * false`). `true` takes the queue: a steer carries text, not the row's flag.
 */
const STEER_NEUTRAL_OPTION_KEYS: ReadonlySet<string> = new Set([
  'skillSlugs',
  'badges',
  'optimisticMessageId',
  'origin',
  'midStreamOverride',
])

/**
 * F1.244 — can this send ride `redirect()` without losing anything?
 *
 * `redirect()` takes a STRING on every runtime (`AgentBackend.redirect`): Pi
 * sends `{ type: 'steer', message }`, Claude parks the text for its PreToolUse
 * hook, codex sends a text-only `turn/steer` input. A steer of a message that
 * carries files therefore delivered the words and dropped the files, while the
 * transcript row kept the attachments and the composer read "accepted" — and
 * `'steer'` is the default on every provider except `nestor-cloud-agent`.
 *
 * Text-only steering is OUR choice, made uniformly — not a limit of every
 * runtime (F1.341). Two of the three runtimes accept images in a steer
 * natively: Pi's `AgentSession.steer(text: string, images?: ImageContent[])`
 * (`@earendil-works/pi-coding-agent` `dist/core/agent-session.d.ts`) and
 * codex's `TurnSteerParams.input: Array<UserInput>`, whose `UserInput` union
 * carries `image` and `localImage` (`packages/codex-protocol/generated/v2/`).
 * What is text-only is our `redirect(message: string)` contract and Claude's
 * steer, which is emulated by parking text for the PreToolUse hook and has no
 * image channel at all. Carrying files on two runtimes and queuing them on the
 * third would make the same composer action behave differently per runtime, so
 * every runtime queues a file-bearing send instead. Widening `redirect()` to
 * images on Pi and codex is possible; it is not done, and this is the place
 * that would change.
 *
 * `false` means "queue it": the queue entry keeps the whole payload and the
 * replay after the turn sends it exactly as an idle send would. Read at BOTH
 * doors that call `redirect()` for a user message — `SessionManager.sendMessage`
 * (through {@link effectiveMidStreamBehavior}) and `sendQueuedNow` (through
 * {@link queueHoldsUnsteerablePayload} since F1.337). The third
 * door the row names, the `steer_undelivered` re-queue, can only hand back what
 * a steer carried, which is now text by construction.
 *
 * Ported from craft-agents-oss v0.13.4 `canSteerTextPayload`
 * (`packages/server-core/src/sessions/SessionManager.ts`, Apache-2.0): same
 * name, same conservative shape ("Unknown future options conservatively use the
 * full-payload path"); the option list is ours, see
 * {@link STEER_NEUTRAL_OPTION_KEYS}.
 */
export function canSteerTextPayload(
  attachments?: readonly unknown[] | null,
  storedAttachments?: readonly unknown[] | null,
  options?: object | null,
): boolean {
  if ((attachments?.length ?? 0) > 0 || (storedAttachments?.length ?? 0) > 0) return false
  return !Object.entries(options ?? {}).some(
    ([key, value]) => value !== undefined && !STEER_NEUTRAL_OPTION_KEYS.has(key) && !(key === 'hidden' && value === false),
  )
}

/**
 * UB6.13 — mid-turn messages: whether a queued entry is one half of a continued message, i.e. it
 * continues an entry still waiting in the queue, or a waiting entry continues it. Such pairs replay
 * together (`SessionManager.processNextQueuedMessage`), and neither half is ever steered on its own
 * (`SessionManager.steerQueuedIfDecided`): steering only "call it X" out of "when you create the
 * event later," / "call it X" delivered the second half alone, and without "later" it read as
 * "create the event now".
 *
 * Copied from craft-agents-oss `v0.15.1:packages/server-core/src/sessions/SessionManager.ts`
 * `isInQueuedContinuation` (Apache-2.0); it lives here beside the other pure queue predicates
 * rather than in the manager.
 */
export function isInQueuedContinuation(
  queue: ReadonlyArray<{ message: string; mergeWith?: object }>,
  entry: { message: string; mergeWith?: object },
): boolean {
  return (entry.mergeWith !== undefined && queue.some(other => other === entry.mergeWith))
    || queue.some(other => other.mergeWith === entry)
}

/**
 * UB6.13 — can this queued entry take part in a continuation merge (two queued messages replayed as
 * one turn)? Upstream asks {@link canSteerTextPayload} of both halves; ours adds the two things our
 * queue entries carry that upstream's do not, because the merged replay joins the DISPLAY texts:
 * a workflow invocation (a host-resolved structured payload, never prose — rule 1 of
 * {@link effectiveMidStreamBehavior}) and a model text that differs from the display text
 * (`modelMessage`), which a join of the display texts would silently drop.
 */
export function canMergeQueuedEntry(entry: {
  attachments?: readonly unknown[] | null
  storedAttachments?: readonly unknown[] | null
  options?: object | null
  workflowInvocation?: unknown
  modelMessage?: string
  message: string
}): boolean {
  return entry.workflowInvocation === undefined
    && (entry.modelMessage === undefined || entry.modelMessage === entry.message)
    && canSteerTextPayload(entry.attachments, entry.storedAttachments, entry.options)
}
