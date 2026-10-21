import { describe, expect, it } from 'bun:test'
import { INIT_PROJECT_INSTRUCTIONS_PROMPT } from '@nessy-agent/shared/prompts/init'
import { CREATE_SKILL_PROMPT } from '@nessy-agent/shared/prompts/create-skill'
import { CREATE_PLUGIN_PROMPT } from '@nessy-agent/shared/prompts/create-plugin'
import { GOAL_INTERVIEW_PROMPT } from '@nessy-agent/shared/prompts/goal'
import { readFileSync } from 'node:fs'
import type { SlashCommandId } from '@/components/ui/slash-command-menu'
import {
  CAPABILITY_REFUSALS,
  dispatchSlashCommandAction,
  isCommandUnavailable,
  typedOutOfBandCommandSubmission,
  type SlashCommandActionHandlers,
} from '../slash-command-actions'

describe('dispatchSlashCommandAction', () => {
  /**
   * P6.447 - `/status` submits the literal, like every other seam-answered read.
   *
   * The row this closes for the FIFTH time: `/mcp`, `/diff`, `/hooks` and
   * `/config` each shipped announced in the menu and in `/help` with no line in
   * `MESSAGE_COMMANDS`, so the menu offered a command its own dispatcher
   * refused and picking it did nothing at all. `/status` had a parser row and a
   * `BaseAgent.chat` arm before it had this line, which is the same shape one
   * step earlier.
   */
  it('submits the literal for /status, so the menu row reaches the seam that answers it', () => {
    const submitted: string[] = []

    const handled = dispatchSlashCommandAction('status', {
      submitCommand: command => submitted.push(command),
    })

    expect(handled).toBe(true)
    expect(submitted).toEqual(['/status'])
  })

  it('NEGATIVE - /status is refused when the runtime withdraws it, and the composer is left alone', () => {
    const submitted: string[] = []

    const handled = dispatchSlashCommandAction('status', {
      excludedCommandIds: ['status'],
      submitCommand: command => submitted.push(command),
    })

    // `false` means the caller leaves the composer untouched rather than
    // clearing it for a command the session will decline (P2.322's one rule).
    expect(handled).toBe(false)
    expect(submitted).toEqual([])
  })

  /**
   * P6.322 half 2 · `/goal` expands the interview macro, and `/plan` does NOT.
   *
   * The row asked for a `/plan` that interviews the user and produces a goal
   * with a measurable condition. `plan` is a `PermissionMode`, every
   * `PermissionMode` is a `SlashCommandId`, and `isPermissionModeCommand` claims
   * it in a branch that runs BEFORE the message-command table — so a second
   * `/plan` meaning is unreachable by construction here. The second assertion is
   * the one that matters: it pins the collision, so the day someone adds a
   * `plan` row to `MESSAGE_COMMANDS` the test says why it can never fire.
   */
  it('expands the goal interview macro for /goal, while /plan stays the permission mode', () => {
    const submitted: string[] = []
    const modes: string[] = []

    const handledGoal = dispatchSlashCommandAction('goal', {
      submitCommand: command => submitted.push(command),
      onPermissionModeChange: mode => modes.push(mode),
    })

    expect(handledGoal).toBe(true)
    expect(submitted).toEqual([GOAL_INTERVIEW_PROMPT])
    expect(modes).toEqual([])

    const handledPlan = dispatchSlashCommandAction('plan', {
      submitCommand: command => submitted.push(command),
      onPermissionModeChange: mode => modes.push(mode),
    })

    expect(handledPlan).toBe(true)
    expect(modes).toEqual(['plan'])
    // The macro was NOT submitted a second time: `/plan` never reaches the
    // message-command table.
    expect(submitted).toEqual([GOAL_INTERVIEW_PROMPT])
  })

  /**
   * The macro's content, pinned where it is load-bearing rather than verbatim.
   *
   * `done_means` (2) is "interviews the user about constraints and turns the
   * answers into a goal carrying a MEASURABLE condition", so the two things a
   * later edit must not quietly drop are the interview instruction and the exact
   * tool call that turns the answers into a record — the `Goal` tool's `create`
   * action with a `condition`, which is the only shape `GoalSchema` accepts.
   */
  it('the goal macro interviews first and creates through the Goal tool the runtimes already share', () => {
    expect(GOAL_INTERVIEW_PROMPT).toContain('Interview me first')
    expect(GOAL_INTERVIEW_PROMPT).toContain('Goal tool')
    expect(GOAL_INTERVIEW_PROMPT).toContain('"create"')
    expect(GOAL_INTERVIEW_PROMPT).toContain('condition')
    // The measurability clause, which is the whole difference between a goal the
    // evaluator can settle and a wish it cannot.
    expect(GOAL_INTERVIEW_PROMPT).toContain('either true or false')
    // And no Pi-only tool is named: `ask_user` is a harness tool, so naming it
    // would make this command behave differently on two of the three runtimes.
    expect(GOAL_INTERVIEW_PROMPT).not.toContain('ask_user')
  })

  it('opens the model selector for /model', () => {
    const calls: string[] = []

    const handled = dispatchSlashCommandAction('model', {
      openModelSelector: () => calls.push('model'),
      submitCommand: command => calls.push(command),
    })

    expect(handled).toBe(true)
    expect(calls).toEqual(['model'])
  })

  /**
   * P6.278 — `/diff` picked from the composer MENU opens the viewer; `/diff`
   * that reaches a runtime is still answered at the seam with the summary.
   *
   * The fall-through is the load-bearing half and it is the second test: every
   * surface that is not the desktop composer supplies no opener, and the
   * command must then reach the runtime exactly as it did before. A dispatcher
   * that swallowed it would leave `-p`, `apps/cli` and the headless server with
   * no `/diff` at all — the clause `help.ts` chose `availability: 'session'`
   * for.
   */
  it('opens the working-tree diff viewer for /diff when the composer supplies one', () => {
    const calls: string[] = []

    const handled = dispatchSlashCommandAction('diff', {
      openWorkingTreeDiff: () => calls.push('diff-viewer'),
      submitCommand: command => calls.push(command),
    })

    expect(handled).toBe(true)
    expect(calls).toEqual(['diff-viewer'])
  })

  it('CONTROL: with no viewer, /diff still reaches the runtime as a message', () => {
    const calls: string[] = []

    const handled = dispatchSlashCommandAction('diff', {
      submitCommand: command => calls.push(command),
    })

    expect(handled).toBe(true)
    expect(calls).toEqual(['/diff'])
  })

  it('opens automations only when an /automations handler is provided', () => {
    const calls: string[] = []

    const handled = dispatchSlashCommandAction('automations', {
      openAutomations: () => calls.push('automations'),
    })

    expect(handled).toBe(true)
    expect(calls).toEqual(['automations'])
    expect(dispatchSlashCommandAction('automations', {})).toBe(false)
  })

  it('opens usage only when a /usage handler is provided', () => {
    const calls: string[] = []

    const handled = dispatchSlashCommandAction('usage', {
      openUsage: () => calls.push('usage'),
    })

    expect(handled).toBe(true)
    expect(calls).toEqual(['usage'])
    expect(dispatchSlashCommandAction('usage', {})).toBe(false)
  })

  it('refreshes usage before opening /usage when supported', async () => {
    const calls: string[] = []

    const handled = dispatchSlashCommandAction('usage', {
      refreshUsage: async () => {
        calls.push('refresh')
      },
      openUsage: () => calls.push('usage'),
    })

    expect(handled).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(['refresh', 'usage'])
  })

  it('opens /usage even when refresh fails', async () => {
    const calls: string[] = []

    const handled = dispatchSlashCommandAction('usage', {
      refreshUsage: async () => {
        calls.push('refresh')
        throw new Error('stale')
      },
      openUsage: () => calls.push('usage'),
    })

    expect(handled).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(['refresh', 'usage'])
  })

  it('opens context only when a /context handler is provided', () => {
    const calls: string[] = []

    const handled = dispatchSlashCommandAction('context', {
      openContext: () => calls.push('context'),
    })

    expect(handled).toBe(true)
    expect(calls).toEqual(['context'])
    expect(dispatchSlashCommandAction('context', {})).toBe(false)
  })

  it('opens export only when a /export handler is provided', () => {
    const calls: string[] = []

    const handled = dispatchSlashCommandAction('export', {
      openExport: () => calls.push('export'),
    })

    expect(handled).toBe(true)
    expect(calls).toEqual(['export'])
    expect(dispatchSlashCommandAction('export', {})).toBe(false)
  })

  it('opens agents only when an /agents handler is provided', () => {
    const calls: string[] = []

    const handled = dispatchSlashCommandAction('agents', {
      openAgents: () => calls.push('agents'),
    })

    expect(handled).toBe(true)
    expect(calls).toEqual(['agents'])
    expect(dispatchSlashCommandAction('agents', {})).toBe(false)
  })

  it('submits existing slash commands for /clear and /help', () => {
    const calls: string[] = []

    expect(dispatchSlashCommandAction('clear', {
      submitCommand: command => calls.push(command),
    })).toBe(true)
    expect(dispatchSlashCommandAction('help', {
      submitCommand: command => calls.push(command),
    })).toBe(true)

    expect(calls).toEqual(['/clear', '/help'])
  })

  it('does not submit /compact as text when compact is unsupported', () => {
    const calls: string[] = []

    const handled = dispatchSlashCommandAction('compact', {
      contextUsageCapability: {
        kind: 'unavailable',
        reason: 'remote-not-reported',
        compact: { manual: false },
      },
      submitCommand: command => calls.push(command),
    })

    expect(handled).toBe(false)
    expect(calls).toEqual([])
  })

  it('expands /init to the shared project-instructions scaffold prompt', () => {
    const calls: string[] = []

    expect(dispatchSlashCommandAction('init', {
      submitCommand: command => calls.push(command),
    })).toBe(true)

    // The macro is the single-source-of-truth shared prompt, not an inline
    // copy — so the overwrite-safety and inspect-first contract stays pinned in
    // one place (packages/shared/src/prompts/init.ts).
    expect(calls).toEqual([INIT_PROJECT_INSTRUCTIONS_PROMPT])
    expect(calls[0]).toContain('AGENTS.md')
    expect(calls[0]).toContain('do NOT overwrite or replace it')
  })

  it('expands /create-skill to the shared skill-creator macro prompt', () => {
    const calls: string[] = []

    expect(dispatchSlashCommandAction('create-skill', {
      submitCommand: command => calls.push(command),
    })).toBe(true)

    // Same single-source-of-truth discipline as /init: the macro is the shared
    // prompt constant, not an inline copy.
    expect(calls).toEqual([CREATE_SKILL_PROMPT])
    expect(calls[0]).toContain('skill-creator')
    expect(calls[0]).toContain('skill_validate')
  })

  it('expands /create-plugin to the shared plugin-creator macro prompt', () => {
    const calls: string[] = []

    expect(dispatchSlashCommandAction('create-plugin', {
      submitCommand: command => calls.push(command),
    })).toBe(true)

    expect(calls).toEqual([CREATE_PLUGIN_PROMPT])
    expect(calls[0]).toContain('plugin-creator')
    expect(calls[0]).toContain('nessy-extension.json')
  })

  it('does not submit message slash commands while processing', () => {
    const calls: string[] = []

    const handled = dispatchSlashCommandAction('clear', {
      isProcessing: true,
      submitCommand: command => calls.push(command),
    })

    expect(handled).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('/btw and /recap (interactive-mode.md:359-385, :398-404)', () => {
  it('bare /btw from the menu reopens the overlay — never a prefill, never a submit', () => {
    const submitted: string[] = []
    const prefilled: string[] = []
    const opened: string[] = []

    const handled = dispatchSlashCommandAction('btw', {
      openSideQuestionOverlay: () => opened.push('overlay'),
      submitCommand: command => submitted.push(command),
      prefillCommand: text => prefilled.push(text),
    })

    expect(handled).toBe(true)
    // interactive-mode.md:374 — bare /btw REOPENS on the most recent exchange;
    // it must not park a caret (`/btw ` prefill) and must not become a turn.
    expect(opened).toEqual(['overlay'])
    expect(submitted).toEqual([])
    expect(prefilled).toEqual([])
  })

  it('stays available while Claude is working — not gated like MESSAGE_COMMANDS', () => {
    const opened: string[] = []
    const recapped: string[] = []

    // interactive-mode.md:367 — "Available while Claude is working". The
    // MESSAGE_COMMANDS block returns false under isProcessing (see the /clear
    // test above); these two exits sit BEFORE it.
    expect(dispatchSlashCommandAction('btw', {
      isProcessing: true,
      openSideQuestionOverlay: () => opened.push('overlay'),
    })).toBe(true)
    expect(dispatchSlashCommandAction('recap', {
      isProcessing: true,
      requestRecap: () => recapped.push('recap'),
    })).toBe(true)

    expect(opened).toEqual(['overlay'])
    expect(recapped).toEqual(['recap'])
  })

  it('dispatches /recap only when a handler is provided', () => {
    const recapped: string[] = []

    expect(dispatchSlashCommandAction('recap', {
      requestRecap: () => recapped.push('recap'),
    })).toBe(true)
    expect(recapped).toEqual(['recap'])
    expect(dispatchSlashCommandAction('recap', {})).toBe(false)
  })

  it('honors slash.excludedCommandIds — an excluded command never dispatches', () => {
    const opened: string[] = []

    // ComposerCapabilities.slash.excludedCommandIds subtracts from 'all':
    // nestor-cloud-agent excludes btw/recap because its queryLlm throws.
    const handled = dispatchSlashCommandAction('btw', {
      allowedCommandIds: 'all',
      excludedCommandIds: ['btw', 'recap'],
      openSideQuestionOverlay: () => opened.push('overlay'),
    })

    expect(handled).toBe(false)
    expect(opened).toEqual([])
  })

  // P2.279 — the same subtraction for the command FAMILIES the resolver cannot
  // enumerate. A saved workflow's id carries its name, so only a prefix can name
  // it; the runtimes that cannot dispatch a recipe get both id builders' prefixes.
  it('honors slash.excludedCommandIdPrefixes — an excluded family never dispatches', () => {
    const prefixes = ['custom:workflow:', 'custom:plugin-workflow:']
    const prefilled: string[] = []

    for (const id of ['custom:workflow:ship', 'custom:plugin-workflow:acme:release'] as const) {
      expect(dispatchSlashCommandAction(id, {
        allowedCommandIds: 'all',
        excludedCommandIdPrefixes: prefixes,
        prefillCommand: text => prefilled.push(text),
        submitCommand: text => prefilled.push(text),
      }), id).toBe(false)
    }
    expect(prefilled).toEqual([])

    // Negative controls: a custom command that is NOT in the family, and the
    // same ids with no prefix list, must be unaffected — a prefix filter that
    // swallowed every `custom:` id would pass the row above and break the menu.
    expect(dispatchSlashCommandAction('custom:review', {
      allowedCommandIds: 'all',
      excludedCommandIdPrefixes: prefixes,
    })).toBe(false)
    expect(dispatchSlashCommandAction('subtask', {
      allowedCommandIds: 'all',
      excludedCommandIdPrefixes: prefixes,
      prefillCommand: text => prefilled.push(text),
    })).toBe(true)
    expect(prefilled).toEqual(['/subtask '])
  })

  // P3.71 — the menu row for `/subtask` is a PREFILL, so withdrawing it removes
  // no capability: the typed form still reaches `BaseAgent.chat`, which is where
  // the fork runs on Pi and refuses honestly elsewhere.
  it('refuses the subtask row where the resolver excludes it, and prefills where it does not', () => {
    const prefilled: string[] = []
    const handlers = { allowedCommandIds: 'all' as const, prefillCommand: (t: string) => prefilled.push(t) }

    expect(dispatchSlashCommandAction('subtask', { ...handlers, excludedCommandIds: ['subtask'] })).toBe(false)
    expect(prefilled).toEqual([])
    expect(dispatchSlashCommandAction('subtask', { ...handlers, excludedCommandIds: ['quota'] })).toBe(true)
    expect(prefilled).toEqual(['/subtask '])
  })

  // T17 — `/quota` is a MESSAGE_COMMANDS entry, so the composer submits the
  // literal `/quota` and the session-command seam answers it. Its provider gate
  // is the same exclusion mechanism as btw/recap, inverted: every provider but
  // nestor-cloud-agent excludes it.
  it('submits /quota as a message and honors its per-provider exclusion', () => {
    const submitted: string[] = []

    expect(dispatchSlashCommandAction('quota', {
      allowedCommandIds: 'all',
      excludedCommandIds: ['btw', 'recap'],
      submitCommand: command => submitted.push(command),
    })).toBe(true)
    expect(submitted).toEqual(['/quota'])

    expect(dispatchSlashCommandAction('quota', {
      allowedCommandIds: 'all',
      excludedCommandIds: ['quota'],
      submitCommand: command => submitted.push(command),
    })).toBe(false)
    expect(submitted).toEqual(['/quota'])
  })

  // P4.5 — `/advisor` joins MESSAGE_COMMANDS for the same reason `/quota` is
  // there: `parseSessionCommand` answers it at the `BaseAgent.chat` seam that
  // every backend inherits, so the composer submits the literal and there is
  // no handler and no RPC. Unlike `/quota` it carries NO provider exclusion —
  // the advisor is host-side on all three runtimes and ships OFF, so the state
  // where the entry is most useful is the state where it is least configured.
  it('submits /advisor as a message on every provider', () => {
    const submitted: string[] = []

    expect(dispatchSlashCommandAction('advisor', {
      allowedCommandIds: 'all',
      excludedCommandIds: ['quota'],
      submitCommand: command => submitted.push(command),
    })).toBe(true)
    expect(submitted).toEqual(['/advisor'])

    // Still subject to the ordinary exclusion mechanism, so a capability that
    // ever needs to remove it can.
    expect(dispatchSlashCommandAction('advisor', {
      allowedCommandIds: 'all',
      excludedCommandIds: ['advisor'],
      submitCommand: command => submitted.push(command),
    })).toBe(false)
    expect(submitted).toEqual(['/advisor'])
  })

  it('does not submit /advisor mid-turn', () => {
    const submitted: string[] = []

    expect(dispatchSlashCommandAction('advisor', {
      allowedCommandIds: 'all',
      isProcessing: true,
      submitCommand: command => submitted.push(command),
    })).toBe(false)
    expect(submitted).toEqual([])
  })

  // P6.634 — `/config` is a `session` row (`SESSION_COMMAND_HELP_ENTRIES`), so
  // the menu must SUBMIT the literal the same way `/advisor` and `/quota` do.
  // The row was offered by the menu and dispatched by nothing, which is what
  // P3.71's enumeration is for; this is the same claim at the dispatcher, so a
  // later refactor that drops the entry fails here as well as there.
  it('submits the bare /config as a message on every provider', () => {
    const submitted: string[] = []

    expect(dispatchSlashCommandAction('config', {
      allowedCommandIds: 'all',
      submitCommand: command => submitted.push(command),
    })).toBe(true)
    // The BARE form — the listing. Never a prefill: a caret parked after
    // `/config` would be the `/subtask` treatment, and the listing is the
    // useful answer here.
    expect(submitted).toEqual(['/config'])

    // Still subject to the ordinary exclusion mechanism, so a runtime that
    // ever needs to withdraw it can — the menu and this dispatcher then agree.
    expect(dispatchSlashCommandAction('config', {
      allowedCommandIds: 'all',
      excludedCommandIds: ['config'],
      submitCommand: command => submitted.push(command),
    })).toBe(false)
    expect(submitted).toEqual(['/config'])
  })

  // Same mid-turn availability as /compact and /clear — accepted, not a bug:
  // MESSAGE_COMMANDS ride the isProcessing gate.
  it('does not submit /quota mid-turn', () => {
    const submitted: string[] = []

    expect(dispatchSlashCommandAction('quota', {
      allowedCommandIds: 'all',
      isProcessing: true,
      submitCommand: command => submitted.push(command),
    })).toBe(false)
    expect(submitted).toEqual([])
  })
})

describe('typedOutOfBandCommandSubmission (typed /btw and /recap interception)', () => {
  it('classifies typed /btw with a question for the out-of-band ask', () => {
    expect(typedOutOfBandCommandSubmission('/btw what was that config file?'))
      .toEqual({ kind: 'btw', question: 'what was that config file?' })
  })

  it('classifies bare /btw as the reopen form, not a usage error', () => {
    // interactive-mode.md:374 — the empty question means REOPEN; the helper
    // carries no isProcessing input at all, so the typed path is structurally
    // never blocked mid-turn (`:367`).
    expect(typedOutOfBandCommandSubmission('/btw')).toEqual({ kind: 'btw', question: '' })
  })

  it('classifies /recap', () => {
    expect(typedOutOfBandCommandSubmission('/recap')).toEqual({ kind: 'recap' })
  })

  it('leaves /clear, /compact and prose alone — they ride the message path', () => {
    expect(typedOutOfBandCommandSubmission('/clear')).toBeNull()
    expect(typedOutOfBandCommandSubmission('/compact')).toBeNull()
    expect(typedOutOfBandCommandSubmission('tell me about /btw')).toBeNull()
    expect(typedOutOfBandCommandSubmission('/recap please')).toBeNull()
  })

  it('classifies typed /heapdump — whole-message only, no menu entry to dispatch', () => {
    // troubleshooting.md:39 — the command "doesn't appear in the command menu;
    // type it in full", so this typed interception is its ONLY entry point.
    expect(typedOutOfBandCommandSubmission('/heapdump')).toEqual({ kind: 'heapdump' })
    expect(typedOutOfBandCommandSubmission('/heapdump now')).toBeNull()
  })
})

describe('/subtask (sub-agents.md:1013)', () => {
  it('prefills the composer with the command instead of submitting it', () => {
    const submitted: string[] = []
    const prefilled: string[] = []

    const handled = dispatchSlashCommandAction('subtask', {
      submitCommand: command => submitted.push(command),
      prefillCommand: text => prefilled.push(text),
    })

    expect(handled).toBe(true)
    // The fork is nothing without its task, so the command must NOT be sent on
    // selection the way `/compact` is.
    expect(submitted).toEqual([])
    expect(prefilled).toEqual(['/subtask '])
  })

  it('is inert without a prefill handler rather than falling through to submit', () => {
    const submitted: string[] = []
    expect(dispatchSlashCommandAction('subtask', { submitCommand: c => submitted.push(c) })).toBe(false)
    expect(submitted).toEqual([])
  })
})

/**
 * P2.322 · ONE renderer rule for "this runtime refuses this command".
 *
 * The row: the resolver withdraws a refused row from the menu for four
 * different commands, while the dispatch enforced a capability refusal for
 * `/compact` alone — and did it in an `if` placed BELOW the prefill exit, so
 * the one command that prefills (`/subtask`) could never have been reached by
 * it. Two treatments of one situation, one file apart, neither written down.
 *
 * These tests pin the rule rather than the instance, because the instance is
 * what drifted: the first asserts every row of the capability table is honoured
 * whatever the table holds, the second proves the rule reaches a PREFILL id,
 * and the third refuses the id-specific `if` the row removed.
 */
describe('P2.322 · one rule decides an unavailable command, for every id', () => {
  it('honours every capability refusal in the table, whatever the table holds', () => {
    // Table-driven over the real table, so a row added later is covered here
    // without anyone remembering to extend this test.
    expect(Object.keys(CAPABILITY_REFUSALS).length).toBeGreaterThan(0)

    for (const id of Object.keys(CAPABILITY_REFUSALS) as SlashCommandId[]) {
      const refused: SlashCommandActionHandlers = { contextUsageCapability: { kind: 'unavailable', compact: { manual: false } } as never }
      expect(isCommandUnavailable(id, refused)).toBe(true)

      const calls: string[] = []
      expect(dispatchSlashCommandAction(id, {
        ...refused,
        submitCommand: command => calls.push(command),
        prefillCommand: text => calls.push(text),
      })).toBe(false)
      expect(calls).toEqual([])
    }
  })

  it('reaches a PREFILL command, which is the half the old placement could not', () => {
    // `/subtask` is the only PREFILL_COMMANDS entry, and the capability table
    // has no row for it today — so the generality is demonstrated by adding
    // one, asserting, and removing it. Without this the row's own claim
    // ("generalise /compact's treatment to /subtask") is untested until a
    // second real row happens to land.
    const prefilled: string[] = []
    const handlers: SlashCommandActionHandlers = { prefillCommand: text => prefilled.push(text) }

    // Control: with no row, the prefill happens.
    expect(dispatchSlashCommandAction('subtask', handlers)).toBe(true)
    expect(prefilled).toEqual(['/subtask '])

    prefilled.length = 0
    CAPABILITY_REFUSALS.subtask = () => true
    try {
      expect(isCommandUnavailable('subtask', handlers)).toBe(true)
      expect(dispatchSlashCommandAction('subtask', handlers)).toBe(false)
      // Never a parked caret after a command the session would decline.
      expect(prefilled).toEqual([])
    } finally {
      delete CAPABILITY_REFUSALS.subtask
    }

    // Restored — the control passes again, so a later test in this file is not
    // running against a mutated table.
    expect(dispatchSlashCommandAction('subtask', handlers)).toBe(true)
    expect(prefilled).toEqual(['/subtask '])
  })

  it('leaves the resolver exclusion and the capability refusal answering as one rule', () => {
    // Both sources feed the same predicate, so a caller that passes one and not
    // the other still gets a refusal for the command that source knows about.
    expect(isCommandUnavailable('compact', { excludedCommandIds: ['compact'] })).toBe(true)
    expect(isCommandUnavailable('compact', { contextUsageCapability: { kind: 'unavailable', compact: { manual: false } } as never })).toBe(true)
    // And an available command stays available under either shape.
    expect(isCommandUnavailable('compact', {})).toBe(false)
    expect(isCommandUnavailable('compact', { excludedCommandIds: ['quota'] })).toBe(false)
  })

  it('keeps no id-specific refusal in the dispatch body', () => {
    // The prohibition as an invariant: the shape this row removed was a bare
    // `commandId === 'compact'` capability check sitting past the prefill exit.
    // Re-introducing it for a second id is exactly how the two treatments were
    // born, so the absence is asserted rather than left to convention.
    const source = readFileSync(new URL('../slash-command-actions.ts', import.meta.url), 'utf8')
    expect(source).toContain('function isCommandUnavailable(')
    expect(source).not.toMatch(/commandId === '[a-z-]+' && handlers\.contextUsageCapability/)
  })
})
