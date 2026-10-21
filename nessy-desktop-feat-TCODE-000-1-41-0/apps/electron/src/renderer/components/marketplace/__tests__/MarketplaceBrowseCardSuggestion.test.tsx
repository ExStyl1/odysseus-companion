/**
 * The suggestion chip on one browse row, isolated.
 *
 * Why it lives apart from its natural home, `MarketplaceComponents.test.tsx`:
 * when this file was written that suite could not run at all — its chain
 * reaches `pdfjs-dist/build/pdf.worker.min.mjs?url`, a Vite resource query bun
 * cannot resolve, and its static imports linked before its own stubs. D1.442
 * (`2cbd7105a`) moved those imports behind the stubs, and the suite now runs
 * alone: 25 pass / 0 fail across 1 file, re-measured 2026-09-23 (F1.136). The
 * reason that SURVIVES is the isolation itself: this file renders one card with
 * nothing but the chip's own props, so a red here is about the chip and not
 * about the detail pane's pdf chain. A comment about what ANOTHER file can do
 * is a reading with a date; re-run that suite before repeating it.
 *
 * `plugin-relevance.md` § What the user sees, fetched 2026-09-06 — "the plugin is
 * pinned above the other results with an annotation that names the matching
 * signal, such as `suggested for this directory`".
 */
import * as React from 'react'
import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { MarketplaceBrowseCard } from '@/components/marketplace/MarketplaceBrowseCard'

function card(props: Partial<React.ComponentProps<typeof MarketplaceBrowseCard>>) {
  return renderToStaticMarkup(
    <MarketplaceBrowseCard
      id="terraform-helpers"
      icon={<span />}
      name="terraform-helpers"
      installState="not-installed"
      installLabel="Install"
      installedLabel="Installed"
      installingLabel="Installing…"
      {...props}
    />,
  )
}

describe('MarketplaceBrowseCard suggestion chip', () => {
  it('names the narrowing beside the annotation', () => {
    // P6.519/P6.424 — five signals are specified, two are decided here, and the
    // three that are not are named where the suggestion appears.
    const html = card({
      suggestionLabel: 'Suggested for this directory',
      suggestionDetail: 'Not matched: cli, hosts, filesRead',
    })
    expect(html).toContain('data-testid="marketplace-card-suggestion"')
    expect(html).toContain('Suggested for this directory')
    expect(html).toContain('Not matched: cli, hosts, filesRead')
  })

  it('carries the dependency annotation as its own sentence, not the directory one', () => {
    // P6.519's second signal. `plugin-relevance.md` says the annotation "names
    // the matching signal", so the two must not collapse onto one label — a row
    // pinned because the project depends on something says a different thing
    // from a row pinned because of where the session is working.
    const html = card({
      suggestionLabel: 'Suggested for your dependencies',
      suggestionDetail: 'Not matched: cli, hosts, filesRead',
    })
    expect(html).toContain('Suggested for your dependencies')
    expect(html).not.toContain('Suggested for this directory')
  })

  it('renders no chip without a label, so a detail alone cannot make an empty pill', () => {
    expect(card({ suggestionDetail: 'Not matched: cli, hosts, filesRead' }))
      .not.toContain('data-testid="marketplace-card-suggestion"')
    expect(card({})).not.toContain('data-testid="marketplace-card-suggestion"')
  })
})
