/**
 * UB14.53 (R2-17, B3-06/B3-19) — the Pages surfaces on v0.15.1's look, pinned at the source; the rendered states are
 * read in DARK by `playground/__tests__/pages-restyle-registry.test.ts`.
 *
 * - DROP-b (decided 2026-10-14, a visible divergence): v0.15.0 added "Publish as Claude artifact" to the page header
 *   (and "Open Claude artifact" to its menu), backed by `pages:publishClaudeArtifact` and
 *   `shared/pages/claude-artifact.ts`. It sends the page's content and data to claude.ai, outside our network
 *   posture; our pages publish on the internal t-artifacts service (`SharePageDialog`). So neither the button nor the
 *   channel exists: the scan below covers every place a channel or the button would have to be declared (the page
 *   view, the renderer API type, the transport map, the channel table and its routing, the server handler, the core
 *   page type, the connection helpers, both locales) and the module upstream ships, with a planted control for each
 *   needle and a positive control that the scan reads what it claims to.
 * - The header the row names: the back control is v0.15.1's `IconButton` named `pages.backToPages`, the Share entry a
 *   ghost `Button` always offered (UA6.7: nothing gates t-artifacts sharing) and named `pages.share.title`.
 * - The refresh row (ours, UA8.3; upstream has none) moved with the header onto the same vocabulary: an inset row on a
 *   hairline, its states on the roles, Review / Run now secondary and Approve primary `Button`s.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PageRefreshStatusView } from '../PageRefreshBar'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..', '..', '..')
const PAGES_DIR = join(import.meta.dir, '..')

/** Upstream's Claude-artifact surface, by every name v0.15.1 gives it (`git grep ClaudeArtifact v0.15.1`). */
const CLAUDE_ARTIFACT_NEEDLE =
  /publishPageAsClaudeArtifact|PUBLISH_CLAUDE_ARTIFACT|pages:publishClaudeArtifact|claudeArtifact|ClaudeArtifact|isClaudeAccountConnection|provider-icons\/claude\.svg/

/** Where the channel or the button would have to be declared, each with a needle the file DOES carry (the control). */
const SCANNED: ReadonlyArray<readonly [string, string]> = [
  ['apps/electron/src/renderer/components/pages/PageView.tsx', "aria-label={t('pages.share.title')}"],
  ['apps/electron/src/shared/types.ts', 'createPageLease(workspaceId: string, pageSlug: string)'],
  ['apps/electron/src/transport/channel-map.ts', 'createPageLease: invoke(RPC_CHANNELS.pages.CREATE_LEASE)'],
  ['packages/shared/src/protocol/channels.ts', "CREATE_LEASE: 'pages:createLease'"],
  ['packages/shared/src/protocol/routing.ts', 'RPC_CHANNELS.pages.CREATE_LEASE'],
  ['packages/server-core/src/handlers/rpc/pages.ts', 'server.handle(RPC_CHANNELS.pages.CREATE_LEASE'],
  ['packages/core/src/types/page.ts', 'export interface PageRenderLease'],
  ['packages/shared/src/config/llm-connections.ts', 'export function'],
  ['packages/shared/src/i18n/locales/en.json', '"pages.share.title"'],
  ['packages/shared/src/i18n/locales/ru.json', '"pages.share.title"'],
]

function read(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), 'utf8')
}

/** The file's CODE: a docblock may (and PageView's does) name the divergence; a declaration may not. JSON is all code. */
function code(relative: string): string {
  const text = read(relative)
  if (relative.endsWith('.json')) return text
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')
}

describe('UB14.53 DROP-b — no "Publish as Claude artifact" channel or button exists', () => {
  it('positive control: the needle fires on each shape upstream ships it in', () => {
    for (const planted of [
      'const updated = await window.electronAPI.publishPageAsClaudeArtifact(activeWorkspaceId, page.config.slug)',
      "    PUBLISH_CLAUDE_ARTIFACT: 'pages:publishClaudeArtifact',",
      '  publishPageAsClaudeArtifact: invoke(RPC_CHANNELS.pages.PUBLISH_CLAUDE_ARTIFACT),',
      "import claudeIcon from '@/assets/provider-icons/claude.svg'",
      '() => !isWebUI && llmConnections.some(isClaudeAccountConnection),',
      '  "pages.claudeArtifact.publish": "Publish as Claude artifact",',
      '  "toast.pageClaudeArtifactPublished": "Published as a Claude artifact",',
      '  claudeArtifact?: PageClaudeArtifactInfo;',
    ]) {
      expect({ planted, hit: CLAUDE_ARTIFACT_NEEDLE.test(planted) }).toEqual({ planted, hit: true })
    }
  })

  it('positive control: every scanned file is read and carries the declaration it is scanned for', () => {
    for (const [file, present] of SCANNED) {
      expect({ file, long: read(file).length > 1_000 }).toEqual({ file, long: true })
      // Read through the same comment stripper the negative arm uses, so the declarations it scans survive it.
      expect({ file, present: code(file).includes(present) }).toEqual({ file, present: true })
    }
  })

  it('NEGATIVE — no scanned file\'s code names the Claude-artifact surface (the comment stripper keeps code: control)', () => {
    expect(code('apps/electron/src/renderer/components/pages/PageView.tsx')).toContain("aria-label={t('pages.share.title')}")
    for (const [file] of SCANNED) {
      expect({ file, match: CLAUDE_ARTIFACT_NEEDLE.exec(code(file))?.[0] ?? null }).toEqual({ file, match: null })
    }
  })

  it('NEGATIVE — upstream\'s publisher module is absent (and the path is the one a control finds for its siblings)', () => {
    expect(existsSync(join(REPO_ROOT, 'packages/shared/src/pages/share-bundle.ts'))).toBe(true)
    expect(existsSync(join(REPO_ROOT, 'packages/shared/src/pages/claude-artifact.ts'))).toBe(false)
  })
})

describe('UB14.53 — the page header on v0.15.1\'s controls', () => {
  const view = readFileSync(join(PAGES_DIR, 'PageView.tsx'), 'utf8')

  it('POSITIVE — Back is an IconButton named pages.backToPages with its tooltip; More is an IconButton; Share a ghost Button', () => {
    expect(view).toContain("<IconButton icon={<ArrowLeft />} aria-label={t('pages.backToPages')} tooltip onClick={handleBack} />")
    expect(view).toContain("<IconButton icon={<MoreHorizontal />} aria-label={t('common.more')} />")
    expect(view).toMatch(/<Button\s+type="button"\s+variant="ghost"\s+onClick=\{\(\) => setShareOpen\(true\)\}\s+aria-label=\{t\('pages\.share\.title'\)\}/)
  })

  it('NEGATIVE — no hand-rolled header button and no surface of its own is left (planted control)', () => {
    const LEGACY = /<button\b|bg-background|border-b border-border\/50|text-foreground\/|shadow-minimal|text-sky-/
    expect(LEGACY.test('<button type="button" onClick={handleBack} aria-label={t(\'pages.backToPages\')}>')).toBe(true)
    expect(LEGACY.exec(view)?.[0] ?? null).toBeNull()
  })
})

describe('UB14.53 — the refresh row (ours) on the same vocabulary', () => {
  const refresh = { cron: '*/15 * * * *', script: 'pages/p/refresh.ts' }
  const SHA = 'a'.repeat(64)
  const render = (props: Partial<Parameters<typeof PageRefreshStatusView>[0]>) =>
    renderToStaticMarkup(createElement(PageRefreshStatusView, { refresh, status: null, reviewing: false, busy: false, ...props }))

  it('POSITIVE — needs approval: the info role, Review secondary; reviewing: the script on a sunken well, Approve primary', () => {
    const waiting = render({ status: { state: 'unapproved', sha256: SHA, script: refresh.script, content: 'console.log(1)' }, reviewing: true })
    expect(waiting).toContain('mx-3 mt-2 rounded-lg border border-subtle px-3 py-1.5 text-label-sm')
    expect(waiting).toContain('inline-flex items-center gap-1 font-medium text-info')
    expect(waiting).toMatch(/data-slot="button" data-variant="secondary"[^>]*>pages\.refresh\.hideReview<\/button>/)
    expect(waiting).toMatch(/data-slot="button" data-variant="primary"[^>]*><svg[\s\S]*?<\/svg>pages\.refresh\.approve<\/button>/)
    expect(waiting).toContain('rounded-md bg-sunken p-2 font-mono text-mono-ui leading-snug text-foreground')
    const approved = render({ status: { state: 'approved', sha256: SHA } })
    expect(approved).toContain('font-medium text-success')
    expect(approved).toMatch(/data-slot="button" data-variant="secondary"[^>]*><svg[\s\S]*?<\/svg>pages\.refresh\.runNow<\/button>/)
  })

  it('NEGATIVE — no state keeps the v0.14 bar (planted control): no hand-rolled button, palette colour or alpha text', () => {
    const LEGACY = /<button(?! data-slot)|text-foreground\/|bg-foreground\/\[|amber-|red-[0-9]|emerald-|border-b border-border|text-\[1[01](\.5)?px\]/
    expect(LEGACY.test('<div class="border-b border-border/50 px-3 py-1.5 text-[11px]"><button type="button">')).toBe(true)
    for (const status of [
      null,
      { state: 'approved' as const, sha256: SHA },
      { state: 'changed' as const, sha256: SHA, script: refresh.script, content: 'x' },
      { state: 'missing' as const },
    ]) {
      const html = render({ status, reviewing: true })
      expect({ state: status?.state ?? 'loading', legacy: LEGACY.exec(html)?.[0] ?? null }).toEqual({ state: status?.state ?? 'loading', legacy: null })
    }
    expect(render({ status: { state: 'missing' } })).toContain('font-medium text-destructive')
  })
})
