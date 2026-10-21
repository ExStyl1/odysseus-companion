/**
 * UA6.3 — the six page tools reach every runtime through ONE grouped host closure (`ctx.pages`, the registry slot
 * `pages` that `SessionManager.pagesToolCallbacksForAgent` binds): Pi and Claude in process, codex over the six
 * `/page/*` host-callback routes — so storage, the `pages:changed` push and `delete_page`'s one-shot card are the one
 * closure's, never a codex copy.
 *
 * Native-first, step 1: codex has no page store or dashboard surface to enable, so step 2 is the bridge. This suite
 * drives the HOST half (the real `startCodexSessionCallbackBridge` resolving from the real registry) with the registry
 * closure on the far side of a fetch shaped like the subprocess client's. The real subprocess round trip is
 * `session-mcp-server/src/host-callback-bridge.test.ts`; the real card, AND SessionManager's binding of the slot (the
 * real `getOrCreateAgent`), are `server-core/src/sessions/__tests__/delete-page-host-card.test.ts` — this suite binds
 * the slot itself, so it proves the readers, never the binding.
 *
 * Plan arms (UA6.3 Tests):
 * - positive: Pi and Claude advertise the six tools, and codex does when the spawn has the host-callback bridge;
 * - negative: a codex spawn without the bridge advertises none.
 * - UA6.7: `list_pages`, `get_page` and `delete_page` describe share state and unpublish-on-delete (v0.13.4 tool-defs.ts
 *   L563, L565, L567, L587); no input schema takes a share field and no description promises a password.
 * - UA8.2: `create_page` and `update_page` carry `refresh` as script CONTENT (`scriptContent`, never a `script` path);
 *   it crosses the bridge as an object (or null on update) and reaches the closure verbatim — the host's
 *   `setPageRefresh` is the one validator — and a non-object refresh is MALFORMED (400).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  getSessionToolDefs,
  getSessionToolNames,
  getToolDefsAsJsonSchema,
  HOST_CALLBACK_BRIDGE_ROUTES,
  HOST_CALLBACK_BRIDGE_SESSION_MISMATCH,
  type PagesToolCallbacks,
  type PageToolDetails,
  type SessionToolContext,
} from '@nessy-agent/session-tools-core'
import {
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '../../../session-scoped-tool-callback-registry.ts'
import { attachSessionSelfManagementBindings } from '../../../session-self-management-bindings.ts'
import { startCodexSessionCallbackBridge, type CodexSessionCallbackBridgeHandle } from '../session-callback-bridge.ts'
import { SESSION_TOOL_DISPLAY_NAMES } from '../../../../utils/toolNames.ts'

const PAGE_TOOLS = ['list_pages', 'get_page', 'create_page', 'update_page', 'write_page_data', 'delete_page'] as const
const KEY = { workspaceId: 'ws-ua63', sessionId: 'codex-caller' }

type Handler = (ctx: SessionToolContext, args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>
const handlerOf = (name: string): Handler => {
  const definition = getSessionToolDefs({ externalStandaloneOnly: true, hostCallbackBridge: true }).find(entry => entry.name === name)
  if (!definition?.handler) throw new Error(`${name} has no registry handler on the bridged codex surface`)
  return definition.handler as Handler
}

let bridge: CodexSessionCallbackBridgeHandle | undefined

afterEach(async () => {
  await bridge?.close()
  bridge = undefined
  unregisterSessionScopedToolCallbacks(KEY)
})

const DETAILS: PageToolDetails = {
  slug: 'build-health', name: 'Build Health', kind: 'live', createdAt: 1, updatedAt: 2, hasContent: true, shared: false,
  folderPath: '/ws/pages/build-health', id: 'page_1', contentPath: '/ws/pages/build-health/index.html', data: null, grants: [],
}

function bindRegistry(overrides: Partial<PagesToolCallbacks> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const pages: PagesToolCallbacks = {
    listPages: () => { calls.push({ method: 'listPages', args: [] }); return [DETAILS] },
    getPage: (slug, options) => { calls.push({ method: 'getPage', args: [slug, options] }); return slug === 'build-health' ? DETAILS : null },
    createPage: async input => { calls.push({ method: 'createPage', args: [input] }); return DETAILS },
    updatePage: async (slug, patch) => { calls.push({ method: 'updatePage', args: [slug, patch] }); return DETAILS },
    writePageData: async (slug, patch) => {
      calls.push({ method: 'writePageData', args: [slug, patch] })
      return { slug, kvCount: 1, seriesCount: 0, generatedAt: 3, snapshotPath: '/ws/pages/build-health/data/snapshot.json', durationMs: 1 }
    },
    deletePage: async slug => { calls.push({ method: 'deletePage', args: [slug] }); return { deleted: true, publicCopyMayRemain: false } },
    ...overrides,
  }
  mergeSessionScopedToolCallbacks(KEY, { pages })
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

/** The codex subprocess's `ctx.pages`, as `createBridgePages` builds it: one route per member. */
function codexContext(): SessionToolContext {
  const call = async <T>(route: string, payload: unknown): Promise<T> => {
    const { body } = await post(route, payload)
    if (typeof body.error === 'string') throw new Error(body.error)
    return body.result as T
  }
  const pages: PagesToolCallbacks = {
    listPages: () => call(HOST_CALLBACK_BRIDGE_ROUTES.pageList, {}),
    getPage: (slug, options) => call(HOST_CALLBACK_BRIDGE_ROUTES.pageGet, { slug, includeContent: options?.includeContent === true }),
    createPage: input => call(HOST_CALLBACK_BRIDGE_ROUTES.pageCreate, input),
    updatePage: (slug, patch) => call(HOST_CALLBACK_BRIDGE_ROUTES.pageUpdate, { slug, patch }),
    writePageData: (slug, patch) => call(HOST_CALLBACK_BRIDGE_ROUTES.pageWriteData, { slug, patch }),
    deletePage: slug => call(HOST_CALLBACK_BRIDGE_ROUTES.pageDelete, { slug }),
  }
  return { pages } as unknown as SessionToolContext
}

async function start(): Promise<void> {
  bridge = await startCodexSessionCallbackBridge({ sessionKey: KEY })
}

const schemaOf = (options: Parameters<typeof getToolDefsAsJsonSchema>[0], name: string) =>
  getToolDefsAsJsonSchema(options).find(entry => entry.name === name)

describe('positive — offered on Pi and Claude, and on codex with the bridge; one closure behind all three', () => {
  it('Pi and Claude advertise the six tools; a bridged codex spawn does too', () => {
    const pi = getSessionToolNames({ projection: 'pi' })
    const claude = getSessionToolNames({})
    const codexBridged = getSessionToolNames({ externalStandaloneOnly: true, hostCallbackBridge: true })
    for (const name of PAGE_TOOLS) {
      expect([name, pi.has(name), claude.has(name), codexBridged.has(name)]).toEqual([name, true, true, true])
    }
  })

  it('the description and input schema are IDENTICAL on codex (bridged), Pi and Claude', () => {
    for (const name of PAGE_TOOLS) {
      const codex = schemaOf({ externalStandaloneOnly: true, hostCallbackBridge: true }, name)
      expect(codex).toBeDefined()
      expect(schemaOf({ projection: 'pi' }, name)).toEqual(codex)
      expect(schemaOf({}, name)).toEqual(codex)
    }
  })

  it('Pi and Claude reach the registry slot in process: the context getter reads the registry slot `pages` (bound here by the test)', async () => {
    const { calls } = bindRegistry()
    const ctx = {} as SessionToolContext
    attachSessionSelfManagementBindings(ctx, KEY)
    const result = await handlerOf('list_pages')(ctx, {})
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(result.content[0]?.text ?? '{}').total).toBe(1)
    expect(calls).toEqual([{ method: 'listPages', args: [] }])
  })

  it('every codex call reaches its own member of the one host closure, with the body narrowed to the tool fields', async () => {
    const { calls } = bindRegistry()
    await start()
    const ctx = codexContext()
    const results = [
      await handlerOf('list_pages')(ctx, {}),
      await handlerOf('get_page')(ctx, { slug: 'build-health', includeContent: true }),
      await handlerOf('create_page')(ctx, { name: 'Build Health', kind: 'live', refresh: { cron: '*/15 * * * *', scriptContent: 'console.log(1)' } }),
      await handlerOf('update_page')(ctx, { slug: 'build-health', description: null, refresh: null }),
      await handlerOf('write_page_data')(ctx, { slug: 'build-health', set: { a: 1 }, appendSeries: { m: [{ v: 2, extra: 'x' }] } }),
      await handlerOf('delete_page')(ctx, { slug: 'build-health' }),
    ]
    expect(results.map(result => Boolean(result.isError))).toEqual([false, false, false, false, false, false])
    expect(calls).toEqual([
      { method: 'listPages', args: [] },
      { method: 'getPage', args: ['build-health', { includeContent: true }] },
      // UA8.2: `refresh` crosses as an object (or null) and reaches the closure verbatim; the host validates it.
      { method: 'createPage', args: [{ name: 'Build Health', kind: 'live', refresh: { cron: '*/15 * * * *', scriptContent: 'console.log(1)' } }] },
      { method: 'updatePage', args: ['build-health', { description: null, refresh: null }] },
      { method: 'writePageData', args: ['build-health', { set: { a: 1 }, appendSeries: { m: [{ v: 2 }] } }] },
      { method: 'deletePage', args: ['build-health'] },
    ])
  })

  it('the turn header and the host display meta name the six tools (one table)', () => {
    expect(PAGE_TOOLS.map(name => SESSION_TOOL_DISPLAY_NAMES[name])).toEqual([
      'List Pages', 'Get Page', 'Create Page', 'Update Page', 'Write Page Data', 'Delete Page',
    ])
  })
})

describe('negative — withheld without the bridge; share state is output only; refresh is content; refusals stay refusals', () => {
  it('a codex spawn WITHOUT the bridge advertises none of the six', () => {
    const bare = getSessionToolNames({ externalStandaloneOnly: true })
    expect(PAGE_TOOLS.filter(name => bare.has(name))).toEqual([])
    expect(getToolDefsAsJsonSchema({ externalStandaloneOnly: true }).filter(def => (PAGE_TOOLS as readonly string[]).includes(def.name))).toEqual([])
  })

  it('UA6.7: list_pages, get_page and delete_page describe share state and unpublish-on-delete; the others do not', () => {
    const describesShare = PAGE_TOOLS.filter(name => /share state|unpublished first/.test(schemaOf({ projection: 'pi' }, name)!.description))
    expect(describesShare).toEqual(['list_pages', 'get_page', 'delete_page'])
  })

  it('UA6.7 (boundary): no input schema takes a share field and no description promises a password', () => {
    for (const name of PAGE_TOOLS) {
      const def = schemaOf({ projection: 'pi' }, name)!
      expect([name, /share|publish/i.test(JSON.stringify(def.inputSchema)), /password/i.test(def.description)]).toEqual([name, false, false])
    }
  })

  it('CONTROL — the password needle fires on the upstream list_pages wording it exists to keep out', () => {
    const upstream = 'rendered in the app\'s Pages section (sidebar) and optionally shared via password-protected public links.'
    expect(/password/i.test(upstream)).toBe(true)
  })

  it('UA8.2: create_page and update_page take refresh as scriptContent, never a script path; in process it reaches the closure', async () => {
    for (const name of ['create_page', 'update_page']) {
      const schema = schemaOf({ projection: 'pi' }, name)!.inputSchema as { properties: Record<string, { properties?: Record<string, unknown>; anyOf?: Array<{ properties?: Record<string, unknown> }> }> }
      const refresh = schema.properties.refresh!
      const fields = Object.keys(refresh.properties ?? refresh.anyOf?.find(branch => branch.properties)?.properties ?? {})
      expect([name, fields.includes('scriptContent'), fields.includes('script')]).toEqual([name, true, false])
    }
    // In process (Pi, Claude): a refresh-only update is a change and reaches the host closure.
    const { calls } = bindRegistry()
    const ctx = {} as SessionToolContext
    attachSessionSelfManagementBindings(ctx, KEY)
    const refresh = { cron: '*/15 * * * *', scriptContent: 'console.log(1)' }
    const refreshOnly = await handlerOf('update_page')(ctx, { slug: 'build-health', refresh })
    expect(refreshOnly.isError).toBeFalsy()
    expect(calls).toEqual([{ method: 'updatePage', args: ['build-health', { refresh }] }])
  })

  it('UA1.8\'s rule: the reads are allow + readOnly, the four mutations block and NOT readOnly', () => {
    const defs = getSessionToolDefs({ externalStandaloneOnly: true, hostCallbackBridge: true })
    expect(PAGE_TOOLS.map(name => {
      const def = defs.find(entry => entry.name === name)!
      return [name, def.safeMode, Boolean(def.readOnly)]
    })).toEqual([
      ['list_pages', 'allow', true],
      ['get_page', 'allow', true],
      ['create_page', 'block', false],
      ['update_page', 'block', false],
      ['write_page_data', 'block', false],
      ['delete_page', 'block', false],
    ])
  })

  it('a declined delete (the host card) is the tool\'s error, and nothing else is called', async () => {
    const { calls } = bindRegistry({
      deletePage: async () => { throw new Error('The user declined deleting the page "Build Health" (build-health); nothing was deleted.') },
    })
    await start()
    const result = await handlerOf('delete_page')(codexContext(), { slug: 'build-health' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Failed to delete page: The user declined')
    expect(calls).toEqual([])
  })

  it('a foreign SESSION envelope is a 403 before the closure is reached', async () => {
    const { calls } = bindRegistry()
    await start()
    const { status, body } = await post(HOST_CALLBACK_BRIDGE_ROUTES.pageDelete, { slug: 'build-health' }, 'someone-else')
    expect(status).toBe(403)
    expect(body.error).toBe(HOST_CALLBACK_BRIDGE_SESSION_MISMATCH)
    expect(calls).toEqual([])
  })

  it('malformed bodies are 400s and never reach the closure', async () => {
    const { calls } = bindRegistry()
    await start()
    const statuses = [
      (await post(HOST_CALLBACK_BRIDGE_ROUTES.pageGet, {})).status,
      (await post(HOST_CALLBACK_BRIDGE_ROUTES.pageGet, { slug: 'a', includeContent: 'yes' })).status,
      (await post(HOST_CALLBACK_BRIDGE_ROUTES.pageCreate, {})).status,
      (await post(HOST_CALLBACK_BRIDGE_ROUTES.pageCreate, { name: 'n', kind: 3 })).status,
      (await post(HOST_CALLBACK_BRIDGE_ROUTES.pageUpdate, { slug: 'a', patch: { projectId: 7 } })).status,
      (await post(HOST_CALLBACK_BRIDGE_ROUTES.pageCreate, { name: 'n', refresh: 'scripts/x.ts' })).status, // UA8.2
      (await post(HOST_CALLBACK_BRIDGE_ROUTES.pageUpdate, { slug: 'a', patch: { refresh: [1] } })).status, // UA8.2
      (await post(HOST_CALLBACK_BRIDGE_ROUTES.pageWriteData, { slug: 'a', patch: { set: [1] } })).status,
      (await post(HOST_CALLBACK_BRIDGE_ROUTES.pageWriteData, { slug: 'a', patch: { appendSeries: { m: [{ v: 'x' }] } } })).status,
      (await post(HOST_CALLBACK_BRIDGE_ROUTES.pageWriteData, { slug: 'a', patch: { pruneSeries: { m: 'x' } } })).status,
      (await post(HOST_CALLBACK_BRIDGE_ROUTES.pageDelete, { slug: 7 })).status,
    ]
    expect(statuses).toEqual([400, 400, 400, 400, 400, 400, 400, 400, 400, 400, 400])
    expect(calls).toEqual([])
  })

  it('no registry entry → "unavailable", never a silent success', async () => {
    await start()
    const result = await handlerOf('delete_page')(codexContext(), { slug: 'build-health' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('delete_page is unavailable')
  })
})
