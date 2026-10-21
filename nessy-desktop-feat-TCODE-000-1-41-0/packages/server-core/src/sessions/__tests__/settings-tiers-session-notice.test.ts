/**
 * P6.576 — the two settings-file tiers reach the session.
 *
 * `buildConfigDoctorReport` already named the winning managed source, the
 * shadowed sources and the dropped entries, and its only production consumer was
 * `apps/cli/src/doctor.ts`. The host held the fact and the user it is about
 * never met it. `buildSettingsTiersSessionLine`'s derivation is pinned by
 * `config/__tests__/config-doctor.test.ts`; what is pinned HERE is the emitting
 * half — the channel, the level, and the once-per-session discipline that keeps
 * a session fact from becoming a per-turn nag.
 *
 * P6.684 — the memo now holds CLAUSES, not a sentence, and the emitter renders
 * them in the user's language. So this file also pins that the renderer maps
 * every clause the derivation can produce: a clause it cannot render is dropped,
 * and a notice of nothing but unrenderable clauses is no notice at all.
 *
 * P6.733 — one of those clauses is the identity-export disclosure, which is not
 * a settings tier: it rides this line because a second notice for one sentence
 * would be more code for the same fact, at the same moment, for the same
 * audience.
 *
 * F1.103 (D1.424) — the notice is rendered by the SHARED i18n singleton, so this
 * file pins its own language in an awaited hook. Found by the census: with the
 * singleton left on 'ru' by an earlier file in the same bun process (the CI
 * `test` job runs one process per directory), 8 of its 12 cases received the
 * Russian sentence and failed on the English pins, while every case passes alone.
 * The recipe is WI-bs's (`agent/__tests__/claude-session-permission-grant.test.ts`).
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { i18n, setupI18n } from '@nessy-agent/shared/i18n'
import type { SettingsTiersClauseV1 } from '@nessy-agent/shared/config/config-doctor'
import { createTestSessionManager } from './test-session-manager.ts'
import { CLAUDE_AUTO_MEMORY_ENV_VAR } from '@nessy-agent/shared/agent/memory/claude-auto-memory'

type RecordedEvent = { type: string; message?: string; level?: string }

/**
 * The production method is private, so it is invoked directly against a
 * hand-built managed session — the assertion then rests on the shipped wiring
 * rather than on a re-implementation of it. Only `sendEvent` is replaced, and by
 * a RECORDER rather than a no-op: the notice rides that channel, so a rig that
 * discarded it could not see the row's deliverable at all.
 */
function rig(clauses: readonly SettingsTiersClauseV1[] | null | undefined) {
  const manager = createTestSessionManager()
  const internals = manager as unknown as {
    settingsTiersSessionClauses: readonly SettingsTiersClauseV1[] | null | undefined
    announceSettingsTiers(managed: unknown): void
    sendEvent(event: RecordedEvent, workspaceId: string): void
  }
  const events: RecordedEvent[] = []
  internals.sendEvent = event => { events.push(event) }
  internals.settingsTiersSessionClauses = clauses
  const managed = {
    id: 'session-1',
    workspace: { id: 'workspace-1', rootPath: '/tmp/workspace-1' },
  }
  return { internals, managed, events }
}

const MANAGED: readonly SettingsTiersClauseV1[] = [{ id: 'managed-source', winner: 'file' }]

beforeAll(async () => {
  if (!i18n.isInitialized) setupI18n()
  await i18n.changeLanguage('en')
})

describe('P6.576 — the settings-tiers session notice', () => {
  test('a session that has something to say says it once, as a fact', () => {
    const h = rig(MANAGED)
    h.internals.announceSettingsTiers(h.managed)
    expect(h.events).toHaveLength(1)
    expect(h.events[0]!.type).toBe('info')
    // Rendered, not echoed: the frame and the clause both come from the locale.
    expect(h.events[0]!.message).toContain('managed settings (file) in effect')
    expect(h.events[0]!.message).toContain('nessy-general-agent doctor')
    // NOT a warning. A managed source being in effect is true in every session
    // on a managed fleet; raising the level for it would make `warning` mean
    // "a policy exists" and stop meaning "something is wrong".
    expect(h.events[0]!.level).toBeUndefined()
  })

  test('a second turn in the same session does not repeat it', () => {
    const h = rig(MANAGED)
    h.internals.announceSettingsTiers(h.managed)
    h.internals.announceSettingsTiers(h.managed)
    h.internals.announceSettingsTiers(h.managed)
    expect(h.events).toHaveLength(1)
  })

  /**
   * The boundary, and the reason the derivation is allowed to return
   * `undefined`: on the default install there is no managed source, no drop and
   * no rejected layer, and a line emitted anyway would be text every user learns
   * to skip — which is how the notice stops being read before it ever matters.
   */
  test('a machine with nothing to report emits nothing', () => {
    const h = rig(undefined)
    h.internals.announceSettingsTiers(h.managed)
    expect(h.events).toEqual([])
    // And an EMPTY clause list is the same silence, which is what the default
    // install actually produces now that the memo holds clauses.
    const empty = rig([])
    empty.internals.announceSettingsTiers(empty.managed)
    expect(empty.events).toEqual([])
  })

  /**
   * P6.684 — every clause the derivation can produce has a rendering. A missing
   * key drops the clause silently, which is the direction that hurts: the notice
   * would go on being emitted while quietly saying less than the doctor does.
   *
   * D1.352 — and "every" is now the TYPE's word rather than a hand-written list.
   * The list held eight of the twelve members: the four announced by their own
   * producers rather than by `buildSettingsTiersSessionClauses`
   * (`child-telemetry-disagreement`, `child-credential-source-unexpected`,
   * `claude-auto-memory-abnormal`, `command-hook-preauthorized`) were covered
   * nowhere in this file, so the case's own promise was true only of the
   * builder's half. The `satisfies` below is keyed on `SettingsTiersClauseV1`'s
   * own id union, so a member added to that type without an entry here is a
   * BUILD failure on this file — the same discipline `renderSettingsTiersLine`'s
   * `never` residue (D1.252) applies to the switch, one layer out, and it
   * catches the case that residue cannot: an arm that exists with no locale key
   * behind it.
   *
   * The instrument is a SENTENCE PER SAMPLE and no longer a separator count, and
   * that is a measured change rather than a taste one: two of the twelve
   * sentences contain the `'; '` the clauses are joined with (the two
   * `command-hook-preauthorized` ones, D1.343), so `split('; ')` counts them
   * twice and the length this case used to assert would have been wrong the day
   * that clause joined the list. A fragment per sample also NAMES the clause
   * that went missing instead of reporting a number that moved.
   */
  test('renders every clause kind, and the counted ones carry their number', () => {
    const samples = {
      'managed-source': [
        { clause: { id: 'managed-source', winner: 'delivered' }, says: 'managed settings (remote) in effect' },
        { clause: { id: 'managed-source', winner: 'file' }, says: 'managed settings (file) in effect' },
      ],
      'invalid-managed-entries': [
        { clause: { id: 'invalid-managed-entries', count: 2 }, says: '2 invalid managed entries were dropped' },
      ],
      'rejected-layers': [
        { clause: { id: 'rejected-layers', count: 1 }, says: '1 settings layer was rejected whole' },
      ],
      'shadowed-managed-file': [
        { clause: { id: 'shadowed-managed-file' }, says: 'shadowed and enforces nothing' },
      ],
      'unfulfilled-mandates': [
        { clause: { id: 'unfulfilled-mandates', count: 3 }, says: '3 force-enabled plugins are not installed here' },
      ],
      'instruction-files-over-limit': [
        { clause: { id: 'instruction-files-over-limit', count: 1, limit: 200 }, says: '200-line guidance' },
      ],
      'telemetry-identity-exported': [
        { clause: { id: 'telemetry-identity-exported' }, says: "exported to your operator's telemetry collector" },
      ],
      'telemetry-event-dialect': [
        { clause: { id: 'telemetry-event-dialect', dialect: 'host-nessy' }, says: "this product's own `nessy.*` names" },
        { clause: { id: 'telemetry-event-dialect', dialect: 'codex' }, says: "codex's own `codex.*` names" },
        { clause: { id: 'telemetry-event-dialect', dialect: 'claude-sdk' }, says: "the Claude runtime's own `claude_code.*` names" },
      ],
      'child-telemetry-disagreement': [
        {
          clause: { id: 'child-telemetry-disagreement', state: 'still-enabled', requested: 'DO_NOT_TRACK=1' },
          says: 'you set DO_NOT_TRACK=1, and the Claude runtime reports analytics still enabled',
        },
        {
          clause: { id: 'child-telemetry-disagreement', state: 'off-while-exporting' },
          says: 'reports its own analytics off for this session',
        },
      ],
      'child-credential-source-unexpected': [
        {
          clause: { id: 'child-credential-source-unexpected', source: 'apiKey', expected: 'subscription' },
          says: 'authorized this session with apiKey, where this connection implies subscription',
        },
      ],
      'claude-auto-memory-abnormal': [
        {
          clause: { id: 'claude-auto-memory-abnormal', state: 'forced-on' },
          says: 'forced on for this session by CLAUDE_CODE_DISABLE_AUTO_MEMORY',
        },
        {
          clause: { id: 'claude-auto-memory-abnormal', state: 'off-by-host' },
          says: 'off for this chat, so it neither writes nor reads notes of its own',
        },
      ],
      'command-hook-preauthorized': [
        {
          clause: { id: 'command-hook-preauthorized', tier: 'user' },
          says: 'command hooks in your own settings run without asking',
        },
        {
          clause: { id: 'command-hook-preauthorized', tier: 'project' },
          says: "command hooks in this trusted project's settings run without asking",
        },
      ],
    } satisfies {
      readonly [K in SettingsTiersClauseV1['id']]: readonly {
        readonly clause: Extract<SettingsTiersClauseV1, { id: K }>
        readonly says: string
      }[]
    }

    const all = Object.values(samples).flat() as readonly {
      clause: SettingsTiersClauseV1
      says: string
    }[]
    const h = rig(all.map(sample => sample.clause))
    h.internals.announceSettingsTiers(h.managed)
    const message = h.events[0]?.message ?? ''
    for (const sample of all) expect(message).toContain(sample.says)
    // A clause the renderer could not render is dropped, so a key that goes
    // missing takes its sentence with it and the loop above names which.
    expect(message).toContain('nessy-general-agent doctor')
  })

  /**
   * C3.199 (QM3 = A, owner 2026-09-11) — the dialect clause is the one the
   * MANAGER cannot cache, because it belongs to the session and not to the
   * process: two sessions on two runtimes export two vocabularies.
   */
  describe('C3.199 · which event dialect this session exports', () => {
    const withTelemetry = <T>(value: string | undefined, run: () => T): T => {
      const before = process.env.NESSY_ENABLE_TELEMETRY
      // `delete` before assigning, always: AGENTS.md's measured Bun trap.
      delete process.env.NESSY_ENABLE_TELEMETRY
      if (value !== undefined) process.env.NESSY_ENABLE_TELEMETRY = value
      try {
        return run()
      } finally {
        delete process.env.NESSY_ENABLE_TELEMETRY
        if (before !== undefined) process.env.NESSY_ENABLE_TELEMETRY = before
      }
    }

    const sayFor = (provider: string): string => withTelemetry('1', () => {
      const h = rig(MANAGED)
      ;(h.internals as unknown as { resolveManagedProvider(): string }).resolveManagedProvider =
        () => provider
      h.internals.announceSettingsTiers(h.managed)
      return h.events[0]?.message ?? ''
    })

    test('names the vocabulary the runtime actually emits, one runtime at a time', () => {
      expect(sayFor('pi')).toContain("this product's own `nessy.*` names")
      expect(sayFor('codex-runtime')).toContain("codex's own `codex.*` names")
      expect(sayFor('anthropic')).toContain("the Claude runtime's own `claude_code.*` names")
      // The rename is the reason the row exists: a dashboard built from the
      // vendor's page is otherwise queried against names we do not emit.
      expect(sayFor('pi')).toContain('`claude_code.*`')
      // It rides the EXISTING line rather than a second notice.
      expect(sayFor('pi')).toContain('managed settings (file) in effect')
    })

    test('says nothing at all on a machine that never opted into telemetry', () => {
      const message = withTelemetry(undefined, () => {
        const h = rig(MANAGED)
        h.internals.announceSettingsTiers(h.managed)
        return h.events[0]?.message ?? ''
      })
      expect(message).toContain('managed settings (file) in effect')
      expect(message).not.toContain('nessy.*')
      // And with nothing else to say either, the whole line stays absent — the
      // dialect clause must not resurrect a notice the default install suppresses.
      const events = withTelemetry(undefined, () => {
        const h = rig([])
        h.internals.announceSettingsTiers(h.managed)
        return h.events
      })
      expect(events).toEqual([])
    })
  })

  /**
   * P6.733 — the control. With identity export off the sentence is ABSENT,
   * which is the half of the row a positive-only test cannot prove.
   */
  test('says nothing about identity export when the clause is not there', () => {
    const h = rig(MANAGED)
    h.internals.announceSettingsTiers(h.managed)
    expect(h.events[0]?.message ?? '').not.toContain('telemetry collector')
  })

  /**
   * D1.139 / D1.250 — the claude auto-memory clause: the two ABNORMAL states are
   * said out loud and the ordinary one is not.
   *
   * The ordinary state is the case that matters. `runtime-default` is true of
   * every claude session, so a clause that fired on it would put a line on all
   * of them, which is the per-session nag this notice's latch exists to prevent
   * — and it already has a PULL surface (D1.215). A positive-only test would be
   * satisfied by a resolver that reported all three.
   *
   * The resolver is driven for REAL: `resolveManagedProvider` is stubbed to say
   * which runtime this is (the same stub the dialect block above uses) and the
   * disposition comes from the environment through
   * `resolveSessionRuntimeNotices`, exactly as the spawn reads it.
   */
  describe('D1.250 · the claude auto-memory clause', () => {
    const withAutoMemoryEnv = <T>(value: string | undefined, run: () => T): T => {
      const before = process.env[CLAUDE_AUTO_MEMORY_ENV_VAR]
      // `delete` before assigning, on both paths: AGENTS.md's measured bun trap.
      delete process.env[CLAUDE_AUTO_MEMORY_ENV_VAR]
      if (value !== undefined) process.env[CLAUDE_AUTO_MEMORY_ENV_VAR] = value
      try {
        return run()
      } finally {
        delete process.env[CLAUDE_AUTO_MEMORY_ENV_VAR]
        if (before !== undefined) process.env[CLAUDE_AUTO_MEMORY_ENV_VAR] = before
      }
    }

    const sayFor = (provider: string, env: string | undefined): string =>
      withAutoMemoryEnv(env, () => {
        const h = rig(MANAGED)
        ;(h.internals as unknown as { resolveManagedProvider(): string }).resolveManagedProvider =
          () => provider
        h.internals.announceSettingsTiers(h.managed)
        return h.events[0]?.message ?? ''
      })

    test('says the FORCED-ON state, naming the variable that produced it', () => {
      const message = sayFor('anthropic', '0')
      expect(message).toContain('CLAUDE_CODE_DISABLE_AUTO_MEMORY')
      expect(message).toContain('forced on')
      // It rides the EXISTING line rather than a second notice.
      expect(message).toContain('managed settings (file) in effect')
    })

    test('the ORDINARY state says nothing at all — the control', () => {
      const message = sayFor('anthropic', undefined)
      expect(message).toContain('managed settings (file) in effect')
      expect(message).not.toContain('CLAUDE_CODE_DISABLE_AUTO_MEMORY')
      expect(message).not.toContain('memory')
    })

    test('and a non-claude session is never asked — which is also what keeps a claude-config dir from being created', () => {
      // `workspaceClaudeConfigDir` CREATES the directory it names, so the
      // provider check is a control on a side effect and not only a fast path.
      const message = sayFor('pi', '0')
      expect(message).toContain('managed settings (file) in effect')
      expect(message).not.toContain('CLAUDE_CODE_DISABLE_AUTO_MEMORY')
    })
  })

  /**
   * D1.252 — the RUNTIME half of the promise `renderSettingsTiersLine`'s
   * docblock makes. The BUILD half cannot be asserted from here (a member that
   * does not compile cannot be written into a test file either); it was measured
   * by planting `{ id: 'planted-control-clause' }` on `SettingsTiersClauseV1`
   * and reading `typecheck:server-core` — `error TS2322: Type '{ readonly id:
   * "planted-control-clause"; }' is not assignable to type 'never'` on the
   * `default` arm's binding, against exit 0 on the same bytes unplanted.
   *
   * What IS assertable here is the direction that arm must NOT take: the `never`
   * binding sits BESIDE `return undefined` rather than replacing it, so an id
   * that reached this switch by a cast is dropped, and the clauses around it
   * still render. Returning the binding instead — the spelling the renderer's
   * `runtimeNoticeKey` uses, where the value IS the key — would put
   * `[object Object]` into a translated sentence, and this case is what sees it.
   */
  test('an id the union cannot produce is dropped, and its neighbours still render', () => {
    const withUnknown = [
      { id: 'managed-source', winner: 'file' },
      { id: 'a-clause-this-switch-does-not-know' },
      { id: 'telemetry-identity-exported' },
    ] as unknown as readonly SettingsTiersClauseV1[]
    const h = rig(withUnknown)
    h.internals.announceSettingsTiers(h.managed)
    const message = h.events[0]?.message ?? ''
    expect(message).toContain('managed settings (file) in effect')
    expect(message).toContain("exported to your operator's telemetry collector")
    // The two that rendered, and nothing between them.
    expect(message.split('; ')).toHaveLength(2)
    expect(message).not.toContain('[object Object]')
    expect(message).not.toContain('a-clause-this-switch-does-not-know')
  })

  /**
   * The control on the REAL derivation: with the memo unset the method runs
   * `collectConfigDoctorInput()` for itself. Whatever this machine's settings
   * tiers happen to say, the method must not throw — it sits at the top of
   * `sendMessage`, so a diagnosis that can fail a send is worse than the silence
   * it replaces — and it must still emit at most one event for the session.
   */
  test('the real derivation runs without throwing and stays once-per-session', () => {
    const h = rig(null)
    expect(() => {
      h.internals.announceSettingsTiers(h.managed)
      h.internals.announceSettingsTiers(h.managed)
    }).not.toThrow()
    expect(h.events.length).toBeLessThanOrEqual(1)
    // And the memo was filled either way, so the second call read no file.
    expect(h.internals.settingsTiersSessionClauses).not.toBeNull()
  })
})
