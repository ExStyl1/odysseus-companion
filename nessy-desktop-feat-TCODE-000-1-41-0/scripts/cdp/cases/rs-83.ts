/**
 * RS-83 (D1.76, half (a)) — what a RUNNING session re-reads when a settings file
 * is edited under it.
 *
 * ## The row
 *
 * D1.76 is *"what a running session re-reads — a saved settings file, and a
 * config directory pointed somewhere else"*, and it is 🟨. Half (b) was answered
 * by measure sitting 5c as a reading (`2026-09-18-measure-sitting-5c.md` §8): a
 * fresh `NESSY_CONFIG_DIR` exported before the app starts really does load
 * nothing from the usual setup, `CLAUDE_CONFIG_DIR` is host-written per
 * WORKSPACE and `CODEX_HOME` is a per-SESSION mkdtemp. Half (a) — *"editing a
 * settings file with a session live"* — stayed owed. This case takes it.
 *
 * ## The detector, and it is three readings of the same moment
 *
 *  1. **`getSettingsProvenance`** — the product's own account of which file
 *     supplies which family. Before the edit it reports the config file as
 *     `present-no-keys` for the `instructionExcludes` family; a host that
 *     re-read it should report something else after.
 *  2. **the app's own ConfigWatcher output** — the host announces what it is
 *     watching and what it re-read, and on a debug-mode launch that goes to the
 *     app's stdout. `NESSY_CDP_APP_LOG` names the file the operator captured it
 *     into; without it that arm is UNAVAILABLE rather than negative.
 *  3. **a turn taken AFTER the edit, in the session that was already open** —
 *     the claude child logs every `settings.json` it opens into the per-session
 *     diagnostic (RS-71 measured that file; RS-77 read it). A session that
 *     re-reads its settings has to open something.
 *
 * ## The controls
 *
 *  1. **the session is genuinely LIVE across the edit** — it exists, it has run
 *     a turn before the edit, and it runs another after it. A fresh session
 *     created after the edit would read the new file for uninteresting reasons.
 *  2. **the edit landed** — the file's bytes and its top-level key set before
 *     and after, from the fixture's own round trip. "The host did not re-read
 *     it" is equally true of a write that never happened.
 *  3. **the key set is otherwise unchanged** — the fixture merges, so every
 *     other key survives. A settings write that drops keys is the failure mode
 *     `StoredConfigKnownFields` exists to prevent, and a case that caused one
 *     would be measuring its own damage.
 *
 * ## What it restores
 *
 * The exact previous value of the one key it touched — including "absent", which
 * is a different state from "present and empty" — in a `finally`.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { configDir } from '../lib/runtime-session-log.ts'
import { listConnections, runtimeOf, switchRuntime } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'
import { LIVE_EDIT_KEY, writeLiveSetting } from '../fixtures/live-settings-edit.ts'

const ID = 'RS-83'
const TITLE = 'what a running session re-reads when a settings file is edited under it'

/** Where the operator captured the app's own stdout, if they did. */
const APP_LOG = process.env.NESSY_CDP_APP_LOG

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.76',
  runtimes: ['claude'],
  credentials:
    'owner: a claude-runtime card, because the third reading is the claude child\'s own account of which '
    + 'settings files it opened. No key is read; the only file written is the run\'s own config.json, restored.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, a config dir created for the run, launched with the `env -u` launcher AND NESSY_DEBUG=1, with the app\'s stdout captured to a file named by NESSY_CDP_APP_LOG.',
    '2. Open a session on a claude card and run one turn, so it is genuinely live.',
    '3. Read `getSettingsProvenance` and note the config file\'s state for the `instructionExcludes` family.',
    '4. Edit that file through `scripts/cdp/fixtures/live-settings-edit.ts` — a merge, with the previous value handed back.',
    '5. WITHOUT relaunching, read the provenance again, read the app\'s own output since the edit, and run a SECOND turn in the SAME session.',
    '6. Restore the previous value.',
  ],
  expected:
    'A host that re-reads a saved settings file reports the new state on its own provenance surface without a '
    + 'relaunch, and says so in its own ConfigWatcher output. Whether the RUNNING session picks it up for its '
    + 'next turn is the row\'s real question and is recorded rather than assumed.',
  detector:
    'the product\'s own `getSettingsProvenance` before and after, the app\'s own stdout since the edit, and the '
    + 'claude child\'s own per-session diagnostic for the turn taken AFTER the edit.',
  positiveControl:
    'the fixture\'s own round trip — the file\'s byte count and its complete top-level key set before and after — '
    + 'plus a session that ran a turn BEFORE the edit and another AFTER it. Without the first, "the host did not '
    + 're-read it" is equally true of a write that never landed; without the second, a session created after the '
    + 'edit would read the new file for reasons that have nothing to do with re-reading.',
  doneMeans:
    'D1.76 half (a) records what a live session re-reads when a settings file changes under it, with the surface '
    + 'each reading came from — completing the row, whose half (b) is already answered.',
  doNotConflate:
    'The ConfigWatcher arm is UNAVAILABLE without `NESSY_CDP_APP_LOG`, never negative: a packaged build writes no '
    + 'application log of its own, so an absent capture is a missing instrument.',
} as const satisfies SittingRecipe

interface Provenance {
  families?: Array<{ id: string; combine?: string; entries?: Array<{ scope: string; file: string; state: string }> }>
}

function stateOf(provenance: Provenance, family: string, file: string): string | undefined {
  return provenance.families
    ?.find(entry => entry.id === family)
    ?.entries?.find(entry => entry.file === file)?.state
}

/** Everything the app printed after `offset` bytes — the ConfigWatcher arm. */
function appOutputSince(offset: number): { available: boolean; text: string; bytes: number } {
  if (!APP_LOG || !existsSync(APP_LOG)) return { available: false, text: '', bytes: 0 }
  const whole = readFileSync(APP_LOG, 'utf8')
  return { available: true, text: whole.slice(offset), bytes: whole.length }
}

/** The claude child's own account of which settings paths it opened. */
function childSettingsPaths(root: string, sessionId: string): { file?: string; lines: number; paths: string[] } {
  const dir = join(root, 'logs', 'runtime')
  if (!existsSync(dir)) return { lines: 0, paths: [] }
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(sessionId) || !name.endsWith('-claude.txt')) continue
    const file = join(dir, name)
    let text: string
    try { text = readFileSync(file, 'utf8') } catch { continue }
    const paths = new Set<string>()
    for (const match of text.matchAll(/(?:for settings\.json at path|Watching for changes in setting files)[: ]+(\S+?)(?:\.\.\.)?\s*$/gm)) {
      if (match[1]) paths.add(match[1])
    }
    return { file, lines: text.split('\n').filter(Boolean).length, paths: [...paths].sort() }
  }
  return { lines: 0, paths: [] }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const root = configDir()

  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the settings a live session re-reads')
  if (contaminated !== undefined) blocked(contaminated)

  const card = (await listConnections(session)).find(row => runtimeOf(row.providerType) === 'anthropic')
  if (!card) blocked('this profile lists no claude-runtime card, and the third reading is the claude child\'s own')

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.check('the case ran in a session it created', key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages}`)
  const bind = await switchRuntime(session, key.sessionId, card.slug)
  run.check(`the session is bound to ${card.slug}`, bind.ok, bind.ok ? undefined : bind.error)
  await sendPrompt(session, key, 'Reply with the single word ready. Do not use any tool.', 300_000)
  const childBefore = childSettingsPaths(root, key.sessionId)
  run.observe('the child\'s settings account BEFORE the edit', childBefore)
  run.require(
    'THE CONTROL — the session ran a turn BEFORE the edit, so it is genuinely live across it',
    childBefore.lines > 0,
    `no per-session diagnostic for ${key.sessionId} under ${join(root, 'logs', 'runtime')}. Without a turn before `
    + 'the edit this is a fresh session reading a new file, which is not what the row asks',
  )

  const configFile = join(root, 'config.json')
  const provenanceBefore = await session.call<Provenance>(`return await window.electronAPI.getSettingsProvenance()`)
  const stateBefore = stateOf(provenanceBefore, LIVE_EDIT_KEY, configFile)
  run.observe('the provenance BEFORE', { file: configFile, family: LIVE_EDIT_KEY, state: stateBefore })

  const logOffset = appOutputSince(0).bytes
  const marker = `CDP-${ID}-${Date.now().toString(36)}`
  let edit
  try {
    edit = writeLiveSetting(root, [marker])
  } catch (error) {
    blocked(`the fixture refused the edit: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    run.observe('the edit', edit)
    run.require(
      'THE CONTROL — the edit landed, and the merge kept every other key',
      edit.bytesAfter !== edit.bytesBefore && edit.keysAfter.length >= edit.keysBefore.length,
      `${edit.bytesBefore} → ${edit.bytesAfter} bytes, keys ${JSON.stringify(edit.keysBefore)} → `
      + `${JSON.stringify(edit.keysAfter)}. A write that did not land, or one that dropped keys, makes every `
      + 'reading below meaningless — and a dropped key is the failure `StoredConfigKnownFields` exists to prevent',
    )

    // Give the host's own watcher a moment; it is a file watcher, not a poll the
    // case controls, so this is a wait rather than an assumption about latency.
    await Bun.sleep(4_000)

    const provenanceAfter = await session.call<Provenance>(`return await window.electronAPI.getSettingsProvenance()`)
    const stateAfter = stateOf(provenanceAfter, LIVE_EDIT_KEY, configFile)
    run.observe('the provenance AFTER, with no relaunch', { state: stateAfter })
    run.check(
      'D1.76(a) — the host re-reads a settings file edited under it, with no relaunch',
      stateAfter !== undefined && stateAfter !== stateBefore,
      `the provenance surface reported ${JSON.stringify(stateBefore)} before and ${JSON.stringify(stateAfter)} `
      + `after a merge that added \`${LIVE_EDIT_KEY}\` to ${configFile}. An unchanged state means the running host `
      + 'is answering from a snapshot taken at startup',
    )

    const output = appOutputSince(logOffset)
    const watcherLines = output.text.split('\n').filter(line => /ConfigWatcher|config|settings/i.test(line)).slice(0, 12)
    run.observe('what the app itself said after the edit', {
      available: output.available,
      note: output.available ? undefined : 'NESSY_CDP_APP_LOG was not set or the file is gone — this arm is UNAVAILABLE, not negative',
      lines: watcherLines,
    })

    await sendPrompt(session, key, 'Reply with the single word again. Do not use any tool.', 300_000)
    const childAfter = childSettingsPaths(root, key.sessionId)
    run.observe('the child\'s settings account AFTER the edit', childAfter)
    run.check(
      'D1.76(a) — the RUNNING session\'s next turn re-opened its settings files',
      childAfter.lines > childBefore.lines,
      `the per-session diagnostic went ${childBefore.lines} → ${childAfter.lines} lines across a turn taken after `
      + `the edit, and the paths it names went ${JSON.stringify(childBefore.paths)} → ${JSON.stringify(childAfter.paths)}`,
    )
  } finally {
    if (edit) {
      const restored = writeLiveSetting(root, edit.previous)
      run.observe('the restore', { back: restored.wrote, keys: restored.keysAfter.length, bytes: restored.bytesAfter })
    }
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
