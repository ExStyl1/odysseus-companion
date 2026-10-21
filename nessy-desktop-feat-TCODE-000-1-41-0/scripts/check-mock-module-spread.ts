#!/usr/bin/env bun
/**
 * check-mock-module-spread — the `mock.module` recipe has three halves, and the
 * third one is the one nothing in this tree could find.
 *
 * P6.979. AGENTS.md §Traps has carried *"a `mock.module` without a spread
 * amputates the module for some OTHER file in the batch, and you cannot choose
 * which; without a restore it is permanent for the process"* for weeks, with
 * nothing able to name its instances. The traps spec then corrected that rule as
 * INCOMPLETE (§"Spread AND restore is NOT enough", 2026-08-28): `mock.module`
 * **mutates the imported namespace object in place**, so a restore written from
 * the live namespace hands back the MOCK — it runs, reports nothing, and leaves
 * the mock installed for every later file in the process. Cost when missed: six
 * manufactured failures in a suite the lane had not touched.
 *
 * ==========================================================================
 * WHAT THIS GUARD FAILS ON, AND WHAT IT ONLY PRICES — read this before quoting
 * it as assurance, because the census says these two are not the same class.
 *
 * It FAILS on one shape: a `mock.module(<spec>, () => IDENT)` whose `IDENT`
 * resolves to a LIVE module namespace — `const IDENT = await import(<spec>)`, or
 * an `import * as IDENT`. That is the restore-restores-the-mock shape, it has no
 * legitimate form, and the fix is always the same one sentence: snapshot with
 * `const IDENT = { ...ns }` before the first mock and restore from the snapshot.
 *
 * It only PRICES the shape the row was born for — a factory returning an object
 * literal with no spread at all. Measured 2026-09-10 over this tree that class
 * is **78 sites in 34 files**, and it is dominated by deliberate narrow stubs of
 * a package the file never otherwise uses: `pdfjs-dist` and its worker (28),
 * `electron` (10), `@/context/ThemeContext` (7), `../logger` (6). A gate on that
 * class would start life silencing 34 files, and a text scan cannot tell a
 * deliberate stub from an amputation, so the count is reported and nothing is
 * failed. That number is A READING WITH A DATE — run the guard, do not quote it.
 *
 * Since F1.134 that class is split by specifier kind: a narrow stub of a
 * FIRST-PARTY module in a file that shares a process is RATCHETED
 * (`isNarrowFirstPartyFinding` — the D1.442 amputation shape); a package, the
 * app logger and an `.isolated.ts` file stay priced.
 *
 * It RATCHETS one more shape (F1.133): a static value import written BELOW a
 * top-level `mock.module` — hoisted above the stub, so the stub cannot apply
 * first (`importsBelowTopLevelMock`). Red on a file `RATCHET_BASELINE_FILE`
 * does not list; the files already there are listed with a reason each.
 *
 * And it cannot see the first half of the rule at all. Whether a narrow stub
 * amputates anything depends on what ELSE is in the batch, and `bun test`
 * IGNORES the order of the paths it is given (AGENTS.md §Traps, 2026-09-08), so
 * the blast radius is not a property of the file this scanner reads.
 *
 * WHEN a narrow stub amputates, measured (F1.561, bun 1.3.14, pinned by
 * `scripts/mock-module-load-order.test.ts`): only when NOTHING in the process
 * had loaded the module before the stub went in. Then a later import gets the
 * stub's object as the module, and every name it does not list is `undefined`.
 * A narrow stub over a module that was ALREADY loaded replaces the names it
 * lists in place and leaves every unlisted export real, on the namespace an
 * importer holds and on a later import. So a ratcheted narrow stub harms a
 * later file only when it ran first for that module in its process — which the
 * text of one file cannot show, and which is why the shape is ratcheted rather
 * than failed.
 * ==========================================================================
 *
 * ## The census that chose the finding, and why the obvious guard was refused
 *
 * Measured 2026-09-10 over 250 `mock.module` sites in 100 of 1 996 test files —
 * the guard's own summary, so it can be re-derived rather than believed:
 *
 *   spread from a snapshot   65 sites   the correct shape
 *   restore from a snapshot  79 sites   the correct SECOND half
 *   spread from a live ns    20 sites   fine at mock time, only the restore is wrong
 *   narrow, no spread        78 sites / 34 files   priced, not failed
 *   unresolved                5 sites   hand-built stubs; reported, never guessed at
 *   restore from a live ns    3 sites /  3 files   THE FINDING
 *
 * All three of those were converted the next day (P6.982) — each now snapshots
 * `{ ...ns }` from an `import * as ns` before the first mock and restores from
 * the snapshot — so the census above is the one that CHOSE the finding, not
 * today's tree: the live count is 0 and the baseline is empty. Re-run the guard
 * for today's numbers rather than reading them here.
 *
 * The row asked for a guard on "no spread". Two things stopped that being built.
 * The first is the 34-file baseline above. The second is worse and is the reason
 * this docblock is long: the naive scanner ALSO reports all 79 restores, because
 * `mock.module(<spec>, () => realX)` in an `afterAll` has no spread in it — so
 * the guard would have flagged the correct second half of the very recipe it
 * exists to enforce. That is the family AGENTS.md already records twice, where a
 * guard fires against the thing that repairs it.
 *
 * ## Why a text scanner and not the TypeScript AST
 *
 * The same trade `check-module-graph-hooks` states: ~2 000 test files, a shape
 * that is two identifiers and a trailing argument, and a gate that has to be
 * cheap enough to sit in `lint:chain`. `splitCallArguments` is imported from
 * that guard rather than copied — one balanced scanner that skips strings,
 * template literals and comments, one place to fix it.
 *
 * The cost is stated rather than hidden: a factory built dynamically, a restore
 * through a function call, and a namespace re-exported under a second name are
 * all invisible here.
 *
 * ## The baseline is keyed by FILE
 *
 * Same reason as its sibling: a line number has a measured half-life of about
 * two days in this tree. Findings already present live in
 * `scripts/mock-module-spread-baseline.txt` with a reason each; the gate is red
 * only on a NEW one. That list is EMPTY since P6.982, which makes the gate a
 * zero-tolerance pin — read the baseline file's own preamble before adding to
 * it. Baselined files that are no longer findings are named as a WARNING on
 * stdout, never a failure — see that sibling's own docblock for the posture and
 * for why stdout rather than stderr.
 *
 * Usage:
 *   bun scripts/check-mock-module-spread.ts                  # report
 *   bun scripts/check-mock-module-spread.ts --check          # exit 1 on a NEW finding
 *   bun scripts/check-mock-module-spread.ts --update-baseline
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { baselinePreamble, codeTokenOffsets, splitCallArguments } from './check-module-graph-hooks'
import { GateSafetyRefusal } from './gate-safety'

// `codeTokenOffsets` LIVES in the sibling guard beside `splitCallArguments` —
// one scanner, one direction of dependency, and no import cycle now that
// `findModuleGraphHooks` enters through it too (P6.984). Re-exported because
// this module's own test states the two comment shapes against it.
export { codeTokenOffsets }

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const BASELINE_FILE = 'scripts/mock-module-spread-baseline.txt'

/**
 * The document this guard enforces — asserted so that deleting the narrative
 * cannot leave the guard standing with nothing behind it.
 */
export const TRAPS_SPEC = 'docs/superpowers/specs/2026-08-21-measured-traps.md'

/** The section of it, quoted so a rename is visible rather than silent. */
export const TRAPS_SECTION = 'restoring from the imported namespace restores the MOCK'

/**
 * How a `mock.module` replacement is built.
 *
 * - `snapshot` — spread of a `{ ...ns }` snapshot. The documented shape.
 * - `live-spread` — spread of a live namespace. Correct AT MOCK TIME (the
 *   spread copies the values as they are now); it is only the restore that is
 *   wrong, which is why this is not a finding on its own.
 * - `restore-live` — a bare passthrough of a live namespace. THE FINDING.
 * - `restore-snapshot` — a bare passthrough of a snapshot. The correct restore.
 * - `narrow` — an object literal with no spread. Priced, never failed.
 * - `unresolved` — a passthrough or spread whose source this scanner could not
 *   find. Reported as a count so the guard cannot quietly under-report.
 */
export type FactoryKind =
  | 'snapshot'
  | 'live-spread'
  | 'restore-live'
  | 'restore-snapshot'
  | 'narrow'
  | 'unresolved'

export interface MockModuleSite {
  readonly file: string
  /** 1-based line of the `mock.module` token, in the file's OWN text. */
  readonly line: number
  /** The first argument exactly as written, quotes stripped when it is a literal. */
  readonly specifier: string
  readonly kind: FactoryKind
  /** What the classification was based on — printed beside a finding. */
  readonly note: string
}

const TOKEN_CHAR = /[A-Za-z0-9_$]/

/** A factory that hands back one identifier and nothing else: `() => realX`. */
const PASSTHROUGH = /^\(?\s*\)?\s*(?:async\s*)?\(\s*\)\s*=>\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*$/

/** The first `...IDENT` in a factory body. */
const FIRST_SPREAD = /\.\.\.\s*([A-Za-z_$][\w$]*)/

/** A spread of an inline dynamic import: `...(await import('x'))`. */
const INLINE_IMPORT_SPREAD = /\.\.\.\s*\(?\s*await\s+import\s*\(/

/**
 * How an identifier holding "the real module" was captured.
 *
 * `live` is the one that matters: `mock.module` mutates the namespace object in
 * place, so anything holding that object holds the mock a moment later.
 */
export function classifyCapture(text: string, name: string): 'snapshot' | 'live' | 'unknown' {
  const definition = new RegExp(
    String.raw`(?:^|[^\w$])(?:const|let|var)\s+${name}\s*(?::[^=;]{0,200})?=\s*([\s\S]{0,200})`,
  ).exec(text)
  if (definition !== null) {
    const head = (definition[1] as string).trimStart()
    // `{ ...` is the snapshot the traps spec prescribes. A bare `{` is a
    // hand-built stub object, which is a narrow stub rather than a live handle.
    if (/^\{\s*\.\.\./.test(head)) return 'snapshot'
    if (/^\{/.test(head)) return 'unknown'
    if (/^\(?\s*await\s+import\s*\(/.test(head)) return 'live'
    const alias = /^([A-Za-z_$][\w$]*)\s*(?:[;,\n]|$)/.exec(head)
    if (alias !== null) return namespaceImports(text).has(alias[1] as string) ? 'live' : 'unknown'
    return 'unknown'
  }
  return namespaceImports(text).has(name) ? 'live' : 'unknown'
}

/** Every `import * as NAME` in the file — a live namespace object by definition. */
export function namespaceImports(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g)].map(match => match[1] as string),
  )
}

/**
 * Every `mock.module(…)` in `text`, classified. Exported so the tests can plant
 * one rather than depend on the tree's current population.
 *
 * Line numbers are computed against the text AS GIVEN — the balanced scanner
 * skips comments on its own, so nothing here strips them first. An earlier
 * census did strip them, and because a block comment loses its newlines that
 * way, every line number it printed for a file with a docblock was wrong.
 */
export function findMockModuleSites(file: string, text: string): MockModuleSite[] {
  const out: MockModuleSite[] = []
  for (const at of codeTokenOffsets(text, 'mock.module')) {
    const before = at > 0 ? (text[at - 1] as string) : ''
    if (before !== '' && TOKEN_CHAR.test(before)) continue
    if (text[at + 'mock.module'.length] !== '(') continue
    const args = splitCallArguments(text, at + 'mock.module'.length)
    if (args === undefined) continue
    const line = text.slice(0, at).split('\n').length
    const specifier = (args[0] ?? '').trim().replace(/^['"`]|['"`]$/g, '')
    const factory = args.slice(1).join(',').trim()

    const passthrough = PASSTHROUGH.exec(factory)
    if (passthrough !== null) {
      const name = passthrough[1] as string
      const capture = classifyCapture(text, name)
      out.push({
        file,
        line,
        specifier,
        kind: capture === 'live' ? 'restore-live' : capture === 'snapshot' ? 'restore-snapshot' : 'unresolved',
        note: `hands back ${name} (${capture})`,
      })
      continue
    }
    if (INLINE_IMPORT_SPREAD.test(factory)) {
      out.push({ file, line, specifier, kind: 'live-spread', note: 'spreads an inline await import' })
      continue
    }
    const spread = FIRST_SPREAD.exec(factory)
    if (spread !== null) {
      const name = spread[1] as string
      const capture = classifyCapture(text, name)
      out.push({
        file,
        line,
        specifier,
        kind: capture === 'snapshot' ? 'snapshot' : capture === 'live' ? 'live-spread' : 'unresolved',
        note: `spreads ${name} (${capture})`,
      })
      continue
    }
    out.push({ file, line, specifier, kind: 'narrow', note: 'no spread of the real module' })
  }
  return out
}

/**
 * F1.134 (origin D1.442-B) — where a specifier resolves. `first-party` is this
 * repository's own code (a relative or absolute path, the renderer's `@/`
 * alias, a `@nessy-agent/*` workspace package); everything else — a package,
 * a `node:`/`bun:` builtin — is `package`.
 */
export function narrowOrigin(specifier: string): 'package' | 'first-party' {
  return /^(\.|\/|@\/|@nessy-agent\/|~\/)/.test(specifier) ? 'first-party' : 'package'
}

/**
 * F1.134 — a narrow stub (no spread) of a FIRST-PARTY module in a file that
 * SHARES a process. Three of them with no restore cost four chunk-level CI reds
 * and 56 pollution failures (D1.440-B, D1.442): the stub removes every name it
 * does not list, and the next file in the process that imports one of those
 * names dies at import. The fix is the recipe: snapshot `{ ...ns }`, spread it,
 * restore from it. (F1.561: "removes" holds when the stub is installed before
 * anything in the process loaded the module; over an already-loaded module the
 * unlisted names stay real — see the load-order note in the header.)
 *
 * Priced instead, and why each:
 * - a package (`pdfjs-dist` and its worker, `electron`, `node:*`) — the row's
 *   CONTROL, and the class the docblock above measured as deliberate;
 * - the app's logger (a specifier whose last segment is `logger`) — named in the
 *   row's CONTROL beside the two packages; KEPT by F1.462 (4), measured 2026-09-24:
 *   the three shared-process stubs (`browser-cdp`, `browser-pane-manager`,
 *   `browser-trust-gate`) omit 4 of `main/logger.ts`'s 12 exports, unrestored, and
 *   those four's only importers are `index.ts` (its chunk's tests read it as TEXT),
 *   `auto-update.ts` (tested in an `.isolated.ts`) and `network-proxy.ts` (its one
 *   test bundles it into a CHILD) — no in-process victim to convert three files for;
 * - any site in an `.isolated.ts` file — `test:isolated` runs one process per
 *   file, so its stubs cannot reach another file.
 */
export function isNarrowFirstPartyFinding(site: MockModuleSite): boolean {
  return site.kind === 'narrow'
    && narrowOrigin(site.specifier) === 'first-party'
    && !site.file.endsWith('.isolated.ts')
    && !/(^|\/)logger(\.ts)?$/.test(site.specifier)
}

/**
 * F1.133 (origin D1.442-A) — the pdfjs recipe's FOURTH rule, which is not about
 * pdfjs: ESM hoists every static import above the module body, so a top-level
 * `mock.module` cannot beat a STATIC import in the same file — the imported
 * graph links and evaluates first, whatever line the import is written on.
 * `MarketplaceComponents.test.tsx` carried all three pdfjs stubs and the
 * DOMMatrix polyfill and was red ALONE for its whole life: nine static value
 * imports written below its stubs linked the `?url` module before any stub ran
 * (fixed in `2cbd7105a` by turning them into `await import(...)`).
 *
 * Returns every static VALUE import that starts a line BELOW the first
 * `mock.module(` that starts a line in code — the text that says its author
 * believed the stub runs first. "Starts a line" is how this tree writes a
 * top-level statement; a mock inside a hook is indented and is not one. A
 * type-only import (`import type …`, or braces holding only `type X`
 * specifiers) is erased and links nothing, and an `await import(…)` is the fix,
 * so neither is returned. Position is the SIGNAL, not the mechanism: an import
 * written above the stub is hoisted just the same, but nobody wrote it believing
 * otherwise.
 *
 * What it cannot tell: whether the stub had anything to beat. A mocked module
 * that links fine unmocked is rewired afterwards through the namespace
 * `mock.module` mutates in place, so the file stays green by a different
 * mechanism than its author assumed — which is why today's instances are
 * ratcheted in `RATCHET_BASELINE_FILE` with a reason each rather than failed.
 */
export function importsBelowTopLevelMock(text: string): Array<{ line: number; statement: string }> {
  const startsLine = (at: number): boolean => at === 0 || text[at - 1] === '\n'
  const first = codeTokenOffsets(text, 'mock.module')
    .find(at => startsLine(at) && text[at + 'mock.module'.length] === '(')
  if (first === undefined) return []
  const out: Array<{ line: number; statement: string }> = []
  for (const at of codeTokenOffsets(text, 'import')) {
    if (at <= first || !startsLine(at)) continue
    const rest = text.slice(at + 'import'.length)
    // `import(`, `import.meta` and `imported…` are not declarations.
    if (!/^[\s{*'"]/.test(rest)) continue
    if (/^\s+type[\s{]/.test(rest)) continue
    const braces = /^\s*\{([^}]*)\}\s*from\b/.exec(rest)
    const specifiers = braces ? (braces[1] as string).split(',').map(entry => entry.trim()).filter(Boolean) : []
    if (specifiers.length > 0 && specifiers.every(entry => /^type\s/.test(entry))) continue
    const end = text.indexOf('\n', at)
    out.push({ line: text.slice(0, at).split('\n').length, statement: text.slice(at, end === -1 ? undefined : end) })
  }
  return out
}

/**
 * The ratchet baseline, beside the zero-tolerance one: `<kind> <file>` per line,
 * a reason on each, edited BY HAND (`--update-baseline` rewrites only
 * `BASELINE_FILE`). A ratchet kind is red only on a file this list does not
 * name; a listed file that is no longer a finding is a WARNING.
 */
export const RATCHET_BASELINE_FILE = 'scripts/mock-module-ratchet-baseline.txt'

/** The kinds a ratchet line may name — one per ratchet this guard runs. */
export const RATCHET_KINDS = ['hoisted-import', 'narrow-first-party'] as const

export function readRatchetBaseline(): Set<string> {
  const file = join(REPO_ROOT, RATCHET_BASELINE_FILE)
  if (!existsSync(file)) return new Set()
  return new Set(
    readFileSync(file, 'utf-8')
      .split('\n')
      .map(line => line.replace(/#.*$/, '').trim().replace(/\s+/g, ' '))
      .filter(line => line !== ''),
  )
}

/**
 * The pathspecs, written with git's `:(glob)` magic because a bare double-star
 * is read WITHOUT glob magic and silently drops files — measured 2026-08-31,
 * recorded in AGENTS.md §Traps.
 */
const TEST_PATHSPECS: readonly string[] = [
  ':(glob)apps/**/*.test.ts', ':(glob)apps/**/*.test.tsx', ':(glob)apps/**/*.isolated.ts',
  ':(glob)packages/**/*.test.ts', ':(glob)packages/**/*.test.tsx', ':(glob)packages/**/*.isolated.ts',
]

/** Every test file in scope — the DENOMINATOR, so the report can say what was searched. */
export function testFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', ...TEST_PATHSPECS], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  }).split('\0').filter(file => file !== '')
}

/**
 * The files worth READING — those that name `mock.module` at all.
 *
 * `-a` rather than plain grep because some source files in this tree have
 * carried a NUL byte and plain grep skips those SILENTLY, and never `-I`
 * alongside it: the two flags are opposites and the LAST one wins.
 */
export function candidateFiles(): string[] {
  try {
    return execFileSync('git', ['grep', '-alz', 'mock.module', '--', ...TEST_PATHSPECS], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    }).split('\0').filter(file => file !== '')
  } catch {
    // git grep exits 1 on no match. Every caller refuses on an empty result
    // rather than reporting a green run over nothing.
    return []
  }
}

export function readBaseline(): Set<string> {
  const file = join(REPO_ROOT, BASELINE_FILE)
  if (!existsSync(file)) return new Set()
  return new Set(
    readFileSync(file, 'utf-8')
      .split('\n')
      .map(line => line.replace(/#.*$/, '').trim())
      .filter(line => line !== ''),
  )
}

/** Baselined files that are no longer findings. Same pass, same posture, as the sibling guard. */
export function staleBaselineEntries(
  baseline: Iterable<string>,
  findingFiles: Iterable<string>,
): string[] {
  const live = new Set(findingFiles)
  return [...new Set(baseline)].filter(file => !live.has(file)).sort()
}

function main(argv: readonly string[]): number {
  const check = argv.includes('--check')
  const update = argv.includes('--update-baseline')

  const spec = join(REPO_ROOT, TRAPS_SPEC)
  if (!existsSync(spec) || !readFileSync(spec, 'utf-8').includes(TRAPS_SECTION)) {
    throw new GateSafetyRefusal(
      `REFUSED: ${TRAPS_SPEC} no longer carries "${TRAPS_SECTION}" — this guard enforces that narrative, `
      + 'and a guard whose reason has been deleted is a rule nobody agreed to.',
    )
  }

  const files = testFiles()
  if (files.length === 0) {
    throw new GateSafetyRefusal('REFUSED: no test files matched — the run would be vacuous.')
  }
  const candidates = candidateFiles()
  if (candidates.length === 0) {
    throw new GateSafetyRefusal(
      'REFUSED: no test file names `mock.module` — that is a broken pathspec, not a tree in that state.',
    )
  }
  const inScope = new Set(files)
  const stray = candidates.filter(file => !inScope.has(file))
  if (stray.length > 0) {
    throw new GateSafetyRefusal(
      `REFUSED: ${stray.length} candidate(s) outside the denominator (${stray[0]}) — the two pathspecs disagree, `
      + 'so the reported file count would not describe what was read.',
    )
  }

  const sites: MockModuleSite[] = []
  const hoisted: Array<{ file: string; line: number; statement: string }> = []
  for (const file of candidates) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf-8')
    sites.push(...findMockModuleSites(file, text))
    hoisted.push(...importsBelowTopLevelMock(text).map(hit => ({ file, ...hit })))
  }
  if (sites.length === 0) {
    throw new GateSafetyRefusal(
      'REFUSED: no `mock.module` call parsed in any candidate file — the matcher is broken, not the tree.',
    )
  }

  const findings = sites.filter(site => site.kind === 'restore-live')
  const findingFiles = [...new Set(findings.map(finding => finding.file))].sort()

  if (update) {
    const known = readBaseline()
    const body = findingFiles
      .map(file => (known.has(file) ? file : `${file}  # recorded ${new Date().toISOString().slice(0, 10)}`))
      .join('\n')
    const path = join(REPO_ROOT, BASELINE_FILE)
    const preamble = existsSync(path) ? baselinePreamble(readFileSync(path, 'utf-8')) : ''
    writeFileSync(path, `${preamble}${body}\n`, 'utf-8')
    console.log(`check-mock-module-spread: baseline written with ${findingFiles.length} file(s).`)
    return 0
  }

  const baseline = readBaseline()
  const fresh = findings.filter(finding => !baseline.has(finding.file))

  for (const finding of findings) {
    const known = baseline.has(finding.file) ? ' (in the baseline)' : ''
    console.log(
      `${finding.file}:${finding.line}  mock.module('${finding.specifier}') ${finding.note} — a restore from a `
      + `LIVE namespace restores the MOCK${known}`,
    )
  }

  const count = (kind: FactoryKind) => sites.filter(site => site.kind === kind).length
  const narrowFiles = new Set(sites.filter(site => site.kind === 'narrow').map(site => site.file)).size
  const firstParty = sites.filter(isNarrowFirstPartyFinding)
  console.log(
    `check-mock-module-spread: ${sites.length} mock.module site(s) in ${candidates.length} of ${files.length} `
    + `test file(s) — ${count('snapshot')} spread from a snapshot, ${count('restore-snapshot')} restore from one, `
    + `${count('live-spread')} spread from a live namespace, ${count('narrow')} narrow (no spread) over `
    + `${narrowFiles} file(s), ${count('unresolved')} unresolved; ${findings.length} finding(s) over `
    + `${findingFiles.length} file(s), ${fresh.length} NOT in the baseline.`,
  )
  console.log(
    `check-mock-module-spread: ${count('narrow') - firstParty.length} of the ${count('narrow')} narrow site(s) are `
    + 'PRICED, not failed — a package, the app logger, or an .isolated.ts file (its own process); the other '
    + `${firstParty.length} stub a FIRST-PARTY module in a shared process and are ratcheted (F1.134). See the docblock.`,
  )

  const stale = staleBaselineEntries(baseline, findingFiles)
  if (stale.length > 0) {
    // Stdout, beside the summary — a warning on the other stream is dropped by
    // every invocation that pipes only stdout.
    console.log(
      `check-mock-module-spread: WARNING — ${stale.length} baselined file(s) are no longer a finding: `
      + `${stale.join(', ')}. Drop the line(s), or run --update-baseline. Not a failure.`,
    )
  }

  // ---- F1.133: a static import written below a top-level stub ----------------
  const ratchet = readRatchetBaseline()
  const hoistKey = (file: string) => `hoisted-import ${file}`
  const hoistFiles = [...new Set(hoisted.map(hit => hit.file))].sort()
  const hoistFresh = hoistFiles.filter(file => !ratchet.has(hoistKey(file)))
  for (const hit of hoisted) {
    const known = ratchet.has(hoistKey(hit.file)) ? ` (in ${RATCHET_BASELINE_FILE})` : ''
    console.log(
      `${hit.file}:${hit.line}  a static import written BELOW a top-level mock.module is hoisted ABOVE it — `
      + `the stub cannot apply first; load it with await import(...) after the stub (F1.133)${known}`,
    )
  }
  console.log(
    `check-mock-module-spread: ${hoisted.length} static value import(s) below a top-level mock.module over `
    + `${hoistFiles.length} file(s); ${hoistFresh.length} file(s) NOT in ${RATCHET_BASELINE_FILE}.`,
  )
  const ratchetStale = staleBaselineEntries(
    [...ratchet].filter(key => key.startsWith('hoisted-import ')),
    hoistFiles.map(hoistKey),
  )
  if (ratchetStale.length > 0) {
    console.log(
      `check-mock-module-spread: WARNING — ${ratchetStale.length} ratchet entr(y/ies) no longer a finding: `
      + `${ratchetStale.join(', ')}. Drop the line(s) by hand. Not a failure.`,
    )
  }

  // ---- F1.134: a narrow stub of a first-party module in a shared process -------
  const narrowKey = (file: string) => `narrow-first-party ${file}`
  const narrowFindingFiles = [...new Set(firstParty.map(site => site.file))].sort()
  const narrowFresh = narrowFindingFiles.filter(file => !ratchet.has(narrowKey(file)))
  for (const site of firstParty) {
    const known = ratchet.has(narrowKey(site.file)) ? ` (in ${RATCHET_BASELINE_FILE})` : ''
    console.log(
      `${site.file}:${site.line}  mock.module('${site.specifier}') is a NARROW stub of a FIRST-PARTY module in a `
      + `shared process — spread a { ...ns } snapshot and restore from it (F1.134)${known}`,
    )
  }
  console.log(
    `check-mock-module-spread: ${firstParty.length} narrow first-party stub(s) over ${narrowFindingFiles.length} `
    + `file(s); ${narrowFresh.length} file(s) NOT in ${RATCHET_BASELINE_FILE}.`,
  )
  const narrowStale = staleBaselineEntries(
    [...ratchet].filter(key => key.startsWith('narrow-first-party ')),
    narrowFindingFiles.map(narrowKey),
  )
  if (narrowStale.length > 0) {
    console.log(
      `check-mock-module-spread: WARNING — ${narrowStale.length} ratchet entr(y/ies) no longer a finding: `
      + `${narrowStale.join(', ')}. Drop the line(s) by hand. Not a failure.`,
    )
  }

  return check && (fresh.length > 0 || hoistFresh.length > 0 || narrowFresh.length > 0) ? 1 : 0
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (error) {
    if (error instanceof GateSafetyRefusal) {
      console.error(error.message)
      process.exit(2)
    }
    throw error
  }
}
