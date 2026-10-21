/**
 * P6.940 clause (1) — a session running AS an agent SAYS SO, for the life of the
 * session.
 *
 * P6.312 landed the claude arm and the `sessionAgent` key (`c3eb37ba5`); its own
 * `done_means` opens with *"a session started as agent X shows `@X` in the
 * composer"*, and that half was the tail it left. Without it the pin is a
 * setting with no visible effect — the prompt and the tools change and nothing
 * on screen says why.
 *
 * THE MOUNT IS PINNED BY SOURCE, for the reason `never-persist-badge-mount.test.tsx`
 * measures in its own header: importing `ActiveOptionBadges.tsx` in a bare bun
 * process throws `TypeError: import.meta.glob is not a function` from
 * `ThemeContext.tsx`, a Vite-only API. So the mount is asserted against its
 * source and the CHIP itself is RENDERED — `SessionFactChip` (UB14.55: the quiet
 * static chip of the one row above the composer; it was a `MetadataBadge`)
 * imports nothing Vite-only, so the label and the sentence are proved to be real
 * text rather than prop names.
 */

import * as React from 'react'
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { SessionFactChip } from '../SessionFactChip'

/** Comment-stripped source: this file's comments quote the very strings it pins. */
function stripped(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const badges = stripped('../ActiveOptionBadges.tsx')

function locale(name: 'en' | 'ru'): Record<string, string> {
  return JSON.parse(readFileSync(
    new URL(`../../../../../../../packages/shared/src/i18n/locales/${name}.json`, import.meta.url),
    'utf8',
  )) as Record<string, string>
}

describe('the pinned-agent badge is mounted (P6.940 clause 1)', () => {
  it('renders from the composer capabilities, not from the setting', () => {
    // POSITIVE: the chip exists, and its source is the SERVER's per-session
    // answer rather than the app-wide key. That distinction is the row: the key
    // is app-wide and the pin is not — it was claude-only when this file was
    // written, and P6.961 added Pi's host-composed arm without touching one line
    // of the renderer, which is the payoff. A renderer read of the setting would
    // put `@X` on a codex session that ignores it.
    expect(badges).toContain('useComposerCapabilities().sessionAgent')
    expect(badges).toContain('{sessionAgent && (')
    expect(badges).toContain("label={t('session.sessionAgentBadge', { name: sessionAgent })}")
    expect(badges).toContain("title={t('session.sessionAgentBadgeTitle', { name: sessionAgent })}")
    expect(badges).toContain('data-testid="session-agent-badge"')
    // The chip row renders for a pinned session even when it has nothing else in
    // it — otherwise the badge would be invisible in a brand-new chat, which is
    // exactly where "what am I talking to" is asked. UB14.55: the row's own condition.
    const at = badges.indexOf('const showChipRow =')
    expect(at).toBeGreaterThan(-1)
    expect(badges.slice(at, badges.indexOf('\n', at))).toContain('|| !!sessionAgent')
  })

  it('the name and the withheld half reach the markup', () => {
    const en = locale('en')
    const html = renderToStaticMarkup(
      <SessionFactChip
        label={en['session.sessionAgentBadge']!.replace('{{name}}', 'reviewer')}
        title={en['session.sessionAgentBadgeTitle']!.replace('{{name}}', 'reviewer')}
        data-testid="session-agent-badge"
      />,
    )
    expect(html).toContain('@reviewer')
    expect(html).toContain('title="')
    expect(html).toContain('data-testid="session-agent-badge"')
    expect(html).toContain('h-control-sm')
    // The owner's 2026-09-07 option (b) in the sentence: the prompt and the
    // tools are pinned and the MODEL is not, which is the one thing a user
    // cannot see anywhere else. Asserted on the STRING rather than the markup,
    // which escapes.
    for (const clause of ['system prompt', 'tool restrictions', 'model is unchanged']) {
      expect(en['session.sessionAgentBadgeTitle']).toContain(clause)
    }
    // Both locales carry both keys, non-empty, and both interpolate the name.
    for (const name of ['en', 'ru'] as const) {
      const table = locale(name)
      expect(table['session.sessionAgentBadge']).toContain('{{name}}')
      expect(table['session.sessionAgentBadgeTitle']).toContain('{{name}}')
    }
  })

  it('offers no control, and changes nothing for a session that is not pinned', () => {
    // NEGATIVE, the control: nothing here can repin a session already running,
    // so a clickable chip would offer something that does not exist — the same
    // reason the never-persist badge above it is inert.
    const start = badges.indexOf('{sessionAgent && (')
    const end = badges.indexOf('{goal && (', start)
    expect(end).toBeGreaterThan(start)
    const block = badges.slice(start, end)
    expect(block).toContain('<SessionFactChip')
    expect(block).not.toContain('onClick')
    expect(block).not.toContain('interactive')
    expect(block).not.toContain('showChevron')
  })

  it('is actually FED — the server decides, and the provider gate is in shared', () => {
    // POSITIVE. A mounted chip whose value no production caller supplies renders
    // for nobody, which this file cannot see on its own: the decision is in
    // another package.
    const resolver = stripped('../../../../../../../packages/shared/src/agent/backend/composer-capabilities.ts')
    expect(resolver).toContain(
      "input.sessionAgent && (input.provider === 'anthropic' || input.provider === 'pi')",
    )
    const manager = stripped('../../../../../../../packages/server-core/src/sessions/SessionManager.ts')
    expect(manager).toContain('function resolvePinnedSessionAgent(')
    expect(manager).toContain('const sessionAgent = resolvePinnedSessionAgent(memo)')
    // NEGATIVE, and it is the P3.326 measurement this row had to respect: the
    // key is a disk read, and reading it per session was 80 % of `getSessions()`
    // when the workspace config did it. It is memoised on the same pass-scoped
    // object, so a 800-session list reads config.json ONCE.
    expect(manager).toContain('if (memo?.sessionAgent) return memo.sessionAgent.name')
    expect(manager).toContain('if (memo) memo.sessionAgent = { name }')
    // P6.961 — the second arm names something the host really applies: Pi has no
    // main-session-agent option, so clause (2) composes the projection here.
    // Without this line the widened gate above could be satisfied by a runtime
    // that ignores the pin, which is the exact failure the gate exists to stop.
    expect(manager).toContain('resolvePiSessionAgentPin(')
  })
})
