/**
 * F1.144 (origin SIT-10 P-SIT10-7) — does `bypassPermissions` cover the
 * deferred-tool plumbing (`mcp__tool_search` / `mcp__tool_load`)?
 *
 * ## The decision (controller, 2026-09-23, under the owner's delegation)
 *
 * **Bypass covers it.** `mcp__tool_load` loads a schema into the next request;
 * `permission-modes.md#skip-all-checks-with-bypasspermissions-mode`:
 * "`bypassPermissions` mode disables permission prompts and safety checks so
 * tool calls execute immediately" — the plumbing is a tool call like any other
 * and gets no card of its own there. The card that then STAYED for
 * `mcp__tool_load` in `default`/`acceptEdits`/`auto` is gone since F1.997 (owner,
 * 2026-09-26, aligned with Claude's own `ToolSearch`, Permission required "No"):
 * both plumbing tools pass those modes by named rules
 * (`deferred-tool-discovery-default.test.ts`). So the bypass arm below no longer
 * discriminates for the plumbing; the REAL-mutation control is the arm that still
 * proves bypass passes a call the asking modes card.
 *
 * ## What the gate answers — the row's premise does NOT reproduce here
 *
 * Measured 2026-09-23 on `runPreToolUseChecks` itself, the one gate Pi's
 * `handlePreToolUseRequest` calls with the session's mode-state: in
 * `bypassPermissions` both discovery tools answer `allow`, and in `default`,
 * `acceptEdits` and `auto` both answer an `mcp_mutation` prompt. So the decided
 * posture is ALREADY the gate's behaviour, and there is no failing arm to write
 * against it; the arms below PIN it, with a recorded mutant (the bypass mode
 * admitted to the interactive-prompt branch) turning the bypass arm red, so the
 * pin is proven able to fail.
 *
 * The SIT-10 reading — `permissionMode: "bypassPermissions"` and
 * `awaitingApprovalCount: 1` in the same second — was taken off the SESSION
 * record, while this gate reads the MODE-STATE singleton
 * (`getPermissionModeDiagnostics`). The two are reconciled by
 * `SessionManager.setSessionPermissionMode`, whose own "Permission mode drift
 * detected" warning exists because they can disagree. That is the surviving
 * hypothesis for the live card and it is handed back as its own row with its
 * instrument, not decided here.
 */
import { afterEach, describe, expect, it } from 'bun:test'

import { runPreToolUseChecks, type PermissionManagerLike } from '../core/pre-tool-use.ts'
import type { PermissionMode } from '../mode-types.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'

const KEY = { workspaceId: 'ws-f1144', sessionId: 'session-f1144' }
const ROOT = '/tmp/nessy-f1144-workspace'

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

afterEach(() => { cleanupModeState(KEY) })

/** The gate as Pi calls it; the mode is read from the mode-state singleton, so it is seeded per call. */
function verdict(toolName: string, input: Record<string, unknown>, mode: PermissionMode, activeSourceSlugs: string[] = []) {
  cleanupModeState(KEY)
  initializeModeState(KEY, mode)
  const result = runPreToolUseChecks({
    toolName,
    input,
    sessionId: KEY.sessionId,
    sessionKey: KEY,
    permissionMode: mode,
    workspaceRootPath: ROOT,
    workspaceId: KEY.workspaceId,
    workingDirectory: ROOT,
    activeSourceSlugs,
    allSourceSlugs: activeSourceSlugs,
    hasSourceActivation: false,
    permissionManager,
  })
  // Read into locals before asserting a shape (the toMatchObject mutation trap).
  return result.type === 'prompt' ? `prompt:${result.promptType}` : result.type
}

const LOAD = ['mcp__tool_load', { names: ['automation_create'] }] as const
const SEARCH = ['mcp__tool_search', { query: 'automation' }] as const

describe('F1.144 · bypassPermissions covers the deferred-tool plumbing', () => {
  it('bypassPermissions: neither discovery tool raises a card', () => {
    expect({
      load: verdict(LOAD[0], { ...LOAD[1] }, 'bypassPermissions'),
      search: verdict(SEARCH[0], { ...SEARCH[1] }, 'bypassPermissions'),
    }).toEqual({ load: 'allow', search: 'allow' })
  })

  it('F1.997: default, acceptEdits and auto no longer ask for mcp__tool_load (the card this row kept is gone)', () => {
    const modes = ['default', 'acceptEdits', 'auto'] as const
    expect(Object.fromEntries(modes.map(mode => [mode, verdict(LOAD[0], { ...LOAD[1] }, mode)])))
      .toEqual({ default: 'allow', acceptEdits: 'allow', auto: 'allow' })
  })

  it('CONTROL: a REAL MCP mutation is unchanged — allowed in bypass, asked in default', () => {
    const call = ['mcp__linear__create_issue', { title: 'x' }] as const
    expect({
      bypassPermissions: verdict(call[0], { ...call[1] }, 'bypassPermissions', ['linear']),
      default: verdict(call[0], { ...call[1] }, 'default', ['linear']),
    }).toEqual({ bypassPermissions: 'allow', default: 'prompt:mcp_mutation' })
  })
})
