import type { SlashCommandId } from '@/components/ui/slash-command-menu'
import {
  PERMISSION_MODE_ORDER,
  type PermissionMode,
} from '@nessy-agent/shared/agent/modes'
import type { ComposerCapabilities } from '@nessy-agent/shared/protocol'
import { INIT_PROJECT_INSTRUCTIONS_PROMPT } from '@nessy-agent/shared/prompts/init'
import { CREATE_SKILL_PROMPT } from '@nessy-agent/shared/prompts/create-skill'
import { CREATE_PLUGIN_PROMPT } from '@nessy-agent/shared/prompts/create-plugin'
import { GOAL_INTERVIEW_PROMPT } from '@nessy-agent/shared/prompts/goal'
import { parseSessionCommand } from '@nessy-agent/shared/slash-commands/session-command'
import { SUBTASK_COMMAND_LABEL } from '@nessy-agent/shared/slash-commands/subtask'

export interface SlashCommandActionHandlers {
  isProcessing?: boolean
  onPermissionModeChange?: (mode: PermissionMode) => void
  allowedPermissionModes?: PermissionMode[]
  allowedCommandIds?: string[] | 'all'
  /** ComposerCapabilities.slash.excludedCommandIds — subtracted from the allowed set. */
  excludedCommandIds?: string[]
  /**
   * ComposerCapabilities.slash.excludedCommandIdPrefixes — subtracted the same
   * way, for the families whose ids the resolver cannot enumerate (a workflow
   * recipe's id carries its name). P2.279.
   */
  excludedCommandIdPrefixes?: string[]
  contextUsageCapability?: ComposerCapabilities['contextUsage']
  openAgents?: () => void
  openAutomations?: () => void
  openContext?: () => void
  openExport?: () => void
  openModelSelector?: () => void
  openMemory?: () => void
  openUsage?: () => void
  /** P6.278 — open the working-tree patch in the diff viewer. */
  openWorkingTreeDiff?: () => void
  refreshUsage?: () => Promise<void> | void
  /**
   * `/btw` from the menu — the BARE form: REOPEN the overlay on the most
   * recent exchange (interactive-mode.md:374). Never a prefill, never a
   * submitted message, and not gated on `isProcessing` (`:367`).
   */
  openSideQuestionOverlay?: () => void
  /** `/recap` — one-line on-demand summary (interactive-mode.md:398-404); same mid-turn availability. */
  requestRecap?: () => void
  submitCommand?: (command: string) => void
  /** Prefills the composer instead of submitting, for commands that need an argument. */
  prefillCommand?: (text: string) => void
}

/**
 * Commands whose selection PREFILLS the composer rather than submitting. A
 * `/subtask` with no task is not a command, it is a typo — `sub-agents.md:1013`
 * spells it "`/subtask` followed by a task" — so the menu leaves the caret after
 * the command instead of sending it.
 */
const PREFILL_COMMANDS: Partial<Record<SlashCommandId, string>> = {
  subtask: `${SUBTASK_COMMAND_LABEL} `,
  // P6.509 — same rule, same reason: `/cd` with no path is a typo. The typed
  // form then rides the ordinary message path to
  // `SessionManager.sendMessage`, which executes it before any turn starts;
  // this table only decides what selecting the MENU row does.
  cd: '/cd ',
}

function isCommandAllowed(
  commandId: SlashCommandId,
  allowedCommandIds?: string[] | 'all',
  excludedCommandIds?: string[],
  excludedCommandIdPrefixes?: string[],
): boolean {
  if (excludedCommandIds?.includes(commandId)) return false
  if (excludedCommandIdPrefixes?.some(prefix => commandId.startsWith(prefix))) return false
  return allowedCommandIds === undefined
    || allowedCommandIds === 'all'
    || allowedCommandIds.includes(commandId)
}

/**
 * The SECOND source of "this runtime refuses this command", beside the
 * resolver's exclusion lists: a capability the composer already holds that
 * answers the same question for one id.
 *
 * Today it has exactly one row, and that is the point — `/compact` used to
 * carry this condition as a bare `commandId === 'compact'` further down the
 * dispatch, where it ran AFTER the prefill branch had already returned. So a
 * capability refusal reached message commands and could never reach a prefill
 * command, and the product had two different treatments of one situation
 * (P2.322). A second entry added here now applies wherever the first does.
 *
 * Why a table and not a `provider` switch: every row must read the SAME value
 * the seam reads. `contextUsage.compact.manual` is resolved once server-side by
 * `composer-capabilities.ts` from the predicate `BaseAgent.canCompactContext()`
 * is tied to, so the menu, this dispatch and the send-path refusal cannot
 * answer differently. A row spelled `provider === 'x'` here would be a third
 * spelling of a fact that already has one.
 *
 * EXPORTED for `__tests__/slash-command-actions.test.ts` only. The generality
 * this row is about — the rule reaches a PREFILL command and not only a message
 * command — cannot be demonstrated while the table has exactly one row and that
 * row is a message command, so the test adds a row for a prefill id, asserts
 * the refusal, and removes it again. That is a behavioural proof rather than a
 * source-order assertion, and it keeps working when the second real row lands.
 */
export const CAPABILITY_REFUSALS: Partial<Record<SlashCommandId, (handlers: SlashCommandActionHandlers) => boolean>> = {
  compact: handlers => handlers.contextUsageCapability?.compact?.manual === false,
}

/**
 * P2.322 — ONE renderer rule for "unavailable on this runtime", consulted once
 * for EVERY command id before any branch of the dispatch runs.
 *
 * The row this closes: the resolver withdraws a refused row from the MENU
 * (`resolveExcludedCommandIds` — `subtask` off a runtime that cannot fork,
 * `compact` where manual compaction does not exist, `quota` off the gateway,
 * `btw`/`recap` on the remote agent), while the dispatch enforced a capability
 * refusal for `compact` alone, in an `if` placed below the prefill exit. The
 * two treatments were one file apart and neither was written down, so
 * `/subtask` — the only {@link PREFILL_COMMANDS} entry — could be prefilled by
 * a caller that passed capabilities but not the exclusion list, and `/compact`
 * could not. Same situation, two answers.
 *
 * Uniform now, in both directions: a refused command is refused whether it
 * prefills, submits, opens a panel or sets a permission mode, and the dispatch
 * returns `false` so the caller leaves the composer untouched rather than
 * parking a caret after a command the session will decline.
 *
 * What this deliberately does NOT do is refuse the TYPED form. `/compact` and
 * `/subtask` typed in full still travel to `BaseAgent.chat`, which answers with
 * the honest "not available on this runtime" — `sub-agents.md#fork-the-current-conversation`
 * promises the typed affordance ("You can start a fork yourself with `/subtask`
 * followed by a task, whether or not fork mode is on") and P3.71 kept it on
 * purpose. This rule decides only what the MENU may dispatch.
 *
 * Exported so the claim "the menu will not dispatch X here" has an instrument
 * that reads the RULE, in the shape `filterCommandsByCapability` is exported
 * for on the menu side.
 */
export function isCommandUnavailable(commandId: SlashCommandId, handlers: SlashCommandActionHandlers): boolean {
  if (!isCommandAllowed(
    commandId,
    handlers.allowedCommandIds,
    handlers.excludedCommandIds,
    handlers.excludedCommandIdPrefixes,
  )) {
    return true
  }
  return CAPABILITY_REFUSALS[commandId]?.(handlers) === true
}

function isPermissionModeCommand(
  commandId: SlashCommandId,
  allowedModes?: PermissionMode[],
): commandId is PermissionMode {
  if (!PERMISSION_MODE_ORDER.includes(commandId as PermissionMode)) return false
  return allowedModes === undefined || allowedModes.includes(commandId as PermissionMode)
}

const MESSAGE_COMMANDS: Partial<Record<SlashCommandId, string>> = {
  // P4.5 · `/advisor` is answered at the same session-command seam `/quota`
  // uses (`parseSessionCommand` → `BaseAgent.chat`), which every backend
  // inherits — so the composer submits the literal and there is no handler and
  // no RPC to add. It inherits this block's `isProcessing` gate for the same
  // reason `/quota` does: the seam is on the send path.
  advisor: '/advisor',
  // P2.217 · same seam, same reason: `/approve` is answered by
  // `BaseAgent.chat`'s `approve` arm, which every backend inherits, so the
  // composer submits the literal and there is no handler and no RPC to add.
  // Without this row the menu offered a command its own dispatcher refused —
  // caught by `slash-command-menu.test.tsx`'s offers-vs-dispatches grid, which
  // had never run against it (P3.316 poisoned the file at the base).
  approve: '/approve',
  compact: '/compact',
  // P6.634 · `/config` is a `session` row in `SESSION_COMMAND_HELP_ENTRIES`,
  // exactly like `/advisor`, `/approve` and `/quota`: `parseSessionCommand`
  // classifies it and the `BaseAgent.chat` seam every backend inherits answers
  // it, so the composer submits the literal and there is no handler and no RPC.
  // P6.410 announced the row in the menu and in `/help` but never added it
  // here, so the menu offered a command its own dispatcher refused — the
  // ADVERTISED anti-pattern P3.71's tripwire enumerates, and it was red.
  //
  // The MENU form is the BARE one: `/config` with no argument LISTS the
  // reachable keys (`config-command.ts`'s `formatSessionConfigListing`), which
  // is the only one of the command's three forms that needs no typing. The
  // `<key>` and `<key>=<value>` forms stay typed — deliberately not a
  // PREFILL_COMMANDS row, because the listing is a useful answer on its own,
  // where a bare `/subtask` is a typo.
  config: '/config',
  clear: '/clear',
  // P6.352 / P6.278 / P6.294 — THE SAME ROW THAT KEPT SHIPPING, three more
  // times. `/mcp`, `/diff` and `/hooks` are all `session` rows answered by the
  // `BaseAgent.chat` seam (`parseSeamReadCommand`), exactly like `/config`
  // above, and all three were announced in the menu and in `/help` without a
  // line here — so the menu offered a command its own dispatcher refused and
  // picking it did nothing at all. That is the ADVERTISED anti-pattern P3.71's
  // tripwire enumerates, and it is the fourth recurrence of the defect
  // `/config`'s own comment two lines up was written about.
  //
  // Found while adding the third, and fixed for all three together: the
  // tripwire that would have caught them (`slash-command-menu.test.tsx`'s
  // offered-vs-dispatchable grid) could not run — its `beforeAll` exceeds its
  // own 120 s budget under parallel load, which reports as "(unnamed) failed"
  // and names no row.
  //
  // `/diff` ALSO has a viewer branch above it. That branch returns first in the
  // desktop composer; this line is what keeps the command working on every
  // surface that has no overlay to open.
  mcp: '/mcp',
  diff: '/diff',
  hooks: '/hooks',
  // P6.447 — the fifth recurrence of the row three lines up, caught before it
  // shipped: `/status` had a `parseSeamReadCommand` row and a `BaseAgent.chat`
  // arm and no line here, so the menu would have offered a command its own
  // dispatcher refused. Same seam, same reason, same one-line answer.
  status: '/status',
  help: '/help',
  // `/quota` is answered at the session-command seam (`BaseAgent.chat`), so the
  // composer only has to submit the literal command — no handler, no RPC. It
  // therefore inherits this block's `isProcessing` gate: unavailable mid-turn,
  // exactly like `/compact` and `/clear`, and accepted as such.
  quota: '/quota',
  // `/init` expands to the shared project-instructions scaffold prompt (adapted
  // from openai/codex, Apache-2.0). The agent inspects the repo with its
  // existing read tools and writes AGENTS.md through the normal
  // permission-gated Write path — no elevated access. Single source of truth in
  // packages/shared/src/prompts/init.ts.
  init: INIT_PROJECT_INSTRUCTIONS_PROMPT,
  // `/create-skill` and `/create-plugin` follow the exact same prompt-macro
  // precedent: they expand to shared prompt constants that interview the user
  // and scaffold a skill/plugin through the NORMAL permission-gated Write path,
  // then verify via the existing `skill_validate` tool (skills) / the existing
  // plugin-management local-install path (plugins). No elevated access, no new
  // tool. Single source of truth in packages/shared/src/prompts/create-skill.ts
  // and create-plugin.ts.
  'create-skill': CREATE_SKILL_PROMPT,
  'create-plugin': CREATE_PLUGIN_PROMPT,
  // P6.322 half 2 · the same prompt-macro precedent, for the same reason: the
  // `Goal` tool already takes a `condition` and P2.2 removed its `pi-only`
  // visibility, so what was missing was the INTERVIEW that produces a condition
  // the evaluator can settle. Named `goal` and not `plan` because `plan` is a
  // `PermissionMode`, and the mode branch of this dispatcher runs first — see
  // `prompts/goal.ts` for the measurement.
  goal: GOAL_INTERVIEW_PROMPT,
}

export function dispatchSlashCommandAction(
  commandId: SlashCommandId,
  handlers: SlashCommandActionHandlers,
): boolean {
  // THE gate — one rule, every id, before every branch below (P2.322).
  if (isCommandUnavailable(commandId, handlers)) {
    return false
  }

  if (isPermissionModeCommand(commandId, handlers.allowedPermissionModes)) {
    handlers.onPermissionModeChange?.(commandId)
    return Boolean(handlers.onPermissionModeChange)
  }

  if (commandId === 'model') {
    handlers.openModelSelector?.()
    return Boolean(handlers.openModelSelector)
  }

  if (commandId === 'agents') {
    handlers.openAgents?.()
    return Boolean(handlers.openAgents)
  }

  if (commandId === 'automations') {
    handlers.openAutomations?.()
    return Boolean(handlers.openAutomations)
  }

  if (commandId === 'context') {
    handlers.openContext?.()
    return Boolean(handlers.openContext)
  }

  if (commandId === 'export') {
    handlers.openExport?.()
    return Boolean(handlers.openExport)
  }

  if (commandId === 'memory') {
    handlers.openMemory?.()
    return Boolean(handlers.openMemory)
  }

  if (commandId === 'usage') {
    if (!handlers.openUsage) return false
    if (handlers.refreshUsage) {
      Promise.resolve(handlers.refreshUsage())
        .catch(() => undefined)
        .finally(() => handlers.openUsage?.())
    } else {
      handlers.openUsage()
    }
    return true
  }

  // `/btw` and `/recap` are answered OUT-OF-BAND (interactive-mode.md:365 —
  // never enter the conversation history) and must stay available "while
  // Claude is working" (`:367`), so their exits sit BEFORE the
  // isProcessing-gated MESSAGE_COMMANDS block below. Menu selection carries no
  // argument, so `btw` here is the BARE form: reopen the overlay on the most
  // recent exchange (`:374`) — never a prefill (deliberately NOT in
  // PREFILL_COMMANDS) and never a submitted message.
  // P6.278 — `/diff` picked from the MENU opens the viewer; `/diff` that
  // reaches a runtime is still answered at the seam with the summary
  // (`slash-commands/diff-command.ts`). Two surfaces, one producer, and the
  // fall-through below is what keeps the second one working: with no opener
  // supplied — every surface that is not the desktop composer — this returns
  // `false` and the command lands in `MESSAGE_COMMANDS` exactly as before.
  if (commandId === 'diff' && handlers.openWorkingTreeDiff) {
    handlers.openWorkingTreeDiff()
    return true
  }

  if (commandId === 'btw') {
    handlers.openSideQuestionOverlay?.()
    return Boolean(handlers.openSideQuestionOverlay)
  }

  if (commandId === 'recap') {
    handlers.requestRecap?.()
    return Boolean(handlers.requestRecap)
  }

  const prefill = PREFILL_COMMANDS[commandId]
  if (prefill) {
    if (!handlers.prefillCommand) return false
    handlers.prefillCommand(prefill)
    return true
  }

  // The `commandId === 'compact'` refusal that used to sit here is now a row of
  // {@link CAPABILITY_REFUSALS}, read by {@link isCommandUnavailable} at the top
  // of this function — so it covers the prefill exit above, which it could not
  // reach from here (P2.322).
  const messageCommand = MESSAGE_COMMANDS[commandId]
  if (!messageCommand || handlers.isProcessing || !handlers.submitCommand) {
    return false
  }

  handlers.submitCommand(messageCommand)
  return true
}

/**
 * Classify TYPED composer input that must never become a sendMessage turn:
 * `/btw [question]`, `/recap`, and `/heapdump`. Uses THE session-command
 * classifier (`parseSessionCommand` — one answer to "is this a command" in the
 * product), narrowed to the kinds the composer routes itself; `/clear`,
 * `/compact` and `/subtask` return null here because they ride the normal
 * message path.
 *
 * A bare `/btw` classifies with `question: ''` — the documented REOPEN form
 * (interactive-mode.md:374), not a usage error. Callers must not gate this on
 * `isProcessing`: `:367` requires availability while Claude is working, and a
 * `/heapdump` must work on a wedged session (troubleshooting.md:39). Typed-only
 * on purpose for `/heapdump` — the doc says it "doesn't appear in the command
 * menu; type it in full", so there is no menu entry to dispatch.
 */
export function typedOutOfBandCommandSubmission(input: string):
  | { kind: 'btw'; question: string }
  | { kind: 'recap' }
  | { kind: 'heapdump' }
  | null {
  const parsed = parseSessionCommand(input)
  if (parsed?.kind === 'btw') return { kind: 'btw', question: parsed.question }
  if (parsed?.kind === 'recap') return { kind: 'recap' }
  if (parsed?.kind === 'heapdump') return { kind: 'heapdump' }
  return null
}
