import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import { buildClaudeRuntimeAgentOptions } from '../claude-runtime-agents.ts';
import {
  CLAUDE_DISABLE_EXPLORE_PLAN_AGENTS_ENV,
  CLAUDE_SDK_DISABLE_BUILTIN_AGENTS_ENV,
  buildClaudeRuntimeBuiltinAgentEnv,
  claudeRuntimeSuppliesAgentDefinitions,
} from '../claude-runtime-builtin-agent-env.ts';
import type { PiRuntimeAgentDefinitionDescriptor } from '../pi-harness/runtime-agent-definition.ts';

function descriptor(
  overrides: Partial<PiRuntimeAgentDefinitionDescriptor> & { key: string; name: string },
): PiRuntimeAgentDefinitionDescriptor {
  return {
    schemaVersion: 2,
    description: 'reviews code',
    selectedAsUnqualifiedAlias: true,
    systemPrompt: 'You are a reviewer.',
    sha256: 'deadbeef',
    provenance: `${overrides.key}@gen-1`,
    capabilityGeneration: 'gen-1',
    definitionDigest: 'digest-1',
    ...overrides,
  };
}

const PROJECT = 'agent::project::ws-1::p_' + '7'.repeat(32);

/**
 * The five input shapes a turn can present, and nothing else exists. The fifth
 * is the one stated EXCEPTION: F1.1203 lets a trusted project's `.claude/agents`
 * files take over all four bundled names, so the host sends no `agents` record
 * while the switch stays set — on purpose, since the roster is then the files
 * Claude loads itself.
 */
const SHAPES: ReadonlyArray<{
  label: string;
  definitions: readonly PiRuntimeAgentDefinitionDescriptor[] | undefined;
  mini: boolean;
  exception?: true;
}> = [
  { label: 'a normal turn with an imported agent', definitions: [descriptor({ key: 'agent.imported', name: 'imported' })], mini: false },
  { label: 'a normal turn that dispatches definitions and has none', definitions: [], mini: false },
  { label: 'a runtime that dispatches no definitions at all', definitions: undefined, mini: false },
  { label: 'a mini completion', definitions: [descriptor({ key: 'agent.imported', name: 'imported' })], mini: true },
  {
    label: 'a project whose .claude/agents files take over all four bundled names',
    definitions: ['planner', 'reviewer', 'scout', 'worker'].map(name =>
      descriptor({ key: `${PROJECT}::claude::${name}`, name, claudeAgentName: name })),
    mini: false,
    exception: true,
  },
];

describe('buildClaudeRuntimeBuiltinAgentEnv', () => {
  it('sets the SDK off switch on a turn that supplies our definitions', () => {
    // P6.527 — the positive arm. `'1'` and not `'true'`: the vendored binary
    // parses this name through the env registry's `bool()`, whose truthy set is
    // `["1","true","yes","on"]`, and `env-vars.md#variables` says "Set to `1`".
    expect(buildClaudeRuntimeBuiltinAgentEnv({
      definitions: [descriptor({ key: 'agent.imported', name: 'imported' })],
      mini: false,
    })).toEqual({ CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1' });
    // The empty-array branch is on the SAME side of the line: the builder seeds
    // our bundled four there, so that session HAS a roster of its own.
    expect(buildClaudeRuntimeBuiltinAgentEnv({ definitions: [], mini: false }))
      .toEqual({ CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1' });
  });

  it('leaves a session that supplies none of its own exactly as the runtime ships it', () => {
    // The boundary this row must not cross. `definitions: undefined` sends no
    // `agents` option at all, so disabling the built-ins there would delete a
    // capability rather than close a divergence — and the mini branch registers
    // nothing and never delegates.
    expect(buildClaudeRuntimeBuiltinAgentEnv({ definitions: undefined, mini: false })).toEqual({});
    expect(buildClaudeRuntimeBuiltinAgentEnv({
      definitions: [descriptor({ key: 'agent.imported', name: 'imported' })],
      mini: true,
    })).toEqual({});
    // Absent means absent, not present-and-undefined: `Options.env` REPLACES the
    // child environment, so an `undefined`-valued key is not an unset one.
    expect(CLAUDE_SDK_DISABLE_BUILTIN_AGENTS_ENV in buildClaudeRuntimeBuiltinAgentEnv({
      definitions: undefined,
      mini: false,
    })).toBe(false);
  });

  it('cannot drift from the condition the agents option itself computes', () => {
    // The whole reason the predicate is allowed to live in a second file. If
    // `buildClaudeRuntimeAgentOptions` ever changes which turns carry an
    // `agents` record, this fails rather than leaving one runtime with neither
    // our agents nor its own. The stated exception is pinned as one: the switch
    // set AND no record sent, so it fails if it ever stops being an exception.
    for (const shape of SHAPES) {
      const sendsAgents = 'agents' in buildClaudeRuntimeAgentOptions({
        definitions: shape.definitions,
        mini: shape.mini,
        env: {},
      });
      expect({ [shape.label]: claudeRuntimeSuppliesAgentDefinitions(shape) })
        .toEqual({ [shape.label]: shape.exception ? true : sendsAgents });
      if (shape.exception) expect({ [shape.label]: sendsAgents }).toEqual({ [shape.label]: false });
    }
  });

  it('removes Explore and Plan on an explicit off, and NOTHING otherwise (P6.313)', () => {
    // The positive arm, and it is asserted on the turn shape where it is the
    // ONLY thing that can act: with definitions of our own the sibling switch
    // already empties the built-in list, so a session that dispatches none is
    // where a user's "no Explore and Plan" actually lands.
    expect(buildClaudeRuntimeBuiltinAgentEnv({
      definitions: undefined,
      mini: false,
      explorePlanAgentsEnabled: false,
    })).toEqual({ CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: '1' });
    // A `mini` completion is the second such shape, and the two switches are
    // deliberately independent: the sibling stays silent there, this one does not.
    expect(buildClaudeRuntimeBuiltinAgentEnv({
      definitions: [descriptor({ key: 'agent.imported', name: 'imported' })],
      mini: true,
      explorePlanAgentsEnabled: false,
    })).toEqual({ CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: '1' });
    // Both together where both apply.
    expect(buildClaudeRuntimeBuiltinAgentEnv({
      definitions: [],
      mini: false,
      explorePlanAgentsEnabled: false,
    })).toEqual({
      CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
      CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: '1',
    });
  });

  it('treats UNSET and an explicit ON as the same absence', () => {
    // The boundary. The vendor's default is ON, so emitting anything for `true`
    // would be a change dressed as a no-op: an install that never touched the
    // key must spawn byte-identically to one built before the row. `in` is the
    // assertion rather than a value comparison because `Options.env` REPLACES
    // the child environment, where a present-and-undefined key is not an unset
    // one.
    for (const explorePlanAgentsEnabled of [undefined, true] as const) {
      const env = buildClaudeRuntimeBuiltinAgentEnv({
        definitions: undefined,
        mini: false,
        explorePlanAgentsEnabled,
      });
      expect(CLAUDE_DISABLE_EXPLORE_PLAN_AGENTS_ENV in env).toBe(false);
      expect(env).toEqual({});
    }
  });

  it('names an env key the child environment builder does not strip', () => {
    // `getDefaultOptions` deletes two families of names from the Claude child
    // env (the provider toggles and the corporate-launcher names). A switch
    // dropped on the way out would look set and do nothing, which is the
    // failure this row exists to remove rather than reproduce.
    const source = readFileSync(
      new URL('../../config/claude-provider-routing-env.ts', import.meta.url),
      'utf8',
    );
    expect(source.includes(CLAUDE_SDK_DISABLE_BUILTIN_AGENTS_ENV)).toBe(false);
    expect(source.includes(CLAUDE_DISABLE_EXPLORE_PLAN_AGENTS_ENV)).toBe(false);
  });

  it('is spread into the SDK options literal — the row does nothing without it', () => {
    // W7-s1 landed the one-line call site this module was built for. A fragment
    // nobody spreads is a switch that is set in a unit test and absent from every
    // real session, so the seam is asserted on the source of the caller rather
    // than trusted. Mirrors `claude-runtime-agents.test.ts`'s own seam check.
    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/\.\.\.buildClaudeRuntimeBuiltinAgentEnv\(/);
  });
});
