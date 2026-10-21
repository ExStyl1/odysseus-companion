import { describe, expect, it } from 'bun:test'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import {
  agentMentionInvocationId,
  buildMcpServerRows,
  isComposerSelectableSkillRow,
  isComposerSelectableSourceRow,
  isSafeSourceRow,
  skillMentionInvocationId,
  sourceTypeFor,
} from '../capability-catalog'
import { parseMentions } from '../mentions'

function capability(
  key: string,
  kind: SafeCapabilitySummary['kind'],
  sourceType?: 'api' | 'mcp' | 'local',
  origin: SafeCapabilitySummary['origin'] = 'native',
): SafeCapabilitySummary {
  return {
    key,
    kind,
    logicalName: key,
    ...(sourceType ? { sourceType } : {}),
    origin,
    scope: { kind: 'workspace', workspaceId: 'ws-1' },
    state: 'active',
    readOnly: origin === 'plugin',
    trustState: 'not-required',
    credentialState: 'not-required',
    selectedAsUnqualifiedAlias: true,
    diagnosticCodes: [],
  }
}

describe('composer source picker filter (R3 part C)', () => {
  const catalog = [
    capability('source-api', 'source', 'api'),
    capability('source-local', 'source', 'local'),
    capability('source-mcp-transport', 'source', 'mcp'),
    capability('mcp-native', 'mcp', 'mcp'),
    capability('mcp-connector', 'mcp', 'mcp', 'plugin'),
    capability('skill-one', 'skill'),
  ]

  it('keeps ONLY folder + API sources in the composer picker (excludes MCP kinds and MCP-transport sources)', () => {
    const composer = catalog.filter(isComposerSelectableSourceRow).map(item => item.key)
    expect(composer).toEqual(['source-api', 'source-local'])
  })

  it('treats a source with no explicit sourceType as API (composer-selectable)', () => {
    expect(isComposerSelectableSourceRow(capability('source-default', 'source'))).toBe(true)
  })

  it('never lets a kind:mcp native or a plugin connector into the picker', () => {
    expect(isComposerSelectableSourceRow(capability('mcp-native', 'mcp', 'mcp'))).toBe(false)
    expect(isComposerSelectableSourceRow(capability('mcp-connector', 'mcp', 'mcp', 'plugin'))).toBe(false)
  })

  it('leaves the Sources management panel filter (isSafeSourceRow) unchanged — MCP still shows there (R2)', () => {
    const management = catalog.filter(isSafeSourceRow).map(item => item.key)
    expect(management).toEqual([
      'source-api',
      'source-local',
      'source-mcp-transport',
      'mcp-native',
      'mcp-connector',
    ])
  })
})

/**
 * P6.311 — the identity the `@` typeahead emits for a subagent.
 *
 * Two arms, and the second is the one a refactor breaks: a plugin subagent's
 * identity is its SCOPED name (`sub-agents.md`: "appear in the typeahead under
 * their scoped name, such as `my-plugin:code-reviewer`"), which the catalog
 * already carries in `mention.id`. Deriving it from `logicalName` would emit the
 * bare name and let two plugins' agents collide.
 */
describe('agent mention identity', () => {
  it('is the logical name for an agent row as the protocol allows one today', () => {
    expect(agentMentionInvocationId(capability('code-reviewer', 'agent'))).toBe('code-reviewer')
  })

  it('prefers the scoped mention id — reachable since P6.694 widened the union', () => {
    // Until P6.694 this branch was unreachable: `mention.type` was
    // `'source' | 'skill'`, so no agent row could legally carry the record and
    // this test had to cast one in. The union now carries `'agent'` and the
    // projection emits it (`capabilities/views.ts`, `agentMentionId`), so the
    // row below is the shape a real plugin agent arrives in.
    const scoped = {
      ...capability('security', 'agent'),
      mention: {
        type: 'agent' as const,
        id: 'my-plugin:review:security',
        qualifiedId: 'my-plugin:review:security',
        selectedAsShortAlias: false,
        label: 'security',
      },
    } satisfies SafeCapabilitySummary
    expect(agentMentionInvocationId(scoped)).toBe('my-plugin:review:security')
  })

  it('does NOT take the skill short-alias path', () => {
    // `skillMentionInvocationId` may emit a SHORT alias when unambiguous; an
    // agent name is what the host resolves to exactly one definition, so the two
    // helpers must not converge on a row that carries both spellings.
    const row = {
      ...capability('security', 'agent'),
      mention: {
        // `'skill'` on purpose here: the point is that the two HELPERS must not
        // converge on one row, so the row deliberately carries the type the
        // skill helper reads.
        type: 'skill' as const,
        id: 'security',
        qualifiedId: 'my-plugin:security',
        selectedAsShortAlias: false,
        label: 'security',
      },
    } satisfies SafeCapabilitySummary
    expect(agentMentionInvocationId(row)).toBe('security')
    expect(skillMentionInvocationId(row)).toBe('my-plugin:security')
  })
})

describe('composer skill picker activation filter', () => {
  it('keeps active skills and excludes policy-disabled skills', () => {
    const active = capability('skill-active', 'skill')
    const disabled = {
      ...capability('skill-disabled', 'skill', undefined, 'plugin'),
      state: 'disabled' as const,
      unavailableReason: 'policy-disabled' as const,
    }

    expect([active, disabled].filter(isComposerSelectableSkillRow).map(item => item.key))
      .toEqual(['skill-active'])
  })

  it('uses the short winner alias and exact collision-loser identity', () => {
    const project = {
      ...capability('skill:project:honey', 'skill'),
      logicalName: 'honey',
      mention: {
        type: 'skill' as const,
        id: 'honey',
        qualifiedId: 'skill:project:honey',
        selectedAsShortAlias: true,
        label: 'Project Honey',
      },
    }
    const plugin = {
      ...capability('plugin:greenpt/honey:skill.honey', 'skill', undefined, 'plugin'),
      logicalName: 'honey',
      selectedAsUnqualifiedAlias: false,
      mention: {
        type: 'skill' as const,
        id: 'honey',
        qualifiedId: 'plugin:greenpt/honey:skill.honey',
        selectedAsShortAlias: false,
        label: 'Plugin Honey',
      },
    }
    const disabled = {
      ...plugin,
      key: 'plugin:disabled/honey:skill.honey',
      state: 'disabled' as const,
    }

    expect([project, plugin, disabled]
      .filter(isComposerSelectableSkillRow)
      .map(skillMentionInvocationId))
      .toEqual(['honey', 'plugin:greenpt/honey:skill.honey'])
  })
})

describe('SourceInfoPage Tools-section gate (U3b finding 1)', () => {
  // The page shows the MCP Tools section when
  // `isSafeSourceRow(summary) && sourceTypeFor(summary) === 'mcp'`. Before U3b it
  // gated on the raw `summary.sourceType === 'mcp'`, which is UNSET for native
  // `.mcp.json` records (kind:'mcp') and plugin connectors — so those never
  // showed the section despite full backend support.
  const showsTools = (s: SafeCapabilitySummary) => isSafeSourceRow(s) && sourceTypeFor(s) === 'mcp'

  it('shows the Tools section for a native .mcp.json record (kind:mcp, no sourceType)', () => {
    expect(showsTools(capability('mcp-native', 'mcp'))).toBe(true)
  })

  it('shows the Tools section for a plugin connector (kind:mcp, plugin origin)', () => {
    expect(showsTools(capability('mcp-connector', 'mcp', undefined, 'plugin'))).toBe(true)
  })

  it('shows the Tools section for an MCP-transport source (kind:source, sourceType:mcp)', () => {
    expect(showsTools(capability('source-mcp-transport', 'source', 'mcp'))).toBe(true)
  })

  it('does NOT show the Tools section for folder/API sources', () => {
    expect(showsTools(capability('source-api', 'source', 'api'))).toBe(false)
    expect(showsTools(capability('source-local', 'source', 'local'))).toBe(false)
    expect(showsTools(capability('source-default', 'source'))).toBe(false)
  })
})

describe('composer @mention of an MCP slug is a graceful no-op (R3 part C)', () => {
  // Post-C the composer `sources` prop is filtered to folder/API only, so the
  // slug list handed to parseMentions never contains an MCP logical name.
  const composerSources = [
    capability('source-api', 'source', 'api'),
    capability('source-local', 'source', 'local'),
    capability('mcp-native', 'mcp', 'mcp'),
    capability('mcp-connector', 'mcp', 'mcp', 'plugin'),
  ].filter(isComposerSelectableSourceRow)

  const sourceSlugs = composerSources.map(s => s.mention?.id ?? s.logicalName)

  it('does not toggle an MCP source when its slug is @mentioned', () => {
    const mentions = parseMentions('[source:mcp-native] please', [], sourceSlugs)
    expect(mentions.sources).toEqual([])
  })

  it('still toggles a folder/API source that IS selectable', () => {
    const mentions = parseMentions('[source:source-api] please', [], sourceSlugs)
    expect(mentions.sources).toEqual(['source-api'])
  })
})

describe('a built-in dp row yields to a configured server (H2)', () => {
  /**
   * The runtime already gets this right: `mergeBuiltinDpMcpServers` takes the
   * configured map as its LEFT argument and stands the built-in down, so ONE
   * server starts. The list has to agree, or a switch advertises a server that
   * can never run.
   *
   * The collision is on the WIRE name. Keying it on the rendered row name —
   * which is `displayName ?? logicalName` — meant a user who had simply
   * renamed their own `dpJira` got two rows for it, and the second one's
   * switch did nothing. The doc comment on `buildMcpServerRows` said "wire
   * name" the whole time; the code read the display name.
   */
  function mcpSource(logicalName: string, displayName?: string): SafeCapabilitySummary {
    return {
      ...capability(`source:ws-1:${logicalName}`, 'source', 'mcp'),
      logicalName,
      ...(displayName ? { displayName } : {}),
    }
  }

  const builtinView = {
    available: true,
    diagnostics: [],
    servers: [
      { name: 'dpJira', subcommand: 'jira', description: 'Jira', defaultEnabled: false, enabled: false },
      { name: 'dpSage', subcommand: 'sage', description: 'Sage', defaultEnabled: false, enabled: false },
    ],
  }

  it('drops the built-in when the configured server carries a different DISPLAY name', () => {
    const rows = buildMcpServerRows(
      { capabilities: [mcpSource('dpJira', 'My Jira')] },
      builtinView,
    )
    expect(rows.map(row => row.name)).toEqual(['dpSage', 'My Jira'])
    // Mutation probe: key the drop on `row.name` again and 'dpJira' comes back
    // as a third row beside 'My Jira'.
    expect(rows.filter(row => row.originKind === 'builtin').map(row => row.builtinDpName))
      .toEqual(['dpSage'])
  })

  it('still drops it when display and wire name agree, and keeps the rest', () => {
    const rows = buildMcpServerRows({ capabilities: [mcpSource('dpJira')] }, builtinView)
    expect(rows.map(row => row.name)).toEqual(['dpJira', 'dpSage'])
    expect(rows.find(row => row.name === 'dpJira')?.originKind).toBe('user')
  })

  it('a plugin MCP component owns the name too', () => {
    const rows = buildMcpServerRows({
      capabilities: [],
      installedPlugins: [{
        pluginKey: 'mk.j', name: 'J', version: '1.0.0', installedAt: 1,
        capabilityKinds: ['mcp'],
        activation: { global: 'unset', workspace: 'enabled' },
        components: [{ kind: 'mcp', name: 'dpJira', capabilityId: 'mcp.j', enabled: true }],
      }] as unknown as Parameters<typeof buildMcpServerRows>[0]['installedPlugins'],
    }, builtinView)
    expect(rows.map(row => row.name)).toEqual(['dpJira', 'dpSage'])
    expect(rows.find(row => row.name === 'dpJira')?.originKind).toBe('plugin')
  })
})

describe('the organisation managed MCP rows (F1.635)', () => {
  /**
   * F1.593 delivers the organisation's `managedMcpServers` into every session's
   * pool, and the catalog projects them as `origin: 'managed'` summaries (the
   * server-side mirror in `bootstrap/storage-runtime.ts`). The list owes them
   * one READ-ONLY row per server — no toggle route (there is no preference and
   * no capability record a switch could write), and no join with the built-in
   * dp rows, whose switch writes a preference an org server does not have.
   *
   * The name clash is the runtime's own rule: the org entry WINS the wire name
   * (`foldManagedOrgMcpServers`), so a built-in (or its RPC row) under the same
   * name advertises a server that can never start and must yield — but only
   * while the org server is actually delivered: a policy-DENIED org row
   * displaces nothing in the fold, so the built-in keeps its row.
   */
  function managed(key: string, logicalName: string, state: SafeCapabilitySummary['state'] = 'active'): SafeCapabilitySummary {
    return {
      ...capability(key, 'mcp', 'mcp', 'managed'),
      logicalName,
      state,
      ...(state === 'disabled' ? { unavailableReason: 'managed-denied' } : {}),
    }
  }

  const builtinView = {
    available: true,
    diagnostics: [],
    servers: [
      { name: 'dpGitlab', subcommand: 'gitlab', description: 'GitLab', defaultEnabled: false, enabled: true },
      { name: 'dpSage', subcommand: 'sage', description: 'Sage', defaultEnabled: false, enabled: false },
    ],
  }

  it('an org server is one read-only row: no builtinDpName, no toggle route, detail page intact', () => {
    const rows = buildMcpServerRows({ capabilities: [managed('managed:mcp:org-docs', 'org-docs')] })
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row).toMatchObject({
      id: 'managed:mcp:org-docs',
      name: 'org-docs',
      originKind: 'managed',
      capabilityKey: 'managed:mcp:org-docs',
      enabled: true,
    })
    expect(row.builtinDpName).toBeUndefined()
    // `McpServersPanel` computes its toggle from exactly these fields; a row
    // carrying none renders the read-only state text instead.
    expect(row.pluginKey).toBeUndefined()
    expect(row.capabilityId).toBeUndefined()
  })

  it('the org name displaces the built-in on both halves; a sibling built-in keeps its row', () => {
    const rows = buildMcpServerRows({
      capabilities: [
        managed('managed:mcp:dpGitlab', 'dpGitlab'),
        { ...capability('builtin:mcp:dpGitlab', 'mcp', 'mcp', 'builtin'), logicalName: 'dpGitlab' },
        { ...capability('builtin:mcp:dpSage', 'mcp', 'mcp', 'builtin'), logicalName: 'dpSage' },
      ],
    }, builtinView)
    expect(rows.filter(row => row.name === 'dpGitlab')).toHaveLength(1)
    const gitlab = rows.find(row => row.name === 'dpGitlab')!
    expect(gitlab.originKind).toBe('managed')
    // The built-in RPC half must not merge its switch onto the org row either.
    expect(gitlab.builtinDpName).toBeUndefined()
    expect(rows.map(row => row.name)).toContain('dpSage')
  })

  it('a policy-DENIED org row displaces nothing — the built-in it would have displaced keeps its row', () => {
    const rows = buildMcpServerRows({
      capabilities: [
        managed('managed:mcp:dpGitlab', 'dpGitlab', 'disabled'),
        { ...capability('builtin:mcp:dpGitlab', 'mcp', 'mcp', 'builtin'), logicalName: 'dpGitlab' },
      ],
    }, builtinView)
    const gitlabRows = rows.filter(row => row.name === 'dpGitlab')
    expect(gitlabRows.map(row => row.originKind)).toContain('builtin')
    expect(gitlabRows.map(row => row.originKind)).toContain('managed')
  })
})
