/**
 * P3.341 — when a codex teardown fails and the runtime switch is refused, say
 * WHICH resource leaked.
 *
 * ## The row, and the half this file is
 *
 * `cleanupRuntimeResources` throws `AggregateError(failures,
 * 'codex-runtime-cleanup-failed')` after five per-step catches, and
 * `SessionManager` awaits `strictDrainSessionForMutation` inside a try whose
 * catch re-codes only `WORKTREE_DIRTY` and rethrows — so the rejection skips
 * `clearRuntimeScopedSessionState` and the marker write, and the user's runtime
 * switch is refused. T25 landed the leaf log (`flattenDisposalFailure`, depth 4)
 * as the instrument and left the cause OPEN by design; it has never been used.
 *
 * Whether the throw should stay fatal to the switch is an OWNER decision, and
 * this lane did not take it: both options and their costs are written at the
 * throw site in `codex-agent.ts`. What is settled either way is that a leaf must
 * NAME its step — otherwise the live sitting the row prices at six-plus attempts
 * would produce a message nobody can attribute.
 *
 * ## Narrowed by CODE first, which is what makes the live day avoidable
 *
 * Reading each callee rather than reproducing:
 *
 *  - `client.close()` is synchronous and REJECTS other promises; its only throw
 *    source is `readline.close()`.
 *  - `manager.kill()` is `new Promise(resolve => …)` with no `reject`, so it can
 *    only reject through a SYNCHRONOUS throw in the executor —
 *    `child.kill('SIGTERM')` on EPERM. (The row said "resolve-only, cannot
 *    reject"; that is corrected. Its broad failure is a HANG, not a rejection.)
 *  - `adapter.close()` is `new Promise(r => server.close(() => r()))` and
 *    DISCARDS the Error `server.close` passes when the server was not open, so
 *    it genuinely cannot reject.
 *  - `callbackBridge.close()` is the same shape plus a synchronous
 *    `closeAllConnections?.()`.
 *  - `rmSync(codexHome, { force, maxRetries: 5 })` throws on EACCES/ENOTDIR or
 *    once the retries are spent; P3.296 measured a 1.6 MB WAL still being
 *    written into that directory.
 *
 * So THREE of the five are structurally unable to reject in ordinary operation
 * and `codexHome` is the honest prior. The cases below force each of the five
 * anyway — a structural argument is a reading, and the point of the harness is
 * that whichever one fires is legible.
 *
 * WHAT EACH TEST KILLS:
 *  - the five per-step cases die if a step goes back to pushing its callee's raw
 *    error, which is the shipped state and the reason T25's instrument was never
 *    usable.
 *  - "keeps the callee's own message" dies if the wrapper REPLACES the cause
 *    instead of prefixing it — attribution bought by losing the diagnosis.
 *  - "all five at once" dies if a step short-circuits the rest, which would turn
 *    a five-resource leak into a one-resource report.
 *  - "a clean teardown throws nothing" is the control: without it every case
 *    above would pass on an implementation that always throws.
 */
import { describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackendConfig } from '../backend/types.ts'
import { CodexAgent, CODEX_TEARDOWN_STEP_FAILURE_PREFIX } from '../codex-agent.ts'

/**
 * Can an r-x PARENT actually stop an unlink on THIS host?
 *
 * The `codexHome` case below stages its failure the honest way — a real
 * `rmSync` refused by real directory permissions — and that is the right
 * instrument everywhere except where the process can ignore them. As ROOT (the
 * Kubernetes runner this repo's `test` job uses) and with `CAP_DAC_OVERRIDE`,
 * the removal SUCCEEDS, `cleanup` throws nothing, and the case fails on
 * `leaves(null)` with an error about AggregateError that names neither root nor
 * permissions. It passed alone on a developer macOS host and failed in CI job
 * 630520568 for exactly this reason, which made it look like contamination.
 *
 * So the precondition is MEASURED rather than assumed, and it is measured by
 * doing the thing the case depends on. Deliberately not `process.getuid() === 0`:
 * that is a proxy, and it is the wrong one wherever a capability rather than a
 * uid decides.
 */
const rxParentBlocksUnlink = (() => {
  const parent = mkdtempSync(join(tmpdir(), 'p3341-precondition-'))
  const victim = join(parent, 'probe')
  try {
    writeFileSync(victim, 'x\n')
    chmodSync(parent, 0o500)
    try {
      rmSync(victim, { force: true })
      return false
    } catch {
      return true
    }
  } catch {
    return false
  } finally {
    chmodSync(parent, 0o700)
    rmSync(parent, { recursive: true, force: true })
  }
})()
if (!rxParentBlocksUnlink) {
  // stderr, so the reason travels with the run rather than living only here.
  console.warn(
    '[codex-teardown-failure-attribution.test.ts] the `codexHome` case is SKIPPED: on this host an r-x '
    + 'parent directory does not prevent an unlink (root, or CAP_DAC_OVERRIDE), so the real rmSync '
    + 'failure it needs cannot be staged. Every other step in this file still runs.',
  )
}

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-codex-teardown',
      name: 'Codex Teardown Workspace',
      rootPath: '/tmp/ws-codex-teardown-root',
      workspaceRootPath: '/tmp/ws-codex-teardown-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-teardown',
    } as never,
    session: {
      id: 'session-codex-teardown',
      workspaceRootPath: '/tmp/ws-codex-teardown-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as never,
    model: 'codex/test-model',
    isHeadless: true,
  } as BackendConfig
}

interface Resources {
  client: { close: () => void } | null
  manager: { kill: () => Promise<void> } | null
  adapter: { close: () => Promise<void> } | null
  callbackBridge: { close: () => Promise<void> } | null
  codexHome: string | null
}

/** A resource set where every step succeeds; each case breaks exactly one. */
function healthyResources(): Resources {
  return {
    client: { close: () => { /* closes cleanly */ } },
    manager: { kill: async () => { /* exits cleanly */ } },
    adapter: { close: async () => { /* unbinds cleanly */ } },
    callbackBridge: { close: async () => { /* unbinds cleanly */ } },
    codexHome: null,
  }
}

async function cleanup(resources: Resources): Promise<unknown> {
  const agent = new CodexAgent(createConfig())
  const internals = agent as unknown as {
    cleanupRuntimeResources: (r: Resources) => Promise<void>
  }
  try {
    await internals.cleanupRuntimeResources(resources)
    return null
  } catch (error) {
    return error
  } finally {
    agent.destroy()
  }
}

/** The leaf messages of the thrown AggregateError, in order. */
function leaves(error: unknown): string[] {
  expect(error).toBeInstanceOf(AggregateError)
  return (error as AggregateError).errors.map(e => (e as Error).message)
}

describe('P3.341 · a teardown failure names the step that failed', () => {
  it('a clean teardown throws nothing — the control every case below rests on', async () => {
    expect(await cleanup(healthyResources())).toBeNull()
  })

  const cases: Array<[string, (r: Resources) => void]> = [
    ['client', r => { r.client = { close: () => { throw new Error('readline already destroyed') } } }],
    ['manager', r => { r.manager = { kill: async () => { throw new Error('kill EPERM') } } }],
    ['adapter', r => { r.adapter = { close: async () => { throw new Error('server was not running') } } }],
    ['callbackBridge', r => { r.callbackBridge = { close: async () => { throw new Error('bridge socket busy') } } }],
  ]

  for (const [step, breakIt] of cases) {
    it(`names "${step}" when that step throws`, async () => {
      const resources = healthyResources()
      breakIt(resources)
      const messages = leaves(await cleanup(resources))
      expect(messages).toHaveLength(1)
      expect(messages[0]!.startsWith(`${CODEX_TEARDOWN_STEP_FAILURE_PREFIX}${step}: `)).toBe(true)
    })
  }

  /**
   * The fifth step, driven for real rather than faked: this is the honest prior,
   * so a stub would be testing the harness. An UNWRITABLE PARENT is what makes
   * `rmSync` fail after `force` and `maxRetries` have both done their work.
   */
  it.skipIf(!rxParentBlocksUnlink)('names "codexHome" when the managed home cannot be removed', async () => {
    // NEVER a real home directory: a fresh mkdtemp under the OS temp dir, and
    // it is removed in the `finally` below.
    const parent = mkdtempSync(join(tmpdir(), 'p3341-parent-'))
    const home = mkdtempSync(join(parent, 'home-'))
    writeFileSync(join(home, 'config.toml'), 'model = "x"\n')
    // r-x on the PARENT: the directory itself is intact, but nothing can be
    // unlinked from it, which is what survives `force` and five retries.
    chmodSync(parent, 0o500)
    try {
      const resources = healthyResources()
      resources.codexHome = home
      const messages = leaves(await cleanup(resources))
      expect(messages).toHaveLength(1)
      expect(messages[0]!.startsWith(`${CODEX_TEARDOWN_STEP_FAILURE_PREFIX}codexHome: `)).toBe(true)
    } finally {
      chmodSync(parent, 0o700)
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it("keeps the callee's own message, so attribution costs no diagnosis", async () => {
    const resources = healthyResources()
    resources.manager = { kill: async () => { throw new Error('kill EPERM') } }
    const error = await cleanup(resources)
    const [message] = leaves(error)
    expect(message).toContain('kill EPERM')
    // And the original is still reachable as the `cause`, so a walker that
    // follows causes loses nothing either.
    const leaf = (error as AggregateError).errors[0] as Error & { cause?: unknown }
    expect((leaf.cause as Error).message).toBe('kill EPERM')
  })

  it('reports ALL failing steps, because no step may cancel another', async () => {
    const resources: Resources = {
      client: { close: () => { throw new Error('a') } },
      manager: { kill: async () => { throw new Error('b') } },
      adapter: { close: async () => { throw new Error('c') } },
      callbackBridge: { close: async () => { throw new Error('d') } },
      codexHome: null,
    }
    const messages = leaves(await cleanup(resources))
    expect(messages).toHaveLength(4)
    expect(messages.map(m => m.slice(CODEX_TEARDOWN_STEP_FAILURE_PREFIX.length).split(':')[0]))
      .toEqual(['client', 'manager', 'adapter', 'callbackBridge'])
  })
})
