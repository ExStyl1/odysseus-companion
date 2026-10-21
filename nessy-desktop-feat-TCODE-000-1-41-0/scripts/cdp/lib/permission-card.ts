/**
 * The tool-PERMISSION card, read and answered by a case that is ABOUT it —
 * `readCard`, `pressCard`, `ensureNoCard` and `shellArm`, one definition each
 * (F1.183, origin WJ-j `P-WJ-j-2`).
 *
 * ## Why these four live here
 *
 * They were written three times, in `rs-103.ts`, `rs-104.ts` and `rs-108.ts`,
 * and the copies had already drifted: RS-103 read the card's text with its lines
 * joined by `|` and cut at 500 characters, and dismissed a leftover card without
 * waiting for it to clear; RS-104 and RS-108 collapsed whitespace, cut at 600,
 * read the scope footnote, and waited for the card to leave. The two-button-shape
 * trap they all encode (a `visibility: hidden` measuring copy in front of the
 * visible card) was paid for once by SIT-9 and is `findCardButton`'s to solve
 * (`lib/ask-user.ts`), so each helper here goes through it rather than
 * restating it. The richest of the three shapes is the one kept: it is a
 * superset of the others' reads, and a card left standing between two arms is
 * exactly the RS-13 trap a dismissal that does not wait for the card to clear
 * can still fall into.
 *
 * `approvePermissionsWhile` (`lib/ask-user.ts`) is the other permission-card
 * reader, and it is not this: it answers every card in the background for a
 * case whose subject is something else. These are for the cases whose subject
 * IS the card — what it offers, what it promises, what one click writes.
 *
 * In a separate file rather than appended to `lib/ask-user.ts` (where
 * `P-WJ-j-2` proposed them) for one reason: `scripts/eslint.config.mjs` cites
 * `ask-user.ts` by line, and the imports these helpers need would shift every
 * one of those lines.
 */

import { findCardButton, PERMISSION_BANNER } from './ask-user.ts'
import { sendPrompt } from './chat.ts'
import type { CdpSession } from './connect.ts'
import { transcript, type SessionKey } from './state.ts'
import { clickAt } from './viewport.ts'

/**
 * The footnotes a card carries about what "Always Allow" will do — read into {@link CardRead.scope}.
 *
 * Each scope is matched in English and in Russian (UB12.46): the card speaks the app's UI language,
 * and an English-only list read every Russian card as `scope: null`. The sentences are the
 * `chat.permissionRemember.*` values of `en.json` / `ru.json`, `dangerousSessionOnly` the head of
 * `chat.permissionRemember.dangerous`; `permission-card.test.ts` pins both twins to the locale files.
 */
export const CARD_SCOPE_FOOTNOTES = {
  repository: ['"Always Allow" saves this command for the repository', '«Разрешить всегда» сохраняет эту команду для репозитория'],
  session: ['"Always Allow" remembers this for the session', '«Разрешить всегда» запоминает это на время сессии'],
  workspace: [
    '"Always Allow" saves a rule for this command in the workspace permissions',
    '«Разрешить всегда» сохраняет правило для этой команды в разрешениях рабочего пространства',
  ],
  dangerousSessionOnly: ['This command is never saved for later', 'Эта команда не сохраняется на будущее'],
} as const

/**
 * The DURABLE answer's label (`chat.permissionAlwaysAllow`) in English and Russian, matched
 * case-insensitively into {@link CardRead.durableOffered} — the same two-language rule as the
 * footnotes (UB12.46). The session-only label (`chat.permissionAlwaysAllow.sessionOnly`) is not one.
 */
export const CARD_DURABLE_LABELS = ['Always Allow', 'Разрешить всегда'] as const

export interface CardRead {
  present: boolean
  /** The visible card's text, whitespace collapsed, at most 600 characters. */
  text: string
  /** Every VISIBLE button's label, in order. */
  labels: string[]
  /** What the card promises: `repository`, `workspace` (F1.1236, codex), `session`, or `dangerous-session-only`. */
  scope: 'repository' | 'workspace' | 'session' | 'dangerous-session-only' | null
  /** Whether a DURABLE button ("Always Allow", either language: {@link CARD_DURABLE_LABELS}) is offered at all. */
  durableOffered: boolean
}

const NO_CARD: CardRead = { present: false, text: '', labels: [], scope: null, durableOffered: false }

/**
 * The permission card on screen now — the LAST visible match, which is the
 * visible copy and never the hidden measuring one in front of it.
 *
 * A page error is "no card": every caller is mid-turn, and a card that vanished
 * between the query and the read is the ordinary case.
 */
export async function readCard(session: CdpSession): Promise<CardRead> {
  return session.call<CardRead>(`
    const vis = el => { const st = getComputedStyle(el); return st.visibility !== 'hidden' && st.display !== 'none' && el.getClientRects().length > 0 }
    const cards = Array.from(document.querySelectorAll(${JSON.stringify(PERMISSION_BANNER)})).filter(vis)
    if (cards.length === 0) return ${JSON.stringify(NO_CARD)}
    const card = cards[cards.length - 1]
    const text = (card.innerText || '').replace(/\\s+/g, ' ').trim()
    const notes = ${JSON.stringify(CARD_SCOPE_FOOTNOTES)}
    const says = twins => twins.some(note => text.includes(note))
    const durable = ${JSON.stringify(CARD_DURABLE_LABELS)}.map(l => l.toLowerCase())
    const labels = Array.from(card.querySelectorAll('button')).filter(vis).map(b => (b.innerText || '').replace(/\\s+/g, ' ').trim())
    return {
      present: true,
      text: text.slice(0, 600),
      labels,
      scope: says(notes.repository) ? 'repository'
        : says(notes.workspace) ? 'workspace'
        : says(notes.dangerousSessionOnly) ? 'dangerous-session-only'
          : says(notes.session) ? 'session' : null,
      durableOffered: labels.some(l => durable.some(d => l.toLowerCase().includes(d))),
    }
  `).catch(() => ({ ...NO_CARD }))
}

/**
 * The OPEN chat's `awaitingApprovalCount`: the chat whose card is on screen,
 * found by its selected row (as `activeSession` in `lib/state.ts` finds it). It
 * is `null` when that cannot be read: no single selected row, the chat not
 * listed, or the field not a number.
 */
async function openChatAwaitingCount(session: CdpSession): Promise<number | null> {
  return session.call<number | null>(`
    const rows = document.querySelectorAll('.session-item[data-selected]')
    if (rows.length !== 1) return null
    const id = rows[0].getAttribute('data-session-id')
    const s = ((await window.electronAPI.getSessions()) || []).find(x => x.id === id)
    return s && typeof s.awaitingApprovalCount === 'number' ? s.awaitingApprovalCount : null
  `).catch(() => null)
}

/**
 * Press the first of `labels` that EXISTS on this card, and require the PRESSED
 * card to clear within 25 s. Returns the label pressed, or a sentence saying why
 * nothing was — never throws, so an arm reports it rather than dying on it.
 *
 * ## "Cleared" is about the pressed card, not the screen (F1.976)
 *
 * The rule was "no card on screen". At an awaiting count of two or more, the
 * next card takes the pressed one's place, so a press that WAS delivered read
 * as "did not clear". All three SIT-an lanes met it (WJ-co-sit4 step 2), and a
 * driver that retries on that word presses the NEXT card.
 *
 * The page carries no request id for a card (`PermissionRequest.tsx` renders
 * none), so the pressed card is tracked by the open chat's awaiting count: a
 * drop below the count read just before the click means the press landed. The
 * card leaving the screen still counts too. When the count cannot be read, that
 * old rule is all there is. The residue: a card the count does not include (the
 * D1.347 blind class) is judged by the old rule alone.
 */
export async function pressCard(
  session: CdpSession,
  labels: readonly string[],
  what: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string> {
  return (await pressAndJudge(session, labels, what, options)).said
}

/** {@link pressCard}'s press, and whether it was delivered by that function's rule. */
async function pressAndJudge(
  session: CdpSession,
  labels: readonly string[],
  what: string,
  options: { timeoutMs?: number; intervalMs?: number },
): Promise<{ delivered: boolean; said: string }> {
  const hit = await findCardButton(session, { card: PERMISSION_BANNER, labels, prefer: 'last' })
  if (!hit) return { delivered: false, said: `no matching button among ${JSON.stringify((await readCard(session)).labels)}` }
  const before = await openChatAwaitingCount(session)
  await clickAt(session, { x: hit.x, y: hit.y }, what)
  const deadline = Date.now() + (options.timeoutMs ?? 25_000)
  while (Date.now() < deadline) {
    if (!(await readCard(session)).present) return { delivered: true, said: hit.text }
    if (before !== null) {
      const now = await openChatAwaitingCount(session)
      if (now !== null && now < before) return { delivered: true, said: hit.text }
    }
    await Bun.sleep(options.intervalMs ?? 500)
  }
  return { delivered: false, said: `pressed ${hit.text} but the card did not clear` }
}

/**
 * How many delivered denials {@link ensureNoCard} makes before it stops with a
 * card still up. The sittings met two cards at once (F1.976); five leaves room
 * and still ends. A chosen number, not a measured one.
 */
export const LEFTOVER_CARD_DENIALS = 5

/**
 * Nothing may leak into the next arm — the RS-13 trap, met again by SIT-9.
 *
 * ## Every leftover card, bounded (F1.991)
 *
 * It pressed Deny once. At an awaiting count of two or more the next card takes
 * the denied one's place (F1.976's finding), so one card still leaked into the
 * next arm. It now denies until no card is on screen, and stops early in two
 * cases:
 *
 * - **a denial that was not delivered** ({@link pressCard}'s rule). Pressing
 *   again would press the same card, or the next one, blind.
 * - **{@link LEFTOVER_CARD_DENIALS} delivered denials with a card still up.** A
 *   turn that raises a new card for every denial would otherwise hold the arm
 *   forever.
 *
 * Either way it says so on stderr, where `CaseRun.observe` writes, so every
 * case's log carries it with no case edit. It returns that sentence, or `null`
 * when the screen is clear. The residue: a card that renders only after the
 * read that found the screen clear is not seen.
 */
export async function ensureNoCard(
  session: CdpSession,
  label: string,
  options: { maxDenials?: number; timeoutMs?: number; intervalMs?: number } = {},
): Promise<string | null> {
  const most = options.maxDenials ?? LEFTOVER_CARD_DENIALS
  let denied = 0
  let why: string
  for (;;) {
    if (!(await readCard(session)).present) return null
    if (denied >= most) {
      why = `${denied} denials delivered and a card is still up`
      break
    }
    const press = await pressAndJudge(session, ['deny'], `${label}: forced dismissal of leftover card ${denied + 1}`, options)
    if (!press.delivered) {
      why = `denial ${denied + 1} was not delivered (${press.said})`
      break
    }
    denied += 1
  }
  const said = `${label}: a leftover permission card is still up: ${why}. It can leak into the next arm (RS-13).`
  console.error(`  · ${said}`)
  return said
}

export interface ShellArm {
  /** A card was raised for this turn. */
  asked: boolean
  /** The model really issued a Bash call — the half that keeps `asked: false` honest. */
  attempted: boolean
  card: CardRead | null
  pressed: string
  commands: string[]
}

/**
 * One shell-command turn with a card watcher beside it.
 *
 * `answer` names the labels to press, or `null` to leave the card standing and
 * read it — the arms that are ABOUT the buttons on offer pass `null` and then
 * dismiss it themselves. `attempted` is read off the transcript's own tool rows,
 * so "the model never issued the command" is a state of its own and never reads
 * as "the floor let it through" — three arms of one sitting were exactly that.
 */
export async function shellArm(
  session: CdpSession,
  key: SessionKey,
  label: string,
  command: string,
  answer: readonly string[] | null,
): Promise<ShellArm> {
  await ensureNoCard(session, label)
  const before = (await transcript(session, key)).length
  let card: CardRead | null = null
  let pressed = '(no card)'
  let asked = false
  // VERBATIM, or the model wraps it in `cd "<dir>" && …` and one arm measures
  // another arm's question (SIT-9 rig finding 4).
  const prompt = 'Run this exact shell command and show me its output. Use it verbatim as the whole command, '
    + `with nothing before it and nothing after it: ${command}`
  const turn = sendPrompt(session, key, prompt, 300_000).catch(() => undefined)
  const watch = (async () => {
    const deadline = Date.now() + 290_000
    while (Date.now() < deadline) {
      await Bun.sleep(1_200)
      const seen = await readCard(session)
      if (!seen.present) continue
      asked = true
      card = seen
      if (answer === null) return
      pressed = await pressCard(session, answer, label)
      return
    }
  })()
  await turn
  await watch
  const rows = (await transcript(session, key)).slice(before)
  const commands = rows
    .map(row => row.toolInput?.command)
    .filter((value): value is string => typeof value === 'string')
  return { asked, attempted: commands.length > 0, card, pressed, commands }
}
