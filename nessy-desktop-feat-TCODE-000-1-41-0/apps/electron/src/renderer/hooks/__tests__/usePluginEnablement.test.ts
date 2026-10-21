/**
 * U4 — plugin enablement request contract (pure logic).
 *
 * The Sources management rows and the plugins-subsection rows toggle plugin
 * enablement through the SAME existing marketplace mutation. This test pins the
 * pure request-building the hook feeds that mutation:
 *   - scope-correct targets (workspace vs the CONCRETE active project),
 *   - the enable/disable request shape is byte-identical to what PluginsPage's
 *     actions menu sends (so both flip the same policy record — no new
 *     machinery),
 *   - "project" is unavailable without a project/session context (menu omits it).
 *
 * The repo has no renderHook/DOM lib, so the load-bearing logic is exported
 * pure and tested directly (the established pattern for renderer hooks).
 */

import { describe, expect, it } from 'bun:test'
import { pluginActivationTarget, pluginToggleRequest } from '../usePluginEnablement.ts'
import type { SafeCapabilityContextRef } from '@nessy-agent/shared/protocol/capabilities'

const WS = 'ws-1'
const WORKSPACE_CTX: SafeCapabilityContextRef = { workspaceId: WS }
const SESSION_CTX: SafeCapabilityContextRef = { workspaceId: WS, sessionId: 'sess-1' }

describe('pluginActivationTarget (U4 scope resolution)', () => {
  it('workspace scope → a workspace target', () => {
    expect(pluginActivationTarget('workspace', WS, WORKSPACE_CTX)).toEqual({ kind: 'workspace', workspaceId: WS })
  })

  it('project scope with a session context → a concrete project target carrying that context', () => {
    expect(pluginActivationTarget('project', WS, SESSION_CTX)).toEqual({ kind: 'project', context: SESSION_CTX })
  })

  it('project scope WITHOUT a project/session context → null (menu omits the project item)', () => {
    expect(pluginActivationTarget('project', WS, WORKSPACE_CTX)).toBeNull()
  })

  it('workspace scope with no active workspace → null', () => {
    expect(pluginActivationTarget('workspace', null, WORKSPACE_CTX)).toBeNull()
  })
})

describe('pluginToggleRequest (U4 shared mutation shape)', () => {
  it('enable → the exact enable request the marketplace menu sends', () => {
    const target = pluginActivationTarget('workspace', WS, WORKSPACE_CTX)!
    expect(pluginToggleRequest('pk-1', true, target)).toEqual({
      pluginKey: 'pk-1',
      action: 'enable',
      target: { kind: 'workspace', workspaceId: WS },
    })
  })

  it('disable in the active project → the exact disable request, project-scoped', () => {
    const target = pluginActivationTarget('project', WS, SESSION_CTX)!
    expect(pluginToggleRequest('pk-1', false, target)).toEqual({
      pluginKey: 'pk-1',
      action: 'disable',
      target: { kind: 'project', context: SESSION_CTX },
    })
  })

  it('the request carries no path/command/cache fields (safe contract)', () => {
    const target = pluginActivationTarget('workspace', WS, WORKSPACE_CTX)!
    const json = JSON.stringify(pluginToggleRequest('pk-1', true, target))
    expect(json).not.toMatch(/Root|Path|command|cache|hash/i)
  })
})
