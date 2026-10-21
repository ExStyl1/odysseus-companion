/**
 * UA1.23 — Publish on an inline html-preview / markdown-preview block goes through the SAME host path as
 * `publish_artifact` (`SessionManager.publishArtifactFromUser` → `artifactPublishPorts` → `runArtifactPublish`): the
 * UA1.17 guard, the UA1.18 card (raised in every mode, `bypassPermissions` included), one request, the registry and
 * one audit row. Driven on the SHIPPED SessionManager method; only the machinery below the decision is stubbed (events,
 * persistence, the connected-client table, the service client) — the harness of `publish-artifact-host-card.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import type { PublishRequest, TArtifactsClient } from '@nessy-agent/shared/artifacts/t-artifacts-client'
import type { PublishArtifactVerdict } from '@nessy-agent/session-tools-core'
import { readArtifactRegistry } from '@nessy-agent/shared/artifacts/registry'
import { createTestSessionManager } from './test-session-manager.ts'

const key = { workspaceId: 'workspace-1', sessionId: 'caller' }

interface Internals {
  sessions: Map<string, unknown>
  directPermissionResolvers: Map<string, { sessionId: string; resolve: (allowed: boolean) => void }>
  sendEvent(event: unknown, workspaceId: string): void
  persistSession(managed: unknown, immediate?: boolean): void
  getSessionPath(sessionId: string, workspaceId?: string): string | null
  rpcServer: unknown
  createArtifactsClientFn: () => TArtifactsClient
  publishArtifactForAgent(caller: unknown, input: { filePath: string }): Promise<PublishArtifactVerdict>
  disposeManagedAgentRuntime(managed: unknown, reason: string, strict: boolean): Promise<void>
  eventSink: ((channel: string, target: unknown, ...args: unknown[]) => void) | null
}

let workspaceRoot: string
let cwd: string
let outside: string

beforeEach(() => {
  workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ua123-ws-')))
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ua123-cwd-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'ua123-outside-')))
  writeFileSync(join(cwd, 'report.html'), '<!doctype html><html><head><title>Q3</title></head><body><h1>Q3</h1></body></html>')
  writeFileSync(join(cwd, 'summary.md'), '# Summary\n\n- one\n')
  writeFileSync(join(outside, 'elsewhere.html'), '<h1>not this session\'s</h1>')
})
afterEach(() => {
  for (const dir of [workspaceRoot, cwd, outside]) rmSync(dir, { recursive: true, force: true })
})

function harness(options: { mode?: string; messages?: unknown[]; extra?: Record<string, unknown> } = {}) {
  const manager = createTestSessionManager()
  const internals = manager as unknown as Internals
  const events: Array<Record<string, unknown>> = []
  const requests: Array<{ method: string; request: PublishRequest }> = []
  const pushes: Array<{ channel: string; args: unknown[] }> = []
  const caller: Record<string, unknown> = {
    id: key.sessionId,
    name: 'Caller',
    workspace: { id: key.workspaceId, rootPath: workspaceRoot },
    workingDirectory: cwd,
    permissionMode: options.mode ?? 'bypassPermissions',
    messages: options.messages ?? [{ id: 'u1', role: 'user', content: 'Make me a Q3 page', timestamp: 1 }],
    ...(options.extra ?? {}),
  }
  internals.sessions.set(encodeSessionKey(key), caller)
  internals.sendEvent = event => { events.push(event as Record<string, unknown>) }
  internals.eventSink = (channel, _target, ...args) => { pushes.push({ channel, args }) }
  internals.persistSession = () => undefined
  internals.getSessionPath = () => null
  internals.rpcServer = {
    findClientsWithCapability: (capability: string, opts?: { workspaceId?: string }) =>
      capability === 'client:confirmDialog' && opts?.workspaceId === key.workspaceId ? ['window-1'] : [],
    hasClientCapability: () => false,
  }
  internals.createArtifactsClientFn = () => ({
    createArtifact: async request => {
      requests.push({ method: 'POST', request })
      return { id: 'abcdefghijklmnopqrstuv', url: 'https://t-artifacts.t-tech.team/a/abcdefghijklmnopqrstuv', title: request.title, expiresAt: '2026-10-09T00:00:00.000Z', retentionDays: 7 }
    },
    updateArtifact: async () => { throw new Error('unused') },
    listOwnedArtifacts: async () => [],
    patchArtifact: async () => { throw new Error('unused') },
    deleteArtifact: async () => { throw new Error('unused') },
  })
  const answerCard = async (allowed: boolean): Promise<void> => {
    for (let attempt = 0; attempt < 200 && internals.directPermissionResolvers.size === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    for (const [, entry] of internals.directPermissionResolvers) entry.resolve(allowed)
  }
  const publish = (filePath: string, sessionId = key.sessionId): Promise<PublishArtifactVerdict> =>
    (manager as unknown as { publishArtifactFromUser(s: string, f: string, w: string): Promise<PublishArtifactVerdict> })
      .publishArtifactFromUser(sessionId, filePath, key.workspaceId)
  const cards = () => events.filter(event => event.type === 'permission_request').map(event => event.request as Record<string, unknown>)
  const auditRows = () => events.filter(event => event.type === 'info').map(event => String(event.message))
  const withdrawn = () => events.filter(event => event.type === 'permission_request_cancelled').map(event => event.requestId)
  const disposeRuntime = (): Promise<void> => internals.disposeManagedAgentRuntime(caller, 'idle-agent reaper', true).catch(() => undefined)
  const awaitCard = async (): Promise<string> => {
    for (let attempt = 0; attempt < 200 && internals.directPermissionResolvers.size === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    const [requestId] = [...internals.directPermissionResolvers.keys()]
    if (!requestId) throw new Error('no card was raised')
    return requestId
  }
  return { manager, internals, caller, publish, answerCard, cards, requests, auditRows, withdrawn, disposeRuntime, awaitCard, pushes }
}

describe('UA1.23 — positive: the preview\'s Publish is the publish_artifact path', () => {
  for (const file of ['report.html', 'summary.md']) {
    test(`${file} inside the cwd, in bypassPermissions: the host card for THAT file, approve → one POST of the previewed bytes`, async () => {
      const { publish, answerCard, cards, requests, auditRows } = harness({ mode: 'bypassPermissions' })
      const pending = publish(join(cwd, file))
      await answerCard(true)
      const verdict = await pending
      expect(verdict.status).toBe('published')
      const raised = cards()
      expect(raised).toHaveLength(1)
      expect(raised[0]).toMatchObject({ toolName: 'publish_artifact', origin: 'host_gate', noAlwaysAllow: true })
      const card = raised[0]!.artifactPublish as { sourcePath: string; previewContent: string; retentionDays: number }
      expect(card.sourcePath).toBe(file)
      expect(card.retentionDays).toBe(7)
      expect(requests.map(entry => entry.method)).toEqual(['POST'])
      expect(requests[0]!.request.content).toBe(card.previewContent)
      expect(readArtifactRegistry(workspaceRoot).map(entry => [entry.sourceSessionId, entry.sourcePath])).toEqual([['caller', file]])
      // One audit row, and it says who asked.
      expect(auditRows()).toHaveLength(1)
      expect(auditRows()[0]).toContain('decision: approved')
      expect(auditRows()[0]).toContain('user (preview)')
    })
  }

  test('a declined card sends nothing', async () => {
    const { publish, answerCard, requests } = harness()
    const pending = publish(join(cwd, 'report.html'))
    await answerCard(false)
    expect((await pending).status).toBe('denied')
    expect(requests).toEqual([])
  })
})

describe('UA1.23 — negative', () => {
  test('a src outside the session\'s roots is refused by the guard before any card, and nothing is sent', async () => {
    const { publish, cards, requests, auditRows } = harness()
    const verdict = await publish(join(outside, 'elsewhere.html'))
    expect(verdict.status).toBe('refused')
    expect(cards()).toEqual([])
    expect(requests).toEqual([])
    expect(auditRows()[0]).toContain('decision: refused-guard')
  })

  test('an unattended session is not reachable from a click: Don\'t ask, a Pi child, a schedule-started turn → refused, zero cards', async () => {
    for (const options of [
      { mode: 'dontAsk' },
      { extra: { piParentSessionKey: 'parent' } },
      { messages: [{ id: 'u1', role: 'user', content: 'tick', timestamp: 1, taskNotification: true }] },
    ]) {
      const { publish, cards, requests } = harness(options)
      const verdict = await publish(join(cwd, 'report.html'))
      expect(verdict.status).toBe('refused')
      expect(cards()).toEqual([])
      expect(requests).toEqual([])
    }
  })

  test('a session that is not in the workspace is an error, and an empty path is refused', async () => {
    const { publish, cards } = harness()
    await expect(publish(join(cwd, 'report.html'), 'nobody')).rejects.toThrow('artifacts-session-not-found')
    expect((await publish('  ')).status).toBe('refused')
    expect(cards()).toEqual([])
  })
})

/**
 * UA12.53 (origin P-UAv-2) — the click-raised card is the USER's, not a runtime's: `raiseArtifactPublishCard` stamped
 * EVERY card `releaseOnStop`, so F1.403's `disposeManagedAgentRuntime` (the idle reaper, a runtime refresh, an auth
 * retry) declined a card a person was looking at — though no answer of theirs travels through that runtime (the RPC
 * handler's await holds it). The card is non-runtime like the composer `!` card: its answer, its timeout, or a
 * session-level teardown (runtime switch, rewind, delete — where even the composer `!` card goes) ends it. The control
 * holds F1.401/F1.403 on the tool path: a card the runtime's own call raised is still declined by the same dispose.
 */
describe('UA12.53 — the click-raised card survives a runtime dispose; the tool card does not', () => {
  test('a preview click, then disposeManagedAgentRuntime: the card stays up and approving it still publishes', async () => {
    const { publish, answerCard, internals, requests, withdrawn, disposeRuntime, awaitCard } = harness()
    const pending = publish(join(cwd, 'report.html'))
    const requestId = await awaitCard()
    await disposeRuntime()
    expect(internals.directPermissionResolvers.has(requestId)).toBe(true)
    expect(withdrawn()).toEqual([])
    await answerCard(true)
    expect((await pending).status).toBe('published')
    expect(requests.map(entry => entry.method)).toEqual(['POST'])
  })

  test('control: a tool-raised card is still the runtime\'s — the same dispose declines it, withdraws it, and nothing is sent', async () => {
    const { internals, caller, requests, withdrawn, disposeRuntime, awaitCard } = harness()
    const pending = internals.publishArtifactForAgent(caller, { filePath: join(cwd, 'report.html') })
    const requestId = await awaitCard()
    await disposeRuntime()
    expect(internals.directPermissionResolvers.has(requestId)).toBe(false)
    expect(withdrawn()).toEqual([requestId])
    expect((await pending).status).toBe('denied')
    expect(requests).toEqual([])
  })
})

/**
 * UA12.197 (VF-3 proposal 2) — UA12.53's STATED divergence, held on purpose: on Pi a strict drain (an auth retry, an
 * agent-view stop, the mutation drains) disposes the runtime AND sweeps the session's pending cards
 * (`clearPendingPermissionRequestsForSession`), so the click-raised card ends there — declined, withdrawn, nothing
 * sent — as the composer `!` card does; on claude/codex those paths only dispose the runtime, and the card stays up.
 */
describe('UA12.197 — the click-raised card: a Pi strict drain ends it, a claude dispose leaves it up', () => {
  /** The same two teardown calls on both runtimes; only the session's resolved provider differs (pinned, not configured). */
  async function clickThenTeardown(provider: 'pi' | 'anthropic') {
    const h = harness({ extra: { activeProvider: provider, backgroundShellCommands: new Map(), piBackgroundTaskKinds: new Set() } })
    ;(h.internals as unknown as { resolveManagedProvider: () => string }).resolveManagedProvider = () => provider
    const pending = h.publish(join(cwd, 'report.html'))
    const requestId = await h.awaitCard()
    // An auth retry's teardown: Pi strict-drains the session (a no-op on any other runtime), every runtime disposes.
    await (h.manager as unknown as { strictDrainPiSession(m: unknown, reason: string): Promise<void> }).strictDrainPiSession(h.caller, 'auth retry')
    await h.disposeRuntime()
    return { ...h, pending, requestId }
  }

  test('Pi: the strict drain declines and withdraws the click card; nothing is sent', async () => {
    const h = await clickThenTeardown('pi')
    expect(h.internals.directPermissionResolvers.has(h.requestId)).toBe(false)
    expect(h.withdrawn()).toEqual([h.requestId])
    expect((await h.pending).status).toBe('denied')
    expect(h.requests).toEqual([])
  })

  test('claude: the same teardown leaves the click card up, and approving it still publishes', async () => {
    const h = await clickThenTeardown('anthropic')
    expect(h.internals.directPermissionResolvers.has(h.requestId)).toBe(true)
    expect(h.withdrawn()).toEqual([])
    await h.answerCard(true)
    expect((await h.pending).status).toBe('published')
    expect(h.requests.map(entry => entry.method)).toEqual(['POST'])
  })
})

/**
 * UA12.54 (origin P-UAv-3) — the click path's verdict note reaches the preview toast VERBATIM
 * (`preview-publish.ts` shows `result.note` as the refused/failed description), but UA1.18's sentences are worded for
 * the MODEL: an unattended refusal ends "Offer the page in one line of text instead" — an instruction no person can
 * follow on their own click. When the caller is a person, the refusals that instruct the model are re-worded: the
 * unattended refusal names the reason (the mode included), the card-pending and changed-under-card refusals lose
 * their imperative-to-the-model, a failed publish does not say "The user approved" to the user who just approved, and
 * the registry residue names the Published pages list instead of `list_artifacts`. The control holds the tool path:
 * the model keeps the wording it can act on.
 */
describe('UA12.54 — the click path\'s refusal wording is the user\'s, not the model\'s', () => {
  test('a dontAsk click → the refusal names the mode and never says "Offer the page in one line of text"', async () => {
    const { publish } = harness({ mode: 'dontAsk' })
    const verdict = await publish(join(cwd, 'report.html'))
    expect(verdict.status).toBe('refused')
    expect(verdict.note).toContain("Don't ask mode")
    expect(verdict.note).not.toContain('Offer the page')
    expect(verdict.note).not.toContain('publish_artifact needs')
  })

  test('control: the tool path in the same mode still reads the model wording it can act on', async () => {
    const { internals, caller } = harness({ mode: 'dontAsk' })
    const verdict = await internals.publishArtifactForAgent(caller, { filePath: join(cwd, 'report.html') })
    expect(verdict.status).toBe('refused')
    expect(verdict.note).toContain('Offer the page in one line of text instead')
    expect(verdict.note).toContain('no request was made')
  })

  test('a second click while a card waits → "answer it first", not "Wait for that answer before publishing again"', async () => {
    const { publish, answerCard, awaitCard } = harness()
    const first = publish(join(cwd, 'report.html'))
    await awaitCard()
    const second = await publish(join(cwd, 'report.html'))
    expect(second.status).toBe('refused')
    expect(second.note).toContain('already waiting')
    expect(second.note).toContain('answer it first')
    expect(second.note).not.toContain('Wait for that answer')
    await answerCard(true)
    expect((await first).status).toBe('published')
  })

  test('a failed service call → "Publishing failed", not "The user approved"', async () => {
    const { internals, publish, answerCard, requests } = harness()
    internals.createArtifactsClientFn = () => ({
      createArtifact: async () => { throw new Error('unreachable') },
      updateArtifact: async () => { throw new Error('unused') },
      listOwnedArtifacts: async () => [],
      patchArtifact: async () => { throw new Error('unused') },
      deleteArtifact: async () => { throw new Error('unused') },
    })
    const pending = publish(join(cwd, 'report.html'))
    await answerCard(true)
    const verdict = await pending
    expect(verdict.status).toBe('failed')
    expect(verdict.note).toContain('Publishing failed')
    expect(verdict.note).not.toContain('The user approved')
    expect(requests).toEqual([])
  })
})

// UA12.52 — the shipped publish path BINDS the notify port: an approved publish pushes `artifacts:changed` to the
// caller's workspace (an open Published pages section reloads without its Retry button — the row's control), and a
// declined card pushes nothing. The channel is spelled as its wire literal so this arm reads red against a tree
// where only the wiring is missing.
describe('UA12.52 — an approved publish pushes artifacts:changed to the workspace', () => {
  test('approve → exactly one artifacts:changed naming the workspace; a declined card pushes none', async () => {
    const approved = harness({ mode: 'bypassPermissions' })
    const pending = approved.publish(join(cwd, 'report.html'))
    await approved.answerCard(true)
    expect((await pending).status).toBe('published')
    const changed = approved.pushes.filter(push => push.channel === 'artifacts:changed')
    expect(changed).toHaveLength(1)
    expect(changed[0]!.args[0]).toBe(key.workspaceId)

    const declined = harness()
    const refused = declined.publish(join(cwd, 'report.html'))
    await declined.answerCard(false)
    expect((await refused).status).toBe('denied')
    expect(declined.pushes.filter(push => push.channel === 'artifacts:changed')).toHaveLength(0)
  })
})
