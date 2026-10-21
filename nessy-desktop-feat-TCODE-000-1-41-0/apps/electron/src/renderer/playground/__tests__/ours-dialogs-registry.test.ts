/**
 * UB14.39 (R6-10) — our own dialogs, every playground state rendered for real in DARK inside the playground's own
 * entry frame by one child process (`fixtures/ours-dialog-entries-probe.ts`; its docblock says why a child and why
 * dark): `registry/ours-dialogs.tsx`'s entries plus the existing entries that already mounted one of these dialogs.
 *
 * What a reviewer sees: each dialog on v0.15.1's floating material with the footer in v0.15.1's words (Cancel the
 * ghost, the forward action the primary, an irreversible confirmation `danger-solid`, a lesser alternative the
 * secondary) and no v0.14 class inside the dialog. Before the row the footers read `outline` + default / `destructive`
 * and the bodies drew `text-muted-foreground`, `text-foreground/NN`, amber and green palette colours,
 * `shadow-minimal` and `uppercase tracking-wide` headings, so the POSITIVE and NEGATIVE arms fail on that tree.
 * The source-level pin (inline dialogs included) is `components/__tests__/ours-dialogs-vocabulary.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import { OURS_DIALOG_ENTRIES_MARKER, type OursDialogEntryRender } from './fixtures/ours-dialog-entries-probe'

const CHILD = new URL('./fixtures/ours-dialog-entries-probe.ts', import.meta.url).pathname
const REPO_ROOT = new URL('../../../../../../', import.meta.url).pathname

let renders: OursDialogEntryRender[] = []
let configDir = ''

beforeAll(async () => {
  // Isolated BEFORE bun starts (AGENTS.md §Traps: the root preload freezes the config dir at import).
  configDir = mkdtempSync(join(tmpdir(), 'ours-dialog-entries-probe-'))
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
  const at = stdout.lastIndexOf(OURS_DIALOG_ENTRIES_MARKER)
  if (exitCode !== 0 || at === -1) {
    throw new Error(`ours-dialog-entries probe exited ${exitCode} without renders:\n${stderr.slice(-4000)}`)
  }
  renders = JSON.parse(stdout.slice(at + OURS_DIALOG_ENTRIES_MARKER.length)) as OursDialogEntryRender[]
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  if (configDir) rmSync(configDir, { recursive: true, force: true })
})

const label = (render: OursDialogEntryRender) => `${render.id} · ${render.variant ?? '(base state)'}`
const statesOf = (id: string) => renders.filter(render => render.id === id)
const one = (id: string, variant: string | null): string => {
  const render = renders.find(r => r.id === id && r.variant === variant)
  expect({ id, variant, found: !!render?.markup }).toEqual({ id, variant, found: true })
  return render!.markup!
}

/** The `[data-slot=dialog-content]` element's own markup (balanced on `<div`), so a page around it is not read. */
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

/** The footer's buttons as `data-variant` values, in order. */
function footerVariants(dialog: string): string[] {
  const footer = dialog.match(/data-slot="dialog-footer"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? ''
  return [...footer.matchAll(/<button data-slot="button" data-variant="([^"]+)"/g)].map(match => match[1]!)
}

/** The button whose text (an icon aside) is `name`, as its opening tag. */
const buttonOf = (markup: string, name: string) =>
  markup.match(new RegExp(`<button data-slot="button"[^>]*>(?:<svg[\\s\\S]*?</svg>)?${name}</button>`))?.[0] ?? ''

/** Every swept dialog state and the footer it must show (Cancel first: DialogFooter is column-reverse on compact). */
const FOOTERS: Record<string, readonly string[]> = {
  'bypass-permissions-dialog': ['ghost', 'danger-solid'],
  'project-trust-dialog': ['ghost', 'secondary', 'danger-solid'],
  'run-confirmation-dialog': ['ghost', 'primary'],
  'extend-published-page-dialog': ['ghost', 'primary'],
  'delete-published-page-dialog': ['ghost', 'danger-solid'],
  'runtime-switch-dialog-costs': ['ghost', 'primary'],
  'plugin-configuration-prompt': ['ghost', 'primary'],
  'plugin-install-checklist': ['ghost', 'primary'],
  'marketplace-browse': ['ghost', 'primary'],
}

describe('our own dialogs, every playground state in dark (UB14.39)', () => {
  it('every state is swept, none threw, and the registry is in the index', () => {
    expect(renders.map(label)).toEqual([
      'bypass-permissions-dialog · (base state)',
      'project-trust-dialog · (base state)',
      'project-contributions-list · (base state)', 'project-contributions-list · Empty report',
      'run-confirmation-dialog · (base state)', 'run-confirmation-dialog · No plugins', 'run-confirmation-dialog · Plugins unknown',
      'extend-published-page-dialog · (base state)',
      'delete-published-page-dialog · (base state)',
      'marketplace-skill-preview-modal · (base state)', 'marketplace-skill-preview-modal · Close only',
      'runtime-switch-dialog-costs · (base state)', 'runtime-switch-dialog-costs · Pi → Codex, trimmed tail',
      'runtime-switch-dialog-costs · Pi → Claude, native carry', 'runtime-switch-dialog-costs · Claude → Codex — the marker inside a long list',
      'runtime-switch-dialog-costs · Codex → Pi — the shortest list there is', 'runtime-switch-dialog-costs · Claude → Pi — a counted row and an UNMEASURED one',
      'runtime-switch-dialog-costs · Same runtime — the empty block', 'runtime-switch-dialog-costs · Preview declined to answer',
      'plugin-configuration-prompt · (base state)', 'plugin-configuration-prompt · Required key unset', 'plugin-configuration-prompt · Optional key unset',
      'plugin-configuration-prompt · No imported title/description', 'plugin-configuration-prompt · Already configured',
      'plugin-install-checklist · (base state)', 'plugin-install-checklist · nessy-default-extension', 'plugin-install-checklist · dp signed in',
      'plugin-install-checklist · dp sign-in failed', 'plugin-install-checklist · Connectors only', 'plugin-install-checklist · Environment values',
      'marketplace-browse · Add marketplace dialog',
    ])
    expect(renders.filter(render => render.error).map(render => `${label(render)}: ${render.error}`)).toEqual([])
    const index = readFileSync(join(import.meta.dir, '../registry/index.ts'), 'utf8')
    expect(index).toContain("import { oursDialogComponents } from './ours-dialogs'")
    expect(index).toContain('...oursDialogComponents,')
  })

  it('POSITIVE — every dialog floats on the v0.15.1 material and its footer reads Cancel ghost, then primary or danger-solid', () => {
    for (const [id, expected] of Object.entries(FOOTERS)) {
      for (const render of statesOf(id)) {
        const dialog = dialogContent(render.markup!)
        expect(dialog, label(render)).toContain('class="motion-dialog')
        expect(dialog, label(render)).toContain('rounded-xl bg-floating p-5 text-foreground shadow-elev-3')
        expect({ state: label(render), footer: footerVariants(dialog) }).toEqual({ state: label(render), footer: [...expected] })
      }
    }
    // The skill preview: Close ghost beside the primary Install, or the lone Close as the secondary; the body on the
    // raised card Info_Section draws.
    const preview = dialogContent(one('marketplace-skill-preview-modal', null))
    expect(footerVariants(preview)).toEqual(['ghost', 'primary'])
    expect(footerVariants(dialogContent(one('marketplace-skill-preview-modal', 'Close only')))).toEqual(['secondary'])
    expect(preview).toContain('<div class="overflow-hidden rounded-lg bg-raised shadow-elev-1">')
    expect(preview).toContain('<span class="ml-2 font-normal text-tertiary">Skill</span>')
  })

  it('POSITIVE — the labelled irreversible buttons, the segmented retention choice and the checklist\'s row actions', () => {
    expect(buttonOf(one('bypass-permissions-dialog', null), 'I accept the risk')).toContain('bg-destructive-solid text-on-destructive')
    expect(buttonOf(one('project-trust-dialog', null), 'Trust folder')).toContain('data-variant="danger-solid"')
    expect(buttonOf(one('project-trust-dialog', null), 'Keep restricted')).toContain('data-variant="secondary"')
    expect(buttonOf(one('delete-published-page-dialog', null), 'Delete')).toContain('data-variant="danger-solid"')
    expect(one('bypass-permissions-dialog', null)).toContain('<p class="text-label text-secondary">')
    expect(one('project-trust-dialog', null)).toContain('data-testid="project-trust-path" class="rounded-md bg-sunken px-3 py-2 font-mono text-mono-ui break-all"')

    const extend = one('extend-published-page-dialog', null)
    expect(extend).toContain('class="inline-flex flex-wrap justify-self-start rounded-md bg-fill-hover p-0.5" role="radiogroup"')
    const checked = extend.match(/<button type="button" role="radio" aria-checked="true" class="[^"]*"/g) ?? []
    expect(checked).toHaveLength(1)
    expect(checked[0]).toContain('bg-floating text-foreground shadow-elev-1')

    const checklist = one('plugin-install-checklist', 'nessy-default-extension')
    expect(buttonOf(checklist, 'Configure')).toContain('data-variant="secondary"')
    expect(buttonOf(checklist, 'Sign in')).toContain('data-variant="primary"')
    expect(one('plugin-install-checklist', 'dp signed in')).toContain('text-success')

    const run = one('run-confirmation-dialog', null)
    expect(run).toContain('<li class="rounded-md border border-subtle px-2.5 py-1.5">')
    expect(run).toContain('<span class="rounded-xs bg-fill-hover px-1.5 py-0.5 text-caption text-secondary">Claude</span>')

    for (const render of statesOf('runtime-switch-dialog-costs').filter(r => r.markup!.includes('Not available on'))) {
      expect(render.markup!, label(render)).toMatch(/<div class="text-label-sm font-medium text-tertiary">Not available on /)
    }

    const contributions = one('project-contributions-list', null)
    expect(contributions).toContain('<p class="mb-1.5 text-label-sm font-medium text-tertiary">This folder provides</p>')
  })

  it('NEGATIVE — no dialog state keeps a v0.14 class or a deprecated variant, an unchosen segment is not raised, an empty report renders nothing', () => {
    const OLD = [
      'data-variant="outline"', 'data-variant="destructive"', 'data-variant="default"', 'text-muted-foreground', 'text-foreground/',
      'bg-foreground/', 'border-foreground/', 'text-amber-', 'bg-amber-', 'text-green-', 'shadow-minimal', 'uppercase tracking-wide',
      'gap-2 sm:gap-0', 'text-[11px]', 'text-[12.5px]',
    ]
    const dialogs = renders.filter(render => render.id !== 'project-contributions-list')
    for (const render of dialogs) {
      const dialog = dialogContent(render.markup!)
      expect({ state: label(render), hasDialog: dialog.length > 0 }).toEqual({ state: label(render), hasDialog: true })
      expect({ state: label(render), old: OLD.filter(old => dialog.includes(old)) }).toEqual({ state: label(render), old: [] })
    }
    expect(OLD.filter(old => one('project-contributions-list', null).includes(old))).toEqual([])

    const unchosen = one('extend-published-page-dialog', null).match(/<button type="button" role="radio" aria-checked="false" class="[^"]*"/g) ?? []
    expect(unchosen).toHaveLength(4)
    for (const segment of unchosen) expect(segment).not.toContain('bg-floating')

    expect(footerVariants(dialogContent(one('delete-published-page-dialog', null)))).not.toContain('primary')
    expect(one('project-contributions-list', 'Empty report')).toBe('<div class="w-[420px]"></div>')
  })
})
