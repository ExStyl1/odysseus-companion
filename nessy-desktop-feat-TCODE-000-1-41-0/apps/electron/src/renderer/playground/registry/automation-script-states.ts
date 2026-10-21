/**
 * UA8.3 follow-up — the script action on the `automation-info-page` playground entry (`automations.tsx`): the
 * `scriptApproval` knob, the script automation and its history, and one variant per approval state. Upstream
 * v0.13.4 has no script action, so this file is ours. It sits apart from `automations.tsx` so its test can import it
 * without the registry's whole graph (which pulls a Vite-only `?url` import bun cannot load), and so the cited lines
 * of `automations.tsx` (119, 214) keep their numbers.
 *
 * The knob covers every place a script action's bytes can stand (`ScriptActionDetails`): the host ledger's five
 * states plus `unknown` — the host read no state, and the row says so and offers nothing. Unapproved and changed
 * offer Approve. The history is built as `useAutomations` builds it (`scriptHistorySummary`), so a run the host
 * refused names the executor's own reason.
 */
import { scriptHistorySummary, type AutomationListItem, type ExecutionEntry, type ScriptAction } from '@/components/automations/types'

export type ScriptApprovalKnob = 'unapproved' | 'changed' | 'approved' | 'missing' | 'outside' | 'unknown'

export const SCRIPT_APPROVAL_OPTIONS: Array<{ label: string; value: ScriptApprovalKnob }> = [
  { label: 'Unapproved (Approve)', value: 'unapproved' },
  { label: 'Changed since approval (Approve)', value: 'changed' },
  { label: 'Approved', value: 'approved' },
  { label: 'Missing file', value: 'missing' },
  { label: 'Outside the workspace', value: 'outside' },
  { label: 'No state read', value: 'unknown' },
]

/** A placeholder digest of the script's current bytes (the one Approve names). */
export const MOCK_SCRIPT_SHA256 = '9c56cc51b374c3ba189210d5b6d4bf57790d351c96c47c02190ecf1e430635ab'

export const MOCK_SCRIPT_PATH = 'scripts/audit-deps.ts'

function scriptApprovalFor(knob: ScriptApprovalKnob): ScriptAction['approval'] {
  if (knob === 'unknown') return undefined
  // The host has no bytes to hash for a missing file or a path outside the workspace.
  if (knob === 'missing' || knob === 'outside') return { state: knob }
  return { state: knob, sha256: MOCK_SCRIPT_SHA256 }
}

/** The knob applied to every script action of the automation; prompt and webhook actions are left as they are. */
export function withScriptApproval(automation: AutomationListItem, knob: ScriptApprovalKnob): AutomationListItem {
  if (!automation.actions.some(a => a.type === 'script')) return automation
  return {
    ...automation,
    actions: automation.actions.map(action => {
      if (action.type !== 'script') return action
      const { approval: _previous, ...rest } = action
      const approval = scriptApprovalFor(knob)
      return approval ? { ...rest, approval } : rest
    }),
  }
}

const now = Date.now()

export const mockScriptAutomation: AutomationListItem = {
  id: 'automation-script',
  event: 'SchedulerTick',
  matcherIndex: 0,
  name: 'Nightly dependency audit',
  summary: 'Daily at 2:00 AM',
  enabled: true,
  cron: '0 2 * * *',
  timezone: 'Europe/Budapest',
  actions: [{ type: 'script', script: MOCK_SCRIPT_PATH, args: ['--json'], runtime: 'bun', timeoutMs: 120_000 }],
  labels: ['Scheduled'],
  lastExecutedAt: now - 3600_000,
}

/** Two runs the host refused (the executor's own sentences, `script-executor.ts`) and one that ran. */
export const mockScriptExecutions: ExecutionEntry[] = [
  {
    id: 'ex-s1', automationId: 'automation-script', event: 'SchedulerTick', status: 'blocked', duration: 0, timestamp: now - 3600_000,
    actionSummary: scriptHistorySummary({ script: MOCK_SCRIPT_PATH, blocked: true }, `Script changed since it was approved: ${MOCK_SCRIPT_PATH} — approve the new version before it can run`),
  },
  {
    id: 'ex-s2', automationId: 'automation-script', event: 'SchedulerTick', status: 'success', duration: 1840, timestamp: now - 86400_000,
    actionSummary: scriptHistorySummary({ script: MOCK_SCRIPT_PATH }, undefined),
  },
  {
    id: 'ex-s3', automationId: 'automation-script', event: 'SchedulerTick', status: 'blocked', duration: 0, timestamp: now - 2 * 86400_000,
    actionSummary: scriptHistorySummary({ script: MOCK_SCRIPT_PATH, blocked: true }, `Script not approved: ${MOCK_SCRIPT_PATH} — approve it before it can run`),
  },
]

/** One `automation-info-page` variant per approval state. */
export function scriptInfoPageVariants(): Array<{ name: string; description: string; props: Record<string, unknown> }> {
  return SCRIPT_APPROVAL_OPTIONS.map(({ label, value }) => ({
    name: `Script · ${label}`,
    description: 'A scheduled script action; the history shows two runs the host refused, with its reason, and one that ran',
    props: { automation: mockScriptAutomation, executions: mockScriptExecutions, scriptApproval: value },
  }))
}
