/**
 * P6.443, codex arm — a codex turn that ends on a provider error or a refusal
 * NAMES the ending, in the vocabulary a claude run already uses.
 *
 * ## What was silent
 *
 * `turn/completed` emitted a bare `{ type: 'complete' }`. The `error`
 * notification produced a `codex: …` line and the turn's VERDICT said nothing,
 * while the same ending on claude names itself through
 * `CLAUDE_RESULT_SUBTYPE_REASON`. Measured at `base-agent.ts`'s cost latch,
 * codex stamped no `terminalIsError` and no qualifying `terminalReason` — 0 and
 * 0, against claude 2 and pi 1.
 *
 * ## The row's M5-codex clause is REFUTED here, and the search is why
 *
 * It reads: *"none — searched `packages/codex-protocol/generated/v2` (562
 * files) for refus/decline/reject; hits are approval decisions only"*. The
 * search is accurate; the conclusion is not. `CodexErrorInfo` publishes
 * `cyberPolicy` and `misalignmentPolicyViolation` — two refusal codes whose
 * names contain none of those three stems, because they are named after the
 * POLICY rather than after the act.
 *
 * WHAT EACH TEST KILLS:
 *  - the mapping arms die if either policy code stops reading as a refusal, or
 *    if the catch-all stops being `provider_error`.
 *  - the object-variant arm dies if the single-key shape
 *    (`{ httpConnectionFailed: { httpStatusCode } }`) stops being read — it is
 *    half of codex's own union.
 *  - the `sessionBudgetExceeded` arm pins a DECISION, not a behaviour: it must
 *    NOT claim a dollar budget the union never named.
 *  - the stamping arms die if the verdict stops reaching `turn/completed`, if it
 *    leaks into a later turn, or if it is stamped on an ordinary completion.
 *  - the call-site arm dies if the agent stops recording it, or starts recording
 *    it for a retrying error or for another turn on the same thread.
 *  - the vocabulary arm dies if either reason loses its renderer copy, which
 *    would make the stamp invisible again by another route.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TERMINAL_REASON_NOTICE_VALUES } from '@nessy-agent/core/types';
import { CodexEventAdapter, codexTerminalReasonForError } from '../backend/codex/event-adapter.ts';

describe('P6.443 · CodexErrorInfo -> the terminal-reason vocabulary', () => {
  it('maps codex\'s TWO policy refusals to provider_refusal', () => {
    expect(codexTerminalReasonForError('cyberPolicy')).toBe('provider_refusal');
    expect(codexTerminalReasonForError('misalignmentPolicyViolation')).toBe('provider_refusal');
  });

  it.each([
    'contextWindowExceeded',
    'usageLimitExceeded',
    'serverOverloaded',
    'internalServerError',
    'unauthorized',
    'badRequest',
    'threadRollbackFailed',
    'sandboxError',
    'other',
  ])('maps the plain variant %p to provider_error', (code) => {
    expect(codexTerminalReasonForError(code)).toBe('provider_error');
  });

  it('reads the single-key OBJECT variants, which are half of codex\'s union', () => {
    for (const key of [
      'httpConnectionFailed',
      'responseStreamConnectionFailed',
      'responseStreamDisconnected',
      'responseTooManyFailedAttempts',
    ]) {
      expect(codexTerminalReasonForError({ [key]: { httpStatusCode: 500 } })).toBe('provider_error');
    }
    expect(codexTerminalReasonForError({ activeTurnNotSteerable: { turnKind: 'review' } }))
      .toBe('provider_error');
  });

  it('falls back to provider_error for an absent or unreadable code', () => {
    expect(codexTerminalReasonForError(undefined)).toBe('provider_error');
    expect(codexTerminalReasonForError(null)).toBe('provider_error');
    // A multi-key object is not one of codex's variants; guessing which key is
    // the code would be inventing.
    expect(codexTerminalReasonForError({ a: 1, b: 2 })).toBe('provider_error');
  });

  it('does NOT claim a dollar budget for sessionBudgetExceeded — a pinned DECISION', () => {
    // The union gives it no unit and no doc comment, and the copy behind
    // `max_budget_usd` names a dollar budget the user set. Naming a budget that
    // may not be one is the confident-wrong-answer shape this fork keeps
    // finding, so it lands on the catch-all with the raw codex code still
    // readable beside it on `error_code`.
    expect(codexTerminalReasonForError('sessionBudgetExceeded')).toBe('provider_error');
    expect(codexTerminalReasonForError('sessionBudgetExceeded')).not.toBe('max_budget_usd');
  });
});

describe('P6.443 · the verdict reaches turn/completed', () => {
  const completed = (adapter: CodexEventAdapter) =>
    adapter.adapt('turn/completed', { threadId: 't', turnId: 'u' })
      .find(event => event.type === 'complete') as { type: 'complete'; terminalReason?: string } | undefined;

  it('stamps the reason the agent recorded', () => {
    const adapter = new CodexEventAdapter();
    adapter.startTurn();
    adapter.noteTerminalError('provider_refusal');
    expect(completed(adapter)?.terminalReason).toBe('provider_refusal');
  });

  it('leaves an ordinary completion unstamped — the POSITIVE CONTROL', () => {
    // Without this, "the reason is stamped" would be equally satisfied by an
    // adapter that stamps every completion.
    const adapter = new CodexEventAdapter();
    adapter.startTurn();
    expect(completed(adapter)).toEqual({ type: 'complete' });
  });

  it('does not leak the verdict into the NEXT turn', () => {
    const adapter = new CodexEventAdapter();
    adapter.startTurn();
    adapter.noteTerminalError('provider_error');
    expect(completed(adapter)?.terminalReason).toBe('provider_error');
    adapter.startTurn();
    expect(completed(adapter)).toEqual({ type: 'complete' });
  });

  it('is consumed once, so one error cannot verdict two completions', () => {
    const adapter = new CodexEventAdapter();
    adapter.startTurn();
    adapter.noteTerminalError('provider_error');
    expect(completed(adapter)?.terminalReason).toBe('provider_error');
    expect(completed(adapter)).toEqual({ type: 'complete' });
  });

  it('last terminal error wins within one turn', () => {
    const adapter = new CodexEventAdapter();
    adapter.startTurn();
    adapter.noteTerminalError('provider_error');
    adapter.noteTerminalError('provider_refusal');
    expect(completed(adapter)?.terminalReason).toBe('provider_refusal');
  });
});

describe('P6.443 · the agent records it, and only for a terminal error', () => {
  const SOURCE = readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8');

  it('calls noteTerminalError from the error branch', () => {
    expect(SOURCE).toContain('this.eventAdapter.noteTerminalError(');
    expect(SOURCE).toContain('codexTerminalReasonForError(');
  });

  it('sits inside the SAME guard the StopFailure mint uses', () => {
    // `willRetry !== true` AND the error names the active turn. A retrying error
    // is a turn that is still going; an error naming another turn on this thread
    // did not end this one. Stamping either would report a stop that did not
    // happen — the confident-wrong-answer shape P6.118's own comment names.
    const mint = SOURCE.indexOf('this.emitCodexStopFailureHookOnce(msg?.error, text);');
    const note = SOURCE.indexOf('this.eventAdapter.noteTerminalError(');
    expect(mint).toBeGreaterThan(0);
    expect(note).toBeGreaterThan(mint);
    // Nothing closes the guard between the two.
    expect(SOURCE.slice(mint, note)).not.toContain('\n      }');
  });
});

describe('P6.443 · both reasons already have renderer copy', () => {
  it('a stamped reason is one the transcript can render', () => {
    // The stamp is only worth anything if `terminal-reason-copy.ts` has a key
    // for it; `TERMINAL_REASON_NOTICE_VALUES` is the shared fact both writers
    // read, and `terminal-reason-copy.ts` types its map as a TOTAL Record over
    // it, so membership here IS the guarantee that copy exists.
    expect(TERMINAL_REASON_NOTICE_VALUES).toContain('provider_error' as never);
    expect(TERMINAL_REASON_NOTICE_VALUES).toContain('provider_refusal' as never);
  });
});
