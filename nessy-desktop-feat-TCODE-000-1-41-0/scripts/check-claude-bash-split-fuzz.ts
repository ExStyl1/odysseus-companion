/**
 * check-claude-bash-split-fuzz — the differential fuzz that was cited as
 * evidence for two years' worth of splitter claims and did not exist.
 *
 * P2.100.
 *
 * ## Why this file exists
 *
 * `claude-bash-rule.ts`'s splitter decides, for every `Bash(...)` permission
 * rule, WHAT TEXT a rule is shown. Two closed rows cited a "blast-radius sweep"
 * as their totality evidence — *"8,167,116 comparisons per splitter, zero
 * `unparseable → *` in either direction"*, and before them *"21,382 literals ×
 * 127 patterns"* — and neither the script, the corpus, nor the result existed
 * anywhere in the tree. A citation nobody can run is not evidence, and that
 * particular one could not have found the defects it was offered against:
 * a corpus of literals the repo already contains answers *"does any rule we
 * ourselves write move"*, never *"is the splitter's model of a shell right"*.
 *
 * The instrument that DID find the real hole was a differential fuzz against a
 * real shell. This is that instrument, committed, deterministic, and runnable.
 *
 * ## The invariant, and why it is one-directional
 *
 * Our splitter is deliberately NOT a shell — the module header says so, and the
 * `#`-comment rule makes it a strict SUBSET of the shell's own reading. So a
 * raw equality diff against `/bin/bash` is noise by construction. The property
 * that actually protects a user is one-directional:
 *
 *   For any command an allow rule MATCHES, the real shell must not run more
 *   simple commands than our splitter offered subcommands.
 *
 * A matching rule approves everything inside the subcommand it matched, so a
 * subcommand that is really TWO shell commands approves the second without ever
 * examining it. That is exactly the shape of the defect this fuzz's ancestor
 * found:
 *
 *     cat <<< 'x' # don't
 *     rm -rf ~ #'
 *
 * — ONE subcommand to the guarded splitter, TWO commands to `/bin/sh` and
 * `/bin/bash`. `'unparseable'` and `'no-match'` are excluded because neither can
 * auto-approve anything: the permission DSL prompts on the first and the second
 * grants nothing. (That exclusion is not a loophole being papered over: the
 * census counts both bands, so a change that "fixes" a violation by pushing the
 * corpus out of the governed band is visible as a number — and so is the band's
 * own size, which is the honest measure of how much this fuzz is testing.)
 *
 * ## Safety — nothing generated here is executed unless it is provably inert
 *
 * The oracle runs the generated command in a real bash. That is the whole point
 * and it is also the hazard, so the corpus is built from a CLOSED vocabulary of
 * inert heads (`echo`, `true`, `:`, `printf`) and inert arguments, and
 * {@link assertInert} re-derives that from the finished string before any
 * execution: no `/`, no `~`, no `>` redirect, no word outside the vocabulary.
 * The gate is belt-and-braces — the generator cannot emit anything it would
 * reject — and it carries its own positive control (`--self-test`), because a
 * safety gate that has never refused anything is not known to work.
 *
 * F1's own fixture uses `cat` and `rm`; the CLASS it belongs to is reproduced
 * here with inert heads (`echo x # don't` + newline + `echo y #'`), and the
 * self-test asserts that this fuzz finds that class.
 *
 * ## Usage
 *
 *     bun scripts/check-claude-bash-split-fuzz.ts            # report
 *     bun scripts/check-claude-bash-split-fuzz.ts --check    # exit 1 on any violation
 *     bun scripts/check-claude-bash-split-fuzz.ts --write    # refresh the snapshot
 *     bun scripts/check-claude-bash-split-fuzz.ts --self-test # prove the rig can fail
 *     bun scripts/check-claude-bash-split-fuzz.ts --cases 500 --seed 7
 *
 * `--check` asserts the INVARIANT, not byte-identity with the snapshot. A
 * shell-oracle census is not reproducible across bash versions, and a gate that
 * fails on a different `/bin/bash` would be turned off within a week. The
 * snapshot (`scripts/claude-bash-split-fuzz.txt`) is therefore a dated
 * measurement record in the shape of `claude-doc-pages.tsv`, not a golden file.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  matchClaudeBashRule,
  splitCompoundCommand,
} from '../packages/shared/src/agent/pi-harness/claude-bash-rule.ts'

const SNAPSHOT = fileURLToPath(new URL('./claude-bash-split-fuzz.txt', import.meta.url))

/* ------------------------------------------------------------------------- *
 * The closed vocabulary
 * ------------------------------------------------------------------------- */

/** Heads that read nothing, write nothing and spawn nothing. */
const HEADS = ['echo', 'true', ':', 'printf'] as const

/**
 * Argument fragments. Every one is either a literal, a quoting form, or an
 * expansion whose body is itself drawn from this vocabulary — so an expansion
 * that DOES run (`$(echo z)`) still runs only an inert head.
 */
const ARGS = [
  'a',
  'b',
  '-n',
  '--',
  "'q'",
  '"q"',
  "$'a'",
  "$'a\\'b'",
  "$'a'b",
  '"$(echo z)"',
  '$(echo z)',
  '`echo z`',
  '$((1+1))',
  '"x y"',
  'x\\ y',
] as const

/** Separators `permissions.md` § Compound commands names, plus a newline. */
const SEPARATORS = [' && ', ' || ', '; ', ' | ', ' & ', '\n', ' |& '] as const

/** Tails that change what a scanner believes about quote state. */
const TAILS = [
  '',
  ' # c',
  " # don't",
  ' #"',
  " #'",
  ' # $(echo z)',
] as const

/** Structural wrappers. `%s` takes a whole command list. */
const WRAPPERS = [
  '%s',
  '( %s )',
  '{ %s; }',
  'if true; then %s; fi',
  'for i in a; do %s; done',
  'while false; do %s; done',
] as const

/** Heredoc forms, appended to a single simple command. */
const HEREDOCS = ['', " <<< 'x'", ' <<< "x"', ' << EOF\nx\nEOF'] as const

/** How {@link assertInert} and the vocabulary derivation both cut a command into words. */
const WORD_SPLIT = /[\s;&|(){}`$'"\\#=+*[\]!<>?%-]+/

/**
 * Every literal word the vocabulary can produce.
 *
 * DERIVED by running {@link WORD_SPLIT} over the arrays above rather than
 * restated, because the hand-written version was wrong twice in five minutes —
 * `don't` cuts into `don` + `t`, `-n` into `n` — and a hand-list that the
 * generator can outrun is a gate that turns into an obstacle and then gets
 * loosened. Anything NOT produced by this vocabulary is refused, which is the
 * property that matters: `nc`, `rm`, a hostname, a path.
 */
const INERT_WORDS = new Set<string>(
  [...HEADS, ...ARGS, ...SEPARATORS, ...TAILS, ...WRAPPERS, ...HEREDOCS]
    .flatMap(literal => literal.split(WORD_SPLIT))
    .filter(word => word.length > 0),
)

/** Anything that could touch the machine. Refused before any execution. */
const FORBIDDEN = /[/~>]|\brm\b|\bmv\b|\bcp\b|\bdd\b|\bcurl\b|\bwget\b|\bchmod\b|\bkill\b|\bsudo\b|\bexec\b|\beval\b|\bsource\b/

/**
 * Refuse to execute anything this rig cannot prove inert.
 *
 * Two independent conditions, because either alone has a hole: the word
 * allowlist misses metacharacter-only mischief, and the `FORBIDDEN` pattern
 * misses a novel binary name.
 */
export function assertInert(command: string): void {
  if (FORBIDDEN.test(command)) {
    throw new Error(`refusing to execute: forbidden construct in ${JSON.stringify(command)}`)
  }
  for (const word of command.split(WORD_SPLIT)) {
    if (word.length === 0) continue
    if (!INERT_WORDS.has(word)) {
      throw new Error(`refusing to execute: unknown word ${JSON.stringify(word)} in ${JSON.stringify(command)}`)
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Generation — deterministic, so a violation is reproducible by seed
 * ------------------------------------------------------------------------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!
}

function simpleCommand(rng: () => number, fixedHead?: string): string {
  const head = fixedHead ?? pick(rng, HEADS)
  const argc = Math.floor(rng() * 3)
  const args = Array.from({ length: argc }, () => pick(rng, ARGS))
  // Heredocs are WEIGHTED DOWN rather than dropped. Unweighted they were on
  // three quarters of simple commands, which cost twice: they arm the
  // `<<`/`$'` guard so the ALLOW verdict is `unparseable` (safe, and outside
  // the invariant), and inside a `{ …; }` or loop wrapper they are frequently a
  // syntax error the shell refuses. Measured at 300 cases unweighted: 119 shell
  // refusals, 137 unparseable, and a governed band of THREE. The adversarial
  // forms still have to appear — they are the reason this fuzz exists — but a
  // corpus that never reaches the band it governs is a green that means nothing.
  const heredoc = rng() < 0.75 ? '' : pick(rng, HEREDOCS)
  return `${head}${args.length ? ` ${args.join(' ')}` : ''}${heredoc}`
}

export function generateCorpus(count: number, seed: number): string[] {
  const rng = mulberry32(seed)
  const out: string[] = []
  // The seeds this rig exists for, always first so a shrunk run still carries
  // them: the F1 class (a comment tail hiding a following command) and the
  // ANSI-C glued head of P2.104.
  out.push("echo x # don't\necho y #'")
  out.push("echo $'a'b # c")
  out.push("echo $'a\\'b # c")
  out.push("printf a <<< 'x' # don't\necho y #'")
  while (out.length < count) {
    const parts = 1 + Math.floor(rng() * 3)
    // Two thirds of the corpus uses ONE head for the whole list. Measured: with
    // a head drawn per simple command, only 2 of 120 executed cases landed in
    // the band the invariant governs (an allow rule that MATCHES), because
    // `matchClaudeBashRule`'s allow branch requires EVERY subcommand to match
    // the one pattern. A fuzz whose invariant governs 2 % of its corpus is a
    // green that means nothing, which is the failure mode this row exists to
    // correct — so the generator is biased toward the shape a real `Bash(cmd:*)`
    // allow rule can actually cover.
    const fixedHead = rng() < 0.67 ? pick(rng, HEADS) : undefined
    const list = Array.from({ length: parts }, () => simpleCommand(rng, fixedHead))
      .join(pick(rng, SEPARATORS))
    // A FUNCTION replacer, not a string: `String.replace` reads `$'` in a
    // replacement as "everything after the match", and `$'…'` is half this
    // vocabulary — the string form spliced the wrapper's own tail into the
    // command and produced words like `donea'b` that no shell would ever see.
    // The wrapper is weighted the same way and for the same reason: five of the
    // six are compound FORMS whose subcommands carry keyword heads (`while`,
    // `do`, `{`), which no per-head rule can match across, so an unweighted
    // draw parked 475 of 826 cases in `no-match`. Weighted, the compound forms
    // are still drawn on two fifths of the corpus.
    const wrapper = rng() < 0.6 ? '%s' : pick(rng, WRAPPERS)
    const command = wrapper.replace('%s', () => list)
      + (rng() < 0.5 ? '' : pick(rng, TAILS))
    if (command.length > 400) continue
    out.push(command)
  }
  return out.slice(0, count)
}

/* ------------------------------------------------------------------------- *
 * The oracle
 * ------------------------------------------------------------------------- */

/**
 * The simple commands a real bash would run, read from its own `DEBUG` trap.
 *
 * `BASH_COMMAND` is the text bash is about to execute, one trap firing per
 * simple command — including each element of a pipeline and each body of a
 * compound form. Reading the shell's own dispatch is the point: any
 * reimplementation of shell parsing here would share the blind spots of the
 * thing being tested.
 *
 * `spawnSync` cannot hand bash an extra descriptor, so the trap writes to
 * stderr behind a marker and the marker is filtered out again — stderr also
 * carries the shell's own diagnostics, which is why the marker exists rather
 * than a bare read.
 *
 * Returns null when the shell itself could not parse the command: a syntax
 * error is not a divergence, it is a command that would never run.
 */
const TRACE_MARKER = '\u0001NESSY-TRACE\u0001'

export function shellSimpleCommands(command: string, shell = 'bash'): string[] | null {
  assertInert(command)
  const script = `trap 'printf "${TRACE_MARKER}%s\\n" "$BASH_COMMAND" >&2' DEBUG\n${command}\n`
  const result = spawnSync(shell, ['--noprofile', '--norc', '-c', script], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    cwd: '/tmp',
  })
  if (result.error || result.signal) return null
  const stderr = result.stderr ?? ''
  if (stderr.includes('syntax error') || stderr.includes('unexpected end of file')) return null
  return stderr
    .split('\n')
    .filter(line => line.startsWith(TRACE_MARKER))
    .map(line => line.slice(TRACE_MARKER.length))
}

/** First word of a command text, which is the token every `Bash(...)` rule keys on. */
function head(text: string): string {
  return text.trim().split(/\s+/)[0] ?? ''
}

/* ------------------------------------------------------------------------- *
 * The comparison
 * ------------------------------------------------------------------------- */

export interface FuzzVerdict {
  command: string
  ourSubcommands: string[] | null
  allowVerdict: 'match' | 'no-match' | 'unparseable'
  shellCommands: string[] | null
  /** A head the shell runs that no subcommand of ours exposed. Reported, not judged. */
  unseenHeads: string[]
  shellCount: number
  ourCount: number
  violation: boolean
}

/**
 * The allow verdict for a permissive rule over each head in the vocabulary.
 * Any of them answering something other than `'unparseable'` means the command
 * was READ, which is when the invariant applies.
 */
function allowVerdictFor(command: string): 'match' | 'no-match' | 'unparseable' {
  let best: 'match' | 'no-match' | 'unparseable' = 'unparseable'
  // Per-head rules only. A blanket `Bash(*)` was tried and REMOVED: it matches
  // every subcommand including the compound keywords, so it moved the whole
  // corpus into the governed band and then reported every keyword wrapper as a
  // hole. A rule that approves everything cannot be evidence about what a rule
  // failed to see.
  for (const pattern of ['echo:*', 'true', ':', 'printf:*']) {
    const verdict = matchClaudeBashRule(pattern, command, { ruleAction: 'allow' })
    if (verdict === 'match') return 'match'
    if (verdict === 'no-match') best = 'no-match'
  }
  return best
}

export function evaluate(command: string, shell = 'bash'): FuzzVerdict {
  const ourSubcommands = splitCompoundCommand(command)
  const allowVerdict = allowVerdictFor(command)
  const shellCommands = shellSimpleCommands(command, shell)
  const ourHeads = new Set((ourSubcommands ?? []).map(head))
  const unseenHeads = shellCommands === null
    ? []
    : [...new Set(shellCommands.map(head))].filter(h => h.length > 0 && !ourHeads.has(h))
  // The violation predicate is a COUNT, not head membership, and the difference
  // took two wrong drafts to find:
  //
  //  - head membership calls `while false; do printf; done` a hole, because our
  //    subcommand is `while false` whose first token is the KEYWORD. The text
  //    was shown to every rule; only the head differs, and a differing head can
  //    only ever make an allow rule match LESS.
  //  - text containment calls F1 safe, because `echo x # don't`+LF+`echo y #'`
  //    is one subcommand containing both shell commands as substrings. That is
  //    the hole itself.
  //
  // What separates them is arity: a rule matching ONE subcommand approves
  // everything in it, so a subcommand that is really TWO shell commands
  // approves the second without examining it. Hence: the shell must not run
  // more simple commands than our splitter offered subcommands.
  const shellCount = shellCommands?.length ?? 0
  const ourCount = ourSubcommands?.length ?? 0
  return {
    command,
    ourSubcommands,
    allowVerdict,
    shellCommands,
    unseenHeads,
    // Only a MATCHING allow is a violation, and the first draft of this
    // predicate said `!== 'unparseable'` — which counted 22 cases as holes on a
    // 200-case run, every one of them a `no-match`. A `no-match` grants
    // nothing, and `'unparseable'` prompts; neither can auto-approve anything,
    // so neither is a hole however far the two readings diverge. What is left
    // is the one combination that hurts: this command WOULD be auto-approved,
    // and the shell would run something our subcommand list never showed.
    shellCount,
    ourCount,
    violation: allowVerdict === 'match' && shellCount > ourCount,
  }
}

export interface FuzzReport {
  seed: number
  cases: number
  shell: string
  shellVersion: string
  executed: number
  shellRefused: number
  unparseable: number
  noMatch: number
  divergentButSafe: number
  violations: FuzzVerdict[]
}

export function runFuzz(cases: number, seed: number, shell = 'bash'): FuzzReport {
  const corpus = generateCorpus(cases, seed)
  const violations: FuzzVerdict[] = []
  let shellRefused = 0
  let unparseable = 0
  let noMatch = 0
  let divergentButSafe = 0
  let executed = 0
  for (const command of corpus) {
    const verdict = evaluate(command, shell)
    if (verdict.shellCommands === null) { shellRefused++; continue }
    executed++
    if (verdict.allowVerdict !== 'match') {
      if (verdict.allowVerdict === 'unparseable') unparseable++
      else noMatch++
      if (verdict.unseenHeads.length > 0) divergentButSafe++
      continue
    }
    if (verdict.violation) violations.push(verdict)
  }
  const version = spawnSync(shell, ['--version'], { encoding: 'utf8' }).stdout ?? ''
  return {
    seed,
    cases: corpus.length,
    shell,
    shellVersion: version.split('\n')[0] ?? 'unknown',
    executed,
    shellRefused,
    unparseable,
    noMatch,
    divergentButSafe,
    violations,
  }
}

function renderSnapshot(report: FuzzReport): string {
  return [
    '# claude-bash-split-fuzz — the differential fuzz result, as a dated measurement.',
    '#',
    '# NOT a golden file. `--check` asserts the invariant (zero violations), because',
    '# a shell-oracle census is not reproducible across bash versions and a gate that',
    '# fails on a different /bin/bash gets turned off. Regenerate with `--write`.',
    '#',
    '# Invariant: for any command an allow rule MATCHES, the real shell must not',
    '# run more simple commands than our splitter offered subcommands. A violation',
    '# is an approval granted over command text no rule ever examined.',
    '',
    `Snapshot: ${new Date().toISOString().slice(0, 10)}`,
    `Seed: ${report.seed}`,
    `Cases: ${report.cases}`,
    `Shell: ${report.shellVersion}`,
    `Executed: ${report.executed}`,
    `Shell refused (syntax error, not a divergence): ${report.shellRefused}`,
    `Allow verdict unparseable (prompts — safe): ${report.unparseable}`,
    `Allow verdict no-match (grants nothing — safe): ${report.noMatch}`,
    `  of the two bands above, readings that differ from the shell: ${report.divergentButSafe}`,
    `Allow verdict match (the band the invariant governs): ${report.executed - report.unparseable - report.noMatch}`,
    `VIOLATIONS: ${report.violations.length}`,
    '',
    ...report.violations.flatMap(v => [
      `  command: ${JSON.stringify(v.command)}`,
      `  ours (${v.ourCount}):    ${JSON.stringify(v.ourSubcommands)}`,
      `  shell (${v.shellCount}):   ${JSON.stringify(v.shellCommands)}`,
      `  unseen heads: ${JSON.stringify(v.unseenHeads)}`,
      '',
    ]),
  ].join('\n')
}

/* ------------------------------------------------------------------------- *
 * The rig's own positive control
 * ------------------------------------------------------------------------- */

/**
 * Prove the rig can FAIL, on three axes, because an all-green fuzz is
 * indistinguishable from a fuzz that never ran:
 *
 *  1. the oracle sees a command hidden behind a comment tail (F1's class);
 *  2. the safety gate refuses something outside the vocabulary;
 *  3. the violation predicate fires on a hand-built divergence.
 */
export function selfTest(): { name: string; ok: boolean; detail: string }[] {
  const results: { name: string; ok: boolean; detail: string }[] = []

  const oracleTrace = shellSimpleCommands("echo x # don't\necho y #'")
  results.push({
    name: 'oracle sees the command a comment tail hides',
    ok: (oracleTrace?.length ?? 0) === 2,
    detail: JSON.stringify(oracleTrace),
  })

  let refused = false
  let refusal = ''
  try {
    assertInert('rm -rf /tmp/x')
  } catch (error) {
    refused = true
    refusal = String(error)
  }
  results.push({ name: 'safety gate refuses a mutating command', ok: refused, detail: refusal })

  let refusedWord = false
  try {
    assertInert('nc example')
  } catch {
    refusedWord = true
  }
  results.push({ name: 'safety gate refuses an unknown word', ok: refusedWord, detail: '' })

  // The predicate itself, on a synthetic verdict — no shell needed, so a broken
  // oracle cannot make this pass by accident.
  // The F1 class, live, with inert heads. WHICH MECHANISM holds the line here
  // is the thing worth pinning, and it is not the one the row assumed:
  //
  //   printf a <<< 'x' # don't
  //   echo y #'
  //
  // still splits to ONE subcommand while bash runs TWO — the byte-level
  // divergence F1 named is intact — and it is harmless only because P2.363's
  // `commentReadingAgrees` corroboration turns the ALLOW verdict into
  // `unparseable`, which prompts. Remove that corroboration and this fixture
  // becomes a violation; that mutation is this artifact's re-break.
  const f1 = evaluate("printf a <<< 'x' # don't\necho y #'")
  results.push({
    name: 'F1 class: splitter still reads 1 where the shell runs 2',
    ok: f1.ourCount === 1 && f1.shellCount === 2,
    detail: `ours=${f1.ourCount} shell=${f1.shellCount}`,
  })
  results.push({
    name: 'F1 class is neutralised by the allow corroboration, not by the splitter',
    ok: f1.allowVerdict === 'unparseable' && !f1.violation,
    detail: `allow=${f1.allowVerdict} violation=${f1.violation}`,
  })

  // The predicate itself, on a synthetic verdict — no shell needed, so a broken
  // oracle cannot make this pass by accident, and a tree with no live violation
  // still proves the rig CAN report one.
  const synthetic: FuzzVerdict = {
    command: 'echo a # x\necho b',
    ourSubcommands: ["echo a # x\necho b"],
    allowVerdict: 'match',
    shellCommands: ['echo a', 'echo b'],
    unseenHeads: [],
    shellCount: 2,
    ourCount: 1,
    violation: true,
  }
  results.push({
    name: 'violation predicate fires when a matching allow hides a command',
    ok: synthetic.violation && evaluate('echo a && echo b').violation === false,
    detail: '',
  })

  return results
}

/* ------------------------------------------------------------------------- *
 * CLI
 * ------------------------------------------------------------------------- */

function main(argv: string[]): number {
  const flag = (name: string) => argv.includes(name)
  const value = (name: string, fallback: number) => {
    const index = argv.indexOf(name)
    return index === -1 ? fallback : Number(argv[index + 1] ?? fallback)
  }

  if (flag('--self-test')) {
    const results = selfTest()
    for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
    return results.every(r => r.ok) ? 0 : 1
  }

  const cases = value('--cases', 2000)
  const seed = value('--seed', 20260903)
  const report = runFuzz(cases, seed)
  const rendered = renderSnapshot(report)

  if (flag('--write')) {
    writeFileSync(SNAPSHOT, rendered)
    console.log(`wrote ${SNAPSHOT}`)
    return report.violations.length === 0 ? 0 : 1
  }

  console.log(rendered)
  if (flag('--check')) {
    if (!existsSync(SNAPSHOT)) {
      console.error('snapshot missing — run with --write')
      return 1
    }
    // The snapshot is read so a deleted artifact is a failure rather than a
    // silent pass; its CONTENT is a record, and the gate is the invariant.
    const previous = readFileSync(SNAPSHOT, 'utf8')
    if (!previous.includes('VIOLATIONS:')) {
      console.error('snapshot is not a fuzz record — run with --write')
      return 1
    }
    if (report.violations.length > 0) {
      console.error(`FAIL: ${report.violations.length} allow-side violations`)
      return 1
    }
    if (report.executed < cases / 4) {
      console.error(`FAIL: only ${report.executed} of ${cases} cases reached the shell`)
      return 1
    }
    console.log('ok — no allow-side violation')
  }
  return 0
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)))
}
