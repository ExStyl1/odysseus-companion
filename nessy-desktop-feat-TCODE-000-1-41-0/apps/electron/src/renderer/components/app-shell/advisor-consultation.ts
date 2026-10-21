/**
 * P4.5 — WHAT AN `advisor_consult` ROW SHOWS, decided on values.
 *
 * P2.1 built the advisor host-side and made the tool reply the injection point:
 * `BaseAgent.executeAdvisorConsult` returns the guidance as the tool RESULT, and
 * that result is the ONLY channel — its own header says so ("There is no second
 * channel, and adding one would put advice into the transcript the model never
 * asked for"). Until this row the renderer had never heard of the tool: measured
 * 2026-09-01, `advisor_consult` appears NOWHERE in `apps/electron/src/renderer`
 * or `packages/ui/src` outside a comment in `runtime-switch-costs.ts`, and
 * `HIDDEN_TOOLS` is empty — so a consultation drew a generic tool row titled
 * "Advisor Consult" (`formatToolName`'s snake_case fallback) with the advice
 * itself reachable only by opening the details pane.
 *
 * WHY A MODULE AND NOT AN INLINE PARSE. The same reason `intermediate-row.ts`
 * and `tool-elapsed.ts` give: the card's decision has to be assertable on
 * VALUES, and a card rendered from `ChatDisplay` cannot be — that component is
 * 3000 lines and unloadable in a shared bun test process
 * (`__tests__/background-task-chip.test.tsx` measures why). `TodoListCard`
 * keeps its predicate beside its JSX; this one is bigger than a predicate,
 * because it reads a string another package produces.
 *
 * THE COUPLING, NAMED RATHER THAN HIDDEN. `executeAdvisorConsult` composes
 * guidance as `Advisor (${modelId}):\n\n${text}` and is deliberately English and
 * un-i18n'd, "for the reason `backend/codex/event-adapter.ts` states on its own
 * strings: this text is read by a MODEL". So the model name and the guidance
 * body are recoverable only by reading that shape back. This module is the one
 * place that does, {@link ADVISOR_GUIDANCE_PREFIX} is the whole of what it
 * assumes, and `__tests__/advisor-consultation.test.ts` pins the producer's
 * literal so a drift there reddens here instead of shipping a blank card.
 *
 * AND THE FAILURE IS FAIL-SAFE, which is why parsing a sibling package's string
 * is acceptable at all. Anything that is not guidance in exactly that shape —
 * every one of the six refusal sentences, a malformed reply, a future change to
 * the literal — returns `null`, and `ChatDisplay` then falls through to the
 * ordinary `ActivityRow`. The worst case is today's behaviour, never a row that
 * lost its content. The refusals are deliberately NOT matched: recognising them
 * would mean matching six English sentences to re-localize them, and they
 * already have a localized twin surface in `/advisor`'s status output
 * (`settings.ai.advisor.status*`), which `advisor.md#use-the-/advisor-command`
 * names as the place a user reads them.
 */

/** The three documented consultation moments (`advisor.md`, via `ADVISOR_MOMENTS`). */
export type AdvisorMomentId = 'approach' | 'recurring-error' | 'before-done'

const MOMENT_IDS: readonly AdvisorMomentId[] = ['approach', 'recurring-error', 'before-done']

/**
 * The literal `BaseAgent.executeAdvisorConsult` opens a successful reply with.
 * Captures the model id; the guidance follows after a blank line.
 */
export const ADVISOR_GUIDANCE_PREFIX = /^Advisor \(([^)]+)\):\n\n/

/** The tool name the three runtimes all spell the same way. */
export const ADVISOR_TOOL_NAME = 'advisor_consult'

/**
 * The fields the card reads — anything shaped like an `ActivityItem` works.
 * Declared structurally rather than imported so this module stays loadable
 * under `bun test`, the one-way dependency `intermediate-row.ts` also keeps.
 */
export interface AdvisorConsultActivity {
  toolName?: string
  status?: string
  content?: string
  toolInput?: Record<string, unknown>
}

export interface AdvisorConsultation {
  /** The advising model, exactly as the host reported it. */
  modelId: string
  /** The advice itself, with the header stripped. Never empty. */
  guidance: string
  /** The moment the model named, when it named a recognised one. */
  moment?: AdvisorMomentId
  /** What the model asked, when it asked something. */
  question?: string
}

/** Whether this row is an advisor consultation at all — name only, any status. */
export function isAdvisorConsultActivity(activity: AdvisorConsultActivity): boolean {
  return activity.toolName?.toLowerCase() === ADVISOR_TOOL_NAME
}

/**
 * Whether `ChatDisplay` should route this row to the card — the FULL decision,
 * not the tool name.
 *
 * The distinction is load-bearing and P3.24 paid for it once already, in this
 * exact slot: `renderActivityCard` returns a React ELEMENT, so `TurnCard`'s
 * `renderActivity?.(props) ?? <ActivityRow …>` fallback can never fire once a
 * card has been chosen — an element is not nullish, and a card that renders
 * `null` therefore removes the row from the transcript instead of yielding it
 * back. `activity-card-routing.ts` records the same finding for the subagent
 * card ("dropping the progress check would hand those rows to `SubagentCard`,
 * which renders `null` for them, and the row would vanish entirely").
 *
 * So the router must ask the question the card will ask, which is why this is
 * the parse and not the name. A refused consult, a running one and a drifted
 * reply all stay on the ordinary row, where their content is still readable.
 */
export function isAdvisorCardActivity(activity: AdvisorConsultActivity): boolean {
  return describeAdvisorConsultation(activity) !== null
}

/**
 * The consultation a row carries, or `null` when the card must not render.
 *
 * `null` covers four distinct states and they are one branch on purpose,
 * because the caller's response to all four is identical — fall through to the
 * ordinary row: a different tool, a consult still running or errored, a refusal
 * sentence, and a guidance body that survived the prefix as empty.
 */
export function describeAdvisorConsultation(
  activity: AdvisorConsultActivity,
): AdvisorConsultation | null {
  if (!isAdvisorConsultActivity(activity)) return null
  // A running consult has no reply yet and an errored one has a stack, not
  // advice. Both belong on the ordinary row, which already paints them.
  if (activity.status !== 'completed') return null

  const content = activity.content
  if (typeof content !== 'string') return null
  const match = ADVISOR_GUIDANCE_PREFIX.exec(content)
  if (!match) return null

  const modelId = match[1]!.trim()
  const guidance = content.slice(match[0].length).trim()
  if (!modelId || !guidance) return null

  const rawMoment = activity.toolInput?.moment
  const moment = MOMENT_IDS.find(candidate => candidate === rawMoment)
  const rawQuestion = activity.toolInput?.question
  const question = typeof rawQuestion === 'string' && rawQuestion.trim()
    ? rawQuestion.trim()
    : undefined

  return { modelId, guidance, moment, question }
}
