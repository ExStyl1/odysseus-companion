/**
 * P6.416 — the `on-skill-invoke:<skill-name>` monitor trigger.
 *
 * `plugins-reference.md` gives a monitor's `when` exactly two forms: `always`,
 * which "starts it at session start and on plugin reload", and
 * `on-skill-invoke:<skill-name>`. `SessionManager`'s own docblock used to say
 * the second had "no dispatch seam here, so those monitors are imported,
 * reported deferred by the adapter, and never started". It has one now: Pi's
 * continuation boundary carries `state.invokedSkills` while the turn is still
 * running, which is what makes the monitor's output reach THAT turn.
 *
 * The subject is `ensurePluginCommandMonitors`'s SELECTION, read off the real
 * `SessionMonitorService.start` request. A monitor that is selected but whose
 * start request never names its command would look identical to a selection bug
 * from the outside, so the request is what the assertions read.
 *
 * Imports are STATIC and the session is an object literal, deliberately: a
 * `beforeAll` that imports `SessionManager.ts` costs 40s+ on a loaded box
 * against bun's 5s hook budget, and reports "0 pass, 1 fail" with no assertion
 * having run (the sibling `monitor-command-gate.test.ts` does exactly that at
 * HEAD, unmodified — the shape AGENTS.md records). Module-scope import has no
 * hook budget to blow.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import type { SessionMonitorService } from '../session-monitor-service.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const stateRoot = mkdtempSync(join(tmpdir(), 'sm-plugin-monitor-skill-'))
const workspaceRoot = join(stateRoot, 'workspace')
mkdirSync(workspaceRoot, { recursive: true })
const WORKSPACE_ID = 'ws-plugin-monitor-skill'
writeFileSync(
  join(workspaceRoot, 'config.json'),
  JSON.stringify({
    id: WORKSPACE_ID,
    name: 'Plugin Monitor Skill Trigger Workspace',
    slug: 'plugin-monitor-skill-trigger-workspace',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }, null, 2),
  'utf-8',
)

afterAll(() => rmSync(stateRoot, { recursive: true, force: true }))

interface Internals {
  sessions: Map<string, unknown>
  sessionMonitors: SessionMonitorService
  ensurePluginCommandMonitors(
    managed: unknown,
    capabilityRuntime: unknown,
    invokedSkillNames?: ReadonlySet<string>,
  ): Promise<void>
}

let sessionCounter = 0

/**
 * Three command monitors on one bundle: the documented `always`, the documented
 * skill trigger, and a skill trigger for a DIFFERENT skill — the last being what
 * separates "the trigger is read" from "any invocation starts everything".
 */
const monitorView = () => ({
  generation: 'generation-1',
  monitors: [
    { form: 'command', id: 'always-watch', monitorId: 'always-watch', pluginKey: 'acme', when: 'always', command: 'tail -F ./always.log', description: 'always' },
    { form: 'command', id: 'debug-watch', monitorId: 'debug-watch', pluginKey: 'acme', when: 'on-skill-invoke:debug', command: 'tail -F ./debug.log', description: 'debug' },
    { form: 'command', id: 'other-watch', monitorId: 'other-watch', pluginKey: 'acme', when: 'on-skill-invoke:release', command: 'tail -F ./release.log', description: 'release' },
  ] as Record<string, unknown>[],
})

function harness() {
  const manager = createTestSessionManager()
  const internals = manager as unknown as Internals
  const sessionKey = { workspaceId: WORKSPACE_ID, sessionId: `session-plugin-monitor-skill-${++sessionCounter}` }
  const managed = {
    id: sessionKey.sessionId,
    workspace: { id: sessionKey.workspaceId, rootPath: workspaceRoot },
    workingDirectory: workspaceRoot,
    permissionMode: 'default',
    isProcessing: true,
    messages: [],
    // Required on `ManagedSession` for every production session; omitting it
    // turns a recovered supervised process into an unhandled rejection charged
    // to whichever suite bun happens to be running (see managed-policy-reread).
    backgroundShellCommands: new Map<string, string>(),
  }
  internals.sessions.set(encodeSessionKey(sessionKey), managed)

  // The real service's `start` is replaced so the assertions read the REQUEST
  // rather than spawning three `tail` processes inside a test tree.
  const started: { command: string; persistent: boolean }[] = []
  ;(internals.sessionMonitors as unknown as { start: unknown }).start = async (
    request: { command?: string; persistent?: boolean },
  ) => {
    started.push({ command: String(request.command), persistent: request.persistent === true })
    return { taskId: `task-${started.length}` }
  }

  const runtime = { view: monitorView(), materializer: { assertActive: () => undefined } }
  return { manager, internals, managed, runtime, started }
}

describe('an on-skill-invoke monitor starts when its skill is invoked (P6.416)', () => {
  test('only the `always` monitor starts when no skill has been invoked', async () => {
    const h = harness()
    await h.internals.ensurePluginCommandMonitors(h.managed, h.runtime)
    expect(h.started.map(entry => entry.command)).toEqual(['tail -F ./always.log'])
    // `:290` — a monitor "runs a shell command for the lifetime of the session".
    expect(h.started.every(entry => entry.persistent)).toBe(true)
    h.manager.cleanup?.()
  })

  test('invoking the named skill starts ITS monitor and not the other trigger', async () => {
    const h = harness()
    await h.internals.ensurePluginCommandMonitors(h.managed, h.runtime, new Set(['debug']))
    expect(h.started.map(entry => entry.command).sort()).toEqual([
      'tail -F ./always.log',
      'tail -F ./debug.log',
    ])
    h.manager.cleanup?.()
  })

  test('a second invocation of the same skill starts nothing more', async () => {
    // `:322` — the monitor name "Prevents duplicate processes when the plugin
    // reloads". The same `started` map that gives `always` start-once has to
    // give it to the trigger, or a skill invoked in a loop spawns one process
    // per call.
    const h = harness()
    await h.internals.ensurePluginCommandMonitors(h.managed, h.runtime, new Set(['debug']))
    const afterFirst = h.started.length
    expect(afterFirst).toBe(2)
    await h.internals.ensurePluginCommandMonitors(h.managed, h.runtime, new Set(['debug']))
    expect(h.started).toHaveLength(afterFirst)
    h.manager.cleanup?.()
  })

  test('an unrelated invoked skill starts no trigger', async () => {
    const h = harness()
    await h.internals.ensurePluginCommandMonitors(h.managed, h.runtime, new Set(['unrelated']))
    expect(h.started.map(entry => entry.command)).toEqual(['tail -F ./always.log'])
    h.manager.cleanup?.()
  })

  test('an empty trigger name matches nothing, so `on-skill-invoke:` alone never fires', async () => {
    const h = harness()
    h.runtime.view.monitors.push({
      form: 'command', id: 'empty', monitorId: 'empty', pluginKey: 'acme',
      when: 'on-skill-invoke:', command: 'tail -F ./empty.log', description: 'empty',
    })
    // The schema refuses this shape at parse (`plugin.monitor.invalid_when`), so
    // it can only arrive from a source that bypassed it — and it must not become
    // a wildcard that starts on every skill.
    await h.internals.ensurePluginCommandMonitors(h.managed, h.runtime, new Set(['', 'debug']))
    expect(h.started.map(entry => entry.command)).not.toContain('tail -F ./empty.log')
    h.manager.cleanup?.()
  })
})
