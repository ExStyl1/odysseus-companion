/**
 * F1.1072 (origin DN-261, 2026-09-28) — a user's whole-tool `WebSearch` deny
 * refuses the app's own search tool, `mcp__session__web_search`, wherever it is
 * judged: claude's PreToolUse gate (`claudeReadablePermissionDeny`) and codex's
 * consult both read it through the shared `evaluatePermissionDslUnderSessionToolAlias`.
 *
 * Measured in-process before the fix: `claudeReadablePermissionDeny` for
 * `mcp__session__web_search` under a workspace `deny WebSearch` (and
 * `deny web_search`) answered `undefined` — the call ran — because the request
 * is judged as `mcp__session__web_search` / `mcp_dynamic` and no Pi binding
 * gives it a second name. permissions.md, MCP section: Claude Code "also applies
 * deny rules that name the whole `Bash` or `WebFetch` tool to these Cowork
 * tools", and "Allow rules don't carry over" — so the deny carries and an allow
 * or an ask does not.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { claudeReadablePermissionDeny } from '../claude-readable-permission-deny.ts'
import { runPreToolUseChecks, type PermissionManagerLike } from '../core/pre-tool-use.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'
import type { PermissionMode } from '../mode-types.ts'
import { permissionsConfigCache } from '../permissions-config.ts'
import { evaluatePermissionDslUnderSessionToolAlias } from '../pi-harness/session-tool-rule-alias.ts'

const ROOT = mkdtempSync(join(tmpdir(), 'nessy-f1072-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

let counter = 0
function workspace(...rules: unknown[]): string {
  counter += 1
  const ws = join(ROOT, `ws-${counter}`)
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'permissions.json'), JSON.stringify({ permissionDsl: { version: 1, rules } }))
  return ws
}
const tool = (id: string, action: 'deny' | 'ask' | 'allow', semanticId: string) => ({ id, action, match: { kind: 'tool', semanticId } })
const judge = (ws: string, toolName: string) =>
  claudeReadablePermissionDeny({ toolName, inputs: [{ query: 'nessy release notes' }], cwd: ws, permissionsContext: { workspaceRootPath: ws }, managedPolicy: undefined })

describe('F1.1072 · a whole-tool WebSearch deny refuses the app\'s search tool', () => {
  it('FAILING ARM (claude gate): deny WebSearch, deny web_search or a glob over them refuses mcp__session__web_search, naming the rule', () => {
    for (const semanticId of ['WebSearch', 'web_search', 'Web*']) {
      const verdict = judge(workspace(tool('deny-search', 'deny', semanticId)), 'mcp__session__web_search')
      expect(verdict, semanticId).toMatchObject({ kind: 'deny', ruleId: 'deny-search' })
      expect(verdict?.kind === 'deny' ? verdict.reason : '', semanticId).toContain('`deny-search`')
    }
  })

  it('FAILING ARM (the shared seam, codex\'s consult request shape): the same deny refuses it with no alias', () => {
    const ws = workspace(tool('deny-search', 'deny', 'WebSearch'))
    const program = permissionsConfigCache.getMergedConfig({ workspaceRootPath: ws }).permissionDsl!
    const request = { generation: program.generation, semanticId: 'mcp_dynamic', toolName: 'mcp__session__web_search', input: { query: 'q' }, cwd: ws }
    expect(evaluatePermissionDslUnderSessionToolAlias(program, undefined, request)).toMatchObject({ action: 'deny', match: { ruleId: 'deny-search' } })
  })

  it('BOUNDARY: an allow or an ask of WebSearch does not carry; a deny of another tool refuses nothing; a rule on the stand-in\'s own name still binds', () => {
    expect(judge(workspace(tool('allow-search', 'allow', 'WebSearch')), 'mcp__session__web_search')).toBeUndefined()
    expect(judge(workspace(tool('ask-search', 'ask', 'WebSearch')), 'mcp__session__web_search')).toBeUndefined()
    expect(judge(workspace(tool('deny-fetch', 'deny', 'WebFetch')), 'mcp__session__web_search')).toBeUndefined()
    // The deny reaches the stand-in only: another session tool is untouched.
    expect(judge(workspace(tool('deny-search', 'deny', 'WebSearch')), 'mcp__session__remember')).toBeUndefined()
    const own = workspace({ id: 'ask-own', action: 'ask', match: { kind: 'mcp', server: 'session', tool: 'web_search' } })
    expect(judge(own, 'mcp__session__web_search')).toMatchObject({ kind: 'ask', ruleId: 'ask-own' })
  })
})

/**
 * F1.1175 (origin the do-now adversarial review, 2026-09-29) — the same carry for
 * a deny written in `toolRules`, the per-tool form permissions.md documents
 * beside the readable policy ("`deny` refuses ... applies in every mode"). The
 * host's mode gate reads `toolRules` against the literal tool name, so before
 * the fix `{ pattern: 'WebSearch', action: 'deny' }` refused Claude's own
 * `WebSearch` and Pi's `web_search` (judged as `WebSearch`) but the Claude
 * gateway's `mcp__session__web_search` ran in every mode.
 */
describe('F1.1175 · a toolRules WebSearch deny refuses the app\'s search tool at the mode gate', () => {
  const noCommands: PermissionManagerLike = {
    isCommandWhitelisted: () => false,
    isDangerousCommand: () => false,
    getBaseCommand: command => command.split(/\s+/)[0] || command,
    extractDomainFromNetworkCommand: () => null,
    isDomainWhitelisted: () => false,
  }
  function toolRulesWorkspace(...toolRules: unknown[]): string {
    counter += 1
    const ws = join(ROOT, `tr-${counter}`)
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, 'permissions.json'), JSON.stringify({ toolRules }))
    permissionsConfigCache.invalidateWorkspace(ws)
    return ws
  }
  // The whole gate, as claude's PreToolUse hook asks it.
  const gate = (ws: string, toolName: string, mode: PermissionMode = 'default') => {
    const sessionKey = { workspaceId: 'ws-f1175', sessionId: `f1175-${counter}-${toolName}-${mode}` }
    cleanupModeState(sessionKey)
    initializeModeState(sessionKey, mode)
    try {
      return runPreToolUseChecks({
        toolName, input: { query: 'nessy release notes' }, sessionId: sessionKey.sessionId, sessionKey,
        permissionMode: mode, workspaceRootPath: ws, workspaceId: sessionKey.workspaceId, workingDirectory: ws,
        activeSourceSlugs: [], allSourceSlugs: [],
        hasSourceActivation: false, permissionManager: noCommands,
      }).type
    } finally {
      cleanupModeState(sessionKey)
    }
  }

  it('FAILING ARM: a toolRules deny of WebSearch (or a glob over it) refuses mcp__session__web_search in every mode', () => {
    for (const pattern of ['WebSearch', 'Web*']) {
      const ws = toolRulesWorkspace({ pattern, action: 'deny' })
      for (const mode of ['default', 'dontAsk', 'bypassPermissions'] as const) {
        expect(gate(ws, 'mcp__session__web_search', mode), `${pattern} ${mode}`).toBe('block')
      }
      expect(gate(ws, 'WebSearch'), pattern).toBe('block') // the built-in, unchanged
    }
    // A deny under either name wins over an allow of the stand-in's own name.
    const both = toolRulesWorkspace({ pattern: 'mcp__session__web_search', action: 'allow' }, { pattern: 'WebSearch', action: 'deny' })
    expect(gate(both, 'mcp__session__web_search')).toBe('block')
  })

  it('BOUNDARY: an allow or an ask of WebSearch does not carry, an earlier allow shadows the deny (first match wins), another deny refuses nothing, the stand-in\'s own rule still binds', () => {
    expect(gate(toolRulesWorkspace({ pattern: 'WebSearch', action: 'allow' }), 'mcp__session__web_search')).toBe('allow')
    expect(gate(toolRulesWorkspace({ pattern: 'WebSearch', action: 'ask' }), 'mcp__session__web_search')).toBe('allow')
    const shadowed = toolRulesWorkspace({ pattern: 'WebSearch', action: 'allow' }, { pattern: 'WebSearch', action: 'deny' })
    expect(gate(shadowed, 'mcp__session__web_search')).toBe('allow')
    expect(gate(toolRulesWorkspace({ pattern: 'WebFetch', action: 'deny' }), 'mcp__session__web_search')).toBe('allow')
    expect(gate(toolRulesWorkspace({ pattern: 'WebSearch', action: 'deny' }), 'mcp__session__remember')).not.toBe('block') // it asks as before
    expect(gate(toolRulesWorkspace({ pattern: 'mcp__session__web_search', action: 'ask' }), 'mcp__session__web_search')).toBe('prompt')
  })
})
