/**
 * RS-100 (D1.392) - the `/btw` side-question panel wears the SAME shell as the
 * popover the Sources page's "+" opens, in both locales, on a packaged build.
 *
 * ## The row
 *
 * D1.392 is the owner's ruling of 2026-09-19, made with two screenshots: the
 * shipped side-question panel had grown a title row, a four-hint footer and a
 * box half again as wide as the agent-driven add popover, and its composer
 * advertised the MAIN composer's rotating tip - a sidebar shortcut, inside a
 * popover with no sidebar in it. `7011c3bf4` extracted the shell into
 * `components/ui/compact-chat-card.tsx` and made both render through it.
 *
 * Three earlier checklist ids fold into this one as arms, because they are the
 * same panel measured in the same pass and a sitting that opens it four times
 * pays for four openings: RS-101 was D1.384 (a `/btw` typed INSIDE the panel)
 * and RS-102 was D1.383 (no `queueGet` for a renderer-minted session id). The
 * empty-state sentence that was RS-100's own subject (D1.382) is arm A's first
 * assertion.
 *
 * ## What each arm measures, and what makes its reading mean anything
 *
 * A. THE SHELL, against the reference in the SAME session. The panel's card and
 *    the add popover's card must report the same width, the same grip icon and
 *    the same card classes, and the panel must carry no title row, no footer and
 *    the empty-state sentence centred. The CONTROL is the reference card itself:
 *    it is four shipped call sites (three add-source variants plus add-skill)
 *    and its own copy must still read as it always did - a shared shell that
 *    restyled the surface it came from is a regression, not a fix. Reading both
 *    in one session is also what makes "the same width" a measurement rather
 *    than two numbers taken at different window sizes.
 *
 * B. THE PLACEHOLDER. The panel's composer must invite a question about the
 *    chat. The forbidden set is not a guess: it is every value of a
 *    `chatInput.placeholder.*` key, read out of the locale file, because the bug
 *    was the panel falling through to that rotation. The CONTROL is the MAIN
 *    composer's own placeholder read in the same instant - it must still be one
 *    of those strings, which proves the rotation is alive and that the panel is
 *    opting out of it rather than the app having stopped rotating.
 *
 * C. BOTH LOCALES. The same two readings after switching the language and
 *    reloading, and the language is put back in a `finally`. The sentences are
 *    read out of `packages/shared/src/i18n/locales/<lang>.json` rather than
 *    spelled here, so this case cannot drift from the copy it is checking; when
 *    the two disagree the failure detail prints both strings, because a packaged
 *    artefact older than the tree is a third possibility that must not read as a
 *    product defect.
 *
 * D. THE PANEL IS A THREAD (D1.399), and the behaviour around it did not
 *    regress. Three questions in a row must render as SIX bubbles in order,
 *    oldest at the top and newest at the BOTTOM, the view scrolled to the
 *    newest, with the dimmed earlier-answers list GONE and the arrow keys doing
 *    nothing - R36 had built `interactive-mode.md`'s ring literally, one
 *    displayed exchange with a truncated list above it, and D1.399 records the
 *    three deviations that replaced it. The hint line is THREE hints, copy,
 *    clear and dismiss, and never the stepping one. `c` copies the LATEST
 *    answer, `x` empties the thread and takes the hint line with it, Escape
 *    dismisses. A `/btw` typed inside the panel is still asked with the prefix
 *    stripped and opens no second panel, and no `[ChatInputZone] Failed to
 *    hydrate queue` is logged.
 *
 *    The arrow arm needs its own note, because the obvious way to write it
 *    cannot fail: "nothing happened" is equally true of a key that did nothing
 *    and of a read taken where nothing WOULD have changed. So it is driven on a
 *    thread of THREE exchanges - the state the old ring could visibly step
 *    through - and compares the bubble TEXTS, which the old stepping changed on
 *    every press.
 *
 * E. A SIDE QUESTION ON A CHAT THAT HAS NEVER RUN A TURN (D1.398). The panel
 *    must answer, and it must never render a bare identifier as the text of the
 *    bubble. These are scored SEPARATELY on purpose: the second is the half
 *    D1.398 built a locale table for, and measured 2026-09-20 (SIT-9) it holds
 *    while the first does not - the start is attempted and the answer still
 *    comes back refused, so a single merged check would report the sentence
 *    table as broken when it is the only half that works. The CONTROL is arm
 *    D's own chat, which answers the same question after one ordinary turn, and
 *    it is what makes a failure here a cold-start fact rather than a dead rig.
 *    The session record is read before and after: a side question must leave the
 *    transcript's message count exactly where it was.
 *
 * ## Two instruments this case installs, each with its own control
 *
 * THE CONSOLE CAPTURE. `Runtime.consoleAPICalled` with `Runtime.enable`, and a
 * planted line of its own at the end: "no hydrate error was logged" and "no
 * console event ever reached me" are the same reading without it. Measured
 * 2026-09-19 (SIT-8): the packaged build logs so little that the whole drive
 * produced ONE console line, so the planted control is not a formality here.
 *
 * THE `queueGet` RECORDER. The hydrate effect reads `window.electronAPI.queueGet`
 * at call time (`input/ChatInputZone.tsx`), so a wrapper that records its
 * argument and forwards sees every call. It turns D1.383 from "no error was
 * logged" into the positive form the row is actually about: the REAL session's
 * id IS asked for - which is the control, since a recorder nothing passes
 * through reports the same zero as a fixed product - and no `side-question:` id
 * ever is. The wrapper is removed in the `finally`.
 *
 * ## Rig facts this case encodes, each paid for by a run
 *
 * - A DETACHED app window has no display: `visibilityState` is `hidden`,
 *   `document.hasFocus()` is false, and this panel is a Radix popover whose
 *   lifetime is focus-driven, so it mounts and is removed about 15 ms later
 *   (SIT-7, row D1.395). `Emulation.setFocusEmulationEnabled` plus
 *   `Page.setWebLifecycleState` restore both, and they must be re-asserted after
 *   `freshSession()` and after every reload - which is why {@link focusWindow}
 *   is called at each of those points rather than once at the top.
 * - `Escape` is never used to close the slash palette: it also dismisses the
 *   panel. The palette's own SELECTION is the path, and selecting the `/btw`
 *   entry opens the panel EMPTY, which is the state the owner photographed.
 * - A side question now STARTS the chat's agent when there is none (D1.398),
 *   so a chat that has never run a turn is no longer turned away with a bare
 *   internal identifier printed as the bubble's text. Arm E drives exactly that.
 *   The seed turn arm D still takes is for the TRANSCRIPT the side channel
 *   answers from, not for the agent - which is why arm E can omit it and still
 *   be a fair question.
 */

import { join } from 'node:path'
import { focusWindow, type CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, setPermissionMode, transcript } from '../lib/state.ts'
import { selectSlashCommand } from '../lib/composer.ts'
import { sendPrompt } from '../lib/chat.ts'
import { typeText, pressKey } from '../lib/keys.ts'
import { clickAt, clickSelector } from '../lib/viewport.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import type { CaseMeta } from '../lib/sitting.ts'

const ID = 'RS-100'
const TITLE = 'the /btw panel wears the agent-driven add popover\'s shell, in both locales, on the packaged build'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.392',
  runtimes: ['pi', 'claude', 'codex'],
  credentials:
    'owner: any ONE card that answers a turn - arm D reads a thread of real answers, and arm E asks the same card on '
    + 'a chat that has deliberately never run one. No key, token or credential file is '
    + 'read, and nothing is written outside the config dir the run was launched with.',
} as const satisfies CaseMeta

/** The panel's card, by the test id `SideQuestionPanel` gives `CompactChatCard`. */
const PANEL = '[data-testid="side-question-panel"]'

/** Every compact card on screen - the panel's and the add popover's are both this. */
const COMPACT_CARD = '.bg-foreground-2.shadow-modal-small'

/** The panel's own composer, which is a `contenteditable` DIV and never a textarea. */
const PANEL_COMPOSER = `${PANEL} div[data-tutorial="chat-input"][role="textbox"]`

/** The Sources page's "+", which opens the reference card. */
const ADD_SOURCE_BUTTON = '[data-tutorial="add-source-button"]'

/** The line D1.383 is about. Its ABSENCE is the finding; the recorder is the control. */
const HYDRATE_ERROR = 'Failed to hydrate queue'

/** The planted line that proves the console capture can see anything at all. */
const CONSOLE_CONTROL = 'RS-100-console-instrument-control'

interface PanelReading {
  panels: number
  text: string
  width: number
  height: number
  ariaLabel: string | null
  cardClass: string | null
  gripIcon: string | null
  placeholder: string | null
  mainPlaceholders: (string | null)[]
  hintLines: number
  hintText: string | null
  earlier: string[]
  /**
   * The thread's message bubbles, oldest first, each with the `top` of its own
   * box so ORDER is read off the layout rather than off the DOM order.
   *
   * The selector is DERIVED from the panel's own markup and not guessed: there
   * is no `data-message-role` in this tree, and a first draft that asked for one
   * reported an empty thread about a panel showing six bubbles. A user turn is
   * `bg-user-message-bubble`; an answer is the `markdown-content` block the
   * compact `ChatDisplay` renders. Nested matches are dropped so one bubble is
   * one entry.
   */
  bubbles: { role: string; top: number; text: string }[]
  /** Null when nothing in the panel scrolls - a short thread is not a failure. */
  scrolledToBottom: boolean | null
  sentenceCentre: number | null
  panelCentre: number | null
}

/** Everything arms A, B and D read off the panel, in ONE round trip. */
async function readPanel(session: CdpSession, sentence: string): Promise<PanelReading> {
  return session.call<PanelReading>(`
    const empty = { panels: 0, text: '', width: 0, height: 0, ariaLabel: null, cardClass: null, gripIcon: null,
      placeholder: null, mainPlaceholders: [], hintLines: 0, hintText: null, earlier: [], bubbles: [],
      scrolledToBottom: null, sentenceCentre: null, panelCentre: null }
    const panel = document.querySelector(${JSON.stringify(PANEL)})
    if (!panel) return empty
    const rect = panel.getBoundingClientRect()
    const divs = Array.from(panel.querySelectorAll('div'))
    // The hint LINE, not every ancestor that contains it: a naive filter counts
    // the wrapper too and reports two lines where the product renders one.
    const hinted = divs.filter(el => /← \\/ →/.test(el.innerText || ''))
    const leaf = hinted.filter(el => !hinted.some(other => other !== el && el.contains(other)))
    const sentence = Array.from(panel.querySelectorAll('*'))
      .find(el => el.children.length === 0 && (el.textContent || '').includes(${JSON.stringify(sentence)}))
    const sentenceRect = sentence ? sentence.getBoundingClientRect() : null
    const editable = panel.querySelector('[contenteditable="true"]')
    const outside = Array.from(document.querySelectorAll('div[data-tutorial="chat-input"][role="textbox"]'))
      .filter(el => !panel.contains(el))
    // D1.399's thread. See {@link PanelReading.bubbles} for why these two
    // selectors and not a role attribute.
    const userSel = '[class*="bg-user-message-bubble"]'
    const answerSel = '.markdown-content'
    const nodes = Array.from(panel.querySelectorAll(userSel + ',' + answerSel))
    const bubbles = nodes
      .filter(el => !nodes.some(other => other !== el && other.contains(el)))
      .map(el => ({
        role: el.matches(userSel) ? 'user' : 'answer',
        top: Math.round(el.getBoundingClientRect().top),
        text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 400),
      }))
    const scroller = panel.querySelector('[data-radix-scroll-area-viewport]')
    const scrolls = scroller && scroller.scrollHeight > scroller.clientHeight + 4
    return {
      panels: document.querySelectorAll(${JSON.stringify(PANEL)}).length,
      text: (panel.innerText || '').replace(/\\s+/g, ' ').trim(),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      ariaLabel: panel.getAttribute('aria-label'),
      cardClass: panel.className,
      gripIcon: (panel.querySelector(':scope > div.absolute svg') || { getAttribute: () => null }).getAttribute('class'),
      placeholder: editable ? editable.getAttribute('aria-placeholder') : null,
      mainPlaceholders: outside.map(el => el.getAttribute('aria-placeholder')),
      hintLines: leaf.length,
      hintText: leaf.length ? (leaf[0].innerText || '').replace(/\\s+/g, ' ').trim() : null,
      earlier: Array.from(panel.querySelectorAll('div.truncate')).map(el => (el.textContent || '').trim()),
      bubbles,
      scrolledToBottom: scrolls
        ? (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) <= 8
        : null,
      sentenceCentre: sentenceRect ? Math.round(sentenceRect.x + sentenceRect.width / 2) : null,
      panelCentre: Math.round(rect.x + rect.width / 2),
    }
  `)
}

interface CardReading {
  testId: string | null
  width: number
  height: number
  cardClass: string
  gripIcon: string | null
  text: string
  placeholder: string | null
}

/** Every compact card on screen - the reference card is the one with no test id. */
async function readCards(session: CdpSession): Promise<CardReading[]> {
  return session.call<CardReading[]>(`
    return Array.from(document.querySelectorAll(${JSON.stringify(COMPACT_CARD)})).map(card => {
      const rect = card.getBoundingClientRect()
      const editable = card.querySelector('[contenteditable="true"]')
      return {
        testId: card.getAttribute('data-testid'),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        cardClass: card.className,
        gripIcon: (card.querySelector(':scope > div.absolute svg') || { getAttribute: () => null }).getAttribute('class'),
        text: (card.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
        placeholder: editable ? editable.getAttribute('aria-placeholder') : null,
      }
    })
  `)
}

/**
 * Type into the PANEL's composer and send, and REPORT whether the send took.
 *
 * The panel passes `disableSend={pending}` - one question at a time, so the ring
 * cannot overwrite an answer the user is waiting for. A send refused for that
 * reason leaves the text sitting in the composer, where `panel.innerText` still
 * reads it: measured 2026-09-19 (SIT-8, first drive of this file), a `/btw ...`
 * typed one second too early stayed in the box and the case reported *the
 * prefix was not stripped* - a product FAIL written about a question that had
 * never been asked. So the caller asserts on `submitted` before reading D1.384's
 * subject at all.
 */
async function askInPanel(session: CdpSession, text: string): Promise<{ submitted: boolean; leftInComposer: string }> {
  await session.call(`document.querySelector(${JSON.stringify(PANEL_COMPOSER)})?.focus(); return true`)
  await Bun.sleep(200)
  await typeText(session, text, { charDelayMs: 12 })
  await Bun.sleep(250)
  await pressKey(session, 'Enter')
  await Bun.sleep(600)
  const left = await session.call<string>(`
    const el = document.querySelector(${JSON.stringify(PANEL_COMPOSER)})
    return el ? (el.innerText || '').trim() : ''
  `)
  return { submitted: left === '', leftInComposer: left }
}

/** Open the panel EMPTY, through the palette's own selection (never a typed Enter). */
async function openEmptyPanel(session: CdpSession): Promise<void> {
  await selectSlashCommand(session, { token: 'btw', match: /side question|побочн/i, expectComposer: '' })
  await Bun.sleep(900)
}

/** Wait for the in-flight word to go away, or give up and let the reading say so. */
async function settle(session: CdpSession, sentence: string, thinking: string, seconds = 120): Promise<PanelReading> {
  let reading = await readPanel(session, sentence)
  for (let i = 0; i < seconds; i += 1) {
    if (reading.panels > 0 && !reading.text.includes(thinking)) return reading
    await Bun.sleep(1_000)
    reading = await readPanel(session, sentence)
  }
  return reading
}

type Locale = Record<string, string>

/** The copy this case checks against, read from the tree rather than spelled here. */
async function locale(lang: string): Promise<Locale> {
  const path = join(import.meta.dir, '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales', `${lang}.json`)
  return Bun.file(path).json() as Promise<Locale>
}

/** Every string the MAIN composer rotates - the set the panel must not be drawing from. */
function mainComposerTips(strings: Locale): string[] {
  return Object.entries(strings)
    .filter(([key]) => key.startsWith('chatInput.placeholder.'))
    .map(([, value]) => value.replace(/\{\{key\}\}/g, '').trim())
}

/** The three sentences the panel rotates, and the sentence it greets with. */
function sideQuestionCopy(strings: Locale): {
  placeholders: string[]; sentence: string; title: string; hints: string[]
  copyHint: string; clearHint: string; dismissHint: string; errorGeneric: string
} {
  return {
    placeholders: [1, 2, 3].map(n => strings[`chat.sideQuestion.placeholder${n}`] ?? ''),
    sentence: strings['chat.sideQuestion.emptyState'] ?? '',
    title: strings['chat.sideQuestion.title'] ?? '',
    // `stepHint` is DELETED by D1.399 and is kept in this list on purpose: the
    // empty-state arm asserts that NO hint is drawn, and a key that came back
    // would have to come back here first.
    hints: ['stepHint', 'copyHint', 'clearHint', 'dismissHint'].map(k => strings[`chat.sideQuestion.${k}`] ?? ''),
    copyHint: strings['chat.sideQuestion.copyHint'] ?? '',
    clearHint: strings['chat.sideQuestion.clearHint'] ?? '',
    dismissHint: strings['chat.sideQuestion.dismissHint'] ?? '',
    errorGeneric: strings['chat.sideQuestion.error.generic'] ?? '',
  }
}

/** Arms A and B, in whichever locale the app is currently showing. */
async function readShellAndPlaceholder(
  run: CaseRun, session: CdpSession, lang: string, strings: Locale,
): Promise<void> {
  const copy = sideQuestionCopy(strings)
  const tips = mainComposerTips(strings)
  await openEmptyPanel(session)
  const panel = await readPanel(session, copy.sentence)
  run.observe(`${lang}: the empty panel`, panel)

  run.check(
    `${lang}: the panel is open and says the side question's own sentence`,
    panel.panels === 1 && panel.text.includes(copy.sentence),
    `expected exactly one panel greeting with ${JSON.stringify(copy.sentence)}; ${panel.panels} panel(s) read `
    + `${JSON.stringify(panel.text.slice(0, 160))}. A mismatch here can also be a packaged artefact older than this `
    + 'tree - compare the bundle mtime against the commit that landed the copy before calling it a product defect.',
  )
  run.check(
    `${lang}: no title row and no hint footer in the empty state`,
    !panel.text.includes(copy.title) && copy.hints.every(hint => hint === '' || !panel.text.includes(hint)),
    `the card still draws the header or the footer: ${JSON.stringify(panel.text.slice(0, 200))}`,
  )
  run.check(
    `${lang}: the title survives as the card's accessible name`,
    panel.ariaLabel === copy.title,
    `a dialog with no visible heading still needs a name; aria-label is ${JSON.stringify(panel.ariaLabel)}`,
  )
  run.check(
    `${lang}: the grip dots are the card's header`,
    (panel.gripIcon ?? '').includes('grip-horizontal'),
    `no grip icon inside the card; read ${JSON.stringify(panel.gripIcon)}`,
  )
  run.check(
    `${lang}: the empty-state sentence is centred in the card`,
    panel.sentenceCentre !== null && panel.panelCentre !== null && Math.abs(panel.sentenceCentre - panel.panelCentre) <= 2,
    `sentence centre ${panel.sentenceCentre} against card centre ${panel.panelCentre}`,
  )

  // ---- arm B, and its control in the same reading -------------------------
  const chosen = panel.placeholder ?? ''
  run.check(
    `${lang}: the panel's composer invites a question about the chat`,
    copy.placeholders.includes(chosen),
    `the composer says ${JSON.stringify(chosen)}, which is none of ${JSON.stringify(copy.placeholders)}`,
  )
  run.check(
    `${lang}: and it is not the main composer's rotating tip`,
    chosen !== '' && !tips.some(tip => tip !== '' && chosen.includes(tip)),
    `the panel is drawing from the main composer's rotation: ${JSON.stringify(chosen)}`,
  )
  const main = panel.mainPlaceholders.filter((value): value is string => typeof value === 'string' && value.length > 0)
  run.observe(`${lang}: CONTROL - the main composer's placeholder in the same read`, main)
  run.check(
    `${lang}: CONTROL - the main composer is still rotating those tips`,
    main.length > 0 && main.every(value => tips.some(tip => tip !== '' && value.includes(tip.slice(0, 12)))),
    'the main composer shows no `chatInput.placeholder.*` string, so "the panel is not using them" is equally true of '
    + `an app that stopped rotating them: read ${JSON.stringify(main)}`,
  )
}

/** The reference card the owner pointed at, opened from the Sources page's "+". */
async function readReferenceCard(run: CaseRun, session: CdpSession, lang: string, sourcesLabel: string): Promise<CardReading | undefined> {
  // The label is the LOCALE's, never the English word: the sidebar row reads
  // the Russian word on a Russian app and an English pattern finds nothing,
  // which reports as "the Sources page was not reachable" - a rig silence that
  // looks like a layout fact. Its own count badge rides the same element, so the
  // remainder after the label is digits.
  //
  // THE REMAINDER IS TESTED WITHOUT A REGEX, on purpose. This is page source
  // carried inside a TEMPLATE LITERAL, and an unknown escape in one loses its
  // backslash: a `\d` written here arrives in the page as a plain `d`, so the
  // test asks whether the count badge is spelled with the letter d and answers
  // NO for every row that exists. Measured 2026-09-19 (SIT-8) - it cost three
  // drives, and each one reported the reference card as unreachable, which
  // reads like a layout fact rather than a broken matcher. Any character class
  // this file sends to the page must be written with a DOUBLED backslash; the
  // three `replace(/\\s+/g, ' ')` calls above are the worked examples.
  const row = await session.call<{ x: number; y: number } | null>(`
    const label = ${JSON.stringify(sourcesLabel)}
    const digits = '0123456789'
    const hits = Array.from(document.querySelectorAll('*')).filter(el => {
      const text = (el.textContent || '').trim()
      if (!text.startsWith(label)) return false
      const rest = text.slice(label.length).trim()
      return rest.split('').every(ch => digits.includes(ch))
    })
    // The LAST VISIBLE hit, never simply the last: the deepest match can be a
    // zero-size node, and refusing on it reports "the Sources page was not
    // reachable in this layout" about a row that is on screen - measured
    // 2026-09-19 (SIT-8, second drive), where it cost arm A its whole control.
    const visible = hits.filter(el => el.getBoundingClientRect().width > 0)
    const el = visible[visible.length - 1]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  `)
  if (!row) {
    run.observe(`${lang}: the reference card`, `no sidebar row reads ${JSON.stringify(sourcesLabel)}`)
    return undefined
  }
  await clickAt(session, row, 'the Sources sidebar row')
  await Bun.sleep(2_500)
  const buttons = await session.call<number>(`return document.querySelectorAll(${JSON.stringify(ADD_SOURCE_BUTTON)}).length`)
  if (buttons === 0) {
    // The two ways this returns nothing are DIFFERENT facts and were one
    // observation until the second drive spent a run on it: a row nobody can
    // find, and a click that never navigated. The commonest cause of the second
    // is a popover still open over the page - Radix closes it on the outside
    // click and swallows that click, so the first press only dismisses.
    run.observe(`${lang}: the reference card`, 'the Sources row was clicked and the page shows no "+" button')
    return undefined
  }
  await clickSelector(session, ADD_SOURCE_BUTTON)
  await Bun.sleep(1_500)
  await focusWindow(session)
  const cards = await readCards(session)
  run.observe(`${lang}: the compact cards on screen with the add popover open`, cards)
  return cards.find(card => card.testId === null)
}

/**
 * Switch the app's language the way its own Appearance picker persists it, and
 * reload so the renderer's in-memory i18n and `localStorage` agree.
 */
async function setLanguage(session: CdpSession, lang: string): Promise<void> {
  await session.call(`
    window.localStorage.setItem('i18nextLng', ${JSON.stringify(lang)})
    await window.electronAPI?.changeLanguage?.(${JSON.stringify(lang)})
    return true
  `)
  await session.send('Page.reload', {})
  await Bun.sleep(6_000)
  await focusWindow(session)
}

/**
 * Wrap `window.electronAPI.queueGet` so every argument is recorded and forwarded.
 *
 * The hydrate effect reads the method off `window.electronAPI` at CALL time
 * (`input/ChatInputZone.tsx`), so a wrapper installed later still sees it. This
 * is the only instrument that can state D1.383 in its positive form.
 */
async function installQueueRecorder(session: CdpSession): Promise<boolean> {
  return session.call<boolean>(`
    if (!window.__rs100QueueGet) {
      const original = window.electronAPI.queueGet.bind(window.electronAPI)
      window.__rs100QueueGet = { calls: [], original }
      window.electronAPI.queueGet = (id) => { window.__rs100QueueGet.calls.push(id); return original(id) }
    }
    return Array.isArray(window.__rs100QueueGet.calls)
  `)
}

/** Take what the recorder has seen so far - call it BEFORE every reload. */
async function drainQueueRecorder(session: CdpSession): Promise<string[]> {
  return session.call<string[]>(`
    if (!window.__rs100QueueGet) return []
    const seen = window.__rs100QueueGet.calls.slice()
    window.__rs100QueueGet.calls.length = 0
    return seen
  `).catch(() => [])
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const env = readAppEnvContamination()
  const envReason = appEnvBlockReason(env, 'the /btw panel and the add popover')
  if (envReason) blocked(envReason)
  run.observe('the app environment', { present: Object.keys(env.present), controlSeen: env.controlSeen })

  await session.send('Runtime.enable')
  const consoleLines: string[] = []
  session.on('Runtime.consoleAPICalled', params => {
    const args = (params as { args?: { value?: unknown; description?: string }[] }).args ?? []
    const type = (params as { type?: string }).type ?? 'log'
    consoleLines.push(`[${type}] ${args.map(a => String(a.value ?? a.description ?? '')).join(' ')}`)
  })

  run.observe('the window', await focusWindow(session))
  run.observe('the theme', await ensureDarkTheme(session))
  await focusWindow(session)

  // The DETECTOR's own first source, and not `documentElement.lang` - measured
  // 2026-09-19 (SIT-8, first drive of this file): the document carries a static
  // `lang="en"` whatever the app is showing, so reading it first told the case
  // it was in English while every string on screen was Russian, and SIX
  // assertions then failed against the wrong locale's copy. The failure was
  // loud, which is the only reason it cost one run rather than a wrong verdict.
  const startedIn = await session.call<string>('return (window.localStorage.getItem("i18nextLng") ?? document.documentElement.lang ?? "en")')
  const first = startedIn.startsWith('ru') ? 'ru' : 'en'
  const second = first === 'en' ? 'ru' : 'en'
  run.observe('the locale the app started in', first)

  // The recorder D1.383 needs. Removed in the `finally`.
  const recorderInstalled = await installQueueRecorder(session)
  run.check('the queueGet recorder is installed', recorderInstalled, 'without it D1.383 has no positive control')
  // A reload destroys it along with the page, and a read taken afterwards
  // answers an empty list that reads exactly like a fixed product - measured
  // 2026-09-19 (SIT-8, first drive): the whole run recorded `[]` and the
  // POSITIVE control failed while the product was behaving correctly. Every
  // reload below is therefore drain, reload, re-install.
  const queueCalls: string[] = []

  try {
    // PIN the locale before reading a word of it. `i18nextLng` is what the
    // detector reads at BOOT; the running renderer keeps its own in-memory
    // language, and the two can disagree - a restore written without a reload
    // leaves exactly that state behind, and the next run then compares Russian
    // copy against English expectations. Writing the detected value back and
    // reloading makes the two agree by construction, which is cheaper than any
    // instrument that tries to guess what the renderer is showing.
    await setLanguage(session, first)
    await installQueueRecorder(session)
    const strings = await locale(first)
    const copy = sideQuestionCopy(strings)
    const thinking = strings['chat.processing.thinking'] ?? 'Thinking'

    const fresh = await freshSession(session, `CDP ${ID}`)
    run.require('the case created its own session', fresh.fresh, `inherited ${fresh.inheritedMessages} message(s): ${fresh.reason ?? ''}`)
    await setPermissionMode(session, fresh.sessionId, 'bypassPermissions')
    await focusWindow(session)

    // Arm D reads a THREAD of real answers, so this chat needs a transcript for
    // the side channel to answer FROM. Since D1.398 the agent no longer has to
    // be running for a side question to be accepted at all - arm E is the case
    // that drives that, on a chat where this seed deliberately does not happen.
    await sendPrompt(session, fresh, 'Reply with the single word: ready', 180_000)
    await focusWindow(session)

    // ---- arms A and B, first locale ---------------------------------------
    await readShellAndPlaceholder(run, session, first, strings)

    // ---- arm D, on the panel that is already open -------------------------
    const firstAsk = await askInPanel(session, 'what is a git rebase')
    run.check(
      'the panel accepted the first question',
      firstAsk.submitted,
      `the composer still holds ${JSON.stringify(firstAsk.leftInComposer)} - the send was refused, so nothing below `
      + 'measures the panel\'s behaviour',
    )
    const answered = await settle(session, copy.sentence, thinking)
    run.observe(`${first}: after the first question`, { text: answered.text.slice(0, 200), earlier: answered.earlier })
    run.check(
      'the first question is asked through the panel',
      answered.panels === 1 && answered.text.length > copy.sentence.length,
      `the panel still shows only its greeting: ${JSON.stringify(answered.text.slice(0, 160))}`,
    )

    const before = await readPanel(session, copy.sentence)
    const nestedAsk = await askInPanel(session, '/btw and what is a merge')
    run.require(
      'the panel accepted the nested question',
      nestedAsk.submitted,
      `the composer still holds ${JSON.stringify(nestedAsk.leftInComposer)}. The panel disables send while an answer `
      + 'is pending, so this is the rig having typed too early - reading the prefix off a question that was never '
      + 'asked is how a correct product gets reported as D1.384 regressing',
    )
    await Bun.sleep(2_500)
    const nested = await settle(session, copy.sentence, thinking)
    run.observe('the nested /btw', { panelsBefore: before.panels, panelsAfter: nested.panels, text: nested.text.slice(0, 220) })
    run.check(
      'a /btw typed INSIDE the panel asks that question, prefix stripped',
      nested.text.includes('and what is a merge') && !nested.text.includes('/btw'),
      `expected the question without its prefix; the panel reads ${JSON.stringify(nested.text.slice(0, 200))}`,
    )
    run.check(
      'it opens no second panel and is not a silent no-op',
      nested.panels === 1 && nested.text !== before.text,
      `panels ${before.panels} -> ${nested.panels}; text ${nested.text === before.text ? 'unchanged' : 'changed'}`,
    )

    // ---- arm D: the THREAD (D1.399) ---------------------------------------
    // A third question, so the thread holds three exchanges - the state the old
    // ring could visibly step through, which is what makes the arrow arm below
    // able to fail at all.
    const thirdAsk = await askInPanel(session, 'which is safer on a shared branch')
    run.check(
      'the panel accepted the third question',
      thirdAsk.submitted,
      `the composer still holds ${JSON.stringify(thirdAsk.leftInComposer)}`,
    )
    const thread = await settle(session, copy.sentence, thinking)
    run.observe('the thread after three questions', {
      bubbles: thread.bubbles.map(b => `${b.role}@${b.top}: ${b.text.slice(0, 60)}`),
      earlier: thread.earlier, hintLines: thread.hintLines, hintText: thread.hintText,
      scrolledToBottom: thread.scrolledToBottom,
    })
    run.check(
      'three questions render as three exchanges, in order, newest at the BOTTOM',
      thread.bubbles.length === 6
        && thread.bubbles.every((b, i) => b.role === (i % 2 === 0 ? 'user' : 'answer'))
        && thread.bubbles.every((b, i) => i === 0 || b.top > thread.bubbles[i - 1]!.top),
      'the panel must render every exchange the way the main chat does - six bubbles alternating user, answer, with '
      + `each below the one before it; read ${JSON.stringify(thread.bubbles.map(b => [b.role, b.top]))}`,
    )
    run.check(
      'the dimmed earlier-answers list is GONE',
      thread.earlier.length === 0,
      'D1.399 deleted the truncated list that used to stack above the current answer; '
      + `${thread.earlier.length} truncated row(s) are still drawn: ${JSON.stringify(thread.earlier)}`,
    )
    run.check(
      'the view is scrolled to the newest exchange',
      thread.scrolledToBottom !== false,
      'the thread is scrollable and is not at the bottom, so the newest answer is off screen',
    )
    run.check(
      'the hint line is the THREE remaining hints and never the stepping one',
      thread.hintLines === 1
        && [copy.copyHint, copy.clearHint, copy.dismissHint].every(h => h !== '' && thread.text.includes(h))
        && !/\u2190|\u2192/.test(thread.text),
      `one muted line carrying copy, clear and dismiss and no arrow glyph; read ${thread.hintLines} line(s): `
      + JSON.stringify(thread.hintText),
    )
    run.check(
      'the deleted stepping hint has no key left behind',
      (strings['chat.sideQuestion.stepHint'] ?? '') === '',
      'D1.399 deleted `chat.sideQuestion.stepHint` from both locales rather than leaving a key with no reader; '
      + 'the locale file still carries it, which `lint:i18n:reachable` counts as rot',
    )

    // The arrows must do NOTHING. Compared on the bubble TEXTS, which the old
    // stepping changed on every press - "the panel looks the same" read off a
    // string that includes the ROTATING placeholder cannot answer this.
    await session.call(`document.querySelector(${JSON.stringify(PANEL)})?.focus(); return true`)
    await pressKey(session, 'ArrowLeft')
    await Bun.sleep(800)
    const afterLeft = await readPanel(session, copy.sentence)
    await pressKey(session, 'ArrowRight')
    await Bun.sleep(800)
    const afterRight = await readPanel(session, copy.sentence)
    const texts = (r: PanelReading) => r.bubbles.map(b => b.text).join('|')
    run.observe('the arrow keys', {
      before: thread.bubbles.length, afterLeft: afterLeft.bubbles.length, afterRight: afterRight.bubbles.length,
    })
    run.check(
      'the arrow keys do nothing - the stepping is gone',
      texts(afterLeft) === texts(thread) && texts(afterRight) === texts(thread)
        && afterLeft.earlier.length === 0 && afterRight.earlier.length === 0,
      'Left and Right must not move the thread; '
      + `bubbles ${thread.bubbles.length} -> ${afterLeft.bubbles.length} -> ${afterRight.bubbles.length}, `
      + `text ${texts(afterLeft) === texts(thread) ? 'unchanged' : 'CHANGED'} on Left`,
    )

    // `c` copies the LATEST answer. A sentinel is planted first so "the
    // clipboard did not change" and "the clipboard cannot be read on this rig"
    // are different readings rather than one silent zero.
    const sentinel = 'RS-100-clipboard-sentinel'
    const planted = await session.call<string>(`
      try { await navigator.clipboard.writeText(${JSON.stringify(sentinel)}); return await navigator.clipboard.readText() }
      catch (error) { return 'CLIPBOARD-UNAVAILABLE: ' + error.message }
    `)
    const latestAnswer = [...thread.bubbles].reverse().find(b => b.role === 'answer')
    await session.call(`document.querySelector(${JSON.stringify(PANEL)})?.focus(); return true`)
    await typeText(session, 'c', { charDelayMs: 10 })
    await Bun.sleep(1_200)
    const clipboard = await session.call<string>(`
      try { return await navigator.clipboard.readText() } catch (error) { return 'CLIPBOARD-UNAVAILABLE: ' + error.message }
    `)
    run.observe('c - the copy key', { planted: planted.slice(0, 60), clipboard: clipboard.slice(0, 160) })
    run.check(
      'c copies the LATEST answer as raw Markdown',
      planted === sentinel && clipboard !== sentinel && latestAnswer !== undefined
        && clipboard.replace(/\s+/g, ' ').trim() === latestAnswer.text,
      planted !== sentinel
        ? `the clipboard could not be planted, so this arm measured nothing: ${JSON.stringify(planted.slice(0, 120))}`
        : `expected the newest answer ${JSON.stringify(latestAnswer?.text.slice(0, 80))}; the clipboard holds `
          + JSON.stringify(clipboard.slice(0, 120)),
    )

    // `x` empties the thread, and the hint line goes with it - the hint is
    // gated on the thread having anything in it, so an `x` that left the line
    // behind would mean the two had come apart.
    await session.call(`document.querySelector(${JSON.stringify(PANEL)})?.focus(); return true`)
    await typeText(session, 'x', { charDelayMs: 10 })
    await Bun.sleep(1_200)
    const cleared = await readPanel(session, copy.sentence)
    run.observe('x - the clear key', { panels: cleared.panels, bubbles: cleared.bubbles.length, hintLines: cleared.hintLines })
    run.check(
      'x empties the thread and takes the hint line with it',
      cleared.panels === 1 && cleared.bubbles.length === 0 && cleared.hintLines === 0
        && cleared.text.includes(copy.sentence),
      `the card must return to its empty state: ${cleared.bubbles.length} bubble(s), ${cleared.hintLines} hint line(s), `
      + `text ${JSON.stringify(cleared.text.slice(0, 120))}`,
    )

    // ---- arm A's control: the reference card, same session -----------------
    // The Sources page is a NAVIGATION, so it dismisses the panel; the panel is
    // then reopened on a session this case creates rather than on whatever a
    // reload would have restored, which on this app is the page you left.
    const sourcesLabel = strings['sidebar.sources'] ?? 'Sources'
    // Dismiss the panel FIRST, with the product's own key. A Radix popover that
    // is still open eats the first click outside it - the click closes the
    // popover and never reaches the sidebar row, so the navigation silently
    // does not happen (measured 2026-09-19, SIT-8, second and third drives).
    await pressKey(session, 'Escape')
    await Bun.sleep(600)
    const dismissed = await readPanel(session, copy.sentence)
    run.check(
      'Escape from inside the panel dismisses it',
      dismissed.panels === 0,
      `${dismissed.panels} panel(s) still open, so the click that follows will be eaten by the popover`,
    )
    const reference = await readReferenceCard(run, session, first, sourcesLabel)
    const backToChat = await freshSession(session, `CDP ${ID} shell`)
    await focusWindow(session)
    await openEmptyPanel(session)
    const panelCard = await readPanel(session, copy.sentence)
    run.observe('the two cards, measured in one session', {
      reference: reference ? { width: reference.width, height: reference.height, grip: reference.gripIcon } : null,
      panel: { width: panelCard.width, height: panelCard.height, grip: panelCard.gripIcon },
      inSession: backToChat.sessionId,
    })
    run.check(
      'CONTROL: the add popover and the panel are one shell - same width, same grip',
      reference !== undefined && reference.width === panelCard.width && (reference.gripIcon ?? '') === (panelCard.gripIcon ?? ''),
      `reference ${reference?.width}px grip ${JSON.stringify(reference?.gripIcon)} against panel ${panelCard.width}px `
      + `grip ${JSON.stringify(panelCard.gripIcon)}`,
    )
    run.check(
      'CONTROL: the add popover still reads as it shipped',
      reference !== undefined && reference.text.length > 0 && reference.placeholder !== null
        && !copy.placeholders.includes(reference.placeholder),
      'the shared shell must not have restyled or re-worded the four add-source / add-skill call sites it came from: '
      + `the reference card reads ${JSON.stringify(reference?.text.slice(0, 120))} with placeholder ${JSON.stringify(reference?.placeholder)}`,
    )

    // ---- arm C: the other locale ------------------------------------------
    queueCalls.push(...await drainQueueRecorder(session))
    await setLanguage(session, second)
    await installQueueRecorder(session)
    const translated = await freshSession(session, `CDP ${ID} ${second}`)
    run.observe('the session the second locale is read in', { id: translated.sessionId, fresh: translated.fresh })
    await focusWindow(session)
    await readShellAndPlaceholder(run, session, second, await locale(second))

    // ---- arm D's two absences, with their controls -------------------------
    await session.evaluate(`console.error(${JSON.stringify(CONSOLE_CONTROL)}); 1`)
    await Bun.sleep(500)
    queueCalls.push(...await drainQueueRecorder(session))
    const calls = queueCalls
    run.observe('every queueGet the renderer made', calls)
    run.check(
      'CONTROL: the queue hydrate really runs for a REAL session',
      calls.includes(fresh.sessionId),
      'no queueGet for the real session id, so "none for the synthetic id" is equally true of a recorder nothing '
      + `passed through: recorded ${JSON.stringify(calls)}`,
    )
    run.check(
      'no queueGet for a session id the RENDERER minted',
      calls.every(id => !id.startsWith('side-question:') && id !== 'pending'),
      `a renderer-minted id reached the host: ${JSON.stringify(calls.filter(id => id.startsWith('side-question:') || id === 'pending'))}`,
    )
    run.check(
      'CONTROL: the console capture can see a console line at all',
      consoleLines.some(line => line.includes(CONSOLE_CONTROL)),
      `${consoleLines.length} console line(s) captured and none of them the planted one`,
    )
    run.check(
      'no queue-hydrate failure was logged',
      !consoleLines.some(line => line.includes(HYDRATE_ERROR)),
      `logged: ${JSON.stringify(consoleLines.filter(line => line.includes(HYDRATE_ERROR)))}`,
    )
    run.observe('console lines captured', consoleLines.length)

    // ---- arm E: a side question on a chat that has NEVER run a turn -------
    // D1.398. The seed turn every arm above takes is exactly what this arm
    // withholds, and arm D's own chat - which answered the same class of
    // question minutes ago on this card - is the control that makes a failure
    // here a COLD-START fact rather than a dead rig or an unreachable gateway.
    const coldStrings = await locale(second)
    const coldCopy = sideQuestionCopy(coldStrings)
    const coldThinking = coldStrings['chat.processing.thinking'] ?? 'Thinking'
    const cold = await freshSession(session, `CDP ${ID} cold`)
    run.check('arm E created its own session', cold.fresh, cold.reason ?? '')
    await setPermissionMode(session, cold.sessionId, 'bypassPermissions')
    await focusWindow(session)
    const coldBefore = (await transcript(session, cold)).length
    await openEmptyPanel(session)
    const coldAsk = await askInPanel(session, 'what can you help me with')
    run.check(
      'the panel accepts a question on a chat that has never run a turn',
      coldAsk.submitted,
      `the composer still holds ${JSON.stringify(coldAsk.leftInComposer)}`,
    )
    const coldRead = await settle(session, coldCopy.sentence, coldThinking)
    run.observe('arm E - the cold chat', {
      text: coldRead.text.slice(0, 400), bubbles: coldRead.bubbles.length,
      answers: coldRead.bubbles.filter(b => b.role === 'answer').map(b => b.text.slice(0, 160)),
    })

    // The two halves are scored SEPARATELY, and the docblock says why: measured
    // 2026-09-20 (SIT-9) the sentence half holds while the answer half does not,
    // and one merged check would report the locale table as broken.
    // The needle is the WHOLE BUBBLE being one identifier, which is the shape
    // D1.398 replaced: the panel used to render `current.error` verbatim as the
    // text of a `role: 'error'` message, so the user read the raw code and
    // nothing else. A looser "contains a hyphenated lowercase token" test was
    // the first draft and is wrong in the direction that matters - it fires on
    // any ordinary hyphenated English word inside a real answer, so it would
    // report a WORKING panel as broken.
    const bareIdentifier = /^[a-z]+(-[a-z]+){1,4}$/
    const answers = coldRead.bubbles.filter(b => b.role === 'answer').map(b => b.text.trim())
    const errorText = answers.join(' ') || coldRead.text
    run.check(
      'arm E: whatever comes back is a SENTENCE, never a bare internal identifier',
      answers.length > 0 && answers.every(text => !bareIdentifier.test(text)),
      'D1.398 half two gives every side-channel failure a sentence in the current locale, and the panel used to '
      + `render the raw code as the whole text of the bubble: ${JSON.stringify(answers.slice(0, 3))}`,
    )
    run.check(
      'arm E: the question is ANSWERED',
      coldRead.bubbles.filter(b => b.role === 'answer').length === 1
        && !errorText.includes(coldCopy.errorGeneric),
      'a side question must work on a chat that has not run a turn yet (D1.398). CONTROL: the same question on this '
      + "run's own seeded chat is answered, so the card and the gateway are live. What came back here: "
      + JSON.stringify(errorText.slice(0, 240)),
    )
    const coldAfter = (await transcript(session, cold)).length
    run.check(
      'arm E: the side question leaves the transcript alone',
      coldAfter === coldBefore,
      `a side question is non-persisting by contract, and this chat's own message count moved `
      + `${coldBefore} -> ${coldAfter}`,
    )
    await pressKey(session, 'Escape')
  } finally {
    await session.call(`
      if (window.__rs100QueueGet) { window.electronAPI.queueGet = window.__rs100QueueGet.original; delete window.__rs100QueueGet }
      return true
    `).catch(() => false)
    // Restore WITH the reload, for the reason the pin above exists: a language
    // put back in storage only leaves the renderer showing the other one, and
    // the next run then reads one locale's copy against the other's.
    await setLanguage(session, first).catch(() => undefined)
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
