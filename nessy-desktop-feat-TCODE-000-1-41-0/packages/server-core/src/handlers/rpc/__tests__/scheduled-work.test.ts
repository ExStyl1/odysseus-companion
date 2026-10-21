/**
 * D1.97 + D1.98 · the read answers THREE states and never merges two of them.
 *
 * The whole hazard of a flat list is that "nothing is queued", "this host
 * cannot answer" and "no such session" all render as an empty array unless the
 * handler distinguishes them. A panel fed the merged answer tells a user
 * nothing is running about a session it never asked — which is the failure
 * `stopAllBackgroundWork`'s own `nothing-to-stop` refusal exists to avoid, one
 * surface over.
 *
 * The `not-supported` arm is not hypothetical: `listSessionScheduledWork` is
 * OPTIONAL on `ISessionManager`, so a host composing a session manager without
 * it is a real configuration and the case drives exactly that object.
 */
import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { registerScheduledWorkHandlers } from '../scheduled-work'

type Handler = (ctx: unknown, value: unknown) => Promise<any>

function rig(sessionManager: unknown): Handler {
  const handlers = new Map<string, Handler>()
  const server = { handle(channel: string, handler: Handler) { handlers.set(channel, handler) } }
  registerScheduledWorkHandlers(server as any, { sessionManager, platform: {}, oauthFlowStore: {} } as any)
  return handlers.get(RPC_CHANNELS.sessions.LIST_SCHEDULED_WORK)!
}

const ctx = { clientId: 'client', workspaceId: 'w', webContentsId: null }

describe('D1.97/D1.98 · sessions:listScheduledWork', () => {
  it('projects both inventories into one flat list, watches under the documented name', async () => {
    const handler = rig({
      listSessionScheduledWork: (sessionId: string, workspaceId?: string) => {
        // The scope really is forwarded: a read that dropped the workspace would
        // answer for whichever session id collided first.
        expect([sessionId, workspaceId]).toEqual(['s1', 'w'])
        return {
          tasks: [{ id: 'mon_1', type: 'monitor', status: 'running', description: 'watch the build log', server: 'example.test', tool: 'ws' }],
          crons: [{ id: 'cron_1', schedule: '0 9 * * *', recurring: true, prompt: 'nightly review' }],
        }
      },
    })
    const page = await handler(ctx, 's1')
    expect(page.unavailable).toBeUndefined()
    expect(page.entries.map((entry: { id: string }) => entry.id)).toEqual(['mon_1', 'cron_1'])
    expect(page.entries[0]).toMatchObject({ type: 'monitor', status: 'running', server: 'example.test' })
    expect(page.entries[1]).toMatchObject({ type: 'scheduled', status: 'scheduled', recurring: true })
  })

  it('separates an EMPTY session from one this host cannot answer for', async () => {
    const empty = await rig({ listSessionScheduledWork: () => ({ tasks: [], crons: [] }) })(ctx, 's1')
    expect(empty).toEqual({ schemaVersion: 1, entries: [] })

    // A session manager WITHOUT the optional accessor — the real shape of a host
    // that has not implemented it.
    const unsupported = await rig({})(ctx, 's1')
    expect(unsupported.entries).toEqual([])
    expect(unsupported.unavailable).toBe('not-supported')
    // The pair is the assertion: same empty array, different verdict.
    expect(empty.unavailable).toBeUndefined()
  })

  it('names a session id nothing owns, rather than answering for it', async () => {
    const page = await rig({ listSessionScheduledWork: () => undefined })(ctx, 'ghost')
    expect(page).toEqual({ schemaVersion: 1, entries: [], unavailable: 'session-not-found' })
  })
})
