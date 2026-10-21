/**
 * UA1.25 — `shareToViewer` / `updateShare` / `revokeShare` on t-artifacts, driven through the SHIPPED SessionManager
 * methods (the `sessionCommand` handlers call exactly these). Only the machinery below the decision is stubbed: events,
 * persistence, the connected-client table, and — where the WIRE is the subject — the client's `fetch` and dp token
 * (the real `createTArtifactsClient` builds the request). No request reaches a real service; the token is an obviously
 * fake string assembled at runtime.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import {
  createTArtifactsClient,
  T_ARTIFACTS_ORIGIN,
  type TArtifactsClient,
} from '@nessy-agent/shared/artifacts/t-artifacts-client'
import type { DpRuntimeRecord } from '@nessy-agent/shared/auth/dp/dp-binary'
import { findArtifactRegistryEntry, recordArtifactPublish } from '@nessy-agent/shared/artifacts/registry'
import type { ShareResult } from '@nessy-agent/shared/protocol'
import { createTestSessionManager } from './test-session-manager.ts'

const key = { workspaceId: 'workspace-1', sessionId: 'shared-chat' }
const ARTIFACT_ID = 'abcdefghijklmnopqrstuv'
const ARTIFACT_URL = `${T_ARTIFACTS_ORIGIN}/a/${ARTIFACT_ID}`

interface Internals {
  sessions: Map<string, unknown>
  directPermissionResolvers: Map<string, { sessionId: string; resolve: (allowed: boolean) => void }>
  sendEvent(event: unknown, workspaceId: string): void
  persistSession(managed: unknown, immediate?: boolean): void
  writeSessionMetadata(managed: unknown, updates: Record<string, unknown>): Promise<void>
  getSessionPath(sessionId: string, workspaceId?: string): string | null
  rpcServer: unknown
  createArtifactsClientFn: () => TArtifactsClient
  disposeManagedAgentRuntime(managed: unknown, reason: string, strict: boolean): Promise<void>
  eventSink: ((channel: string, target: unknown, ...args: unknown[]) => void) | null
}

interface WireCall { method: string; url: string; body: string | undefined }

let workspaceRoot: string
let cwd: string

beforeEach(() => {
  workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ua125-share-ws-')))
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ua125-share-cwd-')))
})
afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

/** The real client, its wire captured: `token` undefined = dp is signed out; `fail` answers that status. */
function wireClient(calls: WireCall[], options: { token?: string | undefined; deleteStatus?: number; signedOut?: boolean; answerWithoutExpiry?: boolean } = {}): TArtifactsClient {
  const fakeToken = ['fake', 'token', 'for', 'tests'].join('-')
  return createTArtifactsClient({
    env: {},
    resolveDpRuntime: () => ({ dpPath: '/nonexistent/dp', source: 'path' } as unknown as DpRuntimeRecord),
    printToken: async () => (options.signedOut ? undefined : fakeToken),
    fetch: async (url, init) => {
      calls.push({ method: String(init.method), url, body: typeof init.body === 'string' ? init.body : undefined })
      if (init.method === 'DELETE') {
        const status = options.deleteStatus ?? 204
        return new Response(null, { status })
      }
      const sent = JSON.parse(String(init.body)) as { title: string; retention_days?: number }
      // P-UA-i-4 — the DEPLOYED service's answer shape (S7-D, RC4, 2026-10-10): no `expires_at`, no `retention_days`.
      if (options.answerWithoutExpiry === true) {
        return new Response(JSON.stringify({ id: ARTIFACT_ID, url: ARTIFACT_URL, title: sent.title }), {
          status: init.method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({
        id: ARTIFACT_ID,
        url: ARTIFACT_URL,
        title: sent.title,
        expires_at: '2026-10-09T00:00:00.000Z',
        retention_days: sent.retention_days ?? 7,
      }), { status: init.method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' } })
    },
  })
}

function harness(options: {
  clientAttached?: boolean
  shared?: { id: string; url: string }
  signedOut?: boolean
  deleteStatus?: number
  answerWithoutExpiry?: boolean
  messages?: Array<Record<string, unknown>>
} = {}) {
  const manager = createTestSessionManager()
  const internals = manager as unknown as Internals
  const events: Array<Record<string, unknown>> = []
  const calls: WireCall[] = []
  const metadataWrites: Array<Record<string, unknown>> = []
  const pushes: Array<{ channel: string; args: unknown[] }> = []
  const session: Record<string, unknown> = {
    id: key.sessionId,
    name: 'Fix the build',
    workspace: { id: key.workspaceId, rootPath: workspaceRoot },
    workingDirectory: cwd,
    permissionMode: 'default',
    messagesLoaded: true,
    createdAt: 1,
    messages: options.messages ?? [
      { id: 'u1', role: 'user', content: `Read ${cwd}/src/app.ts please`, timestamp: 1,
        attachments: [{ type: 'text', name: 'notes.txt', storedPath: join(cwd, '.nessy', 'attachments', 'notes.txt'), mimeType: 'text/plain', size: 3 }] },
      { id: 't1', role: 'tool', toolName: 'Read', toolStatus: 'completed', timestamp: 2,
        toolInput: { file_path: `${cwd}/src/app.ts` }, toolResult: 'export const app = 1',
        rawToolResult: 'RAW-ONLY-PAYLOAD-NEVER-SHOWN' },
      { id: 'a1', role: 'assistant', content: 'Done.', timestamp: 3 },
    ],
    ...(options.shared ? { sharedId: options.shared.id, sharedUrl: options.shared.url } : {}),
  }
  internals.sessions.set(encodeSessionKey(key), session)
  internals.sendEvent = event => { events.push(event as Record<string, unknown>) }
  internals.eventSink = (channel, _target, ...args) => { pushes.push({ channel, args }) }
  internals.persistSession = () => undefined
  internals.writeSessionMetadata = async (_managed, updates) => { metadataWrites.push(updates) }
  internals.getSessionPath = () => null
  internals.rpcServer = {
    findClientsWithCapability: (capability: string, opts?: { workspaceId?: string }) =>
      options.clientAttached === false || capability !== 'client:confirmDialog' || opts?.workspaceId !== key.workspaceId
        ? []
        : ['window-1'],
    hasClientCapability: () => false,
  }
  internals.createArtifactsClientFn = () => wireClient(calls, {
    signedOut: options.signedOut,
    deleteStatus: options.deleteStatus,
    answerWithoutExpiry: options.answerWithoutExpiry,
  })

  const answerCard = async (allowed: boolean): Promise<void> => {
    for (let attempt = 0; attempt < 400 && internals.directPermissionResolvers.size === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    for (const [, entry] of internals.directPermissionResolvers) entry.resolve(allowed)
  }
  const cards = () => events.filter(event => event.type === 'permission_request').map(event => event.request as Record<string, unknown>)
  return { manager, internals, session, events, calls, metadataWrites, answerCard, cards, pushes }
}

describe('share → card → one POST of exactly the bytes on the card', () => {
  test('nothing is sent before the answer; approve sends one POST, stores the link and records a chat row', async () => {
    const { manager, session, events, calls, answerCard, cards } = harness()
    const pending = manager.shareToViewer(key.sessionId, key.workspaceId)
    for (let i = 0; i < 400 && cards().length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 1))
    expect(calls).toHaveLength(0)
    expect(cards()).toHaveLength(1)
    const request = cards()[0]!
    expect(request.noAlwaysAllow).toBe(true)
    const card = request.artifactPublish as Record<string, unknown>
    expect(card.mode).toBe('create')
    expect(card.contentType).toBe('markdown')
    expect(card.retentionDays).toBe(7)
    expect(card.sourcePath).toBe('Fix the build')
    const chatShare = card.chatShare as { relativisedPaths: number; maskedSecretTotal: number }
    expect(chatShare.relativisedPaths).toBeGreaterThan(0)
    expect(chatShare.maskedSecretTotal).toBe(0)
    // UA12.67 — the chat card names the chat ONCE ('Share chat "T" on …'), not publish_artifact's file wording,
    // which for a chat reads `Publish "T" (T) on …` — its sourcePath IS the title.
    expect(request.description).toContain('Share chat "Fix the build" on')
    expect(request.description).not.toContain('Publish "Fix the build"')
    expect(request.description).not.toContain('(Fix the build)')

    await answerCard(true)
    const result = await pending as ShareResult
    expect(result).toMatchObject({ success: true, url: ARTIFACT_URL, expiresAt: '2026-10-09T00:00:00.000Z' })
    expect(calls.map(call => call.method)).toEqual(['POST'])
    expect(calls[0]!.url).toBe(`${T_ARTIFACTS_ORIGIN}/api/artifacts`)
    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>
    expect(body.content).toBe(card.previewContent)
    expect(body.content_type).toBe('markdown')
    expect(body.retention_days).toBe(7)
    expect(session.sharedUrl).toBe(ARTIFACT_URL)
    expect(session.sharedId).toBe(ARTIFACT_ID)
    expect(events.some(event => event.type === 'session_shared' && event.sharedUrl === ARTIFACT_URL)).toBe(true)
    const entry = findArtifactRegistryEntry(workspaceRoot, ARTIFACT_ID)
    expect(entry?.kind).toBe('chat')
    expect(entry?.sourceSessionId).toBe(key.sessionId)
  })

  test('the POST body carries no StoredSession field, no raw-only result, and no absolute path', async () => {
    const { manager, calls, answerCard } = harness()
    const pending = manager.shareToViewer(key.sessionId, key.workspaceId)
    await answerCard(true)
    expect((await pending).success).toBe(true)
    const wire = calls[0]!.body!
    for (const field of ['rawToolResult', 'storedPath', 'workingDirectory', 'sdkSessionId', 'messagesLoaded']) {
      expect(wire.includes(field)).toBe(false)
    }
    expect(wire.includes('RAW-ONLY-PAYLOAD-NEVER-SHOWN')).toBe(false)
    expect(wire.includes(cwd)).toBe(false)
    expect(wire.includes('src/app.ts')).toBe(true) // relativised, not dropped
    expect(wire.includes('export const app = 1')).toBe(true) // the DISPLAYED result is shared
  })
})

// P-UA-i-4 — the deployed service answers WITHOUT `expires_at` (measured live on RC4, S7-D 2026-10-10)
// while the share's create sends `retention_days: 7` and the card showed the retention's date. The share
// result and the registry row must carry the EXPECTATION, never "never expires".
describe('P-UA-i-4 — the service answer carries no expires_at', () => {
  test('a create shows the SENT retention as the expectation in the result and the registry row', async () => {
    const expectedAt = Date.now() + 7 * 24 * 60 * 60 * 1000
    const { manager, calls, answerCard } = harness({ answerWithoutExpiry: true })
    const pending = manager.shareToViewer(key.sessionId, key.workspaceId)
    await answerCard(true)
    const result = await pending as ShareResult
    expect(result.success).toBe(true)
    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>
    expect(body.retention_days).toBe(7) // the app asked for 7 days — the app side is not the one dropping it
    expect(typeof result.expiresAt).toBe('string')
    expect(Math.abs(Date.parse(result.expiresAt as string) - expectedAt)).toBeLessThan(60_000)
    const entry = findArtifactRegistryEntry(workspaceRoot, ARTIFACT_ID)
    expect(typeof entry?.expiresAt).toBe('string')
    expect(Math.abs(Date.parse(entry!.expiresAt!) - expectedAt)).toBeLessThan(60_000)
  })
})

/**
 * UA12.53 (origin P-UAv-2) — the Share card is raised by the user's click through the SAME
 * `raiseArtifactPublishCard` as the preview Publish, and was stamped `releaseOnStop` like a runtime's card, so
 * F1.403's `disposeManagedAgentRuntime` (the idle reaper, a runtime refresh, an auth retry) declined what a person
 * was answering — the answer travels through the RPC handler's await, never through that runtime. Non-runtime like
 * the composer `!` card: the dispose leaves it up, answerable, and approving it still shares.
 */
describe('UA12.53 — the Share card survives a runtime dispose', () => {
  test('a Share click, then disposeManagedAgentRuntime: the card stays up and approving it still sends the POST', async () => {
    const { manager, internals, session, calls, answerCard } = harness()
    const pending = manager.shareToViewer(key.sessionId, key.workspaceId)
    for (let i = 0; i < 400 && internals.directPermissionResolvers.size === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    const [requestId] = [...internals.directPermissionResolvers.keys()]
    if (!requestId) throw new Error('no share card was raised')
    await internals.disposeManagedAgentRuntime(session, 'idle-agent reaper', true).catch(() => undefined)
    expect(internals.directPermissionResolvers.has(requestId)).toBe(true)
    await answerCard(true)
    expect((await pending).success).toBe(true)
    expect(calls.map(call => call.method)).toEqual(['POST'])
  })
})

/**
 * UA12.65 (origin UA-x / UA1.25) — the row's control: a chat whose transcript shows an HTML form EXAMPLE inside a
 * fenced block shares — the fence renders escaped on the published page, so the example is display text, not the
 * phishing shape the v1 content policy refuses. The snapshot's markdown reaches the SAME normaliser the publish
 * path uses (`normalizeArtifact`), so the fence-aware scan lands here for free.
 */
describe('UA12.65 — a chat showing a fenced <form> example still shares', () => {
  test('a transcript whose fenced example contains a form shares after the card is approved', async () => {
    const { manager, internals, calls, answerCard } = harness({
      messages: [
        { id: 'u1', role: 'user', content: 'Show me a login form', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: 'Here is one:\n\n```html\n<form action="/login" method="post">\n  <button>Sign in</button>\n</form>\n```', timestamp: 2 },
      ],
    })
    const pending = manager.shareToViewer(key.sessionId, key.workspaceId)
    for (let i = 0; i < 400 && internals.directPermissionResolvers.size === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    await answerCard(true)
    expect((await pending).success).toBe(true)
    expect(calls.map(call => call.method)).toEqual(['POST'])
    expect((JSON.parse(calls[0]!.body!) as { content: string }).content).toContain('<form action="/login"')
  })
})

describe('UA12.175 — chat share masks, never refuses: the key-name rule (UA12.9) is publish-only', () => {
  test('a coding chat with a git log Author line, a package.json author and a max_tokens input reaches the card and shares', async () => {
    const { manager, internals, calls, answerCard, cards } = harness({
      messages: [
        { id: 'u1', role: 'user', content: 'Who touched the build last?', timestamp: 1 },
        { id: 't1', role: 'tool', toolName: 'Bash', toolStatus: 'completed', timestamp: 2,
          toolInput: { command: 'git log -1' },
          toolResult: 'commit 0123456789abcdef\nAuthor: Igor Gavrikov <igor@example.invalid>\nDate:   Thu Oct 8 12:00:00 2026\n\n    fix the build' },
        { id: 't2', role: 'tool', toolName: 'Read', toolStatus: 'completed', timestamp: 3,
          toolInput: { file_path: 'package.json', max_tokens: 4096 },
          toolResult: '{\n  "name": "demo",\n  "author": "Igor Gavrikov",\n  "version": "1.0.0"\n}' },
        { id: 'a1', role: 'assistant', content: 'Igor did.\n\n- Tokenizer: cl100k_base\n- Auth: enabled', timestamp: 4 },
      ],
    })
    const pending = manager.shareToViewer(key.sessionId, key.workspaceId)
    for (let i = 0; i < 400 && internals.directPermissionResolvers.size === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    expect(cards()).toHaveLength(1)
    await answerCard(true)
    expect((await pending).success).toBe(true)
    expect(calls.map(call => call.method)).toEqual(['POST'])
    expect((JSON.parse(calls[0]!.body!) as { content: string }).content).toContain('Author: Igor Gavrikov')
  })

  test('a chat whose tool read a .env with DB_PASSWORD=… reaches the card and shares (masked, never refused)', async () => {
    const { manager, internals, calls, answerCard, cards } = harness({
      messages: [
        { id: 'u1', role: 'user', content: 'Why does the db connection fail?', timestamp: 1 },
        { id: 't1', role: 'tool', toolName: 'Read', toolStatus: 'completed', timestamp: 2,
          toolInput: { file_path: '.env' }, toolResult: 'DB_HOST=localhost\nDB_PASSWORD=hunter2hunter2\n' },
        { id: 'a1', role: 'assistant', content: 'The host is wrong.', timestamp: 3 },
      ],
    })
    const pending = manager.shareToViewer(key.sessionId, key.workspaceId)
    for (let i = 0; i < 400 && internals.directPermissionResolvers.size === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    expect(cards()).toHaveLength(1)
    await answerCard(true)
    expect((await pending).success).toBe(true)
    expect(calls.map(call => call.method)).toEqual(['POST'])
  })

  test('control: a jwt in the chat is still masked before the card, never sent verbatim', async () => {
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ1YTEyMTc1In0', 'c2lnbmF0dXJlLXZhbHVl'].join('.')
    const { manager, internals, calls, answerCard } = harness({
      messages: [
        { id: 'u1', role: 'user', content: `Decode ${jwt} please`, timestamp: 1 },
        { id: 'a1', role: 'assistant', content: 'Done.', timestamp: 2 },
      ],
    })
    const pending = manager.shareToViewer(key.sessionId, key.workspaceId)
    for (let i = 0; i < 400 && internals.directPermissionResolvers.size === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    await answerCard(true)
    expect((await pending).success).toBe(true)
    const content = (JSON.parse(calls[0]!.body!) as { content: string }).content
    expect(content).not.toContain(jwt)
    expect(content).toContain('[REDACTED:jwt]')
  })
})

describe('update and stop sharing', () => {
  test('update: the card again, then one PUT to the same id; the link is unchanged and no retention is sent', async () => {
    recordArtifactPublish(workspaceRoot, {
      record: { id: ARTIFACT_ID, url: ARTIFACT_URL, title: 'Fix the build', expiresAt: '2026-10-09T00:00:00.000Z', retentionDays: 7 },
      sourceSessionId: key.sessionId, sourcePath: 'Fix the build', contentDigest: 'x', kind: 'chat',
    })
    const { manager, session, calls, answerCard, cards } = harness({ shared: { id: ARTIFACT_ID, url: ARTIFACT_URL } })
    const pending = manager.updateShare(key.sessionId, key.workspaceId)
    await answerCard(true)
    const result = await pending
    expect(result).toMatchObject({ success: true, url: ARTIFACT_URL })
    expect((cards()[0]!.artifactPublish as Record<string, unknown>).mode).toBe('update')
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([`PUT ${T_ARTIFACTS_ORIGIN}/api/artifacts/${ARTIFACT_ID}`])
    expect('retention_days' in (JSON.parse(calls[0]!.body!) as Record<string, unknown>)).toBe(false)
    expect(session.sharedUrl).toBe(ARTIFACT_URL)
  })

  /**
   * UA12.66 (origin UA-x / UA1.25) — the row's control: with the registry row deleted, the update card does NOT
   * claim "never". The service-side link keeps its original expiry (the update sends no retention), so a missing row
   * means the host does not KNOW the expiry — the card marks it unknown instead of presenting `expiresAt: null` as
   * never.
   */
  test('update with the registry row gone: the card marks the expiry unknown and never claims it is endless', async () => {
    const { manager, answerCard, cards } = harness({ shared: { id: ARTIFACT_ID, url: ARTIFACT_URL } })
    const pending = manager.updateShare(key.sessionId, key.workspaceId)
    await answerCard(true)
    expect((await pending).success).toBe(true)
    const payload = cards()[0]!.artifactPublish as Record<string, unknown>
    expect(payload.expiresAt).toBeNull()
    expect(payload.expiresUnknown).toBe(true)
  })

  test('control: updating with the registry row present keeps the known expiry, no unknown marker', async () => {
    recordArtifactPublish(workspaceRoot, {
      record: { id: ARTIFACT_ID, url: ARTIFACT_URL, title: 'Fix the build', expiresAt: '2026-10-09T00:00:00.000Z', retentionDays: 7 },
      sourceSessionId: key.sessionId, sourcePath: 'Fix the build', contentDigest: 'x', kind: 'chat',
    })
    const { manager, answerCard, cards } = harness({ shared: { id: ARTIFACT_ID, url: ARTIFACT_URL } })
    const pending = manager.updateShare(key.sessionId, key.workspaceId)
    await answerCard(true)
    expect((await pending).success).toBe(true)
    const payload = cards()[0]!.artifactPublish as Record<string, unknown>
    expect(payload.expiresUnknown).toBeUndefined()
    expect(payload.expiresAt).toBe('2026-10-09T00:00:00.000Z')
    expect(cards()[0]!.description).toContain('Update chat "Fix the build" on')
    expect(cards()[0]!.description).not.toContain('(Fix the build)')
  })

  test('stop sharing: one DELETE, the fields cleared, the registry row gone', async () => {
    recordArtifactPublish(workspaceRoot, {
      record: { id: ARTIFACT_ID, url: ARTIFACT_URL, title: 'Fix the build', expiresAt: null, retentionDays: 7 },
      sourceSessionId: key.sessionId, sourcePath: 'Fix the build', contentDigest: 'x', kind: 'chat',
    })
    const { manager, session, events, calls, cards } = harness({ shared: { id: ARTIFACT_ID, url: ARTIFACT_URL } })
    const result = await manager.revokeShare(key.sessionId, key.workspaceId)
    expect(result).toMatchObject({ success: true })
    expect(cards()).toHaveLength(0)
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([`DELETE ${T_ARTIFACTS_ORIGIN}/api/artifacts/${ARTIFACT_ID}`])
    expect(session.sharedUrl).toBeUndefined()
    expect(session.sharedId).toBeUndefined()
    expect(events.some(event => event.type === 'session_unshared')).toBe(true)
    expect(findArtifactRegistryEntry(workspaceRoot, ARTIFACT_ID)).toBeUndefined()
  })

  test('stop sharing that fails for a retryable reason keeps a pending deletion and clears the share', async () => {
    recordArtifactPublish(workspaceRoot, {
      record: { id: ARTIFACT_ID, url: ARTIFACT_URL, title: 'Fix the build', expiresAt: null, retentionDays: 7 },
      sourceSessionId: key.sessionId, sourcePath: 'Fix the build', contentDigest: 'x', kind: 'chat',
    })
    const { manager, session, calls } = harness({ shared: { id: ARTIFACT_ID, url: ARTIFACT_URL }, deleteStatus: 503 })
    const result = await manager.revokeShare(key.sessionId, key.workspaceId)
    expect(result).toMatchObject({ success: true, deletionPending: true })
    expect(calls).toHaveLength(1)
    expect(session.sharedId).toBeUndefined()
    expect(findArtifactRegistryEntry(workspaceRoot, ARTIFACT_ID)?.pendingDelete?.lastErrorKind).toBe('server')
  })
})

describe('refusals send nothing', () => {
  test('a declined card sends nothing and leaves the chat unshared', async () => {
    const { manager, session, calls, answerCard } = harness()
    const pending = manager.shareToViewer(key.sessionId, key.workspaceId)
    await answerCard(false)
    const result = await pending
    expect(result).toMatchObject({ success: false, declined: true })
    expect(calls).toHaveLength(0)
    expect(session.sharedUrl).toBeUndefined()
  })

  test('with no window that can show the card, nothing is asked and nothing is sent', async () => {
    const { manager, calls, cards } = harness({ clientAttached: false })
    const result = await manager.shareToViewer(key.sessionId, key.workspaceId)
    expect(result.success).toBe(false)
    expect(result.error).toContain('no window is open')
    expect(cards()).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  test('dp signed out: after the card, one sentence and zero requests (the client spawns no login)', async () => {
    const { manager, session, calls, answerCard, events } = harness({ signedOut: true })
    const pending = manager.shareToViewer(key.sessionId, key.workspaceId)
    await answerCard(true)
    const result = await pending
    expect(result.success).toBe(false)
    expect(result.error).toContain('dp is not signed in')
    expect(calls).toHaveLength(0)
    expect(session.sharedUrl).toBeUndefined()
    expect(events.filter(event => event.type === 'permission_request')).toHaveLength(1)
  })

  test('a link on another service is never contacted: update refuses, stop sharing only clears the fields', async () => {
    const foreign = { id: 'legacy-id', url: 'https://viewer.example.invalid/s/legacy-id' }
    const update = harness({ shared: foreign })
    const refused = await update.manager.updateShare(key.sessionId, key.workspaceId)
    expect(refused.success).toBe(false)
    expect(update.calls).toHaveLength(0)
    expect(update.cards()).toHaveLength(0)

    const revoke = harness({ shared: foreign })
    const cleared = await revoke.manager.revokeShare(key.sessionId, key.workspaceId)
    expect(cleared.success).toBe(true)
    expect(revoke.calls).toHaveLength(0)
    expect(revoke.session.sharedUrl).toBeUndefined()
  })
})

// UA12.52 — the shipped share path BINDS the notify port: an approved share (create or update) pushes
// `artifacts:changed` to the workspace's windows (an open Published pages section reloads without its Retry
// button — the row's control), and a declined card pushes nothing.
describe('UA12.52 — an approved share pushes artifacts:changed to the workspace', () => {
  test('a created share, an updated share → one push each naming the workspace; a declined card → none', async () => {
    const created = harness()
    const createPending = created.manager.shareToViewer(key.sessionId, key.workspaceId)
    for (let i = 0; i < 400 && created.cards().length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 1))
    await created.answerCard(true)
    expect((await createPending).success).toBe(true)
    const createPushes = created.pushes.filter(push => push.channel === 'artifacts:changed')
    expect(createPushes).toHaveLength(1)
    expect(createPushes[0]!.args[0]).toBe(key.workspaceId)

    const updated = harness({ shared: { id: ARTIFACT_ID, url: ARTIFACT_URL } })
    const updatePending = updated.manager.updateShare(key.sessionId, key.workspaceId)
    for (let i = 0; i < 400 && updated.cards().length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 1))
    await updated.answerCard(true)
    expect((await updatePending).success).toBe(true)
    expect(updated.pushes.filter(push => push.channel === 'artifacts:changed')).toHaveLength(1)

    const declined = harness()
    const declinedPending = declined.manager.shareToViewer(key.sessionId, key.workspaceId)
    for (let i = 0; i < 400 && declined.cards().length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 1))
    await declined.answerCard(false)
    expect((await declinedPending).success).toBe(false)
    expect(declined.pushes.filter(push => push.channel === 'artifacts:changed')).toHaveLength(0)
  })
})
