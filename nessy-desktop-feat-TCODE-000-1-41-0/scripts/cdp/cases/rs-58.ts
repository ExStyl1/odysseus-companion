/**
 * RS-58 (D1.162 / ledger K34) — the model picker's provenance label PER ENTRY,
 * in BOTH pickers, on a packaged build.
 *
 * ## The clause this answers
 *
 * K34 cannot leave `partial ʰ` until the label is per ENTRY rather than one line
 * for the whole list, and until a packaged build has been driven with it. The
 * host half (`catalogueListed` stamped per row, THREE values) and the renderer
 * half (the per-entry mark in both pickers) were built by WI-p and WI-q; the
 * driven clause is what is owed, and sitting 4 correctly nulled it — the 1.39.0
 * artefact carried `model-catalogue-unlisted` ZERO times against its two sibling
 * testids at 1 each, and `4b2638db3` is not an ancestor of `b1f4f279c`.
 *
 * So the artefact question is asked FIRST, out of {@link ROW_ARTEFACT_MARKERS},
 * and the case BLOCKS rather than failing when the build predates its subject.
 *
 * ## Three states in ONE list, which is what "per entry" means
 *
 * `modelCatalogueMark` renders the mark for `catalogueListed === false` and
 * NOTHING for `true` and for `undefined` — and those last two are different
 * facts that must not be collapsed: `undefined` means nobody has asked this
 * endpoint, which is the state of a hand-typed list, a never-synced connection
 * AND every gateway card. Rendering it as `false` would tell a user their
 * gateway models are not in the catalogue.
 *
 * A read of one row cannot see any of that. This case plants all three states on
 * ONE connection and reads them in ONE picker pass, so "the mark is on the
 * unlisted row and on neither of its neighbours" is a single observation rather
 * than three runs compared afterwards.
 *
 * ## What is planted, and what is therefore NOT measured
 *
 * Two probe rows are APPENDED to the card's own model list through the app's own
 * `saveLlmConnection` — the same thing `rs-52.ts` does to the stored catalogue,
 * for the same reason: the alternative is a real upstream `/models` fetch, which
 * needs a credential no case may spend. The third state needs no plant at all:
 * the card's REAL rows carry no `catalogueListed`, because the gateway fetcher
 * deliberately leaves it `undefined`, so the production case of the third state
 * is the control rather than a fixture of one. The plant is READ BACK out of the
 * app's own store before anything is asserted, and the original list is restored
 * in a `finally` that reads it back again.
 *
 * **It creates no connection and deletes none.** The first draft of this case
 * called `setupLlmConnection` with a template slug and OVERWROTE the rig's own
 * gateway card — models and credential — on a profile that already held it, and
 * could not delete it afterwards because eleven sessions referenced it. A case
 * that has to delete what it made can damage the profile it is measuring; one
 * that appends two rows and puts the list back cannot.
 *
 * **The STAMPING is not this case's subject.** `mergeModelMetadata`
 * (`server-core/src/model-fetchers/index.ts`) is what decides the three values
 * and is unit-tested; the gateway fetcher deliberately leaves the field
 * `undefined`, which is why the gateway card cannot serve as the subject arm
 * here. What this case measures is the RENDERER half on the artefact, which is
 * the half the row says is owed.
 */

import { requireArtifactCarries, ROW_ARTEFACT_MARKERS } from '../lib/artifact-carries.ts'
import { resolveAppUnderTest } from '../lib/bundle.ts'
import type { CdpSession } from '../lib/connect.ts'
import { pressKey } from '../lib/keys.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import type { CaseMeta } from '../lib/sitting.ts'
import { assertElectronApi, freshSession, selectorCount, visibleElements } from '../lib/state.ts'
import { clickAt, getViewport, resizeWindow } from '../lib/viewport.ts'

const ID = 'RS-58'
const TITLE = 'the model picker\'s catalogue-provenance label PER ENTRY, in both pickers, on a packaged build'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.162',
  runtimes: ['pi'],
  credentials:
    'owner: any Pi card the profile already holds. The case creates NO connection, reads no key and drives no turn: '
    + 'it appends two probe rows to that card\'s stored model list through the app\'s own `saveLlmConnection` and '
    + 'restores the original list in a `finally` that reads it back and asserts the restore.',
} as const satisfies CaseMeta

/** Same widths as `rs-44.ts`, and for its stated reason: a margin, not the boundary. */
const COMPACT_WIDTH = 700
const DESKTOP_WIDTH = 1400

const FOOTER_MENU_TRIGGER = '[data-composer-actions] button[aria-haspopup="menu"]'
const COMPACT_FOOTER_DIALOG_TRIGGER = '[data-composer-actions] button[aria-haspopup="dialog"]'
const OPEN_MENU = '[role="menu"][data-state="open"]'
const OPEN_DIALOG = '[role="dialog"][data-state="open"]'
const INTEGRATION_TOGGLE = '[role="menu"][data-state="open"] button[aria-expanded]:not([role="menuitem"])'
const PROVENANCE_LINE = '[data-testid="model-list-provenance"]'
/** The subject: the PER-ENTRY mark, inside a model row. */
const UNLISTED_MARK = '[data-testid="model-catalogue-unlisted"]'
/**
 * The two pickers' ROW elements, and they are not the same element.
 *
 * `ComposerModelMenu` (`DesktopModelPickerMenu` until UB14.30) renders
 * `StyledDropdownMenuItem`, which is a Radix menu item and NOT a `<button>`; `CompactModelSelector` renders a real
 * `<button>` inside a `DrawerClose`. The first draft of this case read
 * `<container> button` for both and found ONE row in the desktop menu with none
 * of its models among them — while the mark was on the page. That reads exactly
 * like the desktop picker not rendering per-entry marks, which is the 1.39.0
 * finding this case exists to re-take, arrived at from an instrument fault.
 */
const DESKTOP_ROW = '[role="menu"][data-state="open"] [role="menuitem"]'
const COMPACT_ROW = '[role="dialog"][data-state="open"] button'

/** The two probe rows. The THIRD state is the card's own rows, unplanted. */
const SUBJECT_MODEL = 'cdp-unlisted-model'
const LISTED_MODEL = 'cdp-listed-model'

interface RowRead {
  text: string
  /** Whether THIS row carries the per-entry mark. */
  unlisted: boolean
  markText?: string
  markTitle?: string
}

/**
 * Every visible row inside whichever picker is open, each with whether the mark
 * is INSIDE it.
 *
 * The containment test is the whole instrument: a mark rendered once under the
 * list — the state K34 refuses to leave `partial` for — is inside NO row, so a
 * build with the one-line form answers `unlisted: false` on every row while the
 * testid is on screen. The count of marks on the page is therefore read too.
 */
async function pickerRows(session: CdpSession, rowSelector: string): Promise<RowRead[]> {
  return session.call<RowRead[]>(`
    return Array.from(document.querySelectorAll(${JSON.stringify(rowSelector)}))
      .filter(el => {
        const s = window.getComputedStyle(el)
        return s.visibility !== 'hidden' && s.display !== 'none' && el.getClientRects().length > 0
      })
      .map(el => {
        const mark = el.querySelector(${JSON.stringify(UNLISTED_MARK)})
        return {
          text: (el.innerText ?? el.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 200),
          unlisted: mark !== null,
          markText: mark ? (mark.innerText ?? mark.textContent ?? '').replace(/\\s+/g, ' ').trim() : undefined,
          markTitle: mark ? (mark.getAttribute('title') ?? '').replace(/\\s+/g, ' ').trim().slice(0, 300) : undefined,
        }
      })
  `)
}

interface Hit { found: boolean; rect?: { x: number; y: number; width: number; height: number }; covered?: string | null }

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
    const under = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2))
    const covered = !under
      ? 'nothing-at-point'
      : (el.contains(under) || under.contains(el)) ? null : (under.tagName + '.' + String(under.className).slice(0, 60))
    return { found: true, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, covered }
  `)
}

/**
 * Click the index-th visible match, refusing rather than clicking blind — and
 * closing what covers it rather than waiting longer, which is the repair
 * `rs-44.ts` measured on this same footer (a previous dialog's own hint
 * paragraph sits over a 26 px footer with `pointer-events: auto`).
 */
async function clickVisible(session: CdpSession, selector: string, index: number, label: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const hit = await hitRead(session, selector, index)
    if (!hit.found || !hit.rect) throw new Error(`click refused: ${label} — no visible element at index ${index}`)
    if (!hit.covered) {
      await clickAt(session, {
        x: Math.round(hit.rect.x + hit.rect.width / 2),
        y: Math.round(hit.rect.y + hit.rect.height / 2),
      }, label)
      return
    }
    await pressKey(session, 'Escape')
    for (let settle = 0; settle < 8; settle += 1) {
      if ((await selectorCount(session, OPEN_DIALOG)) === 0 && (await selectorCount(session, OPEN_MENU)) === 0) break
      await Bun.sleep(250)
    }
    await Bun.sleep(500)
  }
  const last = await hitRead(session, selector, index)
  throw new Error(`click refused: ${label} is covered by ${last.covered} — an overlay would eat this click silently`)
}

async function closeAnyPicker(session: CdpSession): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if ((await selectorCount(session, OPEN_MENU)) === 0 && (await selectorCount(session, OPEN_DIALOG)) === 0) return
    await pressKey(session, 'Escape')
    await Bun.sleep(400)
  }
}

/**
 * Open the DESKTOP picker, identified by what it contains rather than by copy —
 * the menu carrying the integration expand toggle (`rs-44.ts`'s identification,
 * restated because a case may not edit `lib/`).
 */
async function openDesktopPicker(session: CdpSession): Promise<void> {
  await closeAnyPicker(session)
  const triggers = await visibleElements(session, FOOTER_MENU_TRIGGER)
  if (triggers.length === 0) {
    blocked(
      'the composer footer has no dropdown trigger — on a narrow layout the compact drawer controls render instead. '
      + 'Widen the window and re-run.',
    )
  }
  for (let index = 0; index < triggers.length; index += 1) {
    await clickVisible(session, FOOTER_MENU_TRIGGER, index, `composer footer menu trigger #${index}`)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await selectorCount(session, OPEN_MENU)) > 0) break
      await Bun.sleep(250)
    }
    if ((await selectorCount(session, INTEGRATION_TOGGLE)) === 1) return
    await closeAnyPicker(session)
  }
  blocked(
    `none of the ${triggers.length} composer-footer menus carries the integration expand toggle, so the model picker `
    + 'could not be identified. It refuses to open while a turn is in flight and when the connection is unavailable.',
  )
}

/** Open the COMPACT picker — a Radix drawer, identified by its provenance line. */
async function openCompactPicker(session: CdpSession): Promise<boolean> {
  await closeAnyPicker(session)
  await Bun.sleep(1_500)
  const triggers = await visibleElements(session, COMPACT_FOOTER_DIALOG_TRIGGER)
  for (let index = 0; index < triggers.length; index += 1) {
    await clickVisible(session, COMPACT_FOOTER_DIALOG_TRIGGER, index, `compact footer dialog trigger #${index}`)
    for (let attempt = 0; attempt < 16; attempt += 1) {
      if ((await selectorCount(session, OPEN_DIALOG)) > 0) break
      await Bun.sleep(250)
    }
    if ((await selectorCount(session, PROVENANCE_LINE)) > 0) return true
    await pressKey(session, 'Escape')
    await Bun.sleep(600)
  }
  return false
}

interface StoredModel { id?: string; name?: string; catalogueListed?: boolean }
interface StoredConnection { slug?: string; name?: string; providerType?: string; models?: Array<StoredModel | string> }

async function connections(session: CdpSession): Promise<StoredConnection[]> {
  return session.call<StoredConnection[]>(`
    const res = await window.electronAPI.listLlmConnections()
    return (res?.connections ?? res ?? []).map(c => ({
      slug: c.slug, name: c.name, providerType: c.providerType, models: c.models ?? [],
    }))
  `)
}

/** The three rows' states, as the app's OWN store reports them back. */
function plantedStates(models: Array<StoredModel | string>, unaskedId: string): Record<string, unknown> {
  const byId = new Map(models
    .filter((m): m is StoredModel => typeof m === 'object' && m !== null)
    .map(m => [m.id ?? '', 'catalogueListed' in m ? m.catalogueListed : undefined]))
  return {
    [SUBJECT_MODEL]: byId.has(SUBJECT_MODEL) ? byId.get(SUBJECT_MODEL) : 'row absent',
    [LISTED_MODEL]: byId.has(LISTED_MODEL) ? byId.get(LISTED_MODEL) : 'row absent',
    [unaskedId]: byId.has(unaskedId) ? byId.get(unaskedId) : 'row absent',
  }
}

/** One picker's reading, scored the same way at both widths. */
function scoreArm(
  run: CaseRun,
  where: string,
  rows: RowRead[],
  marksOnPage: number,
  unasked_: { id: string; name: string },
): void {
  const subject = rows.filter(row => row.text.includes(SUBJECT_MODEL))
  const listed = rows.filter(row => row.text.includes(LISTED_MODEL))
  // A picker row shows the model's NAME, not its id — the two probe rows are
  // named after themselves so either works for them, and the card's own row is
  // not: matching it by id found nothing while the row read "DeepSeek V4 Flash",
  // which scored the third arm as absent rather than as unmarked.
  const unasked = rows.filter(row => row.text.includes(unasked_.name) || row.text.includes(unasked_.id))
  run.observe(`${where} — the three planted rows`, {
    subject: subject.map(r => ({ text: r.text.slice(0, 60), unlisted: r.unlisted, markText: r.markText })),
    listed: listed.map(r => ({ text: r.text.slice(0, 60), unlisted: r.unlisted })),
    unasked: unasked.map(r => ({ text: r.text.slice(0, 60), unlisted: r.unlisted })),
    marksOnPage,
  })
  run.check(
    `${where}: THE CONTROL — all three planted rows are on screen`,
    subject.length > 0 && listed.length > 0 && unasked.length > 0,
    `subject=${subject.length} listed=${listed.length} unasked=${unasked.length} of ${rows.length} visible row(s). `
    + 'A row that is not rendered cannot carry a mark, so every verdict below would be equally true of a picker that '
    + 'listed nothing',
  )
  run.check(
    `${where}: the UNLISTED row carries the per-entry mark`,
    subject.some(row => row.unlisted),
    `the subject row's own mark: ${JSON.stringify(subject.map(r => r.markText ?? null))}. ${marksOnPage} mark(s) are `
    + 'on the page in total — a mark on the page that is inside NO row is the one-line form K34 refuses to leave '
    + '`partial` for, and this check is what tells the two apart',
  )
  run.check(
    `${where}: the mark reads as text a user can understand`,
    subject.some(row => (row.markText ?? '').trim().length > 0),
    `the mark's text is ${JSON.stringify(subject.map(r => r.markText ?? null))} — a mark rendering empty is `
    + 'indistinguishable from no mark to a user, which is the same failure `rs-44.ts` guards on its own badge',
  )
  run.check(
    `${where}: THE CONTROL — the LISTED row carries none`,
    listed.every(row => !row.unlisted),
    'the row the catalogue confirmed is marked too, so the mark is not per entry at all — it is on every row, and a '
    + 'user learns nothing from it',
  )
  run.check(
    `${where}: THE CONTROL — the NEVER-ASKED row carries none (undefined is not false)`,
    unasked.every(row => !row.unlisted),
    'a row nobody has asked the endpoint about is marked as NOT LISTED. That is the one rendering WI-p\'s host half '
    + 'names as forbidden: it would tell a user their gateway models are missing from the catalogue, because every '
    + 'gateway card\'s rows are `undefined` by design',
  )
  run.check(
    `${where}: EXACTLY ONE row carries the mark`,
    rows.filter(row => row.unlisted).length === 1,
    `${rows.filter(row => row.unlisted).length} of ${rows.length} visible row(s) carry it — the per-entry claim is `
    + 'that the mark distinguishes rows, and one that is on none or on all does not',
  )
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)

  // ---- the artefact question, before the product is asked anything ---------
  requireArtifactCarries(run, resolveAppUnderTest(session), ROW_ARTEFACT_MARKERS['D1.162']!)

  const before = await connections(session)
  run.observe('the cards this profile holds', before.map(c => ({ slug: c.slug, providerType: c.providerType })))
  const card = before.find(c => (c.providerType ?? '').startsWith('pi'))
  if (!card?.slug) {
    blocked(
      'this profile holds no Pi card, so there is no model list to read a per-entry mark in. It lists: '
      + `${before.map(c => `${c.slug}(${c.providerType})`).join(', ') || 'nothing'}. Press the onboarding's `
      + 'one-click "Nessy · Pi agent" button first — RS-32 drives exactly that.',
    )
  }
  const slug = card.slug
  const originalModels = card.models ?? []
  run.observe('the card under test, and its own model rows', { slug, models: originalModels })
  // The THIRD state, and it is production rather than a fixture: the gateway
  // fetcher leaves `catalogueListed` undefined on every row it writes.
  const unaskedRow = originalModels
    .filter((m): m is StoredModel => typeof m === 'object' && m !== null)
    .find(m => !('catalogueListed' in m))
  if (!unaskedRow?.id) {
    blocked(
      'every row on this card already carries a `catalogueListed` value, so the NEVER-ASKED state has no row to be '
      + 'read on — and that state is the one WI-p\'s host half says must never render as "not listed". '
      + `The rows are ${JSON.stringify(originalModels)}.`,
    )
  }
  const unaskedId = unaskedRow.id
  const unaskedName = unaskedRow.name ?? unaskedRow.id

  const originalViewport = await getViewport(session)
  run.observe('the viewport this run started in', originalViewport)
  let planted = false
  try {
    // ---- two probe rows APPENDED to the card's own list --------------------
    //
    // Appended, never replacing: the card's real rows are the third arm, and a
    // case that rewrites the list it is measuring has nothing left to restore.
    const saved = await session.call<{ success?: boolean; error?: string }>(`
      const res = await window.electronAPI.getLlmConnection(${JSON.stringify(slug)})
      const conn = res?.connection ?? res
      conn.models = (conn.models ?? []).concat(${JSON.stringify([
        { id: SUBJECT_MODEL, name: SUBJECT_MODEL, provider: 'pi', catalogueListed: false },
        { id: LISTED_MODEL, name: LISTED_MODEL, provider: 'pi', catalogueListed: true },
      ])})
      return await window.electronAPI.saveLlmConnection(conn)
    `)
    planted = saved?.success === true
    run.observe('the plant', saved)
    const afterPlant = await connections(session)
    const states = plantedStates((afterPlant.find(c => c.slug === slug)?.models ?? []), unaskedId)
    run.observe('the three states as the app STORED them', states)
    // THE PLANT'S OWN CONTROL. A build that dropped the field on write would make
    // every renderer verdict below a reading about the STORE — and `false` and
    // "row absent" are exactly the two ways that happens.
    run.require(
      'THE CONTROL — the three `catalogueListed` states are in the app\'s own store',
      states[SUBJECT_MODEL] === false && states[LISTED_MODEL] === true && states[unaskedId] === undefined,
      `the store reports ${JSON.stringify(states)} — the renderer cannot be measured against a plant that did not `
      + 'land, and a stripped field here is a finding about `saveLlmConnection`, not about the picker',
    )

    const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
    run.check('the case ran in a session it created', key.fresh, key.reason ?? '')
    await Bun.sleep(1_500)

    // ---- arm 1: the DESKTOP picker ----------------------------------------
    await resizeWindow(session, DESKTOP_WIDTH, Math.max(originalViewport.height, 900))
    await Bun.sleep(1_500)
    await openDesktopPicker(session)
    const desktopRows = await pickerRows(session, DESKTOP_ROW)
    const desktopMarks = await selectorCount(session, UNLISTED_MARK)
    scoreArm(run, 'the DESKTOP picker', desktopRows, desktopMarks, { id: unaskedId, name: unaskedName })
    await closeAnyPicker(session)

    // ---- arm 2: the COMPACT picker ----------------------------------------
    await resizeWindow(session, COMPACT_WIDTH, Math.max(originalViewport.height, 900))
    await Bun.sleep(1_500)
    const opened = await openCompactPicker(session)
    run.check(
      'the COMPACT picker opened at all',
      opened,
      'no footer drawer carried the model-list provenance line, so the compact arm measured nothing — read this '
      + 'before the verdicts below, which are all vacuous without it',
    )
    const compactRows = await pickerRows(session, COMPACT_ROW)
    const compactMarks = await selectorCount(session, UNLISTED_MARK)
    scoreArm(run, 'the COMPACT picker', compactRows, compactMarks, { id: unaskedId, name: unaskedName })
    await closeAnyPicker(session)
  } finally {
    await resizeWindow(session, originalViewport.width, originalViewport.height).catch(() => undefined)
    if (planted) {
      // Restore by writing the ORIGINAL list back, then READ IT BACK — the
      // restore is the half a mutation harness gets wrong (AGENTS.md), so it is
      // asserted rather than assumed.
      const restored = await session.call<{ success?: boolean; error?: string }>(`
        const res = await window.electronAPI.getLlmConnection(${JSON.stringify(slug)})
        const conn = res?.connection ?? res
        conn.models = ${JSON.stringify(originalModels)}
        return await window.electronAPI.saveLlmConnection(conn)
      `).catch((cause: unknown) => ({ error: String(cause) }))
      const readBack = await connections(session).catch(() => [])
      const rows = readBack.find(c => c.slug === slug)?.models ?? []
      const probeRowsLeft = rows.filter(m => typeof m === 'object' && m !== null
        && (m.id === SUBJECT_MODEL || m.id === LISTED_MODEL)).length
      run.observe('the card\'s model list was restored', {
        restored, probeRowsLeft, rows: rows.length, wasBefore: originalModels.length,
      })
      run.check(
        'THE RESTORE — the card carries its own rows again and neither probe row',
        probeRowsLeft === 0 && rows.length === originalModels.length,
        `${probeRowsLeft} probe row(s) still on the card and ${rows.length} row(s) against ${originalModels.length} `
        + 'before — this profile is left mutated, and every later reading on it is against a catalogue this case wrote',
      )
    }
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
