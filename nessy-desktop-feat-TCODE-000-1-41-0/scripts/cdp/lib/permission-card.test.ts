import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'

import en from '../../../packages/shared/src/i18n/locales/en.json'
import ru from '../../../packages/shared/src/i18n/locales/ru.json'
import type { CardButtonHit } from './ask-user.ts'
import type { CdpSession } from './connect.ts'
import { CARD_DURABLE_LABELS, CARD_SCOPE_FOOTNOTES, ensureNoCard, readCard } from './permission-card.ts'

/**
 * F1.991 (origin DN-004) — `ensureNoCard` denies EVERY leftover card, bounded,
 * held against a scripted page (no app).
 *
 * It used to press Deny once. At an awaiting count of two or more the next card
 * takes the denied one's place (F1.976's finding), so one card still leaked into
 * the next arm. Its neighbour `pressCard`'s own pins (the count rule) live in
 * `harness.test.ts`.
 */

const HIT: CardButtonHit = { x: 100, y: 200, text: 'Deny', index: 1, labels: ['Allow', 'Deny'], matched: true }
const FAST = { timeoutMs: 60, intervalMs: 5 }

/**
 * A page with `queued` permission cards, one on screen while any is left. A
 * click that `lands` takes one off the queue and drops the open chat's awaiting
 * count; one that does not leaves both alone.
 */
function page(queued: number, lands = true) {
  let left = queued
  let clicks = 0
  const session = {
    call: async (expression: string) => {
      if (expression.includes('awaitingApprovalCount')) return left
      if (expression.includes('getBoundingClientRect')) return left > 0 ? HIT : null
      return { present: left > 0, text: 'Bash', labels: HIT.labels, scope: null, durableOffered: false }
    },
    evaluate: async () => ({ width: 1440, height: 900 }),
    send: async (_method: string, params: { type?: string } = {}) => {
      if (params.type !== 'mouseReleased') return {}
      clicks += 1
      if (lands && left > 0) left -= 1
      return {}
    },
  }
  return { session: session as never as CdpSession, clicks: () => clicks, left: () => left }
}

describe('ensureNoCard denies every leftover card, and says so when one stays (F1.991)', () => {
  let stderr: ReturnType<typeof spyOn>
  beforeEach(() => { stderr = spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => { stderr.mockRestore() })

  it('two leftover cards: both are denied and none reaches the next arm', async () => {
    const two = page(2)
    expect(await ensureNoCard(two.session, 'arm A', FAST)).toBeNull()
    expect(two.clicks()).toBe(2)
    expect(two.left()).toBe(0)
    expect(stderr).not.toHaveBeenCalled()
    // Control: a clear screen is not pressed at all.
    expect(await ensureNoCard(two.session, 'arm B', FAST)).toBeNull()
    expect(two.clicks()).toBe(2)
  })

  it('NEGATIVE — a denial that is not delivered stops the loop, and the leftover is named on stderr', async () => {
    const stuck = page(2, false)
    const said = await ensureNoCard(stuck.session, 'arm A', FAST)
    // One press, never a second blind one at the same card.
    expect(stuck.clicks()).toBe(1)
    expect(said).toContain('arm A: a leftover permission card is still up: denial 1 was not delivered')
    expect(stderr).toHaveBeenCalledWith(`  · ${said}`)
  })

  it('BOUNDARY — a queue deeper than the bound stops at the bound, with a card still up', async () => {
    const deep = page(10)
    const said = await ensureNoCard(deep.session, 'arm A', { ...FAST, maxDenials: 3 })
    expect(deep.clicks()).toBe(3)
    expect(deep.left()).toBe(7)
    expect(said).toContain('3 denials delivered and a card is still up')
  })
})

/**
 * UB12.46 — `readCard` reads a Russian card as well as an English one. The scope footnotes and the
 * durable label were English-only, so a sitting in Russian read every card as `scope: null` and
 * `durableOffered: false` — the second is the reading RS-112 fails a durable card on.
 *
 * The page body `readCard` sends is run here against a stub page: one visible card with the given
 * text and buttons.
 */
function cardPage(text: string, buttons: string[]): CdpSession {
  const visible = { getClientRects: () => [{}] }
  const card = {
    ...visible,
    innerText: text,
    querySelectorAll: () => buttons.map(label => ({ ...visible, innerText: label })),
  }
  const document = { querySelectorAll: () => [card] }
  const getComputedStyle = () => ({ visibility: 'visible', display: 'block' })
  const session = {
    call: async (body: string) =>
      new Function('document', 'getComputedStyle', `return (async () => { ${body} })()`)(document, getComputedStyle),
  }
  return session as never as CdpSession
}

describe('readCard reads the card in English and in Russian (UB12.46)', () => {
  const EN = en as Record<string, string>
  const RU = ru as Record<string, string>
  const KEYS = { repository: 'repository', session: 'session', workspace: 'workspace' } as const

  it('the twins ARE the locale sentences, so a copy edit fails here rather than in a sitting', () => {
    for (const [scope, key] of Object.entries(KEYS)) {
      const [english, russian]: readonly string[] = CARD_SCOPE_FOOTNOTES[scope as keyof typeof KEYS]
      expect(english).toBe(EN[`chat.permissionRemember.${key}`]!)
      expect(russian).toBe(RU[`chat.permissionRemember.${key}`]!)
    }
    const [english, russian]: readonly string[] = CARD_SCOPE_FOOTNOTES.dangerousSessionOnly
    expect(EN['chat.permissionRemember.dangerous']!.startsWith(english)).toBe(true)
    expect(RU['chat.permissionRemember.dangerous']!.startsWith(russian)).toBe(true)
    expect<string[]>([...CARD_DURABLE_LABELS]).toEqual([EN['chat.permissionAlwaysAllow']!, RU['chat.permissionAlwaysAllow']!])
  })

  it('a Russian repository card reads scope repository with a durable answer offered', async () => {
    const read = await readCard(cardPage(
      `Требуется разрешение Bash npm test ${RU['chat.permissionRemember.repository']}`,
      ['Разрешить', RU['chat.permissionAlwaysAllow']!, 'Отклонить'],
    ))
    expect(read.present).toBe(true)
    expect(read.scope).toBe('repository')
    expect(read.durableOffered).toBe(true)
  })

  it('NEGATIVE — a Russian session-only card offers no durable answer, and its scope is the dangerous one', async () => {
    const read = await readCard(cardPage(
      `Требуется разрешение Bash rm -rf x ${RU['chat.permissionRemember.dangerous']}`,
      ['Разрешить', RU['chat.permissionAlwaysAllow.sessionOnly']!, 'Отклонить'],
    ))
    expect(read.scope).toBe('dangerous-session-only')
    expect(read.durableOffered).toBe(false)
  })

  it('BOUNDARY — the English card still reads, and a card with no footnote reads scope null', async () => {
    const english = await readCard(cardPage(
      `Permission Required Bash npm test ${EN['chat.permissionRemember.session']}`,
      ['Allow', EN['chat.permissionAlwaysAllow']!, 'Deny'],
    ))
    expect(english.scope).toBe('session')
    expect(english.durableOffered).toBe(true)
    const bare = await readCard(cardPage('Требуется разрешение Bash ls', ['Разрешить', 'Отклонить']))
    expect(bare.scope).toBeNull()
    expect(bare.durableOffered).toBe(false)
  })
})
