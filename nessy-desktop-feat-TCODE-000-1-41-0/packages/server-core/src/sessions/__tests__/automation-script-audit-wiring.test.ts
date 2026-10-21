/**
 * UA8.1 — the per-workspace `AutomationSystem` that `SessionManager.setupConfigWatcher` builds is handed the
 * script-action audit port wired to `PrivilegedExecutionBroker.auditEvent` (spec §15 item 4), so every scheduled
 * or App-event script run and refusal lands in `logs/privileged-actions.jsonl`.
 *
 * A source pin rather than a behaviour test: building a real `SessionManager` to reach that construction costs the
 * 40k-line module graph, and the port's behaviour (what is reported, and that a run and a refusal both report) is
 * already pinned in `packages/shared/src/automations/script-executor.test.ts`. The pin can fail: it reads the ONE
 * `new AutomationSystem({ … })` call and requires the option inside it (the control below proves the call is found).
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../SessionManager.ts', import.meta.url), 'utf-8')

function automationSystemConstruction(): string {
  const start = SOURCE.indexOf('new AutomationSystem({')
  expect(start).toBeGreaterThan(-1)
  expect(SOURCE.indexOf('new AutomationSystem({', start + 1)).toBe(-1)
  // The options object runs to the matching `})` of the call; the onPromptsReady body is inside it.
  const end = SOURCE.indexOf('this.automationSystems.set(workspaceId, automationSystem)', start)
  expect(end).toBeGreaterThan(start)
  return SOURCE.slice(start, end)
}

describe('SessionManager wires the script-action audit port (UA8.1)', () => {
  it('control: the one AutomationSystem construction is found and carries its known enableScheduler gate', () => {
    expect(automationSystemConstruction()).toContain('enableScheduler: !isLocalAutomationManagedDisabled()')
  })

  it('the construction passes scriptAudit through to privilegedExecutionBroker.auditEvent', () => {
    expect(automationSystemConstruction()).toMatch(/scriptAudit: \(event, payload\) => this\.privilegedExecutionBroker\.auditEvent\(event, payload\)/)
  })
})
