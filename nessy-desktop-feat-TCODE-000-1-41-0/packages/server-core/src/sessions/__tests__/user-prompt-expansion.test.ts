/**
 * R73 · the two host-owned hook producers this unit added, plus the id parser
 * the expansion one reads.
 *
 * - `UserPromptExpansion` (hooks.md#userpromptexpansion): "Runs when a
 *   user-typed command expands into a prompt before reaching Claude […] Matches
 *   on `command_name`", carrying `expansion_type`, `command_name`,
 *   `command_args`, `command_source` and the original `prompt`.
 *   `decision: "block"` "prevents the command from expanding".
 * - `ConfigChange` (hooks.md#configchange): fires per settings-file change with
 *   `source` + `file_path`, blocks the change — except that
 *   "`policy_settings` changes can't be blocked […] any blocking decision is
 *   ignored."
 *
 * Both are driven off `SessionManager.prototype` with a hand-built `this`, and
 * D1.242 leaves this file as its deliberate exception — the sibling it once named
 * as the same shape takes the real constructor since 2026-09-18: the methods read
 * exactly two things off the instance, and a real one would test the harness.
 */
import { describe, expect, test } from 'bun:test'

import { SessionManager } from '../SessionManager.ts'
import { describeCustomSlashCommandId } from '../custom-command-expansion.ts'

type Captured = { event: string; input: Record<string, unknown> }

function managerWithSessions(
  sessions: Array<{
    id: string
    workspaceId: string
    respond?: (event: string, input: Record<string, unknown>) => unknown
    hasMatchers?: boolean
  }>,
): { manager: any; captured: Captured[] } {
  const captured: Captured[] = []
  const manager = Object.create(SessionManager.prototype) as any
  const map = new Map<string, unknown>()
  for (const session of sessions) {
    const managed = {
      id: session.id,
      workspace: { id: session.workspaceId },
      agentAutomationSystem: session.respond === undefined ? undefined : {
        executeAgentEvent: async (event: string, input: Record<string, unknown>) => {
          captured.push({ event, input })
          return session.respond!(event, input)
        },
        ...(session.hasMatchers === undefined ? {} : {
          hasAgentEventMatchers: () => session.hasMatchers,
        }),
      },
    }
    map.set(session.id, managed)
  }
  manager.sessions = map
  manager.getManaged = (sessionId: string) => map.get(sessionId)
  return { manager, captured }
}

describe('describeCustomSlashCommandId', () => {
  test('derives expansion_type, command_name and command_source from every id shape', () => {
    expect(describeCustomSlashCommandId('custom:deploy'))
      .toEqual({ expansionType: 'slash_command', commandName: 'deploy', commandSource: 'nessy-agent' })
    expect(describeCustomSlashCommandId('custom:skill:review'))
      .toEqual({ expansionType: 'slash_command', commandName: 'review', commandSource: 'skill' })
    expect(describeCustomSlashCommandId('custom:workflow:nightly'))
      .toEqual({ expansionType: 'slash_command', commandName: 'nightly', commandSource: 'workflow' })
    // `pluginKey` is `<base64url>.<base64url>` — colon-free by construction, so
    // the FIRST colon after the marker always ends it and a namespaced logical
    // name survives whole.
    expect(describeCustomSlashCommandId('custom:plugin:bWt0.cGx1Zw:review:security'))
      .toEqual({ expansionType: 'slash_command', commandName: 'review:security', commandSource: 'plugin' })
    // `plugin-workflow:` must be tested BEFORE `plugin:` — the shorter test
    // first would classify this as a prompt command named `-workflow:…`.
    expect(describeCustomSlashCommandId('custom:plugin-workflow:bWt0.cGx1Zw:ship'))
      .toEqual({ expansionType: 'slash_command', commandName: 'ship', commandSource: 'workflow' })
    // hooks.md: "`mcp_prompt` for MCP server prompts".
    expect(describeCustomSlashCommandId('custom:mcp:linear:triage'))
      .toEqual({ expansionType: 'mcp_prompt', commandName: 'triage', commandSource: 'mcp' })
  })
})

describe('SessionManager.emitUserPromptExpansion', () => {
  const key = { sessionId: 's1', workspaceId: 'w1' }
  const input = {
    hook_event_name: 'UserPromptExpansion',
    expansion_type: 'slash_command' as const,
    command_name: 'deploy',
    command_args: 'staging',
    command_source: 'nessy-agent',
    prompt: '/deploy staging',
  }

  test('returns the block reason so the caller can refuse before resolution', async () => {
    const { manager, captured } = managerWithSessions([{
      id: 's1',
      workspaceId: 'w1',
      respond: () => ({ matchedCount: 1, decision: { decision: 'block', reason: 'approval file missing' } }),
    }])
    expect(await manager.emitUserPromptExpansion(key, input)).toEqual({ blocked: 'approval file missing' })
    expect(captured).toEqual([{ event: 'UserPromptExpansion', input }])
  })

  test('carries additionalContext through, and is silent on a plain allow', async () => {
    const allow = managerWithSessions([{ id: 's1', workspaceId: 'w1', respond: () => ({ matchedCount: 0 }) }])
    expect(await allow.manager.emitUserPromptExpansion(key, input)).toEqual({})

    const context = managerWithSessions([{
      id: 's1',
      workspaceId: 'w1',
      respond: () => ({ matchedCount: 1, decision: { additionalContext: '  team review checklist  ' } }),
    }])
    expect(await context.manager.emitUserPromptExpansion(key, input))
      .toEqual({ additionalContext: 'team review checklist' })
  })

  test('fails OPEN on a throwing hook and on a session with no automation authority', async () => {
    const throwing = managerWithSessions([{
      id: 's1',
      workspaceId: 'w1',
      respond: () => { throw new Error('hook exploded') },
    }])
    expect(await throwing.manager.emitUserPromptExpansion(key, input)).toEqual({})

    // The recorded lazy-agent gap: no `agentAutomationSystem` yet means no hook
    // authority, and the command must still run rather than being refused.
    const cold = managerWithSessions([{ id: 's1', workspaceId: 'w1' }])
    expect(await cold.manager.emitUserPromptExpansion(key, input)).toEqual({})
  })
})

describe('SessionManager.runConfigChangeHooks', () => {
  const path = '/w/workspace/hooks.json'

  test('fans out over the live sessions of the workspace only, and answers true when nothing blocks', async () => {
    const { manager, captured } = managerWithSessions([
      { id: 's1', workspaceId: 'w1', respond: () => ({ matchedCount: 1 }) },
      { id: 's2', workspaceId: 'w1', respond: () => ({ matchedCount: 0 }) },
      { id: 'other', workspaceId: 'w2', respond: () => ({ matchedCount: 1 }) },
    ])
    await expect(manager.runConfigChangeHooks('w1', 'project_settings', path)).resolves.toBe(true)
    expect(captured).toHaveLength(2)
    expect(captured[0]!.input).toEqual({
      hook_event_name: 'ConfigChange',
      lifecycle_version: 1,
      source: 'project_settings',
      file_path: path,
    })
  })

  test('answers false when any session blocks, and honours the policy_settings carve-out', async () => {
    const blocking = () => ({ matchedCount: 1, decision: { decision: 'block', reason: 'admin approval required' } })
    const blocked = managerWithSessions([
      { id: 's1', workspaceId: 'w1', respond: () => ({ matchedCount: 0 }) },
      { id: 's2', workspaceId: 'w1', respond: blocking },
    ])
    await expect(blocked.manager.runConfigChangeHooks('w1', 'project_settings', path)).resolves.toBe(false)

    // "`policy_settings` changes can't be blocked. Hooks still fire […] but any
    // blocking decision is ignored. This ensures enterprise-managed settings
    // always take effect."
    const policy = managerWithSessions([{ id: 's1', workspaceId: 'w1', respond: blocking }])
    await expect(policy.manager.runConfigChangeHooks('w1', 'policy_settings', path)).resolves.toBe(true)
    expect(policy.captured).toHaveLength(1)
  })

  test('answers a synchronous true when no session can run the hook', async () => {
    // This is what keeps `ConfigWatcher.applySettingsChange` on its original
    // synchronous tick for every user with no ConfigChange hook.
    const cold = managerWithSessions([{ id: 's1', workspaceId: 'w1' }])
    expect(cold.manager.runConfigChangeHooks('w1', 'user_settings', path)).toBe(true)

    const noMatchers = managerWithSessions([{
      id: 's1', workspaceId: 'w1', hasMatchers: false, respond: () => ({ matchedCount: 0 }),
    }])
    expect(noMatchers.manager.runConfigChangeHooks('w1', 'user_settings', path)).toBe(true)
    expect(noMatchers.captured).toEqual([])
  })

  test('a hook that rejects does not block the change', async () => {
    const rejecting = managerWithSessions([{
      id: 's1', workspaceId: 'w1', respond: () => { throw new Error('hook exploded') },
    }])
    await expect(rejecting.manager.runConfigChangeHooks('w1', 'user_settings', path)).resolves.toBe(true)
  })
})
