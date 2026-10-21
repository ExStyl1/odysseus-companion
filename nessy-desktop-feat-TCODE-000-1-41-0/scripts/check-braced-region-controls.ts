/**
 * check-braced-region-controls — the boundary control that CANNOT FAIL.
 *
 * D1.243.
 *
 * ## The defect, and why nothing in this tree could see it
 *
 * `bracedRegion(src, at)` (`packages/shared/src/testing/source-regions.ts`)
 * returns from `at` to the `}` that closes the first `{` at or after it. When it
 * runs away — an unbalanced brace, an anchor that matched inside a string, a
 * region that is not the one the author meant — it returns the whole REST of the
 * file, and every positive assertion over it then passes for a match anywhere in
 * the module. Silently. So every call site owes one negative:
 *
 * ```ts
 * const body = bracedRegion(src, src.indexOf('private deliverAsyncHookNote('))
 * expect(body).toContain('…')                                  // the claim
 * expect(body).not.toContain('private async flushPendingTaskNotifications(') // the control
 * ```
 *
 * **And the control has to name something declared BELOW the anchor.** A brace
 * scan only ever runs FORWARD, so a needle whose every occurrence sits above the
 * anchor can never be inside the region — not when the scan is right, and not
 * when it runs away to the end of the file. Such a control passes on the exact
 * failure it was written to catch, and it passes identically before and after
 * the bug, so re-running the test tells you nothing.
 *
 * D1.111 wrote fourteen of these and **four of four first drafts had it**
 * (`disposeManagedAgentRuntime`, `warnIfProjectSettingsWidenDefaultMode` and
 * `applyWorktreeSymlinks` all sit above the regions that named them). The only
 * reason they were caught is that the author read the source line numbers by
 * hand. The docblock half of the fix landed in `source-regions.ts`; this is the
 * mechanical half, and it is the half a reader in a hurry needs.
 *
 * ## How it decides, and why by CONTENT rather than by variable
 *
 * For each test file carrying a `bracedRegion(` call it:
 *
 *  1. collects every path literal in the file that resolves to a file that
 *     exists — `new URL('../x.ts', import.meta.url)`, `join(REPO_ROOT, 'a/b.ts')`,
 *     `join(import.meta.dir, '..', '..', 'c.ts')`, and bare `'…​.ts'` literals
 *     resolved against the test's own directory and against the repo root;
 *  2. reads the anchor needle out of the call's second argument (an inline
 *     `src.indexOf('…')`, or the `const start = …indexOf('…')` above it);
 *  3. picks the CANDIDATE SOURCE as the one whose text contains that needle;
 *  4. reads every `expect(<the region>).not.toContain('…')` up to the next
 *     assignment of the same name, and fails one whose needle's LAST occurrence
 *     in that source is before the anchor.
 *
 * Resolving the source by CONTENT instead of by tracking the variable back to
 * its `readFileSync` is deliberate. The nine call sites in the tree today read
 * their source through FIVE different shapes (`Bun.file(CONST).text()`,
 * `Bun.file(new URL(...)).text()`, `readFileSync(join(REPO_ROOT, ...))`,
 * `readFileSync(new URL(...))`, and a local `read(...parts)` helper), and a
 * tracker that understands four of them reports the fifth as *"no control"* —
 * a false finding, which is the cry-wolf shape AGENTS.md says makes a gate
 * people stop running.
 *
 * ## What it CANNOT catch — read this before quoting it as assurance
 *
 *  - **An UNRESOLVED call site is reported and never failed.** If no candidate
 *    source in the file contains the anchor needle — a computed anchor, a source
 *    fetched at runtime, a path shape not in the list above — the site is
 *    counted in the report and skipped. An unresolved site is the absence of a
 *    reading, not a clean bill of health.
 *  - **An IN-FILE FIXTURE is not in the population and is counted apart.** A
 *    call site whose source argument names a constant this same test file
 *    initialises from a literal — `const SOURCE = ['…','…'].join('\n')` — bounds
 *    a region in text the test wrote, not in a source file. There is nothing to
 *    resolve, and printing it as UNRESOLVED is what D1.294 was about: three such
 *    sites printed three UNRESOLVED lines on every clean run, which teaches a
 *    reader to skip exactly the line that would one day name a real one. They
 *    are counted on the summary line and listed in {@link Report.fixtures} for a
 *    caller that wants them; the per-site lines are the noise, so there are none.
 *
 *    **Why not the other repair — give those anchors a real source.** Measured
 *    2026-09-18 on a scratch copy of the only such file
 *    (`packages/shared/src/testing/__tests__/source-regions.test.ts`, the brace
 *    matcher's own unit test): planting its two synthetic sources as a real
 *    module resolves all three sites AND produces a `no-control` FINDING on the
 *    first of them, because that case asserts the positives and its negative
 *    half is the SIBLING `it` — past the reassignment where this scanner's
 *    variable scope ends. So the repair that reads as the thorough one turns a
 *    correct file red. The classification also cannot hide a real site: it is
 *    applied only where no candidate source contained the anchor, i.e. strictly
 *    inside what was already the unresolved bucket.
 *  - **It does not parse.** Anchors and needles are read as single-quoted or
 *    double-quoted literals with the ordinary escapes; a needle assembled from
 *    a template literal or concatenated at runtime is invisible.
 *  - **It says nothing about whether the control is the RIGHT declaration** —
 *    only that the region could, in principle, contain it. A needle three
 *    methods below the region is a weaker control than the next declaration
 *    down, and both pass here.
 *  - **A missing control is reported as a finding**, because the rule is that
 *    the control comes with the conversion. A site whose region is bounded some
 *    other way (an end anchor read out of a minified bundle) does not use
 *    `bracedRegion` at all and is therefore out of scope by construction.
 *
 * ## Why a text scanner and not the TypeScript AST
 *
 * Same trade as `check-module-graph-hooks.ts`: the population is a handful of
 * files found by one `git grep`, the shape is two identifiers and a string, and
 * this has to be cheap enough to sit in `lint:chain`. Loading a TS program over
 * the sources under test costs minutes.
 *
 * Usage:
 *   bun scripts/check-braced-region-controls.ts            # report, always exit 0
 *   bun scripts/check-braced-region-controls.ts --check    # exit 1 on a finding
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GateSafetyRefusal } from './gate-safety'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The helper whose call sites are the population. */
export const HELPER = 'bracedRegion'

/** Where to look for them. `:(glob)` on every `**` — a bare one drops files silently. */
export const CENSUS_PATHSPEC: readonly string[] = [
  ':(glob)packages/**/*.test.ts',
  ':(glob)packages/**/*.test.tsx',
  ':(glob)packages/**/*.isolated.ts',
  ':(glob)apps/**/*.test.ts',
  ':(glob)apps/**/*.test.tsx',
  ':(glob)apps/**/*.isolated.ts',
]

export type FindingKind = 'above-region' | 'no-control'

export interface Finding {
  readonly kind: FindingKind
  /** The test file, repo-relative. */
  readonly file: string
  /** 1-based line of the `bracedRegion(` call. */
  readonly line: number
  /** The anchor needle the region starts at. */
  readonly anchor: string
  /** The control needle, for an `above-region` finding. */
  readonly needle?: string
  /** The source file the anchor was resolved in, repo-relative. */
  readonly source?: string
}

export interface Report {
  readonly sites: number
  readonly resolved: number
  readonly unresolved: { file: string; line: number; anchor: string }[]
  /** Sites bounding a region in a literal the test file itself declares. */
  readonly fixtures: { file: string; line: number; anchor: string; name: string }[]
  readonly findings: Finding[]
}

/** Unescape the ordinary escapes a TS string literal carries. Nothing clever. */
export function unescapeLiteral(raw: string): string {
  return raw.replace(/\\(n|t|r|'|"|`|\$|\\)/g, (_all, ch: string) => {
    if (ch === 'n') return '\n'
    if (ch === 't') return '\t'
    if (ch === 'r') return '\r'
    return ch
  })
}

/**
 * The first quoted literal in `text`, or null. Handles `'…'`, `"…"` and a
 * BACKTICKED literal that carries no `${`.
 *
 * D1.290. The backtick arm is not a convenience: without it the scanner read
 * ``adapter.indexOf(`msg.subtype === 'permission_denied'`)`` as its INNER
 * literal, `permission_denied`, which occurs in two of the candidate sources —
 * so the gate resolved the anchor in the wrong file and REFUSED a control that
 * is correct in the file the test actually reads. Silently picking the wrong
 * source is worse than reading no source at all, which is why this is a fix and
 * the double-quoting at the call site was a workaround.
 *
 * The decision is made at the FIRST quote character rather than by an
 * alternation over the whole text, so a template the scanner cannot read stays
 * unreadable instead of degrading into its inner literal: an interpolating
 * `` `private ${name}(` `` returns null (an UNRESOLVED site, a reported absence)
 * and never `private `. Both directions are pinned in the suite.
 */
export function firstLiteral(text: string): string | null {
  const opener = /['"`]/.exec(text)
  if (opener === null) return null
  if (text[opener.index] === '`') {
    const backticked = /^`((?:[^`\\$]|\\.|\$(?!\{))*)`/.exec(text.slice(opener.index))
    return backticked === null ? null : unescapeLiteral(backticked[1] as string)
  }
  const match = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/.exec(text)
  if (match === null) return null
  return unescapeLiteral(match[1] ?? match[2] ?? '')
}

/**
 * Every existing file a path literal in `text` names.
 *
 * Deliberately generous: a candidate that is not the source under test simply
 * will not contain the anchor, and step 3 discards it. Being generous costs a
 * few `readFileSync` calls; being narrow costs a false finding.
 */
export function candidateSources(text: string, testFile: string, root: string): string[] {
  const dir = dirname(testFile)
  const found = new Set<string>()

  const add = (candidate: string): void => {
    const absolute = isAbsolute(candidate) ? candidate : resolve(root, candidate)
    if (!existsSync(absolute)) return
    if (!statSync(absolute).isFile()) return
    found.add(absolute)
  }

  // `new URL('<rel>', import.meta.url)` — relative to the TEST file's directory.
  for (const match of text.matchAll(/new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) {
    add(resolve(dir, match[1] as string))
  }

  // `join(REPO_ROOT, '<repo-relative>')` and its lowercase spellings.
  for (const match of text.matchAll(/join\(\s*(?:REPO_ROOT|repoRoot|ROOT)\s*,\s*['"]([^'"]+)['"]/g)) {
    add(resolve(root, match[1] as string))
  }

  // `join(import.meta.dir, '..', '..', 'a', 'b.ts')` — a parts list.
  for (const match of text.matchAll(/join\(\s*import\.meta\.dir\s*,\s*((?:['"][^'"]+['"]\s*,?\s*)+)\)/g)) {
    const parts = [...(match[1] as string).matchAll(/['"]([^'"]+)['"]/g)].map(part => part[1] as string)
    add(resolve(dir, ...parts))
  }

  // A bare literal that looks like a source path, resolved both ways.
  for (const match of text.matchAll(/['"]([A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|cjs|js))['"]/g)) {
    const literal = match[1] as string
    add(resolve(dir, literal))
    add(resolve(root, literal))
  }

  // A PATH SPELLED ACROSS ARGUMENTS, against every ancestor of the test file.
  //
  // `system-prompt-append.test.ts` reads its sources through a local helper —
  // `const read = (...parts) => readFileSync(join(import.meta.dir, '..', '..', ...parts), 'utf8')`
  // called as `read('agent', 'codex-agent.ts')` — so no single literal on the
  // call line is a path and the parts list is split between two places. Rather
  // than teach the scanner about that one helper (and report the NEXT shape as
  // a missing control, which is the false finding this file exists not to
  // produce), take every line's bare literals in order and try them against each
  // ancestor directory up to the repo root. A candidate that is not the source
  // under test simply will not contain the anchor.
  for (const line of text.split('\n')) {
    const parts = [...line.matchAll(/['"]([A-Za-z0-9_.-]+)['"]/g)].map(match => match[1] as string)
    if (parts.length < 2) continue
    if (!/\.(ts|tsx|mjs|cjs|js)$/.test(parts[parts.length - 1] as string)) continue
    let base = dir
    for (let up = 0; up < 8 && base.startsWith(root); up += 1) {
      add(resolve(base, ...parts))
      base = dirname(base)
    }
  }

  return [...found]
}

/** `const NAME = '<literal>'` in the test file, so a control can name a constant. */
export function literalConstants(text: string): Map<string, string> {
  const constants = new Map<string, string>()
  for (const match of text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*$/gm)) {
    constants.set(match[1] as string, unescapeLiteral((match[2] as string).slice(1, -1)))
  }
  return constants
}

/**
 * The names of constants this file initialises from an IN-FILE literal.
 *
 * Three shapes, which are the three a test writes a fixture in: a single-line
 * string constant, an array of string literals joined, and a template literal.
 * Only the NAME is needed — the claim being made is "this source is text the
 * test wrote, so there is no file to read", and the declaration's shape is the
 * whole of that claim. Reconstructing the text would add a second way to be
 * wrong (a bad reconstruction reads as UNRESOLVED again) for no extra reading.
 */
export function inlineLiteralSources(text: string): Set<string> {
  const names = new Set<string>(literalConstants(text).keys())
  for (const match of text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\[[\s\S]*?\]\s*\.join\(/g)) {
    names.add(match[1] as string)
  }
  for (const match of text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*`/g)) {
    names.add(match[1] as string)
  }
  return names
}

/** Resolve a `not.toContain(...)` argument: a literal, or a constant named above. */
export function resolveNeedle(argument: string, constants: Map<string, string>): string | null {
  const literal = firstLiteral(argument)
  if (literal !== null) return literal
  const identifier = /^\s*([A-Za-z_$][\w$]*)\s*\)/.exec(argument)
  if (identifier === null) return null
  return constants.get(identifier[1] as string) ?? null
}

/**
 * Audit one test file.
 *
 * `sourceText` is injected only by the tests, which plant a scratch pair rather
 * than mutating the tree — the restore a real-tree mutation owes is the thing
 * AGENTS.md records silently invalidating every later verdict.
 */
export function auditFile(
  file: string,
  text: string,
  root: string,
  readSource: (path: string) => string = path => readFileSync(path, 'utf8'),
): {
  sites: number
  resolved: number
  unresolved: Report['unresolved']
  fixtures: Report['fixtures']
  findings: Finding[]
} {
  const lines = text.split('\n')
  const constants = literalConstants(text)
  const inlineSources = inlineLiteralSources(text)
  const candidates = candidateSources(text, isAbsolute(file) ? file : resolve(root, file), root)
    .map(path => ({ path, text: readSource(path) }))

  const findings: Finding[] = []
  const unresolved: Report['unresolved'] = []
  const fixtures: Report['fixtures'] = []
  let sites = 0
  let resolved = 0

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    // The tail is captured to END OF LINE and never to the first `)`: an anchor
    // needle is very often a signature (`'private deliverAsyncHookNote(a: A): void'`)
    // and carries its own parentheses, so a `[^)]*` capture truncates the
    // literal mid-string, `firstLiteral` then finds no closing quote, and the
    // site reads as UNRESOLVED — a silent skip of exactly the call sites whose
    // anchors are most precise. Measured on this file's own first draft.
    const call = new RegExp(`(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${HELPER}\\(\\s*([A-Za-z_$][\\w$]*)\\s*,\\s*(.*)$`).exec(line)
    if (call === null) continue
    sites += 1

    const region = call[1] as string
    const sourceName = call[2] as string
    const startExpression = call[3] as string

    // The anchor: inline `src.indexOf('…')`, or the `const start = …indexOf('…')`
    // above this line. Nothing further back than the file's start.
    let anchor = /indexOf\(/.test(startExpression) ? firstLiteral(startExpression) : null
    if (anchor === null) {
      const name = /^\s*([A-Za-z_$][\w$]*)\s*\)?/.exec(startExpression)?.[1]
      if (name !== undefined) {
        for (let back = index - 1; back >= 0 && anchor === null; back -= 1) {
          const assignment = new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*[A-Za-z_$][\\w$]*\\.indexOf\\((.*)$`).exec(lines[back] as string)
          if (assignment !== null) anchor = firstLiteral(assignment[1] as string)
        }
      }
    }

    if (anchor === null || anchor === '') {
      unresolved.push({ file, line: index + 1, anchor: startExpression.trim() })
      continue
    }

    const source = candidates.find(candidate => candidate.text.includes(anchor as string))
    if (source === undefined) {
      // The fixture split happens HERE and nowhere earlier, so a site that a
      // real source resolves stays resolved even if its variable's name is also
      // a literal constant somewhere in the file. This is a refinement of the
      // unresolved bucket, never a new way out of the gate.
      if (inlineSources.has(sourceName)) fixtures.push({ file, line: index + 1, anchor, name: sourceName })
      else unresolved.push({ file, line: index + 1, anchor })
      continue
    }
    resolved += 1

    const anchorAt = source.text.indexOf(anchor)
    const controls: string[] = []
    for (let ahead = index + 1; ahead < lines.length; ahead += 1) {
      const next = lines[ahead] as string
      // The region variable's scope ends where it is next assigned.
      if (new RegExp(`(?:const|let)\\s+${region}\\s*=`).test(next)) break
      const control = new RegExp(`expect\\(\\s*${region}\\s*\\)\\s*\\.not\\.toContain\\((.*)$`).exec(next)
      if (control === null) continue
      const needle = resolveNeedle(control[1] as string, constants)
      if (needle === null || needle === '') continue
      controls.push(needle)
      if (source.text.lastIndexOf(needle) < anchorAt) {
        findings.push({
          kind: 'above-region',
          file,
          line: ahead + 1,
          anchor,
          needle,
          source: source.path.startsWith(root) ? source.path.slice(root.length + 1) : source.path,
        })
      }
    }

    if (controls.length === 0) {
      findings.push({
        kind: 'no-control',
        file,
        line: index + 1,
        anchor,
        source: source.path.startsWith(root) ? source.path.slice(root.length + 1) : source.path,
      })
    }
  }

  return { sites, resolved, unresolved, fixtures, findings }
}

/**
 * Every tracked test file naming the helper, read from the WORKING TREE.
 *
 * NOT `--cached`, and the first draft got this wrong in a way that made the
 * gate silently answer the previous commit's question: the file LIST came from
 * the index while the CONTENT came from disk, so a file converted and not yet
 * committed was invisible — the four codex conversions of D1.111 landed with
 * this gate reporting the same 14 call sites it had before them. This gate's
 * subject INCLUDES the runner's own edit (you convert a window and add its
 * control in one commit), which is exactly the reason
 * `check-settings-line-citations.ts` gives for keeping the working tree as its
 * default. The cost is the one that default always carries — a sibling lane's
 * uncommitted conversion is visible here — and it is the right trade for a gate
 * whose findings are about the diff in front of you.
 */
export function callSiteFiles(root: string = REPO_ROOT): string[] {
  try {
    return execFileSync('git', ['grep', '-alI', '-F', HELPER, '--', ...CENSUS_PATHSPEC], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .filter(line => line !== '')
  } catch (error) {
    if ((error as { status?: number }).status === 1) return []
    throw error
  }
}

export function audit(root: string = REPO_ROOT, files: readonly string[] = callSiteFiles(root)): Report {
  let sites = 0
  let resolved = 0
  const unresolved: Report['unresolved'] = []
  const fixtures: Report['fixtures'] = []
  const findings: Finding[] = []
  for (const file of files) {
    const result = auditFile(file, readFileSync(resolve(root, file), 'utf8'), root)
    sites += result.sites
    resolved += result.resolved
    unresolved.push(...result.unresolved)
    fixtures.push(...result.fixtures)
    findings.push(...result.findings)
  }
  return { sites, resolved, unresolved, fixtures, findings }
}

function main(argv: readonly string[]): number {
  const check = argv.includes('--check')
  const files = callSiteFiles()

  // A run that finds no call sites at all is the probe having broken — the
  // helper renamed, the `:(glob)` magic lost — not the population having
  // emptied. Refuse rather than print a clean report, which is the shape of a
  // gate that has silently stopped gating.
  if (files.length === 0) {
    throw new GateSafetyRefusal(
      `REFUSED: no test file names \`${HELPER}\`. That is the probe failing, not the population `
      + 'emptying — check that the helper still carries that name in '
      + 'packages/shared/src/testing/source-regions.ts and that the `:(glob)` magic is still on every '
      + 'pathspec (a bare `**` is read literally by git and silently drops files).',
    )
  }

  const report = audit(REPO_ROOT, files)
  console.log(
    `check-braced-region-controls: ${report.sites} ${HELPER}() call site(s) across ${files.length} `
    + `test file(s); ${report.resolved} resolved to a source, ${report.fixtures.length} over an in-file `
    + `fixture (a literal the test declares — no source file to read), ${report.unresolved.length} unresolved.`,
  )

  for (const site of report.unresolved) {
    console.log(`  UNRESOLVED ${site.file}:${site.line} — anchor ${JSON.stringify(site.anchor)} matched no candidate source.`)
  }
  if (report.unresolved.length > 0) {
    console.log('  An unresolved site is the ABSENCE of a reading, not a clean one; read its control by hand.')
  }

  if (report.findings.length === 0) return 0

  console.log('')
  console.log(`REFUSED: ${report.findings.length} boundary control(s) that cannot fail.`)
  for (const finding of report.findings) {
    if (finding.kind === 'above-region') {
      console.log(
        `  ${finding.file}:${finding.line} — not.toContain(${JSON.stringify(finding.needle)}) is declared `
        + `ABOVE the anchor ${JSON.stringify(finding.anchor)} in ${finding.source ?? '?'}.`,
      )
    } else {
      console.log(
        `  ${finding.file}:${finding.line} — ${HELPER}() with NO not.toContain control `
        + `(anchor ${JSON.stringify(finding.anchor)}, source ${finding.source ?? '?'}).`,
      )
    }
  }
  console.log(
    '  A brace scan only runs FORWARD, so a needle whose every occurrence sits above the anchor can'
    + '\n  never be inside the region — the control passes on the exact runaway it exists to catch, and'
    + '\n  it passes identically before and after the bug. Anchor the control on a DECLARATION below'
    + '\n  the region: the next method, the next exported function, the next arrow assignment.',
  )
  return check ? 1 : 0
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
