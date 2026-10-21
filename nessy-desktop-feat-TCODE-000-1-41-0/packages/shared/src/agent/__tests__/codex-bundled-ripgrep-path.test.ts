/**
 * F1.1301 — a codex shell finds the ripgrep the bundle ships, as Pi's tools do (F1.727).
 *
 * codex's prompts steer the model to `rg` through its shell, and codex 0.159.3 has no grep tool and no rg
 * setting of its own. Its NATIVE answer is a package layout (`bin/codex` beside `codex-package.json` and a
 * `codex-path/rg`, whose directory `codex-rs/arg0` prepends to the process PATH — `install-context/src/lib.rs`
 * `CodexPackageLayout`), and our fetched `resources/bin/codex/<platform>/codex-app-server` is not in that layout,
 * so a packaged codex session on a host with no system rg met `rg: command not found`. The host supplies the
 * directory instead: the codex child's spawn env, which codex hands every shell (`shell_environment_policy`
 * inherits `All` by default), and the policy PATH the host already writes when a plugin `bin/` is enabled.
 *
 * The rig is the production chain with the subprocess faked: the REAL `codexDriver.buildRuntime` over a
 * packaged-layout tree, its runtime handed to a REAL `CodexAgent`, the REAL `ensureRuntime`; only
 * `CodexRuntimeManager.spawn` is a recorder. The recorded env is then used to run `command -v rg` in a real
 * shell, so the verdict is "the shell found the bundled binary", not "a string contained a directory".
 */
import { afterAll, beforeAll, describe, expect, it, mock, setDefaultTimeout } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import * as credentialsIndex from '../../credentials/index.ts';
import * as adapterPackage from '@nessy-agent/codex-responses-adapter';
import * as nestorAuth from '@nessy-agent/codex-responses-adapter/nestor-auth';
import * as codexAgentServer from '@nessy-agent/codex-agent-server';
import type { AdapterHandle } from '@nessy-agent/codex-responses-adapter';
import type { BackendConfig } from '../backend/types.ts';

// The codex-agent module graph is large; the bodies are milliseconds.
setDefaultTimeout(120_000);

const spawns: Array<{ env?: Record<string, string> }> = [];

class FakeRuntimeManager {
  spawn(opts: { env?: Record<string, string> }): unknown { spawns.push(opts); return { pid: 4242 }; }
  async kill(): Promise<void> { /* no child to reap */ }
}

class FakeAppServerClient {
  constructor(_child: unknown, _handlers: unknown) { /* no stdio */ }
  async request(method: string): Promise<unknown> {
    return method === 'thread/start' ? { thread: { id: 'thread-f1301' } } : {};
  }
  notify(): void { /* no-op */ }
  close(): void { /* no-op */ }
}

// Spread from snapshots taken BEFORE mocking, and restored from the same snapshots (AGENTS.md trap).
const realCredentials = { ...credentialsIndex };
const realAdapter = { ...adapterPackage };
const realNestorAuth = { ...nestorAuth };
const realCodexAgentServer = { ...codexAgentServer };

mock.module('../../credentials/index.ts', () => ({
  ...realCredentials,
  getCredentialManager: () => ({ getLlmApiKey: async () => null }),
}));
mock.module('@nessy-agent/codex-responses-adapter', () => ({
  ...realAdapter,
  startAdapter: async (): Promise<AdapterHandle> => ({ port: 45872, close: async () => {} }) as AdapterHandle,
}));
// Never the developer's real dp creds file.
mock.module('@nessy-agent/codex-responses-adapter/nestor-auth', () => ({
  ...realNestorAuth,
  readNestorJwt: () => 'jwt-f1301',
  readNestorCreds: () => ({ ok: true, jwt: 'jwt-f1301' }),
}));
mock.module('@nessy-agent/codex-agent-server', () => ({
  ...realCodexAgentServer,
  CodexRuntimeManager: FakeRuntimeManager,
  AppServerClient: FakeAppServerClient,
}));

afterAll(() => {
  mock.module('../../credentials/index.ts', () => realCredentials);
  mock.module('@nessy-agent/codex-responses-adapter', () => realAdapter);
  mock.module('@nessy-agent/codex-responses-adapter/nestor-auth', () => realNestorAuth);
  mock.module('@nessy-agent/codex-agent-server', () => realCodexAgentServer);
});

const { CodexAgent } = await import('../codex-agent.ts');
const { codexDriver } = await import('../backend/internal/drivers/codex.ts');

const HOST_PATH_WITHOUT_RG = ['/usr/bin', '/bin'].join(delimiter);

let root: string;
let appRoot: string;
let bundledRg: string;
let systemRgDir: string;
let pluginRoot: string;

function writeExecutable(path: string, marker: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho ${marker}\n`);
  chmodSync(path, 0o755);
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'f1301-rg-')));
  // The packaged layout, spelled with the space the real bundle name carries (asar is off).
  appRoot = join(root, 'Nessy Desktop.app', 'Contents', 'Resources', 'app');
  bundledRg = join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg');
  writeExecutable(bundledRg, 'BUNDLED-RG');
  systemRgDir = join(root, 'system-bin');
  writeExecutable(join(systemRgDir, 'rg'), 'SYSTEM-RG');
  pluginRoot = join(root, 'plugin');
  writeExecutable(join(pluginRoot, 'bin', 'demo-cli'), 'DEMO');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function packagedRuntime() {
  return codexDriver.buildRuntime({
    context: {
      connection: null,
      provider: 'codex-runtime',
      resolvedModel: 'codex/test-model',
      capabilities: { needsHttpPoolServer: false },
    },
    coreConfig: {} as never,
    hostRuntime: { appRootPath: appRoot, resourcesPath: dirname(appRoot), isPackaged: true },
    resolvedPaths: { codexBinaryPath: '/fake/codex-app-server' } as never,
  });
}

function agentConfig(runtime: Record<string, unknown>): BackendConfig {
  return {
    provider: 'codex-runtime',
    providerType: 'codex-runtime',
    model: 'codex/test-model',
    isHeadless: true,
    workspace: {
      id: 'ws-f1301',
      name: 'F1.1301 Workspace',
      rootPath: root,
      workspaceRootPath: root,
      sessionRootPath: join(root, 'sessions'),
    } as never,
    session: { id: 'session-f1301', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: root } as never,
    runtime,
  } as BackendConfig;
}

/** The PATH the codex child (and so every codex shell) runs under: the spawn's `env.PATH`, else the host's. */
async function effectiveSpawnPath(runtime: Record<string, unknown>, hostPath: string): Promise<{
  requestPath: string | undefined;
  effectivePath: string;
}> {
  spawns.length = 0;
  const agent = new CodexAgent(agentConfig(runtime));
  const savedPath = process.env.PATH;
  try {
    // PATH is always set at launch, so an assignment stays enumerable (the Bun trap is about names absent at launch).
    process.env.PATH = hostPath;
    await (agent as unknown as { ensureRuntime(): Promise<void> }).ensureRuntime();
  } finally {
    process.env.PATH = savedPath;
    agent.destroy();
  }
  expect(spawns).toHaveLength(1);
  const requestPath = spawns[0]!.env?.PATH;
  return { requestPath, effectivePath: requestPath ?? hostPath };
}

/** What `/bin/sh` resolves `rg` to under this PATH — the real lookup, not a string test. */
function shellResolvesRg(path: string): { status: number | null; stdout: string } {
  const probe = spawnSync('/bin/sh', ['-c', 'command -v rg'], { env: { PATH: path }, encoding: 'utf8' });
  return { status: probe.status, stdout: probe.stdout.trim() };
}

describe('F1.1301 — a packaged codex shell reaches the bundled ripgrep', () => {
  it('the codex driver names the bundled rg of a packaged layout', () => {
    expect(packagedRuntime().paths?.ripgrep).toBe(bundledRg);
  });

  it('the codex child on a host with no ripgrep runs under a PATH whose shell finds the bundled rg', async () => {
    // Positive control for the probe itself, same instrument, same minute.
    expect(shellResolvesRg([HOST_PATH_WITHOUT_RG, systemRgDir].join(delimiter)).stdout).toBe(join(systemRgDir, 'rg'));
    expect(shellResolvesRg(HOST_PATH_WITHOUT_RG).status).not.toBe(0);

    const { effectivePath } = await effectiveSpawnPath(packagedRuntime(), HOST_PATH_WITHOUT_RG);
    expect(shellResolvesRg(effectivePath)).toEqual({ status: 0, stdout: bundledRg });
    // Appended: the host's own entries keep their order and come first.
    expect(effectivePath).toBe([HOST_PATH_WITHOUT_RG, dirname(bundledRg)].join(delimiter));
  });

  it('CONTROL — a host that already resolves rg keeps its own, and nothing to add leaves no PATH key', async () => {
    const hostPath = [HOST_PATH_WITHOUT_RG, systemRgDir].join(delimiter);
    const withSystemRg = await effectiveSpawnPath(packagedRuntime(), hostPath);
    expect(shellResolvesRg(withSystemRg.effectivePath)).toEqual({ status: 0, stdout: join(systemRgDir, 'rg') });

    const noRipgrep = await effectiveSpawnPath({ ...packagedRuntime(), paths: { codexBinary: '/fake/codex-app-server' } }, HOST_PATH_WITHOUT_RG);
    expect(noRipgrep.requestPath).toBeUndefined();
    const alreadyThere = await effectiveSpawnPath(packagedRuntime(), [HOST_PATH_WITHOUT_RG, dirname(bundledRg)].join(delimiter));
    expect(alreadyThere.requestPath).toBeUndefined();
  });

  it('a turn with an enabled plugin bin/ — whose policy PATH replaces the inherited one — still carries the bundled rg', () => {
    const agent = new CodexAgent(agentConfig(packagedRuntime()));
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = HOST_PATH_WITHOUT_RG;
      (agent as unknown as { capabilityTurnRuntime: unknown }).capabilityTurnRuntime = {
        view: { skills: [{ pluginRuntime: { rootPath: pluginRoot } }] },
      };
      const { environment } = (agent as unknown as {
        resolveSelectedPluginSkillRuntimePolicy(): { environment: Record<string, string> };
      }).resolveSelectedPluginSkillRuntimePolicy();
      expect(environment.PATH).toBe([HOST_PATH_WITHOUT_RG, dirname(bundledRg), join(pluginRoot, 'bin')].join(delimiter));
      expect(shellResolvesRg(environment.PATH!)).toEqual({ status: 0, stdout: bundledRg });
    } finally {
      process.env.PATH = savedPath;
      agent.destroy();
    }
  });
});
