/**
 * F1.1241 — no Extended context switch: each Claude model's own window decides.
 *
 * The rule, in `claude-agent.ts` (`resolveClaudeKnownModelWindow` and its two
 * readers): the connection's own entry first (the Models API's
 * `max_input_tokens` on a direct Anthropic list, or a window written on a BYO
 * card), else the registry. A `claude-` id known at 1M or more is sent with its
 * `[1m]` selector; a connection that declares a window below 1M gets that number
 * as `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; the host never emits
 * `CLAUDE_CODE_DISABLE_1M_CONTEXT` itself, and an operator's own export of either
 * vendor name still reaches the child.
 *
 * Owner constraint (2026-10-01): the `[1m]` selector is an internal spawn detail.
 * The model id the app stores and shows stays the bare one, identical across
 * runtimes; only the id handed to the SDK `query()` carries it. The seam tests
 * below drive a real `chatImpl` turn against a faked SDK `query` (the pattern of
 * `claude-settings-file-endpoint.test.ts`) and assert both sides.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk';
import type { BackendConfig } from '../backend/types.ts';

// Snapshot BEFORE mocking, restored in `afterAll` (AGENTS.md §Traps, `mock.module`).
const realSdk = { ...sdkPackage };
const capturedOptions: Record<string, unknown>[] = [];
const capturedEvents: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { options: Record<string, unknown> }) => {
    capturedOptions.push(input.options);
    return (async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        result: 'ok',
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } as never;
    })();
  },
}));

afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk);
});

const {
  ClaudeAgent,
  buildClaudeDeclaredWindowEnv,
  claudeModelWithWindowSelector,
  resolveClaudeKnownModelWindow,
} = await import('../claude-agent.ts');

const OPERATOR_NAMES = ['CLAUDE_CODE_DISABLE_1M_CONTEXT', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'] as const;

/** A connection's model list, the shape the direct Anthropic fetcher writes. */
function connectionWith(...entries: Array<{ id: string; contextWindow?: number }>) {
  return { models: entries.map(entry => ({ name: entry.id, shortName: entry.id, description: '', provider: 'anthropic', ...entry })) } as never;
}

describe('the known window — the connection first, the registry second', () => {
  it('takes the connection entry over the registry, in both directions', () => {
    expect(resolveClaudeKnownModelWindow(connectionWith({ id: 'claude-opus-4-8', contextWindow: 200_000 }), 'claude-opus-4-8')).toBe(200_000);
    // An id the registry has never heard of, sized by the Models API.
    expect(resolveClaudeKnownModelWindow(connectionWith({ id: 'claude-opus-9-9', contextWindow: 1_000_000 }), 'claude-opus-9-9')).toBe(1_000_000);
  });

  it('falls back to the registry, and knows nothing without an id', () => {
    expect(resolveClaudeKnownModelWindow(null, 'claude-opus-4-8')).toBe(1_000_000);
    expect(resolveClaudeKnownModelWindow(connectionWith({ id: 'claude-opus-4-8' }), 'claude-opus-4-8')).toBe(1_000_000);
    expect(resolveClaudeKnownModelWindow(null, 'claude-haiku-4-5-20251001')).toBe(200_000);
    expect(resolveClaudeKnownModelWindow(null, undefined)).toBeUndefined();
  });
});

describe('the [1m] selector', () => {
  it('is appended to a claude- id known at 1M or more', () => {
    expect(claudeModelWithWindowSelector('claude-opus-4-8', 1_000_000)).toBe('claude-opus-4-8[1m]');
    expect(claudeModelWithWindowSelector('claude-opus-9-9', 1_000_000)).toBe('claude-opus-9-9[1m]');
    expect(claudeModelWithWindowSelector('claude-sonnet-4-6', 1_000_000)).toBe('claude-sonnet-4-6[1m]');
  });

  it('is NOT appended below 1M, off the claude- prefix, or twice', () => {
    expect(claudeModelWithWindowSelector('claude-haiku-4-5', 200_000)).toBe('claude-haiku-4-5');
    expect(claudeModelWithWindowSelector('claude-opus-4-8', 200_000)).toBe('claude-opus-4-8');
    expect(claudeModelWithWindowSelector('claude-opus-4-8', undefined)).toBe('claude-opus-4-8');
    // A gateway alias carries its own declared window through the other envs.
    expect(claudeModelWithWindowSelector('coder', 1_000_000)).toBe('coder');
    expect(claudeModelWithWindowSelector('claude-opus-4-8[1m]', 1_000_000)).toBe('claude-opus-4-8[1m]');
  });
});

describe('the declared cap — a connection window below 1M for a claude- id', () => {
  const NO_EXPORT = {} as NodeJS.ProcessEnv;

  it('reaches the SDK as CLAUDE_CODE_AUTO_COMPACT_WINDOW', () => {
    expect(buildClaudeDeclaredWindowEnv(connectionWith({ id: 'claude-opus-4-8', contextWindow: 200_000 }), 'claude-opus-4-8', undefined, NO_EXPORT))
      .toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' });
  });

  it('is absent at 1M, without a declaration, off the prefix, with compaction off, or under an operator export', () => {
    expect(buildClaudeDeclaredWindowEnv(connectionWith({ id: 'claude-opus-4-8', contextWindow: 1_000_000 }), 'claude-opus-4-8', undefined, NO_EXPORT)).toEqual({});
    expect(buildClaudeDeclaredWindowEnv(connectionWith({ id: 'claude-haiku-4-5' }), 'claude-haiku-4-5', undefined, NO_EXPORT)).toEqual({});
    expect(buildClaudeDeclaredWindowEnv(connectionWith({ id: 'coder', contextWindow: 262_144 }), 'coder', undefined, NO_EXPORT)).toEqual({});
    const declared = connectionWith({ id: 'claude-opus-4-8', contextWindow: 200_000 });
    expect(buildClaudeDeclaredWindowEnv(declared, 'claude-opus-4-8', { enabled: false }, NO_EXPORT)).toEqual({});
    expect(buildClaudeDeclaredWindowEnv(declared, 'claude-opus-4-8', undefined, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' })).toEqual({});
  });
});

describe('the chatImpl seam — the selector reaches the SDK, never the stored model', () => {
  let scratch: string;
  const saved: Partial<Record<(typeof OPERATOR_NAMES)[number], string>> = {};

  function agentConfig(model: string): BackendConfig {
    return {
      provider: 'anthropic',
      providerType: 'anthropic',
      model,
      isHeadless: true,
      skipConfigWatcher: true,
      projectTrusted: true,
      // What SessionManager handed every session before F1.1241 by default
      // (`getEnable1MContext()` was `false` unless the switch was turned on).
      // The field no longer exists; it is passed here to prove it decides nothing.
      enable1MContext: false,
      envOverrides: { CLAUDE_CONFIG_DIR: join(scratch, 'claude-config'), ANTHROPIC_API_KEY: 'sk-ant-f1241-fabricated' },
      workspace: {
        id: 'ws-f1241',
        name: 'F1.1241 Workspace',
        rootPath: scratch,
        workspaceRootPath: scratch,
        sessionRootPath: join(scratch, 'sessions'),
      } as never,
      session: {
        id: 'session-f1241',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        workingDirectory: scratch,
      } as never,
    } as unknown as BackendConfig;
  }

  async function runTurn(model: string) {
    const agent = new ClaudeAgent(agentConfig(model));
    const chatImpl = (agent as unknown as { chatImpl: (m: string) => AsyncGenerator<unknown> }).chatImpl.bind(agent);
    for await (const event of chatImpl('hi')) capturedEvents.push(event);
    expect(capturedOptions.length).toBe(1);
    return { agent, options: capturedOptions[0]! };
  }

  beforeEach(() => {
    capturedOptions.length = 0;
    capturedEvents.length = 0;
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1241-')));
    for (const name of OPERATOR_NAMES) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of OPERATOR_NAMES) {
      delete process.env[name];
      if (saved[name] !== undefined) process.env[name] = saved[name];
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  it('a 1M model is sent with [1m] while the stored and shown model stays bare', async () => {
    const { agent, options } = await runTurn('claude-opus-4-8');
    expect(options.model).toBe('claude-opus-4-8[1m]');
    expect(agent.getModel()).toBe('claude-opus-4-8');
    expect(JSON.stringify(capturedEvents)).not.toContain('[1m]');
    expect((options.env as Record<string, string | undefined>).CLAUDE_CODE_DISABLE_1M_CONTEXT).toBeUndefined();
  }, 120_000);

  it('a 200K model is sent as it is', async () => {
    const { agent, options } = await runTurn('claude-haiku-4-5-20251001');
    expect(options.model).toBe('claude-haiku-4-5-20251001');
    expect(agent.getModel()).toBe('claude-haiku-4-5-20251001');
  }, 120_000);

  it('the operator caps reach the child unchanged', async () => {
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1';
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '300000';
    const { options } = await runTurn('claude-opus-4-8');
    const env = options.env as Record<string, string | undefined>;
    expect(env.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe('1');
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('300000');
  }, 120_000);
});
