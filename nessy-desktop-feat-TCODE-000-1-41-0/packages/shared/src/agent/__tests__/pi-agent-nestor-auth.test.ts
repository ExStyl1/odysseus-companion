import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { isUsablePiStoredCredential, resolveNestorGatewayJwtForPi } from '../pi-agent.ts';
import { NESTOR_CLI_BASE_PREFIX, isNestorCliBaseUrl } from '../../auth/nestor.ts';

describe('PiAgent Nessy Gateway auth', () => {
  it('uses the shared dp JWT for Pi connections on the Nestor CLI gateway', () => {
    const jwt = resolveNestorGatewayJwtForPi(
      {
        providerType: 'pi_compat',
        runtime: { baseUrl: `${NESTOR_CLI_BASE_PREFIX}openai-like/v1` },
      },
      () => ({ jwt: 'live-dp-jwt' }),
    );

    expect(jwt).toBe('live-dp-jwt');
  });

  it('does not read dp creds for custom pi_compat endpoints', () => {
    let reads = 0;
    const jwt = resolveNestorGatewayJwtForPi(
      {
        providerType: 'pi_compat',
        runtime: { baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/personal/x' },
      },
      () => {
        reads += 1;
        return { jwt: 'should-not-be-used' };
      },
    );

    expect(jwt).toBeNull();
    expect(reads).toBe(0);
  });

  it('does not read dp creds for non-Pi gateway-like connections', () => {
    let reads = 0;
    const jwt = resolveNestorGatewayJwtForPi(
      {
        providerType: 'codex-runtime',
        runtime: { baseUrl: `${NESTOR_CLI_BASE_PREFIX}openai-like/v1` },
      },
      () => {
        reads += 1;
        return { jwt: 'should-not-be-used' };
      },
    );

    expect(jwt).toBeNull();
    expect(reads).toBe(0);
  });

  it('DA1.10 — reads no dp creds for an unknown path under the CLI prefix', () => {
    // The mirror of the interceptor's new negative. `isNestorCliBaseUrl` still
    // says true for this URL (nine non-credential sites read it); the credential
    // decision says no, so a BYO `pi_compat` connection parked under the prefix
    // is never handed the corporate JWT as its api key.
    let reads = 0;
    const jwt = resolveNestorGatewayJwtForPi(
      {
        providerType: 'pi_compat',
        runtime: { baseUrl: `${NESTOR_CLI_BASE_PREFIX}personal/x` },
      },
      () => {
        reads += 1;
        return { jwt: 'should-not-be-used' };
      },
    );

    expect(isNestorCliBaseUrl(`${NESTOR_CLI_BASE_PREFIX}personal/x`)).toBe(true);
    expect(jwt).toBeNull();
    expect(reads).toBe(0);
    // And the stored-credential fallback follows the same classification, so the
    // two cannot disagree: an arbitrary key is legitimate on that connection.
    expect(isUsablePiStoredCredential(
      { providerType: 'pi_compat', runtime: { baseUrl: `${NESTOR_CLI_BASE_PREFIX}personal/x` } },
      'sk-not-a-jwt',
    )).toBe(true);
  });

  it('matches only the Nestor CLI URL prefix', () => {
    expect(isNestorCliBaseUrl(`${NESTOR_CLI_BASE_PREFIX}models`)).toBe(true);
    expect(isNestorCliBaseUrl('https://code-completion-nestor.tcsbank.ru/api/v1/personal/x')).toBe(false);
  });
});

/**
 * DA1.2, then DA1.13 — the stored-credential fallback beneath the dp JWT.
 *
 * The live path is guarded by `getValidCreds` (expiry AND shape); this suite is
 * about the `credentialManager.getLlmApiKey(slug)` fallback underneath it, which
 * `unified-network-interceptor.ts` symbol `rewriteNestorAuthHeaders` would carry
 * out as `Nestor-Token` whatever it contained.
 *
 * **DA1.2 narrowed that fallback to a JWT SHAPE and named the rest as DA1.13's;
 * DA1.13 removed the fallback instead of tightening it**, because a gateway card
 * keeps no credential of its own at all now. The arms below therefore changed
 * DIRECTION rather than being added to: the case that used to assert `a.b.c`
 * passes is the one that proves the residue is closed, and it is written as a
 * flip on purpose — a pin whose two arms have come to agree is a deleted test
 * that still runs.
 */
describe('DA1.2 + DA1.13 — the Pi gateway stored-credential fallback is closed', () => {
  const gateway = {
    providerType: 'pi_compat' as const,
    runtime: { baseUrl: `${NESTOR_CLI_BASE_PREFIX}openai-like/v1` },
  };

  it('refuses EVERY stored credential on a gateway-classified connection', () => {
    expect(isUsablePiStoredCredential(gateway, 'sk-not-a-jwt')).toBe(false);
    // The two near-misses DA1.2's structural test existed to catch: a value with
    // the right dot count but an empty segment, and one with too few segments.
    expect(isUsablePiStoredCredential(gateway, 'a..c')).toBe(false);
    expect(isUsablePiStoredCredential(gateway, 'header.payload')).toBe(false);
    // And the empty string, which never reaches the guard in production
    // (`getPiAuth` tests `apiKey &&` first) but must not read as "allowed".
    expect(isUsablePiStoredCredential(gateway, '')).toBe(false);
  });

  it('leaves a BYO pi_compat endpoint alone — an arbitrary key belongs there', () => {
    const byo = {
      providerType: 'pi_compat' as const,
      runtime: { baseUrl: 'https://llm.example.internal/v1' },
    };
    expect(isUsablePiStoredCredential(byo, 'sk-not-a-jwt')).toBe(true);
    // Same host as the gateway, different path: a custom endpoint with normal
    // provider auth, so its key is its own business.
    expect(isUsablePiStoredCredential(
      {
        providerType: 'pi_compat',
        runtime: { baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/personal/x' },
      },
      'sk-not-a-jwt',
    )).toBe(true);
    // A non-Pi provider type on the gateway URL is not this file's connection at
    // all — `resolveNestorGatewayJwtForPi` already answers null for it.
    expect(isUsablePiStoredCredential(
      { providerType: 'codex-runtime', runtime: { baseUrl: `${NESTOR_CLI_BASE_PREFIX}openai-like/v1` } },
      'sk-not-a-jwt',
    )).toBe(true);
  });

  it('DA1.13 CLOSES DA1.2s NAMED RESIDUE: a well-shaped stale snapshot is refused too', () => {
    // This assertion was `toBe(true)` under DA1.2 and the flip IS the row.
    // `isJwtShaped` is three non-empty dot segments with no decode and no claim
    // check, so `a.b.c` passed it and a months-old snapshot left the machine as
    // `Nestor-Token`. DA1.13 removed the fallback rather than deepening the
    // test: the credential of record is the live creds file, tried above this
    // guard, and a value found here can only predate that rule.
    expect(isUsablePiStoredCredential(gateway, 'a.b.c')).toBe(false);
    // The control that keeps this suite discriminating rather than constant: the
    // BYO arm still answers the other way for the identical value.
    expect(isUsablePiStoredCredential(
      { providerType: 'pi_compat', runtime: { baseUrl: 'https://llm.example.internal/v1' } },
      'a.b.c',
    )).toBe(true);
  });

  it('is wired into the getPiAuth fallback, ahead of the api_key return', () => {
    // `getPiAuth` is private and its module graph is the whole agent; the honest
    // instrument for "the guard is on the path" is the source itself. This fails
    // if the call is deleted or moved after the return it guards.
    const source = readFileSync(new URL('../pi-agent.ts', import.meta.url), 'utf-8');
    const guardAt = source.indexOf('!isUsablePiStoredCredential(this.config, apiKey)');
    const returnAt = source.indexOf('Retrieved API key credential for Pi provider');
    expect(guardAt).toBeGreaterThan(-1);
    expect(returnAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(returnAt);
  });
});
