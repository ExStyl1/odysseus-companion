/**
 * UA8.2 follow-up — the ONE production path that makes a refresh approval (or an edit) take effect is
 * `SessionManager.setupConfigWatcher`'s `onPagesListChange`, which rebuilds the workspace AutomationSystem's
 * `page:<slug>` matchers (`reloadPageRefreshMatchers`). `pages:approveRefresh` relies on it: it records the approval
 * and then only calls `notifyConfigFileChange(workspaceId, 'pages/<slug>/refresh.ts')`.
 *
 * `packages/shared/src/pages/refresh-consent.test.ts` calls `reloadPageRefreshMatchers()` directly and
 * `packages/shared/src/config/__tests__/watcher-pages.test.ts` pins the watcher half, so neither can see that hop.
 * This file drives a REAL `SessionManager` through the same notify `pages:approveRefresh` uses.
 *
 * - control: right after the construction's own reload settles, the unapproved refresh has no matcher (so a matcher
 *   seen later came from the notify, not from the construction).
 * - positive: approve, notify `pages/<slug>/refresh.ts` → `getMatchersForEvent('SchedulerTick')` gains `page:<slug>`.
 * - negative: edit `refresh.ts`, notify the same path → the matcher is dropped (the approval no longer matches).
 *
 * The key provider is installed through the ledger's one port (`setHostApprovalsKeyProvider`), which is where the
 * SessionManager-built system reads it (it passes no `scriptApprovalsKeyProvider`), and restored after each case.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setHostApprovalsKeyProvider } from '@nessy-agent/shared/approvals/host-approvals'
import {
  approvePageRefresh,
  createPage,
  pageRefreshMatcherId,
  pageRefreshScriptPath,
  setPageRefresh,
} from '@nessy-agent/shared/pages'
import type { SessionManager } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

interface MatcherProbe {
  getMatchersForEvent(event: 'SchedulerTick'): Array<{ id?: string }>
  reloadPageRefreshMatchers(): Promise<number>
}

interface ManagerInternals {
  automationSystems: Map<string, MatcherProbe>
}

const KEY = randomBytes(32)
const WORKSPACE_ID = 'ws-ua82-wiring'
const roots: string[] = []
const managers: SessionManager[] = []

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.cleanup().catch(() => undefined)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  setHostApprovalsKeyProvider(undefined)
})

function matcherIds(system: MatcherProbe): string[] {
  return system.getMatchersForEvent('SchedulerTick').map(matcher => matcher.id ?? '')
}

/** Poll (the watcher debounces 100 ms, then the reload awaits the key) until `want` holds or the deadline passes. */
async function settle(system: MatcherProbe, want: (ids: string[]) => boolean): Promise<string[]> {
  const deadline = Date.now() + 3_000
  let ids = matcherIds(system)
  while (!want(ids) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
    ids = matcherIds(system)
  }
  return ids
}

describe('SessionManager reloads page-refresh matchers on a pages change (UA8.2 follow-up)', () => {
  it('an approval reaches the scheduler through notifyConfigFileChange, and an edit through the same notify drops it', async () => {
    setHostApprovalsKeyProvider({ getKey: async () => KEY })
    const root = mkdtempSync(join(tmpdir(), 'nessy-page-refresh-wiring-'))
    roots.push(root)
    const workspaceRoot = join(root, 'workspace')
    mkdirSync(workspaceRoot, { recursive: true })
    const page = createPage(workspaceRoot, { name: 'Wired', content: '<p>x</p>' })
    setPageRefresh(workspaceRoot, page.slug, { cron: '*/15 * * * *', scriptContent: 'console.log(1)' })

    const manager = createTestSessionManager()
    managers.push(manager)
    manager.setupConfigWatcher(workspaceRoot, WORKSPACE_ID)
    const system = (manager as unknown as ManagerInternals).automationSystems.get(WORKSPACE_ID)
    expect(system).toBeDefined()

    // Control: settle the construction's reload (a newer reload wins over an older one) — unapproved, no matcher.
    await system!.reloadPageRefreshMatchers()
    expect(matcherIds(system!)).toEqual([])

    // Positive: the pages:approveRefresh sequence — record the approval, then poke the watcher on refresh.ts.
    expect(approvePageRefresh(workspaceRoot, KEY, page.slug).state).toBe('approved')
    manager.notifyConfigFileChange(WORKSPACE_ID, pageRefreshScriptPath(page.slug))
    const matcherId = pageRefreshMatcherId(page.slug)
    expect(await settle(system!, ids => ids.includes(matcherId))).toEqual([matcherId])

    // Negative: any writer edits the script; the same notify drops the matcher.
    writeFileSync(join(workspaceRoot, pageRefreshScriptPath(page.slug)), 'console.log(2)')
    manager.notifyConfigFileChange(WORKSPACE_ID, pageRefreshScriptPath(page.slug))
    expect(await settle(system!, ids => ids.length === 0)).toEqual([])
  })
})
