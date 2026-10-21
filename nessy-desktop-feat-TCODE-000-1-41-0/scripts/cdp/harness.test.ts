import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { MODULE_GRAPH_CASE_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

import { classifyInstallMiss, INSTALL_TOOLS, loadPrompt, loadThenCall } from './cases/agent-install.ts'
import { capabilityIdOf, DETAIL_PAGE_TEXT, detailContextOrder, ONBOARDING_TEXT, readDetailPage } from './cases/mcp-w1.ts'
import { callPrompt, inventoryToolsLine, modelSurfaceExpectations } from './cases/mcp-w2.ts'
import { classifyReachMiss, reachNames, reachPrompt, readReach } from './cases/plugin-install-runtimes.ts'
import {
  compareBuiltinRoster, dpLessBranch, DP_FALLBACK_PATH, resultShape, savedMemoryPath, sentenceOpening, toolRow,
} from './cases/rs-105.ts'
import {
  bodyEvidence, bodyOpening, bodyWindows, bundledSkillNames, parseSkillFile, probePrompt, REVIEW_SHAPED_PROMPT,
} from './cases/rs-106.ts'
import { COMMAND_ROW, expectedHooks, fired, HOOK_PROBE_PROMPT, PALETTE_CONTROL_ROW, unaskedFirings } from './cases/rs-107.ts'
import { isOutside, outsideMarkerRoot } from './cases/rs-11.ts'
import {
  probeRepositoryParent, probeRepositoryShape, resolveCardsUnderTest, tempWritableRoots,
} from './cases/rs-13.ts'
import { outsideMarkerPath } from './cases/rs-15.ts'
import { FIXTURE_NAMES, seedAgentSurfaces, targetConfigDir } from './fixtures/agent-surfaces.ts'
import { buildCmdHookFixture, buildFixtures, CMDHOOK, EXPECTED, inspectFixtureConfigDir, modelToolName, proxyToolName } from './fixtures/mcp-naming.ts'
import { buildAnswer, extractShellCommand, pickShellTool, shellArgumentName, startStubUpstream } from './fixtures/stub-upstream.ts'
import {
  approvePermissionsWhile, approverBlindnessNote, approverClaimBlockReason, cardButtonScript,
  type CardButtonHit, type PermissionApproverReads,
} from './lib/ask-user.ts'
import { attach, focusWindow, reassertWindowFocus, resolveTimeoutMs, type CdpSession, type ConnectOptions } from './lib/connect.ts'
import { boundedQuotaLimit, classifyQuotaRender, compareQuotaBudgets, isNessyGatewayChatBase, paneDelta, quotaLimitShape } from './lib/nestor-cloud.ts'
import {
  casePermissionModeOptOut, CASE_PERMISSION_MODE_OPT_OUTS, currentCaseId, DEFAULT_CASE_PERMISSION_MODE,
  resolveCasePermissionMode, ROW_NAMED_NOT_OPTED_OUT, setCurrentCaseId,
} from './lib/permission-mode.ts'
import { classifyRendererHealth } from './lib/renderer-health.ts'
import { configDirVerdict, CONTAMINATING_ENV_NAMES, launchedConfigDir, launcherUnsetNames, readAppConfigDirs, type AppConfigDirReading } from './lib/app-env.ts'
import { BlockedError, CaseRun, exitCodeFor, RESULT_PREFIX, type CaseCheck, type CaseResult } from './lib/report.ts'
import { typeIntoComposer } from './lib/composer.ts'
import { bareCommandEvidence, readPiSessionLog } from './lib/runtime-session-log.ts'
import {
  answerTrustGate, bindProject, bindWorkingDirectory, buttonLabelInPage, buttonTextInPage, CANCEL_BUTTON_TEXTS, CLOSE_BUTTON_TEXTS, DIALOG_DISMISS_BUTTON_TEXTS, isTrustGateButton, isTrustGateHeading, silentGateVerdict,
  TRUST_DIALOG_PATH_SELECTOR, TRUST_GATE_BUTTON, TRUST_GATE_HEADING_IN_PAGE, TRUST_GATE_TITLES, trustScratchProject,
} from './lib/runtime-switch.ts'
import { pressCard } from './lib/permission-card.ts'
import { positiveControlOf, SITTING_RUNTIMES, sittingChecklistDrift, type CaseMeta, type SittingRecipe } from './lib/sitting.ts'
import { clearLabelFiltersInViewFilters, createSessionDirectly, EFFORT_LEVELS, effortRank, freshSession, piPendingPermissions, piReadNote, requireReadablePiRuntime, type PiRuntime, type TranscriptMessage } from './lib/state.ts'
import { isAncestor, readArtifactMarker, ARTIFACT_COMMIT_ENV, ROW_ARTEFACT_MARKERS } from './lib/artifact-carries.ts'
import type { AppUnderTest } from './lib/bundle.ts'

// P6.1008 — THIS FILE'S WALL TIME IS ITS MODULE GRAPH, and bun's 5 s per-test
// default therefore manufactures its own red. Three readings on byte-identical
// work, each with its own date, and the spread is the whole diagnosis:
//
//   19 pass / 1 fail / 1 file   71.85 s   load 15-16   (W10-i, 2026-09-10)
//   ZERO tests executed         55.53 s   load 15.67 -> 16.80   (`-t` matching
//                                         nothing; real 56.86 / user 0.60 /
//                                         sys 0.19, ~1.4 % cpu — W10-i)
//   20 pass / 0 fail / 1 file   13.13 s   (real 13.15 / user 0.65 / sys 0.21 —
//                                         W10-j, 2026-09-10, WARM)
//
// The zero-case control is the separating instrument (AGENTS.md §Traps): 55.53 s
// of the 71.85 s is paid before a single case runs, at ~1.4 % cpu, so the cost is
// I/O against a timer and not contention. The one red W10-i met was
// `case wiring`, which pays 21 more dynamic `await import('./cases/<id>.ts')`
// graphs INSIDE its body — but WHICH case is holding the window when the timer
// fires is an accident, which is why the budget is the FILE's and is sized
// against the largest observed run TOTAL rather than a per-case floor. The warm
// 13.13 s reading is recorded to show the lottery, and deliberately NOT written
// to the cost ledger: a warm number there would size the next budget too small.
//
// Why the budget and not a hoist. Rule 24's own prescription is a static
// top-level import, and it cannot be applied here: this file's case imports are
// COMPUTED from an id list, and the sitting block below globs `cases/rs-*.ts`.
// Hoisting either of them would mean hand-writing the very list these tests exist
// to check against the directory.
//
// Why `MODULE_GRAPH_CASE_BUDGET_MS` (300 000) of the three shapes: the cost that
// crosses a timer here is per-CASE dynamic-import work, not a `beforeAll`, and it
// is the smallest of the three that covers the largest observed total — the same
// pick `packages/shared/src/plugins/__tests__/format-adapters.test.ts` made from
// the same evidence. Readings appended to `scripts/module-graph-hook-costs.txt`.
//
// Why a `@nessy-agent/*` import is admissible in THIS file though no case may
// carry one: the harness's rule (`lib/model-window.ts`, in its own words —
// "no case in `scripts/cdp/` imports from `@nessy-agent/*`; dragging the shared
// package into a harness process changes what the harness is") is about a
// standalone `bun run` CASE process. This is a `bun test` file that drives
// nothing, and the budgets module imports nothing of its own, so no shared graph
// follows it in.
setDefaultTimeout(MODULE_GRAPH_CASE_BUDGET_MS)

const CASES = [
  'AGT-1', 'AGT-2', 'AGT-3', 'AGT-4', 'AGT-5', 'AGT-6', 'AGT-7', 'AGT-8',
  // The MCP wire-name gate. Listed here for the same reason as the rest: a case
  // whose `meta.id` drifts from its filename produces a `##CDP-RESULT##` line
  // nobody can attribute to a checklist row.
  'MCP-W1', 'MCP-W2', 'MCP-W3',
  // The `paths`-gated skill fixture case (Gap A of the 1.25.0 independent
  // audit): no public SKILL.md declares `paths:`, so the artifact is ours.
  'SKL-P1',
  // The Nestor Cloud remote agent block. None of these can be RUN without a live
  // corporate gateway, which is exactly why they are listed here: the wiring —
  // the module loads, `meta.id` matches the filename, `drive` is a function, and
  // the runner knows the id — is the part that can be verified offline, and a
  // case whose id drifts from its filename produces a `##CDP-RESULT##` line
  // nobody can attribute to a checklist row.
  'NCA-1', 'NCA-2', 'NCA-3', 'NCA-4', 'NCA-5', 'NCA-6', 'NCA-7', 'NCA-8', 'NCA-9',
]

describe('case wiring', () => {
  it('has a runnable file per checklist case, whose meta matches its name', async () => {
    for (const id of CASES) {
      const mod = await import(`./cases/${id.toLowerCase()}.ts`) as { meta?: { id: string; title: string }; drive?: unknown }
      expect(mod.meta?.id).toBe(id)
      expect(typeof mod.drive).toBe('function')
      expect((mod.meta?.title ?? '').length).toBeGreaterThan(10)
    }
  })

  it('importing a case does not drive anything', async () => {
    // `import.meta.main` is false under import, so the test above already ran
    // every module's top level. If a case had side effects it would have thrown
    // here (no app is running).
    expect(true).toBe(true)
  })

  it('the wave runner covers exactly the case files that exist', async () => {
    const source = await Bun.file(new URL('./run.ts', import.meta.url).pathname).text()
    for (const id of CASES) expect(source).toContain(`'${id}'`)
  })
})

/**
 * D1.229 — a case's QUOTED copy table against the LIVE locale.
 *
 * `cru-4.ts` quotes three user-visible strings verbatim, deliberately: a key is
 * not what a user reads, and a loose fragment match would pass on a sentence
 * that had lost its meaning. The cost of that choice is that a copy edit landing
 * without a table update fails the CASE — on a live rig, against text that is
 * correct. It happened twice on the same string: `526f6983a` removed the
 * `except in Bypass` tail and `e706e113b` appended the unattended-fallback
 * clause, and neither reached the table.
 *
 * So the restatement is checked here, where it costs a `bun test` rather than a
 * sitting. A case opts in by exporting a `QUOTED_COPY` of key -> locale -> the
 * string it quotes; this block globs the directory for the export and needs no
 * list.
 *
 * **THE TRAP, and it is the reason the guard is written with `live[key]`.** The
 * locale JSONs are FLAT-keyed: the file literally holds the key
 * `"chat.permissionModeRuntimeNote.codex"`, not a nested `chat` object. A guard
 * written with the obvious dot-path walk resolves EVERY key to `undefined` and
 * then reports drift on six strings that are byte-correct — which is exactly the
 * failure this guard exists to prevent, reproduced inside the guard. WI-i walked
 * into it writing the probe this block came from (`lane-WI-i-report.md` §D1.121).
 *
 * The positive control is therefore not optional: a key the tables do NOT quote
 * is resolved in the same way, in the same test, so a reader that can see
 * nothing cannot pass.
 */
describe("a case's quoted copy against the live locale", () => {
  const LOCALES = ['en', 'ru'] as const
  const LOCALE_DIR = join(import.meta.dir, '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')

  /** A flat dotted key NO table quotes — the reader's own control. */
  const CONTROL_KEY = 'chat.permissionModeClause.codexDontAsk'

  it('matches every quoted string, and proves it can read a key it does not quote', async () => {
    const live: Record<string, Record<string, string>> = {}
    for (const locale of LOCALES) {
      live[locale] = JSON.parse(readFileSync(join(LOCALE_DIR, `${locale}.json`), 'utf8')) as Record<string, string>
      // THE POSITIVE CONTROL, asserted before any comparison: a flat lookup of a
      // key no table quotes returns a real sentence. Under the nested-walk bug
      // this is `undefined` and the whole block fails HERE, naming the reader,
      // instead of reporting drift on correct copy.
      expect(
        (live[locale] as Record<string, string>)[CONTROL_KEY],
        `${locale}.json: the control key resolved to nothing — the reader is walking dots, not reading flat keys`,
      ).toMatch(/\S/)
    }

    const names = readdirSync(join(import.meta.dir, 'cases')).filter(name => name.endsWith('.ts')).sort()
    let compared = 0
    let tables = 0
    for (const name of names) {
      // Read the SOURCE first and import only a file that opts in: importing all
      // ~90 case modules to find three exports is the module-graph cost this
      // file's own budget comment is about.
      const source = readFileSync(join(import.meta.dir, 'cases', name), 'utf8')
      if (!source.includes('export const QUOTED_COPY')) continue
      const mod = await import(`./cases/${name}`) as { QUOTED_COPY?: Record<string, Record<string, string>> }
      const quoted = mod.QUOTED_COPY
      if (quoted === undefined) continue
      tables += 1
      for (const [key, byLocale] of Object.entries(quoted)) {
        for (const locale of LOCALES) {
          const mine = byLocale[locale]
          if (mine === undefined) continue
          compared += 1
          expect(
            (live[locale] as Record<string, string>)[key],
            `${name} quotes ${key} (${locale}) as ${JSON.stringify(mine)}`,
          ).toBe(mine)
        }
      }
      // And the control on the TABLE: a table quoting the control key would make
      // the reader's control vacuous for the next reader.
      expect(Object.keys(quoted)).not.toContain(CONTROL_KEY)
    }

    // The anti-vacuum controls on the loop. A glob that stopped matching, or an
    // export that was renamed, leaves every assertion above unreached — and both
    // numbers are floors with a date (1 table, 6 strings on 2026-09-17; 4 since
    // 2026-09-29, when F1.1052 deleted the retired explore's codexReadOnly key), not a statement about how many tables the harness has.
    expect(tables, 'no case exports a QUOTED_COPY — the glob or the export name moved').toBeGreaterThanOrEqual(1)
    expect(compared).toBeGreaterThanOrEqual(4)
  })
})

/**
 * The SITTING cases (`cases/rs-*.ts`), enumerated by the DIRECTORY — P6.1012.
 *
 * The `CASES` array above is hand-maintained, and twenty-eight sitting files
 * landed in one wave without appearing in it or in `run.ts`'s. That is deliberate
 * for the ten that print a recipe instead of driving — `runOne` reads a
 * `##CDP-RESULT##` line and would score a recipe FAIL for never having been meant
 * to run — but it left the whole block enumerated by NOTHING: a `meta.id` that
 * drifts from its filename produces a result line nobody can attribute to a
 * checklist row, which is the same defect the `CASES` list exists to prevent for
 * the wave cases.
 *
 * So this block globs the directory rather than restating it. Three properties,
 * each of which has a way of being wrong that looks like a product finding:
 *
 * 1. **`meta.id` is the filename, upper-cased.** `rs-15.ts` must say `RS-15`.
 * 2. **`meta.row` names a row that EXISTS in the plan**, matched the way the plan
 *    is grepped — `^| <row> ` with the trailing space, so `P6.6` cannot match
 *    `P6.66`'s line and the dot cannot match an arbitrary character.
 * 3. **A recipe is ABSENT from the wave runner.** A file exporting `manual` and no
 *    `drive` must never be in `run.ts`'s `CASES`, because the runner would spawn
 *    it and report FAIL for the missing result line.
 */
describe('the sitting cases', () => {
  const CASE_DIR = new URL('./cases/', import.meta.url).pathname
  /**
   * The plans a sitting case may answer a row of.
   *
   * TWO of them since the 2026-09-12 rig day, and the second is not a
   * convenience: the rig day drives the `2026-09-11-coverage-95-parity.md`
   * plan's C5 phase, so a case born there answers a `C3.*` / `C5.*` row that
   * `2026-08-22-runtime-parity-closure.md` has never carried and never will.
   * With one plan here, such a case fails this block on its FIRST run — and the
   * cheap way past that failure is to write a `P6.*` row id the case does not
   * answer, which is exactly the id-drift this block exists to prevent. A row is
   * named by whichever plan carries it; the guard's job is that SOME plan does.
   */
  const PLANS = [
    '2026-08-22-runtime-parity-closure.md',
    '2026-09-11-coverage-95-parity.md',
    // THREE since 2026-09-14 (WB-f), by the same argument the paragraph above
    // makes for the second: the coverage plan CLOSED and carried its open live
    // rows into `2026-08-22-dp-auth-wave2-and-mcp-exposure.md`, so a case born
    // for one of them answers a `DA*` row no earlier plan has ever carried. With
    // two plans here, `rs-39.ts` fails this block on its first run, and the cheap
    // way past that failure is to write a row id the case does not answer —
    // exactly the id-drift this block exists to prevent.
    '2026-08-22-dp-auth-wave2-and-mcp-exposure.md',
    // FOUR since 2026-09-17 (WI-f), by the same argument again: the
    // `measure:` rows the parity closure deferred on 2026-09-10 were MOVED —
    // each is closed in the parity plan as moved, not as done, and lives under a
    // `D1.*` id that no earlier plan has ever carried. A sitting case born for
    // one of them therefore fails this block on its first run, and the cheap way
    // past that failure is to name the SOURCE `P6.*` id instead — which would
    // attribute the reading to a row that is closed, i.e. exactly the id-drift
    // this block exists to prevent. The `## Pointers back` table in that plan is
    // the map in both directions.
    '2026-09-10-integrations-and-authorization.md',
    // FIVE since 2026-09-23 (WJ-jj, F1.148), by the same argument once more: the
    // 1.41.0 follow-up plan carries the `F1.*` rows its cases answer — RS-105…107
    // are the three SIT-11 surfaces F1.148 owes — and no earlier plan names them.
    '2026-09-18-integrations-followup-1.41.0.md',
    // SIX since 2026-10-02 (UA-e, UA1.1), by the same argument once more: the
    // 1.42.0 upstream-adoption plan carries the `UA*.*` rows its sitting cases
    // answer (UA1.12 opens the "Task board and planning" area, and every later
    // board and pages case joins it), and no earlier plan names a `UA` id — so
    // without it here, the first such case fails this block on its first run.
    '2026-09-23-upstream-adoption-0-13-4-board-planning-pages.md',
    // SEVEN since 2026-10-15 (UB1.1), by the same argument once more: the
    // 1.43.0 upstream-adoption plan — promoted into the tree that day — carries
    // the `UB*.*` rows its sitting cases answer (UB1.11 opens Phase 1's live
    // cases, and every later phase's case list joins it), and no earlier plan
    // names a `UB` id — so without it here, the first such case fails this
    // block on its first run.
    '2026-10-14-upstream-adoption-0-15-1.md',
  ]
    .map(name => join(import.meta.dir, '..', '..', 'docs', 'superpowers', 'plans', name))

  /** `^| <row> ` — the plan's own grep, with the row id escaped rather than trusted. */
  function planNamesRow(plan: string, row: string): boolean {
    return new RegExp(`^\\| ${row.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `, 'm').test(plan)
  }

  const sittingFiles = readdirSync(CASE_DIR).filter(name => /^rs-\d+\.ts$/.test(name)).sort()

  it('matches a row line by its whole id, not by a prefix', () => {
    // The boundary, against a fabricated plan rather than the real one: a naive
    // `plan.includes(row)` scores `P6.6` as present because `P6.66` is, and an
    // unescaped `.` scores `P6X66`. Both would make property 2 below vacuous.
    const fake = '| P6.66 | a row |\n| P6.660 | another row |\n'
    expect(planNamesRow(fake, 'P6.66')).toBe(true)
    expect(planNamesRow(fake, 'P6.660')).toBe(true)
    expect(planNamesRow(fake, 'P6.6')).toBe(false)
    expect(planNamesRow(fake, 'P6X66')).toBe(false)
    expect(planNamesRow(fake, 'P6.6600')).toBe(false)
  })

  it('resolves a UA row through the real PLANS, and refuses a UA id no plan carries', () => {
    // UA1.1 (2026-10-02): a fake sitting case answering the board plan. The
    // positive arm is a row the plan's tracker carries today; the negative arm
    // is the same family with an id no plan has, read through the SAME list
    // and the same matcher, so the pair fails together if the list loses the
    // plan (the positive turns red) or the matcher stops anchoring (the
    // negative turns red).
    const plans = PLANS.map(path => readFileSync(path, 'utf8'))
    const fakeCase: Pick<CaseMeta, 'row'> = { row: 'UA2.7' }
    expect(plans.some(plan => planNamesRow(plan, fakeCase.row))).toBe(true)
    expect(plans.some(plan => planNamesRow(plan, 'UA99.99'))).toBe(false)
    expect(plans.some(plan => planNamesRow(plan, 'UA2.70'))).toBe(false)
  })

  it('resolves a UB row through the real PLANS, and refuses a UB id no plan carries', () => {
    // UB1.1 (2026-10-15): the same pair against the 1.43.0 plan. The positive
    // arm is UB1.11 — the row the first Phase 1 sitting case will answer; the
    // negative arms are a nonexistent id and a near-miss of an existing one,
    // so a matcher that stopped anchoring at the dot (UB1.11 matching
    // UB1.110) turns red here and not in a sitting.
    const plans = PLANS.map(path => readFileSync(path, 'utf8'))
    const fakeCase: Pick<CaseMeta, 'row'> = { row: 'UB1.11' }
    expect(plans.some(plan => planNamesRow(plan, fakeCase.row))).toBe(true)
    expect(plans.some(plan => planNamesRow(plan, 'UB99.99'))).toBe(false)
    expect(plans.some(plan => planNamesRow(plan, 'UB1.110'))).toBe(false)
  })

  it('finds the sitting files on disk at all', () => {
    // The anti-vacuum control. Every assertion below runs inside a loop over this
    // list, so a glob that returned nothing — wrong directory, wrong pattern —
    // would pass the whole block silently. The floor is the count on the day it
    // was last raised — `ls scripts/cdp/cases/rs-*.ts | wc -l`, 37 on 2026-09-12
    // once `rs-38` landed in the 1.37.0 release verification (36 after `rs-36`
    // and `rs-37`, 34 once `rs-35` landed, 33 with `rs-34` and 32 with `rs-33`
    // earlier the same day, 31 on 2026-09-11 with `rs-32`) — and it only ever
    // moves UP, when a case is added, or DOWN when one is deliberately deleted.
    // 47 on 2026-09-17, once `rs-46`…`rs-49` landed in WAVE I-1's first measure
    // sitting (43 before them); 48 later the same day with `rs-50` and 49 with
    // `rs-51`, WAVE I-2's second measure sitting; 50 with `rs-52` and 51 with
    // `rs-53`, 52 with `rs-54` and 53 with `rs-55`, WAVE I-3's third (2026-09-17).
    // It is not a statement about how many cases the sitting has today: read the
    // glob, never this number.
    expect(sittingFiles.length).toBeGreaterThanOrEqual(53)
    expect(sittingFiles[0]).toBe('rs-02.ts')
  })

  it('names every sitting case after its file, and every row after a plan row', async () => {
    const plans = PLANS.map(path => readFileSync(path, 'utf8'))
    // The anti-vacuum control for the list itself: a path that stopped resolving
    // would read as an empty string and match nothing, which looks the same as a
    // case naming a row that does not exist.
    for (const plan of plans) expect(plan.length).toBeGreaterThan(10_000)
    for (const name of sittingFiles) {
      const id = name.replace(/\.ts$/, '').toUpperCase()
      const mod = await import(`./cases/${name}`) as { meta?: CaseMeta; drive?: unknown; manual?: unknown }
      expect(mod.meta?.id).toBe(id)
      expect((mod.meta?.title ?? '').length).toBeGreaterThan(10)
      expect(plans.some(plan => planNamesRow(plan, mod.meta?.row ?? ''))).toBe(true)
      expect(Array.isArray(mod.meta?.runtimes) && mod.meta.runtimes.length > 0).toBe(true)
      // Either it drives or it is a recipe — never neither, which is a file the
      // sitting cannot use in any form.
      expect(typeof mod.drive === 'function' || typeof mod.manual === 'object').toBe(true)
    }
  })

  /**
   * A case may not take a CHECKLIST ID that already belongs to a different row.
   *
   * Measured 2026-09-17 (WB-f, DA2.11). This case block already checked that a
   * case's `meta.row` names a row some PLAN carries, and that `meta.id` matches
   * the filename — and it was still possible for two different sittings to report
   * under one id, because nothing looked at the checklist. `RS-39` had been
   * claimed since 2026-09-13 by a wave-A row (`/quota` on the two non-Pi gateway
   * cards, `DA1.17`), with its File column reading "case owed"; a case file with
   * no checklist row and a checklist row with no case file are invisible to each
   * other, so `rs-39.ts` landed on top of it and nothing failed. The case is
   * `rs-43.ts` now.
   *
   * The rule is deliberately the WEAKEST one that catches it: **when the
   * checklist already has a row for this id, that row must mention the case's own
   * `meta.row`.** It says nothing about a case whose id the checklist does not
   * carry yet — the checklist is controller-owned and a new case's row arrives
   * after the case does, so requiring a row would redden every lane that lands
   * one. 38 of the 39 cases on the day this was written already satisfied it, and
   * the one that did not was the collision.
   */
  it('takes no checklist id that already belongs to a different row', async () => {
    const checklist = await Bun.file(
      join(import.meta.dir, '..', '..', 'docs', 'testing', 'cdp-live-checklist.md'),
    ).text()
    // The anti-vacuum control: an unreadable checklist reads as an empty string,
    // in which case NO id has a row and the loop below asserts nothing at all.
    expect(checklist.length).toBeGreaterThan(10_000)
    expect(checklist).toContain('| RS-16 |')
    let rowsChecked = 0
    for (const name of sittingFiles) {
      const id = name.replace(/\.ts$/, '').toUpperCase()
      const line = checklist.split('\n').find(candidate => candidate.startsWith(`| ${id} |`))
      if (line === undefined) continue
      const mod = await import(`./cases/${name}`) as { meta?: CaseMeta }
      const row = mod.meta?.row ?? ''
      // The WHOLE line, never a slice of it: a checklist row carries its row ids
      // in its Note column, which is the last and longest cell — a 200-character
      // window over `RS-38` cut `C3.371` off and failed a row that was correct
      // (measured the same day this guard was written).
      expect(`${id} | ${line}`).toContain(row)
      rowsChecked += 1
    }
    // The second anti-vacuum control, on the loop rather than on the file: every
    // assertion above is inside a `continue`, so a matcher that stopped matching
    // any line would leave this block green having checked nothing.
    expect(rowsChecked).toBeGreaterThanOrEqual(30)
  })

  it('names every driving sitting case in the runner and keeps every recipe out', async () => {
    const runner = await Bun.file(new URL('./run.ts', import.meta.url).pathname).text()
    // D1.113 — the membership is read out of EACH ARRAY, never as a substring of
    // the file. `runner.includes(`'RS-51'`)` was the old instrument, and it is
    // satisfied by an id sitting in the WAVE: measured 2026-09-17 by moving
    // `'RS-51'` from `SITTING` into `CASES` and re-running this very test, which
    // stayed green (1 pass / 0 fail) over a runner that would then have swept a
    // sitting case into every bare `bun run scripts/cdp/run.ts`. That is the
    // drift this row is about, and a substring cannot see it.
    const sitting = sittingIdsIn(runner)
    const wave = idsInArray(runner, 'CASES')
    // The positive control on the same rig, now on the PARSE rather than on the
    // read: without it, "no sitting id is in `CASES`" is equally true of an array
    // this test failed to slice.
    expect(wave).toContain('AGT-1')
    expect(sitting).toContain('RS-16')
    // Both directions in ONE test on purpose (P6.1007): a pair split across two
    // tests can be satisfied by deleting a case from the runner AND from the
    // directory, and neither half would notice.
    const drives: string[] = []
    const recipesOnly: string[] = []
    for (const name of sittingFiles) {
      const id = name.replace(/\.ts$/, '').toUpperCase()
      const mod = await import(`./cases/${name}`) as { drive?: unknown }
      const isDrive = typeof mod.drive === 'function'
      ;(isDrive ? drives : recipesOnly).push(id)
      // ONE unconditional assertion per file (lint:conditional-expect): a drive is
      // in `SITTING` — reachable by name, never swept into a wave — and a recipe
      // is not; the discriminator decides the EXPECTED value, never whether the
      // expect runs.
      expect(
        sitting.includes(id),
        `${id}: ${isDrive ? 'a drive missing from' : 'a recipe leaked into'} run.ts's SITTING`,
      ).toBe(isDrive)
      // The third direction, which neither arm above covers: the DEFAULT wave.
      // A sitting id in `CASES` is run by a bare `run.ts` — for a recipe that is
      // a FAIL for never having been meant to run, and for a drive it is a turn
      // spent on a card the wave did not choose.
      expect(
        wave.includes(id),
        `${id}: a sitting case leaked into run.ts's CASES — a bare wave would run it`,
      ).toBe(false)
    }
    // And the controls for THOSE loops: a run in which nothing was classified
    // either way would assert nothing at all. Both floors are readings with a
    // date — 30 drives and 7 recipe-ONLY files on 2026-09-12 once `rs-38` landed
    // (29/7 after `rs-36` and `rs-37`, 26/8 after `rs-35` and after `rs-33`, and
    // after `rs-25` and then `rs-17` each grew a drive: 24/8, 23/9 and 22/10
    // earlier the same day, 21/10 on 2026-09-11 after `rs-32`) — derived by
    // `grep -l 'export async function drive' scripts/cdp/cases/rs-*.ts | wc -l`
    // and the file count minus it. NOTE the recipe-only floor can go DOWN when a
    // recipe grows a drive, which is not a deletion: it is the same file moving
    // between the two arms of this very test, and the file-count floor above is
    // what catches a real disappearance.
    expect(drives.length).toBeGreaterThanOrEqual(30)
    expect(recipesOnly.length).toBeGreaterThanOrEqual(7)
  })

  /**
   * DA2.18 - and the OTHER direction: an id the runner offers by name with no
   * case file behind it.
   *
   * Everything above enumerates the DIRECTORY, so every property it states is a
   * property of a file that exists. `run.ts`'s `SITTING` array is the runner's
   * own by-name list, and an id written into it for a file that was never added
   * (or was renamed, as `rs-39.ts` was in `10c10c142`) is invisible to all of
   * them: `runOne` spawns `bun run scripts/cdp/cases/<id>.ts`, the spawn fails,
   * and the sitting reports `(case produced no result line)` - a FAIL that reads
   * like the product, on a case that does not exist.
   *
   * It is also what makes the checklist guard above TOTAL rather than partial.
   * That guard globs the directory, so it can only see an id that has a file;
   * the row's second clause - an id in `SITTING` the checklist assigns to a
   * different row - needs no second loop once every `SITTING` id is known to
   * have one, and needed this test before, because such an id escaped both.
   *
   * The ids are parsed out of the ARRAY rather than substring-matched over the
   * file, and the comments inside it are stripped, because neither shortcut is
   * safe here: `run.ts`'s docblock above `SITTING` names nine pure recipes
   * (`RS-14`, `RS-17`, `RS-21` among them) precisely to say they are NOT in the
   * list, and the comments between the entries name further ids in prose.
   */
  function idsInArray(source: string, constName: string): readonly string[] {
    const start = source.indexOf(`const ${constName} = [`)
    if (start < 0) return []
    const block = source
      .slice(start, source.indexOf('] as const', start))
      .split('\n')
      .map(line => line.replace(/\/\/.*$/, ''))
      .join('\n')
    // The class is wider than `RS-\d+` because `CASES` is: `MCP-W1`, `SKL-P1`,
    // `Q6-LIVE`, `RUN-MARKS` and `PLATE-GUTTER` are all real ids there, and an
    // id this reader cannot see is an id the leak check above cannot refuse.
    return [...block.matchAll(/'([A-Z0-9]+-[A-Z0-9]+)'/g)].map(match => match[1] ?? '')
  }

  /** {@link idsInArray} over the runner's own by-name sitting list. */
  function sittingIdsIn(source: string): readonly string[] {
    return idsInArray(source, 'SITTING')
  }

  it('reads the runner\'s SITTING array itself, not the ids named around it', () => {
    // The boundary, against a fabricated runner rather than the real one. All
    // three ways the cheap instrument is wrong are in these five lines: a
    // substring scan picks up the `CASES` entry above, an unstripped comment
    // contributes an id the array deliberately excludes, and a slice that missed
    // the array returns nothing at all and makes the loop below vacuous.
    const fake = [
      "const CASES = ['RS-99'] as const",
      '// `RS-97` is a pure recipe and is NOT in the list below',
      'const SITTING = [',
      "  'RS-02', 'RS-16',",
      '  // RS-98 is named here in prose only',
      "  'RS-45',",
      '] as const',
    ].join('\n')
    expect(sittingIdsIn(fake)).toEqual(['RS-02', 'RS-16', 'RS-45'])
    expect(sittingIdsIn('no such array here')).toEqual([])
    // D1.113 — the same reader over the OTHER array, on the same fabricated
    // runner: the wave list must come back as itself and not as the sitting's
    // ids, or the leak check reads one array twice and refuses nothing.
    expect(idsInArray(fake, 'CASES')).toEqual(['RS-99'])
    expect(idsInArray(fake, 'NO_SUCH')).toEqual([])
  })

  it('offers no sitting id by name without a case file behind it', async () => {
    const runner = await Bun.file(new URL('./run.ts', import.meta.url).pathname).text()
    const offered = sittingIdsIn(runner)
    // The anti-vacuum control on the real read: membership rather than a count,
    // because a floor on a list every sitting grows is a number the next lane's
    // commit moves. `RS-16` has been in `SITTING` since the list was written.
    expect(offered).toContain('RS-16')

    const onDisk = new Set(sittingFiles.map(name => name.replace(/\.ts$/, '').toUpperCase()))
    for (const id of offered) {
      expect(
        onDisk.has(id),
        `${id}: named in run.ts's SITTING with no scripts/cdp/cases/${id.toLowerCase()}.ts behind it`,
      ).toBe(true)
    }
  })

  /**
   * P6.1014 — the recipe properties are read THROUGH `lib/sitting.ts`, not off a
   * bag of strings.
   *
   * The enforcement that matters is the compiler's: every `rs-*.ts` now ends its
   * `manual` block with `satisfies SittingRecipe`, so a case that forgets its
   * detector or its control fails `tsc` in the file that forgot it, naming the
   * key. What is left for a run-time test is the half `satisfies` cannot do —
   * a file that never opted in (the glob above catches it), and a key that is
   * present but EMPTY, which the type cannot see.
   */
  it('holds every recipe to a detector and a positive control, through the shared type', async () => {
    let recipes = 0
    for (const name of sittingFiles) {
      const mod = await import(`./cases/${name}`) as { manual?: SittingRecipe }
      const manual = mod.manual
      if (manual === undefined) continue
      recipes += 1
      expect(manual.steps.length).toBeGreaterThan(2)
      expect(manual.expected.length).toBeGreaterThan(20)
      expect(manual.detector.length).toBeGreaterThan(20)
      expect(manual.doneMeans.length).toBeGreaterThan(10)
      // `positiveControlOf` is the ONE reader of the field, one spelling since P6.1027.
      expect(positiveControlOf(manual).length).toBeGreaterThan(20)
    }
    // SIX of the sitting files drive and carry no recipe (`rs-05`, `rs-09`,
    // `rs-11`, `rs-12` and, since the rig day, `rs-34` and `rs-35`), so the floor is the
    // rest — 31 on 2026-09-12 once `rs-38` landed with both halves (30 after
    // `rs-36` and `rs-37`, 28 when `rs-34` added a drive and no recipe, where
    // `rs-33` earlier the same day added both).
    // Without it a `manual` export that vanished
    // would empty this loop silently. Derive it, never read it:
    // `grep -l 'export const manual' scripts/cdp/cases/rs-*.ts | wc -l`.
    expect(recipes).toBeGreaterThanOrEqual(31)
  })

  it('spells every declared runtime in the family vocabulary, and binds every declaring file to it — P6.1058', () => {
    // The compiler is the primary guard: `readonly SittingRuntime[]` refuses
    // `claude-runtime` in any file that says `satisfies CaseMeta`. What it cannot
    // see is a file that never opted in — `cru-7.ts` carried the whole meta block
    // unbound for a month — so this reads the SOURCE of every case file, wave and
    // sitting alike, and the vocabulary it checks against is `SITTING_RUNTIMES`
    // itself rather than three names retyped here. That is the row's whole point:
    // until P6.1058 this file's neighbour carried a PROSE list of which cases had
    // been aligned, and the list went stale the moment a case was added.
    const declaring = readdirSync(CASE_DIR)
      .filter(name => name.endsWith('.ts'))
      .sort()
      .map(name => ({ name, source: readFileSync(join(CASE_DIR, name), 'utf8') }))
      .map(file => ({ ...file, literal: /^\s*runtimes:\s*\[([^\]]*)\]/m.exec(file.source)?.[1] }))
      .filter((file): file is typeof file & { literal: string } => file.literal !== undefined)

    // The anti-vacuum control: every globbed sitting file declares one, so a
    // regex that matched nothing — or a directory read that returned nothing —
    // cannot pass this block silently.
    expect(declaring.length).toBeGreaterThanOrEqual(sittingFiles.length)

    for (const file of declaring) {
      const spelled = file.literal.split(',').map(entry => entry.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
      expect(spelled.length, `${file.name}: an empty runtimes list`).toBeGreaterThan(0)
      for (const value of spelled) {
        expect(SITTING_RUNTIMES as readonly string[], `${file.name}: "${value}" is not a runtime FAMILY`).toContain(value)
      }
      // And the file binds itself to the type, so the COMPILER catches the next
      // one first and this test is the backstop rather than the only reader.
      //
      // The CODE form, never the bare phrase. Measured while writing this test:
      // a mutant that deleted `cru-7.ts`'s clause left that file's docblock
      // SENTENCE about the clause behind, and a `toContain('satisfies
      // CaseMeta')` arm scored the mutant green — AGENTS.md §Traps' stale-NAME
      // guard, passing on the very commit that removes the name.
      expect(
        /^\}\s*as const satisfies CaseMeta$/m.test(file.source),
        `${file.name}: declares runtimes without binding its meta — \`} as const satisfies CaseMeta\``,
      ).toBe(true)
    }

    // The boundary, against the two spellings that were really in this tree until
    // `03318461c`: a vocabulary that accepted them would make the loop vacuous.
    expect(SITTING_RUNTIMES as readonly string[]).not.toContain('claude-runtime')
    expect(SITTING_RUNTIMES as readonly string[]).not.toContain('host')
  })

  it('reads a positive control under the one spelling, and no case still carries the other — P6.1027', () => {
    // The boundary for `positiveControlOf`, against a fabricated recipe. Until
    // 2026-09-10 the two wave-10 lanes named the same field `control` and
    // `positiveControl` and this case proved both were read; the sixteen bodies
    // were renamed, so what it proves now is the single reader still reads.
    const body = {
      steps: ['a step'],
      expected: 'what the run must produce',
      detector: 'the source the feature itself writes',
      doneMeans: 'what the row may be marked',
    } as const
    expect(positiveControlOf({ ...body, positiveControl: 'the one spelling' })).toBe('the one spelling')

    // And the rename asserted over the directory rather than trusted. The type
    // already refuses a stray `control` — measured 2026-09-10 against a probe
    // carrying BOTH keys: `TS2353: Object literal may only specify known
    // properties, and 'control' does not exist in type 'SittingRecipe'` — but
    // only in a file that opted into `satisfies`, and `bun test` runs no `tsc`.
    // Every recipe file opts in today; the four that do not (`rs-05`, `rs-09`,
    // `rs-11`, `rs-12`) carry no recipe at all. The day one of those grows one,
    // this is the reader that still sees the old spelling.
    //
    // **Scoped to the `manual` BLOCK, and that is a repair rather than a
    // loosening.** The file-wide scan fired on `rs-55.ts`, whose `run.observe`
    // records a `control:` key in an ordinary object literal inside `drive()` —
    // a correct case, reported as a stray recipe field. A guard that cries wolf
    // is a guard people stop running (AGENTS.md), and the thing it exists to
    // catch is a RECIPE field: `positiveControlOf` reads `manual`, so a `control`
    // anywhere else is not the defect. The slice is the recipe's own two
    // delimiters, which is what `satisfies SittingRecipe` binds.
    const recipeBlock = (source: string): string => {
      const start = source.indexOf('export const manual = {')
      if (start < 0) return ''
      const end = source.indexOf('} as const satisfies SittingRecipe', start)
      return end < 0 ? source.slice(start) : source.slice(start, end)
    }
    // The boundary, on a fabricated source, so the narrowing has both arms and
    // cannot silently stop matching the thing it is for.
    const fakeStray = [
      'export const manual = {',
      '  steps: [],',
      '  control: "the OLD spelling",',
      '} as const satisfies SittingRecipe',
      'function drive() { run.observe("x", { control: "an ordinary key" }) }',
    ].join('\n')
    expect(/^\s*control:/m.test(recipeBlock(fakeStray))).toBe(true)
    expect(/^\s*control:/m.test(recipeBlock(fakeStray.split('\n').slice(4).join('\n')))).toBe(false)

    const strays = sittingFiles
      .filter(name => /^\s*control:/m.test(recipeBlock(readFileSync(join(CASE_DIR, name), 'utf-8'))))
    expect(strays).toEqual([])
  })
})

/**
 * The bare-session-command detector, against both outcomes it has to separate.
 *
 * A detector nobody tested is this repo's most expensive recurring mistake — the
 * 2026-08-08 compaction run burned through three of them, each of which reported
 * a product defect that was not there. These two cases are the synthetic
 * equivalent of the shapes `.pi-sessions/*.jsonl` can hold: the command ran at
 * the seam (a compaction entry, no new user message) versus the command leaked
 * to the model decorated (a user entry carrying both the command and a
 * model-only context marker).
 */
describe('bare session-command evidence', () => {
  const KEY = { workspaceId: 'ws-probe', sessionId: 'sess-probe' }

  function sidecarRoot(lines: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), 'cdp-sidecar-'))
    const dir = join(root, 'sessions', KEY.workspaceId, KEY.sessionId, '.pi-sessions')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'probe.jsonl'), `${lines.map(line => JSON.stringify(line)).join('\n')}\n`, 'utf8')
    return root
  }

  const header = { type: 'session', id: 'h1', timestamp: '', cwd: '/tmp' }
  const firstTurn = { type: 'message', id: 'm1', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }

  it('reads the runtime sidecar and reports its absence rather than an empty pass', () => {
    const missing = readPiSessionLog(KEY, mkdtempSync(join(tmpdir(), 'cdp-sidecar-none-')))
    expect(missing.entries).toEqual([])
    expect(missing.reason).toContain('no-pi-sidecar')

    const present = readPiSessionLog(KEY, sidecarRoot([header, firstTurn]))
    expect(present.sidecarCount).toBe(1)
    expect(present.entries.map(e => e.type)).toEqual(['session', 'message'])
    expect(present.entries[1]?.role).toBe('user')
    expect(present.entries[1]?.text).toContain('hello')
  })

  it('scores a command that ran at the seam as bare', () => {
    const before = readPiSessionLog(KEY, sidecarRoot([header, firstTurn]))
    const after = readPiSessionLog(KEY, sidecarRoot([
      header,
      firstTurn,
      { type: 'compaction', id: 'c1', parentId: 'm1', summary: 'a summary of the work', tokensBefore: 42_000 },
    ]))
    const evidence = bareCommandEvidence(before, after, '/compact')
    expect(evidence.compactions).toBe(1)
    expect(evidence.addedUserMessages).toEqual([])
    expect(evidence.echoedCommand).toEqual([])
    expect(evidence.leakedContext).toEqual([])
  })

  it('catches a command that reached the model decorated', () => {
    const before = readPiSessionLog(KEY, sidecarRoot([header, firstTurn]))
    const after = readPiSessionLog(KEY, sidecarRoot([
      header,
      firstTurn,
      {
        type: 'message',
        id: 'm2',
        parentId: 'm1',
        message: { role: 'user', content: [{ type: 'text', text: '<available_skills>x</available_skills>\n/compact' }] },
      },
    ]))
    const evidence = bareCommandEvidence(before, after, '/compact')
    expect(evidence.compactions).toBe(0)
    expect(evidence.addedUserMessages.map(e => e.raw.id)).toEqual(['m2'])
    expect(evidence.echoedCommand.map(e => e.raw.id)).toEqual(['m2'])
    expect(evidence.leakedContext.map(l => l.marker)).toEqual(['<available_skills>'])
  })
})

/**
 * The effort ordering AGT-5 stands on.
 *
 * AGT-5 asserts a subagent ran ABOVE its parent, and the reported level is the
 * CLAMPED one (`core/types/pi-harness-runtime.ts`: "the clamped value is what
 * ships"). So the comparison has to be a rank on the six-level list, and the two
 * ways it can be wrong both look like a product finding: a level the list does
 * not know silently ranking as `-1` — which would make ANY reported level beat
 * it — and the list drifting out of the order `thinking-levels.ts` declares.
 */
describe('the effort ordering', () => {
  it('ranks the six levels in the order thinking-levels.ts declares', () => {
    expect([...EFFORT_LEVELS]).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(effortRank('high')).toBeGreaterThan(effortRank('low'))
    expect(effortRank('max')).toBeGreaterThan(effortRank('xhigh'))
    expect(effortRank('off')).toBe(0)
  })

  it('refuses an unknown level rather than ranking it', () => {
    // `-1` is BELOW `off`, so an unknown level can never win a `>` comparison
    // by accident. `undefined` is the shape a host predating the wire field
    // sends, and AGT-5 blocks on it rather than comparing.
    expect(effortRank('turbo')).toBe(-1)
    expect(effortRank(undefined)).toBe(-1)
    expect(effortRank('high') > effortRank(undefined)).toBe(true)
    expect(effortRank('turbo') > effortRank('off')).toBe(false)
  })
})

/**
 * D1.265 — an unreadable snapshot and a session that spawned nothing are
 * different findings, and `piRuntime()` used to answer both with
 * `{ children: [] }`.
 *
 * The fourth measure sitting reported *"no new child registered for cdp-deep"*
 * over a turn whose own transcript carried the child's answer: on that packaged
 * build `getPiHarnessRuntime` throws after the session's first turn, the helper
 * caught it, and every case downstream read the empty list as the product's
 * answer. `readFailed` is set only by that catch, so the guard here is exact —
 * and the NEGATIVE case is the one that matters, because a guard that also
 * fired on `available: false` would block every spawn case on its own baseline
 * read, which is legitimately unavailable before the first turn.
 */
describe('requireReadablePiRuntime', () => {
  const runtime = (over: Partial<PiRuntime>): PiRuntime =>
    ({ available: false, children: [], pendingPermissions: [], raw: {}, ...over })

  it('blocks a read that threw, and the block names the reason and the claim', () => {
    let message = ''
    try {
      requireReadablePiRuntime(
        runtime({ readFailed: true, unavailableReason: 'read-threw: pi-harness-runtime-invalid' }),
        'a new cdp-deep child',
      )
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause)
    }
    expect(message).toContain('a new cdp-deep child')
    expect(message).toContain('pi-harness-runtime-invalid')
    // The sentence has to say which of the two facts it is, or the next reader
    // repeats the misreading it exists to prevent.
    expect(message).toContain('could not be READ')
  })

  it('the injected read SETS the flag on its catch branch', () => {
    // The two cases above construct the object, so they cannot see the one place
    // `readFailed` is produced: a string of JavaScript evaluated in the renderer,
    // reachable from no unit test. This is that line, read from source and
    // bounded to the catch branch's own return — with the neighbouring reason
    // string as the positive control that the read found the right line.
    const source = readFileSync(join(import.meta.dir, 'lib', 'state.ts'), 'utf8')
    const catchReturn = source.split('\n').filter(line => line.includes("'read-threw: '"))
    expect(catchReturn).toHaveLength(1)
    expect(catchReturn[0]).toContain('readFailed: true')
    expect(catchReturn[0]).toContain('children: []')
  })

  it('passes an UNAVAILABLE runtime through — that is the ordinary pre-turn read', () => {
    const before = runtime({ unavailableReason: 'pi-runtime-not-started' })
    expect(requireReadablePiRuntime(before, 'the fork baseline')).toBe(before)
    // …and an available session that genuinely spawned nothing is still the
    // case's own FAIL to report, never a block.
    const empty = runtime({ available: true })
    expect(requireReadablePiRuntime(empty, 'a new child').children).toEqual([])
  })
})

/**
 * D1.287 — the SAME swallowed read tells a second lie, and it is the one that
 * manufactures a product finding.
 *
 * `piRuntime()`'s catch returns `pendingPermissions: []` beside `children: []`.
 * Three cases read that list to decide whether the product ASKED — and on
 * `rts-10` the subject check is `afterSwitch.pending > 0`, whose failure
 * sentence is *"an always-allow given on Pi is being honoured on a runtime the
 * user never authorised"*. An unreadable snapshot produces that sentence with
 * no product involved. `rts-5` fails the other way: its control arm would BLOCK
 * saying *"the instrument does not work on this build"*, naming the permission
 * gate for a failure of the read.
 *
 * So the block sentence is per CLAIM, not per helper: *"no card is unanswered"*
 * and *"no child registered"* send a reader to different code.
 */
describe('piPendingPermissions', () => {
  const runtime = (over: Partial<PiRuntime>): PiRuntime =>
    ({ available: false, children: [], pendingPermissions: [], raw: {}, ...over })

  /** A session whose `call` answers with a snapshot, so the real helper runs. */
  const sessionAnswering = (value: PiRuntime): CdpSession =>
    ({ call: async () => value }) as unknown as CdpSession

  const KEY = { workspaceId: 'w', sessionId: 's' }

  it('blocks a failed read with the CARD sentence, and never the child one', async () => {
    let message = ''
    try {
      await piPendingPermissions(
        sessionAnswering(runtime({
          readFailed: true,
          unavailableReason: 'read-threw: pi-harness-runtime-invalid',
        })),
        KEY,
        'whether the tool call raised a permission card',
      )
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause)
    }
    expect(message).toContain('whether the tool call raised a permission card')
    expect(message).toContain('pi-harness-runtime-invalid')
    expect(message).toContain('could not be READ')
    expect(message).toContain('pending-permission list')
    // The negative is the point of the `claim` argument: the child sentence is
    // spelled in this module (the default branch, asserted below), so its
    // absence here is a real reading and not a needle the corpus cannot spell.
    expect(message).not.toContain('spawning nothing')
  })

  it('the DEFAULT claim is still the child sentence — the D1.265 call sites pass two arguments', () => {
    let message = ''
    try {
      requireReadablePiRuntime(
        runtime({ readFailed: true, unavailableReason: 'read-threw: pi-harness-runtime-invalid' }),
        'a new cdp-deep child',
      )
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause)
    }
    expect(message).toContain('spawning nothing')
    expect(message).not.toContain('pending-permission list')
  })

  it('a READABLE snapshot with no pending request passes through — that answer is the case\'s own', async () => {
    const quiet = runtime({ available: true })
    expect(await piPendingPermissions(sessionAnswering(quiet), KEY, 'a card after the switch')).toEqual([])
    const asking = runtime({ available: true, pendingPermissions: [{ requestId: 'r-1', type: 'tool' }] })
    expect(await piPendingPermissions(sessionAnswering(asking), KEY, 'a card after the switch'))
      .toEqual([{ requestId: 'r-1', type: 'tool' }])
  })

  it('every WAIT predicate that reads the pending count also reads `readFailed`', () => {
    // The three converted call sites drive a live app and are reachable from no
    // unit test. What a unit test CAN see is the shape that made them wrong: a
    // predicate resolving on a count alone cannot tell a drained card from an
    // unreadable snapshot, and each of these waits is wrapped in a `.catch()`
    // that would swallow a `BlockedError` raised inside the probe — which is
    // why the guard sits outside the wait and the predicate must see the flag.
    const predicates = ['cases/rts-10.ts', 'cases/rts-5.ts'].flatMap(relative =>
      readFileSync(join(import.meta.dir, relative), 'utf8')
        .split('\n')
        .filter(line => line.includes('pendingPermissions.length') && line.includes('=>'))
        .map(line => ({ relative, line })))
    // Non-vacuity first: two in `rts-10` (the call watcher and the drain), one
    // in `rts-5`'s gate probe. A rename that emptied this list would otherwise
    // satisfy the assertion below by finding nothing.
    expect(predicates).toHaveLength(3)
    for (const { relative, line } of predicates) {
      expect(`${relative}: ${line.trim()}`).toContain('readFailed')
    }
  })
})

/**
 * D1.347 — the approver's zero has three causes, and it reported one number for
 * all three.
 *
 * SIT-5f lost three drives of RS-86 to exactly that: on the packaged 1.40.0 a
 * plugin COMMAND hook's permission card sat on screen with a visible, clickable
 * `Allow once` while every session read `awaitingApprovalCount: 0`, so the
 * approver never clicked and the turn wedged for 180 s and then 300 s — and the
 * helper's report, the number 0, is byte-identical to the report for a turn that
 * asked nothing. The control that settles it is a hand click at the same moment,
 * which ran the hook within seconds.
 *
 * These cases drive the REAL loop over a fake `CdpSession` — the two page reads
 * it makes are distinguishable by their own expressions — because the loop is
 * where the three causes are separated and a test of the record alone would pin
 * a shape nothing produces.
 */
describe('approvePermissionsWhile — the blind read (D1.347)', () => {
  /**
   * A session that answers the COUNT read one way and the BUTTON read another.
   *
   * `count` is what the `getSessions()` expression resolves to (or a thrower);
   * `button` is what `findCardButton`'s page body resolves to. `send` records
   * every dispatched input, which is how "it did not click" is a reading rather
   * than an absence of evidence.
   */
  const fakeSession = (count: () => unknown, button: CardButtonHit | null) => {
    const sent: string[] = []
    const session = {
      call: async (expression: string) => {
        if (expression.includes('awaitingApprovalCount')) return count()
        return button
      },
      // `clickAt` reads the viewport through `evaluate` before it dispatches, and
      // a point outside it is refused — so a fake that answers nothing here makes
      // every click a swallowed no-op and the control arm below unfalsifiable.
      evaluate: async () => ({ width: 1440, height: 900 }),
      send: async (method: string) => { sent.push(method) },
    }
    return { session: session as never, sent }
  }

  const HIT: CardButtonHit = {
    x: 100, y: 200, text: 'Allow once', index: 0, labels: ['Allow once', 'Deny'], matched: true,
  }

  /** Poll fast: the interval is the only thing that makes this a unit test. */
  const drive = async (count: () => unknown, button: CardButtonHit | null) => {
    const { session, sent } = fakeSession(count, button)
    const approver = approvePermissionsWhile(session, 's-1', { intervalMs: 2 })
    await Bun.sleep(40)
    const approved = await approver.stop()
    return { approved, reads: approver.reads, sent }
  }

  it('reports BLIND when the count reads 0 with the Allow button on screen', async () => {
    const { approved, reads, sent } = await drive(() => 0, HIT)

    // The count of approvals is still zero — and that is the point: the zero is
    // now accompanied by a reading that says which zero it is.
    expect(approved).toBe(0)
    expect(reads.blind).toBeGreaterThan(0)
    expect(reads.blindLabels).toEqual(['Allow once'])
    // It did NOT click. Answering a card the count cannot see would change what
    // ten live cases do; RS-86's `answerHookCardsWhile` is the count-independent
    // approver, and counting the card was D1.346's, host-side (`3725e0fbb`).
    expect(sent).toEqual([])
    // The count WAS readable throughout, so this is not a failed read wearing a
    // blindness's name.
    expect(reads.counted).toBe(reads.polls)
    expect(reads.readFailed).toBe(0)
    expect(reads.sessionUnseen).toBe(0)
  })

  it('CONTROL — a quiet screen is not blind, which is what keeps the reading honest', async () => {
    // The same zero count, the same loop, and NO visible Allow button. Without
    // this arm "blind" would be indistinguishable from "polled at all", and the
    // instrument would cry wolf on every idle turn.
    const { approved, reads } = await drive(() => 0, null)

    expect(approved).toBe(0)
    expect(reads.blind).toBe(0)
    expect(reads.blindLabels).toEqual([])
    expect(reads.counted).toBeGreaterThan(0)
    expect(approverBlindnessNote(reads)).toBeUndefined()
  })

  it('separates a count that THREW and a session the list does not carry', async () => {
    const threw = await drive(() => { throw new Error('Runtime.evaluate failed') }, HIT)
    expect(threw.reads.readFailed).toBeGreaterThan(0)
    expect(threw.reads.counted).toBe(0)
    // Unknown is not zero, so a failed read does not get charged as a blindness
    // it never measured.
    expect(threw.reads.blind).toBe(0)

    // The session is simply not in `getSessions()` — a wrong key, or a session
    // that has gone. The page body answers `null` for it, never 0.
    const unseen = await drive(() => null, HIT)
    expect(unseen.reads.sessionUnseen).toBeGreaterThan(0)
    expect(unseen.reads.readFailed).toBe(0)
    expect(unseen.reads.counted).toBe(0)
  })

  it('still approves a card the count DOES see — the loop is unchanged where it can see', async () => {
    const { approved, reads, sent } = await drive(() => 1, HIT)

    expect(approved).toBeGreaterThan(0)
    expect(reads.approved).toBe(approved)
    expect(reads.blind).toBe(0)
    // A real mouse click, which is the property the helper has always had: three
    // dispatched input events per approval, never an in-page `.click()`.
    expect(sent).toContain('Input.dispatchMouseEvent')
  })

  it('the note names the card class and the count, and says nothing when there is nothing to say', () => {
    const reads = (over: Partial<PermissionApproverReads>): PermissionApproverReads => ({
      polls: 10, counted: 10, readFailed: 0, sessionUnseen: 0, blind: 0, blindLabels: [], approved: 0, ...over,
    })

    const blind = approverBlindnessNote(reads({ blind: 4, blindLabels: ['Allow once'] })) ?? ''
    expect(blind).toContain('VISIBLE Allow')
    expect(blind).toContain('Allow once')
    expect(blind).toContain('BLIND, not idle')
    expect(blind).toContain('BLIND, not idle')
    expect(blind).toContain('D1.346 repaired that one host-side')

    const unread = approverBlindnessNote(reads({ counted: 6, readFailed: 3, sessionUnseen: 1 })) ?? ''
    expect(unread).toContain('unknown, not zero')
    expect(unread).toContain('3 threw')
    expect(unread).toContain('1 found no such session')
    // The two are separate sentences, so a run carrying both cannot be read as
    // one cause.
    expect(unread).not.toContain('VISIBLE Allow')

    // The silence arm. A helper that always says something teaches its reader to
    // skip the line, which is the whole failure this row is repairing.
    expect(approverBlindnessNote(reads({}))).toBeUndefined()
    expect(approverBlindnessNote(reads({ approved: 3 }))).toBeUndefined()
  })

  /**
   * D1.356 — the three clauses of the block, and the two shapes that must NOT
   * block. The narrowing in clause 3 is the one worth a test of its own: it is
   * the difference between an instrument and a guard people route around, and a
   * later reader tightening it would turn every transient throw into a discarded
   * run with nothing recording that the loosening was deliberate.
   */
  it('blocks a claim on a zero the approver could not take, and only then', () => {
    const reads = (over: Partial<PermissionApproverReads>): PermissionApproverReads => ({
      polls: 10, counted: 10, readFailed: 0, sessionUnseen: 0, blind: 0, blindLabels: [], approved: 0, ...over,
    })

    // 1. no reading at all — the positive control is the thing at zero.
    const never = approverClaimBlockReason(reads({ polls: 4, counted: 0, readFailed: 4 })) ?? ''
    expect(never).toContain('never read the permission count ONCE')
    expect(never).toContain('own positive control')
    // A run whose turn was shorter than one poll interval reads the same way,
    // and the sentence says so rather than leaving the operator to find out.
    expect(approverClaimBlockReason(reads({ polls: 0, counted: 0 })) ?? '').toContain('shorter than one poll interval')

    // 2. blind, and it blocks EVEN WITH approvals recorded — the wedge is about
    //    the card nobody counted, not about the ones that worked.
    const blind = approverClaimBlockReason(reads({ blind: 2, blindLabels: ['Allow once'], approved: 3 })) ?? ''
    expect(blind).toContain('VISIBLE Allow')
    expect(blind).toContain('BLOCKED rather than banked (D1.356)')

    // 3. unreadable polls block ONLY while the case has no positive reading.
    expect(approverClaimBlockReason(reads({ counted: 6, readFailed: 4, approved: 0 })) ?? '')
      .toContain('unknown, not zero')
    expect(approverClaimBlockReason(reads({ counted: 6, sessionUnseen: 4, approved: 0 })) ?? '')
      .toContain('found no such session')
    expect(approverClaimBlockReason(reads({ counted: 6, readFailed: 4, approved: 2 }))).toBeUndefined()

    // The silence arms: a clean run, and a clean run that approved cards.
    expect(approverClaimBlockReason(reads({}))).toBeUndefined()
    expect(approverClaimBlockReason(reads({ approved: 3 }))).toBeUndefined()
  })
})

/**
 * D1.310 — the five OBSERVE-ONLY readers, where the risk is not a wrong block
 * but a narrative reading an empty list as an answer.
 *
 * D1.265 converted the nine sites whose CHECK depends on the snapshot and
 * deliberately left these, because a block raised for an observation discards
 * the run. What they were missing is smaller: on the packaged 1.39.0 each of
 * them would have recorded `[]` for a session that had children, and nothing in
 * the recorded value said the read had thrown.
 */
describe('piReadNote', () => {
  const runtime = (over: Partial<PiRuntime>): PiRuntime =>
    ({ available: false, children: [], pendingPermissions: [], raw: {}, ...over })

  it('separates a read that THREW from the ordinary pre-turn unavailable read', () => {
    // The positive: only the catch's own flag reads as a failed read.
    expect(piReadNote(runtime({ readFailed: true, unavailableReason: 'read-threw: pi-harness-runtime-invalid' })))
      .toEqual({ readFailed: true, available: false, unavailableReason: 'read-threw: pi-harness-runtime-invalid' })
    // The negative, and it is the one that matters: `available: false` with
    // `pi-runtime-not-started` is the legitimate answer before a session's first
    // turn AND between turns, and collapsing it into `readFailed` would label
    // every baseline read an instrument failure.
    expect(piReadNote(runtime({ unavailableReason: 'pi-runtime-not-started' })))
      .toEqual({ readFailed: false, available: false, unavailableReason: 'pi-runtime-not-started' })
    // A live, readable snapshot that genuinely spawned nothing: the case's own
    // answer, and the note says so.
    expect(piReadNote(runtime({ available: true }))).toEqual({ readFailed: false, available: true })
  })

  it('every observe-only `piRuntime()` reader records the read verdict', () => {
    // The five files D1.310 names, read from source because each drives a live
    // app and is reachable from no unit test. The guard is per FILE rather than
    // per line: what makes an observation honest is that the note reaches the
    // recorded value, and the call sites spell that differently (a spread, a
    // field, a reason sentence).
    const observers = ['agt-4', 'q6-live', 'pkg-1', 'mcp-auth', 'agt-3']
    const readings = observers.map(name => {
      const source = readFileSync(join(import.meta.dir, 'cases', `${name}.ts`), 'utf8')
      // Non-vacuity, per file and in the same reading: a file that stopped
      // calling `piRuntime` would otherwise satisfy this by having nothing to
      // guard, which is the exact shape of a guard that quietly stops guarding.
      const calls = source.split('\n').filter(line => line.includes('piRuntime(session, key)')).length
      const notes = source.split('\n').filter(line => line.includes('piReadNote(')).length
      return `${name}: ${calls} piRuntime call(s), ${notes} read-verdict site(s)`
    })
    for (const reading of readings) {
      expect(reading).not.toContain('0 piRuntime call(s)')
      expect(reading).not.toContain('0 read-verdict site(s)')
    }
    // And the control that this instrument can report a zero at all: a file that
    // reads the runtime through the GUARDED helpers instead has no note, by
    // design, and the same census says so.
    const guarded = readFileSync(join(import.meta.dir, 'cases', 'agt-1.ts'), 'utf8')
    expect(`agt-1: ${guarded.split('\n').filter(line => line.includes('piReadNote(')).length} read-verdict site(s)`)
      .toContain('0 read-verdict site(s)')
  })
})

/**
 * D1.266 — a row whose clause is "on a packaged build" asks about an ARTEFACT.
 *
 * Two rows in the fourth measure sitting asked for behaviour built later in the
 * same wave than the commit that build came from, and each would have produced a
 * confident false finding. These cases drive the pair of instruments that caught
 * it — a literal scan with a sibling control, and the commit ancestry — over a
 * fake app root, because the shape being tested is the VERDICT, not the bundle.
 */
describe('readArtifactMarker', () => {
  const MARKER = 'nessy-d1266-marker-under-test'
  const CONTROL = 'nessy-d1266-sibling-control'

  function fakeApp(files: Record<string, string>): AppUnderTest {
    const root = mkdtempSync(join(tmpdir(), 'cdp-artifact-'))
    for (const [relative, body] of Object.entries(files)) {
      const path = join(root, relative)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, body)
    }
    return { kind: 'packaged', appRoot: root, scanRoots: [root], via: 'test', targetUrl: 'file:///test' }
  }

  it('finds a marker in a RENDERER asset, which the two named bundles do not cover', () => {
    // The walk is the point: `bundleFiles` names `main.cjs` and the Pi bundle,
    // and a UI marker lands in neither.
    const app = fakeApp({
      'dist/main.cjs': `console.log(${JSON.stringify(CONTROL)})`,
      'dist/renderer/assets/index-abc123.js': `t(${JSON.stringify(MARKER)})`,
    })
    const reading = readArtifactMarker(app, { marker: MARKER, control: CONTROL })
    expect(reading.verdict).toBe('carries')
    expect(reading.markerHits).toBe(1)
    expect(reading.controlHits).toBe(1)
    expect(reading.filesScanned).toBe(2)
  })

  it('a missing CONTROL is never reported as a build without the behaviour', () => {
    // The failure this control exists for: an app root that is wrong, renamed or
    // empty answers 0 for everything, and 0 is the same number as a real
    // absence.
    const app = fakeApp({ 'dist/main.cjs': 'nothing of interest here' })
    const reading = readArtifactMarker(app, { marker: MARKER, control: CONTROL })
    expect(reading.verdict).toBe('control-failed')
    expect(reading.detail).toContain('read the wrong tree')
    expect(reading.detail).not.toContain('NULL BY ARTEFACT')
  })

  it('reports NULL BY ARTEFACT with the ancestry clause when the control is there', () => {
    const app = fakeApp({ 'dist/main.cjs': `console.log(${JSON.stringify(CONTROL)})` })
    const reading = readArtifactMarker(app, {
      marker: MARKER,
      control: CONTROL,
      // HEAD cannot be an ancestor of its own parent, so this is the "built
      // later than the artefact" shape the row was born from, with no fixture
      // commit invented.
      implementedBy: 'HEAD',
      artifactCommit: 'HEAD~1',
    })
    expect(reading.verdict).toBe('null-by-artefact')
    expect(reading.markerHits).toBe(0)
    expect(reading.implementedByIsAncestor).toBe(false)
    expect(reading.detail).toContain('NULL BY ARTEFACT')
    expect(reading.detail).toContain('NOT an ancestor')
  })

  it('refuses a marker that is present in a build predating its own commit', () => {
    // The false POSITIVE, which costs exactly as much as the false negative: a
    // marker that was already in the tree proves nothing about the behaviour.
    const app = fakeApp({ 'dist/main.cjs': `${CONTROL} ${MARKER}` })
    const reading = readArtifactMarker(app, {
      marker: MARKER, control: CONTROL, implementedBy: 'HEAD', artifactCommit: 'HEAD~1',
    })
    expect(reading.verdict).toBe('marker-not-discriminating')
    expect(reading.detail).toContain('PREDATES')
  })

  it('D1.308 — ANCESTRY ALONE nulls a row whose fix ships no literal, and says the scan was not run', () => {
    // The app root is POPULATED, and the control for "the scan was not run" is
    // the same app read the other way in the same test: a scan query answers
    // `filesScanned: 2`, an ancestry-only query answers 0. Without that pair,
    // "not scanned" and "scanned and found nothing" are the same zero — the
    // very confusion the control half of this module exists to prevent.
    const app = fakeApp({
      'dist/main.cjs': `console.log(${JSON.stringify(CONTROL)})`,
      'dist/renderer/assets/index-abc123.js': `t(${JSON.stringify(MARKER)})`,
    })
    const scanned = readArtifactMarker(app, { marker: MARKER, control: CONTROL })
    expect(scanned.scanRun).toBe(true)
    expect(scanned.filesScanned).toBe(2)

    // HEAD cannot be an ancestor of its own parent: the "built later than the
    // artefact" shape, with no fixture commit invented.
    const reading = readArtifactMarker(app, { implementedBy: 'HEAD', artifactCommit: 'HEAD~1' })
    expect(reading.verdict).toBe('null-by-artefact')
    expect(reading.scanRun).toBe(false)
    expect(reading.filesScanned).toBe(0)
    expect(reading.marker).toBeUndefined()
    expect(reading.markerHits).toBeUndefined()
    expect(reading.implementedByIsAncestor).toBe(false)
    expect(reading.detail).toContain('THE SCAN WAS NOT RUN')
    expect(reading.detail).toContain('NOT an ancestor')
  })

  it('D1.308 — the same query answers `carries` when the artefact descends from the fix', () => {
    const app = fakeApp({ 'dist/main.cjs': 'nothing of interest here' })
    const reading = readArtifactMarker(app, { implementedBy: 'HEAD~1', artifactCommit: 'HEAD' })
    expect(reading.verdict).toBe('carries')
    expect(reading.implementedByIsAncestor).toBe(true)
    expect(reading.detail).toContain('THE SCAN WAS NOT RUN')
    // A build whose dist carries NEITHER string answers `carries` here, which is
    // the whole point: the scan would have said `control-failed` about a fix
    // that ships nothing to scan for.
    expect(reading.detail).not.toContain('read the wrong tree')
  })

  it('D1.308 — a sha git cannot resolve is `ancestry-unknown`, never an absence', () => {
    // The boundary: with the scan half gone, an unanswerable ancestry leaves NO
    // instrument, and calling that `null-by-artefact` would let a typo block a
    // row that could have been driven. `control-failed` is equally wrong — its
    // sentence is about a scan that read the wrong tree, and no scan ran.
    const app = fakeApp({ 'dist/main.cjs': 'nothing of interest here' })
    const reading = readArtifactMarker(app, {
      implementedBy: '0000000000000000000000000000000000000000',
      artifactCommit: 'HEAD',
    })
    expect(reading.verdict).toBe('ancestry-unknown')
    expect(reading.implementedByIsAncestor).toBeUndefined()
    expect(reading.detail).toContain('NEITHER INSTRUMENT ANSWERED')
    expect(reading.detail).not.toContain('NULL BY ARTEFACT')
  })

  it('reads the artefact commit from the environment when the caller has none', () => {
    const app = fakeApp({ 'dist/main.cjs': `${CONTROL} ${MARKER}` })
    const had = process.env[ARTIFACT_COMMIT_ENV]
    delete process.env[ARTIFACT_COMMIT_ENV]
    process.env[ARTIFACT_COMMIT_ENV] = 'HEAD'
    try {
      const reading = readArtifactMarker(app, { marker: MARKER, control: CONTROL, implementedBy: 'HEAD~1' })
      expect(reading.artifactCommit).toBe('HEAD')
      expect(reading.implementedByIsAncestor).toBe(true)
      expect(reading.verdict).toBe('carries')
    } finally {
      // `delete` FIRST on the restore path too (AGENTS.md): an assignment leaves
      // the name readable by property and invisible to a spread, and every
      // subprocess env in this tree is built by spreading `process.env`.
      delete process.env[ARTIFACT_COMMIT_ENV]
      if (had !== undefined) process.env[ARTIFACT_COMMIT_ENV] = had
    }
  })
})

// ============================================================================
// UB12.2 — freshSession is immune to a persisted label filter
// (b33203609: a board click's live task-label include hides every unlabelled
// row, so a freshly created session's row never becomes selectable and the
// helper falls back to a contaminated session). The live write+reload wiring
// is driven at the sitting; the transform is pure and pinned here.
// ============================================================================
describe('clearLabelFiltersInViewFilters (UB12.2)', () => {
  it('positive: a live label include is dropped and named, statuses and projects kept', () => {
    const map = {
      allSessions: { statuses: { needs_review: 'include' }, labels: { 'live-task-label': 'include' }, groupingMode: 'date' },
      board: { labels: { other: 'exclude' } },
      untouched: { statuses: { active: 'include' } },
    }
    const cleared = clearLabelFiltersInViewFilters(map)!
    expect(cleared.touched).toEqual(['allSessions', 'board'])
    expect(cleared.map.allSessions).toEqual({ statuses: { needs_review: 'include' }, labels: {}, groupingMode: 'date' })
    expect(cleared.map.board).toEqual({ labels: {} })
    expect(cleared.map.untouched).toEqual({ statuses: { active: 'include' } })
  })

  it('negative control: no label filters anywhere means undefined — no write, no reload', () => {
    expect(clearLabelFiltersInViewFilters({
      allSessions: { statuses: { needs_review: 'include' } },
      empty: { labels: {} },
    })).toBeUndefined()
    expect(clearLabelFiltersInViewFilters({})).toBeUndefined()
  })
})

describe('isAncestor', () => {
  it('answers both directions on this repo', () => {
    expect(isAncestor('HEAD~1', 'HEAD')).toBe(true)
    expect(isAncestor('HEAD', 'HEAD~1')).toBe(false)
  })

  it('answers UNDEFINED for a commit git does not know, never `false`', () => {
    // The distinction the helper exists to keep: a typo that read as "not an
    // ancestor" would turn into a NULL verdict and stop a case that could have
    // run.
    expect(isAncestor('0000000000000000000000000000000000000000', 'HEAD')).toBeUndefined()
  })
})

/**
 * D1.288 — a registered marker that no longer exists is the failure this whole
 * module is built to prevent, one level up.
 *
 * `readArtifactMarker` answers `null-by-artefact` for a string the build does
 * not carry, and a marker RENAMED in the tree produces exactly that answer on
 * every build forever — a permanent BLOCK on the row it was written for, worn as
 * a fact about the artefact. The rule this guards is the brief's own: *a marker
 * you cannot find at HEAD in the built product's source is a finding, not a
 * guess.* So each registered marker and control is asserted PRESENT in this
 * repo's own tracked source, and each implementing commit is asserted to
 * resolve — a bad sha answers `undefined` from `isAncestor`, which is deliberate
 * and silent there, and this is where it is caught instead.
 */
describe('ROW_ARTEFACT_MARKERS', () => {
  /** Tracked files carrying `needle`. `-a` and never `-I`: they cancel (AGENTS.md). */
  function filesCarrying(needle: string): number {
    const result = Bun.spawnSync(['git', 'grep', '-la', '--', needle, '--', 'packages', 'apps'], {
      cwd: join(import.meta.dir, '..', '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = result.stdout.toString().trim()
    return out === '' ? 0 : out.split('\n').length
  }

  it('the instrument can read the PRODUCT source — a needle that must be there, and one that cannot', () => {
    // The positive control for the assertions below: without it, "0 files" and
    // "the grep ran in the wrong directory" are the same number, which is the
    // very confusion `readArtifactMarker`'s own control exists to prevent. It
    // earned its place immediately: the first needle here was
    // `requireArtifactCarries`, which answers 0 over this corpus because it
    // lives in `scripts/` — a control the corpus cannot spell, AGENTS.md's trap
    // in its positive direction. A marker is a string the PRODUCT ships, so the
    // corpus is `packages` + `apps` and the control has to come from there.
    expect(filesCarrying('getPiHarnessRuntime')).toBeGreaterThan(0)
    expect(filesCarrying('zzz-no-such-needle-in-this-tree-zzz')).toBe(0)
  })

  it('every registered marker and control is still in the source, and every commit resolves', () => {
    const rows = Object.entries(ROW_ARTEFACT_MARKERS)
    expect(rows.length).toBeGreaterThan(0)
    for (const [row, query] of rows) {
      // An ANCESTRY-ONLY entry (D1.308) has no strings to find, and the reading
      // says so rather than the assertion being skipped: a conditional expect
      // would delete itself the day an entry loses its marker, which is the
      // opposite of what this guard is for.
      expect(query.marker === undefined
        ? `${row}: ancestry-only, no marker to find`
        : `${row}: marker \`${query.marker}\` in ${filesCarrying(query.marker)} file(s)`)
        .not.toContain('in 0 file(s)')
      expect(query.control === undefined
        ? `${row}: ancestry-only, no control to find`
        : `${row}: control \`${query.control}\` in ${filesCarrying(query.control)} file(s)`)
        .not.toContain('in 0 file(s)')
      // A marker and its control that are the same string cannot fail together
      // in different directions — the control would then prove nothing. The
      // fallbacks differ so an ancestry-only entry (both `undefined`) passes on
      // its own shape rather than on two absent strings being equal.
      expect(query.control ?? 'no-control').not.toBe(query.marker ?? 'no-marker')
      // Asserted UNCONDITIONALLY, and the `implementedBy` requirement is the
      // point rather than an accident of these two entries: a registered triple
      // without a commit has only the scan half, and the ancestry half is what
      // separates "the build does not carry it" from "it could not have".
      expect(typeof query.implementedBy).toBe('string')
      expect(isAncestor(String(query.implementedBy), 'HEAD')).toBe(true)
    }
  })
})

/**
 * The config-dir fixture, against the two rules it promises.
 *
 * It writes into a directory that may be the operator's own, so "it never
 * clobbers" and "markers are stable across a re-seed" are not style points: a
 * re-seed mid-wave that re-mints the token a running case is hunting for turns
 * a green run red for no reason, and a `hooks.json` written rather than merged
 * eats the operator's hooks.
 */
describe('the agent-surfaces fixture', () => {
  function scratch(): string {
    return mkdtempSync(join(tmpdir(), 'cdp-surfaces-'))
  }

  it('writes every artifact the blocked rows name', async () => {
    const dir = scratch()
    const report = await seedAgentSurfaces({ configDir: dir })
    expect(report.configDir).toBe(dir)
    for (const path of [
      join(dir, 'agents', `${FIXTURE_NAMES.deepAgent}.md`),
      join(dir, 'agents', `${FIXTURE_NAMES.shallowAgent}.md`),
      join(dir, 'agents', `${FIXTURE_NAMES.skilledAgent}.md`),
      join(dir, 'agents', `${FIXTURE_NAMES.plainAgent}.md`),
      join(dir, 'agents', `${FIXTURE_NAMES.roleAgent}.md`),
      join(dir, 'agents', `${FIXTURE_NAMES.deniedAgent}.md`),
      join(dir, 'skills', FIXTURE_NAMES.skill, 'SKILL.md'),
      join(dir, 'output-styles', `${FIXTURE_NAMES.outputStyle}.md`),
      join(dir, 'MEMORY.md'),
      join(dir, 'hooks.json'),
    ]) {
      expect(existsSync(path)).toBe(true)
    }
    // The one that carries the row's whole claim: the marker exists ONLY in the
    // skill body, so it must not leak into the agent that declares the skill.
    const skill = readFileSync(join(dir, 'skills', FIXTURE_NAMES.skill, 'SKILL.md'), 'utf8')
    const agent = readFileSync(join(dir, 'agents', `${FIXTURE_NAMES.skilledAgent}.md`), 'utf8')
    expect(skill).toContain(report.markers.skill)
    expect(agent).not.toContain(report.markers.skill)
    // CDX-ROLES: the codeword is in the BODY, never the description — the
    // description is the only part the parent model sees.
    const role = readFileSync(join(dir, 'agents', `${FIXTURE_NAMES.roleAgent}.md`), 'utf8')
    const description = /^description:.*$/m.exec(role)?.[0] ?? ''
    expect(role).toContain(report.markers.zephyr)
    expect(description).not.toContain(report.markers.zephyr)
    expect(report.markers.zephyr).toMatch(/^ZEPHYR-[0-9a-f]{8}$/)
    // And probe-role must declare NO grant: each of tools/disallowedTools/
    // permissionMode makes the codex role builder deny it by design, which is
    // what probe-denied is for.
    expect(role).not.toMatch(/^(tools|disallowedTools|permissionMode):/m)
    expect(readFileSync(join(dir, 'agents', `${FIXTURE_NAMES.deniedAgent}.md`), 'utf8')).toMatch(/^tools:/m)
    // AGT-5 half 2 is only measurable on an agent that declares NO effort.
    expect(readFileSync(join(dir, 'agents', `${FIXTURE_NAMES.deepAgent}.md`), 'utf8')).toMatch(/^effort: high$/m)
    expect(readFileSync(join(dir, 'agents', `${FIXTURE_NAMES.shallowAgent}.md`), 'utf8')).not.toMatch(/^effort:/m)
  })

  it('merges into an existing hooks.json instead of replacing it', async () => {
    const dir = scratch()
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ actions: [{ type: 'command', command: 'echo OPERATOR-OWN' }] }],
        PreToolUse: [{ matcher: 'Bash', actions: [{ type: 'command', command: 'echo OPERATOR-PRETOOL' }] }],
      },
    }), 'utf8')
    const report = await seedAgentSurfaces({ configDir: dir })
    const merged = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8')) as {
      hooks: Record<string, { matcher?: string; actions: { command: string }[] }[]>
    }
    expect(merged.hooks.PreToolUse).toHaveLength(1)
    expect(merged.hooks.UserPromptSubmit?.map(m => m.actions[0]!.command).join('|')).toContain('OPERATOR-OWN')
    expect(merged.hooks.UserPromptSubmit?.map(m => m.actions[0]!.command).join('|')).toContain(report.markers.promptHook)
    expect(merged.hooks.SessionStart?.[0]?.matcher).toBe('compact')

    // RS-30's hook (P6.1057): the payload is parsed rather than string-matched,
    // because the whole of what makes it readable is its SHAPE —
    // `hooks.md#annotate-a-result-for-the-auto-mode-classifier` puts
    // `classifierContext` under `hookSpecificOutput` and nowhere else, and
    // `hook-command.ts` reads it nested-only. A command that spells the marker
    // at the top level would pass a `toContain` and be read by nobody.
    const postToolUse = merged.hooks.PostToolUse ?? []
    expect(postToolUse).toHaveLength(1)
    // No matcher: every tool call is annotated, which is what RS-30's framing
    // count needs — and why its recipe tells the operator to remove the hook.
    expect(postToolUse[0]?.matcher).toBeUndefined()
    const command = postToolUse[0]!.actions[0]!.command
    const payload = JSON.parse(/'(\{.*\})'/.exec(command)?.[1] ?? '{}') as {
      hookSpecificOutput?: { hookEventName?: string; classifierContext?: string }
      classifierContext?: string
    }
    expect(payload.hookSpecificOutput?.hookEventName).toBe('PostToolUse')
    expect(payload.hookSpecificOutput?.classifierContext).toBe(report.markers.classifierHook)
    expect(payload.classifierContext).toBeUndefined()
  })

  it('keeps its markers across a re-seed, and appends to MEMORY.md once', async () => {
    const dir = scratch()
    writeFileSync(join(dir, 'MEMORY.md'), '# operator memory\n\n- a line nobody may lose\n', 'utf8')
    const first = await seedAgentSurfaces({ configDir: dir })
    const second = await seedAgentSurfaces({ configDir: dir })
    // A re-seed mid-wave must not invalidate a case that is hunting the token.
    expect(second.markers).toEqual(first.markers)
    const memory = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
    expect(memory).toContain('a line nobody may lose')
    expect(memory.split(first.markers.memory)).toHaveLength(2)
    // Two seeds must not stack two prompt hooks onto one turn — AGT-6 part 3
    // COUNTS occurrences, so a duplicate would read as the b9abd1e6 defect.
    const hooks = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8')) as {
      hooks: Record<string, unknown[]>
    }
    expect(hooks.hooks.UserPromptSubmit).toHaveLength(1)
    expect(hooks.hooks.SessionStart).toHaveLength(1)
    expect(hooks.hooks.PostToolUse).toHaveLength(1)
    // `--fresh` is the only way to re-mint.
    const refreshed = await seedAgentSurfaces({ configDir: dir, fresh: true })
    expect(refreshed.markers.skill).not.toBe(first.markers.skill)
  })

  it('keeps the markers a marker file DOES carry when the fixture grows a new one', async () => {
    // The boundary for the merge in `readMarkers`, and the shape every operator
    // disk was in the day `classifierHook` was added (P6.1057): a
    // `cdp-markers.json` written by an older fixture. All-or-nothing would
    // re-mint the whole set and invalidate the token a running AGT-6 is hunting
    // for, which is rule 2 of that file breaking on an upgrade.
    const dir = scratch()
    const seeded = await seedAgentSurfaces({ configDir: dir })
    const older = JSON.parse(readFileSync(join(dir, 'cdp-markers.json'), 'utf8')) as Record<string, string>
    delete older.classifierHook
    writeFileSync(join(dir, 'cdp-markers.json'), JSON.stringify(older), 'utf8')

    const after = await seedAgentSurfaces({ configDir: dir })
    expect(after.markers.promptHook).toBe(seeded.markers.promptHook)
    expect(after.markers.skill).toBe(seeded.markers.skill)
    expect(after.markers.zephyr).toBe(seeded.markers.zephyr)
    // The missing one is minted, in its own shape, and reaches the hook.
    expect(after.markers.classifierHook).toMatch(/^CDP-CLASSIFIER-[0-9A-F]{10}$/)
    const hooks = JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8')) as {
      hooks: Record<string, { actions: { command: string }[] }[]>
    }
    // And the re-seed replaced the stale CDP hook rather than stacking a second.
    expect(hooks.hooks.PostToolUse).toHaveLength(1)
    expect(hooks.hooks.PostToolUse![0]!.actions[0]!.command).toContain(after.markers.classifierHook)
  })

  it('writes the managed policy only when asked, and in the shape the cache reads', async () => {
    const dir = scratch()
    const without = await seedAgentSurfaces({ configDir: dir })
    expect(without.managedPolicy).toBeUndefined()
    expect(existsSync(join(dir, 'managed-delivery.json'))).toBe(false)

    const withPolicy = await seedAgentSurfaces({ configDir: dir, managedModels: ['only/allowed-model'] })
    const cache = JSON.parse(readFileSync(join(dir, 'managed-delivery.json'), 'utf8')) as {
      schemaVersion: number
      fetchedAt: number
      payload: { availableModels: string[] }
    }
    expect(withPolicy.managedPolicy?.allowed).toEqual(['only/allowed-model'])
    expect(cache.schemaVersion).toBe(1)
    expect(typeof cache.fetchedAt).toBe('number')
    // `availableModels`-ONLY is what makes this route need no approval:
    // `classifyManagedApproval` raises items for sandbox, allow-rule and env
    // categories, and none of those may ride along.
    expect(Object.keys(cache.payload)).toEqual(['availableModels'])
  })

  it('writes the suggestion allowlist into the same delivered document when asked (F1.66)', async () => {
    const dir = scratch()
    // Negative: the shipped default — no option, no key. The pin rides in the
    // same document as every other managed key, so the caller opt-in is the
    // only thing that may add it.
    const without = await seedAgentSurfaces({ configDir: dir })
    expect(without.managedPolicy).toBeUndefined()

    const withSuggestions = await seedAgentSurfaces({ configDir: dir, managedPluginSuggestions: ['acme-tools'] })
    const cache = JSON.parse(readFileSync(join(dir, 'managed-delivery.json'), 'utf8')) as {
      payload: { pluginSuggestionMarketplaces?: string[] }
    }
    expect(cache.payload.pluginSuggestionMarketplaces).toEqual(['acme-tools'])
    expect(withSuggestions.managedPolicy?.keys).toEqual(['pluginSuggestionMarketplaces'])
  })

  it('never falls back to the operator config dir by accident', () => {
    const previous = process.env.NESSY_CONFIG_DIR
    try {
      delete process.env.NESSY_CONFIG_DIR
      // The default is a scratch dir of its own, NOT ~/.nessy-agent. A fixture
      // that writes the live config dir because a variable happened to be unset
      // is the failure the no-clobber rule exists to prevent.
      expect(targetConfigDir()).toContain('nessy-cdp-agents')
      expect(targetConfigDir()).not.toMatch(/\.nessy-agent$/)
      process.env.NESSY_CONFIG_DIR = '/tmp/some-fixture-dir'
      expect(targetConfigDir()).toBe('/tmp/some-fixture-dir')
      // An explicit path always wins, which is the only way to target a live dir.
      expect(targetConfigDir('/tmp/explicit')).toBe('/tmp/explicit')
    } finally {
      if (previous === undefined) delete process.env.NESSY_CONFIG_DIR
      else process.env.NESSY_CONFIG_DIR = previous
    }
  })
})

/**
 * The per-command ceiling, which is the difference between measuring the product
 * and measuring the box it runs on.
 *
 * `Runtime.evaluate` is answered by the RENDERER, so a poll issued while a turn
 * is streaming waits behind the renderer's own work. The 1.36.0 release sitting
 * met load averages of 20 to 52 and lost four cases to
 * `cdp-timeout: Runtime.evaluate did not answer in 30000ms`, each AFTER its own
 * checks had passed — a host reading filed as a case verdict. The knob raises
 * that ceiling for one run and leaves the default alone, so the number is always
 * visible in the narrative rather than silently different.
 *
 * The boundary case is the one worth a test: a knob that accepts `0`, `-1` or
 * `abc` by falling back to the default is a knob an operator can set and believe
 * in while it does nothing — which is worse than no knob, because it makes the
 * next timeout unexplainable.
 */
describe('the CDP per-command ceiling', () => {
  const withEnv = <T>(value: string | undefined, body: () => T): T => {
    const had = 'NESSY_CDP_TIMEOUT_MS' in process.env
    const previous = process.env.NESSY_CDP_TIMEOUT_MS
    delete process.env.NESSY_CDP_TIMEOUT_MS
    if (value !== undefined) process.env.NESSY_CDP_TIMEOUT_MS = value
    try { return body() } finally {
      delete process.env.NESSY_CDP_TIMEOUT_MS
      if (had && previous !== undefined) process.env.NESSY_CDP_TIMEOUT_MS = previous
    }
  }

  it('defaults to 30 s, and an explicit argument still wins over the environment', () => {
    expect(withEnv(undefined, () => resolveTimeoutMs())).toBe(30_000)
    expect(withEnv('120000', () => resolveTimeoutMs())).toBe(120_000)
    expect(withEnv('120000', () => resolveTimeoutMs(5_000))).toBe(5_000)
  })

  it('REFUSES a value that would read as set and behave as unset', () => {
    for (const bad of ['0', '-1', 'abc', 'Infinity']) {
      expect(() => withEnv(bad, () => resolveTimeoutMs())).toThrow(/cdp-bad-timeout/)
    }
    expect(withEnv('   ', () => resolveTimeoutMs())).toBe(30_000)
  })
})

/**
 * F1.120 / D1.395 — the window the harness measures on.
 *
 * FOUR sittings carried `Emulation.setFocusEmulationEnabled` and
 * `Page.setWebLifecycleState` by hand (SIT-7's P-SIT7-3, SIT-8's P-SIT8-2,
 * SIT-9's P-SIT9-3, SIT-10's P-SIT10-8) because `attach()` left the window
 * hidden and unfocused. Driven here against a fake page rather than asserted
 * over source text: the defect is a pair of CALLS that were never made, and a
 * source pin would be satisfied by a module that spells them in a comment.
 */
describe('the window the harness measures on', () => {
  /**
   * A page that answers the read-back, and records what was sent to it.
   *
   * `focusEmulation` is the field `attach` stores `ConnectOptions.focus` in, so
   * the opt-out arm below drives the real decision rather than a mock of it.
   */
  const fakeWindow = (answer: () => unknown, focusEmulation = true) => {
    const sent: { method: string; params: Record<string, unknown> }[] = []
    const session = {
      focusEmulation,
      lastFocus: undefined as unknown,
      send: async (method: string, params: Record<string, unknown>) => {
        sent.push({ method, params })
        if (method === 'Emulation.setFocusEmulationEnabled' && answer() === 'send-throws') {
          throw new Error("cdp-error: Emulation.setFocusEmulationEnabled → {\"message\":\"'Emulation' wasn't found\"}")
        }
        return {}
      },
      call: async () => answer(),
    }
    return { session: session as never as CdpSession, sent }
  }

  const VISIBLE = { hasFocus: true, visibilityState: 'visible' }
  /** What a DETACHED window answers — SIT-7's own reading, the defect's shape. */
  const DETACHED = { hasFocus: false, visibilityState: 'hidden' }

  it('sends both calls, in the measured order, and answers with the PAGE\'s reading', async () => {
    const { session, sent } = fakeWindow(() => VISIBLE)
    const state = await focusWindow(session)

    expect(sent.map(entry => entry.method)).toEqual([
      'Emulation.setFocusEmulationEnabled',
      'Page.setWebLifecycleState',
    ])
    expect(sent[0]!.params).toEqual({ enabled: true })
    expect(sent[1]!.params).toEqual({ state: 'active' })
    expect(state).toEqual(VISIBLE)
  })

  it('CONTROL — it reports a window that stayed hidden, rather than manufacturing the state it asked for', async () => {
    // Without this arm, a helper that returned its own REQUEST would be
    // indistinguishable from one that reads the page: both answer "visible" on
    // the arm above. This is the read-back discipline `applyCasePermissionMode`
    // applies to the mode it writes.
    const { session, sent } = fakeWindow(() => DETACHED)
    expect(await focusWindow(session)).toEqual(DETACHED)
    expect(sent.length).toBe(2)
  })

  it('an attachment that opted out sends NOTHING, and says so by answering undefined', async () => {
    const { session, sent } = fakeWindow(() => VISIBLE, false)
    expect(await reassertWindowFocus(session)).toBeUndefined()
    expect(sent).toEqual([])
    expect(session.lastFocus).toBeUndefined()
  })

  it('records the reading on the session for a case to report', async () => {
    const { session } = fakeWindow(() => VISIBLE)
    const state = await reassertWindowFocus(session)
    expect(state).toEqual(VISIBLE)
    expect(session.lastFocus).toEqual(VISIBLE)
    // No `failed` key on a reading that worked — the failure field is the one
    // thing a caller branches on, so an unconditional one would be worse than
    // none at all.
    expect(Object.keys(session.lastFocus ?? {})).not.toContain('failed')
  })

  it('never turns a rig whose Chromium refuses the call into a failed attach', async () => {
    // The quiet form catches, because it runs for EVERY case at attach and
    // `freshSession()`: a rig without the Emulation domain would otherwise lose
    // every case before its first read. The reason is carried, not swallowed.
    const { session, sent } = fakeWindow(() => 'send-throws')
    const state = await reassertWindowFocus(session)
    expect(state?.failed).toContain("'Emulation' wasn't found")
    expect(state?.hasFocus).toBe(false)
    expect(session.lastFocus?.failed).toBe(state?.failed)
    // It still TRIED, which is what separates a refused call from an opt-out.
    expect(sent.map(entry => entry.method)).toEqual(['Emulation.setFocusEmulationEnabled'])

    // And the LOUD form propagates, because a case calling it by name is a case
    // whose surface depends on it.
    const direct = fakeWindow(() => 'send-throws')
    expect(focusWindow(direct.session)).rejects.toThrow(/Emulation/)
  })

  it('is applied by attach and re-asserted by freshSession on BOTH paths, so no case carries it', () => {
    const connect = readFileSync(new URL('./lib/connect.ts', import.meta.url).pathname, 'utf8')
    const state = readFileSync(new URL('./lib/state.ts', import.meta.url).pathname, 'utf8')

    // Inside `CdpSession.attach` itself, not in the free function beside it: the
    // static is what `runCase` reaches through, and a case that builds a session
    // another way would otherwise be silently unfocused.
    const start = connect.indexOf('  static async attach(')
    expect(start).toBeGreaterThan(0)
    const region = connect.slice(start, connect.indexOf('\n  }', start))
    expect(region).toContain('await reassertWindowFocus(session)')
    // The boundary control names a declaration BELOW the region (AGENTS.md,
    // WI-s): a needle whose every occurrence sits ABOVE the anchor can never be
    // inside the slice, so it passes on the very runaway it exists to catch.
    expect(region).not.toContain('private onMessage(')

    // BOTH returns of `freshSession` — the fresh one and the fallback — for the
    // same reason `applyCasePermissionMode` is on both.
    expect((state.match(/await reassertWindowFocus\(session\)/g) ?? []).length).toBeGreaterThanOrEqual(2)

    // And the cases no longer carry the two calls themselves. The positive
    // control is on the same instrument: the module DOES spell them.
    const caseDir = new URL('./cases/', import.meta.url).pathname
    const carried = readdirSync(caseDir)
      .filter(name => name.endsWith('.ts'))
      .filter(name => /await session\.send\('Emulation\.setFocusEmulationEnabled'/.test(readFileSync(join(caseDir, name), 'utf8')))
    expect(carried).toEqual([])
    expect(connect).toContain("await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })")
  })
})

/**
 * F1.121 / SIT-9's P-SIT9-4 — binding a working directory, and PROVING it took.
 *
 * `setWorkingDirectory` fires and returns while the session's own
 * `workingDirectory` fills in later, and SIT-9 measured the session still bound
 * to a PREVIOUS repository in 2 of 3 drives: every settings read then pointed at
 * a directory nobody wrote and every `settingsUnchanged` control passed
 * vacuously. Driven against a fake page and one REAL temp directory, because
 * three of the five properties below are about what the helper does with an
 * answer it did not expect, which no source pin can see.
 */
describe('bindWorkingDirectory', () => {
  type Mutation = 'ok' | 'throws-timeout' | 'throws-busy' | 'never-resolves'

  /**
   * A page that answers `getSessions()` from a script, and records the order.
   *
   * The two expressions are told apart by their own text, which is what the
   * helper really sends: the mutation names `updateWorkingDirectory` and the
   * read names `getSessions`.
   */
  const fakeBinder = (readings: string[], mutation: Mutation = 'ok') => {
    const calls: string[] = []
    let read = 0
    const session = {
      call: async (expression: string) => {
        if (expression.includes('updateWorkingDirectory')) {
          calls.push('mutate')
          if (mutation === 'throws-timeout') throw new Error('Request timeout: sessions:command (30000ms)')
          if (mutation === 'throws-busy') throw new Error('CodedError: session-project-mutation-busy')
          if (mutation === 'never-resolves') return new Promise(() => { /* the untrusted-directory modal */ })
          return null
        }
        calls.push('read')
        const value = readings[Math.min(read, readings.length - 1)] ?? ''
        read += 1
        return value
      },
    }
    return { session: session as never as CdpSession, calls }
  }

  /** Fast, because nothing here waits on a real app. */
  const FAST = { timeoutMs: 60, intervalMs: 5 }

  it('polls until the session itself names the directory, and says how it got there', async () => {
    const { session, calls } = fakeBinder(['', '', '/tmp/wanted'])
    const bind = await bindWorkingDirectory(session, 's-1', '/tmp/wanted', FAST)

    expect(bind.bound).toBe(true)
    expect(bind.reported).toBe('/tmp/wanted')
    expect(bind.issues).toBe(1)
    expect(bind.reason).toBeUndefined()
    // A SINGLE sample answers `''` even when the bind succeeds (SIT-9 rig
    // finding 2), so the poll is the instrument and this is the arm that proves
    // one read would have reported a failure.
    expect(calls.filter(entry => entry === 'read').length).toBeGreaterThan(1)
  })

  it('THE DEFECT — a session still bound to the PREVIOUS repository is not a bind, and the reason names it', async () => {
    const { session } = fakeBinder(['/tmp/repo-a'])
    const bind = await bindWorkingDirectory(session, 's-1', '/tmp/repo-b', FAST)

    expect(bind.bound).toBe(false)
    // Both directories in the sentence: "asked for B, reports A" is the reading
    // SIT-9 had to reconstruct afterwards, and it is what tells a case its file
    // reads went somewhere else.
    expect(bind.reason).toContain('/tmp/repo-b')
    expect(bind.reason).toContain('/tmp/repo-a')
    expect(bind.reported).toBe('/tmp/repo-a')
    // It re-issued once, which is the whole of the retry policy when the command
    // said nothing.
    expect(bind.issues).toBe(2)
  })

  it('reads a REAL directory through its real path, so a /var ask and a /private/var answer agree', async () => {
    // `mkdtempSync(join(tmpdir(), …))` answers `/var/folders/…` while the app
    // reports `/private/var/folders/…` — the same directory, different strings,
    // and `rs-80.ts` paid a run for comparing them raw.
    const real = realpathSync(mkdtempSync(join(tmpdir(), 'wjj-bind-')))
    // F1.59 CI: on the Linux runner `tmpdir()` is `/tmp`, already real, so that
    // spelling equals the real path and the control below failed there. Where
    // the platform gives no second spelling, the fixture makes one — a symlink
    // to the same directory — so the arm measures the same thing everywhere;
    // on macOS the `/var` spelling is still the one asked.
    const platformSpelling = join(tmpdir(), real.split('/').pop()!)
    const asked = platformSpelling !== real
      ? platformSpelling
      : (() => {
          const link = join(realpathSync(mkdtempSync(join(tmpdir(), 'wjj-bind-link-'))), 'via-symlink')
          symlinkSync(real, link)
          return link
        })()
    // The positive control on the fixture itself: the two spellings really do
    // differ on this machine, or the arm proves nothing.
    expect(asked).not.toBe(real)
    expect(realpathSync(asked)).toBe(real)

    const { session } = fakeBinder([real])
    const bind = await bindWorkingDirectory(session, 's-1', asked, FAST)
    expect(bind.bound).toBe(true)
    expect(bind.target).toBe(real)
    // And the reading is kept VERBATIM, not normalised — a case reporting where
    // it read should print what the app said.
    expect(bind.reported).toBe(real)
  })

  it('keeps a thrown command and never trusts it as failure', async () => {
    // `sessionCommand` answers `Request timeout: sessions:command (30000ms)` on
    // a mutation that LANDED when a previous runtime is tearing down on the same
    // queue (`pkg-5.ts`), so the verdict is the read-back and the throw is
    // evidence beside it.
    const { session } = fakeBinder(['', '/tmp/wanted'], 'throws-timeout')
    const bind = await bindWorkingDirectory(session, 's-1', '/tmp/wanted', FAST)

    expect(bind.bound).toBe(true)
    expect(bind.errors.join(' ')).toContain('Request timeout')
  })

  it('never re-issues after `session-project-mutation-busy`', async () => {
    // `pkg-6.ts` measured a retry colliding with its own first call, still
    // running server-side after the RPC gave up. The control is the arm above
    // it: the same unbound outcome with a SILENT command re-issues once.
    const busy = await bindWorkingDirectory(fakeBinder(['/tmp/elsewhere'], 'throws-busy').session, 's-1', '/tmp/wanted', FAST)
    expect(busy.bound).toBe(false)
    expect(busy.issues).toBe(1)
    expect(busy.errors.join(' ')).toContain('session-project-mutation-busy')

    const silent = await bindWorkingDirectory(fakeBinder(['/tmp/elsewhere']).session, 's-1', '/tmp/wanted', FAST)
    expect(silent.issues).toBe(2)
  })

  it('does not AWAIT the mutation, so a caller can answer the trust gate beside it', async () => {
    // The deadlock `pkg-4.ts` documents: `updateWorkingDirectory` on a directory
    // the app has no trust decision for does not resolve until the modal is
    // answered. A helper that awaited it could never return here — this arm
    // hangs on the old shape and passes on this one.
    const { session, calls } = fakeBinder(['', '/tmp/wanted'], 'never-resolves')
    const bind = await bindWorkingDirectory(session, 's-1', '/tmp/wanted', FAST)

    expect(bind.bound).toBe(true)
    // The command WAS issued — the property is "not awaited", never "not sent".
    expect(calls[0]).toBe('mutate')
  })
})

/**
 * F1.182 / WJ-j's `P-WJ-j-1` — the bind a CASE writes, and the compiler gate
 * under it.
 *
 * `bindWorkingDirectory` above is the measurement; this is the three lines that
 * went around it at every call site. 41 sites over 34 case files wrote a bare
 * `setWorkingDirectory` instead and four cases wrote a LOCAL helper of the same
 * name, each re-deriving a different subset of the four properties that header
 * records — which is the same disease one layer up, and why the raw command is
 * no longer exported at all.
 */
describe('bindProject', () => {
  /**
   * A page whose mutation NEVER resolves until the trust gate has run.
   *
   * That is the real modal's behaviour (`pkg-4.ts`), and it is what makes the
   * ordering arm below able to fail: a helper that awaited the mutation could
   * never reach the gate, so the test would hang rather than pass.
   */
  const fakeProject = (target: string) => {
    const order: string[] = []
    let gated = false
    const session = {
      call: async (expression: string) => {
        if (expression.includes('updateWorkingDirectory')) {
          order.push('mutate')
          return new Promise(resolve => {
            const wait = (): void => { if (gated) resolve(null); else setTimeout(wait, 1) }
            wait()
          })
        }
        order.push('read')
        return gated ? target : ''
      },
    }
    const gate = async (): Promise<string> => { order.push('gate'); gated = true; return 'answered' }
    return { session: session as never as CdpSession, gate, order }
  }

  /** The simple page: no gate, one reading repeated — for the two miss arms. */
  const fakeBinderFor = (readings: string[]) => {
    let read = 0
    const session = {
      call: async (expression: string) => {
        if (expression.includes('updateWorkingDirectory')) return null
        const value = readings[Math.min(read, readings.length - 1)] ?? ''
        read += 1
        return value
      },
    }
    return { session: session as never as CdpSession }
  }

  const FAST = { timeoutMs: 400, intervalMs: 5 }

  it('answers the trust gate WHILE the mutation is in flight, and only then reads the verdict', async () => {
    const { session, gate, order } = fakeProject('/tmp/wanted')
    const run = new CaseRun('X', 'ordering')
    const bind = await bindProject(run, session, 's-1', '/tmp/wanted', { ...FAST, gate })

    expect(bind.bound).toBe(true)
    // The mutation is issued FIRST and the gate runs before any read succeeds —
    // the whole ordering, in one reading. A helper that awaited the mutation
    // would never reach `gate` on this page.
    expect(order[0]).toBe('mutate')
    expect(order.indexOf('gate')).toBeGreaterThan(-1)
    expect(order.indexOf('gate')).toBeLessThan(order.lastIndexOf('read'))
    // Both halves are recorded: the gate's own answer and the bind's check.
    expect(run.observations['trust gate']).toBe('answered')
    expect(run.checks.map(entry => entry.ok)).toEqual([true])
  })

  it('THE POINT — a bind that did not take STOPS the case, and the sentence names both directories', async () => {
    const { session } = fakeBinderFor(['/tmp/repo-a'])
    const run = new CaseRun('X', 'miss')
    let thrown = ''
    await bindProject(run, session, 's-1', '/tmp/repo-b', FAST).catch((cause: unknown) => {
      thrown = cause instanceof Error ? cause.message : String(cause)
    })

    // Without this, every read under the root below it passes vacuously — the
    // silent, flattering miss SIT-9 measured in 2 of 3 drives.
    expect(thrown).toContain('/tmp/repo-b')
    expect(thrown).toContain('/tmp/repo-a')
    expect(run.checks).toHaveLength(1)
    expect(run.checks[0]?.ok).toBe(false)
  })

  it('`require: false` records the same sentence and lets the case go on', async () => {
    const { session } = fakeBinderFor(['/tmp/repo-a'])
    const run = new CaseRun('X', 'soft')
    const bind = await bindProject(run, session, 's-1', '/tmp/repo-b', { ...FAST, require: false })

    expect(bind.bound).toBe(false)
    expect(run.failed).toBe(true)
    // It RETURNED — the control that separates this from the arm above, where
    // the same unbound outcome threw.
    expect(bind.reason).toContain('/tmp/repo-a')
  })

  it('the label travels onto both the observation and the check, so sibling arms can be told apart', async () => {
    const { session, gate } = fakeProject('/tmp/wanted')
    const run = new CaseRun('X', 'labels')
    await bindProject(run, session, 's-1', '/tmp/wanted', { ...FAST, gate, label: 'codex/arm B' })

    expect(Object.keys(run.observations)).toEqual(['codex/arm B: trust gate'])
    expect(run.checks[0]?.label).toContain('codex/arm B: the session is bound to')
  })

  it('no case reaches the raw command any more, and the COMPILER is what stops it', () => {
    const caseDir = new URL('./cases/', import.meta.url).pathname
    const files = readdirSync(caseDir).filter(name => name.endsWith('.ts'))
    // The CALL, never the name: three case docblocks still name the RPC in prose
    // and saying so is the point of them (the refinement F1.173 had to record
    // about `createSession`, met again here).
    const callers = files.filter(name => /[^a-zA-Z]setWorkingDirectory\(/.test(readFileSync(join(caseDir, name), 'utf8')))
    expect(callers).toEqual([])
    // The positive control on the same instrument: the probe CAN see a call of
    // this shape, because the module itself makes one.
    const module = readFileSync(new URL('./lib/runtime-switch.ts', import.meta.url).pathname, 'utf8')
    expect(/[^a-zA-Z]setWorkingDirectory\(/.test(module)).toBe(true)
    // And the real gate, which no grep can be talked out of: the command is
    // declared once and NOT exported, so a case that spells it differently still
    // does not compile.
    expect(module).toContain('\nasync function setWorkingDirectory(')
    expect(module).not.toContain('export async function setWorkingDirectory(')

    // The anti-vacuum control: cases DO bind projects, through the two exported
    // spellings. A zero here would make the assertion above true by accident.
    const binders = files.filter(name => /bindProject\(|bindWorkingDirectory\(/.test(readFileSync(join(caseDir, name), 'utf8')))
    expect(binders.length).toBeGreaterThan(30)
  })
})

/**
 * F1.173 / WJ-e's P-WJ-e-3 — the one spelling of `electronAPI.createSession`.
 *
 * `freshSession` is how a case gets a session, and two cases cannot use it:
 * `q6-live.ts` must CREATE on a connection that cannot be switched into, and
 * `rs-36.ts` must take the product's own branch. Each spelled the RPC itself, so
 * F1.86's bypass default needed two extra edits — the divergence D1.385 exists
 * to close, one layer down.
 */
describe('createSessionDirectly', () => {
  /**
   * A page that answers the three calls the helper's paths make, by their text.
   *
   * `mode` is what `getSessions()` reports the session's `permissionMode` to be;
   * `setPermissionMode` moves it, so `case-default` really drives
   * `applyCasePermissionMode` rather than a stub of it.
   */
  const fakeCreator = (id: string | null, mode = 'auto') => {
    const sent: string[] = []
    let current = mode
    const session = {
      call: async (expression: string) => {
        if (expression.includes('electronAPI.createSession(')) {
          sent.push('create')
          return id === null ? { error: 'session-create-refused' } : { id, workspaceId: 'ws-1' }
        }
        // The needle is the JSON spelling, because `sessionCommand` builds its
        // page body with `JSON.stringify(command)` — a first draft matched the
        // OBJECT-LITERAL form, never fired, and the arm spent 20 s reporting
        // `not-applied` about a helper that was working.
        if (expression.includes('setPermissionMode')) {
          sent.push('set')
          current = /"mode":"([^"]+)"/.exec(expression)?.[1] ?? current
          return null
        }
        sent.push('read')
        return [{ id, workspaceId: 'ws-1', permissionMode: current, messageCount: 0 }]
      },
    }
    return { session: session as never as CdpSession, sent, modeNow: () => current }
  }

  it("applies THIS case's mode on the `case-default` path, and reads it back", async () => {
    const { session, sent, modeNow } = fakeCreator('s-9')
    const created = await createSessionDirectly(session, 'ws-1', { name: 'n' }, 'case-default')

    expect(created.sessionId).toBe('s-9')
    expect(created.workspaceId).toBe('ws-1')
    expect(created.error).toBeUndefined()
    // The default the harness applies everywhere else, now reaching a session
    // `freshSession` never touched.
    expect(created.permissionMode).toBe(DEFAULT_CASE_PERMISSION_MODE)
    expect(modeNow()).toBe(DEFAULT_CASE_PERMISSION_MODE)
    expect(sent).toContain('set')
  })

  it('CONTROL — `from-options` applies NOTHING, and says so in the value', async () => {
    // `rs-36`'s branch inherits the parent's mode because the product's own
    // `onBranch` does and because the card is the arm's subject. Without this
    // arm the helper would be indistinguishable from one that always applies the
    // harness default — which would destroy that arm silently.
    const { session, sent, modeNow } = fakeCreator('s-9', 'default')
    const created = await createSessionDirectly(session, 'ws-1', { permissionMode: 'default' }, 'from-options')

    expect(created.sessionId).toBe('s-9')
    expect(sent).not.toContain('set')
    expect(modeNow()).toBe('default')
    // Prefixed, so a report can never read an inherited mode as an applied one.
    expect(created.permissionMode).toBe('from-options: default')
  })

  it('carries a refusal instead of a session id, and never a half-made key', async () => {
    const { session, sent } = fakeCreator(null)
    const created = await createSessionDirectly(session, 'ws-1', { name: 'n' }, 'case-default')

    expect(created.sessionId).toBeUndefined()
    expect(created.error).toContain('session-create-refused')
    // Nothing was written to a session that does not exist.
    expect(sent).toEqual(['create'])
  })

  it('is the only spelling of the RPC outside the helper', () => {
    const caseDir = new URL('./cases/', import.meta.url).pathname
    const callers = readdirSync(caseDir)
      .filter(name => name.endsWith('.ts'))
      .filter(name => readFileSync(join(caseDir, name), 'utf8').includes('electronAPI.createSession('))
    expect(callers).toEqual([])
    // The positive control on the same instrument, and the reason the needle
    // carries its open parenthesis: three case comments still NAME the RPC — the
    // branch affordance is `createSession` and saying so is the point — so a
    // needle without the parenthesis would read those as call sites.
    const state = readFileSync(new URL('./lib/state.ts', import.meta.url).pathname, 'utf8')
    expect((state.match(/electronAPI\.createSession\(/g) ?? []).length).toBe(1)
  })
})

/**
 * F1.775 (SIT-k, 2026-09-25) — `freshSession`'s fallback never changes the mode
 * of a session the case did not create.
 *
 * Under load the helper created its session, could not see it become the
 * selected row, fell back to the OPEN session and wrote `bypassPermissions` onto
 * it; a [DEFAULT] arm that fell back the same way ran silently in bypass. Driven
 * against a fake page, because the defect is what the helper WRITES, which no
 * source pin can see.
 */
describe('freshSession fallback', () => {
  const OPEN = 'open-1'
  const CREATED = 'created-1'

  /**
   * A page with one open session in `openMode`. Dispatching New Chat creates
   * `CREATED` in `creationMode`; freshSession's own wait for that row to become
   * selected FAILS, the way a `Runtime.evaluate` that took 30–120 s under the
   * sitting's load did, so the helper takes its `session-created-but-not-opened`
   * path. `selectedAtFallback` is the row `activeSession` then reads.
   */
  const fakeApp = (openMode: string, creationMode = 'auto', selectedAtFallback = OPEN) => {
    const modes = new Map<string, string>([[OPEN, openMode]])
    const writes: string[] = []
    const session = {
      focusEmulation: false,
      call: async (expression: string) => {
        if (expression.includes('nessy-agent-navigate')) {
          modes.set(CREATED, creationMode)
          return null
        }
        if (expression.includes('rows.length === 1')) throw new Error('evaluate-timeout: the selected-row read took too long')
        if (expression.includes('ambiguous-active-session')) return selectedAtFallback
        const write = /sessionCommand\("([^"]+)", \{"type":"setPermissionMode","mode":"([^"]+)"/.exec(expression)
        if (write) {
          writes.push(`${write[1]}=${write[2]}`)
          modes.set(write[1]!, write[2]!)
          return null
        }
        if (expression.includes('getSessions()')) {
          return [...modes].map(([id, mode]) => ({ id, workspaceId: 'ws-1', permissionMode: mode, messageCount: id === OPEN ? 12 : 0 }))
        }
        // UB12.2 — freshSession reads the persisted view filters first; this fake
        // runs the ordinary case (nothing persisted), so the clear is a no-op.
        if (expression.includes("localStorage.getItem('nessy-view-filters')")) return null
        throw new Error(`fake page: unexpected call ${expression.slice(0, 80)}`)
      },
    }
    return { session: session as never as CdpSession, writes, modeOf: (id: string) => modes.get(id) }
  }

  const asCase = async <T>(caseId: string, body: () => Promise<T>): Promise<T> => {
    const previous = currentCaseId()
    setCurrentCaseId(caseId)
    try {
      return await body()
    } finally {
      setCurrentCaseId(previous)
    }
  }

  it('refuses, and leaves the open session alone, when that session is not in the mode the case runs in', async () => {
    const app = fakeApp('auto')
    const outcome = await asCase('AGT-1', () => freshSession(app.session).then(() => 'resolved', (cause: unknown) => cause))

    expect(outcome).toBeInstanceOf(BlockedError)
    expect(String((outcome as Error).message)).toContain('session-created-but-not-opened')
    expect(String((outcome as Error).message)).toContain(OPEN)
    expect(app.writes).toEqual([])
    expect(app.modeOf(OPEN)).toBe('auto')
  })

  it('refuses a [DEFAULT] arm whose fallback lands on a session another case put in bypass', async () => {
    // RS-12 keeps the mode the app creates a session in (`auto` here). Before
    // F1.775 this answered `opt-out: kept bypassPermissions` and the arm drove on.
    const app = fakeApp(DEFAULT_CASE_PERMISSION_MODE, 'auto')
    expect(casePermissionModeOptOut('RS-12')).toBeDefined()
    const outcome = await asCase('RS-12', () => freshSession(app.session).then(() => 'resolved', (cause: unknown) => cause))

    expect(outcome).toBeInstanceOf(BlockedError)
    expect(String((outcome as Error).message)).toContain('"auto"')
    expect(app.writes).toEqual([])
  })

  it('CONTROL — an open session already in the case\'s mode is returned as before, contaminated and unwritten', async () => {
    const app = fakeApp(DEFAULT_CASE_PERMISSION_MODE)
    const key = await asCase('AGT-1', () => freshSession(app.session))

    expect(key.sessionId).toBe(OPEN)
    expect(key.fresh).toBe(false)
    expect(key.reason).toContain('session-created-but-not-opened')
    expect(key.inheritedMessages).toBe(12)
    expect(key.permissionMode).toBe(DEFAULT_CASE_PERMISSION_MODE)
    expect(app.writes).toEqual([])
  })

  it('CONTROL — a fallback that lands on the session it created still gets the case\'s mode written', async () => {
    // Without this arm a helper that stopped writing on EVERY fallback would
    // pass the three above, and its own session would start in `auto`.
    const app = fakeApp('auto', 'auto', CREATED)
    const key = await asCase('AGT-1', () => freshSession(app.session))

    expect(key.sessionId).toBe(CREATED)
    expect(key.fresh).toBe(false)
    expect(key.permissionMode).toBe(DEFAULT_CASE_PERMISSION_MODE)
    expect(app.writes).toEqual([`${CREATED}=${DEFAULT_CASE_PERMISSION_MODE}`])
    expect(app.modeOf(OPEN)).toBe('auto')
  })

  it('UB12.2 — a persisted live label include is dropped and the page reloaded before the create attempt', async () => {
    // The b33203609 mechanism, on the wire: the persisted All-Sessions include
    // names a live task label whose carriers a cleanup deleted. The helper must
    // write the cleared map back, reload (AppShell reads the map only in its
    // initializer), and record the touched views on the result — here on the
    // fallback path, which is the path the mechanism itself forces.
    const store = new Map<string, unknown>([[
      'nessy-view-filters',
      JSON.parse(JSON.stringify({ allSessions: { labels: { 'live-task-label': 'include' }, statuses: {} } })),
    ]])
    const reloaded: string[] = []
    const base = fakeApp(DEFAULT_CASE_PERMISSION_MODE)
    const session = {
      focusEmulation: false,
      call: async (expression: string) => {
        const get = /localStorage\.getItem\('([^']+)'\)/.exec(expression)
        if (get) {
          // localStorage answers the raw string, whatever the store holds.
          const value = store.get(get[1]!)
          return value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value)
        }
        const set = /localStorage\.setItem\('([^']+)', ("(?:[^"\\]|\\.)*")\)/.exec(expression)
        if (set) {
          // The expression embeds JSON.stringify(JSON.stringify(map)): the outer
          // parse undoes the embedding, the inner one the serialisation itself.
          store.set(set[1]!, JSON.parse(JSON.parse(set[2]!)))
          return null
        }
        // The post-reload readiness probe only (NOT every electronAPI read — the
        // state reads embed it too): after a reload the preload surface is
        // complete again, and this fake has no boot to wait for.
        if (expression.includes("typeof api[k] !== 'function'")) return []
        return (base.session as unknown as { call: (e: string) => unknown }).call(expression)
      },
      send: async (method: string) => {
        reloaded.push(method)
        return null
      },
    } as never as CdpSession

    const key = await asCase('AGT-1', () => freshSession(session))

    expect(key.fresh).toBe(false)
    expect(key.clearedLabelFilters).toBe('allSessions')
    expect(reloaded).toEqual(['Page.reload'])
    // The set branch already parsed the written value into the store.
    const stored = store.get('nessy-view-filters')! as { allSessions: { labels: Record<string, string> } }
    expect(stored.allSessions.labels).toEqual({})
  })
})

describe('result line', () => {
  it('round-trips through the prefix the wave runner parses', () => {
    const result: CaseResult = {
      case: 'AGT-1',
      title: 't',
      status: 'FAIL',
      durationMs: 5,
      checks: [{ label: 'a', ok: false, detail: 'd' }],
      observations: { children: 0 },
    }
    const line = `${RESULT_PREFIX} ${JSON.stringify(result)}`
    expect(line.startsWith(RESULT_PREFIX)).toBe(true)
    expect(JSON.parse(line.slice(RESULT_PREFIX.length))).toEqual(result)
  })

  it('maps status to a distinct exit code so BLOCKED is never mistaken for a pass', () => {
    expect(exitCodeFor('PASS')).toBe(0)
    expect(exitCodeFor('FAIL')).toBe(1)
    expect(exitCodeFor('BLOCKED')).toBe(2)
  })
})

/**
 * C3.374 — the one visible-copy card-button scan, run against a fake DOM.
 *
 * `findCardButton` needs a page, but `cardButtonScript` is a string, so the
 * SELECTION — which is the whole of what three cases had each written their own
 * way — is testable with no app at all. The fixture below is the DOM the three
 * cases met on the shipped builds: `InputContainer` renders a
 * `visibility: hidden` measuring copy FIRST and it KEEPS ITS BOX, so every
 * button appears twice and a zero-size guard never fires. RS-13 reported "the
 * card did NOT clear" on 4 of 6 arms in one run and 3 of 6 in the next against
 * exactly this shape (RV, packaged 1.37.0, 2026-09-12).
 */
describe('the card-button scan', () => {
  interface FakeButton {
    text: string
    hidden: boolean
    x: number
    y: number
  }

  /** Two copies of one card: the hidden measuring one first, with a real box. */
  function twoCopies(labels: string[]): FakeButton[] {
    return [
      ...labels.map((text, i) => ({ text, hidden: true, x: 100 + i * 80, y: 500 })),
      ...labels.map((text, i) => ({ text, hidden: false, x: 100 + i * 80, y: 640 })),
    ]
  }

  function runScript(script: string, buttons: FakeButton[]): CardButtonHit | null {
    const element = (b: FakeButton) => ({
      innerText: b.text,
      textContent: b.text,
      getClientRects: () => (b.hidden ? [{}] : [{}]),
      getBoundingClientRect: () => ({ x: b.x, y: b.y, width: 60, height: 20 }),
      __hidden: b.hidden,
    })
    const doc = { querySelectorAll: () => buttons.map(element) }
    const win = { getComputedStyle: (el: { __hidden: boolean }) => ({
      visibility: el.__hidden ? 'hidden' : 'visible', display: 'block',
    }) }
    const fn = new Function('document', 'window', script) as (d: unknown, w: unknown) => CardButtonHit | null
    return fn(doc, win)
  }

  const BANNER_LABELS = ['Allow', 'Always Allow', 'Deny', 'Add a note']

  it('matches a label among the VISIBLE copy and returns that copy\'s rect', () => {
    const hit = runScript(
      cardButtonScript({ labels: ['deny', 'reject'] }),
      twoCopies(BANNER_LABELS),
    )
    expect(hit?.text).toBe('Deny')
    expect(hit?.matched).toBe(true)
    // The hidden copy sits at y=500 and keeps its box; the visible one at y=640.
    expect(hit?.y).toBe(650)
    expect(hit?.labels).toEqual(BANNER_LABELS)
    expect(hit?.index).toBe(2)
  })

  it('answers null rather than the last button when no label matched', () => {
    // The fallback is OPT-IN because "the last button" was *Add a note* on the
    // shipped 1.36.0 — a click that answers nothing and parks the turn (R1).
    expect(runScript(cardButtonScript({ labels: ['always allow'] }), twoCopies(['Allow', 'Deny']))).toBeNull()
    const fallback = runScript(
      cardButtonScript({ labels: ['always allow'], fallbackToLastVisible: true }),
      twoCopies(['Allow', 'Deny']),
    )
    expect(fallback?.text).toBe('Deny')
    expect(fallback?.matched).toBe(false)
  })

  it('takes the LAST match when asked, and an exact label never matches a longer one', () => {
    const labels = ['Allow', 'Yes, and switch to auto mode', 'Always Allow', 'Deny']
    expect(runScript(cardButtonScript({ labels: ['allow'] }), twoCopies(labels))?.text).toBe('Allow')
    expect(runScript(cardButtonScript({ labels: ['always allow'], prefer: 'last' }), twoCopies(labels))?.text)
      .toBe('Always Allow')
    // `prefix` is the rs-38 rule: the reopen card's labels are sentences.
    expect(runScript(
      cardButtonScript({ labels: ['Resume from summary'], match: 'prefix' }),
      twoCopies(['Resume from summary (recommended)', 'Resume full session as-is']),
    )?.text).toBe('Resume from summary (recommended)')
  })
})

/**
 * C3.390 — a failure sentence printed beside `ok`.
 *
 * RS-32's log carried `ok the app left the onboarding screen — the onboarding is
 * still on screen 30 s after its last button was pressed …`: the check passed
 * and the detail is the message for the failure that did not happen, because a
 * call site computes the sentence once and passes it whatever the outcome. Both
 * arms are here because only the pair says what changed — the RESULT LINE must
 * still carry the detail either way, which is the half that makes this a
 * narrowing of the console rather than a loss of evidence.
 */
describe('a check\'s detail', () => {
  function captureCheck(ok: boolean): { printed: string[]; checks: CaseCheck[] } {
    const printed: string[] = []
    const real = console.error
    console.error = (...args: unknown[]) => { printed.push(args.map(String).join(' ')) }
    try {
      const run = new CaseRun('T-1', 'detail printing')
      run.check('the surface appeared', ok, 'the surface never appeared within 30 s')
      return { printed, checks: run.checks }
    } finally {
      console.error = real
    }
  }

  it('prints the detail when the check FAILED — it is the failure sentence', () => {
    const { printed, checks } = captureCheck(false)
    expect(printed.join('\n')).toContain('the surface never appeared within 30 s')
    expect(checks[0]?.detail).toBe('the surface never appeared within 30 s')
  })

  it('keeps the detail OUT of a passing line and IN the result line', () => {
    const { printed, checks } = captureCheck(true)
    expect(printed.join('\n')).toContain('the surface appeared')
    expect(printed.join('\n')).not.toContain('never appeared within 30 s')
    // The narrowing is the console's, not the record's: every reader of the
    // `##CDP-RESULT##` line still gets the detail on a passing check.
    expect(checks[0]?.detail).toBe('the surface never appeared within 30 s')
  })
})

/**
 * RS-13's probe repository, and the one shape that makes its codex cell a lie.
 *
 * C3.376 (born from F1's PR-F1-1, measured 2026-09-12 on the shipped
 * `codex-app-server`): `workspace-write` grants `/tmp` and `$TMPDIR` as writable
 * roots OF THEIR OWN, and codex computes its `.git` carve-out PER writable root
 * — so a probe repository nested under a temp root is writable through the tmp
 * grant and the cwd root's carve-out never reaches it. RS-13 built its probe
 * with `mkdtemp(tmpdir())`, i.e. on exactly that shape, and its codex cell
 * therefore measured the tmp grant rather than the floor; the reading reached a
 * ledger cell as `absent` once already.
 *
 * `305a8999d` made the parent a knob and left the DEFAULT under `$TMPDIR`. The
 * default is the other way round now, because a BARE run is what a driver does.
 * These three arms are the guard on that: a default that silently flipped back
 * under a temp root would be invisible to every other gate in this tree — the
 * case would still pass, measuring the wrong thing, which is the failure this
 * row exists to end. The classifier's OTHER arm is exercised too, so the pin
 * proves the probe can still say `nesting` rather than only ever saying `floor`.
 */
describe("RS-13's probe repository", () => {
  it('defaults OUTSIDE every temp root, so a bare run measures the floor', () => {
    const root = join(probeRepositoryParent(undefined), 'nessy-rs13-repo-abc123')
    expect(probeRepositoryShape(root, tempWritableRoots())).toBe('floor')
  })

  // BOTH spellings, because they are not the same string on this platform:
  // `$TMPDIR` is `/var/folders/…` and its realpath is `/private/var/folders/…`.
  // The un-realpathed one is what an operator types; the realpathed one is what
  // the case's own `realpathSync(mkdtempSync(…))` produces. The first draft of
  // `tempWritableRoots` carried only the realpathed spelling and scored the
  // operator's own `$TMPDIR` as the FLOOR arm — a confident wrong reading in the
  // one direction that matters, caught here 2026-09-12.
  it('still reaches the NESTING arm when the operator points it at $TMPDIR', () => {
    for (const parent of [tmpdir(), realpathSync(tmpdir())]) {
      const root = join(probeRepositoryParent(parent), 'nessy-rs13-repo-abc123')
      expect(probeRepositoryShape(root, tempWritableRoots())).toBe('nesting')
    }
  })

  it('does not read a path that merely SHARES a prefix as being under the root', () => {
    expect(probeRepositoryShape('/tmpfoo/repo', ['/tmp'])).toBe('floor')
    expect(probeRepositoryShape('/tmp/repo', ['/tmp'])).toBe('nesting')
    expect(probeRepositoryShape('/tmp', ['/tmp'])).toBe('nesting')
  })
})

/**
 * D1.143 — RS-15's out-of-workspace MARKER, held to the same floor.
 *
 * Same shape, different file, and this is the one the next reader copies: RS-15
 * asks what a user SEES when a write outside the workspace is refused, and its
 * default marker sat under `$TMPDIR` — a root codex's `workspace-write` sandbox
 * carves out. A session that may already write there raises no card, and the
 * case would have photographed the absence of a refusal as the product's answer.
 * The case's own containment check cannot see it: that one asks whether the path
 * is outside the WORKSPACE, which a temp path is.
 *
 * Pinned here rather than left to a live run for the reason the row gives — a
 * latent rig shape is caught by a test in seconds or by a sitting in an hour.
 */
describe("RS-15's out-of-workspace marker", () => {
  it('defaults outside every root the runtime already grants', () => {
    expect(probeRepositoryShape(outsideMarkerPath('abc123', undefined), tempWritableRoots())).toBe('floor')
  })

  it('still reaches the granted-root arm when the operator points it there', () => {
    // BOTH spellings, for the reason the block above records: `$TMPDIR` and its
    // realpath are different strings on this platform, and a classifier that
    // knew only one scored the operator's own override as the floor.
    for (const root of [tmpdir(), realpathSync(tmpdir())]) {
      const override = join(root, 'nessy-rs15-outside-abc123.txt')
      expect(probeRepositoryShape(outsideMarkerPath('abc123', override), tempWritableRoots())).toBe('nesting')
    }
  })

  it('takes the override over the default, and ignores an empty one', () => {
    // The anti-vacuum control on the helper itself: a resolver that always
    // answered its default would pass both tests above by never reading the
    // argument at all.
    expect(outsideMarkerPath('abc123', '/somewhere/else/marker.txt')).toBe('/somewhere/else/marker.txt')
    expect(outsideMarkerPath('abc123', '   ')).toBe(outsideMarkerPath('abc123', undefined))
    expect(outsideMarkerPath('abc123', undefined)).toContain('abc123')
  })
})

/**
 * RS-13's card preconditions, and the day they excluded each other.
 *
 * C3.345 (born from R1's PR-R1-3, measured 2026-09-12 on the 1.37.0 build): the
 * removal-breaker arm needs a scratch `HOME`; the three cards the case demanded
 * unconditionally need the opposite, because the gateway credential is read at
 * `packages/shared/src/auth/dp/creds-store.ts` symbol `getCredsPath` under a
 * home that `packages/codex-responses-adapter/src/home-latch.ts` symbol
 * `latchedHomeDir` latches at module load. So `blocked()` fired on exactly the
 * host the destructive arm requires, and the breaker half of C5.10 could not be
 * driven at all.
 *
 * The second arm below is the one that matters most for the FUTURE: relaxing a
 * precondition is how a two-runtime reading gets banked as three. An ordinary
 * run — the removal arm NOT declared — must still refuse to measure a floor
 * comparison with a runtime missing, and that is the half no live run would
 * notice had gone.
 */
describe("RS-13's card preconditions", () => {
  const all = { pi: 'nessy-pi', claude: 'claude-gateway', codex: 'codex-byo' }

  it('drives all three when all three are on the host', () => {
    const resolved = resolveCardsUnderTest(all, false)
    expect(resolved.driving).toEqual(['pi', 'claude', 'codex'])
    expect(resolved.missing).toEqual([])
    expect(resolved.blocked).toBeUndefined()
  })

  it('STILL blocks an ordinary run with a card missing — the comparison is the subject', () => {
    const resolved = resolveCardsUnderTest({ ...all, codex: undefined }, false)
    // `?? '(not blocked)'` so the RED names what broke: `toContain` on undefined
    // reports a type complaint instead of the missing sentence, and this arm's
    // whole job is to be legible the day someone relaxes the demand.
    expect(resolved.blocked ?? '(not blocked)').toContain('Missing: codex')
  })

  it('drives whichever cards answer once the removal arm is declared', () => {
    const resolved = resolveCardsUnderTest({ pi: 'nessy-pi', claude: undefined, codex: undefined }, true)
    expect(resolved.blocked).toBeUndefined()
    expect(resolved.driving).toEqual(['pi'])
    expect(resolved.missing).toEqual(['claude', 'codex'])
  })

  it('blocks the removal arm only when NO card is left to drive', () => {
    const resolved = resolveCardsUnderTest({}, true)
    expect(resolved.driving).toEqual([])
    expect(resolved.blocked ?? '(not blocked)').toContain('nothing to drive')
  })
})

/**
 * RS-11's out-of-workspace marker — C3.355.
 *
 * R2 measured it on the 1.37.0 build, 2026-09-12: all three codex arms, the
 * `default` CONTROL included, came back `cardAppeared: false` with
 * `fileWritten: true`, because codex resolves `workspaceWrite` for every session
 * this product ships and auto-approves a write inside the workspace before our
 * card can exist. The case's marker therefore moved outside the session root,
 * where sit2's RS-15 measured exactly one card on all three.
 *
 * `isOutside` is the guard that makes that move worth anything, and RS-15 carries
 * the same one because its own outside path once sat INSIDE the workspace and the
 * case passed for the wrong reason. The containment arm below is the negative:
 * an "outside" path that is really inside must be REFUSED, or the probe silently
 * goes back to measuring the workspace grant.
 */
describe("RS-11's out-of-workspace marker", () => {
  it('defaults outside the OS temp roots, so codex\'s own tmp grant is not in the picture', () => {
    const parent = outsideMarkerRoot(undefined)
    expect(probeRepositoryShape(parent, tempWritableRoots())).toBe('floor')
  })

  it('REFUSES a marker directory that is really inside the session root', () => {
    expect(isOutside('/ws/repo/sub', '/ws/repo')).toBe(false)
    expect(isOutside('/ws/repo', '/ws/repo')).toBe(false)
    expect(isOutside('/ws/repo', '/ws/repo/')).toBe(false)
  })

  it('accepts a sibling, and a path that merely shares a prefix', () => {
    expect(isOutside('/ws/elsewhere/m.txt', '/ws/repo')).toBe(true)
    expect(isOutside('/ws/repo-2/m.txt', '/ws/repo')).toBe(true)
  })
})

/**
 * The renderer-health instrument — C3.389.
 *
 * RV measured it once on packaged 1.37.0 and could not report it: `/json/list`
 * returned 0 page targets while the main, GPU and network processes were alive
 * and `[SchedulerService] TICK` kept firing; nothing in
 * `~/Library/Logs/DiagnosticReports`, and a packaged build writes no application
 * log. From the harness that shape reads as every check timing out at once, and
 * nothing in the result line separated it from a product failure.
 *
 * The third arm is the one that keeps the instrument honest. "Nothing answered"
 * is NOT "the app died" — a quit app, a crashed main process and a debugging
 * port that was never opened are one silence from here — and an instrument that
 * names a cause it cannot see would turn every operator mistake into a crash
 * report. `devtools-unreachable` is a refusal to guess, and this arm is what
 * stops a later reader collapsing it into `renderer-gone`.
 */
describe('the renderer-health instrument', () => {
  const target = (type: string) => ({ id: type, type, title: type, url: `about:${type}` })

  it('reads a live page target as healthy', () => {
    const reading = classifyRendererHealth([target('page'), target('service_worker')])
    expect(reading.health).toBe('healthy')
    expect(reading.pageTargets).toBe(1)
  })

  it('reads an ANSWERING endpoint with no page as the renderer being gone', () => {
    const reading = classifyRendererHealth([target('service_worker'), target('other')])
    expect(reading.health).toBe('renderer-gone')
    expect(reading.pageTargets).toBe(0)
    // The survivors are the evidence that the main process was still serving.
    expect(reading.targetTypes).toEqual({ service_worker: 1, other: 1 })
  })

  it('refuses to call an unreachable endpoint a crash', () => {
    const reading = classifyRendererHealth(null)
    expect(reading.health).toBe('devtools-unreachable')
    expect(reading.pageTargets).toBeNull()
    expect(reading.note).toContain('UNREADABLE')
  })

  it('reads an EMPTY answer as the renderer being gone, not as unreachable', () => {
    // The endpoint answering with zero targets of any kind is still an answer:
    // something served the request, so the silence is the renderer's.
    expect(classifyRendererHealth([]).health).toBe('renderer-gone')
  })
})

/**
 * The loopback stub upstream — C3.356.
 *
 * R2 measured the hole on the rig day: RS-16's `byo-classification` reported
 * `shellToolCalled: false` against the gateway control's `true`, because a BYO
 * card carries its own key, a key its upstream rejects gives no turn, and no
 * turn gives no shell. A fake credential cannot measure that arm at all.
 *
 * These arms drive the REAL server over HTTP rather than its pieces, because the
 * thing that has to be true is "an OpenAI-compatible client gets a tool call out
 * of it" — and the second leg (the tool result coming back as the answer) is the
 * half RS-16's classifier reads. The command-recognition arms are separate
 * because a stub that ran whatever a prompt happened to contain would be a worse
 * failure than one that ran nothing.
 */
describe('the loopback stub upstream', () => {
  it('recognises RS-16\'s probe shape and nothing else', () => {
    const probe = "for n in ANTHROPIC_API_KEY NESSY_RS16_NO_SUCH_VARIABLE; do v=$(printenv \"$n\"); "
      + "printf '%s=%s\\n' \"$n\" \"$(printf %s \"$v\" | wc -c | tr -d ' ')\"; done"
    expect(extractShellCommand(`Run this exact command: ${probe} It prints one line per name.`)).toBe(probe)
    expect(extractShellCommand('Please summarise the file and then stop.')).toBeNull()
    expect(extractShellCommand('rm -rf / ; done')).toBeNull()
  })

  it('picks a shell tool by name and refuses a tool set without one', () => {
    expect(pickShellTool(['Read', 'Bash', 'Write'])).toBe('Bash')
    expect(pickShellTool(['Read', 'local_shell'])).toBe('local_shell')
    expect(pickShellTool(['Read', 'Write', 'Edit'])).toBeNull()
  })

  /**
   * The argument NAME, which cost a whole runtime arm of the RS-16 sitting.
   *
   * Measured 2026-09-17 (DA2.10): the stub sent `{ command }` to every shell
   * tool, and codex's `exec_command` takes `cmd`. The turn died inside codex
   * with `failed to parse function arguments: missing field \`cmd\``, no tool
   * ran, and RS-16's `shellToolCalled` control went false — which is BYTE FOR
   * BYTE the symptom of the credential failure this fixture exists to remove,
   * so the instrument was blaming the product for its own constant.
   */
  it('takes the command’s property name from the chosen tool’s OWN schema', () => {
    const codexTool = {
      type: 'function',
      function: { name: 'exec_command', parameters: { properties: { cmd: {}, yield_time_ms: {} } } },
    }
    expect(shellArgumentName([codexTool], 'exec_command')).toBe('cmd')
    const probe = 'for n in OPENAI_API_KEY; do v=$(printenv "$n"); printf \'%s=%s\' "$n" "1"; done'
    const answer = buildAnswer([{ role: 'user', content: `Run this: ${probe}` }], ['exec_command'], [codexTool])
    expect(answer.kind).toBe('tool-call')
    expect(answer.argumentName).toBe('cmd')
  })

  it('falls back to `command` for a tool that declares no schema, and takes the only property otherwise', () => {
    // The NEGATIVE the arm above needs: with no schema there is nothing to read,
    // and the OpenAI-shaped default is what every other client sends — the
    // harness's own name-only fixtures are exactly this case.
    expect(shellArgumentName([{ type: 'function', function: { name: 'Bash' } }], 'Bash')).toBe('command')
    expect(shellArgumentName(undefined, 'Bash')).toBe('command')
    expect(shellArgumentName([{ type: 'function', function: { name: 'Other' } }], 'Bash')).toBe('command')
    // A tool that names its argument something this fixture has never seen is
    // still driven, by the schema's own first property — guessing `command`
    // there would reproduce the codex failure under a different name.
    expect(shellArgumentName(
      [{ type: 'function', function: { name: 'sh', parameters: { properties: { shellLine: {} } } } }],
      'sh',
    )).toBe('shellLine')
  })

  it('hands a TOOL RESULT back verbatim — a summary here would destroy the reading', () => {
    const answer = buildAnswer(
      [{ role: 'user', content: 'x' }, { role: 'tool', content: 'ANTHROPIC_API_KEY=108\nOPENAI_API_KEY=0' }],
      ['Bash'],
    )
    expect(answer.kind).toBe('content')
    expect(answer.content).toBe('ANTHROPIC_API_KEY=108\nOPENAI_API_KEY=0')
  })

  it('answers a real HTTP client with a tool call, then with the tool output', async () => {
    const stub = startStubUpstream({ port: 0 })
    try {
      const models = await (await fetch(`${stub.url}/models`)).json() as { data: { id: string }[] }
      expect(models.data[0]?.id).toBe('nessy-cdp-stub')

      const probe = 'for n in OPENAI_API_KEY; do v=$(printenv "$n"); printf \'%s=%s\' "$n" "1"; done'
      const first = await (await fetch(`${stub.url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-real-key' },
        body: JSON.stringify({
          model: 'anything',
          messages: [{ role: 'user', content: `Run this exact command: ${probe}` }],
          tools: [{ type: 'function', function: { name: 'Bash' } }],
        }),
      })).json() as { choices: { message: { tool_calls?: { function: { name: string; arguments: string } }[] } }[] }
      const call = first.choices[0]?.message.tool_calls?.[0]
      expect(call?.function.name).toBe('Bash')
      expect(JSON.parse(call?.function.arguments ?? '{}').command).toBe(probe)

      // The SECOND LEG is sent in the shape a real client sends, `tool_call_id`
      // included — and that is not pedantry. This repo's own outgoing-request
      // guard is live inside `bun test` and refused the first draft of this arm
      // with HTTP 400 `missing_tool_call_id` before it ever reached the stub
      // (measured 2026-09-12): a fixture test that sends a malformed OpenAI body
      // measures the guard, not the fixture.
      const second = await (await fetch(`${stub.url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'anything',
          messages: [
            { role: 'user', content: 'x' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{}' } }],
            },
            { role: 'tool', tool_call_id: 'call_1', content: 'OPENAI_API_KEY=51' },
          ],
          tools: [{ type: 'function', function: { name: 'Bash' } }],
        }),
      })).json() as { choices: { message: { content: string } }[] }
      expect(second.choices[0]?.message.content).toBe('OPENAI_API_KEY=51')

      // The key never becomes a record — only its length, which is the one thing
      // a case needs and the one shape that cannot be pasted into a client.
      const seen = stub.requests()
      expect(seen.map(entry => entry.authorizationLength)).toEqual([0, 'Bearer not-a-real-key'.length, 0])
      expect(JSON.stringify(seen)).not.toContain('not-a-real-key')
    } finally {
      stub.stop()
    }
  })

  /**
   * F1.185 — a wildcard-bound stub lets another process bind the same port on
   * 127.0.0.1 and take every connection the URL makes; that shadow reproduces
   * the `Malformed_HTTP_Response` of the once-in-five `streams when asked`
   * flake exactly (WJ-j), though the flake's own cause stays unnamed. The
   * instrument is the one that separated the two binds on this rig: a second,
   * loopback-specific listener on the same port must be REFUSED. Against the
   * old wildcard bind the same call BINDS (measured 2026-09-23).
   */
  it('listens on the address its URL names, so no other listener can shadow it', () => {
    const stub = startStubUpstream({ port: 0 })
    try {
      expect(stub.url).toBe(`http://127.0.0.1:${stub.port}/v1`)
      let code: string | undefined
      try {
        const shadow = Bun.listen({ hostname: '127.0.0.1', port: stub.port, socket: { data() {} } })
        shadow.stop(true)
        code = 'BOUND'
      } catch (error) {
        code = (error as { code?: string }).code ?? String(error)
      }
      expect(code).toBe('EADDRINUSE')
    } finally {
      stub.stop()
    }
  })

  it('streams when asked, because a client that gets a whole body sees a protocol error', async () => {
    const stub = startStubUpstream({ port: 0 })
    try {
      const response = await fetch(`${stub.url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'anything', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      })
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      const body = await response.text()
      expect(body).toContain('chat.completion.chunk')
      expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true)
      expect(stub.requests()[0]?.streamed).toBe(true)
    } finally {
      stub.stop()
    }
  })
})

/**
 * The `/quota` render detector, against every outcome it has to separate.
 *
 * NCA-7 and NCA-9 stand entirely on this function, and it has two ways to be
 * wrong that both look like a product failure:
 *
 * 1. **Whitespace.** `describeNestorQuota` joins the head and its limits with
 *    `\n`, but the info row renders as a bare `<span>` with no `white-space`
 *    override, so CSS collapses them and `innerText` returns one line. A
 *    line-anchored detector scores a rendered budget as zero limits. Both
 *    spellings are pinned below because `chatPaneText` can return either
 *    (`textContent` is its fallback when `innerText` comes back blank).
 * 2. **The near-misses.** Every outcome of `describeNestorQuota` is an `info` —
 *    an empty limiter, an HTTP 500, a cancelled read — and the seam's
 *    "not available on this runtime" is one too. A detector that accepted "an
 *    info appeared" passes on a gateway answering 500, which is the vacuous
 *    pass the whole NCA block is written against.
 */
describe('the /quota render detector', () => {
  const collapsed = 'Quota: - Daily [user] (allowed): 73% remaining - Monthly [user] (exhausted)'
  const withNewlines = 'Quota:\n- Daily [user] (allowed): 73% remaining\n- Monthly [user] (exhausted)'

  it('reads a rendered budget in BOTH whitespace spellings', () => {
    const a = classifyQuotaRender(collapsed)
    expect(a.verdict).toBe('limits-rendered')
    expect(a.limitLines).toEqual([
      'Daily [user] (allowed): 73% remaining',
      'Monthly [user] (exhausted)',
    ])

    const b = classifyQuotaRender(withNewlines)
    expect(b.verdict).toBe('limits-rendered')
    expect(b.limitLines).toEqual(a.limitLines)
  })

  it('refuses a bare head with no limits under it', () => {
    expect(classifyQuotaRender('Quota:').verdict).toBe('nothing')
    expect(classifyQuotaRender('Quota:   ').limitLines).toEqual([])
  })

  it('separates the four near-misses from a rendered budget', () => {
    expect(classifyQuotaRender('No quota limits apply to your account.').verdict).toBe('no-limits')
    expect(classifyQuotaRender('Quota is unavailable: the gateway answered HTTP 500.').verdict).toBe('unavailable')
    expect(classifyQuotaRender('Quota read was cancelled.').verdict).toBe('cancelled')
    expect(classifyQuotaRender('Quota is not available on this runtime.').verdict).toBe('not-on-runtime')
  })

  it('reports nothing rather than guessing', () => {
    expect(classifyQuotaRender('').verdict).toBe('nothing')
    expect(classifyQuotaRender('the model said something about a quota').verdict).toBe('nothing')
  })

  it('scores only what THIS run added to the pane', () => {
    // The pane accumulates, so an earlier /quota in the same session would make
    // a whole-pane read true forever. `paneDelta` is what makes a render this
    // run's render — the same discipline `waitForTurn` applies with `sinceCount`.
    const before = `earlier turn\n${collapsed}\n`
    expect(classifyQuotaRender(paneDelta(before, before)).verdict).toBe('nothing')
    expect(classifyQuotaRender(paneDelta(before, `${before}${collapsed}`)).verdict).toBe('limits-rendered')
  })

  /**
   * F1.203 — RS-39's equality detector. Since F1.6 the claude and codex gateway
   * cards read the budget the Pi card reads, so the case asserts EQUALITY with
   * the Pi card's render, and equality has two ways to be vacuous: two failures
   * agreeing, and a figure that moved being scored as a different budget.
   */
  it('scores the same budget as the same, with the figure compared separately', () => {
    const pi = classifyQuotaRender(collapsed)
    const moved = classifyQuotaRender(collapsed.replace('73% remaining', '72% remaining'))
    expect(compareQuotaBudgets(pi, classifyQuotaRender(withNewlines))).toMatchObject({ same: true, exact: true })
    expect(compareQuotaBudgets(pi, moved)).toMatchObject({ same: true, exact: false })
    expect(quotaLimitShape('Daily [user] (allowed): 73% remaining (resets 2026-09-24T08:00:00Z)'))
      .toBe('Daily [user] (allowed): N% remaining (resets 2026-09-24T08:00:00Z)')
  })

  it('refuses a different budget, a non-budget subject, and two agreeing failures', () => {
    const pi = classifyQuotaRender(collapsed)
    // A different STATE on the same limit is a different budget reading, not a moved figure.
    const warned = classifyQuotaRender(collapsed.replace('(allowed)', '(warning)'))
    expect(compareQuotaBudgets(pi, warned).same).toBe(false)
    // The pre-F1.6 answer on the claude/codex gateway card: the refusal (and the pointer).
    const refused = classifyQuotaRender('Quota is not available on this runtime. The Nessy Gateway limit …')
    expect(compareQuotaBudgets(pi, refused).same).toBe(false)
    // Two cards failing the same way agree with each other and prove nothing.
    const down = classifyQuotaRender('Quota is unavailable: the gateway answered HTTP 500.')
    expect(compareQuotaBudgets(down, down).same).toBe(false)
    // An honest empty limiter IS a budget answer, and two of them are the same.
    const none = classifyQuotaRender('No quota limits apply to your account.')
    expect(compareQuotaBudgets(none, none)).toMatchObject({ same: true, exact: true })
  })

  it('compares the LIMIT, not the pane footer that follows it — the RS-39 drive of 2026-09-23', () => {
    // The Pi card's delta, verbatim from the packaged 1.40.0 drive (F1.203's first
    // live run): the pane delta runs to the END of the pane, so the composer's
    // footer follows the last limit, and it names the card's own model and mode.
    const limit = '- Лимит токенов [tgpt/deepseek-v4-flash-0731] (allowed): 94% remaining — Запросы доступны. (resets 2026-09-24T11:00:00+03:00)'
    const pi = classifyQuotaRender(`/quota\n\nQuota:\n${limit}\nTodo\nInfo\n\n\nPress Shift + Return to add a new line\nBypass\nDeepSeek V4 Flash\nLow\nBranch`)
    expect(pi.limitLines).toEqual([limit.slice(2)])
    // Another card, another footer, the same budget: equal, figures included.
    const claude = classifyQuotaRender(`/quota\n\nQuota:\n${limit}\nTodo\nInfo\nBypass\nClaude Sonnet\nHigh`)
    expect(compareQuotaBudgets(pi, claude)).toMatchObject({ same: true, exact: true })
    // The collapsed spelling has no newline to cut at; the reset stamp bounds it.
    const collapsed = classifyQuotaRender(`Quota: ${limit} Todo Info Bypass Codex Medium`)
    expect(compareQuotaBudgets(pi, collapsed)).toMatchObject({ same: true, exact: true })
    expect(boundedQuotaLimit(collapsed.limitLines[0] ?? '')).toBe(limit.slice(2))
  })

  it('picks the gateway card by the menu gate\'s WHOLE-URL rule, not by the CLI prefix', () => {
    expect(isNessyGatewayChatBase('https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1')).toBe(true)
    expect(isNessyGatewayChatBase(' https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1/ ')).toBe(true)
    // Review R1's subpath card and a sibling path under the same prefix: withheld by the menu since F1.6.
    expect(isNessyGatewayChatBase('https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1/sub')).toBe(false)
    expect(isNessyGatewayChatBase('https://code-completion-nestor.tcsbank.ru/api/v1/cli/other')).toBe(false)
    expect(isNessyGatewayChatBase('')).toBe(false)
    expect(isNessyGatewayChatBase(undefined)).toBe(false)
  })
})

/**
 * D1.385 — the permission mode every case runs in, and the six that opt out.
 *
 * The owner's rule is that every automated drive runs in `bypassPermissions`.
 * The policy is data in `lib/permission-mode.ts`; what this block pins is that
 * the data is TRUE — every id has a case file and a checklist row behind it,
 * the README's list is the same set, the default really is the only escape, and
 * the seven ids D1.385 named that reading the cases refutes are RE-MEASURED here
 * rather than refuted in prose. A prose refutation ages; a re-measured one goes
 * red the day it stops being true, which is what makes the disagreement with the
 * owner's own id list safe to carry.
 */
describe('the per-case permission mode', () => {
  const CASE_DIR = new URL('./cases/', import.meta.url).pathname
  const readmePath = new URL('./README.md', import.meta.url).pathname
  const caseFiles = readdirSync(CASE_DIR).filter(name => name.endsWith('.ts')).sort()

  /**
   * Every case's `meta.id`, read out of its SOURCE rather than imported.
   *
   * 163 dynamic imports would cost more than the rest of this file put together
   * (see the budget note at the top), and all 163 case files declare the id the
   * same way — `const ID = '…'` at the top level, measured over the directory on
   * 2026-09-20. A file that stops doing so fails the anti-vacuum check below
   * rather than disappearing from the map silently.
   */
  const idToFile = new Map<string, string>()
  for (const name of caseFiles) {
    const source = readFileSync(join(CASE_DIR, name), 'utf8')
    const id = /^const ID = '([^']+)'/m.exec(source)?.[1]
    if (id !== undefined) idToFile.set(id, name)
  }

  it('reads an id out of every case file — the anti-vacuum control', () => {
    // Without this, a regex that matched nothing would leave every assertion
    // below looping over an empty map and passing having checked nothing.
    expect(idToFile.size).toBe(caseFiles.length)
    expect(caseFiles.length).toBeGreaterThanOrEqual(163)
    expect(idToFile.get('RS-07')).toBe('rs-07.ts')
    expect(idToFile.get('WIRE-PARITY')).toBe('session-tool-wire-parity.ts')
  })

  it('makes the tables the ONLY escape from the default', () => {
    expect(DEFAULT_CASE_PERMISSION_MODE).toBe('bypassPermissions')
    // A case nobody has heard of gets bypass. This is the property D1.385's
    // "done means" asks for — "a new case gets bypass by default" — and it is
    // the one a per-call-site opt-in could not have.
    expect(resolveCasePermissionMode('AGT-1')).toBe('bypassPermissions')
    expect(resolveCasePermissionMode('A-CASE-THAT-DOES-NOT-EXIST')).toBe('bypassPermissions')
    expect(resolveCasePermissionMode(undefined)).toBe('bypassPermissions')
    // The positive control on the same instrument: an opt-out answers "apply
    // nothing". Without it, a resolver that had stopped reading its own table
    // would satisfy every line above.
    expect(resolveCasePermissionMode('RS-12')).toBeUndefined()
    expect(casePermissionModeOptOut('RS-12')?.subject).toBe('the floor')
    expect(casePermissionModeOptOut('AGT-1')).toBeUndefined()
  })

  it('gives every opt-out a case file, a checklist row and a reason', async () => {
    const checklist = await Bun.file(
      join(import.meta.dir, '..', '..', 'docs', 'testing', 'cdp-live-checklist.md'),
    ).text()
    // The anti-vacuum control on the checklist read, the same one the sitting
    // block uses: an unreadable file reads as '' and every id below is absent.
    expect(checklist.length).toBeGreaterThan(10_000)
    expect(checklist).toContain('| RS-16 |')
    expect(CASE_PERMISSION_MODE_OPT_OUTS.length).toBeGreaterThanOrEqual(6)
    for (const entry of CASE_PERMISSION_MODE_OPT_OUTS) {
      // Named rather than bare, so a failure says WHICH id lost its file.
      expect(`${entry.id} -> ${String(idToFile.get(entry.id))}`).not.toContain('undefined')
      expect(checklist.split('\n').some(line => line.startsWith(`| ${entry.checklistId} |`))).toBe(true)
      // A reason long enough to be a measurement rather than a label. The whole
      // value of this table is that each entry says what bypass would DESTROY.
      expect(entry.why.length).toBeGreaterThan(80)
    }
  })

  it('re-measures every id D1.385 named that is NOT opted out', () => {
    expect(ROW_NAMED_NOT_OPTED_OUT.length).toBeGreaterThanOrEqual(7)
    let measured = 0
    for (const entry of ROW_NAMED_NOT_OPTED_OUT) {
      // The row can only name an id that exists, and an id that is opted out
      // belongs in the OTHER table — the two must never overlap.
      const file = idToFile.get(entry.id)
      expect(`${entry.id} -> ${String(file)}`).not.toContain('undefined')
      expect(casePermissionModeOptOut(entry.id)).toBeUndefined()
      const source = readFileSync(join(CASE_DIR, file!), 'utf8')
      const sets = source.includes('setPermissionMode')
      // The refutation itself, re-run. `no-permission-code` means the case takes
      // no mode reading bypass could destroy; `sets-its-own-mode` means the
      // case's own write wins over the default `freshSession` applied.
      expect(`${entry.id}: setPermissionMode present = ${sets}`)
        .toBe(`${entry.id}: setPermissionMode present = ${entry.shape === 'sets-its-own-mode'}`)
      measured += 1
    }
    expect(measured).toBe(ROW_NAMED_NOT_OPTED_OUT.length)
    // The positive control on the probe, over a file NOT in the table: without
    // it, a `source.includes` that had stopped matching would report every
    // `no-permission-code` entry as confirmed.
    expect(readFileSync(join(CASE_DIR, 'cru-4.ts'), 'utf8').includes('setPermissionMode')).toBe(true)
  })

  it('applies the mode in freshSession itself, on BOTH paths, and records the case id in runCase', () => {
    const state = readFileSync(new URL('./lib/state.ts', import.meta.url).pathname, 'utf8')
    const report = readFileSync(new URL('./lib/report.ts', import.meta.url).pathname, 'utf8')
    // Two call sites inside `freshSession` — the fresh return and the fallback
    // return — plus the declaration. An opt-in at the CASE would be "every case
    // that remembered", which is the divergence this row exists to close.
    const applied = state.match(/applyCasePermissionMode\(session,/g) ?? []
    expect(applied.length).toBeGreaterThanOrEqual(2)
    // Required, never optional: the one case that mints a session by hand
    // (`q6-live.ts`) is made by the compiler to say what mode it has.
    //
    // **The needle is scoped to the INTERFACE, and the first draft was not.**
    // `SessionSummary` — a different interface, 140 lines above — carries
    // `permissionMode?: string` legitimately, and a whole-file `not.toContain`
    // failed on it: a negative needle answered by the wrong part of the corpus,
    // which is the shape AGENTS.md warns about. It cost one red here rather than
    // a false green, because the optional form really is present.
    const start = state.indexOf('export interface FreshSession')
    expect(start).toBeGreaterThan(0)
    const region = state.slice(start, state.indexOf('\n}', start))
    // The boundary control names a declaration BELOW the region: an anchor
    // declared above it could never fail, because the slice only runs forward.
    expect(region).not.toContain('NEW_SESSION_ROUTE')
    expect(region).toContain('permissionMode: string')
    expect(region).not.toContain('permissionMode?: string')
    // And the positive control that the needle is SPELLABLE in this corpus —
    // without it, a typo in the optional form would read as a clean absence.
    expect(state).toContain('permissionMode?: string')
    expect(report).toContain('setCurrentCaseId(id)')
    // The positive control on the instrument: a needle this source really has.
    expect(state).toContain('export async function freshSession')
  })

  it("keeps the README's opt-out list and the module's table the same set", () => {
    const readme = readFileSync(readmePath, 'utf8')
    expect(readme).toContain('## Every case runs in `bypassPermissions`, unless the card is its subject')
    for (const entry of CASE_PERMISSION_MODE_OPT_OUTS) {
      expect(readme).toContain(`| ${entry.id} | ${entry.subject} |`)
    }
    // The other direction, which is the one a drifting README fails: a row in
    // the README's table whose id the module does not carry.
    const section = readme.slice(readme.indexOf('### The cases that keep the mode they measure'))
    const listed = [...section.slice(0, section.indexOf('\n\n**')).matchAll(/^\| ([A-Z0-9-]+) \| /gm)]
      .map(match => match[1]!)
      // The SEPARATOR row, which `[A-Z0-9-]+` matches as the id `---`. The first
      // draft did not drop it and failed against a correct README — a cheap red,
      // and the reason the control below asserts the shape rather than a count.
      .filter(id => id !== '---')
    expect(listed).toContain('WIRE-PARITY')
    expect(listed.sort()).toEqual(CASE_PERMISSION_MODE_OPT_OUTS.map(entry => entry.id).sort())
  })

  /**
   * The `Mode` column of the preconditions table, against the module.
   *
   * The table is a PARTIAL view — 34 rows over 163 cases, and three of the six
   * opt-outs have no row at all — so it cannot be the source of truth, and this
   * check runs in one direction only: whatever a row DOES say must agree with
   * `lib/permission-mode.ts`. A cell shape the expander cannot read FAILS rather
   * than being skipped, so a new range spelling has to teach the gate instead of
   * slipping past it.
   */
  it('agrees with the module in every preconditions row', () => {
    const readme = readFileSync(readmePath, 'utf8')
    const table = readme.slice(readme.indexOf('| Case | Needs | Mode |'))
    const rows = table.split('\n').slice(2).filter(line => line.startsWith('| '))
    expect(rows.length).toBeGreaterThanOrEqual(30)
    let withOptOut = 0
    let withOwnMode = 0

    /**
     * THREE cell shapes, and a cell the reader cannot place is a failure.
     *
     *  - `bypass` — the harness default and nothing else;
     *  - ``bypass, then `<mode>` — the case sets its own`` — the shape
     *    `lib/permission-mode.ts` calls `sets-its-own-mode` and `rs-65.ts` is the
     *    worked example of: `freshSession` applies the default at creation and
     *    the case's own later write wins. It is CHECKED, not believed: the case
     *    file must really call `setPermissionMode` with that mode, or the row is
     *    claiming a posture nothing applies;
     *  - a cell naming every opt-out id, for a case that keeps the mode it
     *    measures.
     */
    const modeVerdict = (
      ids: string[],
      optOuts: string[],
      modeCell: string,
    ): { shape: 'opt-out' | 'sets-its-own' | 'bypass'; why: string } => {
      if (optOuts.length > 0) {
        return {
          shape: 'opt-out',
          why: optOuts.every(id => modeCell.includes(id))
            ? 'ok'
            : `must name ${optOuts.join(', ')}, reads ${JSON.stringify(modeCell)}`,
        }
      }
      const ownMode = /^bypass, then `([a-zA-Z]+)` — the case sets its own$/.exec(modeCell)?.[1]
      if (ownMode !== undefined) {
        const unproven = ids.filter(id => {
          const file = idToFile.get(id)
          const source = file === undefined ? '' : readFileSync(join(CASE_DIR, file), 'utf8')
          return !(source.includes('setPermissionMode(') && source.includes(`'${ownMode}'`))
        })
        return {
          shape: 'sets-its-own',
          why: unproven.length === 0
            ? 'ok'
            : `claims to set \`${ownMode}\` itself, and ${unproven.join(', ')} does not call setPermissionMode with it`,
        }
      }
      return {
        shape: 'bypass',
        why: modeCell === 'bypass'
          ? 'ok'
          : `must be exactly "bypass", an opt-out's ids, or "bypass, then \`<mode>\` — the case sets its own"; `
            + `reads ${JSON.stringify(modeCell)}`,
      }
    }

    for (const row of rows) {
      const cells = row.split(' | ')
      const caseCell = cells[0]!.replace(/^\| /, '').trim()
      const modeCell = cells[cells.length - 1]!.replace(/\s*\|\s*$/, '').trim()
      const ids = expandCaseCell(caseCell)
      // A cell the expander could not read is a failure, named.
      expect(`${caseCell} -> ${ids.length} id(s)`).not.toBe(`${caseCell} -> 0 id(s)`)
      const optOuts = ids.filter(id => casePermissionModeOptOut(id) !== undefined)
      if (optOuts.length > 0) withOptOut += 1
      // ONE unconditional assertion on a derived verdict, rather than an
      // `expect` per branch: `lint:conditional-expect` refused the branched
      // form, correctly — a regression that flipped the condition would have
      // DELETED the assertion instead of failing it.
      const verdict = modeVerdict(ids, optOuts, modeCell)
      withOwnMode += verdict.shape === 'sets-its-own' ? 1 : 0
      expect(`${caseCell}: ${verdict.why}`).toBe(`${caseCell}: ok`)
    }
    // The anti-vacuum control on the loop: an expander that returned ids nothing
    // opts out of would take the cheap branch for every row and check nothing.
    expect(withOptOut).toBeGreaterThanOrEqual(2)
    // And the same control on the third shape, which is the one a reader would
    // otherwise write as a decorative sentence: at least one row really is
    // checked against its case file's own `setPermissionMode` (RS-108's floor).
    expect(withOwnMode).toBeGreaterThanOrEqual(1)
  })

  it('expands both cell shapes, and refuses a third — the expander is the load-bearing part', () => {
    expect(expandCaseCell('AGT-1')).toEqual(['AGT-1'])
    expect(expandCaseCell('W19R-C3-4')).toEqual(['W19R-C3-4'])
    expect(expandCaseCell('RS-02…RS-13')).toContain('RS-07')
    expect(expandCaseCell('RS-02…RS-13')).toContain('RS-12')
    expect(expandCaseCell('RS-02…RS-13').length).toBe(12)
    // The right-hand side may drop the shared prefix, which `MCP-W1…W3` does
    // and which a naive expander reads as a range from `MCP-W1` to nothing.
    expect(expandCaseCell('MCP-W1…W3')).toEqual(['MCP-W1', 'MCP-W2', 'MCP-W3'])
    expect(expandCaseCell('LIV-1…LIV-3')).toEqual(['LIV-1', 'LIV-2', 'LIV-3'])
    // And the refusal, which is what makes an unreadable cell a red rather than
    // a silent pass in the block above.
    expect(expandCaseCell('RS-02…AGT-9')).toEqual([])
    expect(expandCaseCell('')).toEqual([])
  })
})

/**
 * A preconditions-table `Case` cell as the list of ids it covers.
 *
 * Two shapes, and nothing else: a single id, and `<left>…<right>` where both
 * sides end in digits and the left's prefix ENDS WITH the right's. That second
 * clause is not decoration — `MCP-W1…W3` spells the right side without the
 * shared `MCP-` and would otherwise expand to nothing.
 *
 * Returns `[]` for anything it cannot read, which the caller treats as a
 * failure. Guessing here would be worse than refusing: a cell read as covering
 * no ids passes the "no opt-outs, so say bypass" branch for free.
 */
function expandCaseCell(cell: string): string[] {
  if (!cell) return []
  const [left, right, ...rest] = cell.split('…')
  if (rest.length > 0 || left === undefined) return []
  if (right === undefined) return /\s/.test(left) ? [] : [left]
  const leftParts = /^(.*?)(\d+)$/.exec(left)
  const rightParts = /^(.*?)(\d+)$/.exec(right)
  if (!leftParts || !rightParts) return []
  const [, prefix, from] = leftParts as unknown as [string, string, string]
  const [, tailPrefix, to] = rightParts as unknown as [string, string, string]
  if (!prefix.endsWith(tailPrefix)) return []
  const start = Number(from)
  const end = Number(to)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 200) return []
  const ids: string[] = []
  for (let n = start; n <= end; n += 1) ids.push(`${prefix}${String(n).padStart(from.length, '0')}`)
  return ids
}

/**
 * D1.381 — RS-81's per-session diagnostic reader, over BOTH files.
 *
 * `ClaudeAgent.noteInterruptSeam` writes the seam line twice — `this.debug(note)`
 * into the host's own debug channel, which a PACKAGED build does not write, and
 * `appendSessionRuntimeHostNote('claude', …)` into
 * `<config>/logs/runtime/<id>-claude-host.txt`, which it does. The reader filtered
 * on `endsWith('-claude.txt')`, which the host's file does not match, so the one
 * surface that could carry the line on the artefact was the one being excluded.
 *
 * Driven against a real directory rather than asserted over source text: the
 * defect is a string predicate, and a source-text pin would have been satisfied
 * by the very filter that caused it.
 */
describe("RS-81's diagnostic reader", () => {
  const SEAM_LINE = '[2026-09-20T00:00:00.000Z] Claude turn interrupt (user_stop); '
    + 'child advertises interrupt_receipt_v1 (capabilities: [])\n'

  function plant(files: Record<string, string>): string {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'rs81-diag-'))
    const dir = join(root, 'logs', 'runtime')
    mkdirSync(dir, { recursive: true })
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
    return root
  }

  it('the defect in one line — the old filter cannot match the host note file', () => {
    // The control that makes the arm below a real one rather than a shape test:
    // this is exactly the predicate the reader carried, and it is `false`.
    expect('sess-1-claude-host.txt'.endsWith('-claude.txt')).toBe(false)
    expect('sess-1-claude.txt'.endsWith('-claude.txt')).toBe(true)
  })

  it('counts a seam line that landed ONLY in the host note file', async () => {
    const { diagnostic } = await import('./cases/rs-81.ts')
    const root = plant({
      'sess-1-claude.txt': 'some child chatter with no seam in it\n',
      'sess-1-claude-host.txt': SEAM_LINE,
    })
    const read = diagnostic(root, 'sess-1')
    // The union is what the case's checks read, and it is non-zero — which on
    // the old reader it was not.
    expect(read.seam).toBe(1)
    // And the halves say WHICH file carried it, which is the difference between
    // "the host wrote nothing" and "the reader looked in one place".
    expect(read.child.seam).toBe(0)
    expect(read.host.seam).toBe(1)
    expect(read.host.file?.endsWith('sess-1-claude-host.txt')).toBe(true)
    expect(read.child.file?.endsWith('sess-1-claude.txt')).toBe(true)
  })

  it('still reads the CHILD file, and sums the two rather than picking one', async () => {
    const { diagnostic } = await import('./cases/rs-81.ts')
    const read = diagnostic(plant({
      'sess-2-claude.txt': `${SEAM_LINE}a second line\n`,
      'sess-2-claude-host.txt': SEAM_LINE,
    }), 'sess-2')
    expect(read.seam).toBe(2)
    expect(read.lines).toBe(3)
    expect(read.advertises).toBe(2)
    expect(read.notAdvertises).toBe(0)
  })

  it('keys on the SESSION ID and reports an absent file as absent', async () => {
    const { diagnostic } = await import('./cases/rs-81.ts')
    const root = plant({
      'other-session-claude.txt': SEAM_LINE,
      'other-session-claude-host.txt': SEAM_LINE,
      // The `latest` symlink name the vendored binary writes beside the real
      // file; reading it would double-count the last session.
      'latest-claude.txt': SEAM_LINE,
    })
    const read = diagnostic(root, 'sess-3')
    expect(read.seam).toBe(0)
    expect(read.file).toBeUndefined()
    expect(read.host.file).toBeUndefined()
    // The positive control on the same planted directory: the reader CAN see a
    // file here, so the zero above is a key miss and not an unreadable root.
    expect(diagnostic(root, 'other-session').seam).toBe(2)
  })

  it('gives D1.376 its own PASS/FAIL rather than folding it into the interrupt check', async () => {
    const source = await Bun.file(new URL('./cases/rs-81.ts', import.meta.url).pathname).text()
    // One `run.check` of its own, reading the composer control AND the host's
    // `isProcessing` — the renderer cannot fake the second.
    expect(source).toContain("'D1.376 — after a message is QUEUED behind a running turn")
    expect(source).toContain('hostIsProcessing')
    expect(source).toContain("control.type === 'button' && hostIsProcessing")
    // The positive control on this instrument: a needle the file really carries.
    expect(source).toContain("const ID = 'RS-81'")
  })
})

/**
 * D1.374 — `answerTrustGate`'s negative carries its reason.
 *
 * `'not-shown'` on its own cannot distinguish *the gate was silenced* from *the
 * gate was correctly silent because this folder contributes nothing*, and four
 * readings in sitting 5e were recorded under that one word. The verdict is
 * derived from the product's OWN gate — `resolveProjectTrustPrompt` validates
 * the directory, drops out when `trustState !== 'unknown'`, then asks
 * `detectProjectContributions` and shows the modal only when
 * `projectWouldContribute(report)` — so what is pinned here is that each of the
 * app's four answers reaches a DIFFERENT word.
 */
describe('the silent trust gate explains itself', () => {
  it('separates "contributes nothing" from "contributes N and was not asked"', () => {
    expect(silentGateVerdict({ ok: true, trustState: 'unknown', items: [] }))
      .toBe('not-shown (contributes nothing)')
    const asked = silentGateVerdict({
      ok: true,
      trustState: 'unknown',
      items: [
        { itemType: 'SKILLS', count: 2, sourceLabel: '.agents/skills' },
        { itemType: 'AGENTS_MD', count: 1, sourceLabel: 'AGENTS.md' },
      ],
    })
    // The COUNT is the row's own word, and the item types are what make the
    // difference actionable: a rig fault names what it planted.
    expect(asked).toContain('contributes 3 and was not asked')
    expect(asked).toContain('SKILLS:2@.agents/skills')
    expect(asked).toContain('AGENTS_MD:1@AGENTS.md')
  })

  it('names the THIRD world the row does not — a decision already made', () => {
    // `resolveProjectTrustPrompt` returns before the detection whenever the
    // state is not `unknown`, so a contributing directory raises nothing here.
    // SIT-5e read a run of these as a profile-wide stickiness (D1.363).
    expect(silentGateVerdict({ ok: true, trustState: 'trusted', items: null }))
      .toBe('not-shown (already decided: trusted)')
    expect(silentGateVerdict({ ok: true, trustState: 'untrusted', items: null }))
      .toBe('not-shown (already decided: untrusted)')
  })

  it('never launders a FAILED read into "contributes nothing"', () => {
    // `projectWouldContribute`'s own header makes this the product's law: only a
    // positive "this folder contributes nothing" may suppress the question. A
    // thrown RPC reported as an empty report would be the exact laundering this
    // change exists to stop — and an empty `items` on a failed read is the shape
    // that would do it, so it is driven.
    expect(silentGateVerdict({ ok: false, why: 'validateProjectDirectory threw: EACCES' }))
      .toBe('not-shown (unexplained: validateProjectDirectory threw: EACCES)')
    expect(silentGateVerdict({ ok: false, why: 'detect threw', trustState: 'unknown', items: [] }))
      .toContain('unexplained')
    expect(silentGateVerdict({ ok: false, why: 'detect threw', trustState: 'unknown', items: [] }))
      .not.toContain('contributes nothing')
  })

  it('leaves `=== answered` narrowing exactly as it was — the two call sites depend on it', async () => {
    const source = await Bun.file(new URL('./lib/runtime-switch.ts', import.meta.url).pathname).text()
    // The widened type is the template-literal form, so every `not-shown (...)`
    // is assignable and every comparison against `'answered'` still compiles.
    expect(source).toContain("export type TrustGateOutcome = 'answered' | `not-shown (${string})`")
    // The probe walks the product's two RPCs, in the product's own order.
    const probe = source.slice(source.indexOf('async function explainSilentTrustGate'))
    const body = probe.slice(0, probe.indexOf('\n}'))
    expect(body.indexOf('validateProjectDirectory')).toBeGreaterThan(-1)
    expect(body.indexOf('detectProjectContributions')).toBeGreaterThan(body.indexOf('validateProjectDirectory'))
    // The boundary control, named BELOW the region: a slice that ran away would
    // otherwise satisfy both `indexOf`s off the rest of the file.
    expect(body).not.toContain('silentGateVerdict')
    // And the two real comparison sites, so this claim is about the tree and not
    // about the type alone.
    const rs87 = await Bun.file(new URL('./cases/rs-87.ts', import.meta.url).pathname).text()
    const rs99 = await Bun.file(new URL('./cases/rs-99.ts', import.meta.url).pathname).text()
    expect(rs87).toContain("trust === 'answered'")
    expect(rs99).toContain("trust !== 'answered'")
  })
})

/**
 * F1.168 — two `scripts/cdp/**` comments that asserted renderer behaviour, and
 * the gate they did not have.
 *
 * `rs-05.ts` said the code-restore button FAILS OPEN until the tracked-change
 * answer lands, and `rs-34.ts` named `parseRewindCommand` as the symbol
 * `ChatDisplay`'s `onSubmit` reads. Both were true when written and both were
 * falsified by F1.77 (`07e7fe619`) and F1.87 (`eee27ddde`) — the exact shape
 * AGENTS.md records as having no guard: *"A comment asserting what a DIFFERENT
 * module does not do has no guard, and the module that falsifies it has no
 * reason to look."*
 *
 * The prescribed residue is a back-pointer in the asserted module, and this lane
 * cannot write one — `rewind-menu.tsx` and `ChatDisplay.tsx` are another lane's
 * zone. So the residue is here instead, and it is deliberately a POSITIVE
 * assertion rather than a stale-name `not.toContain`: a guard on the absent
 * identifier would fire on the very commit whose comment explains the removal,
 * which is the inversion AGENTS.md measured twice (P6.665). A failure here means
 * "the renderer moved; re-read the two comments", not "the renderer is wrong".
 */
describe('the renderer behaviour two cdp comments assert', () => {
  const RENDERER = join(import.meta.dir, '..', '..', 'apps', 'electron', 'src', 'renderer', 'components', 'app-shell')

  it('rs-05 — `rewindOffersCodeRestore` FAILS CLOSED on an unanswered tracked-change read', () => {
    const menu = readFileSync(join(RENDERER, 'rewind-menu.tsx'), 'utf8')
    // The positive control on the read, first: a needle this file really has.
    expect(menu).toContain('export function rewindOffersCodeRestore(')
    const start = menu.indexOf('export function rewindOffersCodeRestore(')
    const region = menu.slice(start, menu.indexOf('\n}', start))
    // The direction itself. `undefined` — the answer has not landed — withholds
    // the button; that is what rs-05's comment now says, and the case records
    // the server's own answer beside the button precisely to tell the
    // not-yet-answered state from an anchor with nothing to restore.
    expect(region).toContain('if (!trackedChangeIds) return false')
    // The boundary control, named BELOW the region: a runaway slice would
    // otherwise satisfy the line above off the rest of the file.
    expect(region).not.toContain('rewindComposerText')
    const cdpComment = readFileSync(new URL('./cases/rs-05.ts', import.meta.url).pathname, 'utf8')
    expect(cdpComment).toContain('FAILS CLOSED until it lands')
  })

  it('rs-34 — the composer guard `ChatDisplay` reads is `rewindCommandOpensMenu`', () => {
    const menu = readFileSync(join(RENDERER, 'rewind-menu.tsx'), 'utf8')
    const chat = readFileSync(join(RENDERER, 'ChatDisplay.tsx'), 'utf8')
    expect(menu).toContain('export function rewindCommandOpensMenu(')
    // The CALL, not the identifier: a guard on the bare name would be satisfied
    // by an import nothing uses, or by a comment mentioning it.
    expect(chat).toContain('rewindCommandOpensMenu(')
    // The positive control on the ChatDisplay read — without it a path that
    // stopped resolving would read as an empty string and fail for the wrong
    // reason, or an over-eager needle would pass on nothing.
    expect(chat.length).toBeGreaterThan(10_000)
    expect(chat).toContain('handleSubmit')
    const cdpComment = readFileSync(new URL('./cases/rs-34.ts', import.meta.url).pathname, 'utf8')
    expect(cdpComment).toContain('`rewindCommandOpensMenu` is read off the raw composer text')
  })
})

describe('AGENT-INSTALL reaches deferred tools in two requests and names a miss honestly (F1.145)', () => {
  const row = (partial: Partial<TranscriptMessage>): TranscriptMessage => ({
    id: `m-${Math.random().toString(36).slice(2, 8)}`, role: 'tool', content: '', timestamp: 0, ...partial,
  })
  const said = (content: string): TranscriptMessage => row({ role: 'assistant', content })
  // SIT-11 pi run 2 (`b934afb8-…`), verbatim — the row's CONTROL. The bold is
  // the model's own, and it is on the one word the classifier needs.
  const PI_RUN_2 = 'The plugin tools (`plugin_plan_install` and `plugin_install`) were deferred, so I just loaded them. '
    + 'Per the runtime contract, they only become callable on your **next** message — I can\'t execute them in this turn. '
    + 'Send any follow-up message (e.g. \'go\') and I\'ll run: 1. `plugin_plan_install` … 2. `plugin_install` …'
  const loaded = row({
    toolName: 'mcp__tool_load', toolStatus: 'completed',
    toolResult: 'MCP tools loaded and available from the user\'s next message (not callable in this request): '
      + 'mcp__session__plugin_plan_install, mcp__session__plugin_install',
  })

  it('THE CONTROL: the model\'s own "callable on your next message" blocks with that reason, never the decline', () => {
    const miss = classifyInstallMiss([loaded, said(PI_RUN_2)])
    expect(miss.kind).toBe('loaded-not-callable')
    expect(miss.reason).toContain('they only become callable on your next message')
    expect(miss.reason).not.toContain('appears to be a probe')
    expect(miss.reason).not.toContain('declin')
    // The words decide, not the rows: the SAME rows with the sentence taken
    // away are a decline that says the tools WERE loaded.
    const silent = classifyInstallMiss([loaded, said('OK.')])
    expect(silent.kind).toBe('declined')
    expect(silent.reason).toContain('so the tools WERE loaded')
  })

  it("D4's outright decline is still a decline, and names what D4 measured", () => {
    const miss = classifyInstallMiss([said('{"status":"blocked","reason":"appears to be a probe or test"}')])
    expect(miss.kind).toBe('declined')
    expect(miss.reason).toContain('appears to be a probe or test')
    expect(miss.reason).toContain('tool rows seen: []')
  })

  it('reads the deferral words only in the request that asked for the CALL', () => {
    // A correct load turn says what the deferral sentence says; reading it
    // would make every later miss `loaded-not-callable`.
    const loadTurn = [loaded, said('Loaded — they are callable from your next message. TOOLS-LOADED')]
    expect(classifyInstallMiss([said('I will not run that.')], loadTurn).kind).toBe('declined')
    // Control: the same sentence moved INTO the call request is the finding.
    expect(classifyInstallMiss([said('They are callable from your next message.')], [loaded]).kind)
      .toBe('loaded-not-callable')
  })

  it('names a card-parked load, and codex\'s documented absence, as their own reasons', () => {
    const parked = classifyInstallMiss([], [row({ toolName: 'mcp__tool_load', toolStatus: 'executing' })])
    expect(parked.kind).toBe('load-parked')
    expect(parked.reason).toContain('status=executing')
    const absent = classifyInstallMiss([said(
      'the tools `plugin_plan_install` and `plugin_install` are not available in my current toolset',
    )])
    expect(absent.kind).toBe('tools-absent')
    expect(absent.reason).toContain('SESSION_TOOLS_REQUIRING_HOST_CALLBACK')
  })

  it('an install that RAN is the product answering; a plan alone is not an install', () => {
    // Both spellings of the row: claude names it through the session server,
    // pi's transcript carries it bare.
    for (const toolName of ['mcp__session__plugin_install', 'plugin_install']) {
      const miss = classifyInstallMiss([row({ toolName, toolStatus: 'completed', toolResult: '{"ok":false}' })])
      expect(miss.kind).toBe('install-ran')
    }
    // `plugin_plan_install` ends in `_install`; it must not read as the install.
    const plan = classifyInstallMiss([row({
      toolName: 'mcp__session__plugin_plan_install', toolStatus: 'completed', toolResult: '{"status":"installable"}',
    })])
    expect(plan.kind).toBe('plan-only')
    expect(plan.reason).toContain('"status":"installable"')
  })

  it('loads in one request and calls in the NEXT, with a load prompt Guardian can read', async () => {
    const sent: string[] = []
    const { load, call } = await loadThenCall(async prompt => {
      sent.push(prompt)
      return { added: [said(`turn ${sent.length}`)] }
    }, INSTALL_TOOLS, 'CALL-PROMPT')
    expect(sent).toHaveLength(2)
    expect(sent[0]).toBe(loadPrompt(INSTALL_TOOLS))
    expect(sent[1]).toBe('CALL-PROMPT')
    expect(load.added[0]?.content).toBe('turn 1')
    expect(call.added[0]?.content).toBe('turn 2')
    for (const name of INSTALL_TOOLS) expect(sent[0]).toContain(JSON.stringify(name))
    // A deferral-aware load: a runtime with nothing deferred answers and stops.
    expect(sent[0]).toContain('is not in your tool list, reply with exactly TOOLS-READY and stop')
    // ONE line (the composer swallows a newline) and no tool forbidden by name
    // (Pi's Guardian reads that pair as an injection — MCP-W2's header).
    expect(sent[0]).not.toContain('\n')
    expect(sent[0]).not.toMatch(/\bdo(n't| not) call\b/i)
  })

  it('the case sends no single-prompt install: every turn goes through the two-request helper', () => {
    const src = readFileSync(new URL('./cases/agent-install.ts', import.meta.url).pathname, 'utf8')
    // One `sendPrompt(` call in the file, and it is the helper's.
    expect(src.match(/sendPrompt\(session/g) ?? []).toHaveLength(1)
    expect(src).toContain('return prompt => sendPrompt(session, key, prompt, 300_000)')
    // Positive control: both agent-driven reaches use it.
    expect(src).toContain('loadThenCall(send, INSTALL_TOOLS,')
    expect(src).toContain('loadThenCall(send, [wire],')
    // And the minted-tool read keys on the ROW by name — the old
    // `JSON.stringify(m).includes(wire)` was satisfied by the case's own prompt.
    expect(src).toContain('rows.filter(m => m.toolName === wire)')
    expect(src).not.toContain('JSON.stringify(m).includes(wire)')
  })
})

describe('the MCP-W fixture writes into a config dir only after the app has booted it (F1.146)', () => {
  const tmpRoot = (): string => mkdtempSync(join(tmpdir(), 'wjn-g6-'))
  // The exact file the fixture's OLD shape wrote before the app ever booted the
  // dir — the dead gate SIT-11 measured in all three drivers.
  const OLD_SHAPE_CONFIG = { builtinDpMcpServers: { enabled: { 't-tracker': true } } }

  it('reads the root the way storage readiness does: only a config.json with a layout version is booted', () => {
    const root = tmpRoot()
    expect(inspectFixtureConfigDir(join(root, 'config')).state).toBe('absent')
    mkdirSync(join(root, 'config'))
    expect(inspectFixtureConfigDir(join(root, 'config')).state).toBe('empty')
    writeFileSync(join(root, 'config', 'config.json'), JSON.stringify(OLD_SHAPE_CONFIG))
    const refused = inspectFixtureConfigDir(join(root, 'config'))
    expect(refused.state).toBe('refused')
    expect(refused.detail).toContain('custom-root-reset-required')
    writeFileSync(join(root, 'config', 'config.json'), '{not json')
    expect(inspectFixtureConfigDir(join(root, 'config')).state).toBe('refused')
    writeFileSync(join(root, 'config', 'config.json'), JSON.stringify({ storageLayoutVersion: 2 }))
    expect(inspectFixtureConfigDir(join(root, 'config')).state).toBe('booted')
    // Files but no config.json at all — the old shape's `mcp.json` alone.
    const other = tmpRoot()
    mkdirSync(join(other, 'config'))
    writeFileSync(join(other, 'config', 'mcp.json'), '{}')
    expect(inspectFixtureConfigDir(join(other, 'config')).state).toBe('refused')
  })

  it('on a root the app has not booted, builds everything EXCEPT the config dir', async () => {
    const root = tmpRoot()
    const { paths, config } = await buildFixtures(root)
    expect(config).toMatchObject({ state: 'absent', seeded: false })
    // THE CLAIM: the directory the app will be launched on does not exist, so
    // the first boot installs a fresh root instead of refusing a legacy one.
    expect(existsSync(paths.configDir)).toBe(false)
    // Positive control: the rest of the tree WAS built.
    expect(existsSync(join(paths.marketA, 'marketplace.json'))).toBe(true)
    expect(existsSync(paths.tokensFile)).toBe(true)
    expect(existsSync(paths.logFile)).toBe(true)
  })

  it('on a root the app REFUSES, writes nothing into it', async () => {
    const root = tmpRoot()
    mkdirSync(join(root, 'config'))
    writeFileSync(join(root, 'config', 'config.json'), JSON.stringify(OLD_SHAPE_CONFIG))
    const { config } = await buildFixtures(root)
    expect(config).toMatchObject({ state: 'refused', seeded: false })
    expect(readdirSync(join(root, 'config'))).toEqual(['config.json'])
    expect(JSON.parse(readFileSync(join(root, 'config', 'config.json'), 'utf8'))).toEqual(OLD_SHAPE_CONFIG)
  })

  it('on a booted root, MERGES config.json and writes mcp.json beside it', async () => {
    const root = tmpRoot()
    mkdirSync(join(root, 'config'))
    writeFileSync(join(root, 'config', 'config.json'), JSON.stringify({
      storageLayoutVersion: 2, appOwnKey: 'kept', builtinDpMcpServers: { enabled: { dpGitlab: false } },
    }))
    const { config } = await buildFixtures(root)
    expect(config).toMatchObject({ state: 'booted', seeded: true })
    const written = JSON.parse(readFileSync(join(root, 'config', 'config.json'), 'utf8')) as Record<string, unknown>
    expect(written.storageLayoutVersion).toBe(2)
    expect(written.appOwnKey).toBe('kept')
    expect(written.builtinDpMcpServers).toEqual({ enabled: { dpGitlab: false, 't-tracker': true } })
    const mcp = JSON.parse(readFileSync(join(root, 'config', 'mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> }
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(['my server.v2', 'мой сервер'])
  })

  it('a CASE builds its registries without touching the running app\'s config dir', async () => {
    const root = tmpRoot()
    mkdirSync(join(root, 'config'))
    const booted = JSON.stringify({ storageLayoutVersion: 2, appOwnKey: 'kept' })
    writeFileSync(join(root, 'config', 'config.json'), booted)
    const { paths, config } = await buildFixtures(root, { seedConfigDir: false })
    expect(config).toMatchObject({ state: 'booted', seeded: false })
    expect(readdirSync(join(root, 'config'))).toEqual(['config.json'])
    expect(readFileSync(join(root, 'config', 'config.json'), 'utf8')).toBe(booted)
    // Positive control: the registries the case came for were built.
    expect(existsSync(join(paths.marketA, 'marketplace.json'))).toBe(true)
    for (const file of ['agent-install.ts', 'plugin-install-runtimes.ts']) {
      const src = readFileSync(new URL(`./cases/${file}`, import.meta.url).pathname, 'utf8')
      expect(src).toContain('await buildFixtures(undefined, { seedConfigDir: false })')
      expect(src.match(/buildFixtures\(/g) ?? []).toHaveLength(1)
    }
  })

  it("mirrors the product's own discriminator, so a change there fails here", () => {
    const readiness = readFileSync(
      new URL('../../packages/shared/src/workspaces/storage-readiness.ts', import.meta.url).pathname, 'utf8',
    )
    // The version the fixture keys on is read off config.json by that name...
    expect(readiness).toContain('(parsed as { storageLayoutVersion?: unknown }).storageLayoutVersion')
    // ...and a non-default root without it is the refusal SIT-11 measured.
    expect(readiness).toContain("if (state === 'legacy') blocked('custom-root-reset-required')")
    // Positive control that this is the file with the custom-root branch at all.
    expect(readiness).toContain('if (!IS_DEFAULT_CONFIG_DIR) {')
  })
})

describe("MCP-W1's detail arm opens the plugin copy by the key the PAGE resolves (F1.149)", () => {
  const REPO = new URL('../../', import.meta.url).pathname
  const read = (path: string): string => readFileSync(join(REPO, path), 'utf8')
  const PLUGIN_KEY_WS = 'plugin://registry-293c0c24/cdp-tracker-probe@1.0.0#a53bc204#mcp.t-tracker@workspace:ws1:'
  const PLUGIN_KEY_PROJECT = 'plugin://registry-293c0c24/cdp-tracker-probe@1.0.0#a53bc204#mcp.t-tracker@project:ws1:pk9'
  const MARKER = 'mcp.t-tracker'
  // Page texts read off SIT-11's claude-gateway evidence, verbatim where it quotes them.
  const CLICKED_PLUGIN_PAGE = 't-tracker t-tracker External marketplace About Managed by plugin No documentation provided. '
    + 'Metadata Duplicates a built-in server; the built-in is used. Parts of this plugin that used this server are inactive: '
    + 'skill:cdp-tracker-helper Type MCP Scope project Status disabled origin plugin transport stdio '
    + 'plugin cmVnaXN0cnktMjkzYzBjMjQt.Y2RwLXRyYWNrZXItcHJvYmU capability mcp.t-tracker Diagnostics capability.dedup.builtin-identity'
  const BUILTIN_PAGE = 't-tracker t-tracker Tool for working with T-Tracker Actions About Managed by plugin Metadata '
    + 'Type MCP Scope builtin Status active origin builtin transport stdio Diagnostics No issues detected.'

  it('reads the reason, a failure FOR THIS KEY, and a loaded plugin page — and nothing from a stale page', () => {
    expect(readDetailPage(CLICKED_PLUGIN_PAGE, PLUGIN_KEY_PROJECT, MARKER)).toBe('reason')
    const failedWs = `My Workspace ${PLUGIN_KEY_WS} Error loading content Failed to load source`
    expect(readDetailPage(failedWs, PLUGIN_KEY_WS, MARKER)).toBe('failed')
    // The pane still showing the PREVIOUS key's failure is not this key's verdict.
    expect(readDetailPage(failedWs, PLUGIN_KEY_PROJECT, MARKER)).toBe('unsettled')
    // Nor is the built-in's page, still up from the control: it never names the copy's capabilityId.
    expect(readDetailPage(BUILTIN_PAGE, PLUGIN_KEY_PROJECT, MARKER)).toBe('unsettled')
    // A plugin page that LOADED without the sentence is its own verdict — the product finding.
    const withoutReason = CLICKED_PLUGIN_PAGE.replace('Duplicates a built-in server; the built-in is used. ', '')
    expect(readDetailPage(withoutReason, PLUGIN_KEY_PROJECT, MARKER)).toBe('loaded-no-reason')
    // The other locale.
    expect(readDetailPage(`${PLUGIN_KEY_WS} Не удалось загрузить источник`, PLUGIN_KEY_WS, MARKER)).toBe('failed')
    expect(capabilityIdOf(PLUGIN_KEY_PROJECT)).toBe(MARKER)
    expect(capabilityIdOf(PLUGIN_KEY_WS)).toBe(MARKER)
  })

  it('carries the locale strings verbatim', () => {
    const en = JSON.parse(read('packages/shared/src/i18n/locales/en.json')) as Record<string, string>
    const ru = JSON.parse(read('packages/shared/src/i18n/locales/ru.json')) as Record<string, string>
    for (const [field, key] of [
      ['reason', 'sourceInfo.unavailable.duplicatesBuiltin'],
      ['failed', 'sourceInfo.failedToLoad'],
      ['metadata', 'capabilityDetail.metadata'],
    ] as const) {
      expect([...DETAIL_PAGE_TEXT[field]] as string[]).toEqual([en[key]!, ru[key]!])
    }
    // The onboarding detector's words, the same way.
    expect([...ONBOARDING_TEXT.getStarted] as string[]).toEqual([en['onboarding.welcome.getStarted']!, ru['onboarding.welcome.getStarted']!])
    expect([...ONBOARDING_TEXT.oneClickPi] as string[])
      .toEqual([en['onboarding.providerSelect.nessyPiDesc']!, ru['onboarding.providerSelect.nessyPiDesc']!])
  })

  it('rests on four product facts, each pinned where it lives', () => {
    // 1. a plugin capability key carries the scope it was resolved in
    const projection = read('packages/shared/src/plugins/projection-candidates.ts')
    expect(projection).toContain('key: `${entry.pluginInstanceId}#${capabilityId}@${scopeToken(selectedScope)}`')
    expect(projection).toContain("return `${scope.kind}:${scope.workspaceId ?? ''}:${scope.projectKey ?? ''}`;")
    // 2. the page resolves in the SELECTED session's context, and says "failed" when the key is not its own
    expect(read('apps/electron/src/renderer/components/app-shell/AppShell.tsx'))
      .toContain('activeWorkspaceId ? capabilityContext(activeWorkspaceId, session.selected) : undefined')
    const page = read('apps/electron/src/renderer/pages/SourceInfoPage.tsx')
    expect(page).toContain('app?.capabilityContext ?? capabilityContext(workspaceId)')
    expect(page).toContain("setError(t('sourceInfo.failedToLoad'))")
    // 3. the product's own row click routes by `encodeURIComponent(key)`, as the case does
    expect(read('apps/electron/src/renderer/lib/capability-catalog.ts'))
      .toContain('export function capabilityRouteId(key: string): string {\n  return encodeURIComponent(key)\n}')
    // 4. the case reads the key in the page's possible contexts, creates no
    //    session, and no longer clicks a row by its NAME
    const w1 = readFileSync(new URL('./cases/mcp-w1.ts', import.meta.url).pathname, 'utf8')
    expect(w1).toContain('await catalogRows(session, workspaceId, sessionId)')
    expect(w1).toContain("route: 'sources/mcp/source/' + encodeURIComponent(")
    expect(w1).not.toContain('clickSelector(')
    expect(w1).not.toContain('await freshSession(')
  })

  it('orders the contexts the page might be in: the selected session, the workspace, one per other directory', () => {
    const sessions = [
      { id: 's1', workingDirectory: '/repo/a' },
      { id: 's2', workingDirectory: '/repo/a' },
      { id: 's3', workingDirectory: '/repo/b' },
      { id: 's4' },
    ]
    // A fresh card-less profile: no session, so the page's context is the
    // workspace alone — the one reading the live drive of 2026-09-23 needed.
    expect(detailContextOrder([], undefined)).toEqual([undefined])
    // The selected session first; a sibling in the same directory adds nothing.
    expect(detailContextOrder(sessions, 's2')).toEqual(['s2', undefined, 's3', 's4'])
    expect(detailContextOrder(sessions, undefined)).toEqual([undefined, 's1', 's3', 's4'])
    // Bounded on a large profile.
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, workingDirectory: `/p/${i}` }))
    expect(detailContextOrder(many, 'm7')).toHaveLength(8)
    expect(detailContextOrder(many, 'm7').slice(0, 2)).toEqual(['m7', undefined])
  })
})

describe("MCP-W2 asks each runtime's model for the name THAT model is handed (F1.153)", () => {
  it('the codex model spelling is the measured one, and it is not the host row name', () => {
    // SIT-11 codex driver, packaged 1.40.0, verbatim: C4's model listed and
    // called this name, and the host recorded the row under the second.
    expect(modelToolName(EXPECTED.pluginEchoWire, 'codex')).toBe('plugin_cdp_echo_probe_echo__whoami')
    expect(proxyToolName(EXPECTED.pluginEchoWire, 'codex')).toBe('mcp__sources__plugin_cdp-echo-probe_echo__whoami')
    // A3, a built-in with no hyphen: the model's `dpGitlab__dp_gitlab_whoami`.
    expect(modelToolName('dpGitlab', 'codex', 'dp_gitlab_whoami')).toBe('dpGitlab__dp_gitlab_whoami')
    // On pi and claude the two names are one name.
    for (const runtime of ['pi', 'claude'] as const) {
      expect(modelToolName(EXPECTED.pluginEchoWire, runtime)).toBe(proxyToolName(EXPECTED.pluginEchoWire, runtime))
    }
  })

  it('leaves the pi and claude prompts byte-for-byte what passed 9/9, and changes only codex', () => {
    const OLD_CALL = 'Call the tool mcp__plugin_cdp-echo-probe_echo__whoami with no arguments, then reply with exactly what it returned and nothing else. '
      + 'Do not read any file and do not guess: if the tool call fails, reply TOOL-FAILED plus the error.'
    const OLD_TOOLS = 'Line 1: TOOLS= followed by every tool name you can call that starts with mcp__, comma-separated, or NONE. '
    for (const runtime of ['pi', 'claude'] as const) {
      expect(callPrompt(runtime)).toBe(OLD_CALL)
      expect(inventoryToolsLine(runtime)).toBe(OLD_TOOLS)
    }
    expect(callPrompt('codex')).toContain('Call the tool plugin_cdp_echo_probe_echo__whoami with no arguments')
    expect(callPrompt('codex')).not.toContain('mcp__sources__')
    // The measured `TOOLS=NONE`: codex's names do not start with `mcp__`.
    expect(inventoryToolsLine('codex')).not.toContain('starts with mcp__')
  })

  it("reads each runtime's own TOOLS line for its own spellings, and the host's spelling is not the codex model's", () => {
    const pi = modelSurfaceExpectations('pi')
    // SIT-11 pi evidence, verbatim: `pi-f3-sanitized` and `pi-f3-hash-fallback`.
    expect('mcp__my_server_v2__whoami').toContain(pi.sanitized)
    expect(pi.hashFallback.test('mcp__server-ab518e32f3__whoami')).toBe(true)
    const codex = modelSurfaceExpectations('codex')
    // C4's turn-1 answer, verbatim.
    expect('plugin_cdp_echo_probe_echo__whoami').toContain(codex.echo)
    expect(codex.hashFallback.test('server_ab518e32f3__whoami')).toBe(true)
    // The control: the HOST's spelling of the echo tool is not accepted as the
    // codex model's — accepting either would paper over F1.155's divergence.
    expect('mcp__sources__plugin_cdp-echo-probe_echo__whoami'.includes(codex.echo)).toBe(false)
    expect(codex.hashFallback.test('mcp__sources__server-ab518e32f3__whoami')).toBe(false)
  })

  it('F1.391 — every runtime\'s hash-fallback pattern accepts that runtime\'s own name for 200 random server-<10 hex> wires', () => {
    for (const runtime of ['pi', 'claude', 'codex'] as const) {
      const { hashFallback } = modelSurfaceExpectations(runtime)
      const misses = Array.from({ length: 200 }, () => crypto.randomUUID().replace(/-/g, '').slice(0, 10))
        .map(hex => modelToolName(`${EXPECTED.scopedCyrillicWirePrefix}${hex}`, runtime))
        .filter(name => !hashFallback.test(name))
      expect(misses, runtime).toEqual([])
    }
  })

  it('still asserts the dispatch on the HOST row name, and records the two names every run', () => {
    const src = readFileSync(new URL('./cases/mcp-w2.ts', import.meta.url).pathname, 'utf8')
    expect(src).toContain('const expectedEchoTool = proxyToolName(EXPECTED.pluginEchoWire, runtime.id)')
    expect(src).toContain('const mintedCalls = toolMessages.filter(m => m.toolName === expectedTool)')
    expect(src).toContain('sendPrompt(session, key, callPrompt(runtime.id), 240_000)')
    expect(src).toContain("'Answer with two lines and nothing else. ' + inventoryToolsLine(runtime.id)")
    expect(src).toContain('`${name}-model-vs-host-name`')
  })
})

/**
 * F1.154 (+ WJ-n P-WJ-n-3) — PLUGIN-INSTALL-RUNTIMES' reach detector, which
 * SIT-11 found could not fail: `called` was `JSON.stringify(rows).includes(wire)`
 * and `nonce` was `/CDP-WHOAMI|whoami/i` over the same blob, and the case's OWN
 * prompt — a user row — spells the wire name, whose suffix is `whoami`.
 */
describe('PLUGIN-INSTALL-RUNTIMES reads the reach off the tool ROW and its nonce (F1.154)', () => {
  const at = 1_758_600_000_000
  const user = (family: 'claude' | 'codex'): TranscriptMessage => ({ id: 'u', role: 'user', content: reachPrompt(family), timestamp: at })
  const toolRow = (toolName: string, toolResult: string): TranscriptMessage =>
    ({ id: 't', role: 'tool', content: '', toolName, toolResult, toolStatus: 'completed', timestamp: at + 1 })

  it("asks the codex model for the name IT is handed, and keys the dispatch on the host's", () => {
    expect(reachNames('codex')).toEqual({
      asked: 'plugin_cdp_echo_probe_echo__whoami',
      hostRow: 'mcp__sources__plugin_cdp-echo-probe_echo__whoami',
    })
    expect(reachPrompt('codex')).toContain('Call the tool plugin_cdp_echo_probe_echo__whoami with no arguments')
    expect(reachPrompt('codex')).not.toContain('mcp__sources__')
    // On claude the two names are one name, and it is what QL9's 1.36.0 PASS called.
    expect(reachNames('claude')).toEqual({
      asked: 'mcp__plugin_cdp-echo-probe_echo__whoami',
      hostRow: 'mcp__plugin_cdp-echo-probe_echo__whoami',
    })
  })

  it("cannot be satisfied by the case's own prompt — the tautology SIT-11 refuted", () => {
    for (const family of ['claude', 'codex'] as const) {
      const rows = [user(family), { id: 'a', role: 'assistant', content: 'CDP-WHOAMI whoami', timestamp: at + 2 }]
      // The CONTROL: the old detector's two reads are both true over this transcript.
      const blob = JSON.stringify(rows)
      expect(blob.includes(reachNames(family).asked) && /CDP-WHOAMI|whoami/i.test(blob)).toBe(true)
      expect(readReach(rows, reachNames(family).hostRow)).toMatchObject({ called: false, nonce: undefined })
    }
  })

  it('goes red on a stopped fixture server, and on a nonce in some OTHER tool\'s row', () => {
    const { hostRow } = reachNames('codex')
    const stopped = readReach([user('codex'), toolRow(hostRow, 'MCP error -32000: Connection closed')], hostRow)
    expect(stopped).toMatchObject({ called: true, nonce: undefined })
    const elsewhere = readReach([user('codex'), toolRow('mcp__sources__t_tracker__whoami', 't-tracker T-X nonce=0123456789ab')], hostRow)
    expect(elsewhere).toMatchObject({ called: false, nonce: undefined })
    expect(elsewhere.toolRows).toEqual(['mcp__sources__t_tracker__whoami'])
  })

  it('reads the per-call nonce out of the host-named row when a server answered', () => {
    const { hostRow } = reachNames('codex')
    const reading = readReach([user('codex'), toolRow(hostRow, 'plugin-echo G6PLUGIN-ABCDEF012345 nonce=2ff7b644afd6')], hostRow)
    expect(reading).toMatchObject({ called: true, nonce: '2ff7b644afd6' })
  })
})

/**
 * F1.262 (origin WJ-x P-WJ-x-4) — the case's docblock promised that a model
 * which declines the reach prompt is BLOCKED, never FAIL, while its reach checks
 * went red on ANY miss. The miss is now classified by AGENT-INSTALL's own
 * classifier (`classifyInstallMiss`), and only the kinds that measure the MODEL
 * or the turn shape block; a miss that measures the PRODUCT stays a failure.
 */
describe('PLUGIN-INSTALL-RUNTIMES classifies a reach miss before scoring it (F1.262)', () => {
  const at = 1_758_600_000_000
  const user = (family: 'claude' | 'codex'): TranscriptMessage => ({ id: 'u', role: 'user', content: reachPrompt(family), timestamp: at })
  const said = (content: string): TranscriptMessage => ({ id: 'a', role: 'assistant', content, timestamp: at + 2 })
  const row = (toolName: string, toolStatus = 'completed', toolResult = ''): TranscriptMessage =>
    ({ id: 't', role: 'tool', content: '', toolName, toolResult, toolStatus, timestamp: at + 1 })

  it('a model that declines is BLOCKED, with the classifier\'s reason', () => {
    for (const family of ['claude', 'codex'] as const) {
      const { hostRow } = reachNames(family)
      const miss = classifyReachMiss([user(family), said('I will not run that.')], hostRow)
      expect(miss).toMatchObject({ verdict: 'blocked', kind: 'declined' })
      expect(miss.reason).toContain('measures the MODEL')
    }
  })

  it('a load parked on a card, and a tool callable only from the next message, are BLOCKED too', () => {
    const { hostRow } = reachNames('claude')
    expect(classifyReachMiss([user('claude'), row('mcp__tool_load', 'executing')], hostRow))
      .toMatchObject({ verdict: 'blocked', kind: 'load-parked' })
    expect(classifyReachMiss([user('claude'), row('mcp__tool_load'), said('It is callable from your next message.')], hostRow))
      .toMatchObject({ verdict: 'blocked', kind: 'loaded-not-callable' })
  })

  it('a turn that errored before any reply is BLOCKED on the error, never read as a decline', () => {
    const { hostRow } = reachNames('codex')
    const miss = classifyReachMiss([user('codex')], hostRow, 'gateway 503: upstream unavailable')
    expect(miss).toMatchObject({ verdict: 'blocked', kind: 'turn-error' })
    expect(miss.reason).toContain('gateway 503')
  })

  it('a miss that measures the PRODUCT stays a FAIL: the tool absent from the toolset, or called under another name', () => {
    const { hostRow } = reachNames('codex')
    expect(classifyReachMiss([user('codex'), said("I don't have access to the tool you named.")], hostRow))
      .toMatchObject({ verdict: 'fail', kind: 'tools-absent' })
    // The model's own name, dispatched as-is: the host did not map it to its row name.
    const misrouted = classifyReachMiss([user('codex'), row('plugin_cdp_echo_probe_echo__whoami')], hostRow)
    expect(misrouted).toMatchObject({ verdict: 'fail', kind: 'misrouted' })
    expect(misrouted.reason).toContain('plugin_cdp_echo_probe_echo__whoami')
    // CONTROL: another server's whoami is not the echo tool, so it is not a misroute.
    expect(classifyReachMiss([user('codex'), row('mcp__sources__t_tracker__whoami'), said('Done.')], hostRow).kind)
      .toBe('declined')
  })
})

/**
 * F1.462 (1), origin WJ-jj P-WJjj-2 — the install asked for a WORKSPACE through
 * `getWorkspaces()?.workspaces?.[0]?.id`, but `getWorkspaces()` returns a bare
 * `WorkspaceInfo[]` (`apps/electron/src/shared/types.ts`), so that branch was dead
 * and every run — SIT-11's included — installed GLOBALLY. DECIDED: global, the
 * Plugins page's own default for a plugin listing (`defaultInstallScope` →
 * `user/global` → `{ kind: 'global' }`), which is the "what a USER gets" this
 * case exists to drive, and what was measured.
 */
describe('PLUGIN-INSTALL-RUNTIMES installs with the Plugins page\'s default for a plugin: global (F1.462)', () => {
  it('asks for global activation, and carries no dead workspace branch', () => {
    const src = readFileSync(new URL('./cases/plugin-install-runtimes.ts', import.meta.url).pathname, 'utf8')
    expect(src).toContain("activateIn: { kind: 'global' }")
    // The CALL, not the bare name: a comment explaining the removal may name it.
    expect(src).not.toContain('window.electronAPI.getWorkspaces')
  })
})

/**
 * F1.183 (origin WJ-j P-WJ-j-2) — the permission-card helpers have ONE
 * definition each. They were written three times (`rs-103`, `rs-104`,
 * `rs-108`) and the copies had already drifted in what they read and in whether
 * a dismissal waited for the card to clear. The near-miss the census must not
 * count: `pkg-6` and `rs-100` declare `readCards`, plural — a different helper.
 */
describe('the permission-card helpers are defined once, in lib (F1.183)', () => {
  const HELPERS = ['readCard', 'pressCard', 'ensureNoCard', 'shellArm'] as const
  const CASE_DIR = new URL('./cases/', import.meta.url).pathname
  const LIB_DIR = new URL('./lib/', import.meta.url).pathname
  const declares = (source: string, name: string): number =>
    (source.match(new RegExp(`async function ${name}\\(`, 'g')) ?? []).length

  it('no case file declares one, and lib/permission-card.ts declares each exactly once', () => {
    const caseFiles = readdirSync(CASE_DIR).filter(name => name.endsWith('.ts'))
    const libFiles = readdirSync(LIB_DIR).filter(name => name.endsWith('.ts'))
    // Anti-vacuum: the directory read found the cases, and the plural near-miss IS there to be not-counted.
    expect(caseFiles.length).toBeGreaterThan(100)
    expect(readFileSync(join(CASE_DIR, 'pkg-6.ts'), 'utf8')).toContain('async function readCards(')
    for (const name of HELPERS) {
      const inCases = caseFiles.filter(file => declares(readFileSync(join(CASE_DIR, file), 'utf8'), name) > 0)
      expect(inCases, `${name} declared in cases/`).toEqual([])
      const inLib = libFiles.flatMap(file => Array(declares(readFileSync(join(LIB_DIR, file), 'utf8'), name)).fill(file))
      expect(inLib, `${name} declared in lib/`).toEqual(['permission-card.ts'])
    }
  })
})

/**
 * F1.184 (origin WJ-j P-WJ-j-3, DA2.18's residue) — `run.ts --check` holds
 * `SITTING` against the checklist. Not a gate over the real tree, by the rule
 * this file records beside `takes no checklist id…`: a new case's row arrives
 * after the case, so the check is the controller's to run. What is pinned here
 * is the logic (a fabricated checklist) and that the CLI's exit code is its own
 * printed verdict (the real tree, whatever it holds today).
 */
describe('run.ts --check holds SITTING against the checklist (F1.184)', () => {
  const CHECKLIST = [
    '| Case | File | What | Last run | Verdict | Note |',
    '| --- | --- | --- | --- | --- | --- |',
    '| RS-02 | `rs-02.ts` | listed and driven | — | owed | row P6.1 |',
    '| RS-03 | `rs-03.ts` | a driving case the runner does not name | — | owed | row P6.2 |',
    '| RS-04 | *case owed (F1.1)* | not written yet | — | owed | row P6.3 |',
    '| RS-05 | `rs-05.ts` | a recipe | — | owed | row P6.4 |',
    '| AGT-1 | `agt-1.ts` | a WAVE row, never read in the reverse direction | — | PASS | |',
    '| RS-6 is prose inside a cell, not a row id |',
  ].join('\n')
  const kinds: Record<string, 'drive' | 'recipe' | 'absent'> = { 'RS-02': 'drive', 'RS-03': 'drive', 'RS-04': 'absent', 'RS-05': 'recipe' }

  it('names a SITTING id with no row, and a driving row SITTING does not name', () => {
    const drift = sittingChecklistDrift(['RS-01', 'RS-02'], CHECKLIST, id => kinds[id] ?? 'absent')
    expect(drift).toEqual({
      sittingWithoutRow: ['RS-01'],
      rowsNotInSitting: ['RS-03'],
      rowsOwed: ['RS-04'],
      rowsRecipe: ['RS-05'],
    })
  })

  it('names nothing when the two agree, and never counts a recipe or an owed row as drift', () => {
    const drift = sittingChecklistDrift(['RS-02', 'RS-03'], CHECKLIST, id => kinds[id] ?? 'absent')
    expect([...drift.sittingWithoutRow, ...drift.rowsNotInSitting]).toEqual([])
    expect(drift.rowsOwed).toEqual(['RS-04'])
  })

  it('the CLI exits 1 exactly when it printed a drift, on the real tree', () => {
    // From THIS directory, where no bunfig.toml sits, and without the test runner's
    // NODE_ENV: from the repo root the child would take the root bunfig's `bun run`
    // preload, whose config-dir guard refuses a `NODE_ENV=test` process with no
    // isolated config dir (measured on this test's first run: exit 1, empty stdout).
    const env: Record<string, string | undefined> = { ...process.env }
    delete env.NODE_ENV
    const run = Bun.spawnSync([process.execPath, 'run', join(import.meta.dir, 'run.ts'), '--check'], {
      cwd: import.meta.dir,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = run.stdout.toString()
    // Anti-vacuum: the checklist WAS read (an unreadable one exits 2 and prints neither line).
    expect(out, `exit ${run.exitCode}; stderr: ${run.stderr.toString().slice(0, 600)}`).toContain('SITTING ids with NO checklist row')
    expect(out).toContain('checklist RS rows whose case DRIVES but SITTING does not name')
    const drifted = /NO checklist row[^:]*: (?!\(none\))/.test(out) || /does not name[^:]*: (?!\(none\))/.test(out)
    expect(run.exitCode).toBe(drifted ? 1 : 0)
  })
})

/**
 * F1.205 (origin WJ-p P-WJ-p-1) — the claude child's model-alias names are
 * contaminating names. `buildClaudeSubprocessEnv` does not strip an inherited
 * `ANTHROPIC_DEFAULT_*_MODEL` (read 2026-09-23, `lib/app-env.ts` header), so the
 * launcher and the test lock — both of which read this list — must delete them.
 * The expected names are DERIVED from the product module that writes them, not
 * restated, so an alias the SDK grows and the product starts writing lands here
 * as a red rather than as an unlisted name.
 */
describe('the contaminating-name list carries every claude model alias the product writes (F1.205)', () => {
  it('every ANTHROPIC_DEFAULT_<ALIAS>_MODEL claude-agent.ts spells is on the list', () => {
    const source = readFileSync(new URL('../../packages/shared/src/agent/claude-agent.ts', import.meta.url).pathname, 'utf8')
    const written = [...new Set(source.match(/\bANTHROPIC_DEFAULT_[A-Z]+_MODEL\b/g) ?? [])].sort()
    // Anti-vacuum: the product module really spells the aliases this row is about.
    expect(written).toEqual(expect.arrayContaining(['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL']))
    const listed = new Set(CONTAMINATING_ENV_NAMES.map(entry => entry.name))
    expect(written.filter(name => !listed.has(name))).toEqual([])
    // None of them may be marked inert: each has a reader, and the block reason must fire on it.
    expect(CONTAMINATING_ENV_NAMES.filter(entry => written.includes(entry.name) && entry.files === 0)).toEqual([])
  })
})

/**
 * DN-110's launcher half of F1.825 (DECISIONS.md: the prefix sweep "under any
 * option") — the README's `env -u` list is `launcherUnsetNames()`: the measured
 * table PLUS every `CLAUDE*` / `ANTHROPIC_*` / `MCP_*` / `DISABLE_*` name of the
 * launching shell. RC #1's `CLAUDE_CODE_TERMINAL_MCP_TOOLS` is the name no census
 * had scored, so it is the positive arm.
 */
describe('the launcher deletes a prefix sweep of the launching shell, names only (F1.852 lane, DN-110)', () => {
  it('sweeps every CLAUDE*/ANTHROPIC_*/MCP_*/DISABLE_* name and always carries the measured table', () => {
    const shell = {
      CLAUDE_CODE_TERMINAL_MCP_TOOLS: 'x', CLAUDECODE: '1', ANTHROPIC_API_KEY: 'secret-value',
      MCP_TIMEOUT: '5', DISABLE_TELEMETRY: '1',
      NESSY_CONFIG_DIR: '/rig/config', CODEX_HOME: '/c', PATH: '/bin', XCLAUDE_X: '1', MY_ANTHROPIC_KEY: 'k',
    }
    const names = launcherUnsetNames(shell)
    expect(names).toEqual(expect.arrayContaining([
      'CLAUDE_CODE_TERMINAL_MCP_TOOLS', 'CLAUDECODE', 'ANTHROPIC_API_KEY', 'MCP_TIMEOUT', 'DISABLE_TELEMETRY',
    ]))
    // Boundary: the launcher's own name, codex's, and a name that merely CONTAINS a prefix survive.
    for (const kept of ['NESSY_CONFIG_DIR', 'CODEX_HOME', 'PATH', 'XCLAUDE_X', 'MY_ANTHROPIC_KEY']) {
      expect(names).not.toContain(kept)
    }
    // Names, never values.
    expect(names.join(' ')).not.toContain('secret-value')
    // An empty shell still deletes the whole measured table.
    expect(launcherUnsetNames({})).toEqual(CONTAMINATING_ENV_NAMES.map(entry => entry.name).sort())
  })

  it("the README's launcher derives its -u list from launcherUnsetNames, not from the table alone", () => {
    const readme = readFileSync(new URL('./README.md', import.meta.url).pathname, 'utf8')
    const launcher = readme.split('\n').filter(line => line.startsWith('env $(bun -e '))
    expect(launcher).toHaveLength(1)
    expect(launcher[0]).toContain('launcherUnsetNames')
  })
})

/**
 * F1.852 — `run.ts` refuses to start when the app on the CDP port runs on a
 * different config dir than the one every case will read. SIT-w (2026-09-25,
 * RS-105) ran a case without `NESSY_CONFIG_DIR` on a relocated rig and it read
 * the owner's real `~/.nessy-agent`.
 */
describe('run.ts refuses a run whose config dir is not the app\'s (F1.852)', () => {
  const home = '/nonexistent-home-f1852'
  const app = (...overrides: Array<string | undefined>): AppConfigDirReading => ({
    port: '9223',
    processes: overrides.map((override, index) => ({ pid: 100 + index, override })),
    unreadable: [],
  })

  it('reads the launched NESSY_CONFIG_DIR from ps eww text, a space inside the path included', () => {
    const ps = '  PID   TT  STAT      TIME COMMAND\n'
      + '42 ??  S  0:01.00 /Applications/Nessy Desktop.app/Contents/MacOS/Nessy Desktop --remote-debugging-port=9223 '
      + 'HOME=/Users/o NESSY_CONFIG_DIR=/tmp/rig one/config NESSY_DEBUG=1 PATH=/bin\n'
    expect(launchedConfigDir(ps)).toBe('/tmp/rig one/config')
    expect(launchedConfigDir(ps.replace(' NESSY_CONFIG_DIR=/tmp/rig one/config', ''))).toBeUndefined()
    expect(launchedConfigDir(ps.replace('/tmp/rig one/config', ''))).toBeUndefined()
  })

  it('refuses in both directions: run unset against a relocated app, and run relocated against a default app', () => {
    const unset = configDirVerdict(undefined, app('/rig/config'), home)
    expect(unset.verdict).toBe('mismatch')
    expect(unset.line).toContain('NESSY_CONFIG_DIR is UNSET')
    expect(unset.line).toContain('Export NESSY_CONFIG_DIR=/rig/config')
    const relocated = configDirVerdict('/rig/config', app(undefined), home)
    expect(relocated.verdict).toBe('mismatch')
    expect(relocated.line).toContain(`runs on ${home}/.nessy-agent`)
  })

  it('lets the same directory through however it is spelled, and does not compare without a readable app', () => {
    expect(configDirVerdict(undefined, app(undefined), home).verdict).toBe('match')
    expect(configDirVerdict('/rig/config/', app(' /rig/config'), home).verdict).toBe('match')
    // The realpath arm: tmpdir() is a symlinked spelling on macOS; mkdtemp's
    // answer and its realpath must compare equal wherever they differ.
    const dir = mkdtempSync(join(tmpdir(), 'f1852-'))
    expect(configDirVerdict(dir, app(realpathSync(dir)), home).verdict).toBe('match')
    expect(configDirVerdict(undefined, { port: '9223', processes: [], unreadable: [] }, home).verdict).toBe('not-compared')
    expect(configDirVerdict(undefined, { port: '9223', processes: [], unreadable: [7] }, home).line).toContain('could not be read')
  })

  // End to end through the real runner: a listener launched on a rig config dir,
  // and `run.ts` started WITHOUT the variable. Needs `lsof` to find the listener.
  it.skipIf(!Bun.which('lsof'))('the runner exits 2 and runs nothing when the listener on the port has another config dir', async () => {
    const rig = mkdtempSync(join(tmpdir(), 'f1852-rig-'))
    const listener = Bun.spawn([process.execPath, '-e',
      "const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('no', { status: 404 }) }); console.log(s.port)"], {
      cwd: rig,
      env: { HOME: process.env.HOME ?? rig, PATH: process.env.PATH ?? '/usr/bin:/bin', NESSY_CONFIG_DIR: join(rig, 'config') },
      stdout: 'pipe',
      stderr: 'ignore',
    })
    try {
      const reader = listener.stdout.getReader()
      let text = ''
      while (!/^\d+\n/.test(text)) {
        const chunk = await reader.read()
        if (chunk.done) break
        text += new TextDecoder().decode(chunk.value)
      }
      const port = text.trim()
      // Positive control on the instrument: the reading sees the listener and its dir.
      const reading = readAppConfigDirs(port)
      expect(reading.processes.map(entry => entry.override)).toEqual([join(rig, 'config')])
      const run = Bun.spawn([process.execPath, 'run', join(import.meta.dir, 'run.ts'), 'RS-47'], {
        cwd: rig,
        env: { HOME: process.env.HOME ?? rig, PATH: process.env.PATH ?? '/usr/bin:/bin', NESSY_CDP_PORT: port, NESSY_CDP_TIMEOUT_MS: '2000' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
      expect(err, `exit ${code}; stdout: ${out.slice(0, 400)}`).toContain('REFUSED')
      expect(code).toBe(2)
      expect(out).not.toContain('WAVE SUMMARY')

      // F1.1141 (origin DN-195) — the same refusal when a case FILE is run directly, not through `run.ts`:
      // `runCase` takes the verdict once per case process and reports BLOCKED, exit 2, before it attaches.
      // Before it, the case attached to whatever answered the port and reported FAIL on an attach error.
      const direct = Bun.spawn([process.execPath, 'run', join(import.meta.dir, 'cases', 'rs-47.ts')], {
        cwd: rig,
        env: { HOME: process.env.HOME ?? rig, PATH: process.env.PATH ?? '/usr/bin:/bin', NESSY_CDP_PORT: port, NESSY_CDP_TIMEOUT_MS: '2000' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [directOut, directErr, directCode] = await Promise.all([
        new Response(direct.stdout).text(), new Response(direct.stderr).text(), direct.exited,
      ])
      const line = directOut.split('\n').find(row => row.startsWith(RESULT_PREFIX)) ?? ''
      const result = (line ? JSON.parse(line.slice(RESULT_PREFIX.length)) : {}) as { status?: string, error?: string }
      expect(result.status, `exit ${directCode}; stderr: ${directErr.slice(-600)}`).toBe('BLOCKED')
      expect(result.error ?? '').toContain('REFUSED')
      expect(directCode).toBe(2)
    } finally {
      listener.kill()
    }
  })
})

/**
 * F1.156 + F1.148 — RS-106's body-unique detector, pinned against the SHIPPED
 * skills rather than against a fixture: the denominator is the directory, each
 * body's opening (what a faithful probe reply quotes) must score, the same
 * opening must not score through the description the roster already shows, and
 * a generic refusal must score nothing against any of the seven — the case's
 * negative arm would otherwise prove nothing.
 */
describe('RS-106 detects a skill BODY in a reply, and nothing else (F1.156)', () => {
  const skillsDir = new URL('../../apps/electron/resources/skills/', import.meta.url).pathname
  const names = bundledSkillNames(skillsDir)
  const skills = names.map(name => [name, parseSkillFile(readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8'))] as const)

  it('reads the denominator from the directory — seven today, none of them empty', () => {
    // A reading with a date (2026-09-23): the directory, not this number, is the denominator.
    expect(names).toEqual(['code-review', 'loop', 'plugin-creator', 'security-review', 'simplify', 'skill-creator', 'workflow-authoring'])
    for (const [, skill] of skills) {
      expect(skill.description.length).toBeGreaterThan(20)
      expect(skill.body.length).toBeGreaterThan(200)
    }
    // The partition SIT-11 measured on claude's own roster, read off the files.
    expect(skills.filter(([, skill]) => !skill.modelInvocable).map(([name]) => name))
      .toEqual(['code-review', 'security-review', 'simplify'])
  })

  it('scores each shipped body\'s opening, and never through the description the roster shows', () => {
    for (const [name, skill] of skills) {
      const windows = bodyWindows(skill.body, [skill.description, probePrompt(name)])
      expect(bodyEvidence(bodyOpening(skill.body), windows).length, name).toBeGreaterThan(0)
      // The description is excluded by construction: quoting it scores nothing.
      expect(bodyEvidence(skill.description, windows), name).toEqual([])
    }
  })

  it('NEGATIVE: a generic refusal, the probe itself and the review-shaped prompt score nothing against any body', () => {
    const refusal = 'I have not been given any instructions by a /code-review skill in this conversation, so there is nothing '
      + 'to quote. If you run the skill first I can tell you what it says.'
    for (const [name, skill] of skills) {
      const windows = bodyWindows(skill.body, [skill.description, probePrompt(name)])
      expect(bodyEvidence(refusal, windows), name).toEqual([])
      expect(bodyEvidence(probePrompt(name), windows), name).toEqual([])
      expect(bodyEvidence(REVIEW_SHAPED_PROMPT, windows), name).toEqual([])
    }
  })

  it('reads frontmatter the way the files write it', () => {
    const parsed = parseSkillFile('---\nname: X\ndescription: "Does x."\ndisable-model-invocation: true\n---\n\n# X\n\nBody one. Body two. Body three.\n')
    expect(parsed).toMatchObject({ description: 'Does x.', modelInvocable: false })
    expect(bodyOpening(parsed.body)).toBe('Body one. Body two.')
    expect(parseSkillFile('---\ndescription: y\n---\nbody').modelInvocable).toBe(true)
  })
})

/**
 * F1.148 surface A + F1.157 — RS-105's readers, pinned without the app: the
 * roster comparison A1 makes against the shipped definitions, the dp-less
 * branch's verdict (which is what keeps a machine WITH dp from passing an arm it
 * never reached), and the three transcript readers the turn arms key on.
 */
describe('RS-105 reads the built-in MCP surface, and says when the dp-less branch is out of reach (F1.148, F1.157)', () => {
  const definitions = [{ name: 'a', defaultEnabled: false }, { name: 'b', defaultEnabled: false }]

  it('compares the served list to the definitions: missing, extra, order, defaults, and untouched-at-default', () => {
    const served = [{ name: 'a', defaultEnabled: false, enabled: false }, { name: 'b', defaultEnabled: false, enabled: false }]
    expect(compareBuiltinRoster(served, definitions)).toEqual({ missing: [], extra: [], orderMatches: true, defaultMismatch: [], offDefault: [] })
    const drifted = [{ name: 'b', defaultEnabled: true, enabled: true }, { name: 'z', defaultEnabled: false, enabled: false }]
    expect(compareBuiltinRoster(drifted, definitions)).toEqual({
      missing: ['a'], extra: ['z'], orderMatches: false, defaultMismatch: ['b'], offDefault: [],
    })
    // A server ON with no stored preference is off its default; the same server with
    // a stored `true` is the user's own choice and is not flagged.
    const on = [{ name: 'a', defaultEnabled: false, enabled: true }, { name: 'b', defaultEnabled: false, enabled: false }]
    expect(compareBuiltinRoster(on, definitions).offDefault).toEqual(['a'])
    expect(compareBuiltinRoster(on, definitions, { a: true }).offDefault).toEqual([])
  })

  it('drives the dp-less branch only when the app says unavailable, and names why it cannot otherwise', () => {
    expect(dpLessBranch({ available: false, fallbackExists: true, expectNoDp: false }).verdict).toBe('drive')
    const here = dpLessBranch({ available: true, fallbackExists: true, expectNoDp: false })
    expect(here.verdict).toBe('not-drivable-here')
    expect(here.reason).toContain(DP_FALLBACK_PATH)
    expect(dpLessBranch({ available: true, fallbackExists: false, expectNoDp: false }).reason).toContain('NESSY_DP')
    // NEGATIVE: an operator who promised a dp-less machine is contradicted, never passed.
    expect(dpLessBranch({ available: true, fallbackExists: false, expectNoDp: true }).verdict).toBe('contradiction')
  })

  it('finds a tool row however the runtime prefixes it, and prefers the completed one', () => {
    const row = (toolName: string, toolStatus: string): TranscriptMessage =>
      ({ id: toolName + toolStatus, role: 'tool', content: '', toolName, toolStatus, timestamp: 0 })
    expect(toolRow([row('automation_list', 'completed')], 'automation_list')?.toolName).toBe('automation_list')
    expect(toolRow([row('mcp__session__remember', 'error'), row('mcp__session__remember', 'completed')], 'remember')?.toolStatus).toBe('completed')
    expect(toolRow([row('mcp__sources__dpGitlab__dp_gitlab_whoami', 'completed')], 'dp_gitlab_whoami')).toBeDefined()
    // NEGATIVE: a longer name that merely ENDS in the same letters is not the tool.
    expect(toolRow([row('mcp__session__not_remember', 'completed')], 'remember')).toBeUndefined()
  })

  it('reads remember\'s own path, keeps an identity out of the record, and finds a sentence by its opening', () => {
    expect(savedMemoryPath('Saved memory to /cfg/workspaces/w/sessions/s1/data/MEMORY.md')).toBe('/cfg/workspaces/w/sessions/s1/data/MEMORY.md')
    expect(savedMemoryPath('Memory is disabled for this session')).toBeUndefined()
    const shape = resultShape('stdout: someone\n  Name: A Person\n  Email: a@example.invalid')
    expect(shape.hasStdout).toBe(true)
    expect(JSON.stringify(shape)).not.toContain('Person')
    expect(sentenceOpening('The built-in Nessy MCP servers need the `dp` CLI, which was not found', 4)).toBe('The built-in Nessy MCP')
  })
})

/**
 * F1.148 surface C — RS-107's fixture and readers. The bundle is the one SIT-11's
 * claude and codex lanes minted by hand and threw away; these arms pin the three
 * properties its controls stand on: the command token lives ONLY in the body, both
 * hooks are declared and their commands really append their marker when a shell
 * runs them, and the case's readers score a firing only when the file grew by
 * its own marker and a card named it first.
 */
describe('RS-107 carries the command-and-hook bundle and reads it honestly (F1.148)', () => {
  it('builds market-c with the token in the command BODY only, and both hooks declared', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rs107-fixture-'))
    const fixture = await buildCmdHookFixture(root)
    const plugin = join(fixture.market, CMDHOOK.pluginId)
    const command = readFileSync(join(plugin, 'commands', `${CMDHOOK.commandName}.md`), 'utf8')
    const body = command.slice(command.indexOf('---', 3) + 3)
    expect(body).toContain(fixture.commandToken)
    // Nothing a roster, a manifest or a listing shows may carry it.
    for (const other of [
      command.slice(0, command.indexOf('---', 3)),
      readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'),
      readFileSync(join(fixture.market, 'marketplace.json'), 'utf8'),
    ]) expect(other).not.toContain(fixture.commandToken)
    const hooks = JSON.parse(readFileSync(join(plugin, 'hooks', 'hooks.json'), 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>
    }
    expect(Object.keys(hooks.hooks).sort()).toEqual(['PostToolUse', 'PreToolUse'])
    expect(hooks.hooks.PreToolUse![0]!.matcher).toBe('Bash')
    // No MCP server: the bundle is a command and two hooks, exactly the SIT-11 shape.
    expect(existsSync(join(plugin, '.mcp.json'))).toBe(false)
    // POSITIVE CONTROL on the hit-file instrument: each hook command, run by a
    // shell, appends ITS marker — so "the file did not grow" can only mean "not run".
    for (const [event, marker, file] of [
      ['PreToolUse', fixture.preMarker, fixture.preHitFile],
      ['PostToolUse', fixture.postMarker, fixture.postHitFile],
    ] as const) {
      const ran = Bun.spawnSync(['sh', '-c', hooks.hooks[event]![0]!.hooks[0]!.command])
      expect(ran.exitCode).toBe(0)
      expect(readFileSync(file, 'utf8')).toBe(`${marker}\n`)
    }
    const rebuilt = await buildCmdHookFixture(root)
    // A rebuild mints fresh markers and starts from empty hit files.
    expect(rebuilt.preMarker).not.toBe(fixture.preMarker)
    expect(existsSync(rebuilt.preHitFile)).toBe(false)
  })

  it('scores a firing only on growth by its own marker, and only when a card named it first', () => {
    expect(fired('', 'M1\n', 'M1')).toBe(true)
    expect(fired('M1\n', 'M1\n', 'M1')).toBe(false)
    // NEGATIVE: the file grew, but by somebody else's line.
    expect(fired('', 'OTHER\n', 'M1')).toBe(false)
    expect(unaskedFirings({ pre: true, post: true, cards: ["Bash: printf 'PRE' >> x"], preMarker: 'PRE', postMarker: 'POST' }))
      .toEqual(['PostToolUse'])
    expect(unaskedFirings({ pre: false, post: false, cards: [], preMarker: 'PRE', postMarker: 'POST' })).toEqual([])
  })

  it('matches the command row by name, keeps the control row, and holds the SIT-11 expectations per runtime', () => {
    expect(COMMAND_ROW.test('/cdp-cmdhook-probe:cdp-probe-cmd CDP fixture command')).toBe(true)
    expect(COMMAND_ROW.test('/cdp-probe-cmd CDP fixture command')).toBe(true)
    expect(COMMAND_ROW.test('/cdp-probe-cmdx something else')).toBe(false)
    expect(PALETTE_CONTROL_ROW.test('/code-review Review the current diff')).toBe(true)
    expect(expectedHooks('claude')).toEqual({ pre: true, post: undefined })
    expect(expectedHooks('codex')).toEqual({ pre: false, post: true })
    expect(expectedHooks('pi')).toEqual({ pre: undefined, post: undefined })
    // One line: the composer swallows a newline and sendPrompt would refuse the prompt.
    expect(HOOK_PROBE_PROMPT.includes('\n')).toBe(false)
  })
})

/**
 * F1.976 (origin WJ-crit-ttt P-3, and WJ-co-sit4 step 2 item 5) — two instrument
 * faults that each let a sitting read, or cause, the wrong thing.
 *
 * 1. The tracked `answerTrustGate` could only press "Trust project", so a lane
 *    that wanted "Keep restricted" wrote its own click — and SIT-an1's own click
 *    read the heading alone and restricted ANOTHER chat's folder, which tore that
 *    chat down. And the tracked folder check was itself a no-op: its path read
 *    matched no element of the shipped dialog, the empty read skipped the
 *    compare, and the click went ahead.
 * 2. `pressCard` reported "did not clear" whenever ANY card remained, so at an
 *    awaiting count of two a delivered press read as a failure — and SIT-an's
 *    `press.ts` retried on that word, pressing the NEXT card.
 */
describe('the trust gate answers explicitly, only for the folder its dialog names (F1.976)', () => {
  /** A page with the trust dialog up for `shown` — `''` is a dialog whose folder could not be read. */
  const fakeGate = (shown: string) => {
    const clicks: string[] = []
    let calls = 0
    let open = true
    const session = {
      call: async (expression: string) => {
        calls += 1
        if (expression.includes('.click()')) { clicks.push(expression); open = false; return true }
        if (expression.includes('return !Array.from')) return !open
        return open ? { present: true, path: shown } : { present: false }
      },
    }
    return { session: session as never as CdpSession, clicks, calls: () => calls }
  }
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'f1976-')))

  it('presses the button the caller NAMED — Keep restricted is no longer a hand-written click', async () => {
    const restrict = fakeGate(scratch)
    expect(await answerTrustGate(restrict.session, scratch, 'keep-restricted', 60)).toBe('answered')
    expect(restrict.clicks).toHaveLength(1)
    expect(restrict.clicks[0]).toContain('"keep restricted"')
    expect(restrict.clicks[0]).not.toContain('"trust folder"')
    // The other answer, on the same rig: the choice is the parameter, not the helper.
    const trust = fakeGate(scratch)
    expect(await answerTrustGate(trust.session, scratch, 'trust', 60)).toBe('answered')
    expect(trust.clicks[0]).toContain('"trust folder"')
  })

  it('NEGATIVE — a dialog naming ANOTHER folder is refused, whichever answer was asked (SIT-an1)', async () => {
    const other = join(scratch, 'ws-a')
    const restrict = fakeGate(other)
    await expect(answerTrustGate(restrict.session, join(scratch, 'ws-b'), 'keep-restricted', 60))
      .rejects.toThrow(`refusing-to-keep-restricted: the dialog is asking about ${other}`)
    expect(restrict.clicks).toEqual([])
  })

  it('NEGATIVE — a dialog whose folder cannot be read is refused, never answered unchecked', async () => {
    // The pre-fix helper skipped the compare on an empty read and clicked.
    const unread = fakeGate('')
    await expect(answerTrustGate(unread.session, scratch, 'keep-restricted', 60))
      .rejects.toThrow('trust-dialog-folder-unreadable')
    expect(unread.clicks).toEqual([])
  })

  it('refuses to TRUST a folder the harness did not mint, and still lets it be kept restricted', async () => {
    const checkout = realpathSync(new URL('../..', import.meta.url).pathname)
    const trust = fakeGate(checkout)
    await expect(answerTrustGate(trust.session, checkout, 'trust', 60)).rejects.toThrow('refusing-to-trust')
    // Refused before the page was asked anything.
    expect(trust.calls()).toBe(0)
    // Positive control on the same folder: restricting grants nothing, so the folder check alone guards it.
    const restrict = fakeGate(checkout)
    expect(await answerTrustGate(restrict.session, checkout, 'keep-restricted', 60)).toBe('answered')
  })

  /**
   * F1.1250 (SIT2-a) — the dialog is still up on the read right after the click and gone on the next. The helper
   * used to fall through to the silent-gate probe there, which saw the decision its own click had just persisted:
   * four calls out of four at the sitting read `not-shown (already decided: …)` after their whole timeout.
   */
  const lingeringGate = (shown: string | null) => {
    const clicks: string[] = []
    let open = shown !== null
    let closing = false
    const session = {
      call: async (expression: string) => {
        if (expression.includes('validateProjectDirectory')) return { ok: true, trustState: 'untrusted', items: null }
        if (expression.includes('.click()')) { clicks.push(expression); closing = true; return true }
        if (expression.includes('return !Array.from')) { const gone = !open; if (closing) open = false; return gone }
        return open ? { present: true, path: shown } : { present: false }
      },
    }
    return { session: session as never as CdpSession, clicks }
  }

  it('reports answered when its own click closed the dialog one read later (F1.1250)', async () => {
    const gate = lingeringGate(scratch)
    expect(await answerTrustGate(gate.session, scratch, 'keep-restricted', 1_500)).toBe('answered')
    expect(gate.clicks).toHaveLength(1)
  })

  it('NEGATIVE — with no dialog and no press, a decided folder still reads not-shown, never answered (F1.1250)', async () => {
    const gate = lingeringGate(null)
    expect(await answerTrustGate(gate.session, scratch, 'keep-restricted', 60)).toBe('not-shown (already decided: untrusted)')
    expect(gate.clicks).toEqual([])
  })

  it('reads the folder off the element the shipped dialog really renders it in, by its own test id (F1.991)', () => {
    const source = (file: string) => readFileSync(
      new URL(`../../apps/electron/src/renderer/components/workspace/${file}`, import.meta.url).pathname, 'utf8')
    const dialog = source('ProjectTrustDialog.tsx')
    const lines = dialog.split('\n')
    const at = lines.findIndex(line => line.trim() === '{project?.displayPath}')
    expect(at).toBeGreaterThan(0)
    // The opening tag right above the folder carries the test id the selector names, not a styling class...
    expect(TRUST_DIALOG_PATH_SELECTOR).toBe('[data-testid="project-trust-path"]')
    expect(lines[at - 1]).toContain('data-testid="project-trust-path"')
    // ...and nothing else the dialog renders carries it (the contributions list inside it has `font-mono` source
    // labels of its own), so `querySelector` can land on the folder and nowhere else.
    expect(dialog.indexOf('project-trust-path')).toBe(dialog.lastIndexOf('project-trust-path'))
    expect(source('ProjectContributionsList.tsx')).not.toContain('project-trust-path')
    expect(dialog).toContain('<ProjectContributionsList')
  })

  // UA12.123 (P-UAay-1): the harness used to match the gate by the ENGLISH text alone, so in a ru UI every trust
  // arm read `not-shown`. The copy now comes from BOTH locales' own files, and the matchers accept either.
  it('UA12.123 — the gate copy is the product\'s own, read from BOTH locale files (QUOTED_COPY)', () => {
    const locale = (file: string) => JSON.parse(readFileSync(
      new URL(`../../packages/shared/src/i18n/locales/${file}`, import.meta.url).pathname, 'utf8')) as Record<string, string>
    // The sets carry the strings the way a match uses them (whitespace-collapsed, case-folded); the key must
    // EXIST and be non-empty, or this pin would pass vacuously:
    const pick = (row: Record<string, string>, key: string): string => {
      expect(typeof row[key]).toBe('string')
      expect((row[key] ?? '').length).toBeGreaterThan(0)
      return row[key]!
    }
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
    const en = locale('en.json')
    const ru = locale('ru.json')
    expect(TRUST_GATE_TITLES).toContain(norm(pick(en, 'projectTrust.title')))
    expect(TRUST_GATE_TITLES).toContain(norm(pick(ru, 'projectTrust.title')))
    expect(TRUST_GATE_BUTTON.trust).toContain(norm(pick(en, 'projectTrust.trust')))
    expect(TRUST_GATE_BUTTON.trust).toContain(norm(pick(ru, 'projectTrust.trust')))
    expect(TRUST_GATE_BUTTON['keep-restricted']).toContain(norm(pick(en, 'projectTrust.keepRestricted')))
    expect(TRUST_GATE_BUTTON['keep-restricted']).toContain(norm(pick(ru, 'projectTrust.keepRestricted')))
  })

  it('UA12.123 — a fabricated ru-titled dialog is found, and the en one still is (P-UAay-1\'s control)', () => {
    expect(isTrustGateHeading('Доверять этой папке?')).toBe(true)
    expect(isTrustGateHeading('Trust this folder?')).toBe(true)
    // Whitespace and case are the dialog's to choose; the contributions heading is not the gate.
    expect(isTrustGateHeading('  доверять этой  папке? ')).toBe(true)
    expect(isTrustGateHeading('This folder provides')).toBe(false)
    expect(isTrustGateHeading('')).toBe(false)
    expect(isTrustGateHeading(null)).toBe(false)
    expect(isTrustGateButton('Доверять папке', 'trust')).toBe(true)
    expect(isTrustGateButton('Trust folder', 'trust')).toBe(true)
    expect(isTrustGateButton('Оставить ограниченным', 'keep-restricted')).toBe(true)
    expect(isTrustGateButton('Keep restricted', 'keep-restricted')).toBe(true)
    // The OTHER answer's button is not this answer's, and no button at all is nothing:
    expect(isTrustGateButton('Доверять папке', 'keep-restricted')).toBe(false)
    expect(isTrustGateButton('Keep restricted', 'trust')).toBe(false)
    expect(isTrustGateButton('', 'trust')).toBe(false)
  })

  it('UA12.123 — the finder embeds both locales\' copy in its page reads (source pin)', () => {
    const self = readFileSync(new URL('./lib/runtime-switch.ts', import.meta.url).pathname, 'utf8')
    // The dialog-present read and the gone read each match against the whole title set:
    expect(self.match(/JSON\.stringify\(TRUST_GATE_TITLES\.map\(normCopy\)\)/g)).toHaveLength(2)
    expect(self).toContain('JSON.stringify(TRUST_GATE_BUTTON[answer].map(normCopy))')
  })

  /**
   * UA12.123 follow-up (2026-10-08 verification): the arms above pin the exported helpers and the source, but
   * answerTrustGate matches IN THE PAGE with its own inline norm, which neither reaches — dropping `.toLowerCase()`
   * from those reads left every arm green while a real ru dialog went `not-shown`. This page EVALUATES each in-page
   * expression the way `CdpSession.call` does (an async function body) against a fabricated dialog DOM, so a broken
   * page-side matcher fails here.
   */
  const evaluatingGate = (title: string, buttons: readonly string[], folder: string) => {
    const clicked: string[] = []
    let open = true
    const field = { textContent: folder }
    const dialog = { querySelector: (selector: string) => (selector === TRUST_DIALOG_PATH_SELECTOR ? field : null) }
    const heading = { textContent: title, closest: (selector: string) => (selector === '[role="dialog"]' ? dialog : null) }
    const buttonEls = buttons.map(text => ({ innerText: text, textContent: text, click: () => { clicked.push(text); open = false } }))
    const document = {
      querySelectorAll: (selector: string) => {
        if (!open) return []
        if (selector === 'h1,h2,h3,[role="heading"]') return [heading]
        if (selector === 'button') return buttonEls
        throw new Error(`evaluatingGate: unexpected selector ${selector}`)
      },
    }
    const window = { electronAPI: { getSessions: async () => { throw new Error('no app behind this page') } } }
    const session = {
      call: async (body: string) =>
        // The page side of CdpSession.call (an async function body), run on the fake DOM:
        (new Function('document', 'window', `return (async () => { ${body} })()`) as (d: unknown, w: unknown) => Promise<unknown>)(document, window),
    }
    return { session: session as never as CdpSession, clicked }
  }
  const ruButtons = ['Доверять папке', 'Оставить ограниченным', 'Отмена'] as const
  const enButtons = ['Trust folder', 'Keep restricted', 'Cancel'] as const

  it('UA12.123 — the in-page reads, EVALUATED, find and answer a ru dialog and an en one (the page-side matcher)', async () => {
    const ruRestrict = evaluatingGate('Доверять этой папке?', ruButtons, scratch)
    expect(await answerTrustGate(ruRestrict.session, scratch, 'keep-restricted', 60)).toBe('answered')
    expect(ruRestrict.clicked).toEqual(['Оставить ограниченным'])
    const ruTrust = evaluatingGate('Доверять этой папке?', ruButtons, scratch)
    expect(await answerTrustGate(ruTrust.session, scratch, 'trust', 60)).toBe('answered')
    expect(ruTrust.clicked).toEqual(['Доверять папке'])
    const enRestrict = evaluatingGate('Trust this folder?', enButtons, scratch)
    expect(await answerTrustGate(enRestrict.session, scratch, 'keep-restricted', 60)).toBe('answered')
    expect(enRestrict.clicked).toEqual(['Keep restricted'])
    const enTrust = evaluatingGate('Trust this folder?', enButtons, scratch)
    expect(await answerTrustGate(enTrust.session, scratch, 'trust', 60)).toBe('answered')
    expect(enTrust.clicked).toEqual(['Trust folder'])
  })

  it('NEGATIVE — evaluated, a dialog whose heading is not the gate\'s title is never answered', async () => {
    const other = evaluatingGate('Доверять этой папке? Нет', ruButtons, scratch)
    expect(await answerTrustGate(other.session, scratch, 'keep-restricted', 60)).not.toBe('answered')
    expect(other.clicked).toEqual([])
  })

  // UA12.94 — the English gate says folder ("Trust this folder?", "Trust folder"), and the retired project copy is
  // no longer the gate: neither the exported helpers nor the page reads match it, so a finder still keyed to it
  // cannot pass by accident.
  it('UA12.94 — the retired "project" copy is not the gate any more (title, button, the whole title set)', () => {
    expect(isTrustGateHeading('Trust this project folder?')).toBe(false)
    expect(isTrustGateButton('Trust project', 'trust')).toBe(false)
    expect(TRUST_GATE_TITLES.filter(title => /project/i.test(title))).toEqual([])
    expect(TRUST_GATE_BUTTON.trust.filter(text => /project/i.test(text))).toEqual([])
  })

  /** `TRUST_GATE_HEADING_IN_PAGE` run the way a page read runs it: its source, evaluated, applied to an element. */
  const headingInPage = (textContent: string | null): boolean =>
    (new Function('el', `return (${TRUST_GATE_HEADING_IN_PAGE})(el)`) as (el: unknown) => boolean)({ textContent })

  it('UA12.94 — TRUST_GATE_HEADING_IN_PAGE, EVALUATED, finds the en and the ru title (any whitespace and case)', () => {
    expect(headingInPage('Trust this folder?')).toBe(true)
    expect(headingInPage('  trust THIS\n folder? ')).toBe(true)
    expect(headingInPage('Доверять этой папке?')).toBe(true)
    expect(headingInPage('  доверять этой  папке? ')).toBe(true)
  })

  it('NEGATIVE — evaluated, it finds no other heading: the retired copy, the contributions heading, an empty one', () => {
    expect(headingInPage('Trust this project folder?')).toBe(false)
    expect(headingInPage('This folder provides')).toBe(false)
    expect(headingInPage('Доверять этой папке? Нет')).toBe(false)
    expect(headingInPage('')).toBe(false)
    expect(headingInPage(null)).toBe(false)
  })

  /**
   * UA12.94 — no case spells the gate's copy: each of the seven cases that read the trust gate's heading inside its
   * own page read interpolates TRUST_GATE_HEADING_IN_PAGE (both locales, from the locale files), and no case keeps a
   * `/trust this …/i` regex literal of its own. The needle is checked on a planted finder first, so an empty scan
   * cannot pass for a clean one.
   */
  it('UA12.94 — every case-local trust-gate heading finder reads TRUST_GATE_HEADING_IN_PAGE, none an English regex', () => {
    const needle = /\/trust this [^/]*\/i/
    expect(needle.test(".find(el => /trust this project/i.test(el.textContent || ''))")).toBe(true)
    expect(needle.test('.find(${TRUST_GATE_HEADING_IN_PAGE})')).toBe(false)
    const dir = new URL('./cases/', import.meta.url).pathname
    const files = readdirSync(dir).filter(name => name.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(50)
    const spelled = files.filter(name => needle.test(readFileSync(join(dir, name), 'utf8')))
    expect(spelled).toEqual([])
    const readers = files.filter(name => readFileSync(join(dir, name), 'utf8').includes('${TRUST_GATE_HEADING_IN_PAGE}')).sort()
    expect(readers).toEqual(['cru-1.ts', 'cru-6.ts', 'pkg-6.ts', 'rs-116.ts', 'rs-51.ts', 'rs-53.ts', 'rs-87.ts'])
  })

  /**
   * UA12.195 (LG-6, 2026-10-09) — the BUTTON half of UA12.94: four cases dismissed a trust dialog they left up by
   * English text alone (`/^\\s*cancel\\s*$/i` in rs-51 and rs-53, `/^(cancel|close|keep restricted)$/i` in rs-80 and
   * rs-84), so in a ru UI each read "no Cancel button" or pressed nothing and left the profile blocked. No case spells
   * an English button regex now; the four read the locale-driven matchers. The needle is checked on planted finders
   * first, so an empty scan cannot pass for a clean one.
   *
   * Follow-up (LG-6-fix, 2026-10-09): the first needle saw only `^`-anchored regexes, so it missed rs-34's closeDialog
   * (`/cancel|close/i` over aria-label plus innerText — in a ru UI the rewind menu's "Отмена" / "Закрыть" matched
   * nothing) and rs-112's hard-coded `/^(Cancel|Отмена)$/`. The needle now takes any regex naming Cancel / Close /
   * Keep restricted (any case, anchored or not) whose `.test(` reads an element's innerText, textContent or
   * aria-label; a regex over a result string (elc-2's `/outcome=cancel/.test(result)`) is not a button finder.
   */
  it('UA12.195 — no case finds a dialog button by an English regex', () => {
    const needle = /\/[^/\n]*\b(?:cancel|close|keep restricted)\b[^/\n]*\/[a-z]*\.test\(\(?[^)\n]*(?:innerText|textContent|aria-label)/i
    expect(needle.test('.find(b => /^\\s*cancel\\s*$/i.test((b.innerText || b.textContent || \'\')))')).toBe(true)
    expect(needle.test(".find(x => /^(cancel|close|keep restricted)$/i.test((x.innerText||'').trim()))")).toBe(true)
    expect(needle.test(".find(x => /cancel|close/i.test((x.getAttribute('aria-label') || '') + ' ' + (x.innerText || '')))")).toBe(true)
    expect(needle.test(".find(x => /^(Cancel|Отмена)$/.test((x.innerText || '').trim()))")).toBe(true)
    expect(needle.test('.find(${buttonTextInPage(CANCEL_BUTTON_TEXTS)})')).toBe(false)
    expect(needle.test('    !/outcome=cancel/.test(result),')).toBe(false)
    const dir = new URL('./cases/', import.meta.url).pathname
    const files = readdirSync(dir).filter(name => name.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(50)
    expect(files.filter(name => needle.test(readFileSync(join(dir, name), 'utf8'))).sort()).toEqual([])
    const readers = files.filter(name => /\$\{button(?:Text|Label)InPage\(/.test(readFileSync(join(dir, name), 'utf8'))).sort()
    expect(readers).toEqual(['rs-05.ts', 'rs-112.ts', 'rs-34.ts', 'rs-51.ts', 'rs-53.ts', 'rs-80.ts', 'rs-84.ts', 'rs-87.ts', 'rs-99.ts'])
  })

  /** `buttonTextInPage(texts)` run the way a page read runs it: its source, evaluated, as `.find`'s callback over fabricated buttons. */
  const pressedBy = (texts: readonly string[], buttons: readonly string[]): string | undefined => {
    const matcher = new Function(`return (${buttonTextInPage(texts)})`)() as (el: unknown) => boolean
    return buttons.map(text => ({ innerText: text, textContent: text })).find(matcher)?.innerText
  }

  it('UA12.195 — the dismissal finders, EVALUATED, press the ru and the en Cancel / Close / Keep restricted (any whitespace and case)', () => {
    expect(pressedBy(CANCEL_BUTTON_TEXTS, ruButtons)).toBe('Отмена')
    expect(pressedBy(CANCEL_BUTTON_TEXTS, enButtons)).toBe('Cancel')
    expect(pressedBy(CANCEL_BUTTON_TEXTS, ['  CANCEL \n'])).toBe('  CANCEL \n')
    expect(pressedBy([...CANCEL_BUTTON_TEXTS, ...CLOSE_BUTTON_TEXTS], ['Готово', 'Закрыть'])).toBe('Закрыть')
    expect(pressedBy(DIALOG_DISMISS_BUTTON_TEXTS, ['Доверять папке', 'Оставить ограниченным'])).toBe('Оставить ограниченным')
    expect(pressedBy(DIALOG_DISMISS_BUTTON_TEXTS, ['Trust folder', 'Keep restricted'])).toBe('Keep restricted')
    expect(pressedBy(DIALOG_DISMISS_BUTTON_TEXTS, ['Trust folder', 'Close'])).toBe('Close')
  })

  it('NEGATIVE — evaluated, they press no decision that persists trust, no partial match, and nothing on an empty dialog', () => {
    expect(pressedBy(CANCEL_BUTTON_TEXTS, ['Trust folder', 'Keep restricted', 'Доверять папке'])).toBeUndefined()
    expect(pressedBy(DIALOG_DISMISS_BUTTON_TEXTS, ['Trust folder', 'Доверять папке'])).toBeUndefined()
    expect(pressedBy(CANCEL_BUTTON_TEXTS, ['Cancel run', 'Отменить'])).toBeUndefined()
    expect(pressedBy(DIALOG_DISMISS_BUTTON_TEXTS, [''])).toBeUndefined()
  })

  /** `buttonLabelInPage(texts)` evaluated over fabricated buttons that carry an `aria-label` (rs-34's closeDialog). */
  const pressedByLabel = (texts: readonly string[], buttons: ReadonlyArray<{ text: string; label?: string }>): string | undefined => {
    const matcher = new Function(`return (${buttonLabelInPage(texts)})`)() as (el: unknown) => boolean
    const els = buttons.map(b => ({ innerText: b.text, textContent: b.text, getAttribute: (name: string) => (name === 'aria-label' ? (b.label ?? null) : null), id: `${b.text}|${b.label ?? ''}` }))
    return els.find(matcher)?.id
  }

  it('UA12.195 follow-up — rs-34\'s closeDialog finder, EVALUATED, presses the ru and the en Close icon by its aria-label, and Cancel by its text', () => {
    const dismiss = [...CANCEL_BUTTON_TEXTS, ...CLOSE_BUTTON_TEXTS]
    expect(pressedByLabel(dismiss, [{ text: '', label: 'Свернуть' }, { text: '', label: 'Закрыть' }])).toBe('|Закрыть')
    expect(pressedByLabel(dismiss, [{ text: '', label: 'Close' }])).toBe('|Close')
    expect(pressedByLabel(dismiss, [{ text: 'Перемотать', label: 'Перемотка' }, { text: 'Отмена' }])).toBe('Отмена|')
    expect(pressedByLabel(dismiss, [{ text: '  CANCEL ' }])).toBe('  CANCEL |')
  })

  it('NEGATIVE — rs-34\'s finder presses no partial label, no other button, and nothing on a button with neither text nor label', () => {
    const dismiss = [...CANCEL_BUTTON_TEXTS, ...CLOSE_BUTTON_TEXTS]
    expect(pressedByLabel(dismiss, [{ text: '', label: 'Close panel' }, { text: 'Cancel run' }, { text: 'Отменить' }])).toBeUndefined()
    expect(pressedByLabel(dismiss, [{ text: 'Rewind', label: 'Rewind' }, { text: '' }])).toBeUndefined()
  })
})

describe('pressCard judges the PRESSED card, not whether any card remains (F1.976)', () => {
  const HIT: CardButtonHit = { x: 100, y: 200, text: 'Allow', index: 0, labels: ['Allow', 'Deny'], matched: true }
  /** Before the click the open chat awaits `before`; after it, `after`, with a card still up when `stillUp`. */
  const fakeCards = (before: number | null, after: number | null, stillUp: boolean) => {
    let clicked = false
    const session = {
      call: async (expression: string) => {
        if (expression.includes('awaitingApprovalCount')) return clicked ? after : before
        if (expression.includes('getBoundingClientRect')) return HIT
        return { present: clicked ? stillUp : true, text: 'Bash', labels: HIT.labels, scope: null, durableOffered: false }
      },
      evaluate: async () => ({ width: 1440, height: 900 }),
      send: async () => { clicked = true },
    }
    return session as never as CdpSession
  }
  const FAST = { timeoutMs: 60, intervalMs: 5 }

  it('a delivered press at an awaiting count of two reads as delivered, though the next card is up', async () => {
    expect(await pressCard(fakeCards(2, 1, true), ['Allow'], 'test', FAST)).toBe('Allow')
  })

  it('NEGATIVE — the count did not move and a card is still up: the press did not land', async () => {
    expect(await pressCard(fakeCards(2, 2, true), ['Allow'], 'test', FAST)).toBe('pressed Allow but the card did not clear')
  })

  it('an unreadable count falls back to the card leaving the screen', async () => {
    expect(await pressCard(fakeCards(null, null, false), ['Allow'], 'test', FAST)).toBe('Allow')
    expect(await pressCard(fakeCards(null, null, true), ['Allow'], 'test', FAST)).toBe('pressed Allow but the card did not clear')
  })
})

/**
 * F1.797 (origin SIT-m, 2026-09-25) — two sitting-instrument limits.
 *
 * 1. `attach` waited a fixed 10 s for the page socket to open, and
 *    `NESSY_CDP_TIMEOUT_MS` did not raise it. At a load average of 13 to 35,
 *    with that knob at 120 s, SIT-m still lost two attaches to
 *    `cdp-socket-open-timeout`. Driven against a real loopback stand-in for the
 *    DevTools endpoint whose page socket never finishes its handshake, because a
 *    source pin would pass on a module that names the resolver in a comment.
 * 2. `trustScratchProject` refused the lane's own `work/sitting/` folder. That
 *    refusal is kept (its guard is the temp dir only, on purpose), but it did not
 *    say that the tracked `answerTrustGate` (F1.976) answers exactly that folder,
 *    so the lane answered the dialog by hand.
 */
describe('the attach ceiling and the scratch-trust refusal (F1.797)', () => {
  const withEnv = async <T>(value: string | undefined, body: () => Promise<T>): Promise<T> => {
    const had = 'NESSY_CDP_TIMEOUT_MS' in process.env
    const previous = process.env.NESSY_CDP_TIMEOUT_MS
    delete process.env.NESSY_CDP_TIMEOUT_MS
    if (value !== undefined) process.env.NESSY_CDP_TIMEOUT_MS = value
    try { return await body() } finally {
      delete process.env.NESSY_CDP_TIMEOUT_MS
      if (had && previous !== undefined) process.env.NESSY_CDP_TIMEOUT_MS = previous
    }
  }

  /** A DevTools `/json/list` with one page, whose socket is on `wsPort`. */
  const devtools = (wsPort: number) => Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json([
      { id: 'p', type: 'page', title: 'f1797', url: 'app://f1797', webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/devtools/page/p` },
    ]),
  })
  /** Takes the TCP connection and never answers the upgrade, like the loaded app SIT-m met. */
  const silentSocket = () => Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  /** One attach that must fail: what it failed with, and how long it took. */
  const failedAttach = async (options: ConnectOptions) => {
    const started = Date.now()
    const error = await attach(options).then(() => undefined, (cause: unknown) => cause as Error)
    return { message: error?.message ?? 'attached', elapsed: Date.now() - started }
  }

  it('the socket open obeys NESSY_CDP_TIMEOUT_MS, and names the ceiling it waited', async () => {
    const tcp = silentSocket()
    const http = devtools(tcp.port)
    try {
      const { message, elapsed } = await withEnv('400', () => failedAttach({ port: http.port, focus: false }))
      expect(message).toContain('cdp-socket-open-timeout')
      expect(message).toContain('in 400ms')
      // The old fixed wait was 10 s. The margin is for a loaded box.
      expect(elapsed).toBeLessThan(8_000)
    } finally {
      http.stop(true)
      tcp.stop(true)
    }
  }, 30_000)

  it('an explicit timeoutMs still wins over the environment for the socket open', async () => {
    const tcp = silentSocket()
    const http = devtools(tcp.port)
    try {
      const { message, elapsed } = await withEnv('120000', () => failedAttach({ port: http.port, timeoutMs: 300, focus: false }))
      expect(message).toContain('cdp-socket-open-timeout')
      expect(message).toContain('in 300ms')
      expect(elapsed).toBeLessThan(8_000)
    } finally {
      http.stop(true)
      tcp.stop(true)
    }
  }, 30_000)

  it('CONTROL — a socket that opens inside the same short ceiling attaches', async () => {
    const ws = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('upgrade only', { status: 400 })),
      websocket: { message() {} },
    })
    const http = devtools(ws.port!)
    try {
      const session = await withEnv('400', () => attach({ port: http.port, focus: false }))
      expect(session.target.title).toBe('f1797')
      session.close()
    } finally {
      http.stop(true)
      ws.stop(true)
    }
  })

  /** A page that must never be asked: both refusals happen before any call. */
  const untouched = { call: async () => { throw new Error('the page was asked') } } as never as CdpSession
  const checkout = realpathSync(new URL('../..', import.meta.url).pathname)

  it("the scratch-trust refusal names answerTrustGate for a sitting lane's own folder", async () => {
    const lane = join(checkout, 'work', 'sitting', 'SIT-f1797', 'ws')
    const error = await trustScratchProject(untouched, lane).then(() => undefined, (cause: unknown) => cause as Error)
    expect(error?.message).toContain('refusing-to-trust')
    expect(error?.message).toContain(`answer through answerTrustGate(session, ${JSON.stringify(lane)}, 'trust' or 'keep-restricted')`)
  })

  it('NEGATIVE — a folder the harness did not make gets no pointer, since answerTrustGate would not trust it either', async () => {
    const error = await trustScratchProject(untouched, checkout).then(() => undefined, (cause: unknown) => cause as Error)
    expect(error?.message).toContain('refusing-to-trust')
    expect(error?.message).not.toContain('answerTrustGate')
  })
})

describe('the composer types single-line keys and pastes multi-line through the app\'s own paste path (UA12.166)', () => {
  /**
   * SIT-R measured four synthetic newline key shapes on both RCs — none inserts a line break; the composer's real
   * multi-line path is its paste handler. The fake answers the harness's in-page reads by shape: focus, the paste
   * dispatch, the palette read, the composer read-back.
   */
  const fakeComposer = (readBack: string) => {
    const sent: string[] = []
    const calls: string[] = []
    const session = {
      send: async (method: string, params: { type?: string; text?: string }) => {
        sent.push(`${method} ${JSON.stringify(params)}`)
        return {}
      },
      call: async (expression: string) => {
        calls.push(expression)
        if (expression.includes('ClipboardEvent')) return true
        if (expression.includes('ambiguous-composer')) return { ok: true, reason: 'focused' }
        if (expression.includes('[data-inline-menu]')) return { open: false, items: [], selectedIndex: -1 }
        if (expression.includes('innerText ?? el.textContent')) return readBack
        throw new Error(`fakeComposer: unrecognised in-page read ${expression.slice(0, 120)}`)
      },
    }
    return { session: session as never as CdpSession, sent, calls }
  }

  it('a two-line prompt rides the app\'s paste path — one ClipboardEvent, no newline key events', async () => {
    const twoLines = 'first line\nsecond line'
    const fake = fakeComposer(twoLines)
    await typeIntoComposer(fake.session, twoLines)
    const pastes = fake.calls.filter(call => call.includes('new ClipboardEvent(\'paste\''))
    expect(pastes).toHaveLength(1)
    expect(pastes[0]).toContain('text/plain')
    expect(pastes[0]).toContain(JSON.stringify(twoLines))
    // Not one CDP key event carries the newline (the four shapes SIT-R measured are all in this class):
    expect(fake.sent.filter(send => send.includes('\\n'))).toEqual([])
    // The focus, the paste dispatch and the verbatim read-back all happened through the page reads:
    expect(fake.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('BOUNDARY — a single-line prompt is still typed with real key events, never pasted', async () => {
    const fake = fakeComposer('one line only')
    await typeIntoComposer(fake.session, 'one line only')
    expect(fake.calls.filter(call => call.includes('ClipboardEvent'))).toEqual([])
    expect(fake.sent.filter(send => send.includes('Input.dispatchKeyEvent')).length).toBeGreaterThanOrEqual(3)
  })

  it('NEGATIVE — a composer that did not take the paste verbatim is refused before anything is sent', async () => {
    const fake = fakeComposer('first line\nsecond line\n(plus a stray)')
    await expect(typeIntoComposer(fake.session, 'first line\nsecond line')).rejects.toThrow('composer-paste-mismatch')
  })

  /**
   * UA12.180: innerText reads each blank line the paste inserts (`<div><br></div>`) as TWO newlines — measured on
   * Electron 39.8.10 by the 2026-10-08 verification: 'a\n\nb' reads back 'a\n\n\nb', 'a\n' reads back 'a\n\n'. An
   * exact compare refused RS-114 arm A's own prompt (two blank lines) on every run. The read-back is innerText's
   * real shape below, not the pasted text echoed.
   */
  it('a blank line read back the way innerText renders it (one extra newline) is accepted (UA12.180)', async () => {
    const fake = fakeComposer('a\n\n\nb')
    await typeIntoComposer(fake.session, 'a\n\nb')
    expect(fake.calls.filter(call => call.includes('ClipboardEvent'))).toHaveLength(1)
  })

  it('a trailing newline read back doubled is accepted (UA12.180)', async () => {
    const fake = fakeComposer('a\n\n')
    await typeIntoComposer(fake.session, 'a\n')
    expect(fake.calls.filter(call => call.includes('ClipboardEvent'))).toHaveLength(1)
  })

  it('NEGATIVE — merged lines (the newline dropped) are still refused (UA12.180)', async () => {
    const fake = fakeComposer('ab')
    await expect(typeIntoComposer(fake.session, 'a\nb')).rejects.toThrow('composer-paste-mismatch')
  })

  it('NEGATIVE — an empty composer (the long-paste attachment took the text) is still refused (UA12.180)', async () => {
    const fake = fakeComposer('')
    await expect(typeIntoComposer(fake.session, 'a\n\nb')).rejects.toThrow('composer-paste-mismatch')
  })

  it('rests on the product: the paste handler is the app\'s own plain-text insert (QUOTED_COPY)', () => {
    const source = readFileSync(
      new URL('../../apps/electron/src/renderer/components/ui/rich-text-input.tsx', import.meta.url).pathname, 'utf8')
    expect(source).toContain("document.execCommand('insertText', false, text)")
    expect(source).toContain("e.clipboardData?.getData('text/plain')")
  })
})
