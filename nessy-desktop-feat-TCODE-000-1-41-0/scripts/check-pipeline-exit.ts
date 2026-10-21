#!/usr/bin/env bun
/**
 * P2.275 — a gate whose exit status is a pipe's, not the gate's.
 *
 * `pipefail` is off by default in every POSIX shell, so a pipeline's status is
 * its LAST stage's. `bun run lint | tail -20`, `tsc … | head`, `eslint … | tee`
 * all return **0** for a gate that failed or never ran, and this was measured
 * directly on this branch: a `bun-test-lock.ts run` that correctly exited 3 on a
 * held mutex exited 0 through `| tail -2`. Piping is exactly what a lane does to
 * keep output readable, and it is the same `tail` that lost eighty-two failing
 * test names here, so the two compound.
 *
 * ## The recorded mitigation is HALF WRONG on the shell this repo runs
 *
 * The row and the lane rules offer "`set -o pipefail` or `${PIPESTATUS[0]}`".
 * Measured 2026-09-03 on this rig, whose login shell is **zsh 5.9**:
 *
 *     (exit 7) | cat
 *     zsh  -> PIPESTATUS[0]=[]  PIPESTATUS[1]=[]  pipestatus[1]=[7]
 *     bash -> PIPESTATUS[0]=[7] PIPESTATUS[1]=[0]
 *
 * `PIPESTATUS` does not exist in zsh at all; the array is `pipestatus` and it is
 * **1-indexed**. So a lane that copies the documented mitigation onto this
 * machine reads an EMPTY STRING and concludes the gate passed — the mitigation
 * failing in the same direction as the bug it was written for. `set -o pipefail`
 * works in both shells and is the one to reach for; read the OUTPUT for proof of
 * work (`Ran N tests`, `0 errors`) rather than trusting a status either way.
 *
 * ## What this file guards, and what it cannot
 *
 * It reads the gate DEFINITIONS this repo commits — every `package.json`
 * `scripts` entry and every tracked shell script — and refuses a pipeline whose
 * exit status is discarded where the value is load-bearing. It cannot see how a
 * lane invokes a gate at a prompt; nothing can. Measured when it was written:
 * `scripts/` and every workspace `package.json` are CLEAN, and the one place
 * that pipes deliberately (`scripts/platform-rig/run-linux-removal-probe.ts`'s
 * generated container script) captures `$?` into `code` BEFORE the pipe with a
 * comment naming this exact trap. The two findings it did have were
 * `apps/electron/scripts/build-{dmg,linux}.sh`, fixed in the same commit.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')

/** Tracked files, so a stray build artefact or another lane's scratch file is not read. */
export function tracked(...patterns: string[]): string[] {
  const result = Bun.spawnSync(['git', 'ls-files', '--', ...patterns], { cwd: REPO, stdout: 'pipe' })
  return result.stdout.toString().split('\n').filter(line => line.trim().length > 0)
}

/**
 * Fixtures are shell scripts that stand for a PLUGIN'S OWN hooks, not gates of
 * ours; holding them to this rule would be asserting something about the corpus
 * `github.com/openai/plugins` rather than about this repo.
 */
const NOT_A_GATE = /(^|\/)(__tests__|fixtures)\//

/** A `|` that is not `||`, outside single or double quotes. */
function pipelineStages(segment: string): string[] {
  const stages: string[] = []
  let current = ''
  let quote: string | null = null
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index]!
    if (quote) {
      if (character === quote) quote = null
      current += character
      continue
    }
    if (character === '"' || character === "'") { quote = character; current += character; continue }
    if (character === '|') {
      if (segment[index + 1] === '|') { current += '||'; index += 1; continue }
      if (segment[index - 1] === '|') { current += character; continue }
      stages.push(current)
      current = ''
      continue
    }
    current += character
  }
  stages.push(current)
  return stages
}

const HEAD_OF = (stage: string): string => (stage.trim().split(/\s+/)[0] ?? '').replace(/^[$("']+/, '')

/** Commands whose whole job is to reshape text — never the thing whose status matters. */
const FILTERS = new Set([
  'tail', 'head', 'grep', 'egrep', 'fgrep', 'rg', 'tee', 'sed', 'awk', 'cut', 'tr',
  'sort', 'uniq', 'wc', 'jq', 'column', 'cat', 'less', 'more', 'xargs',
])

export interface PipelineFinding {
  readonly file: string
  readonly where: string
  readonly text: string
  readonly why: string
}

/** `VAR=$( … | … )` — the value is used, so a lost status becomes an empty value. */
const ASSIGNED_SUBSTITUTION = /^\s*(?:local\s+|export\s+)?[A-Za-z_][A-Za-z0-9_]*=\$\((.+)\)\s*$/

export function scanShellScripts(files: readonly string[] = tracked('*.sh')): PipelineFinding[] {
  const findings: PipelineFinding[] = []
  for (const file of files) {
    if (NOT_A_GATE.test(file)) continue
    const source = readFileSync(resolve(REPO, file), 'utf8')
    if (/^\s*set\s+-[a-z]*o\s+pipefail/m.test(source) || /^\s*set\s+-o\s+pipefail/m.test(source)) continue
    source.split('\n').forEach((line, index) => {
      const text = line.trim()
      if (text.length === 0 || text.startsWith('#')) return
      const assignment = ASSIGNED_SUBSTITUTION.exec(line)
      const body = assignment ? assignment[1]! : line
      const stages = pipelineStages(body)
      if (stages.length < 2) return
      if (!FILTERS.has(HEAD_OF(stages.at(-1)!))) return
      if (!assignment) return
      findings.push({
        file,
        where: `line ${index + 1}`,
        text,
        why: 'the value of this assignment comes out of a pipeline in a script with no `set -o pipefail`, '
          + "so a failure in the first stage produces an EMPTY value and exit 0 rather than a refusal.",
      })
    })
  }
  return findings
}

/** Commands whose exit status is the point — a gate, a build, a generator. */
const GATES = /^(bun|bunx|npm|npx|node|tsc|eslint|prettier|python3?|pytest|vitest|jest|cargo|swift|xcodebuild|electron-builder)$/

export function scanPackageScripts(files: readonly string[] = tracked('package.json', '*/package.json', '*/*/package.json')): PipelineFinding[] {
  const findings: PipelineFinding[] = []
  for (const file of files) {
    if (file.includes('node_modules') || file.includes('.references') || NOT_A_GATE.test(file)) continue
    const parsed = JSON.parse(readFileSync(resolve(REPO, file), 'utf8')) as { scripts?: Record<string, string> }
    for (const [name, command] of Object.entries(parsed.scripts ?? {})) {
      for (const segment of command.split(/&&|\|\||;/)) {
        const stages = pipelineStages(segment)
        if (stages.length < 2) continue
        if (!FILTERS.has(HEAD_OF(stages.at(-1)!))) continue
        if (!GATES.test(HEAD_OF(stages[0]!))) continue
        findings.push({
          file,
          where: `scripts.${name}`,
          text: command,
          why: 'the script ends in a text filter, so the gate ahead of it can fail and the script still exit 0. '
            + 'Put `set -o pipefail;` in front of it, or drop the filter and let the gate print its own summary.',
        })
      }
    }
  }
  return findings
}

// ---------------------------------------------------------------------------

if (import.meta.main) {
  const findings = [...scanShellScripts(), ...scanPackageScripts()]
  for (const finding of findings) {
    console.error(`${finding.file} · ${finding.where}\n    ${finding.text}\n    ${finding.why}`)
  }
  console.log(
    `pipeline exit safety: ${findings.length} finding(s) over `
    + `${tracked('*.sh').length} shell scripts and `
    + `${tracked('package.json', '*/package.json', '*/*/package.json').length} package manifests. `
    + 'This reads gate DEFINITIONS; it cannot see how a lane pipes a gate at a prompt.',
  )
  process.exit(findings.length > 0 ? 1 : 0)
}

