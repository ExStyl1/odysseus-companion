/**
 * UA1.18 — `publish_artifact` and `list_artifacts` reach codex over the host-callback bridge, onto the SAME registry
 * slots (`publishArtifactFn`, `listArtifactsFn`) `SessionManager` binds for Pi and Claude in process — so the card a
 * codex session meets is the one closure's card, not a codex copy.
 *
 * Native-first, step 1: codex has no publishing mechanism of its own for the company service, so step 2 is the
 * bridge. This suite drives the HOST half (the real `startCodexSessionCallbackBridge` resolving from the real
 * registry) with the registry handlers on the far side of a fetch shaped like the subprocess client's. The real
 * subprocess round trip is `session-mcp-server/src/host-callback-bridge.test.ts`; the real closure (card, unattended
 * refusal, guard) is `server-core/.../publish-artifact-host-card.test.ts`.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  getSessionToolDefs,
  getSessionToolNames,
  getToolDefsAsJsonSchema,
  HOST_CALLBACK_BRIDGE_ROUTES,
  HOST_CALLBACK_BRIDGE_SESSION_MISMATCH,
  type ListArtifactsResult,
  type PublishArtifactInput,
  type PublishArtifactVerdict,
  type SessionToolContext,
} from '@nessy-agent/session-tools-core'
import {
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '../../../session-scoped-tool-callback-registry.ts'
import { startCodexSessionCallbackBridge, type CodexSessionCallbackBridgeHandle } from '../session-callback-bridge.ts'
import { SESSION_TOOL_DISPLAY_NAMES } from '../../../../utils/toolNames.ts'

const KEY = { workspaceId: 'ws-ua118', sessionId: 'codex-caller' }

const handlerOf = (name: string) => {
  const definition = getSessionToolDefs({ externalStandaloneOnly: true, hostCallbackBridge: true }).find(entry => entry.name === name)
  if (!definition?.handler) throw new Error(`${name} has no registry handler on the bridged codex surface`)
  return definition.handler as (ctx: SessionToolContext, args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>
}

let bridge: CodexSessionCallbackBridgeHandle | undefined

afterEach(async () => {
  await bridge?.close()
  bridge = undefined
  unregisterSessionScopedToolCallbacks(KEY)
})

function bindRegistry(verdict: PublishArtifactVerdict) {
  const calls: PublishArtifactInput[] = []
  mergeSessionScopedToolCallbacks(KEY, {
    publishArtifactFn: async input => { calls.push(input); return verdict },
    listArtifactsFn: (): ListArtifactsResult => ({
      artifacts: [{ id: 'abcdefghijklmnopqrstuv', title: 'Q3', url: 'https://t-artifacts.t-tech.team/a/abcdefghijklmnopqrstuv', expiresAt: null }],
    }),
  })
  return { calls }
}

async function post(route: string, payload: unknown, sessionId = KEY.sessionId): Promise<{ status: number; body: { result?: unknown; error?: string } }> {
  const response = await fetch(`http://127.0.0.1:${bridge!.port}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, payload }),
  })
  return { status: response.status, body: (await response.json()) as { result?: unknown; error?: string } }
}

async function call<T>(route: string, payload: unknown): Promise<T> {
  const { body } = await post(route, payload)
  if (typeof body.error === 'string') throw new Error(body.error)
  return body.result as T
}

function codexContext(): SessionToolContext {
  return {
    publishArtifact: (input: PublishArtifactInput) => call<PublishArtifactVerdict>(HOST_CALLBACK_BRIDGE_ROUTES.artifactPublish, input),
    listArtifacts: () => call<ListArtifactsResult>(HOST_CALLBACK_BRIDGE_ROUTES.artifactList, {}),
  } as unknown as SessionToolContext
}

async function start(sessionId = KEY.sessionId): Promise<void> {
  bridge = await startCodexSessionCallbackBridge({ sessionKey: { workspaceId: KEY.workspaceId, sessionId } })
}

describe('positive — the codex call reaches the one host closure', () => {
  it('publish: the handler maps the tool input, the closure answers, the tool returns { url, expires_at, updated }', async () => {
    const { calls } = bindRegistry({ status: 'published', note: 'Published.', url: 'https://t-artifacts.t-tech.team/a/abcdefghijklmnopqrstuv', expiresAt: '2026-10-09T00:00:00.000Z' })
    await start()
    const result = await handlerOf('publish_artifact')(codexContext(), { file_path: 'page.html', emoji: '📊', retention_days: 2 })
    expect(result.isError).toBeFalsy()
    const payload = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>
    expect(payload).toMatchObject({ url: 'https://t-artifacts.t-tech.team/a/abcdefghijklmnopqrstuv', updated: false })
    expect(payload.expires_at).toBe('2026-10-09T00:00:00.000Z')
    expect(calls).toEqual([{ filePath: 'page.html', emoji: '📊', retentionDays: 2 }])
  })

  it('list: the calling session\'s rows come back as the tool\'s JSON', async () => {
    bindRegistry({ status: 'refused', note: 'unused' })
    await start()
    const result = await handlerOf('list_artifacts')(codexContext(), {})
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual({
      artifacts: [{ id: 'abcdefghijklmnopqrstuv', title: 'Q3', url: 'https://t-artifacts.t-tech.team/a/abcdefghijklmnopqrstuv', expiresAt: null }],
    })
  })

  it('the description and input schema are IDENTICAL on codex (bridged), Pi and Claude', () => {
    const pick = (defs: ReturnType<typeof getToolDefsAsJsonSchema>, name: string) => defs.find(def => def.name === name)
    for (const name of ['publish_artifact', 'list_artifacts']) {
      const codex = pick(getToolDefsAsJsonSchema({ externalStandaloneOnly: true, hostCallbackBridge: true }), name)
      const pi = pick(getToolDefsAsJsonSchema({ projection: 'pi' }), name)
      const claude = pick(getToolDefsAsJsonSchema({}), name)
      expect(codex, name).toBeDefined()
      expect(pi, name).toEqual(codex)
      expect(claude, name).toEqual(codex)
    }
  })
})

describe('negative — refusals reach the model as refusals; the bridge adds no gate and no hole', () => {
  it('a host refusal is the tool\'s error, with the closure\'s sentence', async () => {
    bindRegistry({ status: 'refused', note: 'publish_artifact needs the user to approve a confirmation card, and this turn was started by an automation, so nothing was published and no request was made.' })
    await start()
    const result = await handlerOf('publish_artifact')(codexContext(), { file_path: 'page.html' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('no request was made')
  })

  it('a foreign SESSION envelope is a 403 before the closure is reached', async () => {
    const { calls } = bindRegistry({ status: 'published', note: 'x', url: 'u', expiresAt: null })
    await start()
    const { status, body } = await post(HOST_CALLBACK_BRIDGE_ROUTES.artifactPublish, { filePath: 'page.html' }, 'someone-else')
    expect(status).toBe(403)
    expect(body.error).toBe(HOST_CALLBACK_BRIDGE_SESSION_MISMATCH)
    expect(calls).toEqual([])
  })

  it('malformed bodies are 400s and never reach the closure', async () => {
    const { calls } = bindRegistry({ status: 'published', note: 'x', url: 'u', expiresAt: null })
    await start()
    expect((await post(HOST_CALLBACK_BRIDGE_ROUTES.artifactPublish, {})).status).toBe(400)
    expect((await post(HOST_CALLBACK_BRIDGE_ROUTES.artifactPublish, { filePath: 'a.html', retentionDays: '7' })).status).toBe(400)
    expect((await post(HOST_CALLBACK_BRIDGE_ROUTES.artifactPublish, { filePath: 'a.html', url: 42 })).status).toBe(400)
    expect(calls).toEqual([])
  })

  it('a field the tool does not declare is dropped on the way in (narrowed)', async () => {
    const { calls } = bindRegistry({ status: 'published', note: 'x', url: 'u', expiresAt: null })
    await start()
    await post(HOST_CALLBACK_BRIDGE_ROUTES.artifactPublish, { filePath: 'a.html', sessionId: 'other', workspaceRoot: '/etc' })
    expect(calls).toEqual([{ filePath: 'a.html' }])
  })

  it('no registry entry → "unavailable", never a silent success', async () => {
    await start()
    const result = await handlerOf('publish_artifact')(codexContext(), { file_path: 'page.html' })
    expect(result.isError).toBe(true)
  })

  it('CONTROL: a codex spawn without the bridge advertises neither tool', () => {
    const bare = getSessionToolNames({ externalStandaloneOnly: true })
    expect(bare.has('publish_artifact')).toBe(false)
    expect(bare.has('list_artifacts')).toBe(false)
    const bridged = getSessionToolNames({ externalStandaloneOnly: true, hostCallbackBridge: true })
    expect(bridged.has('publish_artifact')).toBe(true)
    expect(bridged.has('list_artifacts')).toBe(true)
  })

  it('the turn header and the host display meta name both tools (one table); an unknown name still falls through', () => {
    expect(SESSION_TOOL_DISPLAY_NAMES.publish_artifact).toBe('Publish Artifact')
    expect(SESSION_TOOL_DISPLAY_NAMES.list_artifacts).toBe('List Artifacts')
    expect(SESSION_TOOL_DISPLAY_NAMES.publish_artifacts).toBeUndefined()
  })

  it('UA1.8\'s rule: publish is block and NOT readOnly (codex asks / refuses it in Plan); list is readOnly', () => {
    const defs = getSessionToolDefs({ externalStandaloneOnly: true, hostCallbackBridge: true })
    const publish = defs.find(def => def.name === 'publish_artifact')!
    const list = defs.find(def => def.name === 'list_artifacts')!
    expect([publish.safeMode, Boolean(publish.readOnly)]).toEqual(['block', false])
    expect([list.safeMode, Boolean(list.readOnly)]).toEqual(['allow', true])
  })
})
