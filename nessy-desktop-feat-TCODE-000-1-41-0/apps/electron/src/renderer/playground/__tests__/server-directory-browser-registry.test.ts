/**
 * UB12.55 — the server folder browser's playground entry (`registry/server-directory-browser.tsx`), every state
 * rendered for real in DARK inside the playground's own entry frame by one child process
 * (`fixtures/server-directory-browser-probe.ts`; its docblock says why a child and why dark). Before the row no entry
 * covered the dialog here or upstream, and the playground bridge has no `listServerDirectory`, so UB14.46's restyle had
 * no surface for these states: the census arm fails on that tree (no entry, no index line), and the state arms read the
 * shipped view's markup, not a mock-up.
 *
 * UB12.115 — manual mode's error line (v0.15.1 draws none there): 'Manual · rejected path' carries the container's
 * `projects.invalidFolder` refusal under the field; 'Manual · typed path' is the control with none.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import { SERVER_DIRECTORY_BROWSER_MARKER, type ServerDirectoryBrowserRender } from './fixtures/server-directory-browser-probe'

const CHILD = new URL('./fixtures/server-directory-browser-probe.ts', import.meta.url).pathname
const REPO_ROOT = new URL('../../../../../../', import.meta.url).pathname
const ID = 'server-directory-browser'

let renders: ServerDirectoryBrowserRender[] = []
let configDir = ''

beforeAll(async () => {
  // Isolated BEFORE bun starts (AGENTS.md §Traps: the root preload freezes the config dir at import).
  configDir = mkdtempSync(join(tmpdir(), 'server-directory-browser-probe-'))
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
  const at = stdout.lastIndexOf(SERVER_DIRECTORY_BROWSER_MARKER)
  if (exitCode !== 0 || at === -1) {
    throw new Error(`server-directory-browser probe exited ${exitCode} without renders:\n${stderr.slice(-4000)}`)
  }
  renders = JSON.parse(stdout.slice(at + SERVER_DIRECTORY_BROWSER_MARKER.length)) as ServerDirectoryBrowserRender[]
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  if (configDir) rmSync(configDir, { recursive: true, force: true })
})

const label = (render: ServerDirectoryBrowserRender) => `${render.id} · ${render.variant ?? '(base state)'}`
const one = (variant: string | null): string => {
  const render = renders.find(r => r.id === ID && r.variant === variant)
  expect({ variant, found: !!render?.markup }).toEqual({ variant, found: true })
  return render!.markup!
}

/** The `[data-slot=dialog-content]` element's own markup (balanced on `<div`), so the frame around it is not read. */
function dialogContent(markup: string): string {
  const slot = markup.indexOf('data-slot="dialog-content"')
  if (slot === -1) return ''
  const start = markup.lastIndexOf('<div', slot)
  const tags = /<div\b|<\/div>/g
  tags.lastIndex = start
  let depth = 0
  for (let tag = tags.exec(markup); tag; tag = tags.exec(markup)) {
    depth += tag[0] === '</div>' ? -1 : 1
    if (depth === 0) return markup.slice(start, tag.index + tag[0].length)
  }
  return markup.slice(start)
}

/** The folder rows (the view's row class), as `[name, selected]`. */
function rows(dialog: string): Array<[string, boolean]> {
  return [...dialog.matchAll(/<button type="button" class="w-full flex items-center gap-2 px-3 min-h-row-menu text-label text-left -outline-offset-2 ([^"]+)">[\s\S]*?<span class="truncate">([^<]*)<\/span>/g)]
    .map(match => [match[2]!, match[1] === 'bg-fill-selected'])
}

/** The footer's buttons as `variant:text(:disabled)`, in order. */
function footer(dialog: string): string[] {
  const body = dialog.match(/data-slot="dialog-footer"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? ''
  return [...body.matchAll(/<button data-slot="button" data-variant="([^"]+)"[^>]*?( disabled="")?>([^<]*)<\/button>/g)]
    .map(match => `${match[1]}:${match[3]}${match[2] ? ':disabled' : ''}`)
}

const breadcrumbs = (dialog: string) =>
  [...dialog.matchAll(/<button type="button" class="hover:text-foreground hover:underline px-0\.5">([^<]*)<\/button>/g)].map(match => match[1])

const DESTRUCTIVE = /<div class="px-3 py-4 text-label text-destructive">([^<]*)<\/div>/

describe('the server folder browser, every playground state in dark (UB12.55)', () => {
  it('every state is swept, none threw, and the entry is in the index', () => {
    expect(renders.map(label)).toEqual([
      `${ID} · (base state)`,
      `${ID} · Browse · loading`,
      `${ID} · Browse · truncated`,
      `${ID} · Browse · empty folder`,
      `${ID} · Browse · error`,
      `${ID} · Browse · confirming`,
      `${ID} · Manual · empty`,
      `${ID} · Manual · typed path`,
      `${ID} · Manual · rejected path`,
    ])
    expect(renders.filter(render => render.error).map(render => `${label(render)}: ${render.error}`)).toEqual([])
    const index = readFileSync(join(import.meta.dir, '../registry/index.ts'), 'utf8')
    expect(index).toContain("import { serverDirectoryBrowserComponents } from './server-directory-browser'")
    expect(index).toContain('...serverDirectoryBrowserComponents,')
  })

  it('POSITIVE — each state draws the v0.15.1 dialog with its own listing, notice and footer', () => {
    for (const render of renders) {
      const dialog = dialogContent(render.markup!)
      expect(dialog, label(render)).toContain('rounded-xl bg-floating p-5 text-foreground shadow-elev-3')
      expect(dialog, label(render)).toContain('data-slot="dialog-title" class="text-label-lg font-semibold">Select working folder</h2>')
    }

    // The listing: six folders, one selected, the symlink drawn with its own icon and badge, the breadcrumbs root first.
    const listing = dialogContent(one(null))
    expect(rows(listing)).toEqual([
      ['api-gateway', false], ['mobile-app', false], ['nessy-desktop', false], ['payments-service', true], ['shared-configs', false],
      ['customer-onboarding-flow-experiments-2026-q3-with-a-folder-name-longer-than-the-row', false],
    ])
    expect(listing.match(/lucide-folder-symlink size-4 shrink-0 text-tertiary/g)).toHaveLength(1)
    expect(listing).toContain('<span class="text-label-sm text-tertiary shrink-0">symlink</span>')
    expect(breadcrumbs(listing)).toEqual(['/', 'home', 'alex', 'work'])
    expect(footer(listing)).toEqual(['ghost:Cancel', 'primary:Select'])

    // Loading: the spinner line, no listing yet, so no breadcrumbs and no rows.
    const loading = dialogContent(one('Browse · loading'))
    expect(loading).toContain('<div class="flex items-center justify-center gap-2 py-8 text-label text-secondary"><span class="spinner text-label" role="status"')
    expect({ rows: rows(loading).length, crumbs: breadcrumbs(loading).length }).toEqual({ rows: 0, crumbs: 0 })

    // Truncated: the server's 500-folder cap, counted against what exists, above the rows it did send.
    const truncated = dialogContent(one('Browse · truncated'))
    expect(truncated).toContain('<div class="border-b border-subtle px-3 py-2 text-label-sm text-tertiary">Showing the first 500 folders out of 1240.')
    expect(rows(truncated)).toHaveLength(500)

    // Empty: the empty line and nothing else in the list.
    const empty = dialogContent(one('Browse · empty folder'))
    expect(empty).toContain('<div class="px-3 py-4 text-label text-secondary">No subdirectories. Use the path input above to navigate.</div>')
    expect(rows(empty)).toEqual([])

    // Confirming: the forward button reads Loading and is disabled while the folder is validated.
    expect(footer(dialogContent(one('Browse · confirming')))).toEqual(['ghost:Cancel', 'primary:Loading…:disabled'])

    // Manual: the prompt and the mono path field; Select waits for a path.
    const manual = dialogContent(one('Manual · empty'))
    expect(manual).toContain('<p class="text-label text-secondary">Enter the full path on the server:</p>')
    expect(manual).toContain('placeholder="/Users/username/projects/my-project"')
    expect(footer(manual)).toEqual(['ghost:Cancel', 'primary:Select:disabled'])
    expect(footer(dialogContent(one('Manual · typed path')))).toEqual(['ghost:Cancel', 'primary:Select'])
  })

  it('NEGATIVE — the error state shows the destructive line and no rows, though its last listing is still loaded', () => {
    const error = dialogContent(one('Browse · error'))
    expect(error.match(DESTRUCTIVE)?.[1]).toBe('EACCES: permission denied, scandir &#x27;/root&#x27;')
    expect(rows(error)).toEqual([])
    expect(error).not.toContain('Showing the first')
    expect(error).not.toContain('No subdirectories.')
    // Control: the same listing is behind it (its breadcrumbs stay), and every other state draws no destructive line.
    expect(breadcrumbs(error)).toEqual(['/', 'home', 'alex', 'work'])
    const withError = new Set(['Browse · error', 'Manual · rejected path'])
    expect(renders.filter(render => !withError.has(render.variant ?? '') && DESTRUCTIVE.test(dialogContent(render.markup!))).map(label)).toEqual([])
    // No state keeps a pre-redesign class (UB14.46's source pin, read here on the rendered markup).
    for (const render of renders) {
      const dialog = dialogContent(render.markup!)
      const legacy = ['text-muted-foreground', 'border-foreground/10', 'bg-foreground/5', 'data-variant="outline"', 'font-mono text-xs']
      expect({ state: label(render), legacy: legacy.filter(old => dialog.includes(old)) }).toEqual({ state: label(render), legacy: [] })
    }
  })
})

describe('manual mode draws the container\'s error under the path field (UB12.115)', () => {
  const MANUAL_FIELD = 'placeholder="/Users/username/projects/my-project"'
  const invalidFolder = (JSON.parse(readFileSync(join(REPO_ROOT, 'packages/shared/src/i18n/locales/en.json'), 'utf8')) as Record<string, string>)['projects.invalidFolder']

  it('POSITIVE — a refused typed path shows the destructive line with projects.invalidFolder, below the field it keeps', () => {
    expect(invalidFolder).toBe('Choose a valid external folder.')
    const rejected = dialogContent(one('Manual · rejected path'))
    const line = rejected.match(DESTRUCTIVE)
    expect(line?.[1]).toBe(invalidFolder)
    expect(rejected.indexOf(MANUAL_FIELD)).toBeGreaterThan(-1)
    expect(line!.index!).toBeGreaterThan(rejected.indexOf(MANUAL_FIELD))
    expect(rejected).toContain('value="/home/alex/.ssh"')
    // Select stays live, so a corrected path can be sent again.
    expect(footer(rejected)).toEqual(['ghost:Cancel', 'primary:Select'])
  })

  it('NEGATIVE — a typed path nothing refused, and the empty field, draw no destructive line', () => {
    for (const variant of ['Manual · typed path', 'Manual · empty']) {
      const manual = dialogContent(one(variant))
      expect(manual, variant).toContain(MANUAL_FIELD)
      expect({ variant, line: DESTRUCTIVE.test(manual) }).toEqual({ variant, line: false })
      expect(manual, variant).not.toContain(invalidFolder)
    }
  })
})
