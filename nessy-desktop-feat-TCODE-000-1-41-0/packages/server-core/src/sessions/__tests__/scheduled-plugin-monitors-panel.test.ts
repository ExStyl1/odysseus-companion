/**
 * F1.508 (origin WJ-ak P-WJak-1, LOW) — the background-task panel lists the scheduled plugin monitors `/tasks`
 * already names (F1.502), on the RPC page ONLY.
 *
 * Left out on purpose until now: `sessions:listScheduledWork` projects `listSessionScheduledWork`, whose two arrays
 * are also the hooks' `background_tasks` / `session_crons` payload — a documented contract. So the monitors ride on
 * an OPTIONAL third array of the page (`pluginMonitors`), read through their own accessor, and the hook port is
 * untouched. The two controls the row names:
 *
 *  - the panel's page carries the monitor with its schedule (the renderer's chip + idle-tick note is pinned in
 *    `apps/electron/src/renderer/lib/__tests__/scheduled-work-chips.test.ts`);
 *  - the hook payload is byte-identical before and after a monitor is armed — driven on the real `SessionManager`.
 */
import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { registerScheduledWorkHandlers } from '../../handlers/rpc/scheduled-work.ts'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

type Handler = (ctx: unknown, value: unknown) => Promise<any>
const ctx = { clientId: 'client', workspaceId: 'ws-f1508', webContentsId: null }

function handlerOver(sessionManager: unknown): Handler {
  const handlers = new Map<string, Handler>()
  const server = { handle(channel: string, handler: Handler) { handlers.set(channel, handler) } }
  registerScheduledWorkHandlers(server as any, { sessionManager, platform: {}, oauthFlowStore: {} } as any)
  return handlers.get(RPC_CHANNELS.sessions.LIST_SCHEDULED_WORK)!
}

/**
 * An armed registration as `armPluginPeripherals` records it — with the internal fields (bundle resource, key,
 * executable hash, plugin instance) the panel must NOT carry: the page names the monitor and its schedule only.
 */
function registration(monitorId: string, cron: string, timezone?: string): never {
  return {
    monitorId, cron, ...(timezone ? { timezone } : {}), form: 'schedule',
    key: `plugin:${monitorId}`, pluginInstanceId: 'local.toolkit-1', executableHash: 'sha256:0',
    resource: { pluginInstanceId: 'local.toolkit-1', relativePath: `monitors/${monitorId}.md` },
  } as never
}

function rig() {
  const sm = createTestSessionManager() as any
  const workspace = { id: 'ws-f1508', name: 'ws-f1508', slug: 'ws-f1508', rootPath: '/tmp/ws-f1508', createdAt: Date.now() }
  const managed = createManagedSession({ id: 's1' }, workspace, { messagesLoaded: true, ephemeral: true })
  sm.sessions.set('ws-f1508:s1', managed)
  return { sm, managed }
}

describe('F1.508 — scheduled plugin monitors on the background-task panel, never on the hook port', () => {
  it('THE PANEL — the page carries the armed monitor with its schedule', async () => {
    const { sm, managed } = rig()
    try {
      managed.armedScheduledPluginMonitors = [registration('build-watch', '*/5 * * * *', 'Europe/Moscow')]
      const page = await handlerOver(sm)(ctx, 's1')
      expect(page.pluginMonitors).toEqual([{ monitorId: 'build-watch', cron: '*/5 * * * *', timezone: 'Europe/Moscow' }])
      // The monitor is not an ENTRY: entries stay the hook inventory's projection.
      expect(page.entries.some((entry: { id: string }) => entry.id.includes('build-watch'))).toBe(false)
    } finally {
      sm.cleanup()
    }
  })

  it('THE HOOK PORT — listSessionScheduledWork is byte-identical before and after a monitor is armed', async () => {
    const { sm, managed } = rig()
    try {
      const before = JSON.stringify(sm.listSessionScheduledWork('s1', 'ws-f1508'))
      managed.armedScheduledPluginMonitors = [registration('build-watch', '*/5 * * * *')]
      expect(JSON.stringify(sm.listSessionScheduledWork('s1', 'ws-f1508'))).toBe(before)
      // POSITIVE CONTROL on the same rig: the panel accessor does see it.
      expect(sm.listArmedScheduledPluginMonitors('s1', 'ws-f1508')).toEqual([{ monitorId: 'build-watch', cron: '*/5 * * * *' }])
    } finally {
      sm.cleanup()
    }
  })

  it('BOUNDARY — no armed monitor leaves the page exactly as it was; an unknown session answers undefined', async () => {
    const { sm } = rig()
    try {
      expect(await handlerOver(sm)(ctx, 's1')).toEqual({ schemaVersion: 1, entries: [] })
      expect(sm.listArmedScheduledPluginMonitors('nobody', 'ws-f1508')).toBeUndefined()
    } finally {
      sm.cleanup()
    }
  })
})
