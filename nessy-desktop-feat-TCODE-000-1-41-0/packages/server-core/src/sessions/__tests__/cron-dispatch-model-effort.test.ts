/**
 * P6.376 — a scheduled run dispatches on the model and effort LEVEL the cron
 * RECORD chose, not on whatever the session happens to be set to when the fire
 * lands, and the session is left exactly as it was found.
 *
 * The service half (the record, the store round-trip, the fire carrying the two
 * fields, and the mutation guard) is pinned in `session-cron-service.test.ts`.
 * THIS file pins the other half the row names: `SessionManager`'s dispatch —
 * apply, deliver, restore — which is the piece that decides whether the two
 * fields mean anything.
 *
 * Driven through a partial manager built with `Object.create`, the pattern this
 * suite already uses for the teardown rows: the method under test reaches four
 * members of `this` and nothing else, so a real manager would buy nothing but a
 * workspace, a store and a live agent.
 */
import { describe, expect, test } from 'bun:test'
import { createTestSessionManager } from './test-session-manager.ts'
import type { SessionCronFire } from '../session-cron-service.ts'

type Call = { kind: 'model' | 'effort' | 'deliver'; value: string | null }

function rig(options: { provider?: string; effort?: string; model?: string } = {}) {
  const calls: Call[] = []
  const managed = {
    id: 'sess-a',
    workspace: { id: 'ws-a' },
    model: options.model,
    thinkingLevel: options.effort,
  }
  // `deliverScheduledCronFire` is PRIVATE, so the cast goes through `unknown`:
  // intersecting a private member with a public one reduces to `never`, which
  // reads as "the property does not exist" and hides the real reason.
  const manager = createTestSessionManager() as unknown as {
    deliverScheduledCronFire(managed: unknown, fire: SessionCronFire): Promise<void>
  }
  Object.assign(manager, {
    resolveManagedProvider: () => options.provider ?? 'pi',
    updateSessionModel: async (_id: string, _ws: string, model: string | null) => {
      calls.push({ kind: 'model', value: model })
    },
    setSessionThinkingLevel: async (_id: string, level: string) => {
      calls.push({ kind: 'effort', value: level })
    },
    deliverMonitorEvent: async (delivery: { text: string }) => {
      calls.push({ kind: 'deliver', value: delivery.text })
    },
  })
  return { manager, managed, calls }
}

describe('P6.376 · SessionManager dispatches a cron fire on the record’s model and effort', () => {
  test('applies both, delivers, and restores what the session was on', async () => {
    const { manager, managed, calls } = rig({ model: 'session-model', effort: 'max' })
    await manager.deliverScheduledCronFire(managed, {
      prompt: 'nightly sweep', model: 'claude-haiku-4-5', effort: 'low',
    })
    expect(calls).toEqual([
      { kind: 'model', value: 'claude-haiku-4-5' },
      { kind: 'effort', value: 'low' },
      { kind: 'deliver', value: 'nightly sweep' },
      // The restore is the half that makes this usable: a session the person
      // comes back to in the morning is on what they left it on.
      { kind: 'model', value: 'session-model' },
      { kind: 'effort', value: 'max' },
    ])
  })

  test('a fire naming only an effort never touches the model, and vice versa', async () => {
    const effortOnly = rig({ model: 'session-model', effort: 'max' })
    await effortOnly.manager.deliverScheduledCronFire(effortOnly.managed, { prompt: 'e', effort: 'off' })
    expect(effortOnly.calls).toEqual([
      { kind: 'effort', value: 'off' },
      { kind: 'deliver', value: 'e' },
      { kind: 'effort', value: 'max' },
    ])

    const modelOnly = rig({ model: 'session-model', effort: 'max' })
    await modelOnly.manager.deliverScheduledCronFire(modelOnly.managed, { prompt: 'm', model: 'claude-haiku-4-5' })
    expect(modelOnly.calls).toEqual([
      { kind: 'model', value: 'claude-haiku-4-5' },
      { kind: 'deliver', value: 'm' },
      { kind: 'model', value: 'session-model' },
    ])
  })

  // A session that never had a model of its own restores to `null`, which is
  // `updateSessionModel`'s own documented "clear" — not to the cron's model,
  // and not left dangling.
  test('a session with no model of its own is cleared back, not left on the cron’s', async () => {
    const { manager, managed, calls } = rig()
    await manager.deliverScheduledCronFire(managed, { prompt: 'p', model: 'claude-haiku-4-5' })
    expect(calls.at(-1)).toEqual({ kind: 'model', value: null })
  })

  // NEGATIVE 1 — the delivery failing must not strand the session on the cron's
  // settings. The restore is in a `finally` precisely for this.
  test('a failed delivery still restores the session', async () => {
    const { manager, managed, calls } = rig({ model: 'session-model', effort: 'max' })
    Object.assign(manager, {
      deliverMonitorEvent: async () => { throw new Error('turn boundary busy') },
    })
    await manager.deliverScheduledCronFire(managed, { prompt: 'p', model: 'claude-haiku-4-5', effort: 'low' })
    expect(calls).toEqual([
      { kind: 'model', value: 'claude-haiku-4-5' },
      { kind: 'effort', value: 'low' },
      { kind: 'model', value: 'session-model' },
      { kind: 'effort', value: 'max' },
    ])
  })

  // NEGATIVE 2 — the runtime gate `deliverScheduledMonitorEvent` applies is
  // read here too. A session that has moved to a runtime with no host tool loop
  // must not be woken, and must certainly not have its model changed on the way.
  test('a runtime outside SCHEDULED_DELIVERY_RUNTIMES is neither woken nor re-modelled', async () => {
    const { manager, managed, calls } = rig({ provider: 'not-a-scheduled-runtime', model: 'session-model' })
    await manager.deliverScheduledCronFire(managed, { prompt: 'p', model: 'claude-haiku-4-5', effort: 'low' })
    expect(calls).toEqual([])
  })
})
