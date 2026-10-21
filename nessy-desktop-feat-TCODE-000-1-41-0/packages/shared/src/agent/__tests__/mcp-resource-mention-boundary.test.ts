/**
 * R5 Task 6 — the resource-mention permission boundary, OPTION A (match Claude).
 *
 * An `@server:uri` mention is inserted while building the prompt, so no
 * PreToolUse-equivalent fires and no permission rule covers the resource URI —
 * exactly as Claude documents (it defines a `Read` deny rule for file `@`
 * references and NO rule vocabulary for resource URIs). We deliberately add no
 * resource-URI deny matcher, because:
 *
 *  1. The MODEL-initiated path, `read_mcp_resource`, is `readOnly` / no-permission
 *     by spec (never prompts) but is STILL a named permission target: a
 *     `deny read_mcp_resource` tool rule blocks it in `shouldAllowToolInMode`
 *     before the safe-mode allowance is considered. That tool-name deny is the
 *     admin lever, matching Claude ("a deny rule is the only lever over them").
 *  2. A user typing an `@`-mention is the same trust level as a user typing a
 *     file path or a `[file:...]` mention. A URI-scoped deny rule with the model
 *     path already levered would be surface without a threat.
 *
 * If `read_mcp_resource` were ungated (no rule could reach it) Option B — a
 * resource-scoped deny matcher — would be necessary. This test pins the premise
 * that keeps Option A correct.
 */
import { describe, it, expect } from 'bun:test'
import { SESSION_TOOL_DEFS } from '@nessy-agent/session-tools-core'
import { shouldAllowToolInMode } from '../mode-manager.ts'
import { getPiToolBinding } from '../pi-harness/harness-tool-descriptor.ts'

const RESOURCE_TOOL_NAMES = [
  'read_mcp_resource',
  'list_mcp_resources',
  'mcp__session__read_mcp_resource',
  'mcp__session__list_mcp_resources',
] as const

describe('MCP resource-tool permission boundary (Option A)', () => {
  it('marks both model-facing resource tools readOnly and no-permission (safeMode allow)', () => {
    for (const name of ['read_mcp_resource', 'list_mcp_resources']) {
      const def = SESSION_TOOL_DEFS.find(entry => entry.name === name)
      expect(def, name).toBeDefined()
      expect(def!.readOnly, name).toBe(true)
      expect(def!.safeMode, name).toBe('allow')
    }
  })

  it('allows a model-emitted resource read in safe and ask modes without a prompt', () => {
    for (const toolName of RESOURCE_TOOL_NAMES) {
      const safe = shouldAllowToolInMode(toolName, {}, 'plan')
      expect(safe.allowed, `${toolName} safe`).toBe(true)
      const ask = shouldAllowToolInMode(toolName, {}, 'default')
      expect(ask.allowed, `${toolName} ask`).toBe(true)
      if (ask.allowed) expect(ask.requiresPermission, `${toolName} ask prompt`).toBeFalsy()
    }
  })

  it('keeps read_mcp_resource a named permission target so a tool-name deny is the lever', () => {
    // permissionName === the documented tool name: a `deny read_mcp_resource`
    // rule matches this and blocks the model path (see shouldAllowToolInMode's
    // deny check, which runs before the safe-mode allowance).
    expect(getPiToolBinding('mcp__session__read_mcp_resource').permissionName).toBe('read_mcp_resource')
    expect(getPiToolBinding('mcp__session__list_mcp_resources').permissionName).toBe('list_mcp_resources')
  })
})
