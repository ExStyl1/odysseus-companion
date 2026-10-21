/**
 * F1.525 (origin WJ-ao P-WJao-1, 2026-09-24, carried under F1.359) — a headless
 * server started WITHOUT `bin/nessy-server` (the in-repo `bun run
 * packages/server/src/index.ts`, `server:start` / `server:dev`) with a proxy in
 * its launch environment sends its OWN loopback requests to that proxy: Bun
 * 1.3.14 reads `HTTP(S)_PROXY` / `NO_PROXY` at launch only and has no
 * per-request way to go direct, so only a launcher can exempt loopback — which
 * is what `bin/nessy-server`'s `launcherLoopbackNoProxyFragment()` does (F1.518),
 * and the Docker and systemd starts go through it.
 *
 * DECIDED under the TRANSPARENT and SIMPLE rule: the dev entry is NOT given a
 * launcher (it would mean a self-re-exec with signal forwarding, or a shell
 * wrapper in every root script that starts the server); instead the server SAYS
 * so, once, at the first trust-chain application — the moment its launch
 * environment is still the one Bun read — naming the proxy variables (never
 * their values) and the loopback hosts `NO_PROXY` lacks, with the two remedies.
 *
 * Failing arm taken at `d5ec9426a`: no notice existed (the helper arm fails as
 * "not a function", the application arm logged no warning).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as runtime from '../network-runtime.ts';
import { LOOPBACK_NO_PROXY_HOSTS } from '../network-proxy-utils.ts';

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'] as const;
const LAUNCHER_NO_PROXY = LOOPBACK_NO_PROXY_HOSTS.join(',');
const PROXY = 'http://user:secret@proxy.f1525.invalid:3128';

describe('F1.525 — launchLoopbackProxyNotice (the launch environment, as a table)', () => {
  const notice = (env: Record<string, string>) => runtime.launchLoopbackProxyNotice(env);

  it('HTTP_PROXY with no NO_PROXY: a notice naming the variable and every loopback host, never the value', () => {
    const text = notice({ HTTP_PROXY: PROXY }) ?? '';
    expect(text).toContain('HTTP_PROXY');
    for (const host of LOOPBACK_NO_PROXY_HOSTS) expect(text).toContain(host);
    expect(text).toContain('bin/nessy-server');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('proxy.f1525.invalid');
  });

  it('a lower-case proxy name and an HTTPS-only launch count too — the launcher writes NO_PROXY for any of them', () => {
    expect(notice({ http_proxy: PROXY })).toContain('http_proxy');
    expect(notice({ HTTPS_PROXY: PROXY })).toContain('HTTPS_PROXY');
  });

  it('an operator NO_PROXY that lacks some loopback hosts names only the missing ones, from either spelling', () => {
    const text = notice({ HTTP_PROXY: PROXY, NO_PROXY: 'internal.corp localhost', no_proxy: '127.0.0.1' }) ?? '';
    expect(text).toContain('::1');
    expect(text).not.toMatch(/lacks[^.]*\blocalhost\b/);
  });

  it('CONTROL: what bin/nessy-server exports, a wildcard, and no proxy at all give no notice', () => {
    expect(notice({ HTTP_PROXY: PROXY, NO_PROXY: LAUNCHER_NO_PROXY, no_proxy: LAUNCHER_NO_PROXY })).toBeUndefined();
    expect(notice({ HTTP_PROXY: PROXY, no_proxy: `internal.corp,${LAUNCHER_NO_PROXY}` })).toBeUndefined();
    expect(notice({ HTTPS_PROXY: PROXY, NO_PROXY: '*' })).toBeUndefined();
    expect(notice({ NO_PROXY: 'internal.corp' })).toBeUndefined();
    expect(notice({})).toBeUndefined();
  });
});

describe('F1.525 — the first trust-chain application says it, once', () => {
  let ambient: Array<[string, string | undefined]> = [];
  const originalFetch = globalThis.fetch;
  let warnings: string[] = [];
  const log = {
    info: () => {},
    warn: (message: string) => { warnings.push(message); },
    error: () => {},
  };

  beforeEach(() => {
    ambient = PROXY_ENV_KEYS.map(key => [key, process.env[key]]);
    for (const key of PROXY_ENV_KEYS) delete process.env[key];
    runtime.__resetProcessNetworkTrustChainForTest();
    warnings = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    runtime.__resetProcessNetworkTrustChainForTest();
    // Delete before assign: the Bun 1.3.14 slot trap (AGENTS.md) — an assigned
    // proxy name must stay visible to a later suite's spread.
    for (const [key, value] of ambient) {
      delete process.env[key];
      if (value !== undefined) process.env[key] = value;
    }
  });

  it('a launch with HTTP_PROXY and no loopback NO_PROXY warns at the first application and not at the re-apply', () => {
    process.env.HTTP_PROXY = PROXY;
    runtime.applyProcessNetworkTrustChain({ settings: undefined, log });
    runtime.applyProcessNetworkTrustChain({ settings: undefined, log });
    const loopback = warnings.filter(line => line.includes('bin/nessy-server'));
    expect(loopback).toHaveLength(1);
    expect(loopback[0]).not.toContain('secret');
  });

  it('CONTROL: a launch through the launcher (its NO_PROXY exported) warns nothing about loopback', () => {
    process.env.HTTP_PROXY = PROXY;
    process.env.NO_PROXY = LAUNCHER_NO_PROXY;
    runtime.applyProcessNetworkTrustChain({ settings: undefined, log });
    expect(warnings.filter(line => line.includes('bin/nessy-server'))).toEqual([]);
  });
});
