/**
 * C4.11 (QG4, owner answer B, 2026-09-11) — `$CLAUDE_EFFORT`/`$NESSY_EFFORT`
 * reach codex's shell children through codex's OWN `shell_environment_policy`.
 *
 * `hooks.md` § Hook input, the `effort` field, verbatim: *"The level is also
 * available to hook commands and the Bash tool as the `$CLAUDE_EFFORT`
 * environment variable."* Pi exports the pair on every supervised child start
 * (`pi-agent.ts`'s `childEnvironment`, pinned by `plugin-bin-path.test.ts`) and
 * the host hook runner exports it for all three
 * (`automations/hook-command.ts`). codex's TOOL children got NOTHING, so one
 * documented variable resolved on two runtimes out of three — the silent
 * divergence the native-first rule exists to end, not a gap.
 *
 * Nothing is BUILT here: `buildCodexRuntimeConfigOverride` already emits
 * `{ shell_environment_policy: { set: <this map> } }`, and `buildCodexConfigToml`
 * already writes `[shell_environment_policy.set]`. Two more entries in a map the
 * host writes.
 *
 * ## What each case kills
 *
 * - the two-exit pair, because `resolveSelectedPluginSkillRuntimePolicy` has two
 *   returns and P6.415 was a bug in BOTH: a test through one exit passes over a
 *   fix missing from the other;
 * - the `off` negative, because a defaulted level is the failure mode the shared
 *   resolver exists to prevent — Nessy's sixth level sends no effort parameter
 *   at all, so there is no level to name and BOTH names stay unset;
 * - the plugin-precedence case, because the pair is SPREAD over the plugin env
 *   rather than merged through `mergeEnvironment`: a bundle exporting the same
 *   name must not throw `plugin-skill-runtime-environment-ambiguous` and fail a
 *   turn over an informational variable;
 * - the READ-PER-TURN case, because the level moves mid-session
 *   (`setThinkingLevel`, and an invoked skill overrides it for one turn) while
 *   the agent lives on — a value cached at construction would be stale exactly
 *   when it matters.
 */
import { describe, expect, it } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-c411',
      name: 'Effort Env Workspace',
      rootPath: '/tmp/nessy-c411-ws',
      workspaceRootPath: '/tmp/nessy-c411-ws',
      sessionRootPath: '/tmp/nessy-c411-sessions/ws-c411',
    } as any,
    session: {
      id: 'session-c411',
      workspaceRootPath: '/tmp/nessy-c411-ws',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/nessy-c411-project',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

/**
 * The policy map for a session, optionally with a pinned plugin skill runtime
 * (the second exit) and an extra plugin-supplied environment entry.
 */
function policy(options: {
  pinSkillRuntime?: boolean;
  pluginEnvironment?: Record<string, string>;
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
} = {}): { agent: CodexAgent; environment: Record<string, string> } {
  const agent = new CodexAgent(createConfig());
  if (options.thinkingLevel) agent.setThinkingLevel(options.thinkingLevel);
  (agent as any).capabilityTurnRuntime = { view: { skills: [] } };
  if (options.pinSkillRuntime) {
    (agent as any).activePluginSkillRuntimes = [{
      runtime: {
        profile: 'generic-plugin-env-v1',
        rootPath: '/private/nessy/plugins/demo',
        dataPath: '/private/nessy/plugin-data/demo',
      },
    }];
    (agent as any).config.pluginNodeRuntime = {
      command: '/opt/nessy/bun',
      nodeShimDirectory: '/opt/nessy/shim',
      environment: options.pluginEnvironment ?? {},
    };
  }
  const resolved = (agent as any).resolveSelectedPluginSkillRuntimePolicy() as {
    environment: Record<string, string>;
  };
  return { agent, environment: resolved.environment };
}

describe('C4.11 — the effort pair on codex shell children', () => {
  it('rides the NO-skill exit, where most turns leave', () => {
    expect(policy().environment).toMatchObject({ NESSY_EFFORT: 'medium', CLAUDE_EFFORT: 'medium' });
  });

  it('rides the pinned-skill exit too, beside the plugin aliases', () => {
    const { environment } = policy({ pinSkillRuntime: true });

    expect(environment).toMatchObject({ NESSY_EFFORT: 'medium', CLAUDE_EFFORT: 'medium' });
    // The plugin layer is untouched — this adds to that map, it does not replace
    // it. `NESSY_BUN` and the shim PATH are the two this exit always builds
    // (which alias names a profile contributes is `pluginRuntimeEnvForProfile`'s
    // business and `codex-plugin-bin-path.test.ts`'s).
    expect(environment.NESSY_BUN).toBe('/opt/nessy/bun');
    expect(environment.PATH?.startsWith('/opt/nessy/shim')).toBe(true);
  });

  it('withholds BOTH names at Nessy `off` — the negative that must never default', () => {
    const { environment } = policy({ thinkingLevel: 'off' });

    expect(environment).not.toHaveProperty('NESSY_EFFORT');
    expect(environment).not.toHaveProperty('CLAUDE_EFFORT');
  });

  it('lets the HOST value win over a plugin that exports the same name', () => {
    // Read into a local first: `toMatchObject` with a matcher would overwrite
    // the field (AGENTS.md §Traps), and this case is about the VALUE.
    const { environment } = policy({
      pinSkillRuntime: true,
      pluginEnvironment: { CLAUDE_EFFORT: 'from-the-bundle' },
    });
    const claudeEffort = environment.CLAUDE_EFFORT;

    // Neither a throw (`plugin-skill-runtime-environment-ambiguous`) nor the
    // bundle's value: the level is the session's.
    expect(claudeEffort).toBe('medium');
  });

  it('is read PER TURN, so a mid-session level change takes effect', () => {
    const { agent, environment: before } = policy();
    expect(before.CLAUDE_EFFORT).toBe('medium');

    agent.setThinkingLevel('high');
    const after = ((agent as any).resolveSelectedPluginSkillRuntimePolicy() as {
      environment: Record<string, string>;
    }).environment;

    expect(after.CLAUDE_EFFORT).toBe('high');
    expect(after.NESSY_EFFORT).toBe('high');
  });
});
