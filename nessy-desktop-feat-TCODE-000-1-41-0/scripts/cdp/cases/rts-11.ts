/**
 * RTS-11 — the `/loop` skill is offered on runtimes that cannot honour it.
 *
 * `/loop` schedules a prompt to re-run on an interval. Its scheduling tools are
 * Pi-harness tools — they live under `packages/shared/src/agent/pi-harness/`
 * (`harness-tool-descriptor.ts`, `runtime-agent-definition.ts`) and are mounted
 * with the Pi harness, not with the Claude or Codex runtime. The skill's own
 * palette entry is a plain skill listing and carries no runtime gate.
 *
 * The consequence is the failure mode the plan names: on Claude or Codex the
 * model is offered a command whose tools it does not have, so it answers about a
 * schedule it never created. Nothing errors. The user is told their loop is
 * running.
 *
 * ## What this case asserts, and what it deliberately does not
 *
 * It asserts the OFFER, read from the app's own palette, on all three runtimes
 * in ONE session that switches between them. That is the whole claim and it is
 * observable in three reads.
 *
 * It does NOT assert on what the model says after `/loop` is run off Pi. That
 * would be scoring a sentence, and a model that happens to answer "I cannot
 * schedule anything" would turn a real gap into a green row. Whether the
 * schedule actually fires is RTS-6's job, measured against turns rather than
 * prose.
 *
 * ## The control this case tried to have, and why it does not have one
 *
 * The first version read `/subtask` across the same switch as a "gated control",
 * on the assumption that a pi-only command would be filtered and `/loop` would
 * be the one that slipped through. **That instrument was wrong and the check is
 * gone.** `/subtask` is a palette COMMAND, not one of the pi-only tools; there
 * was never a reason for it to be filtered, so its behaving identically across
 * three runtimes proved nothing about whether filtering exists.
 *
 * What is left is a measurement and a source fact, and they are enough:
 *
 * - Measured here: `/loop` is offered identically on Pi, Claude and Codex.
 * - Read from source: its four scheduling tools — `CronCreate`, `CronList`,
 *   `CronDelete`, `ScheduleWakeup` — are all `visibility: 'pi-only'`
 *   (`packages/session-tools-core/src/tool-defs.ts:1161-1169`), and the comment
 *   above that block calls `visibility: 'pi-only'` **"a SECURITY constraint,
 *   not a preference"** (`:1083`).
 *
 * The CONSEQUENCE — that a loop started off Pi never fires — is not asserted
 * here. It is RTS-6's, measured against turns rather than against prose, because
 * scoring a model's sentence about what it just did is how a real gap becomes a
 * green row.
 */

import type { CdpSession } from '../lib/connect.ts'
import { main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession } from '../lib/state.ts'
import { peekPalette } from '../lib/composer.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { requireRuntimeTrio, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'

const ID = 'RTS-11'
const TITLE = 'The /loop skill is offered identically on runtimes whose scheduling tools it does not have'

/**
 * A second palette entry, read for the record only.
 *
 * Deliberately NOT called a control: `/subtask` is a palette command, not one
 * of the `visibility: 'pi-only'` tools, so nothing says it should be filtered.
 */
const PI_ONLY_PROBE = 'subtask'

/**
 * Palette entries whose COMMAND NAME is the token — not entries that merely
 * mention it.
 *
 * `peekPalette` matches a row's whole visible text, which includes the
 * description, and that made this case report a false failure on 2026-08-16:
 * `/gsd-plan-phase` is described as "Create detailed phase plan (PLAN.md) with
 * verification loop", so it counted as a `/loop` entry on every runtime. The
 * run read `claude: 1, codex: 1` and concluded the offer had NOT been
 * withdrawn — while the real `/loop` was in fact absent on both, exactly as the
 * product intends. The case was measuring the word, not the command.
 *
 * A row's text begins with the command token, so anchoring on that is the whole
 * fix. Kept as a named helper rather than an inline filter so the next reader
 * meets the reason before the regex.
 */
async function paletteFor(session: CdpSession, token: string): Promise<string[]> {
  const rows = await peekPalette(session, token).catch(() => [])
  const named = new RegExp(`^/${token}(\\s|$)`)
  return rows.filter(row => named.test(row.trim()))
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  const trio = await requireRuntimeTrio(session)

  const key = await freshSession(session, `${ID} loop offer across runtimes`)
  run.require('the case got a clean session', key.fresh, key.reason ?? '')

  const seen: Record<string, { loop: number; probe: number }> = {}
  for (const [label, slug] of [['pi', trio.pi], ['claude', trio.claude], ['codex', trio.codex]] as const) {
    await switchRuntime(session, key.sessionId, slug)
    run.require(
      `the session is on ${slug}`,
      (await waitForConnection(session, key.sessionId, slug)) === slug,
      slug,
    )
    // The palette is rebuilt from the capability snapshot; give the switch's
    // `capabilities_changed` event a moment to land before reading it.
    await Bun.sleep(3_000)
    const loop = await paletteFor(session, 'loop')
    const probe = await paletteFor(session, PI_ONLY_PROBE)
    seen[label] = { loop: loop.length, probe: probe.length }
    run.observe(`${label}: /loop entries`, loop)
    run.observe(`${label}: /${PI_ONLY_PROBE} entries (the gated control)`, probe.length)
  }

  run.require(
    'the premise holds: /loop is offered on Pi, where its tools exist',
    (seen.pi?.loop ?? 0) > 0,
    String(seen.pi?.loop),
  )

  // The structural half, and it is stronger than the palette read: the
  // capability snapshot the composer is built from answers `slash.commandIds`
  // for each runtime. If every runtime answers `all`, the palette is not
  // "leaking" `/loop` past a filter — there is no filter, and the offer is the
  // system doing exactly what the capability says.
  const commandIds = await session.call<Record<string, unknown>>(`
    const all = await window.electronAPI.getSessions()
    const s = (all ?? []).find(x => x.id === ${JSON.stringify(key.sessionId)})
    return s && s.composerCapabilities ? s.composerCapabilities.slash : null
  `)
  // Recorded, NOT asserted — and it was asserted once, wrongly.
  //
  // `slash.commandIds: "all"` describes the NATIVE command set, which genuinely
  // is the same on every runtime. The skill half is decided elsewhere: the
  // server withholds the `loop` skill from the slash list wherever its cron
  // tools are not mounted, and the defect this row found was that the RENDERER
  // never re-asked after a mid-session switch, so the pre-switch list stayed on
  // screen. Asserting on `commandIds` claimed a defect in the capability shape
  // that was never there, and it stayed red after the real fix landed — an
  // assertion on an implementation shape rather than on what the user sees.
  run.observe('slash capability (native command set — the same on every runtime by design)', commandIds)

  // Recorded, NOT asserted. Nothing among the entries probed changed across the
  // switch — but `/subtask` was never gated, so this cannot decide whether the
  // palette has a runtime filter at all. It is here because the number is worth
  // a later reader's attention, not because it validates anything above it.
  run.observe('entries probed that differed across runtimes', {
    loop: { pi: seen.pi?.loop, claude: seen.claude?.loop, codex: seen.codex?.loop },
    [PI_ONLY_PROBE]: { pi: seen.pi?.probe, claude: seen.claude?.probe, codex: seen.codex?.probe },
  })

  run.check(
    'the /loop offer is withdrawn on the Claude runtime, whose harness has no scheduling tools',
    (seen.claude?.loop ?? 0) === 0,
    `${seen.claude?.loop} entr(y/ies) still offered`,
  )
  run.check(
    'the /loop offer is withdrawn on the Codex runtime',
    (seen.codex?.loop ?? 0) === 0,
    `${seen.codex?.loop} entr(y/ies) still offered`,
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
