/**
 * SOCKS refusal (network-config.md:37: "Claude Code does not support SOCKS
 * proxies"). A SOCKS URL is refused with a clear message — never silently
 * ignored, and never echoed back (a proxy URL may carry credentials).
 */
import { describe, expect, it } from 'bun:test';
import { findRefusedProxyUrl } from '../proxy-url-validation.ts';
import { buildNetworkEnvVars } from '../proxy-env.ts';

describe('findRefusedProxyUrl', () => {
  it('accepts http and https proxy URLs and empty settings', () => {
    expect(findRefusedProxyUrl(undefined)).toBeUndefined();
    expect(findRefusedProxyUrl({})).toBeUndefined();
    expect(findRefusedProxyUrl({ httpProxy: 'http://proxy.example:3128' })).toBeUndefined();
    expect(findRefusedProxyUrl({ httpsProxy: 'https://proxy.example:3128' })).toBeUndefined();
  });

  it('refuses every SOCKS scheme variant with a clear, field-naming message', () => {
    for (const scheme of ['socks', 'socks4', 'socks4a', 'socks5', 'socks5h']) {
      const refused = findRefusedProxyUrl({ httpsProxy: `${scheme}://proxy.example:1080` });
      expect(refused).toBeDefined();
      expect(refused?.field).toBe('httpsProxy');
      expect(refused?.scheme).toBe(scheme);
      expect(refused?.message).toContain('SOCKS proxies are not supported');
      expect(refused?.message).toContain('httpsProxy');
    }
  });

  it('reports the httpProxy field independently', () => {
    const refused = findRefusedProxyUrl({
      httpProxy: 'socks5://proxy.example:1080',
      httpsProxy: 'https://proxy.example:3128',
    });
    expect(refused?.field).toBe('httpProxy');
  });

  it('never echoes the proxy URL (which may carry credentials) in the message', () => {
    // Fixture-only placeholder credentials — never real ones.
    const refused = findRefusedProxyUrl({
      httpsProxy: 'socks5://fixture-user:fixture-secret@proxy.example:1080',
    });
    expect(refused?.message).not.toContain('fixture-secret');
    expect(refused?.message).not.toContain('fixture-user');
    expect(refused?.message).not.toContain('proxy.example');
  });
});

describe('buildNetworkEnvVars under a refused proxy URL', () => {
  it('does not project a SOCKS proxy the main process refused to use', () => {
    const env = buildNetworkEnvVars(
      { enabled: true, httpsProxy: 'socks5://proxy.example:1080', noProxy: 'localhost' },
      { processEnv: {} },
    );

    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBeUndefined();
  });
});
