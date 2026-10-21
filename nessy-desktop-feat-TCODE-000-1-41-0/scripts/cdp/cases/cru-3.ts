/**
 * CRU-3 — the runtime-switch dialog names what the move costs, per DIRECTION.
 *
 * Before R11 the mid-session switch dialog said one generic paragraph: the
 * conversation survives, the working memory does not, background tasks stop.
 * Everything a user actually LOSES by landing on the other runtime — a
 * permission gate that no longer inspects the call before it runs, a worktree
 * move the model can no longer make, a plan there is no longer anything to
 * accept — was discovered afterwards, by being surprised. `runtimeSwitchCosts`
 * (`app-shell/input/runtime-switch-costs.ts`) computes that set and
 * `RuntimeSwitchDialog.tsx` renders it above the confirm button.
 *
 * ## UNRESOLVED: which `blocked()` fired on 2026-08-21
 *
 * This row PASSED on 2026-08-17 and was recorded BLOCKED on 2026-08-21 under a
 * blanket "fixtures/env, unchanged from history" with **no case-specific reason
 * captured**, so the sitting cannot be attributed after the fact. Nothing about
 * the fixture changed in between: the three cards `requireRuntimeTrio` wants are
 * already seeded by `fixtures/runtime-switch.ts` and are present in both the
 * fixture config dir and the operator's own. The reachable blockers are all
 * RIG-shaped — a multi-panel layout, a narrow window, an expired dp JWT — and a
 * fixture creates none of them.
 *
 * Two things follow, and both are done rather than noted. `assertRigIsDrivable`
 * below runs the layout checks FIRST, before a turn is spent, so the next
 * sitting cannot end in a rig complaint after several minutes. And whoever runs
 * it next should record the block's own text in the narrative, not the word
 * "fixtures" — the message names its own cause every time, and copying it is
 * what makes the row attributable.
 *
 * ## What would have been missed without this case
 *
 * The table is unit-testable and the unit test proves the SET. It cannot prove
 * that the dialog a user meets on a real session with real history renders the
 * rows at all — the dialog only exists for one tier (`runtimeSwitchCopyKey`
 * returns `null` for a model change and for a session with nothing to lose), it
 * is reached through a picker that refuses to open while a turn is in flight,
 * and the block is conditional on `costs.length > 0`. Every one of those gates
 * sits between a correct table and a user reading it.
 *
 * ## What makes this a measurement rather than a vibe
 *
 * - **The control is the OTHER DIRECTION, on the same rig, in the same dialog.**
 *   A cost is a capability the SOURCE has and the TARGET lacks, so the two legs
 *   are different sets and no fixed list can satisfy both — which is the claim
 *   the control now makes. It used to say the return leg lists NOTHING; that was
 *   true for three waves and P6.65/P6.170 ended it (see the comment on leg two).
 *   The dialog must still APPEAR either way, because "nothing listed" and "never
 *   asked" are different states and only the first is the feature working.
 * - **The expectation is derived from the direction AND from the table.** No
 *   count is written here on purpose: the inventory went six → 34 rows under a
 *   sentence in this docblock that said five and two. The case reads
 *   `RUNTIME_SWITCH_COSTS` itself (see the derivation block below), picks its
 *   target from what the host actually offers, and expects the corresponding
 *   list in the module's own row order.
 * - **Rank order is asserted, not the set.** `files` rows before `abilities`
 *   rows is the whole reason the module ranks them: a user skimming one dialog
 *   reads the top. An unordered comparison would pass on a shuffle, and a
 *   derived expectation would inherit a shuffle silently — so the derived list
 *   is itself checked for the rank property before the dialog is compared to it.
 * - **The sentences are the ones a user reads**, quoted verbatim from
 *   `en.json`/`ru.json`, with `{{toRuntime}}` interpolated the way the dialog
 *   interpolates it. Both locales, because the app's language is the operator's
 *   — the locale is READ (`i18nextLng`, the key `setupI18n` configures) rather
 *   than assumed, and anything outside the two registered locales is mapped to
 *   English the same way `fallbackLng: 'en'` maps it.
 *
 * ## Two deliberate scope limits
 *
 * - **The dialog is opened but never CONFIRMED through its own button.** The
 *   claim under test is the dialog's CONTENT, and both legs render the real
 *   dialog through the real picker. Moving the session between the two legs
 *   goes through `sessionCommand(id, { type: 'switchRuntime' })` — the exact
 *   call `ChatPage.tsx:314` makes when the user confirms — so the state change
 *   is the shipped one without asking a coordinate click to land on a button
 *   underneath a modal overlay, which is the input that can silently miss.
 * - **A session with history is a precondition the case creates itself**, by
 *   spending one real turn on Pi. `hasHistory={!isEmptySession}` and
 *   `isEmptySession` is `messages.length === 0` (`ChatDisplay.tsx:2391`), so a
 *   freshly created session gets no dialog at all and a case that skipped the
 *   turn would measure a silent switch and report the block missing.
 *
 * ## What P6.573 changed, and what it deliberately did NOT
 *
 * P6.573 made the inventory DERIVED (the block below). It did not run the case:
 * driving it green on a packaged build is the release sitting's work, not this
 * lane's, and a case whose expectations are computed from the shipped table has
 * never been driven in that form. So the last recorded result stands until the
 * sitting re-drives it, and a red from the first drive is as likely to be this
 * derivation as the product — read the `expected …` observations, which now
 * print the derived row ids for both legs beside what the dialog rendered.
 */

import type { CdpSession } from '../lib/connect.ts'
import { main, blocked, type CaseRun } from '../lib/report.ts'
import {
  assertElectronApi,
  freshSession,
  listSessions,
  selectorCount,
  transcript,
  visibleElements,
  waitFor,
  type FreshSession,
} from '../lib/state.ts'
import { sendPrompt, lastAssistantText } from '../lib/chat.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { clickAt } from '../lib/viewport.ts'
import { pressKey } from '../lib/keys.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  activeConnection,
  listConnections,
  requireRuntimeTrio,
  runtimeOf,
  switchRuntime,
  waitForConnection,
} from '../lib/runtime-switch.ts'

const ID = 'CRU-3'
// The title used to end "and lists nothing on the way back", which was a
// property of the ROW SET and stopped being true on 2026-09-06 (P6.65, P6.170).
// A case title is read by an operator deciding what a red means, so it states
// the direction-dependence the case actually proves and not a count.
const TITLE = 'The runtime-switch dialog lists what the direction costs, and the return leg is a different list'

// ---------------------------------------------------------------------------
// The table, DERIVED — never a second copy of it.
//
// P2.485 derived the SENTENCES (read out of the locale files) and left the
// `id → bodyKey` map and the per-direction expectations hand-written, with a
// comment arguing that a restated table is the point because "a table that
// computed itself from the module under test would agree with it no matter what
// it said". P6.573 spent that argument, and the way it was spent is the whole
// lesson: the module grew from six rows to 34, BOTH return legs stopped being
// empty (`credentialShellFloor` on codex→pi, `policyKeys` on claude→pi), and
// nothing anywhere went red — nothing in `packages/` or `apps/` reads this
// file, so a stale table here produces no `bun test` failure at all. It is
// discovered by a live sitting, several minutes in, and blamed on the app.
//
// A restated table only detects drift if somebody re-reads it, and for three
// waves nobody did. So everything now derives from the two places that own it:
//
//   `runtime-switch-costs.ts`  the rows — id, bodyKey, consequence, and the
//                              per-runtime claims the fire rule reads
//   `locales/{en,ru}.json`     the sentence each bodyKey resolves to
//
// What survives of the old argument is the FIRE RULE ({@link costFires}, six
// lines mirroring `switchCostCertainty`) and the RANK property, both asserted
// against the derived list in `drive`. A rule and an ordering are propositions a
// case can hold the module to; a 34-row inventory is not.
//
// READ, not imported. `runtime-switch-costs.ts` imports `@config/models` and
// `@nessy-agent/shared/agent/backend/runtime-vocabulary`, and
// `scripts/cdp/tsconfig.json` maps neither — but the deciding reason is the one
// `lib/model-window.ts` already settled for this harness in its own words: "no
// case in `scripts/cdp/` imports from `@nessy-agent/*`; dragging the shared
// package into a harness process changes what the harness is." So this file
// parses the module's source the way `parseMinPlausibleContextWindow` parses the
// context-window floor, and carries the same two defences: a structural control
// (every `id:` field in the array must have been matched as a whole row) and a
// BLOCKED rather than a silent empty list when the shape moves.
// ---------------------------------------------------------------------------

type Locale = 'en' | 'ru'

/** The claim a row makes about one runtime — `RuntimeSwitchClaim` in the module. */
type CostClaim = boolean | 'conditional' | 'unmeasured' | null

/** How sure the pair is — `RuntimeSwitchCostCertainty`. */
type CostCertainty = 'measured' | 'unmeasured'

/** One row of `RUNTIME_SWITCH_COSTS`, as written. */
interface CostRow {
  id: string
  bodyKey: string
  consequence: 'files' | 'abilities'
  /** Which runtimes have the capability, by `ModelProvider`. */
  on: Record<string, CostClaim>
}

/** A row as the dialog will RENDER it for one direction, in one locale. */
interface ExpectedRow {
  id: string
  consequence: 'files' | 'abilities'
  /** The sentence, with `{{toRuntime}}` filled. */
  sentence: string
  /** `RuntimeSwitchDialog` appends `(not measured)` to these. */
  unmeasured: boolean
}

/** The module that owns the table, relative to the repo root. */
const COST_SOURCE = 'apps/electron/src/renderer/components/app-shell/input/runtime-switch-costs.ts'

/** The repo root, from this file's own location. */
function repoRoot(): string {
  return join(import.meta.dir, '..', '..', '..')
}

/**
 * The rows out of the module's source. Exported for its own sake: the two
 * refusal arms — a moved array, a row shape the pattern cannot see — are not
 * reachable through a reader that has already blocked.
 *
 * Comments are stripped first, because the rows sit under 30-line docblocks that
 * quote row ids and body keys in prose; a pattern run over the raw file would
 * match sentences about rows as well as rows.
 */
export function parseCostRows(source: string): CostRow[] {
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const declaration = bare.indexOf('const RUNTIME_SWITCH_COSTS')
  if (declaration < 0) return []
  // `readonly RuntimeSwitchCostRow[]` puts a `[]` in the TYPE, before the array
  // literal — anchoring on the first `[` after the name matches that empty pair
  // and yields a zero-length slice, which reads exactly like "the table is
  // empty". Anchor on the `Object.freeze(` that opens the literal instead.
  const freeze = bare.indexOf('Object.freeze(', declaration)
  const open = freeze < 0 ? -1 : bare.indexOf('[', freeze)
  if (open < 0) return []
  let depth = 0
  let close = -1
  for (let i = open; i < bare.length; i += 1) {
    if (bare[i] === '[') depth += 1
    else if (bare[i] === ']') {
      depth -= 1
      if (depth === 0) { close = i; break }
    }
  }
  if (close < 0) return []
  const body = bare.slice(open + 1, close)

  const rows: CostRow[] = []
  const ROW = /\{\s*id:\s*'([^']+)',\s*bodyKey:\s*'([^']+)',\s*consequence:\s*'(files|abilities)',\s*on:\s*\{([^}]*)\},?\s*\}/g
  for (const match of body.matchAll(ROW)) {
    const on: Record<string, CostClaim> = {}
    for (const clause of match[4]!.split(',')) {
      const trimmed = clause.trim()
      if (trimmed === '') continue
      const pair = /^'?([A-Za-z0-9_-]+)'?\s*:\s*(.+)$/.exec(trimmed)
      if (!pair) return []
      const raw = pair[2]!.trim()
      on[pair[1]!] = raw === 'true' ? true
        : raw === 'false' ? false
          : raw === 'null' ? null
            : raw === "'conditional'" ? 'conditional'
              : raw === "'unmeasured'" ? 'unmeasured'
                : null
    }
    rows.push({ id: match[1]!, bodyKey: match[2]!, consequence: match[3] as 'files' | 'abilities', on })
  }
  // The structural control. A row whose literal is spelled differently — a
  // trailing field, a reordered key, a multi-line `on` — is skipped SILENTLY by
  // the pattern above, and a table short by one row is the exact defect this
  // whole rewrite exists to stop. Counting `id:` fields in the same slice is the
  // cheapest instrument that can see it.
  const declaredIds = (body.match(/\bid:\s*'/g) ?? []).length
  return declaredIds === rows.length ? rows : []
}

/** One locale file, as a flat object. */
function localeStrings(locale: Locale): Record<string, unknown> {
  const file = join(repoRoot(), 'packages', 'shared', 'src', 'i18n', 'locales', `${locale}.json`)
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

/**
 * One string out of a locale file, or a BLOCK naming the key.
 *
 * The files are FLAT — the dotted name is the literal key, not a path through
 * nested objects. Written after a nested walk returned `undefined` for all six
 * keys that are demonstrably present, which is the shape of a lookup that
 * reports the product missing a string it has.
 */
function lookup(strings: Record<string, unknown>, key: string, locale: Locale): string {
  const value = strings[key]
  if (typeof value !== 'string') {
    blocked(
      `locale-key-missing: ${locale}.json has no string at ${key}. Every key this case reads comes from `
      + `${COST_SOURCE}, so a key that resolves to nothing means the module and the locale files disagree — `
      + 'which is a product finding, but not one this case can score, because it cannot render the dialog it '
      + 'is comparing against.',
    )
  }
  return value
}

/**
 * Every locale key this case reads BESIDES the per-row `bodyKey`s — P6.1019.
 *
 * Exported so `cru-3-derivation.test.ts` can hold them to the locale files
 * offline. Without that the only instrument for a renamed key is a live sitting,
 * which is the position the three restated strings were in.
 */
export const LOCALE_KEYS = {
  notMeasured: 'chat.runtimeSwitch.costNotMeasured',
  heading: 'chat.runtimeSwitch.costHeading',
  title: 'chat.runtimeSwitch.crossRuntimeTitle',
} as const

interface CostTable {
  rows: readonly CostRow[]
  /** `bodyKey → sentence`, per locale. Every row, both locales. */
  sentence: Record<Locale, Record<string, string>>
  /** `chat.runtimeSwitch.costNotMeasured` — the marker P6.562 appends. */
  notMeasured: Record<Locale, string>
  /** `chat.runtimeSwitch.costHeading` — present only when the block renders. */
  heading: Record<Locale, string>
  /** `chat.runtimeSwitch.crossRuntimeTitle` — proof the dialog on screen is THIS one. */
  title: Record<Locale, string>
}

let cached: CostTable | undefined

/**
 * The table, read once per process.
 *
 * LAZY, not module-load: reading two locale files and a renderer module is a
 * side effect, and `harness.test.ts` asserts that importing a case has none.
 * Lazy also means the refusal arrives as a `BLOCKED` result line rather than as
 * an unhandled throw out of an import, which is the difference between a
 * harness that says what is wrong and one that dies.
 */
function costTable(): CostTable {
  if (cached) return cached
  const path = join(repoRoot(), COST_SOURCE)
  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    blocked(
      `cannot read ${COST_SOURCE} — this case derives the whole cost inventory from the module that owns it `
      + 'rather than restating it, and a restated inventory is what went stale last time (six rows against 34). '
      + 'Run the case from a checkout.',
    )
  }
  const rows = parseCostRows(source)
  if (rows.length === 0) {
    blocked(
      `no rows parsed out of ${COST_SOURCE}. Either \`RUNTIME_SWITCH_COSTS\` moved, or a row is written in a `
      + 'shape `parseCostRows` cannot see — it refuses a partial read on purpose, because a table short by one '
      + 'row would score a correct dialog as a failure and a broken one as a pass. Fix the pattern; do not '
      + 'hardcode the rows.',
    )
  }
  const strings: Record<Locale, Record<string, unknown>> = { en: localeStrings('en'), ru: localeStrings('ru') }
  const sentences = (locale: Locale): Record<string, string> =>
    Object.fromEntries(rows.map(row => [row.bodyKey, lookup(strings[locale], row.bodyKey, locale)]))
  /** One key in both locales — every string this case compares against comes through here. */
  const bothLocales = (key: string): Record<Locale, string> => ({
    en: lookup(strings.en, key, 'en'),
    ru: lookup(strings.ru, key, 'ru'),
  })
  cached = {
    rows,
    sentence: { en: sentences('en'), ru: sentences('ru') },
    notMeasured: bothLocales(LOCALE_KEYS.notMeasured),
    heading: bothLocales(LOCALE_KEYS.heading),
    title: bothLocales(LOCALE_KEYS.title),
  }
  return cached
}

/**
 * Does this row fire for this ordered pair, and how sure are we?
 *
 * Mirrors `switchCostCertainty`. The RULE is restated where the TABLE is not, on
 * purpose: it is six lines that have moved twice in six months (P2.484 fixed the
 * source/target asymmetry, P6.562 added the unmeasured arm), against a table
 * that has moved on almost every wave. A case that mirrored neither could not
 * name what it expects; a case that mirrored both would agree with the module
 * whatever it said.
 */
export function costFires(from: CostClaim, to: CostClaim): CostCertainty | null {
  if (from === 'unmeasured' || to === 'unmeasured') {
    if (from === false || from === null) return null
    if (to === true) return null
    return 'unmeasured'
  }
  return from === true && (to === false || to === 'conditional') ? 'measured' : null
}

/**
 * What the dialog must list for this direction, in this locale — in the module's
 * own row order, which IS the rank order (`files` rows are written first).
 *
 * Empty for a runtime the table declines to describe (`isSwitchableRuntime`
 * refuses an endpoint any row is silent about) and for a switch that does not
 * change runtime, exactly as `runtimeSwitchCosts` is.
 */
function expectedRows(table: CostTable, from: string, to: string, locale: Locale, toLabel: string): ExpectedRow[] {
  const switchable = (runtime: string): boolean => table.rows.every(row => row.on[runtime] !== undefined && row.on[runtime] !== null)
  if (from === to || !switchable(from) || !switchable(to)) return []
  return table.rows.flatMap(row => {
    const certainty = costFires(row.on[from]!, row.on[to]!)
    if (!certainty) return []
    return [{
      id: row.id,
      consequence: row.consequence,
      sentence: fill(table.sentence[locale][row.bodyKey] ?? '', toLabel),
      unmeasured: certainty === 'unmeasured',
    }]
  })
}

// P6.1019 — `costHeading` and `crossRuntimeTitle` used to be RESTATED here, in
// both locales, in the one file where a stale copy produces no `bun test` red:
// nothing in `packages/` or `apps/` imports a case module, which is exactly how
// this case's cost table sat six rows wide against a 34-row module for three
// waves. They are read out of the locale files now, through the same `lookup`
// that already refuses a missing key with a BLOCK naming it — the same treatment
// `costNotMeasured` and every row sentence already had. Both copies matched the
// locale files on the day they were removed, so this changes no verdict; what it
// removes is the next rewording landing as a red in a case nobody runs offline.
// See `lib/model-window.ts` for the rule: read the source, do not restate it.

/**
 * `runtimeLabel` — the mark the dialog interpolates. Brand names stay English
 * in both locales (i18n rule 3), so one table serves both.
 */
const RUNTIME_LABEL: Record<string, string> = {
  pi: 'Pi',
  anthropic: 'Claude',
  'codex-runtime': 'Codex',
}

// ---------------------------------------------------------------------------
// DOM hooks
// ---------------------------------------------------------------------------

/** One per content panel. A case that guesses which one it drives is measuring a coin flip. */
const FOOTER = '[data-composer-actions]'
/** Radix `DropdownMenuTrigger` marks itself; the composer footer holds several. */
const FOOTER_MENU_TRIGGER = '[data-composer-actions] button[aria-haspopup="menu"]'
/** Radix `DropdownMenuContent`. `data-state` separates the live one from a closing one. */
const OPEN_MENU = '[role="menu"][data-state="open"]'
/**
 * The expanded integration list's rows.
 *
 * `ConnectionRow`'s own controls are plain buttons, never `DropdownMenuItem`s —
 * the two-control shape is deliberate (a model tap must not be able to move a
 * session), and it is what makes them separable from the model list here. The
 * `aria-expanded` exclusion drops the collapsed row's own toggle, which carries
 * the ACTIVE connection's name and would otherwise be indistinguishable from a
 * target row whenever one card's name is a substring of another's — which is
 * the normal shape of these three ("Nessy Gateway", "… (Nessy Gateway)").
 */
const CONNECTION_TARGET_ROW = '[role="menu"][data-state="open"] button:not([role="menuitem"]):not([aria-expanded])'
/** The integration row's expand toggle: the only non-menuitem button carrying `aria-expanded`. */
const INTEGRATION_TOGGLE = '[role="menu"][data-state="open"] button[aria-expanded]:not([role="menuitem"])'
const DIALOG = '[data-slot="dialog-content"]'
const DIALOG_TITLE = '[data-slot="dialog-title"]'
/** The cost list is the dialog's only list. */
const DIALOG_COST_ROW = '[data-slot="dialog-content"] li'

/**
 * The rig, checked BEFORE a model turn is spent on it.
 *
 * Both of these blocks used to fire deep in the case: the footer count at the
 * point of opening the picker (after a seed turn), and the trigger count inside
 * `openConnectionPicker` (later still). Neither is a fixture problem and neither
 * needs a session — a multi-panel layout and a narrow window are visible the
 * moment the case attaches. Hoisting them turns a several-minute run that ends
 * in "widen the window" into a refusal in seconds, and it is the reason CRU-3's
 * 2026-08-21 BLOCKED could not be attributed: the close-out recorded no
 * case-specific reason, and the reachable blockers were rig-shaped.
 */
async function assertRigIsDrivable(session: CdpSession, run: CaseRun): Promise<void> {
  const footers = await selectorCount(session, FOOTER)
  run.observe('composer footers on screen', footers)
  if (footers !== 1) {
    blocked(
      `there are ${footers} composer footers on screen. A multi-panel layout puts several pickers up at once and this `
      + 'case must not guess which session it is driving — run the wave with a single content panel open. '
      + '(Checked before any turn is spent: this is the rig, not a fixture.)',
    )
  }
  const triggers = await visibleButtons(session, FOOTER_MENU_TRIGGER)
  run.observe('composer footer menu triggers', triggers.length)
  if (triggers.length === 0) {
    blocked(
      'the composer footer has no dropdown trigger. On a narrow layout the composer renders the COMPACT drawer '
      + 'controls instead; widen the window so the desktop footer renders, then re-run. '
      + '(Checked before any turn is spent: this is the rig, not a fixture.)',
    )
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  // Rig first, fixtures second, turns last.
  await assertRigIsDrivable(session, run)
  const trio = await requireRuntimeTrio(session)
  const locale = await readLocale(session)
  run.observe('locale', locale)

  // --- pick the target direction from what this host can actually reach -----
  const connections = await listConnections(session)
  const auth = await authenticationBySlug(session)
  const pi = connections.find(c => c.slug === trio.pi)!
  const target = [trio.codex, trio.claude]
    .map(slug => connections.find(c => c.slug === slug))
    .find(row => row !== undefined && auth[row.slug] === true)
  if (!auth[pi.slug]) {
    blocked(
      `the Pi card "${pi.slug}" is not authenticated, so this case cannot start a session on it. `
      + 'Sign the gateway cards in through the app (one-click dp auth) and re-run.',
    )
  }
  if (!target) {
    blocked(
      `neither "${trio.codex}" nor "${trio.claude}" is authenticated, so there is no cross-runtime target to switch TO. `
      + `Authentication by slug: ${JSON.stringify(auth)}. This case needs two working runtimes.`,
    )
  }
  const fromRuntime = runtimeOf(pi.providerType)
  const toRuntime = runtimeOf(target.providerType)
  const outboundKey = `${fromRuntime}>${toRuntime}`
  const returnKey = `${toRuntime}>${fromRuntime}`
  run.observe('direction', `${pi.name ?? pi.slug} (${fromRuntime}) -> ${target.name ?? target.slug} (${toRuntime})`)

  // The inventory, derived from the module that owns it. Read here rather than
  // at module load so a moved table arrives as BLOCKED with its cause named.
  const table = costTable()
  const marker = table.notMeasured[locale]
  const expectedOutbound = expectedRows(table, fromRuntime, toRuntime, locale, RUNTIME_LABEL[toRuntime] ?? toRuntime)
  const expectedReturn = expectedRows(table, toRuntime, fromRuntime, locale, RUNTIME_LABEL[fromRuntime] ?? fromRuntime)
  run.observe('cost rows in the table', table.rows.length)
  run.observe(`expected ${outboundKey}`, expectedOutbound.map(describeExpected))
  run.observe(`expected ${returnKey}`, expectedReturn.map(describeExpected))
  run.require(
    'the table describes both ends of this direction',
    expectedOutbound.length > 0,
    `${outboundKey} derives no rows at all from ${table.rows.length} table rows — either a runtime is not a switch `
    + 'endpoint (a row is silent about it) or the direction genuinely costs nothing, and this case cannot tell '
    + 'a dialog that lists nothing from a dialog that never rendered',
  )
  // The rank property, which the old hand-written list gave away for free and
  // which a derived list must therefore assert: `files` rows before `abilities`
  // rows is the entire reason the module ranks them, because a user skimming one
  // dialog reads the top.
  run.check(
    'the derived expectation is itself ranked — every `files` row before every `abilities` row',
    isRanked(expectedOutbound),
    expectedOutbound.map(row => `${row.id}:${row.consequence}`).join(', '),
  )

  // `ConnectionRow` filters `nestor-cloud-agent` out of the target list — it is
  // neither a switch source nor a switch target — so the picker's row order is
  // this list's order.
  const pickerRows = connections.filter(c => c.providerType !== 'nestor-cloud-agent')
  const targetName = target.name ?? target.slug
  const piName = pi.name ?? pi.slug
  const targetIndex = pickerRows.findIndex(c => c.slug === target.slug)
  const piIndex = pickerRows.findIndex(c => c.slug === pi.slug)
  run.observe('picker rows', pickerRows.map(c => `${c.name ?? c.slug} (${c.slug})`))
  if (targetName === piName) {
    blocked(
      `both cards are named ${JSON.stringify(piName)}, so a row in the picker cannot be told apart by name. `
      + 'Rename one of them in Settings → AI and re-run.',
    )
  }

  // --- a session with history, on Pi ---------------------------------------
  const key = await freshSession(session, `${ID} switch costs`)
  run.observe('session', key)
  run.require('the case got a clean session', key.fresh, key.reason ?? '')

  await ensureConnection(session, key, pi.slug)
  run.require(
    `the session starts on ${pi.slug}`,
    (await activeConnection(session, key.sessionId)) === pi.slug,
    String(await activeConnection(session, key.sessionId)),
  )

  // The dialog exists for one tier only. Without a transcript
  // `runtimeSwitchCopyKey` returns null, the picker switches silently, and a
  // case that skipped this turn would report the whole block missing.
  const seeded = await sendPrompt(session, key, 'Reply with exactly: SEEDED', 300_000)
  run.observe('seed turn', lastAssistantText(seeded.added).slice(0, 120))
  // Read the TRANSCRIPT, not the session summary. `listSessions` derives its
  // count from `s.messages.length`, and the summary a listing returns does not
  // carry the array for every session — so a turn that plainly ran (its reply is
  // in `seed turn` above) was reported as `messageCount 0` and this case failed
  // on a precondition it had just satisfied. Measured 2026-08-17.
  const seededRows = (await transcript(session, key)).length
  run.require(
    'the session has a transcript, so the switch is the tier that asks',
    seededRows > 0,
    `transcript rows ${seededRows}`,
  )
  await waitForIdle(session, key)

  await assertSingleFooter(session)

  // ---- leg one: the direction that COSTS ----------------------------------
  const outbound = await openSwitchDialog(session, { activeName: piName, targetName, targetIndex })
  run.observe('outbound dialog title', outbound.title)
  run.observe('outbound dialog rows', outbound.rows)
  run.require(
    'the picker raised the cross-runtime switch dialog',
    outbound.title === table.title[locale],
    `expected ${JSON.stringify(table.title[locale])}, got ${JSON.stringify(outbound.title)}`,
  )

  run.check(
    `the dialog lists the ${expectedOutbound.length} costs of ${outboundKey}, in the table's own rank order`,
    sameRows(outbound.rows, expectedOutbound, marker),
    diffDetail(outbound.rows, expectedOutbound, marker),
  )
  run.check(
    'the cost block carries its heading, naming the runtime being moved onto',
    fold(outbound.text).includes(fold(fill(table.heading[locale], RUNTIME_LABEL[toRuntime] ?? toRuntime))),
    `dialog text: ${outbound.text.slice(0, 300)}`,
  )
  await closeDialogAndMenu(session)

  // ---- move the session, through the app's own command --------------------
  await ensureConnection(session, key, target.slug)
  await waitForIdle(session, key)
  run.require(
    `the session is now on ${target.slug}`,
    (await activeConnection(session, key.sessionId)) === target.slug,
    String(await activeConnection(session, key.sessionId)),
  )

  // ---- leg two: THE POSITIVE CONTROL --------------------------------------
  // Same dialog, same rig, opposite direction — and the control is that the two
  // legs must differ, not that this one is empty.
  //
  // **It used to be "lists no costs at all", and that was true when written and
  // is false now.** A cost is a capability the SOURCE has and the TARGET lacks,
  // and for three waves no capability the other two runtimes had and Pi lacked
  // passed the admission rule, so every return leg was empty. P6.65 and P6.170
  // ended that: `credentialShellFloor` (codex enforces the credential exclusion
  // in the OS, where ours is tool-mediated) and `policyKeys` (documented Claude
  // policy switches nothing of ours reads) are both real, both fire onto Pi, and
  // the module's own docblock stopped claiming otherwise on 2026-09-06 while
  // this case went on asserting it. An emptiness that is a PROPERTY OF THE ROW
  // SET cannot be restated in a case; it can only be derived, which is what
  // `expectedReturn` is.
  //
  // What the control still proves, and proves better: a hardcoded list cannot
  // satisfy both legs at once, because the two derived sets are different sets.
  const inbound = await openSwitchDialog(session, {
    activeName: targetName,
    targetName: piName,
    targetIndex: piIndex,
  })
  run.observe('return dialog title', inbound.title)
  run.observe('return dialog rows', inbound.rows)
  run.check(
    'the return leg still asks — the dialog appears',
    inbound.title === table.title[locale],
    `expected ${JSON.stringify(table.title[locale])}, got ${JSON.stringify(inbound.title)}`,
  )
  run.check(
    `CONTROL: switching back onto ${RUNTIME_LABEL[fromRuntime]} lists the ${expectedReturn.length} costs of ${returnKey}, and only those`,
    sameRows(inbound.rows, expectedReturn, marker),
    diffDetail(inbound.rows, expectedReturn, marker),
  )
  run.check(
    'CONTROL: the two legs are different lists — no fixed list can satisfy both',
    !sameIdSet(expectedOutbound, expectedReturn),
    `${outboundKey}: ${expectedOutbound.map(r => r.id).join(',')} | ${returnKey}: ${expectedReturn.map(r => r.id).join(',')}`,
  )
  run.check(
    expectedReturn.length === 0
      ? 'CONTROL: with nothing lost the dialog renders no cost heading either'
      : 'the return leg carries its own cost heading',
    fold(inbound.text).includes(fold(headingStem(table.heading[locale]))) === (expectedReturn.length > 0),
    `dialog text: ${inbound.text.slice(0, 300)}`,
  )
  await closeDialogAndMenu(session)
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
 * English for anything else, and mirroring that fallback here is the app's own
 * rule rather than a guess about the operator's machine.
 */
async function readLocale(session: CdpSession): Promise<Locale> {
  const raw = await session.call<string>(`
    const stored = window.localStorage.getItem('i18nextLng')
    return String(stored ?? navigator.language ?? 'en')
  `)
  return raw.toLowerCase().split(/[-_]/)[0] === 'ru' ? 'ru' : 'en'
}

/**
 * `LlmConnectionWithStatus.isAuthenticated` — the field that decides whether a
 * row in the picker is clickable at all.
 *
 * `listConnections` does not carry it, and a disabled row swallows the click
 * silently: the dialog never opens and the case looks like the block is
 * missing. Read it here so an unauthenticated card is BLOCKED by name.
 *
 * IT MUST COME FROM `listLlmConnectionsWithStatus`, and the first version of
 * this helper read `listLlmConnections` instead. That method returns the plain
 * `LlmConnection` — the field is not merely false there, it is ABSENT from
 * every row — so `c.isAuthenticated === true` was false for all eleven cards
 * and this case blocked itself on a precondition that was met. Measured
 * 2026-08-17: the keys on a row are slug, name, providerType, authType,
 * createdAt, baseUrl, models, defaultModel, modelSelectionMode, piAuthProvider,
 * customEndpoint, midStreamBehavior, lastUsedAt — and no status among them.
 * The `_WITH_STATUS` handler is the one that computes it, from whether
 * credentials exist for the card's auth type.
 *
 * The tell that made it a case defect rather than a product one: CRU-1 ran a
 * complete turn on `claude-gateway` in the same session while this probe
 * reported that same card unauthenticated.
 */
async function authenticationBySlug(session: CdpSession): Promise<Record<string, boolean>> {
  return session.call<Record<string, boolean>>(`
    const rows = await window.electronAPI.listLlmConnectionsWithStatus()
    const out = {}
    for (const c of rows ?? []) out[c.slug] = c.isAuthenticated === true
    return out
  `)
}

/** Move the session onto a connection through the app's own command, or BLOCK. */
async function ensureConnection(session: CdpSession, key: FreshSession, slug: string): Promise<void> {
  if ((await activeConnection(session, key.sessionId)) === slug) return
  const outcome = await switchRuntime(session, key.sessionId, slug)
  if (!outcome.ok) {
    blocked(
      `the app refused to move the session onto "${slug}": ${outcome.error ?? 'unknown error'}. `
      + 'This case needs two reachable runtimes on one host.',
    )
  }
  const settled = await waitForConnection(session, key.sessionId, slug)
  if (settled !== slug) {
    blocked(`the session did not settle on "${slug}" — it reports ${String(settled)}. The switch was accepted but never landed.`)
  }
}

async function waitForIdle(session: CdpSession, key: FreshSession, timeoutMs = 60_000): Promise<void> {
  await waitFor(
    async () => (await listSessions(session)).find(s => s.id === key.sessionId)?.isProcessing === true,
    processing => processing === false,
    { timeoutMs, intervalMs: 500, label: 'the session to stop processing (the picker refuses to open mid-turn)' },
  )
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
 * or an index read from one list clicks a different element in the other. That
 * exact mismatch is what `elementRect` in `lib/viewport.ts` records: an
 * invisible measuring copy rendered before the real control sent a click to a
 * `visibility: hidden` twin at another y, and the click missed with no error.
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

interface HitRead {
  found: boolean
  rect?: { x: number; y: number; width: number; height: number }
  covered?: string | null
}

/** Rect of the index-th visible match plus what is actually under its centre. */
async function hitRead(session: CdpSession, selector: string, index: number): Promise<HitRead> {
  return session.call<HitRead>(`
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
 * The same two guards `lib/viewport.ts` enforces, restated because that
 * module's hit-test is internal and this case must not edit `lib/`: the
 * coordinate is checked against the live viewport by `clickAt`, and the element
 * under the cursor is checked to BE the target — a coordinate click dies
 * silently under an overlay while key events keep working, which is the failure
 * mode that produces a confident wrong measurement.
 *
 * The hit-test POLLS, exactly as the lib's does, because "covered" is very
 * often a transient. A Radix dropdown keeps `pointer-events: none` on the body
 * for the length of its close animation, so a click issued the instant
 * `data-state` flips to `closed` reads as covered by `HTML` — a timing artifact
 * that a single read would turn into a hard error naming the wrong cause.
 */
async function clickVisible(session: CdpSession, selector: string, index: number, label: string): Promise<void> {
  const deadline = Date.now() + 10_000
  let hit = await hitRead(session, selector, index)
  while (hit.found && hit.covered && Date.now() < deadline) {
    await Bun.sleep(300)
    hit = await hitRead(session, selector, index)
  }
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
 * Open the composer's INTEGRATION picker, identified by what it contains.
 *
 * The footer holds several Radix menu triggers and none of them carries a test
 * hook, so the picker is found by opening candidates and reading them: the
 * integration menu is the one that names the session's ACTIVE connection and
 * carries `ConnectionRow`'s expand toggle. Both signals come from app state
 * (`listLlmConnections`) rather than from translated copy, so this identifies
 * the same control in either locale.
 */
async function openConnectionPicker(session: CdpSession, activeName: string): Promise<void> {
  const triggers = await visibleButtons(session, FOOTER_MENU_TRIGGER)
  if (triggers.length === 0) {
    blocked(
      'the composer footer has no dropdown trigger. On a narrow layout the composer renders the COMPACT drawer '
      + 'controls instead; widen the window so the desktop footer renders, then re-run.',
    )
  }
  for (const trigger of triggers) {
    await clickVisible(session, FOOTER_MENU_TRIGGER, trigger.index, `composer footer menu trigger #${trigger.index}`)
    const opened = await waitFor(
      () => visibleElements(session, OPEN_MENU),
      menus => menus.length > 0 && menus[0]!.text.trim().length > 0,
      { timeoutMs: 5_000, intervalMs: 200, label: 'a dropdown menu to open with text' },
    ).catch(() => [])
    const text = opened[0]?.text ?? ''
    const hasToggle = (await selectorCount(session, INTEGRATION_TOGGLE)) === 1
    if (text.includes(activeName) && hasToggle) return
    await pressKey(session, 'Escape')
    await waitFor(
      () => selectorCount(session, OPEN_MENU),
      count => count === 0,
      { timeoutMs: 5_000, intervalMs: 200, label: 'the wrong menu to close' },
    ).catch(() => 0)
  }
  blocked(
    `none of the ${triggers.length} composer-footer menus is the integration picker: none both names the active `
    + `connection ${JSON.stringify(activeName)} and carries the integration expand toggle. The picker may be `
    + 'disabled — it refuses to open while a turn is in flight, when the connection is unavailable, or when only '
    + 'one switch target is configured.',
  )
}

interface DialogRead {
  title: string
  text: string
  /** The cost rows, bullets stripped, in render order. */
  rows: string[]
}

interface SwitchTarget {
  /** The name shown on the ACTIVE integration's collapsed row — used to find the picker. */
  activeName: string
  /** The name shown on the row to pick. */
  targetName: string
  /**
   * The target's position in the picker's own list.
   *
   * `ConnectionRow` renders `connections.filter(c => c.providerType !== 'nestor-cloud-agent')`
   * in order, so this index is derived from `listLlmConnections()` rather than
   * from text — the tie-break for the case where one card's name contains
   * another's. It is used only when the name alone is ambiguous, and the row it
   * points at is verified to carry the name before it is clicked, so a
   * divergence between the two orders BLOCKS instead of clicking the wrong card.
   */
  targetIndex: number
}

/**
 * Expand the integration row, pick the target, and read the dialog it raises.
 */
async function openSwitchDialog(session: CdpSession, names: SwitchTarget): Promise<DialogRead> {
  await openConnectionPicker(session, names.activeName)

  const toggle = (await visibleButtons(session, INTEGRATION_TOGGLE))[0]
  if (!toggle) blocked('the integration row vanished between identifying the picker and expanding it')
  if (toggle.disabled) {
    blocked(
      'the integration row is disabled, so no switch can be started. `canOpen` requires the server to report the '
      + 'connection switchable, no turn in flight, and more than one target configured.',
    )
  }
  await clickVisible(session, INTEGRATION_TOGGLE, 0, 'the integration expand toggle')

  const rows = await waitFor(
    () => visibleButtons(session, CONNECTION_TARGET_ROW),
    buttons => buttons.some(b => b.text.includes(names.targetName)),
    { timeoutMs: 8_000, intervalMs: 250, label: `the expanded integration list to offer ${names.targetName}` },
  )
  const matches = rows.filter(b => b.text.includes(names.targetName))
  // One match is the answer. Several means one card's name contains another's,
  // and then — and only then — the picker's own ordering breaks the tie, with
  // the chosen row verified to carry the name before anything is clicked.
  const targetRow = matches.length === 1
    ? matches[0]!
    : rows.find(b => b.index === names.targetIndex && b.text.includes(names.targetName))
  if (!targetRow) {
    blocked(
      `${matches.length} rows in the integration list contain ${JSON.stringify(names.targetName)} and row `
      + `#${names.targetIndex} is not one of them, so this case cannot tell which row it means. `
      + `Rows: ${JSON.stringify(rows.map(r => r.text))}`,
    )
  }
  if (targetRow.disabled) {
    blocked(
      `the "${names.targetName}" row is disabled (not authenticated), so the picker will not offer it as a target. `
      + 'Sign that card in through the app and re-run.',
    )
  }
  await clickVisible(session, CONNECTION_TARGET_ROW, targetRow.index, `the "${names.targetName}" integration row`)

  // Wait for the dialog to have CONTENT, not merely to match. `innerText` is
  // layout-dependent, and a read taken the instant the selector matches returns
  // `''` for an element whose container has not sized yet — which reads exactly
  // like "the dialog says nothing".
  const dialogs = await waitFor(
    () => visibleElements(session, DIALOG),
    found => found.length === 1 && found[0]!.text.trim().length > 0,
    { timeoutMs: 15_000, intervalMs: 250, label: 'the runtime-switch dialog to render with text' },
  ).catch(() => [])
  if (dialogs.length !== 1) {
    blocked(
      'picking the other integration raised no dialog. Either the session lost its transcript (the silent tier), or '
      + 'the picker treated this as a model change rather than a runtime change.',
    )
  }

  const title = (await visibleElements(session, DIALOG_TITLE))[0]?.text ?? ''
  const costRows = (await visibleElements(session, DIALOG_COST_ROW)).map(el => stripBullet(el.text))
  return { title, text: dialogs[0]!.text, rows: costRows }
}

async function closeDialogAndMenu(session: CdpSession): Promise<void> {
  await pressKey(session, 'Escape')
  await waitFor(
    () => visibleElements(session, DIALOG),
    found => found.length === 0,
    { timeoutMs: 8_000, intervalMs: 250, label: 'the switch dialog to close' },
  ).catch(() => [])
  await pressKey(session, 'Escape')
  await waitFor(
    () => selectorCount(session, OPEN_MENU),
    count => count === 0,
    { timeoutMs: 8_000, intervalMs: 250, label: 'the integration picker to close' },
  ).catch(() => 0)
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** i18next's `{{toRuntime}}`, filled the way `RuntimeSwitchDialog` fills it. */
function fill(sentence: string, toRuntime: string): string {
  return sentence.replace(/\{\{toRuntime\}\}/g, toRuntime)
}

/** The heading without its interpolation, for an absence claim about any runtime. */
function headingStem(heading: string): string {
  return heading.replace(/\s*\{\{toRuntime\}\}\s*/g, '').trim()
}

/**
 * Case-fold, because `innerText` applies `text-transform`.
 *
 * The cost heading is `uppercase tracking-wide` (`RuntimeSwitchDialog.tsx:103`),
 * so the string a DOM read returns is "NOT AVAILABLE ON CODEX" while the locale
 * file says "Not available on {{toRuntime}}". Case-sensitive comparison would
 * fail the presence check on a heading that is right there — and, worse, would
 * make the control's ABSENCE check pass for free, which is the shape of finding
 * that proves nothing. The rows themselves carry no transform and are compared
 * exactly.
 */
function fold(text: string): string {
  return text.toLocaleLowerCase()
}

/**
 * Each row renders as an `aria-hidden` em dash plus the sentence; `innerText`
 * carries the dash. Only the LEADING one is stripped — several of the sentences
 * contain an em dash of their own.
 */
function stripBullet(text: string): string {
  return text.replace(/^[—–-]\s*/, '').trim()
}

/** `id:consequence` (+ the marker), for the observation lines. */
function describeExpected(row: ExpectedRow): string {
  return `${row.id}:${row.consequence}${row.unmeasured ? ':unmeasured' : ''}`
}

/** Every `files` row before every `abilities` row — the module's own rank order. */
function isRanked(rows: readonly ExpectedRow[]): boolean {
  const firstAbility = rows.findIndex(row => row.consequence === 'abilities')
  if (firstAbility < 0) return true
  return rows.slice(firstAbility).every(row => row.consequence === 'abilities')
}

/**
 * Does the rendered row match the expectation?
 *
 * A MEASURED row is the sentence exactly. An UNMEASURED row is the sentence
 * followed by `({{costNotMeasured}})` in its own `<span>` (P6.562), and the two
 * are inline siblings separated by a CSS margin rather than by a text node — so
 * whether `innerText` puts a space between them is a rendering detail this case
 * must not depend on. Start and end are asserted separately for exactly that
 * reason; the sentence itself is still matched in full.
 */
function rowMatches(actual: string, expected: ExpectedRow, marker: string): boolean {
  if (!expected.unmeasured) return actual === expected.sentence
  return actual.startsWith(expected.sentence) && actual.trimEnd().endsWith(`(${marker})`)
}

function sameRows(actual: string[], expected: readonly ExpectedRow[], marker: string): boolean {
  return actual.length === expected.length
    && actual.every((value, index) => rowMatches(value, expected[index]!, marker))
}

function diffDetail(actual: string[], expected: readonly ExpectedRow[], marker: string): string {
  if (sameRows(actual, expected, marker)) return ''
  return `expected ${JSON.stringify(expected.map(describeExpected))} = ${JSON.stringify(expected.map(row => row.sentence))}; `
    + `rendered ${JSON.stringify(actual)}`
}

/** Two directions carrying the same row ids — the shape a hardcoded list would have. */
function sameIdSet(a: readonly ExpectedRow[], b: readonly ExpectedRow[]): boolean {
  const left = a.map(row => row.id).sort().join(',')
  return left === b.map(row => row.id).sort().join(',')
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
