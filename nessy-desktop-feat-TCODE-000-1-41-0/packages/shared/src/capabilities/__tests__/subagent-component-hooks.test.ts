/**
 * R87b — SUBAGENT frontmatter hooks (`sub-agents.md` § *Hooks in subagent
 * frontmatter*).
 *
 * The proving properties, in the order the unit was scoped:
 *  1. a subagent's `PreToolUse` hook runs while that subagent is active and NOT
 *     after it finishes;
 *  2. a `Stop` in agent frontmatter fires as `SubagentStop` when the child
 *     returns, and only for THAT child;
 *  3. a project-level agent from an untrusted folder still RUNS, with its hooks
 *     skipped and the reason reported;
 *  4. a user-level agent's hooks run with no trust step;
 *  5. a skill's `Stop` still stays `Stop` — R87's rule is not broken by the
 *     new conversion.
 */
import { describe, expect, it } from 'bun:test';
import type { CapabilitySnapshotMaterializer } from '../materializer.ts';
import type { AgentRuntimeView } from '../views.ts';
import {
  combineComponentHookLayers,
  createConfigComponentHookLayer,
  createSubagentParentComponentHookLayer,
  parseSubagentFrontmatterHooks,
  staticSubagentComponentHooks,
  type SubagentComponentHooks,
} from '../component-hooks.ts';
import { parseSkillFrontmatterHooks } from '../runtime-skill-content.ts';
import {
  materializePiRuntimeAgentDefinitions,
  parsePiRuntimeAgentDefinitions,
  subagentHookScope,
} from '../../agent/pi-harness/runtime-agent-definition.ts';
import type { AutomationsConfig } from '../../automations/types.ts';
import { PluginScopedAutomationSystem } from '../../plugins/hooks-automation.ts';

/** A one-line node command hook whose exit code drives the block decision. */
function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

const BLOCKING = nodeCommand('process.exit(1)');

function agentMarkdown(hooksBlock: string): string {
  return `---\nname: reviewer\ndescription: Review code\n${hooksBlock}---\nReviewer instructions.`;
}

const HOOKS_BLOCK = [
  'hooks:',
  '  PreToolUse:',
  '    - matcher: Bash',
  `      hooks:`,
  '        - type: command',
  `          command: ${JSON.stringify(BLOCKING)}`,
  '  Stop:',
  '    - hooks:',
  '        - type: command',
  `          command: ${JSON.stringify(BLOCKING)}`,
  '',
].join('\n');

const preToolUse = {
  hook_event_name: 'PreToolUse' as const,
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
};

function subagentStop(agentId: string) {
  return { hook_event_name: 'SubagentStop' as const, agent_id: agentId, agent_type: 'reviewer' };
}

// ── Parse: the two documented differences from the skill rule ───────────────

describe('parseSubagentFrontmatterHooks', () => {
  it('converts a frontmatter `Stop` to `SubagentStop` and routes it to the parent tier', () => {
    const hooks = parseSubagentFrontmatterHooks(agentMarkdown(HOOKS_BLOCK));
    // "`Stop` — When the subagent finishes (converted to `SubagentStop` at
    // runtime)". Parent-side, because that is the session that emits it.
    expect(hooks?.parent?.automations.SubagentStop?.length).toBe(1);
    expect(hooks?.parent?.automations.Stop).toBeUndefined();
    // "`PreToolUse` — Before the subagent uses a tool": the child's own session.
    expect(hooks?.child?.automations.PreToolUse?.length).toBe(1);
    expect(hooks?.child?.automations.SubagentStop).toBeUndefined();
  });

  it('ignores `once` in agent frontmatter — the hook still runs on every match', () => {
    // hooks.md, the `once` field: "Only honored for hooks declared in skill
    // frontmatter; ignored in settings files and agent frontmatter."
    const hooks = parseSubagentFrontmatterHooks(
      '---\nhooks:\n  PreToolUse:\n    - hooks:\n        - type: command\n          command: ./setup.sh\n          once: true\n---\nbody',
    );
    expect(hooks?.child?.automations.PreToolUse?.length).toBe(1);
    // No once tier exists at all for a subagent, so nothing can consume it.
    const layer = createConfigComponentHookLayer(() => hooks?.child);
    expect(layer.onceMatchersFor('PreToolUse')).toBeUndefined();
    expect(layer.matchersFor('PreToolUse')?.automations.PreToolUse?.length).toBe(1);
  });

  it('leaves R87 alone: a SKILL\'s `Stop` stays `Stop`', () => {
    const skillStop = '---\nhooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: ./done.sh\n---\nbody';
    const skill = parseSkillFrontmatterHooks(skillStop);
    expect(skill?.always?.automations.Stop?.length).toBe(1);
    expect(skill?.always?.automations.SubagentStop).toBeUndefined();
    // The same file read as a SUBAGENT converts. The conversion is the
    // component's, not the file's.
    expect(parseSubagentFrontmatterHooks(skillStop)?.parent?.automations.SubagentStop?.length).toBe(1);
  });

  it('returns undefined with no hooks block and fails soft on a malformed one', () => {
    expect(parseSubagentFrontmatterHooks('---\nname: plain\n---\nbody')).toBeUndefined();
    expect(parseSubagentFrontmatterHooks('---\nhooks: not-a-map\n---\nbody')).toBeUndefined();
  });
});

// ── 1. The child-side lifetime ──────────────────────────────────────────────

describe('a subagent\'s PreToolUse hook in its own session', () => {
  it('runs while the subagent is active and nothing after it finishes', async () => {
    const hooks = parseSubagentFrontmatterHooks(agentMarkdown(HOOKS_BLOCK));
    // The live holder stands in for the child session's `piChildRestrictions`,
    // which the SessionManager layer reads through the same getter.
    let restrictions: { componentHooks?: SubagentComponentHooks } | undefined = { componentHooks: hooks };
    // The layer is built ONCE and handed to the system, exactly as R87's own
    // test does — otherwise rebuilding it per dispatch would re-take any
    // snapshot inside it and the lifetime property here would be untested.
    const layer = createConfigComponentHookLayer(() => restrictions?.componentHooks?.child);
    const system = new PluginScopedAutomationSystem({
      pluginHookConfig: { automations: {} },
      workspaceRootPath: process.cwd(),
      allowDirectCommandRunner: true,
      componentHookLayer: () => layer,
    });

    const active = await system.executeAgentEvent('PreToolUse', preToolUse);
    expect(active.decision?.decision).toBe('block');
    expect(active.matchedCount).toBe(1);

    // Finished: the record is gone, so the LIVE read finds nothing. A layer
    // captured at build time would still report it.
    restrictions = undefined;
    const after = await system.executeAgentEvent('PreToolUse', preToolUse);
    expect(after.decision).toBeUndefined();
    expect(after.matchedCount).toBe(0);
  }, 20_000);

  it('never carries the parent tier into the child session', async () => {
    const hooks = parseSubagentFrontmatterHooks(agentMarkdown(HOOKS_BLOCK));
    const system = new PluginScopedAutomationSystem({
      pluginHookConfig: { automations: {} },
      workspaceRootPath: process.cwd(),
      allowDirectCommandRunner: true,
      componentHookLayer: () => createConfigComponentHookLayer(() => hooks?.child),
    });
    // The child session never emits SubagentStop for itself; the parent does.
    const result = await system.executeAgentEvent('SubagentStop', subagentStop('agent-1'));
    expect(result.matchedCount).toBe(0);
  }, 20_000);
});

// ── 2. The parent-side SubagentStop ─────────────────────────────────────────

describe('a subagent\'s frontmatter Stop, dispatched parent-side', () => {
  function parentSystem(running: Map<string, AutomationsConfig>) {
    // Built once, as above: the live read under test is the layer's own, not
    // the system rebuilding it.
    const layer = createSubagentParentComponentHookLayer(() => running);
    return new PluginScopedAutomationSystem({
      pluginHookConfig: { automations: {} },
      workspaceRootPath: process.cwd(),
      allowDirectCommandRunner: true,
      componentHookLayer: () => layer,
    });
  }

  it('fires as SubagentStop when the child returns, and not once it is cleaned up', async () => {
    const hooks = parseSubagentFrontmatterHooks(agentMarkdown(HOOKS_BLOCK));
    const running = new Map<string, AutomationsConfig>([['agent-1', hooks!.parent!]]);
    const system = parentSystem(running);

    const stopped = await system.executeAgentEvent('SubagentStop', subagentStop('agent-1'));
    expect(stopped.matchedCount).toBe(1);
    expect(stopped.decision?.decision).toBe('block');

    // "cleaned up when it finishes" — the entry leaves the live map once its
    // terminal event has been dispatched.
    running.delete('agent-1');
    const after = await system.executeAgentEvent('SubagentStop', subagentStop('agent-1'));
    expect(after.matchedCount).toBe(0);
  }, 20_000);

  it('does not run one child\'s Stop hook on a sibling\'s completion', async () => {
    const hooks = parseSubagentFrontmatterHooks(agentMarkdown(HOOKS_BLOCK));
    // Only `agent-1` declares hooks; `agent-2` is a plain sibling still running.
    const running = new Map<string, AutomationsConfig>([['agent-1', hooks!.parent!]]);
    const system = parentSystem(running);
    const sibling = await system.executeAgentEvent('SubagentStop', subagentStop('agent-2'));
    expect(sibling.matchedCount).toBe(0);
    // The perf gate is a "could match" predicate and stays true while agent-1
    // is live — it is deliberately not the per-dispatch decision.
    expect(system.hasAgentEventMatchers?.('SubagentStop')).toBe(true);
  }, 20_000);
});

// ── 3 & 4. The trust gate, which splits by SCOPE and gates the HOOKS ─────────

function agentView(
  scope: AgentRuntimeView['agents'][number]['instructionsResource'],
): AgentRuntimeView {
  return {
    generation: 'g1', sources: [], skills: [], mcpServers: [], hooks: [], automations: [],
    promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    agents: [{
      key: 'agent://reviewer',
      name: 'reviewer',
      description: 'Review code',
      selectedAsUnqualifiedAlias: true,
      instructionsResource: scope,
    }],
  } as unknown as AgentRuntimeView;
}

function nativeResource(scopeKind: 'global' | 'project') {
  return {
    source: scopeKind === 'project' ? 'project' : 'shared-personal',
    scope: scopeKind === 'project'
      ? { kind: 'project', workspaceId: 'w', projectKey: 'p' }
      : { kind: 'global' },
    resourceId: 'reviewer',
    absolutePath: `/${scopeKind}/agents/reviewer.md`,
    revision: '1',
    contentHash: 'a'.repeat(64),
  } as unknown as AgentRuntimeView['agents'][number]['instructionsResource'];
}

const pluginResource = {
  pluginInstanceId: 'plugin-1',
  relativePath: 'agents/reviewer.md',
  revision: '1',
  contentHash: 'a'.repeat(64),
} as unknown as AgentRuntimeView['agents'][number]['instructionsResource'];

function materializer(content: string): CapabilitySnapshotMaterializer {
  return { assertActive() {}, readText: async () => content } as unknown as CapabilitySnapshotMaterializer;
}

describe('the frontmatter-hook trust gate splits by scope', () => {
  it('classifies plugin, project and user scopes', () => {
    const view = (resource: AgentRuntimeView['agents'][number]['instructionsResource']) => agentView(resource).agents[0]!;
    expect(subagentHookScope(view(pluginResource))).toBe('plugin');
    expect(subagentHookScope(view(nativeResource('project')))).toBe('project');
    expect(subagentHookScope(view(nativeResource('global')))).toBe('user');
  });

  it('runs a USER-level agent\'s hooks with no trust step', async () => {
    // "Hooks from user-level subagents in `~/.claude/agents/` … run without
    // this step." `projectTrusted: false` is passed deliberately.
    const skipped: string[] = [];
    const [definition] = await materializePiRuntimeAgentDefinitions({
      view: agentView(nativeResource('global')),
      materializer: materializer(agentMarkdown(HOOKS_BLOCK)),
      projectTrusted: false,
      onUntrustedComponentSkipped: diagnostic => skipped.push(diagnostic.reason),
    });
    expect(definition?.componentHooks?.child?.automations.PreToolUse?.length).toBe(1);
    expect(definition?.componentHooks?.parent?.automations.SubagentStop?.length).toBe(1);
    expect(skipped).toEqual([]);
  });

  it('still RUNS an untrusted PROJECT agent, with its hooks skipped and the reason reported', async () => {
    const skipped: { file: string; reason: string }[] = [];
    const [definition] = await materializePiRuntimeAgentDefinitions({
      view: agentView(nativeResource('project')),
      materializer: materializer(agentMarkdown(HOOKS_BLOCK)),
      projectTrusted: false,
      onUntrustedComponentSkipped: diagnostic => skipped.push(diagnostic),
    });
    // The agent is NOT refused — refusing it would contradict "the subagent
    // still runs". Everything but its hooks is intact.
    expect(definition?.name).toBe('reviewer');
    expect(definition?.systemPrompt).toBe('Reviewer instructions.');
    // ...and there is no hook block on it at all, so nothing can dispatch one.
    expect(definition?.componentHooks).toBeUndefined();
    expect('componentHooks' in definition!).toBe(false);
    // "logs an error to the debug log explaining how to trust the folder."
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.file).toBe('/project/agents/reviewer.md');
    expect(skipped[0]!.reason).toContain('not trusted');
    expect(skipped[0]!.reason).toContain('workspace trust dialog');
  });

  it('runs the same PROJECT agent\'s hooks once the folder is trusted', async () => {
    const skipped: string[] = [];
    const [definition] = await materializePiRuntimeAgentDefinitions({
      view: agentView(nativeResource('project')),
      materializer: materializer(agentMarkdown(HOOKS_BLOCK)),
      projectTrusted: true,
      onUntrustedComponentSkipped: diagnostic => skipped.push(diagnostic.reason),
    });
    expect(definition?.componentHooks?.child?.automations.PreToolUse?.length).toBe(1);
    expect(skipped).toEqual([]);
  });

  it('drops a PLUGIN subagent\'s hooks outright — no grant opens that gate', async () => {
    // sub-agents.md: "For security reasons, plugin subagents don't support the
    // `hooks`, `mcpServers`, or `permissionMode` frontmatter fields."
    const skipped: string[] = [];
    for (const projectTrusted of [false, true]) {
      const [definition] = await materializePiRuntimeAgentDefinitions({
        view: agentView(pluginResource),
        materializer: materializer(agentMarkdown(HOOKS_BLOCK)),
        projectTrusted,
        onUntrustedComponentSkipped: diagnostic => skipped.push(diagnostic.reason),
      });
      expect(definition?.name).toBe('reviewer');
      expect(definition?.componentHooks).toBeUndefined();
    }
    // Not a trust failure, so nothing is reported as one — the format adapter's
    // import-time diagnostic is the author-facing channel for this.
    expect(skipped).toEqual([]);
  });
});

// ── Persistence: the field is inside the definition digest ──────────────────

describe('componentHooks on the pinned descriptor', () => {
  it('round-trips through the wire parse and its digest', async () => {
    const [definition] = await materializePiRuntimeAgentDefinitions({
      view: agentView(nativeResource('global')),
      materializer: materializer(agentMarkdown(HOOKS_BLOCK)),
      projectTrusted: true,
    });
    const parsed = parsePiRuntimeAgentDefinitions(JSON.parse(JSON.stringify([definition])));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.definitionDigest).toBe(definition!.definitionDigest);
    expect(parsed[0]!.componentHooks?.parent?.automations.SubagentStop?.length).toBe(1);
  });

  it('leaves a hookless definition byte-identical to what it was before the field existed', async () => {
    const [definition] = await materializePiRuntimeAgentDefinitions({
      view: agentView(nativeResource('global')),
      materializer: materializer('---\nname: reviewer\ndescription: Review code\n---\nReviewer instructions.'),
      projectTrusted: true,
    });
    expect('componentHooks' in definition!).toBe(false);
    expect(parsePiRuntimeAgentDefinitions([definition])).toHaveLength(1);
  });

  it('rejects a structurally impossible block rather than dispatching it', () => {
    expect(() => staticSubagentComponentHooks({ child: 'rm -rf /' })).toThrow('Invalid subagent component hooks child');
    expect(staticSubagentComponentHooks(undefined)).toBeUndefined();
  });
});

// ── The seam that carries all three sources into one automation system ──────

describe('combineComponentHookLayers', () => {
  it('folds a skill layer and a subagent layer into one, and stays undefined when empty', async () => {
    const hooks = parseSubagentFrontmatterHooks(agentMarkdown(HOOKS_BLOCK));
    const combined = combineComponentHookLayers(
      undefined,
      createConfigComponentHookLayer(() => hooks?.child),
      createSubagentParentComponentHookLayer(() => new Map([['agent-1', hooks!.parent!]])),
    );
    expect(combined?.matchersFor('PreToolUse')?.automations.PreToolUse?.length).toBe(1);
    expect(combined?.matchersFor('SubagentStop', subagentStop('agent-1'))?.automations.SubagentStop?.length).toBe(1);
    expect(combined?.matchersFor('SubagentStop', subagentStop('agent-2'))).toBeUndefined();
    expect(combineComponentHookLayers(undefined, undefined)).toBeUndefined();
  });
});
