/**
 * C3.382 — the app's own proxy reaches a Pi SHELL CHILD.
 *
 * R7 measured the defect on the packaged 1.37.0 build (RS-33 runs B and D):
 * with `networkProxy` enabled against a proxy refusing everything, a Pi `Bash`
 * call printed `curl_code=200` and `node_out=NODE_REACHED 200` for a public host
 * with ZERO lines for it in the proxy's own log, while the claude child in the
 * SAME run was refused twice.
 *
 * The row named the Pi SPAWN env as the cause and that premise is refuted:
 * `buildPiSubprocessEnv` already projects the proxy, the exemption and
 * `NODE_USE_ENV_PROXY` into the Pi subprocess. A Pi `bash` tool call is a
 * host-run SUPERVISED process, and the host's own allowlist
 * (`packages/server-core/src/pi-harness/process-supervisor.ts` symbol
 * `isRestrictedHostEnvironmentKey`) answers false for every proxy and CA name
 * under the shipped default `restricted` profile — so the names were stripped
 * one layer below the projection. The supervisor merges a start request's `env`
 * OVER that host environment, which is the seam this file pins.
 *
 * Two levels, because the defect needs both to stay closed: the projection
 * itself (`buildShellChildNetworkEnv`), and the one call site that delivers it
 * to a supervised child (`PiAgent.handleProcessStartRequest`).
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildShellChildNetworkEnv } from '../../config/proxy-env.ts';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

// The file's budget, not a test's: importing `pi-agent.ts` is an I/O-bound
// module graph whose load is charged to whichever hook runs first, and the
// bodies below are milliseconds (AGENTS.md §Traps, the junit reading).
setDefaultTimeout(120_000);

const LOOPBACK = 'localhost,127.0.0.1,::1,[::1]';

describe('buildShellChildNetworkEnv — the projection', () => {
  it('carries both spellings, the loopback exemption and the Node flag from the Settings proxy', () => {
    const env = buildShellChildNetworkEnv({
      processEnv: {},
      settings: { enabled: true, httpProxy: 'http://127.0.0.1:8927', httpsProxy: 'http://127.0.0.1:8927' },
    });

    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:8927');
    expect(env.http_proxy).toBe('http://127.0.0.1:8927');
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:8927');
    expect(env.https_proxy).toBe('http://127.0.0.1:8927');
    // Both spellings, and the exemption runs BEFORE the Node flag — the order
    // `applyNodeEnvProxy`'s docblock requires.
    expect(env.NO_PROXY).toBe(LOOPBACK);
    expect(env.no_proxy).toBe(LOOPBACK);
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
  });

  it('carries an AMBIENT proxy and the operator CA a supervised child cannot inherit', () => {
    const env = buildShellChildNetworkEnv({
      processEnv: { HTTPS_PROXY: 'http://proxy.invalid:3128', NODE_EXTRA_CA_CERTS: '/tmp/operator.pem' },
      settings: undefined,
    });

    expect(env.HTTPS_PROXY).toBe('http://proxy.invalid:3128');
    // `buildNetworkEnvVars` OMITS an operator's CA so an inherited value can
    // pass through; a supervised child inherits nothing, so it is carried here.
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/tmp/operator.pem');
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
  });

  it('withholds the mTLS client identity — the command in this child is the MODEL\'s', () => {
    const env = buildShellChildNetworkEnv({
      processEnv: {},
      settings: {
        enabled: true,
        httpsProxy: 'http://proxy.invalid:3128',
        clientCertPath: '/tmp/client.pem',
        clientKeyPath: '/tmp/client.key',
        clientKeyPassphrase: 'NOT-A-REAL-SECRET',
      },
    });

    expect(env.HTTPS_PROXY).toBe('http://proxy.invalid:3128');
    expect(env).not.toHaveProperty('CLAUDE_CODE_CLIENT_CERT');
    expect(env).not.toHaveProperty('CLAUDE_CODE_CLIENT_KEY');
    expect(env).not.toHaveProperty('CLAUDE_CODE_CLIENT_KEY_PASSPHRASE');
    expect(Object.values(env)).not.toContain('NOT-A-REAL-SECRET');
  });

  it('emits NOTHING with no proxy in effect, so an unproxied machine is byte-identical', () => {
    expect(buildShellChildNetworkEnv({ processEnv: {}, settings: undefined })).toEqual({});
    // A disabled Settings proxy is not a proxy, and neither is whitespace.
    expect(buildShellChildNetworkEnv({
      processEnv: { HTTPS_PROXY: '   ' },
      settings: { enabled: false, httpsProxy: 'http://proxy.invalid:3128' },
    })).toEqual({});
  });
});

const envBinding = { environmentProfile: 'restricted' as const, environmentDigest: 'a'.repeat(64) };
const WORKSPACE_ROOT = join(tmpdir(), 'nessy-c3-382-workspace');

function piConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-c3-382',
      name: 'C3.382',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: join(tmpdir(), 'nessy-c3-382-sessions'),
    } as never,
    session: {
      id: 'session-c3-382',
      workspaceRootPath: WORKSPACE_ROOT,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as never,
    isHeadless: true,
    ...overrides,
  } as BackendConfig;
}

/**
 * Assign an ambient name the way the trap requires: DELETE first, then assign,
 * on the set path and on the restore path (AGENTS.md §Traps — under Bun an
 * assigned value is readable by property and invisible to a spread, and `in`
 * lies about whether it was present at launch).
 */
function setAmbient(name: string, value: string | undefined): void {
  delete process.env[name];
  if (value !== undefined) process.env[name] = value;
}

let ambientBefore: string | undefined;

/**
 * D1.440 — the AMBIENT no-proxy names are controlled too, and that is not
 * tidiness.
 *
 * `buildShellChildNetworkEnv` MERGES an operator's `NO_PROXY` with the loopback
 * exemption, which is right and which nothing pinned. The arms below assert the
 * exemption EXACTLY, so on a machine with no `NO_PROXY` they passed and on the
 * CI runner — whose environment carries a corporate list — the same bytes read
 * `localhost,127.0.0.1,.local,docker,.tinkoff.cloud,…,::1,[::1]` and the case
 * failed as if the product had changed. Measured on the first chunked pipeline.
 *
 * This is AGENTS.md's bun env-slot trap from its second side: what a name does
 * depends on whether it was PRESENT AT LAUNCH, so an arm that reads a merge
 * must own both inputs. `setAmbient` deletes before assigning for the same
 * reason, on the restore path as well.
 */
const AMBIENT_NAMES = ['HTTPS_PROXY', 'NO_PROXY', 'no_proxy'] as const;
const ambientRestore = new Map<string, string | undefined>();

function ownAmbient(name: string, value: string | undefined): void {
  if (!ambientRestore.has(name)) ambientRestore.set(name, process.env[name]);
  setAmbient(name, value);
}

/** Take the no-proxy names away from the runner for one case. */
function clearAmbientNoProxy(): void {
  ownAmbient('NO_PROXY', undefined);
  ownAmbient('no_proxy', undefined);
}

afterEach(() => {
  setAmbient('HTTPS_PROXY', ambientBefore);
  ambientBefore = undefined;
  for (const name of AMBIENT_NAMES) {
    if (ambientRestore.has(name)) setAmbient(name, ambientRestore.get(name));
  }
  ambientRestore.clear();
});

async function driveOneBashStart(): Promise<Record<string, string> | undefined> {
  const starts: { env?: Record<string, string> }[] = [];
  const port = {
    start: async (request: { env?: Record<string, string> }) => {
      starts.push(request);
      return {
        handle: 'process_0123456789abcdef0123456789abcdef',
        output: '', nextCursor: 0, isRunning: false, exitCode: 0, signal: null,
        isolationProfile: 'workspace:test', ...envBinding,
      };
    },
    write: async () => {},
    read: async () => { throw new Error('unused'); },
    stop: async () => {},
    drainSession: async () => [],
  };
  const agent = new PiAgent(piConfig({ processSupervisorPort: port } as Partial<BackendConfig>));
  (agent as never as { subprocess: unknown }).subprocess = {
    stdin: { writable: true, write: () => {} },
  };
  (agent as never as { capabilityTurnRuntime: unknown }).capabilityTurnRuntime = { view: { skills: [] } };

  await (agent as never as {
    handleProcessStartRequest: (message: unknown) => Promise<void>;
  }).handleProcessStartRequest({
    requestId: 'execution-c3-382',
    request: {
      executionId: 'execution-c3-382', semanticId: 'bash',
      command: '/bin/sh', args: ['-lc', 'true'],
      cwd: WORKSPACE_ROOT, profile: 'workspace' as const,
      background: false, timeoutMs: 1000,
    },
  });

  return starts[0]?.env;
}

describe('the supervised child start carries the proxy (Pi backend)', () => {
  it('delivers the proxy names into the start request the supervisor merges over its allowlist', async () => {
    ambientBefore = process.env.HTTPS_PROXY;
    setAmbient('HTTPS_PROXY', 'http://proxy.invalid:3128');
    // The runner's own `NO_PROXY` is not this case's subject; see the block on
    // `clearAmbientNoProxy`. The MERGE it hides is pinned in its own arm below.
    clearAmbientNoProxy();

    const env = await driveOneBashStart();

    // Read into a local before asserting, and assert key by key: the request
    // object is read again below, and `toMatchObject` with a matcher REPLACES
    // the value it matched (AGENTS.md §Traps).
    expect(env).toBeDefined();
    expect(env!.HTTPS_PROXY).toBe('http://proxy.invalid:3128');
    // An AMBIENT name is carried under the spelling it was set in and is not
    // mirrored into the other one — the child is being given back what it would
    // have inherited, not a spelling the operator never wrote. (The SETTINGS
    // proxy is the case that writes both, above.) The exemption is the opposite,
    // and deliberately so: it writes BOTH, because Bun reads `no_proxy` first
    // and the claude binary reads `no_proxy || NO_PROXY`.
    expect(env).not.toHaveProperty('https_proxy');
    expect(env!.NO_PROXY).toBe(LOOPBACK);
    expect(env!.no_proxy).toBe(LOOPBACK);
    expect(env!.NODE_USE_ENV_PROXY).toBe('1');
    // The host's other per-start additions are untouched by the new spread.
    expect(env!.CLAUDE_EFFORT).toBe('medium');
  });

  it('keeps an operator NO_PROXY and ADDS the loopback exemption to it', async () => {
    // The behaviour the CI runner revealed and nothing pinned (D1.440). An
    // operator who exempts their own hosts keeps them; the loopback exemption
    // is added rather than substituted, in BOTH spellings, because Bun reads
    // `no_proxy` first and the claude binary reads `no_proxy || NO_PROXY`.
    ambientBefore = process.env.HTTPS_PROXY;
    setAmbient('HTTPS_PROXY', 'http://proxy.invalid:3128');
    ownAmbient('NO_PROXY', 'corp.invalid,.internal.invalid');
    ownAmbient('no_proxy', undefined);

    const env = await driveOneBashStart();

    expect(env).toBeDefined();
    const merged = env!.NO_PROXY;
    expect(typeof merged).toBe('string');
    for (const kept of ['corp.invalid', '.internal.invalid']) {
      expect(merged as string).toContain(kept);
    }
    for (const added of LOOPBACK.split(',')) {
      expect(merged as string).toContain(added);
    }
    // Read into a local first, then assert the sibling spelling carries it too.
    expect(env!.no_proxy).toBe(merged);
  });

  it('adds no network name at all when no proxy is configured', async () => {
    ambientBefore = process.env.HTTPS_PROXY;
    setAmbient('HTTPS_PROXY', undefined);
    clearAmbientNoProxy();

    const env = await driveOneBashStart();

    expect(env).toBeDefined();
    for (const name of [
      'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy',
      'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS',
    ]) {
      expect(env).not.toHaveProperty(name);
    }
    // The negative is only as strong as the proof that the seam ran at all.
    expect(env!.CLAUDE_EFFORT).toBe('medium');
  });
});
