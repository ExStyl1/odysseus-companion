#!/usr/bin/env bun
/**
 * check-module-graph-hooks — the module-graph hook family has never been
 * enumerated, so every member has been found by a lane meeting a red.
 *
 * P6.862. `packages/shared/src/testing/module-graph-budgets.ts` exists because
 * a `beforeAll`/`beforeEach` that pays a dynamic `import(...)` is doing I/O
 * against bun's 5 000 ms default timer, and the seven suites that had noticed
 * had each grown their own hand-written number. What nothing could do was say
 * WHO ELSE is in the family. `capability-detail-registry.test.ts` carried a
 * hand-written `60_000` that sat below its own measured floor for as long as the
 * file existed (`b1571ad0a`), and the only instrument that found it was a lane
 * hitting the red in wave 9.
 *
 * This guard is that instrument, run on purpose: it lists every
 * `beforeAll`/`beforeEach` in `apps/**` and `packages/**` test files whose body
 * pays a dynamic import and whose budget argument is ABSENT (bun's 5 s default)
 * or a NUMERIC LITERAL (a hand-written number nothing can re-derive).
 *
 * ==========================================================================
 * WHAT THIS GUARD CANNOT CATCH — read this before quoting it as assurance.
 *
 * It answers one question: does this hook declare a budget from the shared
 * module. It CANNOT tell whether the budget is big enough BY ITSELF — sizing
 * needs the zero-case control the budgets module documents, and a member with
 * `MODULE_GRAPH_HOOK_BUDGET_MS` whose graph outgrows 600 000 ms passes here
 * silently. Since P6.1000 that half is answered by DATA rather than by the
 * scanner: {@link COSTS_FILE} carries the readings lanes have taken, and every
 * run prints the largest one beside each budget with the ratio, warning above
 * {@link COST_RATIO_WARN}. What stays true is that a member NOBODY has measured
 * still passes silently — an empty row is the absence of a reading, not a small
 * one. It does not read `setDefaultTimeout`, which is the family's other
 * two shapes; a file that pays its import across its cases rather than in one
 * hook is out of scope by construction. It cannot see a STATIC top-level import
 * that costs the same — AGENTS.md rule 24's own preferred fix — because that
 * import has no timer attached to notice.
 *
 * It cannot see a hook whose module-graph cost is a BUILD rather than an
 * `import(` (F1.650). An in-process `Bun.build(` — the prebuild `beforeAll` of
 * `pi-bundled-oauth-flows.test.ts` — and, since `1db74079f`, a child
 * `bun build` spawn — the lineage prebuild of
 * `pi-session-lineage-real-server.test.ts` — walk the same graph with no
 * dynamic import in the hook body, so neither hook is a member and neither is
 * counted in the summary. The COST LEDGER inherits it: a reading appended to
 * {@link COSTS_FILE} for either file prints as "a STALE line", because the
 * scanner sees no hook there — it is NOT stale. Both hooks sit on a named
 * constant of their own with the readings in its docblock (the escape hatch
 * below), and that docblock is where such a reading belongs; one put on
 * `MODULE_GRAPH_HOOK_BUDGET_MS` instead is refused, use by use (F1.668). Teaching the
 * scanner `Bun.build(` was declined under TRANSPARENT/SIMPLE (F1.639): it would
 * see the in-process build and still miss the child one, and a named constant
 * gives the ledger no number to divide by, so neither row would gain a ratio.
 *
 * It DOES see a hook that pays the graph in a CHILD BUN rather than in-process
 * (UB12.26, 2026-10-16): a spawn whose argv starts `process.execPath, <module>`
 * written in the hook body ({@link CHILD_BUN_MODULE} names the forms), the
 * shape `registry-render.test.ts` brought (one child renders the whole renderer
 * graph, 200.49 s for the file on 2026-09-23). The child `bun build` above
 * stays unseen on purpose — an argv whose first element is the string `build`
 * is excluded — so F1.650's account holds. What this reads is the argv as
 * WRITTEN in the hook: a spawn inside a helper the hook calls, or an argv held
 * in a variable, is read no further. Measured when it landed: 15 hook bodies
 * in `apps/**` and `packages/**` name `process.execPath`; 11 are child-bun
 * members, and the other 4 name it as an MCP server's `command` or inside a
 * script string, not as a spawned argv. Until UB12.26 `registry-render.test.ts`
 * was a member only because a COMMENT in its hook read "at import (AGENTS.md",
 * so two later hooks of the same shape whose comment did not (UB14.2, UB14.3)
 * were refused as unseen importers; a comment is no longer read as code in a
 * hook body either.
 *
 * And it deliberately does NOT report a NAMED constant that is not one of the
 * three exports. The budgets module documents that escape hatch in its own
 * words: "A caller whose measured floor does not fit one of the three numbers
 * below should declare its own constant beside its `setDefaultTimeout` WITH its
 * reading written down". A named constant is greppable and carries a docblock,
 * which is what this guard is for; a bare number is neither.
 * ==========================================================================
 *
 * ## Why a text scanner and not the TypeScript AST
 *
 * The population is ~1 950 test files and the shape being matched is two
 * identifiers and a trailing argument. A balanced-delimiter scan that skips
 * strings, template literals and comments answers it in about a second; loading
 * a TS program over the same files costs minutes and this has to be cheap
 * enough to sit in `lint:chain`. The cost is stated rather than hidden: a hook
 * assembled dynamically, or a `beforeAll` aliased under another name, is
 * invisible here. Regex literals are skipped as well since UB12.72, by a
 * look-behind whose residue {@link regexLiteralEnd} states — before it, one
 * quote inside a `toMatch(/…/)` hid every hook below it.
 *
 * ## The baseline is keyed by FILE, like `check-ledger-citations`
 *
 * Same reason and the same trade: a line number has a measured half-life of
 * about two days in this tree, so a line-keyed baseline would ship red on drift
 * nobody caused, which is how a gate gets muted. The cost is that a file with
 * two unbudgeted hooks is silenced by one entry. Findings already in the tree
 * live in `scripts/module-graph-hook-baseline.txt` with a reason each; the gate
 * is red only on a NEW one.
 *
 * ## The STALE-ENTRY pass, and why it warns rather than fails (P6.978)
 *
 * A file-keyed baseline can go quiet in a direction its own tests could not see.
 * The completeness controls above all ask *is this baselined file still a test
 * file in scope* — never *is it still a FINDING*. A file that was converted to a
 * shared budget and left its line behind is therefore invisible: it is in scope,
 * it is silenced, and the day it regains an unbudgeted hook the gate stays
 * green. Two entries sat in exactly that state for two days and were removed by
 * hand (W9-ce, 2026-09-10) — a pre-silenced future finding is the one way this
 * shape of baseline goes quiet on real drift.
 *
 * It WARNS rather than failing, and that is a posture rather than a detail
 * (controller decision, 2026-09-10): `--check` failing on a stale entry reddens
 * `lint:chain` for every lane in the tree the moment somebody converts a file
 * and forgets its line, which is a fix landing punished by the gate that asked
 * for it. Warning first, one wave of quiet, then a failure if it stays quiet.
 *
 * The warning goes to STDOUT, beside the summary it belongs to, for a measured
 * reason: `plan-status.py`'s unescaped-pipe guard writes its warning to stderr
 * while the table a reader actually reads lands on stdout, so every invocation
 * that captures or pipes only stdout drops it (AGENTS.md §Traps, 2026-09-08). A
 * warning on the other stream is a warning nobody reads.
 *
 * ## What it costs, measured rather than promised
 *
 * `bun run lint:module-graph-hooks` took **5.4 s, 6.8 s, 11.9 s, 26.3 s, 28.4 s
 * and 40.8 s** on identical bytes on 2026-09-08, at loads between 6.8 and 13.4
 * with six sibling lanes writing the tree — cpu **~1.6 s of a 40 s run, about
 * 4 %**. That is the same I/O signature the family it indexes is made of, so
 * read `user`/`sys` beside any future reading and do not treat one number here
 * as the cost. Reading all 1 959 test files instead of the 105 candidates took
 * 92 s at 0.7 % cpu, which is why the read set is narrowed at all.
 *
 * Usage:
 *   bun scripts/check-module-graph-hooks.ts                    # report
 *   bun scripts/check-module-graph-hooks.ts --check            # exit 1 on a NEW finding
 *   bun scripts/check-module-graph-hooks.ts --update-baseline
 *
 * The COST LEDGER beside the baseline — `scripts/module-graph-hook-costs.txt`,
 * P6.1000 — is what closes the first sentence of the box above: a lane appends
 * its zero-case or cold reading there, and every run prints it beside the budget
 * it has to fit. See {@link COSTS_FILE}.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GateSafetyRefusal } from './gate-safety'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const BASELINE_FILE = 'scripts/module-graph-hook-baseline.txt'

/** The budgets a hook in this family is allowed to declare. */
export const SHARED_BUDGETS: readonly string[] = [
  'MODULE_GRAPH_HOOK_BUDGET_MS',
  'MODULE_GRAPH_BUDGET_MS',
  'MODULE_GRAPH_CASE_BUDGET_MS',
]

/** The module those three come from — asserted so a rename cannot go unnoticed. */
export const BUDGETS_MODULE = 'packages/shared/src/testing/module-graph-budgets.ts'

export const HOOKS: readonly string[] = ['beforeAll', 'beforeEach']

export type BudgetKind = 'shared' | 'named' | 'literal' | 'absent'

export interface HookCall {
  readonly file: string
  /** 1-based line of the hook's own name. */
  readonly line: number
  readonly hook: string
  /** The budget argument exactly as written, or undefined when there is none. */
  readonly budget: string | undefined
  readonly kind: BudgetKind
}

/** A token character — used to prove `beforeAll` is not the tail of `xbeforeAll`. */
const TOKEN_CHAR = /[A-Za-z0-9_$]/

/** The characters after which a `/` opens a regex literal rather than dividing (UB12.72). */
const REGEX_AFTER_PUNCTUATION: ReadonlySet<string> = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '+', '-', '*', '%', '~', '^',
])

/** The keywords after which a `/` opens a regex literal: each takes an expression (UB12.72). */
const REGEX_AFTER_KEYWORD: ReadonlySet<string> = new Set([
  'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of', 'return', 'throw', 'typeof', 'void',
  'yield',
])

/**
 * UB12.72 — the offset of the closing `/` of a REGEX LITERAL that opens at `i`,
 * or -1 when the `/` at `i` opens none (a division, a JSX closing tag, a comment,
 * or a `/` this cannot decide).
 *
 * Until UB12.72 the three walkers below read a regex literal as code, so a quote
 * inside one opened a "string" that ran to the next quote of that kind anywhere
 * later in the file. Measured 2026-10-16: line 99 of
 * `automations-restyle.test.tsx` (UB14.44) asserts
 * `toMatch(/<svg[^>]*class="[^"]*…text-tertiary"[^>]*aria-hidden="true"/)`, five
 * `"`, so lines 99–150 read as one string and the child-bun `beforeAll` at line
 * 121 was not code. `--check` refused the file as an importer with no matched
 * hook (rc 2) and `lint:chain` stopped there. The hook's own shape was
 * recognised all along (UB12.26); the regex above it hid it. A file that does
 * NOT import the hook budget would have lost the same hook silently, which is
 * why the scanner learns the form instead of the test file working round it.
 *
 * Which `/` opens a regex is decided as a tokenizer's look-behind decides it, by
 * the previous significant character: after an operator or opening punctuation
 * ({@link REGEX_AFTER_PUNCTUATION}), after `=>`, after a keyword that takes an
 * expression ({@link REGEX_AFTER_KEYWORD}, not a `.property` of that name), or at
 * the start of the text. Never after an identifier, a number, a quote, `)`, `]`
 * or `}` (a division or a JSX `/>`), after `<` (a JSX closing tag `</x>`), or
 * after a postfix `++`/`--` — the one place a division can follow an operator.
 *
 * The residue is stated rather than hidden. A regex after `)` (`if (x) /re/`) or
 * after a comment is still read as code, which is the behaviour before this row.
 * And a regex literal cannot span a line, so a candidate with no closing `/`
 * before its newline is NOT one: a misjudged `/` costs at most the rest of its
 * own line, never the rest of the file. Inside, `\` escapes the next character
 * and a `[…]` class may hold a `/`.
 *
 * Measured 2026-10-16 with the TypeScript 5.9.3 parser as the oracle, over the
 * 3 084 test files this guard's pathspecs name: 2 908 of 2 910 regex literals
 * recognised (the two misses both open the line below a `//` comment); and of
 * 27 236 occurrences of the five tokens the two guards search for (`beforeAll`,
 * `beforeEach`, `mock`, `import`, the hook budget), the scanner disagreed with
 * the parser on 111 before this row and on 12 after it, none of the 12 new.
 */
export function regexLiteralEnd(text: string, i: number): number {
  if (text[i] !== '/') return -1
  const next = text[i + 1]
  if (next === '/' || next === '*') return -1
  let p = i - 1
  while (p >= 0 && /\s/.test(text[p] as string)) p -= 1
  if (p >= 0) {
    const prev = text[p] as string
    if (TOKEN_CHAR.test(prev)) {
      let word = p
      while (word > 0 && TOKEN_CHAR.test(text[word - 1] as string)) word -= 1
      if (text[word - 1] === '.' || !REGEX_AFTER_KEYWORD.has(text.slice(word, p + 1))) return -1
    } else if (prev === '>') {
      if (text[p - 1] !== '=') return -1
    } else if (prev === '+' || prev === '-') {
      if (text[p - 1] === prev) return -1
    } else if (!REGEX_AFTER_PUNCTUATION.has(prev)) {
      return -1
    }
  }
  let inClass = false
  for (let j = i + 1; j < text.length; j += 1) {
    const c = text[j]
    if (c === '\n' || c === '\r') return -1
    if (c === '\\') {
      if (text[j + 1] === '\n' || text[j + 1] === '\r') return -1
      j += 1
      continue
    }
    if (inClass) {
      if (c === ']') inClass = false
      continue
    }
    if (c === '[') inClass = true
    else if (c === '/') return j
  }
  return -1
}

/**
 * Offsets of `token` that are really CODE — not inside a string, a template
 * literal, or a comment.
 *
 * This is not fastidiousness: `check-mock-module-spread`'s first draft searched
 * the raw text and counted **7** extra sites in this tree, every one of them a
 * commented-out `mock.module(` call. `splitCallArguments` below skips these
 * constructs INSIDE a call; nothing was skipping them on the way IN, and both
 * guards enter through this function for that reason (P6.984).
 *
 * For `findModuleGraphHooks` the measured population is ZERO — no commented-out
 * `beforeAll`/`beforeEach` with a dynamic import exists in the tree today
 * (2026-09-10: 50 hooks in 105 of 1996 test files, unchanged by this pass) — so
 * it closes a latent exposure rather than a live defect. A guard that counts
 * commented-out code prints a number nobody can act on.
 *
 * Regex literals are skipped too since UB12.72 ({@link regexLiteralEnd}, whose
 * docblock carries the measured miss and the residue): a quote inside one used
 * to open a string that hid the rest of the file.
 */
export function codeTokenOffsets(text: string, token: string): number[] {
  const out: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string
    const next = text[i + 1]
    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i)
      i = end === -1 ? text.length : end
      continue
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (ch === '/') {
      const end = regexLiteralEnd(text, i)
      if (end !== -1) i = end
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i += 1; i < text.length; i += 1) {
        const c = text[i]
        if (c === '\\') { i += 1; continue }
        if (c === ch) break
      }
      continue
    }
    if (ch === token[0] && text.startsWith(token, i)) out.push(i)
  }
  return out
}

/**
 * Walk `text` from `open` (the index of the call's `(`) to its matching `)`,
 * skipping strings, template literals and comments, and return the top-level
 * argument spans. Returns undefined when the call is unterminated, which on real
 * source means the scanner met something it does not model — reported as such
 * rather than guessed at.
 */
export function splitCallArguments(text: string, open: number): string[] | undefined {
  const args: string[] = []
  let depth = 0
  let start = open + 1
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i] as string
    const next = text[i + 1]
    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i)
      i = end === -1 ? text.length : end
      continue
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (ch === '/') {
      // UB12.72 — a delimiter or a comma inside a regex literal is not the call's.
      const end = regexLiteralEnd(text, i)
      if (end !== -1) i = end
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i += 1; i < text.length; i += 1) {
        const c = text[i]
        if (c === '\\') { i += 1; continue }
        if (c === ch) break
      }
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1
      if (depth === 1) start = i + 1
      continue
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1
      if (depth === 0) {
        args.push(text.slice(start, i))
        return args
      }
      continue
    }
    if (ch === ',' && depth === 1) {
      args.push(text.slice(start, i))
      start = i + 1
    }
  }
  return undefined
}

const NUMERIC = /^-?(?:0[xXbBoO])?[0-9_]+(?:\.[0-9_]+)?(?:e[+-]?[0-9]+)?$/i

/**
 * A dynamic import expression, `await` or not.
 *
 * It matched `await import(` alone in the first draft, and the guard's own
 * cross-check against the seven registered members caught that: the seventh,
 * `slash-command-menu.test.tsx`, wraps every one of its imports as
 * `loadStep('<name>', () => import('<name>'))` and contains the string
 * `await import(` nowhere. A matcher that cannot see a member it was written
 * from is a matcher that would have missed it. The lookbehind keeps a method
 * call `x.import(` and any identifier ending in `import` out.
 */
const DYNAMIC_IMPORT = /(?<![\w$.])import\s*\(/

/**
 * UB12.26 — a CHILD BUN on a module: `Bun.spawn([process.execPath, X, …])`,
 * `Bun.spawnSync({ cmd: [process.execPath, X, …] })` or
 * `spawn(process.execPath, [X, …])` (and the `spawnSync` twin of each), whose
 * module graph the child pays while the hook waits. Excluded: an argv whose
 * first element is the string `build` (F1.650's child build, which this guard
 * declines to see — see the box), and a method call such as `manager.spawn(`
 * (the lookbehind). The trailing lookahead starts with `\s*` so backtracking
 * over the whitespace after the comma cannot slip a `['build'` argv past it.
 */
const CHILD_BUN_MODULE =
  /(?<![\w$.])(?:Bun\.)?spawn(?:Sync)?\s*\(\s*(?:\{\s*cmd\s*:\s*)?\[?\s*process\.execPath\s*,(?!\s*\[?\s*(['"`])build\1)/

/**
 * `text` with every comment replaced by one space, strings and template
 * literals kept verbatim (so the `build` exclusion above can read its argv).
 *
 * UB12.26: a hook body used to be matched on its RAW text, so the comment
 * "freezes the config dir at import (AGENTS.md §Traps)" made
 * `registry-render.test.ts` a member by accident — measured 2026-10-16, the
 * only hook in the tree matched through a comment alone (none through a string
 * alone, which is why strings are left as they were). Template-literal
 * `${…}` bodies are not modelled, the same limit {@link codeTokenOffsets}
 * states; a regex literal is kept verbatim like a string since UB12.72, so a
 * quote or a `//` inside one no longer reads as the start of something else.
 */
function withoutComments(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string
    const next = text[i + 1]
    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i)
      if (end === -1) break
      out += ' '
      // The newline itself is kept: the loop's increment lands on it.
      i = end - 1
      continue
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) break
      out += ' '
      i = end + 1
      continue
    }
    if (ch === '/') {
      const end = regexLiteralEnd(text, i)
      if (end !== -1) {
        out += text.slice(i, end + 1)
        i = end
        continue
      }
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      for (; j < text.length; j += 1) {
        const c = text[j]
        if (c === '\\') { j += 1; continue }
        if (c === ch) break
      }
      out += text.slice(i, j + 1)
      i = j
      continue
    }
    out += ch
  }
  return out
}

export function classifyBudget(raw: string | undefined): BudgetKind {
  if (raw === undefined) return 'absent'
  const value = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
  if (value === '') return 'absent'
  if (SHARED_BUDGETS.includes(value)) return 'shared'
  if (NUMERIC.test(value)) return 'literal'
  return 'named'
}

/** A matched hook with the span of its call, from its name to its closing `)` (F1.668). */
interface MatchedHook {
  readonly call: HookCall
  readonly from: number
  readonly to: number
}

function scanModuleGraphHooks(file: string, text: string): MatchedHook[] {
  const out: MatchedHook[] = []
  for (const hook of HOOKS) {
    // Code offsets, not raw `indexOf` — a commented-out or quoted `beforeAll(`
    // is not a hook (P6.984).
    for (const at of codeTokenOffsets(text, hook)) {
      const before = at > 0 ? (text[at - 1] as string) : ''
      const after = text[at + hook.length]
      if (before !== '' && TOKEN_CHAR.test(before)) continue
      if (after !== '(') continue
      const open = at + hook.length
      const args = splitCallArguments(text, open)
      if (args === undefined) continue
      // The body's code, not its comments (UB12.26); a dynamic import or a
      // child bun on a module makes it a member.
      const body = withoutComments(args[0] ?? '')
      if (!DYNAMIC_IMPORT.test(body) && !CHILD_BUN_MODULE.test(body)) continue
      out.push({
        call: {
          file,
          line: text.slice(0, at).split('\n').length,
          hook,
          budget: args[1]?.trim() === '' ? undefined : args[1]?.trim(),
          kind: classifyBudget(args[1]),
        },
        // The arguments are contiguous slices one comma apart, so their joined
        // length puts `to` on the closing `)`.
        from: at,
        to: open + 1 + args.join(',').length,
      })
    }
  }
  return out.sort((a, b) => a.call.line - b.call.line)
}

/**
 * Every `beforeAll`/`beforeEach` in `text` whose body pays a dynamic import,
 * with the budget it declares. Exported so the tests can plant one.
 */
export function findModuleGraphHooks(file: string, text: string): HookCall[] {
  return scanModuleGraphHooks(file, text).map(hook => hook.call)
}

/** The hook-shaped budget — the one name `main`'s completeness refusal is keyed on. */
const HOOK_BUDGET = 'MODULE_GRAPH_HOOK_BUDGET_MS'

/** Code offsets of `token` that are a whole word: not the tail or head of another identifier. */
function wordOffsets(text: string, token: string): number[] {
  return codeTokenOffsets(text, token).filter(at =>
    !TOKEN_CHAR.test(text[at - 1] ?? '') && !TOKEN_CHAR.test(text[at + token.length] ?? ''))
}

/**
 * The spans of `import … from` clauses, from the keyword to its `from`.
 *
 * A clause is taken only when everything between the two keywords, comments
 * aside, is names, commas, braces and `*` — so a dynamic `import(`, an
 * `import.meta` and a side-effect `import '…'` (whose next `from` belongs to a
 * later statement) open no span. A re-export (`export { … } from`) is not
 * modelled, so one would be refused as a use; none of the 67 importers had one
 * on 2026-09-28.
 */
function importClauseSpans(text: string): Array<readonly [number, number]> {
  const froms = wordOffsets(text, 'from').filter(at => text[at - 1] !== '.')
  const spans: Array<readonly [number, number]> = []
  for (const at of wordOffsets(text, 'import')) {
    if (text[at - 1] === '.') continue
    const from = froms.find(offset => offset > at)
    if (from === undefined) continue
    const clause = text.slice(at + 'import'.length, from)
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    if (/^[\s\w$,{}*]*$/.test(clause)) spans.push([at, from])
  }
  return spans
}

/**
 * F1.668 — the 1-based lines of every USE of `MODULE_GRAPH_HOOK_BUDGET_MS` in
 * `text` that no matched hook accounts for.
 *
 * A use is accounted for when it sits inside the call of a hook the scanner
 * matched — its budget argument, or its body (`registry-render.test.ts` derives
 * a child's kill timer from the budget inside its own hook). Naming it in an
 * import clause is not a use, and neither is a comment or a string
 * ({@link codeTokenOffsets}). Everything else — the budget on an `it(...)` case,
 * on a `setDefaultTimeout(...)`, or on a hook whose cost is a build the scanner
 * cannot match (F1.650) — is returned.
 */
export function strayHookBudgetUses(text: string): number[] {
  const hooks = scanModuleGraphHooks('', text)
  const imports = importClauseSpans(text)
  return wordOffsets(text, HOOK_BUDGET)
    .filter(at => !imports.some(([from, to]) => at > from && at < to))
    .filter(at => !hooks.some(hook => at > hook.from && at < hook.to))
    .map(at => text.slice(0, at).split('\n').length)
}

/**
 * MATCHER COMPLETENESS, and it is not decoration: this exact comparison found
 * the first draft's blind spot. `MODULE_GRAPH_HOOK_BUDGET_MS` is BY DEFINITION
 * the hook-shaped budget, so every test file that imports it must show up among
 * `members` with at least one `shared` hook. When it does not, the scanner
 * cannot see a member somebody already registered by hand — a silent
 * under-count, which is the failure mode a guard like this exists to prevent in
 * others.
 *
 * F1.668, 2026-09-28: and it is checked per USE, not only per FILE. The file
 * check alone let one correctly matched hook vouch for every other use in the
 * same file, so the F1.639 shape — the hook budget on an `it(...)` case, or on a
 * hook the scanner cannot match — passed in any file that also had one real
 * hook. It was live when this landed: six uses in three files, all rewritten to
 * `MODULE_GRAPH_BUDGET_MS`, the budgets module's name for an import cost spread
 * across cases. The file check stays first: a use can be accounted for only in
 * a file the scan read, and it keeps refusing an importer with no hook at all.
 *
 * Exported so the tests can plant both refusals; `read` is `main`'s map of the
 * texts it has already read.
 */
export function assertHookBudgetUsesMatched(
  importers: Iterable<string>,
  members: readonly HookCall[],
  read: (file: string) => string,
): void {
  const registered = [...new Set(importers)].sort()
  const seen = new Set(members.filter(member => member.kind === 'shared').map(member => member.file))
  const unseen = registered.filter(file => !seen.has(file))
  if (unseen.length > 0) {
    throw new GateSafetyRefusal(
      `REFUSED: ${unseen.length} file(s) import MODULE_GRAPH_HOOK_BUDGET_MS and no hook of theirs was matched `
      + `(${unseen.join(', ')}) — the scanner is under-counting the family, so its report would understate it.`,
    )
  }
  const strays = registered.flatMap(file => strayHookBudgetUses(read(file)).map(line => `${file}:${line}`))
  if (strays.length > 0) {
    throw new GateSafetyRefusal(
      `REFUSED: ${strays.length} use(s) of MODULE_GRAPH_HOOK_BUDGET_MS sit in no matched hook (${strays.join(', ')}) `
      + '— it is the hook-shaped budget, so each is either the F1.639 misuse (a case or a file-wide timer takes '
      + 'MODULE_GRAPH_CASE_BUDGET_MS or MODULE_GRAPH_BUDGET_MS, a build hook a named constant of its own) or a '
      + 'member the scanner cannot see, which would understate the family.',
    )
  }
}

/**
 * The pathspecs, written `:(glob)` because a bare `**` is read WITHOUT glob
 * magic by git and silently drops files — measured 2026-08-31, recorded in
 * AGENTS.md §Traps.
 */
const TEST_PATHSPECS: readonly string[] = [
  ':(glob)apps/**/*.test.ts', ':(glob)apps/**/*.test.tsx', ':(glob)apps/**/*.isolated.ts',
  ':(glob)packages/**/*.test.ts', ':(glob)packages/**/*.test.tsx', ':(glob)packages/**/*.isolated.ts',
]

/** Every test file in scope — the DENOMINATOR, so the report can say what was searched. */
export function testFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...TEST_PATHSPECS], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
  return out.split('\0').filter(file => file !== '')
}

function grepFiles(pattern: string): string[] {
  try {
    return execFileSync('git', ['grep', '-alzE', pattern, '--', ...TEST_PATHSPECS], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    }).split('\0').filter(file => file !== '')
  } catch {
    // git grep exits 1 on no match. An empty result is a broken pattern, not a
    // clean tree; every caller refuses on it rather than reporting a green run.
    return []
  }
}

/**
 * The files worth READING — those carrying BOTH a dynamic `import(` and a
 * before-hook. A file with only one of the two cannot hold a member.
 *
 * This exists for one measured reason: reading all 1 958 test files took **92 s
 * wall at 0.7 % cpu** — I/O, not work, and not a number that belongs in
 * `lint:chain`. The two greps together cost 0.39 s and cut the reads from 1 958
 * to 105. Narrowing a search set is how a guard silently under-reports, so the
 * narrowing is not trusted on its own: `main`'s completeness refusal re-derives
 * the registered members independently and refuses if any of them fell out.
 *
 * `-a` rather than plain grep because some source files in this tree have
 * carried a NUL byte and plain grep skips those SILENTLY.
 *
 * UB12.26: a hook that pays its graph in a CHILD bun has no `import(` anywhere
 * in its file, so the second grep is now a union with files naming
 * `process.execPath` ({@link CHILD_BUN_MODULE}'s anchor). Measured 2026-10-16:
 * 30 more files read (191 → 221), two of them the members the import grep had
 * narrowed out (`panel-stack-materials.test.tsx`, `session-item-run-state.test.tsx`).
 */
export function candidateFiles(): string[] {
  const withHook = new Set(grepFiles(String.raw`before(All|Each)[[:space:]]*\(`))
  const withGraph = new Set([
    ...grepFiles(String.raw`(^|[^\w$.])import[[:space:]]*\(`),
    ...grepFiles(String.raw`process\.execPath`),
  ])
  return [...withGraph].filter(file => withHook.has(file)).sort()
}

/** A tracked file's text, by repo-relative path. */
function readRepoFile(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf-8')
}

/**
 * Test files that import the hook-shaped budget by name — the set the matcher is
 * checked for completeness against in `main`.
 *
 * F1.651, 2026-09-26: the grep NARROWS, the code DECIDES. `git grep` matches raw
 * text, so a test file that named the budget only in a comment or a string was
 * counted as an importer, and `main`'s completeness refusal stopped `--check` at
 * rc 2 over a file with no hook to match. Each hit is now kept only when
 * {@link codeTokenOffsets} finds the name in CODE — the entry
 * `findModuleGraphHooks` already uses (P6.984). A named import always puts the
 * name in code, so no real importer is lost. The live population of mention-only
 * files was ZERO when this landed (67 importers), so it closes a latent refusal.
 *
 * `read` exists for `main`, which has already read every candidate: one file
 * open costs ~130 ms on this tree (67 importers, 8.9 s cold and warm alike), so
 * reading the importers a second time would add seconds to `lint:chain`.
 */
export function hookBudgetImporters(read: (file: string) => string = readRepoFile): string[] {
  const token = 'MODULE_GRAPH_HOOK_BUDGET_MS'
  return grepFiles(token).filter(file => codeTokenOffsets(read(file), token).length > 0)
}

/**
 * The baseline's leading comment block — every line before its first entry.
 *
 * P6.870, 2026-09-10. `--update-baseline` used to write the entry list ALONE,
 * so the documented way to regenerate this file deleted the sixty lines of
 * documentation above the entries — the enumeration's own account of itself,
 * the sizing rule, and now the three zero-case controls the sweep measured. A
 * regenerating lane would have lost the evidence and had no way to know: the
 * flag reports success and the file it wrote is valid input.
 *
 * The preamble is defined by POSITION rather than by content — everything up to
 * the first line that is neither blank nor a `#` comment — because a rule
 * keyed on wording would go stale the first time somebody rewrites a heading.
 */
export function baselinePreamble(text: string): string {
  const lines = text.split('\n')
  const first = lines.findIndex(line => line.trim() !== '' && !line.startsWith('#'))
  const head = first === -1 ? [...lines] : lines.slice(0, first)
  while (head.length > 0 && (head[head.length - 1] as string).trim() === '') head.pop()
  return head.length === 0 ? '' : `${head.join('\n')}\n\n`
}

/**
 * Baselined files that are no longer findings — the direction a file-keyed
 * baseline cannot see about itself. Pure, so the two controls for it cost no
 * I/O: the live population is `main`'s to compute.
 */
export function staleBaselineEntries(
  baseline: Iterable<string>,
  findingFiles: Iterable<string>,
): string[] {
  const live = new Set(findingFiles)
  return [...new Set(baseline)].filter(file => !live.has(file)).sort()
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

/**
 * ## P6.1000 — the COST LEDGER, because a declared budget is not a big-enough one
 *
 * The section above says what this guard cannot catch, and this is the first
 * half of it: a member on `MODULE_GRAPH_HOOK_BUDGET_MS` whose graph outgrows
 * 600 000 ms passes here silently until the day it is a red. P6.997 is the
 * adjacent case — 252.2 s cold against that 600 000, **0.42 of its budget**,
 * measured by the lane that wrote the hook and recorded nowhere a second lane
 * would look. The readings existed before this file did; they were scattered
 * across four lane reports and two docblocks, and the second lane to need one
 * re-spent four minutes taking it again.
 *
 * {@link COSTS_FILE} is where a lane APPENDS its zero-case or cold reading. This
 * guard takes the LARGEST recorded reading per file, prints it beside that
 * file's budget with the ratio, and WARNS above {@link COST_RATIO_WARN}.
 *
 * ## Why it warns and does not fail
 *
 * The same posture the stale-entry pass took, for the same reason: a ratio
 * passing 0.5 is a budget to re-measure, which is a row to schedule — not a red
 * to hand every lane whose `lint:chain` happens to run next. The exit code is
 * untouched by everything below.
 *
 * ## The two joins, and what each one costs when it is wrong
 *
 * A file's BUDGET is the TIGHTEST numeric one any of its hooks declares, because
 * that is the one a growing graph fails first; a hook on a named constant of its
 * own contributes none, and a file whose hooks are all named shows `no numeric
 * budget`. A file with a recorded cost and NO hook at all is a stale line —
 * printed as such rather than dropped, since a reading silently ignored is a
 * reading nobody took.
 */
export const COSTS_FILE = 'scripts/module-graph-hook-costs.txt'

/** Bun's own timer — the budget a hook with no argument is actually running on. */
export const BUN_DEFAULT_TIMEOUT_MS = 5_000

/** The share of its budget above which a recorded cost stops being comfortable. */
export const COST_RATIO_WARN = 0.5

export interface CostReading {
  readonly file: string
  readonly ms: number
  /** `YYYY-MM-DD`. A cost is a reading with a date, never a standing fact. */
  readonly date: string
  /** The 1-minute load average when it was taken; undefined when written `-`. */
  readonly load: number | undefined
  /**
   * D1.100 — `(user + sys) / real` for that run, undefined when written `-` or
   * omitted. See {@link COST_CPU} for why the load field could not answer this.
   */
  readonly cpu: number | undefined
  /**
   * D1.100 — WHICH run produced the number, undefined when written `-` or
   * omitted. See {@link COST_INSTRUMENTS}.
   */
  readonly instrument: CostInstrument | undefined
}

/**
 * D1.100 — THE TWO FIELDS THE LOAD AVERAGE COULD NOT SUBSTITUTE FOR.
 *
 * ## The cpu share, and the measurement that demanded it
 *
 * `plugin-info-diagnostics.test.tsx` is recorded here at **354 410 ms at load
 * 7.59**, and W11-r ran the SAME BYTES end to end in **1 089 ms at load 8.84** —
 * a **325x** spread with the load average essentially unchanged. What moved was
 * `(user + sys) / real`: about **0.02** on the 2026-09-07 runs and **1.4** on the
 * 2026-09-10 ones. This family's wall time is I/O WAIT, and a 1-minute load
 * average does not report I/O wait, so the fourth field of the ledger is the
 * wrong instrument for the question it was added to answer. A cpu share under
 * ~0.02 says *starved*; one over ~1 says *the machine was working*, and the two
 * readings stop looking like a contradiction.
 *
 * ## The instrument, and the 3.4x it was hiding
 *
 * The header of the ledger admits two kinds of reading — a ZERO-CASE control and
 * a COLD RUN TOTAL — and wrote both as a bare `<ms>`. They are not the same
 * quantity: on `plugin-info-diagnostics.test.tsx` the full arms cost **3.4x** the
 * zero-case arms on identical bytes, because the heavy graph is loaded by an
 * `await import(...)` INSIDE `beforeAll` and a run with no case selected skips
 * the hook. So a zero-case number is a LOWER bound on the file and a total is an
 * upper one, and {@link costRows}'s *largest wins* rule cannot tell which it just
 * compared.
 *
 * ## Both are OPTIONAL, and that is not a softening
 *
 * Ten readings predate this and none of them can be re-derived — a cpu share is
 * not recoverable from a number somebody wrote down. Making the fields mandatory
 * would mean inventing ten values or deleting ten measurements, and the ledger's
 * own `-` convention already says what to do: *an invented load is worse than a
 * missing one*. Present-and-malformed still REFUSES, exactly like the four
 * fields before them — which is the half of the rule that has teeth.
 */
export const COST_INSTRUMENTS: readonly string[] = ['cold-total', 'zero-case']

export type CostInstrument = 'cold-total' | 'zero-case'

const COST_DATE = /^\d{4}-\d{2}-\d{2}$/
const COST_MS = /^\d+$/
const COST_LOAD = /^\d+(?:\.\d+)?$/
/** A cpu share is `(user+sys)/real` and can legitimately exceed 1 on many cores. */
const COST_CPU = /^\d+(?:\.\d+)?$/

/**
 * One reading per non-comment line, refusing on a line it cannot parse.
 *
 * The refusal is the point: this file is APPENDED BY HAND, and a malformed line
 * skipped silently is a measurement somebody spent four minutes on that no
 * report will ever show. Exit 2 says the gate could not decide, which is true.
 */
export function parseCostReadings(text: string): CostReading[] {
  const out: CostReading[] = []
  const lines = text.split('\n')
  for (let at = 0; at < lines.length; at += 1) {
    const line = (lines[at] as string).trim()
    if (line === '' || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    const refuse = (why: string): never => {
      throw new GateSafetyRefusal(
        `REFUSED: ${COSTS_FILE}:${at + 1} ${why} — a reading nobody can parse is a reading nobody took, and `
        + 'this file is appended by hand. The form is `<file> <ms> <date> <load> [<cpu> <instrument>]`, one '
        + `line per reading, with \`-\` for anything that was not recorded and <instrument> one of `
        + `${COST_INSTRUMENTS.join(' | ')}.`,
      )
    }
    if (parts.length !== 4 && parts.length !== 6) refuse(`has ${parts.length} field(s), not 4 or 6`)
    const file = parts[0] as string
    const ms = parts[1] as string
    const date = parts[2] as string
    const load = parts[3] as string
    // D1.100 — absent on a legacy four-field line, which is a reading that cannot
    // be re-derived rather than a reading somebody declined to complete.
    const cpu = parts[4]
    const instrument = parts[5]
    if (!COST_MS.test(ms)) refuse(`states \`${ms}\` where a whole number of milliseconds belongs`)
    if (!COST_DATE.test(date)) refuse(`states \`${date}\` where a YYYY-MM-DD date belongs`)
    if (load !== '-' && !COST_LOAD.test(load)) refuse(`states \`${load}\` where a load average or \`-\` belongs`)
    if (cpu !== undefined && cpu !== '-' && !COST_CPU.test(cpu)) {
      refuse(`states \`${cpu}\` where a cpu share ((user+sys)/real) or \`-\` belongs`)
    }
    if (instrument !== undefined && instrument !== '-' && !COST_INSTRUMENTS.includes(instrument)) {
      refuse(`states \`${instrument}\` where one of ${COST_INSTRUMENTS.join(' | ')} or \`-\` belongs`)
    }
    out.push({
      file,
      ms: Number(ms),
      date,
      load: load === '-' ? undefined : Number(load),
      cpu: cpu === undefined || cpu === '-' ? undefined : Number(cpu),
      instrument: instrument === undefined || instrument === '-'
        ? undefined
        : instrument as CostInstrument,
    })
  }
  return out
}

/**
 * The three shared budgets' VALUES, read out of the module rather than copied.
 *
 * A second literal here would be the defect this whole family exists about: a
 * number beside a single source of truth, ageing silently.
 */
export function sharedBudgetValues(source: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const name of SHARED_BUDGETS) {
    const match = new RegExp(`export const ${name} = ([0-9_]+)`).exec(source)
    if (match !== null) out.set(name, Number((match[1] as string).replace(/_/g, '')))
  }
  return out
}

/** What timer this hook is really running on, in ms — undefined for a named constant. */
export function budgetMs(member: HookCall, shared: ReadonlyMap<string, number>): number | undefined {
  if (member.kind === 'absent') return BUN_DEFAULT_TIMEOUT_MS
  if (member.kind === 'shared') return shared.get(member.budget ?? '')
  if (member.kind === 'literal') return Number((member.budget ?? '').replace(/_/g, ''))
  return undefined
}

export interface CostRow {
  readonly file: string
  /** The LARGEST reading recorded for this file — the sizing rule's own instrument. */
  readonly reading: CostReading
  /** The tightest numeric budget the file's hooks declare; undefined when none is. */
  readonly budget: number | undefined
  readonly ratio: number | undefined
}

/**
 * The largest reading per file joined to that file's tightest budget, worst
 * ratio first.
 *
 * Largest rather than latest, and it is the budgets module's rule rather than a
 * choice made here: *size against the largest observed run TOTAL, never a warm
 * reading*. A file measured 2.19 s warm and 354.41 s cold on identical bytes.
 */
export function costRows(
  members: readonly HookCall[],
  readings: readonly CostReading[],
  shared: ReadonlyMap<string, number>,
): CostRow[] {
  const largest = new Map<string, CostReading>()
  for (const reading of readings) {
    const seen = largest.get(reading.file)
    if (seen === undefined || reading.ms > seen.ms) largest.set(reading.file, reading)
  }
  const budgets = new Map<string, number>()
  for (const member of members) {
    const ms = budgetMs(member, shared)
    if (ms === undefined) continue
    const seen = budgets.get(member.file)
    if (seen === undefined || ms < seen) budgets.set(member.file, ms)
  }
  return [...largest.values()]
    .map(reading => {
      const budget = budgets.get(reading.file)
      return { file: reading.file, reading, budget, ratio: budget === undefined ? undefined : reading.ms / budget }
    })
    .sort((left, right) => (right.ratio ?? -1) - (left.ratio ?? -1) || left.file.localeCompare(right.file))
}

/** The rows whose recorded cost has passed {@link COST_RATIO_WARN}. */
export function outgrownRows(rows: readonly CostRow[]): CostRow[] {
  return rows.filter(row => row.ratio !== undefined && row.ratio > COST_RATIO_WARN)
}

/**
 * The directories {@link TEST_PATHSPECS} actually walks, derived from the
 * pathspecs rather than written out beside them.
 *
 * A second enumeration in prose is the defect this repo has measured most often:
 * three sentences in the tree said "five" after the list they described had
 * grown. The message below therefore names whatever the pathspecs name today.
 */
const SCAN_ROOTS: readonly string[] = [
  ...new Set(TEST_PATHSPECS.map(spec => (spec.replace(':(glob)', '').split('/')[0] as string))),
]

/**
 * What a cost row's BUDGET column says — and the THIRD branch is P6.1025.
 *
 * Two branches conflated three states. A recorded reading whose file declares no
 * numeric budget was printed as *"a named constant of its own, or no hook at all
 * (a STALE line)"* whether or not this guard had ever looked at that file, so
 * `scripts/cdp/harness.test.ts` — two legitimate readings appended by P6.1008 —
 * was reported as stale for a scan that never reached it.
 *
 * ## Why the third branch and not a wider scan, measured rather than assumed
 *
 * The row offered both. Widening {@link TEST_PATHSPECS} to `scripts/**` does NOT
 * fix this one: measured 2026-09-10, that file contains no `beforeAll` and no
 * `beforeEach` at all — its budget is `setDefaultTimeout(MODULE_GRAPH_CASE_BUDGET_MS)`,
 * the shape this guard says in its own words it "does not read". A wider
 * denominator would move it from one wrong branch to the SAME wrong branch,
 * while changing the population every other control here is checked against.
 *
 * The cost was not cosmetic: the same conflation lived in this guard's own test,
 * where the real-ledger control read an out-of-scan reading as *"a cost line for
 * a file not in scope"* and failed — 1 fail over 1 file, `real 63.34 / user 0.65
 * / sys 0.26` at load 13.44 (2026-09-10), unregistered.
 *
 * `scanned` is the caller's answer to *did the walk reach this file*, which only
 * `main` can give: it holds the denominator {@link testFiles} returned.
 */
export function costBudgetNote(row: CostRow, scanned: boolean): string {
  if (row.budget !== undefined) return `budget ${row.budget} ms`
  if (!scanned) {
    return `OUTSIDE the scan — this guard walks ${SCAN_ROOTS.map(root => `${root}/**`).join(' and ')} only, `
      + 'so no budget of this file was ever read here; the reading stands and this is NOT a stale line'
  }
  return 'no numeric budget in that file — a named constant of its own, or no hook at all (a STALE line)'
}

function main(argv: readonly string[]): number {
  const check = argv.includes('--check')
  const update = argv.includes('--update-baseline')

  if (!existsSync(join(REPO_ROOT, BUDGETS_MODULE))) {
    throw new GateSafetyRefusal(
      `REFUSED: ${BUDGETS_MODULE} is missing — the three budget names this guard checks against have moved, `
      + 'so every hook would be reported as unbudgeted.',
    )
  }
  const budgetsSource = readFileSync(join(REPO_ROOT, BUDGETS_MODULE), 'utf-8')
  const missing = SHARED_BUDGETS.filter(name => !budgetsSource.includes(`export const ${name}`))
  if (missing.length > 0) {
    throw new GateSafetyRefusal(
      `REFUSED: ${missing.join(', ')} no longer exported by ${BUDGETS_MODULE} — a renamed budget would turn `
      + 'every one of its callers into a finding.',
    )
  }

  const files = testFiles()
  if (files.length === 0) {
    throw new GateSafetyRefusal('REFUSED: no test files matched — the run would be vacuous.')
  }
  const candidates = candidateFiles()
  if (candidates.length === 0) {
    throw new GateSafetyRefusal(
      'REFUSED: no test file carries both a dynamic `import(` and a before-hook — that is a broken pathspec, '
      + 'not a tree in that state.',
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

  const texts = new Map<string, string>()
  const members: HookCall[] = []
  for (const file of candidates) {
    const text = readRepoFile(file)
    texts.set(file, text)
    members.push(...findModuleGraphHooks(file, text))
  }
  if (members.length === 0) {
    throw new GateSafetyRefusal(
      'REFUSED: no module-graph hook found in any test file — the matcher is broken, not the tree.',
    )
  }

  // MATCHER COMPLETENESS, per file and, since F1.668, per use — see
  // {@link assertHookBudgetUsesMatched}.
  const readKnown = (file: string): string => texts.get(file) ?? readRepoFile(file)
  assertHookBudgetUsesMatched(hookBudgetImporters(readKnown), members, readKnown)

  const findings = members.filter(member => member.kind === 'literal' || member.kind === 'absent')
  const files_ = [...new Set(findings.map(finding => finding.file))].sort()

  // P6.1000 — parsed BEFORE the `--update-baseline` branch on purpose: a
  // malformed reading must refuse on every path, including the one command that
  // rewrites a file, rather than only on the report.
  const costsPath = join(REPO_ROOT, COSTS_FILE)
  if (!existsSync(costsPath)) {
    throw new GateSafetyRefusal(
      `REFUSED: ${COSTS_FILE} is missing — every recorded cost would read as "never measured", which is the `
      + 'state P6.1000 exists to end, and the run would report a family nobody had priced.',
    )
  }
  const readings = parseCostReadings(readFileSync(costsPath, 'utf-8'))
  const costs = costRows(members, readings, sharedBudgetValues(budgetsSource))
  const outgrown = outgrownRows(costs)

  if (update) {
    const baseline = readBaseline()
    const body = files_
      .map(file => (baseline.has(file) ? file : `${file}  # recorded ${new Date().toISOString().slice(0, 10)}`))
      .join('\n')
    const path = join(REPO_ROOT, BASELINE_FILE)
    const preamble = existsSync(path) ? baselinePreamble(readFileSync(path, 'utf-8')) : ''
    writeFileSync(path, `${preamble}${body}\n`, 'utf-8')
    console.log(`check-module-graph-hooks: baseline written with ${files_.length} file(s).`)
    return 0
  }

  const baseline = readBaseline()
  const fresh = findings.filter(finding => !baseline.has(finding.file))

  for (const finding of findings) {
    const known = baseline.has(finding.file) ? ' (in the baseline)' : ''
    const said = finding.kind === 'absent'
      ? 'no budget argument — it runs on bun\'s 5 000 ms default'
      : `a hand-written ${finding.budget} — nothing can re-derive it`
    console.log(`${finding.file}:${finding.line}  ${finding.hook}: ${said}${known}`)
  }

  const stale = staleBaselineEntries(baseline, files_)

  const byKind = (kind: BudgetKind) => members.filter(member => member.kind === kind).length
  console.log(
    `check-module-graph-hooks: ${members.length} module-graph hook(s) in ${candidates.length} of ${files.length} test file(s) — `
    + `${byKind('shared')} on a shared budget, ${byKind('named')} on a named constant of their own, `
    + `${byKind('literal')} on a bare number, ${byKind('absent')} with no budget at all; `
    + `${findings.length} finding(s) over ${files_.length} file(s), ${fresh.length} NOT in the baseline, `
    + `${stale.length} baselined file(s) no longer a finding.`,
  )

  // Stdout, beside the summary — never stderr. See the docblock: a warning on
  // the other stream is dropped by every invocation that pipes only stdout.
  if (stale.length > 0) {
    console.log(
      `check-module-graph-hooks: WARNING — ${stale.length} baselined file(s) are no longer a finding: `
      + `${stale.join(', ')}. Drop the line(s), or run --update-baseline, which rewrites the entry list from the `
      + 'live findings and keeps the preamble. A stale entry is a pre-silenced FUTURE finding: the file is still '
      + 'in scope, so the day it regains an unbudgeted hook this gate stays green. Not a failure yet — see the '
      + 'docblock for why.',
    )
  }

  // P6.1000 — the cost ledger. Stdout beside the summary, for the stale-entry
  // warning's measured reason: a warning on the other stream is dropped by every
  // invocation that pipes only stdout.
  const worst = costs[0]
  console.log(
    `check-module-graph-hooks: ${readings.length} recorded cost(s) over ${costs.length} file(s) in `
    + `${COSTS_FILE}; ${outgrown.length} above ${COST_RATIO_WARN} of their budget`
    + (worst?.ratio === undefined ? '.' : ` — worst ${worst.ratio.toFixed(2)} on ${worst.file}.`),
  )
  for (const row of costs) {
    // Three branches, not two — a file the walk never reached is not stale (P6.1025).
    const budget = costBudgetNote(row, inScope.has(row.file))
    const ratio = row.ratio === undefined ? '' : `, ratio ${row.ratio.toFixed(2)}`
    const load = row.reading.load === undefined ? 'load not recorded' : `load ${row.reading.load}`
    // D1.100 — printed only when the reading carries them, so the ten readings
    // that predate the two fields read exactly as they did before.
    const cpu = row.reading.cpu === undefined ? '' : `, cpu ${row.reading.cpu}`
    const instrument = row.reading.instrument === undefined ? '' : `, ${row.reading.instrument}`
    console.log(
      `  ${row.file}  ${budget}, largest recorded ${row.reading.ms} ms `
      + `(${row.reading.date}, ${load}${cpu}${instrument})${ratio}`,
    )
  }
  if (outgrown.length > 0) {
    console.log(
      `check-module-graph-hooks: WARNING — ${outgrown.length} member(s) have MEASURED past `
      + `${COST_RATIO_WARN} of their declared budget: ${outgrown.map(row => row.file).join(', ')}. The budget `
      + 'is declared and it is being outgrown; re-measure with a zero-case control on a cold tree and size '
      + 'against the largest total, per the budgets module. Not a failure — the exit code is unchanged, for '
      + 'the stale-entry pass\'s reason: an outgrown budget is a row to schedule, not a red to hand the next '
      + 'lane that runs `lint:chain`.',
    )
  }

  return check && fresh.length > 0 ? 1 : 0
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
