/**
 * UA2.5 — the tile's needs-input badge, runtime chip and ModelChip gateway fallback
 * (Nessy adaptations of the v0.13.4 board, spec §9).
 *
 * - The badge is decided by the server's `awaitingApprovalCount` (or this window's own live
 *   card), through the session list's predicate; the subject pair only names the request.
 * - The runtime chip comes from the session's `llmConnection` → its `providerType`; a slug
 *   this window does not know shows no chip.
 * - ModelChip: a model id the registry does not know (a gateway id) uses the connection's
 *   icon instead of upstream's Anthropic default.
 *
 * Rendered with `renderToStaticMarkup` (no DOM in this repo's `bun test`), through the real
 * `deriveBoardTasks` the container calls, with the Pi, Claude and Codex connection fixtures.
 *
 * UA12.77 (spec §11 item 2, "A node blocked on a card shows needs-input"): a subtask row — a Conductor node's
 * child or a quick-add child — carries the same badge, decided by the same predicate on the CHILD's session.
 */
import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { NESTOR_GATEWAY_CHAT_BASE_URL } from '@nessy-agent/shared/auth/nestor'
import type { SessionMeta } from '@/atoms/sessions'
import type { SessionStatus } from '@/config/session-status-config'
import { getProviderIcon } from '@/lib/provider-icons'
import { deriveBoardTasks, type BoardDeriveContext } from '../board-derive'
import { resolveModelChipIcon } from '../ModelChip'
import { TaskTile } from '../TaskTile'
import type { KanbanTask } from '../types'

const KANBAN_DIR = join(import.meta.dir, '..')
const LOCALES_DIR = join(KANBAN_DIR, '..', '..', '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')
const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8')) as Record<string, string>

let testI18n: I18nInstance
beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
})

const TODO: SessionStatus = { id: 'todo', label: 'TODO', resolvedColor: '#888888', icon: null, iconColorable: true, category: 'open' }
const STATUSES_BY_ID = new Map([[TODO.id, TODO]])

/** The three runtimes' connections, as `AppShellContext.llmConnections` carries them. */
const CONNECTIONS: NonNullable<BoardDeriveContext['connections']> = [
  { slug: 'nessy-gateway', providerType: 'pi', baseUrl: NESTOR_GATEWAY_CHAT_BASE_URL },
  { slug: 'claude-gateway', providerType: 'claude-runtime', baseUrl: null },
  { slug: 'codex-gateway', providerType: 'codex-runtime', baseUrl: null },
]
const RUNTIMES = [
  { slug: 'nessy-gateway', label: 'Pi' },
  { slug: 'claude-gateway', label: 'Claude' },
  { slug: 'codex-gateway', label: 'Codex' },
] as const

function tileFor(fields: Partial<SessionMeta>, context: BoardDeriveContext = { connections: CONNECTIONS }): KanbanTask {
  const meta: SessionMeta = { id: 's1', workspaceId: 'ws', name: 'Task', sessionStatus: 'todo', ...fields }
  const [task] = deriveBoardTasks(new Map([[meta.id, meta]]), STATUSES_BY_ID, context)
  if (!task) throw new Error('no tile derived')
  return task
}

function render(task: KanbanTask): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <TaskTile task={task} status={TODO} treatment="stripe" expanded={false} />
    </I18nextProvider>
  )
}

const NEEDS_INPUT = 'data-kanban-needs-input'

describe('UA2.5 — needs-input badge', () => {
  for (const { slug, label } of RUNTIMES) {
    it(`POSITIVE — awaitingApprovalCount > 0 shows the badge on a ${label} session`, () => {
      const html = render(tileFor({ llmConnection: slug, awaitingApprovalCount: 1, awaitingApprovalToolName: 'Bash', awaitingApprovalType: 'bash' }))
      expect(html).toContain(NEEDS_INPUT)
      expect(html).toContain(en['kanban.needsInput']!)
      expect(html).toContain(`aria-label="Waiting for you: Bash"`)
    })
  }

  it('CONTROL — a count of 0 (and none at all) shows no badge, so the positive arm can fail', () => {
    expect(render(tileFor({ llmConnection: 'nessy-gateway', awaitingApprovalCount: 0 }))).not.toContain(NEEDS_INPUT)
    expect(render(tileFor({ llmConnection: 'nessy-gateway' }))).not.toContain(NEEDS_INPUT)
  })

  it('NEGATIVE — a request with no toolName still shows the badge; its label says only "waiting"', () => {
    const task = tileFor({ llmConnection: 'codex-gateway', awaitingApprovalCount: 2 })
    expect(task.needsInput).toBe(true)
    expect(task.waitingOn).toBeUndefined()
    const html = render(task)
    expect(html).toContain(NEEDS_INPUT)
    expect(html).toContain(`aria-label="${en['session.attention.waiting']}"`)
  })

  it('a question names itself; this window\'s live card shows the badge before any count arrives (the list\'s union)', () => {
    const question = render(tileFor({ awaitingApprovalCount: 1, awaitingApprovalToolName: 'ask_user', awaitingApprovalType: 'ask_user' }))
    expect(question).toContain(`aria-label="${en['session.attention.waitingOnQuestion']}"`)
    const local = tileFor(
      { awaitingApprovalCount: 0 },
      { connections: CONNECTIONS, pendingPermissions: new Map([['s1', [{ type: 'bash', toolName: 'Edit' }]]]) }
    )
    expect(local.needsInput).toBe(true)
    expect(local.waitingOn).toEqual({ type: 'bash', toolName: 'Edit' })
  })
})

describe('UA2.5 — runtime chip', () => {
  for (const { slug, label } of RUNTIMES) {
    it(`POSITIVE — a ${label} connection shows the ${label} chip`, () => {
      const task = tileFor({ llmConnection: slug })
      expect(task.runtime).toBeDefined()
      expect(render(task)).toContain(`data-kanban-runtime="${label}"`)
    })
  }

  it('NEGATIVE — an unknown connection shows no chip, and neither does a session with no connection', () => {
    const unknown = tileFor({ llmConnection: 'deleted-connection' })
    expect(unknown.runtime).toBeUndefined()
    expect(unknown.connection).toBeUndefined()
    expect(render(unknown)).not.toContain('data-kanban-runtime')
    expect(render(tileFor({}))).not.toContain('data-kanban-runtime')
    // The same slug IS chipped when the window knows it — the absence above is the lookup.
    expect(render(tileFor({ llmConnection: 'deleted-connection' }, { connections: [{ slug: 'deleted-connection', providerType: 'pi' }] })))
      .toContain('data-kanban-runtime="Pi"')
  })
})

describe('UA2.5 — ModelChip gateway fallback', () => {
  it('a gateway id uses the connection\'s icon, not upstream\'s Anthropic default', () => {
    const codex = tileFor({ llmConnection: 'codex-gateway', model: 'coder' })
    expect(resolveModelChipIcon(codex.model!, codex.connection)).toEqual(getProviderIcon('codex-runtime'))
    expect(resolveModelChipIcon(codex.model!, codex.connection)).not.toEqual(getProviderIcon('anthropic'))
    const pi = tileFor({ llmConnection: 'nessy-gateway', model: 'coder' })
    expect(resolveModelChipIcon(pi.model!, pi.connection)).toEqual(getProviderIcon('pi', NESTOR_GATEWAY_CHAT_BASE_URL))
    expect(resolveModelChipIcon(pi.model!, pi.connection)).not.toEqual(getProviderIcon('anthropic'))
  })

  it('a registry model keeps its provider icon; with no connection a gateway id keeps upstream\'s default', () => {
    const codexConnection = CONNECTIONS[2]
    expect(resolveModelChipIcon('claude-opus-4-8', codexConnection)).toEqual(getProviderIcon('anthropic'))
    expect(resolveModelChipIcon('coder')).toEqual(getProviderIcon('anthropic'))
  })
})

describe('UA12.77 — a subtask whose session waits on a card shows needs-input on its row', () => {
  const SUBTASK_NEEDS_INPUT = 'data-kanban-subtask-needs-input'
  const parent: SessionMeta = { id: 'p', workspaceId: 'ws', name: 'Task', sessionStatus: 'todo', taskSlug: 'ship' }
  const node = (fields: Partial<SessionMeta>): SessionMeta =>
    ({ id: 'c1', workspaceId: 'ws', name: 'Node A', sessionStatus: 'todo', parentSessionId: 'p', taskSlug: 'ship', taskNodeId: 'a', taskRunId: 'r1', messageCount: 1, isProcessing: true, ...fields })
  const deriveWith = (child: SessionMeta, context: BoardDeriveContext = {}) => {
    const [task] = deriveBoardTasks(new Map([[parent.id, parent], [child.id, child]]), STATUSES_BY_ID, {
      connections: CONNECTIONS,
      specNodesBySlug: new Map([['ship', [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]]]),
      ...context,
    })
    if (!task) throw new Error('no tile derived')
    return task
  }
  const renderExpanded = (task: KanbanTask) => renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <TaskTile task={task} status={TODO} treatment="stripe" expanded />
    </I18nextProvider>
  )

  it('POSITIVE — a Conductor node with awaitingApprovalCount 1 carries the badge, naming the request', () => {
    const task = deriveWith(node({ awaitingApprovalCount: 1, awaitingApprovalToolName: 'Bash', awaitingApprovalType: 'bash' }))
    expect(task.subtasks.find(row => row.sessionId === 'c1')).toMatchObject({ needsInput: true, waitingOn: { type: 'bash', toolName: 'Bash' } })
    const html = renderExpanded(task)
    expect(html).toContain(SUBTASK_NEEDS_INPUT)
    expect(html).toContain('aria-label="Waiting for you: Bash"')
  })

  it('NEGATIVE — a count of 0 shows none, and a never-run node row (no session) never does', () => {
    const task = deriveWith(node({ awaitingApprovalCount: 0 }))
    expect(task.subtasks.every(row => !row.needsInput)).toBe(true)
    expect(task.subtasks.find(row => row.id === 'node:b')?.needsInput).toBeUndefined()
    expect(renderExpanded(task)).not.toContain(SUBTASK_NEEDS_INPUT)
  })

  it('POSITIVE — this window\'s live card on the child, and a quick-add child of a plain tile, carry it too', () => {
    const local = deriveWith(node({ awaitingApprovalCount: 0 }), { pendingPermissions: new Map([['c1', [{ type: 'bash', toolName: 'Edit' }]]]) })
    expect(local.subtasks.find(row => row.sessionId === 'c1')?.needsInput).toBe(true)
    const plainParent: SessionMeta = { id: 'p2', workspaceId: 'ws', name: 'Plain', sessionStatus: 'todo' }
    const quick: SessionMeta = { id: 'q1', workspaceId: 'ws', name: 'Quick', sessionStatus: 'todo', parentSessionId: 'p2', awaitingApprovalCount: 2 }
    const [plain] = deriveBoardTasks(new Map([[plainParent.id, plainParent], [quick.id, quick]]), STATUSES_BY_ID, { connections: CONNECTIONS })
    expect(plain?.subtasks).toEqual([expect.objectContaining({ sessionId: 'q1', needsInput: true })])
    expect(plain?.needsInput).toBeUndefined() // the parent's own badge stays its own session's
  })
})
