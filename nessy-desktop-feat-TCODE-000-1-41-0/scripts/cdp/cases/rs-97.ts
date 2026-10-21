/**
 * RS-97 (D1.134) — the per-event hook matrix: which of the 32 host events
 * actually FIRE on claude, with the same matrix on Pi as the row's own control.
 *
 * ## The row
 *
 * D1.134 asks for *"one command hook per SDK `HookEvent` through our own tiers
 * plus one per event in the loaded settings scopes"*, and for every
 * declaration-backed `emitted` verdict in `ANTHROPIC_HOOK_EVENT_EMISSION` to be
 * replaced by an observed firing or non-firing. It names TWO controls: the same
 * hook set on Pi, and the same file with `settingSources` narrowed. This case
 * drives the host-tier half and the FIRST control. The second is recorded as
 * owed rather than guessed at — `settingSources` is an SDK option the host sets
 * per spawn and no product surface offers it, so narrowing it is a source change
 * and not a rig action.
 *
 * ## The detector, and why it is a FILE
 *
 * `fixtures/agent-surfaces.ts --hook-matrix <dir>` writes one command hook per
 * `AGENT_EVENTS` entry, each appending `<marker> <Event>` to
 * `<dir>/<Event>.hit`. A hook's stdout only reports firing for the handful of
 * events whose output is delivered somewhere a case can read; a file append
 * reports it for all 32, it survives the turn and the session, and `>>` opens
 * its target before writing — so a hook that started and produced nothing is
 * still distinguishable from one that never started.
 *
 * The reading is a DELTA per phase, never a total: one `hits` directory serves
 * every arm, so a per-event line count is snapshotted before each phase and
 * subtracted after it. Without that, the Pi control and the claude subject would
 * be one number and the case would be measuring their sum.
 *
 * ## The controls, all three of them
 *
 *  1. **REGISTRATION, not just firing.** `/hooks` is the product's own account of
 *     which hooks this session will run — and it prints what SURVIVED the six
 *     locks, not what was registered, which is exactly the question. A zero in
 *     the hit files means "did not fire" only if that listing names the hook;
 *     otherwise it means "was never loaded", a different finding this case must
 *     not report as the first. `getSessionCapabilityInventory` was tried and is
 *     the wrong surface: on the packaged 1.40.0 it answers 27 MCP/capability
 *     rows and no hook, so its zero says nothing about hooks.
 *  2. **The instrument can write.** `UserPromptSubmit` fires on every runtime
 *     that has hooks at all, so a run in which NOTHING appears is an instrument
 *     failure rather than a product one — the case says so instead of banking 32
 *     zeros.
 *  3. **The same matrix on Pi**, the row's own named control, in the same run
 *     and against the same files. A zero on claude beside a non-zero on Pi is a
 *     runtime difference; a zero on both is this fork's hook layer.
 *
 * ## What a zero here does NOT claim
 *
 * `runtime-hook-events.ts` is explicit that "this event never fires on claude"
 * is not a claim a closed bundle supports. This case measures ONE session's
 * worth of provocations — a start, a turn with a tool call, a model switch, an
 * end — so an event whose moment this case never creates reports `not-provoked`,
 * which is recorded separately from `provoked-and-silent`. Collapsing the two
 * would turn "we did not ask" into "it does not work".
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import { sendPrompt, sendSlashCommand } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { configDir } from '../lib/runtime-session-log.ts'
import { listConnections, runtimeOf, selectModel, switchRuntime } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, transcript, type TranscriptMessage } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'
import { turnOwnText } from '../lib/turn-evidence.ts'

const ID = 'RS-97'
const TITLE = 'which host hook events actually fire on claude, with the same matrix on Pi as the control'

/** Where `--hook-matrix` was pointed. The case reads it and never writes it. */
const HITS = process.env.NESSY_CDP_HOOK_MATRIX_DIR

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.134',
  runtimes: ['claude', 'pi'],
  credentials:
    'owner: a claude-runtime card and a pi card, both one-click gateway cards. No key is read. The only '
    + 'config write is the fixture\'s own `hooks.json`, in a config dir created for the run.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, a config dir created for the run, seeded with `bun run scripts/cdp/fixtures/agent-surfaces.ts --config-dir <dir> --hook-matrix <hits dir>` — one command hook per AgentEvent.',
    '2. Launch with the `env -u` launcher; export NESSY_CDP_HOOK_MATRIX_DIR=<hits dir> for the case.',
    '3. The case opens a session per runtime and provokes: session start, a turn that calls a tool, a model switch, a second turn.',
    '4. After each phase it reads the per-event line counts and subtracts the snapshot taken before it.',
  ],
  expected:
    'Every event the host says it registered and whose moment this run creates leaves a line in its own file. '
    + 'An event that fires on Pi and not on claude is a runtime difference; one that fires on neither is this '
    + 'fork\'s hook layer, not the SDK.',
  detector:
    'one `<Event>.hit` file per AgentEvent, written by the event\'s own command hook, read as a DELTA per phase '
    + 'so two runtimes sharing one directory are never one number.',
  positiveControl:
    'three: the product\'s own `/hooks` listing (registration, so a zero cannot be read as '
    + '"did not fire" when it means "never loaded"); UserPromptSubmit, which must appear on any runtime with hooks '
    + 'at all, so a wholly empty run is an instrument failure; and the same matrix on Pi in the same run, which is '
    + 'the row\'s own named control.',
  doneMeans:
    'The `anthropic` column of the hook-event table carries observed firings and observed silences for the events '
    + 'this run provokes, and the events it does NOT provoke are named as unprovoked rather than scored.',
  doNotConflate:
    '`not-provoked` and `provoked-and-silent` are different findings. So are "did not fire" and "was never '
    + 'registered" — the first control exists for exactly that. And a silence here is never "never fires": the '
    + 'SDK is a closed bundle and one session is not a proof of absence.',
} as const satisfies SittingRecipe

/** Per-event line counts in the hits directory. Absent file = 0, never undefined. */
function readHits(dir: string): Record<string, number> {
  const out: Record<string, number> = {}
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.hit')) continue
    const event = name.slice(0, -4)
    try {
      out[event] = readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).length
    } catch { out[event] = 0 }
  }
  return out
}

/** What arrived between two readings, as `{ Event: n }` with zeros dropped. */
function delta(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [event, count] of Object.entries(after)) {
    const grew = count - (before[event] ?? 0)
    if (grew > 0) out[event] = grew
  }
  return out
}

/** The events the fixture wrote a hook for — the denominator, read off the file itself. */
function matrixEvents(root: string): { events: string[]; marker?: string } {
  const path = join(root, 'hooks.json')
  if (!existsSync(path)) return { events: [] }
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { hooks?: Record<string, unknown[]> }
    const map = doc.hooks ?? {}
    const events: string[] = []
    let marker: string | undefined
    for (const [event, rows] of Object.entries(map)) {
      const text = JSON.stringify(rows)
      const hit = /CDP-HOOKMX-[0-9A-F]+/.exec(text)
      if (!hit) continue
      events.push(event)
      marker ??= hit[0]
    }
    return { events: events.sort(), ...(marker ? { marker } : {}) }
  } catch { return { events: [] } }
}

/**
 * The PRODUCT's own account of the hooks this session will run — `/hooks`.
 *
 * `slash-commands/hooks-command.ts` is the one surface that lists them, and it
 * is the right registration control precisely because it prints what SURVIVED
 * the six locks rather than what was registered. Its three states are kept
 * apart here for the reason that module gives: *"absence is not emptiness"* —
 * `HOOKS_UNSUPPORTED_LINE` (the runtime published no listing), the empty
 * listing, and rows are three different findings, and a case that folded them
 * would report "no hooks" about a session that never published a list.
 *
 * `getSessionCapabilityInventory` was tried first and is the WRONG surface: on
 * the packaged 1.40.0 it answers 27 rows of `{ key, kind, logicalName, reason }`
 * — MCP servers and capabilities, no hook among them — so a walk for
 * `{ event, tier }` finds nothing and the zero says nothing about hooks.
 */
async function hooksListing(session: CdpSession, key: { sessionId: string; workspaceId: string }): Promise<{
  available: boolean
  text: string
  events: string[]
  note?: string
}> {
  const before = (await transcript(session, key)).length
  try {
    await sendSlashCommand(session, key, {
      // `/hooks` submits itself on selection and leaves the composer EMPTY —
      // `slash-command-actions.ts` makes `subtask` the only PREFILL_COMMAND, and
      // a case that expects a prefill here dies at `palette-selection-did-not-
      // prefill` with the composer holding a bare "\n" (measured 2026-09-18).
      token: 'hooks', match: /hooks/i, expectComposer: '', submitOnSelect: true, timeoutMs: 120_000,
    })
  } catch (error) {
    return { available: false, text: '', events: [], note: `/hooks did not run: ${error instanceof Error ? error.message : String(error)}` }
  }
  return hooksListingOf((await transcript(session, key)).slice(before))
}

/**
 * The listing `/hooks` added to the transcript, read off the rows its turn
 * added MINUS the user's own `/hooks` row (F1.503) — joined in, that row made
 * `available` true on every run, so "registration is read beside firing"
 * passed whether or not the product listed anything.
 */
export function hooksListingOf(added: readonly TranscriptMessage[]): { available: boolean; text: string; events: string[] } {
  const text = turnOwnText(added)
  // The events are read off the listing's own grouping — `<Event>:` on a line of
  // its own, which `formatHookBindingsReport` writes and nothing else does.
  const events = [...new Set([...text.matchAll(/^([A-Z][A-Za-z]+):$/gm)].map(hit => hit[1]!))].sort()
  return { available: text.length > 0, text: text.slice(0, 4_000), events }
}

interface ArmReading {
  runtime: string
  card: string
  sessionId: string
  registered: { available: boolean; text: string; events: string[]; note?: string }
  phases: Record<string, Record<string, number>>
  fired: string[]
}

async function driveArm(
  run: CaseRun,
  session: CdpSession,
  card: { slug: string; providerType: string },
  hits: string,
): Promise<ArmReading> {
  const runtime = runtimeOf(card.providerType)
  const before = readHits(hits)
  const key = await freshSession(session, `CDP ${ID} ${runtime} ${new Date().toISOString().slice(11, 19)}`)
  const bind = await switchRuntime(session, key.sessionId, card.slug)
  run.check(`${runtime}: the session is bound to ${card.slug}`, bind.ok, bind.ok ? undefined : bind.error)
  const phases: Record<string, Record<string, number>> = {}

  const mark = (name: string, snapshot: Record<string, number>): Record<string, number> => {
    const now = readHits(hits)
    phases[name] = delta(snapshot, now)
    return now
  }

  let snapshot = mark('session-start', before)
  const registered = await hooksListing(session, key)
  run.observe(`${runtime}: what the product's own /hooks says will run`, registered)
  snapshot = mark('the-hooks-listing', snapshot)

  // A turn that must call a tool, so PreToolUse / PostToolUse / PostToolBatch /
  // PermissionRequest have a moment. `pwd` is in no DANGEROUS_COMMANDS list.
  await sendPrompt(session, key, 'Run the shell command pwd once, then reply with the single word done.', 900_000)
  snapshot = mark('turn-with-a-tool-call', snapshot)

  // A model switch, so PreModelSwitch / PostModelSwitch have a moment. The
  // second model is read off the card rather than named, so this arm works on
  // whatever the catalogue publishes.
  const models = await session.call<string[]>(`
    const rows = await window.electronAPI.getLlmConnections()
    const row = (rows ?? []).find(entry => entry.slug === ${JSON.stringify(card.slug)})
    return (row?.models ?? []).map(model => model.id ?? model)
  `).catch(() => [] as string[])
  const current = await session.call<string | null>(`
    return (await window.electronAPI.getSessionModel(
      ${JSON.stringify(key.sessionId)}, ${JSON.stringify(key.workspaceId)},
    )) ?? null
  `).catch(() => null)
  const other = models.find(model => model !== current)
  if (other) await selectModel(session, key, other)
  run.observe(`${runtime}: the model switch`, { from: current, to: other ?? null, offered: models.length })
  snapshot = mark('model-switch', snapshot)

  await sendPrompt(session, key, 'Reply with the single word again. Do not use any tool.', 600_000)
  mark('second-turn', snapshot)

  const fired = [...new Set(Object.values(phases).flatMap(phase => Object.keys(phase)))].sort()
  return { runtime, card: card.slug, sessionId: key.sessionId, registered, phases, fired }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const root = configDir()

  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'which hook events fire')
  if (contaminated !== undefined) blocked(contaminated)

  if (!HITS) {
    blocked(
      'NESSY_CDP_HOOK_MATRIX_DIR is unset. This case reads the directory the matrix hooks append to; without it '
      + 'every event would read as silent for want of an instrument. Seed with '
      + '`bun run scripts/cdp/fixtures/agent-surfaces.ts --config-dir <dir> --hook-matrix <hits>` and export it.',
    )
  }
  const hits = HITS

  const matrix = matrixEvents(root)
  run.observe('the matrix on disk', { events: matrix.events.length, marker: matrix.marker, dir: hits })
  run.require(
    'THE PRECONDITION — the config dir carries one CDP hook per event',
    matrix.events.length >= 30,
    `${join(root, 'hooks.json')} carries a CDP matrix hook for ${matrix.events.length} event(s). The fixture writes `
    + 'one per AGENT_EVENTS entry (32 at the artefact commit), so a smaller number means the seed did not land in '
    + 'the dir the app was launched with — and every zero below would then be a reading about the wrong directory',
  )

  const cards = await listConnections(session)
  const claude = cards.find(row => runtimeOf(row.providerType) === 'anthropic')
  const pi = cards.find(row => runtimeOf(row.providerType) === 'pi')
  if (!claude) blocked(`this profile lists no claude-runtime card; it lists ${cards.map(c => c.slug).join(', ') || 'nothing'}`)

  const claudeArm = await driveArm(run, session, claude, hits)
  run.observe('claude — what fired, by phase', claudeArm.phases)
  run.observe('claude — the union', claudeArm.fired)

  run.require(
    'THE CONTROL — the instrument can write at all (UserPromptSubmit on claude)',
    claudeArm.fired.includes('UserPromptSubmit'),
    'not one line reached any `.hit` file on the claude arm, UserPromptSubmit included. That is an instrument '
    + 'failure — an unwritable directory, a hook layer that never loaded the file — and 32 zeros taken from it '
    + 'would be a reading about this case, not about the product',
  )

  let piArm: ArmReading | undefined
  if (pi) {
    piArm = await driveArm(run, session, pi, hits)
    run.observe('pi (THE ROW\'S OWN CONTROL) — what fired, by phase', piArm.phases)
    run.observe('pi — the union', piArm.fired)
  } else {
    run.observe('pi', { note: 'no pi card in this profile — the row\'s first named control is UNAVAILABLE, not negative' })
  }

  // The three-way split the row's verdicts need. `not-provoked` is every matrix
  // event neither arm reached, and it is deliberately NOT scored as a silence.
  const provoked = new Set([...claudeArm.fired, ...(piArm?.fired ?? [])])
  const claudeOnly = claudeArm.fired.filter(event => !(piArm?.fired ?? []).includes(event))
  const piOnly = (piArm?.fired ?? []).filter(event => !claudeArm.fired.includes(event))
  const neither = matrix.events.filter(event => !provoked.has(event))
  run.observe('the split', {
    both: claudeArm.fired.filter(event => (piArm?.fired ?? []).includes(event)),
    claudeOnly,
    piOnly,
    notProvokedByEitherArm: neither,
  })

  run.check(
    'D1.134 — the claude column carries OBSERVED firings for the events this run provokes',
    claudeArm.fired.length > 0,
    `claude fired ${claudeArm.fired.length} of the matrix's ${matrix.events.length} events: `
    + `${JSON.stringify(claudeArm.fired)}. The rest are either unprovoked by this run's four moments or silent, `
    + 'and the split observation above says which',
  )
  run.check(
    'D1.134 — the events Pi fires and claude does not are named, which is the row\'s own control',
    piArm !== undefined,
    piArm
      ? `pi fired ${JSON.stringify(piArm.fired)}; claude-only ${JSON.stringify(claudeOnly)}; `
        + `pi-only ${JSON.stringify(piOnly)}. A pi-only event is a runtime difference on this fork's own hook layer`
      : 'no pi card, so the row\'s first named control could not be taken in this run',
  )
  run.check(
    'D1.134 — registration is read beside firing, so a zero cannot be mistaken for an unloaded hook',
    claudeArm.registered.available,
    `/hooks ${claudeArm.registered.available ? 'answered' : 'did not answer'} in the claude session; it groups `
    + `${claudeArm.registered.events.length} event(s): ${JSON.stringify(claudeArm.registered.events)}. `
    + `First 400 chars: ${JSON.stringify(claudeArm.registered.text.slice(0, 400))}`,
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
