/**
 * The three loop guards and the three inbound outcomes, as units.
 *
 * `cross-session-messaging.md` §Limitations — "in the receiving session, Claude
 * Code rate-limits repeated messages per sender, drops identical repeats
 * arriving within a short window, and queues at most 50 accepted messages for
 * Claude to read. A message loop between two sessions therefore stops on its
 * own." — and §Control inbound messages' `accept` / `hold` / `refuse`.
 *
 * Every "it stops" assertion below names the N it stopped after, and every guard
 * carries its own negative: a limiter that never lets anything through would
 * pass a bare "the eleventh was dropped" and fail the product.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
// P6.939 — the other half of the one voice: the schema whose enum error now
// reads the same shared sentence this module's warning does.
import { StoredConfigSchema } from '@nessy-agent/shared/config'
import {
  admitCrossSessionMessage,
  createCrossSessionInboundState,
  crossSessionInboundStateIsEmpty,
  releaseHeldCrossSessionMessages,
  parseCrossSessionInboundSetting,
  resolveCrossSessionInboundMode,
  resolveCrossSessionInboundWithScopes,
  strictestCrossSessionInboundMode,
  CROSS_SESSION_HOLD_CAP,
  CROSS_SESSION_INBOUND_LADDER,
  CROSS_SESSION_INBOUND_ENV,
  CROSS_SESSION_INBOUND_SETTINGS_FILES,
  crossSessionInboundSettingOf,
  crossSessionInboundUnrecognizedWarning,
  crossSessionOutcomeNotice,
  CROSS_SESSION_QUEUE_CAP,
  CROSS_SESSION_RATE_LIMIT,
  CROSS_SESSION_RATE_WINDOW_MS,
  CROSS_SESSION_REPEAT_WINDOW_MS,
  crossSessionInboundDefaultMode,
  crossSessionPermissionClass,
  resolveDialogExpiryMs,
  takeHeldCrossSessionMessage,
  DEFAULT_DIALOG_EXPIRY,
  DIALOG_EXPIRY_ENV,
  DIALOG_EXPIRY_MS,
  DIALOG_TIMEOUT_MS_ENV,
} from '../cross-session-inbound.ts'

const T0 = 1_700_000_000_000

/** One admission with everything but the varying bits held fixed. */
function admit(
  state: ReturnType<typeof createCrossSessionInboundState>,
  options: { text?: string; now?: number; senderId?: string; queuedCount?: number; mode?: 'accept' | 'hold' | 'refuse' } = {},
) {
  return admitCrossSessionMessage(state, {
    senderId: options.senderId ?? 'sender',
    text: options.text ?? 'hello',
    now: options.now ?? T0,
    // The receiver's real queue length. Big enough that the clamp never masks
    // the counter under test unless a test says otherwise.
    queuedCount: options.queuedCount ?? 10_000,
    mode: options.mode ?? 'accept',
  })
}

describe('the per-sender rate limit', () => {
  test(`admits ${CROSS_SESSION_RATE_LIMIT} and stops the loop on the next one`, () => {
    const state = createCrossSessionInboundState()
    const delivered: number[] = []
    for (let index = 0; index < CROSS_SESSION_RATE_LIMIT + 5; index += 1) {
      // A fresh body every hop, so the repeat check cannot be what stops it.
      const verdict = admit(state, { text: `hop ${index}`, now: T0 + index })
      if (verdict.status === 'delivered') delivered.push(index)
    }
    // The N, observed rather than assumed: the loop ran exactly this far.
    expect(delivered).toHaveLength(CROSS_SESSION_RATE_LIMIT)
    expect(delivered[0]).toBe(0)
    expect(delivered.at(-1)).toBe(CROSS_SESSION_RATE_LIMIT - 1)

    const stopped = admit(state, { text: 'one more', now: T0 + 100 })
    expect(stopped.status).toBe('dropped')
    expect(stopped).toMatchObject({ guard: 'rate-limit' })
    // The page requires the sender to be told which guard, and not to retry now.
    expect('note' in stopped ? stopped.note : '').toMatch(/rate limit/i)
    expect('note' in stopped ? stopped.note : '').toMatch(/not resend right away/i)
  })

  test('the allowance returns once the window has passed', () => {
    const state = createCrossSessionInboundState()
    for (let index = 0; index < CROSS_SESSION_RATE_LIMIT; index += 1) {
      expect(admit(state, { text: `hop ${index}`, now: T0 }).status).toBe('delivered')
    }
    expect(admit(state, { text: 'blocked', now: T0 + CROSS_SESSION_RATE_WINDOW_MS - 1 }).status).toBe('dropped')
    expect(admit(state, { text: 'allowed', now: T0 + CROSS_SESSION_RATE_WINDOW_MS }).status).toBe('delivered')
  })

  test('the limit is per sender, so one loud peer does not mute a quiet one', () => {
    const state = createCrossSessionInboundState()
    for (let index = 0; index < CROSS_SESSION_RATE_LIMIT; index += 1) {
      admit(state, { senderId: 'loud', text: `hop ${index}` })
    }
    expect(admit(state, { senderId: 'loud', text: 'blocked' }).status).toBe('dropped')
    expect(admit(state, { senderId: 'quiet', text: 'first' }).status).toBe('delivered')
  })

  test('a refused attempt does not extend the block, so a retrying sender recovers', () => {
    const state = createCrossSessionInboundState()
    for (let index = 0; index < CROSS_SESSION_RATE_LIMIT; index += 1) {
      admit(state, { text: `hop ${index}`, now: T0 })
    }
    // Retries all the way to the window edge. Counting these would push the
    // oldest stamp forward and mute the sender permanently.
    for (let index = 1; index < CROSS_SESSION_RATE_WINDOW_MS; index += 5_000) {
      expect(admit(state, { text: `retry ${index}`, now: T0 + index }).status).toBe('dropped')
    }
    expect(admit(state, { text: 'after the window', now: T0 + CROSS_SESSION_RATE_WINDOW_MS }).status).toBe('delivered')
  })
})

describe('the identical-repeat check', () => {
  test('an exact echo inside the window is dropped, and the loop stops after 1', () => {
    const state = createCrossSessionInboundState()
    const first = admit(state, { text: 'the deploy is green', now: T0 })
    expect(first.status).toBe('delivered')

    const echo = admit(state, { text: 'the deploy is green', now: T0 + 1_000 })
    expect(echo.status).toBe('dropped')
    expect(echo).toMatchObject({ guard: 'identical-repeat' })
    expect('note' in echo ? echo.note : '').toMatch(/repeat check/i)
  })

  test('a different body from the same sender still gets through', () => {
    const state = createCrossSessionInboundState()
    expect(admit(state, { text: 'the deploy is green', now: T0 }).status).toBe('delivered')
    expect(admit(state, { text: 'the deploy is red', now: T0 + 1_000 }).status).toBe('delivered')
  })

  test('the same body is accepted again once the short window has passed', () => {
    const state = createCrossSessionInboundState()
    expect(admit(state, { text: 'ping', now: T0 }).status).toBe('delivered')
    expect(admit(state, { text: 'ping', now: T0 + CROSS_SESSION_REPEAT_WINDOW_MS - 1 }).status).toBe('dropped')
    expect(admit(state, { text: 'ping', now: T0 + CROSS_SESSION_REPEAT_WINDOW_MS }).status).toBe('delivered')
  })
})

describe('the queue cap', () => {
  test(`stops at ${CROSS_SESSION_QUEUE_CAP} unread and names itself`, () => {
    const state = createCrossSessionInboundState()
    // Filled across windows, because the per-sender rate limit is the tighter
    // guard and would otherwise be what stops it.
    let now = T0
    let delivered = 0
    for (let index = 0; index < CROSS_SESSION_QUEUE_CAP; index += 1) {
      if (index % CROSS_SESSION_RATE_LIMIT === 0) now += CROSS_SESSION_RATE_WINDOW_MS
      if (admit(state, { text: `queued ${index}`, now }).status === 'delivered') delivered += 1
    }
    expect(delivered).toBe(CROSS_SESSION_QUEUE_CAP)

    now += CROSS_SESSION_RATE_WINDOW_MS
    const capped = admit(state, { text: 'one too many', now })
    expect(capped.status).toBe('dropped')
    expect(capped).toMatchObject({ guard: 'queue-cap' })
  })

  test('the counter is clamped by the receiver\'s real queue, so a drain re-opens it', () => {
    const state = createCrossSessionInboundState()
    state.queued = CROSS_SESSION_QUEUE_CAP
    // A drained queue reports 0 pending; the clamp must follow it down rather
    // than leave the cap latched shut for the life of the session.
    expect(admit(state, { text: 'after the drain', queuedCount: 0 }).status).toBe('delivered')
    expect(state.queued).toBe(1)
  })
})

describe('the inbound control', () => {
  test('refuse drops the message and accounts for nothing', () => {
    const state = createCrossSessionInboundState()
    const verdict = admit(state, { mode: 'refuse' })
    expect(verdict.status).toBe('refused')
    expect('note' in verdict ? verdict.note : '').toMatch(/not accepting/i)
    expect(crossSessionInboundStateIsEmpty(state)).toBe(true)
  })

  test('hold sets the message aside and an accept later releases it, in order', () => {
    const state = createCrossSessionInboundState()
    expect(admit(state, { text: 'first', mode: 'hold', now: T0 }).status).toBe('held')
    expect(admit(state, { text: 'second', mode: 'hold', now: T0 + 1 }).status).toBe('held')
    expect(state.queued).toBe(0)

    const released = releaseHeldCrossSessionMessages(state)
    expect(released.map(entry => entry.text)).toEqual(['first', 'second'])
    expect(state.held).toEqual([])
  })

  test(`the hold buffer keeps at most ${CROSS_SESSION_HOLD_CAP} and drops the oldest`, () => {
    const state = createCrossSessionInboundState()
    // Spread across senders and windows so neither the rate limit nor the
    // repeat check is what bounds the buffer.
    for (let index = 0; index < CROSS_SESSION_HOLD_CAP + 5; index += 1) {
      admit(state, { senderId: `sender-${index}`, text: `held ${index}`, mode: 'hold', now: T0 + index })
    }
    expect(state.held).toHaveLength(CROSS_SESSION_HOLD_CAP)
    expect(state.held[0]!.text).toBe('held 5')
    expect(state.held.at(-1)!.text).toBe(`held ${CROSS_SESSION_HOLD_CAP + 4}`)
  })
})

describe('the operator value', () => {
  test('reads the three documented values, case- and space-insensitively', () => {
    expect(resolveCrossSessionInboundMode('accept').mode).toBe('accept')
    expect(resolveCrossSessionInboundMode(' HOLD ').mode).toBe('hold')
    expect(resolveCrossSessionInboundMode('Refuse').mode).toBe('refuse')
  })

  // P6.182 · `explicit` is the field the permission-class default hangs on, so
  // it is asserted beside the mode rather than left to the caller to infer.
  test('an unset value is NOT an operator choice, so the default rule applies', () => {
    expect(resolveCrossSessionInboundMode(undefined)).toEqual({ mode: 'accept', explicit: false })
    expect(resolveCrossSessionInboundMode('')).toEqual({ mode: 'accept', explicit: false })
    expect(resolveCrossSessionInboundMode('accept').explicit).toBe(true)
  })

  // P6.872 · the env is the page's MANAGED half, so an unreadable value REFUSES
  // rather than falling to the permission-class default. Both halves of the
  // page's split treatment are quoted on `resolveCrossSessionInboundMode`.
  test('a misspelt value REFUSES, and the diagnostic says so', () => {
    // NEGATIVE. Before P6.872 this resolved to `accept` with `explicit: false`,
    // which is neither of the page's two unrecognized-value treatments.
    const resolved = resolveCrossSessionInboundMode('refused')
    expect(resolved.mode).toBe('refuse')
    // `explicit` rides out true or the permission-class default would re-open
    // exactly what the refusal closed.
    expect(resolved.explicit).toBe(true)
    expect(resolved.diagnostic).toContain(CROSS_SESSION_INBOUND_ENV)
    expect(resolved.diagnostic).toContain('refused')
    // The refusal is NAMED, which is the half of the row a mode alone cannot
    // carry: the operator has to be able to tell a refusal they asked for from
    // one their typo caused.
    expect(resolved.diagnostic).toContain('REFUSED')
  })

  test('a value the host CAN read is untouched by that refusal', () => {
    // POSITIVE, and the control the test above needs: the refusal belongs to
    // the unreadable value, not to every value that reaches this reader. An
    // operator `accept` still accepts, and it is still an operator choice.
    expect(resolveCrossSessionInboundMode('accept')).toEqual({ mode: 'accept', explicit: true })
    expect(resolveCrossSessionInboundMode(' Hold ')).toEqual({ mode: 'hold', explicit: true })
  })
})

describe('the guard\'s own memory', () => {
  test('sender tracking is bounded, so the loop stopper is not itself a leak', () => {
    const state = createCrossSessionInboundState()
    for (let index = 0; index < 500; index += 1) {
      admit(state, { senderId: `sender-${index}`, text: `hello ${index}`, now: T0 })
    }
    expect(state.senders.size).toBeLessThanOrEqual(64)
  })

  test('per-sender repeat tracking is bounded too', () => {
    const state = createCrossSessionInboundState()
    let now = T0
    for (let index = 0; index < 500; index += 1) {
      if (index % CROSS_SESSION_RATE_LIMIT === 0) now += CROSS_SESSION_RATE_WINDOW_MS
      admit(state, { text: `body ${index}`, now })
    }
    expect(state.senders.get('sender')!.repeats.size).toBeLessThanOrEqual(32)
  })
})

/**
 * P2.460 · the lower-scope exception, as a unit.
 *
 * `settings.md#exceptions-to-managed-settings-precedence`, the
 * `crossSessionInbound` row verbatim: "A stricter value from
 * `.claude/settings.json` or `.claude/settings.local.json`, on the `accept` <
 * `hold` < `refuse` ladder", honored "over managed, `--settings`, and user
 * values; a project or local value that isn't stricter is ignored".
 *
 * Every row here has its own negative, because a resolver that always returned
 * `refuse` would pass "a stricter file wins" and destroy the feature.
 */
describe('a project or local settings file may only TIGHTEN inbound', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  /** A throwaway project directory; nothing here ever names a real home. */
  function project(files: { project?: string; local?: string }): string {
    const root = mkdtempSync(join(tmpdir(), 'nessy-xsession-'))
    roots.push(root)
    mkdirSync(join(root, '.claude'), { recursive: true })
    if (files.project !== undefined) writeFileSync(join(root, '.claude', 'settings.json'), files.project)
    if (files.local !== undefined) writeFileSync(join(root, '.claude', 'settings.local.json'), files.local)
    return root
  }

  test('the ladder is ordered accept < hold < refuse, and nothing re-derives it', () => {
    expect([...CROSS_SESSION_INBOUND_LADDER]).toEqual(['accept', 'hold', 'refuse'])
    expect(strictestCrossSessionInboundMode('accept', 'refuse', 'hold')).toBe('refuse')
    expect(strictestCrossSessionInboundMode('hold', undefined)).toBe('hold')
    // The negative: nothing supplied is the LAX end, not the strict one.
    expect(strictestCrossSessionInboundMode(undefined, undefined)).toBe('accept')
  })

  test('a stricter project value wins over the operator value', () => {
    const workingDirectory = project({ project: '{ "crossSessionInbound": "refuse" }' })
    expect(resolveCrossSessionInboundWithScopes({ operatorMode: 'accept', workingDirectory }))
      .toEqual({ mode: 'refuse', tightenedBy: 'project' })
  })

  test("a project value that isn't stricter is IGNORED", () => {
    const workingDirectory = project({ project: '{ "crossSessionInbound": "accept" }' })
    // The operator asked for `refuse`; a repository must not be able to open it.
    expect(resolveCrossSessionInboundWithScopes({ operatorMode: 'refuse', workingDirectory }))
      .toEqual({ mode: 'refuse' })
  })

  test('local and project are both read, and the strictest of the three wins', () => {
    const workingDirectory = project({
      project: '{ "crossSessionInbound": "hold" }',
      local: '{ "crossSessionInbound": "refuse" }',
    })
    expect(resolveCrossSessionInboundWithScopes({ operatorMode: 'accept', workingDirectory }))
      .toEqual({ mode: 'refuse', tightenedBy: 'local' })
    // …and the other direction, so "local always wins" cannot pass this pair.
    const other = project({
      project: '{ "crossSessionInbound": "refuse" }',
      local: '{ "crossSessionInbound": "accept" }',
    })
    expect(resolveCrossSessionInboundWithScopes({ operatorMode: 'accept', workingDirectory: other }))
      .toEqual({ mode: 'refuse', tightenedBy: 'project' })
  })

  test('comments and trailing commas parse, because these files are co-owned', () => {
    const workingDirectory = project({
      local: '{\n  // held while I review\n  "crossSessionInbound": "hold",\n}',
    })
    expect(resolveCrossSessionInboundWithScopes({ operatorMode: 'accept', workingDirectory }))
      .toEqual({ mode: 'hold', tightenedBy: 'local' })
  })

  test('an unreadable value contributes no VALUE rung, so it can never be laxer', () => {
    // The vendor's own zod is `.catch(void 0)`; dropping the VALUE stays right,
    // because a dropped rung can never be laxer than the operator's. Since
    // P6.866 the drop is no longer silent and no longer inert — see the
    // warn-and-hold describe below, which owns those assertions.
    for (const raw of ['{ "crossSessionInbound": "REFUSE" }', '{ "crossSessionInbound": 3 }']) {
      const workingDirectory = project({ project: raw })
      expect(resolveCrossSessionInboundWithScopes({ operatorMode: 'refuse', workingDirectory }).mode).toBe('refuse')
    }
    // A file that is not a settings document at all sets no value, so it warns
    // about nothing and holds nothing — byte for byte the old behaviour.
    const broken = project({ project: 'not json at all' })
    expect(resolveCrossSessionInboundWithScopes({ operatorMode: 'hold', workingDirectory: broken }))
      .toEqual({ mode: 'hold' })
    // The positive control on the same rig: the exact spelling DOES cross.
    const workingDirectory = project({ project: '{ "crossSessionInbound": "refuse" }' })
    expect(resolveCrossSessionInboundWithScopes({ operatorMode: 'hold', workingDirectory }).mode).toBe('refuse')
  })

  test('no working directory contributes neither scope', () => {
    expect(resolveCrossSessionInboundWithScopes({ operatorMode: 'hold' })).toEqual({ mode: 'hold' })
    expect(resolveCrossSessionInboundWithScopes({ operatorMode: 'hold', workingDirectory: undefined })).toEqual({ mode: 'hold' })
  })

  test('only this key is read out of the document', () => {
    expect(parseCrossSessionInboundSetting({ crossSessionInbound: 'hold', permissions: { deny: ['Bash'] } })).toBe('hold')
    expect(parseCrossSessionInboundSetting({ permissions: { deny: ['Bash'] } })).toBeUndefined()
    expect(parseCrossSessionInboundSetting(['crossSessionInbound'])).toBeUndefined()
    expect(parseCrossSessionInboundSetting(null)).toBeUndefined()
  })

  test('the label pair the warning prints is the pair the resolver reads', () => {
    // The one thing that could drift: the warning writes the two paths with a
    // forward slash for the user to read, while the resolver `join`s them.
    for (const scope of ['project', 'local'] as const) {
      const label = crossSessionInboundUnrecognizedWarning('"x"', scope).split(':')[0]!
      expect(join(...label.split('/'))).toBe(CROSS_SESSION_INBOUND_SETTINGS_FILES[scope])
    }
  })
})

/**
 * P6.866 — an unrecognized value WARNS and HOLDS; it no longer vanishes.
 *
 * `settings-reference.md#crosssessioninbound` (anchor verified 2026-09-08 on the
 * rendered page), verbatim: "Claude Code warns when you set a value it doesn't
 * recognize. While that value is present in a user, project, local, or
 * `--settings` file, Claude Code holds inbound messages, even when a source that
 * takes precedence sets `accept`. A `refuse` that another source sets still
 * applies. Fix or remove the value to clear the hold."
 *
 * The bundle we vendor self-reports 2.1.247 from both of its own self-reports
 * (`claudeCodeVersion` in the SDK manifest and `claude --version`; it read
 * 2.1.233 until the P7.1 lift), and the page says the behaviour arrived in
 * v2.1.248 — "Before v2.1.248, Claude Code ignored an unrecognized value
 * without warning" — so the PAGE still governs and the bundle is still the thing
 * that lags, by ONE patch version now rather than fifteen.
 *
 * Four assertions, because the page's sentence makes four claims: it warns, it
 * holds, the hold beats a preceding `accept`, and a `refuse` still wins.
 */
describe('an unrecognized crossSessionInbound value warns and holds (P6.866)', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function project(files: { project?: string; local?: string }): string {
    const root = mkdtempSync(join(tmpdir(), 'nessy-xsession-typo-'))
    roots.push(root)
    mkdirSync(join(root, '.claude'), { recursive: true })
    if (files.project !== undefined) writeFileSync(join(root, '.claude', 'settings.json'), files.project)
    if (files.local !== undefined) writeFileSync(join(root, '.claude', 'settings.local.json'), files.local)
    return root
  }

  test('POSITIVE: a typo holds even though the operator said accept, and the warning names it', () => {
    const workingDirectory = project({ project: '{ "crossSessionInbound": "reject" }' })
    const verdict = resolveCrossSessionInboundWithScopes({ operatorMode: 'accept', workingDirectory })
    // "Claude Code holds inbound messages, even when a source that takes
    // precedence sets `accept`."
    expect(verdict.mode).toBe('hold')
    // Read into a local before asserting on it: a matcher handed to
    // `toMatchObject` overwrites the field it matched (AGENTS.md §Traps).
    const warnings = verdict.warnings ?? []
    expect(warnings).toHaveLength(1)
    const warning = warnings[0]!
    // The value, named — the page's own example typo.
    expect(warning).toContain('received "reject"')
    // The file, named: the page says "the warning's second sentence depends on
    // which file holds the value".
    expect(warning).toContain('.claude/settings.json')
    // And the page's own sentence, so the user is told what the hold IS.
    expect(warning).toContain('cross-session messages are held for your approval instead of being delivered')
    // Not attributed as a stricter VALUE: no file supplied the winning rung.
    expect(verdict.tightenedBy).toBeUndefined()
  })

  test('NEGATIVE: a value the schema accepts warns about nothing, and so does an absent key', () => {
    // The exact spelling on the same rig — the control that proves the positive
    // above is about the TYPO and not about the file being read at all.
    const recognized = project({ project: '{ "crossSessionInbound": "accept" }' })
    expect(resolveCrossSessionInboundWithScopes({ operatorMode: 'accept', workingDirectory: recognized }))
      .toEqual({ mode: 'accept' })
    // "Default: unset, so Claude Code decides per message" — an absent key is the
    // documented state, not a defect, and must stay silent.
    const absent = project({ project: '{ "permissions": { "deny": ["Bash"] } }' })
    expect(resolveCrossSessionInboundWithScopes({ operatorMode: 'accept', workingDirectory: absent }))
      .toEqual({ mode: 'accept' })
    // No project directory at all: nothing read, nothing said.
    expect(resolveCrossSessionInboundWithScopes({ operatorMode: 'accept' })).toEqual({ mode: 'accept' })
  })

  test('a refuse that another source sets still applies, and both files can warn at once', () => {
    // "A `refuse` that another source sets still applies" — `refuse` outranks the
    // repair hold on the same ladder, so this needs no rule of its own.
    const workingDirectory = project({
      project: '{ "crossSessionInbound": "reject" }',
      local: '{ "crossSessionInbound": "refuse" }',
    })
    const verdict = resolveCrossSessionInboundWithScopes({ operatorMode: 'accept', workingDirectory })
    expect(verdict.mode).toBe('refuse')
    expect(verdict.tightenedBy).toBe('local')
    expect(verdict.warnings ?? []).toHaveLength(1)

    // One warning per rung that carries a typo, in scope order.
    const both = project({
      project: '{ "crossSessionInbound": "reject" }',
      local: '{ "crossSessionInbound": "HOLD" }',
    })
    const pair = resolveCrossSessionInboundWithScopes({ operatorMode: 'accept', workingDirectory: both })
    expect(pair.mode).toBe('hold')
    const lines = pair.warnings ?? []
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('.claude/settings.json')
    expect(lines[1]).toContain('.claude/settings.local.json')
    expect(lines[1]).toContain('received "HOLD"')
  })

  test('the user rung holds too, with or without a project directory', () => {
    // The rung SessionManager feeds (hand-off): a typo in user settings holds on
    // its own, which is why it is not gated on `workingDirectory`.
    const verdict = resolveCrossSessionInboundWithScopes({
      operatorMode: 'accept', operatorExplicit: false, userUnrecognized: '"reject"',
    })
    expect(verdict.mode).toBe('hold')
    expect(verdict.warnings?.[0]).toContain('your user settings')
    // Omitting it is byte-for-byte today's behaviour.
    expect(resolveCrossSessionInboundWithScopes({ operatorMode: 'accept', operatorExplicit: false }))
      .toEqual({ mode: 'accept' })
  })

  test('the read distinguishes absent, valid and unreadable, and bounds what it quotes', () => {
    expect(crossSessionInboundSettingOf({})).toEqual({})
    expect(crossSessionInboundSettingOf(null)).toEqual({})
    expect(crossSessionInboundSettingOf({ crossSessionInbound: 'hold' })).toEqual({ mode: 'hold' })
    expect(crossSessionInboundSettingOf({ crossSessionInbound: 'REFUSE' }))
      .toEqual({ unrecognized: '"REFUSE"' })
    // A non-string is unrecognized too, and reads back without a second layer of
    // quoting.
    expect(crossSessionInboundSettingOf({ crossSessionInbound: 3 })).toEqual({ unrecognized: '3' })
    // A settings file can hold any string; a warning line cannot. Bounded, and
    // the control characters a log line must not carry are escaped.
    const long = crossSessionInboundSettingOf({ crossSessionInbound: 'x'.repeat(500) }).unrecognized ?? ''
    expect(long.length).toBeLessThan(80)
    expect(long.endsWith('…"')).toBe(true)
    expect(crossSessionInboundSettingOf({ crossSessionInbound: 'a\nb' }))
      .toEqual({ unrecognized: '"a\\nb"' })
  })
})


/**
 * P6.182 · the permission-class default, the two holds and the dialog deadline.
 *
 * The rule under test is the one the page states twice, once from each side, and
 * the table below is written as the exclusive-or it actually is — with BOTH
 * agreeing pairs present, because a rule that only ever held would pass every
 * "it was held" assertion and be useless.
 */
describe('P6.182 · the permission-mode class default', () => {
  test('groups sessions the way the page groups them', () => {
    const available = { bypassAvailable: true }
    expect(crossSessionPermissionClass('bypassPermissions', available)).toBe('bypassing')
    // "Plan mode counts as bypassing in sessions with bypass permissions available"
    expect(crossSessionPermissionClass('plan', available)).toBe('bypassing')
    // ...and NOT where bypass is unavailable, which is the negative half of the
    // same sentence and the safe direction (more dialogs, never fewer).
    expect(crossSessionPermissionClass('plan', { bypassAvailable: false })).toBe('prompting')
    // "auto, `acceptEdits`, and `dontAsk` count as prompting"
    for (const mode of ['auto', 'acceptEdits', 'dontAsk']) {
      expect(crossSessionPermissionClass(mode, available)).toBe('prompting')
    }
    // "every other session into the other" — this host's two extra modes, and an
    // absent mode, all land in the prompting class.
    for (const mode of ['default', undefined]) { // F1.1050: the explore arm left with the mode (plan is asserted on its own)
      expect(crossSessionPermissionClass(mode, available)).toBe('prompting')
    }
  })

  test('holds when the two classes DIFFER and delivers when they agree, in both directions', () => {
    expect(crossSessionInboundDefaultMode({ senderClass: 'bypassing', receiverClass: 'prompting' })).toBe('hold')
    expect(crossSessionInboundDefaultMode({ senderClass: 'prompting', receiverClass: 'bypassing' })).toBe('hold')
    expect(crossSessionInboundDefaultMode({ senderClass: 'prompting', receiverClass: 'prompting' })).toBe('accept')
    expect(crossSessionInboundDefaultMode({ senderClass: 'bypassing', receiverClass: 'bypassing' })).toBe('accept')
  })
})

describe('P6.182 · the two holds are one buffer with two lifetimes', () => {
  test('a DEFAULT hold asks for a dialog and carries its request id; an explicit hold does neither', () => {
    const state = createCrossSessionInboundState()
    const byDefault = admitCrossSessionMessage(state, {
      senderId: 'sender', text: 'from the other class', now: T0, queuedCount: 0,
      mode: 'hold', heldVia: 'default', requestId: 'req-1', senderWorkspaceId: 'ws-1',
    })
    expect(byDefault.status).toBe('held')
    expect(byDefault.status === 'held' && byDefault.awaitingApproval).toBe(true)
    expect(state.held[0]).toMatchObject({ via: 'default', requestId: 'req-1', senderWorkspaceId: 'ws-1' })

    const explicit = admitCrossSessionMessage(state, {
      senderId: 'sender', text: 'operator said hold', now: T0 + 1, queuedCount: 0, mode: 'hold',
    })
    expect(explicit.status).toBe('held')
    // No dialog, no deadline: "A message held by an explicit `hold` setting
    // doesn't expire; Claude Code delivers it only when an `accept` later applies."
    expect(explicit.status === 'held' && explicit.awaitingApproval).toBeUndefined()
    expect(state.held[1]!.via).toBe('explicit')
    expect(state.held[1]!.requestId).toBeUndefined()
  })

  test('the two notes differ, because only one of them promises a follow-up', () => {
    const state = createCrossSessionInboundState()
    const byDefault = admitCrossSessionMessage(state, {
      senderId: 'sender', text: 'a', now: T0, queuedCount: 0, mode: 'hold', heldVia: 'default', requestId: 'r',
    })
    const explicit = admitCrossSessionMessage(state, {
      senderId: 'sender', text: 'b', now: T0 + 1, queuedCount: 0, mode: 'hold',
    })
    const defaultNote = byDefault.status === 'held' ? byDefault.note : ''
    const explicitNote = explicit.status === 'held' ? explicit.note : ''
    expect(defaultNote).toContain('approve')
    expect(defaultNote).toContain('expires')
    expect(explicitNote).toContain(CROSS_SESSION_INBOUND_ENV)
    expect(explicitNote).not.toContain('expires')
  })

  test('a held message is taken back out by its dialog id, and a second take finds nothing', () => {
    const state = createCrossSessionInboundState()
    admitCrossSessionMessage(state, {
      senderId: 'sender', text: 'a', now: T0, queuedCount: 0, mode: 'hold', heldVia: 'default', requestId: 'r-a',
    })
    admitCrossSessionMessage(state, {
      senderId: 'sender', text: 'b', now: T0 + 1, queuedCount: 0, mode: 'hold', heldVia: 'default', requestId: 'r-b',
    })
    expect(takeHeldCrossSessionMessage(state, 'r-a')?.text).toBe('a')
    // Approve settles ONE message: the other keeps its own dialog.
    expect(state.held).toHaveLength(1)
    expect(state.held[0]!.requestId).toBe('r-b')
    // An id this buffer no longer holds is "already settled", never an error.
    expect(takeHeldCrossSessionMessage(state, 'r-a')).toBeUndefined()
    expect(takeHeldCrossSessionMessage(state, 'never-existed')).toBeUndefined()
  })
})

describe('P6.182 · the dialog deadline', () => {
  test('defaults to the documented 5m and reads the four documented values', () => {
    expect(resolveDialogExpiryMs({})).toEqual({ ms: DIALOG_EXPIRY_MS[DEFAULT_DIALOG_EXPIRY] })
    expect(resolveDialogExpiryMs({ [DIALOG_EXPIRY_ENV]: '60s' }).ms).toBe(60_000)
    expect(resolveDialogExpiryMs({ [DIALOG_EXPIRY_ENV]: '10m' }).ms).toBe(600_000)
    // "`never`, which disables the deadline" — and `undefined` is exactly what
    // the renderer's auto-continue hook treats as "arm nothing".
    expect(resolveDialogExpiryMs({ [DIALOG_EXPIRY_ENV]: 'never' }).ms).toBeUndefined()
  })

  test('the documented per-session ms override wins over the named value', () => {
    expect(resolveDialogExpiryMs({
      [DIALOG_TIMEOUT_MS_ENV]: '1234',
      [DIALOG_EXPIRY_ENV]: '10m',
    })).toEqual({ ms: 1234 })
  })

  test('an unusable value falls to the DEFAULT with a diagnostic, never to never', () => {
    const named = resolveDialogExpiryMs({ [DIALOG_EXPIRY_ENV]: '5 minutes' })
    expect(named.ms).toBe(DIALOG_EXPIRY_MS[DEFAULT_DIALOG_EXPIRY])
    expect(named.diagnostic).toContain(DIALOG_EXPIRY_ENV)
    const ms = resolveDialogExpiryMs({ [DIALOG_TIMEOUT_MS_ENV]: '-1' })
    expect(ms.ms).toBe(DIALOG_EXPIRY_MS[DEFAULT_DIALOG_EXPIRY])
    expect(ms.diagnostic).toContain(DIALOG_TIMEOUT_MS_ENV)
  })
})

/**
 * P6.182 clause (i) — the USER-settings rung.
 *
 * `settings-reference.md#crosssessioninbound`, verbatim: *"Claude Code reads
 * managed settings first, then the `--settings` flag, then user settings, and
 * applies the first value found."* This host's operator env stands in for the
 * first two, so the ordering to prove is: an EXPLICIT operator value beats the
 * user's, the user's beats the per-message default, and the two files below can
 * still only tighten whichever won.
 */
describe('the user-settings rung (P6.182 clause i)', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  test('a user value applies when the operator claimed nothing, and loses when it did', () => {
    // POSITIVE: no explicit operator value, so the user's replaces the
    // per-message default that arrived as `operatorMode`.
    expect(resolveCrossSessionInboundWithScopes({
      operatorMode: 'accept', userMode: 'refuse', operatorExplicit: false,
    })).toEqual({ mode: 'refuse' })
    // The direction that must never move: an operator who set the key is not
    // overridden by a user, in EITHER direction on the ladder.
    expect(resolveCrossSessionInboundWithScopes({
      operatorMode: 'accept', userMode: 'refuse', operatorExplicit: true,
    })).toEqual({ mode: 'accept' })
    expect(resolveCrossSessionInboundWithScopes({
      operatorMode: 'refuse', userMode: 'accept', operatorExplicit: true,
    })).toEqual({ mode: 'refuse' })
  })

  test('omitting the two arguments is byte-for-byte the behaviour that shipped before', () => {
    // NEGATIVE, the blast radius: every existing caller supplies neither, and a
    // user value alone must not apply — `userMode` without `operatorExplicit`
    // would let a user overwrite an operator's value, which is the one thing
    // this key must never do.
    for (const mode of CROSS_SESSION_INBOUND_LADDER) {
      expect(resolveCrossSessionInboundWithScopes({ operatorMode: mode })).toEqual({ mode })
    }
    // An ABSENT `operatorExplicit` means the caller did not answer; unanswered
    // must not be read as "the operator claimed nothing". This assertion failed
    // on the first implementation (`!== true`) and is why the resolver tests
    // `=== false`.
    expect(resolveCrossSessionInboundWithScopes({ operatorMode: 'accept', userMode: 'refuse' }))
      .toEqual({ mode: 'accept' })
    // And an absent user value changes nothing either.
    expect(resolveCrossSessionInboundWithScopes({
      operatorMode: 'hold', userMode: undefined, operatorExplicit: false,
    })).toEqual({ mode: 'hold' })
  })

  test('the two files still only tighten whichever rung won', () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), 'nessy-xsi-user-'))
    roots.push(workingDirectory)
    mkdirSync(join(workingDirectory, '.claude'), { recursive: true })
    writeFileSync(join(workingDirectory, '.claude', 'settings.json'), JSON.stringify({ crossSessionInbound: 'refuse' }))
    // POSITIVE: a project file stricter than the user's value wins, and says so.
    expect(resolveCrossSessionInboundWithScopes({
      operatorMode: 'accept', userMode: 'hold', operatorExplicit: false, workingDirectory,
    })).toEqual({ mode: 'refuse', tightenedBy: 'project' })
    // NEGATIVE: a project value that is not stricter than the USER's is ignored,
    // exactly as it is ignored against an operator's.
    writeFileSync(join(workingDirectory, '.claude', 'settings.json'), JSON.stringify({ crossSessionInbound: 'accept' }))
    expect(resolveCrossSessionInboundWithScopes({
      operatorMode: 'accept', userMode: 'hold', operatorExplicit: false, workingDirectory,
    })).toEqual({ mode: 'hold' })
  })

  test('the operator env name is spelled the same in both packages', () => {
    // `packages/shared/src/config/storage.ts` names the same literal because
    // shared cannot import server-core. This is the pin that keeps them equal —
    // the same instrument `unattended-approval-defaults.test.ts` uses.
    expect(CROSS_SESSION_INBOUND_ENV).toBe('NESSY_CROSS_SESSION_INBOUND')
  })
})

/**
 * P6.918 — the follow-up a sender receives names WHICH held message settled.
 *
 * The defect was invisible with one message in flight and only appears with
 * two, which is why the positive case below sends two and compares them: an
 * assertion that one notice "contains the quote" passes on the old code the
 * moment the quote happens to be the receiver's name.
 */
describe('the settle notice names the message, not only the receiver', () => {
  const receiver = { name: 'builder', sessionId: 'sess-9' }

  test('two holds to ONE receiver settle with different notices', () => {
    const first = crossSessionOutcomeNotice({ text: 'deploy is green', at: T0 }, 'approved', receiver)
    const second = crossSessionOutcomeNotice({ text: 'deploy is red', at: T0 + 60_000 }, 'approved', receiver)
    expect(first).not.toBe(second)
    expect(first).toContain('deploy is green')
    expect(second).toContain('deploy is red')
    // The receiver is still named — the notice gained a subject, it did not
    // lose one.
    for (const notice of [first, second]) expect(notice).toContain('builder (session sess-9)')
  })

  test('two IDENTICAL texts still separate, because the timestamp rides along', () => {
    // The repeat window admits an identical text once it has passed, so this is
    // a real pair and not a contrived one. Without the stamp these two notices
    // would be byte-identical again.
    const early = crossSessionOutcomeNotice({ text: 'ping', at: T0 }, 'denied', receiver)
    const late = crossSessionOutcomeNotice({ text: 'ping', at: T0 + 3_600_000 }, 'denied', receiver)
    expect(early).not.toBe(late)
    expect(early).toContain(new Date(T0).toISOString())
  })

  test('a long, multi-line text is quoted short and on one line', () => {
    const notice = crossSessionOutcomeNotice(
      { text: `  the branch is ready\n\nand the pipeline ${'x'.repeat(200)}  `, at: T0 },
      'expired',
      receiver,
    )
    expect(notice.split('\n')).toHaveLength(1)
    expect(notice).toContain('the branch is ready and the pipeline')
    expect(notice).toContain('…')
    // NEGATIVE: the tail of a 200-character run must not be in the notice at
    // all — a quote that only LOOKS truncated is the failure this bounds.
    expect(notice).not.toContain('x'.repeat(80))
  })

  test('an empty text still produces a notice, and names the stamp instead', () => {
    // `admitCrossSessionMessage` does not require a non-empty body, so the
    // quote can be empty; the notice must not then read `beginning ""`.
    const notice = crossSessionOutcomeNotice({ text: '   ', at: T0 }, 'refused', receiver)
    expect(notice).not.toContain('beginning ""')
    expect(notice).toContain(new Date(T0).toISOString())
    expect(notice).toContain('no longer accepting cross-session messages')
  })

  test('all four outcomes say something different about what happened', () => {
    const held = { text: 'the report is up', at: T0 }
    const notices = (['approved', 'denied', 'expired', 'refused'] as const)
      .map(outcome => crossSessionOutcomeNotice(held, outcome, receiver))
    expect(new Set(notices).size).toBe(4)
    expect(notices[0]).toContain('was approved and delivered')
    expect(notices[1]).toContain('declined by its user')
    expect(notices[2]).toContain('expired without an answer')
    expect(notices[3]).toContain('was dropped')
  })
})

describe('P6.939 — one typo, one voice', () => {
  /**
   * The merge P6.874 measured as NOT worth making, made once its own trigger
   * fired: P6.878 gave `doctor-collectors.ts` a collector that calls
   * `validateConfig()`, so the settings-doctor page and the CLI doctor both name
   * a bad value unasked — and a user meeting both surfaces was meeting two
   * different explanations of one typo.
   */
  test('the schema and the resolver say the SAME sentence about the same value', () => {
    const schemaMessage = StoredConfigSchema.safeParse({
      storageLayoutVersion: 2,
      workspaceRefs: [],
      activeWorkspaceId: null,
      activeSessionId: null,
      crossSessionInbound: 'reject',
    })
    expect(schemaMessage.success).toBe(false)
    // Read into a local BEFORE asserting anything about it: the issue list is
    // the only place the message exists and it is read twice below.
    const issues = schemaMessage.success ? [] : schemaMessage.error.issues
    const fromSchema = issues.find(issue => issue.path[0] === 'crossSessionInbound')?.message
    const fromResolver = crossSessionInboundUnrecognizedWarning('"reject"', 'user')

    // The page's own fenced block, verbatim, with the value substituted. Both
    // surfaces produce it from `crossSessionInboundUnrecognizedSentence`.
    expect(fromSchema).toBe(
      '"crossSessionInbound" must be one of "accept", "hold", "refuse"; received "reject". '
      + 'This value was ignored; while it is present, cross-session messages are held for your '
      + 'approval instead of being delivered. Set it to one of the values above.',
    )
    // The resolver adds the ONE thing the validator cannot know — which file
    // holds the value — and nothing else.
    expect(fromResolver).toBe(`your user settings: ${fromSchema}`)
  })

  test('zod’s bare enum list is GONE, which is the half that made them two voices', () => {
    // The negative that gives the case above its meaning: before this row the
    // schema said only the list of accepted values, with none of the page's
    // three clauses — the value was ignored, messages are held meanwhile, and
    // fixing it clears the hold.
    const parsed = StoredConfigSchema.safeParse({
      storageLayoutVersion: 2,
      workspaceRefs: [],
      activeWorkspaceId: null,
      activeSessionId: null,
      crossSessionInbound: 7,
    })
    const message = parsed.success
      ? ''
      : parsed.error.issues.find(issue => issue.path[0] === 'crossSessionInbound')?.message ?? ''
    expect(message).toContain('held for your approval')
    // A non-string value is rendered by the SAME renderer both surfaces share,
    // so it is quoted identically in both — `7`, not `"7"`.
    expect(message).toContain('received 7.')
  })
})
