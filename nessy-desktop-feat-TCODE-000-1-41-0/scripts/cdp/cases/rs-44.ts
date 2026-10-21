/**
 * RS-44 (DA2.16) — the two DA2.6 disclosure surfaces, on a PACKAGED build,
 * read off the RENDERED DOM.
 *
 * ## Why a live case at all, when both surfaces already have unit tests
 *
 * Because of what DA2.6 is: a mechanism that WORKED and reached nobody. Its
 * first half emitted the same verdict into `noteModelTargetToolEgress`, whose
 * default sink is a console warning — and a packaged Electron build never
 * writes one. The unit tests for the renderer half assert on the SOURCE
 * (`apps/electron/src/renderer/lib/__tests__/model-target-disclosure.test.ts`
 * and the two component tests), which answers *does the verdict reach the
 * markup* and not *does the user see it*. The row exists precisely because
 * those two questions came apart once already, so the detector here is the
 * rendered DOM of the shipped artefact and nothing else.
 *
 * ## The two surfaces, and what each one is asked
 *
 * 1. **The mark on a connection row** — `data-testid="connection-target-disclosure"`,
 *    rendered by `ConnectionRow.tsx` symbol `TargetDisclosureMark` on the active
 *    row AND on every row of the expanded list. Classified per CONNECTION, on
 *    its own default model.
 * 2. **The line under the model list** — `data-testid="model-target-tool-egress"`,
 *    rendered by `CompactModelSelector.tsx`, naming the PARSED host. Classified
 *    on the endpoint plus the model the session is actually on.
 *
 * The strongest arrangement is the one that reads both cards in a SINGLE DOM
 * read: with the integration list expanded, the external card's row and the
 * gateway card's row are on screen together, so "the mark is on one and not the
 * other" is one reading rather than two runs that could have differed for any
 * other reason. The egress LINE cannot be read that way — it belongs to the
 * session's own connection — so it is read once per arm, and the gateway arm is
 * the control.
 *
 * ## What makes the BYO card disclose, spelled out BY HAND
 *
 * `https://api.anthropic.com/v1` plus a model id in the `anthropic/` namespace.
 * The classifier (`upstream-target.ts` symbol `classifyModelTarget`) returns
 * `class: 'external-vendor'`, `restricted: true`, `host: 'api.anthropic.com'`
 * for that pair. Both values are written out here rather than imported from the
 * module under test, for the reason `rs-32.ts` gives about its two model ids: a
 * check that derives its expectation from the constant under test passes
 * whatever that constant says, a re-regression included.
 *
 * **Two models, not one, and that is load-bearing.** `derivePickerMode`
 * (`input/picker-mode.ts`) returns `locked-single` for a compat connection whose
 * `models` has one entry, and the egress line is rendered only in `flat` mode.
 * A one-model card would therefore show the mark and NOT the line, and the case
 * would report a missing surface that is working as designed.
 *
 * ## TWO pickers, and the row's answer turned on which one was read — measured 2026-09-17
 *
 * The composer has two model controls and only one of them carries surface 2.
 * `FreeFormInput.tsx` renders its OWN `DropdownMenu` picker on a desktop-width
 * window, and `CompactModelSelector` (a Radix drawer) below `AppShell.tsx`'s
 * `MOBILE_THRESHOLD` of 768. Both render the same `ConnectionRow`, so the MARK
 * is on both. `model-target-tool-egress` occurs in `CompactModelSelector.tsx`
 * and nowhere else, and so does `model-list-provenance` — so the desktop picker
 * renders NEITHER of the two lines that component puts under its model list.
 *
 * Measured on this build, same card, same session, minutes apart: the desktop
 * picker listed both of the BYO card's models — so it is in `flat` mode, not
 * `locked-single`, and the mode is not the difference — and rendered no line at
 * all; the compact picker rendered *"This model answers from api.anthropic.com,
 * outside Nessy Gateway…"* and its provenance line beside it.
 *
 * That is why the compact arm is in this case rather than being someone else's
 * problem: it is the POSITIVE CONTROL that separates *the testid is broken* from
 * *this picker does not render it*, and without it the desktop absence is
 * uninterpretable. The gateway control is read in the compact picker for the
 * same reason — a picker that renders no line for anybody would pass a
 * gateway-arm check taken in the desktop dropdown.
 *
 * ## The gateway card is the control, and it is not decoration
 *
 * `classifyModelTarget` answers `nessy-gateway` / `restricted: false` for the
 * verified gateway base URL, so the same code path that renders the mark for the
 * BYO card must render nothing for it. Without that arm, "the mark is present"
 * is equally true of a build that marks every connection — which is the failure
 * mode a disclosure surface can have while looking entirely correct.
 *
 * ## Safety
 *
 * The BYO card carries a FABRICATED `sk-cdp-<32 hex>` key this case generates,
 * and no turn is ever driven on it: both surfaces are decided before any request
 * is sent, so the card never spends a credential and the vendor is never
 * contacted. The gateway card is whatever the profile already has — this case
 * creates none and never reads, prints or writes a credential file.
 */

import { randomUUID } from 'node:crypto'

import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { listConnections, runtimeOf, type ConnectionRow } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, selectorCount, visibleElements } from '../lib/state.ts'
import { pressKey } from '../lib/keys.ts'
import { clickAt, getViewport, resizeWindow } from '../lib/viewport.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-44'
const TITLE = 'the two DA2.6 disclosure surfaces on a packaged build, read off the rendered DOM'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'DA2.16',
  runtimes: ['pi'],
  credentials:
    'none of the operator’s. The BYO card this case creates carries a key the case FABRICATES and never spends — no '
    + 'turn is driven on it. The gateway control is whatever card the profile already holds; on a fresh '
    + 'NESSY_CONFIG_DIR, press the onboarding’s one-click button first (RS-32 does exactly that) so there is a '
    + 'gateway row to read the absence on.',
} as const satisfies CaseMeta

/**
 * The BYO card this case creates. Removed again in a `finally`.
 *
 * A BUILT-IN slug with a numeric suffix, and not a name of this case's own
 * choosing: `connection-setup-logic.ts` symbol `createBuiltInConnection` matches
 * the slug against its template table (stripping a trailing `-N`) and REFUSES
 * anything else — *"Unknown built-in connection slug … Custom connections should
 * be created through settings"*, measured on the first drive of this case. The
 * `-2` suffix is the same door WB-f's RS-16 rig used, and a `baseUrl` is what
 * turns the template into a custom endpoint.
 */
const BYO_SLUG = 'pi-api-key-2'
const BYO_BASE_URL = 'https://api.anthropic.com/v1'
/** Two, so `derivePickerMode` answers `flat` and the egress line renders at all. */
const BYO_MODELS = ['anthropic/claude-sonnet-4-5', 'anthropic/claude-haiku-4-5']
/** What `classifyModelTarget` must parse out of {@link BYO_BASE_URL} — spelled by hand. */
const EXPECTED_HOST = 'api.anthropic.com'
/**
 * The gateway's own host, spelled by hand for the same reason.
 *
 * It is what the rows are told APART by, rather than their names: the BYO card
 * is a built-in template with a numeric suffix, so it can carry the same display
 * name as the gateway card it sits beside, and `cru-3.ts` already records what
 * that does to a row identified by text. The mark's `title` is
 * `chat.modelPicker.toolEgressDisclosure`, which interpolates the PARSED host —
 * so a marked row says for itself which endpoint it is about.
 */
const GATEWAY_HOST = 'code-completion-nestor.tcsbank.ru'
/** The English badge copy, `chat.modelPicker.toolEgressBadge`. */
const EXPECTED_BADGE = /external model|внешняя модель/i

/** A fabricated key, generated per run. 39 characters, never a real credential. */
function fakeKey(): string {
  return `sk-cdp-${randomUUID().replace(/-/g, '')}`
}

/**
 * The width below which the shell switches to the COMPACT composer — measured
 * from `AppShell.tsx`'s own `MOBILE_THRESHOLD` (768), and spelled by hand for
 * the same reason the two classifier values are. A margin, not the boundary: a
 * case that sits exactly on a threshold measures the threshold.
 */
const COMPACT_WIDTH = 700
const DESKTOP_WIDTH = 1400

const FOOTER_MENU_TRIGGER = '[data-composer-actions] button[aria-haspopup="menu"]'
const OPEN_MENU = '[role="menu"][data-state="open"]'
/** `ConnectionRow`'s expand control: a plain button carrying `aria-expanded`. */
const INTEGRATION_TOGGLE = '[role="menu"][data-state="open"] button[aria-expanded]:not([role="menuitem"])'
const MARK = '[data-testid="connection-target-disclosure"]'
const EGRESS_LINE = '[data-testid="model-target-tool-egress"]'
/**
 * The line that says where the model LIST came from — the egress line's
 * neighbour, and the discriminator for its absence.
 *
 * Both are rendered under `pickerMode === 'flat'` and nothing else, so when the
 * provenance line is on screen and the egress line is not, the mode is flat and
 * the CLASSIFIER returned null; when neither is, the picker is in
 * `locked-single` or `unavailable` and the egress line was never going to
 * render. Without it those two produce the same empty read, and only one of them
 * is a finding.
 */
const PROVENANCE_LINE = '[data-testid="model-list-provenance"]'
/** The COMPACT picker's own container — a Radix drawer, which is a dialog. */
const OPEN_DIALOG = '[role="dialog"][data-state="open"]'
/** Its trigger says `dialog`, where the desktop picker's says `menu`. */
const COMPACT_FOOTER_DIALOG_TRIGGER = '[data-composer-actions] button[aria-haspopup="dialog"]'

interface RowRead {
  /** The row's own text, whitespace-collapsed. */
  text: string
  /** Whether THIS row carries the disclosure mark. */
  marked: boolean
  /** The mark's own visible text, when it carries one. */
  markText?: string
  /** The mark's `title`, which is where the host-naming sentence lives on a row. */
  markTitle?: string
}

/**
 * Every visible button inside the open picker, each with whether the disclosure
 * mark is INSIDE it.
 *
 * The containment test is what makes one read answer both arms: the mark is a
 * `<span>` inside the row `<button>`, so a row that does not contain one is a
 * row the build decided not to mark — which is a positive reading about that
 * connection, not the absence of a selector.
 */
async function pickerRows(session: CdpSession): Promise<RowRead[]> {
  return session.call<RowRead[]>(`
    return Array.from(document.querySelectorAll(${JSON.stringify(`${OPEN_MENU} button`)}))
      .filter(el => {
        const s = window.getComputedStyle(el)
        return s.visibility !== 'hidden' && s.display !== 'none' && el.getClientRects().length > 0
      })
      .map(el => {
        const mark = el.querySelector(${JSON.stringify(MARK)})
        return {
          text: (el.innerText ?? el.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 200),
          marked: mark !== null,
          markText: mark ? (mark.innerText ?? mark.textContent ?? '').replace(/\\s+/g, ' ').trim() : undefined,
          markTitle: mark ? (mark.getAttribute('title') ?? '').replace(/\\s+/g, ' ').trim().slice(0, 300) : undefined,
        }
      })
  `)
}

/** The text of a visible element, or `undefined` when the build renders none. */
async function visibleText(session: CdpSession, selector: string): Promise<string | undefined> {
  return session.call<string | undefined>(`
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return undefined
    const s = window.getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none' || el.getClientRects().length === 0) return undefined
    return (el.innerText ?? el.textContent ?? '').replace(/\\s+/g, ' ').trim()
  `)
}

/** The egress line's rendered text, or `undefined` when the build renders none. */
async function egressLine(session: CdpSession): Promise<string | undefined> {
  return visibleText(session, EGRESS_LINE)
}

interface Hit { found: boolean; rect?: { x: number; y: number; width: number; height: number }; covered?: string | null }

/** Rect of the index-th visible match plus what is really under its centre. */
async function hitRead(session: CdpSession, selector: string, index: number): Promise<Hit> {
  return session.call<Hit>(`
    const all = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      .filter(el => {
        const s = window.getComputedStyle(el)
        return s.visibility !== 'hidden' && s.display !== 'none' && el.getClientRects().length > 0
      })
    const el = all[${index}]
    if (!el) return { found: false }
    const r = el.getBoundingClientRect()
    const point = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    const under = document.elementFromPoint(point.x, point.y)
    const covered = !under
      ? 'nothing-at-point'
      : (el.contains(under) || under.contains(el)) ? null : (under.tagName + '.' + String(under.className).slice(0, 60))
    return { found: true, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, covered }
  `)
}

/**
 * Click the index-th visible match, refusing rather than clicking blind.
 *
 * Same two guards `cru-3.ts` states and for the same reason: a coordinate click
 * dies silently under an overlay while key events keep working, and a Radix
 * popover keeps `pointer-events: none` on the body for the length of its close
 * animation, so "covered" is very often a transient and the hit-test polls.
 */
async function clickVisible(session: CdpSession, selector: string, index: number, label: string): Promise<void> {
  const deadline = Date.now() + 10_000
  let hit = await hitRead(session, selector, index)
  while (hit.found && hit.covered && Date.now() < deadline) {
    await Bun.sleep(300)
    hit = await hitRead(session, selector, index)
  }
  if (!hit.found || !hit.rect) throw new Error(`click refused: ${label} — no visible element at index ${index} of ${selector}`)
  if (hit.covered) throw new Error(`click refused: ${label} is covered by ${hit.covered} — an overlay would eat this click silently`)
  await clickAt(session, {
    x: Math.round(hit.rect.x + hit.rect.width / 2),
    y: Math.round(hit.rect.y + hit.rect.height / 2),
  }, label)
}

/** Close whatever picker is open, so the next arm starts from the same state. */
async function closePicker(session: CdpSession): Promise<void> {
  if ((await selectorCount(session, OPEN_MENU)) === 0) return
  await pressKey(session, 'Escape')
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await selectorCount(session, OPEN_MENU)) === 0) return
    await Bun.sleep(250)
  }
}

/**
 * Open the composer's model/integration picker.
 *
 * The footer holds several Radix triggers and none of them carries a test hook,
 * so candidates are opened and READ: the right one is the menu that contains the
 * integration expand toggle. That signal comes from the component tree rather
 * than from translated copy, so it identifies the same control in either locale
 * — the same identification `cru-3.ts` makes, restated here because a case may
 * not edit `lib/`.
 */
async function openPicker(session: CdpSession): Promise<void> {
  await closePicker(session)
  const triggers = await visibleElements(session, FOOTER_MENU_TRIGGER)
  if (triggers.length === 0) {
    blocked(
      'the composer footer has no dropdown trigger. On a narrow layout the composer renders the COMPACT drawer '
      + 'controls instead; widen the window so the desktop footer renders, then re-run.',
    )
  }
  for (let index = 0; index < triggers.length; index += 1) {
    await clickVisible(session, FOOTER_MENU_TRIGGER, index, `composer footer menu trigger #${index}`)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await selectorCount(session, OPEN_MENU)) > 0) break
      await Bun.sleep(250)
    }
    if ((await selectorCount(session, INTEGRATION_TOGGLE)) === 1) return
    await closePicker(session)
  }
  blocked(
    `none of the ${triggers.length} composer-footer menus carries the integration expand toggle, so the model picker `
    + 'could not be identified. It refuses to open while a turn is in flight and when the connection is unavailable.',
  )
}

/** Expand the integration list, so every connection's row is on screen at once. */
async function expandIntegrations(session: CdpSession): Promise<boolean> {
  const toggle = await session.call<{ expanded: boolean; disabled: boolean } | undefined>(`
    const el = document.querySelector(${JSON.stringify(INTEGRATION_TOGGLE)})
    if (!el) return undefined
    return { expanded: el.getAttribute('aria-expanded') === 'true', disabled: el.disabled === true }
  `)
  if (!toggle || toggle.disabled) return false
  if (toggle.expanded) return true
  await clickVisible(session, INTEGRATION_TOGGLE, 0, 'the integration expand toggle')
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await session.call<boolean>(`
      const el = document.querySelector(${JSON.stringify(INTEGRATION_TOGGLE)})
      return el ? el.getAttribute('aria-expanded') === 'true' : false
    `)
    if (state) return true
    await Bun.sleep(250)
  }
  return false
}

/**
 * Open the COMPACT composer's model drawer, identified by what it contains.
 *
 * Below `AppShell.tsx`'s `MOBILE_THRESHOLD` the shell switches composers, and
 * the compact one's model control is a Radix DRAWER rather than a dropdown
 * menu — `aria-haspopup="dialog"`, not `"menu"`, so the desktop selectors above
 * match nothing at all. The right trigger is the one whose open dialog carries
 * the model list's own provenance line; that is component state rather than
 * translated copy, so it identifies the same control in either locale.
 */
/**
 * The same click, after CLOSING whatever is covering the footer — not after
 * widening the hit-test, and not after waiting longer.
 *
 * Measured on the packaged 1.40.0 (sitting 5) with `document.elementFromPoint`
 * at each trigger's own centre: once this loop has opened the FIRST footer
 * dialog and pressed Escape, **both** triggers report the covering element as
 * `P.mt-1 border-t … text-muted-foreground` whose text is the permission-mode
 * hint (*"Plan is the one mode a resumed session comes back in …"*) with
 * `pointer-events: auto` — the previous dialog's own paragraph, still laid over
 * a 26 px-tall footer at y=850 in a 900 px window. It is not a reflow: eight
 * retries over six seconds met the identical refusal, and the run's duration
 * went 30 s → 129 s for nothing.
 *
 * So the settle is an Escape and a WAIT FOR THE DIALOG COUNT TO REACH ZERO,
 * which is the condition the cover actually depends on. The hit-test still
 * refuses a covered point and the last refusal is rethrown, so a cover that
 * survives a closed dialog is still reported in the case's own words.
 */
async function clickWhenSettled(session: CdpSession, index: number): Promise<void> {
  const label = `compact footer dialog trigger #${index}`
  let last: unknown
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await clickVisible(session, COMPACT_FOOTER_DIALOG_TRIGGER, index, label)
      return
    } catch (cause) {
      last = cause
      const message = cause instanceof Error ? cause.message : String(cause)
      if (!message.includes('covered by')) throw cause
      await pressKey(session, 'Escape')
      for (let settle = 0; settle < 8; settle += 1) {
        if ((await selectorCount(session, OPEN_DIALOG)) === 0) break
        await Bun.sleep(250)
      }
      await Bun.sleep(500)
    }
  }
  throw last
}

async function openCompactPicker(session: CdpSession): Promise<boolean> {
  // The compact composer reflows for a second or two after the resize — the
  // footer grows a hint paragraph that briefly sits over the trigger, and the
  // hit-test then refuses the click by design (measured 2026-09-17: *"covered by
  // P.mt-1 border-t…"*). Settle before measuring rather than widen the
  // hit-test's tolerance, which would start clicking under real overlays.
  await Bun.sleep(1_500)
  const triggers = await visibleElements(session, COMPACT_FOOTER_DIALOG_TRIGGER)
  for (let index = 0; index < triggers.length; index += 1) {
    await clickWhenSettled(session, index)
    for (let attempt = 0; attempt < 16; attempt += 1) {
      if ((await selectorCount(session, OPEN_DIALOG)) > 0) break
      await Bun.sleep(250)
    }
    if ((await selectorCount(session, PROVENANCE_LINE)) > 0 || (await selectorCount(session, EGRESS_LINE)) > 0) return true
    await pressKey(session, 'Escape')
    await Bun.sleep(600)
  }
  return false
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  const before = await listConnections(session)
  const gateway = before.find(row => runtimeOf(row.providerType) === 'pi' && row.slug === 'pi-api-key')
    ?? before.find(row => runtimeOf(row.providerType) === 'pi')
  if (!gateway) {
    blocked(
      'this profile lists no gateway card, so the control arm — the connection whose row must carry NO mark — does not '
      + `exist. The app lists: ${before.map(row => `${row.slug}(${row.providerType})`).join(', ') || 'nothing'}. `
      + 'Press the onboarding’s one-click button first (RS-32 drives exactly that).',
    )
  }
  run.observe('the gateway control card', { slug: gateway.slug, name: gateway.name, defaultModel: gateway.defaultModel })

  let created = false
  let sessionId: string | undefined
  try {
    // ---- the BYO card, with a fabricated key that is never spent ------------
    const setup = await session.call<{ success?: boolean; error?: string }>(`
      return await window.electronAPI.setupLlmConnection(${JSON.stringify({
        slug: BYO_SLUG,
        credential: fakeKey(),
        baseUrl: BYO_BASE_URL,
        customEndpoint: { api: 'openai-completions' },
        defaultModel: BYO_MODELS[0],
        models: BYO_MODELS,
      })})
    `)
    run.observe('the BYO card this case created', { slug: BYO_SLUG, baseUrl: BYO_BASE_URL, models: BYO_MODELS, setup })
    created = setup?.success === true
    run.require(
      'the BYO card was created',
      created,
      `setupLlmConnection answered ${JSON.stringify(setup)} — without the card there is nothing to read a disclosure on`,
    )
    const withByo = await listConnections(session)
    const byo = withByo.find(row => row.slug === BYO_SLUG)
    run.require('the app lists the BYO card', byo !== undefined, `the app lists ${withByo.map(row => row.slug).join(', ')}`)
    run.observe('the BYO card as the app lists it', byo && {
      slug: byo.slug, name: byo.name, providerType: byo.providerType, defaultModel: byo.defaultModel,
    })

    // ---- arm 1: the session on the BYO card --------------------------------
    process.env.NESSY_CDP_CARD = BYO_SLUG
    const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
    sessionId = key.sessionId
    await session.call<null>(`
      await window.electronAPI.sessionCommand(${JSON.stringify(key.sessionId)}, { type: 'switchRuntime', connectionSlug: ${JSON.stringify(BYO_SLUG)} })
      return null
    `).catch(() => null)
    await Bun.sleep(1_500)

    const originalViewport = await getViewport(session)
    run.observe('the viewport this run started in', originalViewport)
    await resizeWindow(session, DESKTOP_WIDTH, Math.max(originalViewport.height, 900))
    await Bun.sleep(1_500)
    await openPicker(session)
    const expanded = await expandIntegrations(session)
    run.observe('the integration list expanded', expanded)
    const rowsOnByo = await pickerRows(session)
    const byoLine = await egressLine(session)
    const byoProvenance = await visibleText(session, PROVENANCE_LINE)
    // The desktop picker's WHOLE text, so a reader can see which mode it is in
    // rather than infer it from two absences. `derivePickerMode`'s three
    // outcomes look different here: `flat` lists the models, `locked-single`
    // renders one model block, `unavailable` renders an error card.
    const desktopPickerText = await visibleText(session, OPEN_MENU)
    run.observe('the DESKTOP picker’s whole text', desktopPickerText?.slice(0, 700) ?? '(nothing)')
    run.observe('the model-list provenance line, BYO arm (the picker-mode discriminator)', byoProvenance ?? '(no line rendered)')
    run.observe('the models the app stored on the BYO card', byo?.models?.map(model => model.id))
    run.observe('every visible picker row while the session is on the BYO card', rowsOnByo)
    run.observe('the line under the model list, BYO arm', byoLine ?? '(no line rendered)')

    // THE READ THAT ANSWERS BOTH ARMS AT ONCE. `byo.name` and `gateway.name` are
    // the app's own names for the two cards, so the rows are told apart by state
    // rather than by copy.
    const byoName = byo?.name ?? BYO_SLUG
    const markedRows = rowsOnByo.filter(row => row.marked)
    const hostsNamedByMarks = [...new Set(markedRows.map(row => row.markTitle ?? ''))]
    run.observe('the hosts the marks name, out of their own titles', hostsNamedByMarks)
    run.check(
      `SURFACE 1 — a connection row carries the disclosure mark, and it names ${EXPECTED_HOST}`,
      markedRows.length > 0 && markedRows.every(row => (row.markTitle ?? '').includes(EXPECTED_HOST)),
      `${markedRows.length} marked row(s) on screen, titles ${JSON.stringify(hostsNamedByMarks)}. Rows: `
      + JSON.stringify(rowsOnByo.map(row => ({ text: row.text.slice(0, 60), marked: row.marked })))
      + ' — with the list expanded every connection has a row, so a mark on none of them is the surface missing '
      + 'rather than the card being off screen',
    )
    run.check(
      'SURFACE 1 — the mark reads as the external-model badge',
      markedRows.some(row => EXPECTED_BADGE.test(row.markText ?? '')),
      `the mark’s own text is ${JSON.stringify(markedRows.map(row => row.markText))}, which is neither locale’s `
      + '`chat.modelPicker.toolEgressBadge` — a mark rendering empty is indistinguishable from no mark to a user',
    )
    // THE CONTROL, and it is read off the SAME expanded list in the same pass.
    // Told apart by the host the mark itself names rather than by the cards'
    // display names: a built-in slug with a numeric suffix inherits the template's
    // name, so the two rows can read identically (`cru-3.ts` records what that
    // does to a row identified by text). An UNMARKED row must also exist, or
    // "the gateway is not marked" would be equally true of an empty list.
    const unmarked = rowsOnByo.filter(row => !row.marked && row.text.trim().length > 0)
    run.check(
      `SURFACE 1's CONTROL — no mark names the gateway host (${GATEWAY_HOST}), and an unmarked row exists`,
      markedRows.every(row => !(row.markTitle ?? '').includes(GATEWAY_HOST)) && unmarked.length > 0,
      `marked titles ${JSON.stringify(hostsNamedByMarks)} against ${unmarked.length} unmarked row(s) — a build that `
      + 'marks every connection tells the user nothing, and every positive above would be equally true of it',
    )
    run.check(
      `SURFACE 2 — the DESKTOP picker's line under the model list names the parsed host (${EXPECTED_HOST})`,
      (byoLine ?? '').includes(EXPECTED_HOST),
      byoLine === undefined
        ? 'no line is rendered at all, and the discriminator says which absence this is: the model-list provenance '
          + `line reads ${JSON.stringify(byoProvenance ?? null)}. Present means the picker IS in \`flat\` mode and the `
          + 'CLASSIFIER returned null for this endpoint+model pair, which is the finding; absent means the picker is in '
          + '`locked-single` or `unavailable` — `derivePickerMode` answers `locked-single` for a compat connection whose '
          + 'model list has one entry — and the line was never going to render'
        : `the line reads ${JSON.stringify(byoLine)} and does not name ${EXPECTED_HOST}`,
    )
    await closePicker(session)

    // ---- arm 1b: THE SAME SESSION, in the COMPACT composer -----------------
    //
    // The positive control for surface 2, and the thing that turns its absence
    // above into a reading instead of a suspicion. Below `MOBILE_THRESHOLD` the
    // shell renders a DIFFERENT composer whose model control is
    // `CompactModelSelector` — which is the only module in this tree that
    // renders `model-target-tool-egress` at all. If the line appears here and
    // not there, the testid works, the classifier answered, and what differs is
    // WHICH PICKER the user has in front of them.
    await resizeWindow(session, COMPACT_WIDTH, Math.max(originalViewport.height, 900))
    await Bun.sleep(2_000)
    const compactOpened = await openCompactPicker(session)
    const compactLine = await egressLine(session)
    const compactProvenance = await visibleText(session, PROVENANCE_LINE)
    run.observe('the COMPACT picker, BYO arm', {
      opened: compactOpened,
      egressLine: compactLine ?? '(no line rendered)',
      provenanceLine: compactProvenance ?? '(no line rendered)',
    })
    run.check(
      `SURFACE 2's POSITIVE CONTROL — the COMPACT picker names the parsed host (${EXPECTED_HOST})`,
      (compactLine ?? '').includes(EXPECTED_HOST),
      compactOpened
        ? `the compact picker is open and its line reads ${JSON.stringify(compactLine ?? null)} (provenance: `
          + `${JSON.stringify(compactProvenance ?? null)}). With BOTH pickers silent the finding is the surface itself, `
          + 'not which picker renders it'
        : 'the compact picker did not open, so surface 2 has no positive control on this rig and its absence above is '
          + 'uninterpretable — widen nothing and re-run; the trigger is identified by the provenance line it contains',
    )
    await pressKey(session, 'Escape')
    await Bun.sleep(800)
    await resizeWindow(session, DESKTOP_WIDTH, Math.max(originalViewport.height, 900))
    await Bun.sleep(1_500)

    // ---- arm 2: the same session on the GATEWAY card -----------------------
    await session.call<null>(`
      await window.electronAPI.sessionCommand(${JSON.stringify(key.sessionId)}, { type: 'switchRuntime', connectionSlug: ${JSON.stringify(gateway.slug)} })
      return null
    `).catch(() => null)
    await Bun.sleep(1_500)
    await openPicker(session)
    await expandIntegrations(session)
    const gatewayLine = await egressLine(session)
    const rowsOnGateway = await pickerRows(session)
    await closePicker(session)
    // The control has to be read where the line LIVES, or it proves nothing: a
    // picker that renders no line for anybody would pass a gateway-arm check
    // taken in the desktop dropdown.
    await resizeWindow(session, COMPACT_WIDTH, Math.max(originalViewport.height, 900))
    await Bun.sleep(2_000)
    const gatewayCompactOpened = await openCompactPicker(session)
    const gatewayCompactLine = await egressLine(session)
    const gatewayCompactProvenance = await visibleText(session, PROVENANCE_LINE)
    run.observe('the COMPACT picker, GATEWAY arm', {
      opened: gatewayCompactOpened,
      egressLine: gatewayCompactLine ?? '(no line rendered)',
      provenanceLine: gatewayCompactProvenance ?? '(no line rendered)',
    })
    run.check(
      'SURFACE 2’s CONTROL — the COMPACT picker shows NO line for the gateway card',
      gatewayCompactOpened && gatewayCompactLine === undefined && gatewayCompactProvenance !== undefined,
      `opened=${gatewayCompactOpened}, line=${JSON.stringify(gatewayCompactLine ?? null)}, provenance=`
      + `${JSON.stringify(gatewayCompactProvenance ?? null)} — the provenance line is required present so that a `
      + 'silent picker cannot pass as a correctly-silent disclosure',
    )
    await pressKey(session, 'Escape')
    await Bun.sleep(800)
    await resizeWindow(session, originalViewport.width, originalViewport.height)
    run.observe('the line under the model list, GATEWAY arm', gatewayLine ?? '(no line rendered)')
    run.observe('every visible picker row while the session is on the gateway card', rowsOnGateway)
    run.check(
      'SURFACE 2’s CONTROL — the gateway card shows NO line under its model list',
      gatewayLine === undefined,
      `the gateway arm rendered ${JSON.stringify(gatewayLine)} — the verified gateway is classified `
      + '`nessy-gateway` / `restricted: false`, so a line here means the surface fires on every connection',
    )
    // Recorded rather than required: the expanded list still holds the BYO row,
    // so the mark SHOULD still be there — it is a property of the connection,
    // not of the session. Asserting it would restate the first arm; recording it
    // catches a surface that reads the ACTIVE connection when it should read the
    // row's own.
    run.observe('the BYO row is still marked while the session sits on the gateway', {
      byoName,
      marksStillNaming: [...new Set(rowsOnGateway.filter(row => row.marked).map(row => row.markTitle ?? ''))],
      note: 'the mark is classified per CONNECTION, so moving the session must not move it',
    })
  } finally {
    if (created) {
      // MOVE THE SESSION FIRST. `deleteLlmConnection` refuses while a session
      // still names the card — *"1 session(s) and 0 automation(s) still use …"*
      // — which is the app protecting the user and not a bug; a run that failed
      // before its own gateway arm would otherwise leave the card behind for the
      // next run to find. The session created here is this case's own, so moving
      // it costs nobody anything.
      if (sessionId) {
        await session.call<null>(`
          await window.electronAPI.sessionCommand(${JSON.stringify(sessionId)}, { type: 'switchRuntime', connectionSlug: ${JSON.stringify(gateway.slug)} })
          return null
        `).catch(() => null)
        await Bun.sleep(1_500)
      }
      const removed = await session.call<unknown>(`
        const api = window.electronAPI
        if (typeof api.deleteLlmConnection === 'function') return await api.deleteLlmConnection(${JSON.stringify(BYO_SLUG)})
        return 'no deleteLlmConnection on this build'
      `).catch((cause: unknown) => String(cause instanceof Error ? cause.message : cause))
      run.observe('the BYO card was removed again', removed)
    }
  }
}

if (import.meta.main) await main(ID, TITLE, drive)

export const manual = {
  steps: [
    '1. PACKAGED build, dark theme, ONE content panel, a desktop-width window (the compact drawer footer renders no dropdown trigger and the case BLOCKS naming that).',
    '2. A NESSY_CONFIG_DIR created for the run, with the onboarding’s one-click gateway card pressed so there is a gateway row to read the ABSENCE on.',
    '3. `bun run scripts/cdp/cases/rs-44.ts` with NESSY_CDP_PORT pointed at the app. The case creates its own BYO card (`cdp-rs44-external`) with a FABRICATED key and removes it again in a `finally`.',
    '4. Read the four checks: the mark on the external row, its badge text, the gateway row’s absence of one, and the host-naming line under the model list.',
  ],
  expected: 'the BYO card’s row carries the `external model` mark and the line under the model list names `api.anthropic.com`, in the picker the window actually shows; the gateway card’s row carries no mark and its arm renders no line.',
  detector: 'the RENDERED DOM of the packaged build — `[data-testid="connection-target-disclosure"]` INSIDE a row button, and `[data-testid="model-target-tool-egress"]`. Never the source, and never `noteModelTargetToolEgress`, whose sink a packaged Electron build does not write and whose dedup is per PROCESS.',
  positiveControl: 'TWO. For surface 1, the same expanded list read in one pass, so the mark being present on one row and absent on the other is a single reading. For surface 2, the COMPACT picker below AppShell’s 768 px threshold: it is the only module that renders `model-target-tool-egress` at all, so its line is what separates a broken testid from a picker that does not render one.',
  doneMeans: 'DA2.16 carries one packaged run: both surfaces observed on the rendered DOM with the gateway control in the same read, or the failure quoted with the picker mode beside it.',
  safety: 'the BYO card carries a key the case fabricates and NEVER spends — no turn is driven on it, because both surfaces are decided before any request is sent. The vendor is never contacted and no credential file is read, printed or written.',
  doNotConflate: 'the DESKTOP picker with the COMPACT one — they are different components and only one renders surface 2 (measured 2026-09-17; see the docblock). And a missing LINE with a missing surface: `derivePickerMode` answers `locked-single` for a compat connection whose model list has one entry, and the line renders only in `flat` — so a one-model BYO card produces the same absence as a broken surface. This case gives its card TWO models for that reason, and the failure text says so.',
} as const satisfies SittingRecipe
