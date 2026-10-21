/**
 * Tests for the subprocess network-trust env projection (proxy-env.ts).
 *
 * The trust chain must reach subprocesses (network-config.md:78, :92-98): the
 * CA path travels as NODE_EXTRA_CA_CERTS (honored natively by Node AND Bun)
 * and the client identity as CLAUDE_CODE_CLIENT_CERT /
 * CLAUDE_CODE_CLIENT_KEY / CLAUDE_CODE_CLIENT_KEY_PASSPHRASE — the
 * documented spellings, so a Claude Code subprocess picks them up without
 * our help. Nothing is emitted when nothing is configured.
 *
 * Fixture values are placeholders only — never real key material.
 */
import { describe, expect, it } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildNetworkEnvVars } from '../proxy-env.ts';
import {
  applyManagedEnv,
  clearManagedOriginEnvVars,
  isManagedOriginEnvVar,
  managedOriginEnvVars,
} from '../managed-env.ts';

const EMPTY_ENV: Record<string, string | undefined> = {};

describe('buildNetworkEnvVars', () => {
  it('emits nothing when nothing is configured', () => {
    expect(buildNetworkEnvVars(undefined, { processEnv: EMPTY_ENV })).toEqual({});
    expect(buildNetworkEnvVars({ enabled: false }, { processEnv: EMPTY_ENV })).toEqual({});
  });

  it('emits proxy variables only when the proxy is enabled', () => {
    const settings = { enabled: false, httpsProxy: 'https://proxy.corp.example:8080' };
    expect(buildNetworkEnvVars(settings, { processEnv: EMPTY_ENV })).toEqual({});

    const enabled = buildNetworkEnvVars({ ...settings, enabled: true }, { processEnv: EMPTY_ENV });
    expect(enabled.HTTPS_PROXY).toBe('https://proxy.corp.example:8080');
    expect(enabled.https_proxy).toBe('https://proxy.corp.example:8080');
    expect(enabled.HTTP_PROXY).toBeUndefined();
  });

  it('projects a custom tlsCaPath as NODE_EXTRA_CA_CERTS regardless of proxy enablement', () => {
    const env = buildNetworkEnvVars(
      { enabled: false, tlsCaPath: '~/corp-ca.pem' },
      { processEnv: EMPTY_ENV },
    );

    expect(env.NODE_EXTRA_CA_CERTS).toBe(join(homedir(), 'corp-ca.pem'));
  });

  it('a user-configured custom CA wins over an operator-provided NODE_EXTRA_CA_CERTS', () => {
    const env = buildNetworkEnvVars(
      { enabled: false, tlsCaPath: '/etc/nessy/corp-ca.pem' },
      { processEnv: { NODE_EXTRA_CA_CERTS: '/etc/shell-provided.pem' } },
    );

    expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/nessy/corp-ca.pem');
  });

  it('projects the bundled corporate CA resource when present', () => {
    const env = buildNetworkEnvVars(undefined, {
      processEnv: EMPTY_ENV,
      bundledCaPath: '/app/resources/certs/tinkoff-bundle.crt',
    });

    expect(env.NODE_EXTRA_CA_CERTS).toBe('/app/resources/certs/tinkoff-bundle.crt');
  });

  it('an operator-provided NODE_EXTRA_CA_CERTS wins over the app-default bundled resource', () => {
    const env = buildNetworkEnvVars(undefined, {
      processEnv: { NODE_EXTRA_CA_CERTS: '/etc/shell-provided.pem' },
      bundledCaPath: '/app/resources/certs/tinkoff-bundle.crt',
    });

    // Emitting nothing preserves the inherited shell value at the spawn site
    // (callers spread process.env first, then this projection).
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it('does not project the bundled CA when useBundledCa is false', () => {
    const env = buildNetworkEnvVars(
      { enabled: false, useBundledCa: false },
      { processEnv: EMPTY_ENV, bundledCaPath: '/app/resources/certs/tinkoff-bundle.crt' },
    );

    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it('projects the client identity under the documented spellings', () => {
    const env = buildNetworkEnvVars(
      {
        enabled: false,
        clientCertPath: '~/client.pem',
        clientKeyPath: '~/client-key.pem',
        clientKeyPassphrase: 'fixture-passphrase-not-real',
      },
      { processEnv: EMPTY_ENV },
    );

    expect(env.CLAUDE_CODE_CLIENT_CERT).toBe(join(homedir(), 'client.pem'));
    expect(env.CLAUDE_CODE_CLIENT_KEY).toBe(join(homedir(), 'client-key.pem'));
    expect(env.CLAUDE_CODE_CLIENT_KEY_PASSPHRASE).toBe('fixture-passphrase-not-real');
  });

  it('omits the passphrase variable when the key is unencrypted', () => {
    const env = buildNetworkEnvVars(
      { enabled: false, clientCertPath: '/a/cert.pem', clientKeyPath: '/a/key.pem' },
      { processEnv: EMPTY_ENV },
    );

    expect(env.CLAUDE_CODE_CLIENT_CERT).toBe('/a/cert.pem');
    expect(env.CLAUDE_CODE_CLIENT_KEY).toBe('/a/key.pem');
    expect('CLAUDE_CODE_CLIENT_KEY_PASSPHRASE' in env).toBe(false);
  });

  it('projects no half-identity when only one of cert/key is configured', () => {
    // The misconfiguration is reported by the main-process apply path; a
    // half-projected identity would give subprocesses a DIFFERENT (broken)
    // trust chain than the main process.
    const env = buildNetworkEnvVars(
      { enabled: false, clientCertPath: '/a/cert.pem', clientKeyPassphrase: 'fixture-passphrase-not-real' },
      { processEnv: EMPTY_ENV },
    );

    expect(env).toEqual({});
  });

  it('withholds the client identity (but not the CA) from plugin-scoped projections', () => {
    const env = buildNetworkEnvVars(
      {
        enabled: true,
        httpsProxy: 'https://proxy.corp.example:8080',
        tlsCaPath: '/etc/nessy/corp-ca.pem',
        clientCertPath: '/a/cert.pem',
        clientKeyPath: '/a/key.pem',
        clientKeyPassphrase: 'fixture-passphrase-not-real',
      },
      { processEnv: EMPTY_ENV, excludeClientIdentity: true },
    );

    expect(env.HTTPS_PROXY).toBe('https://proxy.corp.example:8080');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/nessy/corp-ca.pem');
    expect(env.CLAUDE_CODE_CLIENT_CERT).toBeUndefined();
    expect(env.CLAUDE_CODE_CLIENT_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_CLIENT_KEY_PASSPHRASE).toBeUndefined();
  });
});

describe('the managed tier owns the extra CA (server-managed-settings.md#settings-precedence)', () => {
  const MANAGED = '/managed/org-ca.pem';
  const USER = '/tmp/user-ca.pem';
  const managedOrigin = (name: string) => name === 'NODE_EXTRA_CA_CERTS';

  it('a managed NODE_EXTRA_CA_CERTS beats a user tlsCaPath', () => {
    // The measured inversion: `tls-ca-path.ts` tagged user config `custom` and
    // nothing could tell a managed NODE_EXTRA_CA_CERTS from an operator export,
    // so an admin's org CA lost to a user file. That section — "No other
    // settings level can override them, including command line arguments,
    // apart from the exceptions to managed settings precedence."
    const env = buildNetworkEnvVars(
      { enabled: false, tlsCaPath: USER },
      { processEnv: { NODE_EXTRA_CA_CERTS: MANAGED }, managedEnvOrigin: managedOrigin },
    );
    expect(env.NODE_EXTRA_CA_CERTS).toBe(MANAGED);
  });

  it('an OPERATOR NODE_EXTRA_CA_CERTS still loses to a user tlsCaPath', () => {
    // The pre-existing ladder is unchanged below the new top tier: only a
    // MANAGED origin outranks user config, and an unmarked shell export is not
    // one. Without this the fix would have been a blunt "the variable wins".
    const env = buildNetworkEnvVars(
      { enabled: false, tlsCaPath: USER },
      { processEnv: { NODE_EXTRA_CA_CERTS: '/operator/ca.pem' }, managedEnvOrigin: () => false },
    );
    expect(env.NODE_EXTRA_CA_CERTS).toBe(USER);
  });

  it('a managed CA also wins over the bundled app resource', () => {
    const env = buildNetworkEnvVars(
      { enabled: false },
      {
        processEnv: { NODE_EXTRA_CA_CERTS: MANAGED },
        bundledCaPath: '/app/resources/certs/tinkoff-bundle.crt',
        managedEnvOrigin: managedOrigin,
      },
    );
    expect(env.NODE_EXTRA_CA_CERTS).toBe(MANAGED);
  });
});

describe('the managed-origin registry', () => {
  it('records what a managed env block put in this process, by name only', () => {
    clearManagedOriginEnvVars();
    expect(isManagedOriginEnvVar('NODE_EXTRA_CA_CERTS')).toBe(false);

    // A projection into someone else's environment is NOT this process's
    // managed state and must not claim managed origin.
    const foreign: Record<string, string | undefined> = {};
    applyManagedEnv({ NODE_EXTRA_CA_CERTS: '/managed/org-ca.pem' }, {
      source: 'managed-file', confirmed: true, target: foreign,
    });
    expect(isManagedOriginEnvVar('NODE_EXTRA_CA_CERTS')).toBe(false);

    const previous = process.env.NODE_EXTRA_CA_CERTS;
    try {
      applyManagedEnv({ NODE_EXTRA_CA_CERTS: '/managed/org-ca.pem' }, {
        source: 'managed-file', confirmed: true,
      });
      expect(isManagedOriginEnvVar('NODE_EXTRA_CA_CERTS')).toBe(true);
      expect(managedOriginEnvVars()).toEqual(['NODE_EXTRA_CA_CERTS']);
    } finally {
      if (previous === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
      else process.env.NODE_EXTRA_CA_CERTS = previous;
      clearManagedOriginEnvVars();
    }
  });

  it('a WITHHELD managed variable claims no origin until the fetch confirms', () => {
    // :161 — the transport category is withheld from an unconfirmed cache. A
    // variable that was not applied must not be able to outrank user config.
    clearManagedOriginEnvVars();
    const target: Record<string, string | undefined> = {};
    applyManagedEnv({ NODE_EXTRA_CA_CERTS: '/managed/org-ca.pem' }, {
      source: 'server-cache', confirmed: false, target,
    });
    expect(target.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(isManagedOriginEnvVar('NODE_EXTRA_CA_CERTS')).toBe(false);
  });
});
