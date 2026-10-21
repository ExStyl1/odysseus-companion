/**
 * UA6.4 — `rpc/pages.ts` (adapted from craft-agents-oss v0.13.4, Apache-2.0) driven through its registered handlers
 * over a real workspace root: what lands on disk and what is pushed is read back, never assumed.
 *
 * Positive: create → get / getOne / getContent / getData read it back; update and setContent change it; delete removes
 * the folder; a lease is bound to the digest of the exact content it returns and is released; every mutation pushes
 * `pages:changed` to the workspace and pokes the watcher.
 * Negative: a foreign workspace is refused (`pages-workspace-mismatch`) on EVERY channel and touches nothing; a
 * `refresh` on the wire is script CONTENT written by the host (UA8.2) — an upstream-shaped script PATH is refused and
 * writes nothing; a lease for a page with no content is refused; a traversal slug never becomes a path.
 *
 * UA7.4 — the poster channels. Positive: a create with content and every setContent enqueue a capture, and
 * getThumbnail serves a fresh poster as a JPEG data URL. Negative: a create without content enqueues nothing; a
 * missing or stale poster reads null; a traversal slug reads null and regenerates nothing; a foreign workspace is
 * refused on both channels.
 *
 * UA8.3 — the refresh channels (ours). Positive: the review names the host-written script and its digest; approving
 * that digest records the ledger entry and pokes the watcher; run-now runs an approved refresh and stamps lastRefresh.
 * Negative: run-now refuses an unapproved refresh; an approval naming a swapped digest is refused and records
 * nothing; a foreign workspace is refused on all three (the census arm above).
 *
 * UA9.3 — grants and actions (spec §15). Positive: describe returns the host-parsed descriptor (a script's sha256 of
 * its bytes now); issue records a ledger grant bound to the content on screen and pushes pages:changed; list reads it
 * back; a granted script runs through the per-workspace broker (lease, nonce, ledger grant, runApprovedScript) and its
 * run reaches the host's audit port; revoke removes it and the next call is refused. Negative: an issue against content
 * that moved since it was shown, or a script whose bytes moved from the sha256 shown, is refused and records nothing;
 * a script outside the workspace is refused at describe; with no host ports every action is executor-unavailable (fail
 * closed); an API grant on a source absent from the workspace capability view (disabled, managed-denied) is refused
 * before any request; a foreign workspace is refused on all six (the census arm above). The lease-only store UA6.4
 * shipped is gone — the broker's lease eviction and TTL are `action-bridge.test.ts`'s.
 * UA12.102 — the broker is built once, its annotation's source slugs are read per action. Positive: a source added
 * after the first action has its own endpoint rule applied to the next. Negative: before it exists the same POST asks;
 * the rule never reaches another source's grant.
 *
 * UA6.7 — publishing (t-artifacts; the chain itself is `pages/__tests__/page-publishing.test.ts`'s). Positive: the
 * review over the wire sends nothing; publishing the reviewed sha256 sends one POST and pushes pages:changed whose
 * page carries the publication; unpublish sends one DELETE; deleting a published page sends one DELETE first.
 * Negative: a foreign workspace is refused on all three (the census arm above); with no artifact client nothing is
 * published (the review answers, the publish answers `failed`).
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
import { computePageContentDigest, getPagePath, getPageThumbnailPath, loadPageConfig, recordPageThumbnail, type LoadedPage, type PageConfig, type PageRenderLease } from '@nessy-agent/shared/pages'
import { findHostApproval, setHostApprovalsKeyProvider } from '@nessy-agent/shared/approvals/host-approvals'
import type { WorkspaceService } from '@nessy-agent/shared/workspaces'
import type { HandlerFn, RequestContext, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { HANDLED_CHANNELS, readRefreshReview, registerPagesHandlers } from '../pages'
import { scriptSha256 } from '@nessy-agent/shared/automations'
import type { PageActionHostPorts } from '../../session-manager-interface'

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

function rig(tag: string, ports?: PageActionHostPorts, extra: Record<string, unknown> = {}, confirmDialog = true) {
  const root = mkdtempSync(join(tmpdir(), `ua6-4-rpc-${tag}-`))
  roots.push(root)
  const workspaceId = `ws-ua6-4-${tag}`
  const workspaceService = {
    resolve: (id: string) => {
      const workspaceRootPath = join(root, 'workspaces', id)
      mkdirSync(workspaceRootPath, { recursive: true })
      return { id, workspaceRootPath, sessionRootPath: join(root, 'sessions', id), config: { id, name: id, createdAt: 1, updatedAt: 1 }, lastAccessedAt: 1 }
    },
    listResolved: () => [],
  } as unknown as WorkspaceService
  const handlers = new Map<string, HandlerFn>()
  const pushes: Array<{ channel: string; target: unknown; args: unknown[] }> = []
  const notified: Array<[string, string]> = []
  const enqueued: string[][] = []
  const server = {
    handle(channel: string, handler: HandlerFn) { handlers.set(channel, handler) },
    push(channel: string, target: unknown, ...args: unknown[]) { pushes.push({ channel, target, args }) },
    async invokeClient() { return undefined },
    hasClientCapability() { return confirmDialog },
    findClientsWithCapability() { return [] },
  } as unknown as RpcServer
  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  registerPagesHandlers(server, {
    sessionManager: {
      notifyConfigFileChange: (ws: string, rel: string) => { notified.push([ws, rel]) },
      enqueuePageThumbnail: (ws: string, root: string, slug: string) => { enqueued.push([ws, root, slug]) },
      ...(ports ? { pageActionHostPorts: () => ports } : {}),
      ...extra,
    },
    workspaceService,
    platform: { logger },
  } as unknown as HandlerDeps)
  const ctx: RequestContext = { clientId: 'client-1', workspaceId, webContentsId: null }
  const call = <T>(channel: string, ...args: unknown[]): Promise<T> => Promise.resolve(handlers.get(channel)!(ctx, ...args) as T)
  const callAs = <T>(caller: string, channel: string, ...args: unknown[]): Promise<T> =>
    Promise.resolve(handlers.get(channel)!({ ...ctx, workspaceId: caller }, ...args) as T)
  const wsRoot = join(root, 'workspaces', workspaceId)
  return { workspaceId, wsRoot, call, callAs, handlers, pushes, notified, enqueued }
}

describe('UA6.4 — pages RPC core', () => {
  it('registers exactly its ten core channels, the two poster channels (UA7.4), the three refresh channels (UA8.3), the six grant/action channels plus the refusal-audit channel (UA9.3, UA12.112) and the three publishing channels (UA6.7); pages:changed is a push, not a handler', () => {
    const { handlers } = rig('census')
    expect([...handlers.keys()].sort()).toEqual([...HANDLED_CHANNELS].sort())
    expect(HANDLED_CHANNELS).toHaveLength(25)
    expect(HANDLED_CHANNELS as readonly string[]).not.toContain(RPC_CHANNELS.pages.CHANGED)
  })

  it('CRUD round-trips through real storage, and every mutation pushes pages:changed and pokes the watcher', async () => {
    const { call, workspaceId, wsRoot, pushes, notified } = rig('crud')
    const created = await call<PageConfig>(RPC_CHANNELS.pages.CREATE, workspaceId, { name: '  Build Health ', kind: 'live', content: '<p>v1</p>' })
    expect(created.slug).toBe('build-health')
    expect(created.name).toBe('Build Health')
    expect(created.contentDigest).toBe(computePageContentDigest('<p>v1</p>'))

    const listed = await call<LoadedPage[]>(RPC_CHANNELS.pages.GET, workspaceId)
    expect(listed.map(page => page.config.slug)).toEqual(['build-health'])
    expect((await call<LoadedPage>(RPC_CHANNELS.pages.GET_ONE, workspaceId, created.id))?.config.slug).toBe('build-health')
    expect(await call<{ content: string | null; contentDigest?: string }>(RPC_CHANNELS.pages.GET_CONTENT, workspaceId, 'build-health'))
      .toEqual({ content: '<p>v1</p>', contentDigest: created.contentDigest })
    expect(await call(RPC_CHANNELS.pages.GET_DATA, workspaceId, 'build-health')).toBeNull()

    const updated = await call<PageConfig>(RPC_CHANNELS.pages.UPDATE, workspaceId, 'build-health', { name: 'Build Health v2', description: null })
    expect(updated.name).toBe('Build Health v2')
    const rewritten = await call<PageConfig>(RPC_CHANNELS.pages.SET_CONTENT, workspaceId, 'build-health', '<p>v2</p>')
    expect(rewritten.contentDigest).toBe(computePageContentDigest('<p>v2</p>'))

    expect(await call<{ publicCopyMayRemain: boolean }>(RPC_CHANNELS.pages.DELETE, workspaceId, 'build-health')).toEqual({ publicCopyMayRemain: false })
    expect(existsSync(getPagePath(wsRoot, 'build-health'))).toBe(false)

    const changed = pushes.filter(push => push.channel === RPC_CHANNELS.pages.CHANGED)
    expect(changed).toHaveLength(4)
    for (const push of changed) {
      expect(push.target).toEqual({ to: 'workspace', workspaceId })
      expect(push.args[0]).toBe(workspaceId)
    }
    expect((changed[0]!.args[1] as LoadedPage[]).map(page => page.config.slug)).toEqual(['build-health'])
    expect(changed[3]!.args[1]).toEqual([])
    expect(notified).toEqual(Array.from({ length: 4 }, () => [workspaceId, 'pages/build-health/page.json']))
  })

  it('a lease is bound to the digest of the exact content it returns, and release drops it', async () => {
    const { call, workspaceId } = rig('lease')
    await call(RPC_CHANNELS.pages.CREATE, workspaceId, { name: 'Leased', content: '<p>render me</p>' })
    const { lease, content } = await call<{ lease: PageRenderLease; content: string }>(RPC_CHANNELS.pages.CREATE_LEASE, workspaceId, 'leased')
    expect(content).toBe('<p>render me</p>')
    expect(lease.pageSlug).toBe('leased')
    expect(lease.contentDigest).toBe(computePageContentDigest(content))
    expect(lease.nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(lease.expiresAt).toBeGreaterThan(lease.issuedAt)
    const second = await call<{ lease: PageRenderLease }>(RPC_CHANNELS.pages.CREATE_LEASE, workspaceId, 'leased')
    expect(second.lease.leaseId).not.toBe(lease.leaseId)
    expect(second.lease.nonce).not.toBe(lease.nonce)
    expect(await call(RPC_CHANNELS.pages.RELEASE_LEASE, workspaceId, lease.leaseId)).toBeUndefined()
    // Negative: no content, no lease.
    await call(RPC_CHANNELS.pages.CREATE, workspaceId, { name: 'Empty' })
    await expect(call(RPC_CHANNELS.pages.CREATE_LEASE, workspaceId, 'empty')).rejects.toThrow('Page has no content: empty')
  })

  it('a foreign workspace is refused on EVERY channel and nothing is read, written or pushed', async () => {
    const { call, callAs, workspaceId, wsRoot, pushes, notified, enqueued } = rig('foreign')
    await call(RPC_CHANNELS.pages.CREATE, workspaceId, { name: 'Mine', content: '<p>x</p>' })
    pushes.length = 0
    notified.length = 0
    enqueued.length = 0
    const argsFor: Record<string, unknown[]> = {
      [RPC_CHANNELS.pages.GET]: [],
      [RPC_CHANNELS.pages.GET_ONE]: ['mine'],
      [RPC_CHANNELS.pages.CREATE]: [{ name: 'Intruder', content: '<p>x</p>' }],
      [RPC_CHANNELS.pages.UPDATE]: ['mine', { name: 'Hijacked' }],
      [RPC_CHANNELS.pages.DELETE]: ['mine'],
      [RPC_CHANNELS.pages.GET_CONTENT]: ['mine'],
      [RPC_CHANNELS.pages.SET_CONTENT]: ['mine', '<p>pwned</p>'],
      [RPC_CHANNELS.pages.GET_DATA]: ['mine'],
      [RPC_CHANNELS.pages.CREATE_LEASE]: ['mine'],
      [RPC_CHANNELS.pages.RELEASE_LEASE]: ['lease-id'],
      [RPC_CHANNELS.pages.GET_THUMBNAIL]: ['mine'],
      [RPC_CHANNELS.pages.REGENERATE_THUMBNAIL]: ['mine'],
      [RPC_CHANNELS.pages.GET_REFRESH_STATUS]: ['mine'], // UA8.3
      [RPC_CHANNELS.pages.APPROVE_REFRESH]: ['mine', 'f'.repeat(64)], // UA8.3
      [RPC_CHANNELS.pages.RUN_REFRESH_NOW]: ['mine'], // UA8.3
      [RPC_CHANNELS.pages.LIST_GRANTS]: ['mine'], // UA9.3
      [RPC_CHANNELS.pages.DESCRIBE_GRANT_REQUEST]: ['mine', { kind: 'mcp', sourceSlug: 's', toolName: 't' }], // UA9.3
      [RPC_CHANNELS.pages.ISSUE_GRANT]: ['mine', { action: { kind: 'mcp', sourceSlug: 's', toolName: 't' }, contentDigest: 'f'.repeat(64) }], // UA9.3
      [RPC_CHANNELS.pages.REVOKE_GRANT]: ['mine', 'grant_x'], // UA9.3
      [RPC_CHANNELS.pages.EXECUTE_ACTION]: [{ requestId: 'r', pageSlug: 'mine', leaseId: 'l', nonce: 'n', grantId: 'g', invocation: { kind: 'script' } }], // UA9.3
      [RPC_CHANNELS.pages.CANCEL_ACTION]: ['r'], // UA9.3
      [RPC_CHANNELS.pages.AUDIT_REFUSAL]: [{ kind: 'action', pageSlug: 'mine', code: 'frame-focus-required' }], // UA12.112
      [RPC_CHANNELS.pages.GET_SHARE_DATA_SCAN]: ['mine', { includeData: false }], // UA6.7
      [RPC_CHANNELS.pages.PUBLISH]: ['mine', { includeData: false, reviewedSha256: 'f'.repeat(64) }], // UA6.7
      [RPC_CHANNELS.pages.UNPUBLISH]: ['mine'], // UA6.7
    }
    expect(Object.keys(argsFor).sort()).toEqual([...HANDLED_CHANNELS].sort())
    for (const channel of HANDLED_CHANNELS) {
      // The caller is bound to another workspace and names this one …
      await expect(callAs('ws-elsewhere', channel, workspaceId, ...argsFor[channel]!)).rejects.toThrow('pages-workspace-mismatch')
    }
    const page = JSON.parse(readFileSync(join(getPagePath(wsRoot, 'mine'), 'page.json'), 'utf-8')) as PageConfig
    expect(page.name).toBe('Mine')
    expect(readFileSync(join(getPagePath(wsRoot, 'mine'), 'index.html'), 'utf-8')).toBe('<p>x</p>')
    expect(existsSync(getPagePath(wsRoot, 'intruder'))).toBe(false)
    expect(pushes).toEqual([])
    expect(notified).toEqual([])
    expect(enqueued).toEqual([])
    // … and a caller with no workspace at all is refused too.
    await expect(callAs('', RPC_CHANNELS.pages.GET, workspaceId)).rejects.toThrow('pages-workspace-mismatch')
  })

  it('UA8.2: a wire refresh is script content the host writes; a script PATH is refused and writes nothing', async () => {
    const { call, workspaceId, wsRoot } = rig('refresh')
    const path = { cron: '*/15 * * * *', script: 'scripts/x.ts' }
    await expect(call(RPC_CHANNELS.pages.CREATE, workspaceId, { name: 'No Refresh', refresh: path })).rejects.toThrow('Invalid refresh')
    expect(existsSync(getPagePath(wsRoot, 'no-refresh'))).toBe(false)
    await call(RPC_CHANNELS.pages.CREATE, workspaceId, { name: 'No Refresh' })
    await expect(call(RPC_CHANNELS.pages.UPDATE, workspaceId, 'no-refresh', { description: 'not kept', refresh: path })).rejects.toThrow('Invalid refresh')
    let onDisk = JSON.parse(readFileSync(join(getPagePath(wsRoot, 'no-refresh'), 'page.json'), 'utf-8')) as Record<string, unknown>
    expect([onDisk.description, 'refresh' in onDisk]).toEqual([undefined, false])

    await call(RPC_CHANNELS.pages.UPDATE, workspaceId, 'no-refresh', { description: 'kept', refresh: { cron: '*/15 * * * *', scriptContent: 'console.log(1)' } })
    onDisk = JSON.parse(readFileSync(join(getPagePath(wsRoot, 'no-refresh'), 'page.json'), 'utf-8')) as Record<string, unknown>
    expect(onDisk.description).toBe('kept')
    expect((onDisk.refresh as { script?: string }).script).toBe('pages/no-refresh/refresh.ts')
    expect(readFileSync(join(getPagePath(wsRoot, 'no-refresh'), 'refresh.ts'), 'utf-8')).toBe('console.log(1)')
    await call(RPC_CHANNELS.pages.UPDATE, workspaceId, 'no-refresh', { refresh: null })
    expect(existsSync(join(getPagePath(wsRoot, 'no-refresh'), 'refresh.ts'))).toBe(false)
  })

  it('a traversal slug never becomes a path', async () => {
    const { call, workspaceId } = rig('traversal')
    expect(await call(RPC_CHANNELS.pages.GET_ONE, workspaceId, '../../etc')).toBeNull()
    expect(await call<{ content: string | null; contentDigest?: string }>(RPC_CHANNELS.pages.GET_CONTENT, workspaceId, '..')).toEqual({ content: null, contentDigest: undefined })
    await expect(call(RPC_CHANNELS.pages.UPDATE, workspaceId, '../x', { name: 'x' })).rejects.toThrow('Page not found')
    await expect(call(RPC_CHANNELS.pages.DELETE, workspaceId, '../..')).rejects.toThrow()
  })
})

describe('UA7.4 — the poster channels', () => {
  it('a create with content and every setContent enqueue a capture; a create without content does not', async () => {
    const { call, workspaceId, wsRoot, enqueued } = rig('enqueue')
    await call(RPC_CHANNELS.pages.CREATE, workspaceId, { name: 'Empty' })
    expect(enqueued).toEqual([])
    await call(RPC_CHANNELS.pages.CREATE, workspaceId, { name: 'Drawn', content: '<p>v1</p>' })
    expect(enqueued).toEqual([[workspaceId, wsRoot, 'drawn']])
    await call(RPC_CHANNELS.pages.UPDATE, workspaceId, 'drawn', { name: 'Drawn v2' })
    expect(enqueued).toHaveLength(1)
    await call(RPC_CHANNELS.pages.SET_CONTENT, workspaceId, 'empty', '<p>now</p>')
    expect(enqueued).toEqual([[workspaceId, wsRoot, 'drawn'], [workspaceId, wsRoot, 'empty']])
  })

  it('getThumbnail serves a fresh poster as a JPEG data URL, and null when it is missing or stale', async () => {
    const { call, workspaceId, wsRoot } = rig('poster')
    const created = await call<PageConfig>(RPC_CHANNELS.pages.CREATE, workspaceId, { name: 'Poster', content: '<p>v1</p>' })
    expect(await call(RPC_CHANNELS.pages.GET_THUMBNAIL, workspaceId, 'poster')).toBeNull()
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    writeFileSync(getPageThumbnailPath(wsRoot, 'poster'), jpeg)
    recordPageThumbnail(wsRoot, 'poster', { digest: created.contentDigest!, capturedAt: 1, width: 800, height: 500 })
    expect(await call<{ dataUrl: string; digest: string } | null>(RPC_CHANNELS.pages.GET_THUMBNAIL, workspaceId, 'poster'))
      .toEqual({ dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`, digest: created.contentDigest! })
    // A content change leaves the pointer but makes it stale.
    await call(RPC_CHANNELS.pages.SET_CONTENT, workspaceId, 'poster', '<p>v2</p>')
    expect(await call(RPC_CHANNELS.pages.GET_THUMBNAIL, workspaceId, 'poster')).toBeNull()
  })

  it('regenerateThumbnail enqueues one capture for a page slug, and nothing for a traversal slug', async () => {
    const { call, workspaceId, wsRoot, enqueued } = rig('regen')
    expect(await call<boolean>(RPC_CHANNELS.pages.REGENERATE_THUMBNAIL, workspaceId, 'some-page')).toBe(true)
    expect(enqueued).toEqual([[workspaceId, wsRoot, 'some-page']])
    expect(await call<boolean>(RPC_CHANNELS.pages.REGENERATE_THUMBNAIL, workspaceId, '../../etc')).toBe(false)
    expect(await call(RPC_CHANNELS.pages.GET_THUMBNAIL, workspaceId, '../../etc')).toBeNull()
    expect(enqueued).toHaveLength(1)
  })
})

describe('UA8.3 — the refresh review, approval and run-now channels (ours; spec §15)', () => {
  const KEY = Buffer.alloc(32, 7)
  afterAll(() => setHostApprovalsKeyProvider(undefined))

  async function pageWithRefresh(tag: string) {
    setHostApprovalsKeyProvider({ getKey: async () => KEY })
    const r = rig(tag)
    await r.call(RPC_CHANNELS.pages.CREATE, r.workspaceId, {
      name: 'Refreshed',
      refresh: { cron: '*/15 * * * *', scriptContent: "require('node:fs').writeFileSync('ran.txt', 'x')" },
    })
    return r
  }

  it('positive: the review names the host-written script and its digest; approving that digest records a ledger entry and pokes the watcher; run-now runs it and stamps lastRefresh', async () => {
    const { call, workspaceId, wsRoot, notified } = await pageWithRefresh('refresh-ok')
    const review = await call<{ state: string; script: string; sha256: string; content: string }>(RPC_CHANNELS.pages.GET_REFRESH_STATUS, workspaceId, 'refreshed')
    expect(review.state).toBe('unapproved')
    expect(review.script).toBe('pages/refreshed/refresh.ts')
    expect(review.content).toContain('ran.txt')
    // Unapproved: run-now refuses and runs nothing.
    const refused = await call<{ started: boolean; error?: string }>(RPC_CHANNELS.pages.RUN_REFRESH_NOW, workspaceId, 'refreshed')
    expect(refused.started).toBe(false)
    expect(refused.error).toContain('not approved')

    notified.length = 0
    const approval = await call<{ state: string }>(RPC_CHANNELS.pages.APPROVE_REFRESH, workspaceId, 'refreshed', review.sha256)
    expect(approval.state).toBe('approved')
    expect(findHostApproval(wsRoot, KEY, 'refresh-approval', 'page:refreshed')?.digest).toBe(review.sha256)
    expect(notified).toEqual([[workspaceId, 'pages/refreshed/refresh.ts']])

    expect(await call<{ started: boolean }>(RPC_CHANNELS.pages.RUN_REFRESH_NOW, workspaceId, 'refreshed')).toEqual({ started: true })
    for (let i = 0; i < 200 && !(loadPageConfig(wsRoot, 'refreshed')?.lastRefresh); i += 1) await new Promise(resolve => setTimeout(resolve, 50))
    expect(loadPageConfig(wsRoot, 'refreshed')?.lastRefresh?.ok).toBe(true)
    expect(existsSync(join(wsRoot, 'ran.txt'))).toBe(true)
  })

  it('negative: an approval naming a digest other than the current bytes is refused and records nothing', async () => {
    const { call, workspaceId, wsRoot } = await pageWithRefresh('refresh-swap')
    const review = await call<{ sha256: string }>(RPC_CHANNELS.pages.GET_REFRESH_STATUS, workspaceId, 'refreshed')
    writeFileSync(join(getPagePath(wsRoot, 'refreshed'), 'refresh.ts'), 'console.log("swapped")')
    await expect(call(RPC_CHANNELS.pages.APPROVE_REFRESH, workspaceId, 'refreshed', review.sha256)).rejects.toThrow('changed while it was being reviewed')
    expect(findHostApproval(wsRoot, KEY, 'refresh-approval', 'page:refreshed')).toBeUndefined()
  })

  // UA8.3 follow-up: the review's digest and its shown text come from ONE read, so a file swapped between the state
  // read and the text read can never show bytes A beside sha256(B) for the person to approve.
  it('boundary: a script swapped between the state read and the text read is reviewed as the bytes shown (sha256 of the returned content)', async () => {
    const { wsRoot } = await pageWithRefresh('refresh-race-once')
    const scriptPath = join(getPagePath(wsRoot, 'refreshed'), 'refresh.ts')
    let swapped = false
    const swapOnce = (path: string): Buffer => {
      if (!swapped) { swapped = true; writeFileSync(scriptPath, 'console.log("M")') }
      return readFileSync(path)
    }
    const review = await readRefreshReview(wsRoot, KEY, loadPageConfig(wsRoot, 'refreshed')!, swapOnce)
    expect(swapped).toBe(true)
    expect(review.content).toBe('console.log("M")')
    expect(review.sha256).toBe(scriptSha256(Buffer.from(review.content!, 'utf-8')))
    expect(review.state).toBe('unapproved')
  })

  it('negative: a script that keeps changing under the review is refused, never reviewed with a digest of other bytes', async () => {
    const { wsRoot } = await pageWithRefresh('refresh-race-flip')
    const scriptPath = join(getPagePath(wsRoot, 'refreshed'), 'refresh.ts')
    let flips = 0
    const flipEvery = (path: string): Buffer => {
      flips += 1
      writeFileSync(scriptPath, `console.log(${flips})`)
      return readFileSync(path)
    }
    await expect(readRefreshReview(wsRoot, KEY, loadPageConfig(wsRoot, 'refreshed')!, flipEvery)).rejects.toThrow('kept changing')
    expect(flips).toBeGreaterThan(1)
  })

  // UA8.3 follow-up 2: the approval binds `{ path, sha256, args, runtime }` (spec §15 item 3), so the review shows the
  // args and runtime too, and an Approve names the binding it showed — an args-only change (same bytes, same sha256)
  // between the review and the click is refused like a byte swap.
  it('positive: the review carries the args and runtime the approval binds; approving the shown binding records them', async () => {
    const { call, workspaceId, wsRoot } = await pageWithRefresh('refresh-args-ok')
    await call(RPC_CHANNELS.pages.UPDATE, workspaceId, 'refreshed', {
      refresh: { cron: '*/15 * * * *', scriptContent: "require('node:fs').writeFileSync('ran.txt', 'x')", args: ['--seen'] },
    })
    const review = await call<{ sha256: string; args?: string[]; runtime?: string }>(RPC_CHANNELS.pages.GET_REFRESH_STATUS, workspaceId, 'refreshed')
    expect(review.args).toEqual(['--seen'])
    expect(review.runtime).toBe('bun')
    const approval = await call<{ state: string }>(RPC_CHANNELS.pages.APPROVE_REFRESH, workspaceId, 'refreshed', review.sha256, { args: review.args, runtime: review.runtime })
    expect(approval.state).toBe('approved')
    expect(findHostApproval(wsRoot, KEY, 'refresh-approval', 'page:refreshed')?.data).toEqual({ path: 'pages/refreshed/refresh.ts', args: ['--seen'], runtime: 'bun' })
  })

  it('boundary: args changed between the review and Approve (same bytes, same sha256) are refused and record nothing', async () => {
    const { call, workspaceId, wsRoot } = await pageWithRefresh('refresh-args-swap')
    const review = await call<{ sha256: string; args?: string[]; runtime?: string }>(RPC_CHANNELS.pages.GET_REFRESH_STATUS, workspaceId, 'refreshed')
    expect(review.args).toEqual([])
    await call(RPC_CHANNELS.pages.UPDATE, workspaceId, 'refreshed', {
      refresh: { cron: '*/15 * * * *', scriptContent: "require('node:fs').writeFileSync('ran.txt', 'x')", args: ['https://unseen.invalid/x'] },
    })
    const after = await call<{ sha256: string }>(RPC_CHANNELS.pages.GET_REFRESH_STATUS, workspaceId, 'refreshed')
    expect(after.sha256).toBe(review.sha256) // the bytes did not move — only the binding did
    await expect(call(RPC_CHANNELS.pages.APPROVE_REFRESH, workspaceId, 'refreshed', review.sha256, { args: review.args, runtime: review.runtime }))
      .rejects.toThrow('changed while it was being reviewed')
    expect(findHostApproval(wsRoot, KEY, 'refresh-approval', 'page:refreshed')).toBeUndefined()
  })
})

describe('UA9.3 — grants (the host-approvals ledger) and actions (the per-workspace broker)', () => {
  const KEY = Buffer.alloc(32, 9)
  afterAll(() => setHostApprovalsKeyProvider(undefined))

  /** Host ports whose MCP/capability seams are never reached by a script or a refused API call. */
  function scriptPorts(audit: Array<[string, Record<string, unknown>]>): PageActionHostPorts {
    const snapshot = { entries: [], installedPlugins: [], leaseId: 'lease-ua9-3' }
    return {
      registry: { lease: () => { throw new Error('the MCP pool is not part of this test') } },
      resolver: {
        resolve: async () => snapshot,
        releaseSnapshot: () => {},
        isLeaseActive: () => true,
      } as unknown as PageActionHostPorts['resolver'],
      resolveCredential: () => { throw new Error('no credentials in this test') },
      audit: (event, payload) => { audit.push([event, payload]) },
    }
  }

  /**
   * UA12.64 — host ports whose workspace view names one MCP source under a WIRE name that
   * differs from its config slug (`my server.v2` → `my_server_v2`, the resolver's own F3
   * specimen); the pool lease stub is never reached, because the annotation is the subject.
   */
  function mcpWirePorts(audit: Array<[string, Record<string, unknown>]>): PageActionHostPorts {
    const scope = { kind: 'workspace', workspaceId: 'ws-ua12-64' }
    const snapshot = {
      entries: [{
        summary: {
          key: 'native:workspace:source:my server.v2',
          kind: 'source',
          logicalName: 'my server.v2',
          origin: 'native',
          scope,
          enabled: true,
          selectedAsUnqualifiedAlias: true,
          readOnly: false,
          trustState: 'not-required',
          credentialState: 'not-required',
          diagnostics: [],
        },
        runtimeBinding: {
          kind: 'source',
          mcpWireName: 'my_server_v2',
          resource: { source: 'workspace', scope, resourceId: 'source:my server.v2', absolutePath: '/unused/source.json', revision: '1', contentHash: 'hash' },
        },
      }],
      installedPlugins: [],
      leaseId: 'lease-ua12-64',
    }
    return {
      registry: { lease: () => { throw new Error('the MCP pool is not part of this test') } },
      resolver: {
        resolve: async () => snapshot,
        releaseSnapshot: () => {},
        isLeaseActive: () => true,
      } as unknown as PageActionHostPorts['resolver'],
      resolveCredential: () => { throw new Error('no credentials in this test') },
      audit: (event, payload) => { audit.push([event, payload]) },
    }
  }

  async function pageWithScript(tag: string, ports?: PageActionHostPorts) {
    setHostApprovalsKeyProvider({ getKey: async () => KEY })
    const r = rig(tag, ports)
    await r.call(RPC_CHANNELS.pages.CREATE, r.workspaceId, { name: 'Acts', kind: 'interactive', content: '<button>go</button>' })
    mkdirSync(join(r.wsRoot, 'scripts'), { recursive: true })
    writeFileSync(join(r.wsRoot, 'scripts', 'hello.ts'), "console.log('hello from the page')")
    return r
  }

  const scriptAction = { kind: 'script' as const, script: 'scripts/hello.ts' }

  it('positive: describe → issue → list → act (the script runs through the broker and is audited) → revoke → refused', async () => {
    const audit: Array<[string, Record<string, unknown>]> = []
    const { call, workspaceId, wsRoot, pushes } = await pageWithScript('grant-flow', scriptPorts(audit))
    const described = await call<{ action: unknown; scriptSha256: string }>(RPC_CHANNELS.pages.DESCRIBE_GRANT_REQUEST, workspaceId, 'acts', scriptAction)
    expect(described.action).toEqual(scriptAction)
    expect(described.scriptSha256).toMatch(/^[0-9a-f]{64}$/)

    const { lease, content } = await call<{ lease: PageRenderLease; content: string }>(RPC_CHANNELS.pages.CREATE_LEASE, workspaceId, 'acts')
    pushes.length = 0
    const grant = await call<{ id: string; contentDigest: string; scriptSha256?: string }>(RPC_CHANNELS.pages.ISSUE_GRANT, workspaceId, 'acts', {
      action: scriptAction,
      description: 'Say hello',
      contentDigest: computePageContentDigest(content),
      scriptSha256: described.scriptSha256,
    })
    expect(grant.contentDigest).toBe(lease.contentDigest)
    expect(grant.scriptSha256).toBe(described.scriptSha256)
    expect(findHostApproval(wsRoot, KEY, 'page-grant', `page:acts#${grant.id}`)?.digest).toBe(described.scriptSha256)
    expect(pushes.filter(push => push.channel === RPC_CHANNELS.pages.CHANGED)).toHaveLength(1)
    // page.json never carries it.
    expect(JSON.parse(readFileSync(join(getPagePath(wsRoot, 'acts'), 'page.json'), 'utf-8')).grants).toBeUndefined()
    expect((await call<Array<{ id: string }>>(RPC_CHANNELS.pages.LIST_GRANTS, workspaceId, 'acts')).map(g => g.id)).toEqual([grant.id])

    const request = (requestId: string) => ({ requestId, pageSlug: 'acts', leaseId: lease.leaseId, nonce: lease.nonce, grantId: grant.id, invocation: { kind: 'script' } })
    const ran = await call<{ ok: boolean; body?: { stdout?: string }; error?: string }>(RPC_CHANNELS.pages.EXECUTE_ACTION, workspaceId, request('r-1'))
    expect(ran.error).toBeUndefined()
    expect(ran.ok).toBe(true)
    expect(ran.body?.stdout).toContain('hello from the page')
    expect(audit.map(([event]) => event).length).toBeGreaterThan(0)
    expect(audit.every(([, payload]) => payload.trigger === undefined || payload.trigger === 'page-action')).toBe(true)

    expect(await call<boolean>(RPC_CHANNELS.pages.REVOKE_GRANT, workspaceId, 'acts', grant.id)).toBe(true)
    expect(await call<unknown[]>(RPC_CHANNELS.pages.LIST_GRANTS, workspaceId, 'acts')).toEqual([])
    const refused = await call<{ ok: boolean; error?: string }>(RPC_CHANNELS.pages.EXECUTE_ACTION, workspaceId, request('r-2'))
    expect(refused.ok).toBe(false)
    expect(refused.error).toStartWith('grant-not-found:')
  }, 30_000)

  it('negative: an issue against moved content or moved script bytes is refused and records nothing; an escaping script is refused at describe', async () => {
    const { call, workspaceId, wsRoot } = await pageWithScript('grant-moved')
    const described = await call<{ scriptSha256: string }>(RPC_CHANNELS.pages.DESCRIBE_GRANT_REQUEST, workspaceId, 'acts', scriptAction)
    const { content } = await call<{ content: string }>(RPC_CHANNELS.pages.CREATE_LEASE, workspaceId, 'acts')
    const shown = computePageContentDigest(content)

    // The page changed after it asked.
    await call(RPC_CHANNELS.pages.SET_CONTENT, workspaceId, 'acts', '<button>other</button>')
    await expect(call(RPC_CHANNELS.pages.ISSUE_GRANT, workspaceId, 'acts', { action: scriptAction, contentDigest: shown, scriptSha256: described.scriptSha256 }))
      .rejects.toThrow('content-changed')
    // The script changed after the dialog showed its sha256.
    const now = computePageContentDigest('<button>other</button>')
    writeFileSync(join(wsRoot, 'scripts', 'hello.ts'), "console.log('swapped')")
    await expect(call(RPC_CHANNELS.pages.ISSUE_GRANT, workspaceId, 'acts', { action: scriptAction, contentDigest: now, scriptSha256: described.scriptSha256 }))
      .rejects.toThrow('grant-script-changed')
    expect(await call<unknown[]>(RPC_CHANNELS.pages.LIST_GRANTS, workspaceId, 'acts')).toEqual([])
    // Control: the same issue with the current digests is accepted.
    const fresh = await call<{ scriptSha256: string }>(RPC_CHANNELS.pages.DESCRIBE_GRANT_REQUEST, workspaceId, 'acts', scriptAction)
    await call(RPC_CHANNELS.pages.ISSUE_GRANT, workspaceId, 'acts', { action: scriptAction, contentDigest: now, scriptSha256: fresh.scriptSha256 })
    expect(await call<unknown[]>(RPC_CHANNELS.pages.LIST_GRANTS, workspaceId, 'acts')).toHaveLength(1)

    for (const script of ['../outside.ts', '/etc/hosts', 'scripts/missing.ts']) {
      await expect(call(RPC_CHANNELS.pages.DESCRIBE_GRANT_REQUEST, workspaceId, 'acts', { kind: 'script', script })).rejects.toThrow()
    }
  })

  it('negative: with no host ports every action answers executor-unavailable (fail closed); leases still work', async () => {
    const { call, workspaceId } = await pageWithScript('no-ports')
    const described = await call<{ scriptSha256: string }>(RPC_CHANNELS.pages.DESCRIBE_GRANT_REQUEST, workspaceId, 'acts', scriptAction)
    const { lease, content } = await call<{ lease: PageRenderLease; content: string }>(RPC_CHANNELS.pages.CREATE_LEASE, workspaceId, 'acts')
    const grant = await call<{ id: string }>(RPC_CHANNELS.pages.ISSUE_GRANT, workspaceId, 'acts', {
      action: scriptAction, contentDigest: computePageContentDigest(content), scriptSha256: described.scriptSha256,
    })
    const result = await call<{ ok: boolean; error?: string }>(RPC_CHANNELS.pages.EXECUTE_ACTION, workspaceId, {
      requestId: 'r', pageSlug: 'acts', leaseId: lease.leaseId, nonce: lease.nonce, grantId: grant.id, invocation: { kind: 'script' },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toStartWith('executor-unavailable:')
  })

  it('negative: an API grant on a source absent from the workspace capability view is refused before any request', async () => {
    const audit: Array<[string, Record<string, unknown>]> = []
    const { call, workspaceId, wsRoot } = await pageWithScript('api-view', scriptPorts(audit))
    mkdirSync(join(wsRoot, 'sources', 'weather'), { recursive: true })
    writeFileSync(join(wsRoot, 'sources', 'weather', 'config.json'), JSON.stringify({
      id: 'weather_1', name: 'Weather', slug: 'weather', enabled: true, provider: 'custom', type: 'api',
      api: { baseUrl: 'http://127.0.0.1:9', authType: 'none' },
    }))
    const api = { kind: 'api' as const, sourceSlug: 'weather', method: 'GET' as const, pathPattern: '/today' }
    const { lease, content } = await call<{ lease: PageRenderLease; content: string }>(RPC_CHANNELS.pages.CREATE_LEASE, workspaceId, 'acts')
    const grant = await call<{ id: string }>(RPC_CHANNELS.pages.ISSUE_GRANT, workspaceId, 'acts', { action: api, contentDigest: computePageContentDigest(content) })
    const act = (requestId: string) => call<{ ok: boolean; error?: string }>(RPC_CHANNELS.pages.EXECUTE_ACTION, workspaceId, {
      requestId, pageSlug: 'acts', leaseId: lease.leaseId, nonce: lease.nonce, grantId: grant.id, invocation: { kind: 'api', method: 'GET', path: '/today' },
    })
    const refused = await act('r-1')
    expect(refused.ok).toBe(false)
    expect(refused.error).toContain('is not available to this workspace (disabled or blocked by policy)')
    // Control: a source missing from disk fails earlier, with its own reason — the view gate is what refused above.
    rmSync(join(wsRoot, 'sources', 'weather'), { recursive: true, force: true })
    expect((await act('r-2')).error).toContain('API source not found: weather')
  })

  // UA12.64 — the annotation, end to end through the wired host: the broker's MCP policy
  // decision must equal what the hook answers for the name the pool registers
  // (`mcp__<wire>__<tool>`), so `buildBroker` resolves the wire name from the SAME workspace
  // view the executors ask. The executor refuses afterwards (the source exists nowhere on
  // disk) — the annotation runs before it and is audited regardless.
  it('UA12.64: the MCP annotation is audited under the wire name the view mints, not the config slug', async () => {
    const audit: Array<[string, Record<string, unknown>]> = []
    const { call, workspaceId, wsRoot } = await pageWithScript('mcp-wire', mcpWirePorts(audit))
    writeFileSync(join(wsRoot, 'permissions.json'), JSON.stringify({ allowedMcpPatterns: ['^mcp__my_server_v2__'] }))
    const mcp = { kind: 'mcp' as const, sourceSlug: 'my server.v2', toolName: 'preview_render' }
    const { lease, content } = await call<{ lease: PageRenderLease; content: string }>(RPC_CHANNELS.pages.CREATE_LEASE, workspaceId, 'acts')
    const grant = await call<{ id: string }>(RPC_CHANNELS.pages.ISSUE_GRANT, workspaceId, 'acts', { action: mcp, contentDigest: computePageContentDigest(content) })
    const result = await call<{ ok: boolean; error?: string }>(RPC_CHANNELS.pages.EXECUTE_ACTION, workspaceId, {
      requestId: 'r-wire-1', pageSlug: 'acts', leaseId: lease.leaseId, nonce: lease.nonce, grantId: grant.id,
      invocation: { kind: 'mcp', toolName: 'preview_render', args: {} },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not found in this workspace')
    // The broker's own jsonl audit (its CONFIG_DIR default here) carries the decision; fire-and-forget, so poll bounded.
    const auditPath = join(CONFIG_DIR, 'logs', 'page-actions.jsonl')
    let row: Record<string, unknown> | undefined
    for (let attempt = 0; attempt < 100 && !row; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      if (!existsSync(auditPath)) continue
      row = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean)
        .map(l => JSON.parse(l) as Record<string, unknown>)
        .find(e => e.event === 'page_action_executed' && e.requestId === 'r-wire-1')
    }
    expect(row?.policyDecision).toBe('allow')
  })

  // UA12.102 — the broker is built once per workspace, but the source slugs its policy annotation
  // merges are read per ACTION: a source added after the broker's first action has its own
  // `permissions.json` endpoint rule applied to the next action, without a restart. The executor
  // refuses both calls (the empty capability view), the annotation runs before it and is audited.
  it('UA12.102: a source added after the first action has its source-level endpoint rule applied to the next action', async () => {
    const { call, workspaceId, wsRoot } = await pageWithScript('late-source', scriptPorts([]))
    const api = { kind: 'api' as const, sourceSlug: 'tracker', method: 'POST' as const, pathPattern: '/issues' }
    const { lease, content } = await call<{ lease: PageRenderLease; content: string }>(RPC_CHANNELS.pages.CREATE_LEASE, workspaceId, 'acts')
    const grant = await call<{ id: string }>(RPC_CHANNELS.pages.ISSUE_GRANT, workspaceId, 'acts', { action: api, contentDigest: computePageContentDigest(content) })
    const act = (requestId: string) => call<{ ok: boolean; error?: string }>(RPC_CHANNELS.pages.EXECUTE_ACTION, workspaceId, {
      requestId, pageSlug: 'acts', leaseId: lease.leaseId, nonce: lease.nonce, grantId: grant.id, invocation: { kind: 'api', method: 'POST', path: '/issues' },
    })
    const decisionOf = async (requestId: string): Promise<unknown> => {
      const auditPath = join(CONFIG_DIR, 'logs', 'page-actions.jsonl')
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20))
        if (!existsSync(auditPath)) continue
        const row = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean)
          .map(l => JSON.parse(l) as Record<string, unknown>)
          .find(e => e.event === 'page_action_executed' && e.requestId === requestId)
        if (row) return row.policyDecision
      }
      return undefined
    }
    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    // Negative (and the broker's build): no source yet — a POST is approval-worthy for an agent.
    expect((await act(`r-late-1-${uniq}`)).ok).toBe(false)
    expect(await decisionOf(`r-late-1-${uniq}`)).toBe('requires-approval')
    // The source arrives after the broker exists, with its own endpoint rule.
    mkdirSync(join(wsRoot, 'sources', 'tracker'), { recursive: true })
    writeFileSync(join(wsRoot, 'sources', 'tracker', 'config.json'), JSON.stringify({
      id: 'tracker_1', name: 'Tracker', slug: 'tracker', enabled: true, provider: 'custom', type: 'api',
      api: { baseUrl: 'http://127.0.0.1:9', authType: 'none' },
    }))
    writeFileSync(join(wsRoot, 'sources', 'tracker', 'permissions.json'), JSON.stringify({ allowedApiEndpoints: [{ method: 'POST', path: '^/issues' }] }))
    // Positive: the next action reads the source's rule.
    expect((await act(`r-late-2-${uniq}`)).ok).toBe(false)
    expect(await decisionOf(`r-late-2-${uniq}`)).toBe('allow')
    // Control: the rule is the tracker's own — the same POST through another source's grant still asks.
    const elsewhere = await call<{ id: string }>(RPC_CHANNELS.pages.ISSUE_GRANT, workspaceId, 'acts', { action: { ...api, sourceSlug: 'elsewhere' }, contentDigest: computePageContentDigest(content) })
    expect((await call<{ ok: boolean }>(RPC_CHANNELS.pages.EXECUTE_ACTION, workspaceId, {
      requestId: `r-late-3-${uniq}`, pageSlug: 'acts', leaseId: lease.leaseId, nonce: lease.nonce, grantId: elsewhere.id, invocation: { kind: 'api', method: 'POST', path: '/issues' },
    })).ok).toBe(false)
    expect(await decisionOf(`r-late-3-${uniq}`)).toBe('requires-approval')
  })

  // UA12.112 — a refusal the RENDERER's gate decided reaches the trail: the channel appends the
  // line through the workspace broker, marked stage 'renderer-gate' (the decision is the
  // renderer's, reported over the wire).
  it('UA12.112: pages:auditRefusal writes the renderer-gate refusal into the broker trail', async () => {
    const { call, workspaceId } = await pageWithScript('refusal-audit', scriptPorts([]))
    await call<boolean>(RPC_CHANNELS.pages.AUDIT_REFUSAL, workspaceId, {
      kind: 'action', pageSlug: 'acts', code: 'frame-focus-required',
      reason: 'frame-focus-required: mutating actions need a gesture inside the page',
      requestId: 'r-refused-1', leaseId: 'lease_x', grantId: 'grant_x',
      invocation: { kind: 'script' },
    })
    const auditPath = join(CONFIG_DIR, 'logs', 'page-actions.jsonl')
    let row: Record<string, unknown> | undefined
    for (let attempt = 0; attempt < 100 && !row; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      if (!existsSync(auditPath)) continue
      row = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean)
        .map(l => JSON.parse(l) as Record<string, unknown>)
        .find(e => e.event === 'page_action_rejected' && e.stage === 'renderer-gate' && e.requestId === 'r-refused-1')
    }
    expect(row).toMatchObject({ pageSlug: 'acts', code: 'frame-focus-required' })
  })
})

describe('UA6.7 — publishing over the wire', () => {
  afterAll(() => setHostApprovalsKeyProvider(undefined))
  const ID = 'pagesrpcartifact00000001'
  const URL_ = `https://t-artifacts.t-tech.team/a/${ID}`
  function publishingRig(tag: string, confirmDialog = true) {
    const sent: string[] = []
    const client = {
      createArtifact: async (request: { title: string }) => { sent.push('POST'); return { id: ID, url: URL_, title: request.title, expiresAt: null, retentionDays: 7 } },
      updateArtifact: async (_target: unknown, request: { title: string }) => { sent.push('PUT'); return { id: ID, url: URL_, title: request.title, expiresAt: null, retentionDays: 7 } },
      deleteArtifact: async () => { sent.push('DELETE') },
    }
    // No real grants: a key provider with a fixed test key, so the ledger reads as empty (never a real credential).
    setHostApprovalsKeyProvider({ getKey: async () => Buffer.alloc(32, 7) })
    return { ...rig(tag, undefined, { createArtifactsClient: () => client }, confirmDialog), sent }
  }

  it('review sends nothing; publishing the reviewed bytes sends one POST and pushes the page with its publication; unpublish is one DELETE', async () => {
    const { call, workspaceId, pushes, sent } = publishingRig('publish')
    await call(RPC_CHANNELS.pages.CREATE, workspaceId, { name: 'Shared Board', kind: 'live', content: '<p>board</p>' })
    pushes.length = 0
    const review = await call<{ review: { ok: boolean; card?: { sha256: string } } }>(RPC_CHANNELS.pages.GET_SHARE_DATA_SCAN, workspaceId, 'shared-board', { includeData: false })
    expect(review.review.ok).toBe(true)
    expect(sent).toEqual([])
    // UA12.52 follow-up — the review pushes no artifacts:changed (nothing was published)…
    expect(pushes.filter(push => push.channel === RPC_CHANNELS.artifacts.CHANGED)).toEqual([])
    const result = await call<{ status: string; url?: string }>(RPC_CHANNELS.pages.PUBLISH, workspaceId, 'shared-board', { includeData: false, reviewedSha256: review.review.card!.sha256 })
    expect(result).toMatchObject({ status: 'published', url: URL_ })
    expect(sent).toEqual(['POST'])
    const changed = pushes.filter(push => push.channel === RPC_CHANNELS.pages.CHANGED)
    expect(changed).toHaveLength(1)
    expect((changed[0]!.args[1] as LoadedPage[])[0]!.publication?.url).toBe(URL_)
    // …and the publish pushes exactly one, naming the workspace, so an open Published pages section reloads.
    const artifactsChanged = pushes.filter(push => push.channel === RPC_CHANNELS.artifacts.CHANGED)
    expect(artifactsChanged).toHaveLength(1)
    expect(artifactsChanged[0]!.target).toEqual({ to: 'workspace', workspaceId })
    expect(artifactsChanged[0]!.args).toEqual([workspaceId])
    expect(await call<{ outcome: string }>(RPC_CHANNELS.pages.UNPUBLISH, workspaceId, 'shared-board')).toEqual({ outcome: 'deleted' })
    expect(sent).toEqual(['POST', 'DELETE'])
  })

  it('deleting a published page sends one DELETE first; an unpublished page sends nothing', async () => {
    const { call, workspaceId, wsRoot, sent } = publishingRig('delete')
    await call(RPC_CHANNELS.pages.CREATE, workspaceId, { name: 'Gone Soon', kind: 'live', content: '<p>x</p>' })
    await call(RPC_CHANNELS.pages.CREATE, workspaceId, { name: 'Private', kind: 'live', content: '<p>y</p>' })
    const review = await call<{ review: { card?: { sha256: string } } }>(RPC_CHANNELS.pages.GET_SHARE_DATA_SCAN, workspaceId, 'gone-soon', { includeData: false })
    await call(RPC_CHANNELS.pages.PUBLISH, workspaceId, 'gone-soon', { includeData: false, reviewedSha256: review.review.card!.sha256 })
    expect(await call<{ publicCopyMayRemain: boolean }>(RPC_CHANNELS.pages.DELETE, workspaceId, 'gone-soon')).toEqual({ publicCopyMayRemain: false })
    expect(sent).toEqual(['POST', 'DELETE'])
    expect(existsSync(getPagePath(wsRoot, 'gone-soon'))).toBe(false)
    expect(await call<{ publicCopyMayRemain: boolean }>(RPC_CHANNELS.pages.DELETE, workspaceId, 'private')).toEqual({ publicCopyMayRemain: false })
    expect(sent).toEqual(['POST', 'DELETE'])
  })

  it('negative: a caller that cannot show the review (no confirm-dialog capability) publishes nothing', async () => {
    const { call, workspaceId, sent, pushes } = publishingRig('no-window', false)
    await call(RPC_CHANNELS.pages.CREATE, workspaceId, { name: 'Phone', kind: 'live', content: '<p>x</p>' })
    const review = await call<{ review: { ok: boolean; card?: { sha256: string } } }>(RPC_CHANNELS.pages.GET_SHARE_DATA_SCAN, workspaceId, 'phone', { includeData: false })
    const result = await call<{ status: string; note: string }>(RPC_CHANNELS.pages.PUBLISH, workspaceId, 'phone', { includeData: false, reviewedSha256: review.review.card!.sha256 })
    expect(result.status).toBe('refused')
    expect(result.note).toContain('Nessy window')
    expect(sent).toEqual([])
    expect(pushes.filter(push => push.channel === RPC_CHANNELS.artifacts.CHANGED)).toEqual([]) // UA12.52 follow-up
  })

  it('negative: a host with no artifact client publishes nothing (the review still answers, the publish fails)', async () => {
    const { call, workspaceId, pushes } = rig('no-client')
    setHostApprovalsKeyProvider({ getKey: async () => Buffer.alloc(32, 7) })
    await call(RPC_CHANNELS.pages.CREATE, workspaceId, { name: 'Offline', kind: 'live', content: '<p>x</p>' })
    const review = await call<{ review: { ok: boolean; card?: { sha256: string } } }>(RPC_CHANNELS.pages.GET_SHARE_DATA_SCAN, workspaceId, 'offline', { includeData: false })
    expect(review.review.ok).toBe(true)
    expect(await call(RPC_CHANNELS.pages.PUBLISH, workspaceId, 'offline', { includeData: false, reviewedSha256: review.review.card!.sha256 }))
      .toMatchObject({ status: 'failed' })
    expect(pushes.filter(push => push.channel === RPC_CHANNELS.artifacts.CHANGED)).toEqual([]) // UA12.52 follow-up
  })
})
