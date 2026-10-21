/**
 * UB14.39 — the CHILD PROCESS behind `../ours-dialogs-registry.test.ts`: render every state of our own dialogs inside
 * `PlaygroundEntryFrame` (the frame the playground page draws every entry in) and print the markup as JSON on stdout.
 * The states are `registry/ours-dialogs.tsx`'s entries plus the existing entries that already mounted one of these
 * dialogs: `runtime-switch-dialog-costs`, `plugin-configuration-prompt`, `plugin-install-checklist`, and Marketplace
 * Browse's "Add marketplace dialog" variant (only that variant: the rest of that entry is the page, not the dialog).
 *
 * Why a child, and why these stubs: `render-every-entry.ts`'s docblock (a Radix portal draws its content in place, so
 * an open dialog is on the page; the process-global stubs must die with the process). Its `ThemeContext` stub resolves
 * DARK, so this is the dark sweep. The same shape as UB14.36's `dialog-entries-probe.ts`.
 *
 * Everything with a side effect sits behind `import.meta.main` (AGENTS.md §Traps).
 */
import { installStubs, patchReactForAPageRender } from './render-every-entry'

export const OURS_DIALOG_ENTRIES_MARKER = '@@OURS-DIALOG-ENTRIES@@'

export interface OursDialogEntryRender {
  id: string
  /** `null` for the entry's own defaults; the variant's name otherwise. */
  variant: string | null
  markup?: string
  /** First line of the thrown error, when the render threw. */
  error?: string
}

/** Existing entries that mount one of our dialogs: `true` = every state, a list = only those variants. */
const BORROWED: Record<string, true | readonly string[]> = {
  'runtime-switch-dialog-costs': true,
  'plugin-configuration-prompt': true,
  'plugin-install-checklist': true,
  'marketplace-browse': ['Add marketplace dialog'],
}

export async function renderOursDialogEntries(): Promise<OursDialogEntryRender[]> {
  const react = patchReactForAPageRender()
  installStubs(react)
  const h = react.createElement
  // `mock-utils` first, as `render-every-entry.ts` and `playground.tsx` import it, so a module that reads
  // `window.electronAPI` at load finds the fixture.
  await import('../../mock-utils')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { setupI18n } = await import('@nessy-agent/shared/i18n')
  const { initReactI18next } = await import('react-i18next')
  const { PlaygroundEntryFrame, playgroundEntryProps } = await import('../../ComponentPreview')
  const { oursDialogComponents } = await import('../../registry/ours-dialogs')
  const { runtimeSwitchCostsComponents } = await import('../../registry/runtime-switch-costs')
  const { pluginConfigurationComponents } = await import('../../registry/plugin-configuration')
  const { pluginInstallChecklistComponents } = await import('../../registry/plugin-install-checklist')
  const { marketplaceComponents } = await import('../../registry/marketplace')

  // The page's own i18n, pinned to English (F1.103's rule).
  const i18n = setupI18n([initReactI18next])
  await i18n.changeLanguage('en')

  const borrowed = [...runtimeSwitchCostsComponents, ...pluginConfigurationComponents, ...pluginInstallChecklistComponents, ...marketplaceComponents]
    .filter(entry => entry.id in BORROWED)
  const renders: OursDialogEntryRender[] = []
  for (const entry of [...oursDialogComponents, ...borrowed]) {
    const only = BORROWED[entry.id]
    const variants = (entry.variants ?? []).map(v => ({ variant: v.name as string | null, props: v.props }))
    const cases = Array.isArray(only)
      ? variants.filter(v => only.includes(v.variant!))
      : [{ variant: null as string | null, props: {} as Record<string, unknown> }, ...variants]
    for (const { variant, props } of cases) {
      try {
        const markup = renderToStaticMarkup(h(PlaygroundEntryFrame, { component: entry, props: playgroundEntryProps(entry, props) }))
        renders.push({ id: entry.id, variant, markup })
      } catch (error) {
        renders.push({ id: entry.id, variant, error: (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).split('\n')[0] })
      }
    }
  }
  return renders
}

if (import.meta.main) {
  const renders = await renderOursDialogEntries()
  // Exit once stdout has drained: the rendered graph leaves timers behind (render-every-entry.ts, measured).
  process.stdout.write(`\n${OURS_DIALOG_ENTRIES_MARKER}${JSON.stringify(renders)}\n`, () => process.exit(0))
}
