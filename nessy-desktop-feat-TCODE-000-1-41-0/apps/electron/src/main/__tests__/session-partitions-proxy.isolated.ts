/**
 * `configureElectronProxy` walks the whole partition registry.
 *
 * Isolated because it replaces the shared `electron` mock with a session API
 * that records `setProxy` calls; `mock.module` is process-global in bun, so
 * this cannot share a process with the rest of the main-process suites.
 *
 * The static half of the contract — that no partition exists outside the
 * registry — lives in `session-partitions.test.ts`.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { MANAGED_SESSION_PARTITIONS, UPDATER_SESSION_PARTITION } from '../session-partitions';

type SetProxyCall = { partition: string | null; config: unknown };
const setProxyCalls: SetProxyCall[] = [];
const fromPartitionCalls: Array<{ partition: string; options: unknown }> = [];

function fakeSession(partition: string | null) {
  return {
    setProxy: async (config: unknown) => {
      setProxyCalls.push({ partition, config });
    },
  };
}

mock.module('electron', () => ({
  app: { isReady: () => true },
  session: {
    defaultSession: fakeSession(null),
    fromPartition: (partition: string, options?: unknown) => {
      fromPartitionCalls.push({ partition, options });
      return fakeSession(partition);
    },
  },
}));

describe('configureElectronProxy', () => {
  beforeEach(() => {
    setProxyCalls.length = 0;
    fromPartitionCalls.length = 0;
  });

  it('applies the proxy to every registered partition, not just the default session', async () => {
    const { configureElectronProxy } = await import('../network-proxy');

    await configureElectronProxy({
      enabled: true,
      httpProxy: 'http://proxy.internal:3128',
      httpsProxy: 'http://proxy.internal:3128',
      noProxy: 'localhost',
    });

    expect(setProxyCalls.map(call => call.partition).sort()).toEqual(
      MANAGED_SESSION_PARTITIONS.map(entry => entry.partition).sort(),
    );
    // Same rules everywhere — the updater must not get a weaker config.
    for (const call of setProxyCalls) {
      expect(call.config).toEqual({
        mode: 'fixed_servers',
        proxyRules: 'https=http://proxy.internal:3128;http=http://proxy.internal:3128',
        proxyBypassRules: 'localhost',
      });
    }
    // Creation options are forwarded so we do not out-race the owner.
    expect(fromPartitionCalls).toContainEqual({
      partition: UPDATER_SESSION_PARTITION,
      options: { cache: false },
    });
  });

  it('resets every registered partition to direct when the proxy is disabled', async () => {
    const { configureElectronProxy } = await import('../network-proxy');

    await configureElectronProxy({ enabled: false });

    expect(setProxyCalls.length).toBe(MANAGED_SESSION_PARTITIONS.length);
    for (const call of setProxyCalls) {
      expect(call.config).toEqual({ mode: 'direct' });
    }
  });
});

/**
 * F1.519 item 4 (P-WJai-4, 2026-09-24, carried under F1.359) — the Chromium
 * half (browser pane, update feed, sign-in windows on the default session)
 * followed Settings ONLY and was forced `direct` with Settings off, while the
 * host hop beside it (`HostProxyDispatcher`, F1.498) followed
 * `resolveHostProxySelection`: a managed `env` block's proxy, then Settings,
 * then the environment. So a proxy-only network that names its proxy in the
 * environment reached every model turn and no update download. DECIDED: one
 * selection for both halves. Red at `d5ec9426a` on the environment arm (every
 * partition got `direct`) and the reconcile arm (no such export); the
 * Settings-beat-the-environment arm was the control and passed there.
 */
describe('configureElectronProxy · F1.519 · the Chromium half follows the host hop\'s selection', () => {
  const PROXY_ENV_KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'] as const;
  let ambient: Array<[string, string | undefined]> = [];

  beforeEach(() => {
    setProxyCalls.length = 0;
    fromPartitionCalls.length = 0;
    ambient = PROXY_ENV_KEYS.map(key => [key, process.env[key]]);
    for (const key of PROXY_ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    // Delete before assign: the Bun 1.3.14 slot trap (AGENTS.md).
    for (const [key, value] of ambient) {
      delete process.env[key];
      if (value !== undefined) process.env[key] = value;
    }
  });

  const ENV_PROXY = 'http://env-proxy.f1519.invalid:3128';

  it('Settings off and HTTPS_PROXY in the environment: every partition gets the environment proxy and its NO_PROXY', async () => {
    const { configureElectronProxy } = await import('../network-proxy');
    process.env.HTTPS_PROXY = ENV_PROXY;
    process.env.NO_PROXY = 'internal.corp';

    await configureElectronProxy({ enabled: false });

    expect(setProxyCalls.map(call => call.partition).sort()).toEqual(
      MANAGED_SESSION_PARTITIONS.map(entry => entry.partition).sort(),
    );
    for (const call of setProxyCalls) {
      expect(call.config).toEqual({
        mode: 'fixed_servers',
        proxyRules: `https=${ENV_PROXY};http=${ENV_PROXY}`,
        proxyBypassRules: 'internal.corp',
      });
    }
  });

  it('CONTROL: Settings beat the environment, exactly as on the host hop', async () => {
    const { configureElectronProxy } = await import('../network-proxy');
    process.env.HTTPS_PROXY = ENV_PROXY;

    await configureElectronProxy({ enabled: true, httpsProxy: 'http://proxy.internal:3128' });

    expect(setProxyCalls.length).toBe(MANAGED_SESSION_PARTITIONS.length);
    for (const call of setProxyCalls) {
      expect(call.config).toEqual({ mode: 'fixed_servers', proxyRules: 'https=http://proxy.internal:3128' });
    }
  });

  it('a proxy that reaches the environment AFTER the apply reconfigures the Chromium half once, when the host hop sees it', async () => {
    const network = await import('../network-proxy');
    await network.configureElectronProxy({ enabled: false });
    expect(setProxyCalls.map(call => call.config)).toEqual(MANAGED_SESSION_PARTITIONS.map(() => ({ mode: 'direct' })));

    // What a managed env block written by bootstrapServer looks like from here.
    process.env.HTTPS_PROXY = ENV_PROXY;
    setProxyCalls.length = 0;
    await network.reconcileChromiumProxy({ enabled: false });
    expect(setProxyCalls.length).toBe(MANAGED_SESSION_PARTITIONS.length);
    for (const call of setProxyCalls) {
      expect(call.config).toEqual({ mode: 'fixed_servers', proxyRules: `https=${ENV_PROXY};http=${ENV_PROXY}` });
    }

    // Unchanged selection: nothing more is written.
    setProxyCalls.length = 0;
    await network.reconcileChromiumProxy({ enabled: false });
    expect(setProxyCalls).toEqual([]);
  });

  it('CONTROL: a SOCKS proxy the host hop refuses sends the Chromium half direct too', async () => {
    const { configureElectronProxy } = await import('../network-proxy');
    process.env.HTTPS_PROXY = 'socks5://socks.f1519.invalid:1080';

    await configureElectronProxy({ enabled: false });

    for (const call of setProxyCalls) expect(call.config).toEqual({ mode: 'direct' });
  });
});
