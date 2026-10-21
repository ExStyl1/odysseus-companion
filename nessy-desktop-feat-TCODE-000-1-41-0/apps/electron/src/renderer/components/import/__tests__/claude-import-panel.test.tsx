/**
 * P2.9 — the Claude Code import step's rendered states.
 *
 * `ClaudeImportPanel` is the ONE surface behind Settings → Import and the
 * optional onboarding import step, so these assertions cover both. They drive
 * the REAL component (no stub of it) and assert what the user actually sees per
 * state: the dry-run preview naming every artifact kind, the
 * nothing-to-import empty state, and a conflict rendered as a conflict rather
 * than as a write.
 *
 * The dry-run guarantee itself — that computing a plan writes nothing — is a
 * converter property and is asserted in
 * `packages/shared/src/capabilities/__tests__/claude-setup-import.test.ts`.
 * What is asserted HERE is that the confirm control is only reachable from the
 * preview state, which is what makes the write a single confirmed step.
 */

import * as React from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  ClaudeSetupImportPlan,
  ClaudeSetupImportResult,
} from '@nessy-agent/shared/capabilities/claude-setup-import'
import enTranslations from '@nessy-agent/shared/i18n/locales/en.json'
import { ClaudeImportPanel, type ClaudeImportStatus } from '../ClaudeImportPanel'

let i18n: I18nInstance

beforeAll(async () => {
  i18n = createInstance()
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    // The REAL shipped locale, so a rendered label that is missing a key shows
    // up here as the raw key rather than as a passing assertion against a
    // hand-written stub.
    resources: { en: { translation: enTranslations as Record<string, string> } },
    interpolation: { escapeValue: false },
  })
})

const noop = () => {}

function render(props: {
  status: ClaudeImportStatus
  plan?: ClaudeSetupImportPlan | null
  result?: ClaudeSetupImportResult | null
  errorMessage?: string
}): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ClaudeImportPanel {...props} onScan={noop} onImport={noop} onCancel={noop} />
    </I18nextProvider>,
  )
}

const plan = (overrides: Partial<ClaudeSetupImportPlan> = {}): ClaudeSetupImportPlan => ({
  claudeDir: '/home/you/.claude',
  workspaceRootPath: '/ws',
  changes: [],
  warnings: [],
  empty: false,
  ...overrides,
})

const fullPlan = plan({
  changes: [
    { kind: 'instruction', action: 'merge', name: 'CLAUDE.md', target: 'AGENTS.md', detail: '42 lines' },
    { kind: 'permission', action: 'merge', name: 'Permission rules', target: 'permissions.json', detail: '7 rule(s)' },
    { kind: 'skill', action: 'create', name: 'commit-helper', target: 'skills/commit-helper' },
    { kind: 'mcp', action: 'create', name: 'filesystem', target: 'sources/filesystem', detail: 'stdio' },
    { kind: 'hook', action: 'create', name: 'Hooks', target: 'hooks.json', detail: 'PreToolUse' },
  ],
})

describe('ClaudeImportPanel — dry-run preview', () => {
  it('names every artifact kind it is about to import', () => {
    const html = render({ status: 'preview', plan: fullPlan })
    for (const heading of ['Instructions', 'Permissions', 'Skills', 'MCP servers', 'Hooks']) {
      expect(html).toContain(heading)
    }
    // The individual changes, not just the group headings.
    expect(html).toContain('commit-helper')
    expect(html).toContain('filesystem')
    expect(html).toContain('7 rule(s)')
  })

  it('offers the confirm and cancel controls only in the preview state', () => {
    const preview = render({ status: 'preview', plan: fullPlan })
    expect(preview).toContain('The following will be imported:')
    expect(preview).toContain('>Import<')
    expect(preview).toContain('>Cancel<')
    // Before a scan there is nothing to confirm — so no write can be started.
    const idle = render({ status: 'idle' })
    expect(idle).not.toContain('>Import<')
    expect(idle).toContain('Scan ~/.claude')
  })

  it('badges an additive target as Merge and a new target as Add', () => {
    const html = render({ status: 'preview', plan: fullPlan })
    expect(html).toContain('data-action="merge"')
    expect(html).toContain('data-action="create"')
    expect(html).not.toContain('data-action="conflict"')
  })
})

describe('ClaudeImportPanel — nothing to import', () => {
  it('renders the empty state and no confirm control', () => {
    const html = render({ status: 'preview', plan: plan({ empty: true }) })
    expect(html).toContain('Nothing to import')
    expect(html).toContain('No Claude Code configuration was found in ~/.claude.')
    expect(html).not.toContain('>Import<')
  })
})

describe('ClaudeImportPanel — conflict', () => {
  it('renders an existing target as a conflict, with its warnings', () => {
    const html = render({
      status: 'preview',
      plan: plan({
        changes: [{ kind: 'skill', action: 'conflict', name: 'commit-helper', target: 'skills/commit-helper' }],
        warnings: ['MCP server "broken" has no usable stdio command or http/sse url; skipped.'],
      }),
    })
    expect(html).toContain('data-action="conflict"')
    expect(html).toContain('Conflict')
    expect(html).toContain('Warnings')
    expect(html).toContain('no usable stdio command')
  })
})

describe('ClaudeImportPanel — result', () => {
  it('reports how much was applied and how much was skipped', () => {
    const html = render({
      status: 'done',
      result: { applied: fullPlan.changes, skipped: [fullPlan.changes[2]!], errors: [] },
    })
    expect(html).toContain('Import complete')
    expect(html).toContain('5 imported')
    expect(html).toContain('1 skipped')
  })

  it('surfaces per-item write errors', () => {
    const html = render({
      status: 'done',
      result: { applied: [], skipped: [], errors: ['skill "commit-helper": EACCES'] },
    })
    expect(html).toContain('Some items could not be imported')
    expect(html).toContain('EACCES')
  })

  /**
   * P6.654 — an import can WRITE a server and still leave it unable to run. The
   * done screen is where the user lands, so that is where it has to be said.
   */
  it('names the servers that were imported switched off, with what to do next', () => {
    const html = render({
      status: 'done',
      result: {
        applied: [
          fullPlan.changes[0]!,
          {
            kind: 'mcp',
            action: 'create',
            name: 'github',
            target: 'sources/github',
            needsAuth: true,
            detail: 'stdio · imported disabled: it declares environment variables or headers that were not carried',
          },
        ],
        skipped: [],
        errors: [],
      },
    })
    expect(html).toContain('data-testid="claude-import-needs-auth"')
    expect(html).toContain('Needs authentication before it can run')
    // The instruction, not just the fact.
    expect(html).toContain('add the missing values')
    // Named, so the user knows WHICH server to open.
    expect(html).toContain('github')
    expect(html).toContain('sources/github')
    // And only that one: a change with no flag is not swept into the card.
    expect(html).not.toContain('CLAUDE.md · Target')
  })

  it('draws no review card when nothing needs authentication', () => {
    const html = render({
      status: 'done',
      result: { applied: fullPlan.changes, skipped: [], errors: [] },
    })
    // The `fullPlan` MCP change carries no `needsAuth`, so the done screen is
    // byte-for-byte what it was before this card existed.
    expect(html).not.toContain('claude-import-needs-auth')
    expect(html).not.toContain('Needs authentication')
  })
})

/**
 * UB15.3 — the panel on v0.15.1's settings material (ours: upstream has no import page). It is one
 * `SettingsSection` inside the Settings → Import page's `SettingsPage` column, the kind groups are raised
 * `SettingsCard`s, the actions are the shared `Button`, and every colour is a solved ROLE: the seven raw
 * palette lines it carried (`amber-` / `blue-` / `emerald-`, light and `dark:` pairs) are gone.
 */
describe('ClaudeImportPanel — settings material and roles (UB15.3)', () => {
  const RAW_PALETTE =
    /\b(?:bg|text|border|ring|from|to|via|fill|stroke|outline|divide|decoration|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/
  const conflictPlan = plan({
    changes: [
      ...fullPlan.changes,
      { kind: 'skill', action: 'conflict', name: 'existing-skill', target: 'skills/existing-skill' },
    ],
    warnings: ['MCP server "broken" has no usable stdio command or http/sse url; skipped.'],
  })
  const everyState = (): Array<[string, string]> => [
    ['idle', render({ status: 'idle' })],
    ['scanning', render({ status: 'scanning' })],
    ['preview', render({ status: 'preview', plan: conflictPlan })],
    ['empty', render({ status: 'preview', plan: plan({ empty: true }) })],
    ['importing', render({ status: 'importing' })],
    ['done', render({
      status: 'done',
      result: {
        applied: [...fullPlan.changes, { kind: 'mcp', action: 'create', name: 'github', target: 'sources/github', needsAuth: true }],
        skipped: [fullPlan.changes[2]!],
        errors: ['skill "commit-helper": EACCES'],
      },
    })],
    ['error', render({ status: 'error', errorMessage: 'Select a workspace before importing.' })],
  ]

  it('POSITIVE — a quiet section heading, raised group cards, role-tinted chips per action and the shared Button', () => {
    const preview = render({ status: 'preview', plan: conflictPlan })
    // The panel's heading is SettingsSection's h3 (the page owns the h2 title + lede).
    expect(preview).toContain('<h3 class="text-label-sm font-semibold text-secondary">Import from Claude Code</h3>')
    // Each kind group is a raised SettingsCard.
    expect(preview).toContain('rounded-lg bg-raised shadow-elev-1 overflow-hidden')
    // One chip per action, each on its own role tint.
    expect(preview).toMatch(/data-action="create" class="[^"]*bg-success-tint text-success"/)
    expect(preview).toMatch(/data-action="merge" class="[^"]*bg-accent-tint text-accent"/)
    expect(preview).toMatch(/data-action="conflict" class="[^"]*bg-info-tint text-info"/)
    // Confirm is the primary action, cancel the secondary one.
    expect(preview).toMatch(/<button data-slot="button" data-variant="primary"[^>]*>.*?Import<\/button>/)
    expect(preview).toMatch(/<button data-slot="button" data-variant="secondary"[^>]*>Cancel<\/button>/)
    // Notices take v0.15.1's banner material: the warnings the info role, the outcome its own.
    expect(preview).toContain('data-notice="info"')
    const [, done] = everyState().find(([state]) => state === 'done')!
    expect(done).toContain('data-notice="success"')
    expect(done).toMatch(/data-notice="info" data-testid="claude-import-needs-auth"/)
    const [, error] = everyState().find(([state]) => state === 'error')!
    expect(error).toContain('data-notice="error"')
    expect(error).toContain('bg-destructive-tint')
  })

  it('NEGATIVE — no state draws a raw palette class, a foreground-opacity tint or the hand-rolled buttons', () => {
    const states = everyState()
    // Control: the sweep reads real markup for all seven states.
    expect(states.every(([, html]) => html.length > 200)).toBe(true)
    expect(states.filter(([, html]) => RAW_PALETTE.test(html)).map(([state]) => state)).toEqual([])
    expect(states.filter(([, html]) => /\b(?:text|bg|border)-foreground\/|text-muted-foreground|animate-spin/.test(html)).map(([state]) => state)).toEqual([])
    expect(states.filter(([, html]) => html.includes('bg-foreground px-4 py-2') || html.includes('border border-border px-4 py-2')).map(([state]) => state)).toEqual([])
    // And at the source: the seven raw palette lines are zero (the instrument fires on a planted one).
    const source = readFileSync(fileURLToPath(new URL('../ClaudeImportPanel.tsx', import.meta.url)), 'utf8')
    expect(source.split('\n').filter(line => RAW_PALETTE.test(line))).toEqual([])
    // (spelled in parts so the file itself carries no palette class for the lint rule to flag)
    expect(RAW_PALETTE.test(['bg', 'amber-500/15'].join('-'))).toBe(true)
  })
})
