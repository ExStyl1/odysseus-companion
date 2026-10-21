/**
 * P3.53 · a managed OTLP endpoint delivered AFTER bootstrap now arms the
 * exporters instead of waiting for a restart.
 *
 * W2-g corrected the row's premise and pinned the ordering: `immediate` is a
 * STARTUP promise, and it is kept — a CACHED block is in the environment before
 * `createStorageRuntime` runs. What was left uncovered is the block that is not
 * in the cache when that line runs: a first launch, and any later change.
 *
 * Both halves are driven here, and so are the three things a swap gets wrong:
 * an event emitted while the old exporter drains, a rebuild that throws, and a
 * publish that changed nothing.
 */
import { describe, expect, it } from 'bun:test'
import { immediateEnvSnapshot, startOtlpRearming } from '../otlp-rearm'
import { managedEnvCategoryMembers } from '@nessy-agent/shared/config/managed-env'
import type { PiOtlpTelemetry } from '../../pi-harness/otlp-telemetry'
import type { UsageMetrics } from '@nessy-agent/shared/telemetry/usage-metrics'
import type { HostSpanAttributeValue, HostTracer } from '@nessy-agent/shared/telemetry/host-tracer'

const SESSION = { workspaceId: 'w', sessionId: 's' }
const EVENT = { schemaVersion: 1 as const, name: 'session.started' as const, timestamp: 1 }

interface FakeLogs extends PiOtlpTelemetry {
  readonly id: string
  readonly emitted: unknown[]
  readonly drained: { value: boolean }
}

function fakeLogs(id: string, onShutdown?: () => Promise<void>): FakeLogs {
  const emitted: unknown[] = []
  const drained = { value: false }
  return {
    id,
    emitted,
    drained,
    emit: (_session, event) => { emitted.push(event) },
    shutdown: async () => { await onShutdown?.(); drained.value = true },
  }
}

function fakeMetrics(id: string): UsageMetrics & { id: string; drained: { value: boolean } } {
  const drained = { value: false }
  return {
    id,
    drained,
    record: () => {},
    count: () => {},
    flush: async () => {},
    shutdown: async () => { drained.value = true },
  }
}

interface FakeTracer extends HostTracer {
  readonly id: string
  readonly open: Set<string>
  /** Every bulk close this tracer was asked for, with the stamp it was given. */
  readonly closed: Array<Record<string, HostSpanAttributeValue | undefined> | undefined>
  readonly drained: { value: boolean }
  /** How many turns were still open when the drain began — the ORDER assertion. */
  readonly openAtDrain: { value: number | undefined }
}

function fakeTracer(id: string): FakeTracer {
  const open = new Set<string>()
  const closed: Array<Record<string, HostSpanAttributeValue | undefined> | undefined> = []
  const drained = { value: false }
  const openAtDrain: { value: number | undefined } = { value: undefined }
  return {
    id,
    open,
    closed,
    drained,
    openAtDrain,
    startSpan: async (_options, callback) => callback({
      startSpan: async (_o, c) => c({} as never),
      addEvent: () => {}, setAttributes: () => {}, setStatus: () => {},
    }),
    currentTraceparent: () => (open.size > 0 ? `00-${id}-${id}-01` : undefined),
    beginTurnSpan: key => { open.add(key) },
    endTurnSpan: key => { open.delete(key) },
    closeOpenTurnSpans: attributes => { closed.push(attributes); open.clear() },
    flush: async () => {},
    shutdown: async () => { openAtDrain.value = open.size; drained.value = true },
  }
}

/** A hand-driven `onManagedDeliveryChange`. */
function deliveries() {
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    publish: () => { for (const listener of listeners) listener() },
    get size() { return listeners.size },
  }
}

describe('P3.53 · the immediate-slice snapshot', () => {
  it('reads the classification\'s own list rather than a copy of it', () => {
    // The AGENTS.md trap this avoids: a second enumeration beside a
    // single-source-of-truth list. Every name the classification calls
    // `immediate` must appear, and the count is deliberately not asserted.
    const snapshot = immediateEnvSnapshot({})
    const members = managedEnvCategoryMembers('immediate')
    expect(members.length).toBeGreaterThan(0)
    for (const name of members) expect(snapshot).toContain(name)
  })

  it('separates UNSET from empty, because withdrawing an endpoint is a change', () => {
    const name = managedEnvCategoryMembers('immediate')[0] as string
    expect(immediateEnvSnapshot({})).not.toBe(immediateEnvSnapshot({ [name]: '' }))
  })
})

describe('P3.53 · arming', () => {
  it('turns an exporter ON when the endpoint arrives after bootstrap', async () => {
    // THE first-launch case: nothing in the cache at boot, so the exporter is
    // built from an environment with no endpoint and there is nothing to swap.
    // The facade is what makes it reachable at all.
    const name = managedEnvCategoryMembers('immediate')[0] as string
    const env: Record<string, string | undefined> = {}
    const built: (FakeLogs | undefined)[] = []
    const bus = deliveries()

    const armed = await startOtlpRearming({
      buildPiTelemetry: async () => {
        const next = env[name] ? fakeLogs(`logs-${built.length}`) : undefined
        built.push(next)
        return next
      },
      buildUsageMetrics: () => (env[name] ? fakeMetrics('metrics') : undefined),
      subscribe: bus.subscribe,
      env: () => env,
    })

    // Boot: no delegate, and emitting is a harmless no-op rather than a throw.
    expect(built).toEqual([undefined])
    armed.piTelemetry.emit(SESSION, EVENT)

    env[name] = 'https://collector.example/v1'
    bus.publish()
    await armed.settled()

    const live = built[1]
    expect(live).toBeDefined()
    armed.piTelemetry.emit(SESSION, EVENT)
    expect(live!.emitted).toHaveLength(1)
  })

  it('swaps the delegate on a CHANGE and drains the old one', async () => {
    const env: Record<string, string | undefined> = {}
    const name = managedEnvCategoryMembers('immediate')[0] as string
    env[name] = 'https://one.example'
    const built: FakeLogs[] = []
    const bus = deliveries()

    const armed = await startOtlpRearming({
      buildPiTelemetry: async () => { const next = fakeLogs(`logs-${built.length}`); built.push(next); return next },
      buildUsageMetrics: () => fakeMetrics('metrics'),
      subscribe: bus.subscribe,
      env: () => env,
    })

    env[name] = 'https://two.example'
    bus.publish()
    await armed.settled()

    expect(built.map(entry => entry.id)).toEqual(['logs-0', 'logs-1'])
    // The old one is drained — `shutdown()` awaits a final flush, so the
    // in-flight batch is exported rather than dropped.
    expect(built[0]!.drained.value).toBe(true)
    expect(built[1]!.drained.value).toBe(false)
    // …and traffic goes to the NEW one.
    armed.piTelemetry.emit(SESSION, EVENT)
    expect(built[0]!.emitted).toHaveLength(0)
    expect(built[1]!.emitted).toHaveLength(1)
  })

  it('loses no event emitted WHILE the old exporter drains', async () => {
    // The swap order is the part that must not be got wrong: install the new
    // delegate first, then drain. Draining first leaves a window with no
    // exporter, and this is the only assertion that can see it.
    const env: Record<string, string | undefined> = {}
    const name = managedEnvCategoryMembers('immediate')[0] as string
    env[name] = 'https://one.example'
    let armedFacade: { emit: PiOtlpTelemetry['emit'] } | undefined
    const built: FakeLogs[] = []
    const bus = deliveries()

    const armed = await startOtlpRearming({
      buildPiTelemetry: async () => {
        const next = built.length === 0
          ? fakeLogs('logs-0', async () => { armedFacade?.emit(SESSION, EVENT) })
          : fakeLogs('logs-1')
        built.push(next)
        return next
      },
      buildUsageMetrics: () => fakeMetrics('metrics'),
      subscribe: bus.subscribe,
      env: () => env,
    })
    armedFacade = armed.piTelemetry

    env[name] = 'https://two.example'
    bus.publish()
    await armed.settled()

    expect(built[1]!.emitted).toHaveLength(1)
    expect(built[0]!.emitted).toHaveLength(0)
  })

  it('does nothing when a publish changed no immediate variable', async () => {
    // The hourly poll republishes; rebuilding two exporters on every tick would
    // be a cost with no cause.
    const env: Record<string, string | undefined> = {}
    const name = managedEnvCategoryMembers('immediate')[0] as string
    env[name] = 'https://one.example'
    let builds = 0
    const bus = deliveries()

    const armed = await startOtlpRearming({
      buildPiTelemetry: async () => { builds += 1; return fakeLogs(`logs-${builds}`) },
      buildUsageMetrics: () => fakeMetrics('metrics'),
      subscribe: bus.subscribe,
      env: () => env,
    })

    bus.publish()
    bus.publish()
    await armed.settled()
    expect(builds).toBe(1)

    // Positive control on the same rig: a real change still arms.
    env[name] = 'https://two.example'
    bus.publish()
    await armed.settled()
    expect(builds).toBe(2)
  })

  it('keeps the working exporter when a rebuild throws', async () => {
    // An administrator's endpoint typo must not take telemetry down; degrading
    // to "the old endpoint keeps working" beats degrading to silence.
    const env: Record<string, string | undefined> = {}
    const name = managedEnvCategoryMembers('immediate')[0] as string
    env[name] = 'https://one.example'
    const first = fakeLogs('logs-0')
    let calls = 0
    const bus = deliveries()

    const armed = await startOtlpRearming({
      buildPiTelemetry: async () => {
        calls += 1
        if (calls === 1) return first
        throw new Error('bad endpoint')
      },
      buildUsageMetrics: () => fakeMetrics('metrics'),
      subscribe: bus.subscribe,
      env: () => env,
    })

    env[name] = 'https://broken.example'
    bus.publish()
    await armed.settled()

    expect(first.drained.value).toBe(false)
    armed.piTelemetry.emit(SESSION, EVENT)
    expect(first.emitted).toHaveLength(1)
  })

  it('stops arming on `stop()`, and the facade keeps working', async () => {
    const env: Record<string, string | undefined> = {}
    const name = managedEnvCategoryMembers('immediate')[0] as string
    env[name] = 'https://one.example'
    let builds = 0
    const bus = deliveries()

    const armed = await startOtlpRearming({
      buildPiTelemetry: async () => { builds += 1; return fakeLogs(`logs-${builds}`) },
      buildUsageMetrics: () => fakeMetrics('metrics'),
      subscribe: bus.subscribe,
      env: () => env,
    })
    armed.stop()
    expect(bus.size).toBe(0)

    env[name] = 'https://two.example'
    bus.publish()
    await armed.settled()
    expect(builds).toBe(1)
    // Not torn down — the facade still forwards.
    armed.piTelemetry.emit(SESSION, EVENT)
  })

  it('P6.882 · ENDS the in-flight span on the outgoing tracer, stamped, before draining it', async () => {
    // The question a metrics batch never raises: the span was minted by the
    // tracer that is about to be drained, and the new one has never heard of it.
    const env: Record<string, string | undefined> = {}
    const name = managedEnvCategoryMembers('immediate')[0] as string
    env[name] = 'https://one.example'
    const built: FakeTracer[] = []
    const bus = deliveries()

    const armed = await startOtlpRearming({
      buildPiTelemetry: async () => fakeLogs('logs'),
      buildUsageMetrics: () => fakeMetrics('metrics'),
      buildHostTracer: () => { const next = fakeTracer(`tracer-${built.length}`); built.push(next); return next },
      subscribe: bus.subscribe,
      env: () => env,
    })

    armed.hostTracer.beginTurnSpan('ws:sess', { name: 'nessy.session.turn' })
    expect(armed.hostTracer.currentTraceparent('ws:sess')).toContain('tracer-0')

    env[name] = 'https://two.example'
    bus.publish()
    await armed.settled()

    // Ended on the OLD tracer with the marker, and ended BEFORE its drain, so
    // the truncated span rides the final flush rather than being lost.
    expect(built[0]!.closed).toEqual([{ 'nessy.telemetry.rearmed': true }])
    expect(built[0]!.open.size).toBe(0)
    expect(built[0]!.drained.value).toBe(true)
    // …and the ORDER, which the two assertions above cannot see on their own:
    // nothing was still open when the drain began, so the truncated span was in
    // the batch the final flush exported.
    expect(built[0]!.openAtDrain.value).toBe(0)
    // The new tracer is live and was NOT asked to close anything it never had.
    expect(built[1]!.closed).toEqual([])
    expect(armed.hostTracer.currentTraceparent('ws:sess')).toBeUndefined()
    // The turn's own falling edge now reaches the new delegate, where nothing is
    // open — the documented no-op, not a second export.
    armed.hostTracer.endTurnSpan('ws:sess')
    armed.hostTracer.beginTurnSpan('ws:next', { name: 'nessy.session.turn' })
    expect(built[1]!.open.has('ws:next')).toBe(true)
  })

  it('P6.882 · NEGATIVE: a host that passes no tracer gets an inert facade, and a re-arm changes nothing', async () => {
    // `buildHostTracer` is optional precisely so every caller that had no span
    // source keeps its exact behaviour. An inert facade must answer every
    // method without a delegate — including `startSpan`, whose callback still
    // has to run: telemetry may never fail the work it measures.
    const env: Record<string, string | undefined> = {}
    const name = managedEnvCategoryMembers('immediate')[0] as string
    env[name] = 'https://one.example'
    const bus = deliveries()

    const armed = await startOtlpRearming({
      buildPiTelemetry: async () => fakeLogs('logs'),
      buildUsageMetrics: () => fakeMetrics('metrics'),
      subscribe: bus.subscribe,
      env: () => env,
    })

    armed.hostTracer.beginTurnSpan('ws:sess', { name: 'nessy.session.turn' })
    expect(armed.hostTracer.currentTraceparent('ws:sess')).toBeUndefined()
    expect(await armed.hostTracer.startSpan({ name: 'child' }, () => 'ran')).toBe('ran')

    env[name] = 'https://two.example'
    bus.publish()
    await armed.settled()

    expect(armed.hostTracer.currentTraceparent('ws:sess')).toBeUndefined()
    await armed.hostTracer.flush()
    await armed.hostTracer.shutdown()
  })

  it('shutdown drains the delegate and then swallows further emits', async () => {
    const env: Record<string, string | undefined> = {}
    const name = managedEnvCategoryMembers('immediate')[0] as string
    env[name] = 'https://one.example'
    const logs = fakeLogs('logs-0')
    const metrics = fakeMetrics('metrics-0')
    const bus = deliveries()

    const armed = await startOtlpRearming({
      buildPiTelemetry: async () => logs,
      buildUsageMetrics: () => metrics,
      subscribe: bus.subscribe,
      env: () => env,
    })

    await armed.piTelemetry.shutdown()
    await armed.usageMetrics.shutdown()
    expect(logs.drained.value).toBe(true)
    expect(metrics.drained.value).toBe(true)

    armed.piTelemetry.emit(SESSION, EVENT)
    expect(logs.emitted).toHaveLength(0)
  })
})
