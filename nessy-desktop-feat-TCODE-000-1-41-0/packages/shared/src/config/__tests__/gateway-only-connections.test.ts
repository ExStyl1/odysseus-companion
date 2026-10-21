/**
 * P6.498 — the operator's "gateway sign-in only" lock, driven on values.
 *
 * `done_means`'s own control is written into the shape of this suite: *"a test
 * drives set and unset with the key absent as the positive control"*. The
 * ABSENT case is the one that matters most — an unmanaged install must be
 * byte-identical to one built before this row, and a lock that fired without a
 * policy would be worse than no lock at all.
 *
 * Driven through the registrar rather than through a policy file, because the
 * registrar is the seam every host feeds and the decision is what is under
 * test. The composition that feeds it has its own suite in `server-core`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  areNonGatewayConnectionsManagedDisabled,
  isNessyGatewayConnectionShape,
  isNonGatewayConnectionRefused,
  registerManagedNonGatewayConnectionsDisabledProvider,
} from '../llm-connections.ts';
import { NESTOR_GATEWAY_HOST } from '../../auth/nestor.ts';

const GATEWAY = { providerType: 'claude-runtime', baseUrl: `https://${NESTOR_GATEWAY_HOST}/api/v1/cli/openai-like/v1` };
const PERSONAL_KEY = { providerType: 'anthropic', baseUrl: undefined };
const BYO = { providerType: 'pi_compat', baseUrl: 'https://llm.corp.example/v1' };

afterEach(() => {
  registerManagedNonGatewayConnectionsDisabledProvider(undefined);
});

describe('P6.498 — the gateway-only lock', () => {
  test('THE CONTROL — with the key ABSENT nothing is refused, for anyone', () => {
    // The state every unmanaged install is in. If this ever goes red the lock
    // has started firing on people who deployed no policy at all, which is the
    // one failure that would be worse than the gap the row closes.
    expect(areNonGatewayConnectionsManagedDisabled()).toBe(false);
    for (const connection of [GATEWAY, PERSONAL_KEY, BYO]) {
      expect(isNonGatewayConnectionRefused(connection), JSON.stringify(connection)).toBe(false);
    }
  });

  test('SET: personal-key and BYO are refused, the gateway cards are not', () => {
    registerManagedNonGatewayConnectionsDisabledProvider(() => true);
    expect(areNonGatewayConnectionsManagedDisabled()).toBe(true);
    expect(isNonGatewayConnectionRefused(PERSONAL_KEY)).toBe(true);
    expect(isNonGatewayConnectionRefused(BYO)).toBe(true);
    // The four one-click cards, by the two facts that identify them: the
    // gateway host, and the native cloud agent which has no base URL because it
    // IS the gateway's own agent.
    expect(isNonGatewayConnectionRefused(GATEWAY)).toBe(false);
    expect(isNonGatewayConnectionRefused({ providerType: 'nestor-cloud-agent' })).toBe(false);
  });

  test('UNSET: an explicit false is not a lock, and neither is a throwing provider', () => {
    // `false` and unset are the same behaviour on purpose, so a managed
    // deployment that spells the key `false` stays on exactly the path an
    // unmanaged one takes. A provider that throws reads as no opinion — an
    // unreadable policy file must not lock every card in the product.
    registerManagedNonGatewayConnectionsDisabledProvider(() => false);
    expect(isNonGatewayConnectionRefused(BYO)).toBe(false);
    registerManagedNonGatewayConnectionsDisabledProvider(() => { throw new Error('unreadable'); });
    expect(isNonGatewayConnectionRefused(BYO)).toBe(false);
  });

  test('the gateway classifier reads the HOST, not a slug or a display name', () => {
    // A slug list was rejected because a user can rename a connection and an
    // operator's lock must not turn on a display name. The host is the same
    // fact that decides whether `Nestor-Token` is attached.
    expect(isNessyGatewayConnectionShape({ baseUrl: `https://${NESTOR_GATEWAY_HOST}/anything` })).toBe(true);
    expect(isNessyGatewayConnectionShape({ baseUrl: 'https://evil.example/?x=' + NESTOR_GATEWAY_HOST }))
      .toBe(false);
    expect(isNessyGatewayConnectionShape({ baseUrl: 'not a url' })).toBe(false);
    expect(isNessyGatewayConnectionShape({ baseUrl: undefined })).toBe(false);
  });
});
