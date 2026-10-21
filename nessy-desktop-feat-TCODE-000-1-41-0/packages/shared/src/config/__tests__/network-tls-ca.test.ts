import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTlsCaRuntimeForTest } from '../network-tls-ca.ts';

describe('network TLS CA resolver', () => {
  it('uses bundled CA by default when the bundled file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nessy-ca-'));
    const path = join(dir, 'tinkoff-bundle.crt');
    writeFileSync(path, '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n');

    const result = resolveTlsCaRuntimeForTest(undefined, {
      bundledCaPath: path,
    });

    expect(result).toMatchObject({
      ca: '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n',
      source: 'bundled',
      path,
    });
  });

  it('prefers custom CA path over bundled CA', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nessy-ca-'));
    const bundled = join(dir, 'bundled.crt');
    const custom = join(dir, 'custom.crt');
    writeFileSync(bundled, 'bundled');
    writeFileSync(custom, 'custom');

    const result = resolveTlsCaRuntimeForTest(
      { enabled: false, tlsCaPath: custom },
      { bundledCaPath: bundled },
    );

    expect(result).toMatchObject({ ca: 'custom', source: 'custom', path: custom });
  });

  it('allows disabling the bundled CA', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nessy-ca-'));
    const bundled = join(dir, 'tinkoff-bundle.crt');
    writeFileSync(bundled, 'bundled');

    const result = resolveTlsCaRuntimeForTest(
      { enabled: false, useBundledCa: false },
      { bundledCaPath: bundled },
    );

    expect(result).toEqual({ source: 'none' });
  });

  it('does not crash when configured CA file is missing', () => {
    const result = resolveTlsCaRuntimeForTest(
      { enabled: false, tlsCaPath: '/missing/corporate-ca.pem' },
      { bundledCaPath: undefined },
    );

    expect(result.source).toBe('none');
    expect(result.warning).toContain('/missing/corporate-ca.pem');
  });
});
