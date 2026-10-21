/**
 * RTS-9 — a plugin's always-on monitor stops when the session leaves Pi, and
 * starts again when it comes back.
 *
 * `Monitor` is `visibility: 'pi-only'`
 * (`packages/session-tools-core/src/tool-defs.ts:1088`), and the comment above
 * that block states the rule this row enforces: **"`visibility: 'pi-only'` is a
 * SECURITY constraint, not a preference."** A monitor is a live child process. If
 * it survived a switch it would keep running against a session whose runtime
 * never mounted the tool that governs it — nothing would stop it, and nothing
 * would show it in the panel.
 *
 * `clearRuntimeScopedSessionState` stops them
 * (`sessionMonitors.stopAll({ workspaceId, sessionId })`) and the switch reports
 * what it stopped through `capabilityDelta.stoppedMonitors`.
 *
 * ## The return leg is the point, and it is why this case is expensive
 *
 * "The process is gone" passes trivially on a build where monitors never start.
 * So the case measures a PID three times: it must exist on Pi, be gone on
 * Claude, and a **new** one must appear on returning to Pi. Without the third
 * reading the row is an absence with no positive control — the shape AGENTS.md
 * names as the one that has repeatedly produced wrong answers here.
 *
 * ## Precondition the harness will not create for itself
 *
 * A plugin bundling a `when: 'always'` monitor has to be installed. This harness
 * does not install plugins — `scripts/cdp/README.md` states the rule, and it
 * exists because a case that arranges its own environment can break the machine
 * it is measuring. So the case looks for one and reports BLOCKED, naming what to
 * install, when there is none.
 *
 * Set `NESSY_CDP_MONITOR_PLUGIN` to the plugin's logical name once installed.
 */

import type { CdpSession } from '../lib/connect.ts'
import { main, blocked, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, sessionCommand } from '../lib/state.ts'
import { ensureDarkTheme, catalogRows } from '../lib/mcp-fixture.ts'
import { requireRuntimeTrio, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'

const ID = 'RTS-9'
const TITLE = 'A plugin monitor stops when the session leaves Pi and a new one starts when it returns'

/**
 * Monitor child processes for one session, read from the OS, not from the app.
 *
 * **UNRESOLVED, and the first sitting must answer it before reading anything
 * into a zero.** `pgrep -f <sessionId>` assumes the monitor process's ARGV
 * carries the session id. That has never been confirmed live. If it does not,
 * every reading here is zero and the case reports "the monitor is gone" on the
 * Pi leg as well — which the third reading (a NEW pid on the return leg) turns
 * into a visible failure rather than a false pass, but the failure would be the
 * detector's, not the product's.
 *
 * The positive control is the FIRST reading, and when it comes back empty the
 * case now SEPARATES the two causes instead of reporting one as the other: it
 * probes again by the plugin's own name. A monitor process that exists but does
 * not carry the session id is a DETECTOR fault and blocks; no monitor process
 * at all is a product finding and fails.
 */
function pidsMatching(pattern: string): string[] {
  const proc = Bun.spawnSync(['pgrep', '-f', pattern])
  return new TextDecoder().decode(proc.stdout).split('\n').map(l => l.trim()).filter(Boolean)
}

function monitorPids(sessionId: string): string[] {
  return pidsMatching(sessionId)
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  const trio = await requireRuntimeTrio(session)

  const key = await freshSession(session, `${ID} monitor across a switch`)
  run.require('the case got a clean session', key.fresh, key.reason ?? '')

  const rows = await catalogRows(session, key.workspaceId).catch(() => [])
  const monitorish = rows.filter(r => /monitor/i.test(r.kind) || /monitor/i.test(r.logicalName))
  run.observe('capabilities that look like monitors', monitorish.map(r => `${r.logicalName}(${r.kind}/${r.state})`))

  const pinned = process.env.NESSY_CDP_MONITOR_PLUGIN?.trim()
  const chosen = pinned
    ? monitorish.find(r => r.logicalName === pinned)
    : monitorish.find(r => r.state === 'enabled' || r.state === 'active')

  if (!chosen) {
    blocked(
      'no plugin bundling a `when: \'always\'` monitor is installed in this config dir, so there is no monitor to '
      + 'watch across the switch. This harness does not install plugins for itself (scripts/cdp/README.md) — a case '
      + 'that arranges its own environment can break the machine it measures. Install one through the app\'s own '
      + 'marketplace flow, then set NESSY_CDP_MONITOR_PLUGIN to its logical name. '
      + `Capabilities seen here: ${rows.map(r => `${r.logicalName}(${r.kind})`).join(', ') || 'none'}`,
    )
  }

  // --- reading 1: on Pi ----------------------------------------------------
  await switchRuntime(session, key.sessionId, trio.pi)
  run.require(
    'the session starts on Pi',
    (await waitForConnection(session, key.sessionId, trio.pi)) === trio.pi,
    trio.pi,
  )
  // A monitor starts with the session's first turn; give it one.
  await sessionCommand(session, key.sessionId, { type: 'refreshTitle' }).catch(() => undefined)
  await Bun.sleep(15_000)
  const onPi = monitorPids(key.sessionId)
  run.observe('monitor pids on Pi', onPi)
  if (onPi.length === 0) {
    // Separate the detector from the product before calling either wrong.
    // `pgrep -f <sessionId>` has never been confirmed to match a monitor's
    // argv; `pgrep -f <pluginName>` is the second opinion.
    const byPlugin = pidsMatching(chosen!.logicalName)
    run.observe('processes matching the plugin name instead', byPlugin)
    if (byPlugin.length > 0) {
      blocked(
        `no process argv carries the session id ${key.sessionId}, but ${byPlugin.length} carries the plugin name `
        + `${chosen!.logicalName} — so a monitor IS running and this case's detector, not the product, is what came `
        + 'back empty. Read the real argv (`ps -Ao args= -p ' + byPlugin.join(',') + '`) and pin the detector to '
        + 'whatever the monitor actually carries before scoring this row.',
      )
    }
    run.require(
      'a monitor process exists on Pi — the positive control the absence below needs',
      false,
      `neither the session id nor the plugin name ${chosen!.logicalName} matches any process argv, so no monitor is `
      + 'running at all. That is the product half, not the detector half.',
    )
  }

  // --- reading 2: on Claude ------------------------------------------------
  const outcome = await switchRuntime(session, key.sessionId, trio.claude)
  run.observe('switch pi → claude', outcome)
  run.require('the switch was accepted', outcome.ok, outcome.error ?? '')
  await waitForConnection(session, key.sessionId, trio.claude)
  run.observe('capabilityDelta.stoppedMonitors', outcome.result?.capabilityDelta?.stoppedKinds ?? outcome.result?.capabilityDelta ?? null)
  await Bun.sleep(10_000)
  const onClaude = monitorPids(key.sessionId)
  run.observe('monitor pids on Claude', onClaude)
  run.check(
    'the monitor process is gone once the session leaves Pi',
    onClaude.length === 0,
    onClaude.join(', ') || 'none',
  )

  // --- reading 3: back on Pi, a NEW pid -----------------------------------
  const back = await switchRuntime(session, key.sessionId, trio.pi)
  run.require('the return switch was accepted', back.ok, back.error ?? '')
  await waitForConnection(session, key.sessionId, trio.pi)
  await Bun.sleep(15_000)
  const backOnPi = monitorPids(key.sessionId)
  run.observe('monitor pids after returning to Pi', backOnPi)
  run.check(
    'a monitor runs again on the return leg — the stop was a stop, not a permanent teardown',
    backOnPi.length > 0,
    backOnPi.join(', ') || 'none',
  )
  run.check(
    'and it is a NEW process, not the old one that never died',
    backOnPi.length > 0 && backOnPi.every(pid => !onPi.includes(pid)),
    `before ${onPi.join(',')} / after ${backOnPi.join(',')}`,
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
