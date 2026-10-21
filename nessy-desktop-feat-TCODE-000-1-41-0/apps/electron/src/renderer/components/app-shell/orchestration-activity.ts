/**
 * P6.305 / denominator H12 — what a running subagent is DOING, in one line, from
 * ONE source.
 *
 * ## What was wrong
 *
 * `OrchestrationProgressAgent.lastActivity` has existed on the shared wire since
 * the orchestration panel was built, and the Pi orchestrator writes it on every
 * progress emit — `'started'`, then the child's raw event `type`, then the
 * result status (`orchestrator/subagent-tool.ts`, `orchestrator/workflow-tool.ts`).
 * Of the two cards fed by that snapshot, `SubagentCard` never rendered it at all
 * and `WorkflowPanel` rendered it RAW, so the user's answer to *"what is this
 * agent doing?"* was either a spinner or the literal string
 * `tool_execution_start`. Both are this function's callers now, so the two cards
 * cannot disagree and a new activity token is spelled once.
 *
 * ## Native mechanism, asked and answered (owner rule, native-first)
 *
 * - **Pi** — none of its own; the token IS the host's field, already written.
 * - **claude** — one exists and it is better than anything we could synthesize:
 *   `Options.agentProgressSummaries` (vendored `sdk.d.ts:1825`), whose own
 *   comment says the subagent's conversation "is forked every ~30s to produce a
 *   short present-tense description (e.g. \"Analyzing authentication module\"),
 *   emitted on `task_progress` events via the `summary` field", and adds that
 *   "The fork reuses the subagent's model and prompt cache, so cost is typically
 *   minimal." `SDKTaskProgressMessage` (`:4758`) also carries `last_tool_name`
 *   and `description` with NO option to enable. Both score zero in this tree.
 *   Enabling it was step (1) and landed in `claude-agent.ts` (`6f3d5239b`);
 *   F1.919 turned it OFF again, because the fork re-issued a worker's pending
 *   tool call as a second, dead permission card. The claude row now shows
 *   `last_tool_name` (a tool name, through the table below), not a sentence.
 * - **codex** — none: its adapter builds progress rows without an activity field
 *   at all. Also not this lane's file.
 *
 * So the shape is deliberately the host's: a token in, a sentence out. Whatever
 * a runtime learns to publish arrives as another token and meets this table.
 *
 * ## Why a table and not a formatter
 *
 * The token space is OPEN. Pi's `AgentSessionEvent` is `AgentEvent` plus a dozen
 * session-level members, and the union grows with the vendored package; a
 * formatter that pattern-matched would silently invent meanings for members it
 * had never seen. Every token whose meaning we can state gets a sentence, and
 * everything else falls back to the token with its separators softened — legible
 * without being a claim. The RAW token always stays reachable through
 * {@link orchestrationActivityTitle}, so softening never costs a reader the exact
 * value (the same posture `agentRowModelLabel` takes for a model id).
 */

/**
 * Tokens whose whole content is the row's STATUS, which both cards already
 * render immediately to the left. Rendering them would produce `Running ·
 * Running` and `Done · Done`, so the activity slot stays empty instead — an
 * empty slot is the honest rendering of "nothing to add", and it is also what
 * every card showed before this function existed.
 */
const STATUS_ECHO_TOKENS: ReadonlySet<string> = new Set([
  'queued',
  'started',
  'agent_start',
  'running',
  'done',
  'error',
  'aborted',
])

/**
 * One i18n key per token whose meaning is stateable. Several tokens share a key
 * on purpose: the start and the update of the same act read identically to a
 * user watching a line change, and splitting them would add a sentence that says
 * nothing new.
 */
const ACTIVITY_KEYS: Readonly<Record<string, string>> = {
  turn_start: 'turnCard.orchestration.activity.working',
  message_start: 'turnCard.orchestration.activity.writing',
  message_update: 'turnCard.orchestration.activity.writing',
  message_end: 'turnCard.orchestration.activity.writing',
  tool_execution_start: 'turnCard.orchestration.activity.tool',
  tool_execution_update: 'turnCard.orchestration.activity.tool',
  tool_execution_end: 'turnCard.orchestration.activity.toolDone',
  turn_end: 'turnCard.orchestration.activity.stepDone',
  agent_end: 'turnCard.orchestration.activity.wrappingUp',
  agent_settled: 'turnCard.orchestration.activity.wrappingUp',
  compaction_start: 'turnCard.orchestration.activity.compacting',
  compaction_end: 'turnCard.orchestration.activity.compacting',
  auto_retry_start: 'turnCard.orchestration.activity.retrying',
  auto_retry_end: 'turnCard.orchestration.activity.retrying',
  'journal-replay': 'turnCard.orchestration.activity.journalReplay',
}

/** The keys this module can ask for, so a locale sweep can assert all of them exist. */
export const ORCHESTRATION_ACTIVITY_KEYS: readonly string[] = [
  ...new Set(Object.values(ACTIVITY_KEYS)),
]

/** Softened, never re-worded: `tool_execution_start` → `tool execution start`. */
function softenToken(raw: string): string {
  return raw.replace(/[_-]+/g, ' ').trim()
}

export type ActivityTranslate = (key: string) => string

/**
 * The line a card shows beside the status, or `undefined` when there is nothing
 * to add.
 *
 * `undefined` — never an empty string — for an absent token, a whitespace-only
 * token and a status echo, so a caller can render the separator and the span
 * together or not at all.
 */
export function orchestrationActivityLabel(
  raw: string | undefined,
  t: ActivityTranslate,
): string | undefined {
  const token = raw?.trim()
  if (!token) return undefined
  if (STATUS_ECHO_TOKENS.has(token)) return undefined
  const key = ACTIVITY_KEYS[token]
  return key ? t(key) : softenToken(token)
}

/**
 * The hover text carrying the RAW token, for the same reason the model label
 * keeps the raw id on `title`: a sentence is a reading of the token and a reader
 * must be able to get back to the token itself.
 */
export function orchestrationActivityTitle(
  raw: string | undefined,
  t: (key: string, options: { raw: string }) => string,
): string | undefined {
  const token = raw?.trim()
  if (!token) return undefined
  return t('turnCard.orchestration.activity.title', { raw: token })
}
