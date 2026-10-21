/**
 * Automation UI Types
 *
 * UI-specific types for the automations components.
 *
 * ARCHITECTURE NOTE: These types are mirrored from packages/shared/src/automations/types.ts.
 * The renderer runs in a browser context and CANNOT import from @nessy-agent/shared,
 * which uses Node.js APIs (crypto, fs, etc.). Additionally, the automations package is not
 * exported as a package entry point. These types must be manually kept in sync.
 * See apps/electron/CLAUDE.md "Common Mistake: Node.js APIs in Renderer".
 */

import { computeNextRuns } from './utils'
import type { PermissionMode } from '../../../shared/types'
import { parsePermissionMode } from '@nessy-agent/shared/agent/mode-types'
import type { ThinkingLevel } from '@nessy-agent/shared/agent/thinking-levels'
import { DEFAULT_WEBHOOK_METHOD } from './constants'

// ============================================================================
// Automation System Types (mirrored from packages/shared/src/automations/types.ts)
// ============================================================================

export type AppEvent =
  | 'LabelAdd'
  | 'LabelRemove'
  | 'LabelConfigChange'
  | 'PermissionModeChange'
  | 'FlagChange'
  | 'TodoStateChange'
  | 'SessionStatusChange'
  | 'SchedulerTick'

export type AgentEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PermissionRequest'

// `Setup` used to be here. R73 · f001 removed the event: hooks.md#setup fires it
// only under `--init-only` / `-p --init` / `-p --maintenance`, launch modes
// Nessy has none of, so an automation created on it could never run. The event
// picker must not offer it — a row a user can select and save is exactly the
// silently-dead hook the removal exists to prevent. Use `SessionStart`.

export type AutomationTrigger = AppEvent | AgentEvent

export const APP_EVENTS: AppEvent[] = [
  'LabelAdd', 'LabelRemove', 'LabelConfigChange',
  'PermissionModeChange', 'FlagChange', 'TodoStateChange', 'SessionStatusChange', 'SchedulerTick'
]

export const AGENT_EVENTS: AgentEvent[] = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification',
  'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PermissionRequest'
]

export interface PromptAction {
  type: 'prompt'
  prompt: string
  /** LLM connection slug override for the spawned session */
  llmConnection?: string
  /** Model ID override for the spawned session */
  model?: string
  /** Thinking level override for the spawned session */
  thinkingLevel?: ThinkingLevel
}

export interface WebhookAction {
  type: 'webhook'
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  bodyFormat?: 'json' | 'form' | 'raw'
  captureResponse?: boolean
}

export type AutomationAction = PromptAction | WebhookAction | ScriptAction

// ============================================================================
// Conditions (mirrored from packages/shared/src/automations/types.ts)
// ============================================================================

export interface TimeConditionUI {
  condition: 'time'
  after?: string
  before?: string
  weekday?: string[]
  timezone?: string
}

export interface StateConditionUI {
  condition: 'state'
  field: string
  value?: unknown
  from?: unknown
  to?: unknown
  contains?: string
  not_value?: unknown
}

export interface LogicalConditionUI {
  condition: 'and' | 'or' | 'not'
  conditions: AutomationConditionUI[]
}

export type AutomationConditionUI = TimeConditionUI | StateConditionUI | LogicalConditionUI

/** Human-friendly field names for state conditions */
const FIELD_LABELS: Record<string, string> = {
  permissionMode: 'permission mode',
  sessionStatus: 'session status',
  isFlagged: 'flagged',
  labels: 'label',
  sessionName: 'session name',
}

/** Get a readable field name, falling back to the raw field */
function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field
}

/** Produce a short human-readable label for a single leaf condition */
function describeLeaf(c: AutomationConditionUI): string {
  switch (c.condition) {
    case 'time': {
      const parts: string[] = []
      if (c.weekday?.length) parts.push(c.weekday.join(', '))
      if (c.after) parts.push(`after ${c.after}`)
      if (c.before) parts.push(`before ${c.before}`)
      if (c.timezone) parts.push(`(${c.timezone})`)
      return parts.length ? parts.join(' ') : 'any time'
    }
    case 'state': {
      const label = fieldLabel(c.field)
      if (c.from !== undefined || c.to !== undefined) {
        const from = c.from !== undefined ? String(c.from) : 'any'
        const to = c.to !== undefined ? String(c.to) : 'any'
        return `${label} changed from ${from} to ${to}`
      }
      if (c.contains) return `has ${label} "${c.contains}"`
      if (c.not_value !== undefined) {
        if (c.field === 'isFlagged') return c.not_value ? 'not flagged' : 'is flagged'
        return `${label} is not ${String(c.not_value)}`
      }
      if (c.value !== undefined) {
        if (c.field === 'isFlagged') return c.value ? 'is flagged' : 'not flagged'
        return `${label} is ${String(c.value)}`
      }
      return label
    }
    case 'and':
    case 'or':
    case 'not': {
      const sep = c.condition === 'not' ? ' and not ' : ` ${c.condition} `
      return c.conditions.map(describeLeaf).join(sep)
    }
    default:
      return 'unknown condition'
  }
}

/**
 * Flatten a condition tree into displayable rows.
 * Logical conditions are expanded so their children appear as joined text.
 * Returns an array of { label, description } for rendering in Info_Table.
 */
export function flattenConditions(conditions: AutomationConditionUI[]): { label: string; description: string }[] {
  const rows: { label: string; description: string }[] = []
  for (const c of conditions) {
    if (c.condition === 'and' || c.condition === 'or' || c.condition === 'not') {
      // Flatten: join inner descriptions with the operator
      const sep = c.condition === 'not' ? ' and not ' : ` ${c.condition} `
      const inner = c.conditions.map(describeLeaf).join(sep)
      // Use the label of the first child type, or 'Condition' as fallback
      const firstChild = c.conditions[0]
      const label = firstChild
        ? firstChild.condition === 'time' ? 'Time'
          : firstChild.condition === 'state' ? 'State'
          : 'Condition'
        : 'Condition'
      rows.push({ label, description: inner })
    } else {
      const label = c.condition === 'time' ? 'Time' : c.condition === 'state' ? 'State' : 'Condition'
      rows.push({ label, description: describeLeaf(c) })
    }
  }
  return rows
}

// ============================================================================
// List Item (flattened from automations.json for display)
// ============================================================================

export interface AutomationListItem {
  /** Stable 6-char hex ID from automations.json, with fallback to event+index for legacy configs */
  id: string
  /** The event this automation listens to */
  event: AutomationTrigger
  /** Index of this matcher within its event array in automations.json (for write-back) */
  matcherIndex: number
  /** Display name (user-set or auto-derived) */
  name: string
  /** Human-readable summary */
  summary: string
  /** Whether this automation is enabled */
  enabled: boolean
  /** Regex matcher (if any) */
  matcher?: string
  /** Cron expression (SchedulerTick only) */
  cron?: string
  /** IANA timezone for cron */
  timezone?: string
  /** Permission mode */
  permissionMode?: PermissionMode
  /** Labels for prompt sessions */
  labels?: string[]
  /** Conditions that must pass before actions run */
  conditions?: AutomationConditionUI[]
  /** The actions this automation performs */
  actions: AutomationAction[]
  /** Timestamp of last execution (ms since epoch) */
  lastExecutedAt?: number; /** F1.795 — the managed codex policy keeps it from running (automations:get's flag) */ managedDisabled?: true
}

// ============================================================================
// Filter
// ============================================================================

export type AutomationFilterKind = 'all' | 'app' | 'agent' | 'scheduled'

export interface AutomationListFilter {
  kind: AutomationFilterKind
}

/** Maps task type (from route) to AutomationFilterKind for the list panel */
export const AUTOMATION_TYPE_TO_FILTER_KIND: Record<string, AutomationFilterKind> = {
  scheduled: 'scheduled',
  event: 'app',
  agentic: 'agent',
}

// ============================================================================
// Execution History
// ============================================================================

/** UB4.8 — `skipped`: the loop guard silenced the run; UB6.9 adds the semantic-condition skips. The timeline reads the reason either way. */
export type ExecutionStatus = 'success' | 'error' | 'blocked' | 'skipped'

export interface WebhookDetails {
  method: string
  url: string
  statusCode: number
  durationMs: number
  attempts?: number
  /** UB4.27 — why the run failed, as the host's webhook executor recorded it (capped at HISTORY_FIELD_MAX_LENGTH). */
  error?: string
  /** UB4.27 — the response body the host captured, capped, possibly truncated and not valid JSON. */
  responseBody?: string
}

export interface ExecutionEntry {
  id: string
  automationId: string
  event: AutomationTrigger
  status: ExecutionStatus
  /** Duration in milliseconds */
  duration: number
  /** Timestamp in ms since epoch */
  timestamp: number
  /** Error message (if status === 'error') */
  error?: string
  /** Truncated action summary */
  actionSummary?: string
  /** Session ID created by this execution (for deep linking) */
  sessionId?: string
  /** Structured webhook execution details (expandable in timeline) */
  webhookDetails?: WebhookDetails
}

// ============================================================================
// Test Panel
// ============================================================================

export type TestState = 'idle' | 'running' | 'success' | 'error'

export interface TestResult {
  state: TestState
  stderr?: string
  duration?: number
}

// ============================================================================
// Human-Friendly Display Names
// ============================================================================

/** Maps internal event names to user-friendly labels */
export const EVENT_DISPLAY_NAMES: Record<AutomationTrigger, string> = {
  // App events
  LabelAdd:             'Label Added',
  LabelRemove:          'Label Removed',
  LabelConfigChange:    'Label Settings Changed',
  PermissionModeChange: 'Permission Changed',
  FlagChange:           'Flag Changed',
  TodoStateChange:      'Task Updated',
  SessionStatusChange:  'Status Changed',
  SchedulerTick:        'Scheduled',

  // Agent events
  PreToolUse:           'Before Tool Runs',
  PostToolUse:          'After Tool Runs',
  PostToolUseFailure:   'When Tool Fails',
  Notification:         'Notification',
  UserPromptSubmit:     'Message Sent',
  SessionStart:         'Session Started',
  SessionEnd:           'Session Ended',
  Stop:                 'Agent Stopped',
  SubagentStart:        'Sub-agent Started',
  SubagentStop:         'Sub-agent Stopped',
  PreCompact:           'Before Memory Cleanup',
  PermissionRequest:    'Permission Requested',
}

export function getEventDisplayName(event: AutomationTrigger): string {
  return EVENT_DISPLAY_NAMES[event] ?? event
}

/**
 * F1.1052 — an automation's permission mode, named as every other surface names it: the i18n `mode.*`
 * keys (Claude Code's names, "Don't ask" for `dontAsk` — never "Unattended"). This was an English-only copy
 * of the same six labels, and it named a missing mode "Explore", a mode that no longer exists.
 *
 * A missing mode reads as Plan: an automation created without one runs in Plan (F1.1050).
 * `t` is the caller's translator, so the value follows the UI language like the labels beside it.
 */
export function getPermissionDisplayName(
  mode: PermissionMode | undefined,
  t: (key: string) => string,
): string {
  return t(`mode.${mode ?? 'plan'}`)
}

// ============================================================================
// Event Categorization (for AutomationAvatar colors)
// ============================================================================

export type EventCategory =
  | 'scheduled'
  | 'label'
  | 'permission'
  | 'flag'
  | 'todo'
  | 'agent-pre'
  | 'agent-post'
  | 'agent-error'
  | 'session'
  | 'other'

// ============================================================================
// automations.json Parser
// ============================================================================

/** Raw automations.json file structure */
interface AutomationsConfigFile {
  version: number
  automations?: Record<string, AutomationsConfigMatcher[]>; managedLocalAutomationDisabled?: true // F1.795 — sent by automations:get
}

type RawAction =
  | { type: 'prompt'; prompt: string; llmConnection?: string; model?: string; thinkingLevel?: ThinkingLevel }
  | { type: 'webhook'; url: string; method?: string; bodyFormat?: 'json' | 'form' | 'raw'; captureResponse?: boolean } | ScriptAction

interface AutomationsConfigMatcher {
  id?: string
  name?: string
  matcher?: string
  cron?: string
  timezone?: string
  permissionMode?: PermissionMode
  labels?: string[]
  conditions?: AutomationConditionUI[]
  enabled?: boolean
  actions?: RawAction[]
}

/** Derive a human-readable name from task actions and event */
function deriveAutomationName(event: string, matcher: AutomationsConfigMatcher): string {
  if (matcher.name) return matcher.name
  const allActions = matcher.actions ?? []
  const firstAction = allActions[0]
  if (!firstAction) return getEventDisplayName(event as AutomationTrigger)

  if (firstAction.type === 'webhook') {
    const label = `Webhook ${firstAction.method ?? DEFAULT_WEBHOOK_METHOD} ${firstAction.url}`
    return label.length > 40 ? label.slice(0, 40) + '...' : label
  }
  if (firstAction.type === 'script') return scriptAutomationName(firstAction.script) // UA8.3 (helper at the file end)
  // Extract @skill mentions or use first ~40 chars
  const mentionMatch = firstAction.prompt.match(/@(\S+)/)
  if (mentionMatch) return `${mentionMatch[1]} prompt`
  return firstAction.prompt.length > 40
    ? firstAction.prompt.slice(0, 40) + '...'
    : firstAction.prompt
}

/** Derive a summary line from the matcher/cron/event */
function deriveAutomationSummary(event: string, matcher: AutomationsConfigMatcher): string {
  if (matcher.cron) {
    const runs = computeNextRuns(matcher.cron, 1, matcher.timezone) // UB14.49 — computed in the zone it is shown in
    if (runs.length > 0) {
      const next = runs[0]!
      const tz = matcher.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
      const tzCity = tz.split('/').pop()?.replace(/_/g, ' ') ?? tz
      const formatted = next.toLocaleString('en-US', {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: tz,
      })
      return `Next run: ${formatted} (${tzCity})`
    }
    const tz = matcher.timezone ? ` (${matcher.timezone})` : ''
    return `Cron: ${matcher.cron}${tz}`
  }
  if (matcher.matcher) {
    return `Matches: ${matcher.matcher}`
  }
  return `On ${getEventDisplayName(event as AutomationTrigger)}`
}

/**
 * Parse an automations.json file into a flat list of AutomationListItem[].
 * Each matcher entry under each event becomes one item.
 */
export function parseAutomationsConfig(json: unknown): AutomationListItem[] {
  if (!json || typeof json !== 'object') return []
  const config = json as AutomationsConfigFile
  const eventMap = config.automations
  if (!eventMap || typeof eventMap !== 'object') return []

  const allEvents = [...APP_EVENTS, ...AGENT_EVENTS] as string[]
  const items: AutomationListItem[] = []
  let index = 0

  for (const [eventName, matchers] of Object.entries(eventMap)) {
    if (!Array.isArray(matchers)) continue
    const event = (allEvents.includes(eventName) ? eventName : eventName) as AutomationTrigger

    for (let matcherIdx = 0; matcherIdx < matchers.length; matcherIdx++) {
      const matcher = matchers[matcherIdx]
      const rawActions = matcher.actions
      if (!rawActions || !Array.isArray(rawActions) || rawActions.length === 0) continue

      const actions: AutomationAction[] = rawActions
        .filter((a): a is AutomationAction => a.type === 'prompt' || a.type === 'webhook' || a.type === 'script') // UA8.3
      if (actions.length === 0) continue

      items.push({
        id: matcher.id ?? `${eventName}-${index}`,
        event,
        matcherIndex: matcherIdx,
        name: deriveAutomationName(eventName, matcher),
        summary: deriveAutomationSummary(eventName, matcher),
        enabled: matcher.enabled !== false,
        matcher: matcher.matcher,
        cron: matcher.cron,
        timezone: matcher.timezone,
        // Alias-resolved: a persisted automation may carry a pre-migration
        // spelling ('ask'/'safe'/'allow-all'); the list should render the mode,
        // not the raw legacy string.
        permissionMode: typeof matcher.permissionMode === 'string'
          ? (parsePermissionMode(matcher.permissionMode) ?? matcher.permissionMode) as PermissionMode
          : matcher.permissionMode,
        labels: matcher.labels,
        conditions: matcher.conditions,
        actions,
        // F1.795 — the policy disables the scheduler AND the hooks, so every automation is marked.
        ...(config.managedLocalAutomationDisabled === true ? { managedDisabled: true as const } : {}),
      })
      index++
    }
  }

  return items
}

export function getEventCategory(event: AutomationTrigger): EventCategory {
  switch (event) {
    case 'SchedulerTick':
      return 'scheduled'
    case 'LabelAdd':
    case 'LabelRemove':
    case 'LabelConfigChange':
      return 'label'
    case 'PermissionModeChange':
    case 'PermissionRequest':
      return 'permission'
    case 'FlagChange':
      return 'flag'
    case 'TodoStateChange':
    case 'SessionStatusChange':
      return 'todo'
    case 'PreToolUse':
    case 'UserPromptSubmit':
    case 'PreCompact':
    case 'SubagentStart':
      return 'agent-pre'
    case 'PostToolUse':
    case 'SessionEnd':
    case 'SubagentStop':
    case 'Stop':
      return 'agent-post'
    case 'PostToolUseFailure':
      return 'agent-error'
    case 'SessionStart':
    case 'Notification':
      return 'session'
    default:
      return 'other'
  }
}

/**
 * UA8.3 — the timeline line of a script run. A run the HOST refused (unapproved, changed since approval, the managed
 * policy) or skipped names the host's reason, so the person sees why it did not run.
 */
export function scriptHistorySummary(
  script: { script: string; blocked?: boolean; skipped?: boolean; timedOut?: boolean },
  error: string | undefined,
): string {
  if ((script.blocked || script.skipped) && error) return `Script ${script.script} — ${error}`
  if (script.timedOut) return `Script ${script.script} (timed out)`
  return `Script ${script.script}`
}

/**
 * UA8.3 — a script action (mirrored from packages/shared/src/automations/types.ts `ScriptAction`), with the
 * approval state the host read against its ledger (`SafeScriptAutomationAction`). It runs only once the person
 * approved its current bytes. Kept at the file end so the lines cited above stay where they were.
 */
export interface ScriptAction {
  type: 'script'
  script: string
  args?: string[]
  runtime?: 'bun' | 'node' | 'python3'
  timeoutMs?: number
  page?: string
  approval?: { state: 'outside' | 'missing' | 'unapproved' | 'changed' | 'approved'; sha256?: string }
}

/** UA8.3 — the derived name of an unnamed automation whose first action is a script (the webhook branch's shape). */
function scriptAutomationName(script: string): string {
  const label = `Script ${script}`
  return label.length > 40 ? label.slice(0, 40) + '...' : label
}
