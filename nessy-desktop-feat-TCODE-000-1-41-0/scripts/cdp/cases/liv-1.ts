/**
 * LIV-1 — ONE PROCESS OUTLIVES THE TURN, on the product's own route.
 *
 * This is the premise the whole live-session plan
 * (`docs/superpowers/plans/2026-08-17-claude-live-session.md`) is built on, and
 * until this case it had never been observed in the app. L0 proved it in a
 * throwaway spike with a REDUCED option set — no `settingSources`, no tools
 * preset, no system-prompt append, no MCP servers, no plugins, no user hooks —
 * and its own review recorded that "the product's own path" was an overclaim.
 * L2 built the real thing and proved it with unit rigs and fake CLIs. Four
 * consecutive tracker rows then recorded the same absence in escalating terms,
 * the last of them "four rows old now".
 *
 * ## The detector, and the three that were rejected
 *
 * `lib/claude-child.ts` carries the argument in full. In one line: the SESSION
 * ID cannot prove this, because it is persisted and replayed as `--resume=<id>`
 * on the next spawn — measured on this rig, where a FAILED turn respawned the
 * child and the new command line carried the identical `--resume`. `system/init`
 * is a per-TURN marker wearing a session-start name (L0). The application log
 * does not exist on a packaged build. What only a surviving process can carry is
 * the process: a pid whose absolute start time predates turn 1 and whose elapsed
 * time is still climbing after turn 2.
 *
 * Attribution is by CWD — the SDK runs the child in
 * `<config>/sessions/<workspaceId>/<sessionId>` — because two other things on
 * this machine match a naive process search: this developer's Claude Desktop
 * runs its own agent CLI (measured, with its cwd inside this repository), and
 * our own other sessions keep their children alive for minutes.
 *
 * ## THE CONTROL THAT MUST BE ABLE TO FAIL
 *
 * A detector that always answers "same process" would pass this case while
 * measuring nothing, so the case does not end with turn 2. It runs `/clear`
 * through the app's own palette and takes a THIRD turn. `/clear` nulls the
 * session id, and `ensureLiveSession` reuses a live child only when the turn's
 * resume anchor matches the conversation that child already holds — a turn
 * asking for no conversation "matches only a child that never had one". So the
 * product MUST respawn there, and the same instrument, in the same session,
 * must report a DIFFERENT pid. If it does not, this case fails: not because the
 * live session is broken, but because nothing here could have told the two
 * states apart.
 *
 * ## What this case deliberately does NOT claim
 *
 * That the conversation carried over. It does — but a resumed one-shot carries
 * it too, so context continuity is recorded as an observation and asserted
 * nowhere. The claim is about the process and only about the process.
 */

import { randomBytes } from 'node:crypto'

import {
  assertProcessInstrument,
  childIdentity,
  claudeChildren,
  clearConversation,
  describeChildSearch,
  echoTurn,
  etimeSeconds,
  resolveClaudeCard,
  sessionDirOf,
  waitForChildCount,
  type ClaudeChild,
} from '../lib/claude-child.ts'
import type { CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { main, type CaseRun } from '../lib/report.ts'
import { switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, transcript } from '../lib/state.ts'

const ID = 'LIV-1'
const TITLE = 'One Claude child process serves two turns of one conversation, and a forced respawn shows a different one'

/** Per-run tokens: the answer has to be attributable to THIS turn, not to the screen. */
function token(prefix: string): string {
  return `${prefix}${randomBytes(3).toString('hex').toUpperCase()}`
}

const TURN_TIMEOUT_MS = 240_000
/**
 * How long the case sits idle between turn 1 and turn 2.
 *
 * The discriminating window. Under the pre-L2 shape the child is gone within
 * ~1.5 s of the result (L0 measured the reaper lever: closing the input
 * generator killed the child in under that), so a probe here that still finds it
 * is looking at a process that outlived its turn rather than at one still
 * finishing.
 */
const IDLE_GAP_MS = 8_000

/** The child fields worth putting in a report — the command line included, abbreviated. */
function describe(child: ClaudeChild): Record<string, unknown> {
  return {
    pid: child.pid,
    startedAt: child.lstart,
    elapsed: child.etime,
    model: child.spawnModel,
    resume: child.resume ?? '(none)',
    thinking: child.spawnThinking,
    effort: child.spawnEffort,
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  run.observe('theme', await ensureDarkTheme(session))
  // Before any absence is believed: prove `ps` can see the app and `lsof` can
  // read a cwd. Without this, "no child process" is equally true of a broken
  // runtime and of a harness that cannot see processes at all.
  assertProcessInstrument(run)

  const card = await resolveClaudeCard(session, run, { caseId: ID })
  run.observe('card under test', card.slug)

  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.observe('session', { workspaceId: key.workspaceId, sessionId: key.sessionId })
  run.require('the case ran in a session it created', key.fresh,
    key.fresh ? undefined : `${key.reason} (inherited ${key.inheritedMessages} messages)`)

  const outcome = await switchRuntime(session, key.sessionId, card.slug)
  run.observe('switch onto the claude card', outcome)
  const active = await waitForConnection(session, key.sessionId, card.slug)
  run.require(`the session runs on ${card.slug}`, active === card.slug, `llmConnection=${String(active)}`)

  const dir = sessionDirOf(key)
  run.observe('the session directory children are attributed by', dir)

  // A child before the first turn would mean the cwd scoping is matching
  // something else, and every count below would be meaningless.
  const baseline = claudeChildren(dir)
  run.require('no Claude child exists for this session before its first turn', baseline.length === 0,
    JSON.stringify(baseline.map(describe)))

  // ---- turn 1 --------------------------------------------------------------
  const first = token('ALPHA')
  await echoTurn(session, run, key, 'turn 1', first, TURN_TIMEOUT_MS)

  const afterTurn1 = await waitForChildCount(dir, 1)
  run.observe('child after turn 1', afterTurn1.map(describe))
  run.require('exactly one Claude child is attributable to this session after turn 1', afterTurn1.length === 1,
    `${afterTurn1.length} matched; ${JSON.stringify(describeChildSearch(dir).ours.map(row => row.pid))} descend from the app`)
  const original = afterTurn1[0]!

  // ---- the window the old shape could not survive --------------------------
  await Bun.sleep(IDLE_GAP_MS)
  // Polled rather than sampled — see `waitForChildCount`'s note on the two
  // one-shot call sites L2 left in place. It returns at once when the count is
  // already 1, so the idle window above is not extended.
  const idle = await waitForChildCount(dir, 1, 5_000)
  run.observe(`children after ${IDLE_GAP_MS} ms idle`, idle.map(describe))
  run.check(
    `the child that answered turn 1 is STILL RUNNING ${IDLE_GAP_MS} ms after the turn settled`,
    idle.some(child => childIdentity(child) === childIdentity(original)),
    idle.length === 0
      ? 'the session has no child between turns — this is the one-process-per-message shape the plan set out to '
        + 'remove, and every later check here is void'
      : `expected ${childIdentity(original)}, found ${JSON.stringify(idle.map(childIdentity))}`,
  )
  run.check(
    'and it has been running LONGER than it had at the end of turn 1',
    idle.some(child => childIdentity(child) === childIdentity(original)
      && etimeSeconds(child.etime) > etimeSeconds(original.etime)),
    `etime ${original.etime} -> ${JSON.stringify(idle.map(child => child.etime))}`,
  )

  // ---- turn 2 --------------------------------------------------------------
  const second = token('BETA')
  await echoTurn(session, run, key, 'turn 2', second, TURN_TIMEOUT_MS)

  const afterTurn2 = await waitForChildCount(dir, 1, 5_000)
  run.observe('children after turn 2', afterTurn2.map(describe))
  run.check(
    'THE CLAIM: the SAME process answered turn 2 — same pid, same absolute start time, older than turn 1',
    afterTurn2.length === 1 && childIdentity(afterTurn2[0]!) === childIdentity(original),
    afterTurn2.length === 1
      ? `turn 1 was answered by ${childIdentity(original)}, turn 2 by ${childIdentity(afterTurn2[0]!)}`
      : `${afterTurn2.length} children: ${JSON.stringify(afterTurn2.map(describe))}`,
  )
  // Precisely what this asserts: at none of the three samples (after turn 1,
  // mid-gap, after turn 2) did a SECOND child exist for this session. A process
  // cannot come back from the dead, so the original's presence at all three
  // with one unchanging `lstart` already proves it lived throughout; a
  // transient second child between two samples is the only thing sampling
  // could miss, and the label says sample rather than "at any point".
  run.check(
    'no second child for this session appeared at any of the three samples',
    afterTurn2.every(child => childIdentity(child) === childIdentity(original))
      && idle.every(child => childIdentity(child) === childIdentity(original))
      && afterTurn1.length === 1,
    JSON.stringify({ afterTurn1: afterTurn1.map(describe), idle: idle.map(describe), afterTurn2: afterTurn2.map(describe) }),
  )

  // Recorded, deliberately NOT asserted: a resumed one-shot carries the
  // conversation too, so continuity cannot separate the two shapes. It is here
  // because a run where the model has LOST the conversation while keeping its
  // process is worth seeing.
  const roles = (await transcript(session, key)).map(message => `${message.role}:${message.content.slice(0, 40)}`)
  run.observe('transcript so far', roles)

  // ---- THE CONTROL: the app must respawn, and the instrument must say so ----
  const cleared = await clearConversation(session, key)
  run.observe('/clear', cleared)
  run.require('the app cleared the conversation', cleared.after === 0,
    `the transcript went ${cleared.before} -> ${cleared.after} messages`)

  const third = token('GAMMA')
  await echoTurn(session, run, key, 'turn 3 (after /clear)', third, TURN_TIMEOUT_MS)

  const afterClear = await waitForChildCount(dir, 1, 5_000)
  run.observe('children after the forced respawn', afterClear.map(describe))
  const respawned = afterClear.find(child => childIdentity(child) !== childIdentity(original))
  run.check(
    'THE CONTROL: after `/clear` the same instrument reports a DIFFERENT process — so "same pid" was a measurement, '
    + 'not a constant',
    respawned !== undefined,
    respawned
      ? `${childIdentity(original)} -> ${childIdentity(respawned)}`
      : `the pid did not change (${JSON.stringify(afterClear.map(describe))}). Either the app no longer respawns on a `
        + 'cleared resume anchor, or this detector cannot distinguish the two states — and in both readings the '
        + 'positive result above is unproven.',
  )
  run.check(
    'the child that served turns 1 and 2 is gone',
    !afterClear.some(child => childIdentity(child) === childIdentity(original)),
    JSON.stringify(afterClear.map(describe)),
  )
  if (respawned) {
    run.observe('what the respawned child was told to resume', respawned.resume ?? '(nothing — the anchor was cleared)')
  }

  // A machine-wide read at the end, so the report carries what else was running
  // while this measured: the Claude Desktop decoy and any sibling session's
  // child both show up here and neither was counted above.
  const search = describeChildSearch(dir)
  run.observe('claude-shaped processes on the machine at the end', {
    machineWide: search.machineWide.length,
    descendingFromTheAppUnderTest: search.ours.map(row => row.pid),
    inThisSession: search.session.map(row => row.pid),
  })
  if (search.machineWide.length === search.ours.length) {
    // Not a failure — just worth knowing that the ancestry filter had nothing to
    // exclude on this run, so its value is untested here.
    run.observe('ancestry filter', 'nothing to exclude on this run: every claude-shaped process was ours')
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}

export const meta = { id: ID, title: TITLE }
