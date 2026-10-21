/**
 * R87 — component-scoped (skill frontmatter) hooks.
 *
 * hooks.md § Hooks in skills and agents: these hooks "are scoped to the
 * component's lifecycle and only run when that component is active" and are
 * "cleaned up when it finishes". The proving property is the LIFETIME — a hook
 * fires while its skill is active and does NOT fire after the skill leaves the
 * active set — not merely that the config parsed.
 */
import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { CapabilityMaterializationError } from '../materializer.ts';
import type { CapabilitySnapshotMaterializer } from '../materializer.ts';
import type { RuntimeSkillHandle } from '../views.ts';
import {
  createComponentHookLayer,
  materializeRuntimeSkillInvocation,
  parseSkillFrontmatterHooks,
  validateSkillInvocationSnapshot,
  type SkillInvocationRecord,
} from '../runtime-skill-content.ts';
import { parseHooksConfigContent } from '../../automations/hooks-config.ts';
import type { AutomationsConfig } from '../../automations/types.ts';
import { PluginScopedAutomationSystem } from '../../plugins/hooks-automation.ts';

/** A one-line node command hook whose exit code drives the block decision. */
function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

/** A runnable command-hook config in the internal `actions` shape the runtime
 * executes (the same shape `parseSkillFrontmatterHooks` normalizes down to). */
function commandHookConfig(command: string, matcher = 'Bash', event = 'PreToolUse'): AutomationsConfig {
  return parseHooksConfigContent(JSON.stringify({
    automations: { [event]: [{ matcher, actions: [{ type: 'command', command }]}] },
  })).config;
}

/** A minimal active invocation the layer can read — only `key` and
 * `componentHooks` are consulted. */
function activeSkill(key: string, componentHooks: SkillInvocationRecord['componentHooks']): SkillInvocationRecord {
  return { key, componentHooks } as SkillInvocationRecord;
}

const preToolUse = {
  hook_event_name: 'PreToolUse' as const,
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
};

describe('parseSkillFrontmatterHooks', () => {
  it('reads the nested hooks block splitMarkdownFrontmatter leaves opaque', () => {
    const hooks = parseSkillFrontmatterHooks(
      '---\nname: guard\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./check.sh\n---\nbody',
    );
    expect(hooks?.always?.automations.PreToolUse?.length).toBe(1);
    expect(hooks?.once).toBeUndefined();
  });

  it('splits `once: true` hooks into the once tier and out of always', () => {
    const hooks = parseSkillFrontmatterHooks(
      '---\nhooks:\n  SessionStart:\n    - hooks:\n        - type: command\n          command: ./setup.sh\n          once: true\n        - type: command\n          command: ./always.sh\n---\nbody',
    );
    expect(hooks?.once?.automations.SessionStart?.length).toBe(1);
    expect(hooks?.always?.automations.SessionStart?.length).toBe(1);
  });

  it('returns undefined for a skill with no hooks block', () => {
    expect(parseSkillFrontmatterHooks('---\nname: plain\n---\nbody')).toBeUndefined();
    expect(parseSkillFrontmatterHooks('no frontmatter at all')).toBeUndefined();
  });

  it('fails soft on a malformed hooks block rather than throwing', () => {
    // A `hooks` scalar (not a mapping) is ignored — the skill still invokes.
    expect(parseSkillFrontmatterHooks('---\nhooks: not-a-map\n---\nbody')).toBeUndefined();
  });
});

describe('createComponentHookLayer — lifetime', () => {
  const config = commandHookConfig('./check.sh');

  it('surfaces a skill\'s hooks while it is active and nothing after it leaves', () => {
    const active: SkillInvocationRecord[] = [activeSkill('skill:guard', { always: config })];
    const layer = createComponentHookLayer(() => active, new Set());

    // Active: the hook is visible.
    expect(layer.matchersFor('PreToolUse')?.automations.PreToolUse?.length).toBe(1);
    expect(layer.hasMatchers('PreToolUse')).toBe(true);

    // Finished: the record left the set, so the LIVE read finds nothing. This is
    // the whole point — a snapshot taken at build time would still report it.
    active.length = 0;
    expect(layer.matchersFor('PreToolUse')).toBeUndefined();
    expect(layer.hasMatchers('PreToolUse')).toBe(false);
  });

  it('merges hooks across every active skill', () => {
    const active = [
      activeSkill('skill:a', { always: commandHookConfig('./a.sh', 'Bash') }),
      activeSkill('skill:b', { always: commandHookConfig('./b.sh', 'Read') }),
    ];
    const layer = createComponentHookLayer(() => active, new Set());
    expect(layer.matchersFor('PreToolUse')?.automations.PreToolUse?.length).toBe(2);
  });

  it('has no skill source of its own — an unadmitted skill contributes nothing (trust reuse)', () => {
    // The workspace-trust gate lives UPSTREAM, at capability admission:
    // `views.ts` `isRunnable` drops a `review-required`/`blocked` skill from the
    // runtime view, so an untrusted project skill is never invoked and never
    // reaches `activeSkillInvocations`. The layer reuses that gate by having no
    // independent skill source — a skill that declares hooks but was not
    // admitted (here, simply absent from the active set) runs nothing, so a
    // project hook cannot fire before the folder is trusted.
    const declaredButUnadmitted = activeSkill('skill:untrusted', { always: commandHookConfig('./danger.sh') });
    void declaredButUnadmitted; // it exists on disk with hooks, but is not admitted
    const layer = createComponentHookLayer(() => [], new Set());
    expect(layer.matchersFor('PreToolUse')).toBeUndefined();
    expect(layer.hasMatchers('PreToolUse')).toBe(false);
  });

  it('drops a consumed `once` hook without touching the always tier', () => {
    const consumed = new Set<string>();
    const active = [activeSkill('skill:guard', {
      always: commandHookConfig('./always.sh'),
      once: commandHookConfig('./once.sh'),
    })];
    const layer = createComponentHookLayer(() => active, consumed);

    expect(layer.onceMatchersFor('PreToolUse')?.automations.PreToolUse?.length).toBe(1);
    layer.consumeOnce('PreToolUse');
    expect(layer.onceMatchersFor('PreToolUse')).toBeUndefined();
    // The always tier keeps firing.
    expect(layer.matchersFor('PreToolUse')?.automations.PreToolUse?.length).toBe(1);
  });
});

describe('component hook dispatch through the automation chain', () => {
  function systemFor(active: SkillInvocationRecord[], consumed = new Set<string>()) {
    const layer = createComponentHookLayer(() => active, consumed);
    return new PluginScopedAutomationSystem({
      pluginHookConfig: { automations: {} },
      workspaceRootPath: process.cwd(),
      allowDirectCommandRunner: true,
      componentHookLayer: () => layer,
    });
  }

  it('runs an active skill\'s command hook and blocks on non-zero exit', async () => {
    const active = [activeSkill('skill:guard', { always: commandHookConfig(nodeCommand('process.exit(1)')) })];
    const system = systemFor(active);

    const decision = await system.executeAgentEvent('PreToolUse', preToolUse);
    expect(decision.decision?.decision).toBe('block');

    // Gone after finish: the same event dispatched after the skill left the set
    // runs no hook, so there is no decision at all.
    active.length = 0;
    const after = await system.executeAgentEvent('PreToolUse', preToolUse);
    expect(after.decision).toBeUndefined();
    expect(after.matchedCount).toBe(0);
  }, 15_000);

  /**
   * P6.292 — this case used to assert the OPPOSITE, and the opposite is the
   * divergence. `hooks.md` §Common fields, `once`, verbatim: "If `true`, Claude
   * Code removes the hook after its first successful run. A run that fails,
   * blocks with exit code 2, or times out leaves the hook in place, so it runs
   * again on the next matching event." A `process.exit(1)` hook is a run that
   * FAILED, so consuming it silently disarmed the guard the user wrote.
   */
  it('does NOT consume a `once` hook whose run failed with a non-zero exit', async () => {
    const active = [activeSkill('skill:guard', { once: commandHookConfig(nodeCommand('process.exit(1)')) })];
    const system = systemFor(active);

    const first = await system.executeAgentEvent('PreToolUse', preToolUse);
    expect(first.decision?.decision).toBe('block');

    // Still in place: it runs again on the next matching event.
    const second = await system.executeAgentEvent('PreToolUse', preToolUse);
    expect(second.matchedCount).toBe(1);
    expect(second.decision?.decision).toBe('block');
  }, 15_000);

  /**
   * The remaining three outcomes are driven through an INJECTED runner rather
   * than real subprocesses. Each real `node -e` spawn costs this suite a
   * process, and the outcome under test — exit 2, exit 0, a timeout — is a
   * property of the execution authority's RESULT, which is exactly what a
   * runner supplies. The case above keeps one real spawn so the wiring itself
   * is still exercised end to end.
   */
  const systemWithRunnerResult = (
    active: SkillInvocationRecord[],
    result: { success: boolean; exitCode: number | null; timedOut?: boolean },
  ) => {
    const layer = createComponentHookLayer(() => active, new Set<string>());
    return new PluginScopedAutomationSystem({
      pluginHookConfig: { automations: {} },
      workspaceRootPath: process.cwd(),
      componentHookLayer: () => layer,
      pluginCommandRunner: async (action) => ({
        type: 'command' as const,
        command: action.command,
        signal: result.timedOut ? 'SIGTERM' : null,
        durationMs: 1,
        ...result,
      }),
    });
  };

  it('does NOT consume a `once` hook that exited 2', async () => {
    const active = [activeSkill('skill:guard', { once: commandHookConfig('./blocker.sh') })];
    const system = systemWithRunnerResult(active, { success: false, exitCode: 2 });

    expect((await system.executeAgentEvent('PreToolUse', preToolUse)).matchedCount).toBe(1);
    expect((await system.executeAgentEvent('PreToolUse', preToolUse)).matchedCount).toBe(1);
  });

  it('does NOT consume a `once` hook that timed out', async () => {
    const active = [activeSkill('skill:guard', { once: commandHookConfig('./slow.sh') })];
    const system = systemWithRunnerResult(active, { success: false, exitCode: null, timedOut: true });

    expect((await system.executeAgentEvent('PreToolUse', preToolUse)).matchedCount).toBe(1);
    expect((await system.executeAgentEvent('PreToolUse', preToolUse)).matchedCount).toBe(1);
  });

  it('consumes a `once` hook whose run SUCCEEDED', async () => {
    const active = [activeSkill('skill:guard', { once: commandHookConfig('./ok.sh') })];
    const system = systemWithRunnerResult(active, { success: true, exitCode: 0 });

    expect((await system.executeAgentEvent('PreToolUse', preToolUse)).matchedCount).toBe(1);
    // Consumed — the second dispatch of the same event runs nothing.
    const second = await system.executeAgentEvent('PreToolUse', preToolUse);
    expect(second.decision).toBeUndefined();
    expect(second.matchedCount).toBe(0);
  });

  it('folds the component layer into the merged result (narrowest scope, last)', async () => {
    const active = [activeSkill('skill:guard', {
      always: commandHookConfig(nodeCommand(
        'console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:"from-skill"}}))',
      )),
    })];
    const system = systemFor(active);
    const result = await system.executeAgentEvent('PreToolUse', preToolUse);
    expect(result.matchedCount).toBe(1);
    expect(result.decision?.additionalContext).toContain('from-skill');
  }, 15_000);
});

/**
 * P6.59 — the SAME layer, reached through `buildSdkHooks`.
 *
 * The direct chain above is not the route the anthropic backend takes for any
 * event but `PreToolUse`: `mergeClaudeSdkHooks` drops the trusted `PreToolUse`
 * bucket so that one event runs through `runClaudePreToolUseHookPipeline` →
 * `executeAgentEvent`, and everything else is registered with the SDK by
 * `buildSdkHooks`. That builder read the four config tiers and never the
 * component layer, so a skill's frontmatter `PostToolUse` hook was unreachable
 * there — which is why these cases use `PostToolUse` and not `PreToolUse`.
 */
describe('component hook dispatch through the SDK hooks path (P6.59)', () => {
  const postToolUse = {
    hook_event_name: 'PostToolUse' as const,
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_response: 'ok',
  };
  /** stdout-JSON block, the shape a PostToolUse hook uses to speak. */
  const blockingHook = (reason: string) => commandHookConfig(
    nodeCommand(`process.stdout.write(JSON.stringify({decision:"block",reason:${JSON.stringify(reason)}}))`),
    'Bash',
    'PostToolUse',
  );

  function systemFor(active: SkillInvocationRecord[], consumed = new Set<string>()) {
    const layer = createComponentHookLayer(() => active, consumed);
    // No native/user/project/plugin config at all, so every matcher
    // `buildSdkHooks` returns can only have come from the component layer.
    return new PluginScopedAutomationSystem({
      pluginHookConfig: { automations: {} },
      workspaceRootPath: process.cwd(),
      allowDirectCommandRunner: true,
      componentHookLayer: () => layer,
    });
  }

  const dispatch = (system: PluginScopedAutomationSystem) => {
    const matchers = system.buildSdkHooks().PostToolUse ?? [];
    expect(matchers).toHaveLength(1);
    return matchers[0]!.hooks[0]!(postToolUse as never, 'tool-1', {});
  };

  it("registers and runs an active skill's frontmatter PostToolUse hook", async () => {
    const system = systemFor([activeSkill('skill:guard', { always: blockingHook('skill says no') })]);
    await expect(dispatch(system)).resolves.toEqual({
      // `hookBlockEndsTurn('PostToolUse')` is false: the reason rides next to
      // the tool result and the conversation continues.
      continue: true,
      decision: 'block',
      reason: 'skill says no',
    });
  }, 15_000);

  it('registers nothing when no component hook is active', () => {
    expect(systemFor([]).buildSdkHooks()).toEqual({});
  });

  it('re-reads the layer at dispatch, so a finished skill runs nothing', async () => {
    const active = [activeSkill('skill:guard', { always: blockingHook('skill says no') })];
    const system = systemFor(active);
    // Registered while the skill was active — the SDK holds this callback for
    // the whole query.
    const matchers = system.buildSdkHooks().PostToolUse ?? [];
    expect(matchers).toHaveLength(1);
    // "cleaned up when it finishes": the callback resolves the layer itself, so
    // the skill leaving the active set is enough. A callback that had captured
    // the config would still block here.
    active.length = 0;
    await expect(matchers[0]!.hooks[0]!(postToolUse as never, 'tool-1', {})).resolves.toEqual({ continue: true });
  }, 15_000);

  it('honours `once` on the SDK path, consuming it exactly once', async () => {
    const system = systemFor([activeSkill('skill:guard', { once: blockingHook('one shot') })]);
    const matchers = system.buildSdkHooks().PostToolUse ?? [];
    expect(matchers).toHaveLength(1);
    await expect(matchers[0]!.hooks[0]!(postToolUse as never, 'tool-1', {})).resolves.toEqual({
      continue: true,
      decision: 'block',
      reason: 'one shot',
    });
    await expect(matchers[0]!.hooks[0]!(postToolUse as never, 'tool-1', {})).resolves.toEqual({ continue: true });
  }, 15_000);
});

// ── Persistence: a skill invoked with hooks survives the snapshot digest. ──

function materializer(content: string, skillDirectory = '/skills/guard'): CapabilitySnapshotMaterializer {
  return {
    assertActive() {},
    async verifyPlugin() {},
    async resolvePath() { return `${skillDirectory}/SKILL.md`; },
    async resolveSkillDirectory() { return skillDirectory; },
    async readText() { return content; },
    async readRelativeText() { throw new Error('no supporting resources'); },
    resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
  } as unknown as CapabilitySnapshotMaterializer;
}

describe('componentHooks persistence', () => {
  const handle: RuntimeSkillHandle = {
    key: 'skill:native:guard',
    logicalName: 'guard',
    description: '',
    selectedAsUnqualifiedAlias: true,
    resource: {
      source: 'managed-global',
      scope: { kind: 'global' },
      resourceId: 'skill:native:guard',
      absolutePath: '/skills/guard/SKILL.md',
      revision: '1',
      contentHash: 'a'.repeat(64),
    },
  };

  it('materializes hooks onto the record and round-trips through the digest', async () => {
    const content = '---\nname: guard\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./check.sh\n---\nGuard the shell.';
    const invocation = await materializeRuntimeSkillInvocation({
      materializer: materializer(content),
      skill: handle,
      generation: 'generation-1',
      invokedAt: 1,
    });
    expect(invocation.componentHooks?.always?.automations.PreToolUse?.length).toBe(1);

    // The stored snapshot validates against its own digest — the field is part
    // of the record's identity, so a skill active across a restart keeps it.
    const restored = validateSkillInvocationSnapshot(JSON.parse(JSON.stringify(invocation)), {
      key: handle.key,
      sourceDigest: handle.resource.contentHash,
      generation: 'generation-1',
    });
    expect(restored.componentHooks?.always?.automations.PreToolUse?.length).toBe(1);
    expect(restored.invocationDigest).toBe(invocation.invocationDigest);
  });

  it('leaves the digest unchanged for a skill with no hooks (back-compat)', async () => {
    const invocation = await materializeRuntimeSkillInvocation({
      materializer: materializer('---\nname: plain\n---\nNo hooks here.'),
      skill: handle,
      generation: 'generation-1',
      invokedAt: 1,
    });
    expect(invocation.componentHooks).toBeUndefined();
    // A record without the field must not carry the key at all.
    expect('componentHooks' in invocation).toBe(false);
  });
});

/**
 * C3.334 — a frontmatter `async` hook is a BACKGROUND hook, and until
 * 2026-09-12 it was not one: `frontmatterHookToAction` destructured `async` and
 * `asyncRewake` out of the action and `HookCommandActionSchema` declared
 * neither, so the flags could not survive either gate and the hook blocked its
 * event.
 *
 * `hooks.md#hooks-in-skills-and-agents`, verbatim: *"hooks can be defined
 * directly in skills and subagents using frontmatter, in the same configuration
 * format as settings-based hooks"*. `hooks.md#run-hooks-in-the-background`:
 * *"Async hooks can't block or control Claude's behavior"* — which is the
 * property these cases prove, not the parse.
 */
describe('frontmatter `async` hooks (C3.334)', () => {
  /** One `PreToolUse` command hook; `extra` adds fields at the hook's own indent. */
  const frontmatter = (extra: string) =>
    `---\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./slow.sh\n${extra}---\nbody`;

  const firstAction = (content: string): Record<string, unknown> | undefined =>
    parseSkillFrontmatterHooks(content)?.always?.automations.PreToolUse?.[0]?.actions[0] as
      Record<string, unknown> | undefined;

  it('carries `async` and `asyncRewake` onto the action rather than stripping them', () => {
    const action = firstAction(frontmatter('          async: true\n          asyncRewake: true\n'));
    expect(action?.async).toBe(true);
    expect(action?.asyncRewake).toBe(true);
  });

  it('leaves a hook that declared neither carrying neither (the control)', () => {
    const action = firstAction(frontmatter(''));
    // The action itself still parsed — the control is about the two keys, not
    // about the hook surviving.
    expect(action?.command).toBe('./slow.sh');
    expect('async' in (action ?? {})).toBe(false);
    expect('asyncRewake' in (action ?? {})).toBe(false);
  });

  /**
   * A runner that never settles while the event is dispatched: an executor that
   * awaited it could not return at all, so the assertion cannot pass by luck.
   */
  function systemWithDeferredRunner(active: SkillInvocationRecord[]) {
    const layer = createComponentHookLayer(() => active, new Set<string>());
    const state: { started: number; release?: () => void } = { started: 0 };
    const system = new PluginScopedAutomationSystem({
      pluginHookConfig: { automations: {} },
      workspaceRootPath: process.cwd(),
      componentHookLayer: () => layer,
      pluginCommandRunner: async (action) => {
        state.started += 1;
        await new Promise<void>(resolve => { state.release = resolve; });
        return {
          type: 'command' as const,
          command: action.command,
          success: false,
          exitCode: 2,
          signal: null,
          durationMs: 1,
        };
      },
    });
    return { system, state };
  }

  it('runs an `async` frontmatter hook in the background instead of blocking the event', async () => {
    const active = [activeSkill('skill:guard', parseSkillFrontmatterHooks(frontmatter('          async: true\n')))];
    const { system, state } = systemWithDeferredRunner(active);

    const result = await system.executeAgentEvent('PreToolUse', preToolUse);

    // It RAN — a background hook that never started would satisfy "did not
    // block" vacuously.
    expect(state.started).toBe(1);
    expect(result.matchedCount).toBe(1);
    // ...and it could not decide: exit 2 from a background hook is not a block.
    expect(result.decision).toBeUndefined();
    state.release?.();
  });

  it('the SAME hook without `async` blocks on the same exit code (the control)', async () => {
    const active = [activeSkill('skill:guard', parseSkillFrontmatterHooks(frontmatter('')))];
    const layer = createComponentHookLayer(() => active, new Set<string>());
    const system = new PluginScopedAutomationSystem({
      pluginHookConfig: { automations: {} },
      workspaceRootPath: process.cwd(),
      componentHookLayer: () => layer,
      pluginCommandRunner: async (action) => ({
        type: 'command' as const,
        command: action.command,
        success: false,
        exitCode: 2,
        signal: null,
        durationMs: 1,
      }),
    });

    const result = await system.executeAgentEvent('PreToolUse', preToolUse);
    expect(result.decision?.decision).toBe('block');
  });
});
