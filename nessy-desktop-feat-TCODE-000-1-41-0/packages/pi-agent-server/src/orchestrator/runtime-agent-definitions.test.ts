import { describe, expect, it } from 'bun:test'

import {
  isAlwaysAvailableSubagentTool,
  mcpServerLevelGrantCovers,
  normalizePiRuntimeAgentToolName,
  piRuntimeAgentWorktreePolicy,
} from '../../../shared/src/agent/pi-harness/runtime-agent-definition.ts'
import { buildPiRuntimeAgentDefinitions } from './runtime-agent-definitions.ts'

const base = {
  schemaVersion: 2 as const,
  key: 'plugin://honey#agent.hive-scout@workspace',
  name: 'hive-scout',
  description: 'Honey scout',
  selectedAsUnqualifiedAlias: true,
  systemPrompt: 'Inspect concisely.',
  sha256: 'a'.repeat(64),
  provenance: 'plugin://honey#agent.hive-scout@workspace@generation-1',
  capabilityGeneration: 'generation-1',
  definitionDigest: 'b'.repeat(64),
}

/** A parent manifest shaped like production's: working tools + orchestration + MCP. */
const ALL_PARENT_TOOLS = [
  'read', 'grep', 'find', 'ls', 'bash', 'write', 'edit', 'NotebookEdit',
  'web_search', 'web_fetch', 'bash_background', 'ask_user', 'mcp__tool_search',
  'subagent', 'review', 'get_subagent_result', 'steer_subagent', 'stopTask', 'workflow',
  'mcp__gitlab__repos',
]

/**
 * Depth budgets for the `subagent` withhold (sub-agents.md:867). A definition
 * built by a session at `sessionDepth` describes a child at `sessionDepth + 1`;
 * the child is AT the limit when it could not spawn further.
 */
const BELOW_LIMIT = { sessionDepth: 0, maxDepth: 3 }
const AT_LIMIT = { sessionDepth: 2, maxDepth: 3 }

describe('Pi imported agent definition adapter', () => {
  it('never grants ask_user to a subagent — inherited or explicitly requested', () => {
    // agent-sdk/user-input.md: "AskUserQuestion is not currently available in
    // subagents spawned via the Agent tool." Our ask_user follows.
    const [inherited] = buildPiRuntimeAgentDefinitions([{ ...base }], ALL_PARENT_TOOLS, undefined, BELOW_LIMIT)
    expect(inherited!.tools).not.toContain('ask_user')

    const [explicit] = buildPiRuntimeAgentDefinitions([{
      ...base,
      tools: ['Read', 'ask_user'],
    }], ALL_PARENT_TOOLS, undefined, BELOW_LIMIT)
    expect(explicit!.tools).toEqual(['read'])
  })

  it('maps external tool spelling onto exact Pi tools and stays read-only', () => {
    const [definition] = buildPiRuntimeAgentDefinitions([{
      ...base,
      tools: ['Read', 'Grep', 'Glob'],
    }], ['read', 'grep', 'find', 'bash'], undefined, BELOW_LIMIT)

    expect(definition).toMatchObject({
      name: 'hive-scout',
      aliases: [base.key, 'hive-scout'],
      tools: ['read', 'grep', 'find'],
      toolset: 'read-only',
      systemPrompt: 'Inspect concisely.',
      definitionKey: base.key,
    })
  })

  it('narrows the standard mini-agent tool surface without failing a read-only child startup', () => {
    const [definition] = buildPiRuntimeAgentDefinitions([{
      ...base,
      tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
    }], ['read', 'grep', 'find'], undefined, BELOW_LIMIT)

    expect(definition).toMatchObject({
      tools: ['read', 'find', 'grep'],
      // P8 — `toolset` reads the DECLARED list, so an author who asked for
      // `Edit`/`Write`/`Bash` keeps the isolated worktree even in a session that
      // cannot honour those grants. This row read `read-only` before, which is
      // the reading the host never shared: it derives the same verdict from the
      // same declared list and would have refused the spawn outright.
      toolset: 'full',
    })
  })

  it('normalizes the live diary agent tool aliases and safely denies an unavailable known target', () => {
    const diaryTools = [
      'Glob',
      'Grep',
      'ListFiles',
      'ReadFile',
      'ReadManyFiles',
      'NotebookRead',
      'WebFetch',
      'TodoWrite',
    ]
    const [withoutTodoRuntime] = buildPiRuntimeAgentDefinitions(
      [{ ...base, tools: diaryTools }],
      ['read', 'grep', 'find', 'ls', 'web_fetch'],
      undefined,
      BELOW_LIMIT,
    )
    const [withTodoRuntime] = buildPiRuntimeAgentDefinitions(
      [{ ...base, tools: diaryTools }],
      ['read', 'grep', 'find', 'ls', 'web_fetch', 'mcp__session__TodoWrite'],
      undefined,
      BELOW_LIMIT,
    )

    expect(withoutTodoRuntime).toMatchObject({
      tools: ['find', 'grep', 'ls', 'read', 'web_fetch'],
      // P8 — the DECLARED list carries `TodoWrite`, which is not read-only, so
      // both sessions land on the same side of the worktree rule. The tool list
      // still differs (the grant is denied by omission where the manifest lacks
      // it); only the policy no longer swings on whether it resolved, because
      // the host reads the declared list and cannot see that it did not.
      toolset: 'full',
    })
    expect(withTodoRuntime).toMatchObject({
      tools: ['find', 'grep', 'ls', 'read', 'web_fetch', 'mcp__session__TodoWrite'],
      toolset: 'full',
    })
  })

  /**
   * Claude Code renamed its subagent tool `Task` → `Agent`, and marketplace
   * plugins declare the current name (`skill-evaluator`'s `experimenter` agent
   * lists `Agent`). An unrecognized name fails the whole turn closed, so an
   * unmapped `Agent` made every chat in the session error out after installing
   * such a plugin. It resolves to the same Pi tool `Task` already did.
   */
  it('maps the Claude subagent tool under both its Task and Agent spellings', () => {
    const [fromTask] = buildPiRuntimeAgentDefinitions(
      [{ ...base, tools: ['Read', 'Task'] }],
      ['read', 'subagent'],
      undefined,
      BELOW_LIMIT,
    )
    const [fromAgent] = buildPiRuntimeAgentDefinitions(
      [{ ...base, tools: ['Read', 'Agent'] }],
      ['read', 'subagent'],
      undefined,
      BELOW_LIMIT,
    )

    expect(fromAgent!.tools).toEqual(fromTask!.tools)
    expect(fromAgent!.tools).toContain('subagent')
  })

  it('denies the Claude subagent tool by omission when the runtime has no subagent', () => {
    const [definition] = buildPiRuntimeAgentDefinitions(
      [{ ...base, tools: ['Read', 'Agent'] }],
      ['read'],
      undefined,
      BELOW_LIMIT,
    )

    expect(definition!.tools).toEqual(['read'])
  })

  /**
   * R2: `tools-reference.md` opens with "The tool names are the exact strings
   * you use in permission rules, subagent tool lists, and hook matchers", so an
   * imported Claude agent declares `EnterWorktree` verbatim. Without an alias
   * entry that name does NOT merely get dropped — `resolveExplicitTools` pushes
   * it onto `unresolved` and throws, taking the whole imported agent with it.
   * Asserted through `buildPiRuntimeAgentDefinitions`, the production builder.
   */
  it('resolves the documented worktree tool names from an imported agent tool list', () => {
    const [definition] = buildPiRuntimeAgentDefinitions(
      [{ ...base, tools: ['Read', 'EnterWorktree', 'ExitWorktree'] }],
      ['read', 'mcp__session__EnterWorktree', 'mcp__session__ExitWorktree'],
      undefined,
      BELOW_LIMIT,
    )

    expect(definition!.tools).toEqual([
      'read', 'mcp__session__EnterWorktree', 'mcp__session__ExitWorktree',
    ])
  })

  it('resolves the worktree tools under the host binding spelling too', () => {
    const [definition] = buildPiRuntimeAgentDefinitions(
      [{ ...base, tools: ['EnterWorktree'] }],
      ['mcp__session__EnterWorktree'],
      undefined,
      BELOW_LIMIT,
    )

    expect(definition!.tools).toEqual(['mcp__session__EnterWorktree'])
  })

  /**
   * R5: Claude names the model-facing MCP resource tools `ListMcpResourcesTool`
   * / `ReadMcpResourceTool` in permission rules and subagent tool lists. Without
   * the alias entries an imported agent declaring them throws instead of
   * resolving — the same failure class as EnterWorktree.
   */
  it('resolves the documented MCP resource tool names from an imported agent tool list', () => {
    const [definition] = buildPiRuntimeAgentDefinitions(
      [{ ...base, tools: ['Read', 'ListMcpResourcesTool', 'ReadMcpResourceTool'] }],
      ['read', 'mcp__session__list_mcp_resources', 'mcp__session__read_mcp_resource'],
      undefined,
      BELOW_LIMIT,
    )

    expect(definition!.tools).toEqual([
      'read', 'mcp__session__list_mcp_resources', 'mcp__session__read_mcp_resource',
    ])
  })

  /**
   * P2: this used to `throw` — `Unavailable runtime agent tool(s): missing-tool`
   * — and the throw was not scoped to the agent that carried the bad entry. The
   * builder runs inside `buildSessionDefinition` (`index.ts`), so ONE
   * unresolvable entry in ONE installed plugin's agent killed every turn of
   * every session.
   *
   * errors.md § *Agent would be spawned with zero tools*: "Every entry in the
   * subagent's `tools` list failed to match a usable tool, so Claude Code
   * refused to launch the subagent". The refusal needs EVERY entry to fail, it
   * costs one launch ("pass a different subagent_type"), and an entry that
   * merely "matches no tool name" is dropped from the list. Fail-closed on
   * authority (nothing is granted) is preserved; fail-closed on the session is
   * not a safety property, it is an outage.
   */
  it('drops an unresolvable entry instead of failing the session', () => {
    const [definition] = buildPiRuntimeAgentDefinitions(
      [{ ...base, tools: ['Read', 'missing-tool'] }],
      ['read'],
      undefined,
      BELOW_LIMIT,
    )

    expect(definition!.tools).toEqual(['read'])
  })

  /**
   * D7. This used to THROW, and the throw ran inside `buildSessionDefinition` —
   * so one stale descriptor did not fail one agent, it killed every turn of the
   * session from that point on, unrecoverably from the UI. Exactly the outage
   * shape the unresolvable-entry test above already rules out, one field over.
   *
   * Measured live 2026-08-14 on a real profile: any mid-session capability
   * re-registration that bumps the generation (a source enabled or disabled, a
   * plugin installed) left the init-time descriptors behind and the next turn
   * died. Three reproductions, two controls. The precondition is ordinary — an
   * installed plugin that ships an agent capability is enough.
   */
  it('drops a stale-generation descriptor and names it, instead of failing the session', () => {
    const lines: string[] = []
    const definitions = buildPiRuntimeAgentDefinitions(
      [base],
      ['read'],
      'generation-2',
      BELOW_LIMIT,
      { debugLog: message => lines.push(message) },
    )

    expect(definitions).toEqual([])
    // NAMED, not silent: a dropped agent that says nothing is a grant that
    // vanishes with nothing to look at.
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(base.key)
    expect(lines[0]).toContain(base.capabilityGeneration)
    expect(lines[0]).toContain('generation-2')
  })

  it('keeps the healthy descriptors when only one of them is stale', () => {
    // The mixed list is the realistic shape: a re-registration refreshes what
    // the current view holds, and anything the view no longer carries stays
    // behind at its old stamp.
    const definitions = buildPiRuntimeAgentDefinitions(
      [
        { ...base, key: 'stale-one', capabilityGeneration: 'generation-1' },
        { ...base, key: 'fresh-one', capabilityGeneration: 'generation-2' },
      ],
      ['read'],
      'generation-2',
      BELOW_LIMIT,
    )

    expect(definitions.map(definition => definition.definitionKey)).toEqual(['fresh-one'])
  })

  it('inherits the parent tool ceiling when tools are omitted and marks it full', () => {
    const [definition] = buildPiRuntimeAgentDefinitions([
      { ...base, selectedAsUnqualifiedAlias: false },
    ], ['read', 'bash', 'mcp__gitlab__repos'], undefined, BELOW_LIMIT)

    expect(definition).toMatchObject({
      name: base.key,
      aliases: [base.key],
      tools: ['read', 'bash', 'mcp__gitlab__repos'],
      toolset: 'full',
      definitionKey: base.key,
    })
  })

  /**
   * A tool-less descriptor used to inherit the parent's ENTIRE manifest, which
   * includes the orchestration tools. That made every imported agent able to
   * steer the parent's children and stop its background tasks without ever
   * asking for it. The five non-subagent tools stay withheld at every depth;
   * `subagent` alone is depth-derived (sub-agents.md:867) and is covered below.
   */
  it('never gives a tool-less descriptor the non-subagent orchestration tools, at any depth', () => {
    for (const budget of [BELOW_LIMIT, AT_LIMIT]) {
      const [definition] = buildPiRuntimeAgentDefinitions([base], ALL_PARENT_TOOLS, undefined, budget)

      for (const orchestration of ['review', 'get_subagent_result', 'steer_subagent', 'stopTask', 'workflow']) {
        expect(definition!.tools, orchestration).not.toContain(orchestration)
      }
    }
  })

  it('keeps subagent in a tool-less descriptor inherited pool below the depth limit and drops it at the limit', () => {
    // sub-agents.md:867 — "By default, a subagent can spawn subagents of its
    // own" (below the limit the inherited pool keeps `subagent`); "At the depth
    // limit, Claude Code withholds the `Agent` tool from every subagent except
    // a fork". A fork never passes through this builder — its pool is the
    // session's own — so no fork carve-out exists here to test.
    const [below] = buildPiRuntimeAgentDefinitions([base], ALL_PARENT_TOOLS, undefined, BELOW_LIMIT)
    expect(below!.tools).toContain('subagent')

    const [atLimit] = buildPiRuntimeAgentDefinitions([base], ALL_PARENT_TOOLS, undefined, AT_LIMIT)
    expect(atLimit!.tools).not.toContain('subagent')
  })

  it('still gives a tool-less descriptor the ordinary working tools', () => {
    const [definition] = buildPiRuntimeAgentDefinitions([base], ALL_PARENT_TOOLS, undefined, BELOW_LIMIT)

    expect(definition!.tools).toContain('read')
    expect(definition!.tools).toContain('bash')
    expect(definition!.tools).toContain('write')
    expect(definition!.tools).toContain('mcp__gitlab__repos')
  })

  it('leaves an explicit tool list untouched below the depth limit, orchestration included', () => {
    const [definition] = buildPiRuntimeAgentDefinitions(
      [{ ...base, tools: ['read', 'subagent'] }],
      ALL_PARENT_TOOLS,
      undefined,
      BELOW_LIMIT,
    )

    expect(definition!.tools).toEqual(['read', 'subagent'])
  })

  it('withholds an explicitly requested subagent at the depth limit', () => {
    // sub-agents.md:331 — the first filter removes "`Agent`, when the subagent
    // is at the depth limit", "even when listed in the `tools` field".
    const [definition] = buildPiRuntimeAgentDefinitions(
      [{ ...base, tools: ['read', 'subagent'] }],
      ALL_PARENT_TOOLS,
      undefined,
      AT_LIMIT,
    )

    expect(definition!.tools).toEqual(['read'])
    // The withhold does NOT flow into the worktree rule, and P8 is why. This
    // used to assert `read-only` on the reasoning that an at-limit agent left
    // with read-only tools may as well share the tree — sound in isolation, and
    // wrong in composition: the host derives the policy from the DECLARED list,
    // where `subagent` still sits, so it expected `isolated-worktree`, and the
    // "shared tree" outcome was never reached — the spawn was refused with
    // `runtime-agent-worktree-policy-mismatch`. The two sides now read one rule
    // over one list, and it is the stricter of the two answers.
    expect(definition!.toolset).toBe('full')
  })

  it('does not change toolset or worktreePolicy for any existing descriptor shape', () => {
    // `toolset` drives `worktreePolicy` (spawner.ts: 'full' => isolated-worktree,
    // otherwise 'shared'), so subtracting tools must not flip an agent out of its
    // isolated worktree and into the live tree. The expectations below were
    // CAPTURED from the pre-change implementation, so they pin reality.
    const shapes: Array<[string, Record<string, unknown>, 'full' | 'read-only']> = [
      ['tool-less', { ...base }, 'full'],
      ['tool-less, no unqualified alias', { ...base, selectedAsUnqualifiedAlias: false }, 'full'],
      ['explicit read-only only', { ...base, tools: ['read', 'grep'] }, 'read-only'],
      ['explicit read-only incl get_subagent_result', { ...base, tools: ['read', 'get_subagent_result'] }, 'read-only'],
      ['explicit with bash', { ...base, tools: ['read', 'bash'] }, 'full'],
      ['explicit with subagent', { ...base, tools: ['read', 'subagent'] }, 'full'],
      ['explicit empty array', { ...base, tools: [] }, 'read-only'],
      ['explicit all parent tools', { ...base, tools: [...ALL_PARENT_TOOLS] }, 'full'],
    ]

    for (const [label, shape, baselineToolset] of shapes) {
      const [definition] = buildPiRuntimeAgentDefinitions([shape as never], ALL_PARENT_TOOLS, undefined, BELOW_LIMIT)
      expect(definition!.toolset, label).toBe(baselineToolset)
    }
  })

  it('never grants an imported agent an unqualified immutable built-in name', () => {
    const descriptor = {
      ...base,
      key: 'plugin://evil#agent.scout',
      name: 'scout',
      selectedAsUnqualifiedAlias: true,
    }
    const [definition] = buildPiRuntimeAgentDefinitions([descriptor], ['read'], undefined, BELOW_LIMIT)

    expect(definition).toMatchObject({
      name: descriptor.key,
      aliases: [descriptor.key],
      definitionKey: descriptor.key,
    })
  })
})

describe('R20 — the task tools stay available to a restricted subagent', () => {
  const available = [
    'read', 'edit', 'bash',
    'mcp__session__TaskCreate', 'mcp__session__TaskUpdate',
    'mcp__session__TaskGet', 'mcp__session__TaskList',
  ]

  const build = (tools?: string[]) => buildPiRuntimeAgentDefinitions(
    [{ key: 'k', name: 'agent', description: 'd', prompt: 'p', ...(tools ? { tools } : {}) } as never],
    available,
    undefined,
    BELOW_LIMIT,
  )[0] as unknown as { tools: string[]; toolset: string }

  it('a tools allowlist cannot remove them', () => {
    // agent-teams.md: "the task management tools are always available to a
    // teammate even when `tools` restricts other tools."
    const definition = build(['read'])
    expect(definition.tools).toContain('read')
    expect(definition.tools).toContain('mcp__session__TaskCreate')
    expect(definition.tools).toContain('mcp__session__TaskUpdate')
    expect(definition.tools).toContain('mcp__session__TaskGet')
    expect(definition.tools).toContain('mcp__session__TaskList')
  })

  it('they do NOT widen a read-only agent into an isolated worktree', () => {
    // `toolset` decides `worktreePolicy`; the two writing task tools are not
    // read-only, so computing it AFTER the union would flip a read-only agent
    // out of the shared tree.
    expect(build(['read']).toolset).toBe('read-only')
    expect(build(['read', 'edit']).toolset).toBe('full')
  })

  it('an unrestricted agent still gets them, without duplicates', () => {
    const tools = build().tools
    expect(tools.filter(name => name === 'mcp__session__TaskList')).toHaveLength(1)
  })

  it('nothing is invented when the manifest does not carry them', () => {
    const definition = buildPiRuntimeAgentDefinitions(
      [{ key: 'k', name: 'agent', description: 'd', prompt: 'p', tools: ['read'] } as never],
      ['read', 'edit'],
      undefined,
      BELOW_LIMIT,
    )[0] as unknown as { tools: string[] }
    expect(definition.tools).toEqual(['read'])
  })
})

/**
 * Q10-2 — R20 and R27a were measured against a pool spelling no session carries.
 *
 * `SUBAGENT_ALWAYS_AVAILABLE_TOOLS` listed `TaskCreate`/`TaskUpdate`/`TaskGet`/
 * `TaskList`/`ReportFindings` and matched them with `name === tool ||
 * name.endsWith('__' + tool)`. Those are handlerName/permissionName spellings.
 * The pool is `manifest.tools.map(t => t.binding.piName)` (`index.ts`), and
 * `sessionBinding('task_create', 'TaskCreate')` makes that piName
 * `mcp__session__TaskCreate` — so the suffix compare matched NOTHING and the
 * union was inert in every real session. The R20 and R27a fixtures above pass
 * only because they were written with the bindingName spelling
 * (`mcp__session__TaskCreate`); the P7 fixture further down deliberately uses
 * the production spelling and notes that it keeps `alwaysAvailableTools` out of
 * its expectations, which is the inertness recorded without being recognized.
 *
 * The consequence, which is what this pins: a restricted subagent — including
 * the read-only `reviewer`/`auditor` builtins `ReportFindings` exists for —
 * silently lost the tools agent-teams.md says are "always available to a
 * teammate even when `tools` restricts other tools".
 *
 * The fix reuses `normalizePiRuntimeAgentToolName`, the alias table both sides
 * of the Pi boundary already read, rather than adding a second name table.
 */
describe('Q10-2 — the always-available set names the tools the pool carries', () => {
  /** Production spelling: `binding.piName`, exactly as `index.ts` builds it. */
  const available = [
    'read', 'edit', 'grep',
    'mcp__session__TaskCreate', 'mcp__session__TaskUpdate',
    'mcp__session__TaskGet', 'mcp__session__TaskList',
    'mcp__session__ReportFindings',
  ]

  const build = (tools?: string[]) => buildPiRuntimeAgentDefinitions(
    [{ ...base, ...(tools ? { tools } : {}) }],
    available,
    undefined,
    BELOW_LIMIT,
  )[0] as unknown as { tools: string[]; toolset: string }

  it('a tools allowlist cannot remove the task tools', () => {
    const tools = build(['read']).tools
    expect(tools).toContain('read')
    expect(tools).toContain('mcp__session__TaskCreate')
    expect(tools).toContain('mcp__session__TaskUpdate')
    expect(tools).toContain('mcp__session__TaskGet')
    expect(tools).toContain('mcp__session__TaskList')
  })

  it('a read-only reviewer can still report findings', () => {
    expect(build(['read', 'grep']).tools).toContain('mcp__session__ReportFindings')
  })

  it('still does NOT widen a read-only agent into an isolated worktree', () => {
    // `toolset` reads the DECLARED list (P8), so the union cannot reach it.
    expect(build(['read']).toolset).toBe('read-only')
    expect(build(['read', 'edit']).toolset).toBe('full')
  })

  it('invents nothing the manifest does not carry, and never duplicates', () => {
    const bare = buildPiRuntimeAgentDefinitions(
      [{ ...base, tools: ['read'] }],
      ['read', 'edit'],
      undefined,
      BELOW_LIMIT,
    )[0] as unknown as { tools: string[] }
    expect(bare.tools).toEqual(['read'])
    expect(build().tools.filter(name => name === 'mcp__session__TaskList')).toHaveLength(1)
  })

  it('grants no session tool that is not on the list', () => {
    // No widening: the normalizer maps many spellings onto one tool, so the
    // pinned negative is that an unlisted session tool stays out.
    const tools = buildPiRuntimeAgentDefinitions(
      [{ ...base, tools: ['read'] }],
      [...available, 'mcp__session__PushNotification', 'mcp__session__SendUserFile'],
      undefined,
      BELOW_LIMIT,
    )[0] as unknown as { tools: string[] }
    expect(tools.tools).not.toContain('mcp__session__PushNotification')
    expect(tools.tools).not.toContain('mcp__session__SendUserFile')
  })

  /**
   * The other half, and the reason this cannot land on the Pi side alone: the
   * HOST re-validates a child's ARRIVING tools against the pinned definition's
   * DECLARED list (`SessionManager.ts`, `runtime-agent-tool-unavailable:<tool>`).
   * An always-available tool is by construction NOT in that declared list, so
   * teaching only this side would trade a silently-inert union for a spawn-fatal
   * refusal on every restricted agent — the exact trade P6b, P7 and P8 each
   * already paid once.
   */
  it('agrees with the host admission check', () => {
    const declared = ['Read']
    const definition = build(declared)
    const declaredTools = declared.map(normalizePiRuntimeAgentToolName)
    const declaredToolSet = new Set(declaredTools)

    const refused = definition.tools.find(tool => (
      !declaredToolSet.has(normalizePiRuntimeAgentToolName(tool))
      && !declaredTools.some(entry => mcpServerLevelGrantCovers(entry, tool))
      && !isAlwaysAvailableSubagentTool(tool)
    ))
    expect(refused).toBeUndefined()
  })
})

describe('R27a — the delivery tools reach the agents they were written for', () => {
  const available = [
    'read', 'grep', 'find', 'ls',
    'mcp__session__ReportFindings',
    'mcp__session__PushNotification',
    'mcp__session__SendUserFile',
  ]

  const build = (tools?: string[]) => buildPiRuntimeAgentDefinitions(
    [{ key: 'k', name: 'agent', description: 'd', prompt: 'p', ...(tools ? { tools } : {}) } as never],
    available,
    undefined,
    BELOW_LIMIT,
  )[0] as unknown as { tools: string[] }

  it('a read-only reviewer can still report findings', () => {
    // `BUILTIN_AGENT_DEFINITIONS` gives `reviewer` and `auditor` exactly
    // ['read','grep','find','ls']. `ReportFindings` exists so a review agent can
    // hand back structured findings instead of prose, so a ceiling that removes
    // it makes the tool unreachable from the only agent it was written for.
    const tools = build(['read', 'grep']).tools
    expect(tools).toContain('mcp__session__ReportFindings')
  })

  it('does NOT implicitly grant the two tools with side effects', () => {
    // `PushNotification` reaches the OS and `SendUserFile` delivers file
    // content; neither is safe to hand a restricted agent it did not ask for.
    const tools = build(['read']).tools
    expect(tools).not.toContain('mcp__session__PushNotification')
    expect(tools).not.toContain('mcp__session__SendUserFile')
  })

  it.each(['ReportFindings', 'PushNotification', 'SendUserFile'])(
    'an imported Claude agent naming %s resolves instead of being rejected whole',
    (documentedName) => {
      // `resolveExplicitTools` THROWS on an unresolved name, so a missing alias
      // does not skip the tool — it rejects the entire agent. Same failure shape
      // R2 recorded for `EnterWorktree` and `TodoWrite`.
      expect(() => build(['Read', documentedName])).not.toThrow()
      expect(build(['Read', documentedName]).tools)
        .toContain(`mcp__session__${documentedName}`)
    },
  )
})

/**
 * R27b — the alias table has to keep up with the tool table.
 *
 * `resolveExplicitTools` THROWS on a name it cannot resolve, so a missing alias
 * entry does not skip one tool: it rejects the whole imported agent. R27a added
 * entries for the three delivery tools it shipped; the three Cron tools landed
 * two hours later with none, and the four task tools never had any either —
 * even though they are unioned in unconditionally, so an agent that NAMES one
 * failed to load while an agent that stayed silent got it for free.
 *
 * Every name below is a canonical Claude tool name (tools-reference.md's tool
 * table) with an exact Pi counterpart in the binding table.
 */
describe('R27b — every documented tool name with a Pi counterpart resolves', () => {
  const available = [
    'read', 'notebook_edit', 'ask_user', 'mcp__tool_search', 'stopTask',
    'mcp__session__Monitor',
    'mcp__session__CronCreate', 'mcp__session__CronList', 'mcp__session__CronDelete',
    'mcp__session__TaskCreate', 'mcp__session__TaskUpdate',
    'mcp__session__TaskGet', 'mcp__session__TaskList',
  ]

  const build = (tools: string[]) => buildPiRuntimeAgentDefinitions(
    [{ key: 'k', name: 'agent', description: 'd', prompt: 'p', tools } as never],
    available,
    undefined,
    BELOW_LIMIT,
  )[0] as unknown as { tools: string[] }

  it.each([
    ['CronCreate', 'mcp__session__CronCreate'],
    ['CronList', 'mcp__session__CronList'],
    ['CronDelete', 'mcp__session__CronDelete'],
    ['TaskCreate', 'mcp__session__TaskCreate'],
    ['TaskUpdate', 'mcp__session__TaskUpdate'],
    ['TaskGet', 'mcp__session__TaskGet'],
    ['TaskList', 'mcp__session__TaskList'],
    ['TaskStop', 'stopTask'],
    ['Monitor', 'mcp__session__Monitor'],
    ['NotebookEdit', 'notebook_edit'],
    ['ToolSearch', 'mcp__tool_search'],
  ])('an agent declaring %s loads and gets %s', (documentedName, piName) => {
    expect(() => build(['Read', documentedName])).not.toThrow()
    expect(build(['Read', documentedName]).tools).toContain(piName)
  })

  it('AskUserQuestion loads, and is still denied to a subagent', () => {
    // agent-sdk/user-input.md keeps `ask_user` off subagents; the alias exists so
    // naming it drops the tool instead of rejecting the agent.
    expect(() => build(['Read', 'AskUserQuestion'])).not.toThrow()
    expect(build(['Read', 'AskUserQuestion']).tools).not.toContain('ask_user')
  })

  it('nothing is invented when the manifest does not carry the tool', () => {
    const narrow = buildPiRuntimeAgentDefinitions(
      [{ key: 'k', name: 'agent', description: 'd', prompt: 'p', tools: ['Read', 'CronList'] } as never],
      ['read'],
      undefined,
      BELOW_LIMIT,
    )[0] as unknown as { tools: string[] }
    expect(narrow.tools).toEqual(['read'])
  })
})

/**
 * P2 — a parametrized grant costs one tool, never the turn.
 *
 * Live evidence, signed 1.25.0: installing the official `claude-security`
 * plugin made EVERY Pi turn fail, and uninstalling it fixed them; the Claude
 * runtime was unaffected, which puts the fault on this Pi-only path. The
 * plugin's agents declare `tools` in the documented parametrized form —
 * `Agent(a, b)`, `Workflow(x)` — which no branch of `resolveExplicitTools`
 * could resolve, so every one landed in `unresolved` and threw out of
 * `buildSessionDefinition`, the per-generation session builder.
 *
 * The two rules below are BOTH from sub-agents.md § *Restrict which subagents
 * can be spawned*: "The `Agent(agent_type)` allowlist syntax applies only to an
 * agent running as the main thread with `claude --agent`. In a subagent
 * definition, listing `Agent` in `tools` lets that subagent spawn subagents of
 * its own while the depth limit allows it, but any type list inside the
 * parentheses is ignored." Every definition this builder produces IS a subagent
 * definition (`childDepth = sessionDepth + 1`), so `Agent(...)` is `Agent` with
 * the parenthetical discarded — no more, and no less.
 */
describe('P2 — parametrized tool grants resolve or drop, and never throw', () => {
  const available = ['read', 'grep', 'bash', 'subagent', 'workflow']

  const build = (
    tools: string[],
    budget: { sessionDepth: number; maxDepth: number } = BELOW_LIMIT,
  ) => buildPiRuntimeAgentDefinitions(
    [{ ...base, tools }],
    available,
    undefined,
    budget,
  )[0] as unknown as { tools: string[]; toolset: string }

  it.each(['Agent(a, b)', 'Agent(worker)', 'Task(a, b)', 'agent(a,b)'])(
    '%s grants the subagent tool with the type list ignored',
    (spelling) => {
      expect(() => build(['Read', spelling])).not.toThrow()
      expect(build(['Read', spelling]).tools).toEqual(['read', 'subagent'])
    },
  )

  it('still withholds a parametrized Agent grant at the depth limit', () => {
    // sub-agents.md § *Available tools*, the first filter: "`Agent`, when the
    // subagent is at the depth limit", removed "even when listed in the `tools`
    // field". The parenthetical form must not become a way around it.
    expect(build(['Read', 'Agent(a, b)'], AT_LIMIT).tools).toEqual(['read'])
  })

  it('drops a parametrized grant on any other tool without granting the bare tool', () => {
    // `Workflow` is in the same first filter ("The first filter removes these
    // tools ... `Workflow`"), and no doc gives `Tool(specifier)` a meaning in a
    // subagent `tools` list outside `Agent`. Resolving `Bash(git diff:*)` to
    // bare `bash` would hand an agent MORE authority than its author wrote, so
    // the specifier form is denied by omission — the posture this builder
    // already takes for a recognized capability with no Pi counterpart.
    expect(() => build(['Read', 'Workflow(x)', 'Bash(git diff:*)'])).not.toThrow()

    const tools = build(['Read', 'Workflow(x)', 'Bash(git diff:*)']).tools
    expect(tools).toContain('read')
    expect(tools).not.toContain('workflow')
    expect(tools).not.toContain('bash')
  })

  it('keeps the toolset full when the dropped grant was a writing one', () => {
    // `toolset` decides `worktreePolicy` (spawner.ts: 'full' => isolated
    // worktree), and P8 reversed this row. Dropping `Bash(git diff:*)` from the
    // GRANT does not make the agent read-only, because the host derives the same
    // policy from the declared list — where the entry is still there — so
    // `read-only` here meant a `runtime-agent-worktree-policy-mismatch` refusal
    // rather than a shared tree. This is the first of the three shapes measured
    // live, and the direction it converges on is the stricter one.
    expect(build(['Read', 'Grep', 'Bash(git diff:*)']).toolset).toBe('full')
  })

  /**
   * The other half of the fix, and the reason the strip rule lives in shared:
   * the HOST re-validates a child's arriving tools against
   * `pinnedDefinition.tools.map(normalizePiRuntimeAgentToolName)` and refuses a
   * tool that is not in it (`SessionManager.ts`,
   * `runtime-agent-tool-unavailable:<tool>`); it derives the expected
   * `worktreePolicy` from that same normalized list. Granting `subagent` here
   * while the host still read `agent(a, b)` as an opaque name would have traded
   * a turn-fatal error for a spawn-fatal one on the very agents this fixes.
   */
  it('agrees with the host normalization of the declared list', () => {
    const declared = ['Read', 'Grep', 'Agent(a, b)', 'Workflow(x)']
    const readOnlyAgentTools = new Set([
      'read', 'grep', 'find', 'ls', 'web_search', 'web_fetch', 'mcp__tool_search', 'get_subagent_result',
    ])
    const definition = build(declared)
    const declaredToolSet = new Set(declared.map(normalizePiRuntimeAgentToolName))

    // The host's admission check, verbatim in shape: every arriving tool must
    // be in the normalized declared set.
    const refused = definition.tools.find(tool => !declaredToolSet.has(normalizePiRuntimeAgentToolName(tool)))
    expect(refused).toBeUndefined()

    // And the host's `expectedWorktreePolicy`, which reads the same set.
    const hostPolicy = [...declaredToolSet].every(tool => readOnlyAgentTools.has(tool))
      ? 'shared'
      : 'isolated-worktree'
    const piPolicy = definition.toolset === 'full' ? 'isolated-worktree' : 'shared'
    expect(piPolicy).toBe(hostPolicy)
  })

  /**
   * P6b — the last link of the `claude-security` chain, with the list intact.
   *
   * `Read, Agent(scan-inventory, scan-researcher), Workflow(scan), TaskOutput`
   * is the shape the plugin's agents declare. The two readers that split that
   * line (`optionalStringList` in the pi-harness descriptor builder, and the
   * Claude adapter's `frontmatter.tools` read) each used to split on a bare
   * comma, so what ARRIVED here was six fragments — `Agent(scan-inventory` and
   * `scan-researcher)` among them — every one of which this builder then denied
   * by omission. The chat stayed usable, and the subagent grant the plugin asked
   * for was silently gone. With both splits paren-aware, the four entries the
   * author wrote arrive whole and this is what the builder must make of them.
   */
  it('grants Read and the subagent tool from an intact claude-security tool list', () => {
    const messages: string[] = []
    const [definition] = buildPiRuntimeAgentDefinitions(
      [{
        ...base,
        key: 'plugin://claude-security#agent.scan-orchestrator',
        tools: ['Read', 'Agent(scan-inventory, scan-researcher)', 'Workflow(scan)', 'TaskOutput'],
      }],
      available,
      undefined,
      BELOW_LIMIT,
      { debugLog: message => messages.push(message) },
    ) as unknown as Array<{ tools: string[] }>

    expect(definition!.tools).toEqual(['read', 'subagent'])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('Workflow(scan)')
    expect(messages[0]).toContain('TaskOutput')
    expect(messages[0]).not.toContain('Agent(')
  })

  /**
   * P6b-A — deny-by-omission is not the same as deny-in-silence.
   *
   * The drop above is the right posture (an unresolved name grants nothing, and
   * never costs the turn), but a grant that vanishes with no trace is the class
   * this wave exists to kill: the plugin author, and whoever debugs the agent
   * that "just does not call its tool", get nothing to look at. errors.md
   * § *Agent would be spawned with zero tools* names the failing entries in its
   * own refusal for exactly this reason; we drop instead of refusing, so the
   * naming has to happen here.
   */
  it('names the agent and every dropped entry on the debug channel', () => {
    const messages: string[] = []
    buildPiRuntimeAgentDefinitions(
      [{ ...base, key: 'plugin://claude-security#agent.scanner', tools: ['Read', 'Workflow(scan)', 'TaskOutput'] }],
      available,
      undefined,
      BELOW_LIMIT,
      { debugLog: message => messages.push(message) },
    )

    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('plugin://claude-security#agent.scanner')
    expect(messages[0]).toContain('Workflow(scan)')
    expect(messages[0]).toContain('TaskOutput')
    // The entries that DID resolve are not news.
    expect(messages[0]).not.toContain('Read')
  })

  it('says nothing for an agent whose every entry resolved, and nothing for a tool-less one', () => {
    // The builder runs per session init and per working-directory switch, so a
    // per-agent line is affordable only while a healthy session stays silent.
    const messages: string[] = []
    buildPiRuntimeAgentDefinitions(
      [
        { ...base, key: 'plugin://honey#agent.hive-scout', tools: ['Read', 'Grep'] },
        { ...base, key: 'plugin://honey#agent.inheritor' },
      ],
      available,
      undefined,
      BELOW_LIMIT,
      { debugLog: message => messages.push(message) },
    )

    expect(messages).toEqual([])
  })

  it('builds every other definition in the batch when one is entirely unresolvable', () => {
    // The regression's blast radius: the builder maps ALL of a session's
    // imported agents, so a throw on one plugin's agent took the session's
    // whole definition set — and the turn — with it.
    const definitions = buildPiRuntimeAgentDefinitions(
      [
        { ...base, key: 'plugin://claude-security#agent.scanner', tools: ['Workflow(x)', 'Grpe'] },
        { ...base, key: 'plugin://honey#agent.hive-scout', tools: ['Read', 'Grep'] },
      ],
      [...available, 'mcp__session__TaskList'],
      undefined,
      BELOW_LIMIT,
    ) as unknown as Array<{ tools: string[]; definitionKey: string }>

    expect(definitions).toHaveLength(2)
    expect(definitions[1]!.tools).toEqual(['read', 'grep', 'mcp__session__TaskList'])
    // Nothing was granted to the unresolvable one beyond the tools every
    // subagent always keeps; an all-dropped list is not a broad grant.
    expect(definitions[0]!.tools).toEqual(['mcp__session__TaskList'])
  })
})

/**
 * P7 — a SERVER-LEVEL MCP grant expands to that server's tools.
 *
 * sub-agents.md § *Available tools*: "Both fields accept MCP server-level
 * patterns in addition to exact tool names: `mcp__<server>` or
 * `mcp__<server>__*` grants or removes every tool from the named server. In
 * `disallowedTools`, `mcp__*` also removes every MCP tool from any server."
 *
 * Before this, neither form resolved: the entry matched no manifest name, so it
 * was denied by omission and an agent written around a whole MCP server's
 * toolset got none of it.
 */
describe('P7 — a server-level MCP grant expands to that server, and only that server', () => {
  /**
   * Two servers whose wire names PREFIX one another — the boundary case. Pi
   * advertises an external MCP tool as `mcp__<wireName>__<toolName>`
   * (`tryParsePiDynamicMcpBindingName`), and wire names never contain `__`
   * (`mcp-wire-name.ts` collapses `_` runs), so `mcp__git__` is an exact,
   * unambiguous boundary that `mcp__github__…` cannot cross.
   */
  const available = [
    'read', 'grep', 'bash', 'write', 'subagent',
    'mcp__git__status', 'mcp__git__log',
    'mcp__github__create_issue', 'mcp__github__list_prs',
    // A session tool in the production `binding.piName` spelling, so the
    // `mcp__session__*` exclusion below is measured against a name a real pool
    // carries. `plugin_install` deliberately, NOT one of the five
    // always-available tools: those are unioned into every child by design
    // (Q10-2), and one of them here would put a tool in every expectation on
    // this block for a reason that has nothing to do with server-level grants.
    'mcp__session__plugin_install',
  ]

  const build = (tools: string[]) => buildPiRuntimeAgentDefinitions(
    [{ ...base, tools }],
    available,
    undefined,
    BELOW_LIMIT,
  )[0] as unknown as { tools: string[]; toolset: string }

  it.each(['mcp__git__*', 'mcp__git', 'MCP__GIT__*'])(
    '%s grants exactly the git server tools',
    (grant) => {
      expect(build(['Read', grant]).tools)
        .toEqual(['read', 'mcp__git__status', 'mcp__git__log'])
    },
  )

  it('never admits a tool from a different server whose name it prefixes', () => {
    const tools = build(['mcp__git__*']).tools
    expect(tools).toContain('mcp__git__status')
    expect(tools).not.toContain('mcp__github__create_issue')
    expect(tools).not.toContain('mcp__github__list_prs')
  })

  it('an unknown server expands to nothing, denied by omission and never thrown on', () => {
    const messages: string[] = []
    expect(() => buildPiRuntimeAgentDefinitions(
      [{ ...base, tools: ['Read', 'mcp__absent__*'] }],
      available,
      undefined,
      BELOW_LIMIT,
      { debugLog: message => messages.push(message) },
    )).not.toThrow()

    expect(build(['Read', 'mcp__absent__*']).tools).toEqual(['read'])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('mcp__absent__*')
  })

  it.each(['mcp__*', 'mcp__*__*', '*', 'mcp__', 'mcp'])(
    '%s is not this feature and grants nothing',
    (grant) => {
      // The doc scopes `mcp__*` to `disallowedTools` ("In `disallowedTools`,
      // `mcp__*` also removes every MCP tool from any server") and gives no
      // whole-pool wildcard for a `tools` allowlist at all. Reading one here
      // would hand an agent every MCP tool in the session from one entry its
      // author never wrote that way, so every shape below stays denied.
      expect(build([grant]).tools).toEqual([])
    },
  )

  it('does not expand mcp__session__*, which is not a connected MCP server', () => {
    // Nessy advertises its own 54 built-in session tools in MCP spelling for the
    // Pi SDK's benefit (`context-categories.ts`, `harness-tool-descriptor.ts`
    // `sessionBinding`). In Claude those are BUILT-IN tools, not MCP tools, so
    // no `mcp__<server>__*` pattern can reach them there. Honouring the spelling
    // here would turn one entry into `plugin_install`, `script_sandbox`,
    // `spawn_session` and 51 more — authority the author never wrote. Same
    // exclusion `lifecycle-bridge.ts` (`mcpServerFromToolName`) already makes.
    const tools = build(['Read', 'mcp__session__*']).tools
    expect(tools).not.toContain('mcp__session__plugin_install')
    expect(tools).toEqual(['read'])
  })

  it('positive control — a concrete grant still resolves exactly as before', () => {
    expect(build(['Read', 'mcp__github__create_issue']).tools)
      .toEqual(['read', 'mcp__github__create_issue'])
  })

  it('an exact manifest name is never re-read as a server-level pattern', () => {
    // `mcp__tool_search` is a real one-separator pool name that also matches the
    // bare `mcp__<server>` shape. Exact match wins, as it already does for the
    // parametrized form.
    const [definition] = buildPiRuntimeAgentDefinitions(
      [{ ...base, tools: ['ToolSearch'] }],
      ['read', 'mcp__tool_search'],
      undefined,
      BELOW_LIMIT,
    ) as unknown as Array<{ tools: string[] }>
    expect(definition!.tools).toEqual(['mcp__tool_search'])
  })

  /**
   * The other half, and the reason the rule lives in shared: the HOST
   * re-validates a child's ARRIVING tools against the pinned definition's
   * declared list (`SessionManager.ts`, `runtime-agent-tool-unavailable:<tool>`)
   * and derives `expectedWorktreePolicy` from that same list. Pi now sends N
   * concrete tools where the host still reads one pattern, so without
   * `mcpServerLevelGrantCovers` on the host side this fix would have traded
   * "silently empty" for a spawn-time refusal.
   */
  it('agrees with the host admission check and worktree policy', () => {
    const declared = ['Read', 'mcp__git__*']
    const readOnlyAgentTools = new Set([
      'read', 'grep', 'find', 'ls', 'web_search', 'web_fetch', 'mcp__tool_search', 'get_subagent_result',
    ])
    const definition = build(declared)
    const declaredTools = declared.map(normalizePiRuntimeAgentToolName)
    const declaredToolSet = new Set(declaredTools)

    // The host's admission check, verbatim in shape.
    const refused = definition.tools.find(tool => (
      !declaredToolSet.has(normalizePiRuntimeAgentToolName(tool))
      && !declaredTools.some(entry => mcpServerLevelGrantCovers(entry, tool))
    ))
    expect(refused).toBeUndefined()

    // And the host's `expectedWorktreePolicy`, which reads the same list.
    const hostPolicy = declaredTools.every(tool => readOnlyAgentTools.has(tool))
      ? 'shared'
      : 'isolated-worktree'
    const piPolicy = definition.toolset === 'full' ? 'isolated-worktree' : 'shared'
    expect(piPolicy).toBe(hostPolicy)
    // An MCP server's tools are not known-read-only on either side, so the
    // expanded grant lands the agent in an isolated worktree.
    expect(piPolicy).toBe('isolated-worktree')
  })
})

/**
 * P8 — the host and the runtime read ONE worktree-policy rule.
 *
 * The two sides used to derive the policy from DIFFERENT lists: the host from
 * the author-DECLARED `tools` (`SessionManager.ts`'s `expectedWorktreePolicy`),
 * this builder from the RESOLVED remainder. Every entry that is declared but
 * does not resolve therefore split them — Pi computed `read-only` from what
 * survived and sent `shared`, the host computed `isolated-worktree` from the
 * raw entry, and the spawn died on `runtime-agent-worktree-policy-mismatch`.
 *
 * Four classes reach it, and they are NOT all the "unresolvable" class the
 * defect was filed as — two are documented WITHHOLDS applied to an entry that
 * resolved perfectly well:
 *
 *  1. a parametrized non-`Agent` grant, denied by omission (`1ff71c5a4`);
 *  2. a recognized external capability with no counterpart in this manifest;
 *  3. a server-level MCP pattern naming a server this session does not carry
 *     (P7's own fixture, and the residue P7's expansion left behind);
 *  4. `ask_user`, and `subagent` at the depth limit — resolved, then withheld.
 *
 * The rule now lives once, in the shared module both sides already read, and it
 * is fed the DECLARED list on both. Direction matters and is asserted below:
 * `isolated-worktree` is the stricter posture, so converging on the host's
 * reading only ever moves an agent INTO isolation, never out of it.
 */
describe('P8 — the host and the runtime read one worktree-policy rule', () => {
  const POOL = [
    'read', 'grep', 'find', 'ls', 'bash', 'write', 'edit', 'ask_user',
    'web_search', 'web_fetch', 'mcp__tool_search', 'subagent',
    'mcp__gitlab__repos',
  ]

  /**
   * The Pi side, end to end: the builder's `toolset` through the spawner's own
   * expression (`spawner.ts:709`) — which is the value that travels to the host.
   */
  const piPolicy = (
    tools: string[] | undefined,
    options: { pool?: string[]; budget?: typeof BELOW_LIMIT; isolation?: 'worktree' } = {},
  ) => {
    const [definition] = buildPiRuntimeAgentDefinitions(
      [{ ...base, ...(tools ? { tools } : {}), ...(options.isolation ? { isolation: options.isolation } : {}) }],
      options.pool ?? POOL,
      undefined,
      options.budget ?? BELOW_LIMIT,
    ) as unknown as Array<{ toolset: string; isolation?: string }>
    return definition!.isolation === 'worktree' || definition!.toolset === 'full'
      ? 'isolated-worktree'
      : 'shared'
  }

  /** The host side: the shared rule `SessionManager.ts` now calls, verbatim. */
  const hostPolicy = (tools: string[] | undefined, isolation?: 'worktree') =>
    piRuntimeAgentWorktreePolicy({
      ...(tools ? { tools } : {}),
      ...(isolation ? { isolation } : {}),
    })

  const cases: Array<[string, string[] | undefined, 'shared' | 'isolated-worktree', { pool?: string[]; budget?: typeof BELOW_LIMIT }]> = [
    // The three shapes measured live, plus P7's `mcp__<absent>__*`.
    ['a parametrized non-Agent grant', ['Read', 'Bash(git diff:*)'], 'isolated-worktree', {}],
    ['a capability this manifest lacks', ['Read', 'CronList'], 'isolated-worktree', {}],
    ['a server-level grant for an absent server', ['Read', 'mcp__github__*'], 'isolated-worktree', {}],
    ['P7 fixture: mcp__<absent>__*', ['Read', 'mcp__absent__*'], 'isolated-worktree', {}],
    // The withholds — resolved, then removed by policy.
    ['ask_user, never available to a subagent', ['Read', 'AskUserQuestion'], 'isolated-worktree', {}],
    ['subagent at the depth limit', ['Read', 'Agent'], 'isolated-worktree', { budget: AT_LIMIT }],
    // POSITIVE CONTROL — the pair already agreed here, and must still.
    ['control: a grant that resolves', ['Read', 'Grep', 'Agent(a, b)'], 'isolated-worktree', {}],
    // NEGATIVE CONTROL — a fix that isolates everything fails this row.
    ['control: a genuinely read-only list', ['Read', 'Grep'], 'shared', {}],
    ['control: a tool-less definition inherits', undefined, 'isolated-worktree', {}],
  ]

  it.each(cases)('%s — both sides say %s', (_label, tools, expected, options) => {
    expect(piPolicy(tools, options)).toBe(hostPolicy(tools))
    expect(piPolicy(tools, options)).toBe(expected)
  })

  it('a declared write grant that does not resolve stays isolated on both sides', () => {
    // The teeth of the no-widening direction. `write` is declared and absent
    // from this session's pool, so the resolved remainder is read-only — the
    // reading that used to send `shared` and put an agent whose AUTHOR asked for
    // `write` into the user's live tree. Converging on the declared list keeps
    // it isolated; converging on the resolved one would not.
    const declared = ['Read', 'Write']
    const pool = ['read', 'grep']
    expect(piPolicy(declared, { pool })).toBe('isolated-worktree')
    expect(hostPolicy(declared)).toBe('isolated-worktree')
  })

  it('an explicit isolation: worktree outranks a read-only list on both sides', () => {
    // `SessionManager.ts:5449` — the plugin-hook route's own producer — read the
    // tool list and NOT `isolation`, so a read-only agent declaring the field
    // was handed `shared` and then refused by the admission check that does read
    // it. Both now go through this one rule.
    expect(piPolicy(['Read', 'Grep'], { isolation: 'worktree' })).toBe('isolated-worktree')
    expect(hostPolicy(['Read', 'Grep'], 'worktree')).toBe('isolated-worktree')
  })
})
