/**
 * Tests for the CA trust-store composition (network-config.md:56-76).
 *
 * The contract: Claude-style runtimes trust both the bundled Mozilla CA set
 * and the operating system certificate store by default. The source list
 * accepts `bundled` and `system`; the default is `bundled,system`. Reading the
 * OS store requires a runtime with `tls.getCACertificates`; where the runtime
 * lacks it, the composition degrades to the bundled set with a REPORTED
 * warning rather than throwing.
 */
import { describe, expect, it } from 'bun:test';
import { rootCertificates } from 'node:tls';
import {
  buildUndiciDispatcherConfig,
  composeCaTrust,
  parseCertStoreSources,
} from '../network-proxy-utils.ts';

/** Deterministic fake for tls.getCACertificates. */
function fakeGetCACertificates(type: string): string[] {
  if (type === 'bundled') return ['MOZILLA-ROOT-1', 'MOZILLA-ROOT-2'];
  if (type === 'system') return ['OS-ROOT-1'];
  if (type === 'extra') return [];
  throw new Error(`unexpected type ${type}`);
}

describe('parseCertStoreSources', () => {
  it('defaults to bundled,system when unset or blank', () => {
    expect(parseCertStoreSources(undefined)).toEqual({ sources: ['bundled', 'system'], invalid: [] });
    expect(parseCertStoreSources('')).toEqual({ sources: ['bundled', 'system'], invalid: [] });
    expect(parseCertStoreSources('  ')).toEqual({ sources: ['bundled', 'system'], invalid: [] });
  });

  it('parses explicit single-source lists', () => {
    expect(parseCertStoreSources('bundled')).toEqual({ sources: ['bundled'], invalid: [] });
    expect(parseCertStoreSources('system')).toEqual({ sources: ['system'], invalid: [] });
  });

  it('parses the two-source list in any order, trimming and deduplicating', () => {
    expect(parseCertStoreSources('system, bundled')).toEqual({ sources: ['system', 'bundled'], invalid: [] });
    expect(parseCertStoreSources('bundled,bundled,system')).toEqual({ sources: ['bundled', 'system'], invalid: [] });
  });

  it('reports unknown tokens and keeps the valid subset', () => {
    expect(parseCertStoreSources('bundled,keychain')).toEqual({ sources: ['bundled'], invalid: ['keychain'] });
  });

  it('falls back to the default when nothing valid remains', () => {
    expect(parseCertStoreSources('nonsense')).toEqual({ sources: ['bundled', 'system'], invalid: ['nonsense'] });
  });
});

describe('composeCaTrust', () => {
  it('composes bundled + OS store by default', () => {
    const result = composeCaTrust({
      sources: ['bundled', 'system'],
      getCACertificates: fakeGetCACertificates,
    });

    expect(result.ca).toEqual(['MOZILLA-ROOT-1', 'MOZILLA-ROOT-2', 'OS-ROOT-1']);
    expect(result.warnings).toEqual([]);
  });

  it('bundled-only with no extra CA leaves the runtime default trust untouched', () => {
    // `ca: undefined` means "do not pass an explicit ca to undici/tls", which
    // preserves Node's own default behavior: the bundled Mozilla set plus any
    // NODE_EXTRA_CA_CERTS the process was launched with. Passing an explicit
    // bundled-only list here would silently DROP a shell-provided extra CA.
    const result = composeCaTrust({
      sources: ['bundled'],
      getCACertificates: fakeGetCACertificates,
    });

    expect(result.ca).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('system-only produces the OS set plus the configured extra CA', () => {
    const result = composeCaTrust({
      sources: ['system'],
      extraCa: 'CORPORATE-CA',
      getCACertificates: fakeGetCACertificates,
    });

    expect(result.ca).toEqual(['OS-ROOT-1', 'CORPORATE-CA']);
    expect(result.warnings).toEqual([]);
  });

  it('appends the extra CA last after bundled + system', () => {
    const result = composeCaTrust({
      sources: ['bundled', 'system'],
      extraCa: 'CORPORATE-CA',
      getCACertificates: fakeGetCACertificates,
    });

    expect(result.ca).toEqual(['MOZILLA-ROOT-1', 'MOZILLA-ROOT-2', 'OS-ROOT-1', 'CORPORATE-CA']);
  });

  it('preserves NODE_EXTRA_CA_CERTS-provided certs when composing explicitly', () => {
    const withExtra = (type: string): string[] =>
      type === 'extra' ? ['ENV-EXTRA-CA'] : fakeGetCACertificates(type);

    const result = composeCaTrust({
      sources: ['bundled', 'system'],
      extraCa: 'CORPORATE-CA',
      getCACertificates: withExtra,
    });

    expect(result.ca).toEqual([
      'MOZILLA-ROOT-1',
      'MOZILLA-ROOT-2',
      'OS-ROOT-1',
      'ENV-EXTRA-CA',
      'CORPORATE-CA',
    ]);
  });

  it('degrades with a reported warning when the runtime lacks tls.getCACertificates', () => {
    const result = composeCaTrust({
      sources: ['bundled', 'system'],
      extraCa: 'CORPORATE-CA',
      getCACertificates: undefined,
    });

    // Degraded runtime: today's behavior exactly — Mozilla roots + extra CA.
    expect(result.ca).toEqual([...rootCertificates, 'CORPORATE-CA']);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('tls.getCACertificates');
  });

  it('degraded runtime with no extra CA keeps runtime defaults and still warns', () => {
    const result = composeCaTrust({
      sources: ['bundled', 'system'],
      getCACertificates: undefined,
    });

    expect(result.ca).toBeUndefined();
    expect(result.warnings.length).toBe(1);
  });

  it('a throwing system-store read warns and keeps the remaining sources', () => {
    const throwing = (type: string): string[] => {
      if (type === 'system') throw new Error('keychain unavailable');
      return fakeGetCACertificates(type);
    };

    const result = composeCaTrust({
      sources: ['bundled', 'system'],
      extraCa: 'CORPORATE-CA',
      getCACertificates: throwing,
    });

    expect(result.ca).toEqual(['MOZILLA-ROOT-1', 'MOZILLA-ROOT-2', 'CORPORATE-CA']);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('keychain unavailable');
  });
});

describe('buildUndiciDispatcherConfig with a composed CA set', () => {
  it('passes the composed set to direct + proxy TLS options', () => {
    const caSet = ['MOZILLA-ROOT-1', 'OS-ROOT-1', 'CORPORATE-CA'];
    const config = buildUndiciDispatcherConfig(caSet);

    expect(config.directAgentOptions?.connect.ca).toEqual(caSet);
    expect(config.proxyAgentTlsOptions?.requestTls.ca).toEqual(caSet);
    expect(config.proxyAgentTlsOptions?.proxyTls.ca).toEqual(caSet);
  });

  it('omits TLS option fields when the composition wants runtime defaults', () => {
    expect(buildUndiciDispatcherConfig(undefined)).toEqual({});
  });
});
