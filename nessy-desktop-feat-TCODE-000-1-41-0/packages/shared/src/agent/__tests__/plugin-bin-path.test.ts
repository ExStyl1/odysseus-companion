/**
 * C6 — a Claude plugin's `bin/` reaches the Bash tool's PATH.
 *
 * `plugins-reference.md` § File locations, `bin/`: "Executables added to the
 * Bash tool PATH. Files here are invokable as bare commands in any Bash tool
 * call while the plugin is enabled."
 *
 * The claim under test is a RESOLUTION, not a string, so the arms that matter
 * actually execute a bare command against the env the production seam built.
 * The host PATH is INJECTED (`process.env.PATH` is replaced with one temp
 * directory for the duration of an arm and restored afterwards), so no arm's
 * verdict can depend on what is installed on the machine running it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ClaudeAgent } from '../claude-agent.ts';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import { getSessionJobDir, SESSION_JOB_DIR_ENV_VAR } from '../../sessions/storage.ts';

// F1.916 — every supervised start names the session's own scratch root.
const jobDirEnv = { [SESSION_JOB_DIR_ENV_VAR]: getSessionJobDir('ws-c6', 'session-c6') };

let root: string;
/** The injected "system" PATH — one directory, holding one binary. */
let systemDirectory: string;
let alphaRoot: string;
let alphaBin: string;
let gammaRoot: string;
let gammaBin: string;
/** A bundle with no `bin/` at all. */
let betaRoot: string;

function writeExecutable(directory: string, name: string, output: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), `#!/bin/sh\necho ${output}\n`, { mode: 0o755 });
}

/** Run a BARE command name against `path` and return its stdout. */
function runBare(command: string, path: string): string {
  return execFileSync(command, [], { env: { PATH: path }, encoding: 'utf8' }).trim();
}

/** Swap the host PATH for the injected one, run `body`, always restore. */
function withInjectedHostPath<T>(path: string, body: () => T): T {
  const previous = process.env.PATH;
  process.env.PATH = path;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
}

function pluginView(...bundleRoots: string[]) {
  return {
    view: {
      skills: bundleRoots.map(rootPath => ({ pluginRuntime: { rootPath } })),
    },
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'nessy-c6-bin-path-'));
  systemDirectory = join(root, 'system');
  alphaRoot = join(root, 'bundles', 'alpha');
  alphaBin = join(alphaRoot, 'bin');
  betaRoot = join(root, 'bundles', 'beta');
  gammaRoot = join(root, 'bundles', 'gamma');
  gammaBin = join(gammaRoot, 'bin');

  // The one binary the injected system PATH holds. `alpha` ships a file of the
  // SAME name, which is the shadowing case.
  writeExecutable(systemDirectory, 'probe', 'system');
  writeExecutable(alphaBin, 'probe', 'plugin');
  writeExecutable(alphaBin, 'alpha-tool', 'alpha');
  writeExecutable(gammaBin, 'gamma-tool', 'gamma');
  mkdirSync(betaRoot, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function claudeAgentWith(capabilityTurnRuntime: unknown, activeSkillRuntimes: unknown[] = []): any {
  const agent = Object.create(ClaudeAgent.prototype) as any;
  agent.config = {
    pluginNodeRuntime: {
      command: '/private/nessy/runtime/bun',
      nodeShimDirectory: '/private/nessy/runtime/bin',
      environment: { ELECTRON_RUN_AS_NODE: '1' },
    },
  };
  agent.capabilityTurnRuntime = capabilityTurnRuntime;
  agent.activePluginSkillRuntimes = activeSkillRuntimes;
  return agent;
}

describe('an enabled plugin bin/ on the Bash tool PATH (Claude backend)', () => {
  it('makes a bundle executable resolve as a bare command', () => {
    const path = withInjectedHostPath(systemDirectory, () => {
      const agent = claudeAgentWith(pluginView(alphaRoot));
      return agent.resolveSelectedPluginSkillRuntimePolicy().environment.PATH as string;
    });

    expect(path).toBe(`${systemDirectory}${delimiter}${alphaBin}`);
    // The load-bearing assertion: a BARE name resolves through it.
    expect(runBare('alpha-tool', path)).toBe('alpha');
  });

  it('appends, so a plugin cannot shadow a system binary of the same name', () => {
    const path = withInjectedHostPath(systemDirectory, () => {
      const agent = claudeAgentWith(pluginView(alphaRoot));
      return agent.resolveSelectedPluginSkillRuntimePolicy().environment.PATH as string;
    });

    // Both directories hold `probe`; the system one must win.
    expect(runBare('probe', path)).toBe('system');
    expect(path.split(delimiter).indexOf(systemDirectory))
      .toBeLessThan(path.split(delimiter).indexOf(alphaBin));
  });

  it('grants nothing while the plugin is disabled', () => {
    const environment = withInjectedHostPath(systemDirectory, () => {
      // A disabled plugin contributes no runnable entry to the turn view, so
      // the view this turn is empty even though the bundle is still on disk.
      const agent = claudeAgentWith({ view: { skills: [] } });
      return agent.resolveSelectedPluginSkillRuntimePolicy().environment as Record<string, string>;
    });

    expect(environment).toEqual({});
    // Positive control on the same rig: `probe` still resolves on the injected
    // PATH, so the failure below is the absent bin/ and not a broken fixture.
    expect(runBare('probe', systemDirectory)).toBe('system');
    expect(() => runBare('alpha-tool', systemDirectory)).toThrow();
  });

  it('keeps the node shim first and every enabled bundle last, deduped and stable', () => {
    const path = withInjectedHostPath(systemDirectory, () => {
      // `alpha` named twice and by two surfaces; `beta` has no bin/ at all.
      const agent = claudeAgentWith({
        view: {
          skills: [{ pluginRuntime: { rootPath: alphaRoot } }, { pluginRuntime: { rootPath: betaRoot } }],
          hooks: [{ pluginRuntime: { rootPath: alphaRoot } }],
          mcpServers: [{ pluginRuntime: { rootPath: gammaRoot } }],
        },
      }, [{
        pluginInstanceId: 'plugin://alpha@1.0.0',
        runtime: {
          profile: 'claude-plugin-env-v1',
          rootPath: alphaRoot,
          dataPath: join(root, 'plugin-data', 'alpha'),
        },
      }]);
      return agent.resolveSelectedPluginSkillRuntimePolicy().environment.PATH as string;
    });

    expect(path).toBe([
      '/private/nessy/runtime/bin',
      systemDirectory,
      alphaBin,
      gammaBin,
    ].join(delimiter));
    expect(runBare('gamma-tool', path)).toBe('gamma');
    expect(runBare('probe', path)).toBe('system');
  });
});

const envBinding = { environmentProfile: 'restricted' as const, environmentDigest: 'a'.repeat(64) };

function piConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-c6',
      name: 'C6',
      rootPath: join(tmpdir(), 'nessy-c6-workspace'),
      workspaceRootPath: join(tmpdir(), 'nessy-c6-workspace'),
      sessionRootPath: join(tmpdir(), 'nessy-c6-sessions'),
    } as any,
    session: {
      id: 'session-c6',
      workspaceRootPath: join(tmpdir(), 'nessy-c6-workspace'),
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
    ...overrides,
  };
}

describe('an enabled plugin bin/ on the Bash tool PATH (Pi backend)', () => {
  it('reaches every supervised child start, and nothing when no plugin is enabled', async () => {
    const starts: any[] = [];
    const port = {
      start: async (request: any) => {
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
    const agent = new PiAgent(piConfig({ processSupervisorPort: port }));
    (agent as any).subprocess = { stdin: { writable: true, write: () => {} } };

    const bashRequest = (executionId: string) => ({
      requestId: executionId,
      request: {
        executionId, semanticId: 'bash', command: '/bin/sh', args: ['-lc', 'alpha-tool'],
        cwd: join(tmpdir(), 'nessy-c6-workspace'), profile: 'workspace' as const,
        background: false, timeoutMs: 1000,
      },
    });

    const previousPath = process.env.PATH;
    process.env.PATH = systemDirectory;
    try {
      (agent as any).capabilityTurnRuntime = pluginView(alphaRoot);
      await (agent as any).handleProcessStartRequest(bashRequest('execution-enabled'));

      // No plugin runtime matched the command, so the only PLUGIN env the host
      // adds is the PATH — which is what "any Bash tool call" means. The effort
      // pair rides the same host-owned rebuild (hooks.md `:707`).
      expect(starts[0].env).toEqual({
        PATH: `${systemDirectory}${delimiter}${alphaBin}`,
        NESSY_EFFORT: 'medium',
        CLAUDE_EFFORT: 'medium',
        ...jobDirEnv,
      });
      expect(runBare('alpha-tool', starts[0].env.PATH)).toBe('alpha');
      expect(runBare('probe', starts[0].env.PATH)).toBe('system');

      (agent as any).capabilityTurnRuntime = { view: { skills: [] } };
      await (agent as any).handleProcessStartRequest(bashRequest('execution-disabled'));
      // No plugin, so no PATH rebuild — the effort pair and the scratch root are all that remain.
      expect(starts[1].env).toEqual({ NESSY_EFFORT: 'medium', CLAUDE_EFFORT: 'medium', ...jobDirEnv });
      expect(starts[1].env).not.toHaveProperty('PATH');

      // The effort negative on this seam: a session at Nessy's `off` has no
      // documented level to name, so BOTH variables are withheld rather than
      // defaulted — and with no plugin env either, the host adds only the
      // session's scratch root (F1.916), which does not depend on the level.
      // Read per START, never cached: this level was set after the two starts
      // above and still takes effect on the next one.
      agent.setThinkingLevel('off');
      await (agent as any).handleProcessStartRequest(bashRequest('execution-effort-off'));
      expect(starts[2].env).toEqual(jobDirEnv);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      (agent as any).subprocess = null;
      agent.destroy();
    }
  });

  it('carries the plugin runtime env AND the PATH on a plugin-owned command', async () => {
    const starts: any[] = [];
    const port = {
      start: async (request: any) => {
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
    const agent = new PiAgent(piConfig({ processSupervisorPort: port }));
    (agent as any).subprocess = { stdin: { writable: true, write: () => {} } };
    (agent as any).activePluginSkillRuntimes = [{
      pluginInstanceId: 'plugin://alpha@1.0.0#bundle',
      runtime: {
        rootPath: alphaRoot,
        dataPath: join(root, 'plugin-data', 'alpha'),
        profile: 'generic-plugin-env-v1',
      },
    }];
    (agent as any).capabilityTurnRuntime = {
      ...pluginView(alphaRoot),
      materializer: { verifyPlugin: async () => {}, assertActive() {} },
    };

    const previousPath = process.env.PATH;
    process.env.PATH = systemDirectory;
    try {
      await (agent as any).handleProcessStartRequest({
        requestId: 'plugin-process',
        request: {
          executionId: 'execution-plugin', semanticId: 'bash', command: '/bin/sh',
          args: ['-lc', `node "${alphaRoot}/hooks/state.js"`],
          cwd: join(tmpdir(), 'nessy-c6-workspace'), profile: 'workspace' as const,
          background: false, timeoutMs: 1000,
        },
      });

      expect(starts[0].env).toEqual({
        NESSY_PLUGIN_ROOT: alphaRoot,
        PLUGIN_ROOT: alphaRoot,
        NESSY_PLUGIN_DATA: join(root, 'plugin-data', 'alpha'),
        PLUGIN_DATA: join(root, 'plugin-data', 'alpha'),
        PATH: `${systemDirectory}${delimiter}${alphaBin}`,
        NESSY_EFFORT: 'medium',
        CLAUDE_EFFORT: 'medium',
        ...jobDirEnv,
      });
      expect(starts[0].additionalWritableRoots).toEqual([join(root, 'plugin-data', 'alpha')]);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      (agent as any).subprocess = null;
      agent.destroy();
    }
  });
});
