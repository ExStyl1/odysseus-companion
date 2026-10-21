import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHeadlessPlatform } from '../../runtime/platform-headless.ts'
import { createManagedSession, setSessionPlatform } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

/**
 * P2.119 — the host→agent wiring of the two BUDGET anchors, guarded
 * behaviourally instead of by a regex over the source.
 *
 * The row's shape: deleting the wired line `getSessionSpendUsd: () =>
 * managed.tokenUsage?.costUsd` compiles clean and leaves every behaviour test
 * green, because both fields are OPTIONAL on `CoreBackendConfig` — so a whole
 * class of host wiring can be removed without a single red test. The only guard
 * was a source-level assertion in `cost-reporting-persistence.test.ts`, and its
 * own header says why that is not enough: it is UNDER-sensitive to deletion in
 * every other shape and OVER-sensitive to refactoring — renaming
 * `managed.tokenUsage` or extracting the config builder fails it with no
 * behaviour change, which trains maintainers to edit the assertion rather than
 * the code. Under-sensitive to deletion and over-sensitive to refactoring is the
 * worst combination a guard can have.
 *
 * This file is the harness the row asked for. It drives the PRODUCTION path —
 * `createCapabilityTurn` → `getOrCreateAgent` → the config literal — and reads
 * the config at the factory seam `createBackendFromManagedContext`, which exists
 * precisely so a test can stand there (`agent-config-project-trust.test.ts` is
 * the pattern). Nothing is transcribed: each assertion CALLS the wired closure
 * and compares against the session field it is supposed to be reading, so a
 * deleted wire fails as `undefined` and a rename of the source field fails only
 * if it actually stopped reading the session.
 *
 * Why the two anchors are one file: `getPiWebSearchesUsed` (R48) and
 * `getSessionSpendUsd` (P2.44) are the same shape one scope apart — a host-side
 * value that survives an agent instance, wired as an optional getter, with a
 * mirroring sink beside it. The row names the second as untested "for exactly
 * the same reason", and a harness that covered only one would leave the sibling
 * exactly where it was.
 *
 * MEASURED RESIDUE, so the next reader does not mistake it for coverage: every
 * case below resolves to the **Pi** backend, and seeding `activeProvider` does
 * not change that. `SessionManager.ts:16611` reads
 * `managed.activeProvider === 'pi' ? 'pi' : backendContext.provider`, and with no
 * stored LLM connection `backendContext.provider` is Pi as well — the runtime
 * log line "No LLM connection found …, using default anthropic provider" names
 * the API provider, not the backend. So the R48 gate's NEGATIVE arm (the anchor
 * withheld on claude/codex) and the ceiling anchor's deliberate UNGATEDNESS are
 * not driven here: reaching a non-Pi backend needs a stored `claude-runtime`
 * connection written to the real config path, which this harness will not do
 * while other suites share the process. An assertion written without that
 * connection PASSES for the wrong reason, which is how it was first written.
 *
 * What is deliberately NOT asserted here: what the agent DOES with the values.
 * The ceiling walk (`base-agent.ts` `hydrateSessionCostUsdOnce` →
 * `exceedsMaxBudgetUsd` → `terminalReason: 'max_budget_usd'`) and the WebSearch
 * cap (`pi-agent.ts` `webSearchesUsed` → the subprocess budget seed) have their
 * own agent-side pins. The gap the row measured is the WIRE between them, and
 * scoping to the wire is what the row asked for.
 */

setSessionPlatform(createHeadlessPlatform())

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type CapturedConfig = {
  getSessionSpendUsd?: () => number | undefined
  getPiWebSearchesUsed?: () => number | undefined
  onPiWebSearchUsage?: (used: number) => void
}

interface SessionSeed {
  provider: 'pi' | 'anthropic'
  costUsd?: number
  webSearchesUsed?: number
  childWebSearchSeed?: number
}

/**
 * Builds a real `SessionManager`, registers one managed session seeded with the
 * host-side values under test, and returns the config the production path hands
 * the backend factory.
 */
async function capturedBackendConfig(seed: SessionSeed): Promise<CapturedConfig> {
  const root = mkdtempSync(join(tmpdir(), 'nessy-agent-budget-anchors-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })

  const manager = createTestSessionManager()
  const managed = createManagedSession({ id: 'session-a' }, {
    id: 'workspace-a',
    name: 'Workspace A',
    rootPath: workspaceRoot,
    createdAt: 1,
  }, {
    messagesLoaded: true,
    ephemeral: true,
    workingDirectory: workspaceRoot,
  })
  managed.activeProvider = seed.provider
  if (seed.costUsd !== undefined) {
    // The measured home of the ceiling anchor: the same per-turn increments the
    // agent's own counter adds, persisted on the session.
    managed.tokenUsage = { ...(managed.tokenUsage ?? {}), costUsd: seed.costUsd } as typeof managed.tokenUsage
  }
  if (seed.webSearchesUsed !== undefined) managed.piWebSearchesUsed = seed.webSearchesUsed
  if (seed.childWebSearchSeed !== undefined) managed.piChildWebSearchSeed = seed.childWebSearchSeed
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    'workspace-a:session-a',
    managed,
  )

  const internals = manager as unknown as {
    createCapabilityTurn(managed: unknown): Promise<{ runtime: unknown }>
    getOrCreateAgent(managed: unknown, runtime: unknown): Promise<unknown>
    createBackendFromManagedContext(args: { coreConfig: CapturedConfig }): unknown
    cleanup(): void
  }
  try {
    const turn = await internals.createCapabilityTurn(managed)
    let captured: CapturedConfig | undefined
    // Stand at the factory seam. Everything before it is production code; the
    // factory tail (credentials, subprocess spawn) is irrelevant to a wire.
    internals.createBackendFromManagedContext = args => {
      captured = args.coreConfig
      throw new Error('captured-before-construction')
    }
    await expect(internals.getOrCreateAgent(managed, turn.runtime)).rejects.toThrow('captured-before-construction')
    expect(captured).toBeTruthy()
    return captured!
  } finally {
    internals.cleanup()
  }
}

describe('SessionManager backend config budget anchors', () => {
  it('carries the session spend total into the agent config', async () => {
    // The money-adjacent half. Deleting the wire restores the per-instance
    // ceiling walk-past — a $5 cap becoming $5 per agent instance — and this is
    // the assertion that goes red when it does.
    const coreConfig = await capturedBackendConfig({ provider: 'pi', costUsd: 4.25 })
    expect(coreConfig.getSessionSpendUsd?.()).toBe(4.25)
  })

  it('reports no recorded spend for a session that has cost nothing yet', async () => {
    // The boundary: a fresh session must hand back `undefined`, not `0`. The
    // agent's hydration treats a non-positive number as "nothing to resume", so
    // both are inert today — but a wire that invents a number is a wire that can
    // one day resume the wrong ceiling.
    const coreConfig = await capturedBackendConfig({ provider: 'pi' })
    expect(coreConfig.getSessionSpendUsd?.()).toBeUndefined()
  })

  it('carries the WebSearch total into the agent config on Pi', async () => {
    const coreConfig = await capturedBackendConfig({ provider: 'pi', webSearchesUsed: 12 })
    expect(coreConfig.getPiWebSearchesUsed?.()).toBe(12)
  })

  it('falls through to the child seed inherited at spawn', async () => {
    // The second arm of the same wire, and the reason the row calls the anchor
    // untested rather than half-tested: a spawned child starts from the seed it
    // inherited, and only this fall-through carries it.
    const coreConfig = await capturedBackendConfig({ provider: 'pi', childWebSearchSeed: 5 })
    expect(coreConfig.getPiWebSearchesUsed?.()).toBe(5)
  })

  it('prefers the reported total over the inherited seed', async () => {
    // Ordering, not merely presence: the last reported total survives subprocess
    // respawns and must win over the spawn-time seed.
    const coreConfig = await capturedBackendConfig({ provider: 'pi', webSearchesUsed: 9, childWebSearchSeed: 5 })
    expect(coreConfig.getPiWebSearchesUsed?.()).toBe(9)
  })

  it('mirrors a reported WebSearch total back onto the session', async () => {
    // The sink beside the source. `0` is the literal the subprocess sends on
    // `/clear`, so the mirror is asserted with the value most likely to be
    // dropped by a falsy guard.
    const managedSeen: number[] = []
    const coreConfig = await capturedBackendConfig({ provider: 'pi', webSearchesUsed: 3 })
    expect(coreConfig.getPiWebSearchesUsed?.()).toBe(3)
    coreConfig.onPiWebSearchUsage?.(0)
    managedSeen.push(coreConfig.getPiWebSearchesUsed?.() ?? -1)
    expect(managedSeen).toEqual([0])
  })

  it('offers the WebSearch anchor as a pair, never half of it', async () => {
    // The source and its mirror are one wire: a config carrying the reader
    // without the sink would seed a budget it could never update, and the
    // session's total would freeze at the value it had when the agent spawned.
    const coreConfig = await capturedBackendConfig({ provider: 'pi' })
    expect(typeof coreConfig.getPiWebSearchesUsed).toBe('function')
    expect(typeof coreConfig.onPiWebSearchUsage).toBe('function')
  })
})
