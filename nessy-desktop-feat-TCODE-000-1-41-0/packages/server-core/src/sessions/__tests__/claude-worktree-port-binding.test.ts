/**
 * P2.465 — the host half of P2.458's worktree seam.
 *
 * P2.458 built the port and shipped it deliberately UNFED, because arming it
 * wrong does not degrade: `hooks.md#exit-code-2-behavior-per-event` gives this
 * one event no fall-through — *"The exception is `WorktreeCreate`, where any
 * non-zero exit code aborts worktree creation."* So every row below is written
 * against the same question: does this change close P2.427's leak on the
 * subagent and background-session routes WITHOUT converting a `git worktree`
 * that works today into a hard failure.
 *
 * The two gates on the builder are therefore not caution, and each has its own
 * row plus its own mutant:
 *
 *  - **Managed `disableAllHooks`.** The vendored binary's two halves disagree.
 *    `executeHooksOutsideREPL` returns nothing at all under the managed policy
 *    (`if(zre())return C(\`Skipping hooks for ${s} due to 'disableAllHooks'
 *    managed setting\`),[]`), while `hasWorktreeCreateHook` — the gate that
 *    decides whether the hook is called AT ALL — never consults it and still
 *    sees an SDK-registered callback. The result is a thrown
 *    `"WorktreeCreate hook failed: hook is configured but did not run"`.
 *  - **No project handle.** The lease service resolves its repository through
 *    `projectHandleService` and throws `worktree-project-required` without one,
 *    so a project-less session could only ever refuse — and a refusal aborts.
 *
 * The trust arm of that same failure string needed no gate, and the reason is
 * structural: the gate is `oet()` = `!XPe()`, and
 * `XPe(){if(bn())return!0;return yp()}` with `bn()` = `!jt.isInteractive`. The
 * SDK spawns the binary `stdio:["pipe","pipe","pipe"]`, so `!process.stdout
 * .isTTY` holds and the session is non-interactive, which short-circuits
 * `XPe()` true. Recorded in `createClaudeWorktreePort`'s docblock, not asserted
 * here — it is a property of a closed binary, and a test over this repo cannot
 * pin it.
 *
 * NOTHING HERE TOUCHES A REAL GIT REPOSITORY. The lease service is a fake, so
 * the paths are strings; what is measured is the port over it, the two gates,
 * and the composition with `withClaudeWorktreeHooks`.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withClaudeWorktreeHooks } from '@nessy-agent/shared/agent/backend/claude/worktree-hooks'
import type { ClaudeWorktreePort } from '@nessy-agent/shared/agent/backend/claude/worktree-port'
import { DEFAULT_MANAGED_PI_POLICY } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import type { SdkAutomationCallbackMatcher, SdkAutomationCallbackResult, SdkAutomationInput } from '@nessy-agent/shared/automations/types'
import type { PiWorktreeLeaseV1 } from '@nessy-agent/shared/sessions/types'
import { createManagedSession } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A claude session whose lease service is observable.
 *
 * Only the lease SERVICE is faked. The port, both gates, the drain
 * registration and the cwd contract are the real ones — the point of the row
 * "the parent session does not move" is that `mutateWorkingDirectory` is not
 * stubbed out from under it.
 */
function fixture(options: {
  /** Omit to get a session WITH a project, which is the wired case. */
  project?: false
  managedDisableAllHooks?: true
  /** Make `acquire` fail, the way a dirty repo or a collision does. */
  acquireError?: string
} = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'nessy-claude-worktree-port-'))
  roots.push(stateRoot)

  const manager = createTestSessionManager(
    options.managedDisableAllHooks
      ? { managedPiPolicy: { ...DEFAULT_MANAGED_PI_POLICY, disableAllHooks: true } }
      : {},
  ) as any

  const workspace = {
    id: 'ws-claude-worktree-port',
    name: 'Claude Worktree Port Workspace',
    slug: 'claude-worktree-port-workspace',
    rootPath: join(stateRoot, 'workspace'),
    createdAt: Date.now(),
  }
  const projectPath = join(stateRoot, 'project')
  const managed = createManagedSession(
    {
      id: 'session-1',
      workingDirectory: projectPath,
      ...(options.project === false ? {} : { projectKey: 'project-key' }),
    },
    workspace as never,
    { messagesLoaded: true, ephemeral: true },
  )
  const key = `${workspace.id}:${managed.id}`
  manager.sessions.set(key, managed)
  manager.persistSession = () => undefined

  const listed: PiWorktreeLeaseV1[] = []
  const acquired: { ownerAgentId: string; worktreeLeaseId: string }[] = []
  const released: string[] = []
  const service = {
    list: () => listed.map(value => ({ ...value })),
    acquire: async (input: { ownerAgentId: string; worktreeLeaseId: string }) => {
      acquired.push(input)
      if (options.acquireError) throw new Error(options.acquireError)
      const lease: PiWorktreeLeaseV1 = {
        schemaVersion: 1,
        worktreeLeaseId: input.worktreeLeaseId,
        workspaceId: workspace.id,
        ownerAgentId: input.ownerAgentId,
        path: join(stateRoot, '.nessy-worktrees', input.worktreeLeaseId),
        branch: `nessy/${input.ownerAgentId}/${input.worktreeLeaseId}`,
        baseSha: 'abc123',
        status: 'active',
        lastUsedAt: '2026-08-31T00:00:00.000Z',
      }
      listed.push(lease)
      return { ...lease }
    },
    release: async (id: string) => {
      released.push(id)
      const index = listed.findIndex(value => value.worktreeLeaseId === id)
      if (index >= 0) listed.splice(index, 1)
    },
    touch: async () => undefined,
    recover: async () => [],
    sweepOrphans: async () => ({ dryRun: false, removed: [], skipped: [] }),
    setEmit: () => {},
  }
  let built = 0
  manager.createPiWorktreeLeaseService = () => {
    built += 1
    manager.piWorktreeLeaseServices.set(key, service)
    return service
  }

  return {
    manager,
    managed,
    projectPath,
    listed,
    acquired,
    released,
    buildCount: () => built,
    port: (): ClaudeWorktreePort | undefined => manager.createClaudeWorktreePort(managed),
    cleanup: () => manager.cleanup?.(),
  }
}

async function fire(
  matchers: SdkAutomationCallbackMatcher[] | undefined,
  input: Record<string, unknown>,
): Promise<Awaited<ReturnType<SdkAutomationCallbackMatcher['hooks'][number]>>[]> {
  const results = []
  for (const matcher of matchers ?? []) {
    for (const hook of matcher.hooks) {
      // `SdkAutomationCallback`'s third parameter is the OPTIONS bag
      // (`{ signal?: AbortSignal }`), not the signal.
      results.push(await hook(input as unknown as SdkAutomationInput, 'tool-use-id', {}))
    }
  }
  return results
}

describe('P2.465 · the port leases, records and releases', () => {
  /**
   * KILLS: a `create` that returns a path the lease service never minted (the
   * "helpfully compute a directory" mutant), and a `create` wired to the wrong
   * lease id. The lease list is read directly, so what is asserted is the
   * RECORD — which is the only thing P2.427's sweep can ever act on.
   */
  it('leases the worktree the hook asked for and answers with the lease path', async () => {
    const rig = fixture()
    const port = rig.port()
    expect(port).toBeDefined()

    const outcome = await port!.create({ name: 'bold-oak-a3f2' })
    expect(outcome).toEqual({ worktreePath: rig.listed[0]!.path })
    expect(rig.acquired).toEqual([{
      ownerAgentId: 'bold-oak-a3f2',
      worktreeLeaseId: 'worktree-bold-oak-a3f2',
    }])
    // The lease exists, i.e. the sweep and the drain can both see this worktree
    // — the whole difference between this row and `git worktree`.
    expect(rig.listed.map(lease => lease.ownerAgentId)).toEqual(['bold-oak-a3f2'])
    rig.cleanup()
  })

  /**
   * KILLS: calling `mutateWorkingDirectory` in `create`, i.e. copying
   * `EnterWorktree`'s body. The path belongs to the ISOLATED session the binary
   * is about to start — a subagent or a background session — so moving the
   * parent would relocate a session because its child asked for isolation.
   */
  it('does not move the session that owns the port', async () => {
    const rig = fixture()
    await rig.port()!.create({ name: 'bold-oak-a3f2' })
    expect(rig.managed.workingDirectory).toBe(rig.projectPath)
    expect(rig.managed.sdkCwd).toBeUndefined()
    rig.cleanup()
  })

  /**
   * KILLS: letting the lease failure throw out of the port. A throw crossing
   * into the SDK callback surfaces as the binary's own generic hook failure,
   * with the reason redacted; a refusal is carried by
   * `ClaudeWorktreeCreateOutcome` and reaches the user as the block reason.
   */
  it('refuses rather than throwing when the lease cannot be taken', async () => {
    const rig = fixture({ acquireError: 'worktree-collision' })
    const outcome = await rig.port()!.create({ name: 'bold-oak-a3f2' })
    expect(outcome).toEqual({
      refusedReason: 'the host could not lease a worktree for bold-oak-a3f2: worktree-collision',
    })
    expect(rig.listed).toEqual([])
    rig.cleanup()
  })

  /**
   * KILLS: a `remove` that releases by name/index instead of by the path the
   * runtime hands back, and a `remove` that throws on a path this host never
   * leased. `WorktreeRemove` also fires for worktrees a user's own
   * `WorktreeCreate` made, so an unknown path must be a no-op.
   */
  it('releases a leased path and ignores one it never leased', async () => {
    const rig = fixture()
    const port = rig.port()!
    const created = await port.create({ name: 'bold-oak-a3f2' })
    const path = (created as { worktreePath: string }).worktreePath

    await port.remove({ worktreePath: '/somewhere/a-user-hook-made-this' })
    expect(rig.released).toEqual([])
    expect(rig.listed).toHaveLength(1)

    await port.remove({ worktreePath: path })
    expect(rig.released).toEqual(['worktree-bold-oak-a3f2'])
    expect(rig.listed).toEqual([])
    rig.cleanup()
  })
})

describe('P2.465 · the abort hazard, which is why the builder may answer undefined', () => {
  /**
   * THE ABORT-HAZARD ROW.
   *
   * KILLS: dropping the managed-`disableAllHooks` gate. Under that policy the
   * binary calls the hook (`hasWorktreeCreateHook` sees the SDK callback) and
   * then runs no hooks at all (`executeHooksOutsideREPL` returns `[]`), which
   * is the thrown `"hook is configured but did not run"`. The composition is
   * asserted, not just the builder: no port means `withClaudeWorktreeHooks`
   * registers NO `WorktreeCreate` matcher, so the binary keeps its own
   * `git worktree` and there is nothing to abort.
   */
  it('withholds the port under a managed disableAllHooks, and then registers no hook', () => {
    const rig = fixture({ managedDisableAllHooks: true })
    expect(rig.port()).toBeUndefined()

    const hooks = withClaudeWorktreeHooks({}, rig.port())
    expect(hooks.WorktreeCreate).toBeUndefined()
    expect(hooks.WorktreeRemove).toBeUndefined()
    // The control: with the policy off, the same session DOES get both.
    const wired = fixture()
    const armed = withClaudeWorktreeHooks({}, wired.port())
    expect(armed.WorktreeCreate).toHaveLength(1)
    expect(armed.WorktreeRemove).toHaveLength(1)
    rig.cleanup()
    wired.cleanup()
  })

  /**
   * KILLS: dropping the project gate. Without a project handle the lease
   * service throws `worktree-project-required` on every call, so a registered
   * hook could only ever refuse — and a refusal on THIS event aborts creation
   * rather than falling back.
   */
  it('withholds the port when the session has no project handle', () => {
    const rig = fixture({ project: false })
    expect(rig.port()).toBeUndefined()
    // Same session, same manager, project restored: the withholding is the
    // project, not the fixture.
    rig.managed.projectKey = 'project-key'
    expect(rig.port()).toBeDefined()
    rig.cleanup()
  })

  /**
   * The other half of the hazard: a host that IS wired but cannot produce a
   * path must not answer the binary with an empty output. An empty output is
   * indistinguishable from "hook succeeded but returned no worktree path",
   * which the binary throws on; a `block` decision carries the reason.
   *
   * KILLS: returning `{ continue: true }` (or the create outcome unscreened)
   * when the port refuses.
   */
  it('a wired host that cannot lease blocks with its reason, never with an empty path', async () => {
    const rig = fixture({ acquireError: 'worktree-project-required' })
    const hooks = withClaudeWorktreeHooks({}, rig.port())
    const [result] = await fire(hooks.WorktreeCreate, {
      hook_event_name: 'WorktreeCreate',
      name: 'bold-oak-a3f2',
    })
    expect(result).toEqual({
      decision: 'block',
      reason: 'the host could not lease a worktree for bold-oak-a3f2: worktree-project-required',
    })
    // Not a pathless success: the field the binary reads is absent entirely.
    expect(result).not.toHaveProperty('hookSpecificOutput')
    rig.cleanup()
  })

  /**
   * The wired-and-working composition, end to end through the hook the SDK
   * receives. This is the row that proves the seam is fed rather than merely
   * declared: the callback returns the one shape the binary reads back on the
   * callback route (`hookSpecificOutput.worktreePath`, gated on
   * `hookEventName`), carrying a path the lease service minted.
   */
  it('the registered hook answers with a leased path in the shape the binary reads', async () => {
    const rig = fixture()
    const hooks = withClaudeWorktreeHooks({}, rig.port())
    const [result] = await fire(hooks.WorktreeCreate, {
      hook_event_name: 'WorktreeCreate',
      name: 'bold-oak-a3f2',
    })
    // TYPED, not the serialized bytes (P2.514). This assertion read
    // `JSON.parse(JSON.stringify(result))` because our own mirror of the SDK
    // hook result had no `worktreePath` and the reason recorded here was that
    // the mirror could not be edited. P2.495 measured that reading and edited
    // it, so the excess-property check on this literal is now a real second
    // instrument: delete `worktreePath` from `SdkAutomationCallbackResult` and
    // `typecheck:server-core` goes red on this line. `bun test` does not
    // typecheck, so the annotation and the `toEqual` below catch different
    // halves — the declared type, and the value actually produced.
    const expected: SdkAutomationCallbackResult = {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'WorktreeCreate',
        worktreePath: rig.listed[0]!.path,
      },
    }
    expect(result).toEqual(expected)

    // …and the teardown reaches the same lease.
    await fire(hooks.WorktreeRemove, {
      hook_event_name: 'WorktreeRemove',
      worktree_path: rig.listed[0]!.path,
    })
    expect(rig.released).toEqual(['worktree-bold-oak-a3f2'])
    rig.cleanup()
  })
})

const sessionManagerSource = (): string =>
  readFileSync(fileURLToPath(new URL('../SessionManager.ts', import.meta.url)), 'utf8')

describe('P2.465 · the binding exists on the config the host actually writes', () => {
  /**
   * The wire itself, read as text for the reason
   * `claude-cron-port-binding.test.ts` records: the literal lives inside
   * `getOrCreateAgentUnchecked`, which a unit test cannot reach without
   * constructing an agent. Without this line the port is complete, tested and
   * unreachable — the state P2.458 shipped on purpose and this row ends.
   */
  it('binds claudeWorktreePort on the backend config, gated on anthropic', () => {
    const source = sessionManagerSource()
    // G-1 · this pin was a SINGLE-LINE literal and the binding became a
    // three-line ternary, so it failed on formatting alone while the wire it
    // guards was intact. Whitespace-collapsed rather than re-typed at the new
    // width: a source pin that breaks when a line wraps re-spends a lane's time
    // on a diff that changed nothing, and the next reformat would break it
    // again. What is asserted is the WIRE — field, gate, and the call it makes
    // — not its indentation.
    const flat = source.replace(/\s+/g, ' ')
    expect(flat).toContain(
      "claudeWorktreePort: provider === 'anthropic' ? this.createClaudeWorktreePort(managed)",
    )
    // The else branch is no longer `undefined`: P2.497 replaced it with a
    // reporter that says out loud why codex gets no port (closed by absence,
    // not withheld) and still returns `undefined`. Pinned because a silent
    // `undefined` here is exactly the state that row ended.
    expect(flat).toContain(': this.noteAbsentWorktreePort(managed, provider),')
    // Positive control: the sibling port bindings are still in the same
    // literal, so a hit above is this wire and not a comment surviving in a
    // file whose config literal moved elsewhere.
    expect(source).toContain('hookTaskRegistryPort: SCHEDULED_DELIVERY_RUNTIMES.includes(provider)')
    // G-2 (2026-09-11, W12-c) · the second control was pinned on the runtime
    // GATE rather than on the binding, and `1ee02327b` (P6.184) de-gated it:
    // the notification port is built for every runtime now, by one builder, so
    // that the Pi context here and the per-session callback registry further
    // down cannot describe different notifications. The control's job is to
    // prove this config literal still carries its sibling port bindings — the
    // BINDING is what proves that, and a gate that the product deliberately
    // removed can only ever break it again.
    expect(source).toContain('notificationPort: this.buildSessionNotificationPort(managed),')
  })
})

/**
 * P6.127 — the decisions this port takes reach the SESSION, not only the log.
 *
 * P6.18 closed exactly this on Pi (`9bc348b7d`: *"its edits landed in a
 * directory the parent could not see … and nothing anywhere said why"*) and
 * skipped the runtime where the leak was worst. Every arm here answered with
 * `sessionLog.info` alone, which is a file the user does not read.
 *
 * The notice is read off `managed.messages` rather than off the event sink,
 * because the transcript is the durable half: an event a disconnected renderer
 * misses is not a record, and `appendWorktreeSetupNotice` writes both.
 */
describe('P6.127 · a claude worktree decision is session-visible', () => {
  const notices = (managed: { messages?: Array<{ role?: string; content?: string }> }): string[] =>
    (managed.messages ?? []).filter(message => message.role === 'info').map(message => String(message.content))

  it('names the leased path and its branch when a subagent gets its worktree', async () => {
    const rig = fixture()
    const hooks = withClaudeWorktreeHooks({}, rig.port())
    await fire(hooks.WorktreeCreate, { hook_event_name: 'WorktreeCreate', name: 'bold-oak-a3f2', cwd: rig.projectPath })

    const lease = rig.listed[0]
    expect(lease, 'nothing was leased, so the notice assertion below would be vacuous').toBeDefined()
    const lines = notices(rig.managed)
    expect(lines).toHaveLength(1)
    // The PATH is the whole point: the parent session's working directory is
    // unchanged, so without it the user cannot find the subagent's edits.
    expect(lines[0]).toContain(lease!.path)
    expect(lines[0]).toContain(lease!.branch)
    expect(lines[0]).toContain('bold-oak-a3f2')
    rig.cleanup()
  })

  it('names the reason, and says the isolated session was aborted, when the lease fails', async () => {
    const rig = fixture({ acquireError: 'the repository has uncommitted changes' })
    const hooks = withClaudeWorktreeHooks({}, rig.port())
    const results = await fire(hooks.WorktreeCreate, {
      hook_event_name: 'WorktreeCreate', name: 'bold-oak-a3f2', cwd: rig.projectPath,
    })

    // Positive control on the same run: the refusal still reaches the binary as
    // a block, so the notice is an ADDITION and not a replacement.
    expect(results[0]).toMatchObject({ decision: 'block' })
    const lines = notices(rig.managed)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('the repository has uncommitted changes')
    // `hooks.md`'s WorktreeCreate contract has no fall-through, so the honest
    // sentence is that nothing was created — not that git took over.
    expect(lines[0]).toContain('aborts the isolated session')
    expect(rig.listed).toHaveLength(0)
    rig.cleanup()
  })

  it('says nothing to the session when the port stands down, because no request ever arrives', () => {
    // The decision recorded in `createClaudeWorktreePort`'s docblock: with no
    // port there is no callback and no request to attach a notice to, the
    // behaviour is the binary's own `git worktree` — identical to every claude
    // session before P2.465 — and a construction-time line would fire on
    // sessions that never ask for a worktree. Pinned so a later lane does not
    // "fix" the silence into noise without reading why it is silent.
    const rig = fixture({ project: false })
    expect(withClaudeWorktreeHooks({}, rig.port()).WorktreeCreate).toBeUndefined()
    expect(notices(rig.managed)).toEqual([])
    rig.cleanup()
  })
})
