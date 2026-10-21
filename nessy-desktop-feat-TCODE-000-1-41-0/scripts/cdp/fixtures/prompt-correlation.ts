/**
 * The fixture D1.79 needs — and the MEASUREMENT that says it cannot be used yet.
 *
 * ## What it is for
 *
 * D1.79 (*"nothing ties a hook trace, an export record and a transcript line
 * back to one prompt"*) carries a MEASURE-FIRST clause from its source row
 * P6.460: *"Measure whether `prompt_id` reaches our hook input on each runtime
 * first: if it does, this is a documentation row; if not, one host field unlocks
 * M1's correlation."* Answering it needs the hook's own INPUT, and
 * `agent-surfaces.ts`'s hooks `echo` a marker at the model rather than writing
 * their input down. So this fixture seeds command hooks whose action captures
 * stdin.
 *
 * ## READ THIS BEFORE USING IT — measured 2026-09-18 on the packaged 1.40.0
 *
 * **A `UserPromptSubmit` command hook that redirects its stdin to a FILE hangs
 * the turn indefinitely and creates no file.** The ladder, one run, one Pi
 * gateway card, a fresh session per rung, the control first and again last:
 *
 * | rung | hook command | turn | capture file |
 * | --- | --- | --- | --- |
 * | A (control) | *(no hook)* | 12 040 ms, answered | — |
 * | B | `true` | 7 411 ms, answered | — |
 * | C | `echo <marker>` | 7 451 ms, answered | — |
 * | D | `cat > /dev/null` | 6 021 ms, answered | — |
 * | E | `cat` (stdin to STDOUT) | 11 087 ms, answered | — |
 * | **F** | **`cat >> <path>`** | **TIMEOUT at 60 s and again at 121 s** | **never created** |
 *
 * Rung D re-run immediately AFTER rung F answered in 6 021 ms, which is the
 * control that the hang is not sticky and not the app having wedged itself. The
 * path makes no difference: the config dir and `/private/tmp` both hang, and
 * both spellings run in 8 ms under a plain `sh -c` with the same stdin. The file
 * is never created, and `>>` opens its target before the command runs — so
 * whatever fails, it fails before the shell gets that far.
 *
 * **And the stdout route does not reach a readable surface either.** Rung E
 * completes, and the payload appears in neither the transcript, nor the app's
 * captured output, nor the Pi runtime session log (`hook_event_name` and
 * `UserPromptSubmit` both score 0 over all three).
 *
 * So D1.79's measure-first clause is **not answerable by a capture hook on this
 * build**: the one shape that could record the payload is the one shape that
 * hangs the turn, and the shape that survives writes somewhere nobody can read.
 * That reading, its ladder and its controls are in
 * `docs/testing/cdp-runs/2026-09-18-measure-sitting-5c.md` §9.
 *
 * **This file is therefore kept rather than used**: the next lane to reach for
 * this technique would otherwise re-derive the ladder, and the seeding half is
 * exactly what it will need once the hang is fixed. It has no case behind it by
 * design, and `--remove` takes back precisely what it put in.
 *
 * ## A FIXTURE may write config; a case may not
 *
 * The harness rule, in `scripts/cdp/README.md`'s own words: *"This is a config
 * write, which a CASE may not do … A fixture may — that is what a fixture is —
 * and it happens here, in one reviewable place, against a scratch config dir."*
 * So this file is the only place that touches `hooks.json`, it MERGES rather
 * than replaces, it refuses a `hooks.json` it cannot parse, and `--remove` takes
 * back exactly what it put in.
 *
 * ## Usage
 *
 *     bun run scripts/cdp/fixtures/prompt-correlation.ts --config-dir <dir>
 *     bun run scripts/cdp/fixtures/prompt-correlation.ts --config-dir <dir> --remove
 *
 * It prints the capture path, which is what a case would export as
 * `NESSY_CDP_HOOK_CAPTURE`. **Remove the hooks when you are done**: they carry
 * no matcher, so they would otherwise fire on every turn in that config dir —
 * and on this build, hang it.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The events this fixture captures. No matcher on any of them — see the header. */
export const CAPTURED_EVENTS = ['UserPromptSubmit', 'PostToolUse', 'SessionStart'] as const

/** The marker that identifies THIS fixture's hooks, for the merge and the removal. */
export const CAPTURE_MARKER = 'CDP-HOOK-CAPTURE'

/** The file every captured payload is appended to. */
export function capturePath(configDir: string): string {
  return join(configDir, 'cdp-hook-capture.jsonl')
}

/**
 * The command one hook runs.
 *
 * `printf` writes the envelope and `cat` appends stdin verbatim — never `echo`
 * on the payload itself, which would mangle a JSON document with a shell's own
 * escaping rules. The trailing newline is what makes the file line-oriented for
 * a reader that splits on the envelope.
 *
 * This is rung F of the ladder in the header: correct as a shell command, and
 * the shape that hangs the turn on 1.40.0.
 */
function command(event: string, file: string): string {
  return `{ printf '\\n##${CAPTURE_MARKER}## %s\\n' '${event}'; cat; printf '\\n'; } >> '${file}'`
}

function configDirFromArgv(argv: string[]): string {
  const index = argv.indexOf('--config-dir')
  const explicit = index >= 0 ? argv[index + 1] : undefined
  const dir = explicit ?? process.env.NESSY_CONFIG_DIR
  if (!dir) {
    throw new Error(
      'prompt-correlation: no config dir. Pass --config-dir <dir> or export NESSY_CONFIG_DIR. This fixture writes '
      + 'hooks.json and must never guess which profile it is writing to.',
    )
  }
  return dir
}

async function readHooks(path: string): Promise<{ doc: Record<string, unknown>; map: Record<string, unknown[]> }> {
  const raw = existsSync(path) ? await readFile(path, 'utf8') : ''
  let doc: Record<string, unknown> = {}
  if (raw.trim()) {
    try {
      doc = JSON.parse(raw) as Record<string, unknown>
    } catch {
      throw new Error(
        `${path} is not valid JSON. Refusing to overwrite it — fix or move it, then re-run. A fixture that `
        + 'replaces a config file it could not read is a fixture that eats the operator\'s hooks.',
      )
    }
  }
  return { doc, map: (doc.hooks ?? doc.automations ?? {}) as Record<string, unknown[]> }
}

export async function seed(configDir: string): Promise<{ capture: string; hooksFile: string; events: string[] }> {
  mkdirSync(configDir, { recursive: true })
  const hooksFile = join(configDir, 'hooks.json')
  const capture = capturePath(configDir)
  const { doc, map } = await readHooks(hooksFile)
  for (const event of CAPTURED_EVENTS) {
    const list = Array.isArray(map[event]) ? map[event] : []
    // Drop any earlier copy of OUR hook so a re-seed does not append twice;
    // everything else in the list is left exactly as it was.
    const kept = list.filter(row => !JSON.stringify(row).includes(CAPTURE_MARKER))
    map[event] = [...kept, { actions: [{ type: 'command', command: command(event, capture) }] }]
  }
  await writeFile(hooksFile, `${JSON.stringify({ ...doc, hooks: map }, null, 2)}\n`, 'utf8')
  return { capture, hooksFile, events: [...CAPTURED_EVENTS] }
}

export async function remove(configDir: string): Promise<{ hooksFile: string; removed: string[] }> {
  const hooksFile = join(configDir, 'hooks.json')
  if (!existsSync(hooksFile)) return { hooksFile, removed: [] }
  const { doc, map } = await readHooks(hooksFile)
  const removed: string[] = []
  for (const [event, list] of Object.entries(map)) {
    if (!Array.isArray(list)) continue
    const kept = list.filter(row => !JSON.stringify(row).includes(CAPTURE_MARKER))
    if (kept.length !== list.length) removed.push(event)
    // An event whose list ends up EMPTY is left as an empty list rather than
    // deleted: the operator may have had the key there, and a fixture that
    // prunes keys it did not create is a fixture that edits someone else's file.
    map[event] = kept
  }
  if (removed.length > 0) await writeFile(hooksFile, `${JSON.stringify({ ...doc, hooks: map }, null, 2)}\n`, 'utf8')
  return { hooksFile, removed }
}

if (import.meta.main) {
  const configDir = configDirFromArgv(process.argv)
  if (process.argv.includes('--remove')) {
    const result = await remove(configDir)
    console.log(JSON.stringify({ action: 'remove', ...result }, null, 2))
  } else {
    const result = await seed(configDir)
    console.log(JSON.stringify({ action: 'seed', ...result }, null, 2))
    console.log(`\nexport NESSY_CDP_HOOK_CAPTURE=${result.capture}`)
    console.log(
      '\nWARNING (measured 2026-09-18, packaged 1.40.0): this hook shape HANGS the turn and creates no file. '
      + 'Read this fixture\'s header before driving anything with it, and run --remove afterwards.',
    )
  }
}
