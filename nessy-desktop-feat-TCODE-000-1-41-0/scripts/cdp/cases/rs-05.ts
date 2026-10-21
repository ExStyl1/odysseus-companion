/**
 * RS-05 (row P6.107) — the rewind menu's item set and its toast on claude and on
 * codex, where `partial` was propagated from Pi and never measured.
 *
 * Ledger F2/claude and F2/codex, both marker `s` — a claim, not a measurement.
 * The measurement is of OUR OWN renderer, so there is no native mechanism to
 * enable: `rewind-menu.tsx` names no provider at all.
 *
 * ## The row's expectation needs one correction before it is driven
 *
 * `done_means` asks for an item set "byte-identical to Pi". At HEAD it cannot be,
 * and the reason is a feature rather than a defect: P6.103 gates the two code
 * restore buttons on `rewindOffersCodeRestore(selectedId, trackedChangeIds)`, so
 * an anchor with no tracked file changes renders WITHOUT them. The gate is
 * per-ANCHOR and explicitly not per-runtime — its own docblock says so, quoting
 * `checkpointing.md#rewind-and-summarize`: *"The two code restore options appear
 * only when the selected checkpoint has tracked file changes to revert."* But a
 * runtime with no checkpoint PRODUCER yields anchors with no tracked changes, so
 * the observable difference lands on the same surface the row is comparing.
 *
 * So the comparison this case actually makes is the honest one: **the item set
 * is identical across the three runtimes EXCEPT for the code restore buttons,
 * and their presence is recorded beside the anchor's tracked-change state rather
 * than being asserted away.** Each session is seeded with a real file edit for
 * exactly this reason: without one, every runtime looks the same for a reason
 * that has nothing to do with the runtime.
 *
 * A second correction, smaller: the button is labelled **"Rewind and restore
 * files"** (`messageMenu.rewindToHereRestoreFiles`), not "Restore code and
 * conversation" — that is the upstream page's wording, not this renderer's, and
 * a case hunting the page's string would find nothing on every runtime.
 *
 * ## Both documented openers, and the third behaviour people forget
 *
 * `checkpointing.md#rewind-and-summarize` specifies three things, and
 * `double-escape.ts` implements all three:
 *
 *   1. `/rewind` opens the menu;
 *   2. `Esc Esc` on an EMPTY composer opens the menu;
 *   3. `Esc Esc` with text in the composer CLEARS it instead.
 *
 * All three are driven, because (3) is the one that makes (2) a real branch
 * rather than a synonym.
 *
 * ## The toast, and the warning that must be ABSENT on the control
 *
 * `toast.conversationRewoundFilesNotTracked`: *"This session's runtime does not
 * track file edits, so no files were restored"*. It is rendered only on an
 * explicit `fileCheckpointsTracked === false` — `undefined` means the server
 * could not answer and is deliberately NOT a warning
 * (`utils/rewind-report.ts`). The Pi arm is the control: the sentence must not
 * appear there, or the toast comparison is measuring the renderer's fallback
 * rather than the runtime's capability.
 *
 * ## The codex mid-turn arm
 *
 * `P2.447`'s stated posture: `/rewind` opens mid-turn, and the KEYBOARD route
 * yields to the interrupt. codex's longer turns are the one place the two
 * openers could disagree, so the arm runs there — and the menu's own busy line
 * (*"Rewind is unavailable while the agent is working"*) is the surface that
 * says which of the two happened.
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { approvePermissionsWhile } from '../lib/ask-user.ts'
import {
  COMPOSER_SELECTOR, focusComposer, readComposer, submitComposer, typeIntoComposer,
} from '../lib/composer.ts'
import { resolveAppUnderTest } from '../lib/bundle.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { pressKey } from '../lib/keys.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { bindProject, buttonTextInPage, CANCEL_BUTTON_TEXTS, listConnections, runtimeOf, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import { getViewport } from '../lib/viewport.ts'
import type { CaseMeta } from '../lib/sitting.ts'
import {
  assertElectronApi, freshSession, isProcessing, selectorCount, selectorText, sessionCommandResult,
  setPermissionMode, waitFor, type SessionKey,
} from '../lib/state.ts'

const ID = 'RS-05'
const TITLE = 'The rewind menu item set and toast, measured on claude and codex against a Pi control in one run'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.107',
  runtimes: ['pi', 'claude', 'codex'],
  credentials: 'owner: one claude-runtime and one codex-runtime card, already signed in; no key is read here',
} as const satisfies CaseMeta

const DIALOG = '[role="dialog"]'
const MENU_LIST = '[role="dialog"] [role="listbox"]'
/** The menu itself. An EMPTY rewind menu has no listbox, so `MENU_LIST` cannot see it. */
const MENU_DIALOG = '[role="dialog"]'
const MENU_OPTIONS = '[role="dialog"] [role="option"]'
const MENU_BUTTONS = '[role="dialog"] button'
/**
 * The menu's ACTION buttons — the item set this row is actually about.
 *
 * `MENU_BUTTONS` matches the anchors too, because every anchor row IS a
 * `<button role="option">`. An anchor's label is the user's own prompt text
 * plus a clock time, so comparing `MENU_BUTTONS` across arms compares three
 * different SESSIONS' CONTENT and can never match: measured 2026-09-12 (R7),
 * where both non-Pi item-set checks failed on `rs05-pi.txt … 10:38 AM` against
 * `rs05-claude.txt … 10:39 AM` while the thing the row asks about was identical.
 */
const MENU_ACTIONS = '[role="dialog"] button:not([role="option"])'
const TOAST = '[data-sonner-toast]'

/** The renderer's own sentence for a runtime that tracks no file edits. */
const NOT_TRACKED = 'does not track file edits'
/** The menu's own sentence when a turn is in flight. */
const BUSY_LINE = 'Rewind is unavailable while the agent is working'
/** The label the row calls "Restore code and conversation". */
const RESTORE_FILES_LABEL = 'restore files'
/**
 * The seed write's leading words. The rewind menu lists each prompt by a TRUNCATED preview
 * (`rewindPromptPreview`), so the long temp path and the file name can be cut off; the lead never is.
 */
export const SEED_WRITE_LEAD = 'Please create a small text file'

interface MenuReading {
  open: boolean
  options: string[]
  buttons: string[]
  /** `buttons` minus the anchors: the comparable vocabulary. */
  actions: string[]
  offersCodeRestore: boolean
  busy: boolean
}

async function readMenu(session: CdpSession): Promise<MenuReading> {
  const lists = await selectorCount(session, MENU_LIST)
  if (lists === 0) {
    const dialogs = await selectorCount(session, DIALOG)
    // A dialog with no listbox is either the empty state or a different overlay;
    // either way it is not "the rewind menu with its item set".
    return {
      open: false, options: [], offersCodeRestore: false, busy: false,
      buttons: dialogs > 0 ? await selectorText(session, MENU_BUTTONS) : [],
      actions: dialogs > 0 ? await selectorText(session, MENU_ACTIONS) : [],
    }
  }
  const options = await selectorText(session, MENU_OPTIONS)
  const buttons = await selectorText(session, MENU_BUTTONS)
  const actions = await selectorText(session, MENU_ACTIONS)
  const dialogText = (await selectorText(session, DIALOG)).join(' ')
  return {
    open: true,
    options,
    buttons,
    actions,
    offersCodeRestore: actions.some(label => label.toLowerCase().includes(RESTORE_FILES_LABEL)),
    busy: dialogText.includes(BUSY_LINE),
  }
}

/** Wait for the menu rather than sampling it — the README's own rule. */
async function waitForMenu(session: CdpSession, timeoutMs = 8_000): Promise<MenuReading> {
  try {
    return await waitFor(() => readMenu(session), reading => reading.open, { timeoutMs, intervalMs: 200 })
  } catch {
    return readMenu(session)
  }
}

/**
 * Close the rewind menu — by the DIALOG, never by its list.
 *
 * This read `selectorCount(MENU_LIST)` and returned early when it was zero,
 * which is exactly what an OPEN BUT EMPTY menu looks like: a session with no
 * rewindable prompt renders *"No prompts to rewind to yet."* and no
 * `[role="listbox"]` at all. Measured 2026-09-11 on a profile created for the
 * run: the pi arm left that dialog up, the claude arm's first keystroke died
 * with `composer-not-focusable`, and the whole case failed 6.5 minutes later
 * with a message that says nothing about a dialog. The dialog then sat there and
 * took the next case down too.
 *
 * So: Escape, and if the dialog is still there, its own Cancel button — the
 * shipped way out — and the caller is told when neither worked rather than
 * finding out two cases later.
 */
async function closeMenu(session: CdpSession): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await selectorCount(session, MENU_DIALOG)) === 0) return 'closed'
    await pressKey(session, 'Escape')
    await Bun.sleep(400)
    if ((await selectorCount(session, MENU_DIALOG)) === 0) return 'closed'
    const cancelled = await session.call<boolean>(`
      const button = Array.from(document.querySelectorAll(${JSON.stringify(MENU_BUTTONS)}))
        .find(${buttonTextInPage(CANCEL_BUTTON_TEXTS)})
      if (!button) return false
      button.click()
      return true
    `).catch(() => false)
    if (!cancelled) await Bun.sleep(400)
  }
  return (await selectorCount(session, MENU_DIALOG)) === 0 ? 'closed' : 'STILL-OPEN'
}

/**
 * D1.356 — press `Esc Esc` where the app can HEAR it, and record what it would
 * have hit if it could not.
 *
 * SIT-5e drove this arm on all three runtimes and got `open: false` on every
 * one, INCLUDING the Pi control — a route that fails on the control is not a
 * per-runtime divergence, and the row's last paragraph asks whether the cause is
 * the instrument. Read off the shipped renderer, it is:
 *
 *  - the chord is a COMPONENT BEHAVIOUR of the composer, not a hotkey-map entry
 *    (`input/double-escape.ts` says so at length and states the product
 *    consequence: it is not user-rebindable). Its only listener is
 *    `FreeFormInput`'s own `onKeyDown`, so an Escape dispatched while focus sits
 *    anywhere else — on `body` after a dialog closed, on the Cancel button that
 *    closed it — never reaches the handler at all;
 *  - and that handler opens with `if (hasOpenOverlay()) return`, so a leftover
 *    Radix layer swallows the chord silently even WITH the composer focused.
 *
 * The previous arm pressed the two keys straight after `closeMenu()`, which
 * closes by Escape or by clicking Cancel — both of which leave focus off the
 * composer. So the reading was about focus, and it was recorded as being about
 * the runtime.
 *
 * The repair is the app's own route plus its own preconditions, each RECORDED
 * rather than assumed: dialogs gone, composer focused, `document.activeElement`
 * read back at the moment of the press. A run where any of them is false now
 * says which one, instead of producing a `false` that reads like a product fact.
 * `DOUBLE_ESCAPE_WINDOW_MS` is 2 000 in the shipped module, so the two presses
 * go out back to back with no sleep between them.
 */
interface DoubleEscapeRig {
  dialogsBefore: number
  focused: string
  activeAtPress: string
}

async function armDoubleEscape(session: CdpSession): Promise<DoubleEscapeRig> {
  const dialogsBefore = await selectorCount(session, MENU_DIALOG)
  const focused = await focusComposer(session).then(() => 'composer').catch(error => `refused: ${String(error)}`)
  const activeAtPress = await session.call<string>(`
    const el = document.activeElement
    if (!el) return 'null'
    const composer = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR)})
    return (el === composer ? 'COMPOSER ' : '') + (el.tagName || '?') + '.' + String(el.className || '').slice(0, 60)
  `).catch(error => `unread: ${String(error)}`)
  return { dialogsBefore, focused, activeAtPress }
}

interface RuntimeArm {
  runtime: string
  card: string
  slash: MenuReading
  doubleEscapeEmpty: MenuReading
  /** D1.356 — what the chord could have reached, recorded beside whether it did. */
  doubleEscapeRig: DoubleEscapeRig
  doubleEscapeWithText: {
    menuOpened: boolean
    composerAfter: string
    /** D1.356 — the positive control: the text the clear had to have a subject. */
    composerBefore: string
    rig: DoubleEscapeRig
  }
  toast: string[]
  filesNotTrackedWarning: boolean
}

/**
 * Three prompts, the second of which asks for a real file edit so the anchor CAN
 * carry a tracked change. `acceptEdits` is session-scoped and set on a session
 * this case created, so nothing of the operator's is touched.
 *
 * ## The approver, and why `acceptEdits` is not enough (R4, 2026-09-12)
 *
 * Measured on the packaged build driving C5.2: the claude arm's file write
 * raised a `Write` permission card ANYWAY — *"Permission required · Tool: Write ·
 * Write: …/rs05-claude.txt"*, two of them on screen — under a session whose mode
 * had been set to `acceptEdits` and confirmed. Nothing answered it, and the card
 * REPLACES the composer: `selectorCount('div[data-tutorial="chat-input"]')` was
 * **0** with `selectorCount('[data-tutorial="permission-banner"]')` at **2**, so
 * the next keystroke died as `composer-not-focusable: no element matched … the
 * pane is not showing a chat` and the whole case failed there — after eight
 * minutes of seeding, with a message that says nothing about a card.
 *
 * So the seed runs under the same approver `RS-20` uses, for the same reason:
 * permissions are not what this row asks about, and an unanswered card measures
 * the absence of an operator rather than the rewind menu. The count is reported,
 * because a seed that needed approvals is worth seeing — on a runtime where
 * `acceptEdits` really does cover the write it will read zero.
 *
 * ## The file is named by its ABSOLUTE path, in a project the arm is bound to (F1.915)
 *
 * The seed used to say "in the current working directory" on a session with no
 * project, and which folder that is depends on what the runtime TOLD the model:
 * SIT-aa's Pi arm aimed `Write` at the session folder, the file floor refused it
 * (managed storage), the model fell back to Bash, and the rewind tracker saw no
 * edit — so the Pi control failed on the rig, not on the menu (F1.907,
 * WJ-crit-ddd). Each arm is now bound to a folder the case mints under the OS
 * temp dir, and the prompt names the file's full path there
 * ({@link seedWritePrompt}): nothing is left to what the model believes is
 * current, on any runtime.
 */
export function seedWritePrompt(projectDir: string, runtime: string): string {
  return `${SEED_WRITE_LEAD} at the path ${join(projectDir, `rs05-${runtime}.txt`)} `
    + 'containing one line of your choosing, using your file-writing tool, then say DONE.'
}

/**
 * Which rewind anchor is the seed WRITE — the one whose restore-files button the toast route presses (F1.1250).
 *
 * The menu opens on the LAST prompt, the "how many things" question, and the restore-files button is
 * per-anchor (`rewindOffersCodeRestore`): it is correctly absent there, because that prompt edited nothing.
 * Reading only that anchor left the Pi control's toast clause unanswered at the 1.41.0 sitting (SIT2-f, the
 * residue F1.915's note names). `-1` when no anchor is the seed write — then nothing is selected or pressed.
 */
export function seedWriteAnchorIndex(options: string[]): number {
  return options.findIndex(label => label.includes(SEED_WRITE_LEAD))
}

/** The folder one arm is bound to — realpathed, because the app compares by the real path. */
export function mintArmProject(runtime: string): string {
  return mkdtempSync(join(realpathSync(tmpdir()), `cdp-rs05-${runtime}-`))
}

async function seed(session: CdpSession, run: CaseRun, key: SessionKey, runtime: string, projectDir: string): Promise<void> {
  await setPermissionMode(session, key.sessionId, 'acceptEdits')
  const approver = approvePermissionsWhile(session, key.sessionId)
  try {
    await sendPrompt(session, key, 'Reply with the single word READY.', 300_000).catch(() => undefined)
    await sendPrompt(session, key, seedWritePrompt(projectDir, runtime), 300_000).catch(() => undefined)
    await sendPrompt(session, key, 'How many things have I asked you to do so far? Answer with a digit.', 300_000)
      .catch(() => undefined)
  } finally {
    run.observe(`${runtime} — permission cards answered while seeding`, await approver.stop())
  }
  run.observe(`${runtime} — seeded`, 'three prompts, one of them a file write')
}

async function driveArm(session: CdpSession, run: CaseRun, runtime: string, card: string): Promise<RuntimeArm> {
  const key = await freshSession(session, `CDP ${ID} ${runtime} ${new Date().toISOString().slice(11, 19)}`)
  // The REASON, not just the count. `inherited 0 messages` says the fallback
  // session was empty — which is what keeps the readings clean — and nothing at
  // all about WHY the helper fell back, which is the only actionable half.
  // R6a made the identical fix to `rs-36.ts` (`fa9ff814a`) after a standing
  // trust dialog cost four runs; R7's first RS-05 run on 2026-09-12 scored this
  // very check FAIL on the pi arm with nothing in the log pointing anywhere.
  run.check(`${runtime}: the arm ran in a session it created`, key.fresh,
    key.fresh ? undefined
      : `inherited ${key.inheritedMessages} messages; reason: ${key.reason ?? '(none given)'}`)
  const moved = await switchRuntime(session, key.sessionId, card)
  run.observe(`${runtime} — switch onto ${card}`, moved)
  run.require(`${runtime}: the session reports ${card}`,
    (await waitForConnection(session, key.sessionId, card)) === card, card)

  // F1.915 — the arm's own folder, bound before the seed and removed at the end.
  const projectDir = mintArmProject(runtime)
  try {
    await bindProject(run, session, key.sessionId, projectDir, { label: runtime })
    await seed(session, run, key, runtime, projectDir)
    return await measureArm(session, run, key, runtime, card)
  } finally {
    try { rmSync(projectDir, { recursive: true, force: true }) } catch { /* the OS temp dir sweeps it */ }
  }
}

/** Everything after the seed: both openers, the clearing chord, and the toast. */
async function measureArm(session: CdpSession, run: CaseRun, key: SessionKey, runtime: string, card: string): Promise<RuntimeArm> {
  // ---- opener 1: the slash command -----------------------------------------
  await typeIntoComposer(session, '/rewind')
  await submitComposer(session).catch(() => undefined)
  const slash = await waitForMenu(session)
  run.observe(`${runtime} — /rewind`, slash)
  await closeMenu(session)

  // ---- opener 2: Esc Esc on an EMPTY composer ------------------------------
  // D1.356 — through the composer, which is the only listener there is. See
  // `armDoubleEscape`: the previous arm pressed straight after `closeMenu()`,
  // which leaves focus on `body` or on the Cancel button it clicked.
  const emptyRig = await armDoubleEscape(session)
  run.observe(`${runtime} — Esc Esc rig (empty composer)`, emptyRig)
  await pressKey(session, 'Escape')
  await pressKey(session, 'Escape')
  const doubleEscapeEmpty = await waitForMenu(session)
  run.observe(`${runtime} — Esc Esc (empty composer)`, doubleEscapeEmpty)

  // ---- behaviour 3: Esc Esc WITH text clears instead ------------------------
  await closeMenu(session)
  await typeIntoComposer(session, 'a draft nobody sent')
  // D1.356 — the POSITIVE CONTROL, and the reason this arm needed one: the check
  // it feeds reads `composerAfter.trim() === ''`, and an EMPTY composer in this
  // renderer reads back as a bare `"\n"` — so a run where the text never landed
  // at all passed the clear check with nothing to clear. SIT-5e recorded exactly
  // that `"\n"` on all three runtimes. Read the composer BEFORE the chord and
  // the two arms of the check can disagree again.
  const composerBefore = await readComposer(session)
  const withTextRig = await armDoubleEscape(session)
  await pressKey(session, 'Escape')
  await pressKey(session, 'Escape')
  await Bun.sleep(400)
  const doubleEscapeWithText = {
    menuOpened: (await selectorCount(session, MENU_LIST)) > 0,
    composerAfter: await readComposer(session),
    composerBefore,
    rig: withTextRig,
  }
  run.observe(`${runtime} — Esc Esc (composer holds text)`, doubleEscapeWithText)
  await closeMenu(session)

  // ---- the toast, from the restore-files route where it is offered ----------
  let toastLines: string[] = []
  await typeIntoComposer(session, '/rewind')
  await submitComposer(session).catch(() => undefined)
  let forRestore = await waitForMenu(session)
  // F1.1250 — select the seed write's OWN anchor before reading the button: the menu opens on the last prompt,
  // which edited nothing. Clicking an option selects it (`onSelect`); a double click would rewind.
  const writeAnchor = seedWriteAnchorIndex(forRestore.options)
  run.observe(`${runtime} — the seed write's anchor`, writeAnchor >= 0 ? forRestore.options[writeAnchor] : 'not listed')
  if (forRestore.open && writeAnchor >= 0) {
    await session.call(`
      const option = document.querySelectorAll(${JSON.stringify(MENU_OPTIONS)})[${writeAnchor}]
      if (option) option.click()
      return Boolean(option)
    `).catch(() => false)
    // The button waits on the server's tracked-anchor answer (fails closed until it lands), so wait, not sample.
    forRestore = await waitFor(() => readMenu(session), reading => reading.offersCodeRestore, { timeoutMs: 8_000, intervalMs: 250 })
      .catch(() => readMenu(session))
  }
  // What the SERVER says about this session's tracked anchors, beside what the
  // menu renders. `ChatDisplay.tsx` gates the code-restore button on this very
  // answer and, since D1.378 (`07e7fe619`), FAILS CLOSED until it lands —
  // `rewind-menu.tsx` symbol `rewindOffersCodeRestore` opens with
  // `if (!trackedChangeIds) return false`. So a button read the instant the
  // dialog appears can be the not-yet-answered state rather than an anchor with
  // nothing to restore. This comment said FAILS OPEN, which was true when it was
  // written (2026-09-12, R7) and is the behaviour D1.378 reversed. Recording
  // both readings makes the two distinguishable instead of collapsing them into
  // one boolean.
  run.observe(`${runtime} — the server's own tracked-anchor answer`,
    await sessionCommandResult(session, key.sessionId, { type: 'rewindTrackedChanges' })
      .catch(error => String(error)))
  if (forRestore.open && forRestore.offersCodeRestore) {
    // BY LABEL, in ONE page call. An index read in an earlier call can point at
    // a different button by the time the rect is taken — the menu's own button
    // list changes when the tracked-anchor answer lands — and a coordinate click
    // is the input that can miss. R6a measured exactly this on the permission
    // banner this same morning (`89de51f98`).
    //
    // D1.356 — and the predicate is now the SAME ONE the read used, which is why
    // this said "vanished" on all three runtimes including the Pi control.
    // `readMenu` resolves a label through `selectorText`, which falls back to
    // `textContent` when `innerText` comes back blank — the README's own trap 2,
    // a card inside a pane that sizes a frame later. This press matched on
    // `innerText` ALONE, so `offersCodeRestore` could see a button the press
    // could not, and a null was reported as the button having vanished. Two
    // reads of the same DOM must not use two predicates.
    const pressed = await session.call<{ clicked: string } | { missed: string[] }>(`
      const label = e => {
        const rendered = (e.innerText || '').replace(/\\s+/g, ' ').trim()
        return rendered || (e.textContent || '').replace(/\\s+/g, ' ').trim()
      }
      const all = Array.from(document.querySelectorAll(${JSON.stringify(MENU_ACTIONS)}))
      const b = all.find(e => /restore files/i.test(label(e)))
      if (!b) return { missed: all.map(label) }
      b.click()
      return { clicked: label(b) }
    `).catch(error => ({ missed: [`press-failed: ${String(error)}`] }))
    // A miss now NAMES what was on screen instead of asserting a cause. "The
    // button vanished between the read and the press" was a sentence nobody had
    // measured; the labels are.
    run.observe(`${runtime} — restore-files button pressed`, pressed)
    await Bun.sleep(2_500)
    toastLines = await selectorText(session, TOAST)
  } else {
    run.observe(`${runtime} — restore-files button`, 'not offered on this anchor; nothing to press')
  }
  run.observe(`${runtime} — toast`, toastLines)
  // Every arm hands the app back with no dialog on screen. An arm that does not
  // takes the NEXT arm down at its first keystroke, and the next case after that.
  run.observe(`${runtime} — menu at the end of the arm`, await closeMenu(session))

  return {
    runtime,
    card,
    slash,
    doubleEscapeEmpty,
    doubleEscapeRig: emptyRig,
    doubleEscapeWithText,
    toast: toastLines,
    filesNotTrackedWarning: toastLines.some(line => line.includes(NOT_TRACKED)),
  }
}

/**
 * Which arms to drive — `NESSY_CDP_RS05_RUNTIMES`, the knob `RS-25` and `RS-17`
 * already carry (C5.2, R4 2026-09-12).
 *
 * Default is all three, in the order the comparison needs, so nothing about an
 * ordinary run moves. The knob exists because the Pi arm can be UNDRIVABLE
 * while the other two answer, and then the case could not be run at all:
 * measured on the rig day, a lapsed `dp` CLI session makes every Pi turn end
 * `auth-request "Sign in to Developer Platform"` and leaves the composer holding
 * a bare newline, so the next `sendPrompt` cannot type into it and the arm sits
 * out its full 300 s timeout — twice, before the claude arm is reached.
 *
 * Excluding Pi does NOT make the run cheaper-and-equivalent: Pi is the control
 * for both comparisons, so `drive()` records the other arms' readings and then
 * BLOCKS. That is the honest shape — a reading without its control is a reading,
 * and this harness's own retraction exists because one was banked as a pass.
 */
function requestedRuntimes(): Array<'pi' | 'claude' | 'codex'> {
  const raw = process.env.NESSY_CDP_RS05_RUNTIMES?.trim()
  if (!raw) return ['pi', 'claude', 'codex']
  const names = raw.split(/[\s,]+/).filter(Boolean).map(name => name.toLowerCase())
  const unknown = names.filter(name => !['pi', 'claude', 'codex'].includes(name))
  if (unknown.length > 0) {
    blocked(`NESSY_CDP_RS05_RUNTIMES names ${unknown.join(', ')}; the vocabulary is pi, claude, codex`)
  }
  // Pi first whenever it is asked for, because it is the control.
  const ordered = (['pi', 'claude', 'codex'] as const).filter(name => names.includes(name))
  if (ordered.length === 0) blocked('NESSY_CDP_RS05_RUNTIMES selected no arm at all')
  return [...ordered]
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))

  const app = resolveAppUnderTest(session)
  run.observe('app under test', { kind: app.kind, via: app.via })
  run.check('the artefact under test is the PACKAGED app', app.kind === 'packaged',
    app.kind === 'packaged' ? undefined : `kind=${app.kind} — a dev build is not the shipped artefact`)

  const connections = await listConnections(session)
  const pick = (predicate: (providerType: string) => boolean): string | undefined =>
    connections.find(row => predicate(row.providerType))?.slug
  const cards = {
    pi: pick(type => runtimeOf(type) === 'pi'),
    claude: pick(type => runtimeOf(type) === 'anthropic'),
    codex: pick(type => runtimeOf(type) === 'codex-runtime'),
  }
  run.observe('cards', cards)
  if (!cards.pi || !cards.claude || !cards.codex) {
    blocked(
      'one session pair closes both ledger cells only if all three runtimes are on the same host and the same '
      + 'run — two readings on different days measure the day. Missing: '
      + [!cards.pi && 'pi', !cards.claude && 'claude', !cards.codex && 'codex'].filter(Boolean).join(', ')
      + `. The host lists ${connections.map(row => `${row.slug}(${row.providerType})`).join(', ') || 'nothing'}.`,
    )
  }
  await getViewport(session)

  // Pi FIRST, because it is the control every later comparison is made against.
  // The trio is re-bound after the guard above so the dynamic index below keeps
  // its narrowing — `cards[runtime]` on the original literal does not.
  const trio: Record<'pi' | 'claude' | 'codex', string> = { pi: cards.pi, claude: cards.claude, codex: cards.codex }
  const wanted = requestedRuntimes()
  run.observe('arms requested', wanted)
  const arms: RuntimeArm[] = []
  for (const runtime of wanted) {
    arms.push(await driveArm(session, run, runtime, trio[runtime]))
  }

  const control = arms.find(arm => arm.runtime === 'pi')
  if (!control) {
    // Everything the arms DID see, recorded and explicitly not compared. The
    // `blocked()` waits until the end of the case, so the codex mid-turn arm —
    // which needs no control and is half of what this row asks for — still runs.
    run.observe(
      'CONTROL — unavailable',
      'the Pi arm was not driven, so neither comparison below has a control: the item sets are reported as'
      + ' they were read and NOT compared, and the toast warning cannot be shown to distinguish a runtime.'
      + ' Every reading in this run is a reading; none of it closes a cell.',
    )
    for (const arm of arms) {
      run.observe(`${arm.runtime} — item set (uncompared)`, arm.slash.actions)
      run.observe(`${arm.runtime} — anchors (uncompared)`, arm.slash.options)
      run.observe(`${arm.runtime} — offers code restore`, arm.slash.offersCodeRestore)
      run.observe(`${arm.runtime} — files-not-tracked warning`, arm.filesNotTrackedWarning)
      run.observe(`${arm.runtime} — both openers`, {
        slash: arm.slash.open, escEsc: arm.doubleEscapeEmpty.open, escEscRig: arm.doubleEscapeRig,
      })
      run.observe(`${arm.runtime} — Esc Esc with text`, arm.doubleEscapeWithText)
      run.observe(`${arm.runtime} — toast`, arm.toast)
    }
    await driveCodexMidTurn(session, run, cards.codex)
    blocked(
      `the Pi arm is RS-05's control for both comparisons and it was not driven (arms: ${wanted.join(', ')}).`
      + ' Drive it with NESSY_CDP_RS05_RUNTIMES unset, on a host whose Pi card can complete a turn.',
    )
  }
  run.check(
    'THE CONTROL — the Pi arm opened the menu on both documented routes',
    control.slash.open && control.doubleEscapeEmpty.open,
    `slash=${control.slash.open} escEsc=${control.doubleEscapeEmpty.open} — without this the comparison below is against nothing. `
    + `The chord's own preconditions on this arm: ${JSON.stringify(control.doubleEscapeRig)}. `
    + 'A `focused` that is not `composer`, or a non-zero `dialogsBefore`, means the chord never reached '
    + '`FreeFormInput.onKeyDown` — its only listener — and this reading is about focus rather than about a runtime (D1.356).',
  )
  // The Pi toast has to come from a rewind that SUCCEEDED, or its silence proves
  // nothing. Measured 2026-09-12 (R7): the Pi arm's press answered
  // `Failed to rewind conversation Message not found` and the absence check
  // below scored ok against it — a control whose two arms cannot disagree, the
  // same shape as the two RS-17 detector faults fixed this same morning.
  const piToastFailed = control.toast.some(line => /failed to rewind/i.test(line))
  run.check(
    'THE CONTROL — the Pi arm produced a rewind toast at all, and not a failure',
    control.toast.length > 0 && !piToastFailed,
    control.toast.length === 0
      ? 'the Pi arm produced NO toast: either the restore-files button was never offered on its anchor, or the '
        + 'press did not reach the rewind. Either way there is nothing to compare and the toast clause is unanswered.'
      : `the Pi rewind FAILED (${JSON.stringify(control.toast)}), so the absence of the files-not-tracked warning `
        + 'below says nothing about whether Pi tracks file edits',
  )
  run.check(
    'THE CONTROL — the Pi toast carries no "does not track file edits" warning',
    !control.filesNotTrackedWarning,
    control.filesNotTrackedWarning
      ? 'the Pi arm warned too, so the warning is not distinguishing a runtime and the toast comparison is void'
      : undefined,
  )

  for (const arm of arms.filter(entry => entry.runtime !== 'pi')) {
    run.check(`${arm.runtime}: /rewind opens the menu`, arm.slash.open, JSON.stringify(arm.slash.buttons))
    run.check(`${arm.runtime}: Esc Esc on an empty composer opens the menu`, arm.doubleEscapeEmpty.open,
      `the chord's preconditions on this arm: ${JSON.stringify(arm.doubleEscapeRig)}`)
    // D1.356 — the clear now needs its subject. `composerAfter.trim() === ''` is
    // true of a composer that was empty all along, and an empty composer in this
    // renderer reads back as a bare `"\n"`; without the BEFORE reading the two
    // arms of this check cannot disagree.
    run.check(
      `${arm.runtime}: the Esc Esc-with-text arm had text to clear`,
      arm.doubleEscapeWithText.composerBefore.trim().length > 0,
      `the composer held ${JSON.stringify(arm.doubleEscapeWithText.composerBefore)} before the chord, so the `
      + 'CLEAR below has no subject and its pass would be vacuous',
    )
    run.check(
      `${arm.runtime}: Esc Esc with text CLEARS the composer instead of opening the menu`,
      !arm.doubleEscapeWithText.menuOpened
      && arm.doubleEscapeWithText.composerBefore.trim().length > 0
      && arm.doubleEscapeWithText.composerAfter.trim() === '',
      JSON.stringify(arm.doubleEscapeWithText),
    )
    // The corrected comparison: identical APART from the code-restore buttons,
    // whose presence is the anchor's tracked-change fact and is reported rather
    // than asserted.
    const strip = (labels: string[]): string[] =>
      labels.filter(label => !label.toLowerCase().includes(RESTORE_FILES_LABEL)).map(label => label.trim())
    run.check(
      `${arm.runtime}: the item set matches Pi once the per-anchor code-restore buttons are set aside`,
      JSON.stringify(strip(arm.slash.actions)) === JSON.stringify(strip(control.slash.actions)),
      `${JSON.stringify(strip(arm.slash.actions))} vs pi ${JSON.stringify(strip(control.slash.actions))}`,
    )
    // The ANCHORS are reported, never compared: they are the session's own
    // prompts and clock times, which differ by construction across three
    // sessions minted a minute apart.
    run.observe(`${arm.runtime} — anchors (reported, not compared)`, arm.slash.options)
    run.observe(`${arm.runtime} — offers code restore`, arm.slash.offersCodeRestore)
    run.observe(`${arm.runtime} — files-not-tracked warning`, arm.filesNotTrackedWarning)
  }

  await driveCodexMidTurn(session, run, cards.codex)
}

/**
 * The codex mid-turn arm — extracted so it runs on the no-Pi-control path too
 * (C5.2, R4 2026-09-12).
 *
 * It compares nothing against Pi: it asks whether codex's longer turns make the
 * two documented openers disagree, which is a question about one runtime. So it
 * is the half of this row that a host with an undrivable Pi card can still
 * answer, and leaving it after the control's `blocked()` would have thrown it
 * away.
 */
async function driveCodexMidTurn(session: CdpSession, run: CaseRun, codexCard: string): Promise<void> {
  const codexKey = await freshSession(session, `CDP ${ID} codex-midturn ${new Date().toISOString().slice(11, 19)}`)
  await switchRuntime(session, codexKey.sessionId, codexCard)
  await waitForConnection(session, codexKey.sessionId, codexCard)
  await sendPrompt(session, codexKey, 'Reply with the single word READY.', 300_000).catch(() => undefined)
  await typeIntoComposer(session, 'Please write a long, careful essay about the history of the metre, in several paragraphs.')
  await submitComposer(session).catch(() => undefined)
  const inFlight = await waitFor(() => isProcessing(session, codexKey), processing => processing, { timeoutMs: 60_000, intervalMs: 250 })
    .catch(() => false)
  run.observe('codex mid-turn: a turn was in flight', inFlight)
  if (!inFlight) {
    run.observe('codex mid-turn', 'the turn settled before the openers could be driven — re-run; this measured nothing')
  } else {
    await typeIntoComposer(session, '/rewind')
    await submitComposer(session).catch(() => undefined)
    const midTurnSlash = await waitForMenu(session)
    run.observe('codex mid-turn — /rewind', midTurnSlash)
    run.check(
      'codex mid-turn: /rewind still opens the menu, and the menu says it is busy',
      midTurnSlash.open,
      midTurnSlash.open ? undefined : 'P2.447 posture is that /rewind opens mid-turn; it did not here',
    )
    run.observe('codex mid-turn — the menu busy line', midTurnSlash.busy)
    await closeMenu(session)
    await pressKey(session, 'Escape')
    await pressKey(session, 'Escape')
    await Bun.sleep(500)
    const midTurnKeyboard = (await selectorCount(session, MENU_LIST)) > 0
    run.observe('codex mid-turn — Esc Esc opened the menu', midTurnKeyboard)
    run.observe(
      'codex mid-turn VERDICT',
      midTurnKeyboard
        ? 'the keyboard route opened the menu mid-turn, which is NOT the P2.447 posture (it yields to the interrupt)'
        : 'the keyboard route yielded to the interrupt, as P2.447 states',
    )
  }
}

if (import.meta.main) await main(ID, TITLE, drive)
