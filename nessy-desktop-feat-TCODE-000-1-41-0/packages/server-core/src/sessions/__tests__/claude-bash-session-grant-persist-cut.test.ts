/**
 * C4.46 — THE PERSIST CUT: a Bash Always Allow on the CLAUDE-native card is
 * session-scoped and mints no permanent repository rule.
 *
 * ## Why this file exists at all
 *
 * The owner allowed (2026-09-13) a Bash approval on the claude card to be
 * remembered for the SESSION, which is one clause of
 * `packages/shared/src/agent/claude-agent.ts` symbol
 * `claudeCallCanRememberForSession`. That clause alone would have been a
 * widening, not a parity fix: `SessionManager.respondToPermission` fires
 * `persistBashAlwaysAllowRule` on the same click for `requestMeta?.type ===
 * 'bash'` with NO provider term, and `ClaudeAgent.claudeToolApprovalRequest`
 * stamps `type: 'bash'` with the real shell string on exactly that card. So one
 * click on a card the renderer labels "session"
 * (`apps/electron/src/renderer/components/app-shell/input/structured/PermissionRequest.tsx`
 * symbol `permissionRememberScope` returns 'session' for a bash card on claude)
 * would ALSO have written a permanent `Bash(<base> *)` into
 * `.claude/settings.local.json` — the widest grant class, with the sandbox off by
 * standing decision, binding every future session in that repository, while this
 * fork's own gate keeps asking anyway (C3.365). The user would pay the widening
 * and get none of the convenience.
 *
 * ## What is pinned, and in BOTH directions
 *
 * The cut is keyed on `origin`, not on the provider, because `origin` is the
 * thing that is true: `claude_native` means the RUNTIME's own rules raised this
 * card, and its remember is the runtime's own session-scoped `addRules`
 * (measured by C3.7: it writes nothing anywhere and binds for the rest of the
 * turn). A `host_gate` bash card — Pi, codex, and claude's own PreToolUse route
 * — is UNCHANGED and must still persist, because there the saved rule is what
 * the host gate actually reads. A one-armed test here would pass against a build
 * that had deleted the persist entirely, which is the "control whose two arms now
 * agree" failure AGENTS.md §Traps records for a default flip.
 *
 * ## On the planted agent
 *
 * `managed.agent` is a stub here. That is faithful for THIS card rather than the
 * tautology AGENTS.md §Traps (2026-09-12, C3.371) warns about: a `claude_native`
 * approval is raised from inside a live turn, so production always has an agent
 * at this point — unlike the reopen card, which is raised from `getSession`
 * before one exists. The instrument the arms read is the CALL SITE's decision,
 * recorded by replacing the writer, because the clause under test is the guard
 * and not the writer.
 *
 * SAFETY: no real home directory, no real repository, no credential. The
 * workspace root is a temp path that is never written, and the writer is never
 * actually invoked in either arm.
 */
import { describe, expect, test } from 'bun:test'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createTestSessionManager } from './test-session-manager.ts'

const sessionKey = { workspaceId: 'workspace-c446', sessionId: 'session-c446' }

interface Internals {
  sessions: Map<string, unknown>
  pendingPermissionRequests: Map<string, { origin?: string; type?: string; command?: string }>
  handleAgentPermissionRequest(managed: unknown, request: unknown): void
  respondToPermission(
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow?: boolean,
    options?: unknown,
    workspaceId?: string,
  ): boolean
  persistBashAlwaysAllowRule(managed: unknown, command: string): void
  sendEvent(event: unknown, workspaceId: string): void
  persistSession(managed: unknown, immediate?: boolean): void
  removePendingPermissionRequest(managed: unknown, requestId: string, reason?: string): void
}

const CARD = {
  requestId: 'perm-c446',
  toolName: 'Bash',
  command: 'npm install express',
  description: 'Execute: npm install express',
  type: 'bash' as const,
}

/**
 * One manager, one session with a live agent, and the writer replaced by a
 * recorder. Everything between the card and the answer is production code.
 */
function harness() {
  const manager = createTestSessionManager()
  const internals = manager as unknown as Internals
  const persisted: string[] = []
  const answeredByAgent: Array<[string, boolean, boolean]> = []

  const managed: Record<string, unknown> = {
    id: sessionKey.sessionId,
    name: 'C4.46',
    workspace: { id: sessionKey.workspaceId, rootPath: '/tmp/workspace-c446' },
    permissionMode: 'default',
    // See the header: a claude-native card is raised inside a live turn, so an
    // agent is what production has here.
    agent: {
      respondToPermission: (requestId: string, allowed: boolean, alwaysAllow: boolean) => {
        answeredByAgent.push([requestId, allowed, alwaysAllow])
      },
    },
  }
  internals.sessions.set(encodeSessionKey(sessionKey), managed)

  internals.sendEvent = () => undefined
  internals.persistSession = () => undefined
  internals.removePendingPermissionRequest = () => undefined
  internals.persistBashAlwaysAllowRule = (_managed, command) => { persisted.push(command) }

  const raiseAndAnswer = (origin?: string): void => {
    internals.handleAgentPermissionRequest(managed, { ...CARD, ...(origin ? { origin } : {}) })
    internals.respondToPermission(
      sessionKey.sessionId,
      CARD.requestId,
      true,
      true,
      undefined,
      sessionKey.workspaceId,
    )
  }

  return { internals, managed, persisted, answeredByAgent, raiseAndAnswer }
}

describe('C4.46 · the claude-native Bash Always Allow persists nothing', () => {
  test('the pending record carries the producer\'s origin, which is what the cut reads', () => {
    const { internals, managed } = harness()
    internals.handleAgentPermissionRequest(managed, { ...CARD, origin: 'claude_native' })
    // Read into a local before asserting — `toMatchObject` with an asymmetric
    // matcher OVERWRITES the field it matched (AGENTS.md §Traps, 2026-09-07).
    const meta = internals.pendingPermissionRequests.get(CARD.requestId)
    expect(meta?.origin).toBe('claude_native')
    expect(meta?.type).toBe('bash')
    expect(meta?.command).toBe(CARD.command)
  })

  test('NEGATIVE — an Always Allow on the runtime-raised card writes no repository rule', () => {
    const { persisted, answeredByAgent, raiseAndAnswer } = harness()
    raiseAndAnswer('claude_native')

    // The whole of C4.46's safety half. Nothing reaches
    // `.claude/settings.local.json`; the grant is the runtime's own
    // session-scoped `addRules`, echoed back through `canUseTool`.
    expect(persisted).toEqual([])
    // ...and the answer still reaches the runtime carrying `alwaysAllow`, which
    // is what makes the session grant happen at all. Without this the arm above
    // would pass against a build that simply dropped the answer.
    expect(answeredByAgent).toEqual([[CARD.requestId, true, true]])
  })

  test('CONTROL — a host-raised Bash card still persists, so the cut is a cut and not a deletion', () => {
    const { persisted, raiseAndAnswer } = harness()
    raiseAndAnswer('host_gate')

    expect(persisted).toEqual([CARD.command])
  })

  test('CONTROL — a producer that named no origin is the host, and persists too', () => {
    // `handleAgentPermissionRequest` defaults the EVENT's origin to `host_gate`
    // but records the pending entry unmapped, so this arm proves the cut's
    // negative test (`!== 'claude_native'`) answers correctly for the unset case
    // rather than by accident of a default.
    const { internals, persisted, raiseAndAnswer } = harness()
    raiseAndAnswer(undefined)

    expect(internals.pendingPermissionRequests.get(CARD.requestId)?.origin).toBeUndefined()
    expect(persisted).toEqual([CARD.command])
  })

  test('CONTROL — a codex approval is untouched by a claude-shaped cut', () => {
    const { persisted, raiseAndAnswer } = harness()
    raiseAndAnswer('codex_approval')

    expect(persisted).toEqual([CARD.command])
  })
})
