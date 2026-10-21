/**
 * F1.76 (origin D1.373) — the HOST's deadline on a permission card nobody
 * answers, and the sentence the model reads when it fires.
 *
 * ## What was measured, and why the runtime's own knob is not the answer
 *
 * `claude-agent.ts`'s `case 'prompt'` branch publishes a card and then waits for
 * the click. Until this module it waited with no deadline of its own, so the
 * only thing that ended the wait was the SDK's own per-hook backstop: WI-bd
 * measured **602 965 ms** in SIT-5e's leftover claude session, after which the
 * tool row ended `isError: true` carrying the vendored binary's own sentence —
 * *"PreToolUse hook did not respond before its timeout (host client may be
 * unreachable). The tool call was not executed"* — while the session record
 * still held the `pendingApproval` for a `tool_use_id` nothing could run any
 * more. The model was told the transport was broken; the user kept an Allow
 * button that bought nothing.
 *
 * **Native-first, asked and answered.** The runtime HAS a knob:
 * `HookCallbackMatcher.timeout`, *"Timeout in seconds for all hooks in this
 * matcher"* (`sdk.d.ts:868`), and the shipped binary honours it — the per-hook
 * dispatch reads `hn.timeout ? hn.timeout*1000 : _`, with `_` defaulting to
 * `var Li=600000` (one occurrence, `grep -aoF … | wc -l` over the vendored
 * darwin-arm64 `claude`; both SDK self-reports said `2.1.251` on 2026-09-20).
 * That 600 000 ms IS the row's "~603 s". It is measured and INSUFFICIENT rather
 * than unexamined, for three reasons that no value would change: it is
 * per-MATCHER, so lowering it also bounds the fast allow/deny path that never
 * raises a card; its sentence is a frozen build constant that blames the
 * transport; and it withdraws no card. So this module is the host's own
 * deadline, strictly shorter than the SDK's, and it reuses D1.333's machinery
 * (`raceHookApprovalDeadline`) rather than growing a second one.
 *
 * ## The three things that happen when it fires, and why each is needed
 *
 *  1. The pending resolver is removed, so a click that arrives late finds
 *     nothing and is a no-op rather than a second answer.
 *  2. `permission_request_cancelled` reaches the host. That event already
 *     exists (`@nessy-agent/core/types`) and the host already routes it:
 *     `SessionManager.processEvent` calls `removePendingPermissionRequest`,
 *     which deletes the in-memory record AND clears the durable
 *     `managed.pendingApproval`, then tells the renderer. Pi has produced it for
 *     a long time; this is the claude side's first. It rides the turn the card
 *     was raised in while that turn is open, and otherwise (F1.527) the agent's
 *     own withdrawal — the turn in flight, or the host's out-of-turn channel.
 *  3. The caller denies the tool with OUR sentence, so the model reads what
 *     actually happened.
 */
import type { AgentEvent } from '@nessy-agent/core/types';
import { raceHookApprovalDeadline } from '../../../automations/index.ts';

/**
 * How long the host waits at an unanswered permission card on the claude
 * runtime, in milliseconds.
 *
 * **540 000 (9 minutes), and the reasoning is deliberately narrow.** The SDK
 * kills the hook call at 600 000 ms whatever we do (measured above), so any
 * budget at or above that is dead code and the defect returns unchanged;
 * anything far below it takes answering time away from a user the runtime would
 * have waited for, and buys nothing but an earlier sentence. 9 minutes is the
 * largest round value that reliably wins that race. It is a product posture —
 * the one user-visible number in this change — so it lives in one place, named,
 * with its measurement beside it, and `claude-permission-card-deadline.test.ts`
 * pins it strictly below the SDK's backstop.
 */
export const CLAUDE_PERMISSION_CARD_DEADLINE_MS = 540_000;

/** The outcome of waiting at a card: an answer, or the host's own expiry. */
export type ClaudePermissionCardAnswer =
  | { answered: true; allowed: boolean }
  | { answered: false; notice: string };

/** Everything the wait needs. The collaborators are the agent's REAL ones. */
export interface ClaudePermissionCardWait {
  /** The promise the card's Allow/Deny resolves, from `pendingPermissions`. */
  wait: Promise<boolean>;
  /** `perm-<tool_use_id>` — the key the resolver is registered under. */
  requestId: string;
  /** The tool the card is about; it is what the sentence names. */
  toolName: string;
  /**
   * The agent's own `pendingPermissions`. Typed as the one method this module
   * uses so a test can pass the real `Map` and nothing has to be stubbed.
   */
  pending: { delete(requestId: string): unknown };
  /** The turn in flight, if one is open — the cancellation rides it to the host. */
  slot: { readonly settled: boolean; push(event: AgentEvent): void } | null;
  /**
   * F1.527 (origin the 1.41.0 review, C-claude-runtime-1) — how the cancellation reaches the host when
   * {@link slot} is settled or absent at expiry. `slot` is captured when the card is RAISED, and a card a
   * background subagent raised outlives that turn: nothing declines claude's own cards at a turn's end, so 540 s
   * later the captured slot has settled (or there was none) and, before this field, nothing was sent — the host
   * kept the record and the durable `pendingApproval`, and the user's later Allow reached a resolver that was gone.
   * `ClaudeAgent` passes its `withdrawElicitationDialog`: the turn in flight if one is open, else the host's
   * out-of-turn channel (`onPermissionRequestWithdrawn`, F1.369). Optional so a caller with no host (this module's
   * own suite) keeps F1.76's shape.
   */
  withdrawOffTurn?: (requestId: string) => void;
  /** Overridden only by tests; production takes the constant above. */
  budgetMs?: number;
}

/** A budget a person can read, at both the scales this is used at. */
function describeBudget(budgetMs: number): string {
  if (budgetMs < 60_000) return `${budgetMs} ms`;
  const minutes = Math.round(budgetMs / 60_000);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/**
 * The sentence the MODEL reads when the card expired, in
 * `hookApprovalTimeoutNotice`'s voice: it names what was waiting, what bounded
 * the wait, and what to do next. It deliberately says the connection is fine,
 * because the sentence it replaces said the opposite and the model acted on it.
 */
export function claudePermissionCardTimeoutNotice(toolName: string, budgetMs: number): string {
  return `Nobody answered the permission card for ${toolName} within ${describeBudget(budgetMs)}, `
    + 'so the tool did not run and the card was withdrawn. Nothing is wrong with the connection — the '
    + 'request was simply never answered. Tell the user the request went unanswered and ask them to '
    + 'answer the card while the turn is waiting if they still want this to run.';
}

/**
 * Wait for the card, bounded by the host.
 *
 * Returns the answer when one arrives inside the budget — and on the answered
 * path this touches nothing, because `respondToPermission` already removes the
 * pending entry, and a second removal here would hide a regression in it.
 */
export async function awaitClaudePermissionCardAnswer(
  options: ClaudePermissionCardWait,
): Promise<ClaudePermissionCardAnswer> {
  const budgetMs = options.budgetMs ?? CLAUDE_PERMISSION_CARD_DEADLINE_MS;
  const outcome = await raceHookApprovalDeadline<boolean | typeof CARD_EXPIRED>(
    options.wait,
    budgetMs,
    () => CARD_EXPIRED,
  );
  if (outcome !== CARD_EXPIRED) return { answered: true, allowed: outcome };

  withdrawClaudeCard(options);
  return { answered: false, notice: claudePermissionCardTimeoutNotice(options.toolName, budgetMs) };
}

/**
 * The two steps that take an EXPIRED card off the screen, in one place so the
 * two waits below cannot start withdrawing differently.
 *
 *  1. The pending resolver is removed, so a click that arrives late finds
 *     nothing and is a no-op rather than a second answer.
 *  2. `permission_request_cancelled` is pushed onto the card's own turn while
 *     that turn is open — and otherwise (F1.527) handed to `withdrawOffTurn`,
 *     because a card can outlive the turn it was raised in. The host already
 *     routes it (`SessionManager.processEvent` →
 *     `removePendingPermissionRequest`), which deletes the in-memory record AND
 *     clears the durable `managed.pendingApproval`, then tells the renderer.
 *
 * Only ever called on the EXPIRED path. On the ANSWERED path both callers touch
 * nothing, because the card's own settle has already removed the pending entry
 * and a second removal here would hide a regression in it.
 */
function withdrawClaudeCard(
  options: Pick<ClaudePermissionCardWait, 'requestId' | 'pending' | 'slot' | 'withdrawOffTurn'>,
): void {
  options.pending.delete(options.requestId);
  const slot = options.slot;
  if (slot && !slot.settled) {
    slot.push({ type: 'permission_request_cancelled', requestId: options.requestId });
    return;
  }
  options.withdrawOffTurn?.(options.requestId);
}

/**
 * F1.169 (origin WJ-d's F1.76-A) — the SAME deadline for the OTHER claude card,
 * the one the SDK's own `canUseTool` raises.
 *
 * `ClaudeAgent.askToolApproval` publishes a `claude_native` card and settles
 * only on a click, an abort or a teardown. Unlike the `case 'prompt'` branch
 * above it, no SDK backstop was found for this seam at all: the 600 000 ms
 * `var Li=600000` default belongs to the per-hook callback dispatch
 * (`hn.type==="callback"` → `hn.timeout?hn.timeout*1000:_` in the vendored
 * binary), and a `can_use_tool` control request is not a hook callback. So an
 * unanswered native card could wait for as long as the turn lived.
 *
 * The budget, the sentence and the withdrawal are F1.76's, deliberately: two
 * cards a user cannot tell apart must not expire at two different times or say
 * two different things. Only the ANSWER SHAPE differs, which is why this is
 * generic — `askToolApproval` resolves a `ClaudeToolApprovalAnswer`, and the
 * caller says how its own type spells "the host withdrew this" through
 * {@link ClaudeNativeCardWait.expired}. On that runtime the expiry is a DENIAL
 * carrying the notice as its comment, because `buildClaudeCanUseTool` already
 * relays a denial's comment verbatim into the SDK's own `deny.message` (P6.951)
 * — so the model reads our sentence through the channel every other refusal on
 * this runtime already uses, and no new wire field is invented for it.
 */
export interface ClaudeNativeCardWait<TAnswer> extends Omit<ClaudePermissionCardWait, 'wait'> {
  /** The card's own promise — `askToolApproval`'s, unmodified. */
  wait: Promise<TAnswer>;
  /** How the caller's answer type spells an expiry. Called at most once. */
  expired: (notice: string) => TAnswer;
}

/**
 * Wait for a `claude_native` card, bounded by the host.
 *
 * Returns the answer when one arrives inside the budget, touching nothing on
 * that path: `askToolApproval`'s own `settle` removes the pending entry, and a
 * second removal here would hide a regression in it.
 */
export async function awaitClaudeNativeCardAnswer<TAnswer>(
  options: ClaudeNativeCardWait<TAnswer>,
): Promise<TAnswer> {
  const budgetMs = options.budgetMs ?? CLAUDE_PERMISSION_CARD_DEADLINE_MS;
  const outcome = await raceHookApprovalDeadline<TAnswer | typeof CARD_EXPIRED>(
    options.wait,
    budgetMs,
    () => CARD_EXPIRED,
  );
  if (outcome !== CARD_EXPIRED) return outcome;

  withdrawClaudeCard(options);
  return options.expired(claudePermissionCardTimeoutNotice(options.toolName, budgetMs));
}

/**
 * The expiry sentinel. A symbol rather than a third boolean state so that no
 * value a card can legitimately resolve to can be mistaken for the deadline.
 */
const CARD_EXPIRED: unique symbol = Symbol('claude-permission-card-expired');
