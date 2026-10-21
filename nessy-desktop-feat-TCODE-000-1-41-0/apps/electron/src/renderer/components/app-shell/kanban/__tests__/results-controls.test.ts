/**
 * UA4.4 — the Run UI's renderer half (plan UA4.4 "Tests", `results-controls.test.ts`): the Results tab's run controls
 * and the one run path the tile's Play and the editor's Create & Run / Save & Run take (`run-controls.ts`).
 * The host half — `tasks:run` refusing an unconfirmed spec — is `server-core/.../tasks-run-confirmation.test.ts`.
 *
 * Positive: paused or interrupted → Resume (and Stop); running → Pause (and Stop); a confirmed run carries the digest
 * the user saw; a spec that needs no confirmation runs at once; the confirmation names a node's connection, runtime
 * and the workspace default.
 * Negative: terminal or no run → no controls; an agent-created spec shows the confirmation (the tile and the editor
 * share this path — pinned on their source) and a declined one sends no run; an on-disk edit between the read and the
 * run (the host's `run-confirmation-required`) asks again with the new digest; any other run error is not retried.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskRunConfirmationDto, TaskRunRequest } from '@nessy-agent/shared/protocol'
import { describeConfirmationNode, resolveRunControls, startTaskRun, type TaskRunApi } from '../run-controls'
import type { TaskModelGroup } from '../model-catalog'

const confirmation = (digest: string): TaskRunConfirmationDto => ({
  digest,
  nodeCount: 1,
  nodes: [{ id: 'main', title: 'Main' }],
  sources: [],
})

/** A fake `electronAPI`: each `getTask` answers the next scripted reply; `runTask` records and answers or throws. */
function fakeApi(replies: Array<{ needsRunConfirmation: boolean; runConfirmation?: TaskRunConfirmationDto }>, runErrors: Error[] = []) {
  const runs: TaskRunRequest[] = []
  let gets = 0
  const api: TaskRunApi = {
    getTask: async () => replies[Math.min(gets++, replies.length - 1)]!,
    runTask: async (_ws, req) => {
      runs.push(req)
      const error = runErrors.shift()
      if (error) throw error
      return { slug: req.slug, runId: 'r1', taskId: req.slug, status: 'running', nodes: [], tokensUsed: 0 }
    },
  }
  return { api, runs, gets: () => gets }
}

describe('UA4.4 — resolveRunControls', () => {
  it('POSITIVE: paused or interrupted → Resume (and Stop); running → Pause (and Stop); verifying → Stop', () => {
    expect(resolveRunControls('paused')).toEqual(['resume', 'stop'])
    expect(resolveRunControls('interrupted')).toEqual(['resume', 'stop'])
    expect(resolveRunControls('running')).toEqual(['pause', 'stop'])
    expect(resolveRunControls('verifying')).toEqual(['stop'])
  })

  it('NEGATIVE: a terminal run, or no run, offers no controls', () => {
    for (const status of ['completed', 'failed', 'stopped', undefined]) expect(resolveRunControls(status)).toEqual([])
  })
})

describe('UA4.4 — startTaskRun (the tile\'s Play and the editor\'s run)', () => {
  it('POSITIVE: a spec a human saved runs at once, with no confirmation and no digest', async () => {
    const { api, runs } = fakeApi([{ needsRunConfirmation: false }])
    let asked = 0
    const snap = await startTaskRun(api, 'ws', { slug: 't', orchestratorSessionId: 'o' }, async () => { asked++; return true })
    expect(snap?.runId).toBe('r1')
    expect(asked).toBe(0)
    expect(runs).toEqual([{ slug: 't', orchestratorSessionId: 'o' }])
  })

  it('NEGATIVE: an agent-created spec shows the confirmation; confirmed, the run carries the digest shown', async () => {
    const { api, runs } = fakeApi([{ needsRunConfirmation: true, runConfirmation: confirmation('sha256:aaa') }])
    const shown: TaskRunConfirmationDto[] = []
    await startTaskRun(api, 'ws', { slug: 't', orchestratorSessionId: 'o' }, async (c) => { shown.push(c); return true })
    expect(shown.map(c => c.digest)).toEqual(['sha256:aaa'])
    expect(runs).toEqual([{ slug: 't', orchestratorSessionId: 'o', confirmedDigest: 'sha256:aaa' }])
  })

  it('NEGATIVE: a declined confirmation sends no run', async () => {
    const { api, runs } = fakeApi([{ needsRunConfirmation: true, runConfirmation: confirmation('sha256:aaa') }])
    expect(await startTaskRun(api, 'ws', { slug: 't', orchestratorSessionId: 'o' }, async () => false)).toBeNull()
    expect(runs).toEqual([])
  })

  it('NEGATIVE: an on-disk edit between the read and the run re-asks with the new digest', async () => {
    const { api, runs } = fakeApi(
      [{ needsRunConfirmation: false }, { needsRunConfirmation: true, runConfirmation: confirmation('sha256:bbb') }],
      [new Error('run-confirmation-required: t')],
    )
    const shown: string[] = []
    const snap = await startTaskRun(api, 'ws', { slug: 't', orchestratorSessionId: 'o' }, async (c) => { shown.push(c.digest); return true })
    expect(snap?.runId).toBe('r1')
    expect(shown).toEqual(['sha256:bbb'])
    expect(runs.map(r => r.confirmedDigest)).toEqual([undefined, 'sha256:bbb'])
  })

  it('NEGATIVE: another run error is not retried; a host that asks with nothing to show is a refusal', async () => {
    const other = fakeApi([{ needsRunConfirmation: false }], [new Error('already has an active run')])
    await expect(startTaskRun(other.api, 'ws', { slug: 't', orchestratorSessionId: 'o' }, async () => true)).rejects.toThrow('already has an active run')
    expect(other.gets()).toBe(1)
    const bare = fakeApi([{ needsRunConfirmation: true }])
    await expect(startTaskRun(bare.api, 'ws', { slug: 't', orchestratorSessionId: 'o' }, async () => true)).rejects.toThrow('run-confirmation-required')
    expect(bare.runs).toEqual([])
  })

  it('NEGATIVE: the tile and the editor both run through startTaskRun — neither calls runTask itself', () => {
    for (const file of ['KanbanBoardContainer.tsx', 'TaskEditor.tsx']) {
      const source = readFileSync(join(import.meta.dir, '..', file), 'utf-8')
      expect({ file, viaConfirmation: source.includes('startTaskRun(') }).toEqual({ file, viaConfirmation: true })
      expect({ file, direct: /electronAPI\s*\.\s*runTask\(/.test(source) }).toEqual({ file, direct: false })
    }
  })
})

describe('UA4.4 — describeConfirmationNode', () => {
  const groups = [
    { provider: 'pi', label: 'Nessy Gateway', models: [], connectionSlug: 'gw', runtime: 'pi' },
    { provider: 'anthropic', label: 'Claude Code', models: [], connectionSlug: 'cc', runtime: 'anthropic' },
  ] as unknown as TaskModelGroup[]

  it('POSITIVE: a named connection shows its name and runtime; none → the workspace default\'s, marked as such', () => {
    expect(describeConfirmationNode({ llmConnection: 'cc' }, groups, 'gw')).toEqual({ connectionLabel: 'Claude Code', runtime: 'anthropic', workspaceDefault: false })
    expect(describeConfirmationNode({}, groups, 'gw')).toEqual({ connectionLabel: 'Nessy Gateway', runtime: 'pi', workspaceDefault: true })
  })

  it('NEGATIVE: a connection the catalogue does not list shows its slug and no runtime', () => {
    expect(describeConfirmationNode({ llmConnection: 'gone' }, groups, 'gw')).toEqual({ connectionLabel: 'gone', workspaceDefault: false })
    expect(describeConfirmationNode({}, groups, undefined)).toEqual({ workspaceDefault: true })
  })
})
