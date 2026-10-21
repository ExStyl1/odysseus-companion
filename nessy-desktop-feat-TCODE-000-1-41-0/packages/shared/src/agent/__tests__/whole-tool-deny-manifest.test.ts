/**
 * R1: a whole-tool deny removes the tool from the ADVERTISED manifest, not
 * only from what the gate admits.
 *
 * permissions.md:82 — "`Bash(*)` is equivalent to `Bash` and matches all Bash
 * commands. As a deny rule, both forms remove the tool from Claude's context."
 * :142 — "A tool matched by a bare-name glob deny rule is removed from
 * Claude's context, the same as a bare tool name". Denying at the gate alone
 * is fail-closed but leaves the schema in context, so the model keeps
 * attempting a tool it can never use and burns a turn on every attempt.
 *
 * The removal rides the manifest's EXISTING allowlist seam (S14's
 * `allowedBindingNames`) — the same one deferred-tool filtering and the
 * `disableWorkflows` / `disableBackgroundTasks` off switches use — so there is
 * one filter, not two, and the decision is carried on the SIGNED manifest.
 * Changing which tools are present never changes any tool's shape, so no
 * `PI_STATIC_MODEL_CONTRACT_HASHES` pin moves.
 */
import { describe, expect, it } from 'bun:test'

import type { EffectiveCapabilitySnapshot } from '../../capabilities/resolver.ts'
import type { AgentRuntimeView } from '../../capabilities/views.ts'
import {
  createPiExecutionManifestSeed,
  finalizePiExecutionManifest,
  type PiDynamicToolDefinition,
} from '../pi-harness/harness-manifest.ts'
// F1.489 (3) — the identity builder is production's own; imported with the filter below.
import { parseClaudeRuleString } from '../pi-harness/claude-permission-rules.ts'
import {
  compilePermissionDslV1,
  evaluatePermissionDslV1,
} from '../pi-harness/permission-dsl.ts'
import { filterCapabilityIdentitiesByWholeToolDenyUnderSessionToolAlias, piManifestCapabilityIdentities } from '../pi-harness/session-tool-rule-alias.ts'
import { canonicalizeForDecision } from '../session-filesystem-scope.ts'

const GENERATION = 'generation-whole-tool-deny'

const view: AgentRuntimeView = {
  generation: GENERATION,
  sources: [],
  skills: [],
  mcpServers: [],
  hooks: [],
  automations: [],
  agents: [],
  promptLayers: [],
  memory: [],
  permissionLayers: [],
  commands: [],
  promptCommands: [],
  apps: [],
}

const snapshot = {
  context: {
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    projectTrustState: 'none',
    projectTrustRevision: '',
  },
  generation: GENERATION,
  leaseId: 'lease-whole-tool-deny',
  entries: [],
  installedPlugins: [],
  diagnostics: [],
} as EffectiveCapabilitySnapshot

const MCP_SERVERS = ['github', 'gitlab'] as const
const capabilityKey = (wireName: string) => `native:workspace:mcp:${wireName}`

const seed = () => ({
  ...createPiExecutionManifestSeed({
    snapshot,
    view,
    sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' },
  }),
  provenance: MCP_SERVERS.map(wireName => ({ capabilityKey: capabilityKey(wireName), generation: GENERATION })),
  mcpSources: MCP_SERVERS.map(wireName => ({ wireName, capabilityKey: capabilityKey(wireName), generation: GENERATION })),
})

function compile(rule: string, action: 'allow' | 'ask' | 'deny' = 'deny') {
  const parsed = parseClaudeRuleString(rule, action)
  if (!parsed.rule) throw new Error(`Rule is inert and cannot be compiled: ${rule}`)
  return compilePermissionDslV1({
    generation: GENERATION,
    projectTrusted: false,
    canonicalizeRoot: canonicalizeForDecision,
    layers: [{
      scope: 'managed',
      sourceDigest: 'whole-tool-deny',
      document: { version: 1, rules: [{ id: 'whole-tool', ...parsed.rule }] },
    }],
  })
}

/**
 * The production derivation `pi-agent.ts:buildExecutionManifestForCurrentTurn`
 * runs: manifest identities in, `allowedBindingNames` out.
 */
function advertised(rule?: string, dynamicTools: readonly PiDynamicToolDefinition[] = []) {
  const manifestSeed = seed()
  // F1.489 (3) (origin WJ-zz P-WJ-zz-3) — the identities come from the SAME
  // function `buildExecutionManifestForCurrentTurn` calls
  // (`pi-harness/session-tool-rule-alias.ts`, `piManifestCapabilityIdentities`),
  // not from a copy of its body, so a change to production's identity build
  // reaches every arm below — and a mutant of it turns this suite red, which a
  // copy could not.
  //
  // One identity per tool, `{ bindingName, piName, semanticId, permissionName }`:
  //  - a static tool reads its binding and its descriptor;
  //  - a dynamic tool reads its known binding, else the binding name stands in
  //    for its piName and permissionName, and its semantic id is `mcp_dynamic`'s.
  //
  // This block spelled the build out line for line until F1.489 (3). It keeps
  // that block's line count, because two docs anchors cite lines of this file
  // further down.
  //
  const identities = piManifestCapabilityIdentities(manifestSeed.staticTools, dynamicTools)
  const allowedBindingNames = rule === undefined
    ? undefined
    : filterCapabilityIdentitiesByWholeToolDenyUnderSessionToolAlias(identities, compile(rule)) // F1.478 — production's call
      .map(identity => identity.bindingName)
  return finalizePiExecutionManifest(manifestSeed, [...dynamicTools], {
    ...(allowedBindingNames ? { allowedBindingNames } : {}),
  })
}

const mcpTool = (wireName: string, toolName: string): PiDynamicToolDefinition => ({
  bindingName: `mcp__${wireName}__${toolName}`,
  description: 'A proxied MCP tool.',
  inputSchema: { type: 'object', properties: {} },
  modelSchemaVersion: 1,
  bindingSchemaVersion: 1,
  provenance: { capabilityKey: capabilityKey(wireName), generation: GENERATION },
})

/** A built-in session tool: `mcp__session__` on the wire, `TodoWrite` to rules. */
const sessionTool = (): PiDynamicToolDefinition => ({
  bindingName: 'mcp__session__TodoWrite',
  description: 'Track the plan for this turn.',
  inputSchema: { type: 'object', properties: {} },
  modelSchemaVersion: 1,
  bindingSchemaVersion: 1,
  provenance: { capabilityKey: 'runtime:pi-session', generation: GENERATION },
})

describe('a whole-tool deny removes the tool from the advertised manifest', () => {
  it('advertises bash with no rule at all', () => {
    expect(advertised().tools.map(tool => tool.binding.piName)).toContain('bash')
  })

  it.each([
    ['a bare canonical name', 'Bash'],
    ['the equivalent Bash(*) form', 'Bash(*)'],
    ['a tool-name glob', 'Bas*'],
  ])('removes bash for %s, and the gate still denies', (_label, rule) => {
    const names = advertised(rule).tools.map(tool => tool.binding.piName)
    expect(names).not.toContain('bash')
    // Both, not either: removal never stands in for enforcement.
    expect(evaluatePermissionDslV1(compile(rule), {
      generation: GENERATION,
      semanticId: 'bash',
      toolName: 'Bash',
      input: { command: 'git status' },
      cwd: '/workspace',
    }).action).toBe('deny')
    // Only the denied tool goes.
    expect(names).toContain('read')
  })

  it('leaves the tool present for a specifier\'d deny', () => {
    expect(advertised('Bash(git *)').tools.map(tool => tool.binding.piName)).toContain('bash')
  })

  it('removes MCP proxy tools by server glob and by exact name, and leaves built-ins', () => {
    const tools = [mcpTool('github', 'get_issue'), mcpTool('gitlab', 'list'), sessionTool()]
    const names = (rule: string) => advertised(rule, tools).tools.map(tool => tool.binding.piName)

    expect(names('mcp__*')).not.toContain('mcp__github__get_issue')
    expect(names('mcp__*')).not.toContain('mcp__gitlab__list')
    // F1.478 — TodoWrite is claude's `mcp__session__TodoWrite` (not pi-only), and the gate now reads that
    // name too, so `mcp__*` removes it here as on claude; a pi-only session tool stays (the arm at the end).
    expect(names('mcp__*')).not.toContain('mcp__session__TodoWrite')

    expect(names('mcp__github__*')).not.toContain('mcp__github__get_issue')
    expect(names('mcp__github__*')).toContain('mcp__gitlab__list')

    expect(names('mcp__github__get_issue')).not.toContain('mcp__github__get_issue')
    expect(names('mcp__github__get_issue')).toContain('mcp__gitlab__list')
  })

  it('moves the manifest hash without touching any tool shape', () => {
    const before = advertised()
    const after = advertised('Bash')
    expect(after.manifestHash).not.toBe(before.manifestHash)
    const shape = (manifest: typeof before) => manifest.tools
      .filter(tool => tool.binding.piName !== 'bash' && tool.binding.piName !== 'bash_background')
      .map(tool => `${tool.binding.piName}:${tool.modelContractHash ?? ''}`)
    expect(shape(after)).toEqual(shape(before))
  })

  it('F1.478 — a claude-spelled deny removes a claude-visible session tool and leaves a pi-only one', () => {
    const handler = (name: string): PiDynamicToolDefinition => ({ ...sessionTool(), bindingName: `mcp__session__${name}` })
    const tools = [handler('spawn_session'), handler('TaskList')]
    const names = (rule: string) => advertised(rule, tools).tools.map(tool => tool.binding.bindingName)
      .filter(name => name.startsWith('mcp__session__'))
    expect({
      exact: names('mcp__session__spawn_session'),
      server: names('mcp__session'),
      everyServer: names('mcp__*'),
      // CONTROL: the Pi spelling, as before F1.478.
      piName: names('spawn_session'),
    }).toEqual({
      exact: ['mcp__session__TaskList'],
      server: ['mcp__session__TaskList'],
      everyServer: ['mcp__session__TaskList'],
      piName: ['mcp__session__TaskList'],
    })
  })
})
