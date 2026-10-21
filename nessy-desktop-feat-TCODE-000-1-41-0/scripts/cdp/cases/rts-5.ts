/**
 * RTS-5 — after a switch, the mode the RECORD shows is the mode ENFORCEMENT uses.
 *
 * This is blocker A1. `managed.permissionMode` is a record, not the authority:
 * enforcement reads the mode-manager singleton (`permission-manager.ts:209-210`;
 * `claude-agent.ts:1474` calls it the single source of truth). A switch that
 * assigned the field directly instead of going through `setSessionPermissionMode`
 * would leave the UI and the persisted record showing one mode while the newly
 * built agent ran under another — the state `SessionManager.ts:19288` calls
 * drift. No host-side test can see it, because the test and the UI read the same
 * field the switch wrote. Only a real gated action on the far side can.
 *
 * ## The premise this case was WRITTEN with was wrong, and the correction is the point
 *
 * The plan's row says: set `bypassPermissions` under Codex, switch to Pi, ask for
 * a shell command, "It MUST prompt." That assumed `bypassPermissions` is not a
 * mode Pi may run in. It is — Pi supports it, and `renormalizeForRuntime` only
 * rewrites a mode the TARGET disallows (`disabledPermissionModes`, empty for Pi
 * under the default managed policy). So the mode legitimately survives, and a
 * case asserting "it must prompt" would have reported a defect that is not there.
 *
 * What A1 actually needs is weaker to state and stronger to hold: **whatever
 * mode the record shows after the switch, behaviour must agree with it.** Drift
 * in either direction is the failure. A mode that survives and is enforced is a
 * pass; a record saying `acceptEdits` while shell runs unasked is the defect;
 * so is a record saying `bypassPermissions` while every action prompts.
 *
 * ## The instrument, and why it needed its own control
 *
 * The first version of this case asked for `echo RTS5-SHELL-RAN` and read "it
 * ran without prompting" as the finding. A control refuted it: a FRESH Pi
 * session in `explore` ran the same command unasked, because `echo` is
 * classified read-only and auto-approved in every mode. The command has to be
 * one the layer genuinely gates. Measured on this build, in `default`:
 *
 * | command | verdict |
 * | --- | --- |
 * | `echo …` | RAN UNASKED |
 * | `touch <file> && echo …` | **ASKED** |
 * | `printf … > <file> && cat …` | **ASKED** |
 * | `curl -s … example.com` | **ASKED** |
 *
 * So the case runs its own control arm FIRST, in the same run, on the same
 * build: a fresh Pi session in `default` must prompt for the same command. If
 * that arm does not prompt, the instrument is broken and the case reports
 * BLOCKED rather than scoring the subject arm against a detector that cannot
 * detect. An absence needs a positive control, and here it is in-run rather
 * than in a comment.
 */

import type { CdpSession } from '../lib/connect.ts'
import { main, blocked, type CaseRun } from '../lib/report.ts'
import {
  assertElectronApi,
  freshSession,
  listSessions,
  piRuntime,
  requireReadablePiRuntime,
  setPermissionMode,
  transcript,
  waitFor,
  type SessionKey,
} from '../lib/state.ts'
import { clearComposer, submitComposer, typeIntoComposer } from '../lib/composer.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { requireRuntimeTrio, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'

const ID = 'RTS-5'
const TITLE = 'After a switch, the recorded permission mode is the one enforcement actually applies'

/** Gated on this build in `default`; `echo` alone is not (see the header table). */
const GATED_MARKER = 'RTS5-GATE-DONE'
const GATED_PROMPT = `Run this exact shell command: touch /tmp/rts5-gate.txt && echo ${GATED_MARKER}`

type GateVerdict = 'asked' | 'ran-unasked' | 'neither'

/** Ask for a gated action and report which of the two things happened. */
async function probeGate(session: CdpSession, key: SessionKey, timeoutMs = 180_000): Promise<GateVerdict> {
  const before = (await transcript(session, key)).length
  await clearComposer(session)
  await typeIntoComposer(session, GATED_PROMPT)
  // NOT `sendPrompt`: a prompt IS the turn not finishing, so waiting for the
  // turn would time out and report a wait failure instead of the measurement.
  await submitComposer(session)

  // D1.287 — the probe carries the RUNTIME so `readFailed` reaches both the
  // predicate and a guard OUTSIDE the wait. An unreadable snapshot reports zero
  // pending requests, which this function would return as `neither` — and the
  // control arm then BLOCKS saying *"the instrument does not work on this
  // build"*, naming the gate for a failure of the read. The wait's own
  // `.catch()` swallows everything the probe throws, `BlockedError` included,
  // so the guard cannot live inside it.
  const settled = await waitFor(
    async () => {
      const runtime = await piRuntime(session, key)
      const ran = (await transcript(session, key)).slice(before).some(m => (m.toolResult ?? '').includes(GATED_MARKER))
      return { runtime, ran }
    },
    value => value.runtime.pendingPermissions.length > 0 || value.ran || value.runtime.readFailed === true,
    { timeoutMs, intervalMs: 2_000, label: 'a permission request, or the command running unasked' },
  ).catch(() => undefined)
  if (settled) {
    requireReadablePiRuntime(
      settled.runtime,
      'whether the gated command raised a permission card',
      'pending-permissions',
    )
  }

  if ((settled?.runtime.pendingPermissions.length ?? 0) > 0) return 'asked'
  return settled?.ran === true ? 'ran-unasked' : 'neither'
}

async function recordedMode(session: CdpSession, sessionId: string): Promise<string | undefined> {
  return (await listSessions(session)).find(s => s.id === sessionId)?.permissionMode
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  const trio = await requireRuntimeTrio(session)

  // --- the control arm, first ---------------------------------------------
  const control = await freshSession(session, `${ID} control`)
  run.require('the control got a clean session', control.fresh, control.reason ?? '')
  await switchRuntime(session, control.sessionId, trio.pi)
  await waitForConnection(session, control.sessionId, trio.pi)
  await setPermissionMode(session, control.sessionId, 'default')
  const controlMode = await waitFor(
    () => recordedMode(session, control.sessionId),
    value => value === 'default',
    { timeoutMs: 20_000, intervalMs: 500, label: 'the control session to record default' },
  ).catch(() => undefined)
  run.observe('control mode', controlMode)
  const controlVerdict = await probeGate(session, control)
  run.observe('control verdict', controlVerdict)
  if (controlVerdict !== 'asked') {
    blocked(
      `the instrument does not work on this build: a fresh Pi session in \`default\` answered `
      + `"${controlVerdict}" to a command that must be gated. Scoring the subject arm against it would `
      + 'measure nothing. Pick a command this build actually gates and re-run.',
    )
  }
  run.check('the control arm proves the gate is observable on this build', controlVerdict === 'asked')

  // --- the subject arm -----------------------------------------------------
  const key = await freshSession(session, `${ID} bypass then switch`)
  run.require('the subject got a clean session', key.fresh, key.reason ?? '')

  await switchRuntime(session, key.sessionId, trio.codex)
  run.require(
    'the subject starts on codex',
    (await waitForConnection(session, key.sessionId, trio.codex)) === trio.codex,
    trio.codex,
  )
  await setPermissionMode(session, key.sessionId, 'bypassPermissions')
  const beforeMode = await waitFor(
    () => recordedMode(session, key.sessionId),
    value => value === 'bypassPermissions',
    { timeoutMs: 20_000, intervalMs: 500, label: 'the session to record bypassPermissions' },
  ).catch(() => undefined)
  run.require(
    'the subject really is on bypassPermissions before the switch — the premise of the row',
    beforeMode === 'bypassPermissions',
    String(beforeMode),
  )

  const outcome = await switchRuntime(session, key.sessionId, trio.pi)
  run.observe('switch codex → pi', outcome)
  run.require('the switch was accepted', outcome.ok, outcome.error ?? '')
  run.require(
    'the subject reports the pi card',
    (await waitForConnection(session, key.sessionId, trio.pi)) === trio.pi,
    trio.pi,
  )

  // Read the record only after the switch has settled. An earlier read races
  // the persist and reports `undefined`, which is not a mode and is easy to
  // mistake for one.
  const afterMode = await waitFor(
    () => recordedMode(session, key.sessionId),
    value => value !== undefined,
    { timeoutMs: 20_000, intervalMs: 500, label: 'the session to report a mode after the switch' },
  ).catch(() => undefined)
  run.observe('recorded mode after the switch', afterMode)
  run.require(
    'the session reports SOME mode after the switch — an absent mode is its own defect',
    afterMode !== undefined,
    String(afterMode),
  )

  const subjectVerdict = await probeGate(session, key)
  run.observe('subject verdict', subjectVerdict)

  // The assertion is agreement, not a fixed outcome. `bypassPermissions` is a
  // mode Pi supports, so surviving the switch is legitimate; what must never
  // happen is the record and the behaviour disagreeing.
  const expected: GateVerdict = afterMode === 'bypassPermissions' ? 'ran-unasked' : 'asked'
  run.check(
    `the recorded mode (${afterMode}) and the behaviour agree — no drift between record and enforcement`,
    subjectVerdict === expected,
    subjectVerdict === expected
      ? `${afterMode} → ${subjectVerdict}, as it must`
      : `record says ${afterMode} but the gated command ${subjectVerdict === 'asked' ? 'PROMPTED' : 'RAN UNASKED'}`
        + ` — enforcement is on a different mode from the one the user is shown`,
  )
  run.check(
    'the gated action reached a decision at all — neither hung',
    subjectVerdict !== 'neither',
    subjectVerdict,
  )
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
