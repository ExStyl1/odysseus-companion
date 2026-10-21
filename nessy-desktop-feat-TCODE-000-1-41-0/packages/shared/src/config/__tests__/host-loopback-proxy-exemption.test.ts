/**
 * P2.263 — the HOST's own loopback requests must not go through the operator's
 * proxy, and P2.261 — the projection that carries that rule has to be VISIBLE
 * to an env spread.
 *
 * ## What was measured, and why there are two mechanisms
 *
 * With a Settings proxy enabled and no `noProxy`, the host's own fetch of
 * `http://localhost:<port>/v1/models` — the local-model card's model list —
 * landed on the proxy and the local server got zero hits. Two paths carried that request:
 * `shouldBypassProxy`, and the env while it was a plain assignment; BOTH had to be fixed:
 *
 *  - `shouldBypassProxy`, consulted by the Bun `fetch` wrapper
 *    (`proxyForUrl`) and by the Electron undici dispatcher. Its
 *    `rules.length === 0 → false` was the whole cause on that path.
 *  - `projectProxyEnv`, which writes the proxy into this process's own
 *    `process.env` for the children spawned afterwards — Bun's own `fetch` does
 *    not see that delete-then-assign write (F1.1155) — and they never call the function above.
 *
 * ## Why one case runs in a CHILD PROCESS
 *
 * P2.261, measured on Bun 1.3.14: a RUNTIME assignment to a proxy env var is
 * readable by property access but absent from `Object.keys(process.env)` and
 * from `{...process.env}` — which is how every subprocess env in this repo is
 * built. `delete` before assigning restores normal visibility, AND the unlock
 * is sticky: once a name has been deleted, every later assignment to it is
 * visible for the rest of the process.
 *
 * That stickiness is exactly why the visibility case cannot run in this
 * process. This suite's own setup deletes the six proxy names, and the repo's
 * test preload and neighbouring suites may have too — so an in-process
 * assertion would pass with the fix REMOVED and prove nothing. A throwaway Bun
 * child, whose proxy names have never been deleted, is the only rig on which
 * the assertion is a detector.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyProcessNetworkTrustChain, __resetProcessNetworkTrustChainForTest, type NetworkTrustLogger } from '../network-runtime.ts';
import { parseNoProxyRules, shouldBypassProxy } from '../network-proxy-utils.ts';

type Recorded = { init: (RequestInit & { proxy?: string }) | undefined };

const originalFetch = globalThis.fetch;
let recorded: Recorded[] = [];
let tempDir: string;

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'] as const;
let ambientProxyEnv: Array<[string, string | undefined]> = [];

const silentLogger: NetworkTrustLogger = { info: () => {}, warn: () => {}, error: () => {} };

const PROXY_ONLY = { enabled: true, httpsProxy: 'http://proxy.internal:3128', httpProxy: 'http://proxy.internal:3128' } as const;

beforeEach(() => {
  recorded = [];
  tempDir = mkdtempSync(join(tmpdir(), 'nessy-loopback-'));
  ambientProxyEnv = PROXY_ENV_KEYS.map(key => [key, process.env[key]]);
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  __resetProcessNetworkTrustChainForTest();
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    recorded.push({ init });
    return Promise.resolve(new Response('ok'));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetProcessNetworkTrustChainForTest();
  for (const [key, value] of ambientProxyEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe('the fetch wrapper', () => {
  it('sends the local-model card\'s own model list DIRECT, with no noProxy configured', async () => {
    applyProcessNetworkTrustChain({ settings: { ...PROXY_ONLY }, log: silentLogger });
    await fetch('http://localhost:11434/v1/models');
    expect(recorded[0]!.init?.proxy).toBeUndefined();
  });

  it('still proxies everything else — this is an exemption, not a no_proxy=*', async () => {
    applyProcessNetworkTrustChain({ settings: { ...PROXY_ONLY }, log: silentLogger });
    await fetch('https://models.example.com/v1/models');
    expect(recorded[0]!.init?.proxy).toBe('http://proxy.internal:3128');
  });

  it('covers every loopback spelling a local server is reachable at', async () => {
    applyProcessNetworkTrustChain({ settings: { ...PROXY_ONLY }, log: silentLogger });
    for (const url of ['http://127.0.0.1:9100/health', 'http://[::1]:9100/health', 'http://app.localhost:9100/']) {
      await fetch(url);
    }
    expect(recorded.map(entry => entry.init?.proxy)).toEqual([undefined, undefined, undefined]);
  });

  it('exempts loopback even when the operator wrote an explicit list that omits it', async () => {
    applyProcessNetworkTrustChain({
      settings: { ...PROXY_ONLY, noProxy: 'internal.corp' },
      log: silentLogger,
    });
    await fetch('http://127.0.0.1:9100/health');
    await fetch('https://git.internal.corp/repo');
    await fetch('https://models.example.com/');
    expect(recorded.map(entry => entry.init?.proxy))
      .toEqual([undefined, undefined, 'http://proxy.internal:3128']);
  });
});

describe('shouldBypassProxy', () => {
  it('bypasses loopback with NO rules at all — the `rules.length === 0` hole', () => {
    expect(shouldBypassProxy('http://localhost:11434/v1/models', [])).toBe(true);
    expect(shouldBypassProxy('http://127.0.0.1:9100/', [])).toBe(true);
    expect(shouldBypassProxy('http://[::1]:9100/', [])).toBe(true);
  });

  it('leaves the no-rules answer for a remote host exactly where it was', () => {
    expect(shouldBypassProxy('https://example.com', [])).toBe(false);
    expect(shouldBypassProxy('https://127.0.0.1.example.com/', [])).toBe(false);
  });

  it('does not throw on a malformed URL when there are no rules, as before', () => {
    expect(shouldBypassProxy('not a url', [])).toBe(false);
  });

  it('C3.357 — the app\'s OWN gateway host is NOT exempt, and the operator keeps the decision', () => {
    // R2's rig wedged when a refusing proxy denied the app's own hosts, and the
    // row born from it asked for them to join the loopback exemption. Refused:
    // loopback qualifies because the ADDRESS means "the proxy's own machine",
    // and an ordinary remote host has no such property. Exempting it would make
    // the app unreachable on every network whose proxy is the only route to it.
    //
    // This case is the guard on that posture. It is written against the host
    // spelling rather than a constant on purpose: there is no "our own hosts"
    // list in this module, and the whole point is that none should appear here.
    expect(shouldBypassProxy('https://code-completion-nestor.tcsbank.ru/api/v1/cli/models', [])).toBe(false);

    // …and the control that makes the refusal a policy rather than an omission:
    // an operator who DOES want it bypassed already has the mechanism.
    const rules = parseNoProxyRules('code-completion-nestor.tcsbank.ru');
    expect(shouldBypassProxy('https://code-completion-nestor.tcsbank.ru/api/v1/cli/models', rules)).toBe(true);
  });

  it('still honours a port-scoped rule for a non-loopback host', () => {
    const rules = parseNoProxyRules('example.com:8080');
    expect(shouldBypassProxy('http://example.com:8080/', rules)).toBe(true);
    expect(shouldBypassProxy('http://example.com:9090/', rules)).toBe(false);
  });
});

describe('the process.env projection', () => {
  it('writes the loopback exemption in BOTH spellings, since Bun reads no_proxy first', () => {
    // `[::1]` is the entry Bun's own native fetch — the reader of THIS
    // projection — actually honours; the bare `::1` beside it is for the
    // IP-parsing family (P2.471). See LOOPBACK_NO_PROXY_HOSTS.
    applyProcessNetworkTrustChain({ settings: { ...PROXY_ONLY }, log: silentLogger });
    expect(process.env.NO_PROXY).toBe('localhost,127.0.0.1,::1,[::1]');
    expect(process.env.no_proxy).toBe('localhost,127.0.0.1,::1,[::1]');
  });

  it('EXTENDS the operator\'s own value instead of replacing it', () => {
    process.env.no_proxy = 'internal.corp';
    applyProcessNetworkTrustChain({
      settings: { ...PROXY_ONLY, noProxy: 'registry.example.com' },
      log: silentLogger,
    });
    expect(process.env.NO_PROXY).toBe('internal.corp,registry.example.com,localhost,127.0.0.1,::1,[::1]');
    expect(process.env.no_proxy).toBe('internal.corp,registry.example.com,localhost,127.0.0.1,::1,[::1]');
  });

  it('does not duplicate a loopback host the operator already listed', () => {
    applyProcessNetworkTrustChain({
      settings: { ...PROXY_ONLY, noProxy: '127.0.0.1 localhost' },
      log: silentLogger,
    });
    expect(process.env.NO_PROXY).toBe('127.0.0.1,localhost,::1,[::1]');
  });

  it('restores the operator\'s value on disable rather than leaving ours behind', () => {
    process.env.NO_PROXY = 'internal.corp';
    applyProcessNetworkTrustChain({ settings: { ...PROXY_ONLY }, log: silentLogger });
    expect(process.env.NO_PROXY).toBe('internal.corp,localhost,127.0.0.1,::1,[::1]');
    applyProcessNetworkTrustChain({ settings: { enabled: false }, log: silentLogger });
    expect(process.env.NO_PROXY).toBe('internal.corp');
  });
});

/**
 * The child-process arm. See this file's header for why it cannot run inline.
 */
describe('P2.261 — what a subprocess env spread actually receives', () => {
  it('carries the projected proxy AND the loopback exemption into `{...process.env}`', () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, resolve(import.meta.dir, 'fixtures', 'proxy-env-spread-probe.ts')],
      // A plain env object built WITHOUT the six proxy names, so the child's
      // proxy slots have never been written or deleted before the projection
      // runs — the condition the assertion depends on.
      env: childEnvWithoutProxyNames(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = result.stdout.toString().trim();
    // Never let a child that failed to start read as a silent pass.
    if (stdout === '') throw new Error(`probe produced no output; stderr: ${result.stderr.toString()}`);

    const report = JSON.parse(stdout.split('\n').at(-1)!) as Record<string, unknown>;
    expect(report.read).toBe('http://proxy.internal:3128');
    expect(report.httpsInSpread).toBe(true);
    expect(report.noProxyInSpread).toBe(true);
    expect(report.noProxyLowerInSpread).toBe(true);
    expect(report.noProxy).toBe('localhost,127.0.0.1,::1,[::1]');
    // Generous, and it costs nothing on an idle machine — the child completes in
    // about a second. It is here because a spawn is the one thing in this suite
    // whose latency is set by the HOST rather than by the code under test:
    // measured timing out at bun's default while nine sibling processes were
    // building, and again at 30s under the same load.
  }, 120_000);
});

function childEnvWithoutProxyNames(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if ((PROXY_ENV_KEYS as readonly string[]).includes(key)) continue;
    env[key] = value;
  }
  return env;
}
