/**
 * UA12.25 — host cards (publish, archive) survive a renderer reload (P-UA-n-2). A card raised
 * before a window connects (or before its reload) reaches nothing: the window's
 * `pendingPermissions` map is fed only by live `permission_request` events, and the server's
 * `pendingPermissionRequests` entry carried no payload to rebuild the card from. The fix shape:
 * the host-gate request object is stamped on its pending entry when the event is sent, rides the
 * session list DTO (`pendingHostCardRequests`), and a reloading client re-files what it has not
 * already got. These arms drive the REAL raise paths (`publishArtifactForAgent`,
 * `archiveSessionForAgent`) and the REAL `sendEvent`, so the stamp cannot pass without the entry,
 * the event and the DTO projection all agreeing.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import type { PublishArtifactInput, PublishArtifactVerdict } from '@nessy-agent/session-tools-core'
import type { TArtifactsClient } from '@nessy-agent/shared/artifacts/t-artifacts-client'
import { createTestSessionManager } from './test-session-manager.ts'
import { createManagedSession } from '../SessionManager.ts'
import type { SessionManager } from '../SessionManager.ts'

const callerKey = { workspaceId: 'workspace-ua1225', sessionId: 'caller' }

interface Internals {
  sessions: Map<string, unknown>
  directPermissionResolvers: Map<string, { sessionId: string; resolve: (allowed: boolean) => void }>
  publishArtifactForAgent(caller: unknown, input: PublishArtifactInput): Promise<PublishArtifactVerdict>
  archiveSessionForAgent(caller: unknown, sessionId: string | undefined, archived: boolean): Promise<{ status: string; note?: string }>
  countHostRaisedCard(managed: unknown, requestId: string, card: { toolName?: string }): () => void
  pendingPermissionRequests: Map<string, unknown>
  requestPiToolApproval(managed: unknown, request: Record<string, unknown>): Promise<{ allowed: boolean }>
  handleAgentPermissionRequest(managed: unknown, request: Record<string, unknown>): void
  rpcServer: unknown
  persistSession(managed: unknown, immediate?: boolean): void
  getSessionPath(sessionId: string, workspaceId?: string): string | null
  artifactPublishCardTimeoutMs: number
  createArtifactsClientFn: () => TArtifactsClient
}

let workspaceRoot: string
let cwd: string

beforeEach(() => {
  workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ua1225-reload-ws-')))
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ua1225-reload-cwd-')))
  writeFileSync(join(cwd, 'page.html'), '<h1>Hello</h1>')
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

function harness() {
  const manager: SessionManager = createTestSessionManager()
  const internals = manager as unknown as Internals
  const events: Array<Record<string, unknown>> = []
  manager.setEventSink((_channel, _target, event) => { events.push(event as Record<string, unknown>) })

  const caller = createManagedSession(
    {
      id: callerKey.sessionId,
      name: 'Caller',
      permissionMode: 'default',
      workingDirectory: cwd,
      messages: [{ id: 'u1', role: 'user', content: 'Please publish page.html', timestamp: 1 }],
    } as never,
    { id: callerKey.workspaceId, name: 'Reload', rootPath: workspaceRoot, createdAt: 1 } as never,
  )
  internals.sessions.set(encodeSessionKey(callerKey), caller)
  internals.persistSession = () => undefined
  internals.getSessionPath = () => null
  internals.rpcServer = {
    findClientsWithCapability: (capability: string, opts?: { workspaceId?: string }) =>
      capability === 'client:confirmDialog' && opts?.workspaceId === callerKey.workspaceId ? ['window-1'] : [],
    hasClientCapability: () => false,
  }
  // The approval's POST runs after the card is answered; this row's subject is the card, not the upload.
  internals.createArtifactsClientFn = () => ({
    createArtifact: async (request: { title: string }) => ({
      id: 'abcdefghijklmnopqrstuv', url: 'https://t-artifacts.t-tech.team/a/abcdefghijklmnopqrstuv',
      title: request.title, expiresAt: '2026-10-09T00:00:00.000Z', retentionDays: 7,
    }),
    updateArtifact: async () => { throw new Error('unused') },
    listOwnedArtifacts: async () => [],
    patchArtifact: async () => { throw new Error('unused') },
    deleteArtifact: async () => { throw new Error('unused') },
  } as unknown as TArtifactsClient)

  /** Answer every open card, as a window would. */
  const answerCards = async (allowed: boolean): Promise<void> => {
    for (let attempt = 0; attempt < 200 && internals.directPermissionResolvers.size === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    for (const [, entry] of internals.directPermissionResolvers) entry.resolve(allowed)
  }

  /** What a reloading window would learn from the session list (UA12.25's DTO field). */
  const reloadedCards = (): Array<Record<string, unknown>> => {
    const dto = manager.getSessions(callerKey.workspaceId).find(session => session.id === callerKey.sessionId)
    return ((dto as unknown as { pendingHostCardRequests?: Array<Record<string, unknown>> })?.pendingHostCardRequests ?? [])
  }

  return { manager, internals, caller, events, answerCards, reloadedCards }
}

describe('UA12.25 — a pending host card is re-shown to a window that loads after it was raised', () => {
  test('the publish card returns with its preview — the row control — and leaves when answered', async () => {
    const { manager, internals, caller, answerCards, reloadedCards } = harness()
    const pending = internals.publishArtifactForAgent(caller, { filePath: 'page.html' })

    const [card] = reloadedCards()
    expect(card).toBeTruthy()
    expect(card!.toolName).toBe('publish_artifact')
    expect(card!.origin).toBe('host_gate')
    const payload = card!.artifactPublish as { previewContent: string; sourcePath: string }
    expect(payload.sourcePath).toBe('page.html')
    expect(payload.previewContent).toContain('Hello')

    await answerCards(true)
    const verdict = await pending
    expect(verdict.status).toBe('published')
    expect(reloadedCards()).toEqual([])
    manager.cleanup()
  })

  test('the archive card returns with its command, and leaves when answered', async () => {
    const { manager, internals, caller, answerCards, reloadedCards } = harness()
    const pending = internals.archiveSessionForAgent(caller, undefined, true)

    const [card] = reloadedCards()
    expect(card).toBeTruthy()
    expect(card!.toolName).toBe('archive_session')
    expect(String(card!.command)).toContain('archive')

    await answerCards(false)
    const verdict = await pending
    expect(verdict.status).toBe('denied')
    expect(reloadedCards()).toEqual([])
    manager.cleanup()
  })

  test('an entry with no host-gate payload rides nothing — the negative arm', () => {
    const { manager, internals, caller, reloadedCards } = harness()
    const release = internals.countHostRaisedCard(caller, 'bare-host-card', { toolName: 'archive_session' })
    try {
      expect(reloadedCards()).toEqual([])
    } finally {
      release()
    }
    manager.cleanup()
  })

  // UA12.25 follow-up (2026-10-08 verification) — the stamp's REAL scope is the event origin, not the card kind:
  // `handleAgentPermissionRequest` labels every request that names no origin `host_gate` (P6.709), so a Pi
  // tool-call card rides too, and the two runtime-named origins ride nothing. Pinned so a narrowing (or a widening
  // to the runtimes' own cards) is a decision, not an accident.
  test('a Pi tool-call card (requestPiToolApproval, no origin) rides the DTO with its payload — the host_gate default', () => {
    const { manager, internals, caller, reloadedCards } = harness()
    void internals.requestPiToolApproval(caller, {
      decisionId: 'pi-bash-1', toolName: 'Bash', type: 'bash', description: 'List the folder', command: 'ls', subject: {},
    })
    const cards = reloadedCards()
    expect(cards.map(card => [card.requestId, card.toolName, card.origin, card.command])).toEqual([
      ['pi-bash-1', 'Bash', 'host_gate', 'ls'],
    ])
    manager.cleanup()
  })

  test('claude_native and codex_approval cards are pending but ride nothing', () => {
    const { manager, internals, caller, reloadedCards } = harness()
    internals.handleAgentPermissionRequest(caller, {
      requestId: 'native-1', toolName: 'Bash', type: 'bash', description: 'claude asks', command: 'ls', origin: 'claude_native',
    })
    internals.handleAgentPermissionRequest(caller, {
      requestId: 'codex-1', toolName: 'Bash', type: 'bash', description: 'codex asks', command: 'ls', origin: 'codex_approval',
    })
    expect(internals.pendingPermissionRequests.has('native-1')).toBe(true)
    expect(internals.pendingPermissionRequests.has('codex-1')).toBe(true)
    expect(reloadedCards()).toEqual([])
    manager.cleanup()
  })
})
