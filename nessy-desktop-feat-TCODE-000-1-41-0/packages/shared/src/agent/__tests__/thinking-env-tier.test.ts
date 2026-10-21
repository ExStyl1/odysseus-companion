/**
 * P6.30 — the documented thinking ENVIRONMENT tier.
 *
 * `model-config.md#set-the-effort-level` ranks the ways effort can be set:
 * "The environment variable takes precedence over all other methods, then your
 * configured level, then the model default. Frontmatter effort applies when
 * that skill or subagent is active, overriding the session level but not the
 * environment variable." `model-config.md#extended-thinking` adds the off
 * switch: "Disable regardless of effort: Set `MAX_THINKING_TOKENS=0` …".
 *
 * This host implemented every tier of that sentence except the top one. The
 * variables ARRIVE everywhere — `buildClaudeSubprocessEnv` and
 * `buildPiSubprocessEnv` both spread `process.env`, and the codex child inherits
 * it — and were read only by the vendored `claude` binary, so one exported
 * variable meant three different things depending on the runtime a session
 * happened to be on. Native-first measurements behind that claim, each with a
 * positive and a negative control, are in `thinking-levels.ts`'s own header.
 *
 * Two halves are asserted here:
 *  - the RESOLVER, which is pure and table-testable;
 *  - the ENFORCEMENT, which lives one layer up in `BaseAgent.setThinkingLevel`
 *    precisely so that "all other methods" covers writers that never touch
 *    `resolveEffortLevel`.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  DEFAULT_THINKING_LEVEL,
  EFFORT_LEVEL_ENV_VAR,
  MAX_THINKING_TOKENS_ENV_VAR,
  environmentThinkingOverride,
  environmentThinkingOverrideRejection,
} from '../thinking-levels.ts';
import { CodexAgent } from '../codex-agent.ts';
import { codexDriver } from '../backend/internal/drivers/codex.ts';
import type { BackendConfig } from '../backend/types.ts';

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';
/** A model the `:453` default table names, so `auto` has something to resolve to. */
const OPUS_47 = 'claude-opus-4-7';

const TOUCHED = [EFFORT_LEVEL_ENV_VAR, MAX_THINKING_TOKENS_ENV_VAR] as const;
const saved = new Map<string, string | undefined>(TOUCHED.map(key => [key, process.env[key]]));

afterEach(() => {
  for (const key of TOUCHED) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('environmentThinkingOverride — the resolver', () => {
  it('pins nothing when neither variable is set', () => {
    // THE BASELINE THAT MATTERS: on a machine with neither variable exported the
    // answer must be `undefined`, so every session behaves exactly as it did
    // before this tier existed.
    expect(environmentThinkingOverride(MODEL, {})).toBeUndefined();
    expect(environmentThinkingOverrideRejection({})).toBeUndefined();
  });

  it('honours a level name', () => {
    const override = environmentThinkingOverride(MODEL, { [EFFORT_LEVEL_ENV_VAR]: 'xhigh' });
    expect(override?.level).toBe('xhigh');
    expect(override?.variable).toBe(EFFORT_LEVEL_ENV_VAR);
  });

  it('resolves `auto` to the model default, and to the app default for an unlisted model', () => {
    // `#set-the-effort-level`: "set `CLAUDE_CODE_EFFORT_LEVEL` to a level name or
    // `auto`", and the precedence sentence ends "… then the model default".
    expect(environmentThinkingOverride(OPUS_47, { [EFFORT_LEVEL_ENV_VAR]: 'auto' })?.level).toBe('xhigh');
    // Every dynamically discovered gateway model is absent from that table, and
    // absence must not read as "no reasoning".
    expect(environmentThinkingOverride(MODEL, { [EFFORT_LEVEL_ENV_VAR]: 'AUTO' })?.level)
      .toBe(DEFAULT_THINKING_LEVEL);
  });

  it('BOUNDARY — MAX_THINKING_TOKENS=0 turns thinking off and outranks a set level', () => {
    // "Disable regardless of effort" is a ranking, not a sibling: the two
    // variables set together must not race.
    const override = environmentThinkingOverride(MODEL, {
      [EFFORT_LEVEL_ENV_VAR]: 'max',
      [MAX_THINKING_TOKENS_ENV_VAR]: '0',
    });
    expect(override?.level).toBe('off');
    expect(override?.variable).toBe(MAX_THINKING_TOKENS_ENV_VAR);
  });

  it('NEGATIVE CONTROL — a non-zero MAX_THINKING_TOKENS pins nothing', () => {
    // The page gives other values a meaning only "with a fixed thinking budget",
    // a mode this host does not expose. Reinterpreting 8000 as a level would be
    // inventing one.
    expect(environmentThinkingOverride(MODEL, { [MAX_THINKING_TOKENS_ENV_VAR]: '8000' })).toBeUndefined();
  });

  it('NEGATIVE CONTROL — an unrecognised level pins nothing, and says so out loud', () => {
    const env = { [EFFORT_LEVEL_ENV_VAR]: 'ultracode' };
    expect(environmentThinkingOverride(MODEL, env)).toBeUndefined();
    // Ignored is not the same as silent: the whole row is about a control that
    // stops controlling with no diagnostic anywhere.
    const rejection = environmentThinkingOverrideRejection(env);
    expect(rejection).toContain('ultracode');
    expect(rejection).toContain('auto');
  });
});

function agentConfig(thinkingLevel: string): BackendConfig {
  return {
    provider: 'codex-runtime',
    providerType: 'codex-runtime',
    model: MODEL,
    isHeadless: true,
    thinkingLevel,
    workspace: {
      id: 'ws-thinking-env-tier',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-thinking-env-tier',
      workspaceRootPath: '/tmp/ws-thinking-env-tier',
      sessionRootPath: '/tmp/ws-thinking-env-tier/sessions',
    } as never,
    session: {
      id: 'session-thinking-env-tier',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/ws-thinking-env-tier',
    } as never,
    runtime: codexDriver.buildRuntime({
      context: {
        connection: null,
        provider: 'codex-runtime',
        resolvedModel: MODEL,
        capabilities: { needsHttpPoolServer: false },
      },
      coreConfig: {} as never,
      hostRuntime: {} as never,
      resolvedPaths: { codexBinaryPath: '/fake/codex-app-server' } as never,
    }),
  } as unknown as BackendConfig;
}

describe('BaseAgent — the environment outranks every other writer of the level', () => {
  it('NEGATIVE CONTROL — with the variables unset the configured level stands and moves', () => {
    // The half that makes the two below mean something. Without it, an agent
    // that hard-pinned `low` for unrelated reasons would satisfy them.
    const agent = new CodexAgent(agentConfig('max'));
    try {
      expect(agent.getThinkingLevel()).toBe('max');
      agent.setThinkingLevel('low');
      expect(agent.getThinkingLevel()).toBe('low');
    } finally {
      agent.destroy();
    }
  });

  it('pins the level at construction, over the configured one', () => {
    process.env[EFFORT_LEVEL_ENV_VAR] = 'low';
    const agent = new CodexAgent(agentConfig('max'));
    try {
      expect(agent.getThinkingLevel()).toBe('low');
    } finally {
      agent.destroy();
    }
  });

  it('keeps the pin against every later writer, which is what "all other methods" means', () => {
    process.env[EFFORT_LEVEL_ENV_VAR] = 'low';
    const agent = new CodexAgent(agentConfig('medium'));
    try {
      // `/effort`, a restored session, a skill's frontmatter and a subagent's
      // all reach the agent through this one setter.
      agent.setThinkingLevel('max');
      expect(agent.getThinkingLevel()).toBe('low');
    } finally {
      agent.destroy();
    }
  });

  it('MAX_THINKING_TOKENS=0 reaches the agent as `off`', () => {
    process.env[MAX_THINKING_TOKENS_ENV_VAR] = '0';
    const agent = new CodexAgent(agentConfig('high'));
    try {
      expect(agent.getThinkingLevel()).toBe('off');
      agent.setThinkingLevel('xhigh');
      expect(agent.getThinkingLevel()).toBe('off');
    } finally {
      agent.destroy();
    }
  });
});
