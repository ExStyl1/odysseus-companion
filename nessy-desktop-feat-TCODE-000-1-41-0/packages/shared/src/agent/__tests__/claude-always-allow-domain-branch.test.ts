/**
 * F1.1108 (origin DN-076, 2026-09-26) — `ClaudeAgent.respondToPermission`'s curl/wget DOMAIN branch runs
 * for a Bash card only.
 *
 * The branch whitelisted every host of `pending.command` whenever the card's BASE command was `curl` or
 * `wget`, before the per-tool key function ({@link sessionWhitelistKeyForApproval}) is reached — for ANY
 * tool. A whitelisted domain is read by the Bash consult alone (`shouldPromptInAskMode`'s network arm), so
 * a non-Bash card whose `command` happened to start with curl or wget minted a Bash network grant the
 * human never saw. The branch is now keyed on the Bash tool; any other card goes to the per-tool key.
 *
 * The row's other half was MEASURED and does not land (BK-10, 2026-10-09, `work/bk-10/f1108-probe.ts`,
 * the real gate and PermissionManager): the key a plan-mode browser card's Always Allow stores
 * (`mcp__session__browser_tool`) changes no later browser verdict — `evaluate` is allowed in default,
 * acceptEdits and auto with or without it, still asks in plan and is refused in dontAsk.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ClaudeAgent } from '../claude-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

const agents: ClaudeAgent[] = []
afterEach(() => { for (const agent of agents.splice(0)) agent.destroy() })

function clickAlwaysAllow(toolName: string, command: string): { commands: string[]; domains: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'f1108-agent-'))
  const agent = new ClaudeAgent({
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-f1108', name: 'F1108', rootPath: root,
      workspaceRootPath: root, sessionRootPath: join(root, 'sessions'),
    } as never,
    session: { id: 'sess-f1108', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: root } as never,
  } as BackendConfig)
  agents.push(agent)
  const internals = agent as unknown as {
    respondToPermission: (requestId: string, allowed: boolean, alwaysAllow?: boolean) => void
    pendingPermissions: Map<string, Record<string, unknown>>
    permissionManager: { getWhitelistedCommands: () => Set<string>; getWhitelistedDomains: () => Set<string>; getBaseCommand: (command: string) => string }
  }
  internals.pendingPermissions.set('perm-f1108', {
    resolve: () => {},
    toolName,
    command,
    baseCommand: internals.permissionManager.getBaseCommand(command),
  })
  internals.respondToPermission('perm-f1108', true, true)
  return { commands: [...internals.permissionManager.getWhitelistedCommands()], domains: [...internals.permissionManager.getWhitelistedDomains()] }
}

describe('F1.1108 — the curl/wget domain branch of Always Allow is the Bash card\'s only', () => {
  it('a non-Bash card whose command starts with curl or wget whitelists no domain', () => {
    for (const tool of ['Monitor', 'mcp__session__browser_tool', 'SomeFutureTool']) {
      for (const command of ['curl https://f1108.example/a', 'wget https://f1108.example/b']) {
        expect({ tool, command, domains: clickAlwaysAllow(tool, command).domains }).toEqual({ tool, command, domains: [] })
      }
    }
  })

  it('CONTROL — a Bash curl or wget card still whitelists its domain, and stores no command key', () => {
    expect(clickAlwaysAllow('Bash', 'curl https://f1108.example/a')).toEqual({ commands: [], domains: ['f1108.example'] })
    expect(clickAlwaysAllow('Bash', 'wget https://f1108.example/b').domains).toEqual(['f1108.example'])
  })
})
