/**
 * D1.194 (claude half) — an expired SUBSCRIPTION credential gets its own typed
 * code, and the code was already on the wire.
 *
 * ## The row, and what reading it settled
 *
 * The row: an expired subscription credential gets "a typed error whose action
 * is Update credentials → `/settings`" on claude, where the corporate
 * credential gets a card with the REASON and one sign-in button. Read before
 * invented: `ErrorCode` (`packages/core/src/types/message.ts`) has carried
 * `expired_oauth_token` all along, and `errors.ts`'s `ERROR_DEFINITIONS` entry
 * for it already declares the `reauth` action first. What did not exist was a
 * PRODUCER — `runErrorDiagnostics` declares seven codes and that is not one of
 * them (the D1.193 comment beside the call site records `tsc` saying so) — so
 * every expired Claude subscription arrived as the generic
 * `invalid_credentials`, whose one action navigates to a settings page.
 *
 * ## Why a helper rather than a source window
 *
 * Its sibling `claude-oauth-live-refresh.test.ts` pins its own call site with a
 * source-text window and says why: reaching the real arm needs an SDK child
 * dying on a real expired credential, which is a sitting. The DECISION,
 * though, is a pure function of two values both computed at that site, so it is
 * lifted into {@link claudeExpiredSubscriptionPresentation} and driven for
 * real. One source window remains, for the WIRING only — that the call site
 * reads the helper rather than the diagnostic code — because that is the half a
 * pure function cannot pin.
 *
 * ## The control that makes the copied actions honest
 *
 * `ERROR_DEFINITIONS` is not exported, so the helper carries a copy of the
 * `expired_oauth_token` actions. `parseError('OAuth token expired')` returns
 * that definition, so the agreement is asserted rather than assumed: an edit to
 * the definition reddens the helper instead of leaving two copies to drift.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { claudeExpiredSubscriptionPresentation } from '../claude-agent.ts';
import { parseError } from '../errors.ts';

describe('D1.194 — the expired-subscription typed code (claude)', () => {
  it('answers the OAuth-backed credential with expired_oauth_token and a sign-in action', () => {
    const presentation = claudeExpiredSubscriptionPresentation({
      diagnosticCode: 'invalid_credentials',
      diagnosticAuthType: 'oauth_token',
    });
    expect(presentation).toBeDefined();
    expect(presentation?.code).toBe('expired_oauth_token');
    // The sign-in button, FIRST — which is the whole of what the row asks the
    // card to carry beside the reason.
    expect(presentation?.actions[0]?.action).toBe('reauth');
    // And the settings route survives beside it, so the card is not worse than
    // the one it replaces while the renderer's `reauth` arm is still owed.
    expect(presentation?.actions.some(action => action.action === 'settings')).toBe(true);
  });

  it('NEGATIVE — a BYO api key keeps the settings hint, which is its honest remedy', () => {
    // The discriminator is the authType and nothing else. A key the API
    // rejected really is fixed by editing it in settings; a subscription is not.
    expect(claudeExpiredSubscriptionPresentation({
      diagnosticCode: 'invalid_credentials',
      diagnosticAuthType: 'api_key',
    })).toBeUndefined();
    // …and an unknown authType (no default connection at all) is left alone too.
    expect(claudeExpiredSubscriptionPresentation({
      diagnosticCode: 'invalid_credentials',
      diagnosticAuthType: undefined,
    })).toBeUndefined();
  });

  it('BOUNDARY — an OAuth connection failing for some OTHER reason is untouched', () => {
    // MUTATION KILLED: dropping the code check and answering on the authType
    // alone, which would relabel a rate limit and a billing failure as an
    // expired session and offer to sign the user in again.
    for (const code of ['rate_limited', 'billing_error', 'service_unavailable', 'token_expired', 'unknown_error']) {
      expect(claudeExpiredSubscriptionPresentation({
        diagnosticCode: code,
        diagnosticAuthType: 'oauth_token',
      })).toBeUndefined();
    }
  });

  it('the copied actions agree with errors.ts, read through parseError', () => {
    // `parseError` reaches `expired_oauth_token` through its 401 arm's
    // oauth/token/session sub-branch, so this is the definition itself and not
    // a second copy of the copy.
    const definition = parseError(new Error('401 OAuth token expired'));
    expect(definition.code).toBe('expired_oauth_token');
    const presentation = claudeExpiredSubscriptionPresentation({
      diagnosticCode: 'invalid_credentials',
      diagnosticAuthType: 'oauth_token',
    });
    expect(presentation?.actions).toEqual(definition.actions);
  });

  it('the call site reads the helper, not the diagnostic code', () => {
    // A SOURCE window for the WIRING only, for the reason
    // `claude-oauth-live-refresh.test.ts` gives at its own: the arm runs behind
    // an SDK child dying on a real expired credential. The needle is declared
    // BELOW the region it bounds in the file, so this cannot pass by scanning
    // past it.
    const source = readFileSync(fileURLToPath(new URL('../claude-agent.ts', import.meta.url)), 'utf8');
    const at = source.indexOf('const expiredSubscription = claudeExpiredSubscriptionPresentation({');
    expect(at).toBeGreaterThan(-1);
    // D1.111 — an END ANCHOR, and the check that chose it: this anchor's first
    // `{` is the CALL'S ARGUMENT object, two properties long, while both claims
    // below sit after it closes. So the bound is the statement that ends the
    // arm — asserted FOUND, because an `indexOf` miss answers -1 and
    // `slice(at, -1)` is the rest of a 12 000-line file.
    const end = source.indexOf("yield { type: 'complete' };", at);
    expect(end).toBeGreaterThan(at);
    const after = source.slice(at, end);
    // Both halves of the presentation are consumed: the actions AND the code.
    expect(after).toContain('? expiredSubscription.actions');
    expect(after).toContain("code: expiredSubscription ? expiredSubscription.code : diagnostics.code,");
    // BOUNDARY CONTROL: the next arm below this one, which a bound that ran away
    // would swallow.
    expect(after).not.toContain('wasResuming fallback retry');
  });
});
