/**
 * Tests for mTLS client certificate resolution (network-config.md:86-101).
 *
 * Contract points pinned here:
 * - cert + key (+ optional passphrase) are applied to the same undici
 *   dispatcher TLS options the proxy and CA already use;
 * - the files are RE-READ every time settings are applied, so replacing the
 *   files at the same paths rotates the credential without a restart;
 * - a missing or unreadable cert/key is a REPORTED, actionable error — never
 *   a silent fall-through to an unauthenticated connection;
 * - no error message ever contains key bytes or the passphrase.
 *
 * All fixture content is deliberately fake placeholder text — never real key
 * material or a real passphrase.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveClientIdentityRuntime } from '../network-mtls.ts';
import { buildUndiciDispatcherConfig } from '../network-proxy-utils.ts';

const FAKE_PASSPHRASE = 'fixture-passphrase-not-real';

function writeIdentityFiles(cert: string, key: string): { certPath: string; keyPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'nessy-mtls-'));
  const certPath = join(dir, 'client-cert.pem');
  const keyPath = join(dir, 'client-key.pem');
  writeFileSync(certPath, cert);
  writeFileSync(keyPath, key);
  return { certPath, keyPath };
}

describe('resolveClientIdentityRuntime', () => {
  it('returns no identity and no error when mTLS is not configured', () => {
    expect(resolveClientIdentityRuntime(undefined)).toEqual({});
    expect(resolveClientIdentityRuntime({ enabled: false })).toEqual({});
  });

  it('loads cert, key and passphrase when both files are readable', () => {
    const { certPath, keyPath } = writeIdentityFiles('TEST-CERT-V1', 'TEST-KEY-V1');

    const result = resolveClientIdentityRuntime({
      enabled: false,
      clientCertPath: certPath,
      clientKeyPath: keyPath,
      clientKeyPassphrase: FAKE_PASSPHRASE,
    });

    expect(result.error).toBeUndefined();
    expect(result.identity).toEqual({
      cert: 'TEST-CERT-V1',
      key: 'TEST-KEY-V1',
      passphrase: FAKE_PASSPHRASE,
    });
  });

  it('re-reads the files on every resolution so replacing them rotates without a restart', () => {
    const { certPath, keyPath } = writeIdentityFiles('TEST-CERT-V1', 'TEST-KEY-V1');
    const settings = { enabled: false, clientCertPath: certPath, clientKeyPath: keyPath };

    const first = resolveClientIdentityRuntime(settings);
    expect(first.identity?.cert).toBe('TEST-CERT-V1');

    // Rotate by replacing the files at the same paths (network-config.md:101).
    writeFileSync(certPath, 'TEST-CERT-V2');
    writeFileSync(keyPath, 'TEST-KEY-V2');

    const second = resolveClientIdentityRuntime(settings);
    expect(second.identity?.cert).toBe('TEST-CERT-V2');
    expect(second.identity?.key).toBe('TEST-KEY-V2');
  });

  it('a missing key file is a reported error and never a silent unauthenticated identity', () => {
    const { certPath, keyPath } = writeIdentityFiles('TEST-CERT-V1', 'TEST-KEY-V1');
    const missingKeyPath = join(keyPath + '.rotated-away');

    const result = resolveClientIdentityRuntime({
      enabled: false,
      clientCertPath: certPath,
      clientKeyPath: missingKeyPath,
      clientKeyPassphrase: FAKE_PASSPHRASE,
    });

    expect(result.identity).toBeUndefined();
    expect(result.error).toBeDefined();
    expect(result.error).toContain(missingKeyPath);
    // Redaction: the error must never carry the passphrase or file contents.
    expect(result.error).not.toContain(FAKE_PASSPHRASE);
    expect(result.error).not.toContain('TEST-CERT-V1');
  });

  it('a cert path without a key path (and vice versa) is a reported configuration error', () => {
    const { certPath, keyPath } = writeIdentityFiles('TEST-CERT-V1', 'TEST-KEY-V1');

    const certOnly = resolveClientIdentityRuntime({ enabled: false, clientCertPath: certPath });
    expect(certOnly.identity).toBeUndefined();
    expect(certOnly.error).toContain('clientKeyPath');

    const keyOnly = resolveClientIdentityRuntime({ enabled: false, clientKeyPath: keyPath });
    expect(keyOnly.identity).toBeUndefined();
    expect(keyOnly.error).toContain('clientCertPath');
  });
});

describe('buildUndiciDispatcherConfig with a client identity', () => {
  const identity = { cert: 'TEST-CERT-V1', key: 'TEST-KEY-V1', passphrase: FAKE_PASSPHRASE };

  it('applies cert, key and passphrase to direct + proxy TLS options alongside the CA set', () => {
    const caSet = ['MOZILLA-ROOT-1', 'CORPORATE-CA'];
    const config = buildUndiciDispatcherConfig(caSet, identity);

    for (const tlsOptions of [
      config.directAgentOptions?.connect,
      config.proxyAgentTlsOptions?.requestTls,
      config.proxyAgentTlsOptions?.proxyTls,
    ]) {
      expect(tlsOptions?.ca).toEqual(caSet);
      expect(tlsOptions?.cert).toBe('TEST-CERT-V1');
      expect(tlsOptions?.key).toBe('TEST-KEY-V1');
      expect(tlsOptions?.passphrase).toBe(FAKE_PASSPHRASE);
    }
  });

  it('applies the identity without an explicit CA set, leaving default trust untouched', () => {
    const config = buildUndiciDispatcherConfig(undefined, identity);

    expect(config.directAgentOptions?.connect.ca).toBeUndefined();
    expect(config.directAgentOptions?.connect.cert).toBe('TEST-CERT-V1');
    expect(config.proxyAgentTlsOptions?.requestTls.key).toBe('TEST-KEY-V1');
  });

  it('omits the passphrase field when the key is unencrypted', () => {
    const config = buildUndiciDispatcherConfig(undefined, { cert: 'TEST-CERT-V1', key: 'TEST-KEY-V1' });

    expect(config.directAgentOptions?.connect.passphrase).toBeUndefined();
    expect(config.directAgentOptions?.connect.cert).toBe('TEST-CERT-V1');
  });

  it('still returns an empty config when neither CA nor identity is present', () => {
    expect(buildUndiciDispatcherConfig(undefined, undefined)).toEqual({});
  });
});
