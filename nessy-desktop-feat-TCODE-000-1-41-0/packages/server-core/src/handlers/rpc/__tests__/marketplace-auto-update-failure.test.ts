/**
 * P2.184 — `auto-update.ts` discards a rejection from the pass under the
 * comment "the pass logs its own failures". That sentence was FALSE for
 * everything outside the pass's per-plugin loops.
 *
 * `updateInstalledBundles` names its own per-plugin skips (P2.173), but a throw
 * from anywhere ELSE in `run()` — the catalog refresh, the bundle service
 * construction, the invalidation emit — reached the scheduler's `.catch(() => {})`
 * and produced NO LINE AT ALL. The pass is unattended, so its failure mode is
 * that nothing happens, which is indistinguishable from a pass with nothing to
 * do: the same family as P2.146 / P2.153 / P2.159 / P2.162.
 *
 * The channel is the one this composition already writes to and the prefix is
 * the one it already uses, so a failure lands in the same log stream as the
 * successes it would otherwise silently replace.
 */
import { describe, expect, it } from 'bun:test'
import type { HandlerDeps } from '../../handler-deps'
import type { RpcServer } from '@nessy-agent/server-core/transport'
import { startMarketplaceAutoUpdate } from '../marketplace-auto-update'

interface Logged { level: 'info' | 'warn' | 'error'; message: string }

/** A timer that records instead of firing, so the test decides when time passes. */
function recordingTimer() {
  const scheduled: Array<() => void> = []
  return {
    setTimer: (callback: () => void) => { scheduled.push(callback); return scheduled.length - 1 },
    clearTimer: () => {},
    fire: () => { scheduled.at(-1)?.() },
  }
}

function harness(refresh: () => Promise<unknown>) {
  const logged: Logged[] = []
  const deps = {
    platform: {
      logger: {
        info: (message: string) => { logged.push({ level: 'info', message }) },
        warn: (message: string) => { logged.push({ level: 'warn', message }) },
        error: (message: string) => { logged.push({ level: 'error', message }) },
      },
    },
    marketplaceRegistrySource: { refreshAutoUpdateMarketplaces: refresh },
    // No `pluginManagement`, so the pass stops after the refresh — the bundle
    // half has its own containment and its own row (P2.173).
    workspaceService: { listResolved: () => [] },
  } as unknown as HandlerDeps
  const timer = recordingTimer()
  const scheduled = startMarketplaceAutoUpdate({} as unknown as RpcServer, deps, {
    env: {},
    random: () => 0,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  })
  return { logged, timer, scheduled }
}

/** Let the fired pass settle without sleeping on a clock. */
const settle = async (): Promise<void> => { for (let i = 0; i < 8; i += 1) await Promise.resolve() }

describe('the unattended auto-update pass names its own failure', () => {
  it('writes one MARKETPLACE_AUTO_UPDATE line when the refresh rejects', async () => {
    const { logged, timer } = harness(async () => { throw new Error('registry host unreachable') })

    timer.fire()
    await settle()

    const warnings = logged.filter(entry => entry.level === 'warn')
    expect(warnings).toHaveLength(1)
    // Identity on the prefix AND on the cause, not "something was logged":
    // the whole defect was that nothing was.
    expect(warnings[0]!.message).toStartWith('MARKETPLACE_AUTO_UPDATE: the pass did not finish: ')
    expect(warnings[0]!.message).toContain('registry host unreachable')
  })

  it('renders a thrown value that has no default conversion', async () => {
    // `String(Object.create(null))` raises (P2.65), and this renderer runs
    // inside the catch that exists to stop a rejection from vanishing.
    const { logged, timer } = harness(async () => { throw Object.create(null) as never })

    timer.fire()
    await settle()

    const warnings = logged.filter(entry => entry.level === 'warn')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.message).toContain('(unrenderable error)')
  })

  it('POSITIVE CONTROL: a pass with nothing to do logs no failure line', async () => {
    // Without this, "a warn line appeared" could be satisfied by a composition
    // that warns unconditionally, and the assertions above would mean nothing.
    const { logged, timer } = harness(async () => ({ refreshed: [], considered: [], failed: [] }))

    timer.fire()
    await settle()

    expect(logged.filter(entry => entry.level === 'warn')).toEqual([])
  })

  it('POSITIVE CONTROL: a refresh that did not land keeps its OWN P2.159 line', async () => {
    // The new catch must not have swallowed or renamed the per-marketplace
    // report that already existed.
    const { logged, timer } = harness(async () => ({
      refreshed: [],
      considered: ['m1'],
      failed: [{ marketplaceId: 'm1', reason: 'timeout' }],
    }))

    timer.fire()
    await settle()

    const warnings = logged.filter(entry => entry.level === 'warn')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.message).toContain('refresh did not land for m1 (timeout)')
    expect(warnings[0]!.message).not.toContain('the pass did not finish')
  })
})
