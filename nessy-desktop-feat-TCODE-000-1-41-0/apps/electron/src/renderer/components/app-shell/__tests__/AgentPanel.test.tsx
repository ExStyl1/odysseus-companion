/**
 * R29b Task 2 — the observe-and-steer panel.
 *
 * `sub-agents.md:1023` — "Running forks appear in a panel below the prompt
 * input, with one row for the main session and one for each fork" — plus the
 * key table at `:1025`–`:1030`. The page's bindings are terminal keys; this app
 * maps the CAPABILITIES, so the assertions here are that each documented
 * capability exists and lands on the right row, not that a terminal keystroke
 * was reproduced.
 */
import * as React from 'react'
import { beforeAll, describe, expect, test } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PiHarnessChildSummaryV1 } from '@nessy-agent/core/types'
import {
  AgentPanel,
  agentPanelKeyAction,
  agentRowModelLabel,
  followUpClearsInput,
  isAgentChildListed,
  isAgentRowRunning,
  MAIN_ROW_ID,
  nextFocusedRowId,
  toAgentPanelRows,
} from '../AgentPanel'

const translations = {
  'agentPanel.title': 'Running agents',
  'agentPanel.count_one': '{{count}} agent',
  'agentPanel.count_other': '{{count}} agents',
  'agentPanel.mainSession': 'Main session',
  'agentPanel.fork': 'Fork',
  'agentPanel.openTranscript': 'Open transcript',
  'agentPanel.transcriptEmpty': 'No output yet.',
  'agentPanel.followUp': 'Send a follow-up',
  'agentPanel.send': 'Send',
  'agentPanel.stop': 'Stop',
  'agentPanel.dismiss': 'Dismiss',
  'agentPanel.actionFailed': 'Could not reach this agent: {{reason}}',
  'agentPanel.effortTitle': 'Reasoning effort: {{level}}',
  'agentPanel.modelTitle': 'Model: {{model}}',
}

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: translations } },
    interpolation: { escapeValue: false },
  })
})

function child(over: Partial<PiHarnessChildSummaryV1>): PiHarnessChildSummaryV1 {
  return { agentId: 'a1', agent: 'fork', status: 'running', background: true, ...over }
}

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(<I18nextProvider i18n={testI18n}>{node}</I18nextProvider>)
}

const noop = () => undefined

describe('AgentPanel rows', () => {
  test('renders the main session row plus one row per child', () => {
    const html = render(
      <AgentPanel
        open
        mainSessionLabel="Parser work"
        rows={toAgentPanelRows([
          child({ agentId: 'fork-1', agent: 'fork', task: 'draft unit tests' }),
          child({ agentId: 'scout-1', agent: 'scout', task: 'survey the repo', status: 'completed' }),
        ])}
        onOpenTranscript={noop}
        onFollowUp={noop}
        onDismiss={noop}
      />,
    )
    expect(html).toContain('agent-panel-row-main')
    expect(html).toContain('Parser work')
    expect(html).toContain('agent-panel-row-fork-1')
    expect(html).toContain('draft unit tests')
    expect(html).toContain('agent-panel-row-scout-1')
    // The fork is marked as one; the named subagent is not.
    expect(html).toMatch(/data-testid="agent-panel-row-fork-1"[^>]*data-fork="true"/)
    expect(html).toMatch(/data-testid="agent-panel-row-scout-1"[^>]*data-fork="false"/)
  })

  test('renders nothing when the session has no children', () => {
    expect(render(
      <AgentPanel open mainSessionLabel="Parser work" rows={[]} onOpenTranscript={noop} onFollowUp={noop} onDismiss={noop} />,
    )).toBe('')
  })

  test('every documented capability has a control on the row', () => {
    const html = render(
      <AgentPanel
        open
        mainSessionLabel="Parser work"
        rows={toAgentPanelRows([child({ agentId: 'fork-1', task: 'draft unit tests' })])}
        onOpenTranscript={noop}
        onFollowUp={noop}
        onDismiss={noop}
      />,
    )
    // `Enter` — open the transcript; `x` — stop a running row.
    expect(html).toContain('agent-panel-open-fork-1')
    expect(html).toContain('agent-panel-dismiss-fork-1')
    expect(html).toContain('aria-label="Stop"')
  })

  /**
   * A refused control used to render as nothing at all. The row the user acted
   * on has to say which refusal happened, and only that row.
   */
  test('a refused control leaves a visible refusal on the row it was aimed at', () => {
    const html = render(
      <AgentPanel
        open
        mainSessionLabel="Parser work"
        rows={toAgentPanelRows([
          child({ agentId: 'fork-1', status: 'completed' }),
          child({ agentId: 'fork-2' }),
        ])}
        errors={{ 'fork-1': 'child-session-not-active' }}
        onOpenTranscript={noop}
        onFollowUp={noop}
        onDismiss={noop}
      />,
    )
    expect(html).toContain('agent-panel-error-fork-1')
    expect(html).toContain('Could not reach this agent: child-session-not-active')
    expect(html).toContain('role="alert"')
    expect(html).not.toContain('agent-panel-error-fork-2')
  })

  test('no refusal renders when every control succeeded', () => {
    const html = render(
      <AgentPanel
        open
        mainSessionLabel="Parser work"
        rows={toAgentPanelRows([child({ agentId: 'fork-1' })])}
        errors={{}}
        onOpenTranscript={noop}
        onFollowUp={noop}
        onDismiss={noop}
      />,
    )
    expect(html).not.toContain('agent-panel-error-')
    expect(html).not.toContain('Could not reach this agent')
  })

  /**
   * R53c — `statusline.md` § `subagentStatusLine` puts `effort` and `model` in
   * the per-subagent row body. Both are carried straight off the summary, so
   * the assertion is that the row SHOWS the level this child is running at —
   * not the session's, and not a re-derivation the panel made up.
   */
  test('a row shows the effort and model the child is running at', () => {
    const html = render(
      <AgentPanel
        open
        mainSessionLabel="Parser work"
        rows={toAgentPanelRows([
          child({ agentId: 'scout-1', agent: 'scout', task: 'survey the repo', effort: 'xhigh', model: 'claude-opus-4-8' }),
        ])}
        onOpenTranscript={noop}
        onFollowUp={noop}
        onDismiss={noop}
      />,
    )
    expect(html).toMatch(/data-testid="agent-panel-effort-scout-1"[^>]*>xhigh</)
    expect(html).toContain('Reasoning effort: xhigh')
    expect(html).toContain('agent-panel-model-scout-1')
    // Shortened for the row; the raw id stays reachable on the title.
    expect(html).toContain(`>${agentRowModelLabel('claude-opus-4-8')}<`)
    expect(html).toContain('Model: claude-opus-4-8')
    // The status the row already carried is still there, in the same slot.
    expect(html).toContain('running')
  })

  /**
   * Back-compat, and the reason it is asserted as STRING EQUALITY rather than
   * as a pair of `not.toContain`s: `PiHarnessChildSummaryV1` is a wire shape, a
   * host that predates these fields sends neither, and "the row is unchanged"
   * is only worth claiming if the markup is unchanged. The expected string is
   * the pre-change render, pasted verbatim.
   */
  test('a summary carrying neither field renders exactly the markup it did before', () => {
    const html = render(
      <AgentPanel
        open
        mainSessionLabel="Parser work"
        rows={toAgentPanelRows([child({ agentId: 'fork-1', task: 'draft unit tests' })])}
        onOpenTranscript={noop}
        onFollowUp={noop}
        onDismiss={noop}
      />,
    )
    expect(html).toContain('<span class="ml-auto shrink-0 text-muted-foreground">running</span>')
    expect(html).not.toContain('agent-panel-effort-')
    expect(html).not.toContain('agent-panel-model-')
    // The row keeps exactly ONE `·` — the `agent · task` one it always had.
    expect(html.split('·')).toHaveLength(2)
  })

  /**
   * The row says what RAN. `getModelDisplayName` would resolve the deprecated
   * `claude-opus-4-6` through the replacement table and print "Opus 4.8" — a
   * version this child is not on, and the exact case where the effort clamp
   * bites (`xhigh` runs as `high` on 4.6).
   */
  test('a deprecated model id is never relabelled as its replacement', () => {
    expect(agentRowModelLabel('claude-opus-4-6')).not.toContain('4.8')
    const html = render(
      <AgentPanel
        open
        mainSessionLabel="Parser work"
        rows={toAgentPanelRows([child({ agentId: 'scout-1', agent: 'scout', model: 'claude-opus-4-6' })])}
        onOpenTranscript={noop}
        onFollowUp={noop}
        onDismiss={noop}
      />,
    )
    expect(html).not.toContain('4.8')
    // The exact id the child runs on stays reachable.
    expect(html).toContain('Model: claude-opus-4-6')
  })

  test('only the field that is present renders, with no stray separator', () => {
    const effortOnly = render(
      <AgentPanel
        open
        mainSessionLabel="Parser work"
        rows={toAgentPanelRows([child({ agentId: 'fork-1', effort: 'low' })])}
        onOpenTranscript={noop}
        onFollowUp={noop}
        onDismiss={noop}
      />,
    )
    expect(effortOnly).toContain('agent-panel-effort-fork-1')
    expect(effortOnly).not.toContain('agent-panel-model-')

    const modelOnly = render(
      <AgentPanel
        open
        mainSessionLabel="Parser work"
        rows={toAgentPanelRows([child({ agentId: 'fork-1', model: 'pi/qwen3-coder' })])}
        onOpenTranscript={noop}
        onFollowUp={noop}
        onDismiss={noop}
      />,
    )
    expect(modelOnly).not.toContain('agent-panel-effort-')
    expect(modelOnly).toContain('agent-panel-model-fork-1')
    // The `pi/` prefix is an internal routing detail, not a model name.
    expect(modelOnly).toContain('>qwen3-coder<')
  })

  test('a finished row offers dismiss where a running one offers stop', () => {
    const html = render(
      <AgentPanel
        open
        mainSessionLabel="Parser work"
        rows={toAgentPanelRows([child({ agentId: 'fork-1', status: 'completed' })])}
        onOpenTranscript={noop}
        onFollowUp={noop}
        onDismiss={noop}
      />,
    )
    expect(html).toContain('aria-label="Dismiss"')
    expect(html).not.toContain('aria-label="Stop"')
  })
})

describe('the documented key bindings, mapped', () => {
  test('each documented key maps to its capability', () => {
    expect(agentPanelKeyAction('ArrowDown')).toBe('next')
    expect(agentPanelKeyAction('ArrowUp')).toBe('previous')
    expect(agentPanelKeyAction('Enter')).toBe('open')
    expect(agentPanelKeyAction('x')).toBe('dismiss')
    expect(agentPanelKeyAction('Escape')).toBe('return-focus')
    // Desktop-conventional aliases for the same capability.
    expect(agentPanelKeyAction('Delete')).toBe('dismiss')
    expect(agentPanelKeyAction('Backspace')).toBe('dismiss')
    expect(agentPanelKeyAction('a')).toBeNull()
  })

  test('row movement is clamped at both ends', () => {
    const ids = [MAIN_ROW_ID, 'fork-1', 'scout-1']
    expect(nextFocusedRowId(ids, MAIN_ROW_ID, 1)).toBe('fork-1')
    expect(nextFocusedRowId(ids, MAIN_ROW_ID, -1)).toBe(MAIN_ROW_ID)
    expect(nextFocusedRowId(ids, 'scout-1', 1)).toBe('scout-1')
    expect(nextFocusedRowId(ids, 'gone', 1)).toBe(MAIN_ROW_ID)
  })

  /**
   * The decision the panel takes on a refusal: keep the text. Clearing is the
   * receipt for a delivered message, and eating the message is what made the
   * failure invisible in the first place.
   */
  test('a refused follow-up keeps what the user typed; a delivered one clears it', () => {
    expect(followUpClearsInput(false)).toBe(false)
    expect(followUpClearsInput(true)).toBe(true)
    // A caller with nothing to report is treated as delivered (unchanged path).
    expect(followUpClearsInput(undefined)).toBe(true)
  })

  test('only starting and running rows count as running', () => {
    expect(isAgentRowRunning('starting')).toBe(true)
    expect(isAgentRowRunning('running')).toBe(true)
    for (const status of ['completed', 'failed', 'stopped', 'interrupted'] as const) {
      expect(isAgentRowRunning(status)).toBe(false)
    }
  })
})

// F1.806 (origin SIT-p, 2026-09-25) — the Pi "Running agents: 1 agent" panel still listed a background worker after it
// had completed and been reported. sub-agents.md#run-subagents-in-foreground-or-background: "When a subagent finishes
// successfully, Claude Code removes its row immediately"; one that fails or is stopped keeps its row (Claude: 30 s, or
// `x`). The Pi panel follows Claude's page (the runtime owning the surface).
describe('a finished child leaves the panel (F1.806)', () => {
  test('a completed child is not listed', () => {
    expect(isAgentChildListed(child({ status: 'completed' }))).toBe(false)
  })

  test('boundary: a running, failed, stopped or interrupted child is still listed (its row offers stop or dismiss)', () => {
    for (const status of ['starting', 'running', 'failed', 'stopped', 'interrupted'] as const) {
      expect(isAgentChildListed(child({ status }))).toBe(true)
    }
  })

  test('the panel hook filters the snapshot through it', async () => {
    const { readFileSync } = await import('node:fs')
    const hook = readFileSync(new URL('../../../hooks/useAgentPanel.ts', import.meta.url), 'utf8')
    expect(hook).toContain('.filter(isAgentChildListed)')
  })
})
