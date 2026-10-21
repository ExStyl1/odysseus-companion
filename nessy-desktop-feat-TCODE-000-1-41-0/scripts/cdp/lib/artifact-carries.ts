/**
 * D1.266 — does the ARTEFACT under test carry the behaviour the row asks about?
 *
 * ## Why this exists
 *
 * A sitting row whose clause is *"on a packaged build"* is a claim about an
 * artefact, and an artefact is built from a commit. The fourth measure sitting
 * met the consequence twice in one list: `D1.244` and `D1.162` both asked for
 * behaviour built LATER in the same wave than the commit the 1.39.0 build came
 * from, and both would have produced a CONFIDENT FALSE FINDING — an empty
 * gateway catalogue read as *"the gateway publishes no reasoning block"*, and a
 * missing per-entry mark read as *"the renderer does not render it"*. Neither is
 * a product fact; both are the build.
 *
 * Two instruments caught it there, by hand, and this module is the pair:
 *
 *   1. **A literal scan of the shipped tree**, with a SIBLING literal as the
 *      positive control. Without the control, "0 occurrences" and "I read the
 *      wrong directory" are the same number.
 *   2. **`git merge-base --is-ancestor <implementing commit> <artefact commit>`**,
 *      which answers the question the scan cannot: not *is the string there* but
 *      *could it have been*.
 *
 * ## Why it is a BYTE scan and not the `grep -raoF` the row names
 *
 * {@link countInFile}'s own docblock carries the argument and it is this repo's
 * standing rule: `grep -c` counts LINES, so two hits on one line of a bundle
 * read as one, and a NUL byte anywhere in a file makes plain `grep`/`rg` skip it
 * SILENTLY — `apps/electron/dist/main.cjs` carries one about 16 MB in. A count
 * that is off by an unknown factor is not evidence, and an absence that a flag
 * can erase is not an absence. So the literal `-aoF` sweep is replaced by the
 * byte counter this harness already has, applied to every file under the app's
 * own `dist` tree — the RENDERER is where a UI marker lands, and
 * {@link bundleFiles} names only the two host bundles.
 *
 * ## The verdict this returns, and why one of them is not "absent"
 *
 * `null-by-artefact` is not a failure of the claim. It is the harness saying the
 * question was never put to the product, which is exactly what the two rows
 * above needed someone to say before they were driven.
 *
 * ## And some fixes ship no literal at all (D1.308)
 *
 * `D1.264`'s repair NAMES three fields where a spread published four and adds
 * one string to an `exact()` list — nothing new reaches the bundle, and both
 * strings it touches are everywhere in it already. Such a row is answered by the
 * ANCESTRY alone: {@link ArtifactAncestryQuery} omits `marker`/`control`, the
 * tree is not walked, and the reading says so (`scanRun: false`) instead of
 * reporting a zero nobody took.
 */

import { readdirSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

import { countInFile, repoRoot, type AppUnderTest } from './bundle.ts'
import { blocked, type CaseRun } from './report.ts'

/**
 * The commit the packaged app was built from.
 *
 * Nothing in the artefact states it — `app/package.json` carries the VERSION,
 * which several commits share — so it is the operator's to supply, exactly as it
 * is supplied to the sitting brief. Absent, the ancestry half is skipped and the
 * scan half still answers; the reading says which halves ran.
 */
export const ARTIFACT_COMMIT_ENV = 'NESSY_CDP_ARTIFACT_COMMIT'

interface ArtifactCommitQuery {
  /** The commit that implemented the behaviour, when the row names one. */
  implementedBy?: string
  /** Overrides {@link ARTIFACT_COMMIT_ENV} for a caller that knows the build. */
  artifactCommit?: string
}

/** A row whose behaviour ships a literal: both instruments run. */
export interface ArtifactScanQuery extends ArtifactCommitQuery {
  /** The literal the behaviour ships as — the string whose presence IS the claim. */
  marker: string
  /**
   * A sibling literal that must be present whatever the answer.
   *
   * Pick one from the same file and the same era — a neighbouring key, an older
   * sentence from the same surface. Its job is to fail when the scan read the
   * wrong tree, so that a zero on `marker` means something.
   */
  control: string
}

/**
 * D1.308 — a row whose fix ships NO literal of its own, answered by the
 * ancestry alone.
 *
 * `D1.264`'s repair is the measured example: it NAMES three fields where a
 * spread published four (a removal) and adds one string to an `exact()` list,
 * and `'questions'`/`'multiSelect'` are everywhere in the bundle already. So no
 * marker can discriminate it, and before this shape the only way to express the
 * row was to pass a string present in BOTH builds — which answers
 * `marker-not-discriminating`, a true verdict wearing a misleading sentence.
 *
 * The control the scan half provides is not lost, it MOVES: the commit itself is
 * the discriminator, `isAncestor` answers `undefined` rather than `false` for a
 * sha git does not know, and an unknown artefact commit answers
 * `ancestry-unknown` rather than an absence. `marker`/`control` are typed
 * `undefined` rather than omitted so the compiler refuses a half-filled query —
 * a scan query missing its control would otherwise land here silently.
 */
export interface ArtifactAncestryQuery extends ArtifactCommitQuery {
  implementedBy: string
  marker?: undefined
  control?: undefined
}

export type ArtifactMarkerQuery = ArtifactScanQuery | ArtifactAncestryQuery

export type ArtifactVerdict =
  /** The build carries the marker, and the control agrees the scan read it. */
  | 'carries'
  /** The build does not carry it — the question cannot be put to this artefact. */
  | 'null-by-artefact'
  /** The control is absent too: the scan read the wrong tree, or nothing. */
  | 'control-failed'
  /** The marker is present in a build predating its own commit — a bad marker. */
  | 'marker-not-discriminating'
  /**
   * Ancestry-only, and git could not answer: no marker was given, so the scan
   * was not run, and the one instrument that was left did not report. NOT
   * `control-failed`, whose sentence is about a scan that read the wrong tree.
   */
  | 'ancestry-unknown'

export interface ArtifactMarkerReading {
  verdict: ArtifactVerdict
  /** `undefined` on an ancestry-only query — the scan was not run. */
  marker?: string
  markerHits?: number
  control?: string
  controlHits?: number
  /** Whether the shipped tree was read at all (D1.308). */
  scanRun: boolean
  /** Files read, so a zero can be told from an empty directory. */
  filesScanned: number
  root: string
  /** `git merge-base --is-ancestor`, or `undefined` when a commit is unknown. */
  implementedByIsAncestor?: boolean
  artifactCommit?: string
  /** One sentence naming what ran and what it found. */
  detail: string
}

/** Every regular file under `root`, depth-first. Symlinks are not followed. */
function filesUnder(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) out.push(path)
    }
  }
  try {
    if (!statSync(root).isDirectory()) return []
  } catch {
    return []
  }
  walk(root)
  return out
}

/**
 * `git merge-base --is-ancestor a b` — `true`, `false`, or `undefined` when git
 * cannot answer (an unknown sha, a shallow clone, no repo).
 *
 * Exit 0 and exit 1 are both ANSWERS; anything else is not, and the difference
 * is the whole point — an unknown commit must not read as "not an ancestor",
 * which would turn a typo into a NULL verdict.
 */
export function isAncestor(ancestor: string, descendant: string): boolean | undefined {
  const result = Bun.spawnSync(['git', 'merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: repoRoot(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode === 0) return true
  if (result.exitCode === 1) return false
  return undefined
}

/**
 * Scan the app under test for `marker`, with `control` as the positive control
 * and the commit ancestry as the second instrument.
 *
 * Reads the app's own `dist` tree: the host bundle, the Pi subprocess bundle and
 * the renderer assets all sit under it, and a marker may be in any of them.
 */
export function readArtifactMarker(
  app: AppUnderTest,
  query: ArtifactMarkerQuery,
): ArtifactMarkerReading {
  const scanRun = query.marker !== undefined
  const root = app.appRoot === undefined ? '' : join(app.appRoot, 'dist')
  // The tree is not WALKED on an ancestry-only query, which is what makes
  // `filesScanned: 0` beside a populated app root a statement rather than a
  // coincidence: the scan was not run, it did not fail to find anything.
  const files = scanRun && root !== '' ? filesUnder(root) : []
  let markerHits = 0
  let controlHits = 0
  for (const file of files) {
    const marker = countInFile(file, String(query.marker))
    if (marker > 0) markerHits += marker
    const control = countInFile(file, String(query.control))
    if (control > 0) controlHits += control
  }
  const artifactCommit = query.artifactCommit ?? process.env[ARTIFACT_COMMIT_ENV]?.trim()
  const ancestor = query.implementedBy !== undefined && artifactCommit !== undefined && artifactCommit !== ''
    ? isAncestor(query.implementedBy, artifactCommit)
    : undefined
  const where = `${files.length} file(s) under ${root === '' ? '<no app root>' : root}`
  const ancestry = query.implementedBy === undefined
    ? 'no implementing commit given'
    : artifactCommit === undefined || artifactCommit === ''
      ? `no artefact commit known (set ${ARTIFACT_COMMIT_ENV})`
      : ancestor === undefined
        ? `git could not compare ${query.implementedBy} with ${artifactCommit}`
        : `${query.implementedBy} is ${ancestor ? '' : 'NOT '}an ancestor of ${artifactCommit}`
  const scanVerdict = (): ArtifactVerdict => controlHits === 0
    ? 'control-failed'
    : markerHits === 0
      ? 'null-by-artefact'
      : ancestor === false
        ? 'marker-not-discriminating'
        : 'carries'
  // D1.308 — ancestry alone. `undefined` is NOT an absence: git not answering
  // says nothing about the build, and reporting it as `null-by-artefact` would
  // let a typo'd sha block a row that could have been driven.
  const ancestryVerdict = (): ArtifactVerdict => ancestor === undefined
    ? 'ancestry-unknown'
    : ancestor
      ? 'carries'
      : 'null-by-artefact'
  const verdict: ArtifactVerdict = scanRun ? scanVerdict() : ancestryVerdict()
  const scanNotRun = 'THE SCAN WAS NOT RUN — this row states no marker, because its fix ships no literal of its own'
  const detail = !scanRun
    ? verdict === 'ancestry-unknown'
      ? `NEITHER INSTRUMENT ANSWERED: ${scanNotRun}, and ${ancestry}`
      : verdict === 'null-by-artefact'
        ? `NULL BY ARTEFACT: ${ancestry}. ${scanNotRun}, so the ancestry is the whole answer`
        : `the artefact descends from the fix: ${ancestry}. ${scanNotRun}`
    : verdict === 'control-failed'
      ? `the CONTROL string is absent too (${where}) — this scan read the wrong tree, not a build without the behaviour`
      : verdict === 'null-by-artefact'
        ? `NULL BY ARTEFACT: this build does not carry \`${query.marker}\` (${where}; control present ${controlHits}x; ${ancestry})`
        : verdict === 'marker-not-discriminating'
          ? `\`${query.marker}\` is present ${markerHits}x in a build that PREDATES it (${ancestry}) — the marker is not this behaviour's own`
          : `the build carries \`${query.marker}\` ${markerHits}x (${where}; control ${controlHits}x; ${ancestry})`
  return {
    verdict,
    ...(scanRun ? { marker: query.marker, markerHits, control: query.control, controlHits } : {}),
    scanRun,
    filesScanned: files.length,
    root,
    ...(ancestor === undefined ? {} : { implementedByIsAncestor: ancestor }),
    ...(artifactCommit === undefined || artifactCommit === '' ? {} : { artifactCommit }),
    detail,
  }
}

/**
 * D1.288 — the marker triples the sitting rows state, verified rather than
 * quoted, and where they live until each row has a case.
 *
 * The row asks for *"each artefact-dependent sitting row names its marker and
 * the next sitting's cases call the helper before driving"*. Measured 2026-09-18
 * (WI-aj), the second half cannot be delivered yet for a reason worth recording:
 * **the two rows that state a marker have no case file** — the fourth sitting
 * nulled both by hand — and the artefact-dependent rows that DO have a case
 * (`D1.264`/`rs-56.ts`, `D1.184`/`rs-37.ts`) state no marker, because their fixes
 * ship no literal of their own. So the triples live here, checked by
 * `harness.test.ts`, until the case for each row is born; then the entry moves
 * into it and this table loses the row.
 *
 * Every number below was taken by {@link readArtifactMarker} itself against the
 * packaged 1.39.0 at `release/mac-arm64/Nessy Desktop.app`, 616 files, 2.89 s —
 * the first end-to-end drive of this module on a real bundle, and it reproduces
 * the sitting's six hand-measured numbers exactly. Its own controls, same run:
 * a marker the build really carries answers `carries` (`model-list-provenance`,
 * 1 hit, with and without an implementing commit), and a nonsense marker beside
 * a nonsense control answers `control-failed`, never an absence.
 */
/**
 * THE THREE `implementedBy` COMMITS MOVED TO THE MASTER LINE, 2026-09-20.
 *
 * Each row's fix was built on `feat/TCODE-000` and reached `master` as ONE
 * squash commit, `04e335f1e` (MR !48), after which GitLab deleted the source
 * branch: the branch commits `4e3b57caf` (D1.244), `4b2638db3` (D1.162) and
 * `68bc7714f` (D1.264) are ancestors of no ref `master` carries, so
 * `merge-base --is-ancestor <them> HEAD` answers false on every build made from
 * master and `harness.test.ts`'s registry case went red on the first master
 * pipeline that ran it. They still RESOLVE (they are kept reachable on
 * `archive/plan-cited-history`), which is why the failure is an ancestry one
 * rather than a missing object. Measured the same day: `git log -S'<marker>'
 * --reverse origin/master` names `04e335f1e` for both markers, so on the master
 * line that single commit is what "the commit that built it" means for all
 * three; the branch shas stay named here because they are what the 1.39.0
 * readings below were taken against.
 *
 * WHAT IT COSTS, said rather than discovered: an artefact built from the BRANCH
 * (the 1.40.0 dmg, built from `d05d95b13`) does not descend from `04e335f1e`
 * either, so a sitting re-driving THAT artefact now reads
 * `marker-not-discriminating` for the two marker rows and `null-by-artefact`
 * for the ancestry-only one. Both are loud verdicts, not silent passes, and the
 * next artefact is built from master. On 1.39.0 (`b1f4f279c`) every reading
 * below is unchanged: it predates the squash commit exactly as it predated the
 * branch ones.
 */
export const ROW_ARTEFACT_MARKERS: Record<string, ArtifactMarkerQuery> = {
  /**
   * D1.244 — the `fast`/`coder` rows' reasoning behaviour, which needs a build
   * whose fetcher READS the catalogue's block.
   *
   * On 1.39.0 (`b1f4f279c`): marker 0, control 2, `4e3b57caf` NOT an ancestor →
   * `null-by-artefact`, which is the sitting's verdict. `is_default` (9 hits) is
   * the second control if a rename ever takes the first.
   *
   * **The marker survives a comment mention, measured rather than assumed.**
   * `sampling_params` entered the tree in `2465289d9`, a DOCS commit recording
   * what the catalogue publishes, and that commit IS an ancestor of `b1f4f279c`
   * — where the scan still answers 0. So the bundler strips comments and a
   * comment cannot manufacture a `carries`. At HEAD the string is CODE
   * (`model.sampling_params` in `model-fetchers/nestor.ts`), which is what a
   * 1.40.0 build will carry.
   */
  'D1.244': { marker: 'sampling_params', control: 'context_window_size', implementedBy: '04e335f1e' },
  /**
   * D1.162 / ledger K34 — the PER-ENTRY catalogue mark in both pickers.
   *
   * On 1.39.0: marker 0, both sibling testids 1 each, `4b2638db3` NOT an
   * ancestor → `null-by-artefact`. `git log -S --reverse` names `4b2638db3` as
   * the commit that introduced the marker, so it discriminates exactly; at HEAD
   * the string is in two production components (`CompactModelSelector.tsx`,
   * `ComposerModelMenu.tsx` — `DesktopModelPickerMenu.tsx` until UB14.30), so a
   * later build should read 2, not 1.
   */
  'D1.162': { marker: 'model-catalogue-unlisted', control: 'model-list-provenance', implementedBy: '04e335f1e' },
  /**
   * D1.264 — the Pi harness snapshot a LIVE session produces, ANCESTRY ONLY
   * (D1.308), because the fix ships no literal of its own.
   *
   * `68bc7714f` bounds the producer (`mcpHealth` was a spread of a health object
   * that has carried a fourth key since P6.715) and widens the parser by one
   * `exact()` entry (`pendingAsk.questions`). A REMOVAL and a list entry: the
   * bundle gains no string, and `questions`/`multiSelect` are already in it — so
   * a scan can only answer `marker-not-discriminating`, a true verdict wearing a
   * misleading sentence. On 1.39.0 (`b1f4f279c`) this answers `null-by-artefact`
   * from the ancestry alone; on the 1.40.0 artefact (`61cfc4659`) it answers
   * `carries`, which is what makes RS-56's re-drive a question about the product.
   */
  'D1.264': { implementedBy: '04e335f1e' },
}

/**
 * The same reading, observed on the run and BLOCKING unless the verdict is
 * `carries`.
 *
 * A block rather than a failed check, for the reason `runCase` separates the two:
 * a behaviour the artefact never had was not measured, and scoring it FAIL files
 * a product defect against a build. The reading is observed either way, so the
 * narrative carries the numbers even when the case stops.
 */
export function requireArtifactCarries(
  run: CaseRun,
  app: AppUnderTest,
  query: ArtifactMarkerQuery,
): ArtifactMarkerReading {
  const reading = readArtifactMarker(app, query)
  run.observe('artifact-carries', reading)
  if (reading.verdict !== 'carries') blocked(reading.detail)
  return reading
}
