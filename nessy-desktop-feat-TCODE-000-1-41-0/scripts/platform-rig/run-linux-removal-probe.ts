#!/usr/bin/env bun
/**
 * The LINUX half of the platform rig: runs the GNU-`rm` corpus inside a
 * throwaway container, asks this repo's removal floor the same questions on the
 * host, and prints the differential.
 *
 *     bun scripts/platform-rig/run-linux-removal-probe.ts
 *     bun scripts/platform-rig/run-linux-removal-probe.ts --json
 *
 * Exit 0 when every row agrees with the floor's posture, 1 on a row the
 * container measured destructive and NEITHER matcher names, 2 when the rig
 * itself could not run (no container runtime, no image, a control that failed).
 * A rig that cannot run says so and exits 2; it never prints a verdict it did
 * not measure.
 *
 * ## Why a container (P2.188, owner decision 2026-09-02 §A4+§A6)
 *
 * `removal-circuit-breaker.ts` accepts `--recursive`, `--dir` and `--force`,
 * and darwin's BSD `rm` cannot execute any of them (`rm: illegal option -- -`,
 * exit 64). Every long-option claim the floor makes was therefore untested on
 * the machine that tests it. The owner bought one Linux container for exactly
 * this, and this script is it.
 *
 * ## The safety property, stated because the rig is a machine that runs `rm`
 *
 * The corpus is piped to `docker run --rm` on stdin. **No host path is
 * mounted**, `--network none` is set, and every `HOME` the container hands to
 * `rm` is a directory the container itself created under `/probe`. The host
 * half of this script never executes a corpus entry — it only classifies the
 * text. So the worst outcome of a wrong corpus entry is a destroyed container
 * layer that is discarded a second later.
 *
 * ## What the two halves are, and why the join is the point
 *
 * - **Container half** — for each spelling: build `/probe/<id>/home` (with
 *   `keep.txt` and `sub/deep.txt`, or empty for {@link EMPTY_HOME_IDS}), run
 *   the spelling under `sh -c` with stdin at `/dev/null`, then report whether
 *   the directory is gone, its content is gone, or the tree is intact.
 * - **Host half** — {@link findRootOrHomeRemoval} (the structured scan) and
 *   {@link findTextualRemoval} (the weaker fallback), both against the same
 *   text with `home` set to the container's synthetic home.
 *
 * The join answers the question the row actually asked: *is there a spelling
 * that really removes a home on Linux and that our floor does not name?* An
 * over-fire (the floor names a spelling the container measured harmless) is
 * reported and is NOT a failure — the floor's stated posture is false positives
 * over false negatives.
 */
import { spawnSync } from 'node:child_process'
import {
  findRootOrHomeRemoval,
  findTextualRemoval,
} from '../../packages/shared/src/agent/pi-harness/removal-circuit-breaker.ts'
import { CONTROL_IDS, EMPTY_HOME_IDS, REMOVAL_CORPUS } from './removal-corpus.ts'
import type { Expectation, RemovalSpelling } from './removal-corpus.ts'

/** The image the rig runs in. Pinned by tag; any GNU coreutils would do. */
const IMAGE = process.env.NESSY_RIG_LINUX_IMAGE ?? 'debian:12-slim'

/** Where the container builds its synthetic homes. Container-only path. */
export const PROBE_ROOT = '/probe'

interface ContainerRow {
  readonly id: string
  readonly exit: number
  readonly outcome: Expectation
  readonly message: string
}

interface JoinedRow {
  readonly spelling: RemovalSpelling
  readonly container: ContainerRow
  readonly structured: boolean
  readonly textual: boolean
}

/**
 * Build the shell program the container runs. The corpus is embedded rather
 * than mounted, so the container sees no host filesystem at all.
 *
 * Each entry is emitted as a heredoc-free `set -- <id>` block because a corpus
 * command may contain any quote character; the id and the command are passed
 * as positional parameters, which no quoting inside the command can escape.
 */
export function buildContainerScript(): string {
  const lines: string[] = [
    'set -u',
    `PROBE=${PROBE_ROOT}`,
    'run_one() {',
    '  id="$1"; empty="$2"; cmd="$3"',
    '  root="$PROBE/$id"; home="$root/home"',
    '  rm -rf "$root" 2>/dev/null',
    '  mkdir -p "$home"',
    '  if [ "$empty" = "0" ]; then',
    '    mkdir -p "$home/sub"',
    '    printf keep > "$home/keep.txt"',
    '    printf deep > "$home/sub/deep.txt"',
    '  fi',
    // A tree that was never built would score "home-removed" for free.
    '  if [ ! -d "$home" ]; then printf "%s\\t-1\\trig-error\\tsynthetic home not built\\n" "$id"; return; fi',
    // `out=$(...)` carries the exit of the SUBSHELL's last command, which is the
    // corpus entry. Piping into `head` here would report head's status instead
    // — the trap that has already made one `tsc` run look green in this tree.
    '  out="$(HOME="$home" sh -c "$cmd" 2>&1 </dev/null)"; code=$?',
    '  msg="$(printf "%s" "$out" | head -1 | tr "\\t\\n" "  ")"',
    '  if [ ! -d "$home" ]; then outcome=home-removed',
    '  elif [ "$empty" = "1" ]; then outcome=intact',
    '  elif [ -f "$home/keep.txt" ] && [ -f "$home/sub/deep.txt" ]; then outcome=intact',
    '  else outcome=content-removed; fi',
    '  printf "%s\\t%s\\t%s\\t%s\\n" "$id" "$code" "$outcome" "$msg"',
    '}',
  ]
  for (const entry of REMOVAL_CORPUS) {
    const empty = EMPTY_HOME_IDS.has(entry.id) ? '1' : '0'
    lines.push(`run_one ${shQuote(entry.id)} ${empty} ${shQuote(entry.command)}`)
  }
  return lines.join('\n') + '\n'
}

/** Single-quote for `sh`, the only quoting form with no escapes inside it. */
export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function runContainer(): { rows: ContainerRow[]; note: string } | { error: string } {
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
  })
  if (probe.status !== 0) {
    return {
      error:
        'no reachable container runtime (`docker version` failed). ' +
        'Start Docker Desktop, or set NESSY_RIG_LINUX_IMAGE and provide a daemon.',
    }
  }
  const serverVersion = probe.stdout.trim()
  const result = spawnSync(
    'docker',
    ['run', '--rm', '-i', '--network', 'none', IMAGE, 'sh', '-s'],
    { input: buildContainerScript(), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  )
  if (result.status !== 0) {
    return { error: `container run failed (exit ${result.status}): ${result.stderr.trim()}` }
  }
  const rows: ContainerRow[] = []
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue
    const [id, exit, outcome, ...rest] = line.split('\t')
    rows.push({
      id: id ?? '',
      exit: Number(exit),
      outcome: (outcome ?? 'unknown') as Expectation,
      message: rest.join(' ').trim(),
    })
  }
  const version = spawnSync(
    'docker',
    ['run', '--rm', '--network', 'none', IMAGE, 'sh', '-c', 'rm --version | head -1; uname -m'],
    { encoding: 'utf8' },
  )
  return {
    rows,
    note: `${IMAGE} on docker server ${serverVersion} — ${version.stdout.trim().replace(/\n/g, ', ')}`,
  }
}

function join(rows: readonly ContainerRow[]): JoinedRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const joined: JoinedRow[] = []
  for (const spelling of REMOVAL_CORPUS) {
    const container = byId.get(spelling.id)
    if (!container) continue
    // The floor is asked about the SAME text the container ran, with `home`
    // set to the synthetic home so `~`/`$HOME` resolve where they did there.
    const home = `${PROBE_ROOT}/${spelling.id}/home`
    const command = spelling.command.replaceAll('$HOME', home)
    joined.push({
      spelling,
      container,
      structured: findRootOrHomeRemoval(command, { home, platform: 'linux' }) !== null,
      textual: findTextualRemoval(command, home) !== null,
    })
  }
  return joined
}

function main(): number {
  const outcome = runContainer()
  if ('error' in outcome) {
    console.error(`platform-rig/linux: RIG UNAVAILABLE — ${outcome.error}`)
    return 2
  }
  const joined = join(outcome.rows)

  const missingControls = CONTROL_IDS.filter((id) => !joined.some((row) => row.spelling.id === id))
  const brokenControls = joined.filter(
    (row) =>
      (CONTROL_IDS as readonly string[]).includes(row.spelling.id) &&
      row.container.outcome !== row.spelling.expectation,
  )
  if (missingControls.length > 0 || brokenControls.length > 0) {
    console.error(
      `platform-rig/linux: RIG UNTRUSTWORTHY — controls failed: ` +
        `${[...missingControls, ...brokenControls.map((r) => r.spelling.id)].join(', ')}`,
    )
    return 2
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ rig: outcome.note, rows: joined }, null, 2))
  } else {
    console.log(`platform-rig/linux — ${outcome.note}`)
    console.log(`corpus: ${joined.length} spellings, ${CONTROL_IDS.length} of them controls\n`)
    const pad = (value: string, width: number) => value.padEnd(width)
    console.log(
      `${pad('id', 24)}${pad('exit', 6)}${pad('measured', 16)}${pad('predicted', 16)}${pad('structured', 12)}textual`,
    )
    for (const row of joined) {
      const drift = row.container.outcome === row.spelling.expectation ? '' : '  <- prediction wrong'
      console.log(
        pad(row.spelling.id, 24) +
          pad(String(row.container.exit), 6) +
          pad(row.container.outcome, 16) +
          pad(row.spelling.expectation, 16) +
          pad(row.structured ? 'fires' : '-', 12) +
          (row.textual ? 'fires' : '-') +
          drift,
      )
    }
  }

  const destructive = joined.filter((row) => row.container.outcome !== 'intact')
  const unnamed = destructive.filter((row) => !row.structured && !row.textual)
  const structuredOnly = destructive.filter((row) => row.structured && !row.textual)
  const overFires = joined.filter((row) => row.container.outcome === 'intact' && row.structured)

  console.log(
    `\ndestructive on GNU: ${destructive.length}` +
      ` | named by neither matcher: ${unnamed.length}` +
      ` | structured-only (fallback blind): ${structuredOnly.length}` +
      ` | over-fires (harmless, floor fires): ${overFires.length}`,
  )
  for (const row of unnamed) {
    console.error(`  UNNAMED  ${row.spelling.id}: ${row.spelling.command} — ${row.spelling.note}`)
  }
  for (const row of structuredOnly) {
    console.log(`  fallback-blind  ${row.spelling.id}: ${row.spelling.command}`)
  }
  return unnamed.length > 0 ? 1 : 0
}

if (import.meta.main) process.exit(main())
