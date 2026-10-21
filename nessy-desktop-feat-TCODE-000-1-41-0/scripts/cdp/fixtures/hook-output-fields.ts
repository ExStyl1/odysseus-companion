/**
 * D1.43's rig — the three hook OUTPUT/INPUT fields the row names, each with a
 * hook that writes its own evidence to a file the CASE never writes.
 *
 * ## Why a fixture and not a case
 *
 * `scripts/cdp/README.md`: *"A **case** never installs hooks, plugins or managed
 * policy … A FIXTURE may — that is what a fixture is — and it happens here, in
 * one reviewable place, against a scratch config dir, rather than inside a case
 * where a later reader would not expect it."* This file is that one place for
 * D1.43, beside `agent-surfaces.ts` which owns AGT-6's and RS-30's hooks. It
 * MERGES into whatever `hooks.json` already holds and refuses to rewrite a file
 * it could not parse, for the same reason that one does.
 *
 * ## The row, and the three clauses
 *
 * D1.43 (source `P6.298`) reads *"three hook OUTPUT fields are enforced
 * host-side and driven on Pi alone — terminalSequence, async/asyncRewake, and
 * the effort input"*. Each clause gets its own hook, so one clause failing
 * cannot mask another:
 *
 *  - **the effort input.** `packages/shared/src/automations/hook-command.ts`
 *    symbol `buildHookCommandEnv` ends with
 *    `setSanitized(env, 'NESSY_EFFORT', input.effort?.level)` and the same for
 *    `CLAUDE_EFFORT`, quoting hooks.md: *"The level is also available to hook
 *    commands and the Bash tool as the `$CLAUDE_EFFORT` environment
 *    variable."* `setSanitized` no-ops on `undefined`, so an absent effort
 *    leaves BOTH names unset — which makes the reading a clean presence test.
 *    {@link PRE_TOOL_USE_ENV_FILE} is what the hook child writes, and the
 *    POSITIVE CONTROL is in the same dump: `NESSY_EVENT` is set
 *    unconditionally at the top of that same function, so a dump carrying
 *    `NESSY_EVENT` and no `CLAUDE_EFFORT` is an absence, while a dump carrying
 *    neither is a hook that did not run the way this rig thinks it did.
 *
 *  - **`terminalSequence`.** Parsed by `parseUniversalHookOutput` against the
 *    OSC allowlist (0/1/2/9/99/777 and BEL) and merged across hooks. The
 *    POSITIVE CONTROL is its own sibling: the same hook emits `systemMessage`
 *    in the same JSON document, and on the Pi path `pi-agent.ts` symbol
 *    `surfaceSessionStartHookMessage` turns a SessionStart `systemMessage` into
 *    an `info` row the transcript keeps. So if the `info` row arrives and no
 *    surface anywhere carries the sequence, the hook ran, its stdout parsed,
 *    and the sequence went nowhere — which is the reading. Both fields ride ONE
 *    document from ONE hook, so no second hook can be blamed.
 *
 *    The sequence is written `]9;…` and not as raw bytes: a bare
 *    ESC inside a JSON string is an unescaped control character and
 *    `JSON.parse` rejects the whole document, so a raw-byte hook would be read
 *    as emitting no fields at all and the absence would be the rig's.
 *
 *  - **`async`.** The hook records an epoch second before a sleep and another
 *    after it, into {@link ASYNC_FILE}. The turn's own last message timestamp
 *    is the product's clock, so `turnEnd < hookEnd` says the turn did not wait
 *    — with the hook's two lines as the control that it ran at all. No second
 *    arm and no second `hooks.json` is needed, which is what keeps this a
 *    one-relaunch rig.
 *
 * ## Safety
 *
 * Every command is `printf`, `env`, `date`, `grep` and `sleep`. Nothing reads a
 * credential, nothing egresses, and the only paths written are under the config
 * dir this fixture was pointed at. `--remove` takes every hook this file added
 * back out, matched on its own marker, and leaves the operator's own hooks and
 * `agent-surfaces.ts`'s alone.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { targetConfigDir } from './agent-surfaces.ts'

/** Everything this fixture writes lives under one directory inside the config dir. */
export const HOOK_OUTPUT_DIR = 'cdp-hook-output'

/** The `PreToolUse` env dump — D1.43's effort clause. */
export const PRE_TOOL_USE_ENV_FILE = 'pre-tool-use-env.txt'

/** The async hook's two epoch seconds — D1.43's async clause. */
export const ASYNC_FILE = 'async-hook.txt'

/** How long the async hook sleeps between its two stamps. */
export const ASYNC_SLEEP_S = 8

/**
 * The marker every hook this fixture writes carries, so `--remove` can find
 * them by content and nothing else has to be listed.
 */
export const HOOK_MARKER = 'CDP-D143'

/** The OSC 9 body, and the `systemMessage` text, so the case can match both. */
export function markerFor(run: string): { system: string; osc: string } {
  return { system: `${HOOK_MARKER}-SYSTEM-${run}`, osc: `${HOOK_MARKER}-OSC-${run}` }
}

interface SeedOptions {
  configDir?: string
  /** A per-run suffix so two sittings in one config dir cannot read each other's markers. */
  run?: string
}

export interface HookFixtureReport {
  configDir: string
  outputDir: string
  envFile: string
  asyncFile: string
  systemMarker: string
  oscMarker: string
  events: string[]
}

function token(): string {
  return Math.random().toString(16).slice(2, 10).toUpperCase()
}

/**
 * Merge D1.43's three hooks into a config dir's `hooks.json`.
 *
 * Shape: `AutomationMatcher` — `{ matcher?, actions: [{ type: 'command', … }] }`
 * keyed by lifecycle event under a `hooks` root, the same shape
 * `agent-surfaces.ts` writes and `automations/hooks-config.ts`
 * `extractHooksMap` accepts.
 */
export async function seedHookOutputFields(options: SeedOptions = {}): Promise<HookFixtureReport> {
  const configDir = targetConfigDir(options.configDir)
  const run = options.run ?? token()
  const outputDir = join(configDir, HOOK_OUTPUT_DIR)
  await mkdir(outputDir, { recursive: true })
  const envFile = join(outputDir, PRE_TOOL_USE_ENV_FILE)
  const asyncFile = join(outputDir, ASYNC_FILE)
  const { system, osc } = markerFor(run)

  const hooksPath = join(configDir, 'hooks.json')
  const raw = existsSync(hooksPath) ? await readFile(hooksPath, 'utf8') : ''
  let doc: Record<string, unknown> = {}
  if (raw.trim()) {
    try {
      doc = JSON.parse(raw) as Record<string, unknown>
    } catch {
      throw new Error(
        `${hooksPath} is not valid JSON. Refusing to overwrite it — fix or move it, then re-run. A fixture that `
        + 'replaces a config file it could not read is a fixture that eats the operator\'s hooks.',
      )
    }
  }
  const map = (doc.hooks ?? doc.automations ?? {}) as Record<string, unknown[]>
  const add = (event: string, entry: Record<string, unknown>): void => {
    const list = Array.isArray(map[event]) ? [...map[event]] : []
    // Drop any earlier run of THIS fixture so a re-seed does not stack two
    // markers onto one turn, and leave everything else exactly where it is.
    map[event] = [...list.filter(row => !JSON.stringify(row).includes(HOOK_MARKER)), entry]
  }

  // ---- clause 1: the effort input, read out of the hook child's own env ----
  //
  // `>>` and not `>`: the file is opened by the shell before the command runs,
  // so a hook whose body fails still leaves the separator line, and "the hook
  // never ran" stays distinguishable from "the hook ran and found nothing".
  add('PreToolUse', {
    actions: [{
      type: 'command',
      command:
        `{ echo "--- ${HOOK_MARKER} $NESSY_EVENT"; `
        + 'env | grep -E \'^(NESSY_EVENT|NESSY_TOOL_NAME|CLAUDE_EFFORT|NESSY_EFFORT)=\'; } '
        + `>> ${JSON.stringify(envFile)} 2>&1`,
    }],
  })

  // ---- clause 2: terminalSequence, with systemMessage as its own control ----
  //
  // ONE document from ONE hook, so the control cannot be answered by a
  // different hook than the subject. `printf '%s'` rather than `echo`, because
  // the payload is JSON and the markers are `[A-Z0-9-]` only, so the whole
  // document sits inside one single-quoted shell word with nothing to escape.
  //
  // The document is built as TEXT rather than through `JSON.stringify`, so the
  // two escapes below are the bytes that reach the hook's stdout: the literal
  // six characters backslash-u-0-0-1-b, which `JSON.parse` on the host turns
  // into ESC. Writing the raw byte instead would make the document invalid
  // JSON and the host would read the hook as emitting no fields at all.
  const sessionStartPayload = `{"systemMessage":"${system}","terminalSequence":"\\u001b]9;${osc}\\u0007"}`
  add('SessionStart', {
    actions: [{ type: 'command', command: `printf '%s' '${sessionStartPayload}'` }],
  })

  // ---- clause 3: async — two stamps around a sleep, on the shell's clock ----
  add('PostToolUse', {
    actions: [{
      type: 'command',
      async: true,
      command:
        `{ echo "${HOOK_MARKER} start $(date -u +%s)"; sleep ${ASYNC_SLEEP_S}; `
        + `echo "${HOOK_MARKER} end $(date -u +%s)"; } >> ${JSON.stringify(asyncFile)} 2>&1`,
    }],
  })

  await writeFile(hooksPath, `${JSON.stringify({ ...doc, hooks: map }, undefined, 2)}\n`, 'utf8')
  return {
    configDir,
    outputDir,
    envFile,
    asyncFile,
    systemMarker: system,
    oscMarker: osc,
    events: ['PreToolUse', 'SessionStart', 'PostToolUse'],
  }
}

/** Take every hook this fixture added back out, matched on {@link HOOK_MARKER}. */
export async function removeHookOutputFields(configDirOverride?: string): Promise<{ configDir: string; removed: string[] }> {
  const configDir = targetConfigDir(configDirOverride)
  const hooksPath = join(configDir, 'hooks.json')
  if (!existsSync(hooksPath)) return { configDir, removed: [] }
  const raw = await readFile(hooksPath, 'utf8')
  if (!raw.trim()) return { configDir, removed: [] }
  const doc = JSON.parse(raw) as Record<string, unknown>
  const map = (doc.hooks ?? doc.automations ?? {}) as Record<string, unknown[]>
  const removed: string[] = []
  for (const [event, list] of Object.entries(map)) {
    if (!Array.isArray(list)) continue
    const kept = list.filter(row => !JSON.stringify(row).includes(HOOK_MARKER))
    if (kept.length !== list.length) {
      removed.push(event)
      if (kept.length > 0) map[event] = kept
      else delete map[event]
    }
  }
  if (removed.length > 0) await writeFile(hooksPath, `${JSON.stringify({ ...doc, hooks: map }, undefined, 2)}\n`, 'utf8')
  return { configDir, removed }
}

if (import.meta.main) {
  if (process.argv.includes('--remove')) {
    const index = process.argv.indexOf('--config-dir')
    const report = await removeHookOutputFields(index >= 0 ? process.argv[index + 1] : undefined)
    console.log(JSON.stringify(report, undefined, 2))
  } else {
    const index = process.argv.indexOf('--config-dir')
    const runIndex = process.argv.indexOf('--run')
    const report = await seedHookOutputFields({
      ...(index >= 0 ? { configDir: process.argv[index + 1]! } : {}),
      ...(runIndex >= 0 ? { run: process.argv[runIndex + 1]! } : {}),
    })
    console.log(JSON.stringify(report, undefined, 2))
    console.log('\nExport for the case:')
    console.log(`  NESSY_CDP_D143_SYSTEM_MARKER=${report.systemMarker}`)
    console.log(`  NESSY_CDP_D143_OSC_MARKER=${report.oscMarker}`)
  }
}
