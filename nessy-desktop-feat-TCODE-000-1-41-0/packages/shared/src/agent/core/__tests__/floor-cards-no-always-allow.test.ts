/**
 * F1.982 `[permissions]` — every gate floor's card offers no Always Allow.
 *
 * F1.737 put `noAlwaysAllow` on the protected-path prompt; the other
 * non-negotiable prompts `runPreToolUseChecks` emits kept offering Always Allow on
 * Pi and claude: the removal circuit breaker, the `eval` floor, the unattended
 * automation edit, a `requiresUserInteraction` tool and the gate's own `askRule`
 * (a workspace `toolRules` ask). Each is emitted ahead of the branch that reads
 * the session whitelist, allow rules and remembered approvals, with no
 * `commandHash`/`rememberForMinutes`, so no saved answer ever skips it: the click
 * promised what neither side does. On Pi a `bash`-typed floor card's Always also
 * reached the host's permanent repository `Bash(<key> *)` rule (F1.913's
 * mechanism) — `Always` on `rm -rf ~` granted every later `rm`.
 *
 * The fix is the gate's, one field per return; the claude PreToolUse hook
 * (F1.842) and Pi's card builder (F1.737) already forward it, and the host
 * refuses an Always sent anyway on such a card (F1.888). The worktree floor is
 * not here: the host marks its `worktree_approval` type unrememberable itself.
 *
 * CONTROLS: the ordinary card beside each floor — the same program without the
 * breaker's target, the same automation tool at the ceiling, the same `Write`
 * with no rule — carries no `noAlwaysAllow`, so Always Allow stays offered there.
 *
 * SAFETY: every command here is data handed to the pure gate; nothing runs.
 */
import { afterAll, afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { permissionsConfigCache } from '../../permissions-config.ts'
import { cleanupModeState, initializeModeState } from '../../mode-manager.ts'
import type { PermissionMode } from '../../mode-types.ts'
import { runPreToolUseChecks, type PermissionManagerLike, type PreToolUseInput } from '../pre-tool-use.ts'

// The gate's module graph is the cold-start cost, not the cases.
setDefaultTimeout(120_000)

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

const WS = mkdtempSync(join(tmpdir(), 'f1982-'))
writeFileSync(join(WS, 'permissions.json'), `${JSON.stringify({ toolRules: [{ pattern: 'Write', action: 'ask' }] })}\n`)
writeFileSync(join(WS, 'automations.json'), JSON.stringify({
  version: 2,
  automations: {
    SchedulerTick: [
      { id: 'bypass-auto', name: 'Nightly sweep', cron: '0 3 * * *', permissionMode: 'bypassPermissions', actions: [{ type: 'prompt', prompt: 'old' }] },
      { id: 'narrow-auto', name: 'Tidy', cron: '0 4 * * *', permissionMode: 'acceptEdits', actions: [{ type: 'prompt', prompt: 'old' }] },
    ],
  },
}))
/** The same workspace shape with no `toolRules` — the `askRule` arm's control. */
const WS_NO_RULE = mkdtempSync(join(tmpdir(), 'f1982-norule-'))

const sessionKeys: Array<{ workspaceId: string; sessionId: string }> = []
afterEach(() => { permissionsConfigCache.clear() })
afterAll(() => {
  for (const key of sessionKeys) cleanupModeState(key)
  rmSync(WS, { recursive: true, force: true })
  rmSync(WS_NO_RULE, { recursive: true, force: true })
})

function gate(toolName: string, input: Record<string, unknown>, mode: PermissionMode, overrides: Partial<PreToolUseInput> = {}) {
  const sessionKey = { workspaceId: 'ws-f1982', sessionId: `f1982-${sessionKeys.length}` }
  sessionKeys.push(sessionKey)
  cleanupModeState(sessionKey)
  initializeModeState(sessionKey, mode)
  const workspaceRootPath = overrides.workspaceRootPath ?? WS
  return runPreToolUseChecks({
    toolName, input, sessionId: sessionKey.sessionId, sessionKey, permissionMode: mode, interactive: true,
    workspaceRootPath, workspaceId: sessionKey.workspaceId, workingDirectory: workspaceRootPath,
    activeSourceSlugs: ['srv'], allSourceSlugs: ['srv'], hasSourceActivation: false, permissionManager,
    ...overrides,
  })
}

const rewrite = (automationId: string) => ({ automationId, patch: { actions: [{ type: 'prompt', prompt: 'new' }] } })

/** [floor class, mode, tool, input, extra gate input] — each raises exactly that floor. */
const FLOORS: Array<[string, PermissionMode, string, Record<string, unknown>, Partial<PreToolUseInput>?]> = [
  ['removalCircuitBreaker', 'default', 'Bash', { command: 'rm -rf ~' }],
  ['removalCircuitBreaker', 'bypassPermissions', 'Bash', { command: 'rm -rf /' }],
  ['shellEval', 'default', 'Bash', { command: 'eval "$CMD"' }],
  ['shellEval', 'acceptEdits', 'Bash', { command: 'ls && eval "$X"' }],
  ['unattendedAutomationEdit', 'default', 'mcp__session__automation_update', rewrite('bypass-auto')],
  ['requiresUserInteraction', 'default', 'mcp__srv__grant_access', { user: 'x' }, { interactionRequiredToolNames: ['mcp__srv__grant_access'] }],
  ['requiresUserInteraction', 'bypassPermissions', 'mcp__srv__grant_access', { user: 'x' }, { interactionRequiredToolNames: ['mcp__srv__grant_access'] }],
  ['askRule', 'acceptEdits', 'Write', { file_path: join(WS, 'notes.txt'), content: 'x' }],
  ['askRule', 'default', 'Write', { file_path: join(WS, 'notes.txt'), content: 'x' }],
]

describe('F1.982 — every gate floor card carries noAlwaysAllow (Always Allow hidden)', () => {
  for (const [floor, mode, toolName, input, extra] of FLOORS) {
    it(`${floor} — ${mode}: ${toolName} raises the floor with noAlwaysAllow`, () => {
      const result = gate(toolName, input, mode, extra)
      expect(result.type).toBe('prompt')
      if (result.type !== 'prompt') throw new Error(`expected a prompt, got ${result.type}`)
      expect(result.nonNegotiable).toBe(floor as never)
      expect(result.noAlwaysAllow).toBe(true)
      // Still nothing a click could remember with — the flag says what already was.
      expect(result.commandHash).toBeUndefined()
      expect(result.rememberForMinutes).toBeUndefined()
    })
  }
})

describe('F1.982 — CONTROL: the ordinary card beside each floor keeps its Always Allow', () => {
  const CONTROLS: Array<[string, string, Record<string, unknown>, Partial<PreToolUseInput>?]> = [
    ['a keyed command without the breaker target (UA12.70: `rm` mints no key, so it offers none)', 'Bash', { command: 'npm test' }],
    ['a command with no eval construct', 'Bash', { command: 'npm install left-pad' }],
    ['the same automation tool at the ceiling', 'mcp__session__automation_update', rewrite('narrow-auto')],
    ['the same Write with no toolRules ask', 'Write', { file_path: join(WS_NO_RULE, 'notes.txt'), content: 'x' }, { workspaceRootPath: WS_NO_RULE }],
  ]
  for (const [label, toolName, input, extra] of CONTROLS) {
    it(`default: ${label} is an ordinary card with no noAlwaysAllow`, () => {
      const result = gate(toolName, input, 'default', extra)
      expect(result.type).toBe('prompt')
      if (result.type !== 'prompt') throw new Error(`expected a prompt, got ${result.type}`)
      expect(result.nonNegotiable).toBeUndefined()
      expect(result.noAlwaysAllow).toBeUndefined()
    })
  }
})
