/**
 * census-switch-in-map — the census D1.281 wanted, with the instrument it needs.
 *
 * D1.292.
 *
 * ## The shape, and why a grep cannot find it
 *
 * D1.252's defect: `renderSettingsTiersLine` switched over a discriminated union
 * inside a `.map()` whose result is then filtered, and its `default:` arm was a
 * bare `return undefined`. A clause landed in `config-doctor.ts` without its arm
 * fell through and vanished from the notice IN SILENCE — the quiet direction the
 * exhaustive switch exists to prevent. The fix binds the narrowed clause to
 * `never`, which turns the same omission into a BUILD failure (TS2322) on that
 * line, and keeps `return undefined` beside it so the filter still drops an id
 * that could only arrive by a cast.
 *
 * D1.281 then asked for the siblings and was REFUTED as worded: `: never = `
 * finds seven sites and exactly one returns the binding. The class actually
 * worth finding is the one above — a `switch` inside a `.map()`/`.filter()`/
 * `.flatMap()` callback whose `default:` arm has no `never` binding — and WI-ad
 * measured that a proximity heuristic cannot answer it: a `switch` within 70
 * lines of a `.map(` gives 22 candidates over `packages`/`apps`/`scripts`, 20 of
 * them bare, and the three read by hand are ALL false positives because the
 * switch is in a neighbouring function. Proximity in a text file is not
 * containment in a program.
 *
 * So this walks the TypeScript AST with the `typescript` already in
 * `node_modules` (5.9.3), and the containment it reports is the real one: the
 * walk STOPS at any nested function-like node, so a `switch` inside a callback
 * inside the map callback is not attributed to the map — it is not what the
 * map's own arm returns, which is the whole subject.
 *
 * ## What it is NOT
 *
 * **Not a gate.** Every hit is a FINDING for a human to read and row, not a
 * failure: a `default:` arm can be perfectly correct without a `never` binding
 * (the switch may not be over a closed union at all), and a census that failed
 * on those would be the cry-wolf shape AGENTS.md says makes a rule people stop
 * running. It prints, it exits 0, and `--check` is deliberately not a flag.
 *
 * **Not type-aware.** It reads one file at a time with no program and no
 * checker, so it cannot tell a switch over a discriminated union from a switch
 * over a string. That is the difference between seconds and minutes over this
 * tree, and the reader it is written for is a human triaging a short list.
 *
 * **It knows one spelling of the binding**, `const x: never = y`, which is the
 * only one this tree uses (15 occurrences; `satisfies never` scores zero and the
 * single `AssertNever` is a type-level utility in `protocol/routing.ts`, not a
 * switch arm). A helper-call spelling such as `assertNever(x)` would read as a
 * hit here. Check before believing an absence:
 * `git grep -acI 'satisfies never|assertNever\(' -- packages apps scripts`.
 *
 * Usage:
 *   bun scripts/census-switch-in-map.ts          # the census, always exit 0
 *   bun scripts/census-switch-in-map.ts --all    # also list the non-hit classes
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The array methods whose callback's `return` is the subject. */
export const MAPPING_METHODS: readonly string[] = ['map', 'filter', 'flatMap']

/** Where to look. `:(glob)` on every `**` — a bare one is read literally by git. */
export const CENSUS_PATHSPEC: readonly string[] = [
  ':(glob)packages/**/*.ts',
  ':(glob)packages/**/*.tsx',
  ':(glob)apps/**/*.ts',
  ':(glob)apps/**/*.tsx',
  ':(glob)scripts/**/*.ts',
]

export type SwitchVerdict =
  /** A `default:` arm with no `never` binding — the class D1.252 was. */
  | 'bare-default'
  /** A `default:` arm that binds the narrowed value to `never`. */
  | 'never-bound'
  /** No `default:` arm at all — exhaustive by other means, or not closed. */
  | 'no-default'

export interface Hit {
  readonly file: string
  /** 1-based line of the `switch` keyword. */
  readonly line: number
  /** The array method whose callback contains it. */
  readonly method: string
  /** 1-based line of the `.map(`/`.filter(`/`.flatMap(` call. */
  readonly callLine: number
  readonly verdict: SwitchVerdict
  /** The number of `case` clauses, which is what makes a hit worth reading. */
  readonly cases: number
}

/** `const unhandled: never = clause` — the only spelling this tree uses. */
export function bindsNever(clause: ts.DefaultClause): boolean {
  for (const statement of clause.statements) {
    const declarations = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations
      : ts.isBlock(statement)
        ? statement.statements.filter(ts.isVariableStatement).flatMap(inner => [...inner.declarationList.declarations])
        : []
    for (const declaration of declarations) {
      if (declaration.type?.kind === ts.SyntaxKind.NeverKeyword) return true
    }
  }
  return false
}

/** The callback a mapping call was given, or `null` when it was not given one. */
function callbackOf(call: ts.CallExpression): ts.ArrowFunction | ts.FunctionExpression | null {
  const first = call.arguments[0]
  if (first === undefined) return null
  if (ts.isArrowFunction(first) || ts.isFunctionExpression(first)) return first
  return null
}

/**
 * Every `switch` the callback's OWN body contains.
 *
 * The descent stops at a nested function-like node, and that stop is the whole
 * instrument: a `switch` inside another callback is not what this `map` returns,
 * and counting it is exactly the false positive the proximity heuristic produced
 * three times out of three. A nested `map` gets its own entry when the walk
 * reaches it at the top level, so nothing is lost by stopping.
 */
export function ownSwitches(callback: ts.ArrowFunction | ts.FunctionExpression): ts.SwitchStatement[] {
  const found: ts.SwitchStatement[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isSwitchStatement(node)) {
      found.push(node)
      // Its own clauses are still walked: a switch inside a switch arm is this
      // callback's too.
    }
    if (
      ts.isArrowFunction(node)
      || ts.isFunctionExpression(node)
      || ts.isFunctionDeclaration(node)
      || ts.isMethodDeclaration(node)
      || ts.isClassDeclaration(node)
    ) return
    node.forEachChild(visit)
  }
  callback.body.forEachChild(visit)
  return found
}

export function verdictOf(statement: ts.SwitchStatement): SwitchVerdict {
  const fallback = statement.caseBlock.clauses.find(ts.isDefaultClause)
  if (fallback === undefined) return 'no-default'
  return bindsNever(fallback) ? 'never-bound' : 'bare-default'
}

/**
 * A file that CANNOT contain the shape, decided without parsing it.
 *
 * Parsing is the whole cost — 200 files took 41.4 s measured, so the full 5 079
 * would be about seventeen minutes, which is not a census anybody runs twice.
 * A file with no `switch` keyword cannot hold a `SwitchStatement`, and one with
 * no `.map(`/`.filter(`/`.flatMap(` cannot hold the call. Both are SAFE
 * directions: the worst a keyword inside a string or a comment can do is buy a
 * parse that finds nothing, never a miss. Measured over the same 5 079 files:
 * 1 007 contain `switch` and 630 contain both, so the parse is done for 12 % of
 * the tree.
 */
export function cannotContainShape(text: string): boolean {
  if (!text.includes('switch')) return true
  return !MAPPING_METHODS.some(method => text.includes(`.${method}(`))
}

export function auditSource(file: string, text: string): Hit[] {
  if (cannotContainShape(text)) return []
  // `setParentNodes` stays FALSE: nothing here walks upward, and `getStart` is
  // given the source file explicitly, which is the form that does not need a
  // parent pointer.
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false)
  const hits: Hit[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      const callback = MAPPING_METHODS.includes(method) ? callbackOf(node) : null
      if (callback !== null) {
        const callLine = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
        for (const statement of ownSwitches(callback)) {
          hits.push({
            file,
            line: source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1,
            method,
            callLine,
            verdict: verdictOf(statement),
            cases: statement.caseBlock.clauses.filter(ts.isCaseClause).length,
          })
        }
      }
    }
    node.forEachChild(visit)
  }
  source.forEachChild(visit)
  return hits
}

export function censusFiles(root: string = REPO_ROOT): string[] {
  return execFileSync('git', ['ls-files', '--', ...CENSUS_PATHSPEC], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(line => line !== '')
}

export function census(root: string = REPO_ROOT, files: readonly string[] = censusFiles(root)): Hit[] {
  const hits: Hit[] = []
  for (const file of files) hits.push(...auditSource(file, readFileSync(resolve(root, file), 'utf8')))
  return hits
}

function main(argv: readonly string[]): number {
  const all = argv.includes('--all')
  const files = censusFiles()
  const hits = census(REPO_ROOT, files)
  const of = (verdict: SwitchVerdict): Hit[] => hits.filter(hit => hit.verdict === verdict)
  const bare = of('bare-default')

  console.log(
    `census-switch-in-map: ${hits.length} switch(es) inside a ${MAPPING_METHODS.map(m => `.${m}()`).join('/')} `
    + `callback across ${files.length} file(s) — ${bare.length} with a BARE default, `
    + `${of('never-bound').length} binding \`never\`, ${of('no-default').length} with no default arm.`,
  )

  for (const hit of bare) {
    console.log(
      `  ${hit.file}:${hit.line} — ${hit.cases} case(s), inside the .${hit.method}() at line ${hit.callLine}: `
      + '`default:` with no `never` binding.',
    )
  }
  if (bare.length > 0) {
    console.log(
      '  Each is a FINDING to read, never a failure: a bare default is correct wherever the switch is not'
      + '\n  over a closed union, and this census is not type-aware. Where it IS closed, the D1.252 shape is'
      + '\n  `const unhandled: never = value` in the default arm — a member added without its case then'
      + '\n  fails the BUILD on that line instead of disappearing from the output in silence.',
    )
  }

  if (all) {
    for (const verdict of ['never-bound', 'no-default'] as const) {
      for (const hit of of(verdict)) {
        console.log(`  [${verdict}] ${hit.file}:${hit.line} — ${hit.cases} case(s) in .${hit.method}()`)
      }
    }
  }
  return 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
