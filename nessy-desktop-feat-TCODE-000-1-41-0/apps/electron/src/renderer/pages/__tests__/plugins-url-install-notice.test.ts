/**
 * F1.986 — the "Install from repository URL" notice no longer implies the
 * repository was checked.
 *
 * `proposeRepositoryInstall` builds the proposal from the URL alone (F1.805):
 * the repository is never contacted, so a link to a repository that does not
 * exist still comes back `installable`, carrying the
 * `marketplace.repository.not_contacted` info diagnostic. The Plugins page's
 * notice for that proposal read "Installable repository proposal: {{source}}"
 * beside a check mark, which reads as "the repository was verified". It now
 * says only the URL was checked and the repository is fetched and checked at
 * install, beside a neutral info icon.
 *
 * The notice sits in `UrlInstall`, inside `PluginsPage.tsx`, whose module graph
 * needs DOM stubs to import and this package has no DOM harness; like
 * `plugin-update-affordance.test.tsx`, the notice is proved as the wire truth,
 * the strings the user reads in both locales, and a pin on its single call site.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { proposeRepositoryInstall } from '../../../../../../packages/shared/src/marketplace/repository-install.ts'

const pageSource = readFileSync(fileURLToPath(new URL('../PluginsPage.tsx', import.meta.url)), 'utf8')
function locale(name: 'en' | 'ru'): Record<string, string> {
  return JSON.parse(readFileSync(
    fileURLToPath(new URL(`../../../../../../packages/shared/src/i18n/locales/${name}.json`, import.meta.url)),
    'utf8',
  )) as Record<string, string>
}
const en = locale('en')
const ru = locale('ru')

/** `UrlInstall`'s body: from its declaration to the next top-level function. */
function urlInstallSource(): string {
  const start = pageSource.indexOf('function UrlInstall(')
  const end = pageSource.indexOf('\nfunction InlineNotice(', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return pageSource.slice(start, end)
}

describe('F1.986 — the URL-install notice says the repository is checked at install', () => {
  it('describes a proposal built from the URL alone', () => {
    // A repository nobody has looked at: the proposal cannot know it exists.
    const proposal = proposeRepositoryInstall({ url: 'https://github.com/acme/no-such-repository' })
    expect(proposal.status).toBe('installable')
    expect(proposal.diagnostics.map(diagnostic => diagnostic.code)).toContain('marketplace.repository.not_contacted')
  })

  it('says only the URL was checked, in both locales, and names the source', () => {
    const english = en['plugins.urlInstallable']
    expect(english).toContain('{{source}}')
    expect(english).toMatch(/only the URL/i)
    expect(english).toMatch(/checked when you install/i)
    expect(english).not.toMatch(/installable repository proposal/i)

    const russian = ru['plugins.urlInstallable']
    expect(russian).toContain('{{source}}')
    expect(russian).toContain('только URL')
    expect(russian).toContain('при установке')
    expect(russian).not.toContain('Предложение репозитория доступно для установки')
  })

  it('shows the notice only for an installable proposal, with an info icon and no check mark', () => {
    const body = urlInstallSource()
    // The one gate: an unsupported proposal never reaches this notice; its
    // diagnostics render through the error notice instead.
    expect(body).toMatch(
      /proposal\?\.status === 'installable' && \([^\n]*\n\s*<InlineNotice tone="info" icon=\{<Info className="mt-0\.5 h-4 w-4 shrink-0" \/>\}>\n\s*\{t\('plugins\.urlInstallable', \{ source: proposal\.displaySource \}\)\}/,
    )
    expect(body).toMatch(/\{error && \(\n\s*<InlineNotice tone="error"/)
    expect(body).not.toContain('CheckCircle2')
  })
})
