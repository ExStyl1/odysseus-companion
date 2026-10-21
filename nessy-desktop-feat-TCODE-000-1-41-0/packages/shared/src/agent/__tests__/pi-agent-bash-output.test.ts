import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import { getSessionJobDir, SESSION_JOB_DIR_ENV_VAR } from '../../sessions/storage.ts';

// F1.916 — every supervised start names the session's own scratch root.
const jobDirEnv = { [SESSION_JOB_DIR_ENV_VAR]: getSessionJobDir('ws-test', 'session-test') };

const envBinding = { environmentProfile: 'restricted' as const, environmentDigest: 'a'.repeat(64) };

function createConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/nessy-general-agent-test',
      workspaceRootPath: '/tmp/nessy-general-agent-test',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/nessy-general-agent-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
    ...overrides,
  };
}

describe('PiAgent BashOutput session tool', () => {
  it('reads the host-owned supervised process without a child-side buffer', async () => {
    const calls: Array<{ shellId: string; offset?: number }> = [];
    const stopCalls: Array<{ workspaceId: string; sessionId: string; handle: string }> = [];
    const agent = new PiAgent(createConfig({
      processSupervisorPort: {
        start: async () => { throw new Error('unused') },
        write: async () => { throw new Error('unused') },
        read: async ({ handle, cursor }) => {
          calls.push({ shellId: handle, offset: cursor });
          return { handle, output: 'ready\n', nextCursor: 1, isRunning: false, exitCode: 0, signal: null, isolationProfile: 'workspace:test', ...envBinding };
        },
        stop: async ({ sessionKey, handle }) => { stopCalls.push({ ...sessionKey, handle }); },
        drainSession: async () => [],
      },
    }));

    try {
      const result = await (agent as any).executeSessionTool('BashOutput', {
        shell_id: 'process_0123456789abcdef0123456789abcdef',
        offset: 0,
      });

      expect(result.isError).toBe(false);
      expect(result.content).toContain('ready');
      expect(result.content).toContain('next_offset: 1');
      expect(calls).toEqual([{ shellId: 'process_0123456789abcdef0123456789abcdef', offset: 0 }]);

      const stopped = await (agent as any).executeSessionTool('ProcessStop', {
        shell_id: 'process_0123456789abcdef0123456789abcdef',
      });
      expect(stopped.isError).toBe(false);
      expect(stopCalls).toEqual([{
        workspaceId: 'ws-test',
        sessionId: 'session-test',
        handle: 'process_0123456789abcdef0123456789abcdef',
      }]);
    } finally {
      agent.destroy();
    }
  });

  it('binds child starts to the host SessionKey and a replacement Pi child can reattach by handle', async () => {
    const starts: any[] = [];
    const port = {
      start: async (request: any) => {
        starts.push(request);
        return { handle: 'process_0123456789abcdef0123456789abcdef', output: '', nextCursor: 0, isRunning: true, exitCode: null, signal: null, isolationProfile: 'workspace:test', ...envBinding };
      },
      write: async () => { throw new Error('unused') },
      read: async ({ handle }: any) => ({ handle, output: 'survived\n', nextCursor: 9, isRunning: true, exitCode: null, signal: null, isolationProfile: 'workspace:test', ...envBinding }),
      stop: async () => {},
      drainSession: async () => [],
    };
    const first = new PiAgent(createConfig({ processSupervisorPort: port }));
    const sent: any[] = [];
    (first as any).subprocess = { stdin: { writable: true, write: (line: string) => sent.push(JSON.parse(line)) } };
    await (first as any).handleProcessStartRequest({
      requestId: 'request-1',
      request: {
        executionId: 'execution-1', semanticId: 'bash_background', command: '/bin/sh', args: ['-lc', 'sleep 1'],
        cwd: '/tmp/nessy-general-agent-test', workspaceRoot: '/malicious', profile: 'workspace', background: true, timeoutMs: 1000,
      },
    });
    expect(starts[0].sessionKey).toEqual({ workspaceId: 'ws-test', sessionId: 'session-test' });
    expect(starts[0].workspaceRoot).toBe('/tmp/nessy-general-agent-test');
    expect(sent[0]).toMatchObject({ type: 'process_start_response', requestId: 'request-1' });

    // Q1.2: a project session's host-owned root is the captured scope primary
    // root, not the managed Workspace root — and never the subprocess value.
    await (first as any).handleProcessStartRequest({
      requestId: 'request-2',
      request: {
        executionId: 'execution-2', semanticId: 'bash', command: '/bin/sh', args: ['-lc', 'true'],
        cwd: '/tmp/nessy-project-root', workspaceRoot: '/malicious', profile: 'workspace', background: false, timeoutMs: 1000,
      },
    });
    expect(starts[1].workspaceRoot).toBe('/tmp/nessy-general-agent-test');
    (first as any).config.filesystemScope = {
      session: { workspaceId: 'ws-test', sessionId: 'session-test' },
      primaryRoot: '/tmp/nessy-project-root',
      cwd: '/tmp/nessy-project-root',
      additionalRoots: [],
      managedExclusions: [],
      generation: 'g1',
    };
    await (first as any).handleProcessStartRequest({
      requestId: 'request-3',
      request: {
        executionId: 'execution-3', semanticId: 'bash', command: '/bin/sh', args: ['-lc', 'true'],
        cwd: '/tmp/nessy-project-root', workspaceRoot: '/malicious', profile: 'workspace', background: false, timeoutMs: 1000,
      },
    });
    expect(starts[2].workspaceRoot).toBe('/tmp/nessy-project-root');
    (first as any).subprocess = null;
    first.destroy();

    const replacement = new PiAgent(createConfig({ processSupervisorPort: port }));
    try {
      const result = await (replacement as any).requestBashOutput('process_0123456789abcdef0123456789abcdef', 0);
      expect(result.output).toBe('survived\n');
    } finally {
      replacement.destroy();
    }
  });

  it('injects only the matched selected plugin runtime and ignores child-supplied env or writable roots', async () => {
    const starts: any[] = [];
    const port = {
      start: async (request: any) => {
        starts.push(request);
        return { handle: 'process_0123456789abcdef0123456789abcdef', output: '', nextCursor: 0, isRunning: false, exitCode: 0, signal: null, isolationProfile: 'workspace:test', ...envBinding };
      },
      write: async () => {},
      read: async () => { throw new Error('unused'); },
      stop: async () => {},
      drainSession: async () => [],
    };
    const agent = new PiAgent(createConfig({ processSupervisorPort: port }));
    const sent: any[] = [];
    const verified: string[] = [];
    (agent as any).subprocess = { stdin: { writable: true, write: (line: string) => sent.push(JSON.parse(line)) } };
    (agent as any).activePluginSkillRuntimes = [{
      pluginInstanceId: 'plugin://greenpt/honey@1.1.0#bundle',
      runtime: {
        rootPath: '/managed/plugin-cache/honey',
        dataPath: '/managed/plugin-data/honey',
        profile: 'codex-plugin-env-v1',
      },
    }];
    (agent as any).capabilityTurnRuntime = {
      materializer: {
        verifyPlugin: async (pluginInstanceId: string) => { verified.push(pluginInstanceId); },
        assertActive() {},
      },
    };

    try {
      await (agent as any).handleProcessStartRequest({
        requestId: 'plugin-process',
        request: {
          executionId: 'execution-plugin', semanticId: 'bash', command: '/bin/sh',
          args: ['-lc', 'node "/managed/plugin-cache/honey/hooks/honey-state.js" set full'],
          cwd: '/tmp/nessy-general-agent-test', workspaceRoot: '/malicious', profile: 'workspace', background: false, timeoutMs: 1000,
          env: { MALICIOUS_CHILD_ENV: 'leak' }, additionalWritableRoots: ['/'], inheritHostEnv: false,
        },
      });
      expect(starts[0].env).toEqual({
        NESSY_PLUGIN_ROOT: '/managed/plugin-cache/honey',
        PLUGIN_ROOT: '/managed/plugin-cache/honey',
        NESSY_PLUGIN_DATA: '/managed/plugin-data/honey',
        PLUGIN_DATA: '/managed/plugin-data/honey',
        CLAUDE_PLUGIN_ROOT: '/managed/plugin-cache/honey',
        CLAUDE_PLUGIN_DATA: '/managed/plugin-data/honey',
        CLAUDE_CONFIG_DIR: '/managed/plugin-data/honey',
        // hooks.md `:707` — "The level is also available to hook commands and
        // the Bash tool as the `$CLAUDE_EFFORT` environment variable." Composed
        // by the same host-owned rebuild, so it rides every supervised start.
        NESSY_EFFORT: 'medium',
        CLAUDE_EFFORT: 'medium',
        ...jobDirEnv,
      });
      expect(starts[0].additionalWritableRoots).toEqual(['/managed/plugin-data/honey']);
      expect(starts[0].inheritHostEnv).toBeUndefined();
      expect(verified).toEqual(['plugin://greenpt/honey@1.1.0#bundle']);

      await (agent as any).handleProcessStartRequest({
        requestId: 'ordinary-process',
        request: {
          executionId: 'execution-ordinary', semanticId: 'bash', command: '/bin/sh', args: ['-lc', 'pwd'],
          cwd: '/tmp/nessy-general-agent-test', workspaceRoot: '/malicious', profile: 'workspace', background: false, timeoutMs: 1000,
          env: { MALICIOUS_CHILD_ENV: 'leak' }, additionalWritableRoots: ['/'], inheritHostEnv: false,
        },
      });
      // No plugin matched and no plugin bin/ PATH to compose, so the ONLY
      // host-added env left is the effort pair and the scratch root — the
      // child's own `env` is still dropped, which is what this arm is about.
      expect(starts[1].env).toEqual({ NESSY_EFFORT: 'medium', CLAUDE_EFFORT: 'medium', ...jobDirEnv });
      expect(starts[1].env).not.toHaveProperty('MALICIOUS_CHILD_ENV');
      expect(starts[1].additionalWritableRoots).toBeUndefined();
      expect(starts[1].inheritHostEnv).toBeUndefined();
      expect(sent.at(-1)).toMatchObject({ type: 'process_start_response', requestId: 'ordinary-process' });

      (agent as any).capabilityTurnRuntime.materializer.verifyPlugin = async () => {
        throw new Error('plugin-bundle-integrity-mismatch');
      };
      await (agent as any).handleProcessStartRequest({
        requestId: 'tampered-plugin-process',
        request: {
          executionId: 'execution-tampered', semanticId: 'bash', command: '/bin/sh',
          args: ['-lc', 'node "/managed/plugin-cache/honey/hooks/honey-state.js" set full'],
          cwd: '/tmp/nessy-general-agent-test', profile: 'workspace', background: false, timeoutMs: 1000,
        },
      });
      expect(starts).toHaveLength(2);
      expect(sent.at(-1)).toMatchObject({
        type: 'process_start_response',
        requestId: 'tampered-plugin-process',
        error: 'plugin-bundle-integrity-mismatch',
      });
    } finally {
      (agent as any).subprocess = null;
      agent.destroy();
    }
  });
});
