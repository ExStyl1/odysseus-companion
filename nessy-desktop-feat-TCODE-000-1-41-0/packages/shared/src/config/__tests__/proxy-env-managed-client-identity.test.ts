/**
 * F1.563 (P-WJax-1, DECIDED by the controller 2026-09-24) — the CHILD half of
 * the managed client-identity tier.
 *
 * The host hop now presents the identity a managed `env` block names ahead of
 * the stored Settings one, on both hosts (`network-runtime.ts`,
 * `network-proxy.ts`). The children must agree, or a codex / claude-runtime
 * turn (host hop) and a Pi turn or the claude child (children) authenticate as
 * two different identities under one configuration. `buildNetworkEnvVars` wrote
 * the Settings identity over the inherited environment every time, so a
 * managed identity reached no child while Settings named one. Its CA ladder in
 * the same function already ranks a managed `NODE_EXTRA_CA_CERTS` first; the
 * identity now follows the same rule: when a managed block names the identity,
 * nothing is projected and the inherited (managed) values go through.
 *
 * Fixture values are placeholder paths only, never key material.
 */
import { describe, expect, it } from 'bun:test';
import { buildNetworkEnvVars } from '../proxy-env.ts';

const STORED = {
  enabled: false,
  clientCertPath: '/stored/cert.pem',
  clientKeyPath: '/stored/key.pem',
  clientKeyPassphrase: 'stored-passphrase',
};

const MANAGED_ENV = {
  CLAUDE_CODE_CLIENT_CERT: '/managed/cert.pem',
  CLAUDE_CODE_CLIENT_KEY: '/managed/key.pem',
};

const IDENTITY_NAMES = ['CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE'];
const identityOf = (env: Record<string, string>) => Object.fromEntries(IDENTITY_NAMES.filter(name => name in env).map(name => [name, env[name]]));

describe('F1.563 — buildNetworkEnvVars leaves a managed client identity to the inherited environment', () => {
  it('a managed identity and a Settings identity: nothing is projected, so the managed values reach the child', () => {
    const managedOrigin = (name: string) => name in MANAGED_ENV;
    const env = buildNetworkEnvVars(STORED, { processEnv: MANAGED_ENV, managedEnvOrigin: managedOrigin });
    expect(identityOf(env)).toEqual({});
    // What a spawn site builds: the environment spread first, the projection over it.
    expect(identityOf({ ...MANAGED_ENV, ...env })).toEqual(MANAGED_ENV);
  });

  it('a managed block naming only the certificate still takes the tier (a half-named managed identity is not mixed with Settings)', () => {
    const processEnv = { CLAUDE_CODE_CLIENT_CERT: '/managed/cert.pem' };
    const env = buildNetworkEnvVars(STORED, { processEnv, managedEnvOrigin: name => name === 'CLAUDE_CODE_CLIENT_CERT' });
    expect(identityOf(env)).toEqual({});
  });

  it('CONTROL: the same names from the OPERATOR\'s environment (not managed) still lose to Settings', () => {
    const env = buildNetworkEnvVars(STORED, { processEnv: MANAGED_ENV, managedEnvOrigin: () => false });
    expect(identityOf(env)).toEqual({
      CLAUDE_CODE_CLIENT_CERT: '/stored/cert.pem',
      CLAUDE_CODE_CLIENT_KEY: '/stored/key.pem',
      CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: 'stored-passphrase',
    });
  });

  it('CONTROL: a managed-origin name that is EMPTY is no tier', () => {
    const processEnv = { CLAUDE_CODE_CLIENT_CERT: '  ', CLAUDE_CODE_CLIENT_KEY: '' };
    const env = buildNetworkEnvVars(STORED, { processEnv, managedEnvOrigin: () => true });
    expect(env.CLAUDE_CODE_CLIENT_CERT).toBe('/stored/cert.pem');
  });

  it('CONTROL: excludeClientIdentity still withholds everything', () => {
    const env = buildNetworkEnvVars(STORED, { processEnv: {}, managedEnvOrigin: () => false, excludeClientIdentity: true });
    expect(identityOf(env)).toEqual({});
  });
});
