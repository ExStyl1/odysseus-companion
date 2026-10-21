import type { ComponentEntry } from './types'
import type { ReactNode } from 'react'
import type { ActivityItem } from '@nessy-agent/ui/chat/TurnCard'
import type { AskUserUrlConsent, PermissionRequest } from '../../../shared/types'
import { SubagentCard } from '@/components/app-shell/SubagentCard'
import { isTodoCardActivity, TodoListCard } from '@/components/app-shell/TodoListCard'
import { TaskChecklistPanel } from '@/components/app-shell/TaskChecklistPanel'
import { WorkflowPanel } from '@/components/app-shell/WorkflowPanel'
import { AdvisorConsultationCard } from '@/components/app-shell/AdvisorConsultationCard'
import { isAdvisorCardActivity } from '@/components/app-shell/advisor-consultation'
import { AskUserRequest } from '@/components/app-shell/input/structured/AskUserRequest'
import { TaskNotificationLine } from '@/components/app-shell/task-notification-line'

type SubagentScenario = 'running' | 'parallel' | 'chain' | 'error' | 'aborted' | 'done' | 'codex'
type WorkflowScenario = 'phases' | 'budget' | 'error' | 'resumed'
type TodoScenario =
  | 'mixed'
  | 'complete'
  | 'result'
  | 'unparseableResult'
  | 'awaitingInput'
  | 'noTodosInResult'
type AdvisorScenario =
  | 'approach'
  | 'recurringError'
  | 'beforeDone'
  | 'noMoment'
  | 'longGuidance'
  | 'refused'
  | 'running'
type TaskChecklistScenario = 'mixed' | 'allPending' | 'complete' | 'overflow' | 'snapshot' | 'legacyTodoWrite' | 'empty'
type AskUserScenario =
  | 'options'
  | 'freeText'
  | 'batched'
  | 'batchedSingle'
  | 'batchedCountdown'
  | 'batchedPreview'
  | 'urlPlain'
  | 'urlPunycode'
  | 'urlLookalike'

const now = Date.now()

function frame(children: ReactNode, className = 'w-[520px]') {
  return (
    <div className={className}>
      {children}
    </div>
  )
}

function createSubagentActivity(scenario: SubagentScenario): ActivityItem {
  const base: ActivityItem = {
    id: `subagent-${scenario}`,
    type: 'tool',
    status: scenario === 'error' || scenario === 'aborted' ? 'error' : scenario === 'done' ? 'completed' : 'running',
    toolName: 'subagent',
    toolUseId: `subagent-${scenario}`,
    timestamp: now,
    orchestrationProgress: {
      kind: 'subagent',
      runId: `subagent-${scenario}-run`,
      agents: [],
    },
  }

  switch (scenario) {
    case 'running':
      return {
        ...base,
        orchestrationProgress: {
          kind: 'subagent',
          runId: 'subagent-running-run',
          agents: [
            { id: 'running-1', label: 'Scout', agentType: 'scout', status: 'running', tokensIn: 840, tokensOut: 118, lastActivity: 'reading files' },
            { id: 'running-2', label: 'Reviewer', agentType: 'reviewer', status: 'queued', tokensIn: 0, tokensOut: 0 },
          ],
        },
      }
    case 'parallel':
      return {
        ...base,
        orchestrationProgress: {
          kind: 'subagent',
          runId: 'subagent-parallel-run',
          agents: [
            { id: 'parallel-1', label: 'API Scout', agentType: 'scout', status: 'running', tokensIn: 1200, tokensOut: 280, phase: 'fan-out' },
            { id: 'parallel-2', label: 'UI Scout', agentType: 'scout', status: 'running', tokensIn: 1100, tokensOut: 240, phase: 'fan-out' },
            { id: 'parallel-3', label: 'Test Scout', agentType: 'scout', status: 'done', tokensIn: 900, tokensOut: 190, phase: 'fan-out' },
          ],
        },
      }
    case 'chain':
      return {
        ...base,
        orchestrationProgress: {
          kind: 'subagent',
          runId: 'subagent-chain-run',
          agents: [
            { id: 'chain-1', label: 'Plan', agentType: 'planner', status: 'done', tokensIn: 740, tokensOut: 156, phase: 'plan' },
            { id: 'chain-2', label: 'Implement', agentType: 'builder', status: 'running', tokensIn: 980, tokensOut: 310, phase: 'build' },
            { id: 'chain-3', label: 'Verify', agentType: 'reviewer', status: 'queued', tokensIn: 0, tokensOut: 0, phase: 'verify' },
          ],
        },
      }
    case 'error':
      return {
        ...base,
        content: 'Reviewer failed: expected export was missing.',
        orchestrationProgress: {
          kind: 'subagent',
          runId: 'subagent-error-run',
          agents: [
            { id: 'error-1', label: 'Reviewer', agentType: 'reviewer', status: 'error', tokensIn: 620, tokensOut: 74, phase: 'review' },
          ],
        },
      }
    case 'aborted':
      return {
        ...base,
        content: 'Turn stopped before all children completed.',
        orchestrationProgress: {
          kind: 'subagent',
          runId: 'subagent-aborted-run',
          agents: [
            { id: 'aborted-1', label: 'Scout', agentType: 'scout', status: 'done', tokensIn: 820, tokensOut: 122 },
            { id: 'aborted-2', label: 'Reviewer', agentType: 'reviewer', status: 'aborted', tokensIn: 260, tokensOut: 0 },
          ],
        },
      }
    // UB14.18 — the codex half of the same card (P3.24): a `spawn_agent` collab call anchoring
    // subagent-kind progress, routed by `isSubagentCardActivity` exactly as Pi's `subagent` is.
    case 'codex':
      return {
        ...base,
        toolName: 'spawn_agent',
        status: 'completed',
        content: 'Explorer mapped the gateway fetchers. Worker extracted the shared retry helper.',
        orchestrationProgress: {
          kind: 'subagent',
          runId: 'codex-collab-run',
          agents: [
            { id: 'codex-1', label: 'explorer', agentType: 'explorer', status: 'done', tokensIn: 1520, tokensOut: 233, lastActivity: 'tool_execution_end' },
            { id: 'codex-2', label: 'worker', agentType: 'worker', status: 'done', tokensIn: 2210, tokensOut: 618 },
          ],
        },
      }
    case 'done':
      return {
        ...base,
        status: 'completed',
        content: 'Scout found the adapter path. Reviewer confirmed no renderer regressions.',
        orchestrationProgress: {
          kind: 'subagent',
          runId: 'subagent-done-run',
          agents: [
            { id: 'done-1', label: 'Scout', agentType: 'scout', status: 'done', tokensIn: 930, tokensOut: 201 },
            { id: 'done-2', label: 'Reviewer', agentType: 'reviewer', status: 'done', tokensIn: 870, tokensOut: 166 },
          ],
        },
      }
  }
}

function createWorkflowActivity(scenario: WorkflowScenario): ActivityItem {
  const base: ActivityItem = {
    id: `workflow-${scenario}`,
    type: 'tool',
    status: scenario === 'error' || scenario === 'budget' ? 'error' : scenario === 'resumed' ? 'completed' : 'running',
    toolName: 'workflow',
    toolUseId: `workflow-${scenario}`,
    timestamp: now,
    toolInput: { tokenBudget: 5000 },
    orchestrationProgress: {
      kind: 'workflow',
      runId: `workflow-${scenario}-run`,
      agents: [],
    },
  }

  switch (scenario) {
    case 'phases':
      return {
        ...base,
        orchestrationProgress: {
          kind: 'workflow',
          runId: 'workflow-phases-run',
          agents: [
            { id: 'phase-1', label: 'Discover', agentType: 'scout', phase: 'discover', status: 'done', tokensIn: 860, tokensOut: 141, toolCalls: 3, lastActivity: 'mapped files' },
            { id: 'phase-2', label: 'Build', agentType: 'builder', phase: 'build', status: 'running', tokensIn: 1340, tokensOut: 416, toolCalls: 2, lastActivity: 'editing UI' },
            { id: 'phase-3', label: 'Review', agentType: 'reviewer', phase: 'review', status: 'queued', tokensIn: 0, tokensOut: 0, toolCalls: 0 },
          ],
        },
      }
    case 'budget':
      return {
        ...base,
        toolInput: { tokenBudget: 1200 },
        content: 'workflow error\nworkflow tokenBudget exceeded: spent 3012, budget 1200',
        orchestrationProgress: {
          kind: 'workflow',
          runId: 'workflow-budget-run',
          agents: [
            { id: 'budget-1', label: 'Analyzer', agentType: 'scout', phase: 'discover', status: 'done', tokensIn: 2100, tokensOut: 512, toolCalls: 4 },
            { id: 'budget-2', label: 'Verifier', agentType: 'reviewer', phase: 'verify', status: 'error', tokensIn: 340, tokensOut: 60, toolCalls: 1 },
          ],
        },
      }
    case 'error':
      return {
        ...base,
        content: 'workflow error\nparallel[1] failed: fixture did not produce an answer\n\nLogs:\n- started review lane\n- retried once\n\nFailures:\n- parallel[1]: fixture did not produce an answer',
        orchestrationProgress: {
          kind: 'workflow',
          runId: 'workflow-error-run',
          agents: [
            { id: 'error-1', label: 'Implementer', agentType: 'builder', phase: 'build', status: 'done', tokensIn: 1200, tokensOut: 480, toolCalls: 5 },
            { id: 'error-2', label: 'Reviewer', agentType: 'reviewer', phase: 'review', status: 'error', tokensIn: 770, tokensOut: 90, toolCalls: 2 },
          ],
        },
      }
    case 'resumed':
      return {
        ...base,
        status: 'completed',
        toolInput: { tokenBudget: 5000, resumeRunId: 'workflow-phases-run' },
        content: 'workflow done\n\nLogs:\n- resumed from cached scout output\n- completed review\n\n1. Reviewer - done\nNo blocking issues.',
        orchestrationProgress: {
          kind: 'workflow',
          runId: 'workflow-resumed-run',
          agents: [
            { id: 'resumed-1', label: 'Reviewer', agentType: 'reviewer', phase: 'review', status: 'done', tokensIn: 740, tokensOut: 180, toolCalls: 1 },
          ],
        },
      }
  }
}

/**
 * P2.503 · every state the todo card decides between, including the three it
 * declines.
 *
 * The declined ones carry the sweep, exactly as they do for the advisor card
 * above: this slot returns an ELEMENT, so a card that renders `null` DELETES
 * the row rather than yielding it to `ActivityRow`. Those three were live —
 * the router asked the tool NAME, the card asked whether any todos could be
 * recovered, and every TodoWrite row where the two disagreed vanished from the
 * transcript. They render the fallback the real transcript now shows, so the
 * row can be looked at and confirmed present rather than merely un-carded.
 */
function createTodoActivity(scenario: TodoScenario): ActivityItem {
  const base: ActivityItem = {
    id: `todo-${scenario}`,
    type: 'tool',
    status: 'completed',
    toolName: 'TodoWrite',
    toolUseId: `todo-${scenario}`,
    timestamp: now,
  }

  switch (scenario) {
    case 'mixed':
      return {
        ...base,
        status: 'running',
        toolInput: {
          todos: [
            { id: 'todo-1', content: 'Inspect tool activity shape', status: 'completed' },
            { id: 'todo-2', content: 'Render activity card', status: 'in_progress', activeForm: 'Rendering activity card' },
            { id: 'todo-3', content: 'Run focused tests', status: 'pending' },
          ],
        },
      }
    case 'complete':
      return {
        ...base,
        toolInput: {
          todos: [
            { id: 'todo-1', content: 'Add TodoWrite store', status: 'completed' },
            { id: 'todo-2', content: 'Wire todo card', status: 'completed' },
            { id: 'todo-3', content: 'Record tracker gate', status: 'completed' },
          ],
        },
      }
    case 'result':
      return {
        ...base,
        toolInput: undefined,
        content: JSON.stringify({
          todos: [
            { id: 'todo-1', content: 'List persisted todos', status: 'completed' },
            { id: 'todo-2', content: 'Review saved state', status: 'pending' },
          ],
        }),
      }
    case 'unparseableResult':
      // The shipped defect, in the shape a user met it: the call failed and its
      // result is an error string, not JSON. The card draws nothing.
      return {
        ...base,
        status: 'error',
        toolInput: undefined,
        content: 'Error: EACCES writing the todo store',
      }
    case 'awaitingInput':
      // In flight, before the streamed input has been parsed into `todos`.
      return { ...base, status: 'running', toolInput: undefined }
    case 'noTodosInResult':
      // Valid JSON, no `todos` array — a shape drift on the producer side.
      return { ...base, toolInput: undefined, content: JSON.stringify({ ok: true }) }
  }
}

/**
 * URL-mode MCP elicitation consent states, produced by `analyzeConsentUrl`
 * (`@nessy-agent/shared/mcp`). One benign address, one Punycode homograph and
 * one subdomain-suffix lookalike — the three cases the card has to keep
 * distinguishable while still showing the whole URL.
 */
const URL_CONSENT_SCENARIOS: Record<'urlPlain' | 'urlPunycode' | 'urlLookalike', AskUserUrlConsent> = {
  urlPlain: {
    url: 'https://corp.example.com/x?session=42',
    host: 'corp.example.com',
    registrableDomain: 'example.com',
    warnings: [],
  },
  urlPunycode: {
    url: 'https://xn--pple-43d.com/authorize',
    host: 'xn--pple-43d.com',
    registrableDomain: 'xn--pple-43d.com',
    decodedHost: 'аpple.com',
    warnings: [{ kind: 'punycode' }, { kind: 'mixed-script', detail: 'Latin + Cyrillic' }],
  },
  urlLookalike: {
    url: 'https://accounts.example.com.attacker.net/oauth/authorize?client_id=nessy',
    host: 'accounts.example.com.attacker.net',
    registrableDomain: 'attacker.net',
    warnings: [{ kind: 'lookalike-suffix' }],
  },
}

function createAskUserRequest(scenario: AskUserScenario): PermissionRequest {
  const urlConsent = URL_CONSENT_SCENARIOS[scenario as keyof typeof URL_CONSENT_SCENARIOS]
  if (urlConsent) {
    return {
      sessionId: 'playground-session',
      requestId: `ask-user-${scenario}`,
      toolName: 'ask_user',
      description: 'MCP elicitation (url mode)',
      type: 'ask_user',
      askUser: {
        question: `The Example server needs you to authorize access.\n\n${urlConsent.url}`,
        options: ['Open separately', 'Cancel'],
        allowFreeText: false,
        urlConsent,
      },
    }
  }
  if (scenario === 'batched' || scenario === 'batchedSingle' || scenario === 'batchedCountdown' || scenario === 'batchedPreview') {
    const questions = [
      {
        question: 'How should the agent format the output?',
        header: 'Format',
        options: scenario === 'batchedPreview'
          // P6.471 — `option.preview` was on the wire, produced by Pi and drawn
          // by nobody. The SDK documents the format as "Markdown/ASCII content
          // (CLI default, rendered in a monospace box)", so the sweep needs an
          // ASCII preview whose alignment carries meaning, plus one wide enough
          // to exercise the box's own horizontal scroll.
          ? [
            { label: 'Summary', description: 'Brief overview of key points', preview: 'file        | findings\n------------|---------\nagent.ts    |        3\nsession.ts  |        1' },
            { label: 'Detailed', description: 'Full explanation with examples', preview: 'src/\n  agent.ts      3 findings\n  session.ts    1 finding\n  (+ 14 files with none, listed in full)' },
          ]
          : [
            { label: 'Summary', description: 'Brief overview of key points' },
            { label: 'Detailed', description: 'Full explanation with examples' },
          ],
        multiSelect: false,
      },
      {
        question: 'Which sections should the agent include?',
        header: 'Sections',
        options: [
          { label: 'Introduction', description: 'Opening context' },
          { label: 'Benchmarks', description: 'Measured numbers' },
          { label: 'Conclusion', description: 'Final summary' },
        ],
        multiSelect: true,
      },
    ]
    return {
      sessionId: 'playground-session',
      requestId: `ask-user-${scenario}`,
      toolName: 'ask_user',
      description: 'Clarifying questions',
      type: 'ask_user',
      askUser: {
        question: questions[0]!.question,
        options: questions[0]!.options.map(option => option.label),
        allowFreeText: true,
        questions: scenario === 'batchedSingle' || scenario === 'batchedPreview' ? questions.slice(0, 1) : questions,
        // askUserQuestionTimeout countdown state: 25 s puts the on-screen
        // countdown (last 20 s) in view a few seconds after opening.
        ...(scenario === 'batchedCountdown' ? { timeoutMs: 25_000 } : {}),
      },
    }
  }
  return {
    sessionId: 'playground-session',
    requestId: `ask-user-${scenario}`,
    toolName: 'ask_user',
    description: 'Ask the user a question',
    type: 'ask_user',
    askUser: {
      question: scenario === 'options'
        ? 'Which implementation path should the agent take?'
        : 'What should the agent name this release note?',
      options: scenario === 'options'
        ? ['Ship the focused fix', 'Broaden the refactor', 'Stop and summarize']
        : ['Keep the generated title', 'Use a shorter title'],
      allowFreeText: scenario === 'freeText',
      timeoutMs: 300000,
    },
  }
}

function SubagentPlayground({
  scenario,
  expanded,
}: {
  scenario: SubagentScenario
  expanded: boolean
}) {
  return frame(
    <SubagentCard
      activity={createSubagentActivity(scenario)}
      defaultExpanded={expanded}
      onOpenDetails={() => console.info('[Playground] Open subagent details')}
    />
  )
}

function WorkflowPlayground({
  scenario,
  expanded,
}: {
  scenario: WorkflowScenario
  expanded: boolean
}) {
  return frame(
    <WorkflowPanel
      activity={createWorkflowActivity(scenario)}
      defaultExpanded={expanded}
      onOpenDetails={() => console.info('[Playground] Open workflow details')}
      onInsertResumePrompt={prompt => console.info('[Playground] Resume prompt:', prompt)}
    />
  )
}

/**
 * P4.5 · every state the card decides between, including the three it declines.
 *
 * The declined ones are the point of the sweep, not padding: this slot returns
 * an ELEMENT, so a card that renders `null` DELETES the row rather than
 * yielding it to `ActivityRow` (P3.24 measured that on `SubagentCard`). The
 * `refused` and `running` scenarios therefore render the fallback the real
 * transcript would show, so the playground can be looked at and the row
 * confirmed present rather than merely un-carded.
 */
function createAdvisorActivity(scenario: AdvisorScenario): ActivityItem {
  const base: ActivityItem = {
    id: `advisor-${scenario}`,
    type: 'tool',
    status: 'completed',
    toolName: 'advisor_consult',
    toolUseId: `advisor-${scenario}`,
    timestamp: now,
  }

  switch (scenario) {
    case 'approach':
      return {
        ...base,
        toolInput: {
          moment: 'approach',
          question: 'Should the retry live in the transport or in the caller?',
        },
        content: 'Advisor (claude-sonnet-4-5):\n\nPut it in the transport. The caller already has three'
          + ' call sites and each would grow its own backoff; the transport has one, and it is the layer'
          + ' that knows which failures are retryable.',
      }
    case 'recurringError':
      return {
        ...base,
        toolInput: {
          moment: 'recurring-error',
          question: 'ENOENT keeps coming back after the mkdir fix.',
        },
        content: 'Advisor (tgpt/qwen35-397b-a17b-fp8):\n\nThe directory is created and then removed by the'
          + ' teardown of the previous case, so the second run races it. Create it inside the same'
          + ' function that writes, not in setup.',
      }
    case 'beforeDone':
      return {
        ...base,
        toolInput: {
          moment: 'before-done',
          question: 'Anything missing before I report this finished?',
        },
        content: 'Advisor (claude-opus-4-1):\n\nThe migration is covered but nothing asserts the rollback'
          + ' path. Add one case that runs it and checks the table is back to its previous shape.',
      }
    case 'noMoment':
      // A moment the host did not recognise, or a reply that arrived without
      // one: the card keeps the guidance and drops only the label.
      return {
        ...base,
        toolInput: { question: 'Which of these two is cheaper to maintain?' },
        content: 'Advisor (claude-sonnet-4-5):\n\nThe second. It has one seam instead of three, and the'
          + ' seam it has is the one your tests already reach.',
      }
    case 'longGuidance':
      return {
        ...base,
        toolInput: {
          moment: 'approach',
          question: 'How should the cache be invalidated when a plugin changes on disk?',
        },
        content: 'Advisor (claude-opus-4-1):\n\n'
          + 'Three options, cheapest first.\n\n'
          + '1. Invalidate on the watcher event you already receive. You pay nothing extra and you'
          + ' inherit the debounce that is already there.\n'
          + '2. Version the manifest and compare on read. Robust against a missed event, but every'
          + ' reader now parses the manifest.\n'
          + '3. Drop the cache entirely. Correct by construction, and the profile says the cache saves'
          + ' about 40ms on a cold window — which is not nothing, but it is not the reason this is'
          + ' slow either.\n\n'
          + 'Take 1 and record 3 as the fallback if the watcher proves unreliable on Windows.',
      }
    case 'refused':
      // One of the six English refusal sentences. Not guidance, so the card
      // declines and the ordinary tool row paints it.
      return {
        ...base,
        toolInput: { moment: 'approach', question: 'Is this approach sound?' },
        content: 'The advisor is turned off for this session. Continue on your own — do not consult'
          + ' again this turn.',
      }
    case 'running':
      return {
        ...base,
        status: 'running',
        toolInput: { moment: 'before-done', question: 'Anything missing?' },
        content: undefined,
      }
  }
}

function AdvisorPlayground({ scenario }: { scenario: AdvisorScenario }) {
  const activity = createAdvisorActivity(scenario)
  if (!isAdvisorCardActivity(activity)) {
    return frame(
      <div className="rounded-md border border-dashed border-default px-2.5 py-2 text-label-sm text-tertiary">
        Not routed to the card — the transcript keeps the ordinary tool row here.
      </div>
    )
  }
  return frame(<AdvisorConsultationCard activity={activity} />)
}

function TodoPlayground({ scenario }: { scenario: TodoScenario }) {
  const activity = createTodoActivity(scenario)
  if (!isTodoCardActivity(activity)) {
    return frame(
      <div className="rounded-md border border-dashed border-default px-2.5 py-2 text-label-sm text-tertiary">
        Not routed to the card — the transcript keeps the ordinary tool row here.
      </div>
    )
  }
  return frame(<TodoListCard activity={activity} />)
}

/** R20: the Ctrl+T checklist surface, built from real task tool activities. */
function createChecklistActivities(scenario: TaskChecklistScenario): ActivityItem[] {
  let sequence = 0
  const base = (over: Partial<ActivityItem>): ActivityItem => ({
    id: `checklist-${scenario}-${++sequence}`,
    type: 'tool',
    status: 'completed',
    timestamp: now + sequence,
    ...over,
  })
  const create = (subject: string, id: string, activeForm?: string) => base({
    toolName: 'mcp__session__TaskCreate',
    toolInput: { subject, description: 'Playground fixture', ...(activeForm ? { activeForm } : {}) },
    content: JSON.stringify({ task: { id, subject } }),
  })
  const update = (input: Record<string, unknown>) => base({ toolName: 'mcp__session__TaskUpdate', toolInput: input })

  if (scenario === 'empty') return []
  if (scenario === 'legacyTodoWrite') return [createTodoActivity('mixed')]
  if (scenario === 'snapshot') {
    return [base({
      toolName: 'mcp__session__TaskList',
      toolInput: {},
      content: JSON.stringify({
        tasks: [
          { id: 'task-001', subject: 'Read the contract source', status: 'completed', blockedBy: [] },
          { id: 'task-002', subject: 'Wire the store', status: 'in_progress', blockedBy: ['task-001'] },
          { id: 'task-003', subject: 'Render the checklist', status: 'pending', blockedBy: ['task-002'] },
        ],
      }),
    })]
  }
  if (scenario === 'overflow') {
    return Array.from({ length: 8 }, (_, index) => create(`Task number ${index + 1}`, `task-00${index + 1}`))
  }
  const items = [
    create('Read the contract source', 'task-001'),
    create('Wire the file-backed store', 'task-002', 'Wiring the file-backed store'),
    create('Render the checklist', 'task-003'),
  ]
  if (scenario === 'allPending') return items
  if (scenario === 'complete') {
    return [...items, update({ taskId: 'task-001', status: 'completed' }),
      update({ taskId: 'task-002', status: 'completed' }), update({ taskId: 'task-003', status: 'completed' })]
  }
  // 'mixed' also exercises the raw `task_id` key the stream keeps after repair.
  return [...items, update({ taskId: 'task-001', status: 'completed' }), update({ task_id: 'task-002', status: 'in_progress' })]
}

function TaskChecklistPlayground({ scenario }: { scenario: TaskChecklistScenario }) {
  return frame(
    <TaskChecklistPanel activities={createChecklistActivities(scenario)} open />
  )
}

type TaskNotificationScenario = 'subagent' | 'shellFailed' | 'legacy'

/** F1.351's delivery, as `SessionManager.flushPendingTaskNotifications` frames it for the model. */
function taskNotificationDelivery(body: string): string {
  return [
    '<system-reminder>The block below is a background task notification delivered by the host: no human input has occurred.</system-reminder>',
    '<task-notification>',
    body,
    '</task-notification>',
  ].join('\n')
}

function createTaskNotificationContent(scenario: TaskNotificationScenario): string {
  switch (scenario) {
    case 'subagent':
      return taskNotificationDelivery('Background subagent task t-1 finished (completed).\nAll three checks passed.')
    case 'shellFailed':
      return taskNotificationDelivery([
        'Background shell task b-7 finished (failed, exit 1).',
        'Command: bun test ./packages/shared/src/agent/__tests__/spawn-session-defer.test.ts',
        ...Array.from({ length: 14 }, (_, index) => `  (fail) case ${index + 1} — expected 2, received 3`),
      ].join('\n'))
    case 'legacy':
      // A row stored before the host framed it: shown whole, never guessed at.
      return 'Background task t-0 finished.'
  }
}

/** UB14.18: the F1.351 line at rest (closed); click the summary to open the body under the hairline. */
function TaskNotificationPlayground({ scenario }: { scenario: TaskNotificationScenario }) {
  return frame(<TaskNotificationLine content={createTaskNotificationContent(scenario)} />)
}

function AskUserPlayground({ scenario }: { scenario: AskUserScenario }) {
  return frame(
    <AskUserRequest
      request={createAskUserRequest(scenario)}
      onResponse={response => console.info('[Playground] ask_user response:', response)}
    />,
    'h-[360px] w-[420px]'
  )
}

const subagentScenarioOptions = [
  { label: 'Running', value: 'running' },
  { label: 'Parallel', value: 'parallel' },
  { label: 'Chain', value: 'chain' },
  { label: 'Error', value: 'error' },
  { label: 'Aborted', value: 'aborted' },
  { label: 'Done', value: 'done' },
  { label: 'Codex collab (spawn_agent)', value: 'codex' },
]

const workflowScenarioOptions = [
  { label: 'Phases', value: 'phases' },
  { label: 'Budget exceeded', value: 'budget' },
  { label: 'Error', value: 'error' },
  { label: 'Resumed', value: 'resumed' },
]

const advisorScenarioOptions = [
  { label: 'Approach', value: 'approach' },
  { label: 'Recurring error', value: 'recurringError' },
  { label: 'Before done', value: 'beforeDone' },
  { label: 'No moment label', value: 'noMoment' },
  { label: 'Long guidance', value: 'longGuidance' },
  { label: 'Refused (falls through)', value: 'refused' },
  { label: 'Still running (falls through)', value: 'running' },
]

const todoScenarioOptions = [
  { label: 'Mixed', value: 'mixed' },
  { label: 'Complete', value: 'complete' },
  { label: 'Result JSON', value: 'result' },
  { label: 'Unparseable result (falls through)', value: 'unparseableResult' },
  { label: 'Awaiting input (falls through)', value: 'awaitingInput' },
  { label: 'Result without todos (falls through)', value: 'noTodosInResult' },
]

const taskChecklistScenarioOptions = [
  { label: 'Mixed', value: 'mixed' },
  { label: 'All pending', value: 'allPending' },
  { label: 'Complete', value: 'complete' },
  { label: 'Overflow (>5)', value: 'overflow' },
  { label: 'TaskList snapshot', value: 'snapshot' },
  { label: 'Legacy TodoWrite', value: 'legacyTodoWrite' },
  { label: 'Empty (no-op)', value: 'empty' },
]

const taskNotificationScenarioOptions = [
  { label: 'Subagent finished', value: 'subagent' },
  { label: 'Shell failed (long body)', value: 'shellFailed' },
  { label: 'Legacy row (no block)', value: 'legacy' },
]

const askUserScenarioOptions = [
  { label: 'Options', value: 'options' },
  { label: 'Free text', value: 'freeText' },
  { label: 'Batched (2 questions)', value: 'batched' },
  { label: 'Batched (single)', value: 'batchedSingle' },
  { label: 'Batched (countdown)', value: 'batchedCountdown' },
  { label: 'Batched (option previews)', value: 'batchedPreview' },
  { label: 'URL consent (plain)', value: 'urlPlain' },
  { label: 'URL consent (Punycode)', value: 'urlPunycode' },
  { label: 'URL consent (lookalike)', value: 'urlLookalike' },
]

export const orchestrationComponents: ComponentEntry[] = [
  {
    id: 'orchestration-subagent-card',
    name: 'Orchestration / SubagentCard',
    category: 'Chat',
    description: 'Subagent activity card states for running, parallel, chain, error, aborted, and done runs.',
    component: SubagentPlayground,
    layout: 'centered',
    props: [
      {
        name: 'scenario',
        description: 'Subagent state',
        control: { type: 'select', options: subagentScenarioOptions },
        defaultValue: 'running',
      },
      {
        name: 'expanded',
        description: 'Expand agent rows',
        control: { type: 'boolean' },
        defaultValue: true,
      },
    ],
    variants: subagentScenarioOptions.map(option => ({
      name: option.label,
      props: { scenario: option.value, expanded: option.value !== 'running' },
    })),
  },
  {
    id: 'orchestration-workflow-panel',
    name: 'Orchestration / WorkflowPanel',
    category: 'Chat',
    description: 'Workflow run panel states for phase groups, token budget, error, and resume handling.',
    component: WorkflowPlayground,
    layout: 'centered',
    props: [
      {
        name: 'scenario',
        description: 'Workflow state',
        control: { type: 'select', options: workflowScenarioOptions },
        defaultValue: 'phases',
      },
      {
        name: 'expanded',
        description: 'Expand phase details',
        control: { type: 'boolean' },
        defaultValue: true,
      },
    ],
    variants: workflowScenarioOptions.map(option => ({
      name: option.label,
      props: { scenario: option.value, expanded: true },
    })),
  },
  {
    id: 'orchestration-advisor-card',
    name: 'Orchestration / AdvisorConsultationCard',
    category: 'Chat',
    description: 'P4.5 advisor consultation card: the three documented moments, a reply whose moment was not recognised, a long multi-paragraph answer, and the two states the card declines so the ordinary tool row keeps them.',
    component: AdvisorPlayground,
    layout: 'centered',
    props: [
      {
        name: 'scenario',
        description: 'Consultation state',
        control: { type: 'select', options: advisorScenarioOptions },
        defaultValue: 'approach',
      },
    ],
    variants: advisorScenarioOptions.map(option => ({
      name: option.label,
      props: { scenario: option.value },
    })),
  },
  {
    id: 'orchestration-todo-list-card',
    name: 'Orchestration / TodoListCard',
    category: 'Chat',
    description: 'P2.503 TodoWrite activity card: the mixed, complete and persisted-result lists, plus the three states the card declines so the ordinary tool row keeps them instead of the row vanishing.',
    component: TodoPlayground,
    layout: 'centered',
    props: [
      {
        name: 'scenario',
        description: 'Todo list state',
        control: { type: 'select', options: todoScenarioOptions },
        defaultValue: 'mixed',
      },
    ],
    variants: todoScenarioOptions.map(option => ({
      name: option.label,
      props: { scenario: option.value },
    })),
  },
  {
    id: 'orchestration-task-checklist',
    name: 'Orchestration / TaskChecklistPanel',
    category: 'Chat',
    description: 'R20 task checklist surface: accumulated TaskCreate/TaskUpdate calls, a TaskList snapshot, the >5 overflow cap, the legacy TodoWrite fallback, and the empty no-op. Chrome comes from the shared SystemCard primitive.',
    component: TaskChecklistPlayground,
    layout: 'centered',
    props: [
      {
        name: 'scenario',
        description: 'Checklist state',
        control: { type: 'select', options: taskChecklistScenarioOptions },
        defaultValue: 'mixed',
      },
    ],
    variants: taskChecklistScenarioOptions.map(option => ({
      name: option.label,
      props: { scenario: option.value },
    })),
  },
  {
    id: 'orchestration-ask-user',
    name: 'Orchestration / ask_user dialog',
    category: 'Chat Inputs',
    description: 'ask_user permission-channel dialog with option-only, free-text, batched multi-question (R7), and URL-mode elicitation consent states (domain highlight, Punycode and lookalike warnings).',
    component: AskUserPlayground,
    layout: 'centered',
    previewOverflow: 'visible',
    props: [
      {
        name: 'scenario',
        description: 'Dialog state',
        control: { type: 'select', options: askUserScenarioOptions },
        defaultValue: 'options',
      },
    ],
    variants: askUserScenarioOptions.map(option => ({
      name: option.label,
      props: { scenario: option.value },
    })),
  },
  {
    id: 'orchestration-task-notification',
    name: 'Orchestration / TaskNotificationLine',
    category: 'Chat',
    description: 'F1.351 background-task notification the host delivered between turns, drawn as a labelled system line (UB14.18: a transcript status row whose body opens under the inset hairline): a subagent completion, a failed shell task with a long body, and a legacy row with no framing.',
    component: TaskNotificationPlayground,
    layout: 'centered',
    props: [
      {
        name: 'scenario',
        description: 'Notification',
        control: { type: 'select', options: taskNotificationScenarioOptions },
        defaultValue: 'subagent',
      },
    ],
    variants: taskNotificationScenarioOptions.map(option => ({
      name: option.label,
      props: { scenario: option.value },
    })),
  },
]
