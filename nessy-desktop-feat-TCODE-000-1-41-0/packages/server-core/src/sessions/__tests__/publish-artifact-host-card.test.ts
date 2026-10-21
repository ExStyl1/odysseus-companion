/**
 * UA1.18 — `publish_artifact`'s card is raised by the HOST closure (`SessionManager.publishArtifactForAgent`), the
 * seam all three runtimes reach (Pi and Claude in process through the session-scoped registry, codex over
 * `HOST_CALLBACK_BRIDGE_ROUTES.artifactPublish`) — archive_session's measured reason (P6.466). These cases drive the
 * SHIPPED closure and its registry binding; only the machinery below the decision is stubbed (events, persistence,
 * the connected-client table, and the service client).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { attachSessionSelfManagementBindings } from '@nessy-agent/shared/agent/session-self-management-bindings'
import { mergeSessionScopedToolCallbacks, unregisterSessionScopedToolCallbacks } from '@nessy-agent/shared/agent'
import {
  HOST_CALLBACK_BRIDGE_ROUTES,
  SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK,
  SESSION_TOOLS_REQUIRING_HOST_CALLBACK,
  type PublishArtifactInput,
  type PublishArtifactVerdict,
  type SessionToolContext,
} from '@nessy-agent/session-tools-core'
import type { PublishRequest, TArtifactsClient } from '@nessy-agent/shared/artifacts/t-artifacts-client'
import { startCodexSessionCallbackBridge } from '@nessy-agent/shared/agent/backend/codex/session-callback-bridge'
import { parseManagedPiPolicyV1 } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { createTestSessionManager } from './test-session-manager.ts'
import { createManagedSession, setSessionPlatform } from '../SessionManager.ts'
import { createHeadlessPlatform } from '../../runtime/platform-headless.ts'
import { ARTIFACT_CARD_SOURCE_HEAD_LIMIT_BYTES } from '../artifact-publishing.ts'

const callerKey = { workspaceId: 'workspace-1', sessionId: 'caller' }

interface Internals {
  sessions: Map<string, unknown>
  directPermissionResolvers: Map<string, { sessionId: string; resolve: (allowed: boolean, canonicalInput?: unknown, answer?: unknown, comment?: string) => void }>
  publishArtifactForAgent(caller: unknown, input: PublishArtifactInput): Promise<PublishArtifactVerdict>
  artifactCardUnattendedReason(caller: unknown): string | null
  sendEvent(event: unknown, workspaceId: string): void
  persistSession(managed: unknown, immediate?: boolean): void
  getSessionPath(sessionId: string, workspaceId?: string): string | null
  rpcServer: unknown
  createArtifactsClientFn: () => TArtifactsClient
  artifactPublishCardTimeoutMs: number
  countHostRaisedCard(managed: unknown, requestId: string, card: { toolName?: string }): () => void
}

let workspaceRoot: string
let cwd: string

beforeEach(() => {
  workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ua118-hostcard-ws-')))
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ua118-hostcard-cwd-')))
  writeFileSync(join(cwd, 'page.html'), '<h1>Hello</h1>')
})
afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

function harness(options: { mode?: string; clientAttached?: boolean; messages?: unknown[]; extra?: Record<string, unknown> } = {}) {
  const manager = createTestSessionManager()
  const internals = manager as unknown as Internals
  const events: Array<Record<string, unknown>> = []
  const requests: Array<{ method: string; request: PublishRequest }> = []
  let counted = 0

  const caller: Record<string, unknown> = {
    id: callerKey.sessionId,
    name: 'Caller',
    workspace: { id: callerKey.workspaceId, rootPath: workspaceRoot },
    workingDirectory: cwd,
    permissionMode: options.mode ?? 'default',
    messages: options.messages ?? [{ id: 'u1', role: 'user', content: 'Please publish page.html', timestamp: 1 }],
    ...(options.extra ?? {}),
  }
  internals.sessions.set(encodeSessionKey(callerKey), caller)
  internals.sendEvent = event => { events.push(event as Record<string, unknown>) }
  internals.persistSession = () => undefined
  internals.getSessionPath = () => null
  internals.rpcServer = {
    findClientsWithCapability: (capability: string, opts?: { workspaceId?: string }) =>
      options.clientAttached === false || capability !== 'client:confirmDialog' || opts?.workspaceId !== callerKey.workspaceId
        ? []
        : ['window-1'],
    hasClientCapability: () => false,
  }
  internals.createArtifactsClientFn = () => ({
    createArtifact: async request => {
      requests.push({ method: 'POST', request })
      return { id: 'abcdefghijklmnopqrstuv', url: 'https://t-artifacts.t-tech.team/a/abcdefghijklmnopqrstuv', title: request.title, expiresAt: '2026-10-09T00:00:00.000Z', retentionDays: 7 }
    },
    updateArtifact: async (_target, request) => {
      requests.push({ method: 'PUT', request })
      return { id: 'abcdefghijklmnopqrstuv', url: 'https://t-artifacts.t-tech.team/a/abcdefghijklmnopqrstuv', title: request.title, expiresAt: '2026-10-09T00:00:00.000Z', retentionDays: 7 }
    },
    listOwnedArtifacts: async () => [],
    patchArtifact: async () => { throw new Error('unused') },
    deleteArtifact: async () => { throw new Error('unused') },
  })
  const originalCount = internals.countHostRaisedCard.bind(manager)
  internals.countHostRaisedCard = (managed, requestId, card) => { counted += 1; return originalCount(managed, requestId, card) }

  const answerCard = async (allowed: boolean): Promise<void> => {
    for (let attempt = 0; attempt < 200 && internals.directPermissionResolvers.size === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    for (const [, entry] of internals.directPermissionResolvers) entry.resolve(allowed)
  }
  const publish = (input: PublishArtifactInput = { filePath: 'page.html' }) => internals.publishArtifactForAgent(caller, input)
  const cards = () => events.filter(event => event.type === 'permission_request').map(event => event.request as Record<string, unknown>)
  const auditRows = () => events.filter(event => event.type === 'info').map(event => String(event.message))
  return { manager, internals, caller, events, requests, answerCard, publish, cards, auditRows, counted: () => counted }
}

describe('the card is raised in EVERY mode a person can answer, bypassPermissions included', () => {
  for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']) {
    test(`mode ${mode}: one card, no "always allow", approve → one POST carrying the previewed bytes`, async () => {
      const { publish, answerCard, cards, requests, auditRows } = harness({ mode })
      const pending = publish()
      await answerCard(true)
      const verdict = await pending
      expect(verdict.status).toBe('published')
      const raised = cards()
      expect(raised).toHaveLength(1)
      expect(raised[0]!.toolName).toBe('publish_artifact')
      expect(raised[0]!.origin).toBe('host_gate')
      expect(raised[0]!.noAlwaysAllow).toBe(true)
      // UA12.67 control — a FILE card keeps publish_artifact's wording (title, then the file in parentheses).
      expect(raised[0]!.description).toContain('Publish "')
      expect(raised[0]!.description).toContain('(page.html) on')
      expect(raised[0]!.description).not.toContain('Share chat')
      const payload = raised[0]!.artifactPublish as { previewContent: string; mode: string }
      expect(payload.mode).toBe('create')
      expect(requests.map(entry => entry.method)).toEqual(['POST'])
      expect(requests[0]!.request.content).toBe(payload.previewContent)
      expect(auditRows()).toHaveLength(1)
      expect(auditRows()[0]).toContain('decision: approved')
      expect(auditRows()[0]).toContain(`mode: ${mode}`)
    })
  }

  test('an update in bypassPermissions raises the card too, and approval sends ONE PUT', async () => {
    const first = harness({ mode: 'bypassPermissions' })
    const created = first.publish()
    await first.answerCard(true)
    expect((await created).status).toBe('published')

    const second = harness({ mode: 'bypassPermissions' })
    writeFileSync(join(cwd, 'page.html'), '<h1>Hello again</h1>')
    const updated = second.publish({ filePath: 'page.html', url: 'https://t-artifacts.t-tech.team/a/abcdefghijklmnopqrstuv' })
    await second.answerCard(true)
    expect((await updated).status).toBe('updated')
    expect(second.cards()).toHaveLength(1)
    expect((second.cards()[0]!.artifactPublish as { mode: string }).mode).toBe('update')
    expect(second.requests.map(entry => entry.method)).toEqual(['PUT'])
  })
})

describe('refusals', () => {
  test('deny → no request, a refusal to the model, one denied audit row', async () => {
    const { publish, answerCard, requests, auditRows } = harness()
    const pending = publish()
    await answerCard(false)
    const verdict = await pending
    expect(verdict.status).toBe('denied')
    expect(verdict.note).toContain('was declined')
    expect(requests).toEqual([])
    expect(auditRows().map(row => row.includes('decision: denied'))).toEqual([true])
  })

  test('a card nobody answers resolves to DENY after the timeout, nothing sent', async () => {
    const { internals, publish, requests } = harness()
    internals.artifactPublishCardTimeoutMs = 20
    const verdict = await publish()
    expect(verdict.status).toBe('denied')
    expect(verdict.note).toContain('nobody answered it within')
    expect(requests).toEqual([])
    expect(internals.directPermissionResolvers.size).toBe(0)
  })

  const unattended: Array<[string, Parameters<typeof harness>[0]]> = [
    ['dontAsk', { mode: 'dontAsk' }],
    ['no interactive client', { clientAttached: false }],
    ['a scheduled / host-delivered turn', { messages: [{ id: 'u1', role: 'user', content: '<task-notification>…', timestamp: 1, taskNotification: true }] }],
    ['a Pi goal continuation', { messages: [{ id: 'u1', role: 'user', content: 'Continue active goal (g1@3)', timestamp: 1 }] }],
    ['an automation\'s prompt', { extra: { triggeredBy: { automationName: 'nightly', timestamp: 1 } } }],
    ['a Pi child session', { extra: { piParentSessionKey: { workspaceId: 'workspace-1', sessionId: 'parent' } } }],
  ]
  for (const [name, options] of unattended) {
    test(`unattended (${name}) → refused BEFORE countHostRaisedCard, no card, zero requests, one audit row`, async () => {
      const h = harness(options)
      const verdict = await h.publish()
      expect(verdict.status).toBe('refused')
      expect(verdict.note).toContain('no request was made')
      expect(h.counted()).toBe(0)
      expect(h.cards()).toEqual([])
      expect(h.requests).toEqual([])
      expect(h.auditRows().map(row => row.includes('decision: refused-unattended'))).toEqual([true])
    })
  }

  test('control: an automation session where the user typed a LATER message is attended', () => {
    const h = harness({
      extra: { triggeredBy: { automationName: 'nightly', timestamp: 1 } },
      messages: [
        { id: 'u1', role: 'user', content: 'nightly prompt', timestamp: 1 },
        { id: 'u2', role: 'user', content: 'now publish it', timestamp: 2 },
      ],
    })
    expect(h.internals.artifactCardUnattendedReason(h.caller)).toBeNull()
  })

  test('a second call while a card is pending is refused; the first still completes', async () => {
    const { publish, answerCard, requests, cards } = harness()
    const first = publish()
    for (let attempt = 0; attempt < 200 && cards().length === 0; attempt += 1) await new Promise(resolve => setTimeout(resolve, 1))
    const second = await publish()
    expect(second.status).toBe('refused')
    expect(second.note).toContain('already waiting')
    await answerCard(true)
    expect((await first).status).toBe('published')
    expect(requests).toHaveLength(1)
  })
})

describe('the binding every runtime reaches', () => {
  test('the context getters read the publishArtifactFn / listArtifactsFn registry slots (a hand-merged fake; SessionManager\'s own binding is the next describe)', async () => {
    const key = { workspaceId: 'workspace-9', sessionId: 'bound' }
    try {
      const calls: string[] = []
      mergeSessionScopedToolCallbacks(key, {
        publishArtifactFn: async input => { calls.push(`publish:${input.filePath}`); return { status: 'refused', note: 'x' } },
        listArtifactsFn: () => { calls.push('list'); return { artifacts: [] } },
      })
      const ctx = {} as SessionToolContext
      attachSessionSelfManagementBindings(ctx, key)
      await ctx.publishArtifact!({ filePath: 'a.html' })
      await ctx.listArtifacts!()
      expect(calls).toEqual(['publish:a.html', 'list'])
    } finally {
      unregisterSessionScopedToolCallbacks(key)
    }
    expect(SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has('publish_artifact')).toBe(true)
    expect(SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK.has('publish_artifact')).toBe(true)
    expect(SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK.has('list_artifacts')).toBe(true)
    expect(HOST_CALLBACK_BRIDGE_ROUTES.artifactPublish).toBe('/artifact/publish')
    expect(HOST_CALLBACK_BRIDGE_ROUTES.artifactList).toBe('/artifact/list')
  })
})

/**
 * UA1.18 follow-up — the ONE link the arms above cannot execute: the two lines in `getOrCreateAgentUnchecked` that bind
 * `publishArtifactFn` / `listArtifactsFn` into the per-session registry. Pi and Claude reach the closure through the
 * context getters (`attachSessionSelfManagementBindings`), codex through `startCodexSessionCallbackBridge`'s DEFAULT
 * `resolvePorts`, which reads the same registry. This drives the REAL `getOrCreateAgent` (the rig of
 * `pi-child-max-turns-config.test.ts`: only the backend factory, the automation system and the drain participant are
 * stubbed) and then reaches the card through both routes WITHOUT handing either one a closure of its own — so deleting
 * the binding turns this red (measured 2026-10-02: both arms 0/2), where the hand-merged arm above stays green. The
 * session is a Pi one; the registration block is not provider-gated, so a Claude session runs the same lines.
 */
describe('the SHIPPED binding: getOrCreateAgent publishes the closures every runtime reaches', () => {
  async function boundSession() {
    setSessionPlatform(createHeadlessPlatform())
    const manager = createTestSessionManager({
      managedPiPolicy: parseManagedPiPolicyV1({ schemaVersion: 1, disabledPermissionModes: [], autoCompactEnabled: false }),
    })
    const internals = manager as unknown as Internals & Record<string, unknown>
    const workspace = { id: 'workspace-ua118-bound', name: 'UA1.18 bound', rootPath: workspaceRoot, createdAt: 1 }
    const managed = createManagedSession(
      { id: 'ua118-bound-session', name: 'UA1.18 bound', ephemeral: true },
      workspace as never,
      { messagesLoaded: true },
    ) as unknown as Record<string, unknown> & { id: string }
    managed.workingDirectory = cwd
    managed.permissionMode = 'default'
    managed.messages = [{ id: 'u1', role: 'user', content: 'Please publish page.html', timestamp: 1 }]
    const key = { workspaceId: workspace.id, sessionId: managed.id }
    internals.sessions.set(encodeSessionKey(key), managed)
    const events: Array<Record<string, unknown>> = []
    internals.sendEvent = event => { events.push(event as Record<string, unknown>) }
    internals.persistSession = () => undefined
    internals.flushSession = async () => undefined
    internals.getSessionPath = () => null
    internals.rpcServer = {
      findClientsWithCapability: (capability: string, opts?: { workspaceId?: string }) =>
        capability === 'client:confirmDialog' && opts?.workspaceId === workspace.id ? ['window-1'] : [],
      hasClientCapability: () => false,
    }
    internals.resolveBackendContextForManaged = () => ({
      connection: null,
      provider: 'pi',
      resolvedModel: 'pi-model',
      capabilities: { needsHttpPoolServer: false },
    })
    internals.buildAgentAutomationSystem = async () => ({ executeAgentEvent: async () => ({ matchedCount: 0 }) })
    const agent = {
      isProcessing: () => false,
      setAutomationSystem() {},
      setCapabilityTurnRuntime() {},
      setPermissionMode() {},
      drainAutomationEvents: async () => {},
      postInit: async () => ({}),
      setAllSources() {},
      setSourceServers: async () => {},
      getModel: () => 'pi-model',
      chat: () => (async function* () {})(),
      getSessionId: () => undefined,
      endLifecycle: async () => {},
      forceAbort() {},
      dispose() {},
    }
    internals.createBackendFromManagedContext = () => agent
    internals.piWorkspaceDrainParticipant = {
      processSupervisorPort: undefined,
      async admitRuntime(input: { publish(agent: unknown, handle: { dispose(): void }): void; create(): Promise<unknown> }) {
        input.publish(await input.create(), { dispose() {} })
      },
      dispose() {},
    }
    const requests: string[] = []
    internals.createArtifactsClientFn = () => ({
      createArtifact: async () => { requests.push('POST'); throw new Error('a denied card must send nothing') },
      updateArtifact: async () => { requests.push('PUT'); throw new Error('a denied card must send nothing') },
      listOwnedArtifacts: async () => [],
      patchArtifact: async () => { throw new Error('unused') },
      deleteArtifact: async () => { throw new Error('unused') },
    })
    const runWithRuntime = internals.withCapabilityRuntime as (m: unknown, fn: (runtime: unknown) => Promise<unknown>) => Promise<unknown>
    const getOrCreateAgent = internals.getOrCreateAgent as (m: unknown, runtime: unknown) => Promise<unknown>
    await runWithRuntime.call(manager, managed, runtime => getOrCreateAgent.call(manager, managed, runtime))
    const cards = () => events.filter(event => event.type === 'permission_request').map(event => event.request as Record<string, unknown>)
    const denyWhenRaised = async (): Promise<void> => {
      for (let attempt = 0; attempt < 500 && internals.directPermissionResolvers.size === 0; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 2))
      }
      for (const [, entry] of internals.directPermissionResolvers) entry.resolve(false)
    }
    const teardown = async () => {
      managed.agent = null
      managed.piDrainRegistration = undefined
      unregisterSessionScopedToolCallbacks(key)
      await manager.cleanup()
    }
    return { key, cards, requests, denyWhenRaised, teardown }
  }

  test('Pi / Claude: the context getters reach the card through the registry the host bound', async () => {
    const h = await boundSession()
    try {
      const ctx = {} as SessionToolContext
      attachSessionSelfManagementBindings(ctx, h.key)
      expect(typeof ctx.publishArtifact).toBe('function')
      expect(typeof ctx.listArtifacts).toBe('function')
      const pending = ctx.publishArtifact!({ filePath: 'page.html' })
      await h.denyWhenRaised()
      const verdict = await pending
      expect(verdict.status).toBe('denied')
      expect(h.cards()).toHaveLength(1)
      expect(h.cards()[0]!.toolName).toBe('publish_artifact')
      expect(h.cards()[0]!.artifactPublish).toBeDefined()
      expect(h.requests).toEqual([])
      expect(await ctx.listArtifacts!()).toEqual({ artifacts: [] })
    } finally {
      await h.teardown()
    }
  })

  test('codex: /artifact/publish over the bridge\'s DEFAULT resolvePorts raises the same card', async () => {
    const h = await boundSession()
    const bridge = await startCodexSessionCallbackBridge({ sessionKey: h.key })
    try {
      const pending = fetch(`http://127.0.0.1:${bridge.port}${HOST_CALLBACK_BRIDGE_ROUTES.artifactPublish}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: h.key.sessionId, payload: { filePath: 'page.html' } }),
      })
      await h.denyWhenRaised()
      const body = (await (await pending).json()) as { result?: PublishArtifactVerdict; error?: string }
      expect(body.error).toBeUndefined()
      expect(body.result?.status).toBe('denied')
      expect(h.cards()).toHaveLength(1)
      expect(h.cards()[0]!.artifactPublish).toBeDefined()
      expect(h.requests).toEqual([])
    } finally {
      await bridge.close()
      await h.teardown()
    }
  })
})

describe('the source excerpt on the card is bounded on the wire', () => {
  test('a single-line page above the cap rides the card as a capped prefix, marked with a trailing ellipsis', async () => {
    // Short words, so the guard's scan stays cheap; what matters is that the file has NO newline.
    const line = `<p>${'ab cd '.repeat(Math.ceil((ARTIFACT_CARD_SOURCE_HEAD_LIMIT_BYTES * 3) / 6))}</p>`
    writeFileSync(join(cwd, 'page.html'), line)
    const { publish, answerCard, cards } = harness()
    const pending = publish()
    await answerCard(false)
    expect((await pending).status).toBe('denied')
    const head = (cards()[0]!.artifactPublish as { sourceHead: string }).sourceHead
    expect(Buffer.byteLength(head, 'utf8')).toBeLessThanOrEqual(ARTIFACT_CARD_SOURCE_HEAD_LIMIT_BYTES + Buffer.byteLength('…'))
    expect(head.endsWith('…')).toBe(true)
    expect(line.startsWith(head.slice(0, -1))).toBe(true)
  })

  test('control: a page under the cap shows exactly its first 40 lines, unmarked', async () => {
    const lines = Array.from({ length: 45 }, (_, index) => `<p>line ${index + 1}</p>`)
    writeFileSync(join(cwd, 'page.html'), lines.join('\n'))
    const { publish, answerCard, cards } = harness()
    const pending = publish()
    await answerCard(false)
    expect((await pending).status).toBe('denied')
    expect((cards()[0]!.artifactPublish as { sourceHead: string }).sourceHead).toBe(lines.slice(0, 40).join('\n'))
  })
})

describe('UA12.28 — a deny note on a host-gate card reaches the model', () => {
  /** Waits for the card, then answers every pending resolver with `allowed` and the given note. */
  async function answerWithNote(h: ReturnType<typeof harness>, allowed: boolean, note: string): Promise<void> {
    for (let attempt = 0; attempt < 200 && h.internals.directPermissionResolvers.size === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    for (const [, entry] of h.internals.directPermissionResolvers) entry.resolve(allowed, undefined, undefined, note)
  }

  test('positive: the note is quoted in the refusal the model reads, and nothing is sent', async () => {
    const h = harness()
    const pending = h.publish()
    await answerWithNote(h, false, 'please redact the client column first')
    const verdict = await pending
    expect(verdict.status).toBe('denied')
    expect(verdict.note).toContain('the person attached a note: "please redact the client column first"')
    expect(h.requests).toEqual([])
  })

  test('boundary: a blank note is dropped — the plain refusal stands; an over-long note is capped with the marker', async () => {
    const blank = harness()
    const pendingBlank = blank.publish()
    await answerWithNote(blank, false, '   ')
    const blankVerdict = await pendingBlank
    expect(blankVerdict.status).toBe('denied')
    expect(blankVerdict.note).not.toContain('attached a note')

    const long = harness()
    const pendingLong = long.publish()
    await answerWithNote(long, false, 'x'.repeat(1300))
    const longVerdict = await pendingLong
    expect(longVerdict.note).toContain('...[truncated]')
    expect(longVerdict.note).not.toContain('x'.repeat(1300))
  })
})
