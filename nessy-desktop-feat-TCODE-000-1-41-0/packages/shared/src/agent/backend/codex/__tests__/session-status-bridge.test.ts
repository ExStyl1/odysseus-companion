/**
 * UA1.3 — `set_session_status` and `set_session_labels` reach codex over the host-callback bridge.
 *
 * Native-first: codex has no workflow status or label of its own (`ThreadStatus` is runtime state, `ThreadSection` is a
 * client-managed sidebar section — the reading is on `HOST_CALLBACK_BRIDGE_ROUTES.sessionSetStatus`), so the host
 * supplies the pair once, on the bridge.
 *
 * This suite drives the HOST half — the real `startCodexSessionCallbackBridge`, resolving its ports from the real
 * per-session registry `SessionManager` publishes into for every runtime — with the registry handlers themselves on
 * the far side of a fetch shaped exactly like the subprocess client's (`host-callback-bridge-client.ts`). The real
 * subprocess round-trip is `session-mcp-server/src/host-callback-bridge.test.ts`; the real host closures (the
 * closure rule and the caller-workspace check) are `server-core/.../agent-session-status-closure.test.ts`.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  closedStatusRefusal,
  getToolDefsAsJsonSchema,
  getSessionToolDefs,
  getSessionToolNames,
  HOST_CALLBACK_BRIDGE_ROUTES,
  HOST_CALLBACK_BRIDGE_SESSION_MISMATCH,
  type ResolvedLabelsResult,
  type ResolvedStatusResult,
  type SessionToolContext,
} from '@nessy-agent/session-tools-core'
import {
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '../../../session-scoped-tool-callback-registry.ts'
import { startCodexSessionCallbackBridge, type CodexSessionCallbackBridgeHandle } from '../session-callback-bridge.ts'

const KEY = { workspaceId: 'ws-ua13', sessionId: 'codex-caller' }

/** The registry handlers themselves — the ones every runtime's `set_session_status` / `set_session_labels` runs. */
const handlerOf = (name: string) => {
  const definition = getSessionToolDefs({ externalStandaloneOnly: true, hostCallbackBridge: true }).find(entry => entry.name === name)
  if (!definition?.handler) throw new Error(`${name} has no registry handler on the bridged codex surface`)
  return definition.handler as (ctx: SessionToolContext, args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>
}
const handleSetSessionStatus = (ctx: SessionToolContext, args: { sessionId?: string; status: string }) => handlerOf('set_session_status')(ctx, args)
const handleSetSessionLabels = (ctx: SessionToolContext, args: { sessionId?: string; labels: string[] }) => handlerOf('set_session_labels')(ctx, args)

const STATUSES = [
  { id: 'todo', label: 'Todo', category: 'open' as const },
  { id: 'needs-review', label: 'Needs Review', category: 'open' as const },
  { id: 'done', label: 'Done', category: 'closed' as const },
  { id: 'cancelled', label: 'Cancelled', category: 'closed' as const },
]

let bridge: CodexSessionCallbackBridgeHandle | undefined

afterEach(async () => {
  await bridge?.close()
  bridge = undefined
  unregisterSessionScopedToolCallbacks(KEY)
})

/**
 * The registry slots, shaped like `SessionManager`'s closures: the resolvers answer exact id then case-insensitive
 * label, and the SET closures are the authority — they refuse a closed status (UA1.2's rule, its sentence) and a
 * target outside the caller's workspace, which is what the real ones do.
 */
function bindRegistry() {
  const writes: Array<{ kind: 'status' | 'labels'; sessionId: string | undefined; value: unknown }> = []
  const ownSessions = new Set([KEY.sessionId, 'sibling'])
  const target = (sessionId: string | undefined): string => {
    const id = sessionId ?? KEY.sessionId
    if (!ownSessions.has(id)) throw new Error(`No session "${id}" in your own workspace.`)
    return id
  }
  mergeSessionScopedToolCallbacks(KEY, {
    resolveStatusFn: (status: string): ResolvedStatusResult => {
      const hit = STATUSES.find(s => s.id === status) ?? STATUSES.find(s => s.label.toLowerCase() === status.toLowerCase())
      const available = STATUSES.map(s => s.id)
      return hit ? { resolved: hit.id, available, category: hit.category } : { resolved: null, available }
    },
    setSessionStatusFn: async (sessionId: string | undefined, status: string) => {
      const id = target(sessionId)
      if (STATUSES.find(s => s.id === status)?.category === 'closed') throw new Error(closedStatusRefusal(status))
      writes.push({ kind: 'status', sessionId: id, value: status })
    },
    resolveLabelsFn: (labels: string[]): ResolvedLabelsResult => ({
      resolved: labels.filter(label => label === 'bug'),
      unknown: labels.filter(label => label !== 'bug'),
      available: ['bug'],
    }),
    setSessionLabelsFn: async (sessionId: string | undefined, labels: string[]) => {
      writes.push({ kind: 'labels', sessionId: target(sessionId), value: labels })
    },
  })
  return { writes }
}

/** One POST, shaped exactly as `host-callback-bridge-client.ts` `call` sends it. */
async function post(route: string, payload: unknown, sessionId = KEY.sessionId): Promise<{ status: number; body: { result?: unknown; error?: string } }> {
  const response = await fetch(`http://127.0.0.1:${bridge!.port}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, payload }),
  })
  return { status: response.status, body: (await response.json()) as { result?: unknown; error?: string } }
}

/** The subprocess client's contract: a `{ error }` reply is THROWN, a `{ result }` is returned. */
async function call<T>(route: string, payload: unknown): Promise<T> {
  const { body } = await post(route, payload)
  if (typeof body.error === 'string') throw new Error(body.error)
  return body.result as T
}

/** The codex `SessionToolContext` members `session-mcp-server` binds over the bridge. */
function codexContext(): SessionToolContext {
  return {
    resolveStatus: (status: string) => call<ResolvedStatusResult>(HOST_CALLBACK_BRIDGE_ROUTES.sessionResolveStatus, { status }),
    setSessionStatus: async (sessionId: string | undefined, status: string) => {
      await call(HOST_CALLBACK_BRIDGE_ROUTES.sessionSetStatus, { sessionId, status })
    },
    resolveLabels: (labels: string[]) => call<ResolvedLabelsResult>(HOST_CALLBACK_BRIDGE_ROUTES.sessionResolveLabels, { labels }),
    setSessionLabels: async (sessionId: string | undefined, labels: string[]) => {
      await call(HOST_CALLBACK_BRIDGE_ROUTES.sessionSetLabels, { sessionId, labels })
    },
  } as unknown as SessionToolContext
}

async function start(sessionId = KEY.sessionId): Promise<void> {
  bridge = await startCodexSessionCallbackBridge({ sessionKey: { workspaceId: KEY.workspaceId, sessionId } })
}

describe('positive — the caller\'s status and labels are set over the bridge, from the host registry', () => {
  it('needs-review, named by its label, is resolved on the host and written for the caller', async () => {
    const { writes } = bindRegistry()
    await start()
    const result = await handleSetSessionStatus(codexContext(), { status: 'Needs Review' })
    expect(result.isError).toBeFalsy()
    expect(result.content[0]?.text).toBe('Status set to "needs-review" on current session.')
    expect(writes).toEqual([{ kind: 'status', sessionId: KEY.sessionId, value: 'needs-review' }])
  })

  it('labels resolve and set the same way, and an unknown label is rejected with the handler\'s own text', async () => {
    const { writes } = bindRegistry()
    await start()
    const ok = await handleSetSessionLabels(codexContext(), { labels: ['bug'] })
    expect(ok.isError).toBeFalsy()
    const rejected = await handleSetSessionLabels(codexContext(), { labels: ['nope'] })
    expect(rejected.isError).toBe(true)
    expect(rejected.content[0]?.text).toContain('Labels rejected:')
    expect(writes).toEqual([{ kind: 'labels', sessionId: KEY.sessionId, value: ['bug'] }])
  })
})

describe('negative — what the bridge must refuse', () => {
  it('a closed status is refused by the handler with UA1.2\'s sentence, and nothing is sent to the set route', async () => {
    const { writes } = bindRegistry()
    await start()
    for (const status of ['done', 'Cancelled']) {
      const result = await handleSetSessionStatus(codexContext(), { status })
      expect(result.isError).toBe(true)
      expect(result.content[0]?.text).toContain('Refusing to set the closed status')
    }
    expect(writes).toEqual([])
  })

  it('a body that skips the handler and posts "done" is refused by the host closure, through the wire', async () => {
    const { writes } = bindRegistry()
    await start()
    const { status, body } = await post(HOST_CALLBACK_BRIDGE_ROUTES.sessionSetStatus, { status: 'done' })
    expect(status).toBe(200)
    expect(body.error).toBe(closedStatusRefusal('done'))
    expect(writes).toEqual([])
  })

  it('a target in another workspace is refused by the host closure, and the handler reports the failure', async () => {
    const { writes } = bindRegistry()
    await start()
    const status = await handleSetSessionStatus(codexContext(), { sessionId: 'elsewhere', status: 'todo' })
    expect(status.isError).toBe(true)
    expect(status.content[0]?.text).toBe('[ERROR] Failed to set status: No session "elsewhere" in your own workspace.')
    const labels = await handleSetSessionLabels(codexContext(), { sessionId: 'elsewhere', labels: ['bug'] })
    expect(labels.isError).toBe(true)
    // Positive control on the same instrument: an own-workspace sibling IS reachable.
    const sibling = await handleSetSessionStatus(codexContext(), { sessionId: 'sibling', status: 'todo' })
    expect(sibling.isError).toBeFalsy()
    expect(writes).toEqual([{ kind: 'status', sessionId: 'sibling', value: 'todo' }])
  })

  it('a request naming another SESSION is rejected before any port is touched (403)', async () => {
    const { writes } = bindRegistry()
    await start()
    const { status, body } = await post(HOST_CALLBACK_BRIDGE_ROUTES.sessionSetStatus, { status: 'todo' }, 'someone-else')
    expect(status).toBe(403)
    expect(body.error).toBe(HOST_CALLBACK_BRIDGE_SESSION_MISMATCH)
    expect(writes).toEqual([])
  })

  it('a malformed body is a 400, not a write', async () => {
    const { writes } = bindRegistry()
    await start()
    expect((await post(HOST_CALLBACK_BRIDGE_ROUTES.sessionSetStatus, { status: 7 })).status).toBe(400)
    expect((await post(HOST_CALLBACK_BRIDGE_ROUTES.sessionSetLabels, { labels: 'bug' })).status).toBe(400)
    expect((await post(HOST_CALLBACK_BRIDGE_ROUTES.sessionResolveStatus, {})).status).toBe(400)
    expect((await post(HOST_CALLBACK_BRIDGE_ROUTES.sessionResolveLabels, { labels: [1] })).status).toBe(400)
    expect(writes).toEqual([])
  })

  it('with no registry entry the routes answer "unavailable", never a silent success', async () => {
    await start()
    const result = await handleSetSessionStatus(codexContext(), { status: 'todo' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('set_session_status is unavailable for this session.')
  })
})

/**
 * UA1.2's deferred arm (waves.md O8): the rule lives in the tool DESCRIPTION because that is the one text all three
 * runtimes see — codex never calls `getSystemPrompt` — so the codex projection must carry it byte for byte.
 */
describe('the codex projection is the Pi and Claude one', () => {
  const describedOn = (options: Parameters<typeof getToolDefsAsJsonSchema>[0]) => {
    const definitions = getToolDefsAsJsonSchema(options)
    return ['set_session_status', 'set_session_labels'].map(name => {
      const definition = definitions.find(entry => entry.name === name)
      expect(definition, `${name} is missing from the projection`).toBeDefined()
      return { description: definition!.description, inputSchema: definition!.inputSchema }
    })
  }

  it('the description and input schema are identical on codex (bridged), Pi and Claude', () => {
    const codex = describedOn({ externalStandaloneOnly: true, hostCallbackBridge: true })
    expect(codex).toEqual(describedOn({ projection: 'pi' }))
    expect(codex).toEqual(describedOn(undefined))
    expect(codex[0]!.description).toContain('Never set a closed status')
  })

  it('CONTROL — a codex spawn WITHOUT the host-callback bridge advertises neither tool; with it, both', () => {
    const bare = getSessionToolNames({ externalStandaloneOnly: true })
    const bridged = getSessionToolNames({ externalStandaloneOnly: true, hostCallbackBridge: true })
    for (const name of ['set_session_status', 'set_session_labels']) {
      expect(bare.has(name), `${name} on the bare codex surface`).toBe(false)
      expect(bridged.has(name), `${name} missing from the bridged codex surface`).toBe(true)
    }
  })
})
