/**
 * RS-34 (rows C3.246 + C5.34) — the four dialogs the CHAT PANE opens, measured
 * in the running app: where their boxes actually land, and what the keyboard
 * and the mouse do to them.
 *
 * ## Why a live case and not another render test
 *
 * C3.244 fixed the anchor of these four dialogs by changing the CONTAINING
 * BLOCK: `CHAT_PANE_ANCHOR_CLASS` (`relative`) on the pane root, `absolute
 * inset-0` on `ChatPaneOverlay`. That is width-independent by construction, so
 * the unit tests assert the class strings and the source shape — which is the
 * right test for a rule with no measurement in it, and cannot see the one thing
 * the owner actually reported: a dialog sliding under the session list. jsdom
 * has no layout, so `getBoundingClientRect()` there is all zeros and an anchored
 * box and a window-anchored box are the same object. C3.246 exists for exactly
 * that gap: the pixel proof this tree cannot take in a unit test.
 *
 * C5.34 is the other half — the dialogs' BEHAVIOUR, which C3.247 left at a
 * source read: a click inside must not dismiss, Escape must, and the centring
 * must hold in both sidebar states.
 *
 * ## The detector, and the control that makes it mean something
 *
 * Everything here is `getBoundingClientRect()` on four boxes: the pane root, the
 * overlay (`[role="dialog"]`), the overlay's single element child (the panel),
 * and a `.session-item` row, which is the cheapest honest proxy for "how far
 * right the sidebar reaches" — it is a real row of the list the owner's
 * screenshot shows the dialog sliding under.
 *
 * A rect read is trivially faked by a rig that reports constants, so the case
 * carries a POSITIVE CONTROL rather than an absence: the sidebar is collapsed
 * and every box is read AGAIN. The pane's centre and the panel's centre must
 * both move, by the SAME non-zero amount. A detector reading a constant, or
 * reading the window instead of the pane, cannot produce that. It is also the
 * arm that proves the assertion below is not vacuous: with the rail hidden the
 * pane is wider and its centre moves TOWARDS the window centre, so
 * "not window-centred" is a statement about this build's geometry and not about
 * the arithmetic.
 *
 * `offsetParent` is asserted as well, and it is the structural half of the same
 * claim: for an `absolute` element it IS the containing block, so
 * `dialog.offsetParent === pane` is the DOM saying `CHAT_PANE_ANCHOR_CLASS` is
 * doing its job. A `fixed` overlay — the bug C3.244 fixed — reports `null`.
 *
 * ## The openers are the product's own, and one of them is not a slash command
 *
 * `agents`, `context` and `usage` are palette commands and are selected through
 * `selectSlashCommand` with `submitOnSelect`, which is the harness's own rule:
 * selection is what turns typed text into a command. `rewind` is NOT in the
 * palette — `rewindCommandOpensMenu` is read off the raw composer text inside
 * `ChatDisplay`'s single `onSubmit` — so this case uses the OTHER documented
 * opener, `Esc Esc` on an empty composer, which `checkpointing.md` names and
 * `rs-05` already drives.
 *
 * ## No turn is sent, deliberately
 *
 * Every one of these dialogs renders off `session` alone. The rewind menu with
 * no rewindable prompt renders its own empty sentence and still mounts the
 * overlay, which is the surface this case measures. So the case needs no model,
 * no card and no credential — it runs on a rig whose gateway is refusing every
 * turn, which is the rig this was first driven on.
 */
import { attach } from '../lib/connect.ts'
import { clearComposer, focusComposer, selectSlashCommand } from '../lib/composer.ts'
import { pressKey } from '../lib/keys.ts'
import { main, type CaseRun } from '../lib/report.ts'
import { buttonLabelInPage, CANCEL_BUTTON_TEXTS, CLOSE_BUTTON_TEXTS } from '../lib/runtime-switch.ts'
import { freshSession, selectorCount } from '../lib/state.ts'
import { clickAt, clickSelector } from '../lib/viewport.ts'
import type { CaseMeta } from '../lib/sitting.ts'
import type { CdpSession } from '../lib/connect.ts'

const ID = 'RS-34'
const TITLE = 'The four chat-pane dialogs: their boxes against the pane, and what a click and Escape do to them'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'C3.246',
  // A renderer surface, so the answer is the same on every card — but the
  // vocabulary is per FAMILY and a case that named one would read as a claim
  // about that one. Nothing here spawns an agent.
  runtimes: ['pi', 'claude', 'codex'],
  credentials: 'none — no turn is sent and no card is read; a profile with no connection at all will do',
} as const satisfies CaseMeta

/** The pane root: the element `CHAT_PANE_ANCHOR_CLASS` is composed onto. */
const PANE_CLASS_FRAGMENT = 'flex h-full flex-col min-w-0'
const DIALOG = '[role="dialog"]'
const SIDEBAR_TOGGLE = 'button[aria-label="Toggle Sidebar"]'

interface Box { x: number; y: number; w: number; h: number }
interface Reading {
  win: Box
  pane: Box | null
  paneIsPositioned: boolean
  label: string | null
  overlay: Box | null
  panel: Box | null
  offsetParentIsPane: boolean | null
  sessionItem: Box | null
}

/**
 * One read of every box at once.
 *
 * In ONE evaluation on purpose: four rects taken in four round trips can
 * straddle a re-layout, and a case that reports a dialog half a frame out of
 * step with its pane would be reporting the rig.
 */
async function read(session: CdpSession): Promise<Reading> {
  return session.call<Reading>(`
    const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
    const panes = [...document.querySelectorAll('div')].filter(d => (d.className || '').toString().includes(${JSON.stringify(PANE_CLASS_FRAGMENT)}))
    if (panes.length > 1) throw new Error('ambiguous-pane: ' + panes.length + ' chat panes on screen — run this case with a single content panel open')
    const pane = panes[0] ?? null
    const dialog = document.querySelector(${JSON.stringify(DIALOG)})
    const panel = dialog ? dialog.firstElementChild : null
    return {
      win: { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight },
      pane: box(pane),
      paneIsPositioned: pane ? getComputedStyle(pane).position !== 'static' : false,
      label: dialog ? dialog.getAttribute('aria-label') : null,
      overlay: box(dialog),
      panel: box(panel),
      offsetParentIsPane: dialog ? (dialog.offsetParent === pane) : null,
      sessionItem: box(document.querySelector('.session-item')),
    }
  `)
}

const centreX = (b: Box): number => b.x + b.w / 2
const right = (b: Box): number => b.x + b.w
const sameBox = (a: Box, b: Box): boolean =>
  Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.w - b.w) <= 1 && Math.abs(a.h - b.h) <= 1

/** Is a chat-pane dialog on screen right now? */
async function dialogOpen(session: CdpSession): Promise<boolean> {
  return (await selectorCount(session, DIALOG)) > 0
}

/**
 * Close whatever is open, by every shipped route in turn, and SAY which one
 * worked.
 *
 * `rs-05`'s own docblock records what a dialog left standing costs: the next
 * arm's first keystroke dies with `composer-not-focusable` and the case fails
 * minutes later with a message that names no dialog. So this never returns
 * quietly — the route is reported, and `still-open` is a value the caller
 * checks.
 */
async function closeDialog(session: CdpSession): Promise<string> {
  if (!(await dialogOpen(session))) return 'already-closed'
  await pressKey(session, 'Escape')
  await Bun.sleep(350)
  if (!(await dialogOpen(session))) return 'escape'
  const clicked = await session.call<boolean>(`
    const d = document.querySelector(${JSON.stringify(DIALOG)})
    const b = d && [...d.querySelectorAll('button')].find(${buttonLabelInPage([...CANCEL_BUTTON_TEXTS, ...CLOSE_BUTTON_TEXTS])})
    if (!b) return false
    b.click()
    return true
  `).catch(() => false)
  await Bun.sleep(350)
  if (!(await dialogOpen(session))) return clicked ? 'close-button' : 'vanished'
  // The backdrop: a point inside the overlay but outside the panel. The overlay
  // IS the pane, so its top-left corner plus a few pixels is always such a point
  // while the panel is centred.
  const reading = await read(session)
  if (reading.overlay) {
    await clickAt(session, { x: reading.overlay.x + 6, y: reading.overlay.y + 6 }, 'backdrop')
    await Bun.sleep(350)
  }
  return (await dialogOpen(session)) ? 'STILL-OPEN' : 'backdrop'
}

/**
 * Wait for the dialog, do not sample it — the README's own rule, and it cost a
 * reading here before it was applied.
 *
 * The first run of this case slept 700 ms after each opener and scored
 * `sidebar-open/usage` as NEVER OPENED, while the identical opener in the
 * sidebar-collapsed arm of the same run produced `Session usage` — i.e. the
 * case reported "the usage dialog does not open" about a dialog that does. A
 * fixed sleep on a rig running three packaged app instances is a coin flip; the
 * poll is not.
 */
async function waitForDialog(session: CdpSession, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await dialogOpen(session)) return true
    if (Date.now() >= deadline) return false
    await Bun.sleep(150)
  }
}

/** Open one dialog by the route the product gives the user for it. */
async function openDialog(session: CdpSession, which: string): Promise<void> {
  if (which === 'rewind') {
    // `Esc Esc` on an EMPTY composer — `checkpointing.md#rewind-and-summarize`,
    // and `ChatDisplay`'s own comment quoting it.
    await focusComposer(session)
    await clearComposer(session)
    await pressKey(session, 'Escape')
    await Bun.sleep(150)
    await pressKey(session, 'Escape')
    await waitForDialog(session)
    return
  }
  await selectSlashCommand(session, {
    token: which,
    // The palette also lists project skills whose names contain these words
    // (`/gsd-map-codebase` is in the `agents` list on this machine), so the row
    // is matched from the START of its visible text.
    match: new RegExp(`^${which}\\b`, 'i'),
    // These three act on SELECTION — `slash-command-actions.ts` calls
    // `openAgents` / `openContext` / `openUsage` and nothing is prefilled — so
    // the composer must come back empty. That assertion is the proof the APP
    // opened the dialog rather than the harness typing prose.
    expectComposer: '',
  })
  await waitForDialog(session)
}

interface DialogArm {
  which: string
  opened: boolean
  label: string | null
  reading: Reading
  clickInsideKeptOpen: boolean | null
  escapeClosed: boolean | null
  backdropClosed: boolean | null
  closedBy: string
}

async function driveDialog(session: CdpSession, run: CaseRun, which: string, state: string): Promise<DialogArm> {
  await openDialog(session, which)
  const opened = await dialogOpen(session)
  const reading = await read(session)
  let clickInsideKeptOpen: boolean | null = null
  let escapeClosed: boolean | null = null
  let backdropClosed: boolean | null = null

  if (opened && reading.panel) {
    // A click INSIDE the panel, on its own centre. Every one of the four stops
    // propagation on its panel root (three inline in `ChatDisplay`, the fourth
    // inside `RewindMenuPanel`), so the backdrop's `onClose` must not fire.
    await clickAt(session, { x: centreX(reading.panel), y: reading.panel.y + reading.panel.h / 2 }, `${which}-panel-centre`)
    await Bun.sleep(350)
    clickInsideKeptOpen = await dialogOpen(session)

    if (clickInsideKeptOpen) {
      await pressKey(session, 'Escape')
      await Bun.sleep(400)
      escapeClosed = !(await dialogOpen(session))

      if (!escapeClosed) {
        const again = await read(session)
        if (again.overlay) {
          await clickAt(session, { x: again.overlay.x + 6, y: again.overlay.y + 6 }, `${which}-backdrop`)
          await Bun.sleep(400)
        }
        backdropClosed = !(await dialogOpen(session))
      }
    }
  }

  const closedBy = await closeDialog(session)
  const arm: DialogArm = { which, opened, label: reading.label, reading, clickInsideKeptOpen, escapeClosed, backdropClosed, closedBy }
  run.observe(`${state}/${which}`, {
    opened,
    label: reading.label,
    pane: reading.pane,
    overlay: reading.overlay,
    panel: reading.panel,
    offsetParentIsPane: reading.offsetParentIsPane,
    clickInsideKeptOpen,
    escapeClosed,
    backdropClosed,
    closedBy,
  })
  return arm
}

/** Score one sidebar state's geometry. */
function scoreGeometry(run: CaseRun, state: string, arms: DialogArm[]): void {
  for (const arm of arms) {
    const { reading: r } = arm
    run.check(`${state}/${arm.which}: the dialog is on screen`, arm.opened, arm.label ?? 'no [role="dialog"] after the opener')
    if (!arm.opened || !r.pane || !r.overlay || !r.panel) continue

    run.check(
      `${state}/${arm.which}: the pane is the dialog's containing block`,
      r.offsetParentIsPane === true && r.paneIsPositioned,
      `offsetParentIsPane=${r.offsetParentIsPane} paneIsPositioned=${r.paneIsPositioned}`,
    )
    run.check(
      `${state}/${arm.which}: the backdrop IS the pane's box, not the window's`,
      sameBox(r.overlay, r.pane),
      `overlay=${JSON.stringify(r.overlay)} pane=${JSON.stringify(r.pane)} window=${JSON.stringify(r.win)}`,
    )
    run.check(
      `${state}/${arm.which}: the panel is centred on the pane`,
      Math.abs(centreX(r.panel) - centreX(r.pane)) <= 2,
      `panelCX=${centreX(r.panel)} paneCX=${centreX(r.pane)}`,
    )
    if (r.sessionItem) {
      run.check(
        `${state}/${arm.which}: neither the panel nor the backdrop reaches the session list`,
        r.panel.x >= right(r.sessionItem) && r.overlay.x >= right(r.sessionItem),
        `panel.x=${r.panel.x} overlay.x=${r.overlay.x} sessionItem.right=${right(r.sessionItem)}`,
      )
    }
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  const key = await freshSession(session, `CDP ${ID}`)
  run.require('a fresh session', key.fresh, JSON.stringify(key))

  // Nothing should be standing from a previous case, and if something is, the
  // first geometry read would be of THAT dialog under this one's name.
  const preexisting = await closeDialog(session)
  run.observe('dialog standing before the case', preexisting)
  run.require('no dialog was left standing by an earlier case', preexisting !== 'STILL-OPEN')

  const before = await read(session)
  run.require('the chat pane is on screen', before.pane !== null, JSON.stringify(before))
  run.observe('window', before.win)
  run.observe('pane with the sidebar open', before.pane)
  run.observe('session-item row', before.sessionItem)

  const order = ['agents', 'context', 'usage', 'rewind']
  const open: DialogArm[] = []
  for (const which of order) open.push(await driveDialog(session, run, which, 'sidebar-open'))
  scoreGeometry(run, 'sidebar-open', open)

  // ---- the owner's own complaint, as one number ---------------------------
  //
  // A window-anchored dialog centres on `win.w / 2`. With the sidebar open the
  // pane's centre is far from it, so the two are separable — and the control
  // below proves the separation is measured rather than assumed.
  const anchored = open.filter(a => a.opened && a.reading.panel && a.reading.pane)
  run.require('at least one dialog opened with the sidebar open', anchored.length > 0)
  for (const arm of anchored) {
    const r = arm.reading
    run.check(
      `sidebar-open/${arm.which}: the panel is NOT centred on the window`,
      Math.abs(centreX(r.panel!) - centreX(r.win)) >= 8,
      `panelCX=${centreX(r.panel!)} windowCX=${centreX(r.win)} paneCX=${centreX(r.pane!)}`,
    )
  }

  // ---- behaviour (C5.34) --------------------------------------------------
  //
  // THE CONTROL FOR THE ESCAPE DETECTOR, and it is inside the case rather than
  // beside it: the four dialogs are driven by the SAME `pressKey(session,
  // 'Escape')`, so if one of them closes, the key event reaches the app and a
  // dialog that stays up is the product's answer and not a dead key. `rewind`
  // is the one that carries its own handler (`rewind-menu.tsx`'s
  // `if (key === 'Escape') return { type: 'close' }`), so it is the arm that
  // establishes the control. Without this check a build where Escape reached
  // NOTHING would report the same four FAILs and read as four product defects.
  const escapeControl = open.find(a => a.escapeClosed === true)
  run.check(
    'THE CONTROL — the Escape key reaches the app at all (one dialog closes on it)',
    escapeControl !== undefined,
    escapeControl ? `${escapeControl.which} closed on Escape` : 'no dialog closed on Escape — every Escape verdict below is uninterpretable',
  )

  for (const arm of open) {
    if (!arm.opened) continue
    run.check(
      `sidebar-open/${arm.which}: a click INSIDE the panel does not dismiss it`,
      arm.clickInsideKeptOpen === true,
      arm.clickInsideKeptOpen === null ? 'not reached' : 'the panel click reached the backdrop',
    )
    if (arm.clickInsideKeptOpen) {
      run.check(
        `sidebar-open/${arm.which}: Escape closes it`,
        arm.escapeClosed === true,
        arm.escapeClosed === null ? 'not reached' : `still on screen after Escape; backdrop click closed it: ${arm.backdropClosed}`,
      )
    }
  }

  // ---- THE POSITIVE CONTROL: collapse the sidebar and read every box again --
  await clickSelector(session, SIDEBAR_TOGGLE)
  await Bun.sleep(900)
  const collapsed = await read(session)
  run.observe('pane with the sidebar collapsed', collapsed.pane)
  run.require('the sidebar toggle moved the pane', collapsed.pane !== null && before.pane !== null && collapsed.pane.x !== before.pane.x,
    `before=${JSON.stringify(before.pane)} after=${JSON.stringify(collapsed.pane)}`)

  const closedArms: DialogArm[] = []
  for (const which of order) closedArms.push(await driveDialog(session, run, which, 'sidebar-collapsed'))
  scoreGeometry(run, 'sidebar-collapsed', closedArms)

  const paneShift = centreX(collapsed.pane!) - centreX(before.pane!)
  const pairs = order
    .map(which => ({
      which,
      openArm: open.find(a => a.which === which),
      closedArm: closedArms.find(a => a.which === which),
    }))
    .filter(p => p.openArm?.reading.panel && p.closedArm?.reading.panel)
  run.require('both sidebar states produced a measurable panel for at least one dialog', pairs.length > 0)
  for (const p of pairs) {
    const shift = centreX(p.closedArm!.reading.panel!) - centreX(p.openArm!.reading.panel!)
    run.check(
      `THE CONTROL — ${p.which}: the panel's centre moves with the pane's, by the same amount`,
      Math.abs(shift - paneShift) <= 2 && Math.abs(paneShift) >= 8,
      `paneShift=${paneShift} panelShift=${shift}`,
    )
  }

  // Put the sidebar back, so the next case meets the layout it expects.
  await clickSelector(session, SIDEBAR_TOGGLE)
  await Bun.sleep(700)
  const restored = await read(session)
  run.observe('pane after restoring the sidebar', restored.pane)
  run.check(
    'the sidebar is restored for the next case',
    restored.pane !== null && before.pane !== null && Math.abs(restored.pane.x - before.pane.x) <= 1,
    `${JSON.stringify(restored.pane)} vs ${JSON.stringify(before.pane)}`,
  )
  run.check('no dialog is left standing', !(await dialogOpen(session)))
}

if (import.meta.main) await main(ID, TITLE, drive)
