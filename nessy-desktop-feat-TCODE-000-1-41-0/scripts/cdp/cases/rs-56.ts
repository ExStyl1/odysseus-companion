/**
 * RS-56 (D1.260) — the INSTRUMENT the effort re-take needs, asked about itself:
 * is the Pi harness runtime snapshot readable on the packaged build at all?
 *
 * ## Why this case exists, and why it is not the row it was born inside
 *
 * D1.260 asks for AGT-5's effort readings to be re-taken with a clean
 * environment, because the sitting rig used to hand the app its own
 * `CLAUDE_EFFORT`. Driven on the clean rig (measure sitting 4), AGT-5 stopped at
 * its first required check — *"the declaring subagent was spawned — no new child
 * registered for cdp-deep"* — over a turn whose own transcript carries
 * `Started background subagent task … agent_ids: agent-subagent-…-1` and a child
 * answer. The child was there; the READ was not.
 *
 * AGT-5 reads children through `lib/state.ts` `piRuntime()`, which wraps
 * `window.electronAPI.getPiHarnessRuntime` and converts a throw into
 * `{ available: false, children: [] }`. So a runtime read that FAILS and a
 * session that spawned NOTHING are the same reading, and the case reports the
 * second. That is the shape this repo calls a detector defect, and it is worth
 * its own case rather than a sentence in a narrative: every case that reads
 * `childState.children` — AGT-1, AGT-2, AGT-5 — rests on this one call.
 *
 * ## The measurement, which is a BEFORE and an AFTER in one session
 *
 * The same call, on the same session id, minutes apart:
 *
 *   BEFORE the first turn  a well-formed snapshot: `available: false`,
 *                          `unavailableReason: 'pi-runtime-not-started'`, and an
 *                          integer `barrierSeq`. THE POSITIVE CONTROL — the RPC
 *                          answers, the preload's `barrierSeq` guard passes and
 *                          `parsePiHarnessRuntimeSnapshotV1` accepts the payload,
 *                          all three on this build.
 *   AFTER one plain turn   `pi-harness-runtime-invalid`.
 *
 * Nothing about the session changed except that a Pi runtime now exists to be
 * described. The control is what makes the after-reading a finding rather than
 * "the API is not there": an unreadable API fails both reads.
 *
 * `pi-harness-runtime-invalid` is thrown in exactly two places in
 * `apps/electron/src/preload/bootstrap.ts`'s `getPiHarnessRuntime` — the
 * `barrierSeq` guard, and `parsePiHarnessRuntimeSnapshotV1`, whose every failure
 * carries that one word. This case CANNOT tell those two apart from outside
 * (the preload exposes no raw invoke; `window.__nessyRpcRaw` is the same wrapped
 * object), and it says so rather than naming one.
 *
 * ## The second parser, on the same session and the same moment
 *
 * `listPiAgentView` is a DIFFERENT payload through a DIFFERENT parser
 * (`parsePiAgentViewPageV1`, whose failure word is `pi-agent-view-invalid`). It
 * is read in BOTH arms and scored as its own before/after rather than as
 * corroboration of the first, because the two answers mean different things.
 *
 * **And the `pi-agent-view-invalid` this case reported on the packaged 1.39.0 and
 * 1.40.0 — in BOTH arms, including on a session that had never run a turn — was
 * THIS CASE'S OWN REQUEST.** Measured 2026-09-18 by WI-ap (D1.323), which set out
 * to find the field the live payload carries that the closed list rejects and
 * found that there is no such field: the call passed
 * `{ session: target, limit: 20 }`, and `PiAgentViewPageRequestV1`'s only fields
 * are `schemaVersion`, `cursor` and `limit`, so
 * `parsePiAgentViewPageRequestV1` rejected it for two independent reasons — the
 * unknown key and the missing `schemaVersion: 1` — before the manager was reached.
 * Probed directly, `{ schemaVersion: 1, limit: 20 }` and `{ schemaVersion: 1 }`
 * both PASS while the rig's payload and `{ schemaVersion: 1, session, limit: 20 }`
 * both throw. The request is fixed above; a reading taken before `86d7ed37a` is
 * about the rig.
 *
 * **The same caution as the first parser, and one step wider.**
 * `pi-agent-view-invalid` is `fail()`'s one shared word in FOUR parsers in
 * `packages/shared/src/protocol/pi-agent-view.ts`, and the REQUEST parser and the
 * RESULT parser are among them — so from outside the preload the word cannot tell
 * a rejected ANSWER from a rejected QUESTION, which is exactly how this case came
 * to report a product defect for four sittings. The paragraph above about
 * `pi-harness-runtime-invalid` naming two places reads as if only that parser had
 * the property; it is the rule here, not the exception.
 *
 * ## The user-visible half, and its own positive control
 *
 * A subagent is dispatched and the DOM is polled for `[data-testid="agent-panel"]`
 * — the panel `useAgentPanel` mounts from exactly this snapshot. The control
 * that a child EXISTED is not the panel and not the model's prose: it is the
 * child's own session record on disk, `<config>/sessions/<workspaceId>/<childId>/
 * session.jsonl` carrying `piChildRestrictions`, the file the feature itself
 * writes and the same detector RS-52 settled on. Without it, "no panel" and "no
 * child" are one reading again, which is the defect this case is about.
 *
 * ## The rig precondition
 *
 * The clean-environment block, for the ordinary reason: a lane's own shell
 * exports names this product reads (`lib/app-env.ts`). It is not that this
 * measurement is sensitive to them — it is that a sitting that stops printing
 * the control stops noticing when it is not clean.
 *
 * ## What this case creates and removes
 *
 * Two sessions it names itself and whatever child the dispatch produces, all
 * inside `NESSY_CONFIG_DIR`. It writes no configuration, reads no credential and
 * edits no stored connection.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { appEnvBlockReason, readAppEnvContamination } from '../lib/app-env.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { writableConfigDir } from '../lib/runtime-session-log.ts'
import { listConnections, runtimeOf, switchRuntime } from '../lib/runtime-switch.ts'
import { assertElectronApi, freshSession, type SessionKey } from '../lib/state.ts'
import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'
import { checkAbsence, turnAnswered } from '../lib/turn-evidence.ts'

const ID = 'RS-56'
const TITLE = 'the Pi harness runtime snapshot, read before and after the session\'s first turn'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.260',
  runtimes: ['pi'],
  credentials: 'owner: any pi card. No key is read; the case never touches the dp file.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build, a config dir created for the run, and the app launched with the `env -u` launcher in scripts/cdp/README.md.',
    '2. Create a session, bind it to a pi card, and read `getPiHarnessRuntime` BEFORE any turn. This is the control.',
    '3. Run ONE plain turn that uses no tool.',
    '4. Read `getPiHarnessRuntime` again, on the same session id. Read `listPiAgentView` in both arms too.',
    '5. Dispatch a subagent on a second session and poll the DOM for the agent panel while the child runs.',
    '6. Read the child\'s own session record off disk, which is what proves there was a child to render.',
  ],
  expected:
    'Both reads answer. A build where the BEFORE read answers and the AFTER read throws is reporting that the '
    + 'snapshot it builds for a live Pi session is rejected by its own parser — and every case that reads '
    + '`childState.children` is measuring that instead of the product.',
  detector:
    'the preload\'s own thrown error word (`pi-harness-runtime-invalid` / `pi-agent-view-invalid`) against the '
    + 'same call on the same session before the turn, plus the child\'s `session.jsonl` on disk for the panel arm. '
    + 'Never the model\'s prose, and never `piRuntime()`\'s swallowed `{ children: [] }`, which is the ambiguity '
    + 'this case exists to remove.',
  positiveControl:
    'the BEFORE read in the same session: a well-formed snapshot with `unavailableReason: "pi-runtime-not-started"` '
    + 'and an integer `barrierSeq` proves the RPC, the preload wrapper and the parser all work on this build, so the '
    + 'AFTER read is about the payload and not about the API. For the panel arm, the child record on disk proves '
    + 'there was something to render.',
  doneMeans:
    'D1.260 records whether AGT-5\'s effort readings are re-takeable on this build at all, and the snapshot surface '
    + 'carries a driven verdict rather than an assumption.',
  doNotRead:
    'Do NOT read this off `SessionManager.getPiHarnessRuntimeSnapshot` or the protocol parser. That both exist and '
    + 'agree in unit fixtures is already known; whether the payload a LIVE Pi session produces survives the parser '
    + 'is the question, and only a running app can answer it.',
} as const satisfies SittingRecipe

interface RuntimeRead {
  readonly err: string | null
  readonly available?: boolean
  readonly reason?: string
  readonly children?: number
  readonly barrierSeq?: number
  readonly viewErr: string | null
}

/**
 * Both reads, in one round trip, so the two parsers are asked at the same moment.
 *
 * The throw is CAUGHT and reported as a string rather than allowed to propagate:
 * the failure word IS the reading here, and a case that dies on it would have
 * nothing to compare against its own control.
 */
async function readRuntime(session: CdpSession, key: SessionKey): Promise<RuntimeRead> {
  return session.call<RuntimeRead>(`
    const target = { workspaceId: ${JSON.stringify(key.workspaceId)}, sessionId: ${JSON.stringify(key.sessionId)} }
    let err = null, available, reason, children, barrierSeq, viewErr = null
    try {
      const r = await window.electronAPI.getPiHarnessRuntime(target)
      available = r.snapshot.available
      reason = r.snapshot.unavailableReason
      children = (r.snapshot.childState && r.snapshot.childState.children ? r.snapshot.childState.children : []).length
      barrierSeq = r.barrierSeq
    } catch (e) { err = String(e && e.message || e) }
    try {
      // The PAGE REQUEST, and nothing else — D1.323's repair. The request type has
      // exactly schemaVersion, cursor and limit; the listing is per WORKSPACE and
      // the workspace comes from the RPC context, so there is nowhere to put a
      // session. The old payload was rejected twice over by the REQUEST parser —
      // the unknown key and the missing schemaVersion — before the manager was
      // reached at all. No backtick in this comment: it lives inside a template
      // literal and one would close it (AGENTS.md).
      await window.electronAPI.listPiAgentView({ schemaVersion: 1, limit: 20 })
    } catch (e) { viewErr = String(e && e.message || e) }
    return { err, available, reason, children, barrierSeq, viewErr }
  `)
}

/** Every session directory under the workspace, by name. */
function sessionDirs(root: string, workspaceId: string): string[] {
  try {
    return readdirSync(join(root, 'sessions', workspaceId))
  } catch {
    return []
  }
}

/**
 * The child sessions this turn created, read off disk by EXCLUSION.
 *
 * A record carrying `piChildRestrictions` is a child; a record without it is an
 * ordinary session. Same reader as RS-52, and for the same reason: it is a file
 * the feature itself writes, and it is the only surface in this case that is not
 * the one under test.
 */
function childrenCreatedBy(root: string, workspaceId: string, before: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (const id of sessionDirs(root, workspaceId)) {
    if (before.has(id)) continue
    try {
      for (const line of readFileSync(join(root, 'sessions', workspaceId, id, 'session.jsonl'), 'utf8').trim().split('\n')) {
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (parsed.piChildRestrictions !== undefined) { out.push(id); break }
      }
    } catch { /* a directory without a readable record is not a child */ }
  }
  return out
}

/** Is the agent panel mounted right now? Polled, never sampled once. */
async function waitForAgentPanel(session: CdpSession, ms: number): Promise<{ panel: boolean; rows: number }> {
  const deadline = Date.now() + ms
  let last = { panel: false, rows: 0 }
  while (Date.now() < deadline) {
    last = await session.call<{ panel: boolean; rows: number }>(`
      return {
        panel: !!document.querySelector('[data-testid="agent-panel"]'),
        rows: document.querySelectorAll('[data-testid^="agent-panel-row-"]').length,
      }
    `)
    if (last.panel) return last
    await new Promise(resolve => { setTimeout(resolve, 1_000) })
  }
  return last
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const root = writableConfigDir('reading the child session records this case dispatches')

  const appEnv = readAppEnvContamination()
  run.observe('app-env', { pids: appEnv.pids.length, present: appEnv.present, controlSeen: appEnv.controlSeen })
  const contaminated = appEnvBlockReason(appEnv, 'the runtime-snapshot read this case measures')
  if (contaminated !== undefined) blocked(contaminated)

  const cards = await listConnections(session)
  const card = cards.find(row => runtimeOf(row.providerType) === 'pi')
  if (!card) blocked('no pi card on this host — the Pi harness runtime snapshot cannot be produced without one')

  // ---- the BEFORE/AFTER pair, one session -----------------------------------
  const key = await freshSession(session, `CDP ${ID} ${new Date().toISOString().slice(11, 19)}`)
  run.check('the arm ran in a session it created', key.fresh, key.fresh ? undefined : `inherited ${key.inheritedMessages} messages`)
  const bind = await switchRuntime(session, key.sessionId, card.slug)
  run.check(`the session is bound to ${card.slug}`, bind.ok, bind.ok ? undefined : `switchRuntime refused: ${bind.error}`)

  const before = await readRuntime(session, key)
  run.observe('before-turn', before)
  run.require(
    'THE CONTROL — before the first turn the snapshot READS, so the RPC, the preload guard and the parser all work here',
    before.err === null && Number.isSafeInteger(before.barrierSeq),
    `getPiHarnessRuntime threw ${JSON.stringify(before.err)} on a session that has never run a turn; with the control `
    + 'dead the after-reading below would say nothing about the payload',
  )

  const turn = await sendPrompt(session, key, 'Reply with the single word ready. Do not use any tool.', 240_000)
  run.observe('turn', { added: 'added' in turn ? turn.added.length : 0 })

  const after = await readRuntime(session, key)
  run.observe('after-turn', after)
  // F1.504 — "still reads" is about a session a Pi runtime now describes: the
  // plain turn must have ANSWERED, or nothing changed between the two reads.
  const plainTurn = turnAnswered(turn.added)
  checkAbsence(
    run,
    'THE SUBJECT — after one plain turn the same call on the same session still READS',
    after.err === null,
    plainTurn,
    `getPiHarnessRuntime threw ${JSON.stringify(after.err)} where the same call on the same session answered `
    + `${JSON.stringify({ available: before.available, reason: before.reason, barrierSeq: before.barrierSeq })} minutes `
    + 'earlier. The only thing that changed is that a Pi runtime now exists to describe, so the payload the host '
    + 'builds for a live session is what the parser rejects. `pi-harness-runtime-invalid` is thrown by BOTH the '
    + 'preload\'s `barrierSeq` guard and `parsePiHarnessRuntimeSnapshotV1`, and this case cannot tell them apart '
    + 'from outside the preload',
  )
  // The SECOND parser is its own before/after, not a corroboration of the first,
  // and the distinction is the whole value of the arm. It failed in BOTH arms on
  // the packaged 1.39.0 and 1.40.0 — which read as "that surface does not read at
  // all" and was THE CASE'S OWN REQUEST being rejected (D1.323, repaired in
  // `readRuntime` above). The before/after shape is kept because it is what makes
  // the two readings separable at all: the same word in both arms is a surface
  // that never reads, a word only after the turn is the live payload.
  run.check(
    'the SECOND surface reads at all — `listPiAgentView` answers BEFORE the first turn',
    before.viewErr === null,
    `listPiAgentView threw ${JSON.stringify(before.viewErr)} on a session that has never run a turn, where `
    + 'getPiHarnessRuntime answered on the same session in the same round trip. This surface is unreadable on this '
    + 'build independently of the subject below, and the two must not be reported as one finding',
  )
  checkAbsence(
    run,
    '`listPiAgentView` reads after the turn too',
    after.viewErr === null,
    plainTurn,
    `listPiAgentView threw ${JSON.stringify(after.viewErr)} (before the turn: ${JSON.stringify(before.viewErr)}). `
    + 'Read this check against the one above: the same word in both arms is a surface that never reads, and a word '
    + 'only here is the live session\'s payload being rejected',
  )

  // ---- the user-visible half ------------------------------------------------
  const panelKey = await freshSession(session, `CDP ${ID} panel ${new Date().toISOString().slice(11, 19)}`)
  run.check('the panel arm ran in a session it created', panelKey.fresh, panelKey.fresh ? undefined : panelKey.reason)
  const panelBind = await switchRuntime(session, panelKey.sessionId, card.slug)
  run.check(`the panel arm is bound to ${card.slug}`, panelBind.ok, panelBind.ok ? undefined : `switchRuntime refused: ${panelBind.error}`)
  const dirsBefore = new Set(sessionDirs(root, panelKey.workspaceId))
  // Phrased to END at the dispatch, for RS-52's measured reason: asked for the
  // child's answer back, the parent spends minutes hunting a background task's
  // output and the turn measures its resourcefulness.
  await sendPrompt(
    session,
    panelKey,
    'Dispatch the scout subagent with the task "Name one file in this directory." '
    + 'Do not wait for it, do not look for its output, and do not run any other tool. '
    + 'Once you have started it, reply with the single word started.',
    300_000,
  )
  const panel = await waitForAgentPanel(session, 20_000)
  const children = childrenCreatedBy(root, panelKey.workspaceId, dirsBefore)
  run.observe('panel-arm', { panel, children })
  run.require(
    'THE CONTROL for the panel arm — a child session record really was written',
    children.length > 0,
    'no new session directory carries `piChildRestrictions`, so no child was created and the panel has nothing to '
    + 'render: this arm measures nothing either way',
  )
  run.check(
    'the agent panel mounts while a child exists',
    panel.panel,
    `no [data-testid="agent-panel"] within 20 s of a dispatch that wrote ${children.length} child record(s) to disk `
    + '— `useAgentPanel` reads the same snapshot the subject check above could not',
  )

  run.observe('verdict', {
    before: { err: before.err, reason: before.reason, barrierSeq: before.barrierSeq, viewErr: before.viewErr },
    after: { err: after.err, reason: after.reason, viewErr: after.viewErr },
    childrenOnDisk: children.length,
    panelMounted: panel.panel,
  })
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
