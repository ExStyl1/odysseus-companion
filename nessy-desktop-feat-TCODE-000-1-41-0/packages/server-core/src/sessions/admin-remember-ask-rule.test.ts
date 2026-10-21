/**
 * F1.869 (origin WJ-crit-tt P-1) — F1.860's twin on the PRIVILEGED-INSTALL card.
 *
 * ## What was measured first (WJ-crit-xx, 2026-09-25, HEAD `123de1bcd`)
 *
 * End to end, the REAL ClaudeAgent PreToolUse hook (the SDK `query` the only
 * double) into the REAL `SessionManager.handleAgentPermissionRequest` /
 * `respondToPermission`, with the workspace rule
 * `{ id: 'ask-brew', action: 'ask', match: { kind: 'bash', executable: 'brew' } }`,
 * each first card answered the way `ChatDisplay.tsx`'s admin branch answers a
 * ticked "remember this exact command" box — `(sid, rid, true, false,
 * { rememberForMinutes })`, the card's own value or the `?? 10` it sent then (gone since F1.885):
 *
 * - `brew install --cask x` and `brew upgrade --cask x` in `default`, `auto` and
 *   `acceptEdits`: the first card is `admin_approval` in F1.860's ask-rule shape
 *   (it names `ask-brew`, carries NO `rememberForMinutes` and no gate
 *   `commandHash`) — and the SECOND identical command ran with NO CARD. The
 *   admin branch mints the broker's own `commandHash` for every admin card and
 *   `respondToPermission` read the remember lifetime from the renderer's answer
 *   alone, so the ticked box stored a ten-minute window the ask rule never saw.
 * - `bypassPermissions` + `ask-brew`: a `bash` card both times (no remember), and
 *   with no rule no card at all — unchanged, and not this row.
 * - No rule, `default`: the admin card carries `rememberForMinutes: 10` and the
 *   second call runs with no card — the documented remember window (the control).
 *
 * ## The fix this file pins (`SessionManager`, the admin branch, by symbol)
 *
 * An admin card offers a remember window only when its PRODUCER named one
 * (`adminCardRememberWindowOffered`): the gate's three privileged shapes always
 * do (`classifyAdminApproval`), and F1.860's ask-rule card deliberately does
 * not. Such a card neither stores a window from the answer nor is answered by a
 * window an earlier no-rule card stored.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { createManagedSession } from './SessionManager.ts'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

type Manager = ReturnType<typeof createTestSessionManager>
type AgentAnswer = { requestId: string; allowed: boolean; alwaysAllow?: boolean }
type Internals = {
  handleAgentPermissionRequest(managed: unknown, request: Record<string, unknown>): void
  adminRememberApprovals: Map<string, { expiresAt: number }>
}

const COMMAND = 'brew install --cask f1869-app'

/** The card the gate raises with NO rule (`classifyAdminApproval`, as the probe read it). */
const NO_RULE_CARD = {
  toolName: 'Bash',
  command: COMMAND,
  type: 'admin_approval',
  description: 'Admin approval required for cask install: f1869-app',
  appName: 'F1869 App',
  reason: 'Homebrew needs admin access to complete post-install steps.',
  impact: 'May install files in /Applications and system-managed directories.',
  requiresSystemPrompt: true,
  rememberForMinutes: 10,
  commandHash: 'gate-hash-f1869',
  approvalTtlSeconds: 120,
  modePrompt: true,
  origin: 'host_gate',
} as const

/** The same card under a readable ask rule — F1.860's shape, byte for byte what the probe read. */
const ASK_RULE_CARD = (() => {
  const { rememberForMinutes: _minutes, commandHash: _hash, modePrompt: _mode, ...card } = NO_RULE_CARD
  return { ...card, description: 'Bash requires approval by readable permission policy rule `ask-brew` (workspace scope).' }
})()

describe('F1.869 · an admin card that names no remember window is never remembered', () => {
  let root: string
  let sm: Manager
  let events: SessionEvent[]
  let answers: AgentAnswer[]
  let managed: { id: string; workspace: { id: string }; agent: unknown }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'f1869-admin-remember-'))
    sm = createTestSessionManager()
    events = []
    answers = []
    sm.setEventSink(((...args: unknown[]) => { events.push(args[2] as SessionEvent) }) as Parameters<Manager['setEventSink']>[0])
    managed = createManagedSession(
      { id: 'session_f1869', name: 'F1.869' },
      { id: 'ws_f1869', name: 'F1.869', rootPath: root, createdAt: Date.now() } as never,
      { messagesLoaded: true },
    ) as unknown as typeof managed
    managed.agent = { respondToPermission: (requestId: string, allowed: boolean, alwaysAllow?: boolean) => { answers.push({ requestId, allowed, alwaysAllow }) } }
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(`${managed.workspace.id}:${managed.id}`, managed)
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  const internals = () => sm as unknown as Internals
  const cards = () => events.filter(event => event.type === 'permission_request')
  const raise = (requestId: string, card: Record<string, unknown>) => internals().handleAgentPermissionRequest(managed, { ...card, requestId })
  /** An admin answer with the box ticked: the card's value, or `?? 10` — the renderer's default before F1.885, kept here as a client that sends a lifetime anyway. */
  const approveTicked = (requestId: string, card: Record<string, unknown>) =>
    sm.respondToPermission(managed.id, requestId, true, false, { rememberForMinutes: (card.rememberForMinutes as number | undefined) ?? 10 })

  it('an ask-rule admin card answered with the box ticked stores no window, and the next identical card is shown', () => {
    raise('perm-ask-1', ASK_RULE_CARD)
    expect(cards()).toHaveLength(1)
    expect(approveTicked('perm-ask-1', ASK_RULE_CARD)).toBe(true)
    expect(answers).toEqual([{ requestId: 'perm-ask-1', allowed: true, alwaysAllow: false }])
    expect(internals().adminRememberApprovals.size).toBe(0)

    raise('perm-ask-2', ASK_RULE_CARD)
    expect(cards()).toHaveLength(2)
    expect(answers).toHaveLength(1)
  })

  it('a window an earlier NO-RULE card stored does not answer a later ask-rule card for the same command', () => {
    raise('perm-plain-1', NO_RULE_CARD)
    expect(approveTicked('perm-plain-1', NO_RULE_CARD)).toBe(true)
    expect(internals().adminRememberApprovals.size).toBe(1)

    raise('perm-ask-after', ASK_RULE_CARD)
    expect(cards()).toHaveLength(2)
    expect(answers.map(answer => answer.requestId)).toEqual(['perm-plain-1'])
  })

  it('CONTROL: a no-rule admin card answered with the box ticked answers the next identical card with no card', () => {
    raise('perm-plain-1', NO_RULE_CARD)
    expect(approveTicked('perm-plain-1', NO_RULE_CARD)).toBe(true)
    raise('perm-plain-2', NO_RULE_CARD)
    expect(cards()).toHaveLength(1)
    expect(answers.at(-1)).toEqual({ requestId: 'perm-plain-2', allowed: true, alwaysAllow: false })
  })

  it('CONTROL: a no-rule admin card answered WITHOUT the tick stores nothing and the next card is shown', () => {
    raise('perm-plain-1', NO_RULE_CARD)
    expect(sm.respondToPermission(managed.id, 'perm-plain-1', true, false, { rememberForMinutes: undefined })).toBe(true)
    raise('perm-plain-2', NO_RULE_CARD)
    expect(cards()).toHaveLength(2)
  })
})
