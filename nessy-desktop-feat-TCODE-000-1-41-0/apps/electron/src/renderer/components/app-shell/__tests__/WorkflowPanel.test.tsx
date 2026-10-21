import * as React from 'react'
import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ActivityItem } from '@nessy-agent/ui/chat/TurnCard'
import { WorkflowPanel, workflowRecipeSource } from '../WorkflowPanel'

const translations = {
  'turnCard.workflow.budgetExceeded': 'Budget exceeded',
  'turnCard.workflow.cancelNote': 'Stopping the turn aborts running workflow children.',
  'turnCard.workflow.column.agent': 'Agent',
  'turnCard.workflow.column.time': 'Time',
  'turnCard.workflow.column.tokens': 'Tokens',
  'turnCard.workflow.column.tools': 'Tools',
  'turnCard.workflow.elapsed': 'Elapsed {{elapsed}}',
  'turnCard.workflow.error': 'Error',
  'turnCard.workflow.keepFailed': 'Could not keep this workflow',
  'turnCard.workflow.keepPersonal': 'Keep for me',
  'turnCard.workflow.keepProject': 'Keep in project',
  'turnCard.workflow.keepSaved': 'Kept — run it later with /{{name}}',
  'turnCard.workflow.logs': 'Logs',
  'turnCard.workflow.openDetails': 'Open workflow result',
  'turnCard.workflow.phase.agentCount_one': '{{count}} agent',
  'turnCard.workflow.phase.agentCount_other': '{{count}} agents',
  'turnCard.workflow.phase.default': 'Start',
  'turnCard.workflow.phase.pending': 'Pending',
  'turnCard.workflow.phase.toggle': 'Toggle phase {{phase}}',
  'turnCard.workflow.result': 'Result',
  'turnCard.workflow.resume': 'Resume',
  'turnCard.workflow.resumePrompt': 'Resume workflow run {{runId}} using the workflow tool with resumeRunId "{{runId}}".',
  'turnCard.workflow.resumedFrom': 'Resumed from {{runId}}',
  'turnCard.workflow.runId': 'Run ID',
  // P6.305: the activity slot's keys, so this suite asserts the SENTENCE the
  // user reads rather than the key name.
  'turnCard.orchestration.activity.title': 'Last activity: {{raw}}',
  'turnCard.orchestration.activity.tool': 'Running a tool',
  'turnCard.workflow.status.aborted': 'Aborted',
  'turnCard.workflow.status.done': 'Done',
  'turnCard.workflow.status.error': 'Error',
  'turnCard.workflow.status.queued': 'Queued',
  'turnCard.workflow.status.running': 'Running',
  'turnCard.workflow.summary_one': '{{count}} phase · {{agents}} agents',
  'turnCard.workflow.summary_other': '{{count}} phases · {{agents}} agents',
  'turnCard.workflow.title': 'Workflow',
  'turnCard.workflow.toggle': 'Toggle workflow details',
  'turnCard.workflow.tokens': '{{input}} in / {{output}} out',
  'turnCard.workflow.tokensNoBudget': '{{spent}} tokens',
  'turnCard.workflow.tokensWithBudget': '{{spent}} / {{budget}} tokens',
}

let testI18n: I18nInstance
const realDateNow = Date.now

function setNow(iso: string) {
  Date.now = () => new Date(iso).getTime()
}

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n
    .use(initReactI18next)
    .init({
      lng: 'en',
      fallbackLng: 'en',
      resources: { en: { translation: translations } },
      interpolation: { escapeValue: false },
    })
})

afterEach(() => {
  Date.now = realDateNow
})

function createWorkflowActivity(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: 'activity-1',
    type: 'tool',
    status: 'running',
    toolName: 'workflow',
    timestamp: 1700000000000,
    toolInput: {
      tokenBudget: 100,
    },
    orchestrationProgress: {
      kind: 'workflow',
      runId: 'workflow-run-1',
      agents: [
        {
          id: 'workflow-run-1-1',
          label: 'Scout',
          agentType: 'scout',
          phase: 'discover',
          status: 'done',
          tokensIn: 10,
          tokensOut: 2,
          toolCalls: 1,
          lastActivity: 'done',
        },
        {
          id: 'workflow-run-1-2',
          label: 'Reviewer',
          agentType: 'reviewer',
          phase: 'review',
          status: 'running',
          tokensIn: 7,
          tokensOut: 0,
          toolCalls: 2,
          lastActivity: 'message_update',
          startedAt: '2026-07-06T12:00:00.000Z',
        },
      ],
    },
    ...overrides,
  }
}

function renderWorkflowPanel(activity: ActivityItem, defaultExpanded = true): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <WorkflowPanel
        activity={activity}
        defaultExpanded={defaultExpanded}
        onInsertResumePrompt={() => {}}
      />
    </I18nextProvider>
  )
}

describe('WorkflowPanel', () => {
  it('renders a running multi-phase workflow with token budget and cancel note', () => {
    setNow('2026-07-06T12:01:05.000Z')
    const html = renderWorkflowPanel(createWorkflowActivity())

    expect(html).toContain('Workflow')
    expect(html).toContain('workflow-run-1')
    expect(html).toContain('2 phases')
    expect(html).toContain('19 / 100 tokens')
    expect(html).toContain('discover')
    expect(html).toContain('review')
    expect(html).toContain('Scout')
    expect(html).toContain('Reviewer')
    expect(html).toContain('1m 5s')
    expect(html).toContain('Stopping the turn aborts running workflow children.')
  })

  it('renders rich workflow columns with tool counts, run elapsed, and phase toggles', () => {
    setNow('2026-07-06T12:03:00.000Z')
    const html = renderWorkflowPanel(createWorkflowActivity({
      orchestrationProgress: {
        kind: 'workflow',
        runId: 'workflow-run-1',
        phases: [
          { title: 'Discover' },
          { title: 'Build' },
        ],
        agents: [
          {
            id: 'workflow-run-1-1',
            label: 'Scout',
            agentType: 'scout',
            phase: 'Discover',
            status: 'done',
            tokensIn: 1000,
            tokensOut: 24,
            toolCalls: 1,
            startedAt: '2026-07-06T12:00:00.000Z',
            endedAt: '2026-07-06T12:01:00.000Z',
          },
          {
            id: 'workflow-run-1-2',
            label: 'Builder',
            agentType: 'builder',
            phase: 'Build',
            status: 'running',
            tokensIn: 5,
            tokensOut: 0,
            toolCalls: 2,
            startedAt: '2026-07-06T12:02:00.000Z',
            lastActivity: 'tool_execution_start',
          },
        ],
      },
    }))

    expect(html).toContain('Agent')
    expect(html).toContain('Tokens')
    expect(html).toContain('Tools')
    expect(html).toContain('Time')
    expect(html).toContain('Elapsed 3m')
    expect(html).toContain('aria-label="Toggle phase Discover"')
    // P6.305 FLIPPED. This line used to assert the RAW token appeared, which
    // was a faithful pin of a real defect: the user read `tool_execution_start`
    // in the activity slot. The token now goes through the one shared reader,
    // so the sentence is what renders and the raw value survives on `title`.
    expect(html).toContain('Running a tool')
    expect(html).toContain('title="Last activity: tool_execution_start"')
    expect(html).not.toContain('>tool_execution_start<')
    expect(html).toMatch(/>2<\/span>/)
  })

  it('renders declared workflow phases in order before and after populated phases', () => {
    const html = renderWorkflowPanel(createWorkflowActivity({
      orchestrationProgress: {
        kind: 'workflow',
        runId: 'workflow-run-1',
        phases: [
          { title: 'Plan', detail: 'Set up context' },
          { title: 'Build' },
          { title: 'Review' },
        ],
        agents: [
          {
            id: 'workflow-run-1-1',
            label: 'Builder',
            agentType: 'worker',
            phase: 'Build',
            status: 'running',
            tokensIn: 3,
            tokensOut: 1,
          },
        ],
      },
    }))

    expect(html).toContain('3 phases')
    expect(html).toContain('Plan')
    expect(html).toContain('Set up context')
    expect(html).toContain('Build')
    expect(html).toContain('Review')
    expect(html).toContain('Builder')
    expect(html).toContain('Pending')
    expect(html.indexOf('Plan')).toBeLessThan(html.indexOf('Build'))
    expect(html.indexOf('Build')).toBeLessThan(html.indexOf('Review'))
  })

  it('updates elapsed time from agent start time on rerender', () => {
    setNow('2026-07-06T12:00:05.000Z')
    const firstHtml = renderWorkflowPanel(createWorkflowActivity())
    expect(firstHtml).toContain('5s')

    setNow('2026-07-06T12:02:00.000Z')
    const nextHtml = renderWorkflowPanel(createWorkflowActivity())
    expect(nextHtml).toContain('2m')
  })

  it('renders completed workflow logs and final result text', () => {
    const html = renderWorkflowPanel(createWorkflowActivity({
      status: 'completed',
      content: 'workflow done\n\nLogs:\n- gathered context\n- wrote patch\n\n1. Scout - done\nDone output',
      orchestrationProgress: {
        kind: 'workflow',
        runId: 'workflow-run-1',
        agents: [
          {
            id: 'workflow-run-1-1',
            label: 'Scout',
            agentType: 'scout',
            phase: 'discover',
            status: 'done',
            tokensIn: 10,
            tokensOut: 2,
          },
        ],
      },
    }))

    expect(html).toContain('Logs')
    expect(html).toContain('gathered context')
    expect(html).toContain('wrote patch')
    expect(html).toContain('Result')
    expect(html).toContain('workflow done')
    expect(html).toContain('Resume')
  })

  it('renders workflow error state', () => {
    const html = renderWorkflowPanel(createWorkflowActivity({
      status: 'error',
      content: 'workflow error\nworkflow failed: no files\n\nLogs:\n- setup\n\nFailures:\n- parallel[1]: no files',
      orchestrationProgress: {
        kind: 'workflow',
        runId: 'workflow-run-1',
        agents: [
          {
            id: 'workflow-run-1-1',
            label: 'Reviewer',
            agentType: 'reviewer',
            phase: 'review',
            status: 'error',
            tokensIn: 6,
            tokensOut: 1,
          },
        ],
      },
    }))

    expect(html).toContain('Error')
    expect(html).toContain('workflow failed: no files')
    expect(html).toContain('setup')
  })

  it('renders budget exceeded state', () => {
    const html = renderWorkflowPanel(createWorkflowActivity({
      status: 'error',
      toolInput: { tokenBudget: 10 },
      content: 'workflow error\nworkflow tokenBudget exceeded: spent 19, budget 10',
    }))

    expect(html).toContain('Budget exceeded')
    expect(html).toContain('19 / 10 tokens')
  })

  it('renders resumed workflow state', () => {
    const html = renderWorkflowPanel(createWorkflowActivity({
      status: 'completed',
      toolInput: {
        tokenBudget: 100,
        resumeRunId: 'workflow-run-0',
      },
      content: 'workflow done\n\n1. Scout - done\nDone output',
      orchestrationProgress: {
        kind: 'workflow',
        runId: 'workflow-run-2',
        agents: [],
      },
    }))

    expect(html).toContain('workflow-run-2')
    expect(html).toContain('Resumed from workflow-run-0')
    expect(html).toContain('Resume')
  })
})

/**
 * P6.318 — the keep-this-run affordance.
 *
 * Three things the row asks for and one it forbids: the buttons appear on a
 * finished run that carries an inline recipe, they offer BOTH scopes, and they
 * are absent when the caller withheld `onKeepRun` — which is how a runtime that
 * cannot dispatch a recipe (`runtimeDispatchesWorkflows`) is never offered the
 * save. The fourth case is a run whose recipe is already on disk.
 *
 * Mutation probe: dropping the `completedStatuses` gate turns the running case
 * red; dropping the `workflowRecipeSource` gate turns the named-run case red.
 */
function completedWorkflowActivity(overrides: Partial<ActivityItem> = {}): ActivityItem {
  const base = createWorkflowActivity(overrides)
  return {
    ...base,
    status: 'completed',
    orchestrationProgress: {
      ...base.orchestrationProgress!,
      agents: (base.orchestrationProgress!.agents ?? []).map(agent => ({ ...agent, status: 'done' as const })),
    },
  }
}

function renderKeepable(activity: ActivityItem, offer = true): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <WorkflowPanel
        activity={activity}
        defaultExpanded
        onInsertResumePrompt={() => {}}
        {...(offer ? { onKeepRun: () => {} } : {})}
      />
    </I18nextProvider>
  )
}

describe('P6.318 — keep this run', () => {
  const inlineRun = () => completedWorkflowActivity({
    toolInput: { tokenBudget: 100, script: 'export const meta = { name: "nightly" }\nreturn 1' },
  })

  it('offers BOTH scopes on a finished run that carries an inline recipe', () => {
    const html = renderKeepable(inlineRun())
    expect(html).toContain('Keep in project')
    expect(html).toContain('Keep for me')
  })

  it('offers nothing when the caller withheld the action — the runtime that cannot dispatch a recipe', () => {
    // `runtimeDispatchesWorkflows` is answered by the caller, so "not offered"
    // is expressed by the absent prop. This is the row's own requirement.
    const html = renderKeepable(inlineRun(), false)
    expect(html).not.toContain('Keep in project')
    expect(html).not.toContain('Keep for me')
  })

  it('offers nothing while the run is still going', () => {
    const html = renderKeepable(createWorkflowActivity({
      toolInput: { script: 'export const meta = { name: "nightly" }' },
    }))
    expect(html).not.toContain('Keep in project')
  })

  it('offers nothing for a run whose recipe is already on disk', () => {
    // A `name` or `scriptPath` run dispatches something the user already has;
    // keeping it would write a second copy of it.
    expect(renderKeepable(completedWorkflowActivity({ toolInput: { name: 'nightly' } })))
      .not.toContain('Keep in project')
    expect(renderKeepable(completedWorkflowActivity({ toolInput: { scriptPath: './w.js' } })))
      .not.toContain('Keep in project')
  })

  it('reads the inline recipe and only the inline recipe', () => {
    expect(workflowRecipeSource(inlineRun())).toContain('export const meta')
    expect(workflowRecipeSource(completedWorkflowActivity({ toolInput: { script: '   ' } }))).toBeUndefined()
    expect(workflowRecipeSource(completedWorkflowActivity({ toolInput: {} }))).toBeUndefined()
  })
})
