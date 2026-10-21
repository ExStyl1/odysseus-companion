/**
 * check-read-only-inspector-differential — a bounded differential check of the
 * read-only Bash gate's awk and find inspectors against the REAL binaries, plus
 * the shell's own glob delivery: files named -f / -i / -o in the sandbox turn
 * an unquoted glob into options (`awk *`, `sort *`).
 *
 * UA12.183 (and the UA12.103 remainder it carries), 2026-10-09; glob
 * deliveries UA12.213, 2026-10-09.
 *
 * ## Why this file exists
 *
 * The read-only gate (`validateBashCommand` over the shipped `default.json`
 * allowlist — what Plan / Don't ask run without a card) judges awk and find by
 * reading their words: {@link getDangerousAwkReason}'s text patterns and option
 * walk, and find's `DANGEROUS_COMMAND_ARGS`. Every hole found so far (UA12.103's
 * backslash-newline, UA12.183's `-f` / `-i` / `@include`, the unquoted glob the
 * shell expands into an option — UA12.207/UA12.212) was a spelling the
 * inspector read one way and the binary another. The words the gate reads are
 * bash-parser's, not bash's, so the only oracle that settles a spelling is to
 * RUN it. This script runs a closed, enumerated corpus through both and reports
 * the one cell that matters:
 *
 *   BYPASS — the gate says read-only AND the real binary changed the sandbox.
 *
 * The other three cells are printed as counts (a refused spelling with no
 * effect is an over-block — stated, never a failure).
 *
 * ## What it can and cannot see
 *
 * It measures the binaries ON THIS HOST: macOS ships BWK awk and BSD find, so a
 * gawk-only spelling (`-i inplace`, `@include`, `--file=`) has no effect here
 * and lands in "refused, no effect" or "allowed, no effect" — the unit arms in
 * `bash-validator-argv-inspectors.test.ts` pin those by reading, not by running.
 * A run on a Linux host with gawk/GNU find exercises the rest; the report names
 * each binary's version so two readings are never confused.
 *
 * ## Safety — what is executed
 *
 * Every command runs under `/bin/bash -c` with its cwd, HOME and TMPDIR set to a
 * fresh temporary directory, PATH `/usr/bin:/bin`, stdin `/dev/null` unless the
 * command pipes its own, and a 5 s timeout. The corpus is built from a CLOSED
 * vocabulary — the only side effect any member can have is `touch m`, a write
 * of `m`/`out`, a delete of `d.txt`, or a rewrite of `f.txt`/`cmd.txt`, all
 * relative — and
 * {@link assertConfined} re-checks the finished string before it runs: no `..`,
 * no `~`, no `$` expansion outside single quotes, and no `/` outside
 * `/dev/stdin` / `/dev/null`. The positive control (a refused `system()` MUST
 * change the sandbox) and the negative control (a plain read must not) run
 * first; if either fails the rig is broken and the script exits 2.
 *
 * ## Usage
 *
 *     bun scripts/check-read-only-inspector-differential.ts          # report
 *     bun scripts/check-read-only-inspector-differential.ts --check  # exit 1 on a BYPASS
 *     bun scripts/check-read-only-inspector-differential.ts --verbose # every row
 *
 * It is NOT in `lint:chain`: it spawns a few hundred processes and its answer is
 * host-dependent. It is run once per change to an inspector, and its dated
 * reading goes into the row that changed it.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateBashCommand } from '../packages/shared/src/agent/bash-validator.ts'

const allowlist = JSON.parse(
  readFileSync(new URL('../apps/electron/resources/permissions/default.json', import.meta.url), 'utf8'),
) as { allowedBashPatterns: { pattern: string }[] }
const patterns = allowlist.allowedBashPatterns.flatMap(entry => {
  try {
    return [{ regex: new RegExp(entry.pattern), source: entry.pattern }]
  } catch {
    return []
  }
})

/** The gate Plan / Don't ask run: read-only on the shipped allowlist. */
export const gateAllows = (command: string): boolean => validateBashCommand(command, patterns).allowed

/** Refuses a command that could reach outside the sandbox; the corpus never builds one. */
export function assertConfined(command: string): void {
  const withoutDevices = command.replace(/\/dev\/(?:stdin|null)\b/g, '')
  if (withoutDevices.includes('/')) throw new Error(`not confined (a path): ${command}`)
  if (command.includes('..') || command.includes('~')) throw new Error(`not confined (a parent/home): ${command}`)
  if (/\$[{(A-Za-z_]/.test(command.replace(/'[^']*'/g, "''"))) throw new Error(`not confined (an expansion): ${command}`)
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/** awk programs, each of which changes the sandbox when awk runs it. */
const AWK_PROGRAMS = [
  'BEGIN{system("touch m")}',
  'BEGIN{system ("touch m")}',
  'BEGIN{print "touch m" | "sh"}',
  'BEGIN{printf "touch m\\n" | "sh"}',
  'BEGIN{printf("touch m\\n") | "sh"}',
  'BEGIN{c="sh"; print "touch m" | c}',
  'BEGIN{"touch m" | getline}',
  'BEGIN{"touch m" | getline x}',
  'BEGIN{print "x" > "m"}',
  'BEGIN{print "x" >> "m"}',
  'BEGIN{printf "x" > "m"}',
  'BEGIN{print("x") > "m"}',
  'BEGIN{x = "m"; print "x" > x}',
  'BEGIN{system\\\n("touch m")}',
  'BEGIN{print "touch m" |\\\n"sh"}',
  'BEGIN{print "x" >\\\n"m"}',
  'BEGIN{x=1\\\nsystem("touch m")}',
  'BEGIN{system #c\n("touch m")}',
  'BEGIN{close(system("touch m"))}',
]

/** Ways the shell can hand awk a program text, each a function of the program. */
const AWK_DELIVERIES: { name: string; build: (program: string) => string | null }[] = [
  { name: 'single-quoted', build: p => (p.includes("'") ? null : `awk '${p}'`) },
  { name: 'double-quoted', build: p => `awk "${p.replace(/["\\]/g, c => `\\${c}`)}"` },
  { name: 'ansi-c', build: p => `awk $'${p.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/'/g, "\\'")}'` },
  {
    name: 'ansi-c hex letters',
    build: p => {
      const hexed = p
        .replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/'/g, "\\'")
        .replace(/system/g, 'sys\\x74em').replace(/getline/g, 'getl\\x69ne').replace(/\|/g, '\\x7c').replace(/>/g, '\\x3e')
      return `awk $'${hexed}'`
    },
  },
  {
    name: 'quote-split keyword',
    build: p => (p.includes("'") ? null : `awk '${p.replace('system', "sys''tem").replace('getline', "get''line").replace('print', "pr''int")}'`),
  },
  { name: 'program file -f', build: () => 'awk -f p.awk' },
  { name: 'program file attached -fp.awk', build: () => 'awk -fp.awk' },
  { name: 'program file via stdin -f -', build: () => 'awk -f - < p.awk' },
  { name: 'program file -f /dev/stdin', build: () => 'awk -f /dev/stdin < p.awk' },
  { name: 'program piped to -f -', build: () => 'cat p.awk | awk -f -' },
  { name: 'program file quoted option', build: () => "awk '-f' p.awk" },
  { name: 'program file escaped option', build: () => 'awk -\\f p.awk' },
  { name: 'program file ansi-c option', build: () => "awk $'-\\x66' p.awk" },
  { name: 'program file after -v', build: () => 'awk -v x=1 -f p.awk' },
  { name: 'program file after -safe', build: () => 'awk -safe -f p.awk' },
  { name: 'program file after -F', build: () => 'awk -F, -fp.awk' },
  // A `--` that is the SEPARATE argument of -F / -v / -W is that option's value, not the end of
  // the options (UA12.183 follow-up, 2026-10-09): every awk reads the word after a bare -F as FS.
  { name: 'program file after -F --', build: () => 'awk -F -- -f p.awk' },
  { name: 'program file attached after -F quoted --', build: () => "awk -F '--' -fp.awk" },
  { name: 'program piped to -f - after -F --', build: () => 'cat p.awk | awk -F -- -f -' },
  { name: 'program file after -v --', build: () => 'awk -v -- -f p.awk' },
  { name: 'program file after -W --', build: () => 'awk -W -- -f p.awk' },
  { name: 'program -e (gawk)', build: p => (p.includes("'") ? null : `awk -e '${p}'`) },
  { name: 'program --source= (gawk)', build: p => (p.includes("'") ? null : `awk --source='${p}'`) },
  { name: 'program after --', build: p => (p.includes("'") ? null : `awk -- '${p}'`) },
]

/** find actions (BSD and GNU spellings), each of which changes the sandbox. */
const FIND_ACTIONS = [
  ['-exec', 'touch m \\;'],
  ['-exec', 'touch m {} +'],
  ['-execdir', 'touch m \\;'],
  ['-ok', 'touch m \\;'],
  ['-okdir', 'touch m \\;'],
  ['-delete', ''],
  ['-fprint', 'm'],
  ['-fprint0', 'm'],
  ['-fls', 'm'],
  ['-fprintf', "m '%p'"],
] as const

/** Spellings of the action word itself. */
const FIND_SPELLINGS: { name: string; build: (action: string) => string }[] = [
  { name: 'plain', build: a => a },
  { name: 'single-quoted', build: a => `'${a}'` },
  { name: 'double-quoted', build: a => `"${a}"` },
  { name: 'quote-split', build: a => `${a.slice(0, 3)}''${a.slice(3)}` },
  { name: 'backslash', build: a => `${a.slice(0, 3)}\\${a.slice(3)}` },
  { name: 'leading backslash', build: a => `\\${a}` },
  { name: 'ansi-c', build: a => `$'${a}'` },
  { name: 'ansi-c hex', build: a => `$'-\\x${a.charCodeAt(1).toString(16)}${a.slice(2)}'` },
  { name: 'upper-case', build: a => a.toUpperCase() },
]

/** Prefixes before the action (the path, BSD options, a predicate chain). */
const FIND_PREFIXES = [
  'find . -name d.txt',
  'find -E . -name d.txt',
  'find -L . -name d.txt',
  'find -s . -name d.txt',
  'find . -maxdepth 1 -name d.txt',
  'find . -name x -o -name d.txt',
]

export type Row = { family: 'awk' | 'find' | 'sort'; name: string; command: string; stdin?: string }

export function buildCorpus(): Row[] {
  const rows: Row[] = []
  for (const program of AWK_PROGRAMS) {
    for (const delivery of AWK_DELIVERIES) {
      const command = delivery.build(program)
      if (command !== null) rows.push({ family: 'awk', name: `${delivery.name} :: ${JSON.stringify(program)}`, command })
    }
  }
  // Programs that read their command from the input record (BWK `system` with no parentheses).
  rows.push({ family: 'awk', name: 'bare system on the record', command: "awk '{system}' cmd.txt" })
  rows.push({ family: 'awk', name: 'print $0 to sh', command: "awk '{print | \"sh\"}' cmd.txt" })
  rows.push({ family: 'awk', name: 'stdin record to sh', command: "echo 'touch m' | awk '{print | \"sh\"}'" })
  // The shell's own glob delivery (UA12.213, 2026-10-09): the sandbox holds files named
  // -f / -i / -o, so an unquoted glob expands INTO the option stream — `awk *` reads -i
  // as its program file and `sort *` writes cmd.txt through the delivered -o.
  rows.push({ family: 'awk', name: 'unquoted glob delivery', command: 'awk *' })
  rows.push({ family: 'sort', name: 'unquoted glob delivery', command: 'sort *' })
  for (const prefix of FIND_PREFIXES) {
    for (const [action, rest] of FIND_ACTIONS) {
      for (const spelling of FIND_SPELLINGS) {
        rows.push({
          family: 'find',
          name: `${prefix} :: ${spelling.name} ${action}`,
          command: `${prefix} ${spelling.build(action)}${rest ? ` ${rest}` : ''}`,
          stdin: action.startsWith('-ok') ? 'y\ny\ny\n' : undefined,
        })
      }
    }
  }
  const seen = new Set<string>()
  return rows.filter(row => !seen.has(row.command) && seen.add(row.command) !== undefined)
}

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

function snapshot(dir: string): string {
  const lines: string[] = []
  const walk = (at: string, rel: string): void => {
    for (const name of readdirSync(at).sort()) {
      const full = join(at, name)
      const st = statSync(full)
      if (st.isDirectory()) {
        lines.push(`${rel}${name}/`)
        walk(full, `${rel}${name}/`)
      } else {
        lines.push(`${rel}${name} ${createHash('sha256').update(readFileSync(full)).digest('hex')}`)
      }
    }
  }
  walk(dir, '')
  return lines.join('\n')
}

/** Runs one command in a fresh sandbox; true when the sandbox changed. */
export function runChanges(row: Row): boolean {
  assertConfined(row.command)
  const dir = mkdtempSync(join(tmpdir(), 'ro-inspector-diff-'))
  try {
    writeFileSync(join(dir, 'f.txt'), 'a,b\nc,d\n')
    writeFileSync(join(dir, 'd.txt'), 'delete me\n')
    writeFileSync(join(dir, 'cmd.txt'), 'touch m\n')
    writeFileSync(join(dir, 'p.awk'), 'BEGIN{system("touch m")}\n')
    // Files named like options (UA12.213, 2026-10-09): an unquoted glob in the command
    // expands them into argv — `-i` becomes awk's program file, `-o` sort's output file.
    writeFileSync(join(dir, '-f'), 'ordinary text\n')
    writeFileSync(join(dir, '-i'), 'BEGIN{system("touch m")}\n')
    writeFileSync(join(dir, '-o'), 'ordinary text\n')
    const before = snapshot(dir)
    spawnSync('/bin/bash', ['-c', row.command], {
      cwd: dir,
      env: { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: dir, LC_ALL: 'C' },
      input: row.stdin ?? '',
      timeout: 5000,
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    return snapshot(dir) !== before
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function version(args: string[]): string {
  const result = spawnSync(args[0] as string, args.slice(1), { encoding: 'utf8', timeout: 5000 })
  return `${(result.stdout || result.stderr || '').split('\n')[0]?.trim() || 'no version output'}`
}

if (import.meta.main) {
  const check = process.argv.includes('--check')
  const verbose = process.argv.includes('--verbose')

  // Controls first: a rig that cannot see an effect, or sees one in a read, proves nothing.
  const positive: Row = { family: 'awk', name: 'positive control', command: `awk 'BEGIN{system("touch m")}'` }
  const negative: Row = { family: 'awk', name: 'negative control', command: "awk -F, '{print $2}' f.txt" }
  const findPositive: Row = { family: 'find', name: 'positive control', command: 'find . -name d.txt -delete' }
  if (!runChanges(positive) || !runChanges(findPositive)) {
    console.error('rig broken: a known side effect did not change the sandbox')
    process.exit(2)
  }
  if (runChanges(negative) || !gateAllows(negative.command) || gateAllows(positive.command)) {
    console.error('rig broken: the read control changed the sandbox, or the gate misjudged a control')
    process.exit(2)
  }

  const corpus = buildCorpus()
  const cells = { bypass: [] as Row[], refusedEffect: 0, overBlock: 0, read: 0 }
  for (const row of corpus) {
    const allowed = gateAllows(row.command)
    const changed = runChanges(row)
    if (allowed && changed) cells.bypass.push(row)
    else if (!allowed && changed) cells.refusedEffect++
    else if (!allowed) cells.overBlock++
    else cells.read++
    if (verbose) console.log(`${allowed ? 'ALLOW' : 'block'} ${changed ? 'EFFECT' : 'none  '} ${row.family} ${JSON.stringify(row.command)}`)
  }

  console.log(`check-read-only-inspector-differential — ${new Date().toISOString().slice(0, 10)}`)
  console.log(`  awk:  /usr/bin/awk — ${version(['/usr/bin/awk', '--version'])}`)
  console.log(`  find: /usr/bin/find — ${process.platform === 'darwin' ? 'BSD find (macOS; no --version)' : version(['/usr/bin/find', '--version'])}`)
  console.log(`  bash: ${version(['/bin/bash', '--version'])}`)
  console.log(`  corpus: ${corpus.length} commands (${corpus.filter(r => r.family === 'awk').length} awk, ${corpus.filter(r => r.family === 'find').length} find, ${corpus.filter(r => r.family === 'sort').length} sort)`)
  console.log(`  BYPASS (gate allows, binary changed the sandbox): ${cells.bypass.length}`)
  console.log(`  refused, and the binary changed the sandbox:      ${cells.refusedEffect}`)
  console.log(`  refused, no effect on this host (over-block or another awk/find's spelling): ${cells.overBlock}`)
  console.log(`  allowed, no effect:                               ${cells.read}`)
  for (const row of cells.bypass) console.log(`  BYPASS ${row.family}: ${JSON.stringify(row.command)}  (${row.name})`)
  if (check && cells.bypass.length > 0) process.exit(1)
}
