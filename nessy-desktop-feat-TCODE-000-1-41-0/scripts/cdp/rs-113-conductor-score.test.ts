/**
 * RS-113 (UA4.12) - the Conductor / Generate case's scorers, each with a positive and a negative arm, and the
 * product facts it restates, read back out of the product's own source or modules so a rename turns this file red
 * instead of leaving the sitting waiting for something the app no longer says or does.
 *
 * - The run-log readers (`parseRunLog`, `spawnCounts`, `scoreOneFinishPerAttempt`, `wokeAfterDone`, `nodeTimes`)
 *   read `TaskRunner`'s append-only log; their kinds are pinned against `RunLogEntry` in `storage.ts`.
 * - `scoreVerdictSequence`: D's FAIL-naming-b-then-PASS; `DAG_FAIL_LINE` is the Conductor's scoped form.
 * - `scoreSettlement`: W's invariant (done only after the producer ended, and done at all); the delay is a reading.
 * - `descendantPids` / `fdCountsByPid` / `maxConcurrentRunning`: F's instrument.
 * - `appendNodeYaml`: the on-disk edit, round-tripped through the product's own `serializeTaskYaml` /
 *   `parseTaskYaml` - the node lands, the bytes change, and the premise (`nodes` is the last key) is shown.
 * - `scoreDraftSamples` / `editGeneratedSpec` / `folderDelta`: G.
 * - `RUN_CONFIRMATION_REQUIRED` against `run-controls.ts` and `rpc/tasks.ts`.
 * - `scoreTileRows`: D's "children render under the tile" - a row counts only when a child session backs it (the row
 *   is a button); a synthetic `node:<id>` row carries the node's title too, so a title alone proves nothing.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { GENERATE_CLIENT_TIMEOUT_MS, GENERATE_PERMISSION_MODE } from '../../packages/shared/src/tasks/generate-limits.ts'
import { parseTaskYaml, serializeTaskYaml } from '../../packages/shared/src/tasks/storage.ts'
import { parseTaskSpec } from '../../packages/shared/src/tasks/schema.ts'
import {
  appendNodeYaml, BACKGROUND_ARMS, DAG_FAIL_LINE, descendantPids, editGeneratedSpec, fdCountsByPid, folderDelta,
  maxConcurrentRunning, nodeTimes, parseRunLog, RUN_CONFIRMATION_REQUIRED, scoreDraftSamples, scoreOneFinishPerAttempt,
  scoreSettlement, scoreTileRows, scoreVerdictSequence, SETTLEMENT_TOLERANCE_MS, spawnCounts, specFetchedTileRows,
  wokeAfterDone, type DraftSample, type RunLogLine, type TileRowRead,
} from './cases/rs-113.ts'

const ROOT = join(import.meta.dir, '..', '..')
const source = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const line = (e: RunLogLine): string => JSON.stringify(e)

describe('RS-113: the run-log readers', () => {
  const log: RunLogLine[] = [
    { t: '2026-10-02T10:00:00.000Z', kind: 'run-started' },
    { t: '2026-10-02T10:00:01.000Z', kind: 'node-spawned', nodeId: 'a', sessionId: 's1' },
    { t: '2026-10-02T10:00:05.000Z', kind: 'node-finished', nodeId: 'a', sessionId: 's1', state: 'done' },
    { t: '2026-10-02T10:00:06.000Z', kind: 'node-spawned', nodeId: 'b', sessionId: 's2' },
    { t: '2026-10-02T10:00:09.000Z', kind: 'node-finished', nodeId: 'b', sessionId: 's2', state: 'done' },
    { t: '2026-10-02T10:00:10.000Z', kind: 'node-retry', nodeId: 'b', reason: 'verdict-fail: x' },
    { t: '2026-10-02T10:00:11.000Z', kind: 'node-spawned', nodeId: 'b', sessionId: 's3' },
    { t: '2026-10-02T10:00:15.000Z', kind: 'node-finished', nodeId: 'b', sessionId: 's3', state: 'done' },
  ]

  it('parses the log and skips a torn last line', () => {
    const text = `${log.map(line).join('\n')}\n{"kind":"node-sp`
    expect(parseRunLog(text)).toHaveLength(log.length)
    expect(parseRunLog('')).toEqual([])
  })

  it('counts children per node, and one finish per attempt passes', () => {
    expect(spawnCounts(log)).toEqual({ a: 1, b: 2 })
    expect(scoreOneFinishPerAttempt(log).ok).toBe(true)
  })

  it('fails a lost finish, a double finish, a finish of a child never spawned, and a log with no child', () => {
    expect(scoreOneFinishPerAttempt(log.filter(e => !(e.kind === 'node-finished' && e.sessionId === 's3'))).detail).toContain('b:s3 finished 0x')
    expect(scoreOneFinishPerAttempt([...log, { kind: 'node-finished', nodeId: 'a', sessionId: 's1', state: 'done' }]).detail).toContain('a:s1 finished 2x')
    expect(scoreOneFinishPerAttempt([...log, { kind: 'node-finished', nodeId: 'c', sessionId: 's9', state: 'done' }]).detail).toContain('never spawned')
    expect(scoreOneFinishPerAttempt([{ kind: 'run-started' }]).ok).toBe(false)
  })

  it('reads a node\'s first spawn and first finish, and the woke-after-done lines', () => {
    expect(nodeTimes(log, 'b')).toEqual({ spawnedAt: Date.parse('2026-10-02T10:00:06.000Z'), finishedAt: Date.parse('2026-10-02T10:00:09.000Z'), finishedState: 'done' })
    expect(nodeTimes(log, 'zz')).toEqual({ spawnedAt: undefined, finishedAt: undefined })
    expect(wokeAfterDone(log)).toHaveLength(0)
    expect(wokeAfterDone([...log, { kind: 'node-woke-after-done', nodeId: 'a', sessionId: 's1' }])).toHaveLength(1)
  })

  it('reads only kinds the product writes (storage.ts RunLogEntry)', () => {
    const storage = source('packages/shared/src/tasks/storage.ts')
    for (const kind of ['node-spawned', 'node-finished', 'node-retry', 'node-woke-after-done', 'verdict', 'run-started']) {
      expect(storage).toContain(`'${kind}'`)
    }
    expect(storage).not.toContain(`'node-woke-after-dones'`) // the negative needle, spelt in the file's own grammar
  })
})

describe('RS-113: scoreVerdictSequence and the FAIL line', () => {
  it('passes one FAIL naming b and then PASS', () => {
    expect(scoreVerdictSequence([{ result: 'fail', nodes: ['b'] }, { result: 'pass' }], 'b').ok).toBe(true)
  })

  it('fails a first PASS, a FAIL naming another node, two FAILs, and a last FAIL', () => {
    expect(scoreVerdictSequence([{ result: 'pass' }], 'b').ok).toBe(false)
    expect(scoreVerdictSequence([{ result: 'fail', nodes: ['c'] }, { result: 'pass' }], 'b').ok).toBe(false)
    expect(scoreVerdictSequence([{ result: 'fail', nodes: ['b'] }, { result: 'fail', nodes: ['b'] }, { result: 'pass' }], 'b').detail).toContain('2 FAIL')
    expect(scoreVerdictSequence([{ result: 'fail', nodes: ['b'] }], 'b').detail).toContain('not PASS')
    expect(scoreVerdictSequence([], 'b').ok).toBe(false)
  })

  it('dictates the Conductor\'s own scoped FAIL form', () => {
    expect(DAG_FAIL_LINE).toMatch(/^VERDICT: FAIL — nodes=b — \S/)
    expect(source('packages/server-core/src/tasks/TaskRunner.ts')).toContain("'VERDICT: FAIL — nodes=<id>,<id> — <one-line reason>'")
  })
})

describe('RS-113: scoreSettlement', () => {
  const at = 1_000_000

  it('passes a node done after its producer ended, and reads the delay', () => {
    const score = scoreSettlement({ expect: 'after-marker', spawnedAt: at, markerAt: at + 30_000, finishedAt: at + 34_000 })
    expect(score.ok).toBe(true)
    expect(score.detail).toContain('4.0 s after')
  })

  it('fails a node done before its producer ended, one never done, and one whose producer left no marker', () => {
    const early = scoreSettlement({ expect: 'after-marker', spawnedAt: at, markerAt: at + 30_000, finishedAt: at + 5_000 })
    expect(early).toMatchObject({ ok: false, verdict: 'done-before-producer' })
    // The boundary: inside the clock tolerance is not "before".
    expect(scoreSettlement({ expect: 'after-marker', spawnedAt: at, markerAt: at + 30_000, finishedAt: at + 30_000 - SETTLEMENT_TOLERANCE_MS + 1 }).ok).toBe(true)
    expect(scoreSettlement({ expect: 'after-marker', spawnedAt: at, markerAt: at + 30_000 }).verdict).toBe('never-done')
    const noMarker = scoreSettlement({ expect: 'after-marker', spawnedAt: at, finishedAt: at + 3_000 })
    expect(noMarker.ok).toBe(false)
    expect(noMarker.detail).toStartWith('UNMEASURED')
    expect(scoreSettlement({ expect: 'after-marker' }).verdict).toBe('not-dispatched')
  })

  it('reads a monitor\'s floor: no earlier than the producer\'s seconds after the spawn', () => {
    expect(scoreSettlement({ expect: 'min-seconds', minSeconds: 15, spawnedAt: at, finishedAt: at + 16_000 }).ok).toBe(true)
    expect(scoreSettlement({ expect: 'min-seconds', minSeconds: 15, spawnedAt: at, finishedAt: at + 6_000 }).verdict).toBe('done-before-producer')
    expect(scoreSettlement({ expect: 'min-seconds', minSeconds: 15, spawnedAt: at }).verdict).toBe('never-done')
  })

  it('records a record arm whatever it reads, but not an arm that never spawned', () => {
    expect(scoreSettlement({ expect: 'record', spawnedAt: at }).ok).toBe(true)
    expect(scoreSettlement({ expect: 'record', spawnedAt: at, finishedAt: at + 2_000 }).detail).toContain('no marker')
    expect(scoreSettlement({ expect: 'record' }).ok).toBe(false)
  })

  it('every checked producer names its marker, so its arm can be measured at all', () => {
    for (const arm of BACKGROUND_ARMS) {
      const prompt = arm.prompt('/tmp/MARKER-X', 'S')
      expect(prompt.includes('/tmp/MARKER-X'), arm.name).toBe(arm.expect === 'after-marker' || arm.name === 'codex-spawn')
    }
    expect(BACKGROUND_ARMS.filter(arm => arm.expect === 'record').map(arm => arm.name)).toEqual(['codex-spawn'])
  })
})

describe('RS-113: the fd instrument', () => {
  const ps = ['  1     0', ' 100     1', ' 101   100', ' 102   101', ' 200     1', ' 201   200', 'garbage line'].join('\n')

  it('walks the tree below the roots and leaves a sibling tree out', () => {
    expect(descendantPids(ps, [100])).toEqual([100, 101, 102])
    expect(descendantPids(ps, [100, 200])).toEqual([100, 101, 102, 200, 201])
    expect(descendantPids(ps, [])).toEqual([])
  })

  it('counts descriptors per pid and skips the header', () => {
    const lsof = [
      'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
      'Nessy     100 me    cwd    DIR  1,4      640    2 /',
      'Nessy     100 me    txt    REG  1,4     1000    3 /x',
      'codex     102 me      0u  CHR  16,1      0t0  999 /dev/ttys001',
    ].join('\n')
    expect(fdCountsByPid(lsof)).toEqual({ 100: 2, 102: 1 })
    expect(fdCountsByPid('COMMAND PID USER')).toEqual({})
  })

  it('reads the most nodes running at once', () => {
    const four = [1, 2, 3, 4].map(() => ({ state: 'running' }))
    expect(maxConcurrentRunning([[{ state: 'pending' }], four, [{ state: 'done' }]])).toBe(4)
    expect(maxConcurrentRunning([[{ state: 'running' }, { state: 'pending' }]])).toBe(1)
    expect(maxConcurrentRunning([])).toBe(0)
  })
})

describe('RS-113: the on-disk edit', () => {
  const spec = parseTaskSpec({
    id: 'confirm-me', title: 'Confirm me', goal: 'Reply READY.',
    defaults: { llmConnection: 'card' },
    nodes: [{ id: 'main', title: 'Confirm me', prompt: 'Reply with exactly the word READY and nothing else.' }],
  })

  it('appends a node a create_board_task spec as saveTaskSpec writes it parses back with', () => {
    expect(spec.success).toBe(true)
    const yaml = serializeTaskYaml(spec.data!)
    const edited = appendNodeYaml(yaml, { id: 'extra', title: 'Added on disk', prompt: 'Reply with exactly EXTRA-1.' })
    expect(edited).not.toBe(yaml) // the bytes change, so the digest does
    const parsed = parseTaskYaml(edited)
    expect(parsed.valid).toBe(true)
    expect(parsed.spec?.nodes.map(n => n.id)).toEqual(['main', 'extra'])
    expect(parsed.spec?.nodes[1]?.prompt).toBe('Reply with exactly EXTRA-1.')
  })

  it('shows its premise: with a key after `nodes` the append does not add a node', () => {
    const withOutputs = parseTaskSpec({ ...spec.data!, outputs: { result: '${nodes.main.output}' } })
    const edited = appendNodeYaml(serializeTaskYaml(withOutputs.data!), { id: 'extra', title: 'x', prompt: 'y' })
    expect(parseTaskYaml(edited).spec?.nodes.map(n => n.id) ?? []).not.toEqual(['main', 'extra'])
    // ...and create_board_task never writes `outputs`.
    expect(source('packages/server-core/src/tasks/create-board-task.ts')).not.toMatch(/\boutputs\s*:/)
  })
})

describe('RS-113: Generate', () => {
  const good: DraftSample = { found: true, taskDraft: true, hidden: false, permissionMode: GENERATE_PERMISSION_MODE, awaitingApprovalCount: 0, onBoard: false }

  it('passes a listed, unhidden, off-board draft authoring in dontAsk with no card', () => {
    expect(GENERATE_PERMISSION_MODE).toBe('dontAsk')
    expect(scoreDraftSamples([good, { ...good, onBoard: null }]).ok).toBe(true)
  })

  it('fails a held card, another mode, a hidden draft, a tile, a draft never listed and a board never read', () => {
    expect(scoreDraftSamples([good, { ...good, awaitingApprovalCount: 1 }]).detail).toContain('card was held')
    expect(scoreDraftSamples([{ ...good, permissionMode: 'default' }]).ok).toBe(false)
    expect(scoreDraftSamples([{ ...good, hidden: true }]).ok).toBe(false)
    expect(scoreDraftSamples([good, { ...good, onBoard: true }]).detail).toContain('tile on the board')
    expect(scoreDraftSamples([{ ...good, found: false }]).detail).toContain('never listed')
    expect(scoreDraftSamples([{ ...good, onBoard: null }]).detail).toContain('never read')
    expect(scoreDraftSamples([{ ...good, taskDraft: false }]).ok).toBe(false)
  })

  it('edits a generated spec: a new title and the editor\'s mode, the nodes kept', () => {
    const generated = { id: 'g', title: 'Hello world', goal: 'x', defaults: { model: 'm' }, nodes: [{ id: 'a', prompt: 'p' }] }
    const edited = editGeneratedSpec(generated, '(edited)', 'default')
    expect(edited).toMatchObject({ title: 'Hello world (edited)', defaults: { model: 'm', permissionMode: 'default' }, nodes: generated.nodes })
    expect(parseTaskSpec(edited).success).toBe(true)
    expect(generated.defaults).toEqual({ model: 'm' }) // the draft's object is not mutated
  })

  it('names a changed, a new and a removed entry, and nothing for an unchanged folder', () => {
    expect(folderDelta({ a: 1, b: 2 }, { a: 1, b: 2 })).toEqual([])
    expect(folderDelta({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 })).toEqual(['b', 'c'])
    expect(folderDelta({ a: 1, b: 2 }, { a: 1 })).toEqual(['b'])
  })

  it('waits the editor\'s own fallback (attempts x timeout + grace)', () => {
    expect(GENERATE_CLIENT_TIMEOUT_MS).toBe(380_000)
  })
})

describe('RS-113: the host refusal it reads', () => {
  it('is the literal run-controls.ts and rpc/tasks.ts carry', () => {
    expect(RUN_CONFIRMATION_REQUIRED).toBe('run-confirmation-required')
    expect(source('apps/electron/src/renderer/components/app-shell/kanban/run-controls.ts')).toContain(`'${RUN_CONFIRMATION_REQUIRED}'`)
    expect(source('packages/server-core/src/handlers/rpc/tasks.ts')).toContain(RUN_CONFIRMATION_REQUIRED)
    expect(source('packages/server-core/src/handlers/rpc/tasks.ts')).not.toContain(`${RUN_CONFIRMATION_REQUIRED}d`)
  })
})

describe('RS-113: the tile rows D reads (UA4.12 follow-up)', () => {
  const titles = ['A on Pi', 'B on Claude', 'C on Codex']
  const backed = titles.map(title => ({ title, interactive: true }))

  it('passes when every node\'s row is backed by a child session', () => {
    expect(scoreTileRows(backed, titles)).toEqual({ ok: true, detail: 'A on Pi: session, B on Claude: session, C on Codex: session' })
  })

  it('fails a synthetic row carrying the node\'s title, and a missing row', () => {
    const synthetic = scoreTileRows([backed[0]!, backed[1]!, { title: 'C on Codex', interactive: false }], titles)
    expect(synthetic.ok).toBe(false)
    expect(synthetic.detail).toContain('C on Codex: synthetic')
    const missing = scoreTileRows(backed.slice(0, 2), titles)
    expect(missing.ok).toBe(false)
    expect(missing.detail).toContain('C on Codex: no row')
    expect(scoreTileRows([], titles).ok).toBe(false)
  })

  it('rests on the product: only a session-backed row is a button, and a synthetic row has no session', () => {
    const kanban = 'apps/electron/src/renderer/components/app-shell/kanban'
    expect(source(`${kanban}/SubtaskRow.tsx`)).toContain(`role={interactive ? 'button' : undefined}`)
    expect(source(`${kanban}/TaskTile.tsx`)).toContain('onClick={onSubtaskClick && sessionId ? () => onSubtaskClick(sessionId) : undefined}')
    // UA5.10: the click opens the row's session scoped to its task (upstream's openSessionScoped) — still by its session id.
    expect(source(`${kanban}/KanbanBoardContainer.tsx`)).toMatch(/onSubtaskClick=\{\(taskId, subtaskId\) => openSessionScoped\(subtaskId, metaMap\.get\(taskId\)\?\.projectId\)\}/)
    const synthetic = pendingRowLiteral(source(`${kanban}/subtask-merge.ts`))
    expect(synthetic).toBeDefined()
    expect(synthetic).toContain("runState: 'pending'")
    expect(synthetic).not.toContain('sessionId')
  })

  // UA12.69 follow-up (2026-10-08 verification, findings/UA12.69.md lens B): a0b20ca19 split the pending-row literal
  // over several lines, so a one-line find saw only `id: \`node:${node.id}\`,` and a `sessionId:` field added on any
  // other line of the literal passed unseen. The pin now reads the WHOLE `rows.push({ … })` literal.
  it('CONTROL — the pin sees a sessionId planted on any line of the pending-row literal', () => {
    const src = source('apps/electron/src/renderer/components/app-shell/kanban/subtask-merge.ts')
    const planted = src.replace("runState: 'pending',", "runState: 'pending',\n        sessionId: node.id,")
    expect(planted).not.toBe(src)
    expect(pendingRowLiteral(planted)).toContain('sessionId')
  })

  // UA12.69 follow-up (VF-4 re-verify): the conditional spread `...(… : {}),` itself contains `})`, so a slice that
  // stopped at the first `})` after the id ended inside the literal and missed a field appended as its LAST line.
  it('CONTROL — the pin reads past the conditional spread to the literal\'s own closing line', () => {
    const src = source('apps/electron/src/renderer/components/app-shell/kanban/subtask-merge.ts')
    const spread = '...(node.connection ? { connection: node.connection } : {}),'
    const planted = src.replace(spread, `${spread}\n        sessionId: node.id,`)
    expect(planted).not.toBe(src)
    const literal = pendingRowLiteral(planted)
    expect(literal).toContain('node.connection')
    expect(literal).toMatch(/\n\s*\}\)$/)
    expect(literal).toContain('sessionId')
  })
})

/**
 * The pending-row `rows.push({ … })` literal around the synthetic `node:<id>` id, or undefined. It ends at the first
 * LINE that opens with `})` — the literal's own close — never at the first `})`, which the conditional spread
 * `...(… : {}),` inside the literal also contains.
 */
function pendingRowLiteral(src: string): string | undefined {
  const at = src.indexOf('id: `node:${node.id}`')
  if (at < 0) return undefined
  const start = src.lastIndexOf('rows.push({', at)
  const close = /\n\s*\}\)/.exec(src.slice(at))
  return start < 0 || !close ? undefined : src.slice(start, at + close.index + close[0].length)
}

describe('RS-113: D control reads only after the spec fetch lands (UA12.114)', () => {
  const titles = ['A on Pi', 'B on Claude', 'C on Codex']
  const rows = titles.map(title => ({ title, interactive: false }) satisfies TileRowRead)

  it('polls a partial tile until every node has a row, returning the first full read', async () => {
    // Before the fetch lands the merge has rendered only the session-backed row (b); the fetch brings all three.
    const reads: TileRowRead[][] = [rows.slice(1), rows]
    const control = await specFetchedTileRows(() => Promise.resolve(reads.shift() ?? rows), titles, 5_000, 10)
    expect(control).toEqual(rows)
  })

  it('stays bounded when the fetch never lands: the last read wins, no row is invented, nothing throws', async () => {
    const control = await specFetchedTileRows(() => Promise.resolve(rows.slice(1)), titles, 120, 10)
    expect(control).toEqual(rows.slice(1))
  })

  it('rests on the case: the control read is the polled helper, never a single readTileRows', () => {
    expect(source('scripts/cdp/cases/rs-113.ts')).toMatch(/const controlRows = await specFetchedTileRows\(/)
  })
})

describe('RS-113: the pi-wakeup arm is authored loop-first (UA12.158)', () => {
  const arm = BACKGROUND_ARMS.find(a => a.name === 'pi-wakeup')!
  const prompt = arm.prompt('MARKER-FILE', '101500')

  it('arms the self-paced /loop before anything else, and never asks for a bare wake', () => {
    const createAt = prompt.indexOf('CronCreate')
    expect(createAt).toBeGreaterThanOrEqual(0)
    expect(prompt.slice(createAt, createAt + 80)).toMatch(/dynamic/i)
    // The bare call the shipped contract refuses (the old arm measured UNMEASURED by design): ScheduleWakeup
    // appears only as the loop's re-arm / its stop, never as a first, loopless request.
    const scheduleAt = prompt.indexOf('ScheduleWakeup')
    expect(scheduleAt).toBeGreaterThan(createAt)
  })

  it('schedules a re-arm inside the schema window and rides the wake turn for marker and WOKE', () => {
    expect(prompt).toContain('delaySeconds 60')
    // The loop's ITERATION prompt carries the producer's work — the marker and the WOKE reply — so the wake
    // turn's own door completes the node with ITS text (the UA12.156 gate arm), and it ends the loop so the
    // pending record clears and the door completes at all.
    expect(prompt).toContain('touch MARKER-FILE')
    expect(prompt).toContain('WOKE-101500')
    expect(prompt).toMatch(/stop true|stop: true/)
  })

  it('rests on the shipped contract: a loopless wake is refused by name, and a dynamic loop delivers its first iteration when the turn ends', () => {
    const manager = source('packages/server-core/src/sessions/SessionManager.ts')
    expect(manager).toContain("'No self-paced /loop is active in this session.'")
    const tools = source('packages/session-tools-core/src/tool-defs.ts')
    expect(tools).toContain('True for a self-paced /loop: no schedule — the first iteration is delivered as soon as the current turn ends')
    expect(tools).toContain("'True to end the loop: cancels the pending wakeup immediately.'")
  })

  it('BOUNDARY — the other producers keep their shapes; no other arm grew a loop', () => {
    const bare = BACKGROUND_ARMS.filter(a => a.name !== 'pi-wakeup')
    for (const other of bare) expect(other.prompt('M', 'S')).not.toContain('CronCreate')
    expect(BACKGROUND_ARMS.map(a => a.name)).toContain('pi-wakeup')
  })
})
