/**
 * D1.150 — the holder names, in the reader's language, from a wire FIELD.
 *
 * ## Why this suite is the instrument
 *
 * The toast it feeds lives in `AiSettingsPage`'s delete handler and is not
 * reachable without an Electron window, and the field it reads does not flow end
 * to end yet (one sending hop still drops `WireError.data` — see the module
 * header). So the invariant is pinned where it is decidable: the PARSE of a
 * payload that crossed two rebuild seams as `unknown`, and the SPLIT between a
 * label this renderer translates and a name it must print verbatim.
 *
 * The `t` here is a recorder rather than the real i18next: what matters is which
 * key was asked for and with what interpolation, because that pair is the whole
 * contract with the locale files, and the two keys' presence in BOTH locales is
 * the ordinary `lint:i18n:parity` / `lint:i18n:sorted` gate's job, not this
 * file's.
 */
import { describe, expect, it } from 'bun:test'
import {
  describeConnectionInUseHolders,
  parseConnectionInUseData,
} from '../connection-in-use-holders'

/** Records the key and renders something a human could read, in one line. */
const t = (key: string, options?: Record<string, unknown>): string => {
  const suffix = options
    ? ` ${Object.entries(options).map(([k, v]) => `${k}=${String(v)}`).join(' ')}`
    : ''
  return `[${key}${suffix}]`
}

const payload = (over: Partial<Record<string, unknown>> = {}) => ({
  sessions: [],
  automations: [],
  moreSessions: 0,
  moreAutomations: 0,
  ...over,
})

describe('D1.150 — parsing a payload that arrived as unknown', () => {
  it('accepts the shape the thrower sends', () => {
    expect(parseConnectionInUseData(payload({ sessions: ['A'], moreSessions: 2 })))
      .toEqual({ sessions: ['A'], automations: [], moreSessions: 2, moreAutomations: 0 })
  })

  it('answers null for everything that is not it — the refusal must still render', () => {
    // Each of these reached a `.map` under a cast, and a throw while rendering a
    // refusal hides the refusal itself.
    for (const bad of [
      undefined, null, 'CONNECTION_IN_USE', 42, [],
      payload({ sessions: 'A' }),            // a string where a list belongs
      payload({ sessions: ['A', 7] }),       // a list with a non-name in it
      payload({ moreSessions: -1 }),         // a count that cannot be a count
      payload({ moreAutomations: Number.NaN }),
      { sessions: [], automations: [] },     // the two counts missing entirely
    ]) {
      expect(parseConnectionInUseData(bad)).toBeNull()
      expect(describeConnectionInUseHolders(bad, t)).toBeNull()
    }
  })
})

describe('D1.150 — the label is translated and the NAME is not', () => {
  it('asks for the chat key and passes the user own names through verbatim', () => {
    const line = describeConnectionInUseHolders(payload({ sessions: ['Отчёт Q3', 'Release notes'] }), t)

    expect(line).toBe('[settings.ai.connectionInUseChats names=Отчёт Q3, Release notes]')
    // The names are NOT a key and are never looked up: they are user-authored
    // text, which is the whole reason the row asked for a field instead of a
    // better English sentence.
    expect(line).not.toContain('settings.ai.connectionInUseMore')
  })

  it('builds the tail from the COUNT rather than reading an English tail', () => {
    // Four sessions with two more behind them: the toast shows three and the
    // tail absorbs the fourth, so the number a user reads still adds up to what
    // the server refused for.
    const line = describeConnectionInUseHolders(
      payload({ sessions: ['A', 'B', 'C', 'D'], moreSessions: 2 }),
      t,
    )

    expect(line).toBe('[settings.ai.connectionInUseChats names=A, B, C [settings.ai.connectionInUseMore count=3]]')
  })

  it('names both groups, chats first, and neither when the payload names nobody', () => {
    const both = describeConnectionInUseHolders(
      payload({ sessions: ['A'], automations: ['Nightly'] }),
      t,
    )
    expect(both).toBe('[settings.ai.connectionInUseChats names=A]\n[settings.ai.connectionInUseTasks names=Nightly]')

    // THE CONTROL: a well-formed payload holding nobody adds no line at all, so
    // the caller keeps showing exactly the sentence it shows today. Without it
    // the assertions above would pass on a version that always printed a label.
    expect(describeConnectionInUseHolders(payload(), t)).toBeNull()
  })

  it('a group that is ONLY a tail still says something', () => {
    // The sender bounds its own lists, so a refusal can arrive with a count and
    // no names at all; dropping it would under-report what is holding the
    // connection.
    expect(describeConnectionInUseHolders(payload({ moreAutomations: 5 }), t))
      .toBe('[settings.ai.connectionInUseTasks names=[settings.ai.connectionInUseMore count=5]]')
  })
})
