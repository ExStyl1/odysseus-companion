/**
 * Q7 — our agent definitions must reach the Claude Agent SDK's OWN subagent
 * mechanism.
 *
 * The gate (`.superpowers/sdd/q6-agent-invocation-report.md`, Q6-D4) measured
 * the SDK answering `Agent type 'q6-plain' not found. Available agents: claude,
 * claude-code-guide, Explore, general-purpose, Plan, statusline-setup` while our
 * catalog reported all 12 agents `active`. Nothing registered them.
 *
 * The option is `agents`, and the two contracts were read SEPARATELY rather
 * than one being assumed to echo the other:
 *
 * - `agent-sdk/subagents.md` § *Overview*, fetched raw 2026-08-13, line 18:
 *   "**Programmatically**: use the `agents` parameter in your `query()`
 *   options."
 * - the installed SDK's own types, `@anthropic-ai/claude-agent-sdk@0.3.218`
 *   `sdk.d.ts:1348`: `agents?: Record<string, AgentDefinition>;`, whose jsdoc
 *   (`sdk.d.ts:1343-1344`) reads "Programmatically define custom subagents that
 *   can be invoked via the Agent tool. Keys are agent names, values are agent
 *   definitions." That second sentence is the TYPES ONLY — it is not on the doc
 *   page, and an earlier draft of this file cited it as though it were.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildClaudeRuntimeAgents, buildClaudeRuntimeAgentOptions } from '../claude-runtime-agents.ts';
import { BUILTIN_AGENT_DEFINITIONS } from '../../agents/definitions.ts';
import type { PiRuntimeAgentDefinitionDescriptor } from '../pi-harness/runtime-agent-definition.ts';

/** Every tool name the bundled four DECLARE — Pi's own spellings, none of them the SDK's. */
const BUILTIN_PI_TOOL_SPELLINGS = new Set(BUILTIN_AGENT_DEFINITIONS.flatMap(definition => definition.tools));

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

describe('buildClaudeRuntimeAgents', () => {
  it('maps a descriptor onto the SDK AgentDefinition fields', () => {
    const agents = buildClaudeRuntimeAgents([
      descriptor({
        key: 'agent.auditor',
        name: 'auditor',
        tools: ['Read', 'Grep', 'Agent'],
        disallowedTools: ['Bash'],
        model: 'sonnet',
        maxTurns: 4,
        background: true,
        memory: 'project',
      }),
    ]);

    expect(agents.auditor).toEqual({
      description: 'reviews code',
      prompt: 'You are a reviewer.',
      tools: ['Read', 'Grep', 'Agent'],
      disallowedTools: ['Bash'],
      model: 'sonnet',
      maxTurns: 4,
      background: true,
      memory: 'project',
    });
  });

  it('passes the author-declared tool spellings through unnormalized', () => {
    // The descriptor's `tools` is the author's list verbatim
    // (`buildPiRuntimeAgentDescriptor`: `tools: [...tools]`), never the
    // Pi-normalized one — `normalizePiRuntimeAgentToolName` is applied at read
    // time on the Pi side only. Claude's SDK wants Claude's own spellings, so
    // the correct transform here is none at all. Rewriting `Agent` to Pi's
    // `subagent` would hand the SDK a tool name it does not have.
    const agents = buildClaudeRuntimeAgents([
      descriptor({ key: 'agent.a', name: 'a', tools: ['Agent(one, two)', 'WebFetch'] }),
    ]);
    expect(agents.a?.tools).toEqual(['Agent(one, two)', 'WebFetch']);
  });

  it('omits an absent optional rather than sending undefined', () => {
    const agents = buildClaudeRuntimeAgents([descriptor({ key: 'agent.bare', name: 'bare' })]);
    expect(agents.bare).toEqual({ description: 'reviews code', prompt: 'You are a reviewer.' });
    expect('tools' in agents.bare!).toBe(false);
    expect('model' in agents.bare!).toBe(false);
  });

  it('keys an ambiguous definition by its qualified key so the Record cannot silently collapse', () => {
    // Two plugins bundling a same-named agent both have
    // `selectedAsUnqualifiedAlias: false`. `Record<string, AgentDefinition>` has
    // no alias list, so keying both by `name` would drop one ENTIRELY. Same
    // rule the Pi side applies at `runtime-agent-definitions.ts:350`
    // (`name: hasUnqualifiedAlias ? descriptor.name : descriptor.key`).
    const agents = buildClaudeRuntimeAgents([
      descriptor({ key: 'plugin-a.scan', name: 'scan', selectedAsUnqualifiedAlias: false }),
      descriptor({ key: 'plugin-b.scan', name: 'scan', selectedAsUnqualifiedAlias: false }),
    ]);
    expect(Object.keys(agents).filter(key => key.startsWith('plugin-')).sort())
      .toEqual(['plugin-a.scan', 'plugin-b.scan']);
  });

  it('drops effort: off, which the SDK union has no member for', () => {
    // Our ThinkingLevel carries 'off' (`thinking-levels.ts:30`); the SDK's
    // `effort` is `'low' | 'medium' | 'high' | 'xhigh' | 'max' | number`.
    expect(buildClaudeRuntimeAgents([
      descriptor({ key: 'agent.off', name: 'off', effort: 'off' }),
    ]).off).not.toHaveProperty('effort');
    expect(buildClaudeRuntimeAgents([
      descriptor({ key: 'agent.hi', name: 'hi', effort: 'high' }),
    ]).hi?.effort).toBe('high');
  });

  it('drops a permissionMode the SDK union has no member for, and keeps the rest', () => {
    // The SDK's is `'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`, ours the same
    // six since F1.1050 retired 'explore' (this arm used it); any other string is still dropped, never passed on.
    expect(buildClaudeRuntimeAgents([
      descriptor({ key: 'agent.x', name: 'x', permissionMode: 'explore-legacy' as never }),
    ]).x).not.toHaveProperty('permissionMode');
    expect(buildClaudeRuntimeAgents([
      descriptor({ key: 'agent.y', name: 'y', permissionMode: 'acceptEdits' }),
    ]).y?.permissionMode).toBe('acceptEdits');
  });

  it('substitutes a description for a definition that declares none', () => {
    // `description` is REQUIRED by the SDK type and is what the model matches a
    // task against; an empty one makes the agent undelegatable. Same fallback
    // string the Pi side uses (`runtime-agent-definitions.ts:352`).
    expect(buildClaudeRuntimeAgents([
      descriptor({ key: 'agent.q', name: 'q', description: '' }),
    ]).q?.description).toBe('Imported q agent.');
  });

  it('returns an empty record when the runtime dispatches no definitions at all', () => {
    // `undefined` is the "this runtime does not dispatch agent definitions"
    // case, and it stays empty: seeding the bundled four there would register
    // agents whose Pi twins that session never had.
    expect(buildClaudeRuntimeAgents(undefined)).toEqual({});
  });

  // P3.277 — the four bundled definitions reach this builder. Before this they
  // reached Pi (`loadAgentDefinitions` seeds its map with them) and nothing
  // else, so `scout`, `planner`, `worker` and `reviewer` answered on one runtime
  // and were "Agent type not found" on the other.
  describe('bundled builtins', () => {
    it('registers all four for a session that dispatches definitions but has none of its own', () => {
      expect(Object.keys(buildClaudeRuntimeAgents([])).sort())
        .toEqual(['planner', 'reviewer', 'scout', 'worker']);
    });

    it('forwards description and prompt from the shared definition, unedited', () => {
      const scout = buildClaudeRuntimeAgents([]).scout!;
      const source = BUILTIN_AGENT_DEFINITIONS.find(definition => definition.name === 'scout')!;
      expect(scout.description).toBe(source.description);
      expect(scout.prompt).toBe(source.systemPrompt);
    });

    it('translates the toolset instead of forwarding Pi\'s own tool spellings', () => {
      // The declared list is `read`/`grep`/`find`/`ls` — correct for Pi and not
      // an SDK spelling (`sdk.d.ts`'s own `agents` example: `tools: ['Read',
      // 'Grep', 'Glob', 'Bash']`). Forwarding it verbatim is the unresolvable
      // input `errors.md` § *Agent would be spawned with zero tools* describes.
      const agents = buildClaudeRuntimeAgents([]);
      expect(agents.scout!.tools).toEqual(['Read', 'Grep', 'Glob']);
      expect(agents.planner!.tools).toEqual(['Read', 'Grep', 'Glob']);
      expect(agents.reviewer!.tools).toEqual(['Read', 'Grep', 'Glob']);
      expect(agents.worker!.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write']);
      for (const agent of Object.values(agents)) {
        expect(agent.tools!.some(tool => BUILTIN_PI_TOOL_SPELLINGS.has(tool))).toBe(false);
      }
    });

    it('gives the full toolset an explicit list rather than inheriting everything', () => {
      // Omitting `tools` inherits the parent's whole pool, which on this runtime
      // is WebFetch/WebSearch/Agent/`mcp__session__*` — authority `worker` has
      // never had on Pi, widened silently on one runtime.
      expect(buildClaudeRuntimeAgents([]).worker!.tools).toBeDefined();
    });

    it('drops tier, which the SDK cannot express, rather than inventing a model', () => {
      for (const agent of Object.values(buildClaudeRuntimeAgents([]))) {
        expect('model' in agent).toBe(false);
      }
      // The residue this leaves is real and stated: a bundled agent runs on the
      // session model here and on its tier's model on Pi.
      expect(BUILTIN_AGENT_DEFINITIONS.every(definition => definition.tier !== undefined)).toBe(true);
    });

    it('keeps the builtin when a descriptor answers to its name, exactly as the Pi loader does', () => {
      // `loadAgentDefinitions` stores a runtime definition colliding with a
      // built-in under its QUALIFIED key and keeps the built-in reachable
      // ("Runtime agent … collides with an immutable built-in without a
      // qualified definition key" is the throw for the case with no key). Both
      // runtimes read the same descriptors, so without the same rule here an
      // imported `reviewer` would shadow the bundled one on claude and sit
      // beside it on Pi.
      const agents = buildClaudeRuntimeAgents([
        descriptor({ key: 'agent.reviewer', name: 'reviewer', selectedAsUnqualifiedAlias: true }),
      ]);
      expect(agents.reviewer!.prompt).toContain('You are a reviewer agent.');
      expect(agents['agent.reviewer']!.prompt).toBe('You are a reviewer.');
      expect(Object.keys(agents).sort())
        .toEqual(['agent.reviewer', 'planner', 'reviewer', 'scout', 'worker']);
    });

    it('applies the same rule to the RESERVED fork name', () => {
      // `fork` is not a fifth builtin, it is reserved: "inherit the parent
      // session's prompt, tools, model and permission mode" is not something a
      // definition may redefine, and `loadAgentDefinitions` refuses to let one
      // claim the name.
      const agents = buildClaudeRuntimeAgents([
        descriptor({ key: 'plugin-x.fork', name: 'fork', selectedAsUnqualifiedAlias: true }),
      ]);
      expect(agents.fork).toBeUndefined();
      expect(agents['plugin-x.fork']).toBeDefined();
    });
  });
});

describe('buildClaudeRuntimeAgentOptions', () => {
  // This is the seam the turn path actually spreads, mirroring
  // `buildClaudeStructuredOutputOptions` in `claude-turn-options.test.ts`: a
  // pure `Pick<Options, …>` fragment, asserted on WHAT WE PASS rather than on
  // the SDK's behaviour. The series' recurring defect is a helper unit-tested in
  // a code path the turn never reaches, and Q6-D4 was that defect one layer up —
  // the definitions existed and reached nothing.

  it('produces the agents option a normal turn carries', () => {
    const options = buildClaudeRuntimeAgentOptions({
      definitions: [descriptor({ key: 'agent.imported', name: 'imported' })],
      mini: false,
    });
    expect((options.agents as Record<string, unknown>).imported)
      .toEqual({ description: 'reviews code', prompt: 'You are a reviewer.' });
    // P3.277 — and the bundled four ride along, which is what makes them
    // reachable on this runtime at all.
    expect(Object.keys(options.agents as object).sort())
      .toEqual(['imported', 'planner', 'reviewer', 'scout', 'worker']);
  });

  it('omits the key entirely when the runtime dispatches no definitions', () => {
    // An empty `agents: {}` is not the same request as no `agents` at all: the
    // SDK's own built-in set is what a session that dispatches none must keep.
    // P3.277 moved the EMPTY-ARRAY case to the other side of this line: a
    // session that dispatches definitions and has none of its own still gets
    // the bundled four, because Pi's loader gives it exactly those.
    expect('agents' in buildClaudeRuntimeAgentOptions({ definitions: undefined, mini: false })).toBe(false);
    expect(Object.keys((buildClaudeRuntimeAgentOptions({ definitions: [], mini: false }).agents ?? {})).sort())
      .toEqual(['planner', 'reviewer', 'scout', 'worker']);
  });

  it('F1.1178 — leaves a project .claude/agents file to the SDK’s own load instead of replacing it', () => {
    // `agent-sdk/subagents.md`: "Programmatically defined agents take precedence
    // over filesystem-based agents with the same name." Registering the host's
    // copy of `.claude/agents/guarded.md` replaced the SDK's own load of that
    // file with a translation that drops its frontmatter hooks (the notice) and
    // its inline MCP servers. Keys as `native-sources.ts` mints them; its suite
    // pins `isClaudeProjectAgentCopyKey` against the real inventory's keys.
    const project = 'agent::project::ws-1::p_' + '7'.repeat(32);
    const hooks = {
      child: { automations: { PreToolUse: [{ matcher: 'Bash', actions: [{ type: 'command', command: './guard.sh' }] }] } },
    } as never;
    const notices: string[] = [];
    const options = buildClaudeRuntimeAgentOptions({
      definitions: [
        descriptor({ key: `${project}::claude::guarded`, name: 'guarded', componentHooks: hooks }),
        // THE CONTROL — our own `.nessy-agent/agents` file in the same project,
        // same scope and hooks: still registered, still announced.
        descriptor({ key: `${project}::::ours`, name: 'ours', componentHooks: hooks }),
      ],
      mini: false,
      onNotice: notice => notices.push(notice.agentKey),
    });
    const names = Object.keys(options.agents as object);
    expect(names).not.toContain('guarded');
    expect(names.some(name => name.includes('guarded'))).toBe(false);
    expect(names).toContain('ours');
    expect(notices).toEqual([`${project}::::ours`]);
  });

  describe('F1.1203 — a project .claude/agents file named like a bundled agent', () => {
    // `sub-agents.md`, the Built-in subagents section: "A user or project
    // subagent named `Explore` overrides the built-in". The bundled four are this
    // host's built-ins, but they reach Claude as programmatic agents, which
    // "take precedence over filesystem-based agents with the same name"
    // (`agent-sdk/subagents.md`) — so the seed itself must give way, or the
    // user's file (and its hooks and inline servers) never runs on Claude.
    const project = 'agent::project::ws-1::p_' + '7'.repeat(32);
    const hooks = {
      child: { automations: { PreToolUse: [{ matcher: 'Bash', actions: [{ type: 'command', command: './guard.sh' }] }] } },
    } as never;
    const build = (definitions: PiRuntimeAgentDefinitionDescriptor[], env: Record<string, string | undefined>) => {
      const notices: string[] = [];
      const agents = buildClaudeRuntimeAgents(
        definitions, undefined, undefined, notice => notices.push(notice.agentKey), undefined, undefined, env,
      );
      return { names: Object.keys(agents).sort(), notices };
    };

    it('leaves the name to the SDK’s own load of the file: the bundled reviewer is not seeded', () => {
      const { names, notices } = build(
        [descriptor({ key: `${project}::claude::reviewer`, name: 'reviewer', componentHooks: hooks, claudeAgentName: 'reviewer' })],
        {},
      );
      // Neither the bundled reviewer nor the host's translated copy: the only
      // `reviewer` left is the one Claude loads from `.claude/agents/reviewer.md`.
      expect(names).toEqual(['planner', 'scout', 'worker']);
      expect(notices).toEqual([]);
    });

    it('keeps the bundled agent when the session does not load project agents, and for our own file', () => {
      // THE BOUNDARY — `NESSY_CLAUDE_SETTING_SOURCES` without `project`: the SDK
      // loads no `.claude/agents`, so removing the seed would leave no reviewer.
      expect(build(
        [descriptor({ key: `${project}::claude::reviewer`, name: 'reviewer', claudeAgentName: 'reviewer' })],
        { NESSY_CLAUDE_SETTING_SOURCES: 'user' },
      ).names).toEqual(['planner', 'reviewer', 'scout', 'worker']);
      // THE CONTROL — a `.nessy-agent/agents/reviewer.md` is ours, not Claude's:
      // it sits beside the bundled one under its qualified key (P3.277), as on Pi.
      expect(build(
        [descriptor({ key: `${project}::::reviewer`, name: 'reviewer' })],
        {},
      ).names).toEqual([`${project}::::reviewer`, 'planner', 'reviewer', 'scout', 'worker'].sort());
    });

    it('goes by the name Claude loads the file under (its frontmatter `name`), never the file name', () => {
      // `sub-agents.md`: identity "comes only from the `name` frontmatter field";
      // "The filename doesn't have to match". `code-review.md` with
      // `name: reviewer` IS Claude's reviewer, so the seed gives way...
      expect(build(
        [descriptor({ key: `${project}::claude::code-review`, name: 'code-review', claudeAgentName: 'reviewer' })],
        {},
      ).names).toEqual(['planner', 'scout', 'worker']);
      // ...and `reviewer.md` with `name: code-reviewer` (or a file Claude skips,
      // which carries no `claudeAgentName`) takes nothing: the bundled one stays.
      for (const claudeAgentName of ['code-reviewer', undefined]) {
        expect(build(
          [descriptor({ key: `${project}::claude::reviewer`, name: 'reviewer', ...(claudeAgentName ? { claudeAgentName } : {}) })],
          {},
        ).names).toEqual(['planner', 'reviewer', 'scout', 'worker']);
      }
    });

    it('says why a session agent pin fails when the project took over all four bundled names', () => {
      // The record is empty here although the session DOES dispatch definitions,
      // and Claude has a `reviewer` from the file — so "registers no agent
      // definitions at all" would be false. The pin itself stays unapplied (the
      // F1.1178 residue); only the sentence changes.
      const notes: string[] = [];
      const options = buildClaudeRuntimeAgentOptions({
        definitions: ['planner', 'reviewer', 'scout', 'worker'].map(name =>
          descriptor({ key: `${project}::claude::${name}`, name, claudeAgentName: name })),
        mini: false,
        mainThreadAgent: 'reviewer',
        onDiagnostic: message => notes.push(message),
        env: {},
      });
      expect(options).toEqual({});
      expect(notes).toHaveLength(1);
      expect(notes[0]).not.toContain('at all');
      expect(notes[0]).toContain('.claude/agents');
      // THE BOUNDARY — a runtime that dispatches no definitions keeps the old sentence.
      const none: string[] = [];
      buildClaudeRuntimeAgentOptions({
        definitions: undefined, mini: false, mainThreadAgent: 'reviewer', onDiagnostic: m => none.push(m),
      });
      expect(none).toEqual(['Session agent "reviewer" was not applied: this session registers no agent definitions at all.']);
    });
  });

  describe('P6.312 — the agent a session runs AS', () => {
    // `Options.agent`: *"Agent name for the main thread. When specified, the
    // agent's system prompt, tool restrictions, and model will be applied to the
    // main conversation. The agent must be defined either in the `agents` option
    // or in settings."* The prompt, the tools and `initialPrompt` are the SDK's
    // own work; what this host owes is the name, the resolution, and the one
    // half it withholds.
    const pinned = (mainThreadAgent: string, extra?: Partial<PiRuntimeAgentDefinitionDescriptor>) => {
      const notes: string[] = [];
      const options = buildClaudeRuntimeAgentOptions({
        definitions: [descriptor({ key: 'agent.imported', name: 'imported', ...extra })],
        mini: false,
        mainThreadAgent,
        onDiagnostic: message => notes.push(message),
      });
      return { options, notes };
    };

    it('names the pinned agent, and says nothing when there is nothing to withhold', () => {
      const { options, notes } = pinned('imported');
      expect(options.agent).toBe('imported');
      // The registration is untouched, so the SDK applies the prompt and the
      // tool restriction exactly as it documents them.
      expect((options.agents as Record<string, unknown>).imported)
        .toEqual({ description: 'reviews code', prompt: 'You are a reviewer.' });
      expect(notes).toEqual([]);
    });

    it('withholds the agent’s MODEL and says so — the owner’s option (b)', () => {
      // The SDK's own sentence would apply the agent's model to the main
      // conversation, which gives one session two answers to "what model is
      // this?". Dropped from the registration, because that is the only place
      // the SDK reads it from — and announced, because a silent drop is the
      // defect this whole plan is about.
      const { options, notes } = pinned('imported', { model: 'opus' });
      expect(options.agent).toBe('imported');
      expect('model' in (options.agents as Record<string, object>).imported!).toBe(false);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('imported');
      expect(notes[0]).toContain('opus');
      expect(notes[0]).toContain('keeps its own model');
    });

    it('leaves a NON-pinned agent’s model alone — the control', () => {
      // Without this the case above passes for an implementation that strips
      // every agent's model, which would silently re-point four subagents.
      const notes: string[] = [];
      const options = buildClaudeRuntimeAgentOptions({
        definitions: [
          descriptor({ key: 'agent.imported', name: 'imported', model: 'opus' }),
          descriptor({ key: 'agent.other', name: 'other', model: 'haiku' }),
        ],
        mini: false,
        mainThreadAgent: 'imported',
        onDiagnostic: message => notes.push(message),
      });
      expect((options.agents as Record<string, { model?: string }>).other!.model).toBe('haiku');
      expect('model' in (options.agents as Record<string, object>).imported!).toBe(false);
    });

    it('degrades on a name the roster does not carry, and never sends it', () => {
      // The SDK requires the name to resolve, so sending an unresolvable one
      // turns a mistyped setting into a session that will not start.
      const { options, notes } = pinned('revieww');
      expect('agent' in options).toBe(false);
      expect(options.agents).toBeDefined();
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('revieww');
      expect(notes[0]).toContain('imported');
    });

    it('says so when there is no roster at all, rather than pinning into nothing', () => {
      const notes: string[] = [];
      const options = buildClaudeRuntimeAgentOptions({
        definitions: undefined,
        mini: false,
        mainThreadAgent: 'imported',
        onDiagnostic: message => notes.push(message),
      });
      expect(options).toEqual({});
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('no agent definitions at all');
    });

    it('an UNPINNED turn is byte-identical to one built before this row', () => {
      // THE BASELINE. Every session that has not set the host key must spawn
      // exactly as it did, or shipping this respawns every live session once.
      const options = buildClaudeRuntimeAgentOptions({
        definitions: [descriptor({ key: 'agent.imported', name: 'imported', model: 'opus' })],
        mini: false,
      });
      expect('agent' in options).toBe(false);
      expect((options.agents as Record<string, { model?: string }>).imported!.model).toBe('opus');
    });
  });

  it('withholds agents from a mini turn', () => {
    // The mini branch exists to cut the token count with a lean prompt and a
    // minimal tool list, and it never delegates.
    expect(buildClaudeRuntimeAgentOptions({
      definitions: [descriptor({ key: 'agent.reviewer', name: 'reviewer' })],
      mini: true,
    })).toEqual({});
  });
});

describe('claude-agent turn wiring', () => {
  it('spreads the fragment into the SDK options literal', () => {
    // One stable call-site assertion is the only static proof that the builder
    // above is reached by a real turn; every field-level claim is behavioural,
    // in the describes above.
    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/\.\.\.buildClaudeRuntimeAgentOptions\(/);
  });
});

describe('the agent model policy (gateway substitution)', () => {
  // Measured live 2026-08-14 (Q6-LIVE claim 3): claude-security declares
  // `model: opus`, the gateway serves no such id, and the SDK child died with
  // "model not available" while Pi substituted and codex inherited. The policy
  // engages ONLY when the caller supplies the served catalog.
  const policy = (heard: string[]) => ({
    servedModels: ['tgpt/qwen35-397b-a17b-fp8'],
    sessionModel: 'tgpt/qwen35-397b-a17b-fp8',
    onDiagnostic: (message: string) => heard.push(message),
  });

  it('drops a declared model the connection cannot serve, announcing both models', () => {
    const heard: string[] = [];
    const agents = buildClaudeRuntimeAgents(
      [descriptor({ key: 'agent.sec', name: 'sec', model: 'opus' })],
      policy(heard),
    );
    expect('model' in agents.sec!).toBe(false);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toContain('"opus"');
    expect(heard[0]).toContain('tgpt/qwen35-397b-a17b-fp8');
  });

  it('keeps a declared model the connection serves, silently', () => {
    const heard: string[] = [];
    const agents = buildClaudeRuntimeAgents(
      [descriptor({ key: 'agent.sec', name: 'sec', model: 'tgpt/qwen35-397b-a17b-fp8' })],
      policy(heard),
    );
    expect(agents.sec!.model).toBe('tgpt/qwen35-397b-a17b-fp8');
    expect(heard).toHaveLength(0);
  });

  it('passes an alias through untouched when no policy is supplied — the anthropic contract', () => {
    const agents = buildClaudeRuntimeAgents(
      [descriptor({ key: 'agent.sec', name: 'sec', model: 'opus' })],
    );
    expect(agents.sec!.model).toBe('opus');
  });
});

/**
 * P3.345 — the roster half of cross-session messaging, on claude.
 *
 * Before this, `subagentRosterToolGrant` had exactly one consumer (Pi's
 * `runtime-agent-definitions.ts`) and this builder forwarded the author's
 * `tools` verbatim, so the SAME descriptor produced a subagent that could write
 * to a peer on Pi and discover one, and on claude could only write. Both names
 * are on claude's own surface — asserted here against the registry rather than
 * assumed, with `list_mcp_resources` as the same-table control that IS `pi-only`
 * and a fabricated name as the zero.
 */
describe('P3.345 — the subagent roster grant on claude', () => {
  const CLAUDE_POOL = ['Read', 'Grep', 'send_agent_message', 'list_sessions'];

  it('the two names really are on claude’s session-tool surface', async () => {
    const { getSessionToolNames } = await import('@nessy-agent/session-tools-core');
    const claude = getSessionToolNames();
    const pi = getSessionToolNames({ projection: 'pi' });
    expect(claude.has('send_agent_message')).toBe(true);
    expect(claude.has('list_sessions')).toBe(true);
    // Control: a name that is genuinely `pi-only`, so "claude has everything"
    // cannot be what the two assertions above are measuring.
    expect(claude.has('list_mcp_resources')).toBe(false);
    expect(pi.has('list_mcp_resources')).toBe(true);
    // Zero control: the probe is reading a registry, not answering true.
    expect(claude.has('__not_a_real_session_tool')).toBe(false);
  });

  it('unions the roster tool when the author declared the messaging tool', () => {
    const agents = buildClaudeRuntimeAgents(
      [descriptor({ key: 'agent.peer', name: 'peer', tools: ['Read', 'send_agent_message'] })],
      undefined,
      undefined,
      undefined,
      CLAUDE_POOL,
    );
    expect(agents.peer!.tools).toEqual(['Read', 'send_agent_message', 'list_sessions']);
  });

  it('grants nothing when the author did not declare the messaging tool', () => {
    const agents = buildClaudeRuntimeAgents(
      [descriptor({ key: 'agent.plain', name: 'plain', tools: ['Read', 'Grep'] })],
      undefined,
      undefined,
      undefined,
      CLAUDE_POOL,
    );
    expect(agents.plain!.tools).toEqual(['Read', 'Grep']);
  });

  it('grants nothing when the parent pool does not carry the roster tool', () => {
    const agents = buildClaudeRuntimeAgents(
      [descriptor({ key: 'agent.peer', name: 'peer', tools: ['Read', 'send_agent_message'] })],
      undefined,
      undefined,
      undefined,
      ['Read', 'Grep', 'send_agent_message'],
    );
    expect(agents.peer!.tools).toEqual(['Read', 'send_agent_message']);
  });

  it('leaves an agent with no declared tools alone — it already inherits both', () => {
    const agents = buildClaudeRuntimeAgents(
      [descriptor({ key: 'agent.open', name: 'open' })],
      undefined,
      undefined,
      undefined,
      CLAUDE_POOL,
    );
    expect(agents.open!.tools).toBeUndefined();
  });

  it('an explicit denial wins, including in the DOCUMENTED spelling', () => {
    // `cross-session-messaging.md` calls the roster tool `ListAgents`; ours is
    // `list_sessions`, and the alias table resolves the two. A denial written
    // the way the page spells it must therefore still beat the grant.
    for (const denial of ['list_sessions', 'ListAgents']) {
      const agents = buildClaudeRuntimeAgents(
        [descriptor({
          key: 'agent.peer',
          name: 'peer',
          tools: ['Read', 'send_agent_message'],
          disallowedTools: [denial],
        })],
        undefined,
        undefined,
        undefined,
        CLAUDE_POOL,
      );
      expect(agents.peer!.tools).toEqual(['Read', 'send_agent_message']);
      expect(agents.peer!.disallowedTools).toEqual([denial]);
    }
  });

  it('a caller that supplies no pool keeps the pre-P3.345 behaviour exactly', () => {
    const agents = buildClaudeRuntimeAgents(
      [descriptor({ key: 'agent.peer', name: 'peer', tools: ['Read', 'send_agent_message'] })],
    );
    expect(agents.peer!.tools).toEqual(['Read', 'send_agent_message']);
  });

  it('the option seam threads the pool through', () => {
    const options = buildClaudeRuntimeAgentOptions({
      definitions: [descriptor({ key: 'agent.peer', name: 'peer', tools: ['send_agent_message'] })],
      mini: false,
      availableToolNames: CLAUDE_POOL,
    });
    expect(options.agents!.peer!.tools).toEqual(['send_agent_message', 'list_sessions']);
  });
});

/**
 * P6.790 (P6.342 split a) — THE DIGEST-POSITION RULE, pinned mechanically.
 *
 * `PiRuntimeAgentDefinitionDescriptor`'s own docblock states the constraint in
 * capitals: *"every key added here must be appended LAST in both object
 * literals that build a descriptor — `buildPiRuntimeAgentDescriptor`'s
 * `descriptor` and `parseDefinitionEntry`'s `parsed` — or the two sides hash
 * differently and every definition carrying it fails the digest check and
 * vanishes from the session."*
 *
 * Until now that rule was a comment. Its failure mode is the worst kind: no
 * exception, no diagnostic, no red test — every definition carrying the new key
 * simply stops existing for the session, and the two sides only disagree for
 * definitions that actually populate it, so a fixture that leaves it unset stays
 * green. P6.790 hands the next lane a key to add to that descriptor
 * (`mcpServerInline`, parsed in `agents/definitions.ts` and carried nowhere
 * yet), so the rule is pinned FIRST.
 *
 * Read from SOURCE rather than exercised, because `buildPiRuntimeAgentDescriptor`
 * is not exported and because the round-trip only fails for a descriptor that
 * populates the divergent key — which is exactly what the lane adding it would
 * not have.
 */
describe('the descriptor digest-position rule (P6.790)', () => {
  const SOURCE_PATH = new URL('../pi-harness/runtime-agent-definition.ts', import.meta.url).pathname;
  const source = readFileSync(SOURCE_PATH, 'utf-8');

  /**
   * The lines of one object literal, from its `const <name> = {` to its own
   * closing brace — searched from the declaration of the function named by
   * `owner` rather than from the top of the file.
   *
   * The owner is not decoration. This read used to take the FIRST
   * `const descriptor = {` in the file, and `492bd901d` (P6.317 (2)) inserted a
   * THIRD producer, `buildSessionAgentDescriptor`, above the one this rule is
   * about: the 1.36.0 wave gate then reported `tier missing from
   * buildPiRuntimeAgentDescriptor` while that function emits `tier` in the right
   * position and the literal being read belonged to another function entirely.
   */
  function literalBody(owner: string, declaration: string): string[] {
    const lines = source.split('\n');
    const ownerLine = lines.findIndex(line => line.startsWith(owner));
    expect(ownerLine, owner).toBeGreaterThan(-1);
    const start = lines.findIndex((line, index) => index > ownerLine && line.trim() === declaration);
    expect(start, declaration).toBeGreaterThan(-1);
    const indent = lines[start]!.length - lines[start]!.trimStart().length;
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (line.trim() === '}' && line.length - line.trimStart().length === indent) {
        return lines.slice(start + 1, i);
      }
    }
    throw new Error(`unterminated literal: ${declaration}`);
  }

  /** The key each line contributes, in source order — plain, shorthand, or a spread. */
  function keyOrder(body: readonly string[]): string[] {
    const keys: string[] = [];
    for (const line of body) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      if (trimmed.startsWith('...')) {
        // `...(cond ? { key } : {})` and `...(cond === undefined ? {} : { key })`
        // both reach the same place: the first `{` carrying an identifier.
        const spread = /\{\s*([A-Za-z][A-Za-z0-9_]*)\s*[:}]/.exec(trimmed);
        if (spread?.[1]) keys.push(spread[1]);
        continue;
      }
      const plain = /^([A-Za-z][A-Za-z0-9_]*)\s*[:,]/.exec(trimmed);
      if (plain?.[1]) keys.push(plain[1]);
    }
    return keys;
  }

  const produced = keyOrder(literalBody('function buildPiRuntimeAgentDescriptor(', 'const descriptor = {'));
  const parsed = keyOrder(literalBody('function parseDefinitionEntry(', 'const parsed = {'));
  /**
   * The THIRD producer (`492bd901d`, P6.317 (2)): a `--agents` JSON entry, whose
   * input type {@link SessionAgentDefinitionV1} declares neither `tier` nor
   * `color`, so its literal emits neither. That is not a digest break — a key
   * absent on BOTH sides hashes identically — and the rule it must obey is the
   * weaker one asserted below: the keys it does emit stay in `parsed`'s order.
   */
  const sessionProduced = keyOrder(literalBody('function buildSessionAgentDescriptor(', 'const descriptor = {'));

  it('both literals emit their keys in the SAME order', () => {
    // The control first: a body that failed to extract would make the equality
    // below pass on two empty arrays.
    expect(produced.length).toBeGreaterThan(10);
    expect(parsed.length).toBe(produced.length);
    expect(parsed).toEqual(produced);
  });

  it('the session-agent literal emits its own keys in that same order', () => {
    expect(sessionProduced.length).toBeGreaterThan(10);
    // A SUBSEQUENCE, not an equality: omitting a key the caller cannot supply is
    // safe, reordering the rest is the silent-vanish failure this rule exists
    // for. `parsed` restricted to what this route emits must be exactly it.
    expect(parsed.filter(key => sessionProduced.includes(key))).toEqual(sessionProduced);
  });

  it('every declared descriptor field is emitted by both literals', () => {
    // The other half of the same rule, and the failure a source-order check
    // alone cannot see: a key added to the INTERFACE and to only one literal
    // still leaves the two hashing differently.
    const lines = source.split('\n');
    const start = lines.findIndex(line => line.startsWith('export interface PiRuntimeAgentDefinitionDescriptor {'));
    expect(start).toBeGreaterThan(-1);
    const end = lines.findIndex((line, index) => index > start && line === '}');
    const declared: string[] = [];
    for (const line of lines.slice(start + 1, end)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) continue;
      const field = /^([A-Za-z][A-Za-z0-9_]*)\??:/.exec(trimmed);
      // `definitionDigest` is the one exception BY CONSTRUCTION: it is the hash
      // OF the literal, so it is spread on afterwards and can never appear in it.
      if (field?.[1] && field[1] !== 'definitionDigest') declared.push(field[1]);
    }
    expect(declared.length).toBeGreaterThan(10);
    for (const field of declared) {
      expect(produced, `${field} missing from buildPiRuntimeAgentDescriptor`).toContain(field);
      expect(parsed, `${field} missing from parseDefinitionEntry`).toContain(field);
    }
  });

  it('every field the session-agent literal omits is one its caller cannot supply', () => {
    // The bound on the subsequence rule above, so "omitted" can never mean
    // "dropped". A `--agents` entry is JSON typed by `SessionAgentDefinitionV1`;
    // a descriptor field that route leaves out must have no field there to leave
    // out. Adding `color` to that interface without emitting it fails here.
    const definitions = readFileSync(
      new URL('../../agents/definitions.ts', import.meta.url).pathname,
      'utf-8',
    ).split('\n');
    const start = definitions.findIndex(line =>
      line.startsWith('export interface SessionAgentDefinitionV1 {'));
    expect(start).toBeGreaterThan(-1);
    const end = definitions.findIndex((line, index) => index > start && line === '}');
    const acceptedFromCaller = new Set<string>();
    for (const line of definitions.slice(start + 1, end)) {
      const field = /^([A-Za-z][A-Za-z0-9_]*)\??:/.exec(line.trim());
      if (field?.[1]) acceptedFromCaller.add(field[1]);
    }
    expect(acceptedFromCaller.size).toBeGreaterThan(10);
    for (const field of produced) {
      if (sessionProduced.includes(field)) continue;
      expect(acceptedFromCaller, `${field} is accepted from a --agents entry and then dropped`)
        .not.toContain(field);
    }
  });
});
