/**
 * The permission-channel round trip an MCP elicitation needs on a runtime whose
 * dialogs are not driven by a Pi subprocess.
 *
 * Pi asks its user by handing an `ask_user` request to the subprocess protocol.
 * The Claude and Codex runtimes have no such channel — but they DO have the
 * same host-side permission surface (`onPermissionRequest` out,
 * `respondToPermission` in), and that surface already renders an
 * `AskUserPermissionRequest`. This is the smallest thing that turns those two
 * halves into a promise, so `handleMcpElicitationWithAskUser` — the ONE
 * implementation of the URL gate, the form plans and the decline-visibly rule —
 * can run unchanged on all three runtimes.
 *
 * The answer is validated here, exactly as `PiAgent.respondToPermission`
 * validates its own: an option answer must name a real option at the index it
 * claims, free text must have been allowed and be non-empty, and a batched
 * answer must satisfy `validateBatchedAskUserAnswer`. A malformed answer is an
 * error rather than a value, so it degrades to a decline upstream instead of
 * sending an MCP server something the user never chose.
 */

import type { AskUserAnswer, AskUserPermissionRequest } from '@nessy-agent/core/types';
import { validateAskUserQuestions, validateBatchedAskUserAnswer } from '@nessy-agent/core/utils';
import { PERMISSION_MODE_AGENT_LABELS, type PermissionMode } from './mode-types.ts';

interface PendingElicitationAsk {
  askUser: AskUserPermissionRequest;
  settle: (outcome: { answer?: AskUserAnswer; error?: string }) => void;
  /** F1.818 — the host-side auto-continue clock; cleared with the entry. */
  timeout?: ReturnType<typeof setTimeout>;
}

export interface ElicitationAskUserBridgeOptions {
  /**
   * Put the question on screen. Throwing means it never reached a user, which
   * the bridge reports as a refusal rather than waiting forever.
   */
  surface: (request: { requestId: string; askUser: AskUserPermissionRequest }) => void;
  /** Distinguishes this runtime's ids in logs; also the requestId prefix. */
  idPrefix: string;
  /**
   * The runtime's permission mode, read at ask time rather than captured — a
   * user switches modes mid-conversation, and the mode that matters is the one
   * in force when the server asks. Required, not optional: the two checks below
   * are the whole of the parity with Pi's own ask surface, and an option a
   * caller may omit is an option the next runtime omits.
   */
  permissionMode: () => PermissionMode;
  /** The user's `askUserQuestionTimeout`, in ms; `undefined` is "never". */
  timeoutMs: () => number | undefined;
  /**
   * F1.220 — tell the HOST that a dialog it was shown is gone without an
   * answer: the MCP server withdrew its request, the turn was stopped, or the
   * session is going away.
   *
   * Settling the promise is only half of a withdrawal. `surface` put a card on
   * the host's permission channel, and the host keeps its own record of it
   * (`SessionManager`'s `pendingPermissionRequests`) and the card on screen; the
   * one event that clears both is `permission_request_cancelled`, which Pi's
   * `cancelPendingPermission` and codex's `denyPendingApprovals` already emit.
   * Before this option the bridge settled and said nothing, so on claude and
   * codex a withdrawn question stayed on screen answering nothing.
   *
   * Called from {@link ElicitationAskUserBridge.cancel} — and since F1.818
   * from the timeout expiry ({@link ElicitationAskUserBridge.autoContinue}) —
   * never for a dialog the user ANSWERED (the answer path is the host's own
   * removal) and never for one whose `surface` threw (nothing reached the
   * host). Required for the reason `permissionMode` is: an option a caller may
   * omit is an option the next runtime omits. It must not throw; a failure is
   * the owner's to report, and the settle has already happened.
   */
  withdraw: (requestId: string) => void;
}

export class ElicitationAskUserBridge {
  private readonly pending = new Map<string, PendingElicitationAsk>();
  private sequence = 0;

  constructor(private readonly options: ElicitationAskUserBridgeOptions) {}

  /** Ids currently on screen. Read by the owning agent's respond path. */
  owns(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /**
   * Ask, and resolve when the user answers.
   *
   * Rejects — never hangs — when the request is malformed, cannot be surfaced,
   * or is cancelled. `handleMcpElicitationWithAskUser` maps a rejection to
   * `cancel`, which is a settled MCP answer.
   */
  async ask(askUser: AskUserPermissionRequest, signal?: AbortSignal): Promise<AskUserAnswer> {
    if (askUser.questions) {
      // Batched superset (R7): the documented 1-4 x 2-4 bounds + 12-char header.
      validateAskUserQuestions(askUser.questions);
    } else if (!askUser.question || askUser.options.length < 1 || askUser.options.length > 4) {
      // ONE option is legal here and nowhere else. `declineVisibly` in
      // `mcp/elicitation.ts` is an acknowledgement — a single `OK` — and it is
      // the whole of the "tell the user why, then decline it, never silently"
      // rule. Holding it to the `ask_user` TOOL's documented 2-4 bound would
      // make the refusal throw, which is a `cancel` with nothing shown: the
      // silent drop the rule exists to prevent.
      throw new Error('An elicitation dialog needs a question and at most 4 options.');
    }
    if (signal?.aborted) throw new Error('The elicitation was aborted.');

    // askUserQuestionTimeout (settings.md): the host is the single authority for
    // the auto-continue clock, and the card is what carries it to the countdown,
    // so it is stamped BEFORE anything is surfaced. The default "never" leaves it
    // undefined and arms nothing. Same stamp `PiAgent.requestAskUserPermission`
    // makes — without it a user's setting governed one runtime out of three.
    askUser.timeoutMs = this.options.timeoutMs();
    // F1.818 — and the deadline is ASK-anchored: `askedAt` is what a late-mounted
    // card reads its true remaining time from, instead of restarting the clock at
    // mount (SIT-s arm A read "Auto-continuing in 19s…" twelve minutes late).
    askUser.askedAt = Date.now();

    // An elicitation reaches the user through the permission channel, not through
    // runPreToolUseChecks, so the gate's interaction rule cannot see it (the same
    // reason PiAgent states for the same guard). `dontAsk` never prompts, so the
    // request is refused here instead of putting a card on screen in the mode
    // that promised not to ask. The rejection degrades to a settled `decline`
    // upstream, so the server is answered rather than left waiting.
    if (this.options.permissionMode() === 'dontAsk') {
      throw new Error(
        `ask_user is unavailable in ${PERMISSION_MODE_AGENT_LABELS.dontAsk} mode, which never prompts.`,
      );
    }

    const requestId = `${this.options.idPrefix}-${Date.now()}-${++this.sequence}`;
    const settled = new Promise<{ answer?: AskUserAnswer; error?: string }>(resolve => {
      this.pending.set(requestId, { askUser, settle: resolve });
    });

    const abort = () => this.cancel(requestId, 'The elicitation was aborted.');
    signal?.addEventListener('abort', abort, { once: true });

    try {
      this.options.surface({ requestId, askUser });
    } catch (error) {
      this.pending.delete(requestId);
      signal?.removeEventListener('abort', abort);
      throw new Error(
        `The elicitation never reached a user: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // F1.818 — the clock arms HERE, at ask time, host-side, as Pi's
    // ask-user-service arms its own: an expiry is a settlement, not a renderer
    // courtesy, so an unmounted card (an unattended or backgrounded session)
    // still expires. A mounted card's countdown is a reading of this deadline,
    // never the deadline itself.
    if (askUser.timeoutMs !== undefined) {
      const entry = this.pending.get(requestId);
      if (entry) entry.timeout = setTimeout(() => this.autoContinue(requestId), askUser.timeoutMs);
    }

    try {
      const outcome = await settled;
      if (outcome.error) throw new Error(outcome.error);
      if (!outcome.answer) throw new Error('No answer was provided.');
      return outcome.answer;
    } finally {
      this.clearEntry(requestId);
      signal?.removeEventListener('abort', abort);
    }
  }

  /**
   * F1.818 — expiry settlement: RESOLVES the waiting ask with Pi's auto-continue
   * shape (`autoContinued`, never a tool error — `askUserQuestionAnswerEnvelope`
   * turns it into the SDK's `afkTimeoutMs` and away note), and takes the card
   * off the host through the same withdraw channel a cancel uses: the question
   * is answered even though nobody answered it. A renderer that mounted the card
   * keeps its own countdown, anchored to `askedAt`; its late expiry lands on a
   * settled id and is a no-op.
   */
  private autoContinue(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.clearEntry(requestId);
    pending.settle({ answer: { type: 'batched', answers: {}, autoContinued: true } });
    try {
      this.options.withdraw(requestId);
    } catch {
      // Same posture as cancel: a host that cannot be told is the owner's to
      // report, never a reason to throw out of an expiry.
    }
  }

  /** Remove one entry and its clock, whoever is settling it. */
  private clearEntry(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    if (pending.timeout) clearTimeout(pending.timeout);
    this.pending.delete(requestId);
  }

  /**
   * Deliver one permission response. Returns whether this bridge owned the id,
   * so the caller can fall through to its own approval bookkeeping.
   *
   * A denial is a user decision, not an error: it settles as a cancel of the
   * dialog, which `handleMcpElicitationWithAskUser` reads as "no usable answer"
   * and turns into a decline for the server.
   */
  respond(requestId: string, allowed: boolean, answer?: AskUserAnswer): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.clearEntry(requestId);
    if (!allowed) {
      pending.settle({ error: 'The user cancelled the question.' });
      return true;
    }
    if (!answer) {
      pending.settle({ error: 'No answer was provided.' });
      return true;
    }
    const problem = validateAnswer(pending.askUser, answer);
    pending.settle(problem ? { error: problem } : { answer });
    return true;
  }

  /** Settle one pending dialog as cancelled, and withdraw its card from the host (F1.220). */
  cancel(requestId: string, reason: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.clearEntry(requestId);
    pending.settle({ error: reason });
    try {
      this.options.withdraw(requestId);
    } catch {
      // The dialog is settled either way; a host that cannot be told is the
      // owner's fault to report, never a reason to throw out of a teardown.
    }
  }

  /** Settle every pending dialog; used on abort and teardown. */
  cancelAll(reason: string): void {
    for (const requestId of [...this.pending.keys()]) this.cancel(requestId, reason);
  }
}

/** `null` when the answer is sendable, else the reason it is not. */
function validateAnswer(askUser: AskUserPermissionRequest, answer: AskUserAnswer): string | null {
  if (answer.type === 'batched') {
    try {
      validateBatchedAskUserAnswer(askUser.questions, answer);
      return null;
    } catch {
      return 'Invalid batched answer.';
    }
  }
  if (answer.type === 'option') {
    const expected = askUser.options[answer.optionIndex];
    return Number.isInteger(answer.optionIndex) && expected !== undefined && answer.value === expected
      ? null
      : 'Invalid option answer.';
  }
  if (answer.type === 'free_text') {
    if (!askUser.allowFreeText) return 'Free-text answers are not allowed for this question.';
    return answer.value.trim() ? null : 'An empty answer is not a value.';
  }
  return 'Unsupported answer type.';
}
