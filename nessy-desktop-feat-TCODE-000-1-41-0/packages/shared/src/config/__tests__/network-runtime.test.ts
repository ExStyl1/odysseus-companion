/**
 * The trust chain a process applies to its OWN outbound calls.
 *
 * This is what the headless `nessy-server` binary gets instead of the Electron
 * main's undici dispatcher: Bun's native fetch ignores `setGlobalDispatcher`,
 * so the proxy, the composed CA and the client identity ride Bun's per-request
 * `proxy` / `tls` fetch options.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import {
  applyProcessNetworkTrustChain,
  watchNetworkTrustChain,
  __resetProcessNetworkTrustChainForTest,
  type NetworkTrustLogger,
} from '../network-runtime.ts';

type Recorded = { input: unknown; init: (RequestInit & { proxy?: string; tls?: unknown }) | undefined };

const originalFetch = globalThis.fetch;
let recorded: Recorded[] = [];
let logLines: string[] = [];
let tempDir: string;

/**
 * This suite asserts what the trust chain WRITES INTO the proxy env keys and
 * what its disable path leaves behind, so it must own them: a corporate runner
 * exports `NO_PROXY=localhost,127.0.0.1,…`, and the disable path faithfully
 * restores that launch-env value exactly where the test expects `undefined`.
 * Snapshotted and cleared per test, restored after the trust chain's own
 * restore has run (order matters: `__resetProcessNetworkTrustChainForTest`
 * re-projects against the cleared baseline first).
 */
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'] as const;
let ambientProxyEnv: Array<[string, string | undefined]> = [];

/**
 * Captured at module load, NOT in beforeEach: the repo-wide `[test]` preload
 * (`unified-network-interceptor.ts`) froze `PROXY_URL` from the ambient env
 * before any test code ran, and its `{ ...init, ...(proxy ? { proxy } : {}) }`
 * spread overrides the per-request `proxy` option with that frozen value. On a
 * host launched with a corporate proxy env the real-runtime case below can
 * therefore never reach its local listener — clearing `process.env` later
 * cannot unfreeze the preload — so it is skipped with that named reason,
 * following the live-gateway / RUN_LIVE_OAUTH_E2E gating precedents.
 */
const proxyEnvFrozenByPreload = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']
  .some(key => !!process.env[key]);

const recordingLogger: NetworkTrustLogger = {
  info: (message, detail) => logLines.push(`${message} ${JSON.stringify(detail ?? null)}`),
  warn: (message, detail) => logLines.push(`${message} ${JSON.stringify(detail ?? null)}`),
  error: (message, detail) => logLines.push(`${message} ${JSON.stringify(detail ?? null)}`),
};

beforeEach(() => {
  recorded = [];
  logLines = [];
  tempDir = mkdtempSync(join(tmpdir(), 'nessy-trust-'));
  ambientProxyEnv = PROXY_ENV_KEYS.map(key => [key, process.env[key]]);
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  __resetProcessNetworkTrustChainForTest();
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    recorded.push({ input, init });
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

function writeIdentity(): { certPath: string; keyPath: string } {
  const certPath = join(tempDir, 'client.crt');
  const keyPath = join(tempDir, 'client.key');
  writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\nclient-v1\n-----END CERTIFICATE-----\n');
  writeFileSync(keyPath, '-----BEGIN PRIVATE KEY-----\nkey-v1\n-----END PRIVATE KEY-----\n');
  return { certPath, keyPath };
}

describe('applyProcessNetworkTrustChain — proxy', () => {
  it('routes this process\'s own requests through the configured proxy, per protocol', async () => {
    applyProcessNetworkTrustChain({
      settings: {
        enabled: true,
        httpProxy: 'http://proxy.internal:3128',
        httpsProxy: 'http://secure-proxy.internal:3129',
      },
      log: recordingLogger,
    });

    await fetch('https://models.example.com/v1/models');
    await fetch('http://plain.example.com/');

    expect(recorded[0]!.init?.proxy).toBe('http://secure-proxy.internal:3129');
    expect(recorded[1]!.init?.proxy).toBe('http://proxy.internal:3128');
  });

  it('honours NO_PROXY so loopback RPC does not traverse the proxy', async () => {
    applyProcessNetworkTrustChain({
      settings: { enabled: true, httpsProxy: 'http://proxy.internal:3128', noProxy: 'localhost,127.0.0.1' },
      log: recordingLogger,
    });

    await fetch('https://127.0.0.1:9100/health');
    expect(recorded[0]!.init?.proxy).toBeUndefined();
  });

  it('mirrors the proxy into the environment so callers that bypass the wrapper still route', () => {
    applyProcessNetworkTrustChain({
      settings: { enabled: true, httpsProxy: 'http://proxy.internal:3128', noProxy: 'localhost' },
      log: recordingLogger,
    });
    expect(process.env.HTTPS_PROXY).toBe('http://proxy.internal:3128');
    // The configured value, EXTENDED with the loopback exemption P2.263 added
    // — this projection is what Bun's own fetch and every env spread read, and
    // it is the mechanism `shouldBypassProxy` cannot reach. The exemption's own
    // cases live in `host-loopback-proxy-exemption.test.ts`.
    expect(process.env.NO_PROXY).toBe('localhost,127.0.0.1,::1,[::1]');

    // Disabling removes exactly the keys we set — no stale proxy survives.
    applyProcessNetworkTrustChain({ settings: { enabled: false }, log: recordingLogger });
    expect(process.env.HTTPS_PROXY).toBeUndefined();
    expect(process.env.NO_PROXY).toBeUndefined();
  });

  it('restores an operator-provided proxy instead of deleting it', () => {
    process.env.HTTPS_PROXY = 'http://launch-env-proxy:8080';
    try {
      applyProcessNetworkTrustChain({
        settings: { enabled: true, httpsProxy: 'http://configured:3128' },
        log: recordingLogger,
      });
      expect(process.env.HTTPS_PROXY).toBe('http://configured:3128');

      applyProcessNetworkTrustChain({ settings: { enabled: false }, log: recordingLogger });
      expect(process.env.HTTPS_PROXY).toBe('http://launch-env-proxy:8080');
    } finally {
      delete process.env.HTTPS_PROXY;
    }
  });

  it('refuses a SOCKS proxy from a hand-edited config instead of mis-routing', async () => {
    const applied = applyProcessNetworkTrustChain({
      settings: { enabled: true, httpsProxy: 'socks5://proxy.internal:1080' },
      log: recordingLogger,
    });

    expect(applied.proxy).toBe(false);
    await fetch('https://models.example.com/');
    expect(recorded[0]!.init?.proxy).toBeUndefined();
    expect(logLines.some(line => line.includes('NOT applied'))).toBe(true);
  });
});

describe('applyProcessNetworkTrustChain — TLS material', () => {
  it('presents the client identity and the composed CA on https requests', async () => {
    const { certPath, keyPath } = writeIdentity();
    const caPath = join(tempDir, 'corp-ca.pem');
    writeFileSync(caPath, 'corporate-ca');

    const applied = applyProcessNetworkTrustChain({
      settings: {
        enabled: false,
        tlsCaPath: caPath,
        clientCertPath: certPath,
        clientKeyPath: keyPath,
        clientKeyPassphrase: 'hunter2',
      },
      log: recordingLogger,
    });

    expect(applied).toEqual({ proxy: false, customCa: true, clientIdentity: true });

    await fetch('https://gateway.example.com/v1/models');
    const tls = recorded[0]!.init?.tls as { ca: string[]; cert: string; key: string; passphrase: string };
    expect(tls.cert).toContain('client-v1');
    expect(tls.key).toContain('key-v1');
    expect(tls.passphrase).toBe('hunter2');
    // The extra CA must AUGMENT the public roots, never replace them: a
    // corporate-only list would break every public-root host. Asserted by
    // shape — how many roots the runtime and the OS store ship varies.
    expect(Array.isArray(tls.ca)).toBe(true);
    expect(tls.ca[tls.ca.length - 1]).toBe('corporate-ca');
    expect(tls.ca).toContain(rootCertificates[0]!);
    expect(tls.ca.length).toBeGreaterThan(rootCertificates.length);
  });

  it('leaves the runtime default trust alone when nothing is configured', async () => {
    applyProcessNetworkTrustChain({ settings: undefined, log: recordingLogger });

    await fetch('https://api.example.com/');
    expect(recorded[0]!.init?.tls).toBeUndefined();
    expect(recorded[0]!.init?.proxy).toBeUndefined();
  });

  it('re-reads the identity on every application so rotation needs no restart', async () => {
    const { certPath, keyPath } = writeIdentity();
    const settings = { enabled: false, clientCertPath: certPath, clientKeyPath: keyPath };

    applyProcessNetworkTrustChain({ settings, log: recordingLogger });
    await fetch('https://gateway.example.com/');
    expect((recorded[0]!.init?.tls as { cert: string }).cert).toContain('client-v1');

    writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\nclient-v2\n-----END CERTIFICATE-----\n');
    applyProcessNetworkTrustChain({ settings, log: recordingLogger });
    await fetch('https://gateway.example.com/');
    expect((recorded[1]!.init?.tls as { cert: string }).cert).toContain('client-v2');
  });

  it('reports an unreadable client certificate instead of silently going unauthenticated', () => {
    const applied = applyProcessNetworkTrustChain({
      settings: {
        enabled: false,
        clientCertPath: join(tempDir, 'missing.crt'),
        clientKeyPath: join(tempDir, 'missing.key'),
      },
      log: recordingLogger,
    });

    expect(applied.clientIdentity).toBe(false);
    expect(logLines.some(line => line.includes('mTLS client certificate was NOT applied'))).toBe(true);
  });

  it('lets an explicit per-call proxy or tls option win', async () => {
    applyProcessNetworkTrustChain({
      settings: { enabled: true, httpsProxy: 'http://proxy.internal:3128' },
      log: recordingLogger,
    });

    await fetch('https://api.example.com/', {
      proxy: 'http://override.internal:8080',
      tls: { ca: ['explicit'] },
    } as RequestInit);

    expect(recorded[0]!.init?.proxy).toBe('http://override.internal:8080');
    expect(recorded[0]!.init?.tls).toEqual({ ca: ['explicit'] });
  });
});

describe('applyProcessNetworkTrustChain — secrets', () => {
  it('never logs a credentialed proxy URL, a key path or a passphrase', () => {
    const { certPath, keyPath } = writeIdentity();

    applyProcessNetworkTrustChain({
      settings: {
        enabled: true,
        httpsProxy: 'http://alice:s3cr3t@proxy.internal:3128',
        clientCertPath: certPath,
        clientKeyPath: keyPath,
        clientKeyPassphrase: 'hunter2',
      },
      log: recordingLogger,
    });

    const output = logLines.join('\n');
    expect(output).not.toContain('s3cr3t');
    expect(output).not.toContain('alice');
    expect(output).not.toContain('proxy.internal');
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain(keyPath);
    // It still says what it did.
    expect(output).toContain('Applying trust chain');
  });
});

describe('applyProcessNetworkTrustChain — against the real runtime', () => {
  it.skipIf(proxyEnvFrozenByPreload)('actually routes a real fetch through the proxy', async () => {
    // The unit tests above assert the OPTIONS we set. This asserts the runtime
    // honours them — the whole design rests on Bun's per-request `proxy`/`tls`
    // fetch options, because Bun's fetch ignores undici's global dispatcher.
    const { createServer } = await import('node:http');
    const hits: string[] = [];
    const proxy = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('via-proxy');
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', () => resolve()));
    const port = (proxy.address() as { port: number }).port;

    globalThis.fetch = originalFetch;
    __resetProcessNetworkTrustChainForTest();
    applyProcessNetworkTrustChain({
      settings: { enabled: true, httpProxy: `http://127.0.0.1:${port}` },
      log: recordingLogger,
    });

    try {
      // A host that cannot resolve: reaching it at all proves the proxy was used.
      const response = await fetch('http://nessy-trust-chain.invalid/probe');
      expect(await response.text()).toBe('via-proxy');
      // Compare the parsed request line, not its spelling: the client may send
      // the absolute form with an explicit default port (`…invalid:80/probe` on
      // the CI container, `…invalid/probe` locally). Both routed through the
      // proxy — which is the whole claim — so the assertion must not turn a URL
      // serialization difference into a red build.
      expect(hits.map(hit => {
        const parsed = new URL(hit);
        return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
      })).toEqual(['http://nessy-trust-chain.invalid/probe']);
    } finally {
      proxy.close();
    }
  });
});

describe('watchNetworkTrustChain', () => {
  const applyCount = () => logLines.filter(line => line.includes('Applying trust chain')).length;

  it('survives the atomic rewrite saveConfig performs', async () => {
    // saveConfig writes a temp file and renames over config.json. A watch bound
    // to the original inode goes deaf after the first change, so the watcher
    // must follow the DIRECTORY — that is what this asserts.
    const configFile = join(tempDir, 'config.json');
    writeFileSync(configFile, '{}');

    applyProcessNetworkTrustChain({ settings: undefined, log: recordingLogger });
    expect(applyCount()).toBe(1);

    const watcher = watchNetworkTrustChain({ log: recordingLogger, configDir: tempDir, debounceMs: 5 });
    try {
      await Bun.sleep(60); // let the kqueue watch arm before the first write
      // Two rounds: the second is what a file-inode watch would sleep through.
      // Counted as "grew", not an exact number — one save legitimately surfaces
      // as more than one filesystem event.
      for (let round = 1; round <= 2; round++) {
        const before = applyCount();
        const temp = join(tempDir, `config.json.${round}.tmp`);
        writeFileSync(temp, `{"storageLayoutVersion":${round}}`);
        renameSync(temp, configFile);
        await Bun.sleep(150);
        expect(applyCount()).toBeGreaterThan(before);
      }
    } finally {
      watcher.dispose();
    }
  });

  it('debounces a burst of writes instead of re-applying once per event', async () => {
    writeFileSync(join(tempDir, 'config.json'), '{}');
    applyProcessNetworkTrustChain({ settings: undefined, log: recordingLogger });

    const watcher = watchNetworkTrustChain({ log: recordingLogger, configDir: tempDir, debounceMs: 60 });
    try {
      await Bun.sleep(60);
      for (let i = 0; i < 8; i++) writeFileSync(join(tempDir, 'config.json'), `{"n":${i}}`);
      await Bun.sleep(250);
      expect(applyCount()).toBeGreaterThan(1);
      expect(applyCount()).toBeLessThan(1 + 8);
    } finally {
      watcher.dispose();
    }
  });

  it('degrades to a warning when there is no config directory to watch', () => {
    const watcher = watchNetworkTrustChain({
      log: recordingLogger,
      configDir: join(tempDir, 'absent-dir'),
    });
    watcher.dispose();
    expect(logLines.some(line => line.includes('Not watching network settings'))).toBe(true);
  });
});
