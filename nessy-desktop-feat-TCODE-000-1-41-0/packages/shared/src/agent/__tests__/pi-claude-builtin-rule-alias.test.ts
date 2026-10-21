/**
 * F1.1111 (origin DN-078, the Pi mirror of F1.833) — a rule written with CLAUDE's name for a tool binds Pi's tool of
 * another name, for the pairs this fork already records as the same tool (`PI_RUNTIME_AGENT_TOOL_ALIASES`,
 * `pi-harness/runtime-agent-definition.ts`, the table imported agents' tool lists resolve through): `Glob` → `find`,
 * `Agent` → `subagent`, `AskUserQuestion` → `ask_user`, `ToolSearch` → `mcp__tool_search` and `mcp__tool_load` (its two
 * halves: tools-reference.md "Searches for and loads deferred tools"), `ListMcpResourcesTool` / `ReadMcpResourceTool` →
 * the pi-only session resource tools. Judged in PiAgent's gate and in the manifest's whole-tool-deny filter through the
 * one alias seam (`piSessionToolRuleAlias`), so the model is never shown a tool the gate refuses.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { EffectiveCapabilitySnapshot } from '../../capabilities/resolver.ts'
import type { AgentRuntimeView } from '../../capabilities/views.ts'
import { permissionsConfigCache } from '../permissions-config.ts'
import { createPiExecutionManifestSeed, finalizePiExecutionManifest } from '../pi-harness/harness-manifest.ts'
import { getPiToolBindingByBindingName } from '../pi-harness/harness-tool-descriptor.ts'
import {
  evaluatePermissionDslUnderSessionToolAlias,
  filterCapabilityIdentitiesByWholeToolDenyUnderSessionToolAlias,
  piManifestCapabilityIdentities,
  piSessionToolRuleAlias,
} from '../pi-harness/session-tool-rule-alias.ts'

const ROOT = mkdtempSync(join(tmpdir(), 'nessy-f1111-'))
afterAll(() => {
  permissionsConfigCache.clear()
  rmSync(ROOT, { recursive: true, force: true })
})

let counter = 0
function program(action: 'deny' | 'ask' | 'allow', semanticId: string) {
  counter += 1
  const ws = join(ROOT, `ws-${counter}`)
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'permissions.json'), JSON.stringify({ permissionDsl: { version: 1, rules: [{ id: `r-${counter}`, action, match: { kind: 'tool', semanticId } }] } }))
  return { ws, program: permissionsConfigCache.getMergedConfig({ workspaceRootPath: ws }).permissionDsl! }
}

/** PiAgent's gate call for one Pi tool, as `handlePreToolUseRequest` makes it. */
function verdict(rule: { action: 'deny' | 'ask' | 'allow'; semanticId: string }, bindingName: string): string {
  const { ws, program: compiled } = program(rule.action, rule.semanticId)
  const binding = getPiToolBindingByBindingName(bindingName)!
  return evaluatePermissionDslUnderSessionToolAlias(compiled, piSessionToolRuleAlias(binding), {
    generation: compiled.generation, semanticId: binding.descriptorId, toolName: binding.permissionName, input: {}, cwd: ws,
  }).action ?? 'none'
}

describe('F1.1111: a claude-named rule binds Pi\'s same tool of another name', () => {
  it('a whole-tool deny under the claude name refuses the Pi tool', () => {
    expect({
      glob: verdict({ action: 'deny', semanticId: 'Glob' }, 'find'),
      agent: verdict({ action: 'deny', semanticId: 'Agent' }, 'subagent'),
      askUser: verdict({ action: 'deny', semanticId: 'AskUserQuestion' }, 'ask_user'),
      toolSearch: verdict({ action: 'deny', semanticId: 'ToolSearch' }, 'mcp__tool_search'),
      toolLoad: verdict({ action: 'deny', semanticId: 'ToolSearch' }, 'mcp__tool_load'),
      listResources: verdict({ action: 'deny', semanticId: 'ListMcpResourcesTool' }, 'mcp__session__list_mcp_resources'),
      readResource: verdict({ action: 'deny', semanticId: 'ReadMcpResourceTool' }, 'mcp__session__read_mcp_resource'),
    }).toEqual({
      glob: 'deny', agent: 'deny', askUser: 'deny', toolSearch: 'deny', toolLoad: 'deny', listResources: 'deny', readResource: 'deny',
    })
  })

  it('an ask under the claude name asks too (the alias is the same subject, F1.379\'s order)', () => {
    expect(verdict({ action: 'ask', semanticId: 'Glob' }, 'find')).toBe('ask')
  })

  it('the manifest drops the Pi tool under a claude-named whole-tool deny, so the model never sees it', () => {
    const { program: compiled } = program('deny', 'Glob')
    const identity = (bindingName: string) => {
      const binding = getPiToolBindingByBindingName(bindingName)!
      return { piName: binding.piName, bindingName: binding.bindingName, permissionName: binding.permissionName, semanticId: binding.descriptorId }
    }
    expect(filterCapabilityIdentitiesByWholeToolDenyUnderSessionToolAlias([identity('find'), identity('grep')], compiled)
      .map(kept => kept.bindingName)).toEqual(['grep'])
  })

  it('CONTROL: another claude tool\'s rule, the legacy `Task` (also the name of Pi\'s own task-graph tool) and Pi\'s own name behave as before', () => {
    expect({
      grepRuleOnFind: verdict({ action: 'deny', semanticId: 'Grep' }, 'find'),
      taskRuleOnSubagent: verdict({ action: 'deny', semanticId: 'Task' }, 'subagent'),
      piNameStillBinds: verdict({ action: 'deny', semanticId: 'find' }, 'find'),
      lspUnaliased: verdict({ action: 'deny', semanticId: 'LSP' }, 'lsp'),
    }).toEqual({ grepRuleOnFind: 'none', taskRuleOnSubagent: 'none', piNameStillBinds: 'deny', lspUnaliased: 'none' })
  })
})

/**
 * UB12.9 (born 2026-10-16 from the controller review, w2-bk6-7-correctness finding 1) — F1.1111 binds `ToolSearch` to
 * BOTH halves of Pi's loader, so a whole-tool `deny ToolSearch` takes `mcp__tool_search` and `mcp__tool_load` out of the
 * manifest. Deferral used to stay on regardless, hiding every candidate behind a loader the session no longer has.
 * mcp.md, section "Configure tool search", gives `{"permissions":{"deny":["ToolSearch"]}}` as the way to "disable the
 * `ToolSearch` tool specifically", beside the switch that loads every MCP tool upfront — so a session without its loader
 * loads its tools upfront. Driven through PiAgent's own composition (pi-agent.ts, the manifest build): capability
 * identities, the whole-tool deny filter, then the finalizer with deferral preferred on.
 */
describe('UB12.9: a denied loader turns deferral off, so no tool hides behind a loader the session lacks', () => {
  const view: AgentRuntimeView = {
    generation: 'gen-ub129', sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [],
    memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
  }
  const snapshot = {
    context: { workspaceId: 'w', sessionId: 's', projectTrustState: 'none', projectTrustRevision: '' },
    generation: view.generation, leaseId: 'l', entries: [], installedPlugins: [], diagnostics: [],
  } as EffectiveCapabilitySnapshot
  const capabilityKey = 'native:workspace:mcp:github'
  const seed = () => ({
    ...createPiExecutionManifestSeed({ snapshot, view, sessionKey: { workspaceId: 'w', sessionId: 's' } }),
    provenance: [{ capabilityKey, generation: view.generation }],
    mcpSources: [{ wireName: 'github', capabilityKey, generation: view.generation }],
  })
  const mcpTools = Array.from({ length: 60 }, (_, index) => ({
    bindingName: `mcp__github__tool_${index}`, description: `Tool ${index}`, inputSchema: { type: 'object' },
    modelSchemaVersion: 1, bindingSchemaVersion: 1, provenance: { capabilityKey, generation: view.generation },
  }))

  /** One session's manifest under one permissions document, composed as PiAgent composes it. */
  function manifestUnder(document: unknown, options: { hasUncachedMcpSource?: boolean } = {}) {
    counter += 1
    const ws = join(ROOT, `ws-${counter}`)
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, 'permissions.json'), JSON.stringify(document))
    const compiled = permissionsConfigCache.getMergedConfig({ workspaceRootPath: ws }).permissionDsl!
    const s = seed()
    const allowedBindingNames = filterCapabilityIdentitiesByWholeToolDenyUnderSessionToolAlias(
      piManifestCapabilityIdentities(s.staticTools, mcpTools), compiled,
    ).map(identity => identity.bindingName)
    const manifest = finalizePiExecutionManifest(s, mcpTools, { deferredMcpEnabled: true, allowedBindingNames, ...options })
    const names = new Set(manifest.tools.map(tool => tool.binding.piName))
    const hidden = new Set(manifest.deferredMcp.candidatePiNames)
    return {
      deferred: manifest.deferredMcp.enabled,
      loader: ['mcp__tool_search', 'mcp__tool_load'].filter(name => names.has(name)),
      // A candidate stays in the signed manifest and the subprocess hides it until the loader loads it, so "upfront"
      // is "in the manifest AND not a candidate".
      mcpUpfront: mcpTools.filter(tool => names.has(tool.bindingName) && !hidden.has(tool.bindingName)).length,
      mcpHidden: mcpTools.filter(tool => hidden.has(tool.bindingName)).length,
    }
  }

  it('Claude\'s documented `deny ToolSearch` (a Claude settings document) loads every MCP tool upfront', () => {
    expect(manifestUnder({ permissions: { deny: ['ToolSearch'] } }))
      .toEqual({ deferred: false, loader: [], mcpUpfront: 60, mcpHidden: 0 })
  })

  it('Pi\'s own spelling of one half (`deny mcp__tool_load`) does the same: search without load reaches nothing', () => {
    expect(manifestUnder({ permissions: { deny: ['mcp__tool_load'] } }))
      .toEqual({ deferred: false, loader: [], mcpUpfront: 60, mcpHidden: 0 })
  })

  it('BOUNDARY: the uncached-source floor cannot re-arm deferral without its loader', () => {
    expect(manifestUnder({ permissions: { deny: ['ToolSearch'] } }, { hasUncachedMcpSource: true }))
      .toEqual({ deferred: false, loader: [], mcpUpfront: 60, mcpHidden: 0 })
  })

  it('CONTROL: with no loader rule (or a rule on another tool) deferral stays on and the loader pair stays', () => {
    const expected = { deferred: true, loader: ['mcp__tool_search', 'mcp__tool_load'], mcpUpfront: 0, mcpHidden: 60 }
    expect(manifestUnder({ permissions: { deny: [] } })).toEqual(expected)
    expect(manifestUnder({ permissions: { deny: ['Glob'] } })).toEqual(expected)
  })
})
