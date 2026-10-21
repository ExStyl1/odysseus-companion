/**
 * UA3.5 — `create_board_task` reaches codex over the host-callback bridge, onto the SAME registry slot
 * (`createBoardTaskFn`) `SessionManager` binds for Pi and Claude in process — so every restriction on the invoking
 * agent (its folder, project, sources and connection; no mode) is the one closure's, not a codex copy.
 *
 * Native-first, step 1: codex has no board or task API of its own (spec §4), so step 2 is the bridge. This suite
 * drives the HOST half (the real `startCodexSessionCallbackBridge` resolving from the real registry) with the registry
 * handler on the far side of a fetch shaped like the subprocess client's. The real subprocess round trip is
 * `session-mcp-server/src/host-callback-bridge.test.ts`; the real restrictions are
 * `server-core/src/tasks/create-board-task.test.ts`.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  getSessionToolDefs,
  getSessionToolNames,
  getToolDefsAsJsonSchema,
  HOST_CALLBACK_BRIDGE_ROUTES,
  HOST_CALLBACK_BRIDGE_SESSION_MISMATCH,
  type CreateBoardTaskInput,
  type CreateBoardTaskResult,
  type SessionToolContext,
} from '@nessy-agent/session-tools-core'
import {
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '../../../session-scoped-tool-callback-registry.ts'
import { startCodexSessionCallbackBridge, type CodexSessionCallbackBridgeHandle } from '../session-callback-bridge.ts'
import { SESSION_TOOL_DISPLAY_NAMES } from '../../../../utils/toolNames.ts'

const KEY = { workspaceId: 'ws-ua35', sessionId: 'codex-caller' }

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

function bindRegistry(answer: (input: CreateBoardTaskInput) => CreateBoardTaskResult) {
  const calls: CreateBoardTaskInput[] = []
  mergeSessionScopedToolCallbacks(KEY, {
    createBoardTaskFn: async input => { calls.push(input); return answer(input) },
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

function codexContext(): SessionToolContext {
  return {
    createBoardTask: async (input: CreateBoardTaskInput) => {
      const { body } = await post(HOST_CALLBACK_BRIDGE_ROUTES.taskCreate, input)
      if (typeof body.error === 'string') throw new Error(body.error)
      return body.result as CreateBoardTaskResult
    },
  } as unknown as SessionToolContext
}

async function start(sessionId = KEY.sessionId): Promise<void> {
  bridge = await startCodexSessionCallbackBridge({ sessionKey: { workspaceId: KEY.workspaceId, sessionId } })
}

const created = (): CreateBoardTaskResult => ({ slug: 'fix-login', orchestratorSessionId: 'orch-1', warnings: ['Unknown skills (kept in the spec, but they don\'t exist in this workspace): ghost'] })

describe('positive — the codex call reaches the one host closure', () => {
  it('the handler passes the tool input through and returns { slug, orchestratorSessionId, warnings }', async () => {
    const { calls } = bindRegistry(created)
    await start()
    const result = await handlerOf('create_board_task')(codexContext(), { title: 'Fix login', description: 'Find the loop', skills: ['ghost'] })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual(created())
    expect(calls).toEqual([{ title: 'Fix login', description: 'Find the loop', skills: ['ghost'] }])
  })

  it('the description and input schema are IDENTICAL on codex (bridged), Pi and Claude', () => {
    const pick = (defs: ReturnType<typeof getToolDefsAsJsonSchema>) => defs.find(def => def.name === 'create_board_task')
    const codex = pick(getToolDefsAsJsonSchema({ externalStandaloneOnly: true, hostCallbackBridge: true }))
    expect(codex).toBeDefined()
    expect(pick(getToolDefsAsJsonSchema({ projection: 'pi' }))).toEqual(codex)
    expect(pick(getToolDefsAsJsonSchema({}))).toEqual(codex)
  })
})

describe('negative — refusals reach the model as refusals; the bridge adds no gate and no hole', () => {
  it('a host refusal (a foreign folder) is the tool\'s error, with the closure\'s code', async () => {
    bindRegistry(() => { throw new Error('project-handle-required: a task created by an agent runs in the creating session\'s own working folder') })
    await start()
    const result = await handlerOf('create_board_task')(codexContext(), { title: 'T', description: 'D', workingDirectory: '/etc' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('project-handle-required')
  })

  it('a foreign SESSION envelope is a 403 before the closure is reached', async () => {
    const { calls } = bindRegistry(created)
    await start()
    const { status, body } = await post(HOST_CALLBACK_BRIDGE_ROUTES.taskCreate, { title: 'T', description: 'D' }, 'someone-else')
    expect(status).toBe(403)
    expect(body.error).toBe(HOST_CALLBACK_BRIDGE_SESSION_MISMATCH)
    expect(calls).toEqual([])
  })

  it('malformed bodies are 400s and never reach the closure', async () => {
    const { calls } = bindRegistry(created)
    await start()
    expect((await post(HOST_CALLBACK_BRIDGE_ROUTES.taskCreate, {})).status).toBe(400)
    expect((await post(HOST_CALLBACK_BRIDGE_ROUTES.taskCreate, { title: 'T' })).status).toBe(400)
    expect((await post(HOST_CALLBACK_BRIDGE_ROUTES.taskCreate, { title: 'T', description: 'D', sources: 'github' })).status).toBe(400)
    expect((await post(HOST_CALLBACK_BRIDGE_ROUTES.taskCreate, { title: 'T', description: 'D', sources: [1] })).status).toBe(400)
    expect((await post(HOST_CALLBACK_BRIDGE_ROUTES.taskCreate, { title: 'T', description: 'D', llmConnection: 7 })).status).toBe(400)
    expect(calls).toEqual([])
  })

  it('a field the tool does not declare (a mode, a session id) is dropped on the way in (narrowed)', async () => {
    const { calls } = bindRegistry(created)
    await start()
    await post(HOST_CALLBACK_BRIDGE_ROUTES.taskCreate, { title: 'T', description: 'D', permissionMode: 'bypassPermissions', sessionId: 'other' })
    expect(calls).toEqual([{ title: 'T', description: 'D' }])
  })

  it('no registry entry → "unavailable", never a silent success', async () => {
    await start()
    const result = await handlerOf('create_board_task')(codexContext(), { title: 'T', description: 'D' })
    expect(result.isError).toBe(true)
  })

  it('the turn header and the host display meta name the tool (one table)', () => {
    expect(SESSION_TOOL_DISPLAY_NAMES.create_board_task).toBe('Create Board Task')
    expect(SESSION_TOOL_DISPLAY_NAMES.create_task).toBeUndefined()
  })

  it('CONTROL: offered on a codex spawn with the bridge, absent from one without it', () => {
    expect(getSessionToolNames({ externalStandaloneOnly: true }).has('create_board_task')).toBe(false)
    expect(getSessionToolNames({ externalStandaloneOnly: true, hostCallbackBridge: true }).has('create_board_task')).toBe(true)
  })

  it('UA1.8\'s rule: block and NOT readOnly (codex asks / refuses it in Plan and Don\'t ask); no mode in the schema', () => {
    const def = getSessionToolDefs({ externalStandaloneOnly: true, hostCallbackBridge: true }).find(entry => entry.name === 'create_board_task')!
    expect([def.safeMode, Boolean(def.readOnly)]).toEqual(['block', false])
    const schema = getToolDefsAsJsonSchema({ externalStandaloneOnly: true, hostCallbackBridge: true })
      .find(entry => entry.name === 'create_board_task')!.inputSchema as { properties: Record<string, unknown> }
    expect(Object.keys(schema.properties).filter(key => /mode/i.test(key))).toEqual(['model'])
  })
})
