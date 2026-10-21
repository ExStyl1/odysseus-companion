/**
 * CRU-4 — a permission mode says what the ACTIVE runtime can enforce.
 *
 * The seven mode descriptions used to be one runtime-independent string each,
 * and several of them were false on Codex. Nothing of ours inspects a Codex
 * tool call before it runs — `codex-agent.ts` has no `runPreToolUseChecks` call
 * at all, only `consultPermissionRules` on the ANSWER side, which can answer
 * only an approval request Codex itself chose to raise — so "never prompts",
 * "no prompts" and "produce a plan" were promises made on a runtime that keeps
 * none of them. R15 moved the per-runtime facts into
 * `RUNTIME_PERMISSION_MODE_NOTE_KEYS` and appends them in
 * `describePermissionModeForRuntime`, which the composer's picker calls with
 * `ComposerCapabilities.connection.activeRuntime`.
 *
 * ## What would have been missed without this case
 *
 * The append is one line of renderer code and it hangs off a capability field
 * that travels a long way: the server recomputes `composerCapabilities` on
 * every session DTO, the renderer re-renders the composer from it, and the
 * picker only takes this path when the backend supplied no `description` of its
 * own. A unit test on the helper proves the string concatenation. It cannot
 * prove that the runtime a live session is ACTUALLY on reaches the picker — and
 * that is the whole claim, because the note's value is that it is true of the
 * session in front of the user.
 *
 * ## What makes this a measurement rather than a vibe
 *
 * - **THE POSITIVE CONTROL is the same picker on a Pi session.** Workspace
 *   Settings deliberately renders these seven strings with NO runtime (a
 *   workspace has no runtime: its sessions pick their own integration and can
 *   switch mid-session), and Pi is the runtime whose behaviour the general
 *   string already describes — so a Pi session must carry no Codex note and must
 *   not name a runtime at all. (Since P6.492, `7c2dd610c`, its menu does carry
 *   ONE band: the resume-table sentence, a fact about the host that is true on
 *   every local runtime — see {@link RESUME_NOTE}.) Without that half, "the description mentions Codex"
 *   would pass on a sentence hardcoded into the locale file.
 * - **The assertion is on the DELTA, not on the whole string.** For each mode
 *   the case takes the Codex rendering minus the Pi rendering and requires the
 *   remainder to be exactly the expected note. That is a stronger claim than
 *   "contains": it proves the note is APPENDED to the same general sentence,
 *   that Pi has nothing appended, and that the appended text is the right one,
 *   in one comparison — and it cannot be satisfied by a description that
 *   happens to mention Codex for unrelated reasons.
 * - **The picker is identified by BEHAVIOUR, not by position.** The composer
 *   footer holds several Radix menu triggers and none carries a test hook.
 *   The case writes the session's permission mode twice through the app's own
 *   `sessionCommand` channel and takes the one control whose label follows it.
 *   Guessing by DOM order would silently read the model menu instead, and a
 *   model menu carries no notes — which is a FAIL that looks exactly like the
 *   feature being broken.
 * - **The locale is read, not assumed** (`i18nextLng`, the key `setupI18n`
 *   configures), and anything outside the two registered locales is mapped to
 *   English the way `fallbackLng: 'en'` maps it.
 *
 * ## Scope, stated rather than implied
 *
 * `chat.permissionModeNote.codexDontAsk` is NOT observable here and this case
 * does not claim it: `dontAsk` is in `PICKER_HIDDEN_MODES`, so no picker ever
 * lists it (it is settable through config, the CLI flag and automations only).
 * The other note keys — `.codex` and `.codexPlan` — cover every mode the picker
 * does show.
 *
 * ## F1.1054 (2026-09-29): five rows, in Claude Desktop's order
 *
 * The retired `explore` and its `codexReadOnly` clause are gone (F1.1050,
 * F1.1052), so the picker lists five modes, not six. Two things the case read
 * changed with F1.1052 and are restated below rather than left to fail as a
 * "defect": the rows follow `PERMISSION_MODE_PICKER_ORDER` (Auto, Manual, Accept
 * edits, Plan, Bypass permissions), not the capability set's order, and each row
 * ends with the digit that selects it, which the delta must not read as a clause
 * — see {@link rowText}.
 */

import type { CdpSession } from '../lib/connect.ts'
import { main, blocked, type CaseRun } from '../lib/report.ts'
import {
  assertElectronApi,
  freshSession,
  listSessions,
  selectorCount,
  setPermissionMode,
  visibleElements,
  waitFor,
  type FreshSession,
} from '../lib/state.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { clickAt } from '../lib/viewport.ts'
import { pressKey } from '../lib/keys.ts'
import {
  activeConnection,
  listConnections,
  requireRuntimeTrio,
  switchRuntime,
  waitForConnection,
} from '../lib/runtime-switch.ts'

const ID = 'CRU-4'
const TITLE = 'On Codex the mode picker says what Codex enforces; on Pi it says nothing extra'

// ---------------------------------------------------------------------------
// The copy, verbatim.
//
// Quoted from `packages/shared/src/i18n/locales/{en,ru}.json`, because a key is
// not what a user reads. A copy edit that lands without updating this table
// fails the case with both strings printed — the actionable shape. Matching a
// loose fragment instead would pass on a sentence that had lost its meaning.
// ---------------------------------------------------------------------------

type Locale = 'en' | 'ru'

/**
 * `chat.permissionModeRuntimeNote.codex` — the SHARED caveat, and as of the
 * one-line change it is rendered ONCE as a footer of the menu rather than
 * appended to all six items. That repetition is what made this menu 564px tall
 * on Codex against 384px on Pi, and it is why this case's model changed shape:
 * the codex-minus-pi delta per ITEM is now empty for four of the six modes (of
 * the five since F1.1054: only Plan keeps a clause).
 */
const FOOTER_NOTE: Record<Locale, string> = {
  // P3.328 (`7843b293b`) rewrote both: the second half said "Nessy does not
  // check each action before it runs", false since P2.197. This table is the
  // verbatim copy the case asserts, so it is re-quoted rather than loosened —
  // a stale entry here fails the case on a sentence that is correct, and it
  // DID: the `except in Bypass` tail was removed by P6.572 (`526f6983a`) and
  // the unattended-fallback clause appended by W13-k (`e706e113b`), neither of
  // which reached this table. Re-quoted at `e706e113b`.
  en: 'On Codex the runtime decides which actions to raise — Nessy checks each raised action against its own limits and rules before it runs. Bypass skips the approval card only: the safety floors and your deny rules still refuse, and with nobody attending the session a call no rule covers is refused rather than run, unless an operator sets unattendedApprovalFallback to allow.',
  ru: 'В Codex рантайм сам решает, какие действия выносить на подтверждение, — Nessy проверяет каждое такое действие своими ограничениями и правилами до запуска. «Обход разрешений» пропускает только карточку подтверждения: защитные пороги и ваши правила deny всё равно откажут, а если за сессией никто не следит, вызов, который не покрыт ни одним правилом, отклоняется, а не выполняется, пока оператор не поставит unattendedApprovalFallback в allow.',
}

/**
 * `chat.permissionModeNote.resumeTable` — P6.492 (`7c2dd610c`) restores only `plan` on resume, and the picker
 * states it once at menu level on all three LOCAL runtimes (`PERMISSION_MODE_RESUME_NOTE_KEY`,
 * `resolveRuntimePermissionModeNote`), appended after the codex caveat with one space. F1.1250: the case still
 * expected no Pi band and a codex band without this sentence, so the sitting (SIT2-f) failed it on a correct menu.
 */
const RESUME_NOTE: Record<Locale, string> = {
  en: 'Plan is the one mode a resumed session comes back in — Bypass and Auto are not restored, so a resumed session starts in the mode a new one would.',
  ru: 'План — единственный режим, в котором возобновлённая сессия открывается снова: Обход разрешений и Авто не восстанавливаются, поэтому возобновлённая сессия стартует в том же режиме, что и новая.',
}

/** The band each leg must show: the codex caveat then the resume sentence; Pi the resume sentence alone. */
function expectedBand(runtime: 'codex' | 'pi', locale: Locale): string {
  return runtime === 'codex' ? `${FOOTER_NOTE[locale]} ${RESUME_NOTE[locale]}` : RESUME_NOTE[locale]
}

/** `chat.permissionModeClause.codexPlan` — `plan`, which also has no `SubmitPlan` on Codex. */
const CLAUSE_PLAN: Record<Locale, string> = {
  // F1.1052: shortened so `Create a plan before making changes.` plus this clause fits the picker's one line.
  en: 'Codex asks on edits; no plan to approve.',
  ru: 'Codex спросит о правках; плана нет.',
}

/**
 * The three quoted strings ABOVE, keyed by the i18n key each was copied from —
 * D1.229.
 *
 * `harness.test.ts` reads this and compares it to
 * `packages/shared/src/i18n/locales/{en,ru}.json`, so a copy edit that lands
 * without updating the table fails a `bun test` in seconds instead of failing
 * this case on a live rig weeks later. That is not hypothetical: the tail of
 * `FOOTER_NOTE` was corrected twice (`526f6983a`, then `e706e113b`) before this
 * table caught up, and the case failed on text that was correct both times.
 *
 * **It is a MAP and not a derivation.** Nothing here imports the locale — the
 * strings stay hand-quoted, which is the whole point of restating them. This
 * export only tells the guard WHICH key each restatement claims to be.
 *
 * Any case may export a `QUOTED_COPY` of this shape and the same guard picks it
 * up; the key is the flat dotted string the JSON literally holds.
 */
export const QUOTED_COPY: Record<string, Record<Locale, string>> = {
  'chat.permissionModeRuntimeNote.codex': FOOTER_NOTE,
  'chat.permissionModeNote.resumeTable': RESUME_NOTE,
  // F1.1052 removed `chat.permissionModeClause.codexReadOnly` with the retired explore; F1.1054 removed
  // this case's own copy of it and its explore arm.
  'chat.permissionModeClause.codexPlan': CLAUSE_PLAN,
}

/**
 * `RUNTIME_PERMISSION_MODE_CLAUSE_KEYS['codex-runtime']`, restated by mode.
 *
 * Restated rather than imported: this harness is its own tsconfig and does not
 * resolve the renderer's aliases. Restating is also the point — a table that
 * derived itself from the module under test would agree with it whatever it
 * said.
 *
 * `''` and not `undefined` for the four modes with no clause: the delta this is
 * compared against is a string, and an empty delta is the ASSERTION for those
 * modes — the caveat must NOT be repeated on them — not an absence of one.
 */
function expectedCodexClause(mode: string, locale: Locale): string {
  switch (mode) {
    case 'plan': return CLAUSE_PLAN[locale]
    // The four that used to carry a full copy of the footer sentence.
    case 'default':
    case 'acceptEdits':
    case 'auto':
    case 'bypassPermissions': return ''
    // `dontAsk` has a clause and no picker ever renders it.
    default: return ''
  }
}

/** `PERMISSION_MODE_ORDER` — Claude Code's six since F1.1050 retired `explore` (packages/shared AGENTS.md). */
const PERMISSION_MODE_ORDER = ['dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions']
/**
 * `PERMISSION_MODE_PICKER_ORDER` (renderer `composer-permission-modes.ts`, F1.1052) — Claude Desktop's order,
 * which the picker renders Nessy's own modes in. A UI order only; the clamp keeps `PERMISSION_MODE_ORDER`.
 */
const PERMISSION_MODE_PICKER_ORDER = ['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions']
/** `PICKER_HIDDEN_MODES` — settable through config, the CLI flag and automations only. */
const PICKER_HIDDEN_MODES = new Set(['dontAsk'])

/** The two modes the identification probe writes. Neither raises a gate dialog. */
const PROBE_MODE_A = 'plan'
const PROBE_MODE_B = 'acceptEdits'

// ---------------------------------------------------------------------------
// DOM hooks
// ---------------------------------------------------------------------------

const FOOTER = '[data-composer-actions]'
const FOOTER_MENU_TRIGGER = '[data-composer-actions] button[aria-haspopup="menu"]'
const OPEN_MENU = '[role="menu"][data-state="open"]'
/**
 * The shared runtime caveat, which as of the one-line change is a FOOTER of the
 * open menu rather than a suffix on every item. Read separately from the items
 * for that reason: the old model could only see it because it was inside them,
 * and a case that kept looking there would report the caveat as MISSING once it
 * moved — the caveat being present exactly once is now its own reading.
 */
const OPEN_MENU_RUNTIME_NOTE = '[role="menu"][data-state="open"] [data-permission-mode-runtime-note]'
/** `StyledDropdownMenuItem` is a Radix `DropdownMenu.Item`; one per visible mode. */
const OPEN_MENU_ITEM = '[role="menu"][data-state="open"] [role="menuitem"]'
/** The compact composer's mode control, so a narrow layout BLOCKS by name rather than by symptom. */
const COMPACT_MODE_BUTTON = 'button[aria-label^="Permission mode"]'

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  const trio = await requireRuntimeTrio(session)
  const locale = await readLocale(session)
  run.observe('locale', locale)

  const connections = await listConnections(session)
  const auth = await authenticationBySlug(session)
  for (const slug of [trio.pi, trio.codex]) {
    if (!connections.some(c => c.slug === slug)) blocked(`the card "${slug}" is not configured on this host`)
    if (!auth[slug]) {
      blocked(
        `the card "${slug}" is not authenticated, so a session cannot run on it. This case needs BOTH a Codex `
        + `session and a Pi session on one host — the Pi half is the control. Authentication: ${JSON.stringify(auth)}`,
      )
    }
  }

  const key = await freshSession(session, `${ID} mode notes`)
  run.observe('session', key)
  run.require('the case got a clean session', key.fresh, key.reason ?? '')
  await assertSingleFooter(session)

  // ---- the Codex reading --------------------------------------------------
  await ensureRuntime(session, key, trio.codex, 'codex-runtime')
  const codexCaps = await composerCapabilities(session, key.sessionId)
  run.observe('codex capabilities', codexCaps)
  if (codexCaps.locked) {
    blocked('the composer reports its permission modes LOCKED on this connection, so the picker will not open.')
  }
  const modes = visibleModes(codexCaps.modes)
  run.observe('modes the picker should list', modes)
  run.require('the session offers permission modes to list', modes.length > 0, JSON.stringify(codexCaps.modes))

  const triggerIndex = await findPermissionModeTrigger(session, key)
  run.observe('permission-mode trigger index in the composer footer', triggerIndex)

  const codexReading = await readModePicker(session, triggerIndex)
  const codexItems = codexReading.items
  run.observe('codex picker rows', codexItems)
  run.require(
    'the menu that follows the session mode lists exactly the modes the capability set names',
    codexItems.length === modes.length,
    `capability modes ${JSON.stringify(modes)} vs ${codexItems.length} rendered rows: ${JSON.stringify(codexItems)}`,
  )

  // ---- the Pi reading: THE POSITIVE CONTROL -------------------------------
  await ensureRuntime(session, key, trio.pi, 'pi')
  const piCaps = await composerCapabilities(session, key.sessionId)
  run.observe('pi capabilities', piCaps)
  run.require(
    'the control runs against the same mode set, so the two readings are comparable',
    sameSequence(visibleModes(piCaps.modes), modes),
    `pi ${JSON.stringify(visibleModes(piCaps.modes))} vs codex ${JSON.stringify(modes)}`,
  )
  const piTriggerIndex = await findPermissionModeTrigger(session, key)
  const piReading = await readModePicker(session, piTriggerIndex)
  const piItems = piReading.items
  run.observe('pi picker rows', piItems)
  run.require(
    'the control read the same picker, row for row',
    piItems.length === codexItems.length,
    `pi ${piItems.length} rows vs codex ${codexItems.length}`,
  )

  // ---- the claim ----------------------------------------------------------
  // Row order is `getVisibleComposerPermissionModes`'s order, which since F1.1052
  // is the picker order narrowed to the capability set — the same list on both
  // legs, asserted above — so index i is mode i on both readings.
  const deltas: Record<string, string> = {}
  let everyNoteRight = true
  let everyControlClean = true
  for (const [index, mode] of modes.entries()) {
    const codexRow = codexItems[index] ?? ''
    const piRow = piItems[index] ?? ''
    const appended = codexRow.startsWith(piRow) ? codexRow.slice(piRow.length).trim() : `«NOT-A-SUFFIX» ${codexRow}`
    deltas[mode] = appended
    if (appended !== expectedCodexClause(mode, locale)) everyNoteRight = false
    // The control leg must carry no Codex fact at all — and, as of the one-line
    // change, the footer sentence must appear on NEITHER leg's items.
    if (piRow.includes('Codex') || piRow.includes(FOOTER_NOTE[locale]) || piRow.length === 0) everyControlClean = false
    if (codexRow.includes(FOOTER_NOTE[locale])) everyControlClean = false
  }
  run.observe('codex-minus-pi, per mode', deltas)

  run.check(
    'on Codex a mode carries a clause ONLY where Codex enforces less than the mode promises — and the shared caveat is on no item',
    everyNoteRight,
    everyNoteRight
      ? ''
      : modes
        .map((mode, index) => `${mode}: appended ${JSON.stringify(deltas[mode])}, expected ${JSON.stringify(expectedCodexClause(mode, locale))}`
          + ` (codex row ${JSON.stringify(codexItems[index] ?? '')})`)
        .join(' | '),
  )
  run.observe('the runtime-note band, per leg', {
    codex: codexReading.runtimeNote, pi: piReading.runtimeNote,
  })
  run.check(
    'THE CAVEAT IS SAID ONCE, as a footer of the Codex menu rather than under every mode, followed by the resume sentence',
    codexReading.runtimeNote === expectedBand('codex', locale),
    codexReading.runtimeNote === expectedBand('codex', locale)
      ? ''
      : `read ${JSON.stringify(codexReading.runtimeNote)}, expected ${JSON.stringify(expectedBand('codex', locale))}`,
  )
  run.check(
    'CONTROL: the Pi menu carries the resume sentence alone — no Codex caveat (P6.492)',
    piReading.runtimeNote === expectedBand('pi', locale),
    piReading.runtimeNote === expectedBand('pi', locale)
      ? ''
      : `pi band: ${JSON.stringify(piReading.runtimeNote)}, expected ${JSON.stringify(expectedBand('pi', locale))}`,
  )
  run.check(
    'CONTROL: the same picker\'s rows on a Pi session carry no note and name no runtime',
    everyControlClean,
    everyControlClean ? '' : `pi rows: ${JSON.stringify(piItems)}`,
  )
  // WAS "a STRICT prefix", requiring the Codex row to be LONGER on every mode.
  // That was the old shape's assertion — a note appended six times — and under
  // the one-line change it is exactly backwards: four of the six rows (five since
  // F1.1054) are now
  // IDENTICAL on both runtimes, and that identity is the whole point. So the
  // claim splits in two, and both halves have to hold or the reading means
  // nothing: the Codex row still STARTS with the Pi row (so a difference is an
  // addition and never a rewrite), and it grows ONLY where a clause is expected.
  const rowsExtendCleanly = modes.every((_, index) => {
    const codexRow = codexItems[index] ?? ''
    const piRow = piItems[index] ?? ''
    return piRow.length > 0 && codexRow.startsWith(piRow)
  })
  const grewOnlyWhereExpected = modes.every((mode, index) => {
    const codexRow = codexItems[index] ?? ''
    const piRow = piItems[index] ?? ''
    const grew = codexRow.length > piRow.length
    return grew === (expectedCodexClause(mode, locale).length > 0)
  })
  run.check(
    'CONTROL: a Codex row EXTENDS the Pi one rather than rewriting it — and grows only where a clause is due',
    rowsExtendCleanly && grewOnlyWhereExpected,
    rowsExtendCleanly && grewOnlyWhereExpected
      ? ''
      : `extends=${rowsExtendCleanly} grewOnlyWhereExpected=${grewOnlyWhereExpected}: `
        + `pi ${JSON.stringify(piItems)} vs codex ${JSON.stringify(codexItems)}`,
  )
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The app's UI language, read rather than assumed.
 *
 * `setupI18n` configures `lookupLocalStorage: 'i18nextLng'` with
 * `caches: ['localStorage']`, so the renderer writes its resolved language
 * there on every start. Two locales are registered; `fallbackLng: 'en'` renders
 * English for anything else, and mirroring that fallback is the app's own rule
 * rather than a guess about the operator's machine.
 */
async function readLocale(session: CdpSession): Promise<Locale> {
  const raw = await session.call<string>(`
    const stored = window.localStorage.getItem('i18nextLng')
    return String(stored ?? navigator.language ?? 'en')
  `)
  return raw.toLowerCase().split(/[-_]/)[0] === 'ru' ? 'ru' : 'en'
}

/**
 * Authentication per card, from the ONLY method that reports it.
 *
 * `listLlmConnections` returns the plain `LlmConnection` and the status field is
 * ABSENT from every row, not false — so reading it there made this case block
 * itself on a precondition that was already met, naming all eleven cards as
 * unauthenticated. The tell: CRU-1 ran a full turn on `claude-gateway` while
 * this probe called that same card unauthenticated. `listLlmConnectionsWithStatus`
 * is the one that computes it, from whether credentials exist for the card's
 * auth type.
 */
async function authenticationBySlug(session: CdpSession): Promise<Record<string, boolean>> {
  return session.call<Record<string, boolean>>(`
    const rows = await window.electronAPI.listLlmConnectionsWithStatus()
    const out = {}
    for (const c of rows ?? []) out[c.slug] = c.isAuthenticated === true
    return out
  `)
}

interface ComposerCaps {
  activeRuntime?: string
  modes: string[]
  locked: boolean
  /** A backend-supplied description wins outright and would suppress the note by design. */
  backendModeOptions: number
}

/**
 * `Session.composerCapabilities` — the exact object the composer builds its
 * picker from (`ChatDisplay.tsx:2359`), recomputed server-side on every DTO.
 *
 * Reading `connection.activeRuntime` here is the INPUT to the note, not the
 * note, so waiting on it is not circular.
 */
async function composerCapabilities(session: CdpSession, sessionId: string): Promise<ComposerCaps> {
  return session.call<ComposerCaps>(`
    const all = await window.electronAPI.getSessions()
    const s = (all ?? []).find(x => x.id === ${JSON.stringify(sessionId)})
    const caps = s && s.composerCapabilities ? s.composerCapabilities : null
    const permissions = caps && caps.permissions ? caps.permissions : {}
    return {
      activeRuntime: caps && caps.connection ? caps.connection.activeRuntime : undefined,
      modes: Array.isArray(permissions.modes) ? permissions.modes : [],
      locked: permissions.locked === true,
      backendModeOptions: Array.isArray(permissions.modeOptions) ? permissions.modeOptions.length : 0,
    }
  `)
}

/**
 * `getVisibleComposerPermissionModes`, restated: the capability set minus the hidden modes, in the picker's
 * order (F1.1052). The backend-named branch (`modeOptions`, Nestor Cloud) keeps its own order, and
 * `ensureRuntime` blocks on it before this is read, so it is not restated.
 */
function visibleModes(capabilityModes: string[]): string[] {
  const visible = capabilityModes.filter(mode => PERMISSION_MODE_ORDER.includes(mode) && !PICKER_HIDDEN_MODES.has(mode))
  if (visible.length === 0) return [...PERMISSION_MODE_PICKER_ORDER]
  return PERMISSION_MODE_PICKER_ORDER.filter(mode => visible.includes(mode))
}

/**
 * One picker row's text without its trailing shortcut digit.
 *
 * F1.1052 ends every Nessy row with the digit that selects it
 * (`PermissionModeItemTrailing`), AFTER the description. Left in, the Codex row
 * "… changes. Codex asks on edits; no plan to approve. 4" does not start with the
 * Pi row "… changes. 4", so every delta would read «NOT-A-SUFFIX». The digit is
 * the same on both legs (same index), so dropping it removes nothing the claim is
 * about. The Recommended and Default badges sit in the title, before the
 * description, and are identical on both legs, so they stay.
 */
export function rowText(text: string): string {
  return text.trim().replace(/\s+\d$/, '')
}

/**
 * Move the session onto a connection and wait until the composer's OWN input
 * agrees, not merely until the command returns.
 */
async function ensureRuntime(
  session: CdpSession,
  key: FreshSession,
  slug: string,
  expectedRuntime: string,
): Promise<void> {
  if ((await activeConnection(session, key.sessionId)) !== slug) {
    const outcome = await switchRuntime(session, key.sessionId, slug)
    if (!outcome.ok) {
      blocked(`the app refused to move the session onto "${slug}": ${outcome.error ?? 'unknown error'}`)
    }
    const settled = await waitForConnection(session, key.sessionId, slug)
    if (settled !== slug) {
      blocked(`the session did not settle on "${slug}" — it reports ${String(settled)}`)
    }
  }
  const caps = await waitFor(
    () => composerCapabilities(session, key.sessionId),
    value => value.activeRuntime === expectedRuntime,
    { timeoutMs: 30_000, intervalMs: 500, label: `composerCapabilities.connection.activeRuntime to become ${expectedRuntime}` },
  ).catch(() => undefined)
  if (!caps) {
    blocked(
      `the session moved onto "${slug}" but its composer capabilities never reported activeRuntime `
      + `"${expectedRuntime}". Without that field the picker has no runtime to describe and this case cannot score it.`,
    )
  }
  if (caps.backendModeOptions > 0) {
    blocked(
      `"${slug}" ships its own backend mode descriptions (${caps.backendModeOptions} modeOptions), which win outright `
      + 'by design. This case must run against a local runtime, not a remote agent card.',
    )
  }
}

async function assertSingleFooter(session: CdpSession): Promise<void> {
  const count = await selectorCount(session, FOOTER)
  if (count !== 1) {
    blocked(
      `there are ${count} composer footers on screen. A multi-panel layout puts several pickers up at once and this `
      + 'case must not guess which session it is driving — run the wave with a single content panel open.',
    )
  }
}

// ---------------------------------------------------------------------------
// Driving the picker
// ---------------------------------------------------------------------------

interface VisibleButton {
  index: number
  text: string
  disabled: boolean
}

/**
 * Every VISIBLE match, with the index a click can use.
 *
 * The visibility filter has to be identical here and in {@link clickVisible},
 * or an index read from one list clicks a different element in the other —
 * the mismatch `lib/viewport.ts` records, where an invisible measuring copy
 * rendered before the real control took a click at another y and it missed
 * with no error at all.
 */
async function visibleButtons(session: CdpSession, selector: string): Promise<VisibleButton[]> {
  return session.call<VisibleButton[]>(`
    return Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      .filter(el => {
        const s = window.getComputedStyle(el)
        return s.visibility !== 'hidden' && s.display !== 'none' && el.getClientRects().length > 0
      })
      .map((el, index) => ({
        index,
        text: (el.innerText ?? el.textContent ?? '').replace(/\\s+/g, ' ').trim(),
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      }))
  `)
}

/**
 * Click the index-th visible match, refusing rather than clicking blind.
 *
 * The same two guards `lib/viewport.ts` enforces, restated because that
 * module's hit-test is internal and this case must not edit `lib/`: `clickAt`
 * checks the coordinate against the live viewport, and the element under the
 * cursor is checked to be the target — a click that lands on an overlay dies
 * silently while key events keep working, which is how a run produces a
 * confident wrong measurement.
 */
async function clickVisible(session: CdpSession, selector: string, index: number, label: string): Promise<void> {
  const hit = await session.call<{
    found: boolean
    rect?: { x: number; y: number; width: number; height: number }
    covered?: string | null
  }>(`
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
  if (!hit.found || !hit.rect) throw new Error(`click refused: ${label} — no visible element at index ${index} of ${selector}`)
  if (hit.rect.width <= 0 || hit.rect.height <= 0) {
    throw new Error(`click refused: ${label} has zero size (${hit.rect.width}x${hit.rect.height})`)
  }
  if (hit.covered) {
    throw new Error(`click refused: ${label} is covered by ${hit.covered} — an overlay would eat this click silently`)
  }
  await clickAt(session, {
    x: Math.round(hit.rect.x + hit.rect.width / 2),
    y: Math.round(hit.rect.y + hit.rect.height / 2),
  }, label)
}

/**
 * Which composer-footer control is the permission-mode picker — answered by
 * driving it, not by counting siblings.
 *
 * The trigger renders `currentPermissionModeDisplay.shortLabel` and nothing
 * else identifies it: no test hook, no aria-label, and the model picker sits
 * next to it with an identical `aria-haspopup="menu"`. So the case writes the
 * session's mode twice through `sessionCommand` — the app's own channel, whose
 * `permission_mode_changed` event is what a backend-initiated change travels
 * back on — and takes the ONE control whose label followed. Anything else is
 * refused rather than guessed: reading the model menu by mistake produces a
 * FAIL that looks exactly like the feature being broken.
 */
async function findPermissionModeTrigger(session: CdpSession, key: FreshSession): Promise<number> {
  const triggers = await visibleButtons(session, FOOTER_MENU_TRIGGER)
  if (triggers.length === 0) {
    const compact = await selectorCount(session, COMPACT_MODE_BUTTON)
    blocked(
      compact > 0
        ? 'the composer is in COMPACT layout, where the permission mode is a drawer rather than a dropdown. '
          + 'Widen the window so the desktop footer renders, then re-run.'
        : 'the composer footer has no dropdown trigger at all, so there is no mode picker to open.',
    )
  }

  await setSessionMode(session, key, PROBE_MODE_A)
  const before = await stableTriggerTexts(session)
  await setSessionMode(session, key, PROBE_MODE_B)
  const after = await waitFor(
    () => visibleButtons(session, FOOTER_MENU_TRIGGER).then(rows => rows.map(r => r.text)),
    texts => texts.length === before.length && texts.some((text, index) => text !== before[index]),
    { timeoutMs: 20_000, intervalMs: 400, label: 'a composer control to follow the session permission mode' },
  ).catch(() => undefined)
  if (!after) {
    blocked(
      'no control in the composer footer followed the session permission mode across two writes '
      + `(${PROBE_MODE_A} -> ${PROBE_MODE_B}). Labels stayed ${JSON.stringify(before)}. Without that the case cannot `
      + 'tell the mode picker from the model picker, and reading the wrong menu would report a defect that is not there.',
    )
  }

  const changed = after.map((text, index) => (text !== before[index] ? index : -1)).filter(index => index >= 0)
  if (changed.length !== 1) {
    blocked(
      `${changed.length} composer controls changed when only the permission mode changed `
      + `(${JSON.stringify(before)} -> ${JSON.stringify(after)}). The picker cannot be identified unambiguously.`,
    )
  }
  return changed[0]!
}

/** Write the mode through the app's own channel and wait for the app to report it. */
async function setSessionMode(session: CdpSession, key: FreshSession, mode: string): Promise<void> {
  await setPermissionMode(session, key.sessionId, mode)
  await waitFor(
    async () => (await listSessions(session)).find(s => s.id === key.sessionId)?.permissionMode,
    value => value === mode,
    { timeoutMs: 20_000, intervalMs: 400, label: `the session to report permissionMode ${mode}` },
  )
}

/**
 * Trigger labels, once they have stopped moving.
 *
 * The renderer applies a backend mode change on an event, so a snapshot taken
 * the instant the RPC agrees can still be the previous label — and a stale
 * baseline makes every control look like it changed, which the caller then
 * refuses as ambiguous. Two identical consecutive reads is the settle.
 */
async function stableTriggerTexts(session: CdpSession, timeoutMs = 15_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  let previous = (await visibleButtons(session, FOOTER_MENU_TRIGGER)).map(r => r.text)
  for (;;) {
    await Bun.sleep(700)
    const current = (await visibleButtons(session, FOOTER_MENU_TRIGGER)).map(r => r.text)
    if (current.length === previous.length && current.every((text, index) => text === previous[index])) return current
    previous = current
    if (Date.now() >= deadline) return current
  }
}

/**
 * Open the mode picker, read every row, close it again.
 *
 * The rows are read with `visibleElements`, which reports each match's size —
 * so a zero-height duplicate left in the tree cannot be mistaken for a rendered
 * row. The wait is for CONTENT rather than for the selector: `innerText` is
 * layout-dependent and returns `''` for an element whose container has not
 * sized yet, which reads exactly like a picker that says nothing.
 */
interface ModePickerReading {
  items: string[]
  /** The shared runtime caveat, read as its own element. `null` = no band at all. */
  runtimeNote: string | null
}

async function readModePicker(session: CdpSession, triggerIndex: number): Promise<ModePickerReading> {
  // ONE RETRY, and the reason is measured rather than defensive. The CONTROL
  // leg opens this picker straight after a runtime switch, and the composer
  // footer is still settling: the first open landed on a menu whose rows had no
  // text yet and the case blocked itself — on the leg whose only job is to show
  // that the Codex note is absent. The Codex leg, which opens on a quiet
  // composer, read all six rows on the first attempt. A single re-open costs a
  // second and removes the only flake this case has shown.
  let texts: string[] = []
  let note: string | null = null
  let bandCount = 0
  for (let attempt = 0; attempt < 2 && texts.length === 0; attempt += 1) {
    await clickVisible(session, FOOTER_MENU_TRIGGER, triggerIndex, `the permission-mode trigger (#${triggerIndex})`)
    const rows = await waitFor(
      () => visibleElements(session, OPEN_MENU_ITEM),
      found => found.length > 0 && found.every(el => el.text.trim().length > 0),
      { timeoutMs: 10_000, intervalMs: 250, label: 'the mode picker to render its rows with text' },
    ).catch(() => [])
    texts = rows.map(el => rowText(el.text))
    // Read WHILE THE MENU IS OPEN, before the Escape below. The caveat is no
    // longer inside the rows, so a reading that only collected rows would report
    // it missing rather than moved.
    if (texts.length > 0) {
      const band = await visibleElements(session, OPEN_MENU_RUNTIME_NOTE).catch(() => [])
      note = band.length > 0 ? (band[0]!.text ?? '').trim() : null
      bandCount = band.length
    }

    await pressKey(session, 'Escape')
    await waitFor(
      () => selectorCount(session, OPEN_MENU),
      count => count === 0,
      { timeoutMs: 8_000, intervalMs: 250, label: 'the mode picker to close' },
    ).catch(() => 0)
  }

  if (texts.length === 0) {
    blocked('the mode picker opened TWICE and rendered no rows with text either time, so there is nothing to read.')
  }
  // More than one band would be the old defect in a new place: the caveat said
  // more than once in one menu.
  if (bandCount > 1) {
    blocked(`the open menu carried ${bandCount} runtime-note bands; exactly one or none is the only readable shape.`)
  }
  return { items: texts, runtimeNote: note }
}

/** Equal, and in the same order — the picker renders the picker order narrowed to the capability set. */
function sameSequence(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
