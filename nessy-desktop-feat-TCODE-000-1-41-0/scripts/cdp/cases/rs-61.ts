/**
 * RS-61 (D1.95, source `P2.62`) — the background-work index survives a RESTART,
 * read from inside the app rather than off the store.
 *
 * ## The row, and the half that was still owed
 *
 * P2.62: *"the durability argument — a `running` record from a previous host
 * process staying visible — is proven by the backfill UNIT, not by a live
 * restart"*. Measure sitting 4 (packaged 1.39.0) answered the STORE half end to
 * end: a background `sleep 900` started through a Pi session, the app `kill -9`'d,
 * `<config>/sessions/.pi-processes/<handle>.json` still reading `running` after
 * the relaunch, and the shell itself still alive — so the record was TRUE and not
 * merely stale.
 *
 * What it could not take was the PRODUCT half — the restarted host SHOWING that
 * record — because on 1.39.0 the Pi harness snapshot a live chat produces was
 * rejected by its own parser after the first turn (D1.264, RS-56 3 of 9). That
 * defect is fixed on 1.40.0 (RS-56 7 of 9, release verification 2026-09-18), so
 * this case exists.
 *
 * ## The surface it reads, and why THIS one
 *
 * `window.electronAPI.listSessionScheduledWork(sessionId)` — the one read behind
 * `ActiveTasksBar` (*"ONE read (`sessions:listScheduledWork`) supplied as
 * `scheduledWork`"*), behind `useSessionScheduledWork`, and behind the `/tasks`
 * transcript row `SessionManager.runTasksSessionCommand` writes. One projection,
 * `projectSessionScheduledWork`, feeds all three, which is why the case can drive
 * one of them and speak about the user's view: a hook that listed the work, a
 * user who typed the command and a panel drawing the chips *"cannot word it three
 * ways"*, in that method's own words.
 *
 * It is deliberately NOT the store. The store half is answered; reading the JSON
 * again would re-take a measurement and still leave the product's own answer
 * unmeasured.
 *
 * ## Two phases, because a case cannot restart the app it is attached to
 *
 * Same shape as `AGT-8`, for the same reason. `NESSY_CDP_RS61_PHASE=plant` runs
 * against a live app and writes a state file; the OPERATOR then kills every app
 * process, proves the debug port free and relaunches on the SAME
 * `NESSY_CONFIG_DIR`; `NESSY_CDP_RS61_PHASE=read` runs against the new process.
 *
 * `NESSY_CDP_RS61_STATE` names the state file — the plant phase's own output, and
 * the read phase's only input. It carries no credential: a session id, a handle,
 * a pid and two timestamps.
 *
 * ## Four readings, and three of them are controls
 *
 * 1. **THE SUBJECT.** The planted record is in `listSessionScheduledWork`'s answer
 *    for the planted session, after the restart, with `status: 'running'`. Read
 *    TWICE — once cold, once after the session has been navigated to AND clicked
 *    — and satisfied by either, because "the product does not report it" and "the
 *    product reports it once you open the conversation" are different products
 *    and a single cold read cannot tell them apart.
 * 2. **The record is TRUE, not stale.** The process the record names is still
 *    running — by pid when the projection supplies one and by the record's own
 *    `command` in `ps` when it does not, which is the case today ({@link
 *    stillAlive}). Same separation sitting 4 made on the store with `pgrep 'sleep
 *    900'`. Without it, "the record says running" is equally true of a record
 *    nothing swept.
 * 3. **The read DISCRIMINATES.** A session created in the read phase, seconds old,
 *    reports NO running work through the identical call. Without it, "everything
 *    reports running" is not excluded and the subject means nothing.
 * 4. **The host really is a NEW process.** The plant phase records the app pid the
 *    RUNNER saw; the read phase is given the pid the runner sees NOW
 *    (`NESSY_CDP_RS61_HOST_PID`) and BLOCKS when they are equal. An operator who
 *    forgot to relaunch would otherwise read a record that never left memory and
 *    bank it as durability. The case cannot see the app's pid over CDP, so this
 *    one number comes from the rig — which is why it is a BLOCK on equality
 *    rather than a check on difference: a rig that cannot supply it is a rig that
 *    cannot answer the row.
 *
 * ## Why `bash_background` and a long sleep
 *
 * `bash_background` is the Pi tool whose `claudeBehaviorCounterpart` is
 * `Bash(run_in_background)` and whose permission name is `Bash`, and it is named
 * in the prompt: asked for "your background shell tool" the model reached for
 * plain `Bash` instead, which runs the sleep in the FOREGROUND and leaves the
 * turn holding it.
 *
 * 900 s so the process outlives every step here by an order of magnitude: a shell
 * that exited on its own would make the post-restart record honestly `exited` and
 * the subject unreadable.
 *
 * **And it needs a permission answerer underneath.** The first draft argued it
 * did not, because `sleep` is not in `DANGEROUS_COMMANDS` — and that list is
 * about which spellings `persistBashAlwaysAllowRule` refuses to REMEMBER, not
 * about which ones ask. Measured on the packaged 1.40.0: two cards on screen and
 * `processing: true` for the whole 240 s budget. `approvePermissionsWhile` runs
 * for the length of that one turn and its count is reported, so a run where it
 * approved nothing is visible rather than assumed.
 *
 * The plant phase REFUSES to write its state file unless a running record exists,
 * so the read phase can never be run against a plant that did not plant anything.
 *
 * ## Safety
 *
 * No credential is read, printed or written. The one process this case starts is
 * a `sleep` inside the app's own background-shell surface; the read phase prints
 * its pid and, at the end of the sitting, the operator kills it — the case does
 * not, because killing it is what would make a re-read of the same rig impossible.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { approvePermissionsWhile } from '../lib/ask-user.ts'
import { sendPrompt } from '../lib/chat.ts'
import type { CdpSession } from '../lib/connect.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { assertElectronApi, freshSession, textOfRole } from '../lib/state.ts'
import { clickAt } from '../lib/viewport.ts'
import type { CaseMeta } from '../lib/sitting.ts'

const ID = 'RS-61'
const TITLE = 'a running background record from a previous host process, read from inside the restarted app'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'D1.95',
  runtimes: ['pi'],
  credentials:
    'whatever card the profile already has — the case creates none and switches none. TWO PHASES on ONE '
    + 'NESSY_CONFIG_DIR: NESSY_CDP_RS61_PHASE=plant, then the operator kills every app process and relaunches on the '
    + 'same config dir, then NESSY_CDP_RS61_PHASE=read. Both need NESSY_CDP_RS61_STATE (the handoff file) and the read '
    + 'phase needs NESSY_CDP_RS61_HOST_PID (the pid of the app it is now talking to).',
} as const satisfies CaseMeta

/** What the plant phase hands the read phase. No credential, by construction. */
interface PlantedState {
  /** The session the background shell belongs to. */
  sessionId: string
  /** The record's own id, as `listSessionScheduledWork` reports it. */
  entryId: string
  /** The shell's pid, when the record carries one — it does not today. */
  pid: number | undefined
  /** The command the record names, which is how liveness is checked without a pid. */
  command: string | undefined
  /** The app pid the RUNNER saw while planting. */
  hostPid: number | undefined
  plantedAt: string
}

/** One row of `listSessionScheduledWork`'s projection, reduced to what is read here. */
interface WorkEntry {
  id: string
  type?: string
  status?: string
  description?: string
  /** The projection does NOT carry one — measured 2026-09-18; see {@link stillAlive}. */
  pid?: number
  /** What the shell was asked to run, which is what the record claims about. */
  command?: string
}

/** The product's own read — never the store on disk, which sitting 4 already answered. */
async function scheduledWork(session: CdpSession, sessionId: string): Promise<{ entries: WorkEntry[]; raw: unknown }> {
  const answer = await session.call<{ entries?: WorkEntry[] } | undefined>(`
    return await window.electronAPI.listSessionScheduledWork(${JSON.stringify(sessionId)})
  `)
  return { entries: answer?.entries ?? [], raw: answer }
}

/**
 * Is the process the record names still running?
 *
 * **By COMMAND and not by pid, because the projection carries no pid** —
 * measured 2026-09-18 on the packaged 1.40.0, where a planted record reads
 * `{id, type: 'shell', status: 'running', description: 'sleep 900', command:
 * 'sleep 900'}` and nothing else. A `process.kill(pid, 0)` control would
 * therefore report `unavailable` on every run, which is a control that never
 * fires; `pid` is still preferred when a future projection supplies one.
 *
 * Reading the OS here is not a detour around the product: the record is a CLAIM
 * ABOUT A PROCESS, and the only thing that can falsify it is the process. It is
 * the same separation measure sitting 4 made on the store with `pgrep 'sleep
 * 900'`.
 *
 * This process's own pid is excluded so a `ps` line for the case itself can
 * never answer for the subject.
 */
function stillAlive(pid: number | undefined, command: string | undefined): {
  alive: boolean | undefined
  how: string
  pid?: number
  command?: string
  matches?: number
} {
  if (typeof pid === 'number' && Number.isFinite(pid)) {
    try {
      process.kill(pid, 0)
      return { alive: true, how: 'pid, from the record', pid }
    } catch {
      return { alive: false, how: 'pid, from the record', pid }
    }
  }
  if (!command) return { alive: undefined, how: 'the record carries neither a pid nor a command' }
  const listing = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  if (listing.status !== 0) return { alive: undefined, how: `ps refused: ${listing.stderr?.trim() ?? ''}`, command }
  const matches = (listing.stdout ?? '').split('\n')
    .filter(line => line.includes(command))
    .filter(line => Number(line.trim().split(/\s+/)[0]) !== process.pid)
  return { alive: matches.length > 0, how: 'the command the record names, in ps', command, matches: matches.length }
}

/**
 * Navigate to a session and click its sidebar row — the two gestures a user has.
 *
 * It exists for read 2 above and for nothing else: the click is what
 * `freshSession()`'s own docblock calls the resync, and a case that only
 * dispatched the navigate event would be reading a pane that may still be
 * showing the previous session.
 */
async function openSession(session: CdpSession, sessionId: string): Promise<void> {
  await session.call(`
    window.dispatchEvent(new CustomEvent('nessy-agent-navigate', { detail: { route: 'session', sessionId: ${JSON.stringify(sessionId)} } }))
    return true
  `).catch(() => undefined)
  await Bun.sleep(3_000)
  const row = await session.call<{ found: boolean; x?: number; y?: number }>(`
    const el = document.querySelector('.session-item[data-session-id="' + ${JSON.stringify(sessionId)} + '"]')
    if (!el) return { found: false }
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return { found: false }
    return { found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  `).catch((): { found: boolean; x?: number; y?: number } => ({ found: false }))
  if (row.found && row.x !== undefined && row.y !== undefined) {
    await clickAt(session, { x: row.x, y: row.y }, 'the planted session row').catch(() => undefined)
    await Bun.sleep(5_000)
  }
}

function statePath(): string {
  const path = process.env.NESSY_CDP_RS61_STATE?.trim()
  if (!path) {
    blocked(
      'NESSY_CDP_RS61_STATE is not set. The plant phase writes it and the read phase is nothing without it: a read '
      + 'phase that invented the session id would be reading whatever session happened to be there, which is the '
      + 'contamination `freshSession()` exists to prevent.',
    )
  }
  return path
}

async function plant(run: CaseRun, session: CdpSession): Promise<void> {
  const key = await freshSession(session, `CDP ${ID} plant ${new Date().toISOString().slice(11, 19)}`)
  run.require('the plant ran in a session it created', key.fresh, key.reason ?? '')

  // One seeding turn first: a session that has never run a turn has no Pi session
  // file, and the background tool is not reachable in it.
  const seed = await sendPrompt(session, key, 'Reply with the single word ready and nothing else.', 180_000)
  run.observe('the seeding turn', {
    answered: textOfRole(seed.added, 'assistant').join(' ').slice(0, 80) || '(none)',
  })

  // An APPROVER underneath, and it is not belt-and-braces: measured here on the
  // packaged 1.40.0, `sleep 900` through the Pi card in the mode a fresh session
  // starts in raised TWO permission cards and the turn sat at `processing: true`
  // for the whole 240 s budget with nothing to answer them. `sleep` is indeed
  // not in `DANGEROUS_COMMANDS`, and that list is about which spellings
  // `persistBashAlwaysAllowRule` refuses to remember — not about which ones ask.
  // The docblock said otherwise until this run; AGENTS.md's own trap
  // ("a dangerous Bash spelling on any card needs an answerer running or the
  // turn hangs silently") turns out to want no adjective at all.
  const approver = approvePermissionsWhile(session, key.sessionId)
  let turn
  try {
    turn = await sendPrompt(
      session,
      key,
      'Use your bash_background tool to start the command sleep 900, then tell me only the task id it returns. Leave '
      + 'it running.',
      240_000,
    )
  } finally {
    run.observe('permission cards approved while the background turn ran', await approver.stop())
  }
  run.observe('the background turn', {
    answered: textOfRole(turn.added, 'assistant').join(' ').slice(0, 200) || '(none)',
    tools: turn.added.filter(m => m.role === 'tool').map(m => m.toolName ?? m.toolDisplayName ?? '(unnamed)'),
  })

  const work = await scheduledWork(session, key.sessionId)
  run.observe('what the product reports for this session BEFORE the restart', work.entries)
  const running = work.entries.filter(entry => entry.status === 'running')
  run.require(
    'the plant produced a RUNNING record the product itself reports',
    running.length > 0,
    'the model did not start a background shell, or the product does not report it — either way there is nothing for '
    + 'the read phase to find, and writing a state file now would hand it a question it cannot answer. Re-run the '
    + 'plant; read the tool list above to see what the model did instead.',
  )

  const first = running[0] as WorkEntry
  const state: PlantedState = {
    sessionId: key.sessionId,
    entryId: first.id,
    pid: first.pid,
    command: first.command,
    hostPid: Number(process.env.NESSY_CDP_RS61_HOST_PID ?? '') || undefined,
    plantedAt: new Date().toISOString(),
  }
  writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`)
  run.observe('the state handed to the read phase', state)
  run.observe(
    'NEXT',
    'kill every app process, prove the debug port free, relaunch on the SAME NESSY_CONFIG_DIR, then run this case '
    + 'again with NESSY_CDP_RS61_PHASE=read and NESSY_CDP_RS61_HOST_PID set to the NEW app pid.',
  )
}

async function read(run: CaseRun, session: CdpSession): Promise<void> {
  const path = statePath()
  if (!existsSync(path)) {
    blocked(`no state file at ${path} — run NESSY_CDP_RS61_PHASE=plant first, on the same NESSY_CONFIG_DIR.`)
  }
  const state = JSON.parse(readFileSync(path, 'utf8')) as PlantedState
  run.observe('the planted state', state)

  // Control 4, and it BLOCKS: an operator who did not relaunch would read a
  // record that never left memory and bank it as durability.
  const hostPid = Number(process.env.NESSY_CDP_RS61_HOST_PID ?? '') || undefined
  if (hostPid === undefined) {
    blocked(
      'NESSY_CDP_RS61_HOST_PID is not set. The case cannot see the app\'s pid over CDP, and without it "the record '
      + 'survived a restart" cannot be told from "the app was never restarted" — which is the whole row.',
    )
  }
  if (state.hostPid !== undefined && hostPid === state.hostPid) {
    blocked(
      `the app pid is ${hostPid} in both phases, so this is the SAME host process and nothing has been restarted. `
      + 'Kill every app process, prove the debug port free, relaunch, and pass the new pid.',
    )
  }
  run.observe('the host process', { plantedUnder: state.hostPid, readUnder: hostPid, restarted: true })

  // TWO reads, because the obvious single one over-fits. The record could
  // plausibly be restored when the session is LOADED rather than at boot, and
  // "the product does not report it" and "the product reports it once you open
  // the conversation" are different products. So the subject is satisfied by
  // EITHER read, and both are recorded.
  const cold = await scheduledWork(session, state.sessionId)
  run.observe('read 1 — what the RESTARTED app reports before the session is opened', cold.entries)
  await openSession(session, state.sessionId)
  const opened = await scheduledWork(session, state.sessionId)
  run.observe('read 2 — and after the planted session has been navigated to AND clicked', opened.entries)
  run.observe('the planted session is really loaded', await session.call<number>(`
    return (await window.electronAPI.getSessionMessages(${JSON.stringify(state.sessionId)}))?.messages?.length ?? -1
  `).catch(() => -1))

  const work = opened.entries.length > 0 ? opened : cold
  const survivor = work.entries.find(entry => entry.id === state.entryId)
  run.check(
    'THE SUBJECT — the record planted under the previous host process is still reported by the product',
    survivor !== undefined,
    `\`listSessionScheduledWork\` carries ${state.entryId} in NEITHER read. The store half was already answered on `
    + 'the packaged 1.39.0 (measure sitting 4), so a disappearance here is the product\'s read and not the file — '
    + 'check the store on disk before writing this up, because the two answers are a much sharper finding together',
  )
  run.check(
    'and it is still RUNNING, which is the durability P2.62 asks about',
    survivor?.status === 'running',
    `the record is reported as \`${survivor?.status ?? '(absent)'}\` — a record that settles on the restart is a `
    + 'different product from one that stays visible, and P2.62\'s sentence is about the second',
  )

  // Control 2: the record is TRUE rather than unswept.
  const pid = survivor?.pid ?? state.pid
  const command = survivor?.command ?? state.command
  const liveness = stillAlive(pid, command)
  run.observe('the planted shell itself', liveness)
  const alive = liveness.alive
  run.check(
    'THE CONTROL — the process the record names is still alive, so the record is TRUE and not merely unswept',
    alive === true,
    alive === undefined
      ? 'the record names neither a pid nor a command, so "running" cannot be checked against anything and this '
        + 'reading is unavailable rather than negative'
      : 'the record reads `running` for a process that is gone — which is a STALE record, and it makes the subject '
        + 'above a statement about a sweep that did not happen rather than about durability',
  )

  // Control 3: the read discriminates.
  const fresh = await freshSession(session, `CDP ${ID} control ${new Date().toISOString().slice(11, 19)}`)
  run.check('the control ran in a session it created', fresh.fresh, fresh.reason ?? '')
  const controlWork = await scheduledWork(session, fresh.sessionId)
  run.observe('what the same call reports for a session seconds old', controlWork.entries)
  run.check(
    'THE CONTROL — a brand-new session reports NO running work through the identical call',
    controlWork.entries.filter(entry => entry.status === 'running').length === 0,
    'the same read reports running work for a session that has never run a turn, so "the planted record is reported" '
    + 'is equally true of a call that reports running work for everything',
  )
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  const phase = process.env.NESSY_CDP_RS61_PHASE?.trim()
  run.observe('phase', phase ?? '(unset)')

  const cards = await session.call<Array<{ slug: string }>>(`
    const rows = await window.electronAPI.listLlmConnections()
    return (rows ?? []).map(c => ({ slug: c.slug }))
  `)
  run.observe('the cards this profile has', cards)

  if (phase === 'plant') {
    if (cards.length === 0) {
      blocked(
        'this profile lists no LLM connection, so no turn can start a background shell. Run RS-32 first — it presses '
        + 'the onboarding\'s own one-click button.',
      )
    }
    await plant(run, session)
    return
  }
  if (phase === 'read') {
    await read(run, session)
    return
  }
  blocked(
    'NESSY_CDP_RS61_PHASE must be `plant` or `read`. A case cannot restart the app it is attached to, so the restart '
    + 'is the operator\'s step between the two — exactly as AGT-8\'s two sittings are.',
  )
}

if (import.meta.main) await main(ID, TITLE, drive)
