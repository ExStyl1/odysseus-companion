/**
 * UA1.19 — the Published pages RPC (`rpc/artifacts.ts`): `/mine` joined to the workspace registry, extend, delete,
 * and the pending deletion that is never dropped. Driven through the REAL t-artifacts client (UA1.16) with an injected
 * `fetch` and an injected dp `printToken` — nothing reaches a real service or a real dp — and the REAL registry over a
 * temporary workspace root. The handlers are registered on a recording server, so the caller-workspace check (UA1.9)
 * is the shipped one.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS, RPC_REQUEST_TIMEOUT_BY_CHANNEL } from '@nessy-agent/shared/protocol'
import type { ArtifactDeleteResult, ArtifactsListResult, ArtifactActionResult, ArtifactPublishFileResult } from '@nessy-agent/shared/protocol'
import { createTArtifactsClient, T_ARTIFACTS_ORIGIN, type TArtifactsClient } from '@nessy-agent/shared/artifacts/t-artifacts-client'
import { createPage } from '@nessy-agent/shared/pages'
import { readArtifactRegistry, recordArtifactPublish } from '@nessy-agent/shared/artifacts/registry'
import type { RequestContext, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { HANDLED_CHANNELS, PENDING_DELETE_RETRY_WINDOW_MS, registerArtifactsHandlers } from '../artifacts'

const OURS = 'AbCdEfGhIjKlMnOpQrStUv'
const OUTSIDE = 'ZyXwVuTsRqPoNmLkJiHgFe'
const link = (id: string) => `${T_ARTIFACTS_ORIGIN}/a/${id}`

interface Call { method: string; path: string; body?: unknown }

/** A scripted service: answers by `METHOD path`, records every request; never a network. */
function fakeService(script: Record<string, Array<{ status: number; body?: unknown }>>) {
  const calls: Call[] = []
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const path = url.slice(T_ARTIFACTS_ORIGIN.length)
    const method = init.method ?? 'GET'
    calls.push({ method, path, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) })
    const queue = script[`${method} ${path}`]
    const answer = queue && queue.length > 1 ? queue.shift()! : queue?.[0]
    if (!answer) return new Response(null, { status: 500 })
    return answer.status === 204
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(answer.body ?? {}), { status: answer.status, headers: { 'content-type': 'application/json' } })
  }
  return { calls, fetch }
}

/** A real client over the fake service; `signedIn` is what `dp auth print-token` answers (undefined = signed out). */
function client(service: ReturnType<typeof fakeService>, signedIn: { value: boolean }, dp: { tokenReads: number }): TArtifactsClient {
  return createTArtifactsClient({
    fetch: service.fetch,
    env: {},
    resolveDpRuntime: () => ({ dpPath: '/fake/dp' }) as never,
    // Assembled at runtime: an obviously fake token-shaped string, never a real credential.
    printToken: async () => {
      dp.tokenReads += 1
      return signedIn.value ? ['fake', 'token', 'for', 'tests'].join('-') : undefined
    },
    log: { info: () => undefined },
  })
}

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ua119-ws-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function harness(options: { service: ReturnType<typeof fakeService>; signedIn?: { value: boolean }; windows?: Record<number, string>; sessionManager?: Record<string, unknown> }) {
  const signedIn = options.signedIn ?? { value: true }
  const dp = { tokenReads: 0 }
  const handlers = new Map<string, (ctx: RequestContext, ...args: unknown[]) => unknown>()
  const pushes: Array<{ channel: string; target: unknown; args: unknown[] }> = []
  const server = {
    handle: (channel: string, fn: (ctx: RequestContext, ...args: unknown[]) => unknown) => { handlers.set(channel, fn) },
    push: (channel: string, target: unknown, ...args: unknown[]) => { pushes.push({ channel, target, args }) },
  } as unknown as RpcServer
  const deps = {
    workspaceService: { resolve: (id: string) => ({ id, workspaceRootPath: root }), listResolved: () => [{ id: 'ws-a', workspaceRootPath: root }] },
    windowManager: { getWorkspaceForWindow: (wc: number) => (options.windows ?? { 1: 'ws-a' })[wc] ?? null },
    sessionManager: options.sessionManager ?? {},
  } as unknown as HandlerDeps
  registerArtifactsHandlers(server, deps, {
    createClient: () => client(options.service, signedIn, dp),
    now: () => new Date('2026-10-02T12:00:00.000Z'),
  })
  const ctx: RequestContext = { clientId: 'c1', workspaceId: 'ws-a', webContentsId: 1 }
  const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => await handlers.get(channel)!(ctx, ...args) as T
  return { handlers, call, ctx, signedIn, dp, pushes }
}

function seedOurs(extra: Partial<Parameters<typeof recordArtifactPublish>[1]> = {}) {
  recordArtifactPublish(root, {
    record: { id: OURS, url: link(OURS), title: 'Q3 report', expiresAt: '2026-10-09T00:00:00.000Z', retentionDays: 7 },
    sourceSessionId: 'session-1', sourcePath: 'out/q3.html', contentDigest: 'a'.repeat(64), ...extra,
  })
}

const MINE = [
  { id: OURS, url: link(OURS), title: 'Q3 report', expires_at: '2026-10-09T00:00:00.000Z', retention_days: 7, emoji: '📊' },
  { id: OUTSIDE, url: link(OUTSIDE), title: 'Published elsewhere', expires_at: null, retention_days: 0 },
]

describe('UA1.19 artifacts RPC — positive', () => {
  test('the module handles exactly its four channels', () => {
    const { handlers } = harness({ service: fakeService({}) })
    expect([...handlers.keys()].sort()).toEqual([...HANDLED_CHANNELS].sort())
    expect([...HANDLED_CHANNELS].sort()).toEqual(['artifacts:delete', 'artifacts:list', 'artifacts:publishFile', 'artifacts:setRetention'])
  })

  test('UA1.23: publishFile hands the block\'s PATH and session to the one host publishing path and answers its verdict', async () => {
    const calls: unknown[][] = []
    const verdict: ArtifactPublishFileResult = { status: 'published', note: 'Published.', url: link(OURS), expiresAt: null }
    const { call } = harness({
      service: fakeService({}),
      sessionManager: { publishArtifactFromUser: async (...args: unknown[]) => { calls.push(args); return verdict } },
    })
    const result = await call<ArtifactPublishFileResult>(RPC_CHANNELS.artifacts.PUBLISH_FILE, 'ws-a', { sessionId: 'session-1', filePath: 'out/q3.html' })
    expect(result).toEqual(verdict)
    expect(calls).toEqual([['session-1', 'out/q3.html', 'ws-a']])
  })

  test('the list is /mine joined to the registry: pages published outside Nessy are listed, without a source', async () => {
    seedOurs()
    const service = fakeService({ 'GET /api/artifacts/mine': [{ status: 200, body: MINE }] })
    const { call } = harness({ service })
    const result = await call<ArtifactsListResult>(RPC_CHANNELS.artifacts.LIST, 'ws-a')
    expect(result.status).toBe('ok')
    expect(result.artifacts.map(row => row.id)).toEqual([OURS, OUTSIDE])
    expect(result.artifacts[0]).toMatchObject({ emoji: '📊', retentionDays: 7, source: { sessionId: 'session-1', path: 'out/q3.html', kind: 'file' } })
    expect(result.artifacts[1]!.source).toBeUndefined()
    expect(result.artifacts[1]!.expiresAt).toBeNull()
    expect(service.calls).toEqual([{ method: 'GET', path: '/api/artifacts/mine' }])
  })

  test('delete sends exactly one DELETE for the id and the registry entry leaves', async () => {
    seedOurs()
    const service = fakeService({ [`DELETE /api/artifacts/${OURS}`]: [{ status: 204 }] })
    const { call } = harness({ service })
    const result = await call<ArtifactDeleteResult>(RPC_CHANNELS.artifacts.DELETE, 'ws-a', { id: OURS, url: link(OURS) })
    expect(result).toEqual({ outcome: 'deleted' })
    expect(service.calls).toEqual([{ method: 'DELETE', path: `/api/artifacts/${OURS}` }])
    expect(readArtifactRegistry(root)).toEqual([])
  })

  test('a pending deletion is retried after the next successful sign-in, then leaves the list and the registry', async () => {
    seedOurs()
    const signedIn = { value: false }
    const service = fakeService({
      'GET /api/artifacts/mine': [{ status: 200, body: MINE }],
      [`DELETE /api/artifacts/${OURS}`]: [{ status: 204 }],
    })
    const { call } = harness({ service, signedIn })
    // Signed out: the delete is kept, and the list shows ONE status plus the owed row.
    const failed = await call<ArtifactDeleteResult>(RPC_CHANNELS.artifacts.DELETE, 'ws-a', { id: OURS, url: link(OURS) })
    expect(failed.outcome).toBe('pending')
    const out = await call<ArtifactsListResult>(RPC_CHANNELS.artifacts.LIST, 'ws-a')
    expect(out.status).toBe('needs-login')
    expect(out.artifacts.map(row => [row.id, row.pendingDelete?.lastErrorKind])).toEqual([[OURS, 'needs-login']])
    expect(service.calls).toEqual([])
    // Signed in again: the list call succeeds, the owed DELETE goes out once, the row is gone.
    signedIn.value = true
    const back = await call<ArtifactsListResult>(RPC_CHANNELS.artifacts.LIST, 'ws-a')
    expect(back.status).toBe('ok')
    expect(back.retriedDeletes).toBe(1)
    expect(back.artifacts.map(row => row.id)).toEqual([OUTSIDE])
    expect(service.calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET /api/artifacts/mine', `DELETE /api/artifacts/${OURS}`])
    expect(readArtifactRegistry(root)).toEqual([])
  })

  test('extend is one PATCH of retention_days — unlimited (0) included — and the registry follows', async () => {
    seedOurs()
    const service = fakeService({
      [`PATCH /api/artifacts/${OURS}`]: [{ status: 200, body: { id: OURS, url: link(OURS), title: 'Q3 report', expires_at: null, retention_days: 0 } }],
    })
    const { call } = harness({ service })
    const result = await call<ArtifactActionResult>(RPC_CHANNELS.artifacts.SET_RETENTION, 'ws-a', OURS, 0)
    expect(result.ok).toBe(true)
    expect(service.calls).toEqual([{ method: 'PATCH', path: `/api/artifacts/${OURS}`, body: { retention_days: 0 } }])
    expect(readArtifactRegistry(root)[0]).toMatchObject({ expiresAt: null, retentionDays: 0 })
  })
})

describe('UA1.19 artifacts RPC — negative', () => {
  test('a failed DELETE is not dropped: a page published outside this workspace is kept as a pending deletion too', async () => {
    const service = fakeService({
      [`DELETE /api/artifacts/${OUTSIDE}`]: [{ status: 503 }],
      'GET /api/artifacts/mine': [{ status: 200, body: MINE }, { status: 200, body: MINE }],
    })
    const { call } = harness({ service })
    const result = await call<ArtifactDeleteResult>(RPC_CHANNELS.artifacts.DELETE, 'ws-a', { id: OUTSIDE, url: link(OUTSIDE), title: 'Published elsewhere' })
    expect(result).toMatchObject({ outcome: 'pending', errorKind: 'server' })
    const kept = readArtifactRegistry(root)
    expect(kept.map(entry => [entry.id, entry.sourceSessionId, entry.pendingDelete?.lastErrorKind])).toEqual([[OUTSIDE, '', 'server']])
    // The next list retries it; the service still fails, so it is STILL owed and shown as pending, not dropped.
    const listed = await call<ArtifactsListResult>(RPC_CHANNELS.artifacts.LIST, 'ws-a')
    expect(listed.artifacts.find(row => row.id === OUTSIDE)?.pendingDelete?.lastErrorKind).toBe('server')
    expect(readArtifactRegistry(root)).toHaveLength(1)
  })

  test('needs-login: one status, no request; dp is only ASKED for a token (print-token), never logged in', async () => {
    seedOurs()
    const service = fakeService({ 'GET /api/artifacts/mine': [{ status: 200, body: MINE }] })
    const { call, dp } = harness({ service, signedIn: { value: false } })
    const result = await call<ArtifactsListResult>(RPC_CHANNELS.artifacts.LIST, 'ws-a')
    expect(result.status).toBe('needs-login')
    expect(result.errorKind).toBe('needs-login')
    expect(result.message).toContain('Sign in to dp')
    // No pending deletion in the registry → no rows; nothing was sent. The client's only dp seam is `printToken`
    // (UA1.16 fence 4: no `dp auth login`, no browser), read exactly once for the one request it refused.
    expect(result.artifacts).toEqual([])
    expect(service.calls).toEqual([])
    expect(dp.tokenReads).toBe(1)
  })

  test('a refusal no retry fixes (403) keeps nothing; an unknown (404) page counts as deleted', async () => {
    seedOurs()
    const service = fakeService({
      [`DELETE /api/artifacts/${OUTSIDE}`]: [{ status: 403 }],
      [`DELETE /api/artifacts/${OURS}`]: [{ status: 404 }],
    })
    const { call } = harness({ service })
    const forbidden = await call<ArtifactDeleteResult>(RPC_CHANNELS.artifacts.DELETE, 'ws-a', { id: OUTSIDE, url: link(OUTSIDE) })
    expect(forbidden).toMatchObject({ outcome: 'failed', errorKind: 'forbidden' })
    const gone = await call<ArtifactDeleteResult>(RPC_CHANNELS.artifacts.DELETE, 'ws-a', { id: OURS, url: link(OURS) })
    expect(gone).toEqual({ outcome: 'deleted' })
    expect(readArtifactRegistry(root)).toEqual([])
  })

  test('a retention outside 0..36500 and a link on another origin are refused before any request', async () => {
    const service = fakeService({})
    const { call } = harness({ service })
    expect(await call<ArtifactActionResult>(RPC_CHANNELS.artifacts.SET_RETENTION, 'ws-a', OURS, -1)).toMatchObject({ ok: false, errorKind: 'invalid' })
    expect(await call<ArtifactActionResult>(RPC_CHANNELS.artifacts.SET_RETENTION, 'ws-a', OURS, 36_501)).toMatchObject({ ok: false, errorKind: 'invalid' })
    expect(await call<ArtifactDeleteResult>(RPC_CHANNELS.artifacts.DELETE, 'ws-a', { id: OURS, url: `https://claude.ai/a/${OURS}` })).toMatchObject({ outcome: 'failed', errorKind: 'invalid' })
    expect(service.calls).toEqual([])
    expect(readArtifactRegistry(root)).toEqual([])
  })

  test('UA1.23: a publishFile naming no file is refused without reaching the host path', async () => {
    const calls: unknown[] = []
    const { call } = harness({ service: fakeService({}), sessionManager: { publishArtifactFromUser: async (...args: unknown[]) => { calls.push(args); return { status: 'published', note: '' } } } })
    expect(await call<ArtifactPublishFileResult>(RPC_CHANNELS.artifacts.PUBLISH_FILE, 'ws-a', { sessionId: 'session-1' })).toMatchObject({ status: 'refused' })
    expect(await call<ArtifactPublishFileResult>(RPC_CHANNELS.artifacts.PUBLISH_FILE, 'ws-a', null)).toMatchObject({ status: 'refused' })
    expect(calls).toEqual([])
  })

  test('a caller bound to another workspace is refused on every channel, before any request', async () => {
    const service = fakeService({ 'GET /api/artifacts/mine': [{ status: 200, body: MINE }] })
    const published: unknown[] = []
    const { handlers } = harness({ service, windows: { 1: 'ws-b' }, sessionManager: { publishArtifactFromUser: async (...args: unknown[]) => { published.push(args) } } })
    const ctx: RequestContext = { clientId: 'c1', workspaceId: 'ws-a', webContentsId: 1 }
    await expect(Promise.resolve().then(() => handlers.get(RPC_CHANNELS.artifacts.LIST)!(ctx, 'ws-a'))).rejects.toThrow('artifacts-workspace-mismatch')
    await expect(Promise.resolve().then(() => handlers.get(RPC_CHANNELS.artifacts.SET_RETENTION)!(ctx, 'ws-a', OURS, 7))).rejects.toThrow('artifacts-workspace-mismatch')
    await expect(Promise.resolve().then(() => handlers.get(RPC_CHANNELS.artifacts.DELETE)!(ctx, 'ws-a', { id: OURS, url: link(OURS) }))).rejects.toThrow('artifacts-workspace-mismatch')
    await expect(Promise.resolve().then(() => handlers.get(RPC_CHANNELS.artifacts.PUBLISH_FILE)!(ctx, 'ws-a', { sessionId: 'session-1', filePath: 'out/q3.html' }))).rejects.toThrow('artifacts-workspace-mismatch')
    expect(service.calls).toEqual([])
    expect(published).toEqual([])
  })
})

/**
 * UA1.19 follow-up — "retried after the next successful sign-in" (the row and the UI copy): the owed DELETE goes out
 * on the dp session's needs-login → ready boundary (`SessionManager.subscribeDpSessionState`, the broker the system
 * and chat dp cards publish to), without anyone reopening the Published pages list.
 */
describe('UA1.19 artifacts RPC — owed deletions on the dp sign-in boundary', () => {
  type DpState = 'ready' | 'needs-login' | 'unavailable'
  function signInHarness(service: ReturnType<typeof fakeService>, signedIn: { value: boolean }) {
    const listeners: Array<(state: DpState) => unknown> = []
    const h = harness({
      service,
      signedIn,
      sessionManager: { subscribeDpSessionState: (listener: (state: DpState) => unknown) => { listeners.push(listener); return () => undefined } },
    })
    const publish = async (state: DpState) => { for (const listener of listeners) await listener(state) }
    return { ...h, listeners, publish }
  }

  test('a pending deletion goes out as exactly one DELETE when dp turns ready — no list call — and the entry leaves', async () => {
    seedOurs()
    const signedIn = { value: false }
    const service = fakeService({ [`DELETE /api/artifacts/${OURS}`]: [{ status: 204 }] })
    const { call, listeners, publish } = signInHarness(service, signedIn)
    expect(listeners).toHaveLength(1)
    const failed = await call<ArtifactDeleteResult>(RPC_CHANNELS.artifacts.DELETE, 'ws-a', { id: OURS, url: link(OURS) })
    expect(failed.outcome).toBe('pending')
    await publish('needs-login')
    signedIn.value = true
    await publish('ready')
    expect(service.calls.map(c => `${c.method} ${c.path}`)).toEqual([`DELETE /api/artifacts/${OURS}`])
    expect(readArtifactRegistry(root)).toEqual([])
  })

  test('NEG: a needs-login publish sends nothing, and a ready with nothing owed reads no token', async () => {
    seedOurs({ sourceSessionId: 'session-1' })
    const signedIn = { value: false }
    const service = fakeService({ [`DELETE /api/artifacts/${OURS}`]: [{ status: 204 }] })
    const { call, dp, publish } = signInHarness(service, signedIn)
    await call<ArtifactDeleteResult>(RPC_CHANNELS.artifacts.DELETE, 'ws-a', { id: OURS, url: link(OURS) })
    const tokenReadsAfterDelete = dp.tokenReads
    await publish('needs-login')
    await publish('unavailable')
    expect(service.calls).toEqual([])
    expect(dp.tokenReads).toBe(tokenReadsAfterDelete)
    expect(readArtifactRegistry(root).map(entry => entry.pendingDelete?.lastErrorKind)).toEqual(['needs-login'])
    // Nothing owed: a ready boundary asks dp for nothing and sends nothing.
    rmSync(root, { recursive: true, force: true })
    root = mkdtempSync(join(tmpdir(), 'ua119-ws-'))
    signedIn.value = true
    await publish('ready')
    expect(service.calls).toEqual([])
    expect(dp.tokenReads).toBe(tokenReadsAfterDelete)
  })
})

describe('UA1.19 artifacts RPC — the list\'s client budget', () => {
  test('artifacts:list outlasts its worst case: list (token + request) + the retry window + the last retry started in it + 5 s', () => {
    const tokenPlusRequest = 30_000 + 30_000
    const worst = tokenPlusRequest + PENDING_DELETE_RETRY_WINDOW_MS + tokenPlusRequest + 5_000
    expect(RPC_REQUEST_TIMEOUT_BY_CHANNEL[RPC_CHANNELS.artifacts.LIST]).toBeGreaterThanOrEqual(worst)
    // Control: one call (token + request + 5 s) is what delete keeps — the list's extra is the retry pass alone.
    expect(RPC_REQUEST_TIMEOUT_BY_CHANNEL[RPC_CHANNELS.artifacts.DELETE]).toBe(tokenPlusRequest + 5_000)
  })
})

/**
 * UA12.117 — a delete or extend from the Published pages list must reach an OPEN Pages view: the action pushes
 * `pages:changed` when it landed on a `page`-kind registry row (the view's share badge reads the row through
 * `LoadedPage.publication`), and none for a file row — a file is no page, nothing to refresh. The pushed copy is
 * `loadWorkspacePages` — the same one rpc/pages.ts's own mutations push — so the badge it carries is fresh.
 */
describe('UA12.117 — artifacts actions push pages:changed for page rows only', () => {
  // ids the real client accepts (ID_PATTERN, 6..64): current ones are 22 characters.
  const PAGE_ID = 'ZzYyXxWwVuUtSrQpOnMl'
  const FILE_ID = 'AaBbCcDdEeFfGgHhIiJj'

  function seedPageRow(id: string, page: { id: string; slug: string }): void {
    recordArtifactPublish(root, {
      record: { id, url: link(id), title: 'A page', expiresAt: '2026-10-09T00:00:00.000Z', retentionDays: 7 },
      sourceSessionId: '', sourcePath: `pages/${page.slug}`, contentDigest: 'b'.repeat(64),
      kind: 'page', page: { ...page, includesData: false },
    })
  }

  function seedFileRow(id: string): void {
    recordArtifactPublish(root, {
      record: { id, url: link(id), title: 'A file', expiresAt: '2026-10-09T00:00:00.000Z', retentionDays: 7 },
      sourceSessionId: 'session-1', sourcePath: 'out/q3.html', contentDigest: 'c'.repeat(64),
    })
  }

  const changedFor = (h: ReturnType<typeof harness>) => h.pushes.filter(push => push.channel === RPC_CHANNELS.pages.CHANGED)

  test('deleting a page-kind row pushes one pages:changed whose copy reads the row gone; a file-kind row pushes none', async () => {
    const page = createPage(root, { name: 'Shared page' })
    seedPageRow(PAGE_ID, { id: page.id, slug: page.slug })
    seedFileRow(FILE_ID)
    const service = fakeService({
      [`DELETE /api/artifacts/${PAGE_ID}`]: [{ status: 204 }],
      [`DELETE /api/artifacts/${FILE_ID}`]: [{ status: 204 }],
    })
    const h = harness({ service })

    await h.call<ArtifactDeleteResult>(RPC_CHANNELS.artifacts.DELETE, 'ws-a', { id: PAGE_ID, url: link(PAGE_ID) })
    const pushes = changedFor(h)
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.target).toEqual({ to: 'workspace', workspaceId: 'ws-a' })
    const pages = pushes[0]!.args[1] as Array<{ config: { slug: string }; publication?: unknown }>
    expect(pages.find(entry => entry.config.slug === page.slug)?.publication).toBeUndefined()

    // CONTROL — the row's second half: a file is no page, its delete refreshes nothing.
    await h.call<ArtifactDeleteResult>(RPC_CHANNELS.artifacts.DELETE, 'ws-a', { id: FILE_ID, url: link(FILE_ID) })
    expect(changedFor(h)).toHaveLength(1)
  })

  test('extending a page-kind row pushes one pages:changed; a file-kind row pushes none', async () => {
    const page = createPage(root, { name: 'Another page' })
    seedPageRow(PAGE_ID, { id: page.id, slug: page.slug })
    seedFileRow(FILE_ID)
    const service = fakeService({
      [`PATCH /api/artifacts/${PAGE_ID}`]: [{ status: 200, body: { id: PAGE_ID, url: link(PAGE_ID), title: 'A page', expires_at: null, retention_days: 0 } }],
      [`PATCH /api/artifacts/${FILE_ID}`]: [{ status: 200, body: { id: FILE_ID, url: link(FILE_ID), title: 'A file', expires_at: null, retention_days: 0 } }],
    })
    const h = harness({ service })

    await h.call<ArtifactActionResult>(RPC_CHANNELS.artifacts.SET_RETENTION, 'ws-a', PAGE_ID, 0)
    expect(changedFor(h)).toHaveLength(1)
    expect(changedFor(h)[0]!.args[0]).toBe('ws-a')

    await h.call<ArtifactActionResult>(RPC_CHANNELS.artifacts.SET_RETENTION, 'ws-a', FILE_ID, 0)
    expect(changedFor(h)).toHaveLength(1)
  })

  test('a refused delete pushes nothing', async () => {
    const page = createPage(root, { name: 'Third page' })
    seedPageRow(PAGE_ID, { id: page.id, slug: page.slug })
    const service = fakeService({ [`DELETE /api/artifacts/${PAGE_ID}`]: [{ status: 403 }] })
    const h = harness({ service })
    const result = await h.call<ArtifactDeleteResult>(RPC_CHANNELS.artifacts.DELETE, 'ws-a', { id: PAGE_ID, url: link(PAGE_ID) })
    expect(result.outcome).toBe('failed')
    expect(changedFor(h)).toEqual([])
  })
})
