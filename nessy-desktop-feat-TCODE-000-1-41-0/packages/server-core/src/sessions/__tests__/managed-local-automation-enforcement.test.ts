/**
 * D1.409 — the managed local-automation gate (D1.205) actually fires.
 *
 * ## The measured defect
 *
 * `[features] in_app_local_automation = false` in a codex deployment's
 * `requirements.toml` is read by exactly ONE production writer,
 * `recordCodexLocalAutomationRequirement` inside `CodexAgent.createRuntime`,
 * which runs when the FIRST codex app-server of the process starts. The only
 * consumer that turned it into scheduler behaviour was
 * `enableScheduler: !isLocalAutomationManagedDisabled()`, evaluated ONCE inside
 * `setupConfigWatcher`'s `if (!this.automationSystems.has(workspaceId))` — and
 * `initialize()` calls `setupConfigWatcher` for EVERY workspace at boot, before
 * any agent exists. So the gate read `false` every time, the system was never
 * rebuilt, and `subscribeManagedLocalAutomationChange` — published by the module
 * for exactly this ordering — had zero subscribers. Meanwhile
 * `readCodexConfigRequirements` put the key on `honoured` and
 * `CODEX_HOST_FACING_FEATURE_KEYS` verdicted it `'nessy'` ("this product applies
 * it"): an administrator's restriction enforced nowhere and reported as applied.
 *
 * ## What each case is
 *
 * (a) is the failing arm: a system constructed BEFORE the tier is written keeps
 * its scheduler running after the flip. (b) is its receipt — the host says how
 * many it stopped and why, because a scheduler that silently never fires is
 * indistinguishable from a bug, which is the posture `managed-in-app-browser.ts`
 * established for this class and `describeManagedLocalAutomationRefusal` words.
 * (c) is the WAKE half: `SessionManager.runMissedRunSweep` is a second dispatch
 * path the construction-time gate never covered — a host wake event fired
 * catch-up runs whatever `enableScheduler` said. (d) and (e) are the controls
 * the brief names: a tier of `false` and a tier of `undefined` change nothing.
 * (f) is the construction-time gate, which already worked and is the POSITIVE
 * CONTROL that `schedulerRunning` reads a real scheduler rather than a constant.
 * (g) pins the ORDERING that makes the `honoured` push honest: the arming sits
 * ahead of the construction inside `setupConfigWatcher`, so an `AutomationSystem`
 * cannot come into existence with nothing subscribed.
 *
 * ## The process-scoped tier is why every case resets it
 *
 * `codexLocalAutomationDisabled` is a module-level `let`. Leaving it `true`
 * would hand the next file in the same bun process a disabled scheduler, which
 * is the order-dependence `resetManagedLocalAutomationForTests` exists for.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  describeManagedLocalAutomationRefusal,
  recordCodexLocalAutomationRequirement,
  resetManagedLocalAutomationForTests,
} from '@nessy-agent/shared/config/managed-local-automation'
import { bracedRegion } from '@nessy-agent/shared/testing/source-regions'
import type { SessionManager } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const SESSION_MANAGER = new URL('../SessionManager.ts', import.meta.url).pathname

interface SchedulerProbe {
  schedulerRunning: boolean
  runMissedRunSweep: (now?: number) => Promise<{ fired: number }>
}

interface ManagerInternals {
  automationSystems: Map<string, SchedulerProbe>
  enforceManagedLocalAutomationPolicy: (trigger: 'startup' | 'policy-change') => { stopped: number }
}

const roots: string[] = []
const managers: SessionManager[] = []

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await manager.cleanup().catch(() => undefined)
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  // The tier is process-scoped; a case that left it set would disable the
  // scheduler of every later file in this bun process.
  resetManagedLocalAutomationForTests()
})

/** A manager with one real workspace `AutomationSystem`, built at `tierNow`. */
function fixture(workspaceId: string): { manager: SessionManager; system: SchedulerProbe } {
  const root = mkdtempSync(join(tmpdir(), 'nessy-managed-local-automation-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  const manager = createTestSessionManager()
  managers.push(manager)
  manager.setupConfigWatcher(workspaceRoot, workspaceId)
  const system = (manager as unknown as ManagerInternals).automationSystems.get(workspaceId)
  expect(system).toBeDefined()
  return { manager, system: system! }
}

describe('D1.409 — a codex in_app_local_automation requirement reaches a running scheduler', () => {
  it('(a) stops the scheduler of a system constructed BEFORE the tier was written', () => {
    const { system } = fixture('ws-flip')
    // Read through the PRIVATE field, not the new getter, so this case can be
    // run against the pre-fix build and fail on the defect rather than on a
    // missing instrument.
    const live = (): boolean => (system as unknown as { scheduler: unknown }).scheduler !== null
    // The ordinary production ordering: boot builds the system with the tier
    // still `undefined`, so the scheduler is running.
    expect(live()).toBe(true)

    // The first codex app-server of the process reports the requirement.
    recordCodexLocalAutomationRequirement(true)

    expect(live()).toBe(false)
    // And the public receipt agrees with the private state it reports on.
    expect(system.schedulerRunning).toBe(false)
  })

  it('(b) says how many schedulers it stopped and names the policy', () => {
    const { manager } = fixture('ws-receipt')
    recordCodexLocalAutomationRequirement(true)
    // A second pass has nothing left to stop — the count is what really
    // happened, not the number of workspaces.
    const again = (manager as unknown as ManagerInternals)
      .enforceManagedLocalAutomationPolicy('policy-change')
    expect(again.stopped).toBe(0)
    // The sentence the host reports is the module's single wording, so the
    // scheduler, the hook builder and this notice cannot drift into three.
    expect(describeManagedLocalAutomationRefusal()).toContain('in_app_local_automation = false')
  })

  it('(c) declines the host wake sweep, which construction could never gate', async () => {
    const { manager, system } = fixture('ws-wake')
    let sweeps = 0
    const real = system.runMissedRunSweep.bind(system)
    system.runMissedRunSweep = async (now?: number) => { sweeps += 1; return real(now) }

    recordCodexLocalAutomationRequirement(true)
    const result = await manager.runMissedRunSweep()

    expect(result.fired).toBe(0)
    expect(sweeps).toBe(0)
  })

  it('(d) CONTROL — a tier of `false` changes nothing', () => {
    const { system } = fixture('ws-allowed')
    const live = (): boolean => (system as unknown as { scheduler: unknown }).scheduler !== null
    expect(live()).toBe(true)
    recordCodexLocalAutomationRequirement(false)
    expect(live()).toBe(true)
  })

  it('(e) CONTROL — clearing the tier changes nothing on its own', () => {
    const { system } = fixture('ws-cleared')
    const live = (): boolean => (system as unknown as { scheduler: unknown }).scheduler !== null
    recordCodexLocalAutomationRequirement(undefined)
    expect(live()).toBe(true)
  })

  it('(f) CONTROL — a workspace built AFTER the tier is set is declined at construction', () => {
    recordCodexLocalAutomationRequirement(true)
    const { system } = fixture('ws-late')
    const live = (): boolean => (system as unknown as { scheduler: unknown }).scheduler !== null
    expect(live()).toBe(false)
  })

  it('(g) arms the subscription AHEAD of the construction it protects', async () => {
    const src = await Bun.file(SESSION_MANAGER).text()
    const start = src.indexOf('  setupConfigWatcher(workspaceRootPath: string, workspaceId: string): void {')
    expect(start).toBeGreaterThan(0)
    const body = bracedRegion(src, start)
    // BOUNDARY CONTROL: a declaration BELOW this method, so a runaway brace scan
    // cannot make the ordering assertion pass on the rest of the file.
    expect(body).not.toContain('async runMissedRunSweep(')
    const arming = body.indexOf('this.ensureManagedLocalAutomationEnforcement()')
    const construction = body.indexOf('new AutomationSystem({')
    expect(arming).toBeGreaterThan(0)
    expect(construction).toBeGreaterThan(0)
    expect(arming).toBeLessThan(construction)
  })
})

/**
 * F1.795 (origin: release sitting SIT-m F8) — a scheduler declined at CONSTRUCTION (the cached codex tier restored at
 * startup, F1.101) was declined silently: (f) above shows it never runs, but `enforceManagedLocalAutomationPolicy`
 * names the policy only when it stops a RUNNING scheduler, so a startup decline left no sentence in the log. The
 * construction path now names it too.
 */
describe('F1.795 — a scheduler declined at construction says so', () => {
  it('the construction under the tier reports the declined workspace with the policy sentence', () => {
    recordCodexLocalAutomationRequirement(true)
    const noted: Array<{ workspaceId: string; reason: string }> = []
    const proto = (createTestSessionManager().constructor as { prototype: Record<string, unknown> }).prototype
    const real = proto.noteManagedLocalAutomationDeclined as (this: unknown, workspaceId: string) => { workspaceId: string; reason: string }
    proto.noteManagedLocalAutomationDeclined = function (this: unknown, workspaceId: string) {
      const payload = real.call(this, workspaceId)
      noted.push(payload)
      return payload
    }
    try {
      fixture('ws-declined')
    } finally {
      proto.noteManagedLocalAutomationDeclined = real
    }
    expect(noted).toEqual([{ workspaceId: 'ws-declined', reason: describeManagedLocalAutomationRefusal() }])
  })

  it('CONTROL — a construction with no tier reports nothing', () => {
    const noted: string[] = []
    const proto = (createTestSessionManager().constructor as { prototype: Record<string, unknown> }).prototype
    const real = proto.noteManagedLocalAutomationDeclined
    proto.noteManagedLocalAutomationDeclined = (workspaceId: string) => { noted.push(workspaceId) }
    try {
      fixture('ws-allowed-at-construction')
    } finally {
      proto.noteManagedLocalAutomationDeclined = real
    }
    expect(noted).toEqual([])
  })
})
