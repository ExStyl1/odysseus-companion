/**
 * P6.362 — an unrecognised model id produces a diagnostic, once, on every
 * runtime.
 *
 * Measured before building: no runtime does this for us behind our loopback.
 * Claude's vendored binary emits the line itself, but `model-config.md` states
 * the check *"runs only on the Anthropic API"* and exempts LLM gateways and a
 * custom `ANTHROPIC_BASE_URL` — which is exactly where every one of our
 * sessions lives. So the host is the only seam, and being host-side it answers
 * identically on all three.
 *
 * The three narrowings are what stop it crying wolf, and each has an arm: an
 * empty catalogue says nothing, a served id says nothing, and the same id twice
 * says it once.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { resolveModelForProvider } from '@nessy-agent/shared/agent/backend/factory'
import { resolveConnectionModelAlias } from '@nessy-agent/shared/config/llm-connections'
import { setManagedModelAllowlist } from '@nessy-agent/shared/config/managed-model-allowlist'
import type { LlmConnection } from '@nessy-agent/shared/config/llm-connections'
import {
  forgetModelDefaultSubstitution,
  peekModelDefaultSubstitution,
  recordModelDefaultSubstitution,
} from '../../model-fetchers'
import { createTestSessionManager } from './test-session-manager.ts'

type Event = { type: string; level?: string; message?: string; sessionId?: string; model?: string | null }

function harness(models: unknown[] | undefined) {
  const events: Event[] = []
  const manager = createTestSessionManager() as any
  manager.sendEvent = (event: Event) => { events.push(event) }
  manager.unrecognizedModelNotices = new Set<string>()
  const managed = { id: 'session-1', workspace: { id: 'workspace-1' } }
  const context = {
    connection: { slug: 'gateway', ...(models === undefined ? {} : { models }) },
    resolvedModel: 'tgpt/qwen35-397b-a17b-fp8',
  }
  return { manager, managed, context, events, warnings: () => events.filter(e => e.level === 'warning') }
}

describe('P6.362 the unrecognised model id is named', () => {
  test('names the id and the catalogue it was checked against', () => {
    const rig = harness([{ id: 'claude-opus-5' }, 'gpt-5.1'])

    rig.manager.warnIfModelIdUnrecognized(rig.managed, rig.context)

    const [warning] = rig.warnings()
    expect(warning?.message).toContain('tgpt/qwen35-397b-a17b-fp8')
    // The catalogue it was checked against, by SIZE — a connection's model list
    // is the operator's to disclose, and the count is what makes the claim
    // checkable.
    expect(warning?.message).toContain('the 2 models')
    expect(warning?.message).toContain('`gateway`')
    // It does not claim the request will fail: our catalogue is a cache.
    expect(warning?.message).toContain('will still be sent')
  })

  test('says it ONCE for the same session, connection and id', () => {
    const rig = harness(['claude-opus-5'])

    rig.manager.warnIfModelIdUnrecognized(rig.managed, rig.context)
    rig.manager.warnIfModelIdUnrecognized(rig.managed, rig.context)
    rig.manager.warnIfModelIdUnrecognized(rig.managed, rig.context)

    expect(rig.warnings()).toHaveLength(1)
  })

  test('an EMPTY catalogue is not a refutation and says nothing', () => {
    const empty = harness([])
    empty.manager.warnIfModelIdUnrecognized(empty.managed, empty.context)
    expect(empty.warnings()).toEqual([])

    // Nor is an absent one: a connection whose models were never fetched knows
    // nothing about the id, and a warning derived from missing data is the kind
    // that trains people to ignore warnings.
    const absent = harness(undefined)
    absent.manager.warnIfModelIdUnrecognized(absent.managed, absent.context)
    expect(absent.warnings()).toEqual([])
  })

  test('a served id says nothing — the positive control', () => {
    const rig = harness([{ id: 'tgpt/qwen35-397b-a17b-fp8' }, 'claude-opus-5'])
    rig.manager.warnIfModelIdUnrecognized(rig.managed, rig.context)
    expect(rig.warnings()).toEqual([])
  })

  test('a connection the session has none of says nothing', () => {
    const rig = harness(['claude-opus-5'])
    rig.manager.warnIfModelIdUnrecognized(rig.managed, { connection: null, resolvedModel: 'x' })
    expect(rig.warnings()).toEqual([])
  })
})

/**
 * P6.362 · the ALIAS half — and the diagnostic above is what proves it MAPPED
 * rather than merely went quiet.
 *
 * Nothing here touches `warnIfModelIdUnrecognized`: the alias resolves inside
 * `resolveModelForProvider`, so by the time the diagnostic reads
 * `backendContext.resolvedModel` the id is the SERVED one and the check passes
 * on its own terms. An alias that only silenced the warning would leave the
 * unserved id going out on the wire, which is the failure this shape refuses.
 *
 * Tier 1 is native and needs no configuration: the Nessy Gateway publishes an
 * `alias` per model on `/cli/models`, `fetchNestorModels` maps it onto
 * `ModelDefinition.shortName`, and `resolveGatewayFastModelId` already resolves
 * one of them by hand. Tier 2 is the operator's own declaration, for endpoints
 * that publish none — the gateway's default coder model
 * `tgpt/qwen35-397b-a17b-fp8` is exactly that case.
 */
const SERVED = 'tgpt/t-pro-it-2-1-fp8'
const GATEWAY_DEFAULT_CODER = 'tgpt/qwen35-397b-a17b-fp8'

function gatewayConnection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'gateway',
    name: 'Nessy Gateway',
    providerType: 'claude-runtime',
    authType: 'api-key',
    createdAt: 0,
    defaultModel: GATEWAY_DEFAULT_CODER,
    models: [{ id: SERVED, name: SERVED, shortName: 'coder' }, { id: 'tgpt/qwen3-235b-a22b', name: 'q3' }],
    ...overrides,
  } as LlmConnection
}

describe('P6.362 an alias maps an unrecognised id onto a served one', () => {
  afterEach(() => { setManagedModelAllowlist(undefined) })

  test('the endpoint’s OWN published alias resolves with nothing configured', () => {
    // `coder` is the catalogue entry’s `shortName`, i.e. the gateway’s `alias`.
    const resolved = resolveConnectionModelAlias(gatewayConnection(), 'coder')
    expect(resolved).toBe(SERVED)
  })

  test('an operator alias maps the gateway default coder model, and the diagnostic goes quiet', () => {
    const connection = gatewayConnection({ modelAliases: { [GATEWAY_DEFAULT_CODER]: SERVED } })
    const resolvedModel = resolveModelForProvider('anthropic', undefined, connection)
    expect(resolvedModel).toBe(SERVED)

    const rig = harness([{ id: SERVED }, { id: 'tgpt/qwen3-235b-a22b' }])
    rig.manager.warnIfModelIdUnrecognized(rig.managed, { connection, resolvedModel })
    expect(rig.warnings()).toEqual([])
  })

  test('an alias whose TARGET is not served is refused, and the diagnostic still names the ORIGINAL id', () => {
    const connection = gatewayConnection({ modelAliases: { [GATEWAY_DEFAULT_CODER]: 'tgpt/never-served' } })
    const resolvedModel = resolveModelForProvider('anthropic', undefined, connection)
    expect(resolvedModel).toBe(GATEWAY_DEFAULT_CODER)

    const rig = harness([{ id: SERVED }, { id: 'tgpt/qwen3-235b-a22b' }])
    rig.manager.warnIfModelIdUnrecognized(rig.managed, { connection, resolvedModel })
    const [warning] = rig.warnings()
    expect(warning?.message).toContain(GATEWAY_DEFAULT_CODER)
  })

  test('an alias is not a route around the managed allowlist', () => {
    setManagedModelAllowlist(['tgpt/qwen3-235b-a22b'])
    const connection = gatewayConnection({ modelAliases: { [GATEWAY_DEFAULT_CODER]: SERVED } })
    expect(resolveConnectionModelAlias(connection, GATEWAY_DEFAULT_CODER)).toBe(GATEWAY_DEFAULT_CODER)
  })

  test('an id the catalogue already serves is returned untouched — no alias may redirect it', () => {
    const connection = gatewayConnection({ modelAliases: { [SERVED]: 'tgpt/qwen3-235b-a22b' } })
    expect(resolveConnectionModelAlias(connection, SERVED)).toBe(SERVED)
  })

  test('an EMPTY catalogue resolves nothing — it cannot tell served from unserved', () => {
    const connection = gatewayConnection({ models: [], modelAliases: { [GATEWAY_DEFAULT_CODER]: SERVED } })
    expect(resolveConnectionModelAlias(connection, GATEWAY_DEFAULT_CODER)).toBe(GATEWAY_DEFAULT_CODER)
  })
})

/**
 * P6.1080 — the SESSION half: the endpoint retired this connection's default,
 * and the user is told which model answers instead.
 *
 * ## Why this could not ride P6.362
 *
 * The two look like one case and are not, and the difference is a measurement
 * rather than a taste. The substitution happens in
 * `ModelRefreshService._doRefresh` at startup, before any session exists; it
 * rewrites `connection.defaultModel`; and `resolveModelForProvider` then CLEARS
 * the session's own stale model against the refreshed catalogue. So by the time
 * `warnIfModelIdUnrecognized` reads `resolvedModel` it is holding the NEW id,
 * which the catalogue serves, and P6.362 correctly says nothing — which is why
 * three gateway connections on the author's own rig moved off
 * `tgpt/qwen35-397b-a17b-fp8` between the 2026-09-03 and 2026-09-07 config
 * snapshots in total silence.
 *
 * It rides the same seam, deliberately: same call site, same
 * `sendEvent({ type: 'info', level: 'warning' })`, same unlocalised English. So
 * Pi, Claude and Codex all say it and none of them had to be taught to.
 */
const RETIRED = 'tgpt/qwen35-397b-a17b-fp8'
const ANSWERING = 'tgpt/deepseek-v4-flash-0731'

function substitutionHarness(connectionDefault: string | undefined) {
  const events: Event[] = []
  const manager = createTestSessionManager() as any
  manager.sendEvent = (event: Event) => { events.push(event) }
  manager.modelDefaultSubstitutionNotices = new Set<string>()
  const managed = { id: 'session-1', workspace: { id: 'workspace-1' } }
  const connection = { slug: 'nessy-gateway', defaultModel: connectionDefault } as LlmConnection
  return { manager, managed, connection, warnings: () => events.filter(e => e.level === 'warning') }
}

describe('P6.1080 the substituted default model is named', () => {
  afterEach(() => { forgetModelDefaultSubstitution('nessy-gateway') })

  test('names the retired id, the model answering, and how it was chosen', () => {
    recordModelDefaultSubstitution('nessy-gateway', RETIRED, ANSWERING, 'catalogue-default')
    const rig = substitutionHarness(ANSWERING)

    rig.manager.announceModelDefaultSubstitution(rig.managed, rig.connection)

    const [warning] = rig.warnings()
    expect(warning?.message).toContain(RETIRED)
    expect(warning?.message).toContain(ANSWERING)
    expect(warning?.message).toContain('`nessy-gateway`')
    // How it was chosen, because "a model answered" without "from the endpoint's
    // own catalogue" reads like the host picked one.
    expect(warning?.message).toContain('catalogue-default')
    // And what the user can do about it, which is the whole point of saying it.
    expect(warning?.message).toContain('Settings')
  })

  test('says it ONCE for the same session, connection and id pair', () => {
    recordModelDefaultSubstitution('nessy-gateway', RETIRED, ANSWERING, 'coder-alias')
    const rig = substitutionHarness(ANSWERING)

    rig.manager.announceModelDefaultSubstitution(rig.managed, rig.connection)
    rig.manager.announceModelDefaultSubstitution(rig.managed, rig.connection)
    rig.manager.announceModelDefaultSubstitution(rig.managed, rig.connection)

    expect(rig.warnings()).toHaveLength(1)
  })

  test('a connection with NO substitution on record says nothing — the negative arm', () => {
    const rig = substitutionHarness(ANSWERING)
    rig.manager.announceModelDefaultSubstitution(rig.managed, rig.connection)
    expect(rig.warnings()).toEqual([])

    // Nor does a session with no connection at all.
    const none = substitutionHarness(ANSWERING)
    none.manager.announceModelDefaultSubstitution(none.managed, null)
    expect(none.warnings()).toEqual([])
  })

  test('a record that no longer DESCRIBES the connection is forgotten, not announced', () => {
    // The user picked a model of their own after the substitution. That makes
    // the record history, and history is not a warning.
    recordModelDefaultSubstitution('nessy-gateway', RETIRED, ANSWERING, 'catalogue-default')
    const rig = substitutionHarness('tgpt/qwen36-35b-a3b-fp8')

    rig.manager.announceModelDefaultSubstitution(rig.managed, rig.connection)

    expect(rig.warnings()).toEqual([])
    // Dropped rather than merely skipped: a stale record must not come back to
    // life if the user later switches onto the substituted model deliberately.
    expect(peekModelDefaultSubstitution('nessy-gateway')).toBeUndefined()
  })
})

/**
 * C3.388 — THIS CHAT's own model was dropped by the catalogue test, and until
 * this row nothing said so.
 *
 * RV's PR-RV-3 on packaged 1.37.0: a session stored `tgpt/qwen35-397b-a17b-fp8`,
 * the runtime's own Pi session file recorded
 * `wireModels: ["tgpt/deepseek-v4-flash-0731"]`, the turn answered normally, and
 * the transcript carried ZERO info rows. The two notices above are both
 * structurally unable to see it — P6.1080 watches the CONNECTION's default and
 * P6.362 reads `resolvedModel`, which by then holds the id that IS served — so
 * the first case below is written as RV's own reading and the rest are the
 * narrowings that stop it crying wolf.
 */
describe('C3.388 the session\'s own substituted model is named', () => {
  function sessionRig(stored: string | undefined, running: string, models: unknown[] | undefined) {
    const events: Event[] = []
    const manager = createTestSessionManager() as any
    manager.sendEvent = (event: Event) => { events.push(event) }
    manager.sessionModelSubstitutionNotices = new Set<string>()
    const managed = { id: 'session-1', workspace: { id: 'workspace-1' }, ...(stored ? { model: stored } : {}) }
    const context = {
      connection: { slug: 'gateway', ...(models === undefined ? {} : { models }) },
      resolvedModel: running,
    }
    return {
      manager,
      managed,
      context,
      warnings: () => events.filter(e => e.level === 'warning'),
      // D1.127 — the WIRE fact beside the sentence, which the `level` filter
      // above cannot see: `session_model_changed` carries no level.
      modelSyncs: () => events.filter(e => e.type === 'session_model_changed'),
    }
  }

  const RETIRED = 'tgpt/qwen35-397b-a17b-fp8'
  const ANSWERING = 'tgpt/deepseek-v4-flash-0731'

  test('names the chat\'s own id and the model answering instead — RV\'s reading', () => {
    const rig = sessionRig(RETIRED, ANSWERING, [ANSWERING, 'tgpt/qwen36-35b-a3b-fp8'])

    rig.manager.warnIfSessionModelSubstituted(rig.managed, rig.context)

    const [warning] = rig.warnings()
    expect(warning?.message).toContain(RETIRED)
    expect(warning?.message).toContain(ANSWERING)
    expect(warning?.message).toContain('`gateway`')
    // "This chat", not "this connection" — the whole point of the fourth member
    // is that the connection's own default was never retired.
    expect(warning?.message).toContain('This chat is set to')
  })

  test('says it ONCE for the same session, connection and pair', () => {
    const rig = sessionRig(RETIRED, ANSWERING, [ANSWERING])
    rig.manager.warnIfSessionModelSubstituted(rig.managed, rig.context)
    rig.manager.warnIfSessionModelSubstituted(rig.managed, rig.context)
    rig.manager.warnIfSessionModelSubstituted(rig.managed, rig.context)
    expect(rig.warnings()).toHaveLength(1)
  })

  test('a chat running the model it is set to says nothing — the positive control', () => {
    const rig = sessionRig(ANSWERING, ANSWERING, [ANSWERING])
    rig.manager.warnIfSessionModelSubstituted(rig.managed, rig.context)
    expect(rig.warnings()).toEqual([])
  })

  test('a chat with no model of its own says nothing', () => {
    // The ordinary session. It runs the connection default BY DESIGN, and
    // calling that a substitution would put a warning on every new chat.
    const rig = sessionRig(undefined, ANSWERING, [ANSWERING])
    rig.manager.warnIfSessionModelSubstituted(rig.managed, rig.context)
    expect(rig.warnings()).toEqual([])
  })

  test('a catalogue that is empty or absent says nothing', () => {
    // P6.362's narrowing, for its reason: a warning derived from missing data is
    // the kind that trains people to ignore warnings.
    const empty = sessionRig(RETIRED, ANSWERING, [])
    empty.manager.warnIfSessionModelSubstituted(empty.managed, empty.context)
    expect(empty.warnings()).toEqual([])

    const absent = sessionRig(RETIRED, ANSWERING, undefined)
    absent.manager.warnIfSessionModelSubstituted(absent.managed, absent.context)
    expect(absent.warnings()).toEqual([])
  })

  test('a stored id the catalogue DOES list says nothing, whatever else differs', () => {
    // The predicate is the clearing condition itself: `resolveModelForProvider`
    // drops a stored id only when the catalogue does not list it. A difference
    // with the stored id still served is somebody else's substitution, and this
    // notice must not claim it.
    const rig = sessionRig(RETIRED, ANSWERING, [RETIRED, ANSWERING])
    rig.manager.warnIfSessionModelSubstituted(rig.managed, rig.context)
    expect(rig.warnings()).toEqual([])
  })

  /**
   * D1.127 — the row's OTHER half: the picker and the footer render
   * `session.model`, and the record still holds the retired id, so the sentence
   * C3.388 built was true while the UI went on naming a model the endpoint had
   * dropped.
   *
   * The wire fact is the event the renderer ALREADY handles for that field, so
   * the fix needs no renderer line; these three cases pin the two properties
   * that make it safe — it is sent whenever the condition holds (not once, so a
   * reopen inside this process is covered), and it is sent on NO other shape.
   */
  test('sends the running model on the wire, so the picker stops showing a retired id', () => {
    const rig = sessionRig(RETIRED, ANSWERING, [ANSWERING, 'tgpt/qwen36-35b-a3b-fp8'])
    rig.manager.warnIfSessionModelSubstituted(rig.managed, rig.context)
    expect(rig.modelSyncs()).toEqual([
      { type: 'session_model_changed', sessionId: 'session-1', model: ANSWERING },
    ])
    // ...and the RECORD is untouched: the predicate can be met by a catalogue
    // that is momentarily partial, and a persisted overwrite of a model the user
    // chose is not recoverable.
    expect(rig.managed.model).toBe(RETIRED)
  })

  test('the sentence is once and the state sync is every time — they are not the same rule', () => {
    const rig = sessionRig(RETIRED, ANSWERING, [ANSWERING])
    rig.manager.warnIfSessionModelSubstituted(rig.managed, rig.context)
    rig.manager.warnIfSessionModelSubstituted(rig.managed, rig.context)
    rig.manager.warnIfSessionModelSubstituted(rig.managed, rig.context)
    expect(rig.warnings()).toHaveLength(1)
    expect(rig.modelSyncs()).toHaveLength(3)
  })

  test('sends NOTHING on the shapes that say nothing — the negative for the wire half', () => {
    // The ordinary session, the matching session and the empty catalogue: if any
    // of these synced, every chat in the product would be told its model changed.
    for (const rig of [
      sessionRig(ANSWERING, ANSWERING, [ANSWERING]),
      sessionRig(undefined, ANSWERING, [ANSWERING]),
      sessionRig(RETIRED, ANSWERING, []),
      sessionRig(RETIRED, ANSWERING, [RETIRED, ANSWERING]),
    ]) {
      rig.manager.warnIfSessionModelSubstituted(rig.managed, rig.context)
      expect(rig.modelSyncs()).toEqual([])
    }
  })

  test('a running id the catalogue does NOT list is left to P6.362', () => {
    // The other half of the same rule, and the arm that keeps the two notices
    // from both firing: an unserved `resolvedModel` is exactly what
    // `warnIfModelIdUnrecognized` exists to report.
    const rig = sessionRig(RETIRED, 'tgpt/never-heard-of-it', [ANSWERING])
    rig.manager.warnIfSessionModelSubstituted(rig.managed, rig.context)
    expect(rig.warnings()).toEqual([])
  })
})
