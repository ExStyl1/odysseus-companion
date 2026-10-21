/**
 * The workflow keyword trigger and its origin gate.
 *
 * `workflows.md` §Where the keyword works is a security boundary, not a UX
 * note. The keyword "is an opt-in only in a prompt you type yourself"; it must
 * not start a workflow from a headless prompt, an SDK send that does not stamp
 * its input as human, a scheduled task prompt, or "a webhook payload or pull
 * request comment relayed into the conversation". Claude records the permissive
 * behaviour as a fixed defect (before v2.1.210 the keyword fired from all of
 * those routes), so the gate here is fail-closed: only an explicitly human
 * origin can trigger, and every other origin — including an unstamped one — is
 * treated as relayed.
 */

import type { AgentProvider } from '../agent/backend/types.ts'

/** The literal keyword, matching Claude's current spelling. */
export const WORKFLOW_TRIGGER_KEYWORD = 'ultracode'

/**
 * Which runtimes can actually act on the directive this keyword appends.
 *
 * P2.315. The origin gate above was the only gate, so a `claude-runtime` or
 * `codex-runtime` session that saw the keyword had
 * {@link WORKFLOW_KEYWORD_TRIGGER_DIRECTIVE} appended to its prompt — a
 * directive naming the `workflow` tool, which exists only in
 * `pi-agent-server/src/orchestrator/` and is not on those sessions' tool
 * surface. Nothing errored: the model read a marker addressed to a tool it does
 * not have. That is P2.212's defect one route up — the slash-command route was
 * already gated by `BaseAgent.canDispatchWorkflowCommands()` and yields
 * `settings.ai.workflows.dispatchUnavailable`; the keyword route was not gated
 * at all.
 *
 * `workflows.md#ask-for-a-workflow-in-your-prompt` says what the keyword is for
 * — "Claude Code highlights the keyword in your input and Claude writes a
 * workflow script for the task instead of working through it turn by turn." A
 * runtime that cannot run the script cannot honour that, so the keyword is
 * simply not in effect there and the prompt is left exactly as the user typed
 * it.
 *
 * TOTAL over the runtime vocabulary (P2.124): `Record`, not `Partial<Record>`,
 * so a runtime added to `AgentProvider` breaks the build here instead of
 * inheriting a silent default. The `true` set must equal the set of backends
 * that consume `ChatOptions['workflowInvocation']`; `workflow-keyword.test.ts`
 * asserts exactly that against the backend sources, which is the same property
 * `runtime-capability-drift.test.ts` holds for the slash-command arm.
 */
export const WORKFLOW_KEYWORD_DISPATCH_RUNTIMES: Readonly<Record<AgentProvider, boolean>> = Object.freeze({
  pi: true,
  anthropic: false,
  'codex-runtime': false,
  'nestor-cloud-agent': false,
})

/**
 * How a prompt reached the session. Only `'human'` is a keyboard-typed prompt
 * from the person at the client; everything else is a relay of some kind and
 * can never opt into orchestration on the user's behalf.
 */
export type WorkflowPromptOrigin = 'human' | 'relayed' | 'automation' | 'headless'

const KEYWORD_PATTERN = new RegExp(`(?:^|[^\\p{L}\\p{N}_])${WORKFLOW_TRIGGER_KEYWORD}(?![\\p{L}\\p{N}_])`, 'iu')

/**
 * True when this prompt opts into workflow orchestration.
 *
 * All three gates are required and all three fail closed: the trigger must be
 * enabled (`workflowKeywordTriggerEnabled`, which `disableWorkflows` also forces
 * off), the origin must be human, and the session's runtime must be one that can
 * dispatch a workflow ({@link WORKFLOW_KEYWORD_DISPATCH_RUNTIMES}). `provider`
 * is REQUIRED rather than defaulted for the same reason the origin is: a caller
 * that forgets it must fail to compile, not silently re-open the gate. A
 * provider string outside the vocabulary reads as `undefined` and is refused.
 */
export function detectWorkflowKeywordTrigger(
  text: string,
  options: { origin: WorkflowPromptOrigin; keywordTriggerEnabled: boolean; provider: AgentProvider },
): boolean {
  if (!options.keywordTriggerEnabled) return false
  if (options.origin !== 'human') return false
  if (WORKFLOW_KEYWORD_DISPATCH_RUNTIMES[options.provider] !== true) return false
  return KEYWORD_PATTERN.test(text)
}

/**
 * Model-facing directive appended to a triggered turn. It only chooses HOW the
 * work is structured — the run still passes through the ordinary launch consent
 * and the session's permission mode.
 */
export const WORKFLOW_KEYWORD_TRIGGER_DIRECTIVE =
  `The user included the \`${WORKFLOW_TRIGGER_KEYWORD}\` keyword, which opts this request into workflow `
  + 'orchestration. Write a workflow script for the task and run it with the workflow tool instead of '
  + 'working through the task turn by turn.'
