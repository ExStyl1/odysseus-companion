/**
 * UA6.2 — `delete_page` asks the HOST (`SessionManager.confirmPageDeleteForAgent`, reached through
 * `pagesToolCallbacksForAgent`): a one-shot, non-rememberable `host_gate` card in EVERY mode, `bypassPermissions`
 * included, and a refusal with no card when nobody can answer one (UA1.18's unattended predicate). These cases drive
 * the SHIPPED closures over a real temp workspace; only the machinery below the decision is stubbed (events,
 * persistence, the connected-client table).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createPage, getPagePath } from '@nessy-agent/shared/pages'
import { readArtifactRegistry, recordArtifactPublish } from '@nessy-agent/shared/artifacts/registry'
import type { TArtifactsClient } from '@nessy-agent/shared/artifacts/t-artifacts-client'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { unregisterSessionScopedToolCallbacks } from '@nessy-agent/shared/agent'
import { attachSessionSelfManagementBindings } from '@nessy-agent/shared/agent/session-self-management-bindings'
import { startCodexSessionCallbackBridge } from '@nessy-agent/shared/agent/backend/codex/session-callback-bridge'
import { parseManagedPiPolicyV1 } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { HOST_CALLBACK_BRIDGE_ROUTES, type SessionToolContext } from '@nessy-agent/session-tools-core'
import { createTestSessionManager } from './test-session-manager.ts'
import { createManagedSession, setSessionPlatform } from '../SessionManager.ts'
import { createHeadlessPlatform } from '../../runtime/platform-headless.ts'
import type { PagesToolCallbacks } from '../../pages/tool-callbacks.ts'

const callerKey = { workspaceId: 'workspace-1', sessionId: 'caller' }

interface Internals {
  sessions: Map<string, unknown>
  directPermissionResolvers: Map<string, { sessionId: string; resolve: (allowed: boolean) => void }>
  pagesToolCallbacksForAgent(caller: unknown): PagesToolCallbacks
  sendEvent(event: unknown, workspaceId: string): void
  persistSession(managed: unknown, immediate?: boolean): void
  rpcServer: unknown
  eventSink: ((channel: string, target: unknown, ...args: unknown[]) => void) | null
  pageDeleteCardTimeoutMs: number
  countHostRaisedCard(managed: unknown, requestId: string, card: { toolName?: string }): () => void
}

let workspaceRoot: string
let otherRoot: string

beforeEach(() => {
  workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ua62-delete-ws-')))
  otherRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ua62-delete-other-')))
})
afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
  rmSync(otherRoot, { recursive: true, force: true })
})

function harness(options: { mode?: string; clientAttached?: boolean; messages?: unknown[]; extra?: Record<string, unknown> } = {}) {
  const manager = createTestSessionManager()
  const internals = manager as unknown as Internals
  const events: Array<Record<string, unknown>> = []
  const pushes: Array<{ channel: string; args: unknown[] }> = []
  let counted = 0

  const caller: Record<string, unknown> = {
    id: callerKey.sessionId,
    name: 'Caller',
    workspace: { id: callerKey.workspaceId, rootPath: workspaceRoot },
    workingDirectory: workspaceRoot,
    permissionMode: options.mode ?? 'default',
    messages: options.messages ?? [{ id: 'u1', role: 'user', content: 'Delete the old dashboard', timestamp: 1 }],
    ...(options.extra ?? {}),
  }
  internals.sessions.set(encodeSessionKey(callerKey), caller)
  internals.sendEvent = event => { events.push(event as Record<string, unknown>) }
  internals.persistSession = () => undefined
  internals.eventSink = (channel, _target, ...args) => { pushes.push({ channel, args }) }
  internals.rpcServer = {
    findClientsWithCapability: (capability: string, opts?: { workspaceId?: string }) =>
      options.clientAttached === false || capability !== 'client:confirmDialog' || opts?.workspaceId !== callerKey.workspaceId
        ? []
        : ['window-1'],
    hasClientCapability: () => false,
  }
  const originalCount = internals.countHostRaisedCard.bind(manager)
  internals.countHostRaisedCard = (managed, requestId, card) => { counted += 1; return originalCount(managed, requestId, card) }

  const answerCard = async (allowed: boolean): Promise<void> => {
    for (let attempt = 0; attempt < 200 && internals.directPermissionResolvers.size === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    for (const [, entry] of internals.directPermissionResolvers) entry.resolve(allowed)
  }
  const callbacks = internals.pagesToolCallbacksForAgent(caller)
  const cards = () => events.filter(event => event.type === 'permission_request').map(event => event.request as Record<string, unknown>)
  return { internals, callbacks, answerCard, cards, pushes, counted: () => counted }
}

describe('delete_page raises one card in EVERY mode a person can answer, bypassPermissions included', () => {
  for (const mode of ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']) {
    test(`mode ${mode}: one host_gate card, no "always allow"; approve → the folder is gone and pages:changed is pushed`, async () => {
      const page = createPage(workspaceRoot, { name: 'Old Dashboard', content: '<p>x</p>' })
      const h = harness({ mode })
      const pending = h.callbacks.deletePage(page.slug)
      await h.answerCard(true)
      expect(await pending).toEqual({ deleted: true, publicCopyMayRemain: false })
      const raised = h.cards()
      expect(raised).toHaveLength(1)
      expect(raised[0]!.toolName).toBe('delete_page')
      expect(raised[0]!.origin).toBe('host_gate')
      expect(raised[0]!.noAlwaysAllow).toBe(true)
      expect(String(raised[0]!.description)).toContain('"Old Dashboard"')
      expect(h.counted()).toBe(1)
      expect(existsSync(getPagePath(workspaceRoot, page.slug))).toBe(false)
      const changed = h.pushes.filter(push => push.channel === RPC_CHANNELS.pages.CHANGED)
      expect(changed).toHaveLength(1)
      expect(changed[0]!.args[0]).toBe(callerKey.workspaceId)
      expect(changed[0]!.args[1]).toEqual([])
    })
  }
})

describe('no approval deletes nothing', () => {
  for (const mode of ['default', 'bypassPermissions']) {
    test(`mode ${mode}: deny → the tool fails with the refusal, the folder stays, nothing is pushed`, async () => {
      const page = createPage(workspaceRoot, { name: 'Keep Me', content: '<p>x</p>' })
      const h = harness({ mode })
      const pending = h.callbacks.deletePage(page.slug)
      await h.answerCard(false)
      await expect(pending).rejects.toThrow('was declined; the page is unchanged.')
      expect(existsSync(join(getPagePath(workspaceRoot, page.slug), 'index.html'))).toBe(true)
      expect(h.pushes).toEqual([])
      expect(h.internals.directPermissionResolvers.size).toBe(0)
    })
  }

  test('a card nobody answers resolves to DENY after the timeout; the page stays', async () => {
    const page = createPage(workspaceRoot, { name: 'Unanswered', content: '<p>x</p>' })
    const h = harness({ mode: 'bypassPermissions' })
    h.internals.pageDeleteCardTimeoutMs = 20
    await expect(h.callbacks.deletePage(page.slug)).rejects.toThrow('nobody answered it within')
    expect(existsSync(getPagePath(workspaceRoot, page.slug))).toBe(true)
    expect(h.internals.directPermissionResolvers.size).toBe(0)
  })

  const unattended: Array<[string, Parameters<typeof harness>[0]]> = [
    ['dontAsk', { mode: 'dontAsk' }],
    ['no interactive client', { clientAttached: false }],
    ['a scheduled / host-delivered turn', { messages: [{ id: 'u1', role: 'user', content: '<task-notification>…', timestamp: 1, taskNotification: true }] }],
    ['an automation\'s prompt', { extra: { triggeredBy: { automationName: 'nightly', timestamp: 1 } } }],
    ['a Pi child session', { extra: { piParentSessionKey: { workspaceId: 'workspace-1', sessionId: 'parent' } } }],
  ]
  for (const [name, options] of unattended) {
    test(`unattended (${name}) → a refusal with no card; the page stays`, async () => {
      const page = createPage(workspaceRoot, { name: 'Unattended', content: '<p>x</p>' })
      const h = harness(options)
      await expect(h.callbacks.deletePage(page.slug)).rejects.toThrow('was not deleted')
      expect(h.cards()).toEqual([])
      expect(h.counted()).toBe(0)
      expect(existsSync(getPagePath(workspaceRoot, page.slug))).toBe(true)
    })
  }
})

describe('scope', () => {
  test('create → list through the bound callbacks, and a mutation pushes pages:changed to the caller\'s workspace', async () => {
    const h = harness()
    const created = await h.callbacks.createPage({ name: 'Fresh', content: '<p>x</p>' })
    expect((await h.callbacks.listPages()).map(page => page.slug)).toEqual([created.slug])
    const changed = h.pushes.filter(push => push.channel === RPC_CHANNELS.pages.CHANGED)
    expect(changed).toHaveLength(1)
    expect((changed[0]!.args[1] as Array<{ config: { slug: string } }>).map(page => page.config.slug)).toEqual([created.slug])
  })

  test('the callbacks are bound to the caller\'s workspace: a page of another workspace is neither listed nor deletable', async () => {
    const foreign = createPage(otherRoot, { name: 'Foreign', content: '<p>x</p>' })
    const h = harness()
    expect(await h.callbacks.listPages()).toEqual([])
    await expect(h.callbacks.deletePage(foreign.slug)).rejects.toThrow('Page not found')
    expect(h.cards()).toEqual([])
    expect(existsSync(getPagePath(otherRoot, foreign.slug))).toBe(true)
  })
})

/**
 * UA6.3 follow-up — the ONE link the arms above cannot execute: the line in `getOrCreateAgent`'s registry block that
 * binds `pages: this.pagesToolCallbacksForAgent(managed)` into the per-session registry (the field is optional, so tsc
 * cannot see it go). Pi and Claude reach the closure through the context getter (`attachSessionSelfManagementBindings`'s
 * `pages`), codex through `startCodexSessionCallbackBridge`'s DEFAULT `resolvePorts`, which reads the same registry.
 * This drives the REAL `getOrCreateAgent` on the rig of `publish-artifact-host-card.test.ts`'s "SHIPPED binding" block
 * (only the backend factory, the automation system and the drain participant are stubbed) and hands neither route a
 * closure of its own — so a missing binding turns both positive arms red. The session is a Pi one; the registration
 * block is not provider-gated, so a Claude or codex session runs the same lines.
 */
describe('the SHIPPED binding: getOrCreateAgent publishes the pages closure every runtime reaches', () => {
  async function boundSession() {
    setSessionPlatform(createHeadlessPlatform())
    const manager = createTestSessionManager({
      managedPiPolicy: parseManagedPiPolicyV1({ schemaVersion: 1, disabledPermissionModes: [], autoCompactEnabled: false }),
    })
    const internals = manager as unknown as Internals & Record<string, unknown>
    const workspace = { id: 'workspace-ua63-bound', name: 'UA6.3 bound', rootPath: workspaceRoot, createdAt: 1 }
    const managed = createManagedSession(
      { id: 'ua63-bound-session', name: 'UA6.3 bound', ephemeral: true },
      workspace as never,
      { messagesLoaded: true },
    ) as unknown as Record<string, unknown> & { id: string }
    managed.workingDirectory = workspaceRoot
    managed.permissionMode = 'default'
    managed.messages = [{ id: 'u1', role: 'user', content: 'List my pages', timestamp: 1 }]
    const key = { workspaceId: workspace.id, sessionId: managed.id }
    internals.sessions.set(encodeSessionKey(key), managed)
    internals.sendEvent = () => undefined
    internals.persistSession = () => undefined
    internals.flushSession = async () => undefined
    internals.getSessionPath = () => null
    internals.eventSink = null
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
    const runWithRuntime = internals.withCapabilityRuntime as (m: unknown, fn: (runtime: unknown) => Promise<unknown>) => Promise<unknown>
    const getOrCreateAgent = internals.getOrCreateAgent as (m: unknown, runtime: unknown) => Promise<unknown>
    await runWithRuntime.call(manager, managed, runtime => getOrCreateAgent.call(manager, managed, runtime))
    const teardown = async () => {
      managed.agent = null
      managed.piDrainRegistration = undefined
      unregisterSessionScopedToolCallbacks(key)
      await manager.cleanup()
    }
    return { key, teardown }
  }

  test('Pi / Claude: the context getter `pages` reaches the closure the host bound, scoped to the session\'s workspace', async () => {
    const page = createPage(workspaceRoot, { name: 'Bound Page', content: '<p>x</p>' })
    createPage(otherRoot, { name: 'Foreign Page', content: '<p>x</p>' })
    const h = await boundSession()
    try {
      const ctx = {} as SessionToolContext
      attachSessionSelfManagementBindings(ctx, h.key)
      expect(ctx.pages).toBeDefined()
      expect((await ctx.pages!.listPages()).map(listed => listed.slug)).toEqual([page.slug])
      // Negative arm, same instrument: a session key nobody registered has no `pages` port.
      const unbound = {} as SessionToolContext
      attachSessionSelfManagementBindings(unbound, { workspaceId: h.key.workspaceId, sessionId: 'ua63-never-bound' })
      expect(unbound.pages).toBeUndefined()
    } finally {
      await h.teardown()
    }
  })

  test('codex: /page/list over the bridge\'s DEFAULT resolvePorts reaches the same closure', async () => {
    const page = createPage(workspaceRoot, { name: 'Bridged Page', content: '<p>x</p>' })
    const h = await boundSession()
    const bridge = await startCodexSessionCallbackBridge({ sessionKey: h.key })
    try {
      const response = await fetch(`http://127.0.0.1:${bridge.port}${HOST_CALLBACK_BRIDGE_ROUTES.pageList}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: h.key.sessionId, payload: {} }),
      })
      const body = (await response.json()) as { result?: Array<{ slug: string }>; error?: string }
      expect(body.error).toBeUndefined()
      expect(body.result?.map(listed => listed.slug)).toEqual([page.slug])
    } finally {
      await bridge.close()
      await h.teardown()
    }
  })
})

describe('UA6.7 — delete_page on a PUBLISHED page takes the copy down after the card, before the folder', () => {
  const ARTIFACT = 'ua67deletepageartifact01'
  function publish(slug: string, id: string): void {
    recordArtifactPublish(workspaceRoot, {
      record: { id: ARTIFACT, url: `https://t-artifacts.t-tech.team/a/${ARTIFACT}`, title: 'Published', expiresAt: null, retentionDays: 7 },
      sourceSessionId: '',
      sourcePath: `pages/${slug}`,
      contentDigest: 'a'.repeat(64),
      kind: 'page',
      page: { id, slug, includesData: false },
    })
  }
  function stubClient(internals: Internals, deletes: string[]): void {
    const client = {
      deleteArtifact: async (target: { id?: string }) => { deletes.push(target.id ?? '') },
    } as unknown as TArtifactsClient
    ;(internals as unknown as { createArtifactsClientFn: () => TArtifactsClient }).createArtifactsClientFn = () => client
  }

  test('approve → exactly one DELETE through the registry, the row leaves, the folder goes, no copy may remain', async () => {
    const page = createPage(workspaceRoot, { name: 'Published', content: '<p>x</p>' })
    publish(page.slug, page.id)
    const h = harness({ mode: 'bypassPermissions' })
    const deletes: string[] = []
    stubClient(h.internals, deletes)
    const pending = h.callbacks.deletePage(page.slug)
    await h.answerCard(true)
    expect(await pending).toEqual({ deleted: true, publicCopyMayRemain: false })
    expect(deletes).toEqual([ARTIFACT])
    expect(readArtifactRegistry(workspaceRoot)).toEqual([])
    expect(existsSync(getPagePath(workspaceRoot, page.slug))).toBe(false)
  })

  test('deny → no DELETE, the publication and the folder stay', async () => {
    const page = createPage(workspaceRoot, { name: 'Published', content: '<p>x</p>' })
    publish(page.slug, page.id)
    const h = harness({ mode: 'default' })
    const deletes: string[] = []
    stubClient(h.internals, deletes)
    const pending = h.callbacks.deletePage(page.slug)
    await h.answerCard(false)
    await expect(pending).rejects.toThrow('was declined')
    expect(deletes).toEqual([])
    expect(readArtifactRegistry(workspaceRoot)).toHaveLength(1)
    expect(existsSync(getPagePath(workspaceRoot, page.slug))).toBe(true)
  })
})
