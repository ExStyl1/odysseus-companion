/**
 * RS-50 (DA2.26, re-pointed for F1.6) — the TURN-PATH positive control RS-39's
 * FAIL was missing, the SCREEN half of the detector, and the three typed forms of
 * `/quota`.
 *
 * ## F1.6 changed what the two gateway cards answer (F1.203)
 *
 * When this case was written the claude and codex gateway cards answered `/quota`
 * with the runtime's refusal plus DA1.17's pointer ("run /quota on a Pi
 * session"). F1.6 (`f6987934f`, origin D1.77) replaced both: the menu row is
 * gated on the CONNECTION (the whole-URL gateway rule, whatever the runtime) and
 * the two overrides read the budget through the host-side read the Pi card uses.
 * So all three gateway cards now expect the SAME vocabulary — a budget — and the
 * refusal moved to the one card that must still get it: a BYO card, added here as
 * the negative control. The instrument (both surfaces, timed, delta-read) is
 * unchanged; only the expectation moved. RS-39 owns the stronger claim that the
 * three budgets are EQUAL; this case asks that each is reachable and is a budget.
 *
 * ## Why RS-39's FAIL could not be read
 *
 * RS-39 measured `/quota` on `claude-gateway` and `codex-gateway` on the packaged
 * 1.39.0 and recorded 6 of 12: the transcript carried one `user` row with the
 * text and no non-user row in 45 s. DA1.57 had already proved the AGENT-layer
 * dispatch works, so the row asks where the packaged silence comes from and names
 * three candidates — the preamble before `agent.chat()` (MCP materialisation, dp
 * preflight, the capability runtime), the composer's handling of the typed form,
 * or the anchored pattern.
 *
 * **None of those can be told apart without knowing whether an ORDINARY turn
 * answers on the same card in the same run.** A card that cannot complete any
 * turn produces the identical reading and is the cheapest of the explanations. So
 * arm A of every card is one ordinary prompt under RS-39's own 45 s budget, and it
 * is the control the whole case rests on: without it, "the pointer is
 * unreachable" is equally true of a session that never reached a runtime at all.
 *
 * ## The second instrument, and it is why this is not a re-run of RS-39
 *
 * Measured by the first measure sitting (2026-09-17, `rs-46.ts`, narrative
 * `docs/testing/cdp-runs/2026-09-17-measure-sitting-1.md` §1): on the packaged
 * 1.39.0 a command the host demonstrably CONSUMES — `/help`, `/status` — leaves
 * NO row in `getSessionMessages` at all, while its answer IS on screen. RS-39's
 * detector is `getSessionMessages`. So its FAIL is consistent with two products
 * that differ completely:
 *
 *   (i) nothing dispatched — the preamble never reached `BaseAgent.chat`;
 *   (ii) it dispatched, `describeQuota()` yielded its `info`, and the reply does
 *        not persist — the same seam `rs-46.ts` found for `/help`.
 *
 * Every arm here therefore reads BOTH surfaces and reports which one answered
 * first. A clause on screen and absent from the store is finding (ii), and it is
 * a different product from silence — they need opposite fixes.
 *
 * ## The screen read is a DELTA, and that is not a detail
 *
 * The chat pane ACCUMULATES. This case's first drive read the pane's tail after
 * each arm, so once the refusal had rendered for `/quota` it was still on screen
 * for `/quota ` and for `/quota now` — two later arms passing on the first one's
 * evidence, which is the same defect `rs-46.ts` paid for with a still-streaming
 * neighbour. Every screen reading below is the text added SINCE that arm's own
 * submit, by common prefix against the pane read immediately before it.
 *
 * ## The three typed forms, and a premise of the row corrected in passing
 *
 * The row says `/quota ` with a trailing space *"is prose by design"* because
 * `QUOTA_PATTERN` is anchored. Re-read at HEAD that is wrong in the one way that
 * matters: `parseSessionCommand` does `const trimmed = input.trim()` BEFORE
 * testing any pattern, so a trailing space is trimmed away and `/quota ` is the
 * command. The form that really is prose is a trailing WORD. Both are driven —
 * the corrected premise deserves a measurement rather than a source reading,
 * because the composer is a `contenteditable` and what it SUBMITS need not be
 * what was typed (this case records the submitted string for exactly that).
 *
 * ## The three gateway cards expect the SAME words; the BYO card the refusal
 *
 * Every gateway card answers with `describeNestorQuota`'s own content — `Quota:`,
 * or *"No quota limits apply to your account."*, or *"Quota is unavailable: …"*
 * — and a command form must render a BUDGET (the first two) with neither the
 * refusal nor the retired pointer beside it. The BYO card (a fabricated key at
 * an `.invalid` host) answers the runtime's refusal. It drives the two COMMAND
 * forms only: the ordinary turn and the trailing-word form need a model, and a
 * fabricated key has none, so their absence on that card is recorded, not failed.
 *
 * ## Safety
 *
 * `/quota` does not consume the gateway budget. The three gateway cards are
 * created with the product's own one-click buttons; the BYO card carries a
 * fabricated key and no turn is driven on it. This case never reads, prints or
 * writes any credential file and never runs `dp auth`. The ordinary-turn control
 * spends one short turn per gateway card.
 */

import { randomUUID } from 'node:crypto'

import { clearComposer, focusComposer, paletteState, peekPalette, submitComposer, typeIntoComposer } from '../lib/composer.ts'
import type { CdpSession } from '../lib/connect.ts'
import { pressKey } from '../lib/keys.ts'
import { classifyQuotaRender } from '../lib/nestor-cloud.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, isProcessing, transcript, waitFor, type SessionKey } from '../lib/state.ts'
import { clickAt } from '../lib/viewport.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-50'
const TITLE = 'the ordinary-turn control RS-39 never had, and the three typed forms of /quota'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'DA2.26',
  runtimes: ['claude', 'codex', 'pi'],
  credentials:
    'owner: the machine must already hold the shared dp sign-in the one-click cards use — the case presses the '
    + 'product’s own buttons and never touches the file, never reads a token and never runs `dp auth`. Run it on '
    + 'a NESSY_CONFIG_DIR created for the run and exported to the CASE process too.',
} as const satisfies CaseMeta

/** `BaseAgent.describeQuota`'s refusal — since F1.6 the BYO card's answer, and no gateway card's. */
const REFUSAL = 'Quota is not available on this runtime.'
/** DA1.17's RETIRED pointer, spelled by hand: F1.6 removed it, so no card may carry it. */
const RETIRED_POINTER = ['Nessy Gateway limit', '/quota on a Nessy Gateway (Pi) session'] as const
/** `describeNestorQuota`'s four outcomes — every gateway card's vocabulary since F1.6. */
const BUDGET_CLAUSES = ['Quota:', 'No quota limits apply', 'Quota is unavailable', 'Quota read was cancelled'] as const

/**
 * The gateway cards, in the order they are driven.
 *
 * Pi LAST and not first: it is the surface control, and a control read after the
 * two subjects cannot have warmed anything for them. Since F1.6 all three expect
 * the same budget vocabulary.
 */
const CARDS = [
  { slug: 'claude-gateway', label: /Claude Code agent/i, family: 'claude' },
  { slug: 'codex-gateway', label: /Codex agent/i, family: 'codex' },
  { slug: 'pi-api-key', label: /Pi agent/i, family: 'pi' },
] as const

/** The negative control: a BYO endpoint that spends its own (fabricated) key, never the gateway budget. */
const BYO = { slug: 'claude-custom', baseUrl: 'https://cdp-rs50.invalid/v1', models: ['tgpt/deepseek-v4-flash-0731'] } as const

/**
 * The three typed forms.
 *
 * `command: true` means `parseSessionCommand` carries it at HEAD — which for the
 * trailing-space form is the CORRECTION this case records, not the row's premise.
 */
const FORMS = [
  { text: '/quota', command: true, why: 'the exact form' },
  { text: '/quota ', command: true, why: 'a trailing SPACE — the row calls this prose; `parseSessionCommand` trims first, so it is the command' },
  { text: '/quota now', command: false, why: 'a trailing WORD — this really is prose, and is the arm that must reach the model' },
] as const

const COMPOSER = 'div[data-tutorial="chat-input"][role="textbox"][aria-multiline="true"]'

interface Rect { x: number; y: number; text: string }

async function buttonByText(session: CdpSession, pattern: RegExp): Promise<Rect | undefined> {
  return session.call<Rect | undefined>(`
    const wanted = ${pattern.toString()}
    const button = Array.from(document.querySelectorAll('button')).find(el => wanted.test((el.innerText || '').replace(/\\s+/g, ' ')))
    if (!button) return undefined
    button.scrollIntoView({ block: 'center' })
    await new Promise(resolve => setTimeout(resolve, 400))
    const r = button.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return undefined
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (button.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120) }
  `)
}

/**
 * Press one of the product's own one-click cards.
 *
 * **Escape FIRST, and re-find `Add Connection` from the settings route each
 * time.** Measured 2026-09-17 on this rig: a loop that pressed the Claude card
 * and then looked for the Codex one reported *"no card button"* — the first
 * card's own dialog was still up, so `Add Connection` was never re-reached and
 * the LABEL was blamed. Pressed on its own, `/Codex agent/i` matches
 * *"Nessy · Codex agent Coding agent on the same gateway."* and creates
 * `codex-gateway` on the first try.
 */
async function pressOneClick(session: CdpSession, label: RegExp): Promise<string | undefined> {
  await session.call<null>(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return null`)
  await Bun.sleep(800)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const done = await buttonByText(session, /get started/i)
    if (!done) break
    await clickAt(session, { x: done.x, y: done.y }, 'the onboarding’s Get Started button')
    await Bun.sleep(2_000)
  }
  await session.call<null>(`
    window.dispatchEvent(new CustomEvent('nessy-agent-navigate', { detail: { route: 'settings/ai' }, bubbles: true }))
    return null
  `)
  await Bun.sleep(2_500)
  let add = await buttonByText(session, /Add Connection/i)
  if (!add) {
    const section = await buttonByText(session, /^AI Model, thinking/i)
    if (section) {
      await clickAt(session, { x: section.x, y: section.y }, 'the AI settings section')
      await Bun.sleep(2_000)
    }
    add = await buttonByText(session, /Add Connection/i)
  }
  if (!add) return undefined
  await clickAt(session, { x: add.x, y: add.y }, 'Add Connection')
  await Bun.sleep(2_500)
  const card = await buttonByText(session, label)
  if (!card) return undefined
  await clickAt(session, { x: card.x, y: card.y }, card.text)
  await Bun.sleep(4_000)
  return card.text
}

/**
 * Everything the chat pane is rendering, and WHICH element answered.
 *
 * The source is reported because the fallback is `document.body`: a reading taken
 * off the whole window is still a reading, but it is not the chat pane, and a
 * later lane must be able to tell which one it has.
 */
async function paneText(session: CdpSession): Promise<{ source: string; text: string }> {
  return session.call<{ source: string; text: string }>(`
    const pane = document.querySelector('[data-testid="chat-display"]')
    const el = pane ?? document.body
    return { source: pane ? 'chat-display' : 'body', text: (el.innerText || '').replace(/\\s+/g, ' ') }
  `).catch(() => ({ source: '(unreadable)', text: '' }))
}

/** What `after` added to `before` — the common-prefix delta, which is what an append-only pane produces. */
function addedSince(before: string, after: string): string {
  let i = 0
  while (i < before.length && i < after.length && before[i] === after[i]) i += 1
  return after.slice(i)
}

interface Submitted {
  readonly submitted: string
  readonly rows: readonly { role: string; text: string }[]
  readonly msStore: number | null
  readonly msScreen: number | null
  readonly ms: number
  readonly added: string
  readonly paneSource: string
}

/**
 * Type one form, submit it as TEXT, and watch BOTH surfaces.
 *
 * Idle first (a still-streaming previous arm hands its rows to the next one),
 * then Escape the palette — `submitComposer` refuses to press Enter while it is
 * open, correctly, because Enter would select a row instead of sending.
 *
 * The wait ends as soon as the surface this arm needs has answered, and never
 * later than RS-39's own 45 s, so the numbers here are comparable with the FAIL
 * this case exists to explain. `wanted` is what the SCREEN must show to count as
 * an answer — the echoed user row alone would make any delta non-empty.
 */
async function typeAndSubmit(
  session: CdpSession,
  key: SessionKey,
  text: string,
  options: { readonly wanted: readonly string[]; readonly needsAssistant: boolean },
): Promise<Submitted> {
  await waitFor(
    () => isProcessing(session, key),
    busy => busy === false,
    { timeoutMs: 120_000, intervalMs: 1_000, label: `the session to go idle before ${JSON.stringify(text)}` },
  ).catch(() => undefined)
  const before = (await transcript(session, key)).length
  await focusComposer(session)
  await clearComposer(session)
  await typeIntoComposer(session, text, { charDelayMs: 12 })
  await Bun.sleep(600)
  const palette = await paletteState(session).catch(() => ({ open: false, items: [] as unknown[] }))
  if ((palette as { open?: boolean }).open) {
    await pressKey(session, 'Escape')
    await Bun.sleep(400)
  }
  const submitted = await session.call<string>(`
    const el = document.querySelector(${JSON.stringify(COMPOSER)})
    return el ? (el.innerText || '') : ''
  `)
  const paneBefore = await paneText(session)
  const started = Date.now()
  await submitComposer(session)

  let msStore: number | null = null
  let msScreen: number | null = null
  let added = ''
  let paneSource = paneBefore.source
  while (Date.now() - started < 45_000) {
    await Bun.sleep(500)
    const rows = (await transcript(session, key)).slice(before)
    const nonUser = rows.filter(message => message.role !== 'user')
    const assistant = rows.filter(message => message.role === 'assistant')
    if (msStore === null && (options.needsAssistant ? assistant.length > 0 : nonUser.length > 0)) msStore = Date.now() - started
    const pane = await paneText(session)
    paneSource = pane.source
    added = addedSince(paneBefore.text, pane.text)
    if (msScreen === null && options.wanted.some(clause => added.includes(clause))) msScreen = Date.now() - started
    if (options.needsAssistant ? msStore !== null : (msStore !== null || msScreen !== null)) break
  }
  const ms = Date.now() - started
  await Bun.sleep(1_500)
  const pane = await paneText(session)
  added = addedSince(paneBefore.text, pane.text)
  const rows = (await transcript(session, key))
    .slice(before)
    .map(message => ({ role: message.role, text: (message.content ?? '').slice(0, 500) }))
  return { submitted, rows, msStore, msScreen, ms, added, paneSource: pane.source || paneSource }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  for (const card of CARDS) {
    const listed = await session.call<boolean>(`
      const rows = await window.electronAPI.listLlmConnections()
      return (rows ?? []).some(c => c.slug === ${JSON.stringify(card.slug)})
    `)
    if (!listed) {
      run.observe(`pressed the one-click button for ${card.slug}`, await pressOneClick(session, card.label) ?? '(not reachable)')
    }
  }
  const cards = await session.call<Array<{ slug: string; providerType: string }>>(`
    const rows = await window.electronAPI.listLlmConnections()
    return (rows ?? []).map(c => ({ slug: c.slug, providerType: c.providerType }))
  `)
  run.observe('the cards this profile has', cards)
  for (const card of CARDS) {
    if (!cards.some(row => row.slug === card.slug)) {
      blocked(
        `the ${card.slug} card could not be created through the product's own one-click button, so neither the `
        + 'ordinary-turn control nor the /quota arms can run on it. The app lists '
        + `${cards.map(row => row.slug).join(', ') || 'nothing'}.`,
      )
    }
  }

  for (const card of CARDS) {
    const key = await sessionOn(session, card.slug, card.family)
    const palette = (await peekPalette(session, 'quota').catch(() => [] as string[])).filter(text => /quota/i.test(text))
    run.observe(`${card.slug} — the /quota rows the palette offers`, palette)
    run.check(
      `${card.slug} — the /quota MENU row is offered (F1.6 gates it on the connection)`,
      palette.length > 0,
      'the palette offers no /quota row on a gateway card. Since F1.6 the row follows the CONNECTION, so this is a '
      + 'build without F1.6 or a gate that reads the runtime again',
    )

    // ---- ARM A — THE CONTROL this whole case exists for -------------------
    const ordinary = await typeAndSubmit(session, key, 'Reply with the single word ready.', {
      wanted: ['ready'],
      needsAssistant: true,
    })
    run.observe(`${card.slug} — the ORDINARY turn`, {
      msToAssistantRow: ordinary.msStore,
      roles: ordinary.rows.map(row => row.role),
      rows: ordinary.rows.map(row => `${row.role}: ${row.text.slice(0, 200)}`),
      paneSource: ordinary.paneSource,
    })
    run.check(
      `THE CONTROL — an ordinary turn on ${card.slug} reaches the MODEL inside RS-39's own 45 s budget`,
      ordinary.msStore !== null,
      `no assistant row in ${ordinary.ms} ms on ${card.slug}. A /quota FAIL on this card is then NOT about /quota at `
      + 'all: this session cannot complete any turn, which is the cheapest of the three causes DA2.26 lists and the '
      + 'one that must be excluded before the other two are looked for',
    )

    // ---- ARM B/C/D — the three typed forms --------------------------------
    await driveForms(run, session, key, card.slug, FORMS, [...BUDGET_CLAUSES], 'budget')
  }

  // ---- THE NEGATIVE CONTROL — a BYO card, the two command forms only --------
  const setup = await session.call<{ success?: boolean; error?: string }>(`
    return await window.electronAPI.setupLlmConnection(${JSON.stringify({
      slug: BYO.slug,
      credential: `sk-cdp-${randomUUID().replace(/-/g, '')}`,
      authType: 'api_key_with_endpoint',
      baseUrl: BYO.baseUrl,
      defaultModel: BYO.models[0],
      models: BYO.models,
    })})
  `)
  run.observe(`the BYO control ${BYO.slug}`, { baseUrl: BYO.baseUrl, setup })
  if (!run.check(
    `THE CONTROL — the BYO card ${BYO.slug} could be created`,
    setup?.success === true,
    `setupLlmConnection answered ${JSON.stringify(setup)}, so the negative control is a NULL and the three gateway `
    + 'arms are unguarded against a build that answers a budget on every card',
  )) return
  const byoKey = await sessionOn(session, BYO.slug, BYO.slug)
  run.observe(
    `${BYO.slug} — the forms NOT driven`,
    'the ordinary turn and the trailing-word form: both need a model answer, and this card carries a fabricated key',
  )
  await driveForms(run, session, byoKey, BYO.slug, FORMS.filter(form => form.command), [REFUSAL], 'refusal')
}

/** A fresh session, switched onto `slug`. */
async function sessionOn(session: CdpSession, slug: string, label: string): Promise<SessionKey> {
  const key = await freshSession(session, `CDP ${ID} ${label} ${new Date().toISOString().slice(11, 19)}`)
  await session.call<null>(`
    await window.electronAPI.sessionCommand(${JSON.stringify(key.sessionId)}, { type: 'switchRuntime', connectionSlug: ${JSON.stringify(slug)} })
    return null
  `).catch(() => null)
  await Bun.sleep(3_000)
  return key
}

/**
 * Drive `forms` on one card and read both surfaces.
 *
 * `expect` is what a COMMAND form must render on screen: `budget` on a gateway
 * card (`limits-rendered` or `no-limits`, and neither the refusal nor the retired
 * pointer beside it), `refusal` on the BYO card (the runtime's own sentence and
 * no budget). The answered-on-a-surface check stays as it was — it is the
 * dispatch question — and the kind of answer is a second, separate check.
 */
async function driveForms(
  run: CaseRun,
  session: CdpSession,
  key: SessionKey,
  slug: string,
  forms: readonly (typeof FORMS)[number][],
  wanted: readonly string[],
  expect: 'budget' | 'refusal',
): Promise<void> {
  for (const form of forms) {
    const result = await typeAndSubmit(session, key, form.text, { wanted, needsAssistant: !form.command })
    const assistant = result.rows.filter(row => row.role === 'assistant')
    const stored = result.rows.filter(row => row.role !== 'user').map(row => row.text).join('\n')

    // The two surfaces, read separately and never merged into one verdict: the
    // same clause present on screen and absent from the store is finding (ii)
    // of this case's docblock, and it is a different product from silence.
    const inStore = wanted.map(clause => [clause, stored.includes(clause)] as const)
    const onScreen = wanted.map(clause => [clause, result.added.includes(clause)] as const)
    const render = classifyQuotaRender(result.added)
    run.observe(`${slug} — ${JSON.stringify(form.text)} (${form.why})`, {
      submitted: JSON.stringify(result.submitted),
      msToStoreRow: result.msStore,
      msToScreenClause: result.msScreen,
      roles: result.rows.map(row => row.role),
      rows: result.rows.map(row => `${row.role}: ${row.text.slice(0, 250)}`),
      inStore: Object.fromEntries(inStore),
      onScreen: Object.fromEntries(onScreen),
      screenVerdict: render.verdict,
      paneSource: result.paneSource,
      addedOnScreen: result.added.slice(0, 900),
    })

    if (form.command) {
      run.check(
        `${slug} — ${JSON.stringify(form.text)} is ANSWERED on at least one surface`,
        inStore.some(([, hit]) => hit) || onScreen.some(([, hit]) => hit),
        `neither the transcript nor the text the pane ADDED after this submit carries any of ${JSON.stringify(wanted)}, `
        + 'so the command produced nothing a user could read anywhere. Read the ordinary-turn control above before '
        + 'reading this as a missing answer',
      )
      const retired = RETIRED_POINTER.some(clause => result.added.includes(clause) || stored.includes(clause))
      run.check(
        expect === 'budget'
          ? `${slug} — ${JSON.stringify(form.text)} renders a BUDGET, with no refusal and no retired pointer`
          : `THE CONTROL — ${JSON.stringify(form.text)} on the BYO card is REFUSED, with no budget`,
        expect === 'budget'
          ? (render.verdict === 'limits-rendered' || render.verdict === 'no-limits') && !result.added.includes(REFUSAL) && !retired
          : render.verdict === 'not-on-runtime' && render.limitLines.length === 0 && !retired,
        `screen verdict=${render.verdict}, retired pointer ${retired ? 'PRESENT' : 'absent'} — `
        + (expect === 'budget'
          ? 'since F1.6 every gateway card reads the budget the Pi card reads; a refusal or a pointer is the pre-F1.6 answer'
          : 'a BYO card spends its own key, so any budget or pointer here is a lie'),
      )
      run.check(
        `${slug} — ${JSON.stringify(form.text)} never reaches the MODEL`,
        assistant.length === 0,
        'an assistant row answered a form `parseSessionCommand` carries at HEAD, so the host did NOT consume it '
        + 'and the anchored-pattern premise needs re-reading before anything is built',
      )
    } else {
      run.check(
        `${slug} — ${JSON.stringify(form.text)} is PROSE and reaches the model`,
        assistant.length > 0,
        'a trailing WORD is the form the anchored pattern really does exclude, so it must reach the model. No '
        + 'assistant row means either the turn path is down (read the control above) or the pattern is not what '
        + 'the source says',
      )
    }
  }
}

if (import.meta.main) await main(ID, TITLE, drive)

export const manual = {
  steps: [
    '1. PACKAGED build, dark theme, ONE content panel, a NESSY_CONFIG_DIR created for the run and exported to the CASE process as well as the app.',
    '2. `bun run scripts/cdp/cases/rs-50.ts`. It presses the product’s own one-click buttons for the Claude Code, Codex and Pi gateway cards, and creates ONE BYO control with a FABRICATED key at an `.invalid` host; it touches no credential file.',
    '3. Per gateway card it reads the palette for the /quota row, drives ONE ordinary turn — that is the control — and then the three typed forms of /quota. On the BYO card only the two command forms run.',
    '4. Read the ordinary-turn check FIRST. Every /quota reading below it is uninterpretable on a card whose ordinary turn did not answer.',
  ],
  expected: 'the /quota row is offered and the ordinary turn reaches the model on all three gateway cards inside 45 s; on each of them the two command forms render a BUDGET (`describeNestorQuota`’s own content — F1.6) with neither the refusal nor the retired pointer; the BYO card’s two command forms answer "Quota is not available on this runtime." with no budget; and the trailing-word form reaches the model on every gateway card.',
  detector: 'BOTH surfaces, read separately and timed: `getSessionMessages` for the store, and for the screen the text the chat pane ADDED since that arm’s own submit (a common-prefix delta — the pane accumulates, so a tail read lets a later arm pass on an earlier arm’s answer). The first measure sitting proved the two disagree on this build: `/help` and `/status` are consumed and leave no stored row while their answer is on screen.',
  positiveControl: 'the ordinary turn on the SAME card in the SAME run under RS-39’s own 45 s budget, plus the Pi card as the surface control. A build on which the ordinary turn fails on a gateway card explains a /quota FAIL with no /quota mechanism at all; a build on which /quota is readable nowhere on ANY card, Pi included, is a finding about the command surface rather than about the two gateway cards. The BYO card is the negative half: a build that answered a budget on every card passes the gateway arms and fails it.',
  doneMeans: 'DA2.26 carries, per gateway card, the ordinary-turn verdict beside the /quota verdict and the time each surface took, and the three typed forms recorded with what each one SUBMITTED — so RS-39’s 1.39.0 FAIL is attributed to the turn path, to the dispatch, or to the persistence, rather than left as one number.',
  safety: '/quota does not consume the gateway budget; the ordinary-turn control spends one short turn per gateway card; the BYO card carries a fabricated key and no turn is driven on it; no credential file is read, printed or written and `dp auth` is never run.',
  doNotConflate: 'a reply that never happened with a reply that happened and did not persist. Through `getSessionMessages` alone they are the same reading, and they need opposite fixes.',
} as const satisfies SittingRecipe
