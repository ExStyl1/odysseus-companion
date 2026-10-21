import { describe, expect, it } from 'bun:test'

import type { CapabilitySnapshotMaterializer } from '../../capabilities/materializer.ts'
import type { AgentRuntimeView } from '../../capabilities/views.ts'
import { PI_TOOL_BINDINGS } from './harness-tool-descriptor.ts'
import {
  PI_RUNTIME_AGENT_TOOL_ALIASES,
  SESSION_AGENT_KEY_PREFIX,
  isReadOnlySubagentToolGrant,
  matchesSubagentToolDenial,
  materializePiRuntimeAgentDefinitions,
  mcpServerLevelGrantCovers,
  normalizePiRuntimeAgentToolName,
  parseMcpServerLevelGrant,
  piRuntimeAgentWorktreePolicy,
  resolvePiSessionAgentPin,
} from './runtime-agent-definition.ts'

const DIARY_FRONTMATTER = `---
name: diary-writer
description: generate a diary for user
color: yellow
tools:
  - Glob
  - Grep
  - ListFiles
  - ReadFile
  - ReadManyFiles
  - NotebookRead
  - WebFetch
  - TodoList
modelConfig:
  model: qwen3-coder-plus
---

You are a personal diary writing assistant.`

function viewWithAgent(): AgentRuntimeView {
  return {
    generation: 'generation-1',
    sources: [],
    skills: [],
    mcpServers: [],
    hooks: [],
    automations: [],
    agents: [{
      key: 'plugin://skills-market/agent-example#agent.diary-writer@workspace',
      name: 'diary-writer',
      description: 'generate a diary for user',
      selectedAsUnqualifiedAlias: true,
      instructionsResource: {
        pluginInstanceId: 'plugin://skills-market/agent-example@1.0.0#fixture',
        relativePath: 'agents/diary.md',
        contentHash: 'fixture',
      },
    }],
    promptLayers: [],
    memory: [],
    permissionLayers: [],
    commands: [],
    promptCommands: [],
    apps: [],
  }
}

function materializer(content: string): CapabilitySnapshotMaterializer {
  return {
    assertActive() {},
    async verifyPlugin() {},
    async resolvePath() {
      throw new Error('not used')
    },
    async readText() {
      return content
    },
    resolveCredential() {
      throw new Error('not used')
    },
  }
}

describe('Pi runtime agent definition materialization', () => {
  it('materializes the live agent-example diary YAML block-list without promoting nested model fields', async () => {
    const [definition] = await materializePiRuntimeAgentDefinitions({
      view: viewWithAgent(),
      materializer: materializer(DIARY_FRONTMATTER),
    })

    expect(definition).toMatchObject({
      name: 'diary-writer',
      systemPrompt: 'You are a personal diary writing assistant.',
      tools: [
        'Glob',
        'Grep',
        'ListFiles',
        'ReadFile',
        'ReadManyFiles',
        'NotebookRead',
        'WebFetch',
        'TodoList',
      ],
    })
    expect(definition?.model).toBeUndefined()
  })

  it('parses an explicitly empty tools list as the empty SET — never refuse (A1), never inherit (P2.202)', async () => {
    // TWO properties, from two rows, and they are independent — which is why
    // this test kept its name's first half when P2.202 flipped its second.
    //
    // A1, unchanged: the definition still LOADS. This exact shape (`tools: []`
    // in ~/.nessy-agent/agents/cdp-high-effort.md) killed every send in every
    // session before A1, because the parse threw and took the whole snapshot
    // with it. An empty grant is not a refusal, here or at admission.
    //
    // P2.202, flipped: it loads as the EMPTY SET, not as an omitted key. This
    // asserted `toBeUndefined()` — inherit every tool available to subagents —
    // reading `sub-agents.md`'s omitted-field default onto a list the author
    // wrote. `errors.md#agent-would-be-spawned-with-zero-tools` separates them
    // in one sentence (re-fetched 2026-08-27): "If you leave the `tools` list
    // empty, or `disallowedTools` removes every entry in it, Claude Code also
    // skips the refusal and launches the subagent without tools", against its
    // fix list's "Delete the `tools` field instead of listing tools to give the
    // subagent every tool available to subagents." An author who named no tools
    // was being handed the whole session pool — truncation that widened.
    const [definition] = await materializePiRuntimeAgentDefinitions({
      view: viewWithAgent(),
      materializer: materializer(`---\nname: diary-writer\ntools: []\n---\n\nInstructions.`),
    })
    expect(definition).toBeDefined()
    expect(definition!.tools).toEqual([])
    expect(definition!.systemPrompt).toBe('Instructions.')
  })

  /**
   * P6b-B — the descriptor's own `tools` read must be paren-aware.
   *
   * The Pi side already treats `Agent(a, b)` as the bare subagent tool and
   * denies every other `Tool(specifier)` by omission (`SUBAGENT_TOOL_SPELLINGS`,
   * `resolveExplicitTools`). That is only reachable if the ENTRY survives the
   * split: a bare `.split(',')` here handed the Pi side `Agent(scan-inventory`
   * and `scan-researcher)`, two names nothing can resolve, so the documented
   * grant was silently lost on the way in. `splitMarkdownFrontmatter` joins a
   * YAML sequence on `', '`, so the single-line and block forms are one case.
   */
  it('keeps a parametrized tool grant whole, and denies nothing on the way in', async () => {
    const [single] = await materializePiRuntimeAgentDefinitions({
      view: viewWithAgent(),
      materializer: materializer(
        '---\nname: diary-writer\ntools: Read, Agent(scan-inventory, scan-researcher), Workflow(scan), TaskOutput\n---\n\nInstructions.',
      ),
    })
    expect(single!.tools).toEqual([
      'Read',
      'Agent(scan-inventory, scan-researcher)',
      'Workflow(scan)',
      'TaskOutput',
    ])

    // A `disallowed-tools` entry shredded the same way loses a DENIAL, which is
    // the worse direction: `Bash(rm:*)` became `Bash(rm:*` plus nothing.
    const [denied] = await materializePiRuntimeAgentDefinitions({
      view: viewWithAgent(),
      materializer: materializer(
        '---\nname: diary-writer\ndisallowed-tools:\n  - Bash(rm -rf:*, sudo:*)\n  - Write\n---\n\nInstructions.',
      ),
    })
    expect(denied!.disallowedTools).toEqual(['Bash(rm -rf:*, sudo:*)', 'Write'])
  })

  it('keeps refusing a JSON tools array with a non-string entry', async () => {
    // A1 kept every per-field refusal and only narrowed its cost to the one
    // definition, so making the split paren-aware must not quietly coerce
    // `["Read", 1]` into `Read` + `1`. That literal only reaches the reader
    // through `splitMarkdownFrontmatter`'s fallback scanner — hence the
    // `description` line below, a real shape js-yaml refuses outright, which
    // sends the whole block down the scanner and keeps the value verbatim.
    const diagnostics: string[] = []
    const definitions = await materializePiRuntimeAgentDefinitions({
      view: viewWithAgent(),
      materializer: materializer([
        '---',
        'description: Use when the user says "deploy": ship it',
        'tools: ["Read", 1]',
        '---',
        '',
        'Instructions.',
      ].join('\n')),
      onInvalidDefinition: diagnostic => { diagnostics.push(diagnostic.reason) },
    })

    expect(definitions).toEqual([])
    expect(diagnostics[0]).toContain('.tools[1]')
  })

  /**
   * sub-agents.md:297 — "Auto-submitted as the first user turn when this agent
   * runs as the main session agent (via `--agent` or the `agent` setting).
   * Commands and skills are processed. Prepended to any user-provided prompt".
   *
   * `materializePiRuntimeAgentDefinitions` builds the descriptor AND re-parses
   * it through `parsePiRuntimeAgentDefinitions`, so a value that survives here
   * survived the content-addressed digest too — the field has to sit inside the
   * hashed object on both sides or every definition carrying it is dropped.
   */
  describe('initialPrompt', () => {
    it('carries the value, in both spellings, through the digest round trip', async () => {
      for (const key of ['initialPrompt', 'initial-prompt']) {
        const [definition] = await materializePiRuntimeAgentDefinitions({
          view: viewWithAgent(),
          materializer: materializer(`---\nname: diary-writer\n${key}: Read AGENTS.md, then wait.\n---\n\nInstructions.`),
        })
        // Asserted separately: a field hashed on one side only makes the WHOLE
        // definition fail the digest check and vanish, which reads identically
        // to "the field was dropped" through an optional chain.
        expect(definition).toBeDefined()
        // Not split on the comma: the key is a scalar and must stay out of the
        // array-frontmatter set.
        expect(definition!.initialPrompt).toBe('Read AGENTS.md, then wait.')
      }
    })

    it('omits an unrepresentable block scalar and refuses an over-length value', async () => {
      // `initialPrompt: |` matches the ordinary scalar regex and would arrive as
      // the literal "|". Omitted, and the agent still loads — a parser limit
      // must not delete an imported agent over a field nothing consumes yet.
      const [blockScalar] = await materializePiRuntimeAgentDefinitions({
        view: viewWithAgent(),
        materializer: materializer(`---\nname: diary-writer\ninitialPrompt: |\n---\n\nInstructions.`),
      })
      expect(blockScalar).toBeDefined()
      expect(blockScalar?.initialPrompt).toBeUndefined()

      const diagnostics: string[] = []
      const excluded = await materializePiRuntimeAgentDefinitions({
        view: viewWithAgent(),
        materializer: materializer(`---\nname: diary-writer\ninitialPrompt: ${'x'.repeat(16 * 1024 + 1)}\n---\n\nInstructions.`),
        onInvalidDefinition: diagnostic => { diagnostics.push(diagnostic.reason) },
      })
      expect(excluded).toHaveLength(0)
      expect(diagnostics[0]).toContain('initialPrompt: exceeds 16384 characters')
    })
  })

  /**
   * F1.1203 — a trusted project's `.claude/agents` copy carries the name Claude
   * Code loads it under: the frontmatter `name` (`sub-agents.md`: "The filename
   * doesn't have to match"), and none when Claude skips the file.
   */
  describe('claudeAgentName', () => {
    const claudeCopy = (content: string, key = 'agent::project::ws-1::p_1::claude::reviewer') => materializePiRuntimeAgentDefinitions({
      view: { ...viewWithAgent(), agents: [{ ...viewWithAgent().agents[0]!, key, name: 'reviewer' }] },
      materializer: materializer(content),
    })

    it('carries the frontmatter name of a .claude/agents copy through the digest round trip', async () => {
      const [definition] = await claudeCopy(`---\nname: code-reviewer\ndescription: Reviews code.\n---\n\nReview.`)
      expect(definition).toBeDefined()
      expect(definition!.claudeAgentName).toBe('code-reviewer')
    })

    it('carries none for a file Claude skips, or for an agent that is not a .claude/agents copy', async () => {
      const [noDescription] = await claudeCopy(`---\nname: reviewer\n---\n\nReview.`)
      expect(noDescription).toBeDefined()
      expect(noDescription!.claudeAgentName).toBeUndefined()
      const [ours] = await claudeCopy(
        `---\nname: reviewer\ndescription: Reviews code.\n---\n\nReview.`,
        'agent::project::ws-1::p_1::::reviewer',
      )
      expect(ours).toBeDefined()
      expect(ours!.claudeAgentName).toBeUndefined()
    })

    // F1.1211 — Claude Code parses the frontmatter as YAML, retries once with
    // special-character values quoted, and loads NO agent from a block that
    // still fails (measured on the vendored 2.1.274 binary). Our lenient scanner
    // still reads a name there, so the stamp dropped the bundled agent of that
    // name while Claude loaded nothing under it.
    it('carries none for frontmatter Claude cannot parse, and the name when its quoting retry parses it', async () => {
      const [unparseable] = await claudeCopy(`---\nname: reviewer\ndescription: Reviews code.\n tools: Read\n---\n\nReview.`)
      expect(unparseable).toBeDefined()
      expect(unparseable!.claudeAgentName).toBeUndefined()
      // CONTROL — the shape the retry repairs: a plain value holding `": "`.
      const [repaired] = await claudeCopy(`---\nname: reviewer\ndescription: Use when the user says "review": check it\n---\n\nReview.`)
      expect(repaired).toBeDefined()
      expect(repaired!.claudeAgentName).toBe('reviewer')
    })
  })

  describe('mcpServers bare-name plugin alias (T3)', () => {
    // A NATIVE agent, not a plugin one: `sub-agents.md`'s "plugin subagents
    // don't support the ... mcpServers ... frontmatter field" already excludes
    // a plugin's OWN agent from this table entirely (see
    // `pi-runtime-agent-definition.test.ts`), so the only live case for the
    // bare-name alias is a NATIVE agent definition (e.g. a user's own
    // `.agents/agents/*.md` file) naming a plugin's bundled server by the
    // short name it was known by before T2 gave plugin servers a stable
    // `plugin_<id>_<server>` wire name.
    function nativeAgentView(): AgentRuntimeView {
      const view = viewWithAgent()
      view.agents[0] = {
        ...view.agents[0]!,
        instructionsResource: {
          source: 'shared-personal',
          scope: { kind: 'global' },
          resourceId: 'agents/native.md',
          absolutePath: '/agents/native.md',
          revision: '1',
          contentHash: 'b'.repeat(64),
        } as any,
      }
      return view
    }

    it("resolves a native agent's bare-name reference to a plugin MCP server's wire-qualified key", async () => {
      const view = nativeAgentView()
      view.mcpServers = [{
        key: 'plug:mcp:t-tracker',
        wireName: 'plugin_figma_t-tracker',
        logicalName: 't-tracker',
        pluginInstanceId: 'plugin://internal/figma@1.0.0#hash',
      } as any]

      const [definition] = await materializePiRuntimeAgentDefinitions({
        view,
        materializer: materializer(`---\nname: diary-writer\nmcpServers:\n  - t-tracker\n---\n\nInstructions.`),
      })

      expect(definition).toBeDefined()
      expect(definition!.mcpServerKeys).toEqual(['plug:mcp:t-tracker'])
    })

    it('does not alias a bare name shared by two plugin instances — only an unambiguous bare name resolves', async () => {
      const view = nativeAgentView()
      view.mcpServers = [
        {
          key: 'plug:mcp:a-docs',
          wireName: 'plugin_a_docs',
          logicalName: 'docs',
          pluginInstanceId: 'plugin://internal/a@1.0.0#hash',
        } as any,
        {
          key: 'plug:mcp:b-docs',
          wireName: 'plugin_b_docs',
          logicalName: 'docs',
          pluginInstanceId: 'plugin://internal/b@1.0.0#hash',
        } as any,
      ]
      const diagnostics: string[] = []

      const excluded = await materializePiRuntimeAgentDefinitions({
        view,
        materializer: materializer(`---\nname: diary-writer\nmcpServers:\n  - docs\n---\n\nInstructions.`),
        onInvalidDefinition: diagnostic => { diagnostics.push(diagnostic.reason) },
      })

      expect(excluded).toHaveLength(0)
      expect(diagnostics[0]).toContain('Unavailable MCP server reference: docs')
    })

    // Review finding 1 (2026-08-10 final-branch review): the contenders count
    // above only scanned `view.mcpServers`, so a user-created MCP SOURCE
    // carrying the same bare name (`view.sources`, not `view.mcpServers`) was
    // invisible to it — a plugin server could still add an (ambiguous, but
    // uncounted) bare-name alias row that `resolveReferences` matched FIRST,
    // ahead of the source's own row, handing a native agent's `mcpServers:
    // [notes]` reference to the plugin instead of the user's source. This is
    // the exact regression the branch's own headline promise ("a plugin can
    // never take over ... the wire name of a ... user-configured server")
    // was supposed to rule out.
    it("a same-named MCP source keeps the bare-name reference — a plugin server never claims it", async () => {
      const view = nativeAgentView()
      view.mcpServers = [{
        key: 'plug:mcp:notes',
        wireName: 'plugin_evil_notes',
        logicalName: 'notes',
        pluginInstanceId: 'plugin://internal/evil@1.0.0#hash',
      } as any]
      view.sources = [{
        key: 'source:mcp:notes',
        logicalName: 'notes',
        mcpWireName: 'notes',
      } as any]

      const [definition] = await materializePiRuntimeAgentDefinitions({
        view,
        materializer: materializer(`---\nname: diary-writer\nmcpServers:\n  - notes\n---\n\nInstructions.`),
      })

      expect(definition).toBeDefined()
      expect(definition!.mcpServerKeys).toEqual(['source:mcp:notes'])
    })
  })
})

/**
 * P7 — the shared server-level MCP grant rule, which BOTH sides of the Pi
 * boundary read: `resolveExplicitTools` expands a pattern into the concrete
 * tools a child arrives holding, and `SessionManager` admits that arrival
 * against a declared list that still holds only the pattern.
 *
 * sub-agents.md § *Available tools*: "Both fields accept MCP server-level
 * patterns in addition to exact tool names: `mcp__<server>` or
 * `mcp__<server>__*` grants or removes every tool from the named server. In
 * `disallowedTools`, `mcp__*` also removes every MCP tool from any server."
 *
 * mcp.md fixes the concrete name it is measured against: "The full form is
 * `mcp__plugin_<plugin-name>_<server-name>__<tool-name>` ... Use this full name
 * when referencing the tool in permission rules, a skill's `allowed-tools`
 * list, a subagent's `tools` field, or a hook matcher."
 */
describe('P7 — server-level MCP grant parsing', () => {
  it.each([
    ['mcp__git__*', 'git'],
    ['mcp__git', 'git'],
    ['  MCP__Git__*  ', 'git'],
    // A plugin-bundled server's wire name is one segment, underscores included
    // (mcp.md: `mcp__plugin_<plugin-name>_<server-name>__<tool-name>`).
    ['mcp__plugin_my-plugin_database-tools__*', 'plugin_my-plugin_database-tools'],
  ])('%s names server %s', (entry, server) => {
    expect(parseMcpServerLevelGrant(entry)).toBe(server)
  })

  it.each([
    // The doc scopes `mcp__*` to `disallowedTools`, and gives a `tools`
    // allowlist no whole-pool wildcard at all. None of these parse, so none can
    // become a grant on every MCP server in the session.
    'mcp__*', 'mcp__*__*', '*', 'mcp__', 'mcp', '',
    // A CONCRETE tool name is not a bare server grant: the server segment may
    // not contain `__`, because Pi advertises `mcp__<wireName>__<toolName>` and
    // wire names never carry `__` (`mcp-wire-name.ts` collapses `_` runs).
    'mcp__git__status', 'mcp__git__status__*',
    // Reserved: Nessy's own built-in tools wear MCP spelling, and `session` is
    // not a connected server any pattern may reach.
    'mcp__session', 'mcp__session__*',
    // Not an MCP name at all.
    'read', 'Agent(a, b)', 'x__mcp__git__*',
  ])('%s is not a server-level grant', (entry) => {
    expect(parseMcpServerLevelGrant(entry)).toBeUndefined()
  })

  it('covers only the named server, never one whose name it prefixes', () => {
    expect(mcpServerLevelGrantCovers('mcp__git__*', 'mcp__git__status')).toBe(true)
    expect(mcpServerLevelGrantCovers('mcp__git', 'mcp__git__status')).toBe(true)
    // The trailing `__` is the boundary and the whole point.
    expect(mcpServerLevelGrantCovers('mcp__git__*', 'mcp__github__create_issue')).toBe(false)
    expect(mcpServerLevelGrantCovers('mcp__git__*', 'mcp__gitlab__repos')).toBe(false)
    // A server with no tool segment is not one of its own tools.
    expect(mcpServerLevelGrantCovers('mcp__git__*', 'mcp__git')).toBe(false)
    // And nothing a non-grant entry could ever cover.
    expect(mcpServerLevelGrantCovers('mcp__*', 'mcp__git__status')).toBe(false)
    expect(mcpServerLevelGrantCovers('read', 'read')).toBe(false)
  })
})

/**
 * P12 — the DENY half of that same sentence, which only the ALLOW half read.
 *
 * Raw page (`curl -sL https://code.claude.com/docs/en/sub-agents.md`),
 * § *Available tools*: "Both fields accept MCP server-level patterns in
 * addition to exact tool names: `mcp__<server>` or `mcp__<server>__*` grants or
 * removes every tool from the named server. In `disallowedTools`, `mcp__*` also
 * removes every MCP tool from any server."
 *
 * **Both fields.** `disallowedTools` went through `matchesToolPattern`'s glob
 * alone, where a bare `mcp__<server>` compiles to `^mcp__<server>$` and matches
 * no concrete `mcp__<server>__<tool>` name at all — the author wrote a denial
 * and every tool of that server stayed callable.
 */
describe('P12 — server-level MCP denial', () => {
  it('a BARE mcp__<server> entry removes that server every tool', () => {
    // The defect, stated as the doc states it. `^mcp__deploy$` matched nothing.
    expect(matchesSubagentToolDenial('mcp__deploy__release', ['mcp__deploy'], 'test'))
      .toBe('mcp__deploy')
    expect(matchesSubagentToolDenial('mcp__deploy__rollback', ['read', 'mcp__deploy'], 'test'))
      .toBe('mcp__deploy')
  })

  it('the parametrized spelling keeps denying exactly as before', () => {
    // Control for the fix's own condition: this arm was already green through
    // the glob, and must stay green through the new route.
    expect(matchesSubagentToolDenial('mcp__deploy__release', ['mcp__deploy__*'], 'test'))
      .toBe('mcp__deploy__*')
  })

  it('mcp__* removes every MCP tool from any server', () => {
    // The sentence's second half. Already honoured — `*` compiles to `[^/]*`,
    // which spans the `__` separators a tool name is built from — and
    // `parseMcpServerLevelGrant` deliberately refuses to read `mcp__*` as a
    // named server, so it must keep falling through to the glob.
    expect(matchesSubagentToolDenial('mcp__deploy__release', ['mcp__*'], 'test')).toBe('mcp__*')
    expect(matchesSubagentToolDenial('mcp__git__status', ['mcp__*'], 'test')).toBe('mcp__*')
    expect(matchesSubagentToolDenial('mcp__*__*', ['mcp__*__*'], 'test')).not.toBeNull()
  })

  it('denies only the named server, never one whose name it prefixes', () => {
    // No widening: the trailing `__` boundary is the helper's, and the deny
    // side inherits it unchanged.
    expect(matchesSubagentToolDenial('mcp__github__create_issue', ['mcp__git'], 'test')).toBeNull()
    expect(matchesSubagentToolDenial('mcp__gitlab__repos', ['mcp__git'], 'test')).toBeNull()
    expect(matchesSubagentToolDenial('mcp__git', ['mcp__git__*'], 'test')).toBeNull()
  })

  it('leaves every non-MCP entry to the glob it already used', () => {
    // No widening, the other direction: an entry that is not a server-level
    // pattern never reaches the helper, so its verdict is byte-identical.
    expect(matchesSubagentToolDenial('write', ['write'], 'test')).toBe('write')
    expect(matchesSubagentToolDenial('write', ['mcp__deploy'], 'test')).toBeNull()
    expect(matchesSubagentToolDenial('write', ['mcp__*'], 'test')).toBeNull()
    expect(matchesSubagentToolDenial('read', ['gr*p'], 'test')).toBeNull()
    expect(matchesSubagentToolDenial('grep', ['gr*p'], 'test')).toBe('gr*p')
    expect(matchesSubagentToolDenial('bash', undefined, 'test')).toBeNull()
    expect(matchesSubagentToolDenial('bash', [], 'test')).toBeNull()
  })

  it('reads the ONE rule, reserved segment included', () => {
    // Consequence of reusing `mcpServerLevelGrantCovers` rather than writing a
    // deny-only variant: `mcp__session__` stays Nessy's own prefix on this side
    // too, so a bare `mcp__session` is not a server-level denial. The spelling
    // that exists for those tools still denies them through the glob, and so
    // does the whole-pool `mcp__*`.
    expect(matchesSubagentToolDenial('mcp__session__todowrite', ['mcp__session'], 'test')).toBeNull()
    expect(matchesSubagentToolDenial('mcp__session__todowrite', ['mcp__session__*'], 'test'))
      .toBe('mcp__session__*')
    expect(matchesSubagentToolDenial('mcp__session__todowrite', ['mcp__*'], 'test')).toBe('mcp__*')
  })
})

/**
 * Q10-1 — the denial never case-folded, so an author writing the tool's OWN
 * documented spelling got a denial that silently did nothing.
 *
 * tools-reference.md opens with "The tool names are the exact strings you use in
 * permission rules, subagent tool lists, and hook matchers", and the strings that
 * page names are `Read`, `Write`, `Grep`, `TaskList`, `Agent`. Pi advertises them
 * as `read`, `write`, `grep`, `mcp__session__TaskList`, `subagent`. The ALLOW
 * side has always closed that gap — `resolveExplicitTools` resolves exact, then
 * case-insensitive, then through `PI_RUNTIME_AGENT_TOOL_ALIASES`. The DENY side
 * read `matchesToolPattern` alone, whose `globToRegex` compiles `Read` to
 * `^Read$` and therefore matches no `read`.
 *
 * Same class as `1ff71c5a4` (a shredded entry that stopped denying), `8cd73fa1c`
 * (the grant half of the server-level sentence) and P12 above (its deny half):
 * a deny that silently fails to deny. One cause over — the spelling rather than
 * the pattern.
 *
 * The fix reuses `normalizePiRuntimeAgentToolName`, the SAME normalizer
 * `isReadOnlySubagentToolGrant` and the host's arrival check already read, so
 * there is no second alias table and the two sides of the Pi boundary cannot
 * drift apart on which spellings mean one tool.
 */
describe('Q10-1 — a denial matches the tool an author actually wrote', () => {
  it('denies the pi tool named by its documented spelling', () => {
    // The defect. `disallowedTools: ['Read']` against the pi tool `read`.
    expect(matchesSubagentToolDenial('read', ['Read'], 'test')).toBe('Read')
    expect(matchesSubagentToolDenial('write', ['Write'], 'test')).toBe('Write')
    expect(matchesSubagentToolDenial('bash', ['BASH'], 'test')).toBe('BASH')
  })

  it('resolves the documented spelling through the alias table, as the allow side does', () => {
    // `resolveExplicitTools`'s third step. `TaskList` is the documented name;
    // `mcp__session__TaskList` is what the manifest advertises, and no amount of
    // case-folding alone bridges the two.
    expect(matchesSubagentToolDenial('mcp__session__TaskList', ['TaskList'], 'test')).toBe('TaskList')
    expect(matchesSubagentToolDenial('subagent', ['Agent'], 'test')).toBe('Agent')
    expect(matchesSubagentToolDenial('find', ['Glob'], 'test')).toBe('Glob')
    // `Agent(a, b)` — sub-agents.md § *Restrict which subagents can be spawned*
    // says the type list inside the parentheses is ignored, which is exactly how
    // the allow side reads it. The deny side now reads it the same way.
    expect(matchesSubagentToolDenial('subagent', ['Agent(reviewer)'], 'test')).toBe('Agent(reviewer)')
  })

  it('folds case inside a glob too', () => {
    expect(matchesSubagentToolDenial('grep', ['GR*P'], 'test')).toBe('GR*P')
  })

  it('the server-level arm already folded, and still does', () => {
    // Control for the fix's own condition: `parseMcpServerLevelGrant` lowercases
    // both sides already, so this arm must be byte-identical after the change.
    expect(matchesSubagentToolDenial('mcp__deploy__release', ['MCP__Deploy'], 'test')).toBe('MCP__Deploy')
  })

  it('does NOT widen — a tool the author did not name still runs', () => {
    // The whole no-widening control. Case-folding must not turn one denial into
    // a denial of some OTHER tool.
    expect(matchesSubagentToolDenial('read', ['Write'], 'test')).toBeNull()
    expect(matchesSubagentToolDenial('write', ['Read'], 'test')).toBeNull()
    expect(matchesSubagentToolDenial('read', ['GR*P'], 'test')).toBeNull()
    expect(matchesSubagentToolDenial('mcp__github__create_issue', ['MCP__Git'], 'test')).toBeNull()
    expect(matchesSubagentToolDenial('mcp__session__TaskList', ['TaskCreate'], 'test')).toBeNull()
    expect(matchesSubagentToolDenial('read', undefined, 'test')).toBeNull()
    expect(matchesSubagentToolDenial('read', [], 'test')).toBeNull()
  })
})

/**
 * The session-tool wire-name unification respelled 22 advertised names, and an
 * agent or skill written against the old ones must keep working — on the deny
 * side above all, where a rule that quietly stops matching stops DENYING.
 *
 * Both halves are computed from `PI_TOOL_BINDINGS`, so a tool added or respelled
 * later is covered without editing this test.
 */
describe('legacy and documented spellings still reach the renamed session tools', () => {
  const divergent = PI_TOOL_BINDINGS.filter(binding =>
    binding.bindingName.startsWith('mcp__session__') && binding.descriptorId !== binding.handlerName)

  it('resolves the spelling advertised before the rename, for every respelled tool', () => {
    expect(divergent.length).toBeGreaterThan(20)
    const pool = PI_TOOL_BINDINGS.map(binding => binding.piName)
    for (const binding of divergent) {
      const legacy = `mcp__session__${binding.descriptorId}`
      // The allow side: `resolveExplicitTools`'s ladder, whose alias step is the
      // only one that can bridge an underscore-divergent name.
      expect(normalizePiRuntimeAgentToolName(legacy), legacy)
        .toBe(normalizePiRuntimeAgentToolName(binding.piName))
      // The deny side, on the live pool: the rule the author wrote still bites.
      expect(matchesSubagentToolDenial(binding.piName, [legacy], 'test'), legacy).toBe(legacy)
      expect(pool).toContain(binding.piName)
    }
  })

  it('resolves the documented bare spelling too, except where a Claude name owns it', () => {
    for (const binding of divergent) {
      // `Task` is the exception, and it is not an oversight: Claude's `Task` is
      // the SUBAGENT tool (`task: ['subagent']`), so the bare name is spoken for
      // and the session Task tool is reached by its prefixed name instead.
      const documented = binding.handlerName!
      if (documented === 'Task') continue
      expect(normalizePiRuntimeAgentToolName(documented), documented)
        .toBe(normalizePiRuntimeAgentToolName(binding.piName))
    }
    expect(normalizePiRuntimeAgentToolName('Task')).toBe('subagent')
  })

  /**
   * P6.833 — the DENY direction of the same bridge, written out for the three
   * worktree tools because `WorktreeBatch` is the one that shipped without an
   * alias entry (`1384f0bcc`) and a deny that silently stops denying is the
   * failure this whole describe exists to catch. The loop above is derived and
   * therefore covers the new entry automatically; these three assertions pin
   * the shape a future narrowing of the alias step would break.
   */
  it('resolves the bare documented worktree spelling on the deny side, and widens to no sibling', () => {
    expect(matchesSubagentToolDenial('mcp__session__WorktreeBatch', ['WorktreeBatch'], 'test'))
      .toBe('WorktreeBatch')
    // The negative: the three worktree tools stay apart, so denying the batch
    // tool does not quietly remove the enter/exit pair (or the reverse).
    expect(matchesSubagentToolDenial('mcp__session__EnterWorktree', ['WorktreeBatch'], 'test')).toBeNull()
    expect(matchesSubagentToolDenial('mcp__session__WorktreeBatch', ['EnterWorktree'], 'test')).toBeNull()
  })

  /**
   * P6.838 — the ENTRY-level guard, beside the behaviour-level loop above.
   *
   * The bare documented spellings are now derived from `PI_TOOL_BINDINGS`
   * (`DOCUMENTED_SESSION_TOOL_SPELLINGS`) rather than hand-written, after the
   * hand-writing missed a shipped binding in two consecutive waves. This asserts
   * the derivation's OUTPUT rather than only its effect, so a narrowing of the
   * derivation — a stray `.filter`, a changed key case — names the tool it
   * dropped instead of surfacing as a resolution that happens to still work.
   *
   * MUTATION CONTROL, run 2026-09-08: filtering one binding out of the derived
   * map turned both this case and the behaviour loop above red, each naming
   * `CronControl`; the source was restored byte-for-byte (sha256 back to
   * baseline) and both went green again.
   */
  it('derives an entry for every divergent binding, and yields `task` to Claude', () => {
    for (const binding of divergent) {
      const documented = binding.handlerName!.toLowerCase()
      if (documented === 'task') continue
      expect(PI_RUNTIME_AGENT_TOOL_ALIASES[documented], documented).toEqual([
        `mcp__session__${binding.handlerName}`,
        `mcp__session__${binding.descriptorId}`,
        binding.descriptorId,
      ])
    }
    // The deliberate exception, and the reason the derived map is spread FIRST:
    // a hand-written key always overwrites the derived value.
    expect(PI_RUNTIME_AGENT_TOOL_ALIASES.task).toEqual(['subagent'])
  })

  it('does not widen — a legacy spelling reaches its OWN tool only', () => {
    expect(matchesSubagentToolDenial('mcp__session__CronList', ['mcp__session__cron_create'], 'test')).toBeNull()
    expect(matchesSubagentToolDenial('mcp__session__SubmitPlan', ['mcp__session__slash_command'], 'test')).toBeNull()
    // A session tool that never diverged keeps exactly one spelling.
    expect(normalizePiRuntimeAgentToolName('mcp__session__source_manage')).toBe('mcp__session__source_manage')
  })
})

/**
 * P2.202 — the safety property that makes admitting the empty set cheap.
 *
 * Before this row an empty `tools` list could not reach these functions: both
 * collapse sites folded it onto `undefined`, and `isReadOnlySubagentToolGrant`'s
 * own doc said so ("An empty list cannot occur"). It can now, so the verdict it
 * produces has to be pinned rather than assumed — a wrong answer here does not
 * fail loudly, it silently moves an agent between the user's live checkout and a
 * throwaway worktree, or splits the two sides of the Pi boundary and kills the
 * spawn on `runtime-agent-worktree-policy-mismatch`.
 */
describe('worktree policy on an authored-empty tools list', () => {
  it('reads the empty set as read-only, and an absent list as not', () => {
    // Vacuous, and correct for the reason the field means: an author who
    // declared no tools declared no WRITING tool.
    expect(isReadOnlySubagentToolGrant([])).toBe(true)
    // Unchanged, and the whole reason the two spellings must stay apart: a
    // tool-less definition INHERITS the parent's pool, which is not read-only.
    expect(isReadOnlySubagentToolGrant(undefined)).toBe(false)
  })

  it('keeps an empty-list agent in the shared checkout, and a tool-less one isolated', () => {
    expect(piRuntimeAgentWorktreePolicy({ tools: [] })).toBe('shared')
    expect(piRuntimeAgentWorktreePolicy({ tools: undefined })).toBe('isolated-worktree')
    // `isolation: worktree` is an explicit author request and still outranks the
    // toolset-derived default, empty list included.
    expect(piRuntimeAgentWorktreePolicy({ tools: [], isolation: 'worktree' })).toBe('isolated-worktree')
  })
})

/**
 * P6.47 — a denial written in the documented spelling of the cross-session
 * messaging tools must actually deny.
 *
 * `cross-session-messaging.md` §Turn off cross-session messaging: "**Stop
 * sending and listing**: add permission deny rules naming `SendMessage` and
 * `ListAgents`. Both take the bare tool name with no specifier." Our tools are
 * `send_agent_message` and `list_sessions`, so before the alias entries an
 * author's off-switch resolved to nothing and stopped denying in silence — the
 * class this whole table exists to close.
 */
describe('P6.47 — the SendMessage/ListAgents off-switch', () => {
  it('denies our tools by their documented names, in every advertised spelling', () => {
    for (const tool of ['mcp__session__send_agent_message', 'send_agent_message']) {
      expect(matchesSubagentToolDenial(tool, ['SendMessage'], 'test'), tool).toBe('SendMessage')
    }
    for (const tool of ['mcp__session__list_sessions', 'list_sessions']) {
      expect(matchesSubagentToolDenial(tool, ['ListAgents'], 'test'), tool).toBe('ListAgents')
    }
    // "no specifier" is the documented form, but case is not part of the rule.
    expect(matchesSubagentToolDenial('mcp__session__send_agent_message', ['sendmessage'], 'test')).toBe('sendmessage')
  })

  it('still denies them by OUR names, so the alias added a door and closed none', () => {
    expect(matchesSubagentToolDenial('mcp__session__send_agent_message', ['send_agent_message'], 'test'))
      .toBe('send_agent_message')
    expect(matchesSubagentToolDenial('mcp__session__list_sessions', ['list_sessions'], 'test'))
      .toBe('list_sessions')
    expect(matchesSubagentToolDenial('mcp__session__send_agent_message', ['mcp__session__*'], 'test'))
      .toBe('mcp__session__*')
  })

  it('does NOT widen — the two are separate tools and neither covers the other', () => {
    // The no-widening control this table's own rule demands. `SendMessage`
    // upstream also serves subagent and teammate messaging; folding it onto the
    // discovery tool, or onto any other session tool, would deny more than the
    // author wrote.
    expect(matchesSubagentToolDenial('mcp__session__list_sessions', ['SendMessage'], 'test')).toBeNull()
    expect(matchesSubagentToolDenial('mcp__session__send_agent_message', ['ListAgents'], 'test')).toBeNull()
    expect(matchesSubagentToolDenial('mcp__session__spawn_session', ['SendMessage'], 'test')).toBeNull()
    expect(matchesSubagentToolDenial('mcp__session__get_session_info', ['ListAgents'], 'test')).toBeNull()
    // The repo-local `SendMessage` collision this divergence exists to avoid is
    // an RPC, not a tool, so nothing in the pool answers to the bare name.
    expect(matchesSubagentToolDenial('sendMessage', ['ListAgents'], 'test')).toBeNull()
  })

  it('normalizes both spellings of each tool onto one identity', () => {
    expect(normalizePiRuntimeAgentToolName('SendMessage'))
      .toBe(normalizePiRuntimeAgentToolName('mcp__session__send_agent_message'))
    expect(normalizePiRuntimeAgentToolName('ListAgents'))
      .toBe(normalizePiRuntimeAgentToolName('mcp__session__list_sessions'))
    expect(normalizePiRuntimeAgentToolName('SendMessage'))
      .not.toBe(normalizePiRuntimeAgentToolName('ListAgents'))
  })
})

/**
 * P6.317 (2) — the `--agents` JSON route.
 *
 * Every case here goes through `materializePiRuntimeAgentDefinitions`, which
 * builds the descriptor AND re-parses it through
 * `parsePiRuntimeAgentDefinitions`: a value that survives to the assertion
 * survived the content-addressed digest too. That matters more on this route
 * than on the file one, because these fields arrive already TYPED — a boolean
 * `background`, a numeric `maxTurns`, a nested `hooks` mapping — and the file
 * route's line-based frontmatter reader could never produce them, so nothing
 * else in this file pins the digest over a non-string value.
 */
describe('P6.317 (2) — session agents from the `--agents` flag', () => {
  it('carries the typed fields, and the whole descriptor, through the digest round trip', async () => {
    const diagnostics: string[] = []
    const definitions = await materializePiRuntimeAgentDefinitions({
      view: { ...viewWithAgent(), agents: [] },
      materializer: materializer('unused'),
      onInvalidDefinition: diagnostic => { diagnostics.push(diagnostic.reason) },
      sessionAgents: {
        auditor: {
          prompt: 'Audit the diff.',
          description: 'reviews a branch',
          tools: ['ReadFile', 'Grep'],
          model: 'qwen3-coder-plus',
          effort: 'high',
          // The three shapes the FILE route cannot deliver: the frontmatter
          // splitter hands every scalar over as a string and a nested mapping
          // as opaque text.
          maxTurns: 12,
          background: true,
          isolation: 'worktree',
          initialPrompt: 'Read AGENTS.md, then wait.',
          hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
        },
      },
    })

    expect(diagnostics).toEqual([])
    expect(definitions).toHaveLength(1)
    const [definition] = definitions
    expect(definition!.key).toBe(`${SESSION_AGENT_KEY_PREFIX}auditor`)
    expect(definition!.name).toBe('auditor')
    // The caller named the agent, so the model invokes it by that name.
    expect(definition!.selectedAsUnqualifiedAlias).toBe(true)
    expect(definition!.systemPrompt).toBe('Audit the diff.')
    expect(definition!.tools).toEqual(['ReadFile', 'Grep'])
    expect(definition!.model).toBe('qwen3-coder-plus')
    expect(definition!.effort).toBe('high')
    expect(definition!.maxTurns).toBe(12)
    expect(definition!.background).toBe(true)
    expect(definition!.isolation).toBe('worktree')
    expect(definition!.initialPrompt).toBe('Read AGENTS.md, then wait.')
    // Parsed by the SAME reader the file route uses — no second hook parser —
    // and `PreToolUse` is a CHILD-tier event.
    expect(definition!.componentHooks?.child).toBeDefined()
    expect(definition!.componentHooks?.parent).toBeUndefined()
  })

  it('outranks a same-named agent on disk, and leaves every other one loaded', async () => {
    // `sub-agents.md#choose-the-subagent-scope`: "When multiple subagents share
    // the same name, Claude Code uses the one from the higher-priority
    // location" — `--agents` is rank 2, `.claude/agents/` is rank 3. Not a
    // diagnostic: the displacement is the documented behaviour working.
    const view = viewWithAgent()
    view.agents = [
      ...view.agents,
      { ...view.agents[0]!, key: 'plugin://x#agent.other@workspace', name: 'other' },
    ]
    const diagnostics: string[] = []

    const definitions = await materializePiRuntimeAgentDefinitions({
      view,
      materializer: materializer(DIARY_FRONTMATTER),
      onInvalidDefinition: diagnostic => { diagnostics.push(diagnostic.reason) },
      sessionAgents: { 'diary-writer': { prompt: 'Session instructions win.' } },
    })

    expect(diagnostics).toEqual([])
    expect(definitions.map(entry => entry.name).sort()).toEqual(['diary-writer', 'other'])
    const displaced = definitions.find(entry => entry.name === 'diary-writer')
    expect(displaced!.key).toBe(`${SESSION_AGENT_KEY_PREFIX}diary-writer`)
    expect(displaced!.systemPrompt).toBe('Session instructions win.')
  })

  it('excludes a malformed entry with a diagnostic naming the flag, and loads the rest', async () => {
    const diagnostics: { agentKey: string; agentName: string; file: string; reason: string }[] = []
    const definitions = await materializePiRuntimeAgentDefinitions({
      view: { ...viewWithAgent(), agents: [] },
      materializer: materializer('unused'),
      onInvalidDefinition: diagnostic => { diagnostics.push(diagnostic) },
      sessionAgents: {
        empty: { prompt: '   ' },
        missing: { description: 'no instructions at all' },
        'bad-effort': { prompt: 'Something.', effort: 'exhaustive' },
        good: { prompt: 'Something.' },
      },
    })

    expect(definitions.map(entry => entry.name)).toEqual(['good'])
    expect(diagnostics.map(entry => entry.file).sort())
      .toEqual(['--agents bad-effort', '--agents empty', '--agents missing'])
    expect(diagnostics.map(entry => entry.agentKey).sort()).toEqual([
      `${SESSION_AGENT_KEY_PREFIX}bad-effort`,
      `${SESSION_AGENT_KEY_PREFIX}empty`,
      `${SESSION_AGENT_KEY_PREFIX}missing`,
    ])
    // The FIELD's own label, the same wording the file route gives — there is
    // no second emptiness message on this route to drift from it.
    expect(diagnostics.find(entry => entry.agentName === 'empty')!.reason)
      .toBe('Invalid agents.empty.prompt: expected non-empty string')
    expect(diagnostics.find(entry => entry.agentName === 'missing')!.reason)
      .toBe('Invalid agents.missing.prompt: expected string')
    expect(diagnostics.find(entry => entry.agentName === 'bad-effort')!.reason)
      .toBe('Invalid agents.bad-effort.effort')
  })

  it('resolves an mcpServers name reference through the SAME candidate table the file route uses', async () => {
    // `mcpReferenceCandidates` was extracted so the two routes cannot drift:
    // review finding 1 (2026-08-10) is that a plugin server must not claim a
    // bare name a user-created source already owns.
    const view: AgentRuntimeView = { ...viewWithAgent(), agents: [] }
    view.mcpServers = [{
      key: 'plug:mcp:notes',
      wireName: 'plugin_evil_notes',
      logicalName: 'notes',
      pluginInstanceId: 'plugin://internal/evil@1.0.0#hash',
    } as any]
    view.sources = [{ key: 'source:mcp:notes', logicalName: 'notes', mcpWireName: 'notes' } as any]

    const [definition] = await materializePiRuntimeAgentDefinitions({
      view,
      materializer: materializer('unused'),
      sessionAgents: { auditor: { prompt: 'Audit.', mcpServers: ['notes'] } },
    })

    expect(definition!.mcpServerKeys).toEqual(['source:mcp:notes'])
  })

  it('carries an inline server with the host verdict stamped, and skips no trust gate it should apply', async () => {
    // `sub-agents.md`, `<span id="inline-server-trust" />`: a `--agents`
    // definition's inline servers load with no folder-trust check — it came
    // from the command line of the person running the app. `projectTrusted` is
    // therefore never consulted on this route, and P6.816's verdict travels
    // with the map.
    const [definition] = await materializePiRuntimeAgentDefinitions({
      view: { ...viewWithAgent(), agents: [] },
      materializer: materializer('unused'),
      projectTrusted: false,
      onUntrustedComponentSkipped: () => { throw new Error('a session agent must not consult folder trust') },
      sessionAgents: {
        auditor: {
          prompt: 'Audit.',
          mcpServers: [{ tracker: { command: 'tracker', args: ['--stdio'] } }],
        },
      },
    })

    expect(definition!.mcpServerInline).toEqual({ tracker: { command: 'tracker', args: ['--stdio'] } })
    expect(definition!.mcpServerInlineTrusted).toBe(true)
  })
})

/**
 * P6.940 (2) — the host-composed projection of a PINNED SESSION AGENT onto a Pi
 * session.
 *
 * Claude gets this natively (`Options.agent`: *"the agent's system prompt, tool
 * restrictions, and model will be applied to the main conversation"*). Pi has no
 * such path — every `spawner.ts` entry point composes a CHILD and these
 * descriptors exist for DISPATCH — so the host projects three of the
 * descriptor's fields and must announce the rest rather than dropping them
 * quietly, which is what these cases pin.
 */
describe('resolvePiSessionAgentPin (P6.940 clause 2)', () => {
  const descriptor = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 2 as const,
    key: 'user:diary-writer',
    name: 'diary-writer',
    description: 'writes a diary',
    selectedAsUnqualifiedAlias: true,
    systemPrompt: 'Write the diary.',
    sha256: 'a'.repeat(64),
    provenance: 'user',
    capabilityGeneration: 'gen-1',
    definitionDigest: 'b'.repeat(64),
    ...over,
  }) as never

  it('projects the prompt, the tools and the initialPrompt — and nothing else', () => {
    const notes: string[] = []
    const pin = resolvePiSessionAgentPin(
      [descriptor({ tools: ['Read', 'Grep'], initialPrompt: 'Read AGENTS.md, then wait.' })],
      'diary-writer',
      note => notes.push(note),
    )
    expect(pin).toEqual({
      name: 'diary-writer',
      systemPrompt: 'Write the diary.',
      tools: ['Read', 'Grep'],
      initialPrompt: 'Read AGENTS.md, then wait.',
    })
    // Nothing unapplied was declared, so nothing is announced — the diagnostic
    // must not fire on an agent that fits.
    expect(notes).toEqual([])
  })

  it('announces every declared field a main-session pin cannot apply, model included', () => {
    const notes: string[] = []
    resolvePiSessionAgentPin(
      [descriptor({ model: 'claude-opus-5', effort: 'high', maxTurns: 3, disallowedTools: ['Bash'] })],
      'diary-writer',
      note => notes.push(note),
    )
    expect(notes).toHaveLength(1)
    // The model is the one whose silent application would give a session two
    // answers to "what model is this?" — ledger K7's one-session-one-upstream.
    expect(notes[0]).toContain('model')
    expect(notes[0]).toContain('effort')
    expect(notes[0]).toContain('maxTurns')
    // `disallowedTools` has no honest Pi expression: the one field that removes
    // without naming a universe is skill-scoped by contract.
    expect(notes[0]).toContain('disallowedTools')
    expect(notes[0]).toContain('keeps its own model')
  })

  it('resolves by KEY as well as by name, because a plugin agent is addressed by its key', () => {
    expect(resolvePiSessionAgentPin([descriptor()], 'user:diary-writer')?.name).toBe('diary-writer')
  })

  it('degrades on an unknown name and on an empty roster — it never returns a pin it cannot honour', () => {
    // A mistyped setting must not become a session that will not start, which is
    // the same reason the claude arm refuses to forward an unresolvable name.
    const unknown: string[] = []
    expect(resolvePiSessionAgentPin([descriptor()], 'diary-writter', n => unknown.push(n))).toBeUndefined()
    expect(unknown[0]).toContain('no agent by that name')
    expect(unknown[0]).toContain('diary-writer')

    const empty: string[] = []
    expect(resolvePiSessionAgentPin([], 'diary-writer', n => empty.push(n))).toBeUndefined()
    expect(empty[0]).toContain('registers no agent definitions')

    const none: string[] = []
    expect(resolvePiSessionAgentPin(undefined, undefined, n => none.push(n))).toBeUndefined()
    // No pin asked for is not a problem and must say nothing at all.
    expect(none).toEqual([])
  })

  it('omits an empty tools list rather than pinning an empty ceiling', () => {
    // An empty `piAllowedTools` denies every tool. A definition with `tools: []`
    // means "declared nothing", not "allow nothing".
    expect(resolvePiSessionAgentPin([descriptor({ tools: [] })], 'diary-writer')?.tools).toBeUndefined()
  })
})
