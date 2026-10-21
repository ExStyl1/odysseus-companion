/**
 * P6.709 — every permission card must be able to say WHO raised it.
 *
 * Before this, the origin survived only as prose inside `reason`
 * (`permissionDslAskReason` writes "Readable permission policy rule `X`
 * (workspace scope) requires approval"), so a renderer that wanted to branch on
 * it — P6.208's "approve and switch to auto mode" carve-out for prompts forced
 * by an ask rule or a hook — would have been parsing a sentence.
 *
 * Two directions are pinned here, and the second one is the one worth having:
 *
 *  1. A host-raised card names the host. `archiveSessionForAgent` is one of the
 *     six host-owned prompts that reach `sendEvent` directly, without any
 *     runtime behind them.
 *  2. The agent band RELAYS what the producer said and never overwrites it. A
 *     backend that names its runtime's own approval flow keeps that word.
 *
 * The band's DEFAULT of `host_gate` landed only once both runtime producers name
 * themselves (`ClaudeAgent.askToolApproval` → `claude_native`, codex's approval
 * branch → `codex_approval`). The field shipped with NO default in the first
 * half of this row for exactly that reason: defaulting earlier would have
 * labelled every claude-native card host-raised. Every producer that still
 * reaches the band unset is a host surface — the MCP elicitation bridge on
 * `BaseAgent`, Pi's `ask_user`, the local-tool gate, the nestor-cloud executor —
 * so the default is a reading rather than a guess.
 *
 * One card deliberately stays UNSET and is not defaulted away:
 * `reprojectPendingApproval` re-fires a durable record after a restart, and
 * `PiPendingApprovalV1` persists no origin, so that card omits the field rather
 * than claiming the host raised what claude did.
 */
import { describe, expect, test } from 'bun:test'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { PERMISSION_REQUEST_ORIGIN_VALUES } from '@nessy-agent/core/types'
import type { ArchiveSessionVerdict } from '@nessy-agent/session-tools-core'
import { createTestSessionManager } from './test-session-manager.ts'

const callerKey = { workspaceId: 'workspace-origin', sessionId: 'caller' }
const targetKey = { workspaceId: 'workspace-origin', sessionId: 'target' }

interface Internals {
  sessions: Map<string, unknown>
  directPermissionResolvers: Map<string, { sessionId: string; resolve: (allowed: boolean) => void }>
  pendingPermissionRequests: Map<string, unknown>
  archiveSessionForAgent(caller: unknown, sessionId: string | undefined, archived: boolean): Promise<ArchiveSessionVerdict>
  handleAgentPermissionRequest(managed: unknown, request: unknown): void
  sendEvent(event: unknown, workspaceId: string): void
  persistSession(managed: unknown, immediate?: boolean): void
  flushSession(sessionId: string, workspaceId?: string): Promise<void>
  emitUnreadSummaryChanged(): void
  offerWorktreeCleanupOnClose(managed: unknown): Promise<void>
}

const makeManaged = (key: typeof callerKey, isArchived?: boolean): Record<string, unknown> => ({
  id: key.sessionId,
  name: `Session ${key.sessionId}`,
  workspace: { id: key.workspaceId, rootPath: '/tmp/workspace-origin' },
  permissionMode: 'default',
  ...(isArchived === undefined ? {} : { isArchived }),
})

function harness() {
  const manager = createTestSessionManager()
  const internals = manager as unknown as Internals
  const events: Array<Record<string, unknown>> = []

  const caller = makeManaged(callerKey)
  const target = makeManaged(targetKey, false)
  internals.sessions.set(encodeSessionKey(callerKey), caller)
  internals.sessions.set(encodeSessionKey(targetKey), target)

  // Only the machinery BELOW the card is stubbed; the card is the production one.
  internals.sendEvent = event => { events.push(event as Record<string, unknown>) }
  internals.persistSession = () => undefined
  internals.flushSession = async () => undefined
  internals.emitUnreadSummaryChanged = () => undefined
  internals.offerWorktreeCleanupOnClose = async () => undefined

  const answerCard = async (allowed: boolean): Promise<void> => {
    for (let attempt = 0; attempt < 50 && internals.directPermissionResolvers.size === 0; attempt += 1) {
      await Promise.resolve()
    }
    for (const [, entry] of internals.directPermissionResolvers) entry.resolve(allowed)
  }

  /** The card, read into a local before any assertion — `toMatchObject` with an
   * asymmetric matcher OVERWRITES the field it matched (AGENTS.md §Traps). */
  const card = (): Record<string, unknown> | undefined => {
    const event = events.find(entry => entry.type === 'permission_request')
    return event?.request as Record<string, unknown> | undefined
  }

  return { internals, caller, events, answerCard, card }
}

const agentRequest = {
  requestId: 'perm-origin-1',
  toolName: 'Bash',
  command: 'npm install express',
  description: 'Execute: npm install express',
  type: 'bash' as const,
}

describe('P6.709 · the permission card carries its origin', () => {
  test('the three origins are the three producers, and nothing else', () => {
    expect([...PERMISSION_REQUEST_ORIGIN_VALUES]).toEqual(['host_gate', 'claude_native', 'codex_approval'])
  })

  test('a host-owned prompt with no runtime behind it names the host gate', async () => {
    const { internals, caller, card, answerCard } = harness()
    const pending = internals.archiveSessionForAgent(caller, 'target', true)
    await answerCard(true)
    await pending
    const raised = card()
    expect(raised, 'archive_session raised no card').toBeDefined()
    const origin = raised!.origin
    expect(origin).toBe('host_gate')
  })

  test('the agent band relays the producer’s origin unchanged', () => {
    const { internals, caller, card } = harness()
    internals.handleAgentPermissionRequest(caller, { ...agentRequest, origin: 'claude_native' })
    const raised = card()
    expect(raised).toBeDefined()
    const origin = raised!.origin
    expect(origin).toBe('claude_native')
  })

  test('a producer that names no origin is the HOST — every one that reaches this band is', () => {
    const { internals, caller, card } = harness()
    internals.handleAgentPermissionRequest(caller, agentRequest)
    const raised = card()
    expect(raised).toBeDefined()
    const origin = raised!.origin
    // The default landed only once BOTH runtime producers name themselves; every
    // producer still reaching here unset is a host surface (the MCP elicitation
    // bridge, Pi's `ask_user`, the local-tool gate, the nestor-cloud executor).
    expect(origin).toBe('host_gate')
  })

  test('the default cannot overwrite a runtime that DID name itself', () => {
    const { internals, caller, card } = harness()
    internals.handleAgentPermissionRequest(caller, { ...agentRequest, origin: 'codex_approval' })
    const raised = card()
    const origin = raised!.origin
    expect(origin).toBe('codex_approval')
  })
})
