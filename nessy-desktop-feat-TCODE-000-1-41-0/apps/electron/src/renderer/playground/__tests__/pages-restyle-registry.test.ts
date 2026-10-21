/**
 * UB14.53 (R2-17) — every Pages playground state rendered for real in DARK inside the playground's own entry frame by
 * one child process (`fixtures/pages-entries-probe.ts`; its docblock says why a child and why dark): the library, the
 * tile, the delete dialog, the share dialog and the page view (`registry/pages.tsx`).
 *
 * What a reviewer sees: v0.15.1's look with our Share action — the page header's Back and More as `IconButton`s and
 * the Share entry a ghost `Button` named "Share Page" (the accent globe and "Shared" while a copy is live), the body
 * without a surface of its own, the no-content actions primary + secondary, the library's 48px header with New Page
 * secondary, the tile a raised 16:10 card with the kind placeholder, the delete confirm danger-solid, the share
 * dialog's footer ghost/primary (Unpublish `danger` to arm). Before the row the page header drew hand-rolled
 * `<button>`s on `text-foreground/60`, the tile `bg-card shadow-minimal` with a title monogram, the footers `outline`
 * + `destructive`, so the POSITIVE and NEGATIVE arms fail on that tree. The DROP-b pin and the source-level arms are
 * `components/pages/__tests__/pages-restyle.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import { PAGES_ENTRIES_MARKER, type PagesEntryRender } from './fixtures/pages-entries-probe'

const CHILD = new URL('./fixtures/pages-entries-probe.ts', import.meta.url).pathname
const REPO_ROOT = new URL('../../../../../../', import.meta.url).pathname
const LOCALES_DIR = join(REPO_ROOT, 'packages', 'shared', 'src', 'i18n', 'locales')
const EN = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8')) as Record<string, string>

let renders: PagesEntryRender[] = []
let configDir = ''

beforeAll(async () => {
  // Isolated BEFORE bun starts (AGENTS.md §Traps: the root preload freezes the config dir at import).
  configDir = mkdtempSync(join(tmpdir(), 'pages-entries-probe-'))
  const child = Bun.spawn([process.execPath, CHILD], {
    cwd: REPO_ROOT,
    env: { ...process.env, NESSY_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const killer = setTimeout(() => child.kill(), MODULE_GRAPH_HOOK_BUDGET_MS - 30_000)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(killer)
  const at = stdout.lastIndexOf(PAGES_ENTRIES_MARKER)
  if (exitCode !== 0 || at === -1) {
    throw new Error(`pages-entries probe exited ${exitCode} without renders:\n${stderr.slice(-4000)}`)
  }
  renders = JSON.parse(stdout.slice(at + PAGES_ENTRIES_MARKER.length)) as PagesEntryRender[]
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  if (configDir) rmSync(configDir, { recursive: true, force: true })
})

const label = (render: PagesEntryRender) => `${render.id} · ${render.variant ?? '(base state)'}`
const one = (id: string, variant: string | null): string => {
  const render = renders.find(r => r.id === id && r.variant === variant)
  expect({ id, variant, found: !!render?.markup }).toEqual({ id, variant, found: true })
  return render!.markup!
}

/** The opening tag of the element carrying `attribute` (e.g. `aria-label="Back to Pages"`). */
function tagWith(markup: string, attribute: string): string {
  const at = markup.indexOf(attribute)
  if (at === -1) return ''
  const start = markup.lastIndexOf('<', at)
  return markup.slice(start, markup.indexOf('>', at) + 1)
}

/** The footer's buttons as `data-variant` values, in order. */
function footerVariants(markup: string): string[] {
  const footer = markup.match(/data-slot="dialog-footer"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? ''
  return [...footer.matchAll(/<button data-slot="button" data-variant="([^"]+)"/g)].map(match => match[1]!)
}

/** Classes the v0.14 pages drew and v0.15.1 retired (palette colours, alpha foreground, the old shadow and Button aliases). */
const LEGACY = /text-foreground\/|bg-foreground\/\[|amber-|red-[0-9]|emerald-|sky-[0-9]|shadow-minimal|border-border\/|bg-card\b|data-variant="(outline|destructive|default)"|text-\[1[0-3](\.5)?px\]|rounded-\[8px\]/

describe('UB14.53 — the Pages entries, every state, rendered in dark', () => {
  it('every state of the five entries renders (none threw)', () => {
    const ids = [...new Set(renders.map(r => r.id))]
    expect(ids).toEqual(['pages-library', 'pages-tile', 'pages-delete-dialog', 'pages-share-dialog', 'pages-view'])
    expect(renders.filter(r => r.error).map(r => `${label(r)}: ${r.error}`)).toEqual([])
    expect(renders.filter(r => r.id === 'pages-view').length).toBe(8)
  })

  it('POSITIVE — the page header: Back is an IconButton named "Back to Pages", More an IconButton, Share a ghost Button "Share Page"', () => {
    const frame = one('pages-view', 'Frame')
    expect(frame).toContain('<div class="flex h-12 shrink-0 items-center gap-1.5 px-2.5 @max-mobile/shell:px-1.5">')
    expect(tagWith(frame, `aria-label="${EN['pages.backToPages']}"`)).toContain('data-slot="icon-button"')
    expect(tagWith(frame, `aria-label="${EN['common.more']}"`)).toContain('data-slot="icon-button"')
    const share = tagWith(frame, `aria-label="${EN['pages.share.title']}"`)
    expect(share).toContain('data-slot="button" data-variant="ghost"')
    expect(share).toContain(`title="${EN['pages.share.title']}"`)
    // No surface of its own: the panel's paper shows through.
    expect(frame).toContain('<div class="h-full w-full"><div class="flex h-full flex-col">')
  })

  it('POSITIVE — a live copy: the Share entry wears the accent globe and says "Shared"; NEGATIVE — none without one', () => {
    const published = one('pages-view', 'Frame · published')
    expect(tagWith(published, `aria-label="${EN['pages.share.title']}"`)).toContain(`title="${EN['pages.shared']}"`)
    expect(published).toContain('lucide-earth text-accent')
    expect(published).toContain(`<span class="hidden pr-0.5 @[28rem]/panel:inline">${EN['pages.shared']}</span>`)
    const plain = one('pages-view', 'Frame')
    expect(plain).not.toContain('text-accent')
    expect(plain).not.toContain(`>${EN['pages.shared']}</span>`)
  })

  it('POSITIVE — no content: "Design this with an agent" primary, "Open Folder" secondary; the refresh row and alert on the roles', () => {
    const empty = one('pages-view', 'No content')
    expect(empty).toMatch(new RegExp(`data-variant="primary"[^>]*><svg[\\s\\S]*?</svg>${EN['pages.designWithAgent']}</button>`))
    expect(empty).toMatch(new RegExp(`data-variant="secondary"[^>]*><svg[\\s\\S]*?</svg>${EN['pages.openFolder']}</button>`))
    const failed = one('pages-view', 'Frame · refresh failed')
    expect(tagWith(failed, 'data-page-refresh-state=')).toContain('mx-3 mt-2 rounded-lg border border-subtle px-3 py-1.5 text-label-sm')
    expect(failed).toContain(EN['pages.refreshFailed']!)
    // Boundary: no schedule, no refresh row.
    expect(one('pages-view', 'Frame')).not.toContain('data-page-refresh-state=')
  })

  it('POSITIVE — the library header and grid, the tile card and its placeholder, the delete and share footers', () => {
    const library = one('pages-library', 'Three kinds')
    expect(library).toContain('<div class="flex h-12 shrink-0 items-center justify-between gap-2 px-gutter">')
    expect(library).toMatch(new RegExp(`data-variant="secondary"[^>]*><svg[\\s\\S]*?</svg> ${EN['pages.newPage']}</button>`))
    expect(library).toContain('grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4 px-gutter')
    const empty = one('pages-library', 'Empty')
    expect([...empty.matchAll(/data-slot="button" data-variant="secondary"/g)].length).toBe(3) // New Page + the two empty actions

    for (const variant of ['Static', 'Interactive', 'Live']) {
      const tile = one('pages-tile', variant)
      expect(tile).toContain('rounded-lg bg-raised text-left shadow-elev-1')
      expect(tile).toContain('hover:translate-y-[calc(-2px*var(--motion-scale))] hover:shadow-elev-2')
      expect(tile).toContain('relative aspect-[16/10] w-full overflow-hidden border-b border-subtle bg-sunken')
      expect(tile).toContain('grid size-11 place-items-center rounded-full bg-raised text-secondary shadow-elev-1')
    }
    expect(one('pages-tile', 'Published')).toContain(`title="${EN['pages.shared']}"`)
    expect(one('pages-tile', 'Live')).not.toContain(`title="${EN['pages.shared']}"`)

    expect(footerVariants(one('pages-delete-dialog', 'Default'))).toEqual(['ghost', 'danger-solid'])
    expect(footerVariants(one('pages-share-dialog', 'Not published — review card'))).toEqual(['ghost', 'primary'])
    expect(footerVariants(one('pages-share-dialog', 'Published, up to date'))).toEqual(['danger'])
    expect(one('pages-share-dialog', 'Source approval needs the view-only ack'))
      .toContain('rounded-lg border border-[color:var(--info-border)] bg-info-tint p-3')
    expect(one('pages-share-dialog', 'Script approval blocks publishing'))
      .toContain('rounded-lg border border-[color:var(--destructive-border)] bg-destructive-tint p-3')
  })

  it('NEGATIVE — no Pages state draws a v0.14 class or Button alias (planted control)', () => {
    // Control: the pre-row page header and tile, as they rendered, trip the census.
    expect(LEGACY.test('<button type="button" class="flex h-7 w-7 items-center rounded-md text-foreground/60">')).toBe(true)
    expect(LEGACY.test('<button class="rounded-xl border border-foreground/[0.08] bg-card shadow-minimal">')).toBe(true)
    expect(LEGACY.test('<button data-slot="button" data-variant="outline">')).toBe(true)
    const offenders = renders
      .filter(r => r.markup && LEGACY.test(r.markup))
      .map(r => `${label(r)}: ${LEGACY.exec(r.markup!)![0]}`)
    expect(offenders).toEqual([])
  })
})
