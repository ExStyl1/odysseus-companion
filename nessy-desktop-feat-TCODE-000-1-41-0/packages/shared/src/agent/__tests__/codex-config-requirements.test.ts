/**
 * P2.7 — the codex half: `configRequirements/read` after `initialize`.
 *
 * Driven against a FAKE app-server rather than a spawned binary, because the
 * three cases that matter are the three a real binary will not reproduce on
 * demand: a deployment that carries `[features] in_app_updates = false`, an
 * app-server old enough not to know the method at all, and a call that fails
 * mid-transport. The shipped binary's side of the contract — that the method and
 * the feature key exist in it — is measured in the module's own header with a
 * positive and a negative control, which is a different question from this one.
 *
 * The invariant every case shares: the probe NEVER throws. A runtime that cannot
 * answer an optional question must still start a session.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, test } from 'bun:test'
import {
  CODEX_CONFIG_REQUIREMENTS_METHOD,
  CODEX_CONFIG_REQUIREMENTS_TIMEOUT_MS,
  CODEX_EXPERIMENTAL_REQUIREMENT_GATES,
  CODEX_EXPERIMENTAL_REQUIREMENT_GATE_PREFIX,
  CODEX_HOST_FACING_FEATURE_KEYS,
  CODEX_IN_APP_BROWSER_FEATURE_KEY,
  CODEX_REQUIREMENT_APPLICATION_DESTINATIONS_PREFIX,
  CODEX_REQUIREMENT_ENFORCEMENT,
  CODEX_REQUIREMENT_UNAPPLIED_PREFIXES,
  CODEX_REQUIREMENT_UNREPORTABLE_PREFIX,
  CODEX_UNREPORTED_REQUIREMENT_FAMILIES,
  classifyCodexRequirementField,
  formatCodexConfigRequirementsDiagnostics,
  formatCodexUnreportableRequirementFamilies,
  isDefinitiveAppServerRefusal,
  probeCodexConfigRequirements,
  readCodexConfigRequirements,
  type CodexRequestChannel,
} from '../codex-config-requirements.ts'

/** A codex app-server that answers `configRequirements/read` with `result`. */
function server(result: unknown): CodexRequestChannel & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async request(method: string): Promise<unknown> {
      calls.push(method)
      return result
    },
  }
}

/** A codex app-server that refuses, the way `AppServerClient` surfaces one. */
function refusingServer(message: string, code?: number): CodexRequestChannel {
  return {
    async request(): Promise<unknown> {
      const error = new Error(message) as Error & { code?: number }
      if (typeof code === 'number') error.code = code
      throw error
    },
  }
}

describe('a deployment that forbids in-app updates', () => {
  test('reads in_app_updates=false as the disable, and says so', async () => {
    const lines: string[] = []
    const app = server({ requirements: { featureRequirements: { in_app_updates: false } } })
    const reading = await probeCodexConfigRequirements(app, { onDiagnostic: line => lines.push(line) })

    expect(app.calls).toEqual([CODEX_CONFIG_REQUIREMENTS_METHOD])
    expect(reading.status).toBe('read')
    expect(reading.inAppUpdatesDisabled).toBe(true)
    expect(reading.honoured).toEqual(['featureRequirements.in_app_updates'])
    expect(lines.some(line => line.includes('in-app updates disabled'))).toBe(true)
  })

  test('in_app_updates=true is NOT a disable, and a malformed value decides nothing', async () => {
    for (const value of [true, 'false', 0, null]) {
      const reading = readCodexConfigRequirements({
        requirements: { featureRequirements: { in_app_updates: value } },
      })
      expect({ value, disabled: reading.inAppUpdatesDisabled })
        .toEqual({ value, disabled: undefined })
    }
  })
})

describe('protocol drift degrades, it never throws', () => {
  test('an app-server that does not know the method is UNSUPPORTED, not a failure', async () => {
    const lines: string[] = []
    const reading = await probeCodexConfigRequirements(
      refusingServer('unknown variant `configRequirements/read`', -32601),
      { onDiagnostic: line => lines.push(line) },
    )
    expect(reading.status).toBe('unsupported')
    expect(reading.inAppUpdatesDisabled).toBeUndefined()
    expect(lines).toEqual([
      '[managed] codex configRequirements/read was refused permanently by this app-server, '
      + 'so it is not asked again this session: unknown variant `configRequirements/read`',
    ])
  })

  test('-32600 is what the SHIPPED binary answers an unknown method with', async () => {
    // MEASURED 2026-08-27 against
    // `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`, and
    // re-driven 2026-09-11 on the `0.150.1` binary the lift installed, which
    // answers byte-identically:
    //   {"error":{"code":-32600,"message":"Invalid request: unknown variant
    //    `nessyNonexistentMethod/read`, expected one of `initialize`, ..."}}
    // P2.7 recorded the pair -32601/-32602 and the module asserted it, so on the
    // binary this product actually ships the `unsupported` branch was DEAD and a
    // drifted app-server read as a transient blip — the one confusion the code
    // was carried to prevent. Both branches leave the managed tier standing
    // (P2.137), so this changes which sentence is true, not what is enforced.
    //
    // P2.243 · the verdict is UNCHANGED and its REASON moved: the serde token in
    // the message carries it now, not the code. That matters because the next
    // two cases exist.
    const lines: string[] = []
    const reading = await probeCodexConfigRequirements(
      refusingServer('Invalid request: unknown variant `configRequirements/read`', -32600),
      { onDiagnostic: line => lines.push(line) },
    )
    expect(reading.status).toBe('unsupported')
    expect(lines[0]).toContain('was refused permanently by this app-server')
  })

  /**
   * P2.243 — `-32600` IS THE SERVER'S CATCH-ALL, so it cannot decide this alone.
   *
   * Measured over six conditions on the shipped binary, on the tag shipped then
   * and re-confirmed for the unknown-method arm at `rust-v0.150.1`:
   * an unknown method, params on a unit method, a wrong field type, a missing
   * required field AND a bad thread id all return `-32600`. A rule that reads
   * that code as "the method is not here" therefore states a false fact about
   * four of the six. The sibling classifier in `codex-agent.ts` had already
   * reached the message-based rule for the same binary; the two now share one
   * function.
   *
   * KILLS: putting `-32600` back into `DEFINITIVE_REFUSAL_CODES`, which makes
   * the first case below report `unsupported` for a busy server.
   */
  test('-32600 WITHOUT a serde token is transient, not a missing method', async () => {
    for (const message of ['Invalid request: thread not found', 'Invalid request: invalid cursor']) {
      const lines: string[] = []
      const reading = await probeCodexConfigRequirements(
        refusingServer(message, -32600),
        { onDiagnostic: line => lines.push(line) },
      )
      expect({ message, status: reading.status }).toEqual({ message, status: 'failed' })
      expect(lines[0]).toContain('failed, continuing unmanaged')
    }
  })

  test('a serde PARAM failure is permanent too, and says so without claiming the method is absent', async () => {
    const lines: string[] = []
    const reading = await probeCodexConfigRequirements(
      refusingServer('Invalid request: unknown field `nessyExtra`, expected one of ...', -32600),
      { onDiagnostic: line => lines.push(line) },
    )
    expect(reading.status).toBe('unsupported')
    expect(lines[0]).toContain('was refused permanently by this app-server')
    // The server's own words are quoted, which is what separates a param drift
    // from an absent method for whoever reads the line.
    expect(lines[0]).toContain('unknown field `nessyExtra`')
  })

  test('codex-agent.ts carries NO second rule — the reconciliation itself', () => {
    // The mutation this kills, found by the re-break harness rather than by
    // review: restore `isDefinitiveBackgroundTerminalsRefusal`'s own copy of the
    // rule (the `-32601 || -32602` code test plus its serde regex) and every
    // behavioural test still passes, because the two classifiers agree on every
    // input those tests use. What must not come back is the DUPLICATION — one
    // binary needed two rules only because one was written from the
    // specification and the other from the binary.
    //
    // A source assertion because the sibling is module-private and its call site
    // needs a live app-server; same instrument and same reason as the guard pin
    // further down this file.
    const agentSource = readFileSync(
      fileURLToPath(new URL('../codex-agent.ts', import.meta.url)),
      'utf8',
    )
    const start = agentSource.indexOf('function isDefinitiveBackgroundTerminalsRefusal(error: unknown): boolean {')
    expect(start).toBeGreaterThan(-1)
    const body = agentSource.slice(start, agentSource.indexOf('\n}', start))
    expect(body).toContain('return isDefinitiveAppServerRefusal(error);')
    // COMMENT LINES STRIPPED FIRST. The function's own docblock explains the
    // reconciliation and therefore names `-32601` — a pin that forbade what its
    // own explanation quotes could only ever fail, which is exactly how the
    // first draft of this assertion went red.
    const code = body.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
    // The two shapes of the rule this function used to hold itself.
    expect(code).not.toContain('-32601')
    expect(code).not.toContain('unknown variant')
  })

  test('the two classifiers are now ONE, and it is the shared one', async () => {
    // The reconciliation itself, pinned: `codex-agent.ts` no longer carries a
    // second rule, and this is the function both sides call.
    expect(isDefinitiveAppServerRefusal(Object.assign(new Error('unknown variant `x`'), { code: -32600 }))).toBe(true)
    expect(isDefinitiveAppServerRefusal(Object.assign(new Error('thread not found'), { code: -32600 }))).toBe(false)
    // Kept for a FUTURE binary that answers with real JSON-RPC codes.
    expect(isDefinitiveAppServerRefusal(Object.assign(new Error('anything at all'), { code: -32601 }))).toBe(true)
    expect(isDefinitiveAppServerRefusal(Object.assign(new Error('anything at all'), { code: -32602 }))).toBe(true)
    // A deadline rejection carries neither, and must never latch.
    expect(isDefinitiveAppServerRefusal(new Error('app-server request configRequirements/read timed out after 5000ms'))).toBe(false)
  })

  test('a code outside the definitive set is still transient', async () => {
    // -32603 (internal error) and -32000 (our own server-request failure frame)
    // are things that can pass; they must not be read as "the method is gone".
    for (const code of [-32603, -32000, 0]) {
      const reading = await probeCodexConfigRequirements(refusingServer('busy', code))
      expect({ code, status: reading.status }).toEqual({ code, status: 'failed' })
    }
  })

  test('a transport failure carries no code and is reported as transient', async () => {
    const lines: string[] = []
    const reading = await probeCodexConfigRequirements(
      refusingServer('app-server client closed'),
      { onDiagnostic: line => lines.push(line) },
    )
    expect(reading.status).toBe('failed')
    expect(lines).toEqual([
      '[managed] codex configRequirements/read failed, continuing unmanaged: app-server client closed',
    ])
  })

  test('a rejection with no diagnostic sink still resolves', async () => {
    // The spawn path passes a sink today; a future caller may not, and a probe
    // that throws only when nobody is listening is the worst possible shape.
    await expect(probeCodexConfigRequirements(refusingServer('boom'))).resolves.toBeDefined()
  })

  test('a result of any shape produces a reading', () => {
    for (const result of [undefined, null, 'nope', 42, [], { requirements: null }, {}]) {
      expect(readCodexConfigRequirements(result).status).toBe('none')
    }
  })
})

/**
 * P2.138 — the third way an app-server can fail to answer.
 *
 * P2.7 covered the two that SAY something: a refusal, and a transport error.
 * A server that simply IGNORES the method says nothing at all, and
 * `AppServerClient.request` had no third settlement — its pending entries reject
 * only on `close()`, which on this path is unreachable (`CodexAgent` does not
 * assign the client to `this.client` until after the probe returns). The spawn
 * would sit between `initialized` and `thread/start` with no status and no error.
 *
 * That is the WORSE failure, because this module's whole contract is to degrade
 * visibly, and a hang is the one outcome nothing surfaces.
 */
describe('a server that never answers still lets the runtime start', () => {
  /** A channel that accepts the request and is never heard from again. */
  const silent = (record?: { options?: unknown }): CodexRequestChannel => ({
    request(_method: string, _params?: unknown, options?: { timeoutMs?: number }): Promise<unknown> {
      if (record) record.options = options
      return new Promise(() => {})
    },
  })

  /**
   * The PRODUCTION channel, faithfully — P2.262.
   *
   * `AppServerClient.request` arms its own timer from `options.timeoutMs`,
   * rejects with exactly this message, deletes the pending entry, and
   * deliberately attaches NO `code` (`packages/codex-agent-server/src/`
   * `app-server-client.ts`, the `setTimeout` inside `request`; the comment
   * there says why the code is withheld). Mirror any change made there here.
   *
   * Why this double had to exist: every other double in this describe IGNORES
   * `timeoutMs`, so until now the only arm any test had ever watched settle was
   * `requestWithDeadline`'s own race timer. On a real channel that arm
   * never wins — both timers are set to the same `remainingMs` and
   * `client.request(...)` is evaluated first, so the client's timer is armed
   * first and rejects first. The helper is nonetheless correct, because the two
   * arms produce the same no-`code` rejection with the same message; but that
   * was a coincidence of symmetry no assertion held down, which is the whole of
   * this row. It is the identical blind spot P2.245 closed one layer up, where
   * the two arms did NOT agree and a dead sentinel shipped green.
   */
  const honouring = (record?: { options?: unknown; channelTimerFired?: boolean }): CodexRequestChannel => ({
    request(method: string, _params?: unknown, options?: { timeoutMs?: number }): Promise<unknown> {
      if (record) record.options = options
      const timeoutMs = options?.timeoutMs
      return new Promise((_resolve, reject) => {
        if (timeoutMs === undefined || !(timeoutMs > 0)) return
        setTimeout(() => {
          if (record) record.channelTimerFired = true
          reject(new Error(`app-server request ${method} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      })
    },
  })

  test('POSITIVE CONTROL: with the deadline disabled the probe never settles', async () => {
    let settled = false
    void probeCodexConfigRequirements(silent(), { timeoutMs: 0 }).then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 80))
    // This is the shipped behaviour before this row, and the reason every
    // assertion below is worth making.
    expect(settled).toBe(false)
  })

  test('the deadline turns the hang into the ordinary transient degradation', async () => {
    const lines: string[] = []
    const started = Date.now()
    const reading = await probeCodexConfigRequirements(silent(), {
      onDiagnostic: line => lines.push(line),
      timeoutMs: 25,
    })
    expect(Date.now() - started).toBeLessThan(2_000)
    // `failed`, not `unsupported`: a server that went quiet may well know the
    // method. `codex-agent.ts` leaves the managed in-app-updates tier standing
    // for both, so a hung probe cannot re-open an update channel either way.
    expect(reading.status).toBe('failed')
    expect(reading.inAppUpdatesDisabled).toBeUndefined()
    expect(lines).toEqual([
      '[managed] codex configRequirements/read failed, continuing unmanaged: '
      + 'app-server request configRequirements/read timed out after 25ms',
    ])
  })

  test('the bound holds even for a channel that ignores the option it was given', async () => {
    // The channel here is `silent`, which accepts `{ timeoutMs }` and does
    // nothing with it — exactly what a drifted or hand-rolled channel would do.
    // The probe holds its own deadline rather than trusting the callee, which is
    // why the race is not redundant with the client's own timer.
    const record: { options?: unknown } = {}
    const reading = await probeCodexConfigRequirements(silent(record), { timeoutMs: 25 })
    expect(reading.status).toBe('failed')
    // And it still PASSES the bound down, so a real `AppServerClient` can drop
    // its pending entry instead of leaking it until the session ends.
    expect(record.options).toEqual({ timeoutMs: 25 })
  })

  test('THE PRODUCTION PATH: a channel that HONOURS the bound degrades identically', async () => {
    // P2.262. The bound was only ever measured against channels that ignore it,
    // so the arm a real `AppServerClient` takes had never run in this file.
    const lines: string[] = []
    const record: { options?: unknown; channelTimerFired?: boolean } = {}
    const started = Date.now()
    const reading = await probeCodexConfigRequirements(honouring(record), {
      onDiagnostic: line => lines.push(line),
      timeoutMs: 25,
    })
    expect(Date.now() - started).toBeLessThan(2_000)
    // The double really did enforce the bound it was handed — without this the
    // test would pass on a channel that dropped the option, which is the state
    // this row exists to leave.
    expect(record.channelTimerFired).toBe(true)
    expect(record.options).toEqual({ timeoutMs: 25 })
    expect(reading.status).toBe('failed')
    expect(reading.inAppUpdatesDisabled).toBeUndefined()
    expect(lines).toEqual([
      '[managed] codex configRequirements/read failed, continuing unmanaged: '
      + 'app-server request configRequirements/read timed out after 25ms',
    ])
  })

  test('the two arms are INTERCHANGEABLE, and that is now asserted rather than assumed', async () => {
    // The row's precise finding: `requestWithDeadline` is correct because the
    // channel's rejection and the module's own are indistinguishable — same
    // message, no `code` on either, so both land on the transient side and the
    // managed tier stands either way. Nothing held that down. The moment the
    // two stop agreeing — a different message, a `code`, a partial result — the
    // caller's verdict starts depending on which timer won a race it cannot
    // observe, and this is the assertion that notices.
    const ignoredLines: string[] = []
    const honouredLines: string[] = []
    const ignored = await probeCodexConfigRequirements(silent(), {
      onDiagnostic: line => ignoredLines.push(line),
      timeoutMs: 25,
    })
    const honoured = await probeCodexConfigRequirements(honouring(), {
      onDiagnostic: line => honouredLines.push(line),
      timeoutMs: 25,
    })
    expect(honoured).toEqual(ignored)
    expect(honouredLines).toEqual(ignoredLines)
  })

  test('production takes the measured constant, and it is short', () => {
    // Measured resting state of this call on the shipped binary: 1-5 ms over ten
    // round-trips. A bound set near the floor manufactures its own failures; a
    // bound this far above it can only fire on a server that is not answering.
    expect(CODEX_CONFIG_REQUIREMENTS_TIMEOUT_MS).toBe(5_000)
    const source = readFileSync(fileURLToPath(new URL('../codex-config-requirements.ts', import.meta.url)), 'utf8')
    expect(source).toContain('options.timeoutMs ?? CODEX_CONFIG_REQUIREMENTS_TIMEOUT_MS')
  })

  test('an answer inside the bound is unaffected', async () => {
    const reading = await probeCodexConfigRequirements(server({ requirements: null }))
    expect(reading.status).toBe('none')
  })
})

describe('unsupported requirements are surfaced diagnostics, never silent drops', () => {
  test('every field the server SET that we do not apply is named', async () => {
    const lines: string[] = []
    const reading = await probeCodexConfigRequirements(server({
      requirements: {
        allowedSandboxModes: ['workspace-write'],
        allowedApprovalPolicies: null,
        checkForUpdateOnStartup: false,
        allowManagedHooksOnly: true,
        featureRequirements: { in_app_updates: false, browser_use: false },
        // Every field of this schema is `T | null`, and `null` is "not set".
        models: null,
        logDir: null,
      },
    }), { onDiagnostic: line => lines.push(line) })

    expect([...reading.unsupported]).toEqual([
      'allowManagedHooksOnly',
      'allowedSandboxModes',
      'checkForUpdateOnStartup',
      'featureRequirements.browser_use',
    ])
    // P6.6 — three of these are enforced by codex itself, so the honest line is
    // the codex one and there is NOTHING in the gap bucket. The old single line
    // said the opposite about every one of them.
    //
    // D1.204 · the fourth is not: `browser_use` is the sixth *"in desktop apps"*
    // feature and its subject — the Browser Use agent integration — is
    // unreachable from a codex session here, the same absence
    // `ConfigRequirements.browserUse` is `'inapplicable'` for. It is asserted in
    // its own bucket below rather than merely removed from this one, or the
    // change could not tell a re-verdict from a dropped key.
    expect([...reading.codexEnforced]).toEqual([
      'allowManagedHooksOnly',
      'allowedSandboxModes',
      'checkForUpdateOnStartup',
    ])
    expect([...reading.inapplicable]).toEqual(['featureRequirements.browser_use'])
    expect(reading.notApplied).toEqual([])
    expect(reading.unrecognised).toEqual([])
    expect(lines.some(line => line.includes(
      'enforced by the codex app-server itself, so Nessy does not re-implement them: allowManagedHooksOnly',
    ))).toBe(true)
    expect(lines.some(line => line.includes('ENFORCED BY NOBODY'))).toBe(false)
    // The narrower update switch is REPORTED and not folded into the
    // all-or-nothing gate: it forbids the startup check, not every check.
    expect(reading.inAppUpdatesDisabled).toBe(true)
  })

  /**
   * P6.247 CORRECTED THIS TEST'S NAME, not just its assertion. A document whose
   * wire fields are all `null` does NOT mean "sets nothing": `read_requirements`
   * answers `None` for an empty document, so an object arriving at all means
   * `ConfigRequirementsToml::is_empty` was false — and ten of the keys that
   * check covers never cross this wire. The buckets are still empty and that is
   * still correct; what changed is that the formatter no longer answers with
   * silence, which an administrator reads as compliance.
   */
  test('a document whose wire fields are all null still names the wire ceiling', () => {
    const reading = readCodexConfigRequirements({
      requirements: { allowedSandboxModes: null, featureRequirements: null },
    })
    expect(reading.status).toBe('read')
    expect(reading.unsupported).toEqual([])
    expect(reading.honoured).toEqual([])
    expect(reading.codexEnforced).toEqual([])
    expect(reading.notApplied).toEqual([])
    expect(reading.unrecognised).toEqual([])
    expect(formatCodexConfigRequirementsDiagnostics(reading))
      .toEqual([formatCodexUnreportableRequirementFamilies()])
  })

  test('no requirements at all says so once', () => {
    expect(formatCodexConfigRequirementsDiagnostics(readCodexConfigRequirements({ requirements: null })))
      .toEqual(['[managed] codex reports no config requirements'])
  })
})

/**
 * The spawn WIRING, pinned by source match.
 *
 * `createRuntime` spawns a real app-server, verifies a binary manifest and binds
 * an adapter port, so it is not drivable from a unit test — and the fact that
 * matters here is an ORDER: the probe has to run after `initialize` (the method
 * is only answerable once the connection is initialized) and before the runtime
 * is published, so a policy the server carries is in force for the first turn
 * rather than the second.
 */
describe('the codex spawn reads requirements after initialize', () => {
  const source = readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8')

  /**
   * P6.620 — EVERY anchor in this block is resolved inside a NAMED FUNCTION, and
   * none of them is a syntax token.
   *
   * Two ways this instrument has already broken, both on a file the committing
   * lane had every right to touch:
   *
   * 1. `at('} else {')` searched a 250 000-character file from byte zero and
   *    answered with the FIRST such string anywhere — nowhere near the guard the
   *    assertion is about. One unrelated `else` arm turned it red and it stayed
   *    red across two lanes (2026-09-06, diagnosed by W7-m2). W7-u bounded the
   *    search; a bound on a SYNTAX TOKEN is still a bet on the shape of code
   *    somebody else owns, so the token is gone entirely — the guard's `else`
   *    arm is now identified by the sentence only it contains.
   * 2. `at("await client.request('thread/start', {")` died when the call's
   *    params were extracted into a variable (measured at HEAD 2026-09-07: 2 of
   *    59 red, on a refactor that changed nothing this block is about). The
   *    needle now names the METHOD and stops before the arguments.
   *
   * The window is `createRuntime`, the method every assertion here is about, so
   * a same-named line anywhere else in the file cannot answer. The assertions
   * are still ORDER comparisons — that is what "runs after `initialize` and
   * before the thread opens" means — but the things being ordered are named
   * calls and unique sentences, never a brace.
   */
  const CREATE_RUNTIME = 'private async createRuntime(): Promise<void> {'
  const createRuntimeAt = source.indexOf(CREATE_RUNTIME)
  // Rig check: one method, one window. A second declaration would make every
  // offset below ambiguous, and a missing one would silently search from 0.
  expect(createRuntimeAt, 'codex-agent.ts no longer declares createRuntime()').toBeGreaterThanOrEqual(0)
  expect(source.indexOf(CREATE_RUNTIME, createRuntimeAt + 1), 'createRuntime() is declared twice').toBe(-1)

  const at = (needle: string): number => {
    const index = source.indexOf(needle, createRuntimeAt)
    expect(index, `missing source anchor inside createRuntime(): ${needle}`).toBeGreaterThanOrEqual(0)
    return index
  }

  /**
   * The `else` arm of the `requirementAnswered` guard, named by the only
   * sentence it contains rather than by the brace that opens it.
   *
   * `codex-agent.ts` is written to; a brace moves whenever anyone adds a nested
   * `if`. This sentence is a user-visible diagnostic that exists precisely
   * because a non-answer must say so, so it moves only when the behaviour this
   * block is about moves — which is exactly when the test should be re-read.
   */
  const GUARD_ELSE_ARM = 'are left as they were rather than cleared'

  it('probes between `initialized` and `thread/start`', () => {
    const initialized = at("client.notify('initialized')")
    const probe = at('await probeCodexConfigRequirements(this.recordManagedApprovalsReviewers(client), {')
    const threadStart = at("client.request('thread/start'")
    expect(initialized).toBeLessThan(probe)
    expect(probe).toBeLessThan(threadStart)
  })

  it('feeds the reading into the shared update-policy tier', () => {
    expect(source).toContain('recordCodexInAppUpdatesRequirement(requirements.inAppUpdatesDisabled)')
    expect(at('recordCodexInAppUpdatesRequirement(requirements.inAppUpdatesDisabled)'))
      .toBeGreaterThan(at('await probeCodexConfigRequirements(this.recordManagedApprovalsReviewers(client), {'))
  })

  /**
   * P2.137 — ONLY AN ANSWER MAY WRITE THE TIER.
   *
   * `recordCodex…(undefined)` CLEARS the codex tier, and
   * `requirements.inAppUpdatesDisabled` is `undefined` for `status:'failed'`
   * exactly as it is for `status:'none'`. Before this guard, a transport hiccup
   * was indistinguishable from "the server carries no requirement" and cleared a
   * previously-read disable — in a codex-only fleet, silently re-opening a
   * security-update channel an administrator had closed.
   *
   * KILLS: deleting the guard, or widening it to `!== 'failed'` (which would let
   * `unsupported` clear the tier — and `unsupported` on OUR artifact means the
   * shipped app-server refused the request PERMANENTLY: a downgraded or
   * substituted binary, or a request shape that no longer fits its structs.
   * P2.243 widened that sentence; it used to say "can only mean a downgraded or
   * substituted artifact", which stopped being true once the verdict covered a
   * param-shape drift. Either way it is the last thing to trust over a deployed
   * policy.)
   *
   * A SOURCE-SHAPE assertion for the same reason the two above are: the write
   * happens inside `spawnRuntime`, which needs a real app-server and an adapter
   * port. The BEHAVIOUR of the registrar it guards is pinned separately in
   * `config/__tests__/managed-in-app-updates.test.ts`, whose
   * `a non-boolean clears the tier rather than deciding something` case is
   * deliberately UNCHANGED — the registrar's contract was never the defect; this
   * caller passing "we do not know" into a parameter that means "there is no
   * requirement" was.
   */
  it('writes the tier only when the probe actually answered', () => {
    expect(source).toContain(
      "const requirementAnswered = requirements.status === 'read' || requirements.status === 'none'",
    )
    const guard = at('const requirementAnswered =')
    const write = at('recordCodexInAppUpdatesRequirement(requirements.inAppUpdatesDisabled)')
    expect(guard).toBeLessThan(write)
    expect(source).toContain('if (requirementAnswered) {')
    // A non-answer says so rather than silently doing nothing — and this is the
    // same sentence `GUARD_ELSE_ARM` uses to find the arm.
    expect(source).toContain(GUARD_ELSE_ARM)
  })

  /**
   * P2.463 — the browser tier's binding, and it is pinned INSIDE the guard.
   *
   * The same source-shape instrument as the three above, for the same reason:
   * the write happens in `spawnRuntime`, which needs a real app-server and an
   * adapter port. Two facts, and the second is the one worth a test — a call
   * placed after the `if` block instead of inside it compiles, passes a "the
   * call exists" assertion, and reintroduces P2.137's defect on a capability:
   * `inAppBrowserDisabled` is `undefined` for `status:'failed'` exactly as it is
   * for `status:'none'`, so an unguarded write lets one transport hiccup re-open
   * a browser an administrator closed.
   *
   * KILLS: deleting the call (the ARMED-AND-UNFED state P2.399 landed and P2.463
   * closed), and moving it outside the guard.
   */
  it('feeds the reading into the shared browser-policy tier, inside the answered guard', () => {
    const call = 'recordCodexInAppBrowserRequirement(requirements.inAppBrowserDisabled)'
    expect(source).toContain(call)
    expect(at(call)).toBeGreaterThan(at('await probeCodexConfigRequirements(this.recordManagedApprovalsReviewers(client), {'))
    // INSIDE the guard, not merely after it: the guard opens before the call and
    // the `else` arm — the only thing that can close the block — comes after it.
    const guardOpens = at('if (requirementAnswered) {')
    expect(guardOpens).toBeLessThan(at(call))
    // The `else` arm that CLOSES THIS guard, named by its own sentence rather
    // than by a brace. See `GUARD_ELSE_ARM`.
    expect(at(call)).toBeLessThan(at(GUARD_ELSE_ARM))
  })

  it('sends the probe diagnostics to the session debug channel', () => {
    expect(source).toContain('onDiagnostic: message => this.debug(message),')
  })

  /**
   * P6.484 — the APPLY, and where it has to sit.
   *
   * The same source-shape instrument as the four above, for the same reason:
   * `spawnRuntime` needs a real app-server and an adapter port. Everything that
   * DECIDES is driven for real in `codex-managed-new-thread-model.test.ts`;
   * what only this file can see is the ORDER, and the order is the whole
   * behaviour — an override resolved after `thread/start` has already opened the
   * thread would compile, pass every unit assertion, and change nothing about
   * the model the session actually runs on.
   *
   * KILLS: applying it after the thread opens; passing no `session` to the probe
   * (which would leave the diagnostics printing the pre-row guess while the
   * model was in fact overridden — the two disagreeing, which is worse than
   * either alone).
   */
  it('applies the administrator new-thread model before the thread opens, and tells the probe', () => {
    const probe = at('await probeCodexConfigRequirements(this.recordManagedApprovalsReviewers(client), {')
    const session = at('session: { model: this._model, modelChosenExplicitly: this.modelChosenExplicitly },')
    // `46ebbb952` turned this into a block when it added `managedServiceTier` beside the
    // `setModel` call, so the anchor stops at the condition — the form this file's own
    // header asks for (name the METHOD and stop before the arguments).
    const apply = at("if (newThreadVerdict.kind === 'applied') {")
    const threadStart = at("client.request('thread/start'")

    // The probe is told who chose the model, INSIDE its own options object.
    expect(session).toBeGreaterThan(probe)
    expect(session).toBeLessThan(apply)
    // And the override lands before the thread exists.
    expect(apply).toBeGreaterThan(probe)
    expect(apply).toBeLessThan(threadStart)
  })
})

/**
 * P6.6 — the classification, and the two directions it can rot in.
 *
 * The verdicts themselves are evidence, not code: each one is cited to a file
 * and a SYMBOL of `github.com/openai/codex` at `rust-v0.150.1` in the table's
 * own docblock — symbols rather than lines, because the lines moved under the
 * 2026-09-11 lift and the symbols did not. What a test CAN pin is that the table stays TOTAL over the wire
 * type, that the three buckets partition, and that the gap bucket is not empty
 * by construction — a classifier that answered `'codex'` for everything would
 * satisfy a partition test and quietly restore the defect.
 */
const GENERATED_WIRE_TYPE = fileURLToPath(new URL(
  '../../../../codex-protocol/generated/v2/ConfigRequirements.ts',
  import.meta.url,
))

/**
 * The field names of the generated `ConfigRequirements` type alias.
 *
 * Doc comments are stripped first: at `rust-v0.156.1` (F1.255) ts-rs began
 * emitting a `/** … *\/` block before three of the fields, and a field preceded
 * by a comment rather than by `{` or `,` was invisible to the matcher — it read
 * 26 of 29, which is the one way this rig check can fail open.
 */
function generatedWireFields(): string[] {
  const source = readFileSync(GENERATED_WIRE_TYPE, 'utf8')
  const body = /export type ConfigRequirements = \{(.*)\};/s.exec(source)?.[1]
  expect(body, 'the generated type alias moved or was reshaped').toBeTruthy()
  const bare = (body ?? '').replace(/\/\*[\s\S]*?\*\//g, '')
  return [...bare.matchAll(/(?:^|,)\s*([A-Za-z][A-Za-z0-9]*)\s*:/g)].map(match => match[1]!)
}

describe('P6.6 — every requirement has a verdict, and the verdicts partition', () => {
  /**
   * TOTALITY. A field added to the generated bindings by a codex bump lands in
   * `unrecognised` at runtime — honest, but a gap nobody is told to close. This
   * is the telling.
   *
   * `featureRequirements` is excluded because it is a MAP: its verdict is
   * per-key and lives in `classifyCodexRequirementField`, pinned separately
   * below.
   */
  it('covers every field of the generated wire type', () => {
    const fields = generatedWireFields()
    // Rig check: the extractor found the whole alias, not a fragment of it.
    // 22 until the 2026-09-11 lift to `rust-v0.150.1`, which added five; 27 until
    // `rust-v0.156.1` (F1.255, 2026-09-24), which added three and removed one.
    expect(fields.length).toBe(29)
    expect(fields).toContain('featureRequirements')
    for (const field of fields) {
      if (field === 'featureRequirements') continue
      expect(CODEX_REQUIREMENT_ENFORCEMENT[field], `no verdict for ${field}`).toBeDefined()
    }
  })

  /**
   * The FOUR EXPERIMENTAL fields the generated bindings omit. `CodexAgent`
   * sends `experimentalApi: true`, so the shipped app-server can put them on the
   * wire, and without these entries all four would be reported as fields this
   * build has never heard of.
   *
   * `application` joined at `rust-v0.154.0` and is the one whose verdict is NOT
   * `'codex'` — pinned individually below for that reason.
   */
  it('also covers the four experimental fields ts-rs leaves out of the bindings', () => {
    expect(generatedWireFields()).not.toContain('hooks')
    expect(generatedWireFields()).not.toContain('application')
    expect(CODEX_REQUIREMENT_ENFORCEMENT.allowedApprovalsReviewers).toBe('codex')
    expect(CODEX_REQUIREMENT_ENFORCEMENT.hooks).toBe('codex')
    expect(CODEX_REQUIREMENT_ENFORCEMENT.network).toBe('codex')
    expect(CODEX_REQUIREMENT_ENFORCEMENT.application).toBe('client')
  })

  /**
   * KILLS: a table that answers `'codex'` for everything. Native-first is an
   * answer to be REACHED, not assumed, and the fields codex parses, composes,
   * prints and publishes without ever acting on are the residue that makes the
   * rest of the table meaningful.
   *
   * P3.239 narrowed the residue from four names to one; `rust-v0.154.0` took it
   * back to two, and the SECOND is not a widening of the first. Both are fields
   * this build could apply and does not:
   *
   *  - `models` — codex's own client applies it
   *    (`tui/src/managed_new_thread_defaults.rs`), and we are the same kind of
   *    client holding the same answer.
   *  - `application` — an administrator's egress allowlist for the APPLICATION,
   *    which codex states is *"independent of agent network permissions"*
   *    (`codex-rs/config/src/application_requirements.rs`,
   *    `ApplicationRequirementsToml`) and which the only two files naming it in
   *    codex's tree parse, validate and PUBLISH without ever enforcing.
   *
   * This case stays a whole-list equality rather than a membership check, so a
   * future edit that quietly widens `'client'` over a capability we do not have
   * still fails here — which is what it was built for. When it reddens, ask
   * whether the new name names something absent (then it is `'inapplicable'`)
   * or something present we decline to apply (then it belongs here, with its
   * reason recorded beside the field).
   */
  it('names the fields nobody enforces that this build could have applied', () => {
    const clientOwned = Object.entries(CODEX_REQUIREMENT_ENFORCEMENT)
      .filter(([, verdict]) => verdict === 'client')
      .map(([field]) => field)
      .sort()
    expect(clientOwned).toEqual(['application', 'models'])
  })

  /**
   * The five whose subject this build does not have, and the reason they are not
   * one fact with the `'client'` bucket.
   *
   * Each governs a capability that is absent HERE, measured field by field
   * (module docblock, P3.239 table, plus the per-field table on
   * `CODEX_REQUIREMENT_ENFORCEMENT` for the two the lift added):
   * `allowAppshots` has no subject anywhere in the codex we ship, `computerUse`
   * governs a capability this product does not have at all, `browserUse` governs
   * one deliberately unreachable from a codex session (P6.27),
   * `allowBrowserAndComputerUse` is the GATE over those same two absent
   * capabilities, and `inAppBrowser` governs CODEX's own in-app browser rather
   * than the desktop host's pane — the name collision that makes it worth
   * reading twice, since the host's pane really is enforced, by the
   * `featureRequirements.in_app_browser` path and not by this field.
   *
   * Pinned as a set so that a name cannot be quietly parked here to make the gap
   * bucket look empty.
   */
  it('parks the five whose subject this build does not have in their own verdict', () => {
    const inapplicable = Object.entries(CODEX_REQUIREMENT_ENFORCEMENT)
      .filter(([, verdict]) => verdict === 'inapplicable')
      .map(([field]) => field)
      .sort()
    expect(inapplicable).toEqual([
      'allowAppshots',
      'allowBrowserAndComputerUse',
      'browserUse',
      'computerUse',
      'inAppBrowser',
    ])
  })

  /**
   * The three the lift added that codex DOES apply, each with the source that
   * says so. A verdict of `'codex'` is the cheap answer and the one most likely
   * to be reached by assumption, so these three are pinned individually rather
   * than left to the totality case above.
   */
  it("records the three new fields codex's own config layer applies", () => {
    expect(CODEX_REQUIREMENT_ENFORCEMENT.cliAuthCredentialsStore).toBe('codex')
    expect(CODEX_REQUIREMENT_ENFORCEMENT.chatgptBaseUrl).toBe('codex')
    expect(CODEX_REQUIREMENT_ENFORCEMENT.additionalDeveloperInstructions).toBe('codex')
  })

  /**
   * F1.255 — the `rust-v0.156.1` arrivals, each read at the tag (the table on
   * `CODEX_REQUIREMENT_ENFORCEMENT` carries the file and the reason). All three
   * are `'codex'`, which is the verdict most likely to be reached by assumption,
   * so each is pinned by name; and the field codex RETIRED at the same tag
   * (`windowsSandboxPrivateDesktop`, gone from the struct, its config key now
   * warned as ignored) must not keep a verdict for a field the wire cannot carry.
   */
  it('records the rust-v0.156.1 arrivals by name, and drops the field that left', () => {
    const fields = generatedWireFields()
    for (const field of ['modelProvider', 'modelProviders', 'allowedLoginMethods']) {
      expect(fields, `${field} is not in the generated bindings`).toContain(field)
      expect(CODEX_REQUIREMENT_ENFORCEMENT[field], field).toBe('codex')
    }
    expect(fields).not.toContain('windowsSandboxPrivateDesktop')
    expect(CODEX_REQUIREMENT_ENFORCEMENT.windowsSandboxPrivateDesktop).toBeUndefined()
    // CONTROL: a field that did not move keeps its verdict on the same read.
    expect(CODEX_REQUIREMENT_ENFORCEMENT.allowedWindowsSandboxImplementations).toBe('codex')
  })

  it('resolves the open-ended [features] table per key', () => {
    expect(classifyCodexRequirementField('featureRequirements.in_app_updates')).toBe('nessy')
    // D1.204 · the sixth host-facing key; `js_repl` below is the positive
    // control that the `'codex'` default still answers for a real codex feature.
    expect(classifyCodexRequirementField('featureRequirements.browser_use')).toBe('inapplicable')
    expect(classifyCodexRequirementField('featureRequirements.js_repl')).toBe('codex')
    expect(classifyCodexRequirementField('nessyInventedField')).toBeUndefined()
  })

  /**
   * The partition, driven through the real parser. One assertion per bucket:
   * `not.toEqual(expect.arrayContaining([a, b]))` passes when EITHER is absent,
   * and a "the buckets are disjoint" assertion written that way proves nothing.
   */
  it('splits one reported set into four disjoint buckets', () => {
    const reading = readCodexConfigRequirements({
      requirements: {
        // codex-enforced
        allowedApprovalPolicies: ['on-request'],
        logDir: 'file:///var/log/codex',
        // enforced by nobody, and this build could have applied it
        models: { newThread: { model: 'gpt-5' } },
        // enforced by nobody, and the capability is absent here
        allowAppshots: false,
        // this build has no verdict
        nessyUnknownRequirement: true,
        // applied by Nessy
        featureRequirements: { in_app_updates: false },
      },
    })

    expect([...reading.honoured]).toEqual(['featureRequirements.in_app_updates'])
    expect([...reading.codexEnforced]).toEqual(['allowedApprovalPolicies', 'logDir'])
    expect([...reading.notApplied]).toEqual(['models'])
    expect([...reading.inapplicable]).toEqual(['allowAppshots'])
    expect([...reading.unrecognised]).toEqual(['nessyUnknownRequirement'])
    // The union is the old field, unchanged in meaning: what Nessy does not do.
    expect([...reading.unsupported]).toEqual([
      'allowAppshots',
      'allowedApprovalPolicies',
      'logDir',
      'models',
      'nessyUnknownRequirement',
    ])
  })

  /** Each bucket gets its own sentence, and the gap sentence is unmistakable. */
  it('reports the buckets as separate lines', () => {
    const lines = formatCodexConfigRequirementsDiagnostics(readCodexConfigRequirements({
      requirements: {
        allowedApprovalPolicies: ['on-request'],
        models: { newThread: { model: 'gpt-5' } },
        allowAppshots: false,
        nessyUnknownRequirement: true,
      },
    }))
    expect(lines.some(line => line.includes(
      'enforced by the codex app-server itself, so Nessy does not re-implement them: allowedApprovalPolicies',
    ))).toBe(true)
    expect(lines.some(line => line.includes(
      'ENFORCED BY NOBODY — codex publishes these for its client to apply and this build does not: models',
    ))).toBe(true)
    expect(lines.some(line => line.includes(
      'govern capabilities this build does not have, so there is nothing to apply and nothing '
      + 'escapes: allowAppshots',
    ))).toBe(true)
    expect(lines.some(line => line.includes(
      'no verdict for (newer app-server than its enforcement table): nessyUnknownRequirement',
    ))).toBe(true)
    // NEGATIVE CONTROL: the sentence that said all of them were dropped is gone.
    expect(lines.some(line => line.includes('read but NOT applied'))).toBe(false)
    // NEGATIVE CONTROL for P3.239's own split: the gap sentence must not have
    // swept up the capability this build does not have.
    expect(lines.some(line => line.includes(
      'this build does not: allowAppshots',
    ))).toBe(false)
  })
})

/**
 * P3.239 — `models` is the one requirement in the gap bucket, and a field name
 * is not something an administrator can act on.
 *
 * The value is REPORTED and deliberately not applied: codex's own client calls
 * these "defaults rather than enforcement" and fills `config.model` only when
 * the invocation named none, while `BaseAgent` resolves a model for every codex
 * thread before this probe runs. Applying it here would move a session off the
 * model the picker shows — see the module docblock.
 */
describe('the managed new-thread defaults are named, with their values', () => {
  it('reports the required model, effort and tier', () => {
    const reading = readCodexConfigRequirements({
      requirements: {
        models: {
          newThread: { model: 'gpt-5-codex', modelReasoningEffort: 'high', serviceTier: 'priority' },
        },
      },
    })

    expect(reading.managedNewThreadDefaults).toEqual({
      model: 'gpt-5-codex',
      modelReasoningEffort: 'high',
      serviceTier: 'priority',
    })
    const lines = formatCodexConfigRequirementsDiagnostics(reading)
    expect(lines.some(line => line.includes(
      'requires new threads to start on model gpt-5-codex, reasoning effort high, service tier priority',
    ))).toBe(true)
    // The sentence has to say what the session actually did, or it is a name
    // with a value attached and still not actionable.
    expect(lines.some(line => line.includes('the requirement is NOT applied'))).toBe(true)
  })

  /**
   * A partial requirement is common — an administrator who pins only the model
   * — and the line must not print an empty clause for the other two.
   */
  it('names only the fields the administrator set', () => {
    const reading = readCodexConfigRequirements({
      requirements: { models: { newThread: { model: 'gpt-5-codex' } } },
    })
    expect(reading.managedNewThreadDefaults).toEqual({ model: 'gpt-5-codex' })
    const line = formatCodexConfigRequirementsDiagnostics(reading)
      .find(candidate => candidate.includes('requires new threads to start on'))
    expect(line).toContain('start on model gpt-5-codex — this build')
    expect(line).not.toContain('reasoning effort')
    expect(line).not.toContain('service tier')
  })

  /**
   * TOTALITY, on the spawn path: every wrong shape reads as "nothing was
   * required" and none of them throws. `models: {}` and an empty `newThread` are
   * the two the far side can genuinely send — `ModelsRequirementsToml::is_empty`
   * exists on the Rust side for exactly that state — and a line about a
   * requirement with no content is a line nobody can act on.
   */
  it.each([
    ['no models key', {}],
    ['models is a string', { models: 'gpt-5' }],
    ['models is empty', { models: {} }],
    ['newThread is null', { models: { newThread: null } }],
    ['newThread is empty', { models: { newThread: {} } }],
    ['the fields are not strings', { models: { newThread: { model: 7, serviceTier: true } } }],
    ['the model is an empty string', { models: { newThread: { model: '' } } }],
  ])('reports nothing for %s', (_label, requirements) => {
    const reading = readCodexConfigRequirements({ requirements })
    expect(reading.managedNewThreadDefaults).toBeUndefined()
    expect(formatCodexConfigRequirementsDiagnostics(reading)
      .some(line => line.includes('requires new threads to start on'))).toBe(false)
  })
})

/**
 * D1.168 — the `application` egress allowlist is DISCLOSED by value, and the
 * decision it discloses is that this build applies none of it.
 *
 * The shape is read at `rust-v0.154.0` from the tree itself: ts-rs drops the
 * `application` FIELD of `ConfigRequirements` but still emits
 * `generated/v2/ApplicationRequirements.ts` (`{ network: … | null }`),
 * `ApplicationNetworkRequirements.ts` (`{ enabled: boolean, domains }`) and
 * `NetworkDomainPermission.ts` (`"allow" | "deny"`). The field arrives on the
 * wire because `CodexAgent` sends `experimentalApi: true`.
 *
 * Every case here is about the same failure the `models` line was written to fix
 * one row earlier: a bare field name in a list is not something an administrator
 * can act on.
 */
describe('D1.168 — the managed application destinations are named, with their domains', () => {
  it('names the domains, the switch, and that NONE of them is applied', () => {
    const reading = readCodexConfigRequirements({
      requirements: {
        application: {
          network: {
            enabled: true,
            domains: { 'api.example.com': 'allow', 'telemetry.example.net': 'deny' },
          },
        },
      },
    })

    expect(reading.managedApplicationDestinations).toEqual({
      enabled: true,
      allowed: ['api.example.com'],
      denied: ['telemetry.example.net'],
    })

    const line = formatCodexConfigRequirementsDiagnostics(reading)
      .find(candidate => candidate.startsWith(CODEX_REQUIREMENT_APPLICATION_DESTINATIONS_PREFIX))
    expect(line).toBeDefined()
    expect(line).toContain('deny-unlisted ON')
    expect(line).toContain('allow 1: api.example.com')
    expect(line).toContain('deny 1: telemetry.example.net')
    // The three clauses the decision rests on, each of which a reader can get
    // wrong in a different direction.
    expect(line).toContain('applies NONE of them')
    expect(line).toContain('nothing here is refused on account of it')
    expect(line).toContain('SEPARATE from the agent\'s own network permissions')

    // The field keeps its `'client'` verdict and its bucket — the value is an
    // ADDITION to the gap report, not a replacement for it. Without this the
    // disclosure could pass while the field had quietly been re-verdicted.
    expect([...reading.notApplied]).toEqual(['application'])
    expect(reading.honoured).toEqual([])
    // And the line rides the operator queue rather than the debug channel, which
    // is what `CODEX_REQUIREMENT_UNAPPLIED_PREFIXES` decides.
    expect(CODEX_REQUIREMENT_UNAPPLIED_PREFIXES.some(prefix => line!.startsWith(prefix))).toBe(true)
  })

  /**
   * BOUNDARY. `enabled` absent is codex's own `true`
   * (`raw.enabled.unwrap_or(true)`), and a permission this build does not
   * recognise is DROPPED rather than filed under the other verdict — a domain in
   * the wrong column is worse in a report than a domain missing from it.
   */
  it('defaults the switch on, and drops a permission it does not recognise', () => {
    const reading = readCodexConfigRequirements({
      requirements: {
        application: {
          network: {
            domains: { 'a.example.com': 'allow', 'b.example.com': 'maybe', 'c.example.com': 7 },
          },
        },
      },
    })
    expect(reading.managedApplicationDestinations).toEqual({
      enabled: true,
      allowed: ['a.example.com'],
      denied: [],
    })
  })

  /** BOUNDARY — the cap shortens the line and the total keeps it honest. */
  it('caps the printed names at ten and counts the rest', () => {
    const domains: Record<string, string> = {}
    for (let index = 0; index < 14; index += 1) domains[`d${index + 10}.example.com`] = 'allow'
    const line = formatCodexConfigRequirementsDiagnostics(readCodexConfigRequirements({
      requirements: { application: { network: { enabled: true, domains } } },
    })).find(candidate => candidate.startsWith(CODEX_REQUIREMENT_APPLICATION_DESTINATIONS_PREFIX))

    expect(line).toContain('allow 14:')
    expect(line).toContain('+4 more')
    expect(line).toContain('d10.example.com')
    // The eleventh name, in sorted order, is the first one the cap drops.
    expect(line).not.toContain('d20.example.com')
  })

  /**
   * TOTALITY, on the spawn path, and the NEGATIVE the disclosure needs: every
   * wrong shape reads as "nothing was deployed" and none of them throws or
   * prints a line. `enabled: false` with no domains is the one an administrator
   * can really send — a switch turned off and nothing listed asks this build for
   * nothing, and a notice about it is the kind that teaches people to ignore
   * notices.
   */
  it.each([
    ['no application key', {}],
    ['application is a string', { application: 'deny' }],
    ['network is null', { application: { network: null } }],
    ['network is an array', { application: { network: [] } }],
    ['domains is an array', { application: { network: { enabled: false, domains: [] } } }],
    ['the policy is off and empty', { application: { network: { enabled: false } } }],
  ])('discloses nothing for %s', (_label, requirements) => {
    const reading = readCodexConfigRequirements({ requirements })
    expect(reading.managedApplicationDestinations).toBeUndefined()
    expect(formatCodexConfigRequirementsDiagnostics(reading)
      .some(line => line.startsWith(CODEX_REQUIREMENT_APPLICATION_DESTINATIONS_PREFIX))).toBe(false)
  })

  /**
   * The CONTROL for the case above: a policy that is off but LISTS domains is
   * still disclosed, because the failure an administrator is guarding against —
   * this app reaching somewhere they did not list — is unaffected by their
   * switch when nothing applies the switch either.
   */
  it('still discloses a policy that is switched off but lists domains', () => {
    const line = formatCodexConfigRequirementsDiagnostics(readCodexConfigRequirements({
      requirements: {
        application: { network: { enabled: false, domains: { 'a.example.com': 'deny' } } },
      },
    })).find(candidate => candidate.startsWith(CODEX_REQUIREMENT_APPLICATION_DESTINATIONS_PREFIX))
    expect(line).toContain('deny-unlisted off')
    expect(line).toContain('deny 1: a.example.com')
  })
})

/**
 * P2.373 → P2.399 → P2.463: one line this module has now got wrong in BOTH
 * directions, so both directions are pinned.
 *
 * `chatgpt-work-local-security` names `features.in_app_browser = false` as
 * *"Disable the desktop app's built-in browser"*. The history:
 *
 *  1. classified `'codex'`, which prints as *"enforced by the codex app-server
 *     itself, so Nessy does not re-implement them"* — a FALSE ASSURANCE about a
 *     control nothing enforced, which is strictly worse than saying nothing.
 *  2. P2.373 re-verdicted it `'client'` and printed the opposite out loud
 *     (*"treat the built-in browser as UNRESTRICTED on this deployment"*), which
 *     was honest and was not a gate.
 *  3. P2.399 built the gate (`config/managed-in-app-browser.ts` plus
 *     `apps/electron/src/main/browser-pane-manager.ts`) and left the codex INPUT
 *     tier unfed; P2.463 bound it from `codex-agent.ts`.
 *
 * So the verdict is `'nessy'` and the requirement is HONOURED. Every assertion
 * below carries the negative control for the sentence it replaced, because the
 * failure mode here is not a wrong bucket — it is a report an administrator
 * believes. Reported-as-enforced-by-codex and reported-as-enforced-by-nobody are
 * the same defect pointing opposite ways, and a gate whose report says
 * *ENFORCED BY NOBODY* is the second one.
 */
describe('P2.373/P2.463 — the built-in browser policy is reported as APPLIED, by us', () => {
  it('classifies the host-facing feature key as one this product applies', () => {
    expect(classifyCodexRequirementField(
      `featureRequirements.${CODEX_IN_APP_BROWSER_FEATURE_KEY}`,
    )).toBe('nessy')
    // POSITIVE CONTROL on the same rig: a key naming a real codex feature keeps
    // the `'codex'` default, so this is an exception and not a table flip.
    expect(classifyCodexRequirementField('featureRequirements.js_repl')).toBe('codex')
    // D1.204 · and this one is NOT the default any more — the same subject as
    // `ConfigRequirements.browserUse`, now in the same bucket as it.
    expect(classifyCodexRequirementField('featureRequirements.browser_use')).toBe('inapplicable')
    // The twin, unchanged since P2.7.
    expect(classifyCodexRequirementField('featureRequirements.in_app_updates')).toBe('nessy')
  })

  /**
   * The record that both BUILT host-facing controls are built, and that the
   * other three have the verdict their subject earns rather than the `'codex'`
   * default. `'client'` is this module's word for "only the client could apply
   * it and this build does not"; it stopped being true for the first two when
   * their gates landed, so a future edit that reverts either of THOSE to
   * `'client'` while the gate stands fails here, because the report and the
   * behaviour would then disagree.
   *
   * I2.24 · the family is SIX by codex's own doc (`grep -c 'desktop app'` over
   * `features/src/lib.rs` at `rust-v0.154.0`), five of them the consecutive
   * `InApp*` registry entries and the sixth `BrowserUse`. This asserts the whole
   * map rather than the additions, so a SEVENTH key appearing here has to be
   * argued for in the constant's docblock before this passes — and D1.204's
   * sixth was argued for there before it was added.
   */
  it('carries the six keys whose subject is the desktop host, each with its own verdict', () => {
    expect(CODEX_HOST_FACING_FEATURE_KEYS).toEqual({
      in_app_updates: 'nessy',
      in_app_browser: 'nessy',
      // Present subject, no gate — the honest gap, not a claim of enforcement.
      in_app_chat: 'client',
      // Absent subject: no dictation surface exists in this build to disable.
      in_app_dictation: 'inapplicable',
      // D1.205 · the reader exists now: the scheduler at the `AutomationSystem`
      // construction and the hook tiers beside `disableAllHooks`.
      in_app_local_automation: 'nessy',
      // D1.204 · absent subject: the Browser Use agent integration is
      // unreachable from a codex session (P6.27), which is why the field twin
      // `ConfigRequirements.browserUse` carries the same verdict.
      browser_use: 'inapplicable',
    })
  })

  /**
   * The three additions through the REAL classifier, which is what a report
   * actually calls — the map above could be right while the prefix resolver
   * never reached it. The NEGATIVE half is the same call on a key that is NOT
   * host-facing, which must still take the `'codex'` default: without it this
   * case passes against a resolver that answered `'client'` for everything.
   */
  it('resolves the three new host-facing keys through the [features] prefix, and nothing else', () => {
    expect(classifyCodexRequirementField('featureRequirements.in_app_chat')).toBe('client')
    expect(classifyCodexRequirementField('featureRequirements.in_app_dictation')).toBe('inapplicable')
    expect(classifyCodexRequirementField('featureRequirements.in_app_local_automation')).toBe('nessy')
    expect(classifyCodexRequirementField('featureRequirements.shell_snapshot_v2')).toBe('codex')
  })

  /**
   * D1.204's NEGATIVE, and the one assertion here that is easy to mistake for an
   * oversight. `browser_use`'s two siblings keep the `'codex'` default because
   * codex's own doc puts them OUTSIDE the six-key desktop-app denominator this
   * constant is derived from — read at `rust-v0.154.0`, `BrowserUseFullCdpAccess`
   * is *"access the full Chrome DevTools Protocol surface"* and
   * `BrowserUseExternal` is *"integration with external browsers"*, neither
   * carrying the *"in desktop apps"* line all six of the others do.
   *
   * Without this case the row's change is indistinguishable from "everything
   * whose name starts with browser is inapplicable", which is a rule nobody
   * chose and which the next lift would extend by accident.
   */
  it('leaves the two browser_use SIBLINGS on the codex default, by codex\'s own denominator', () => {
    expect(classifyCodexRequirementField('featureRequirements.browser_use')).toBe('inapplicable')
    expect(classifyCodexRequirementField('featureRequirements.browser_use_external')).toBe('codex')
    expect(classifyCodexRequirementField('featureRequirements.browser_use_full_cdp_access')).toBe('codex')
  })

  /**
   * The bucket, and the two wrong buckets it must not be in.
   *
   * `notApplied` is the pre-P2.463 answer. `unrecognised` is the trap the
   * re-verdict opens if the `[features]` loop does not skip the key: `'nessy'`
   * has no arm in the bucket switch, so an applied requirement would be reported
   * as one this build has never heard of.
   */
  it('routes it into the APPLIED bucket, and into neither wrong one', () => {
    const reading = readCodexConfigRequirements({
      requirements: {
        featureRequirements: { in_app_browser: false, js_repl: false },
      },
    })
    expect([...reading.honoured]).toEqual(['featureRequirements.in_app_browser'])
    expect([...reading.codexEnforced]).toEqual(['featureRequirements.js_repl'])
    expect([...reading.notApplied]).toEqual([])
    expect([...reading.unrecognised]).toEqual([])
    // `unsupported` is the union of what Nessy does NOT do, so an applied key is
    // absent from it too — that is the field the loop above decides.
    expect([...reading.unsupported]).toEqual(['featureRequirements.js_repl'])
    expect(reading.inAppBrowserDisabled).toBe(true)
  })

  /**
   * D1.205 — the SUCCESSOR of the anti-false-assurance pair, and it is replaced
   * rather than deleted on purpose.
   *
   * The retired case pinned the HONEST GAP: `in_app_local_automation` present,
   * not honoured, in `notApplied`, and the reading carrying no field for the
   * value — *"it goes RED the day someone flips the verdict to `'nessy'` without
   * building the reader"*. It fired exactly as designed on this commit, which
   * built the reader; keeping it beside the reader would pin the absence of the
   * thing that now exists.
   *
   * What the successor pins is the other direction, which is the one that can
   * now go wrong: the key is honoured, the value reaches
   * `localAutomationDisabled`, and the verdict is `'nessy'` because two gates
   * read it — `enableScheduler` at the `AutomationSystem` construction in
   * `SessionManager` and the clause beside `disableAllHooks` in
   * `capabilities/runtime-automations.ts`. If either gate is removed, this case
   * is the one that has to be edited, and editing it is the moment the verdict
   * must go back to `'client'`.
   *
   * The POSITIVE CONTROL is `js_repl` in the SAME reading — a key this build
   * does NOT apply, which must still land in `unsupported`, so the honoured
   * assertion cannot pass against a parser that honours everything.
   */
  it('honours in_app_local_automation and carries its value (D1.205)', () => {
    const reading = readCodexConfigRequirements({
      requirements: {
        featureRequirements: { in_app_local_automation: false, in_app_updates: false, js_repl: true },
      },
    })
    expect([...reading.honoured].sort())
      .toEqual(['featureRequirements.in_app_local_automation', 'featureRequirements.in_app_updates'])
    expect(reading.localAutomationDisabled).toBe(true)
    expect([...reading.notApplied]).toEqual([])
    // POSITIVE CONTROL on the same reading: a key this build does not apply
    // lands in `unsupported` AND in `codexEnforced` (it is codex's own), so the
    // honoured assertion above cannot pass against a parser that honours
    // everything, and the two-bucket shape is the control's own signature.
    expect([...reading.unsupported]).toEqual(['featureRequirements.js_repl'])
    expect([...reading.codexEnforced]).toEqual(['featureRequirements.js_repl'])
    // The two wrong buckets for OUR key: `'codex'` would be a false assurance
    // pointing one way, `unrecognised` the other — a requirement this build has
    // never heard of.
    expect([...reading.codexEnforced]).not.toContain('featureRequirements.in_app_local_automation')
    expect([...reading.unrecognised]).toEqual([])
  })

  /**
   * D1.205's BOUNDARY, and it is the half a positive-only case cannot see: only
   * a literal `false` disables. A malformed managed value — a string, a number,
   * `true` — must not stop a fleet's automations, which is the same rule the
   * in-app-updates twin states for a security-update channel.
   */
  it('only a literal false disables local automation (D1.205)', () => {
    for (const value of [true, 'false', 0, null]) {
      const reading = readCodexConfigRequirements({
        requirements: { featureRequirements: { in_app_local_automation: value } },
      })
      expect(reading.localAutomationDisabled).toBeUndefined()
    }
    // And the control on the loop: the presence of the key is still reported,
    // so "said nothing" is distinguishable from "was never asked".
    const present = readCodexConfigRequirements({
      requirements: { featureRequirements: { in_app_local_automation: true } },
    })
    expect([...present.honoured]).toEqual(['featureRequirements.in_app_local_automation'])
  })

  it('honours the twin and the browser together, without either displacing the other', () => {
    const reading = readCodexConfigRequirements({
      requirements: {
        featureRequirements: { in_app_browser: false, in_app_updates: false },
      },
    })
    expect([...reading.honoured].sort()).toEqual([
      'featureRequirements.in_app_browser',
      'featureRequirements.in_app_updates',
    ])
    expect([...reading.unsupported]).toEqual([])
    expect(reading.inAppBrowserDisabled).toBe(true)
    expect(reading.inAppUpdatesDisabled).toBe(true)
  })

  it('prints the enforced sentence with BOTH spellings, and neither historical claim', () => {
    const lines = formatCodexConfigRequirementsDiagnostics(readCodexConfigRequirements({
      requirements: { featureRequirements: { in_app_browser: false } },
    }))
    expect(lines.some(line => line.includes(
      'in_app_browser=false — the built-in browser is DISABLED and every entry point refuses by '
      + 'name; the host spelling of the same switch is disableInAppBrowser',
    ))).toBe(true)
    // NEGATIVE CONTROL 1 — the original false assurance.
    expect(lines.some(line => line.includes(
      'enforced by the codex app-server itself',
    ))).toBe(false)
    // NEGATIVE CONTROL 2 — P2.373's honest sentence, which the gate made false.
    expect(lines.some(line => line.includes('NO gate on its built-in browser'))).toBe(false)
    expect(lines.some(line => line.includes('UNRESTRICTED on this deployment'))).toBe(false)
    // NEGATIVE CONTROL 3 — the gap bucket must not name it either.
    expect(lines.some(line => line.includes('ENFORCED BY NOBODY'))).toBe(false)
  })

  /**
   * The reading rule is UNCHANGED by the binding, and that is the point: only a
   * literal `false` is the documented disable, because a malformed managed value
   * must not silently remove a shipped surface the user can see. What the binding
   * changed is the BUCKET — a present-but-not-disabling key is still a
   * requirement this product applies, so it is honoured rather than reported as
   * unapplied, exactly as `in_app_updates: true` has always been.
   */
  it.each([
    ['true', true],
    ['the string "false"', 'false'],
    ['zero', 0],
    ['null', null],
  ])('disables nothing when the value is %s, and still reports the key as applied', (_label, value) => {
    const reading = readCodexConfigRequirements({
      requirements: { featureRequirements: { in_app_browser: value } },
    })
    expect(reading.inAppBrowserDisabled).toBeUndefined()
    expect([...reading.honoured]).toEqual(['featureRequirements.in_app_browser'])
    expect([...reading.notApplied]).toEqual([])
    expect(formatCodexConfigRequirementsDiagnostics(reading)
      .some(line => line.includes('the built-in browser is DISABLED'))).toBe(false)
  })
})

/**
 * P6.77 — the FOUR `#[experimental]` fields ts-rs drops, and the instrument that
 * catches a fifth.
 *
 * The drop is upstream's and this build cannot undo it: regenerating the
 * bindings from the same tag reproduces it. So the row closes as a DISCLOSURE —
 * the absence recorded at the reader with the upstream attribute as its reason —
 * plus a pin that makes a future field audible instead of silent.
 *
 * **THE PIN HAS NOW BEEN COLLECTED ON, which is why this block says four.** It
 * was written about three fields and promised a fourth could not arrive
 * silently; `rust-v0.154.0` added `application`
 * (`#[experimental("configRequirements/read.application")]`), the prefix count in
 * the shipped binary went 3 -> 4, and both cases below reddened — while
 * `generated/v2/ConfigRequirements.ts` came back from the regeneration
 * BYTE-IDENTICAL, which is exactly the silence the pin exists to break. Its
 * verdict (`'client'`: codex parses, validates and PUBLISHES it and enforces
 * nothing) is recorded beside the field in `codex-config-requirements.ts`.
 *
 * The pin is possible only because of the attribute's shape. `#[experimental]`
 * has two forms in `app-server-protocol/src/protocol/v2/config.rs`
 * (`rust-v0.154.0`): `nested`, which is NOT dropped (the
 * `allowed_approval_policies` field of `struct ConfigRequirements` carries it
 * and is in the generated bindings), and a string naming the experimental gate,
 * which IS. That string is compiled into the shipped `codex-app-server`
 * verbatim, so the binary enumerates the dropped set for us.
 */
describe('P6.77 — the fields ts-rs drops are disclosed, and a fifth cannot be silent', () => {
  /**
   * TOTALITY, in the direction the existing generated-fields test cannot see.
   * `covers every field of the generated wire type` walks the bindings, which by
   * construction never mention these four. This walks the declared drops.
   */
  it('carries a verdict for every declared experimental gate, and adds no fifth of its own', () => {
    const declared = Object.keys(CODEX_EXPERIMENTAL_REQUIREMENT_GATES).sort()
    expect(declared).toEqual(['allowedApprovalsReviewers', 'application', 'hooks', 'network'])
    for (const field of declared) {
      // The generated bindings must NOT know them — that is the premise.
      expect(generatedWireFields(), `${field} is no longer dropped`).not.toContain(field)
      expect(CODEX_REQUIREMENT_ENFORCEMENT[field], `no verdict for dropped field ${field}`).toBeDefined()
    }
    // Every value is the shared prefix plus the field's own camelCase name, so
    // the map cannot drift from the attribute it transcribes.
    for (const [field, gate] of Object.entries(CODEX_EXPERIMENTAL_REQUIREMENT_GATES)) {
      expect(gate).toBe(`${CODEX_EXPERIMENTAL_REQUIREMENT_GATE_PREFIX}${field}`)
    }
    // And the enforcement table is exactly the bindings plus these three: a name
    // quietly deleted from either side fails here.
    const expected = [
      ...generatedWireFields().filter(field => field !== 'featureRequirements'),
      ...declared,
    ].sort()
    expect(Object.keys(CODEX_REQUIREMENT_ENFORCEMENT).sort()).toEqual(expected)
  })

  /**
   * D1.206 — the LIFT obligation, and it is deliberately not a detector.
   *
   * Re-read 2026-09-24 from `app-server-protocol/src/protocol/v2/config.rs` at
   * `rust-v0.156.1` (F1.255): `pub struct ConfigRequirements` declares **33**
   * fields, 29 of which reach the generated bindings and 4 of which carry a gate
   * string. The identity `33 = 29 + 4` (`31 = 27 + 4` at `rust-v0.154.0`) is what
   * both tripwires in this file rest on.
   *
   * What it CANNOT see, stated here because the assertion looks stronger than it
   * is: a field dropped from the bindings by any mechanism OTHER than the gate
   * string takes the struct to 32 and moves neither 27 nor 4, so this stays
   * green. It reddens when either KNOWN side moves — which is its whole job,
   * because that is what sends a lift lane to the paragraph in
   * `CODEX_EXPERIMENTAL_REQUIREMENT_GATES` that says to re-read the struct.
   */
  it('pins the struct arithmetic a lift must re-derive at the source', () => {
    const CODEX_REQUIREMENTS_STRUCT_FIELDS_AT_SHIPPED_TAG = 33
    const bindings = generatedWireFields().length
    const gates = Object.keys(CODEX_EXPERIMENTAL_REQUIREMENT_GATES).length
    expect(
      bindings + gates,
      'the bindings + declared gates no longer sum to `struct ConfigRequirements`\'s '
        + 'field count at the shipped tag — re-read '
        + 'app-server-protocol/src/protocol/v2/config.rs at the lifted tag and re-take '
        + 'all three numbers together (D1.206)',
    ).toBe(CODEX_REQUIREMENTS_STRUCT_FIELDS_AT_SHIPPED_TAG)
    // The two halves separately, so a compensating pair of moves cannot pass.
    expect(bindings).toBe(29)
    expect(gates).toBe(4)
  })

  /**
   * The binary probe. Skipped — VISIBLY, as a skip line rather than a silent
   * pass — when no `codex-app-server` is staged for this platform: the binaries
   * are gitignored (`apps/electron/.gitignore:14`), so a clean checkout has
   * none.
   *
   * Its own positive control is the per-gate assertion: if the extractor were
   * broken it would find zero of four, not four of four. The negative control
   * is a name that is not a field.
   *
   * IT FIRED, which is the only reason this docblock is being edited rather than
   * re-dated: `rust-v0.154.0` added `application`
   * (`#[experimental("configRequirements/read.application")]`, read from
   * `codex-rs/app-server-protocol/src/protocol/v2/config.rs` at the tag), the
   * prefix count went 3 -> 4, and this case went red while
   * `generated/v2/ConfigRequirements.ts` came back from the regeneration
   * BYTE-IDENTICAL — the exact silence it exists to break. Its promise is now
   * made about a fifth.
   */
  const stagedCodexBinary = findStagedCodexAppServer()
  it.skipIf(stagedCodexBinary === undefined)(
    'finds exactly the declared gate strings in the shipped app-server, and no fifth',
    () => {
      const path = stagedCodexBinary!
      const gates = Object.values(CODEX_EXPERIMENTAL_REQUIREMENT_GATES)
      const counts = countInBinary(path, [
        CODEX_EXPERIMENTAL_REQUIREMENT_GATE_PREFIX,
        ...gates,
        // Negative control: proves a hit is a hit and not the scan saying yes.
        `${CODEX_EXPERIMENTAL_REQUIREMENT_GATE_PREFIX}nessyNotAField`,
      ])
      for (const gate of gates) {
        expect(counts[gate], `${gate} missing from ${path}`).toBe(1)
      }
      expect(counts[`${CODEX_EXPERIMENTAL_REQUIREMENT_GATE_PREFIX}nessyNotAField`]).toBe(0)
      // THE PIN: a FIFTH `#[experimental("configRequirements/read.…")]` field
      // added upstream raises this to five while the generated bindings stay
      // silent about it. (Read as a live promise, not a hope: the same sentence
      // said "a fourth" and a fourth arrived at `rust-v0.154.0`.)
      expect(
        counts[CODEX_EXPERIMENTAL_REQUIREMENT_GATE_PREFIX],
        'the shipped app-server names more experimental requirement gates than '
          + 'CODEX_EXPERIMENTAL_REQUIREMENT_GATES declares — read config.rs at the shipped tag',
      ).toBe(gates.length)
    },
  )
})

/**
 * The staged `codex-app-server` for this platform, or `undefined`. Mirrors
 * `resolveCodexBinaryPath`'s dev layout without needing a host-runtime context.
 */
function findStagedCodexAppServer(): string | undefined {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch
  const exe = process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server'
  const candidate = fileURLToPath(new URL(
    `../../../../../apps/electron/resources/bin/codex/${process.platform}-${arch}/${exe}`,
    import.meta.url,
  ))
  return existsSync(candidate) ? candidate : undefined
}

/**
 * Occurrences of each needle in a file, read in chunks so a 178 MB binary does
 * not become a 178 MB allocation. `latin1` is byte-transparent, and the overlap
 * carries any needle straddling a chunk boundary; hits inside the carried tail
 * are counted once.
 */
function countInBinary(path: string, needles: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const needle of needles) counts[needle] = 0
  const overlap = Math.max(...needles.map(needle => needle.length)) + 8
  const chunkSize = 8 * 1024 * 1024
  const buffer = Buffer.allocUnsafe(chunkSize)
  const size = statSync(path).size
  const fd = openSync(path, 'r')
  try {
    let carry = ''
    let position = 0
    while (position < size) {
      const read = readSync(fd, buffer, 0, chunkSize, position)
      if (read <= 0) break
      const text = carry + buffer.toString('latin1', 0, read)
      for (const needle of needles) {
        let at = text.indexOf(needle)
        while (at !== -1) {
          // Already counted on the previous pass if it ended inside the carry.
          if (position === 0 || at + needle.length > carry.length) counts[needle]! += 1
          at = text.indexOf(needle, at + 1)
        }
      }
      carry = text.slice(-overlap)
      position += read
    }
  } finally {
    closeSync(fd)
  }
  return counts
}

/**
 * P6.247 — five families were named in the row; the source said TEN, at
 * `rust-v0.156.1` (F1.255) it said NINE: 42 `ConfigRequirementsToml` keys, 33
 * read by `map_requirements_to_api`, `allowed_login_methods` now among them; and
 * at `rust-v0.159.3` (F1.1215) it says TEN again: 43 keys, the new
 * `guardian_extra_policy` read by the mapper 0 times and covered by `is_empty`.
 *
 * Measured at `rust-v0.150.1`, which for codex outranks the page:
 * `ConfigRequirementsToml` (`codex-rs/config/src/config_requirements.rs`)
 * accepts 39 keys and `map_requirements_toml_to_api`
 * (`codex-rs/app-server/src/request_processors/config_processor.rs`) reads 29 of
 * them. Both numbers moved at the 2026-09-11 lift and the DIFFERENCE did not:
 * the ten it never reads are the same ten, re-derived key by key against the new
 * tag rather than carried, and each one is still consumed by codex itself
 * elsewhere in `config_requirements.rs` — so the ceiling is the REPORT, not the
 * enforcement. (A caution for whoever re-derives it next: the mapper writes
 * `requirements` and the field on separate lines, so a single-line
 * `requirements\.<field>` grep under-counts it by five and invents five
 * unreported families that are nothing of the kind.)
 *
 * WHAT EACH TEST KILLS:
 *  - "names every family" dies if a family is dropped from the constant, which
 *    is how a report starts under-stating what it cannot see;
 *  - "is disjoint from the wire type" dies the day upstream ADDS one of the ten
 *    to `ConfigRequirements` — at which point the sentence becomes a lie in the
 *    other direction and the family should move to the enforcement table;
 *  - "still reports a carried family by name" is the row's own control: the
 *    ceiling sentence must not replace or suppress the per-field verdicts;
 *  - "says nothing when the server reported no requirements" is the negative
 *    control that keeps the line honest — `is_empty` covers all ten, so a null
 *    `requirements` really does mean none was deployed.
 */
describe('P6.247 — the requirement families this wire cannot carry are named', () => {
  it('names every family, with its subject, in one line', () => {
    const line = formatCodexUnreportableRequirementFamilies()
    expect(line.startsWith(CODEX_REQUIREMENT_UNREPORTABLE_PREFIX)).toBe(true)
    // `allowed_login_methods` left this list at `rust-v0.156.1` (F1.255): the
    // mapper now puts it on the wire as `allowedLoginMethods`, which is exactly
    // what the disjointness case below exists to catch — and caught.
    expect(Object.keys(CODEX_UNREPORTED_REQUIREMENT_FAMILIES).sort()).toEqual([
      'allowed_chatgpt_workspaces',
      'apps',
      'guardian_extra_policy',
      'guardian_policy_config',
      'marketplaces',
      'mcp_servers',
      'permissions',
      'plugins',
      'remote_sandbox_config',
      'rules',
    ])
    for (const [key, subject] of Object.entries(CODEX_UNREPORTED_REQUIREMENT_FAMILIES)) {
      expect(line, `${key} is not named`).toContain(`${key} (${subject})`)
    }
    // The count in the sentence is DERIVED, so it cannot drift from the list.
    expect(line).toContain('10 whole requirement families')
    // NOT a "this build did not do it" line: nothing was asked of this build, so
    // it must not ride the durable operator queue with the three that were.
    expect(CODEX_REQUIREMENT_UNAPPLIED_PREFIXES.some(prefix => line.startsWith(prefix))).toBe(false)
  })

  it('is disjoint from the fields the generated wire type does carry', () => {
    const wire = generatedWireFields()
    // Rig check: the extractor read the alias, not a fragment — the same
    // control the totality test above uses.
    expect(wire).toContain('allowedSandboxModes')
    for (const key of Object.keys(CODEX_UNREPORTED_REQUIREMENT_FAMILIES)) {
      const camel = key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
      expect(wire, `${key} now crosses the wire as ${camel} — move it to the enforcement table`)
        .not.toContain(camel)
    }
  })

  it('still reports a carried family by name beside the ceiling', () => {
    const lines = formatCodexConfigRequirementsDiagnostics(readCodexConfigRequirements({
      requirements: { allowedSandboxModes: ['read-only'] },
    }))
    expect(lines.some(line => line.includes(
      'enforced by the codex app-server itself, so Nessy does not re-implement them: '
      + 'allowedSandboxModes',
    ))).toBe(true)
    expect(lines.at(-1)).toBe(formatCodexUnreportableRequirementFamilies())
  })

  it('says nothing when the server reported no requirements at all', () => {
    const lines = formatCodexConfigRequirementsDiagnostics(
      readCodexConfigRequirements({ requirements: null }),
    )
    expect(lines.some(line => line.startsWith(CODEX_REQUIREMENT_UNREPORTABLE_PREFIX))).toBe(false)
  })
})
