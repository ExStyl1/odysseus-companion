/**
 * P2.251 — the loopback NO_PROXY exemption on the Claude subprocess env.
 *
 * `buildClaudeSubprocessEnv` hands the child a proxy (projected from Settings
 * AND inherited from the host shell) while `envOverrides` points
 * `ANTHROPIC_BASE_URL` at `http://127.0.0.1:<port>` — the per-session gateway
 * adapter. Measured against the real native binary behind a loopback sink proxy
 * (four arms, 2026-08-27): without an exemption the turn FAILS and the adapter
 * receives nothing, because the child POSTs its own loopback URL at the proxy.
 *
 * The three properties that make this an exemption rather than an opt-out, and
 * that a naive implementation gets wrong, are what these cases pin:
 *   - it fires ONLY when a proxy is actually set (no proxy → env untouched);
 *   - it EXTENDS an existing NO_PROXY instead of replacing it;
 *   - it writes BOTH documented spellings, because third-party parsers read one
 *     or the other.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { buildClaudeSubprocessEnv } from '../options.ts';
import { applyLoopbackProxyExemption } from '../../config/proxy-env.ts';

const TOUCHED = [
  'HTTP_PROXY', 'http_proxy',
  'HTTPS_PROXY', 'https_proxy',
  'ALL_PROXY', 'all_proxy',
  'NO_PROXY', 'no_proxy',
] as const;
const saved = new Map<string, string | undefined>();
for (const key of TOUCHED) saved.set(key, process.env[key]);

function clearProxyEnv(): void {
  for (const key of TOUCHED) delete process.env[key];
}

afterEach(() => {
  for (const key of TOUCHED) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const LOOPBACK = ['localhost', '127.0.0.1', '::1', '[::1]'];

describe('P2.251 loopback proxy exemption on the Claude subprocess env', () => {
  it('exempts loopback when the host shell alone carries a proxy', () => {
    clearProxyEnv();
    // The shipped corporate-user default on macOS: `loadShellEnv` copies the
    // login shell in, so this reaches the child with no Settings proxy at all.
    process.env.HTTPS_PROXY = 'http://proxy.corp.invalid:3128';

    const env = buildClaudeSubprocessEnv({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:54321' });

    const entries = (env.NO_PROXY ?? '').split(',');
    for (const host of LOOPBACK) expect(entries).toContain(host);
    // Both spellings, same value — a child that reads only the lowercase one
    // must not see an unexempted proxy.
    expect(env.no_proxy).toBe(env.NO_PROXY);
    // …and it is an EXEMPTION, not an opt-out: the wildcard would also make the
    // measured arm pass while sending every corporate request direct.
    expect(entries).not.toContain('*');
  });

  it('leaves NO_PROXY alone when no proxy is set at all', () => {
    clearProxyEnv();

    const env = buildClaudeSubprocessEnv({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:54321' });

    expect(env.NO_PROXY).toBeUndefined();
    expect(env.no_proxy).toBeUndefined();
  });

  it('fires on ALL_PROXY too — the route the app never sets and a shell often does', () => {
    clearProxyEnv();
    process.env.ALL_PROXY = 'http://proxy.corp.invalid:3128';

    expect((buildClaudeSubprocessEnv().NO_PROXY ?? '').split(',')).toContain('127.0.0.1');
  });

  it('is not fooled by a proxy variable that is present but empty', () => {
    clearProxyEnv();
    process.env.HTTPS_PROXY = '   ';

    expect(buildClaudeSubprocessEnv().NO_PROXY).toBeUndefined();
  });

  it("extends the user's own NO_PROXY instead of replacing it", () => {
    clearProxyEnv();
    process.env.HTTPS_PROXY = 'http://proxy.corp.invalid:3128';
    process.env.NO_PROXY = '.corp.invalid,10.0.0.0/8';

    const entries = (buildClaudeSubprocessEnv().NO_PROXY ?? '').split(',');

    expect(entries.slice(0, 2)).toEqual(['.corp.invalid', '10.0.0.0/8']);
    for (const host of LOOPBACK) expect(entries).toContain(host);
  });

  it('extends a NO_PROXY that arrives through envOverrides, which land last', () => {
    clearProxyEnv();
    process.env.HTTPS_PROXY = 'http://proxy.corp.invalid:3128';

    const env = buildClaudeSubprocessEnv({ NO_PROXY: 'internal.invalid' });

    const entries = (env.NO_PROXY ?? '').split(',');
    expect(entries[0]).toBe('internal.invalid');
    for (const host of LOOPBACK) expect(entries).toContain(host);
  });
});

describe('P2.251 applyLoopbackProxyExemption grammar', () => {
  it('accepts the space-separated NO_PROXY spelling and emits the canonical comma form', () => {
    // network-config.md documents both spellings; a raw pass-through of the
    // space form keeps failing in every third-party parser but our two.
    const env: Record<string, string | undefined> = {
      HTTP_PROXY: 'http://proxy.corp.invalid:3128',
      NO_PROXY: 'a.invalid b.invalid',
    };

    applyLoopbackProxyExemption(env);

    expect(env.NO_PROXY).toBe('a.invalid,b.invalid,localhost,127.0.0.1,::1,[::1]');
  });

  it('never duplicates an entry the user already wrote, in either case', () => {
    const env: Record<string, string | undefined> = {
      HTTP_PROXY: 'http://proxy.corp.invalid:3128',
      NO_PROXY: 'LocalHost,127.0.0.1',
      no_proxy: 'localhost',
    };

    applyLoopbackProxyExemption(env);

    expect(env.NO_PROXY).toBe('LocalHost,127.0.0.1,::1,[::1]');
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });
});
