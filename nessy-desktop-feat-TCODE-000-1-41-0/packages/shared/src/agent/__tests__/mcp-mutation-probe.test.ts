/**
 * F1.1050 (DN-272, 2026-09-29) — the MCP MUTATION ORACLE no longer names `explore`.
 *
 * `shouldPromptInAskMode`'s MCP branch (`core/pre-tool-use.ts`) decides whether an
 * `mcp__` call cards in `default`, `acceptEdits` and `auto` by asking the mode gate
 * "would a read-only mode refuse it?". It asked with the literal `explore`, the mode
 * F1.1050 retires. `plan` is not a drop-in probe: its chrome.md branch blocks a
 * state-changing browser command that explore allows, so a naive swap would add a
 * card for every browser click in every asking mode. The probe is now `plan` plus
 * `mutationProbe: true`, which keeps explore's browser verdict.
 *
 * MEASURED before `explore` left the union (the tree of this commit): over 79 calls —
 * every `mcp__session__<name>` in the session-tool registry, eight browser commands
 * (one of them an array batch), fourteen source-MCP spellings and two api_ calls —
 * `explore` and `plan` + `mutationProbe` gave the same `allowed` on all 79, and a
 * plain `plan` differed on five, every one a state-changing browser command. The
 * verdicts are pinned below as that measurement gave them, so they hold after
 * `explore` is gone.
 */
import { describe, expect, it } from 'bun:test'
import { shouldPromptInAskMode, type PermissionManagerLike } from '../core/pre-tool-use.ts'
import { shouldAllowToolInMode } from '../mode-manager.ts'

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}
const context = { workspaceRootPath: '/fixture/dn272-workspace' }

function card(toolName: string, input: Record<string, unknown>): string | null {
  return shouldPromptInAskMode(toolName, input, permissionManager, context)?.promptType ?? null
}

describe('F1.1050 — the MCP mutation probe keeps the verdicts it had under explore', () => {
  it('a state-changing browser command still runs with no card in the asking modes; read-only ones too', () => {
    for (const command of ['click @e1', 'open https://example.com', 'fill @e1 x', 'snapshot', 'screenshot']) {
      expect(card('mcp__session__browser_tool', { command })).toBeNull()
    }
    expect(card('mcp__session__browser_tool', { command: ['snapshot', 'click @e1'] })).toBeNull()
  })

  it('CONTROL: a plain plan probe would refuse the click — the option is what keeps the verdict', () => {
    expect(shouldAllowToolInMode('mcp__session__browser_tool', { command: 'click @e1' }, 'plan').allowed).toBe(false)
    expect(shouldAllowToolInMode('mcp__session__browser_tool', { command: 'click @e1' }, 'plan', { mutationProbe: true }).allowed).toBe(true)
  })

  it('mutating session tools and source-MCP writes still card mcp_mutation; read-only ones do not', () => {
    for (const name of ['plugin_install', 'automation_create', 'source_manage', 'spawn_session', 'send_agent_message', 'CronCreate']) {
      expect(card(`mcp__session__${name}`, {})).toBe('mcp_mutation')
    }
    for (const name of ['mcp__linear__create_issue', 'mcp__slack__post_message', 'mcp__x__delete_thing', 'mcp__x__Write']) {
      expect(card(name, {})).toBe('mcp_mutation')
    }
    expect(card('mcp__x__api_items', { method: 'POST', path: '/items' })).toBe('mcp_mutation')
    expect(card('mcp__x__api_items', { method: 'GET', path: '/items' })).toBeNull()
    expect(card('mcp__session__SubmitPlan', {})).toBeNull()
    expect(card('mcp__x__Read', {})).toBeNull()
  })
})
