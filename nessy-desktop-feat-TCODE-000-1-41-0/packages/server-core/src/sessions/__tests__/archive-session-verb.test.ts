/**
 * P6.466 — archiving another of your own sessions is an agent verb, and its
 * approval card must survive Bypass.
 *
 * ## What was measured before this was written, and why the floor sits where it does
 *
 * Two seams were proposed for the carve-out. Neither reaches a session MCP tool
 * on all three runtimes:
 *
 * - `INTERACTION_ONLY_TOOLS` (`shared/src/agent/core/pre-tool-use.ts`) is read
 *   inside `runPreToolUseChecks`, which has ZERO call sites in `codex-agent.ts`
 *   — its own docblock says so and a grep at HEAD agrees. A name added there
 *   is honoured on Pi and Claude and invisible on codex.
 * - `findNonNegotiableFloors` DOES run on codex, but only through
 *   `CodexAgent.floorVerdict` → `codexApprovalFloorSubjects`, which renders
 *   codex's own `command` / `commandV1` / `fileChangeV1` approvals as `Bash`
 *   and `Write` subjects. An MCP tool call yields no subject at all.
 *
 * So the floor is in the HOST CLOSURE, `SessionManager.archiveSessionForAgent`,
 * which every runtime reaches: Pi and Claude through the session-scoped registry
 * in process, codex over `HOST_CALLBACK_BRIDGE_ROUTES.sessionArchive`. The
 * closure raises a one-shot `noAlwaysAllow` card through
 * `directPermissionResolvers` — the same mechanism `authorizeMonitor` uses —
 * and reads no permission mode at all, which is what "prompts in every mode
 * including bypass" requires.
 *
 * The mode-blindness is asserted as a MATRIX below rather than as one bypass
 * case, because a gate that happened to prompt only in `default` would pass a
 * single-mode test and be exactly the defect the row exists to prevent.
 */
import { describe, expect, test } from 'bun:test'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { attachSessionSelfManagementBindings } from '@nessy-agent/shared/agent/session-self-management-bindings'
import { mergeSessionScopedToolCallbacks, unregisterSessionScopedToolCallbacks } from '@nessy-agent/shared/agent'
import {
  HOST_CALLBACK_BRIDGE_ROUTES,
  SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK,
  SESSION_TOOLS_REQUIRING_HOST_CALLBACK,
  type ArchiveSessionVerdict,
  type SessionToolContext,
} from '@nessy-agent/session-tools-core'
import { createTestSessionManager } from './test-session-manager.ts'

const callerKey = { workspaceId: 'workspace-1', sessionId: 'caller' }
const targetKey = { workspaceId: 'workspace-1', sessionId: 'target' }
const foreignKey = { workspaceId: 'workspace-2', sessionId: 'foreign' }

interface Internals {
  sessions: Map<string, unknown>
  directPermissionResolvers: Map<string, { sessionId: string; resolve: (allowed: boolean) => void }>
  archiveSessionForAgent(
    caller: unknown,
    sessionId: string | undefined,
    archived: boolean,
  ): Promise<ArchiveSessionVerdict>
  sendEvent(event: unknown, workspaceId: string): void
  persistSession(managed: unknown, immediate?: boolean): void
  flushSession(sessionId: string, workspaceId?: string): Promise<void>
  emitUnreadSummaryChanged(): void
  offerWorktreeCleanupOnClose(managed: unknown): Promise<void>
}

type Managed = Record<string, unknown>

const makeManaged = (
  key: typeof callerKey,
  permissionMode: string,
  isArchived?: boolean,
): Managed => ({
  id: key.sessionId,
  name: `Session ${key.sessionId}`,
  workspace: { id: key.workspaceId, rootPath: '/tmp/workspace-1' },
  permissionMode,
  ...(isArchived === undefined ? {} : { isArchived }),
})

function harness(options: { mode?: string; targetArchived?: boolean } = {}) {
  const manager = createTestSessionManager()
  const internals = manager as unknown as Internals
  const events: Array<Record<string, unknown>> = []

  const caller = makeManaged(callerKey, options.mode ?? 'default')
  const target = makeManaged(targetKey, 'default', options.targetArchived ?? false)
  const foreign = makeManaged(foreignKey, 'default', false)
  internals.sessions.set(encodeSessionKey(callerKey), caller)
  internals.sessions.set(encodeSessionKey(targetKey), target)
  internals.sessions.set(encodeSessionKey(foreignKey), foreign)

  // Only the machinery BELOW the decision is stubbed. The card, its shape and
  // the verdict are the production ones.
  internals.sendEvent = event => { events.push(event as Record<string, unknown>) }
  internals.persistSession = () => undefined
  internals.flushSession = async () => undefined
  internals.emitUnreadSummaryChanged = () => undefined
  internals.offerWorktreeCleanupOnClose = async () => undefined

  /** Answer the one card the closure raises, once it has been raised. */
  const answerCard = async (allowed: boolean): Promise<void> => {
    for (let attempt = 0; attempt < 50 && internals.directPermissionResolvers.size === 0; attempt += 1) {
      await Promise.resolve()
    }
    for (const [, entry] of internals.directPermissionResolvers) entry.resolve(allowed)
  }

  const archive = (sessionId: string | undefined, archived = true) =>
    internals.archiveSessionForAgent(caller, sessionId, archived)

  return { manager, internals, caller, target, events, answerCard, archive }
}

/** The card the closure raised, or `undefined` when it raised none. */
function raisedCard(events: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  const event = events.find(entry => entry.type === 'permission_request')
  return event?.request as Record<string, unknown> | undefined
}

describe('the approval card is raised in EVERY permission mode', () => {
  // The matrix is the assertion. `bypassPermissions` alone would not separate a
  // mode-blind gate from one that reads the mode and happens to say yes.
  for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']) {
    test(`mode ${mode} still asks`, async () => {
      const { events, answerCard, archive } = harness({ mode })
      const pending = archive('target')
      await answerCard(true)
      const verdict = await pending
      const card = raisedCard(events)
      expect(card, `no card in ${mode}`).toBeDefined()
      expect(card!.toolName).toBe('archive_session')
      expect(card!.noAlwaysAllow).toBe(true)
      expect(verdict.status).toBe('applied')
    })
  }
})

describe('the verdict the caller gets', () => {
  test('a denial leaves the target unarchived and says so', async () => {
    const { target, answerCard, archive } = harness()
    const pending = archive('target')
    await answerCard(false)
    const verdict = await pending
    expect(verdict.status).toBe('denied')
    expect(verdict.note).toContain('unchanged')
    // `done_means` (c): the flag must not have moved.
    expect(target.isArchived).toBe(false)
  })

  test('an approval moves the flag and the target sees it', async () => {
    const { target, answerCard, archive } = harness()
    const pending = archive('target')
    await answerCard(true)
    expect((await pending).status).toBe('applied')
    expect(target.isArchived).toBe(true)
  })

  test('unarchiving is the same verb with archived: false', async () => {
    const { target, answerCard, archive } = harness({ targetArchived: true })
    const pending = archive('target', false)
    await answerCard(true)
    expect((await pending).status).toBe('applied')
    expect(target.isArchived).toBe(false)
  })

  test('an already-archived target is unchanged and raises NO card', async () => {
    // A person asked to approve a no-op is a person being trained to click.
    const { events, archive } = harness({ targetArchived: true })
    const verdict = await archive('target')
    expect(verdict.status).toBe('unchanged')
    expect(raisedCard(events)).toBeUndefined()
  })

  test('a target in another workspace is refused by name and raises no card', async () => {
    const { events, archive } = harness()
    const verdict = await archive('foreign')
    expect(verdict.status).toBe('not-found')
    expect(verdict.note).toContain('your own workspace')
    expect(raisedCard(events)).toBeUndefined()
  })

  test('positive control — the same harness DOES raise a card for a reachable target', async () => {
    // Without this, the two "raises no card" cases above are equally consistent
    // with a harness that can never observe one.
    const { events, answerCard, archive } = harness()
    const pending = archive('target')
    await answerCard(true)
    await pending
    expect(raisedCard(events)).toBeDefined()
  })
})

describe('the seam reaches all three runtimes', () => {
  test('Pi and Claude reach the closure through the session-scoped registry', () => {
    const calls: Array<[string | undefined, boolean]> = []
    mergeSessionScopedToolCallbacks(callerKey, {
      archiveSessionFn: async (sessionId, archived) => {
        calls.push([sessionId, archived])
        return { status: 'applied' }
      },
    })
    try {
      const ctx = {} as SessionToolContext
      attachSessionSelfManagementBindings(ctx, callerKey)
      expect(typeof ctx.archiveSession).toBe('function')
      void ctx.archiveSession!('target', true)
      expect(calls).toEqual([['target', true]])
    } finally {
      unregisterSessionScopedToolCallbacks(callerKey)
    }
  })

  test('codex reaches it over the bridge, and the tool is gated off without one', () => {
    // Both memberships or neither: a tool in the host-callback set but not the
    // bridged set is refused on codex, and one in neither would be ADVERTISED
    // with no card behind it — the exact outcome this row exists to prevent.
    expect(SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has('archive_session')).toBe(true)
    expect(SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK.has('archive_session')).toBe(true)
    expect(HOST_CALLBACK_BRIDGE_ROUTES.sessionArchive).toBe('/session/archive')
  })
})
