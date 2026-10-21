/**
 * UA8.3 follow-up — the canonical `automation-info-page` playground entry (`registry/automations.tsx`) reaches the
 * script action UA8.3 shipped: a `scriptApproval` knob over the six places a script's bytes can stand (the host
 * ledger's five states plus no state read), one variant per state, and a history whose refused runs name the host's
 * reason (`scriptHistorySummary`, as `useAutomations` builds it).
 *
 * Positive: one variant per state, each rendering its state marker through the shipped `AutomationActionRow`;
 * unapproved and changed offer Approve carrying the shown digest; the history names both refusal reasons; the entry
 * declares the knob and mounts the knob's wrapper. Negative / boundary: approved, missing, outside and no-state offer
 * no Approve; the knob leaves a prompt-only automation untouched.
 *
 * The data lives in `registry/automation-script-states.ts`, imported here alone: the registry's own graph pulls a
 * Vite-only `?url` import (pdfjs) bun cannot load, so the entry's wiring is pinned in its SOURCE, and
 * `registry-render.test.ts` renders every variant of it through the real frame. Rendered with
 * `renderToStaticMarkup`; nothing here reads a label.
 */
import { createElement } from 'react'
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { AutomationActionRow } from '@/components/automations/AutomationActionRow'
import type { AutomationListItem, ScriptAction } from '@/components/automations/types'
import {
  MOCK_SCRIPT_SHA256,
  SCRIPT_APPROVAL_OPTIONS,
  mockScriptAutomation,
  mockScriptExecutions,
  scriptInfoPageVariants,
  withScriptApproval,
  type ScriptApprovalKnob,
} from '../registry/automation-script-states'

const KNOBS: readonly ScriptApprovalKnob[] = ['unapproved', 'changed', 'approved', 'missing', 'outside', 'unknown']
/**
 * The row's one button is Approve (matched by element, not label: another file in the same run may initialise i18n).
 * UB14.44: Approve is the `Button` primitive (v0.15.1 restyle), whose element opens with its slot and variant.
 */
const APPROVE = '<button data-slot="button" data-variant="primary"'

function renderScriptRow(knob: ScriptApprovalKnob): string {
  const action = withScriptApproval(mockScriptAutomation, knob).actions[0] as ScriptAction
  return renderToStaticMarkup(createElement(AutomationActionRow, {
    action,
    index: 0,
    onApproveScript: async () => ({ state: 'approved' as const, sha256: MOCK_SCRIPT_SHA256 }),
  }))
}

const count = (html: string, needle: string) => html.split(needle).length - 1

describe('UA8.3 follow-up — automation-info-page sweeps the script action', () => {
  it('POSITIVE — the knob covers the six states and one variant per state carries the script automation', () => {
    expect(SCRIPT_APPROVAL_OPTIONS.map(o => o.value)).toEqual([...KNOBS])
    const variants = scriptInfoPageVariants()
    expect(variants.map(v => v.props.scriptApproval)).toEqual([...KNOBS])
    for (const v of variants) {
      expect(v.name.startsWith('Script · ')).toBe(true)
      expect(v.props.automation).toBe(mockScriptAutomation)
      expect(v.props.executions).toBe(mockScriptExecutions)
    }
  })

  it('POSITIVE — each state renders its marker; unapproved and changed offer Approve naming the shown digest', () => {
    for (const knob of KNOBS) {
      const html = renderScriptRow(knob)
      expect(html).toContain(`data-script-approval="${knob}"`)
      expect(html).toContain('scripts/audit-deps.ts --json')
      const offersApprove = knob === 'unapproved' || knob === 'changed'
      expect(count(html, APPROVE)).toBe(offersApprove ? 1 : 0)
      if (offersApprove) expect(html).toContain(`title="sha256 ${MOCK_SCRIPT_SHA256}"`)
    }
  })

  it('POSITIVE — the history names the host\'s refusal reasons; the run that ran names only its script', () => {
    const lines = mockScriptExecutions.map(e => [e.status, e.actionSummary])
    expect(lines).toEqual([
      ['blocked', 'Script scripts/audit-deps.ts — Script changed since it was approved: scripts/audit-deps.ts — approve the new version before it can run'],
      ['success', 'Script scripts/audit-deps.ts'],
      ['blocked', 'Script scripts/audit-deps.ts — Script not approved: scripts/audit-deps.ts — approve it before it can run'],
    ])
  })

  it('NEGATIVE — the knob leaves a prompt-only automation untouched, and drops a stale approval on no state', () => {
    const prompt: AutomationListItem = { ...mockScriptAutomation, actions: [{ type: 'prompt', prompt: 'Summarise today' }] }
    for (const knob of KNOBS) expect(withScriptApproval(prompt, knob)).toBe(prompt)
    const stale: AutomationListItem = {
      ...mockScriptAutomation,
      actions: [{ ...(mockScriptAutomation.actions[0] as ScriptAction), approval: { state: 'approved', sha256: MOCK_SCRIPT_SHA256 } }],
    }
    expect((withScriptApproval(stale, 'unknown').actions[0] as ScriptAction).approval).toBeUndefined()
  })

  it('the canonical entry declares the knob, mounts its wrapper and spreads the script variants (source pin)', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'registry', 'automations.tsx'), 'utf8')
    const start = source.indexOf("id: 'automation-info-page'")
    expect(start).toBeGreaterThan(0)
    const body = source.slice(start, source.indexOf("id: 'automation-card'", start))
    expect(body).toContain('component: AutomationInfoPageScriptPlayground,')
    expect(body).toContain("name: 'scriptApproval'")
    expect(body).toContain('options: SCRIPT_APPROVAL_OPTIONS')
    expect(body).toContain('...scriptInfoPageVariants(),')
    expect(source).toContain('withScriptApproval(automation, scriptApproval)')
    expect(source).toContain("overrideElectronApiMethod('approveAutomationScript'")
  })
})
