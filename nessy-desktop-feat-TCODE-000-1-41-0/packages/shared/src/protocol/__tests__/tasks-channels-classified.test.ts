/**
 * UA3.3 — the durable `tasks:*` family (ported from craft-agents-oss v0.13.4 `channels.ts` + `routing.ts`,
 * Apache-2.0, plus our `tasks:delete`) is declared and classified, and the background-output read
 * `tasks:getOutput` — which shares the namespace by history only (spec §22 item 8) — keeps its class and its
 * module.
 *
 * Positive: the twelve durable channels exist with their exact wire strings and each routes to the workspace
 * server (upstream classifies every one REMOTE_ELIGIBLE, the `tasks:generated` push included).
 * Negative: `tasks:getOutput` keeps its key, wire string, class and handler module (`rpc/sessions.ts`), and the
 * family is exactly twelve — a stray `tasks:*` string is neither declared nor routed.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAllChannelValues, RPC_CHANNELS } from '../channels'
import { channelLocality, LOCAL_ONLY_CHANNELS, REMOTE_ELIGIBLE_CHANNELS } from '../routing'

const DURABLE_TASK_CHANNELS = [
  'tasks:create',
  'tasks:delete',
  'tasks:generate',
  'tasks:generated',
  'tasks:get',
  'tasks:getResults',
  'tasks:list',
  'tasks:pause',
  'tasks:resume',
  'tasks:run',
  'tasks:stop',
  'tasks:validate',
]

const SESSIONS_RPC = join(import.meta.dir, '..', '..', '..', '..', 'server-core', 'src', 'handlers', 'rpc', 'sessions.ts')

describe('UA3.3 — the durable tasks:* channels are declared and classified', () => {
  it('declares exactly the twelve durable channels beside tasks:getOutput', () => {
    const { GET_OUTPUT, ...durable } = RPC_CHANNELS.tasks
    expect(GET_OUTPUT).toBe('tasks:getOutput')
    const declared: string[] = Object.values(durable).sort()
    expect(declared).toEqual(DURABLE_TASK_CHANNELS)
    const all = getAllChannelValues()
    for (const channel of DURABLE_TASK_CHANNELS) expect(all).toContain(channel)
  })

  it('routes every durable channel to the workspace server (REMOTE_ELIGIBLE, never LOCAL_ONLY)', () => {
    for (const channel of DURABLE_TASK_CHANNELS) {
      expect(channelLocality(channel)).toBe('workspace')
      expect(REMOTE_ELIGIBLE_CHANNELS.has(channel)).toBe(true)
      expect(LOCAL_ONLY_CHANNELS.has(channel)).toBe(false)
    }
  })

  it('NEGATIVE: tasks:getOutput keeps its class and its module (rpc/sessions.ts), and is not a durable channel', () => {
    expect(DURABLE_TASK_CHANNELS).not.toContain('tasks:getOutput')
    expect(channelLocality('tasks:getOutput')).toBe('workspace')
    const sessions = readFileSync(SESSIONS_RPC, 'utf-8')
    const handled = sessions.slice(sessions.indexOf('export const HANDLED_CHANNELS'), sessions.indexOf('] as const', sessions.indexOf('export const HANDLED_CHANNELS')))
    expect(handled).toContain('RPC_CHANNELS.tasks.GET_OUTPUT,')
    expect(sessions).toContain('server.handle(RPC_CHANNELS.tasks.GET_OUTPUT,')
  })

  it('NEGATIVE: a tasks:* string outside the family is neither declared nor routed', () => {
    expect(getAllChannelValues()).not.toContain('tasks:bogus')
    expect(channelLocality('tasks:bogus')).toBe('unclassified')
  })
})
