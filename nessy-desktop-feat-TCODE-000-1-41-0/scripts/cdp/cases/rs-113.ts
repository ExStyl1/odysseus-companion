/**
 * RS-113 (plan row UA4.12, 1.42.0 upstream adoption) - the Conductor and Generate on the shipped build: a task
 * whose nodes run on Pi, Claude Code and Codex passes outputs down its DAG, takes a forced FAIL verdict, repairs
 * the named node and its dependents and then PASSES; a run pauses and resumes; a node never runs above its
 * orchestrator's mode and a blocked node shows needs-input on the board; an agent-created spec asks for a run
 * confirmation from the tile's Play and an on-disk edit asks again; four codex nodes run at once while the app's
 * open file descriptors are counted; each background producer holds its node open until it ends; and Generate
 * authors a draft (no card, nothing saved) that is edited, adopted and run through the confirmation.
 *
 * The case content is UA4.12's "Proves" list and the sitting ASKs of UA4.1, UA4.2, UA4.3, UA4.4, UA4.5, UA4.6,
 * UA4.7, UA4.8 and UA12.77 (`work/wi16/sitting-asks.md`). One case, families selected by
 * `NESSY_CDP_RS113_ARMS` (default `D,P,M,C,F,W,G`; `R1` / `R2` are the two-pass restart and run only when named).
 *
 * ## The families, one arm each
 *
 * D.  **A DAG across three runtimes, FAIL -> repair -> PASS** (UA4.1 (a), UA4.7). Nodes `a` (Pi card) -> `b`
 *     (Claude card) -> `c` (Codex card); the orchestrator runs on the card `NESSY_CDP_RS113_ORCHESTRATOR` names
 *     (default `codex`, UA4.7's ASK). The acceptance criteria are a script: PASS only when `b`'s output carries
 *     `REPAIRED-<stamp>`, which `b` writes only on a repaired attempt (its prompt keys on the Conductor's own
 *     repair preamble); otherwise `VERDICT: FAIL — nodes=b — …`. Proven: the run completes; `a`'s token reaches
 *     `b` and `c` (`${nodes.<id>.output}`); the verdicts read FAIL naming `b`, then PASS, with exactly one FAIL;
 *     the run log spawns `a` once and `b` and `c` twice (the named node and its dependent re-run, `a` does not);
 *     every spawned child has exactly ONE `node-finished`; the children carry the nodes' titles and cards and
 *     render under the tile as SESSION-BACKED rows (a button; a synthetic `node:<id>` row carries the title too, so
 *     a title proves nothing - with a control read while `c` has no child, whose row must read synthetic; the
 *     control polls the tile until the spec fetch has landed, bounded, UA12.114); the
 *     orchestrator closes (`done`, upstream O25). `tokensUsed` and each codex child's
 *     usage are READINGS (UA4.1 (b)).
 * P.  **Pause and resume** (UA4.4 (4), host half). Two nodes `a` (`sleep 25`) -> `b`; paused while `a` runs:
 *     `runStatus` reads `paused`, `a` still finishes, `b` is NOT dispatched 10 s later; Resume dispatches `b`
 *     and the run completes, one `node-finished` per attempt.
 * M.  **The mode ceiling and needs-input** (UA4.2, UA12.77). The orchestrator is put in `default` (the card is the
 *     subject, so NOT bypass); node `a` asks for `bypassPermissions` and runs in `default`; it is asked to `touch`
 *     a scratch file and holds a permission card: its subtask row carries `[data-kanban-subtask-needs-input]`.
 *     The orchestrator is lowered to `plan`, then node `a` is switched to `auto`: it stays `plan`. The card is
 *     DENIED (the file is not created, the mark leaves the row) and node `b`, dispatched after the lowering,
 *     runs in `plan`.
 * C.  **Run confirmation from the tile's Play** (UA4.4 (1),(2),(3)). C0, the control on the same instrument: a
 *     hand-written spec (the editor's save) needs none, and its Play runs with no dialog. Then a caller chat asks for
 *     `create_board_task`; the host says `needsRunConfirmation`; the tile's Play opens the confirmation, Cancel runs
 *     nothing, Play -> Run starts the run; after it ends the host asks nothing and Play shows no confirmation (it is
 *     read: upstream disables Play once every subtask has run); an on-disk edit of `task.yaml` (one node appended)
 *     makes the host ask again for two nodes, `tasks:run` without the digest is refused `run-confirmation-required`,
 *     and Play shows the confirmation again (Cancel runs nothing). The tile does NOT see an on-disk edit by itself:
 *     the board re-reads specs only when the slug set changes, the editor closes or a task child starts or ends a
 *     turn (`KanbanBoardContainer.tsx`'s spec effect; upstream v0.13.4 the same, no `task.yaml` watcher), so the
 *     step navigates to the caller's chat and back (the board remounts and re-reads), then checks under its own
 *     name that the tile shows the new row with Play enabled before it presses Play.
 * F.  **File descriptors under four codex nodes** (UA4.1). Four independent codex nodes (`sleep 30`) with
 *     `max_parallel: 4`; the app's process tree (`pgrep` + `ps` descendants) is counted with ONE `lsof` per sample
 *     before, during and after the run. The counts are READINGS; the checks are that four nodes ran at once and
 *     that the instrument read the tree. No threshold is invented.
 * W.  **Background producers vs node completion** (UA4.8 (1)-(5)). One single-node task per arm
 *     (`NESSY_CDP_RS113_W`, default all): `claude-agent`, `claude-bash`, `codex-terminal`, `pi-subagent`,
 *     `pi-wakeup`, `pi-goal` must finish only AFTER their producer touched its marker file (and finish at all);
 *     `pi-wakeup` arms a self-paced /loop FIRST (CronCreate {dynamic: true}, then a ScheduleWakeup re-arm; the
 *     loop's iteration is the wake turn and stops the loop) - a bare ScheduleWakeup is refused by the shipped
 *     contract and the old arm measured UNMEASURED by design (UA12.156/UA12.158);
 *     `pi-monitor` no earlier than 15 s after the spawn; `codex-spawn` is RECORDED (P-UA-am-1's premise). The run
 *     log's `node-woke-after-done` count is read per arm (0 expected on every checked arm). A producer that never
 *     wrote its marker is UNMEASURED and fails (the model declined, or used a producer the host cannot see - the
 *     observed tool input says which).
 * G.  **Generate** (UA4.5, UA4.6 host half, UA4.12's last bullet). Per runtime (`NESSY_CDP_RS113_GENERATE_RUNTIMES`,
 *     default `codex,pi,claude`): `tasks:generate` acks a draft orchestrator that is listed (`taskDraft`, not
 *     hidden) but has NO tile, authors in `dontAsk` and never holds a card (`awaitingApprovalCount` stays 0),
 *     `tasks:generated` arrives within the editor's 380 s with a valid spec, and nothing is saved (`tasks:list`
 *     unchanged; the draft's folder unchanged at depth 2). The spec is then EDITED (retitled, `defaults.permissionMode:
 *     default`) and saved with the draft's id: it is adopted in place (one tile, the editor's mode), the host asks for
 *     a run confirmation (an adoption records nothing), and the tile's Play -> Run starts it (then Stop).
 * R1/R2. **A restart** (UA4.3 (1)-(3), UA4.4 (4) relaunch). R1 starts two runs whose `b` sleeps 120 s, writes
 *     `scripts/cdp/tmp/rs-113-restart.json` and BLOCKS: quit the app, relaunch it with the same launcher, run
 *     `NESSY_CDP_RS113_ARMS=R2`. R2: both runs read `interrupted`, never `running`; the first task's `task.yaml`
 *     is edited (b's prompt and a new node) and resumed: `b` re-runs in a NEW child with the ORIGINAL prompt, no
 *     new node joins the run, the abandoned child sits in `todo`; the second is stopped: `stopped`.
 *
 * Not here (manual add-ons in the ASK): the Results tab's on-screen controls and the dark sweep of the confirmation
 * and the Results / Generate panes (UA4.4 (3),(4),(7), UA4.6 (5)), the editor's Generate tab driven by hand and its
 * discard on close, and UA4.2 (1)'s editor hints.
 *
 * ## Detectors
 *
 * The host's own records: `tasks:get` / `tasks:getResults` / `tasks:list`, `getSessions` (mode, card, column,
 * `awaitingApprovalCount`, `taskDraft`), the run log `<config>/workspaces/<id>/tasks/<slug>/runs/<run>/run-log.jsonl`
 * (`TaskRunner`'s append-only record), marker files' mtimes, `lsof`; on screen only the tile, its Play, the
 * confirmation dialog and the subtask row's needs-input mark (`data-kanban-*` hooks, the locale strings quoted in
 * {@link QUOTED_COPY} and pinned against the live locales by `harness.test.ts`).
 *
 * ## What it writes
 *
 * The app's session store and the `tasks/<slug>/` folders of the tasks it creates (every session it created is
 * deleted in a `finally`, a folder left behind through `tasks:delete`), one node appended to the `task.yaml` of a
 * task it created (C, R2 - the on-disk edit is the subject), and marker files under one scratch
 * directory in the OS temp dir (removed in the `finally`). R1 leaves its two tasks and a state file for R2.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GENERATE_CLIENT_TIMEOUT_MS, GENERATE_PERMISSION_MODE } from '../../../packages/shared/src/tasks/generate-limits.ts'
import { appProcessPids, configDirScope } from '../lib/app-env.ts'
import { sendPrompt } from '../lib/chat.ts'
import { focusWindow, type CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { ensureNoCard, readCard } from '../lib/permission-card.ts'
import { BlockedError, blocked, main, type CaseRun } from '../lib/report.ts'
import { listConnections, resolveConfigDir, runtimeOf, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import {
  assertElectronApi, ensureSessionName, freshSession, setPermissionMode, transcript, waitFor,
  type SessionKey, type TranscriptMessage,
} from '../lib/state.ts'
import { turnReply, turnRowsSince } from '../lib/turn-evidence.ts'
import { clickSelector } from '../lib/viewport.ts'
import type { CaseMeta, SittingRuntime } from '../lib/sitting.ts'
import { parseCreateResult } from './rs-111.ts'

const ID = 'RS-113'
const TITLE = 'Conductor and Generate: a Pi/Claude/Codex DAG passes outputs, FAILs, repairs and PASSes; pause/resume; the mode ceiling and needs-input; the run confirmation from Play; fds under four codex nodes; background producers hold a node; Generate drafts, adopts and runs'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UA4.12',
  runtimes: ['pi', 'claude', 'codex'],
  credentials:
    'owner: one card per runtime that answers a turn (a `pi` card, a `claude-runtime` card, a `codex-runtime` card), '
    + 'already signed in, named in the run notes. No key, token or credential file is read. The workspace keeps its '
    + 'default statuses; the app was started with the env -u launcher and NESSY_CONFIG_DIR exported to this process '
    + '(F reads the app\'s process tree by it).',
} as const satisfies CaseMeta

/** The on-screen strings this case matches, per locale (pinned against the live locales by `harness.test.ts`). */
export const QUOTED_COPY = {
  'kanban.runSubtasks': { en: 'Run subtasks', ru: 'Запустить подзадачи' },
  'tasks.runConfirm.title': { en: 'Run this task?', ru: 'Запустить эту задачу?' },
  'tasks.runConfirm.run': { en: 'Run', ru: 'Запустить' },
  'common.cancel': { en: 'Cancel', ru: 'Отмена' },
} as const

const labelsOf = (key: keyof typeof QUOTED_COPY): string[] => Object.values(QUOTED_COPY[key])

/** The host's refusal for a run whose spec digest was never confirmed (`run-controls.ts` / `rpc/tasks.ts`). */
export const RUN_CONFIRMATION_REQUIRED = 'run-confirmation-required'

const ARMS = (process.env.NESSY_CDP_RS113_ARMS ?? 'D,P,M,C,F,W,G').split(',').map(v => v.trim().toUpperCase()).filter(Boolean)
const TERMINAL = new Set(['completed', 'failed', 'stopped'])
const RESTART_STATE = new URL('../tmp/rs-113-restart.json', import.meta.url).pathname

// ---------------------------------------------------------------------------------------------------------------
// Pure scorers (pinned by scripts/cdp/rs-113-conductor-score.test.ts)
// ---------------------------------------------------------------------------------------------------------------

/** One line of `run-log.jsonl` (`packages/shared/src/tasks/storage.ts` `RunLogEntry`), read leniently. */
export interface RunLogLine {
  t?: string
  kind: string
  nodeId?: string
  sessionId?: string
  state?: string
  result?: string
  nodes?: string[]
  reason?: string
}

/** Every parseable line of a run log; a torn last line (an append in flight) is skipped, never thrown. */
export function parseRunLog(text: string): RunLogLine[] {
  const out: RunLogLine[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as RunLogLine
      if (value && typeof value.kind === 'string') out.push(value)
    } catch { /* torn line */ }
  }
  return out
}

/** How many children the run spawned per node (`node-spawned`). */
export function spawnCounts(log: readonly RunLogLine[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const e of log) if (e.kind === 'node-spawned' && e.nodeId) counts[e.nodeId] = (counts[e.nodeId] ?? 0) + 1
  return counts
}

/**
 * Exactly ONE `node-finished` per spawned child (UA4.1's "exactly one node-finished or node-retry" read on the
 * log): a child with none is a lost completion, a child with two is a double settle. A `node-finished` naming a
 * child that was never spawned is a fault too.
 */
export function scoreOneFinishPerAttempt(log: readonly RunLogLine[]): { ok: boolean; detail: string } {
  const finishes = new Map<string, number>()
  const spawned: string[] = []
  for (const e of log) {
    if (e.kind === 'node-spawned' && e.sessionId) spawned.push(`${e.nodeId}:${e.sessionId}`)
    if (e.kind === 'node-finished' && e.sessionId) {
      const key = `${e.nodeId}:${e.sessionId}`
      finishes.set(key, (finishes.get(key) ?? 0) + 1)
    }
  }
  const faults = [
    ...spawned.filter(key => (finishes.get(key) ?? 0) !== 1).map(key => `${key} finished ${finishes.get(key) ?? 0}x`),
    ...[...finishes.keys()].filter(key => !spawned.includes(key)).map(key => `${key} finished but was never spawned`),
  ]
  if (spawned.length === 0) faults.push('no child was spawned')
  return { ok: faults.length === 0, detail: faults.length === 0 ? `${spawned.length} attempt(s), one finish each` : faults.join('; ') }
}

/** D's verdict sequence: one FAIL naming `node` first, the LAST one PASS, and no other FAIL. */
export function scoreVerdictSequence(
  verdicts: ReadonlyArray<{ result: string; nodes?: string[]; reason?: string }>,
  node: string,
): { ok: boolean; detail: string } {
  const fails = verdicts.filter(v => v.result === 'fail')
  const first = verdicts[0]
  const last = verdicts[verdicts.length - 1]
  const faults = [
    ...(first?.result === 'fail' && (first.nodes ?? []).includes(node) ? [] : [`the first verdict is not a FAIL naming ${node}`]),
    ...(last?.result === 'pass' ? [] : ['the last verdict is not PASS']),
    ...(fails.length === 1 ? [] : [`${fails.length} FAIL verdicts, not 1`]),
  ]
  return { ok: faults.length === 0, detail: faults.length === 0 ? JSON.stringify(verdicts) : `${faults.join('; ')} - ${JSON.stringify(verdicts)}` }
}

/** The `node-woke-after-done` lines of a log (TaskRunner header item 6). */
export function wokeAfterDone(log: readonly RunLogLine[]): RunLogLine[] {
  return log.filter(e => e.kind === 'node-woke-after-done')
}

/** A node's FIRST spawn and its first `done` finish, as epoch ms (the log's `t`). */
export function nodeTimes(log: readonly RunLogLine[], nodeId: string): { spawnedAt?: number; finishedAt?: number; finishedState?: string } {
  const at = (e: RunLogLine | undefined): number | undefined => {
    const value = e?.t ? Date.parse(e.t) : Number.NaN
    return Number.isFinite(value) ? value : undefined
  }
  const spawned = log.find(e => e.kind === 'node-spawned' && e.nodeId === nodeId)
  const finished = log.find(e => e.kind === 'node-finished' && e.nodeId === nodeId)
  return { spawnedAt: at(spawned), finishedAt: at(finished), ...(finished?.state ? { finishedState: finished.state } : {}) }
}

export type SettlementExpectation = 'after-marker' | 'min-seconds' | 'record'

export interface SettlementReading {
  expect: SettlementExpectation
  spawnedAt?: number
  finishedAt?: number
  /** The marker file's mtime - when the producer ended. */
  markerAt?: number
  minSeconds?: number
}

/** A clock-skew allowance between the run log's `t` and a file's mtime (same machine; ms rounding). */
export const SETTLEMENT_TOLERANCE_MS = 1_000

/**
 * W's verdict for one producer. The invariant is the gate's: a node is done only AFTER its producer ended, and it
 * is done at all ("not never"). The delay between the two is a READING in `detail`, never a threshold.
 */
export function scoreSettlement(r: SettlementReading): { ok: boolean; verdict: string; detail: string } {
  const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`
  if (r.spawnedAt === undefined) return { ok: false, verdict: 'not-dispatched', detail: 'the node was never spawned' }
  if (r.expect === 'record') {
    return {
      ok: true,
      verdict: 'recorded',
      detail: r.finishedAt === undefined
        ? 'not done by the deadline'
        : `done ${secs(r.finishedAt - r.spawnedAt)} after the spawn${r.markerAt !== undefined ? `, ${secs(r.finishedAt - r.markerAt)} after the marker` : ', no marker'}`,
    }
  }
  if (r.expect === 'min-seconds') {
    const min = (r.minSeconds ?? 0) * 1000
    if (r.finishedAt === undefined) return { ok: false, verdict: 'never-done', detail: 'the node was not done by the deadline' }
    const after = r.finishedAt - r.spawnedAt
    return after + SETTLEMENT_TOLERANCE_MS >= min
      ? { ok: true, verdict: 'done-after-producer', detail: `done ${secs(after)} after the spawn (producer ${secs(min)})` }
      : { ok: false, verdict: 'done-before-producer', detail: `done ${secs(after)} after the spawn, before the ${secs(min)} producer ended` }
  }
  if (r.markerAt === undefined) {
    return {
      ok: false,
      verdict: r.finishedAt === undefined ? 'unmeasured' : 'unmeasured-no-marker',
      detail: 'UNMEASURED - the producer never wrote its marker: the model did not start it, or started one the host cannot see (read the tool input)',
    }
  }
  if (r.finishedAt === undefined) return { ok: false, verdict: 'never-done', detail: `the producer ended ${secs(r.markerAt - r.spawnedAt)} after the spawn, the node was never done` }
  if (r.finishedAt + SETTLEMENT_TOLERANCE_MS < r.markerAt) {
    return { ok: false, verdict: 'done-before-producer', detail: `done ${secs(r.markerAt - r.finishedAt)} BEFORE the producer ended` }
  }
  return { ok: true, verdict: 'done-after-producer', detail: `done ${secs(r.finishedAt - r.markerAt)} after the producer ended` }
}

/** `roots` and every process below them, from `ps -A -o pid=,ppid=` text. */
export function descendantPids(psText: string, roots: readonly number[]): number[] {
  const children = new Map<number, number[]>()
  for (const line of psText.split('\n')) {
    const [pid = Number.NaN, ppid = Number.NaN] = line.trim().split(/\s+/).map(Number)
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || pid <= 0) continue
    children.set(ppid, [...(children.get(ppid) ?? []), pid])
  }
  const seen = new Set<number>()
  const queue = [...roots]
  while (queue.length > 0) {
    const pid = queue.shift()!
    if (seen.has(pid)) continue
    seen.add(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  return [...seen].sort((a, b) => a - b)
}

/** Open descriptors per pid from one `lsof -n -P -p <list>` (column 2 is the PID; the header is skipped). */
export function fdCountsByPid(lsofText: string): Record<number, number> {
  const counts: Record<number, number> = {}
  for (const line of lsofText.split('\n').slice(1)) {
    const pid = Number(line.trim().split(/\s+/)[1])
    if (Number.isFinite(pid) && pid > 0) counts[pid] = (counts[pid] ?? 0) + 1
  }
  return counts
}

/** The most nodes a run's snapshots ever showed `running` at once. */
export function maxConcurrentRunning(snapshots: ReadonlyArray<ReadonlyArray<{ state: string }>>): number {
  return snapshots.reduce((max, nodes) => Math.max(max, nodes.filter(n => n.state === 'running').length), 0)
}

/** One subtask row of a tile as D reads it: its title and whether it is a button (only a session-backed row is). */
export interface TileRowRead { title: string; interactive: boolean }

/**
 * D's "the children render under the tile": every node's row must be backed by a child session. The tile renders a
 * synthetic `node:<id>` row with the node's title for a node no announced child backs (`subtask-merge.ts`), so a
 * title alone passes even when no child nests under the tile; a session-backed row is the only one `TaskTile` gives
 * an `onClick` (`SubtaskRow` then renders it as a button).
 */
export function scoreTileRows(rows: readonly TileRowRead[], titles: readonly string[]): { ok: boolean; detail: string } {
  const verdicts = titles.map(title => {
    const mine = rows.filter(r => r.title === title)
    return { title, state: mine.length === 0 ? 'no row' : mine.some(r => r.interactive) ? 'session' : 'synthetic' }
  })
  return { ok: verdicts.every(v => v.state === 'session'), detail: verdicts.map(v => `${v.title}: ${v.state}`).join(', ') }
}

/**
 * D's control read (UA12.114): the tile's rows, polled until the board's spec fetch has LANDED - every node
 * title carries a row - bounded. A single read after `expandTile` races the fetch: the tile answers with only
 * the rows rendered so far (the merge's session-backed ones) and the control fails a node whose row was still
 * on its way - the flake this closes. When the bound expires the LAST read wins, so the control still scores
 * what the tile actually showed and can still fail - it never invents a row and never throws into the check.
 */
export async function specFetchedTileRows(
  read: () => Promise<TileRowRead[]>,
  titles: readonly string[],
  timeoutMs: number,
  intervalMs: number,
): Promise<TileRowRead[]> {
  return waitFor(read, rows => titles.every(t => rows.some(r => r.title === t)), {
    timeoutMs, intervalMs, label: 'the spec fetch (a row per node)',
  }).catch(() => read())
}

/**
 * C / R2's on-disk edit: one node appended to a `task.yaml` as `saveTaskSpec` writes it (js-yaml, `nodes` the last
 * key, a sequence indented two spaces). The bytes change, so the digest does, and the new node is a never-run row,
 * so the tile's Play is enabled again (a tile whose every subtask has run offers no Play).
 */
export function appendNodeYaml(yaml: string, node: { id: string; title: string; prompt: string }): string {
  const body = yaml.endsWith('\n') ? yaml : `${yaml}\n`
  return `${body}  - id: ${node.id}\n    title: ${JSON.stringify(node.title)}\n    prompt: ${JSON.stringify(node.prompt)}\n`
}

/** One poll of a Generate draft while it authors. */
export interface DraftSample {
  found: boolean
  taskDraft: boolean
  hidden: boolean
  permissionMode: string | null
  awaitingApprovalCount: number
  onBoard: boolean | null
}

/** G's authoring posture: listed as a draft, not hidden, never on the board, in `dontAsk`, never holding a card. */
export function scoreDraftSamples(samples: readonly DraftSample[]): { ok: boolean; detail: string } {
  const seen = samples.filter(s => s.found)
  const faults = [
    ...(seen.length > 0 ? [] : ['the draft was never listed by getSessions']),
    ...(seen.every(s => s.taskDraft) ? [] : ['a sample without taskDraft']),
    ...(seen.every(s => !s.hidden) ? [] : ['the draft was hidden']),
    ...(seen.every(s => s.permissionMode === GENERATE_PERMISSION_MODE) ? [] : [`a sample not in ${GENERATE_PERMISSION_MODE}: ${JSON.stringify([...new Set(seen.map(s => s.permissionMode))])}`]),
    ...(seen.every(s => s.awaitingApprovalCount === 0) ? [] : [`a card was held (max awaitingApprovalCount ${Math.max(...seen.map(s => s.awaitingApprovalCount))})`]),
    ...(seen.some(s => s.onBoard === true) ? ['the draft had a tile on the board'] : []),
    ...(seen.some(s => s.onBoard === false) ? [] : ['the board was never read while the draft authored']),
  ]
  return { ok: faults.length === 0, detail: faults.length === 0 ? `${seen.length} sample(s)` : faults.join('; ') }
}

/** G's edit before adoption: a new title and the editor's mode; the nodes are the draft's. */
export function editGeneratedSpec(spec: Record<string, unknown>, suffix: string, mode: string): Record<string, unknown> {
  const defaults = typeof spec.defaults === 'object' && spec.defaults !== null ? spec.defaults as Record<string, unknown> : {}
  return { ...spec, title: `${String(spec.title ?? 'Generated task')} ${suffix}`, defaults: { ...defaults, permissionMode: mode } }
}

/** Names whose mtime changed, appeared or disappeared between two folder listings (`relative path -> mtimeMs`). */
export function folderDelta(before: Readonly<Record<string, number>>, after: Readonly<Record<string, number>>): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...names].filter(name => before[name] !== after[name]).sort()
}

// ---------------------------------------------------------------------------------------------------------------
// The host, read through the renderer's own API
// ---------------------------------------------------------------------------------------------------------------

interface SessionRow {
  id: string
  found: boolean
  name: string | null
  permissionMode: string | null
  awaitingApprovalCount: number
  kanbanColumn: string | null
  sessionStatus: string | null
  isProcessing: boolean
  taskDraft: boolean
  hidden: boolean
  parentSessionId: string | null
  taskSlug: string | null
  taskNodeId: string | null
  taskRunId: string | null
  llmConnection: string | null
  workingDirectory: string | null
  tokenUsage: unknown
}

const ROW_SCRIPT = `
  const pick = s => ({
    id: s.id, found: true, name: typeof s.name === 'string' ? s.name : null,
    permissionMode: typeof s.permissionMode === 'string' ? s.permissionMode : null,
    awaitingApprovalCount: typeof s.awaitingApprovalCount === 'number' ? s.awaitingApprovalCount : 0,
    kanbanColumn: typeof s.kanbanColumn === 'string' ? s.kanbanColumn : null,
    sessionStatus: typeof s.sessionStatus === 'string' ? s.sessionStatus : null,
    isProcessing: s.isProcessing === true, taskDraft: s.taskDraft === true, hidden: s.hidden === true,
    parentSessionId: s.parentSessionId ?? null, taskSlug: s.taskSlug ?? null, taskNodeId: s.taskNodeId ?? null,
    taskRunId: s.taskRunId ?? null, llmConnection: s.llmConnection ?? null,
    workingDirectory: typeof s.workingDirectory === 'string' ? s.workingDirectory : null, tokenUsage: s.tokenUsage ?? null,
  })
`

async function sessionRows(session: CdpSession): Promise<SessionRow[]> {
  return session.call<SessionRow[]>(`${ROW_SCRIPT}
    return ((await window.electronAPI.getSessions()) ?? []).map(pick)
  `)
}

async function sessionRow(session: CdpSession, id: string): Promise<SessionRow> {
  const row = (await sessionRows(session)).find(r => r.id === id)
  return row ?? {
    id, found: false, name: null, permissionMode: null, awaitingApprovalCount: 0, kanbanColumn: null, sessionStatus: null,
    isProcessing: false, taskDraft: false, hidden: false, parentSessionId: null, taskSlug: null, taskNodeId: null,
    taskRunId: null, llmConnection: null, workingDirectory: null, tokenUsage: null,
  }
}

interface NodeState { id: string; state: string; sessionId?: string; attempt: number }
interface RunSnapshot { runId: string; status: string; nodes: NodeState[]; tokensUsed: number }
interface Results {
  runId: string | null
  runIds: string[]
  runStatus?: string
  verdicts?: Array<{ result: string; nodes?: string[]; reason?: string }>
  repair?: { used: number; max: number }
  nodes: Array<{ id: string; title: string; state: string; sessionId?: string; output?: string; wokeAfterDone?: boolean }>
}
interface GetReading { needsRunConfirmation: boolean; nodeCount: number | null; digest: string | null; run: RunSnapshot | null; error?: string }

async function createTask(session: CdpSession, workspaceId: string, spec: unknown, orchestratorSessionId?: string): Promise<{ slug: string; orchestratorSessionId: string; error?: string }> {
  return session.call(`
    try {
      const res = await window.electronAPI.createTask(${JSON.stringify(workspaceId)}, {
        yaml: ${JSON.stringify(JSON.stringify(spec, null, 2))},
        ${orchestratorSessionId ? `orchestratorSessionId: ${JSON.stringify(orchestratorSessionId)},` : ''}
      })
      return { slug: res.slug || '', orchestratorSessionId: res.orchestratorSessionId || '',
        ...(res.slug ? {} : { error: 'invalid: ' + JSON.stringify(res.validation).slice(0, 300) }) }
    } catch (e) { return { slug: '', orchestratorSessionId: '', error: String(e && e.message || e).slice(0, 300) } }
  `)
}

async function getTask(session: CdpSession, workspaceId: string, slug: string, runId?: string): Promise<GetReading> {
  return session.call(`
    try {
      const res = await window.electronAPI.getTask(${JSON.stringify(workspaceId)}, ${JSON.stringify(slug)}${runId ? `, ${JSON.stringify(runId)}` : ''})
      const c = res.runConfirmation
      return { needsRunConfirmation: res.needsRunConfirmation === true, nodeCount: c ? c.nodeCount : null,
        digest: c ? c.digest : null, run: res.run ?? null }
    } catch (e) { return { needsRunConfirmation: false, nodeCount: null, digest: null, run: null, error: String(e && e.message || e).slice(0, 300) } }
  `)
}

async function results(session: CdpSession, workspaceId: string, slug: string, runId?: string): Promise<Results> {
  return session.call(`
    try {
      return await window.electronAPI.getTaskResults(${JSON.stringify(workspaceId)}, ${JSON.stringify(slug)}${runId ? `, ${JSON.stringify(runId)}` : ''})
    } catch (e) { return { runId: null, runIds: [], nodes: [], runStatus: 'error: ' + String(e && e.message || e).slice(0, 200) } }
  `)
}

/** `tasks:run`; the snapshot, or the error the host threw (the C refusal arm reads it). */
async function runTask(session: CdpSession, workspaceId: string, slug: string, orchestratorSessionId: string, confirmedDigest?: string): Promise<{ run?: RunSnapshot; error?: string }> {
  return session.call(`
    try {
      const run = await window.electronAPI.runTask(${JSON.stringify(workspaceId)}, {
        slug: ${JSON.stringify(slug)}, orchestratorSessionId: ${JSON.stringify(orchestratorSessionId)},
        ${confirmedDigest ? `confirmedDigest: ${JSON.stringify(confirmedDigest)},` : ''}
      })
      return { run }
    } catch (e) { return { error: String(e && e.message || e).slice(0, 300) } }
  `)
}

async function runControl(session: CdpSession, verb: 'pauseTask' | 'resumeTask' | 'stopTask', workspaceId: string, slug: string, runId: string): Promise<string> {
  return session.call(`
    try { await window.electronAPI.${verb}(${JSON.stringify(workspaceId)}, ${JSON.stringify(slug)}, ${JSON.stringify(runId)}); return 'ok' }
    catch (e) { return 'error: ' + String(e && e.message || e).slice(0, 200) }
  `)
}

async function listTaskSlugs(session: CdpSession, workspaceId: string): Promise<string[]> {
  return session.call<string[]>(`return ((await window.electronAPI.listTasks(${JSON.stringify(workspaceId)})) ?? []).map(String)`)
}

async function waitRunStatus(session: CdpSession, workspaceId: string, slug: string, runId: string, accept: (status: string) => boolean, timeoutMs: number): Promise<Results> {
  return waitFor(() => results(session, workspaceId, slug, runId), r => accept(r.runStatus ?? ''), { timeoutMs, intervalMs: 3_000 })
    .catch(() => results(session, workspaceId, slug, runId))
}

function readLog(workspaceRoot: string, slug: string, runId: string): RunLogLine[] {
  const path = join(workspaceRoot, 'tasks', slug, 'runs', runId, 'run-log.jsonl')
  return existsSync(path) ? parseRunLog(readFileSync(path, 'utf8')) : []
}

// ---------------------------------------------------------------------------------------------------------------
// The board, the tile, its Play and the confirmation
// ---------------------------------------------------------------------------------------------------------------

async function openBoard(session: CdpSession): Promise<boolean> {
  await session.call<null>(`
    window.dispatchEvent(new CustomEvent('nessy-agent-navigate', { detail: { route: 'board' }, bubbles: true }))
    return null
  `)
  return waitFor(
    () => session.call<number>(`return document.querySelectorAll('[data-kanban-column]').length`),
    count => count >= 3,
    { timeoutMs: 15_000, intervalMs: 500 },
  ).then(() => true, () => false)
}

async function openSession(session: CdpSession, sessionId: string): Promise<boolean> {
  await session.call<null>(`
    window.dispatchEvent(new CustomEvent('nessy-agent-navigate', {
      detail: { route: ${JSON.stringify(`allSessions/session/${sessionId}`)} }, bubbles: true,
    }))
    return null
  `)
  return waitFor(
    () => session.call<string | null>(`
      const rows = document.querySelectorAll('.session-item[data-selected]')
      return rows.length === 1 ? rows[0].getAttribute('data-session-id') : null
    `),
    selected => selected === sessionId,
    { timeoutMs: 20_000, intervalMs: 500 },
  ).then(() => true, () => false)
}

const tileSelector = (sessionId: string): string => `[data-kanban-task=${JSON.stringify(sessionId)}]`

async function tileExists(session: CdpSession, sessionId: string): Promise<boolean> {
  return session.call<boolean>(`return document.querySelector(${JSON.stringify(tileSelector(sessionId))}) !== null`)
}

/** Mark one element for {@link clickSelector} (a real mouse click; Radix ignores synthetic clicks). */
async function markAndClick(session: CdpSession, findScript: string, what: string): Promise<string | null> {
  const marked = await session.call<boolean>(`
    document.querySelectorAll('[data-rs113-target]').forEach(el => el.removeAttribute('data-rs113-target'))
    const el = (() => { ${findScript} })()
    if (!el) return false
    el.setAttribute('data-rs113-target', 'x')
    return true
  `)
  if (!marked) return `${what}: not found`
  try {
    await clickSelector(session, '[data-rs113-target="x"]')
    return null
  } catch (error) {
    return `${what}: ${String(error).slice(0, 200)}`
  }
}

/** Expand a tile's subtask list, when collapsed. UA12.151: target the toggle by its
 * `data-kanban-subtasks-toggle` hook, never `button[aria-expanded]` — the status picker's Radix
 * trigger also carries aria-expanded and precedes the toggle in the tile, so the first match opens
 * the status menu instead (SIT-D F1's row-fails all root-caused there; pinned by the board's
 * board-dom-hooks.test.tsx). */
async function expandTile(session: CdpSession, sessionId: string): Promise<void> {
  const toggleSelector = `${tileSelector(sessionId)} button[data-kanban-subtasks-toggle]`
  const expanded = await session.call<string | null>(`
    const b = document.querySelector(${JSON.stringify(toggleSelector)})
    return b ? b.getAttribute('aria-expanded') : null
  `)
  if (expanded === 'false') {
    await markAndClick(session, `return document.querySelector(${JSON.stringify(toggleSelector)})`, 'expand')
  }
}

/** The tile's subtask rows whose title is one of `titles` (see {@link scoreTileRows}). */
async function readTileRows(session: CdpSession, sessionId: string, titles: readonly string[]): Promise<TileRowRead[]> {
  return session.call<TileRowRead[]>(`
    const titles = ${JSON.stringify(titles)}
    const tile = document.querySelector(${JSON.stringify(tileSelector(sessionId))})
    if (!tile) return []
    return Array.from(tile.querySelectorAll('span'))
      .filter(el => titles.includes((el.textContent || '').trim()))
      .map(el => ({ title: (el.textContent || '').trim(), interactive: el.parentElement?.getAttribute('role') === 'button' }))
  `)
}

async function clickPlay(session: CdpSession, sessionId: string): Promise<string | null> {
  return markAndClick(session, `
    const labels = ${JSON.stringify(labelsOf('kanban.runSubtasks'))}
    const tile = document.querySelector(${JSON.stringify(tileSelector(sessionId))})
    if (!tile) return null
    return Array.from(tile.querySelectorAll('button')).find(b => labels.includes(b.getAttribute('aria-label') || '') && !b.disabled) || null
  `, 'Play')
}

interface DialogRead { open: boolean; text: string }

async function readConfirmation(session: CdpSession): Promise<DialogRead> {
  return session.call<DialogRead>(`
    const titles = ${JSON.stringify(labelsOf('tasks.runConfirm.title'))}
    const d = Array.from(document.querySelectorAll('[role="dialog"]')).find(el => titles.some(t => (el.innerText || '').includes(t)))
    return d ? { open: true, text: (d.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 600) } : { open: false, text: '' }
  `)
}

async function waitConfirmation(session: CdpSession, timeoutMs = 10_000): Promise<DialogRead> {
  return waitFor(() => readConfirmation(session), d => d.open, { timeoutMs, intervalMs: 400 }).catch(() => readConfirmation(session))
}

async function pressConfirmation(session: CdpSession, key: 'tasks.runConfirm.run' | 'common.cancel'): Promise<string | null> {
  return markAndClick(session, `
    const titles = ${JSON.stringify(labelsOf('tasks.runConfirm.title'))}
    const labels = ${JSON.stringify(labelsOf(key))}
    const d = Array.from(document.querySelectorAll('[role="dialog"]')).find(el => titles.some(t => (el.innerText || '').includes(t)))
    if (!d) return null
    return Array.from(d.querySelectorAll('button')).find(b => labels.includes((b.innerText || '').trim())) || null
  `, key)
}

// ---------------------------------------------------------------------------------------------------------------
// Shared drive context
// ---------------------------------------------------------------------------------------------------------------

interface Cards { pi?: string; claude?: string; codex?: string }

interface Ctx {
  run: CaseRun
  session: CdpSession
  workspaceId: string
  workspaceRoot: string
  cards: Cards
  stamp: string
  scratch: string
  /** Orchestrators to stop-and-delete in the finally (their children with them). */
  owned: Array<{ slug?: string; orchestratorSessionId: string; runIds: string[] }>
}

const cardFor = (ctx: Ctx, runtime: SittingRuntime): string | undefined => ctx.cards[runtime]

function unmeasuredCard(ctx: Ctx, label: string, runtime: SittingRuntime): boolean {
  if (cardFor(ctx, runtime)) return false
  ctx.run.check(`${label}: measured`, false, `UNMEASURED - no ${runtime} card on this host; the arm needs one`)
  return true
}

/** Create a task as the editor does (a human save), put its orchestrator on `card` in `mode`, and own it. */
async function prepareTask(
  ctx: Ctx,
  label: string,
  spec: Record<string, unknown>,
  card: string,
  mode: string,
): Promise<{ slug: string; orchestratorSessionId: string } | null> {
  const created = await createTask(ctx.session, ctx.workspaceId, spec)
  if (created.orchestratorSessionId) ctx.owned.push({ slug: created.slug || undefined, orchestratorSessionId: created.orchestratorSessionId, runIds: [] })
  ctx.run.observe(`${label}: tasks:create`, created)
  if (!ctx.run.check(`${label}: tasks:create returned a slug and an orchestrator`, Boolean(created.slug && created.orchestratorSessionId), created.error ?? JSON.stringify(created))) return null
  await switchRuntime(ctx.session, created.orchestratorSessionId, card)
  const on = await waitForConnection(ctx.session, created.orchestratorSessionId, card)
  await setPermissionMode(ctx.session, created.orchestratorSessionId, mode).catch(() => undefined)
  const row = await waitFor(() => sessionRow(ctx.session, created.orchestratorSessionId), r => r.permissionMode === mode, { timeoutMs: 15_000, intervalMs: 1_000 })
    .catch(() => sessionRow(ctx.session, created.orchestratorSessionId))
  if (!ctx.run.check(`${label}: the orchestrator runs on ${card} in ${mode} (read back)`, on === card && row.permissionMode === mode,
    `connection ${JSON.stringify(on ?? null)}, mode ${JSON.stringify(row.permissionMode)}`)) return null
  return { slug: created.slug, orchestratorSessionId: created.orchestratorSessionId }
}

async function startRun(ctx: Ctx, label: string, slug: string, orchestratorSessionId: string): Promise<string | null> {
  const started = await runTask(ctx.session, ctx.workspaceId, slug, orchestratorSessionId)
  const runId = started.run?.runId ?? null
  if (runId) ctx.owned.find(o => o.orchestratorSessionId === orchestratorSessionId)?.runIds.push(runId)
  ctx.run.check(`${label}: tasks:run started a run`, runId !== null, started.error ?? 'no runId')
  return runId
}

async function liveRun(ctx: Ctx, slug: string, runId: string): Promise<RunSnapshot | null> {
  return (await getTask(ctx.session, ctx.workspaceId, slug, runId)).run
}

async function waitNode(ctx: Ctx, slug: string, runId: string, nodeId: string, accept: (n: NodeState) => boolean, timeoutMs: number): Promise<NodeState | null> {
  const read = async (): Promise<NodeState | null> => (await liveRun(ctx, slug, runId))?.nodes.find(n => n.id === nodeId) ?? null
  return waitFor(read, n => n !== null && accept(n), { timeoutMs, intervalMs: 1_500 }).catch(read)
}

const stampOf = (): string => new Date().toISOString().slice(11, 19).replace(/:/g, '')

// ---------------------------------------------------------------------------------------------------------------
// D - a DAG across three runtimes: FAIL -> repair -> PASS
// ---------------------------------------------------------------------------------------------------------------

/** The FAIL line D's acceptance criteria dictate: the Conductor's own scoped form, naming `b` (pinned by the score test). */
export const DAG_FAIL_LINE = 'VERDICT: FAIL — nodes=b — b is not repaired yet'

async function driveDag(ctx: Ctx): Promise<void> {
  const { run, session } = ctx
  if (unmeasuredCard(ctx, 'D', 'pi') || unmeasuredCard(ctx, 'D', 'claude') || unmeasuredCard(ctx, 'D', 'codex')) return
  const orchestratorRuntime = (process.env.NESSY_CDP_RS113_ORCHESTRATOR ?? 'codex') as SittingRuntime
  if (unmeasuredCard(ctx, 'D orchestrator', orchestratorRuntime)) return
  const s = stampOf()
  const alpha = `ALPHA-${s}`
  const repaired = `REPAIRED-${s}`
  const spec = {
    id: `cdp-rs-113-dag-${s}`,
    title: `CDP ${ID} DAG ${s}`,
    goal: 'A scripted three-runtime check of output passing and repair.',
    acceptance_criteria:
      `This is a scripted check. Answer VERDICT: PASS only when the output of subtask "b" contains ${repaired}. `
      + `When it does not, answer exactly this verdict line: ${DAG_FAIL_LINE}`,
    max_iterations: 2,
    nodes: [
      { id: 'a', title: 'A on Pi', llmConnection: ctx.cards.pi, prompt: `Reply with exactly this text and nothing else: ${alpha}` },
      {
        id: 'b', title: 'B on Claude', llmConnection: ctx.cards.claude, depends_on: ['a'],
        prompt: 'You receive a token: ${nodes.a.output}. If this message starts with the words "The previous result was '
          + `rejected", reply with exactly the token, a space and ${repaired}. Otherwise reply with exactly the token, a `
          + `space and FIRST-${s}. Reply with that one line only.`,
      },
      { id: 'c', title: 'C on Codex', llmConnection: ctx.cards.codex, depends_on: ['b'], prompt: `Reply with exactly this one line and nothing else: \${nodes.b.output} CHARLIE-${s}` },
    ],
  }
  const task = await prepareTask(ctx, 'D', spec, cardFor(ctx, orchestratorRuntime)!, 'bypassPermissions')
  if (!task) return
  const runId = await startRun(ctx, 'D', task.slug, task.orchestratorSessionId)
  if (!runId) return
  // Read the board while the children exist (session-backed rows under the tile), then wait for the end. The
  // control on the same instrument: while b runs and c has no child yet, c's row must read synthetic.
  const titles = spec.nodes.map(n => n.title)
  const cTitle = spec.nodes[2]!.title
  await waitNode(ctx, task.slug, runId, 'b', n => n.sessionId !== undefined, 600_000)
  if (await openBoard(session)) {
    await expandTile(session, task.orchestratorSessionId)
    // UA12.114: the control reads only once the spec fetch has landed (polled, bounded) - a single read
    // after expandTile raced the fetch and could fail a row that was still rendering.
    const controlRows = await specFetchedTileRows(
      () => readTileRows(session, task.orchestratorSessionId, titles), titles, 20_000, 500)
    const cUnspawned = (await liveRun(ctx, task.slug, runId))?.nodes.find(n => n.id === 'c')?.sessionId === undefined
    if (cUnspawned) {
      run.check('D control: a node with no child yet reads as a synthetic row (the instrument can fail)',
        controlRows.some(r => r.title === cTitle) && !controlRows.some(r => r.title === cTitle && r.interactive), JSON.stringify(controlRows))
    } else {
      run.observe('D control: not taken (c was spawned before the read)', controlRows)
    }
  }
  await waitNode(ctx, task.slug, runId, 'c', n => n.sessionId !== undefined, 600_000)
  const boardOpen = await openBoard(session)
  if (boardOpen) await expandTile(session, task.orchestratorSessionId)
  const tileRows = boardOpen
    ? await waitFor(() => readTileRows(session, task.orchestratorSessionId, titles), rows => scoreTileRows(rows, titles).ok, { timeoutMs: 20_000, intervalMs: 500 })
      .catch(() => readTileRows(session, task.orchestratorSessionId, titles))
    : []
  const tileScore = scoreTileRows(tileRows, titles)
  const midTokens = (await liveRun(ctx, task.slug, runId))?.tokensUsed ?? null
  const end = await waitRunStatus(session, ctx.workspaceId, task.slug, runId, status => TERMINAL.has(status), 1_200_000)
  const log = readLog(ctx.workspaceRoot, task.slug, runId)
  const outputs = Object.fromEntries(end.nodes.map(n => [n.id, (n.output ?? '').slice(0, 300)]))
  run.observe('D: the results', { runStatus: end.runStatus, verdicts: end.verdicts, repair: end.repair, outputs })
  run.check('D: the run completed', end.runStatus === 'completed', `runStatus ${JSON.stringify(end.runStatus)}`)
  run.check('D: a\'s output reached b (${nodes.a.output})', (outputs.b ?? '').includes(alpha), JSON.stringify(outputs))
  run.check('D: b\'s repaired output reached c', (outputs.c ?? '').includes(repaired) && (outputs.c ?? '').includes(alpha), JSON.stringify(outputs))
  const verdicts = scoreVerdictSequence(end.verdicts ?? [], 'b')
  run.check('D: the verdicts read FAIL naming b, then PASS', verdicts.ok, verdicts.detail)
  const counts = spawnCounts(log)
  run.observe('D: children spawned per node (run log)', counts)
  run.check('D: the repair re-ran the named node and its dependent only (a 1, b 2, c 2)',
    counts.a === 1 && counts.b === 2 && counts.c === 2, JSON.stringify(counts))
  const finishes = scoreOneFinishPerAttempt(log)
  run.check('D: every spawned child has exactly one node-finished', finishes.ok, finishes.detail)
  const children = (await sessionRows(session)).filter(r => r.parentSessionId === task.orchestratorSessionId)
  const byNode = (node: string): SessionRow[] => children.filter(r => r.taskNodeId === node)
  const titlesOk = spec.nodes.every(n => byNode(n.id).length > 0 && byNode(n.id).every(r => r.name === n.title && r.llmConnection === n.llmConnection))
  run.observe('D: the children', children.map(r => ({ node: r.taskNodeId, name: r.name, card: r.llmConnection, column: r.kanbanColumn, tokenUsage: r.tokenUsage })))
  run.check('D: each child carries its node\'s title and card', titlesOk, JSON.stringify(children.map(r => [r.taskNodeId, r.name, r.llmConnection])))
  run.check('D: the children render under the tile with their titles (session-backed rows)', boardOpen && tileScore.ok,
    boardOpen ? tileScore.detail : 'the board did not open')
  const orchestrator = await sessionRow(session, task.orchestratorSessionId)
  run.check('D: the completed run closed the orchestrator (done, upstream O25)', orchestrator.sessionStatus === 'done',
    `sessionStatus ${JSON.stringify(orchestrator.sessionStatus)}, column ${JSON.stringify(orchestrator.kanbanColumn)}`)
  run.observe('D: tokensUsed (UA4.1 (b) reading: mid-run, then at the end)', { midRun: midTokens, end: (await liveRun(ctx, task.slug, runId))?.tokensUsed ?? null })
  run.observe('D: node-woke-after-done', wokeAfterDone(log))
}

// ---------------------------------------------------------------------------------------------------------------
// P - pause and resume
// ---------------------------------------------------------------------------------------------------------------

async function drivePause(ctx: Ctx): Promise<void> {
  const { run, session } = ctx
  const runtime = (process.env.NESSY_CDP_RS113_PAUSE_RUNTIME ?? 'claude') as SittingRuntime
  if (unmeasuredCard(ctx, 'P', runtime)) return
  const s = stampOf()
  const spec = {
    id: `cdp-rs-113-pause-${s}`,
    title: `CDP ${ID} pause ${s}`,
    goal: 'A scripted pause check.',
    acceptance_criteria: 'This is a scripted check. Answer exactly: VERDICT: PASS',
    nodes: [
      { id: 'a', title: 'Slow A', prompt: `Run the shell command \`sleep 25\` and wait for it to finish, then reply with exactly PAUSE-A-${s}.` },
      { id: 'b', title: 'Then B', depends_on: ['a'], prompt: `Reply with exactly PAUSE-B-${s}.` },
    ],
  }
  const task = await prepareTask(ctx, 'P', spec, cardFor(ctx, runtime)!, 'bypassPermissions')
  if (!task) return
  const runId = await startRun(ctx, 'P', task.slug, task.orchestratorSessionId)
  if (!runId) return
  const a = await waitNode(ctx, task.slug, runId, 'a', n => n.state === 'running' && n.sessionId !== undefined, 120_000)
  run.require('P: node a is running', a?.state === 'running', JSON.stringify(a))
  run.observe('P: pause', await runControl(session, 'pauseTask', ctx.workspaceId, task.slug, runId))
  const paused = await results(session, ctx.workspaceId, task.slug, runId)
  run.check('P: the run reads paused', paused.runStatus === 'paused', `runStatus ${JSON.stringify(paused.runStatus)}`)
  const aDone = await waitNode(ctx, task.slug, runId, 'a', n => n.state === 'done', 240_000)
  run.check('P: a running child still finishes while paused', aDone?.state === 'done', JSON.stringify(aDone))
  await Bun.sleep(10_000)
  const held = await liveRun(ctx, task.slug, runId)
  const bHeld = held?.nodes.find(n => n.id === 'b')
  const spawnedB = spawnCounts(readLog(ctx.workspaceRoot, task.slug, runId)).b ?? 0
  run.check('P: a paused run dispatches nothing (b pending 10 s after a finished, never spawned)',
    held?.status === 'paused' && bHeld?.state === 'pending' && spawnedB === 0, JSON.stringify({ status: held?.status, b: bHeld, spawnedB }))
  run.observe('P: resume', await runControl(session, 'resumeTask', ctx.workspaceId, task.slug, runId))
  const end = await waitRunStatus(session, ctx.workspaceId, task.slug, runId, status => TERMINAL.has(status), 600_000)
  const log = readLog(ctx.workspaceRoot, task.slug, runId)
  run.check('P: Resume dispatched b and the run completed', end.runStatus === 'completed' && (spawnCounts(log).b ?? 0) === 1,
    JSON.stringify({ runStatus: end.runStatus, spawned: spawnCounts(log) }))
  const finishes = scoreOneFinishPerAttempt(log)
  run.check('P: one node-finished per attempt', finishes.ok, finishes.detail)
}

// ---------------------------------------------------------------------------------------------------------------
// M - the mode ceiling and needs-input on a blocked node
// ---------------------------------------------------------------------------------------------------------------

async function readSubtaskMark(session: CdpSession, orchestratorSessionId: string): Promise<{ count: number; labels: string[] }> {
  return session.call(`
    const tile = document.querySelector(${JSON.stringify(tileSelector(orchestratorSessionId))})
    const marks = tile ? Array.from(tile.querySelectorAll('[data-kanban-subtask-needs-input]')) : []
    return { count: marks.length, labels: marks.map(m => m.getAttribute('aria-label') || '') }
  `)
}

async function drivePosture(ctx: Ctx): Promise<void> {
  const { run, session } = ctx
  const runtime = (process.env.NESSY_CDP_RS113_POSTURE_RUNTIME ?? 'claude') as SittingRuntime
  if (unmeasuredCard(ctx, 'M', runtime)) return
  const s = stampOf()
  const probe = join(ctx.scratch, `posture-${s}.txt`)
  const spec = {
    id: `cdp-rs-113-posture-${s}`,
    title: `CDP ${ID} posture ${s}`,
    goal: 'A scripted mode-ceiling check.',
    acceptance_criteria: 'This is a scripted check. Answer exactly: VERDICT: PASS',
    nodes: [
      {
        id: 'a', title: 'Blocked A', permissionMode: 'bypassPermissions',
        prompt: `Use your shell tool to run exactly this command: touch ${probe}\nAfter the command, reply with exactly POSTURE-A-${s}.`,
      },
      { id: 'b', title: 'Capped B', depends_on: ['a'], prompt: `Reply with exactly POSTURE-B-${s}.` },
    ],
  }
  const task = await prepareTask(ctx, 'M', spec, cardFor(ctx, runtime)!, 'default')
  if (!task) return
  const runId = await startRun(ctx, 'M', task.slug, task.orchestratorSessionId)
  if (!runId) return
  const a = await waitNode(ctx, task.slug, runId, 'a', n => n.sessionId !== undefined, 120_000)
  const childA = a?.sessionId
  run.require('M: node a was dispatched', childA !== undefined, JSON.stringify(a))
  const aRow = await waitFor(() => sessionRow(session, childA!), r => r.found && r.permissionMode !== null, { timeoutMs: 20_000, intervalMs: 1_000 })
    .catch(() => sessionRow(session, childA!))
  run.check('M: a node asking for bypassPermissions under a default orchestrator runs in default', aRow.permissionMode === 'default',
    `node a reads ${JSON.stringify(aRow.permissionMode)}`)
  const blocked = await waitFor(() => sessionRow(session, childA!), r => r.awaitingApprovalCount >= 1, { timeoutMs: 240_000, intervalMs: 2_000 })
    .catch(() => sessionRow(session, childA!))
  if (!run.check('M: node a holds a permission card (needs input)', blocked.awaitingApprovalCount >= 1,
    'UNMEASURED - no card within 240 s: the model did not run the command, or the command raised none (read node a\'s chat)')) {
    await runControl(session, 'stopTask', ctx.workspaceId, task.slug, runId)
    return
  }
  const boardOpen = await openBoard(session)
  if (boardOpen) await expandTile(session, task.orchestratorSessionId)
  const mark = await waitFor(() => readSubtaskMark(session, task.orchestratorSessionId), m => m.count >= 1, { timeoutMs: 20_000, intervalMs: 500 })
    .catch(() => readSubtaskMark(session, task.orchestratorSessionId))
  run.observe('M: the subtask row\'s needs-input mark', mark)
  run.check('M: the blocked node\'s subtask row shows needs-input (UA12.77)', boardOpen && mark.count >= 1, boardOpen ? JSON.stringify(mark) : 'the board did not open')

  // Lower the orchestrator, then try to raise the node above it.
  await setPermissionMode(session, task.orchestratorSessionId, 'plan').catch(() => undefined)
  const lowered = await waitFor(() => sessionRow(session, task.orchestratorSessionId), r => r.permissionMode === 'plan', { timeoutMs: 15_000, intervalMs: 1_000 })
    .catch(() => sessionRow(session, task.orchestratorSessionId))
  run.require('M: the orchestrator was lowered to plan (read back)', lowered.permissionMode === 'plan', JSON.stringify(lowered.permissionMode))
  await setPermissionMode(session, childA!, 'auto').catch(() => undefined)
  await Bun.sleep(3_000)
  const raised = await sessionRow(session, childA!)
  run.check('M: switching node a to auto under a plan orchestrator leaves it at plan', raised.permissionMode === 'plan',
    `node a reads ${JSON.stringify(raised.permissionMode)}`)

  // Deny the card in node a's own chat; nothing is written and the mark leaves the row.
  // A node's chat may not be a sidebar row, so the open is read by its card coming on screen, not by the selection.
  run.observe('M: node a\'s chat selected in the list', await openSession(session, childA!))
  await focusWindow(session)
  const onScreen = await waitFor(() => readCard(session), card => card.present, { timeoutMs: 20_000, intervalMs: 500 }).catch(() => readCard(session))
  const leftover = onScreen.present ? await ensureNoCard(session, 'M: deny node a\'s card') : 'node a\'s card never came on screen'
  run.check('M: node a\'s card was denied', onScreen.present && leftover === null, leftover ?? '')
  const cleared = await waitFor(() => sessionRow(session, childA!), r => r.awaitingApprovalCount === 0, { timeoutMs: 30_000, intervalMs: 1_000 })
    .catch(() => sessionRow(session, childA!))
  if (await openBoard(session)) await expandTile(session, task.orchestratorSessionId)
  const markAfter = await waitFor(() => readSubtaskMark(session, task.orchestratorSessionId), m => m.count === 0, { timeoutMs: 20_000, intervalMs: 500 })
    .catch(() => readSubtaskMark(session, task.orchestratorSessionId))
  run.check('M: with the card answered, the row carries no needs-input mark', cleared.awaitingApprovalCount === 0 && markAfter.count === 0,
    JSON.stringify({ awaiting: cleared.awaitingApprovalCount, mark: markAfter }))
  run.check('M: the denied command wrote nothing', !existsSync(probe), `${probe} exists`)

  const b = await waitNode(ctx, task.slug, runId, 'b', n => n.sessionId !== undefined, 300_000)
  const bRow = b?.sessionId
    ? await waitFor(() => sessionRow(session, b.sessionId!), r => r.found && r.permissionMode !== null, { timeoutMs: 20_000, intervalMs: 1_000 }).catch(() => sessionRow(session, b.sessionId!))
    : null
  run.check('M: node b, dispatched after the lowering, runs in plan', bRow?.permissionMode === 'plan',
    b?.sessionId ? `node b reads ${JSON.stringify(bRow?.permissionMode)}` : `node b was not dispatched: ${JSON.stringify(b)}`)
  run.observe('M: stop', await runControl(session, 'stopTask', ctx.workspaceId, task.slug, runId))
}

// ---------------------------------------------------------------------------------------------------------------
// C - the run confirmation from the tile's Play
// ---------------------------------------------------------------------------------------------------------------

const isBoardTaskTool = (row: TranscriptMessage): boolean => /create_board_task/.test(`${row.toolName ?? ''} ${row.toolDisplayName ?? ''}`)

async function runIdsOf(ctx: Ctx, slug: string): Promise<string[]> {
  return (await results(ctx.session, ctx.workspaceId, slug)).runIds ?? []
}

/** Whether the tile's Play is rendered and enabled (a tile whose every subtask has run offers it disabled). */
async function playState(session: CdpSession, sessionId: string): Promise<'enabled' | 'disabled' | 'absent'> {
  return session.call(`
    const labels = ${JSON.stringify(labelsOf('kanban.runSubtasks'))}
    const tile = document.querySelector(${JSON.stringify(tileSelector(sessionId))})
    const b = tile ? Array.from(tile.querySelectorAll('button')).find(x => labels.includes(x.getAttribute('aria-label') || '')) : null
    return b ? (b.disabled ? 'disabled' : 'enabled') : 'absent'
  `)
}

/** C0, the control on the same instrument: a hand-written spec (the editor's save) runs from Play with no dialog. */
async function driveConfirmationControl(ctx: Ctx): Promise<void> {
  const { run, session } = ctx
  const runtime = (process.env.NESSY_CDP_RS113_CALLER_RUNTIME ?? 'claude') as SittingRuntime
  if (unmeasuredCard(ctx, 'C0', runtime)) return
  const s = stampOf()
  const task = await prepareTask(ctx, 'C0', {
    id: `cdp-rs-113-handwritten-${s}`, title: `CDP ${ID} hand-written ${s}`, goal: 'A hand-written task.',
    nodes: [{ id: 'main', title: 'Hand-written', prompt: `Reply with exactly HAND-${s}.` }],
  }, cardFor(ctx, runtime)!, 'bypassPermissions')
  if (!task) return
  run.check('C0: a hand-written spec needs no confirmation', !(await getTask(session, ctx.workspaceId, task.slug)).needsRunConfirmation)
  if (!run.check('C0: the board opened', await openBoard(session), 'no [data-kanban-column]')) return
  await waitFor(() => tileExists(session, task.orchestratorSessionId), Boolean, { timeoutMs: 20_000, intervalMs: 500 }).catch(() => false)
  run.observe('C0: Play', await clickPlay(session, task.orchestratorSessionId) ?? 'clicked')
  await Bun.sleep(5_000)
  const dialog = await readConfirmation(session)
  const ids = await waitFor(() => runIdsOf(ctx, task.slug), x => x.length === 1, { timeoutMs: 30_000, intervalMs: 1_000 }).catch(() => runIdsOf(ctx, task.slug))
  ctx.owned.find(o => o.orchestratorSessionId === task.orchestratorSessionId)?.runIds.push(...ids)
  run.check('C0: Play on it runs with no confirmation', !dialog.open && ids.length === 1, JSON.stringify({ dialog, runIds: ids }))
  if (ids[0]) run.observe('C0: stop', await runControl(session, 'stopTask', ctx.workspaceId, task.slug, ids[0]))
}

async function driveConfirmation(ctx: Ctx, caller: SessionKey): Promise<void> {
  const { run, session } = ctx
  const s = stampOf()
  const before = (await transcript(session, caller)).length
  let added: TranscriptMessage[] = []
  try {
    added = (await sendPrompt(session, caller,
      'Please call the create_board_task tool exactly once with these arguments and nothing else: '
      + `${JSON.stringify({ title: `Confirm me ${s}`, description: `Reply with exactly the word READY-${s} and nothing else.` })}. `
      + 'Then reply with the tool\'s answer word for word.', 240_000)).added
  } catch (error) {
    run.observe('C: the send threw', String(error).slice(0, 300))
  }
  const rows = await turnRowsSince(() => transcript(session, caller), added, before)
  const created = rows.filter(isBoardTaskTool).map(r => parseCreateResult(r.toolResult)).find(v => v !== null) ?? null
  if (created) ctx.owned.push({ slug: created.slug, orchestratorSessionId: created.orchestratorSessionId, runIds: [] })
  run.observe('C: the create turn', { reply: turnReply(rows).slice(0, 300), created })
  if (!run.check('C: create_board_task created a task', created !== null,
    'UNMEASURED - no create_board_task call answered with a slug (declined-by-model, or the codex bridge was down)')) return
  const { slug, orchestratorSessionId } = created!
  const asked = await getTask(session, ctx.workspaceId, slug)
  run.check('C: the host asks for a confirmation of an agent-created spec', asked.needsRunConfirmation && asked.nodeCount === 1, JSON.stringify(asked))

  const boardOpen = await openBoard(session)
  run.require('C: the board opened', boardOpen, 'no [data-kanban-column]')
  await waitFor(() => tileExists(session, orchestratorSessionId), Boolean, { timeoutMs: 20_000, intervalMs: 500 }).catch(() => false)
  run.observe('C: Play (to cancel)', await clickPlay(session, orchestratorSessionId) ?? 'clicked')
  const shown = await waitConfirmation(session)
  run.observe('C: the confirmation', shown)
  run.check('C: Play on an agent-created spec shows the run confirmation', shown.open, 'no confirmation within 10 s')
  run.observe('C: Cancel', await pressConfirmation(session, 'common.cancel') ?? 'clicked')
  await Bun.sleep(5_000)
  run.check('C: Cancel runs nothing', (await runIdsOf(ctx, slug)).length === 0 && !(await readConfirmation(session)).open,
    JSON.stringify(await runIdsOf(ctx, slug)))

  run.observe('C: Play (to run)', await clickPlay(session, orchestratorSessionId) ?? 'clicked')
  const again = await waitConfirmation(session)
  run.observe('C: Run', again.open ? (await pressConfirmation(session, 'tasks.runConfirm.run') ?? 'clicked') : 'no confirmation to press')
  const first = await waitFor(() => runIdsOf(ctx, slug), ids => ids.length === 1, { timeoutMs: 30_000, intervalMs: 1_000 }).catch(() => runIdsOf(ctx, slug))
  ctx.owned.find(o => o.orchestratorSessionId === orchestratorSessionId)?.runIds.push(...first)
  run.check('C: Run in the confirmation starts the run', first.length === 1, JSON.stringify(first))
  const firstRun = first[0]
  if (first.length !== 1 || !firstRun) return
  const ended = await waitRunStatus(session, ctx.workspaceId, slug, firstRun, status => TERMINAL.has(status), 600_000)
  await waitFor(() => sessionRow(session, orchestratorSessionId), r => !r.isProcessing, { timeoutMs: 60_000, intervalMs: 1_000 }).catch(() => undefined)
  run.observe('C: the first run ended', ended.runStatus)

  // After the run: the host asks nothing more, and the tile offers no confirmation (every subtask has run, so
  // upstream's Play is disabled - read, not assumed; when it is enabled, a click must show no dialog).
  run.check('C: the host asks nothing once the spec was confirmed', !(await getTask(session, ctx.workspaceId, slug)).needsRunConfirmation)
  await openBoard(session)
  const play = await playState(session, orchestratorSessionId)
  let dialogAfter = false
  if (play === 'enabled') {
    await clickPlay(session, orchestratorSessionId)
    await Bun.sleep(5_000)
    dialogAfter = (await readConfirmation(session)).open
    if (dialogAfter) await pressConfirmation(session, 'common.cancel')
    const ids = await runIdsOf(ctx, slug)
    ctx.owned.find(o => o.orchestratorSessionId === orchestratorSessionId)?.runIds.push(...ids)
    for (const id of ids.slice(1)) await runControl(session, 'stopTask', ctx.workspaceId, slug, id)
  }
  run.observe('C: Play after the run ended', { play, dialogAfter })
  run.check('C: Play after the run ended shows no confirmation', play !== 'absent' && !dialogAfter, JSON.stringify({ play, dialogAfter }))

  // The on-disk edit: one node appended (a never-run row enables Play again once the board re-reads the spec).
  const yamlPath = join(ctx.workspaceRoot, 'tasks', slug, 'task.yaml')
  if (!run.check('C: task.yaml is on disk', existsSync(yamlPath), yamlPath)) return
  writeFileSync(yamlPath, appendNodeYaml(readFileSync(yamlPath, 'utf8'), { id: 'extra', title: 'Added on disk', prompt: `Reply with exactly EXTRA-${s}.` }))
  const reasked = await getTask(session, ctx.workspaceId, slug)
  run.check('C: an on-disk edit makes the host ask again (for the edited spec)', reasked.needsRunConfirmation && reasked.nodeCount === 2, JSON.stringify(reasked))
  const runsBefore = (await runIdsOf(ctx, slug)).length
  const refused = await runTask(session, ctx.workspaceId, slug, orchestratorSessionId)
  if (refused.run?.runId) ctx.owned.find(o => o.orchestratorSessionId === orchestratorSessionId)?.runIds.push(refused.run.runId)
  run.check(`C: tasks:run without the digest is refused ${RUN_CONFIRMATION_REQUIRED}`, (refused.error ?? '').includes(RUN_CONFIRMATION_REQUIRED),
    JSON.stringify(refused))
  // The board re-reads a spec only on a slug-set change, an editor close or a child's turn edge (no task.yaml
  // watcher, upstream v0.13.4 parity): leave the board for the caller's chat and come back, so it remounts and
  // re-reads. A stale tile then FAILs here under its own name, not as a missing confirmation.
  await openSession(session, caller.sessionId)
  const reopened = await openBoard(session)
  await waitFor(() => tileExists(session, orchestratorSessionId), Boolean, { timeoutMs: 20_000, intervalMs: 500 }).catch(() => false)
  await expandTile(session, orchestratorSessionId)
  const fresh = await waitFor(
    async () => ({ play: await playState(session, orchestratorSessionId), rows: await readTileRows(session, orchestratorSessionId, ['Added on disk']) }),
    r => r.play === 'enabled' && r.rows.length > 0,
    { timeoutMs: 20_000, intervalMs: 500 },
  ).catch(async () => ({ play: await playState(session, orchestratorSessionId), rows: await readTileRows(session, orchestratorSessionId, ['Added on disk']) }))
  if (!run.check('C: after the board re-read, the tile shows the edited spec\'s new row and Play reads enabled',
    reopened && fresh.play === 'enabled' && fresh.rows.length > 0, JSON.stringify({ reopened, ...fresh }))) return
  run.observe('C: Play (edited spec)', await clickPlay(session, orchestratorSessionId) ?? 'clicked')
  const third = await waitConfirmation(session)
  run.check('C: Play on the edited spec shows the confirmation again', third.open, 'no confirmation within 10 s')
  run.observe('C: Cancel (edited spec)', await pressConfirmation(session, 'common.cancel') ?? 'clicked')
  await Bun.sleep(3_000)
  run.check('C: and Cancel runs nothing', (await runIdsOf(ctx, slug)).length === runsBefore, JSON.stringify(await runIdsOf(ctx, slug)))
}

// ---------------------------------------------------------------------------------------------------------------
// F - file descriptors under four codex nodes
// ---------------------------------------------------------------------------------------------------------------

interface FdReading { pids: number; total: number; top: Array<{ pid: number; fds: number; command: string }> }

function readFds(): FdReading | string {
  const roots = appProcessPids(configDirScope())
  if (roots.length === 0) return 'no app process found (pgrep "MacOS/Nessy Desktop", scoped to NESSY_CONFIG_DIR)'
  const ps = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid=']).stdout.toString()
  const pids = descendantPids(ps, roots)
  const lsof = Bun.spawnSync(['lsof', '-n', '-P', '-p', pids.join(',')]).stdout.toString()
  const counts = fdCountsByPid(lsof)
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (total === 0) return `lsof read nothing for ${pids.length} pid(s)`
  const top = Object.entries(counts).map(([pid, fds]) => ({ pid: Number(pid), fds })).sort((a, b) => b.fds - a.fds).slice(0, 6)
    .map(entry => ({ ...entry, command: Bun.spawnSync(['ps', '-o', 'comm=', '-p', String(entry.pid)]).stdout.toString().trim().slice(-60) }))
  return { pids: pids.length, total, top }
}

async function driveFds(ctx: Ctx): Promise<void> {
  const { run, session } = ctx
  if (unmeasuredCard(ctx, 'F', 'codex')) return
  const s = stampOf()
  const spec = {
    id: `cdp-rs-113-fds-${s}`,
    title: `CDP ${ID} four codex nodes ${s}`,
    goal: 'Four codex nodes at once.',
    acceptance_criteria: 'This is a scripted check. Answer exactly: VERDICT: PASS',
    max_parallel: 4,
    nodes: [1, 2, 3, 4].map(i => ({
      id: `n${i}`, title: `Codex ${i}`, llmConnection: ctx.cards.codex,
      prompt: `Run the shell command \`sleep 30\` and wait for it to finish, then reply with exactly FD-${i}-${s}.`,
    })),
  }
  const baseline = readFds()
  run.observe('F: fds before the run', baseline)
  const task = await prepareTask(ctx, 'F', spec, ctx.cards.codex!, 'bypassPermissions')
  if (!task) return
  const runId = await startRun(ctx, 'F', task.slug, task.orchestratorSessionId)
  if (!runId) return
  const snapshots: NodeState[][] = []
  const samples: Array<{ at: number; running: number; fds: FdReading | string }> = []
  const deadline = Date.now() + 600_000
  while (Date.now() < deadline) {
    const snap = await liveRun(ctx, task.slug, runId)
    if (snap) snapshots.push(snap.nodes)
    const running = snap?.nodes.filter(n => n.state === 'running').length ?? 0
    if (running > 0) samples.push({ at: Date.now(), running, fds: readFds() })
    if (!snap || TERMINAL.has(snap.status) || snap.status === 'verifying') break
    await Bun.sleep(3_000)
  }
  const end = await waitRunStatus(session, ctx.workspaceId, task.slug, runId, status => TERMINAL.has(status), 300_000)
  await Bun.sleep(20_000)
  const after = readFds()
  const peak = samples.filter(x => typeof x.fds !== 'string').sort((a, b) => (b.fds as FdReading).total - (a.fds as FdReading).total)[0]
  run.observe('F: fds at the peak (with the running node count)', peak ?? null)
  run.observe('F: fds 20 s after the run', after)
  run.observe('F: READING (UA4.1): baseline -> peak -> after', {
    baseline: typeof baseline === 'string' ? baseline : baseline.total,
    peak: peak ? (peak.fds as FdReading).total : null,
    peakRunning: peak?.running ?? null,
    after: typeof after === 'string' ? after : after.total,
    samples: samples.length,
  })
  run.check('F: four codex nodes ran at once', maxConcurrentRunning(snapshots) === 4, `max running ${maxConcurrentRunning(snapshots)}`)
  run.check('F: the fd instrument read the app\'s process tree before, during and after', typeof baseline !== 'string' && peak !== undefined && typeof after !== 'string',
    JSON.stringify({ baseline: typeof baseline === 'string' ? baseline : 'ok', peak: peak ? 'ok' : 'no sample', after: typeof after === 'string' ? after : 'ok' }))
  run.check('F: the run completed', end.runStatus === 'completed', `runStatus ${JSON.stringify(end.runStatus)}`)
}

// ---------------------------------------------------------------------------------------------------------------
// W - background producers vs node completion (UA4.8)
// ---------------------------------------------------------------------------------------------------------------

interface BackgroundArm {
  name: string
  runtime: SittingRuntime
  expect: SettlementExpectation
  minSeconds?: number
  prompt: (marker: string, s: string) => string
}

export const BACKGROUND_ARMS: readonly BackgroundArm[] = [
  {
    name: 'claude-agent', runtime: 'claude', expect: 'after-marker',
    prompt: (m, s) => 'Use the Agent tool with run_in_background set to true to start ONE background subagent with this exact '
      + `task: "Run the shell command: sleep 30 && touch ${m}". Do not wait for it and do not check on it. As soon as it has `
      + `started, reply with exactly BG-STARTED-${s}.`,
  },
  {
    name: 'claude-bash', runtime: 'claude', expect: 'after-marker',
    prompt: (m, s) => `Use the Bash tool with run_in_background set to true to run exactly: sleep 20 && touch ${m}\n`
      + `Do not wait for it. Reply with exactly BG-STARTED-${s} right after starting it.`,
  },
  {
    name: 'codex-terminal', runtime: 'codex', expect: 'after-marker',
    prompt: (m, s) => 'Start this command as a background terminal session of your exec tool (yield and leave it running; '
      + `not a shell "&" and not nohup): sleep 20 && touch ${m}\nDo not wait for it. Reply with exactly BG-STARTED-${s} right after starting it.`,
  },
  {
    name: 'codex-spawn', runtime: 'codex', expect: 'record',
    prompt: (m, s) => `Use spawn_agent to start one sub-agent with the task "Run the shell command: sleep 20 && touch ${m}, then reply DONE". `
      + `Do not call wait_agent. Reply with exactly BG-STARTED-${s} right after spawning it.`,
  },
  {
    name: 'pi-subagent', runtime: 'pi', expect: 'after-marker',
    prompt: (m, s) => 'Use your Agent tool in background mode (run_in_background true) to start ONE background subagent with '
      + `the task "Run the shell command: sleep 30 && touch ${m}". Do not wait for it. Reply with exactly BG-STARTED-${s}.`,
  },
  {
    name: 'pi-monitor', runtime: 'pi', expect: 'min-seconds', minSeconds: 15,
    prompt: (_m, s) => 'Use the Monitor tool to watch the shell command "sleep 60" with a timeout of 15 seconds. Reply with '
      + `exactly BG-STARTED-${s} right after starting the monitor.`,
  },
  {
    // UA12.158 — loop-first: a BARE ScheduleWakeup is refused by the shipped contract ('No self-paced /loop is
    // active in this session.', SessionManager — the old arm measured UNMEASURED by design, SIT-D F6). The child
    // arms the loop with CronCreate {dynamic: true} (the first iteration delivers as soon as the current turn
    // ends), re-arms it once with ScheduleWakeup {delaySeconds: 60} (the schema's floor), and the LOOP's iteration
    // is the wake turn: it touches the marker, replies WOKE, and calls ScheduleWakeup {stop: true} so the pending
    // record clears and the node's door completes with the wake turn's own text (the UA12.156 gate pin).
    name: 'pi-wakeup', runtime: 'pi', expect: 'after-marker',
    prompt: (m, s) => 'Arm a self-paced /loop, then let it wake you. Call CronCreate once with dynamic set to true and '
      + `prompt exactly: "Run the shell command: touch ${m} then reply exactly WOKE-${s}, then call ScheduleWakeup with `
      + 'stop true to end the loop". Then call ScheduleWakeup once with delaySeconds 60 to arm the loop wakeup. Run '
      + `nothing yourself now. Reply with exactly BG-STARTED-${s} and end your turn; the loop's iteration does the rest.`,
  },
  {
    name: 'pi-goal', runtime: 'pi', expect: 'after-marker',
    prompt: (m, s) => `/goal Run the shell command: sleep 15 && touch ${m} and then reply GOAL-DONE-${s}`,
  },
]

async function driveBackgroundArm(ctx: Ctx, arm: BackgroundArm): Promise<void> {
  const { run, session } = ctx
  const label = `W/${arm.name}`
  if (unmeasuredCard(ctx, label, arm.runtime)) return
  const s = stampOf()
  const marker = join(ctx.scratch, `${arm.name}-${s}.done`)
  const spec = {
    id: `cdp-rs-113-bg-${arm.name}-${s}`,
    title: `CDP ${ID} ${arm.name} ${s}`,
    goal: 'A background-producer settlement check.',
    acceptance_criteria: 'This is a scripted check. Answer exactly: VERDICT: PASS',
    nodes: [{ id: 'bg', title: `Background ${arm.name}`, prompt: arm.prompt(marker, s) }],
  }
  const task = await prepareTask(ctx, label, spec, cardFor(ctx, arm.runtime)!, 'bypassPermissions')
  if (!task) return
  const runId = await startRun(ctx, label, task.slug, task.orchestratorSessionId)
  if (!runId) return
  let markerAt: number | undefined
  const deadline = Date.now() + 420_000
  let node: NodeState | null = null
  let settledAt: number | undefined
  while (Date.now() < deadline) {
    if (markerAt === undefined && existsSync(marker)) markerAt = statSync(marker).mtimeMs
    node = (await liveRun(ctx, task.slug, runId))?.nodes.find(n => n.id === 'bg') ?? node
    const settled = node !== null && node.state !== 'running' && node.state !== 'pending'
    settledAt = settled ? settledAt ?? Date.now() : undefined
    // Done, and the producer either ended or had 90 s past the done to end (each producer runs 15-30 s).
    if (settled && (markerAt !== undefined || arm.expect !== 'after-marker' || Date.now() - settledAt! > 90_000)) break
    await Bun.sleep(1_000)
  }
  if (markerAt === undefined && existsSync(marker)) markerAt = statSync(marker).mtimeMs
  await Bun.sleep(30_000) // a wake after done lands after the done
  const log = readLog(ctx.workspaceRoot, task.slug, runId)
  const times = nodeTimes(log, 'bg')
  const woke = wokeAfterDone(log)
  const childId = log.find(e => e.kind === 'node-spawned' && e.nodeId === 'bg')?.sessionId
  const childRows = childId ? await transcript(session, { workspaceId: ctx.workspaceId, sessionId: childId }).catch(() => [] as TranscriptMessage[]) : []
  const score = scoreSettlement({ expect: arm.expect, ...times, markerAt, minSeconds: arm.minSeconds })
  run.observe(`${label}: the reading`, {
    verdict: score.verdict, detail: score.detail, node: node?.state ?? null, finishedState: times.finishedState ?? null,
    wokeAfterDone: woke.length, tools: childRows.filter(r => r.toolName).map(r => ({ tool: r.toolName, input: JSON.stringify(r.toolInput ?? {}).slice(0, 160) })).slice(0, 8),
  })
  if (arm.expect === 'record') {
    run.check(`${label}: measured (node spawned; the settlement is a READING)`, score.ok, score.detail)
  } else {
    run.check(`${label}: the node is done only after its producer ended, and is done`, score.ok, score.detail)
    run.check(`${label}: no node-woke-after-done`, woke.length === 0, JSON.stringify(woke))
  }
  const status = (await results(session, ctx.workspaceId, task.slug, runId)).runStatus ?? ''
  if (!TERMINAL.has(status)) run.observe(`${label}: stop`, await runControl(session, 'stopTask', ctx.workspaceId, task.slug, runId))
}

// ---------------------------------------------------------------------------------------------------------------
// G - Generate: draft, no card, nothing saved; edit, adopt, confirm, run
// ---------------------------------------------------------------------------------------------------------------

function folderListing(root: string | null): Record<string, number> | string {
  if (!root || !existsSync(root)) return `no folder (${JSON.stringify(root)})`
  const out: Record<string, number> = {}
  const walk = (dir: string, rel: string, depth: number): void => {
    if (Object.keys(out).length >= 5_000) return
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const name = String(entry.name)
      if (name === '.git' || name === 'node_modules') continue
      const path = join(dir, name)
      const key = rel ? `${rel}/${name}` : name
      try { out[key] = statSync(path).mtimeMs } catch { continue }
      if (entry.isDirectory() && depth < 2) walk(path, key, depth + 1)
    }
  }
  walk(root, '', 1)
  return out
}

async function installGeneratedListener(session: CdpSession): Promise<void> {
  await session.call<null>(`
    if (!window.__rs113Generated) {
      window.__rs113Generated = []
      window.electronAPI.onTaskGenerated((ws, r) => window.__rs113Generated.push({ ws, at: Date.now(), r }))
    }
    return null
  `)
}

interface Generated { orchestratorSessionId: string; slug: string; yaml: string; spec?: Record<string, unknown>; valid: boolean; error?: string; at: number }

async function readGenerated(session: CdpSession, orchestratorSessionId: string): Promise<Generated | null> {
  return session.call<Generated | null>(`
    const hit = (window.__rs113Generated || []).find(x => x.r && x.r.orchestratorSessionId === ${JSON.stringify(orchestratorSessionId)})
    if (!hit) return null
    const r = hit.r
    return { orchestratorSessionId: r.orchestratorSessionId, slug: r.slug || '', yaml: String(r.yaml || '').slice(0, 4000),
      spec: r.spec ?? undefined, valid: !!(r.validation && r.validation.valid), error: r.error, at: hit.at }
  `)
}

async function driveGenerate(ctx: Ctx, runtime: SittingRuntime): Promise<void> {
  const { run, session } = ctx
  const label = `G/${runtime}`
  if (unmeasuredCard(ctx, label, runtime)) return
  const s = stampOf()
  await installGeneratedListener(session)
  const slugsBefore = await listTaskSlugs(session, ctx.workspaceId)
  const t0 = Date.now()
  const ack = await session.call<{ orchestratorSessionId?: string; error?: string }>(`
    try {
      return await window.electronAPI.generateTask(${JSON.stringify(ctx.workspaceId)}, {
        goal: ${JSON.stringify(`Two subtasks: the first replies HELLO-${s}; the second, after the first, replies WORLD-${s}.`)},
        title: ${JSON.stringify(`CDP ${ID} generate ${runtime} ${s}`)},
        llmConnection: ${JSON.stringify(cardFor(ctx, runtime))},
      })
    } catch (e) { return { error: String(e && e.message || e).slice(0, 300) } }
  `)
  const draft = ack.orchestratorSessionId
  if (draft) ctx.owned.push({ orchestratorSessionId: draft, runIds: [] })
  if (!run.check(`${label}: tasks:generate acked a draft orchestrator`, Boolean(draft), JSON.stringify(ack))) return
  const firstRow = await waitFor(() => sessionRow(session, draft!), r => r.found, { timeoutMs: 20_000, intervalMs: 1_000 }).catch(() => sessionRow(session, draft!))
  const folderBefore = folderListing(firstRow.workingDirectory)
  const boardOpen = await openBoard(session)
  const samples: DraftSample[] = []
  let generated: Generated | null = null
  while (Date.now() - t0 < GENERATE_CLIENT_TIMEOUT_MS) {
    const row = await sessionRow(session, draft!)
    samples.push({
      found: row.found, taskDraft: row.taskDraft, hidden: row.hidden, permissionMode: row.permissionMode,
      awaitingApprovalCount: row.awaitingApprovalCount, onBoard: boardOpen ? await tileExists(session, draft!) : null,
    })
    generated = await readGenerated(session, draft!)
    if (generated) break
    await Bun.sleep(2_000)
  }
  const posture = scoreDraftSamples(samples)
  run.check(`${label}: the draft is listed, not on the board, authors in ${GENERATE_PERMISSION_MODE} and never holds a card`, posture.ok, posture.detail)
  run.observe(`${label}: tasks:generated`, generated ? { ...generated, spec: undefined, elapsedS: Math.round((generated.at - t0) / 1000) } : null)
  if (!run.check(`${label}: tasks:generated arrived within ${GENERATE_CLIENT_TIMEOUT_MS / 1000} s with a valid spec`,
    generated !== null && generated.valid && !generated.error && typeof generated.spec === 'object',
    generated ? `valid ${generated.valid}, error ${JSON.stringify(generated.error ?? null)}` : 'no tasks:generated for the draft')) return
  const slugsAfter = await listTaskSlugs(session, ctx.workspaceId)
  run.check(`${label}: nothing was saved (tasks:list unchanged)`, slugsAfter.filter(x => !slugsBefore.includes(x)).length === 0,
    JSON.stringify(slugsAfter.filter(x => !slugsBefore.includes(x))))
  const folderAfter = folderListing(firstRow.workingDirectory)
  const delta = typeof folderBefore === 'string' || typeof folderAfter === 'string' ? null : folderDelta(folderBefore, folderAfter)
  run.observe(`${label}: the draft's folder`, { folder: firstRow.workingDirectory, changed: delta ?? folderBefore })
  run.check(`${label}: the draft wrote nothing in its folder (depth 2)`, delta !== null && delta.length === 0,
    delta === null ? `UNMEASURED - ${typeof folderBefore === 'string' ? folderBefore : folderAfter}` : JSON.stringify(delta.slice(0, 10)))

  // Edit and adopt.
  const edited = editGeneratedSpec(generated!.spec!, '(edited)', 'default')
  const adopted = await createTask(session, ctx.workspaceId, edited, draft)
  run.observe(`${label}: the adoption`, adopted)
  const owned = ctx.owned.find(o => o.orchestratorSessionId === draft)
  if (owned && adopted.slug) owned.slug = adopted.slug
  if (!run.check(`${label}: saving the edited spec adopts the draft in place`, adopted.slug !== '' && adopted.orchestratorSessionId === draft,
    adopted.error ?? JSON.stringify(adopted))) return
  const row = await waitFor(() => sessionRow(session, draft!), r => !r.taskDraft && r.taskSlug === adopted.slug, { timeoutMs: 20_000, intervalMs: 1_000 })
    .catch(() => sessionRow(session, draft!))
  const orchestrators = (await sessionRows(session)).filter(r => r.taskSlug === adopted.slug && !r.parentSessionId)
  run.check(`${label}: one orchestrator carries the task, in the editor's mode`,
    orchestrators.length === 1 && row.permissionMode === 'default' && !row.taskDraft,
    JSON.stringify({ orchestrators: orchestrators.map(r => r.id), mode: row.permissionMode, taskDraft: row.taskDraft }))
  const asked = await getTask(session, ctx.workspaceId, adopted.slug)
  run.check(`${label}: an adopted draft asks for a run confirmation`, asked.needsRunConfirmation, JSON.stringify(asked))
  if (await openBoard(session)) {
    await waitFor(() => tileExists(session, draft!), Boolean, { timeoutMs: 20_000, intervalMs: 500 }).catch(() => false)
    run.check(`${label}: the adopted task has its tile`, await tileExists(session, draft!), 'no tile')
    run.observe(`${label}: Play`, await clickPlay(session, draft!) ?? 'clicked')
    const shown = await waitConfirmation(session)
    run.check(`${label}: Play shows the run confirmation`, shown.open, 'no confirmation within 10 s')
    if (shown.open) run.observe(`${label}: Run`, await pressConfirmation(session, 'tasks.runConfirm.run') ?? 'clicked')
    const ids = await waitFor(() => runIdsOf(ctx, adopted.slug), x => x.length === 1, { timeoutMs: 30_000, intervalMs: 1_000 }).catch(() => runIdsOf(ctx, adopted.slug))
    owned?.runIds.push(...ids)
    run.check(`${label}: Run starts the adopted task`, ids.length === 1, JSON.stringify(ids))
    if (ids[0]) run.observe(`${label}: stop`, await runControl(session, 'stopTask', ctx.workspaceId, adopted.slug, ids[0]))
  } else {
    run.check(`${label}: the board opened`, false, 'no [data-kanban-column]')
  }
}

// ---------------------------------------------------------------------------------------------------------------
// R1 / R2 - a restart
// ---------------------------------------------------------------------------------------------------------------

interface RestartState {
  workspaceId: string
  stamp: string
  tasks: Array<{ slug: string; orchestratorSessionId: string; runId: string; bSession: string; bMarker: string }>
}

function restartSpec(s: string, which: string, bMarker: string): Record<string, unknown> {
  return {
    id: `cdp-rs-113-restart-${which}-${s}`,
    title: `CDP ${ID} restart ${which} ${s}`,
    goal: 'A scripted restart check.',
    acceptance_criteria: 'This is a scripted check. Answer exactly: VERDICT: PASS',
    nodes: [
      { id: 'a', title: 'Quick A', prompt: `Reply with exactly RESTART-A-${s}.` },
      { id: 'b', title: 'Long B', depends_on: ['a'], prompt: `Run the shell command \`sleep 120\` and wait for it, then reply with exactly ${bMarker}.` },
    ],
  }
}

async function driveRestartOne(ctx: Ctx): Promise<void> {
  const { run } = ctx
  const runtime = (process.env.NESSY_CDP_RS113_RESTART_RUNTIME ?? 'claude') as SittingRuntime
  if (unmeasuredCard(ctx, 'R1', runtime)) return
  const s = stampOf()
  const state: RestartState = { workspaceId: ctx.workspaceId, stamp: s, tasks: [] }
  for (const which of ['resume', 'stop']) {
    const bMarker = `ORIGINAL-B-${which}-${s}`
    const task = await prepareTask(ctx, `R1/${which}`, restartSpec(s, which, bMarker), cardFor(ctx, runtime)!, 'bypassPermissions')
    if (!task) return
    const runId = await startRun(ctx, `R1/${which}`, task.slug, task.orchestratorSessionId)
    if (!runId) return
    const b = await waitNode(ctx, task.slug, runId, 'b', n => n.state === 'running' && n.sessionId !== undefined, 300_000)
    if (!run.check(`R1/${which}: node b is running`, b?.sessionId !== undefined, JSON.stringify(b))) return
    state.tasks.push({ slug: task.slug, orchestratorSessionId: task.orchestratorSessionId, runId, bSession: b!.sessionId!, bMarker })
  }
  // R1's tasks are R2's subject: they are not cleaned up here.
  ctx.owned.splice(0, ctx.owned.length, ...ctx.owned.filter(o => !state.tasks.some(t => t.orchestratorSessionId === o.orchestratorSessionId)))
  mkdirSync(new URL('../tmp/', import.meta.url).pathname, { recursive: true })
  writeFileSync(RESTART_STATE, `${JSON.stringify(state, null, 2)}\n`)
  run.observe('R1: state for R2', RESTART_STATE)
  blocked(`R1 done: QUIT the app now (node b of both runs is mid-sleep), relaunch it with the same env -u launcher, then run NESSY_CDP_RS113_ARMS=R2 bun run scripts/cdp/run.ts ${ID}`)
}

async function driveRestartTwo(ctx: Ctx): Promise<void> {
  const { run, session } = ctx
  if (!existsSync(RESTART_STATE)) blocked(`R2 needs ${RESTART_STATE}: run NESSY_CDP_RS113_ARMS=R1 first, then quit and relaunch`)
  const state = JSON.parse(readFileSync(RESTART_STATE, 'utf8')) as RestartState
  for (const t of state.tasks) ctx.owned.push({ slug: t.slug, orchestratorSessionId: t.orchestratorSessionId, runIds: [t.runId] })
  for (const t of state.tasks) {
    const read = await results(session, state.workspaceId, t.slug, t.runId)
    run.check(`R2/${t.slug}: after the restart the run reads interrupted, never running`, read.runStatus === 'interrupted',
      `runStatus ${JSON.stringify(read.runStatus)}`)
  }
  const [resumeTask, stopTaskEntry] = state.tasks
  if (resumeTask) {
    const yamlPath = join(ctx.workspaceRoot, 'tasks', resumeTask.slug, 'task.yaml')
    if (existsSync(yamlPath)) {
      const original = readFileSync(yamlPath, 'utf8')
      // b's prompt changed and a node appended (`saveTaskSpec` writes js-yaml with `nodes` last).
      const edited = appendNodeYaml(original.replace(resumeTask.bMarker, `EDITED-${state.stamp}`),
        { id: 'z', title: 'Added after the restart', prompt: `Reply with exactly Z-${state.stamp}.` })
      writeFileSync(yamlPath, edited)
      run.check('R2: task.yaml edited before Resume (b\'s prompt and a new node)', original.includes(resumeTask.bMarker),
        'b\'s marker is not in task.yaml, so the prompt edit did not land')
    } else {
      run.check('R2: task.yaml is on disk', false, yamlPath)
    }
    run.observe('R2: resume', await runControl(session, 'resumeTask', state.workspaceId, resumeTask.slug, resumeTask.runId))
    const end = await waitRunStatus(session, state.workspaceId, resumeTask.slug, resumeTask.runId, status => TERMINAL.has(status), 600_000)
    const log = readLog(ctx.workspaceRoot, resumeTask.slug, resumeTask.runId)
    const bSessions = log.filter(e => e.kind === 'node-spawned' && e.nodeId === 'b').map(e => e.sessionId)
    const newB = bSessions[bSessions.length - 1]
    const firstUser = newB && newB !== resumeTask.bSession
      ? (await transcript(session, { workspaceId: state.workspaceId, sessionId: newB }).catch(() => [] as TranscriptMessage[])).find(m => m.role === 'user')?.content ?? ''
      : ''
    run.check('R2: Resume re-ran b in a NEW child', newB !== undefined && newB !== resumeTask.bSession, JSON.stringify(bSessions))
    run.check('R2: the new child got b\'s ORIGINAL prompt, not the edited one', firstUser.includes(resumeTask.bMarker) && !firstUser.includes(`EDITED-${state.stamp}`),
      JSON.stringify(firstUser.slice(0, 300)))
    const nodes = (await results(session, state.workspaceId, resumeTask.slug, resumeTask.runId)).nodes.map(n => n.id)
    run.check('R2: no node joined the resumed run', !nodes.includes('z') && !Object.keys(spawnCounts(log)).includes('z'), JSON.stringify(nodes))
    const abandoned = await sessionRow(session, resumeTask.bSession)
    run.check('R2: the abandoned child sits in To do', abandoned.kanbanColumn === 'todo', `column ${JSON.stringify(abandoned.kanbanColumn)}`)
    run.check('R2: the resumed run completed', end.runStatus === 'completed', `runStatus ${JSON.stringify(end.runStatus)}`)
  }
  if (stopTaskEntry) {
    run.observe('R2: stop the interrupted run', await runControl(session, 'stopTask', state.workspaceId, stopTaskEntry.slug, stopTaskEntry.runId))
    const stopped = await waitRunStatus(session, state.workspaceId, stopTaskEntry.slug, stopTaskEntry.runId, status => status === 'stopped', 30_000)
    run.check('R2: Stop on an interrupted run reads stopped', stopped.runStatus === 'stopped', `runStatus ${JSON.stringify(stopped.runStatus)}`)
  }
  rmSync(RESTART_STATE, { force: true })
}

// ---------------------------------------------------------------------------------------------------------------
// drive
// ---------------------------------------------------------------------------------------------------------------

async function cleanup(ctx: Ctx): Promise<void> {
  const report: Record<string, unknown> = {}
  const rows = await sessionRows(ctx.session).catch(() => [] as SessionRow[])
  for (const owned of ctx.owned) {
    const slug = owned.slug ?? rows.find(r => r.id === owned.orchestratorSessionId)?.taskSlug ?? undefined
    const stops: string[] = []
    for (const runId of slug ? owned.runIds : []) {
      const status = (await results(ctx.session, ctx.workspaceId, slug!, runId).catch(() => null))?.runStatus ?? ''
      if (!TERMINAL.has(status)) stops.push(await runControl(ctx.session, 'stopTask', ctx.workspaceId, slug!, runId))
    }
    const victims = [...rows.filter(r => r.parentSessionId === owned.orchestratorSessionId).map(r => r.id), owned.orchestratorSessionId]
    const deleted: string[] = []
    for (const id of victims) {
      deleted.push(await ctx.session.call<string>(`
        try { await window.electronAPI.deleteSession(${JSON.stringify(id)}); return 'deleted' }
        catch (e) { return 'delete failed: ' + String(e && e.message || e).slice(0, 120) }
      `).catch(error => `delete failed: ${String(error).slice(0, 120)}`))
    }
    let folder = 'none'
    if (slug && (await listTaskSlugs(ctx.session, ctx.workspaceId).catch(() => [] as string[])).includes(slug)) {
      folder = await ctx.session.call<string>(`
        try { await window.electronAPI.deleteTask(${JSON.stringify(ctx.workspaceId)}, ${JSON.stringify(slug)}); return 'deleted' }
        catch (e) { return 'delete failed: ' + String(e && e.message || e).slice(0, 120) }
      `).catch(error => `delete failed: ${String(error).slice(0, 120)}`)
    }
    report[slug ?? owned.orchestratorSessionId] = { stops, sessions: deleted.length, failed: deleted.filter(d => d !== 'deleted'), folder }
  }
  rmSync(ctx.scratch, { recursive: true, force: true })
  ctx.run.observe('cleanup', report)
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  await ensureDarkTheme(session)
  run.observe('window', await focusWindow(session))
  run.observe('arms', ARMS)
  const connections = await listConnections(session)
  const cards: Cards = {
    pi: connections.find(row => runtimeOf(row.providerType) === 'pi')?.slug,
    claude: connections.find(row => runtimeOf(row.providerType) === 'anthropic')?.slug,
    codex: connections.find(row => runtimeOf(row.providerType) === 'codex-runtime')?.slug,
  }
  run.observe('cards', cards)
  if (!cards.pi && !cards.claude && !cards.codex) {
    blocked(`no pi, claude-runtime or codex-runtime card on this host; it lists ${connections.map(row => `${row.slug}(${row.providerType})`).join(', ') || 'nothing'}`)
  }

  // The caller chat: C's create_board_task, and the workspace every arm runs in.
  const callerRuntime = (process.env.NESSY_CDP_RS113_CALLER_RUNTIME ?? 'claude') as SittingRuntime
  const callerCard = cards[callerRuntime] ?? cards.claude ?? cards.pi ?? cards.codex!
  const caller = await freshSession(session, `CDP ${ID} caller ${stampOf()}`)
  run.require('ran in a session it created', caller.fresh, `inherited ${caller.inheritedMessages} messages; reason: ${caller.reason ?? '(none given)'}`)
  run.observe('the caller\'s permission mode (read back)', caller.permissionMode)
  await switchRuntime(session, caller.sessionId, callerCard)
  run.require(`the caller runs on ${callerCard}`, (await waitForConnection(session, caller.sessionId, callerCard)) === callerCard, callerCard)
  await ensureSessionName(session, caller, `CDP ${ID} caller`)

  const workspaceRoot = join(resolveConfigDir(), 'workspaces', caller.workspaceId)
  run.require('the workspace root is readable (the run logs live there)', existsSync(workspaceRoot), workspaceRoot)
  const scratch = join(tmpdir(), `cdp-rs-113-${process.pid}-${stampOf()}`)
  mkdirSync(scratch, { recursive: true })
  const ctx: Ctx = { run, session, workspaceId: caller.workspaceId, workspaceRoot, cards, stamp: stampOf(), scratch, owned: [] }

  const family = async (name: string, body: () => Promise<void>): Promise<void> => {
    try {
      await body()
    } catch (error) {
      if (error instanceof BlockedError) throw error
      run.check(`${name}: completed its arms`, false, String(error).slice(0, 300))
    }
  }

  try {
    if (ARMS.includes('R2')) {
      await family('R2', () => driveRestartTwo(ctx))
      return
    }
    if (ARMS.includes('R1')) {
      await family('R1', () => driveRestartOne(ctx))
      return
    }
    if (ARMS.includes('D')) await family('D', () => driveDag(ctx))
    if (ARMS.includes('P')) await family('P', () => drivePause(ctx))
    if (ARMS.includes('M')) await family('M', () => drivePosture(ctx))
    if (ARMS.includes('C')) {
      await family('C0', () => driveConfirmationControl(ctx))
      await openSession(session, caller.sessionId)
      await focusWindow(session)
      await family('C', () => driveConfirmation(ctx, caller))
    }
    if (ARMS.includes('F')) await family('F', () => driveFds(ctx))
    if (ARMS.includes('W')) {
      const wanted = (process.env.NESSY_CDP_RS113_W ?? BACKGROUND_ARMS.map(arm => arm.name).join(',')).split(',').map(v => v.trim())
      for (const arm of BACKGROUND_ARMS.filter(a => wanted.includes(a.name))) await family(`W/${arm.name}`, () => driveBackgroundArm(ctx, arm))
    }
    if (ARMS.includes('G')) {
      const runtimes = (process.env.NESSY_CDP_RS113_GENERATE_RUNTIMES ?? 'codex,pi,claude').split(',').map(v => v.trim()) as SittingRuntime[]
      for (const runtime of runtimes) await family(`G/${runtime}`, () => driveGenerate(ctx, runtime))
    }
  } finally {
    ctx.owned.push({ orchestratorSessionId: caller.sessionId, runIds: [] })
    await cleanup(ctx)
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
