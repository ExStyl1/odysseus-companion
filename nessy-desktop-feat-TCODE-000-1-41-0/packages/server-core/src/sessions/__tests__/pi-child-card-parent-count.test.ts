/**
 * F1.903 (release sittings SIT-ac and SIT-aj, RC #2, 2026-09-25) — a Pi CHILD's
 * permission card must light the badge of the session it is shown in.
 *
 * ## The measured defect
 *
 * A Pi child's card is registered under the hidden CHILD's id
 * (`handleAgentPermissionRequest` via `requestPiToolApproval`) and SHOWN in its
 * visible parent (`permissionSurfaceRouting` names the parent as the request's
 * `parentSessionId`; the renderer's `permissionSurfaceSessionId` and iOS both
 * file it there). `awaitingApprovalCount` counted only records whose
 * `sessionId` is the session itself, so with the child's card on screen the
 * parent read 0 — twice in SIT-ac, reproduced in SIT-aj — while a main-thread
 * card read 1. Every reader of the count missed it: iOS's row badge and
 * app-icon total, another window, the archived-card notice, a rig's approver.
 *
 * ## The rig
 *
 * The REAL `SessionManager` (`createTestSessionManager`), the REAL Pi approval
 * seam (`requestPiToolApproval` → `handleAgentPermissionRequest`), the REAL
 * answer (`respondToPermission`), and the count read where every client reads
 * it: `getSessions()`. Sessions are stubs holding only what those paths read.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GUARDIAN_POLICY_PROMPT } from '@nessy-agent/shared/prompts/guardian'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createTestSessionManager } from './test-session-manager.ts'

// The SessionManager module graph dominates this file's wall time; the bodies are milliseconds.
setDefaultTimeout(120_000)

const root = mkdtempSync(join(tmpdir(), 'nessy-f1903-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

type Card = { requestId: string; sessionId?: string; parentSessionId?: string; agentLabel?: string }
type Stub = Record<string, unknown> & { id: string }

let counter = 0

function rig() {
  const n = ++counter
  const workspaceId = `ws-f1903-${n}`
  const workspace = { id: workspaceId, name: 'F1.903', rootPath: join(root, `ws-${n}`) }
  const stub = (id: string, extra: Record<string, unknown> = {}): Stub => ({
    id,
    activeProvider: 'pi',
    permissionMode: 'ask',
    isProcessing: true,
    lastMessageAt: n,
    messages: [],
    backgroundShellCommands: new Map<string, unknown>(),
    workspace,
    workingDirectory: workspace.rootPath,
    ...extra,
  })
  const child = (id: string, parentId: string, name: string, restrictions: Record<string, unknown>) => stub(id, {
    hidden: true,
    name,
    piParentSessionKey: { workspaceId, sessionId: parentId },
    piChildRestrictions: restrictions,
  })
  const manager = createTestSessionManager() as any
  manager.persistSession = () => undefined
  manager.emitPiHarnessInvalidation = () => undefined
  const cards: Card[] = []
  manager.sendEvent = (event: { type?: string; request?: Card }) => {
    if (event?.type === 'permission_request' && event.request) cards.push({ ...event.request })
  }
  const add = (session: Stub) => {
    manager.sessions.set(encodeSessionKey({ workspaceId, sessionId: session.id }), session)
    return session
  }
  /** The Pi permission service's interactive seam, as a child's (or a parent's) gate calls it. */
  const ask = (session: Stub, decisionId: string, card: Record<string, unknown> = {}): Promise<{ allowed: boolean }> =>
    manager.requestPiToolApproval(session, {
      decisionId,
      toolName: 'Bash',
      type: 'bash',
      command: 'rm -rf ./scratch-dir',
      description: 'Execute: rm -rf ./scratch-dir',
      ...card,
    })
  const deny = (session: Stub, requestId: string) =>
    manager.respondToPermission(session.id, requestId, false, false, undefined, workspaceId)
  /** What every client reads: the Session DTO's count and its subject. */
  const dto = (session: Stub) => {
    const s = (manager.getSessions(workspaceId) as Array<Record<string, unknown>>).find(x => x.id === session.id)
    if (!s) throw new Error(`session ${session.id} not listed`)
    return {
      count: s.awaitingApprovalCount,
      toolName: s.awaitingApprovalToolName,
      type: s.awaitingApprovalType,
    }
  }
  const total = () => (manager.getSessions(workspaceId) as Array<{ awaitingApprovalCount?: number }>)
    .reduce((sum, s) => sum + (s.awaitingApprovalCount ?? 0), 0)
  return { stub, child, add, ask, deny, dto, total, cards, manager, workspaceId }
}

const WORKER = { definitionKey: 'worker', prompt: 'You are a worker.' }
const JUDGE = { prompt: `${GUARDIAN_POLICY_PROMPT}\n\nJudge the planned action.` }

describe('F1.903 — a Pi child\'s card counts on the session it is shown in', () => {
  test('a hidden child\'s card lifts the visible parent\'s count and names its subject; the list counts it once; the answer clears it', async () => {
    const r = rig()
    const parent = r.add(r.stub('parent'))
    const worker = r.add(r.child('worker-1', parent.id, 'worker: clean the scratch dir', WORKER))

    const answer = r.ask(worker, 'pi-decision-child-1')

    // The card is shown in the parent (the routing this count now follows).
    expect(r.cards).toHaveLength(1)
    expect(r.cards[0]).toMatchObject({ sessionId: worker.id, parentSessionId: parent.id })
    // SIT-aj's reading was 0 here.
    expect(r.dto(parent)).toEqual({ count: 1, toolName: 'Bash', type: 'bash' })
    // Counted where it is filed, and only there: a total over the list is one card, not two.
    expect(r.dto(worker)).toEqual({ count: 0, toolName: undefined, type: undefined })
    expect(r.total()).toBe(1)

    // The answer still settles the CHILD's request (validated against the child that asked).
    expect(r.deny(worker, 'pi-decision-child-1')).toBe(true)
    expect(await answer).toMatchObject({ allowed: false })
    expect(r.dto(parent)).toEqual({ count: 0, toolName: undefined, type: undefined })
    expect(r.total()).toBe(0)
  })

  test('a grandchild under a hidden child counts on the visible root, where its card is shown', () => {
    const r = rig()
    const parent = r.add(r.stub('parent'))
    const worker = r.add(r.child('worker-1', parent.id, 'worker: plan', WORKER))
    const nested = r.add(r.child('nested-1', worker.id, 'scout: look around', WORKER))

    void r.ask(nested, 'pi-decision-nested-1')

    expect(r.cards[0]).toMatchObject({ sessionId: nested.id, parentSessionId: parent.id })
    expect(r.dto(parent).count).toBe(1)
    expect(r.dto(worker).count).toBe(0)
    expect(r.dto(nested).count).toBe(0)
  })

  test('CONTROL: a main-thread card still reads 1 on its own session, and a sibling top-level session reads 0', () => {
    const r = rig()
    const parent = r.add(r.stub('parent'))
    const other = r.add(r.stub('other'))
    r.add(r.child('worker-1', parent.id, 'worker: idle', WORKER))

    void r.ask(parent, 'pi-decision-main-1')

    expect(r.cards[0]?.parentSessionId).toBeUndefined()
    expect(r.dto(parent)).toEqual({ count: 1, toolName: 'Bash', type: 'bash' })
    expect(r.dto(other).count).toBe(0)
    expect(r.total()).toBe(1)
  })

  test('NEGATIVE: a Guardian judge child raises no card (F1.920), so nothing is counted on the parent or the child', async () => {
    const r = rig()
    const parent = r.add(r.stub('parent'))
    const judge = r.add(r.child('judge-1', parent.id, 'scout: Judge the following planned action', JUDGE))

    const answer = await r.ask(judge, 'pi-decision-judge-1')

    expect(answer.allowed).toBe(false)
    expect(r.cards).toEqual([])
    expect(r.dto(parent).count).toBe(0)
    expect(r.dto(judge).count).toBe(0)
  })

  test('BOUNDARY: a child whose parent is not loaded has no surface to move to and stays counted on itself', () => {
    const r = rig()
    const orphan = r.add(r.child('orphan-1', 'parent-not-loaded', 'worker: orphaned', WORKER))

    void r.ask(orphan, 'pi-decision-orphan-1')

    // The renderer files a card with no `parentSessionId` under the session that asked.
    expect(r.cards[0]?.parentSessionId).toBeUndefined()
    expect(r.dto(orphan)).toEqual({ count: 1, toolName: 'Bash', type: 'bash' })
  })
})

/**
 * F1.1096 — `awaiting-approval-count.test.ts` pinned these properties on a COPY
 * of the old per-session rule, so it passed without describing the product (and
 * kept passing when F1.903 changed the rule). That file is retired; the
 * properties it alone held are read here off the REAL count and subject, through
 * the same seam and the same DTO every client reads.
 */
describe('F1.1096 — the count and its subject, read off the real SessionManager', () => {
  test('two cards on one session count 2, not "1 or more", and the subject names the FIRST raised', () => {
    const r = rig()
    const parent = r.add(r.stub('parent'))

    void r.ask(parent, 'pi-decision-first')
    void r.ask(parent, 'pi-decision-second', { toolName: 'Write', type: 'file_write', description: 'Write: notes.md' })

    expect(r.dto(parent)).toEqual({ count: 2, toolName: 'Bash', type: 'bash' })
    // Answering the first leaves one, and the subject moves to the one still waiting.
    expect(r.deny(parent, 'pi-decision-first')).toBe(true)
    expect(r.dto(parent)).toEqual({ count: 1, toolName: 'Write', type: 'file_write' })
  })

  test('the same session id in ANOTHER workspace reads 0 — the count is per workspace too', () => {
    const r = rig()
    const parent = r.add(r.stub('parent'))
    const otherWorkspace = { id: `${r.workspaceId}-other`, name: 'F1.1096 other', rootPath: join(root, `${r.workspaceId}-other`) }
    r.manager.sessions.set(
      encodeSessionKey({ workspaceId: otherWorkspace.id, sessionId: parent.id }),
      { ...r.stub(parent.id), workspace: otherWorkspace, workingDirectory: otherWorkspace.rootPath },
    )

    void r.ask(parent, 'pi-decision-ws-1')

    expect(r.dto(parent).count).toBe(1)
    const twin = (r.manager.getSessions(otherWorkspace.id) as Array<Record<string, unknown>>).find(x => x.id === parent.id)
    expect(twin).toBeDefined()
    expect(twin!.awaitingApprovalCount).toBe(0)
    expect(twin!.awaitingApprovalToolName).toBeUndefined()
  })
})
