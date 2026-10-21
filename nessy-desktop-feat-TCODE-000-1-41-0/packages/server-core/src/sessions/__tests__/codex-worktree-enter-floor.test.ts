/**
 * P6.137 — the `EnterWorktree` approval floor for the runtime that reaches no
 * pre-tool gate at all.
 *
 * `evaluateWorktreeApproval` runs inside `runPreToolUseChecks`, and that
 * pipeline has ZERO call sites in `codex-agent.ts` (measured 2026-09-08 with
 * `grep -an 'runPreToolUseChecks(' <file>`: claude 1, pi 6, codex 0). So the
 * three worktree tools crossing to a bridged codex spawn had to bring a floor
 * with them, and this file drives the host's half of it —
 * `SessionManager.authorizeWorktreeEnter` — through the same closure the bridge
 * route resolves.
 *
 * The subject is the CARD and the REFUSALS, not the port: the port is the same
 * object Pi and claude already use, and what this row adds is the judgement in
 * front of it on one runtime.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'
import { resolveWorktreeNamespace } from '@nessy-agent/shared/agent/pi-harness/worktree-layout'

const managers: SessionManager[] = []
const roots: string[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Internals {
  authorizeWorktreeEnter(managed: unknown, input: { path?: string }): Promise<void>
  sessions: Map<string, unknown>
  directPermissionResolvers: Map<string, { resolve(allowed: boolean): void }>
}

/**
 * A session with a PROJECT, which is what anchors the worktree boundary.
 * `withProject: false` is the no-repository shape, and it is a real one: a
 * session opened on a workspace root with no project has no `projectKey`.
 */
function harness(id: string, options: { withProject?: boolean; cwd?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nessy-worktree-floor-'))
  roots.push(root)
  const events: SessionEvent[] = []
  const manager = createTestSessionManager()
  managers.push(manager)
  manager.setEventSink(((...args: unknown[]) => {
    events.push(args[2] as SessionEvent)
  }) as Parameters<SessionManager['setEventSink']>[0])

  const managed = createManagedSession({ id, name: id }, {
    id: 'ws_worktree_floor',
    name: 'Worktree Floor Workspace',
    rootPath: root,
    createdAt: 1,
  } as never, { messagesLoaded: true }) as unknown as Record<string, unknown>
  if (options.withProject !== false) managed.projectKey = `project:${root}`
  managed.workingDirectory = options.cwd ?? root

  const internals = manager as unknown as Internals
  internals.sessions.set(`ws_worktree_floor:${id}`, managed)
  return { manager, managed, internals, events, root }
}

/** The `permission_request` events raised, in order. */
function cards(events: SessionEvent[]) {
  return events.filter(event => event.type === 'permission_request') as Array<
    SessionEvent & { request: Record<string, unknown> }
  >
}

describe('P6.137 · the host EnterWorktree floor', () => {
  it('raises a non-remembered worktree_approval card for a target outside the namespace', async () => {
    const { managed, internals, events } = harness('floor-outside')

    const outcome = internals.authorizeWorktreeEnter(managed, { path: '/tmp/somewhere-else' })
    // The card is raised SYNCHRONOUSLY, before anything is awaited, so a test
    // that answered it later could not race the port.
    const raised = cards(events)
    expect(raised).toHaveLength(1)
    // Read the request into a local before asserting on it (AGENTS.md: a shape
    // asserted with an asymmetric matcher is overwritten by the matcher).
    const request = raised[0]!.request
    expect(request.toolName).toBe('EnterWorktree')
    expect(request.type).toBe('worktree_approval')
    expect(request.command).toBe('/tmp/somewhere-else')
    // `worktrees.md`: "An `EnterWorktree` permission rule or choosing 'don't ask
    // again' doesn't suppress this prompt" — so the client's Always button must
    // not be offered for something the server will not remember.
    expect(request.noAlwaysAllow).toBe(true)
    expect(request.origin).toBe('host_gate')
    // The same sentence the pre-tool gate's own card carries, from the one
    // builder: a user must not meet two wordings for one move.
    expect(String(request.description)).toContain('outside this repository\'s worktree directory')

    internals.directPermissionResolvers.get(String(request.requestId))!.resolve(true)
    await outcome
  })

  it('a denied card refuses the enter, and the refusal names the target', async () => {
    // NEGATIVE. This is the arm that makes the card mean anything: a "no" that
    // let the move happen anyway would be a prompt, not a floor.
    const { managed, internals, events } = harness('floor-denied')

    const outcome = internals.authorizeWorktreeEnter(managed, { path: '/tmp/denied-target' })
    const request = cards(events)[0]!.request
    internals.directPermissionResolvers.get(String(request.requestId))!.resolve(false)

    await expect(outcome).rejects.toThrow('/tmp/denied-target')
    // Nothing is left behind for a later answer to settle.
    expect(internals.directPermissionResolvers.has(String(request.requestId))).toBe(false)
  })

  it('a session with no repository is REFUSED without a card', async () => {
    // The fail-closed direction, and the one a "prompt for everything" floor
    // would get wrong: there is no boundary to judge the target against, so the
    // page's own answer is a refusal rather than a question nobody can answer.
    const { managed, internals, events } = harness('floor-no-project', { withProject: false })

    await expect(internals.authorizeWorktreeEnter(managed, { path: '/tmp/anywhere' }))
      .rejects.toThrow('no repository')
    expect(cards(events)).toHaveLength(0)
  })

  it('creation and a target inside the namespace pass silently', async () => {
    // "New-worktree creation and paths under the repository's worktree
    // directory don't prompt." A floor that carded these would be a second
    // mechanism disagreeing with the documented one on every ordinary call.
    //
    // The namespace is read from `resolveWorktreeNamespace`, never spelled here:
    // this fork's region is `<dirname(repoRoot)>/.nessy-worktrees/<slug>/`, not
    // the `<repoRoot>/.claude/worktrees/` the page names, and a hand-written
    // path would test a boundary the product does not have. (Measured: it does
    // — this case carded a `.claude/worktrees/` path and timed out waiting for
    // an answer, which is the floor working and the test being wrong.)
    const { managed, internals, events, root } = harness('floor-inside')
    const inside = join(
      resolveWorktreeNamespace(root).namespaceRoot,
      'feature-x',
    )

    await internals.authorizeWorktreeEnter(managed, {})
    await internals.authorizeWorktreeEnter(managed, { path: inside })

    expect(cards(events)).toHaveLength(0)
  })
})
