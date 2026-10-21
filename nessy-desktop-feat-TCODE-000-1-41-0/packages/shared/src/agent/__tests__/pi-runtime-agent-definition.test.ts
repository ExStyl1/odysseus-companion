import { describe, expect, it } from 'bun:test'

import type { AgentRuntimeView } from '../../capabilities/views.ts'
import {
  materializePiRuntimeAgentDefinitions,
  parsePiRuntimeAgentDefinitions,
  validatePiRuntimeAgentDefinitionContent,
  type PiRuntimeAgentDefinitionDiagnostic,
} from '../pi-harness/runtime-agent-definition.ts'

function runtimeView(): AgentRuntimeView {
  return {
    generation: 'generation-1',
    sources: [],
    skills: [],
    mcpServers: [],
    hooks: [],
    automations: [],
    agents: [{
      key: 'plugin://greenpt/honey#agent.hive-scout@workspace',
      name: 'hive-scout',
      description: 'Read-only scout',
      selectedAsUnqualifiedAlias: true,
      instructionsResource: {
        pluginInstanceId: 'plugin://greenpt/honey@1.1.0#hash',
        relativePath: 'agents/hive-scout.md',
        contentHash: 'a'.repeat(64),
      },
      model: 'inherit',
      tools: ['Read', 'Grep'],
    }],
    promptLayers: [],
    memory: [],
    permissionLayers: [],
    commands: [],
    promptCommands: [],
    apps: [],
  }
}

describe('Pi runtime agent definitions', () => {
  it('materializes frontmatter-free instructions into a bounded path-free transport', async () => {
    const definitions = await materializePiRuntimeAgentDefinitions({
      view: runtimeView(),
      materializer: {
        assertActive() {},
        async verifyPlugin() {},
        async resolvePath() { throw new Error('paths must not be transported') },
        async readText() {
          return [
            '---',
            'name: ignored-transport-metadata',
            '---',
            'Inspect only the requested scope.',
          ].join('\n')
        },
        resolveCredential() { throw new Error('not used') },
      },
    })

    expect(definitions).toEqual([expect.objectContaining({
      schemaVersion: 2,
      key: 'plugin://greenpt/honey#agent.hive-scout@workspace',
      name: 'hive-scout',
      selectedAsUnqualifiedAlias: true,
      systemPrompt: 'Inspect only the requested scope.',
      tools: ['Read', 'Grep'],
      provenance: 'plugin://greenpt/honey#agent.hive-scout@workspace@generation-1',
      capabilityGeneration: 'generation-1',
      definitionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })])
    expect(JSON.stringify(definitions)).not.toContain('agents/hive-scout.md')
    expect(Object.isFrozen(definitions)).toBe(true)
    expect(Object.isFrozen(definitions[0])).toBe(true)
  })

  it('excludes duplicate keys and tampered prompts at subprocess ingress, naming the reason', async () => {
    // A1: exclusion, not a list-fatal throw. The security property is
    // unchanged — a tampered entry NEVER loads — but the surviving entries do,
    // and the failure is reported per entry instead of failing the turn.
    const definitions = await materializePiRuntimeAgentDefinitions({
      view: runtimeView(),
      materializer: {
        assertActive() {},
        async verifyPlugin() {},
        async resolvePath() { return '' },
        async readText() { return 'Pinned instructions.' },
        resolveCredential() { throw new Error('not used') },
      },
    })
    const reasons: string[] = []
    const onInvalid = (failure: { reason: string }) => { reasons.push(failure.reason) }

    expect(parsePiRuntimeAgentDefinitions([
      { ...definitions[0], systemPrompt: 'tampered' },
    ], { onInvalid })).toEqual([])
    expect(reasons.at(-1)).toContain('sha256')

    expect(parsePiRuntimeAgentDefinitions([
      { ...definitions[0], capabilityGeneration: 'stale-generation' },
    ], { onInvalid })).toEqual([])
    expect(reasons.at(-1)).toContain('definitionDigest')

    const survivors = parsePiRuntimeAgentDefinitions([
      definitions[0],
      definitions[0],
    ], { onInvalid })
    expect(survivors).toHaveLength(1)
    expect(reasons.at(-1)).toContain('duplicate key')
  })

  it('resolves a skills preload list from agent frontmatter into skillKeys', async () => {
    const view = runtimeView()
    view.skills = [
      { key: 'skill://api-conventions', logicalName: 'api-conventions', selectedAsUnqualifiedAlias: true } as any,
      { key: 'skill://unlisted', logicalName: 'unlisted', selectedAsUnqualifiedAlias: true } as any,
    ]
    const materializer = {
      assertActive() {}, async verifyPlugin() {}, async resolvePath() { return '' },
      async readText() {
        return ['---', 'skills:', '  - api-conventions', '---', 'Pinned instructions.'].join('\n')
      },
      resolveCredential() { throw new Error('not used') },
    }

    const [definition] = await materializePiRuntimeAgentDefinitions({ view, materializer })
    // Only the named skill is preloaded; `unlisted` stays reachable through the
    // Skill tool but is not injected at startup.
    expect(definition!.skillKeys).toEqual(['skill://api-conventions'])

    const missing = {
      ...materializer,
      async readText() {
        return ['---', 'skills:', '  - nonexistent', '---', 'Pinned instructions.'].join('\n')
      },
    }
    const diagnostics: PiRuntimeAgentDefinitionDiagnostic[] = []
    const excluded = await materializePiRuntimeAgentDefinitions({
      view,
      materializer: missing,
      onInvalidDefinition: diagnostic => diagnostics.push(diagnostic),
    })
    expect(excluded).toEqual([])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.reason).toContain('Unavailable skill reference: nonexistent')
  })

  it('ignores permissionMode, mcpServers and hooks declared by a PLUGIN subagent', async () => {
    // sub-agents.md: "For security reasons, plugin subagents don't support the
    // `hooks`, `mcpServers`, or `permissionMode` frontmatter fields. These
    // fields are ignored when loading agents from a plugin."
    const view = runtimeView()
    // The fixture agent's instructions live in a plugin bundle, which is what
    // makes it a plugin subagent.
    expect('pluginInstanceId' in view.agents[0]!.instructionsResource).toBe(true)
    view.mcpServers = [{ key: 'mcp://slack', wireName: 'slack' } as any]
    const materializer = {
      assertActive() {}, async verifyPlugin() {}, async resolvePath() { return '' },
      async readText() {
        return [
          '---',
          'permissionMode: bypassPermissions',
          'mcpServers:',
          '  - slack',
          // P6.808 — the INLINE form is excluded by the same rule as the
          // reference form: an ignored field must not become a way for a plugin
          // to hand its own subagent a server.
          '  - playwright:',
          '      type: stdio',
          '      command: npx',
          'hooks:',
          '  PreToolUse:',
          '    - matcher: "Bash"',
          '---',
          'Pinned instructions.',
        ].join('\n')
      },
      resolveCredential() { throw new Error('not used') },
    }

    const [definition] = await materializePiRuntimeAgentDefinitions({ view, materializer })

    // A plugin must not hand its own subagent a broader permission mode...
    expect(definition!.permissionMode).toBeUndefined()
    // ...its own MCP servers, referenced OR inline (P6.808)...
    expect(definition!.mcpServerKeys).toBeUndefined()
    expect(definition!.mcpServerInline).toBeUndefined()
    // ...or its own lifecycle hooks.
    expect(JSON.stringify(definition)).not.toContain('PreToolUse')

    // The exclusion is not a rejection: the rest of the agent still loads.
    expect(definition!.systemPrompt).toBe('Pinned instructions.')
  })

  it('ignores a plugin subagent permissionMode supplied on the host route too', async () => {
    // The resolver does not populate this field for an agent today. Dropping it
    // anyway is what keeps the exclusion from depending on that staying true.
    const view = runtimeView()
    view.agents[0] = { ...view.agents[0]!, permissionMode: 'bypassPermissions', mcpServerKeys: ['mcp://slack'] }
    view.mcpServers = [{ key: 'mcp://slack', wireName: 'slack' } as any]
    const [definition] = await materializePiRuntimeAgentDefinitions({
      view,
      materializer: {
        assertActive() {}, async verifyPlugin() {}, async resolvePath() { return '' },
        async readText() { return 'Pinned instructions.' },
        resolveCredential() { throw new Error('not used') },
      },
    })
    expect(definition!.permissionMode).toBeUndefined()
    expect(definition!.mcpServerKeys).toBeUndefined()
  })

  it('keeps permissionMode and mcpServers for a NATIVE (non-plugin) subagent', async () => {
    // The mirror of the two cases above: the exclusion is scoped to plugins, so
    // a user's own `~/.nessy-agent/agents` file keeps both fields.
    const view = runtimeView()
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
    view.mcpServers = [{ key: 'mcp://slack', wireName: 'slack' } as any]
    const [definition] = await materializePiRuntimeAgentDefinitions({
      view,
      materializer: {
        assertActive() {}, async verifyPlugin() {}, async resolvePath() { return '' },
        async readText() {
          return ['---', 'permissionMode: plan', 'mcpServers:', '  - slack', '---', 'Pinned instructions.'].join('\n')
        },
        resolveCredential() { throw new Error('not used') },
      },
    })
    expect(definition!.permissionMode).toBe('plan')
    expect(definition!.mcpServerKeys).toEqual(['mcp://slack'])
  })

  it('reads the INLINE mcpServers form and keeps the reference listed after it (P6.808)', async () => {
    // `sub-agents.md#scope-mcp-servers-to-a-subagent`: "Each entry in the list is
    // either an inline server definition or a string referencing an MCP server
    // already configured in your session". This is the page's own example.
    //
    // MEASURED AT HEAD before P6.808: `optionalStringList` threw
    // `Invalid agent.<name>.mcpServers[0]: expected non-empty string` and
    // `materializePiRuntimeAgentDefinitions` excluded the WHOLE definition — so
    // the `- github` REFERENCE, the form the parity row records as working, was
    // lost by the mere presence of an inline sibling. That is the control this
    // case exists for; `mcpServerInline` is the second assertion, not the first.
    const view = runtimeView()
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
    view.mcpServers = [{ key: 'mcp://github', wireName: 'github' } as any]
    const excluded: PiRuntimeAgentDefinitionDiagnostic[] = []
    const definitions = await materializePiRuntimeAgentDefinitions({
      view,
      onInvalidDefinition: diagnostic => excluded.push(diagnostic),
      materializer: {
        assertActive() {}, async verifyPlugin() {}, async resolvePath() { return '' },
        async readText() {
          return [
            '---',
            'mcpServers:',
            '  - playwright:',
            '      type: stdio',
            '      command: npx',
            '  - github',
            '---',
            'Pinned instructions.',
          ].join('\n')
        },
        resolveCredential() { throw new Error('not used') },
      },
    })
    expect(excluded).toEqual([])
    expect(definitions.length).toBe(1)
    const definition = definitions[0]!
    expect(definition.mcpServerKeys).toEqual(['mcp://github'])
    expect(definition.mcpServerInline).toEqual({ playwright: { type: 'stdio', command: 'npx' } })
    // `materializePiRuntimeAgentDefinitions` runs the WIRE parse on what it
    // built, so surviving it is the digest-position rule (P6.790) exercised on a
    // descriptor that actually POPULATES the new key — the one case a fixture
    // leaving it unset can never reach.
    expect(definition.definitionDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  /**
   * P6.792 / P6.816 — the folder-trust gate for the inline half, and the verdict
   * that travels with it.
   *
   * `sub-agents.md`, the explicit `<span id="inline-server-trust" />` anchor:
   * "Claude Code loads an inline server from an agent file in your project's
   * `.claude/agents/` directory, or in an `--add-dir` directory's
   * `.claude/agents/`, only after you trust the folder the agent file came
   * from." The same section says what happens until then: "Claude Code skips
   * every inline server in that agent file" — the agent still runs, and a name
   * reference in the same list is not gated at all.
   */
  describe('an inline mcpServers entry is gated on the agent folder\'s trust', () => {
    const CONTENT = [
      '---',
      'mcpServers:',
      '  - playwright:',
      '      type: stdio',
      '      command: npx',
      '  - github',
      '---',
      'Pinned instructions.',
    ].join('\n')

    function projectScopedView(): AgentRuntimeView {
      const view = runtimeView()
      view.agents[0] = {
        ...view.agents[0]!,
        instructionsResource: {
          source: 'shared-personal',
          // The gated scope. `subagentHookScope`'s allowlist folds
          // builtin/global/workspace into the exempt set; anything else — a
          // project folder, an `--add-dir` one — is `'project'`.
          scope: { kind: 'project' },
          resourceId: 'agents/db-admin.md',
          absolutePath: '/project/.nessy-agent/agents/db-admin.md',
          revision: '1',
          contentHash: 'b'.repeat(64),
        } as any,
      }
      view.mcpServers = [{ key: 'mcp://github', wireName: 'github' } as any]
      return view
    }

    function materialize(view: AgentRuntimeView, projectTrusted?: boolean) {
      const skipped: PiRuntimeAgentDefinitionDiagnostic[] = []
      return materializePiRuntimeAgentDefinitions({
        view,
        ...(projectTrusted === undefined ? {} : { projectTrusted }),
        onUntrustedComponentSkipped: diagnostic => skipped.push(diagnostic),
        materializer: {
          assertActive() {}, async verifyPlugin() {}, async resolvePath() { return '' },
          async readText() { return CONTENT },
          resolveCredential() { throw new Error('not used') },
        },
      }).then(definitions => ({ definitions, skipped }))
    }

    it('starts a project-folder server once the folder is trusted, and says so on the wire', async () => {
      const { definitions, skipped } = await materialize(projectScopedView(), true)

      expect(skipped).toEqual([])
      const definition = definitions[0]!
      expect(definition.mcpServerInline).toEqual({ playwright: { type: 'stdio', command: 'npx' } })
      // P6.816: the verdict is a field of its own, not something the wire side
      // re-derives from the map's presence.
      expect(definition.mcpServerInlineTrusted).toBe(true)
      // Survived the wire parse `materializePiRuntimeAgentDefinitions` runs over
      // what it built — the digest-position rule, exercised on a descriptor that
      // populates the new key.
      expect(definition.definitionDigest).toMatch(/^[a-f0-9]{64}$/)
    })

    it('skips it when the folder is not trusted, and keeps the reference beside it', async () => {
      const { definitions, skipped } = await materialize(projectScopedView(), false)

      expect(definitions).toHaveLength(1)
      const definition = definitions[0]!
      expect(definition.mcpServerInline).toBeUndefined()
      expect(definition.mcpServerInlineTrusted).toBeUndefined()
      // The page gates the inline half ONLY: "a name that references a server
      // you already configured" is one of the two kinds loaded without a check.
      expect(definition.mcpServerKeys).toEqual(['mcp://github'])
      expect(skipped).toHaveLength(1)
      expect(skipped[0]!.reason).toContain('inline mcpServers skipped')
      expect(skipped[0]!.agentName).toBe('hive-scout')
    })

    it('leaves the exempt scopes alone — the control that the gate is not blanket', async () => {
      const view = projectScopedView()
      view.agents[0] = {
        ...view.agents[0]!,
        instructionsResource: {
          ...view.agents[0]!.instructionsResource,
          scope: { kind: 'global' },
        } as any,
      }
      // No `projectTrusted` at all: the user-level directory is one of the
      // scopes the page exempts, so the absence of a grant must not matter.
      const { definitions, skipped } = await materialize(view)

      expect(skipped).toEqual([])
      expect(definitions[0]!.mcpServerInline).toEqual({ playwright: { type: 'stdio', command: 'npx' } })
      expect(definitions[0]!.mcpServerInlineTrusted).toBe(true)
    })

    it('refuses an inline map that reaches the wire without the verdict', async () => {
      const { definitions } = await materialize(projectScopedView(), true)
      const reasons: string[] = []
      const onInvalid = (failure: { reason: string }) => { reasons.push(failure.reason) }
      const { mcpServerInlineTrusted: _stripped, ...withoutVerdict } = definitions[0]!

      expect(parsePiRuntimeAgentDefinitions([withoutVerdict], { onInvalid })).toEqual([])
      // Named, not a bare digest mismatch: the subprocess has no folder and no
      // trust state, so "the host never said" has to be legible as itself.
      expect(reasons.at(-1)).toBe(
        'Invalid piRuntimeAgentDefinitions[0].mcpServerInline: no folder-trust verdict travelled with it',
      )

      // The mirror: a verdict about nothing is refused too, so the pair cannot
      // drift apart in either direction.
      const { mcpServerInline: _dropped, ...verdictOnly } = definitions[0]!
      expect(parsePiRuntimeAgentDefinitions([verdictOnly], { onInvalid })).toEqual([])
      expect(reasons.at(-1)).toBe(
        'Invalid piRuntimeAgentDefinitions[0].mcpServerInlineTrusted: no inline server travelled with it',
      )
    })
  })

  it('refuses an inline mcpServers entry whose body is not a server definition, by name', async () => {
    // The boundary: the row is not "accept anything". A malformed entry is
    // refused with the field named, which costs that ONE definition — the
    // alternative is an agent quietly running without the server it was written
    // around.
    const refused = validatePiRuntimeAgentDefinitionContent({
      name: 'db-admin',
      content: [
        '---',
        'mcpServers:',
        '  - ["playwright", {"type": "stdio"}]',
        '---',
        'Pinned instructions.',
      ].join('\n'),
    })
    expect(refused.ok).toBe(false)
    expect((refused as { reason: string }).reason)
      .toBe('Invalid agent.db-admin.mcpServers[0]: expected a server name or an inline server definition')

    // ...and the documented example is accepted on the same path, so the
    // refusal above is a shape verdict rather than the old blanket one.
    expect(validatePiRuntimeAgentDefinitionContent({
      name: 'db-admin',
      content: [
        '---',
        'mcpServers:',
        '  - playwright:',
        '      type: stdio',
        '      command: npx',
        '---',
        'Pinned instructions.',
      ].join('\n'),
    })).toEqual({ ok: true })
  })

  it('resolves MCP-backed Source keys but rejects non-MCP Source keys', async () => {
    const view = runtimeView()
    view.sources = [
      { key: 'source://gitlab', logicalName: 'gitlab', mcpWireName: 'gitlab', resource: {} as any },
      { key: 'source://api', logicalName: 'api', resource: {} as any },
    ]
    // Source-key resolution is orthogonal to the plugin exclusion, so this case
    // uses a NATIVE agent; a plugin one would now correctly have no MCP servers.
    view.agents[0] = {
      ...view.agents[0]!,
      mcpServerKeys: ['source://gitlab'],
      instructionsResource: {
        source: 'shared-personal',
        scope: { kind: 'global' },
        resourceId: 'agents/native.md',
        absolutePath: '/agents/native.md',
        revision: '1',
        contentHash: 'b'.repeat(64),
      } as any,
    }
    const materializer = {
      assertActive() {}, async verifyPlugin() {}, async resolvePath() { return '' },
      async readText() { return 'Pinned instructions.' }, resolveCredential() { throw new Error('not used') },
    }

    const [definition] = await materializePiRuntimeAgentDefinitions({ view, materializer })
    expect(definition!.mcpServerKeys).toEqual(['source://gitlab'])

    view.agents[0] = { ...view.agents[0]!, mcpServerKeys: ['source://api'] }
    const diagnostics: PiRuntimeAgentDefinitionDiagnostic[] = []
    const excluded = await materializePiRuntimeAgentDefinitions({
      view,
      materializer,
      onInvalidDefinition: diagnostic => diagnostics.push(diagnostic),
    })
    expect(excluded).toEqual([])
    expect(diagnostics[0]!.reason).toContain('Unavailable MCP server reference: source://api')
  })

  it('excludes an agent with present-invalid frontmatter and names the file and reason', async () => {
    // A1: per-entry exclusion. The field validation itself is unchanged — each
    // of these frontmatter shapes still refuses to load — but the refusal now
    // costs that one agent, not the whole definitions list at send time.
    const cases = [
      ['effort: ultra', 'effort'],
      ['maxTurns: 0', 'maxTurns'],
      ['maxTurns: nope', 'maxTurns'],
      ['tier: huge', 'tier'],
      ['tier:', 'tier'],
      ['model:', 'model'],
      // P9: a non-string entry in a tool list. Both arms went through a
      // hand-rolled scanner that kept the flow sequence verbatim, so the JSON
      // branch of `optionalToolList` refused them per entry; under P4's js-yaml
      // reader the sequence is PARSED, and a flattener that stringified the `1`
      // handed the runtime a tool literally named "1" instead. The number is the
      // arm that regressed; the mapping is its sibling, which flattened to `''`
      // and read as an empty list — i.e. "inherit every tool", the widest
      // possible reading of a malformed ceiling.
      ['tools: ["Read", 1]', 'tools'],
      ['tools: ["Read", { nested: true }]', 'tools'],
    ] as const

    for (const [frontmatterLine, expected] of cases) {
      const view = runtimeView()
      view.agents[0] = { ...view.agents[0]!, model: undefined, tools: undefined }
      const diagnostics: PiRuntimeAgentDefinitionDiagnostic[] = []
      const definitions = await materializePiRuntimeAgentDefinitions({
        view,
        materializer: {
          assertActive() {},
          async verifyPlugin() {},
          async resolvePath() { throw new Error('paths must not be transported') },
          async readText() {
            return ['---', frontmatterLine, '---', 'Pinned instructions.'].join('\n')
          },
          resolveCredential() { throw new Error('not used') },
        },
        onInvalidDefinition: diagnostic => diagnostics.push(diagnostic),
      })
      expect(definitions).toEqual([])
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]!.reason).toContain(expected)
      // The diagnostic names the definition file a user would open to fix it.
      expect(diagnostics[0]!.file).toContain('agents/hive-scout.md')
    }
  })

  /**
   * P2.202. This test asserted the OPPOSITE until 2026-08-27 — "parses empty
   * tools/disallowedTools/skills lists as omitted (inherit)" — reading
   * `sub-agents.md`'s "Inherits every tool available to subagents if omitted"
   * onto an empty list as well.
   *
   * `errors.md#agent-would-be-spawned-with-zero-tools` refutes that directly
   * (re-fetched 2026-08-27): "Omitting the `tools` field never triggers this
   * refusal. If you leave the `tools` list empty, or `disallowedTools` removes
   * every entry in it, Claude Code also skips the refusal and launches the
   * subagent without tools", and the same section's fix list: "Delete the
   * `tools` field instead of listing tools to give the subagent every tool
   * available to subagents." Deleted means everything; empty means nothing.
   *
   * Per FIELD, not per parser — the same split `agents/definitions.ts` makes:
   * `tools` keeps the empty set, `disallowedTools` and `skills` collapse it,
   * because an empty denylist denies nothing and an empty preload list preloads
   * nothing.
   */
  const authoredEmptySpellings = ['tools: []', 'tools:', 'tools: ""', 'tools: ,,,']
  for (const spelling of authoredEmptySpellings) {
    it(`keeps an authored-empty tools list as the empty SET (${JSON.stringify(spelling)})`, async () => {
      const view = runtimeView()
      view.agents[0] = { ...view.agents[0]!, model: undefined, tools: undefined }
      const [definition] = await materializePiRuntimeAgentDefinitions({
        view,
        materializer: {
          assertActive() {},
          async verifyPlugin() {},
          async resolvePath() { throw new Error('paths must not be transported') },
          async readText() {
            return ['---', spelling, 'disallowedTools: []', 'skills: []', '---', 'Pinned instructions.'].join('\n')
          },
          resolveCredential() { throw new Error('not used') },
        },
      })
      expect(definition).toBeDefined()
      expect(definition!.tools).toEqual([])
      // Unchanged, and deliberately asymmetric with `tools` above.
      expect(definition!.disallowedTools).toBeUndefined()
      expect(definition!.skillKeys).toBeUndefined()

      // The wire half. Both collapse sites had to move together or this stays
      // green while nothing changed downstream: the descriptor builder folded
      // `[]` away BEFORE `parseTools` ever saw it, so the row's stated site was
      // only half the defect. Round-tripping the REAL descriptor — digest and
      // all — is what exercises both.
      const parsedWire = parsePiRuntimeAgentDefinitions([definition!])
      expect(parsedWire).toHaveLength(1)
      expect(parsedWire[0]!.tools).toEqual([])
    })
  }

  it('keeps an OMITTED tools key omitted, so the inherit default still has an owner', async () => {
    const view = runtimeView()
    view.agents[0] = { ...view.agents[0]!, model: undefined, tools: undefined }
    const [definition] = await materializePiRuntimeAgentDefinitions({
      view,
      materializer: {
        assertActive() {},
        async verifyPlugin() {},
        async resolvePath() { throw new Error('paths must not be transported') },
        async readText() {
          return ['---', 'color: yellow', '---', 'Pinned instructions.'].join('\n')
        },
        resolveCredential() { throw new Error('not used') },
      },
    })
    expect(definition).toBeDefined()
    expect(definition!.tools).toBeUndefined()
    expect(parsePiRuntimeAgentDefinitions([definition!])[0]!.tools).toBeUndefined()

    // And the two spellings are no longer digest-equal, which is the mechanical
    // proof that the field now reaches the wire: injecting `tools: []` onto a
    // descriptor digested WITHOUT the key is refused rather than silently
    // accepted as inherit. (Before P2.202 this parsed fine and yielded
    // `undefined` — the collapse hid the tamper.)
    const failures: { reason: string }[] = []
    const tampered = parsePiRuntimeAgentDefinitions(
      [{ ...definition!, tools: [] }],
      { onInvalid: failure => failures.push(failure) },
    )
    expect(tampered).toHaveLength(0)
    expect(failures[0]!.reason).toContain('definitionDigest')
  })

  it('A1 gate: one malformed definition is skipped and named while the valid ones load', async () => {
    // The measured failure: one bad file in ~/.nessy-agent/agents/ made
    // materialize → getOrCreateAgentUnchecked → sendMessage throw, killing
    // every send in every session. Per-entry exclusion is the contract now.
    const view = runtimeView()
    view.agents = [
      view.agents[0]!,
      {
        key: 'agent.broken@global',
        name: 'broken',
        description: '',
        selectedAsUnqualifiedAlias: false,
        instructionsResource: {
          source: 'shared-personal',
          scope: { kind: 'global' },
          resourceId: 'agents/broken.md',
          absolutePath: '/home/user/.nessy-agent/agents/broken.md',
          revision: '1',
          contentHash: 'c'.repeat(64),
        } as any,
      },
    ]
    const diagnostics: PiRuntimeAgentDefinitionDiagnostic[] = []
    const definitions = await materializePiRuntimeAgentDefinitions({
      view,
      materializer: {
        assertActive() {},
        async verifyPlugin() {},
        async resolvePath() { return '' },
        async readText(resource: unknown) {
          return typeof resource === 'object' && resource !== null && 'pluginInstanceId' in resource
            ? 'Valid instructions.'
            : ['---', 'permissionMode: nope', '---', 'Broken instructions.'].join('\n')
        },
        resolveCredential() { throw new Error('not used') },
      },
      onInvalidDefinition: diagnostic => diagnostics.push(diagnostic),
    })
    expect(definitions.map(definition => definition.name)).toEqual(['hive-scout'])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]!.agentKey).toBe('agent.broken@global')
    expect(diagnostics[0]!.file).toBe('/home/user/.nessy-agent/agents/broken.md')
    expect(diagnostics[0]!.reason).toContain('permissionMode')
  })

  it('validatePiRuntimeAgentDefinitionContent refuses loudly per file where the runtime skips', () => {
    // The skill_validate-style strict half: the doctor names what the send
    // path silently excludes, from the same validation code.
    expect(validatePiRuntimeAgentDefinitionContent({
      name: 'ok',
      content: '---\ntools: Read\n---\nDo the thing.',
    })).toEqual({ ok: true })
    expect(validatePiRuntimeAgentDefinitionContent({
      name: 'cdp-high-effort',
      content: '---\ntools: []\n---\nInstructions.',
    })).toEqual({ ok: true })

    const invalid = validatePiRuntimeAgentDefinitionContent({
      name: 'broken',
      content: '---\npermissionMode: nope\n---\nDo the thing.',
    })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.reason).toContain('permissionMode')

    const empty = validatePiRuntimeAgentDefinitionContent({ name: 'empty', content: '---\ncolor: yellow\n---\n' })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.reason).toContain('instructions')
  })

  it('still refuses an invalid permissionMode on a NATIVE subagent — by excluding that agent', async () => {
    // Moved off the plugin fixture rather than dropped: `permissionMode` is
    // ignored for plugin subagents, and an ignored field must not reject the
    // agent. Where the field applies it still refuses to load — per entry, with
    // the diagnostic naming the native file's absolute path.
    const view = runtimeView()
    view.agents[0] = {
      ...view.agents[0]!,
      model: undefined,
      tools: undefined,
      instructionsResource: {
        source: 'shared-personal',
        scope: { kind: 'global' },
        resourceId: 'agents/native.md',
        absolutePath: '/agents/native.md',
        revision: '1',
        contentHash: 'b'.repeat(64),
      } as any,
    }
    const diagnostics: PiRuntimeAgentDefinitionDiagnostic[] = []
    const definitions = await materializePiRuntimeAgentDefinitions({
      view,
      materializer: {
        assertActive() {}, async verifyPlugin() {}, async resolvePath() { return '' },
        async readText() {
          return ['---', 'permissionMode: nope', '---', 'Pinned instructions.'].join('\n')
        },
        resolveCredential() { throw new Error('not used') },
      },
      onInvalidDefinition: diagnostic => diagnostics.push(diagnostic),
    })
    expect(definitions).toEqual([])
    expect(diagnostics[0]!.file).toBe('/agents/native.md')
    expect(diagnostics[0]!.reason).toContain('permissionMode')
  })
})
