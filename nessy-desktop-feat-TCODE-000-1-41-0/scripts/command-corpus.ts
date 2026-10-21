/**
 * command-corpus — the one read-only copy of the real agent-issued Bash corpus,
 * and the only sanctioned way to read it.
 *
 * P2.389 (owner sitting §1.6 = (A)); the instrument P3.329 was sequenced behind.
 *
 * ## Why this file exists
 *
 * P2.91 measured the removal breaker's blast radius against **18 272 distinct
 * Bash commands actually issued by agents in this repo**, extracted from the
 * local session transcripts. Every number that governs the breaker's posture
 * comes from that corpus — 784 newly-prompting commands (4.29 %), 2 517 with an
 * unparsed nested span (13.78 %), **504 heredocs**. The corpus itself lives
 * under the user's real home directory, and the standing safety rule after this
 * project's own `rm -rf ~` incident forbids EXECUTING any string that names a
 * real home or root. So the lane that needed it correctly routed around it and
 * measured a designed adversarial slice instead: honest, but unweighted.
 *
 * The owner's sitting resolved it (§1.6, decided 2026-09-05): **(A) one copy,
 * read-only, treated as untrusted data.** This script takes that copy and reads
 * it back. It never executes a single byte of it.
 *
 * ## The five constraints the copy is taken under (controller, 2026-09-07)
 *
 * 1. **It lives OUTSIDE the repository** and is never committed — transcripts
 *    are untrusted data and may carry secrets. The path comes from the
 *    `NESSY_COMMAND_CORPUS` environment variable.
 * 2. **Every command string is scrubbed** through the host's own tool-result
 *    secret scanner ({@link scanToolResultForSecrets}, P6.574's named rules)
 *    before it is written. Only the scrubbed text is stored. The manifest
 *    records HOW MANY values each rule redacted and never what they were.
 * 3. **The copy is made read-only** (`chmod -R a-w`) as the last step of
 *    `build`.
 * 4. **Reading a path under the real home is permitted**; the standing rule
 *    forbids a real home as the TARGET of `rm`/`mv`/`chmod`, and this script's
 *    only write target is the corpus directory it is given.
 * 5. **Provenance travels with the copy** — source pattern, file count,
 *    transcript lines, distinct commands, scrub counts, date — in
 *    `MANIFEST.json`, never the transcripts themselves.
 *
 * ## It SKIPS on any other machine, and says so
 *
 * `NESSY_COMMAND_CORPUS` unset, or pointing at a directory that does not exist,
 * is a clean skip with a printed reason and exit 0 — never a failure. Nothing
 * in `bun test` reads this script, and a checkout without the corpus behaves
 * exactly as it does today.
 *
 * ## The corpus is UNTRUSTED DATA
 *
 * Every string in it was written by a model or a user on a real machine. It is
 * read as text, handed to pure functions, and counted. It is never executed,
 * never interpolated into a command, and never printed in bulk — a subcommand
 * that reports examples prints a handful of TRUNCATED ones, because a corpus
 * line is exactly the kind of text that can carry a prompt injection or a path
 * someone would rather not see in a report.
 *
 * ## Usage
 *
 *     # once, by a human or under an explicit approval:
 *     NESSY_COMMAND_CORPUS=<dir> bun scripts/command-corpus.ts build \
 *       --from ~/.claude/projects/<project-dir>
 *
 *     NESSY_COMMAND_CORPUS=<dir> bun scripts/command-corpus.ts stats
 *     NESSY_COMMAND_CORPUS=<dir> bun scripts/command-corpus.ts split-diff
 *
 * `split-diff` is P3.329's instrument: it replays the corpus through the
 * splitter twice — once with the heredoc model off (the reading before P3.329)
 * and once with it on — and classifies every command whose verdict moved. Exit
 * 1 when any move is not attributable to a heredoc body.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  describeHeredocShape,
  splitCompoundCommand,
  splitCompoundCommandWithoutHeredocModel,
} from '../packages/shared/src/agent/pi-harness/claude-bash-rule.ts'
import { scanToolResultForSecrets } from '../packages/shared/src/agent/tool-result-secret-scan.ts'

/* ------------------------------------------------------------------------- *
 * The copy's shape
 * ------------------------------------------------------------------------- */

const COMMANDS_FILE = 'commands.jsonl'
const MANIFEST_FILE = 'MANIFEST.json'

/** Provenance. Counts only — no transcript text ever lands here. */
interface CorpusManifest {
  /** What this is, spelled out for whoever finds the directory later. */
  readonly what: string
  /** The directory the transcripts were read from. */
  readonly sourcePattern: string
  /** Transcript files read. */
  readonly files: number
  /** Transcript lines scanned. */
  readonly transcriptLines: number
  /** Bash tool calls seen, before de-duplication. */
  readonly bashCalls: number
  /** Distinct commands written. */
  readonly commands: number
  /** Rule name to number of values redacted. Never the values. */
  readonly redacted: ReadonlyArray<{ readonly rule: string; readonly count: number }>
  /** Distinct commands that carried at least one redaction. */
  readonly commandsRedacted: number
  /** ISO date the copy was taken. */
  readonly takenAt: string
}

export interface CommandCorpus {
  readonly dir: string
  readonly manifest: CorpusManifest
  readonly commands: readonly string[]
}

/**
 * Load the corpus, or explain why there is none.
 *
 * Returns `null` — with a printed reason — when `NESSY_COMMAND_CORPUS` is unset
 * or names a directory that does not exist. That is the ordinary case on every
 * machine but the one the copy was taken on, and it is never an error.
 */
export function loadCommandCorpus(): CommandCorpus | null {
  const dir = process.env.NESSY_COMMAND_CORPUS
  if (!dir) {
    console.log('SKIP: NESSY_COMMAND_CORPUS is not set — no command corpus on this machine.')
    return null
  }
  if (!existsSync(dir)) {
    console.log(`SKIP: NESSY_COMMAND_CORPUS points at ${dir}, which does not exist.`)
    return null
  }
  const commandsPath = join(dir, COMMANDS_FILE)
  const manifestPath = join(dir, MANIFEST_FILE)
  if (!existsSync(commandsPath) || !existsSync(manifestPath)) {
    console.log(`SKIP: ${dir} exists but carries no ${COMMANDS_FILE}/${MANIFEST_FILE} — run \`build\` first.`)
    return null
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CorpusManifest
  const commands: string[] = []
  for (const line of readFileSync(commandsPath, 'utf8').split('\n')) {
    if (!line) continue
    // Each line is a JSON-encoded string, so a command's own newlines and
    // quotes survive the round trip byte-for-byte.
    const value: unknown = JSON.parse(line)
    if (typeof value === 'string') commands.push(value)
  }
  return { dir, manifest, commands }
}

/* ------------------------------------------------------------------------- *
 * build — the one copy
 * ------------------------------------------------------------------------- */

/**
 * Pull every `Bash` tool call out of one transcript line.
 *
 * The transcripts are JSONL; a line is an object whose `message.content` may be
 * an array of blocks, and a `tool_use` block named `Bash` carries the command in
 * `input.command`. Anything that does not parse is skipped in silence — a
 * transcript is an append-only log and a truncated last line is normal.
 */
export function bashCommandsInLine(line: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const message = (parsed as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return []
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as { type?: unknown; name?: unknown; input?: unknown }
    if (b.type !== 'tool_use' || b.name !== 'Bash') continue
    if (typeof b.input !== 'object' || b.input === null) continue
    const command = (b.input as { command?: unknown }).command
    if (typeof command === 'string' && command.length > 0) out.push(command)
  }
  return out
}

/** What {@link harvestCommands} counted. Counts only — never a matched byte. */
export interface CommandHarvest {
  readonly commands: readonly string[]
  readonly bashCalls: number
  readonly redacted: ReadonlyArray<{ readonly rule: string; readonly count: number }>
  readonly commandsRedacted: number
}

/**
 * Extract, SCRUB and de-duplicate — the whole of the copy's transformation, as
 * one pure function over transcript lines.
 *
 * It is separate from {@link build}'s file I/O for one reason: the corpus came
 * back with **zero** redactions, and an absence finding needs a positive control
 * on the same rig. `command-corpus.test.ts` drives this function with a
 * synthetic transcript line carrying a fake token and asserts the scrub fires,
 * so the zero is a measured absence rather than an unwired scanner.
 */
export function harvestCommands(lines: Iterable<string>): CommandHarvest {
  let bashCalls = 0
  const distinct = new Set<string>()
  const redacted = new Map<string, number>()
  let commandsRedacted = 0
  for (const line of lines) {
    for (const command of bashCommandsInLine(line)) {
      bashCalls += 1
      // Constraint 2: only the SCRUBBED text is ever kept. The counts are
      // accumulated here and the matched bytes are dropped on the floor.
      const scan = scanToolResultForSecrets(command)
      if (scan.counts.length > 0) {
        commandsRedacted += 1
        for (const entry of scan.counts) {
          redacted.set(entry.rule, (redacted.get(entry.rule) ?? 0) + entry.count)
        }
      }
      distinct.add(scan.text)
    }
  }
  return {
    commands: [...distinct].sort(),
    bashCalls,
    redacted: [...redacted].map(([rule, count]) => ({ rule, count })),
    commandsRedacted,
  }
}

function build(fromDir: string, targetDir: string, force: boolean): number {
  if (!existsSync(fromDir) || !statSync(fromDir).isDirectory()) {
    console.error(`build: --from ${fromDir} is not a directory.`)
    return 1
  }
  if (existsSync(join(targetDir, COMMANDS_FILE)) && !force) {
    console.error(
      `build: ${targetDir} already carries a corpus. It is deliberately read-only; pass --force to retake the copy.`,
    )
    return 1
  }
  mkdirSync(targetDir, { recursive: true })
  if (force) {
    // Restore write permission on THIS EXACT directory — the only path this
    // script ever chmods, and the copy's own target (constraint 4).
    spawnSync('chmod', ['-R', 'u+w', targetDir], { stdio: 'inherit' })
  }

  const files = readdirSync(fromDir)
    .filter(name => name.endsWith('.jsonl'))
    .map(name => join(fromDir, name))
    .sort()

  let transcriptLines = 0
  const lines: string[] = []
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue
      transcriptLines += 1
      lines.push(line)
    }
  }
  const harvest = harvestCommands(lines)

  const commands = harvest.commands
  writeFileSync(join(targetDir, COMMANDS_FILE), `${commands.map(c => JSON.stringify(c)).join('\n')}\n`)
  const manifest: CorpusManifest = {
    what: 'Read-only copy of real agent-issued Bash commands (P2.389, owner sitting §1.6 = A). UNTRUSTED DATA: read, never executed. Secret-scrubbed at copy time.',
    sourcePattern: `${fromDir}/*.jsonl`,
    files: files.length,
    transcriptLines,
    bashCalls: harvest.bashCalls,
    commands: commands.length,
    redacted: harvest.redacted,
    commandsRedacted: harvest.commandsRedacted,
    takenAt: new Date().toISOString().slice(0, 10),
  }
  writeFileSync(join(targetDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)

  // Constraint 3.
  spawnSync('chmod', ['-R', 'a-w', targetDir], { stdio: 'inherit' })

  console.log(`corpus written to ${targetDir} (read-only)`)
  console.log(`  transcript files   : ${manifest.files}`)
  console.log(`  transcript lines   : ${manifest.transcriptLines}`)
  console.log(`  Bash tool calls    : ${manifest.bashCalls}`)
  console.log(`  distinct commands  : ${manifest.commands}`)
  console.log(`  commands scrubbed  : ${manifest.commandsRedacted}`)
  console.log(
    `  redactions by rule : ${manifest.redacted.length === 0 ? 'none' : manifest.redacted.map(r => `${r.rule}×${r.count}`).join(', ')}`,
  )
  return 0
}

/* ------------------------------------------------------------------------- *
 * stats — what the corpus says about the splitter today
 * ------------------------------------------------------------------------- */

/** A heredoc operator anywhere in the text. Cheap census only, not a parse. */
const HEREDOC_OPERATOR = /<<-?\s*(?:'[^']*'|"[^"]*"|\\?[A-Za-z_][A-Za-z0-9_]*)/

function stats(corpus: CommandCorpus): number {
  let unparseable = 0
  let heredocs = 0
  let heredocUnparseable = 0
  // P6.716's census: an EXPANDING heredoc body (unquoted delimiter) carrying a
  // `$(…)` or a backtick is the one shape P3.329 left alone, and the row asked
  // for its size before deciding what to do about it. Counts only.
  let expandingCommands = 0
  let executableCommands = 0
  let executableBodies = 0
  let substitutionSpans = 0
  for (const command of corpus.commands) {
    const parts = splitCompoundCommand(command)
    if (parts === null) unparseable += 1
    // `<<<` is a here-STRING, not a heredoc; the operator regex requires a word
    // after `<<` and a here-string's `<` is not one.
    if (HEREDOC_OPERATOR.test(command) && !command.includes('<<<')) {
      heredocs += 1
      if (parts === null) heredocUnparseable += 1
    }
    const shape = describeHeredocShape(command)
    if (shape.expandingBodies > 0) expandingCommands += 1
    if (shape.executableBodies > 0) {
      executableCommands += 1
      executableBodies += shape.executableBodies
      substitutionSpans += shape.substitutionSpans
    }
  }
  console.log(`corpus            : ${corpus.dir}`)
  console.log(`taken             : ${corpus.manifest.takenAt} from ${corpus.manifest.sourcePattern}`)
  console.log(`distinct commands : ${corpus.commands.length}`)
  console.log(`unparseable today : ${unparseable}`)
  console.log(`carry a heredoc   : ${heredocs}`)
  console.log(`  of those, unparseable: ${heredocUnparseable}`)
  console.log(`expanding body (unquoted delimiter) : ${expandingCommands} commands`)
  console.log(`  ... carrying a substitution       : ${executableCommands} commands`)
  console.log(`  ... bodies / substitution spans   : ${executableBodies} / ${substitutionSpans}`)
  return 0
}

/* ------------------------------------------------------------------------- *
 * split-diff — P3.329's instrument
 * ------------------------------------------------------------------------- */

/** Whether `inner` is an order-preserving subsequence of `outer`. */
function isSubsequence(inner: readonly string[], outer: readonly string[]): boolean {
  let cursor = 0
  for (const segment of inner) {
    const at = outer.indexOf(segment, cursor)
    if (at === -1) return false
    cursor = at + 1
  }
  return true
}

/**
 * Replay the corpus through both splitters and classify every verdict move.
 *
 * ## The invariant this measures, and why it is the honest one
 *
 * The module's rule is **refuse more, never approve more**. The heredoc model
 * keeps it by EXCISING body text rather than merging it: a body always occupies
 * whole lines and a newline is a separator, so every body line was already its
 * own segment. What that yields is one of four shapes, and each is named:
 *
 * - **`identical`** — the reading did not move at all.
 * - **`dropped`** — the new list is an order-preserving SUBSEQUENCE of the old
 *   one: body lines the old split read as commands are simply gone. This is the
 *   `["cat <<EOF", "rm -rf ~", "EOF"]` shape the removal breaker fired on.
 * - **`rescued`** — the old reading was `'unparseable'` (a prompt) because an
 *   apostrophe in a body desynced `scanCommand`'s quote state; with the body
 *   excised the command parses.
 * - **`recut`** — the old reading BALANCED but was mis-parsed for the same
 *   reason, so the new list is not a subsequence. Every new segment is still a
 *   SUBSTRING of an old segment: the new reading cuts an old blob finer, it
 *   never invents text.
 *
 * So the class that must be empty is **`invented`** — a segment offered to a
 * rule that appears nowhere in the old reading. Together with `noHeredocMoved`,
 * which must also be zero, that is the row's claim: nothing moves except on a
 * command carrying a heredoc, and nothing a rule is shown is new text.
 *
 * **What this does NOT claim**, stated because a finer cut is genuinely an
 * approve-more direction: an allow rule can match a smaller piece it could not
 * match when the piece was buried in a blob. That is confined to `rescued` and
 * `recut`, i.e. to commands whose old reading was a measured mis-parse, and it
 * is the direction the owner sitting sanctioned when it lifted the ruling.
 */
function splitDiff(corpus: CommandCorpus, showExamples: number): number {
  let identical = 0
  let dropped = 0
  let rescued = 0
  let recut = 0
  let lost = 0
  let noHeredocMoved = 0
  const invented: string[] = []

  for (const command of corpus.commands) {
    const before = splitCompoundCommandWithoutHeredocModel(command)
    const after = splitCompoundCommand(command)
    const same =
      before === null || after === null
        ? before === after
        : before.length === after.length && before.every((part, i) => part === after[i])
    if (same) {
      identical += 1
      continue
    }
    if (!command.includes('<<')) noHeredocMoved += 1
    if (after === null) {
      lost += 1
      continue
    }
    if (before === null) {
      rescued += 1
      continue
    }
    if (isSubsequence(after, before)) {
      dropped += 1
      continue
    }
    if (after.every(segment => before.some(old => old.includes(segment)))) {
      recut += 1
      continue
    }
    invented.push(command)
  }

  console.log(`corpus                             : ${corpus.commands.length} distinct commands`)
  console.log(`identical                          : ${identical}`)
  console.log(`dropped (new list is a subsequence): ${dropped}`)
  console.log(`rescued from 'unparseable'         : ${rescued}`)
  console.log(`recut (every segment a substring)  : ${recut}`)
  console.log(`newly 'unparseable' (refuses more) : ${lost}`)
  console.log(`moved with NO heredoc in the text  : ${noHeredocMoved}   <- must be 0`)
  console.log(`INVENTED segment offered to a rule : ${invented.length}   <- must be 0`)
  if (invented.length > 0 && showExamples > 0) {
    console.log('examples (truncated — corpus text is untrusted):')
    for (const command of invented.slice(0, showExamples)) {
      console.log(`  ${JSON.stringify(command.slice(0, 120))}`)
    }
  }
  return invented.length === 0 && noHeredocMoved === 0 ? 0 : 1
}

/* ------------------------------------------------------------------------- *
 * CLI
 * ------------------------------------------------------------------------- */

function main(argv: readonly string[]): number {
  const subcommand = argv[0] ?? 'stats'
  if (subcommand === 'build') {
    const target = process.env.NESSY_COMMAND_CORPUS
    if (!target) {
      console.error('build: NESSY_COMMAND_CORPUS must name the directory the copy goes into.')
      return 1
    }
    const fromIndex = argv.indexOf('--from')
    if (fromIndex === -1 || !argv[fromIndex + 1]) {
      console.error('build: --from <transcript directory> is required.')
      return 1
    }
    return build(argv[fromIndex + 1] as string, target, argv.includes('--force'))
  }
  const corpus = loadCommandCorpus()
  if (corpus === null) return 0
  if (subcommand === 'stats') return stats(corpus)
  if (subcommand === 'split-diff') return splitDiff(corpus, argv.includes('--examples') ? 5 : 0)
  console.error(`unknown subcommand: ${subcommand} (build | stats | split-diff)`)
  return 1
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)))
}
