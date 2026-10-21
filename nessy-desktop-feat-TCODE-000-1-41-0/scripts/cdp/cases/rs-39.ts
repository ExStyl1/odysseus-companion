/**
 * RS-39 (DA1.17, rewritten for F1.6) — `/quota` on the claude and codex GATEWAY
 * cards answers the SAME Nessy Gateway budget the Pi gateway card reads, and a
 * BYO card is still refused.
 *
 * ## Why this case was rewritten, not re-run (F1.203)
 *
 * DA1.17 option B kept the runtime's refusal on the two non-Pi gateway cards
 * and appended a pointer ("run /quota on a Pi session"), with the menu row
 * withdrawn. F1.6 (`f6987934f`, origin D1.77) replaced that decision:
 * `offersNestorQuota` now gates the menu row on the CONNECTION alone — the
 * whole-URL gateway rule, whatever the runtime — and the claude and codex
 * `describeQuota` overrides read the budget through the same host-side read the
 * Pi card uses (`backend/internal/nestor-quota.ts`, `NessyGatewayQuotaRead`). A
 * card that can SHOW the number must not also point elsewhere, so the pointer
 * constant is gone. The old case asserted the withdrawn row, the refusal and the
 * pointer: every one of its gateway checks fails on a build carrying F1.6.
 *
 * On a build WITHOUT F1.6 (1.40.0 and earlier) THIS case fails the gateway arms
 * — no row offered, the refusal and the pointer instead of a budget — while the
 * Pi control and both BYO controls pass. That split is the rewrite's own
 * negative control: the case can tell the two gates apart.
 *
 * ## The claim is EQUALITY with the Pi card, read in the same minute
 *
 * "Something quota-shaped appeared" would pass on a gateway answering HTTP 500
 * on all three cards. So the Pi gateway card is read FIRST and must render a
 * budget (`limits-rendered`, or the honest `no-limits`); each of the other two
 * must then render the same budget — `compareQuotaBudgets` (`lib/nestor-cloud.ts`):
 * the same verdict and every limit's title, scope, state and reset stamp equal.
 * The percentage is recorded, not asserted, because the budget is per USER and
 * anything else signed in as that user can spend between two reads seconds apart.
 * The three reads' timestamps are recorded beside it.
 *
 * ## SELECTED, not typed — the row is offered now
 *
 * With the menu row offered on all three gateway cards, the palette is the user's
 * path and the one F1.6 opened, so the gateway arms select it
 * (`sendSlashCommand`, the app's own Enter handler). A card whose palette offers
 * no row FAILS that check and is then TYPED instead, so the reply is still read:
 * on a pre-F1.6 build that is how the refusal-and-pointer answer gets recorded.
 *
 * ## The detector is the SCREEN — RS-50's finding, applied
 *
 * A successful `/quota` render is a plain `info`, which `SessionManager` does not
 * persist (only a `warning` or a `Compacted` info is stored) — `lib/nestor-cloud.ts`
 * fact 2. The old case read `getSessionMessages`, which finds nothing when the
 * feature works; RS-50 then measured the answer on screen on all three cards
 * while no stored row carried it. Every reading here is the text the chat pane
 * ADDED since that arm's own submit (`paneDelta`), classified by
 * `classifyQuotaRender`. The store is observed beside it, never asserted.
 *
 * ## The two BYO controls, kept
 *
 * A BYO custom-endpoint card spends its own key, not the gateway budget: no menu
 * row, and a typed `/quota` answers the runtime's own refusal with no budget.
 * Review R1's arm stays — a BYO card at a gateway chat-base SUBPATH — because a
 * gate that decided by HOST or by prefix would offer that card the budget, and
 * the whole-URL rule must not.
 *
 * ## Safety
 *
 * `/quota` deliberately does not consume the budget (`quota_handler.go` is
 * outside `userLimitMiddleware`), so this case spends nothing. The three gateway
 * cards are created with the product's own one-click buttons; the BYO cards
 * carry fabricated keys and no turn is ever driven on them. No credential file is
 * read, printed or written.
 */

import { randomUUID } from 'node:crypto'

import { sendSlashCommand } from '../lib/chat.ts'
import { clearComposer, focusComposer, paletteState, peekPalette, submitComposer, typeIntoComposer } from '../lib/composer.ts'
import type { CdpSession } from '../lib/connect.ts'
import { pressKey } from '../lib/keys.ts'
import {
  chatPaneText, classifyQuotaRender, compareQuotaBudgets, composerCapabilities, paneDelta, waitForChatText,
  type QuotaRender,
} from '../lib/nestor-cloud.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, transcript, type SessionKey } from '../lib/state.ts'
import { clickAt } from '../lib/viewport.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-39'
const TITLE = '/quota on the claude and codex gateway cards answers the same Nessy Gateway budget the Pi card reads; a BYO card is still refused'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'DA1.17',
  runtimes: ['claude', 'codex', 'pi'],
  credentials:
    'owner: the machine must already hold the shared dp sign-in the one-click cards use — the case presses the '
    + 'product’s own buttons for the three gateway cards and never touches the file. The BYO controls carry keys the '
    + 'case fabricates. Run it on a NESSY_CONFIG_DIR created for the run.',
} as const satisfies CaseMeta

/** `BaseAgent.describeQuota`'s refusal — the BYO cards' answer, and never a gateway card's any more. */
const REFUSAL = 'Quota is not available on this runtime.'
/**
 * DA1.17's RETIRED pointer, spelled by hand: F1.6 removed it, and a gateway card
 * that shows the number AND points elsewhere for it is the half-applied change
 * this case must catch. A BYO card must never carry it either.
 */
const RETIRED_POINTER = ['Nessy Gateway limit', '/quota on a Nessy Gateway (Pi) session'] as const

/** Read in this order: the Pi card is the CONTROL, so it is read first and must be a budget. */
const GATEWAY_CARDS = [
  { label: /Pi agent/i, slug: 'pi-api-key', family: 'pi' },
  { label: /Claude Code agent/i, slug: 'claude-gateway', family: 'claude' },
  { label: /Codex agent/i, slug: 'codex-gateway', family: 'codex' },
] as const

/** The two BYO controls: an ordinary custom endpoint, and R1's SUBPATH case. */
const BYO_PLAIN = { slug: 'claude-custom', baseUrl: 'https://cdp-rs39.invalid/v1' }
const BYO_SUBPATH = { slug: 'codex-custom', baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1/sub' }
const MODELS = ['tgpt/deepseek-v4-flash-0731', 'tgpt/qwen36-35b-a3b-fp8']

function fakeKey(): string {
  return `sk-cdp-${randomUUID().replace(/-/g, '')}`
}

interface Rect { x: number; y: number; text: string }

async function buttonByText(session: CdpSession, pattern: RegExp): Promise<Rect | undefined> {
  return session.call<Rect | undefined>(`
    const wanted = ${pattern.toString()}
    const button = Array.from(document.querySelectorAll('button')).find(el => wanted.test((el.innerText || '').replace(/\\s+/g, ' ')))
    if (!button) return undefined
    const first = button.getBoundingClientRect()
    if (first.bottom > window.innerHeight || first.top < 0) {
      button.scrollIntoView({ block: 'center' })
      await new Promise(resolve => setTimeout(resolve, 400))
    }
    const r = button.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return undefined
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: (button.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80) }
  `)
}

/** Press one of the product's own one-click cards, from whichever surface has it. */
async function pressOneClick(session: CdpSession, label: RegExp): Promise<string | undefined> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const done = await buttonByText(session, /get started/i)
    if (!done) break
    await clickAt(session, { x: done.x, y: done.y }, 'the onboarding’s Get Started button')
    await Bun.sleep(2_000)
  }
  const direct = await buttonByText(session, label)
  if (direct) {
    await clickAt(session, { x: direct.x, y: direct.y }, direct.text)
    await Bun.sleep(3_000)
    return direct.text
  }
  await session.call<null>(`
    window.dispatchEvent(new CustomEvent('nessy-agent-navigate', { detail: { route: 'settings/ai' }, bubbles: true }))
    return null
  `)
  await Bun.sleep(2_500)
  const section = await buttonByText(session, /^AI Model, thinking/i)
  if (section) {
    await clickAt(session, { x: section.x, y: section.y }, 'the AI settings section')
    await Bun.sleep(2_000)
  }
  const add = await buttonByText(session, /Add Connection/i)
  if (!add) return undefined
  await clickAt(session, { x: add.x, y: add.y }, 'Add Connection')
  await Bun.sleep(2_000)
  const card = await buttonByText(session, label)
  if (!card) return undefined
  await clickAt(session, { x: card.x, y: card.y }, card.text)
  await Bun.sleep(3_000)
  return card.text
}

/** A fresh session, switched onto `slug`. */
async function sessionOn(session: CdpSession, slug: string, label: string): Promise<SessionKey> {
  process.env.NESSY_CDP_CARD = slug
  const key = await freshSession(session, `CDP ${ID} ${label} ${new Date().toISOString().slice(11, 19)}`)
  await session.call<null>(`
    await window.electronAPI.sessionCommand(${JSON.stringify(key.sessionId)}, { type: 'switchRuntime', connectionSlug: ${JSON.stringify(slug)} })
    return null
  `).catch(() => null)
  await Bun.sleep(2_500)
  return key
}

/**
 * Type `/quota` and submit it as TEXT — the BYO path, and the fallback for a
 * gateway card whose palette offers no row.
 *
 * The palette opens on the slash token whether or not it has a match, and
 * `submitComposer` refuses to press Enter while it is open — correctly, because
 * Enter would select a row. So the palette is dismissed with Escape first, and
 * the composer's content is re-read: an Escape that also cleared the composer
 * would otherwise submit nothing and the case would read an empty delta.
 */
async function typeQuota(session: CdpSession): Promise<string> {
  await focusComposer(session)
  await clearComposer(session)
  await typeIntoComposer(session, '/quota', { charDelayMs: 12 })
  await Bun.sleep(600)
  const palette = await paletteState(session).catch(() => ({ open: false }))
  if (palette.open) {
    await pressKey(session, 'Escape')
    await Bun.sleep(400)
  }
  const submitted = await session.call<string>(`
    const el = document.querySelector(${JSON.stringify('div[data-tutorial="chat-input"][role="textbox"][aria-multiline="true"]')})
    return el ? (el.innerText || '').trim() : ''
  `)
  await submitComposer(session)
  return submitted
}

interface QuotaReading {
  readonly how: 'selected' | 'typed'
  readonly render: QuotaRender
  readonly at: string
  /** Stored rows after the submit — observed, never asserted (fact 2 of `lib/nestor-cloud.ts`). */
  readonly stored: string[]
}

/**
 * Ask `/quota` and read what the pane ADDED.
 *
 * The wait ends on the first classifiable render, 90 s at most — the read itself
 * is bounded at 10 s by `NESTOR_QUOTA_TIMEOUT_MS`, so 90 s covers the session's
 * own preamble with room to spare, and a `nothing` after it is a real finding.
 */
async function askQuota(session: CdpSession, key: SessionKey, how: 'selected' | 'typed'): Promise<QuotaReading> {
  const before = await chatPaneText(session).catch(() => '')
  const storedBefore = (await transcript(session, key)).length
  if (how === 'selected') {
    await sendSlashCommand(session, key, { token: 'quota', match: /quota/i, expectComposer: '', submitOnSelect: true, noWait: true })
  } else {
    await typeQuota(session)
  }
  const settled = await waitForChatText(
    session,
    text => classifyQuotaRender(paneDelta(before, text)).verdict !== 'nothing',
    { label: `the ${how} /quota answer`, timeoutMs: 90_000 },
  )
  await Bun.sleep(1_500)
  const after = await chatPaneText(session).catch(() => settled.text)
  const stored = (await transcript(session, key)).slice(storedBefore)
    .filter(message => message.role !== 'user')
    .map(message => `${message.role}: ${message.content.slice(0, 300)}`)
  return { how, render: classifyQuotaRender(paneDelta(before, after)), at: new Date().toISOString(), stored }
}

function quotaRowsIn(entries: readonly string[]): string[] {
  return entries.filter(text => /quota/i.test(text))
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  // ---- the three gateway cards, through the product's own buttons ---------
  for (const card of GATEWAY_CARDS) {
    const listed = await session.call<boolean>(`
      const rows = await window.electronAPI.listLlmConnections()
      return (rows ?? []).some(c => c.slug === ${JSON.stringify(card.slug)})
    `)
    if (!listed) run.observe(`pressed the one-click button for ${card.slug}`, await pressOneClick(session, card.label) ?? '(not reachable)')
  }
  const cards = await session.call<Array<{ slug: string; providerType: string; baseUrl?: string }>>(`
    const rows = await window.electronAPI.listLlmConnections()
    return (rows ?? []).map(c => ({ slug: c.slug, providerType: c.providerType, baseUrl: c.baseUrl }))
  `)
  run.observe('the cards this profile has', cards)
  for (const card of GATEWAY_CARDS) {
    if (!cards.some(row => row.slug === card.slug)) {
      blocked(
        `the ${card.slug} card could not be created through the product's own one-click button, so there is nothing `
        + `to ask /quota on. The app lists ${cards.map(row => row.slug).join(', ') || 'nothing'}.`,
      )
    }
  }

  // ---- the gateway arms: Pi FIRST (the control), then claude, then codex ---
  let control: QuotaReading | undefined
  for (const card of GATEWAY_CARDS) {
    const isControl = card.family === 'pi'
    const key = await sessionOn(session, card.slug, card.family)
    const caps = await composerCapabilities(session, key.sessionId).catch(() => ({ excludedCommandIds: ['(unreadable)'] }))
    const palette = quotaRowsIn(await peekPalette(session, 'quota').catch(() => [] as string[]))
    run.observe(`${card.slug} — the /quota rows the palette offers, and the composer's exclusions`, { palette, excluded: caps.excludedCommandIds })
    run.check(
      `${isControl ? 'THE CONTROL — ' : ''}${card.slug} — the /quota MENU row is offered`,
      palette.length > 0 && !caps.excludedCommandIds.includes('quota'),
      `palette=${JSON.stringify(palette)} excluded=${JSON.stringify(caps.excludedCommandIds)} — F1.6 gates the row on the `
      + 'CONNECTION (the whole-URL gateway rule), so every gateway card is offered it. Withheld here means the build '
      + 'predates F1.6 or the gate reads the runtime again',
    )

    const reading = await askQuota(session, key, palette.length > 0 ? 'selected' : 'typed')
    const { render } = reading
    run.observe(`${card.slug} — what /quota put on screen (${reading.how}, ${reading.at})`, {
      verdict: render.verdict,
      limitLines: render.limitLines,
      delta: render.delta.slice(0, 600),
      storedAfterSubmit: reading.stored,
    })
    run.check(
      `${card.slug} — the answer carries neither the runtime's refusal nor DA1.17's retired pointer`,
      !render.delta.includes(REFUSAL) && !RETIRED_POINTER.some(clause => render.delta.includes(clause)),
      `the pane added ${JSON.stringify(render.delta.slice(0, 300))} — a gateway card that refuses, or shows the number `
      + 'AND points to the Pi card for it, is the pre-F1.6 answer or a half-applied one',
    )

    if (isControl) {
      control = reading
      run.check(
        'THE CONTROL — the Pi gateway card renders a BUDGET',
        render.verdict === 'limits-rendered' || render.verdict === 'no-limits',
        `verdict=${render.verdict} — every equality below needs a budget to be equal TO. An \`unavailable\` here is the `
        + 'gateway or the sign-in, not the two cards under test: sign in through the app and re-run',
      )
      continue
    }
    const compared = compareQuotaBudgets(control!.render, render)
    run.observe(`${card.slug} — against the Pi card's budget`, {
      same: compared.same,
      figuresEqual: compared.exact,
      detail: compared.detail,
      piReadAt: control!.at,
      thisReadAt: reading.at,
    })
    run.check(
      `${card.slug} — renders the SAME budget the Pi gateway card rendered`,
      compared.same,
      `${compared.detail}. F1.6's claim is that this card reads the budget the Pi card reads, through the same host `
      + 'read; a different budget, or none, is a second reader or no reader',
    )
  }

  // ---- the two BYO controls -------------------------------------------------
  for (const byo of [BYO_PLAIN, BYO_SUBPATH]) {
    const setup = await session.call<{ success?: boolean; error?: string }>(`
      return await window.electronAPI.setupLlmConnection(${JSON.stringify({
        slug: byo.slug,
        credential: fakeKey(),
        authType: 'api_key_with_endpoint',
        baseUrl: byo.baseUrl,
        defaultModel: MODELS[0],
        models: MODELS,
      })})
    `)
    run.observe(`the BYO control ${byo.slug}`, { baseUrl: byo.baseUrl, setup })
    if (setup?.success !== true) {
      run.check(
        `THE CONTROL — the BYO card ${byo.slug} could be created`,
        false,
        `setupLlmConnection answered ${JSON.stringify(setup)}, so this negative control is a NULL and the gateway arms `
        + 'above are unguarded against a build that offers the budget to every card',
      )
      continue
    }
    const key = await sessionOn(session, byo.slug, byo.slug)
    const palette = quotaRowsIn(await peekPalette(session, 'quota').catch(() => [] as string[]))
    run.check(
      `THE CONTROL — the BYO card ${byo.slug} is offered NO /quota row`,
      palette.length === 0,
      `the palette offers ${JSON.stringify(palette)} on a card that spends its own key${byo.slug === BYO_SUBPATH.slug
        ? ' — at a SUBPATH of the gateway chat base, which a host- or prefix-based gate would get wrong (review R1)'
        : ''}`,
    )
    const reading = await askQuota(session, key, 'typed')
    run.observe(`${byo.slug} — what a typed /quota put on screen`, {
      verdict: reading.render.verdict,
      delta: reading.render.delta.slice(0, 600),
      storedAfterSubmit: reading.stored,
    })
    run.check(
      `THE CONTROL — a typed /quota on ${byo.slug} is REFUSED with no budget`,
      reading.render.verdict === 'not-on-runtime' && reading.render.limitLines.length === 0
        && !RETIRED_POINTER.some(clause => reading.render.delta.includes(clause)),
      `verdict=${reading.render.verdict} — ${JSON.stringify(reading.render.delta.slice(0, 300))}. A BYO card has no `
      + 'Nessy Gateway budget to report; a budget, or a pointer to one, here is a lie',
    )
  }
}

if (import.meta.main) await main(ID, TITLE, drive)

export const manual = {
  steps: [
    '1. PACKAGED build, dark theme, ONE content panel, a NESSY_CONFIG_DIR created for the run and exported to the case process too.',
    '2. `bun run scripts/cdp/cases/rs-39.ts`. It presses the product’s own one-click buttons for the Pi, Claude Code and Codex gateway cards, and creates its two BYO controls with FABRICATED keys.',
    '3. Per gateway card, Pi FIRST: the palette must offer the /quota row, which the case SELECTS; the chat pane’s added text is classified and compared with the Pi card’s.',
    '4. Per BYO card: no /quota row in the palette, and a TYPED /quota answers the runtime’s refusal with no budget.',
  ],
  expected: 'the Pi gateway card renders a budget; the Claude Code and Codex gateway cards are offered the row and render the SAME budget (same limits, states and reset stamps; the figures recorded beside it), with neither the refusal nor the retired "run /quota on a Pi session" pointer; both BYO cards — R1’s gateway-subpath card included — are offered no row and answer "Quota is not available on this runtime." with no budget.',
  detector: 'the text the chat pane ADDED after each arm’s own submit, classified by `classifyQuotaRender` and compared by `compareQuotaBudgets` (`lib/nestor-cloud.ts`). Never `getSessionMessages`: a successful /quota render is an `info` the host does not persist, so the store finds nothing exactly when the feature works — the old RS-39 instrument, which RS-50 retired.',
  positiveControl: 'the Pi gateway card, read first in the same run: it must render a budget, and every gateway equality is against it. The BYO arms are the negative half — a build that offered the budget to every card passes the gateway arms and fails them; a pre-F1.6 build (1.40.0) fails the claude and codex arms while the Pi control and both BYO controls pass.',
  doneMeans: 'F1.6 carries one packaged run: the Pi card’s budget quoted, both other gateway cards’ renders compared against it with the three read times, and both BYO controls read — including R1’s subpath card.',
  safety: '/quota does not consume the gateway budget, so this case spends nothing; the BYO cards carry fabricated keys and no turn is driven on them; no credential file is read, printed or written.',
  doNotConflate: 'the same budget with the same text. Two cards failing the same way (`Quota is unavailable: …` on all three) agree with each other and prove nothing, so only a rendered budget can be equal; and the percentage can move between two reads without the budget being a different one.',
} as const satisfies SittingRecipe
