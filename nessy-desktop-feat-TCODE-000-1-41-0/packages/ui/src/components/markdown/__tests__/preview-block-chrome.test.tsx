/**
 * UB14.10 (R3-03) — the one well every rich preview block now sits in, v0.15.1
 * `packages/ui/src/components/markdown/PreviewBlockChrome.tsx` (ADDED upstream, taken 1:1).
 *
 * Instruments. packages/ui ships no DOM harness, so markup is read from `renderToStaticMarkup` (the
 * instrument of `chat/turn/__tests__/turn-primitives.test.tsx`); lucide draws `lucide-<kebab-name>`
 * into the svg class. The navigator's arrows are driven the way `code-block-run.test.tsx` drives
 * Run: a probe CALLS `PreviewItemNavigator(props)` during its own render, so its hooks are the
 * probe's and the returned element tree is in hand; an arrow element's `onClick` is then invoked.
 *
 * Arms:
 * - positive: with three items at index 0 the navigator draws previous · item menu · next, and
 *   "previous" is DISABLED while "next" is not; next selects 1; at the last index "next" is the
 *   disabled one and previous selects the index before. The menu trigger reads the active item's
 *   label, or `n / total` for an unlabelled one.
 * - negative / boundary (the row's control): a single item renders NO navigator at all (an empty
 *   string, not a disabled pair).
 * - the frame and header pieces the blocks share: the sunken hairline well; a header with no
 *   actions keeps its right padding and draws no action group; an action is named, and its native
 *   tooltip repeats the name UNLESS the caller passes its own `title` — the Publish action in the
 *   doc and html blocks (UA1.23) relies on exactly that override; loading and error lines.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { Maximize2 } from 'lucide-react'
import en from '../../../../../shared/src/i18n/locales/en.json'
import ru from '../../../../../shared/src/i18n/locales/ru.json'
import {
  PreviewBlockAction,
  PreviewBlockError,
  PreviewBlockFrame,
  PreviewBlockHeader,
  PreviewBlockLoading,
  PreviewItemNavigator,
  type PreviewItemNavigatorProps,
} from '../PreviewBlockChrome'

// A private instance through the provider, so labels never depend on which other test file
// initialised the global i18next first (the instrument of code-block-run.test.tsx).
let testI18n: I18nInstance
beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en }, ru: { translation: ru } },
    interpolation: { escapeValue: false },
  })
})

const PREVIOUS = en['overlay.previousItem']
const NEXT = en['overlay.nextItem']

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<I18nextProvider i18n={testI18n}>{node}</I18nextProvider>)
}

/** The `<button …>` opening tag whose aria-label is `name` (static markup). */
function buttonTag(html: string, name: string): string {
  const at = html.indexOf(`aria-label="${name}"`)
  if (at === -1) return ''
  const start = html.lastIndexOf('<button', at)
  return html.slice(start, html.indexOf('>', at) + 1)
}

type ActionElement = React.ReactElement<React.ComponentProps<typeof PreviewBlockAction>>

function actions(node: React.ReactNode, out: ActionElement[] = []): ActionElement[] {
  if (Array.isArray(node)) {
    for (const child of node) actions(child, out)
    return out
  }
  if (!React.isValidElement(node)) return out
  if (node.type === PreviewBlockAction) out.push(node as ActionElement)
  actions((node.props as { children?: React.ReactNode }).children, out)
  return out
}

/** The navigator's element tree, its hooks hosted by a probe (see the docblock). */
function navigatorTree(props: PreviewItemNavigatorProps): React.ReactNode {
  let tree: React.ReactNode = null
  function Probe(): React.ReactElement {
    tree = PreviewItemNavigator(props)
    return <>{tree}</>
  }
  render(<Probe />)
  return tree
}

const THREE = [{ label: 'v1' }, { label: 'v2' }, {}]

describe('PreviewItemNavigator (UB14.10)', () => {
  it('positive: at index 0 "previous" is disabled, "next" is not, and next selects 1', () => {
    const html = render(<PreviewItemNavigator items={THREE} activeIndex={0} onSelect={() => {}} />)
    expect(buttonTag(html, PREVIOUS)).toContain('disabled=""')
    expect(buttonTag(html, NEXT)).not.toBe('')
    expect(buttonTag(html, NEXT)).not.toContain('disabled=""')
    expect(html).toContain('lucide-chevron-left')
    expect(html).toContain('lucide-chevron-right')
    // the menu trigger names the active item
    expect(html).toContain('>v1</span>')

    const selected: number[] = []
    const tree = navigatorTree({ items: THREE, activeIndex: 0, onSelect: index => selected.push(index) })
    actions(tree).find(a => a.props['aria-label'] === NEXT)?.props.onClick?.({} as React.MouseEvent<HTMLButtonElement>)
    expect(selected).toEqual([1])
  })

  it('boundary: at the last index "next" is disabled, previous selects the one before, an unlabelled item reads n / total', () => {
    const html = render(<PreviewItemNavigator items={THREE} activeIndex={2} onSelect={() => {}} />)
    expect(buttonTag(html, NEXT)).toContain('disabled=""')
    expect(buttonTag(html, PREVIOUS)).not.toContain('disabled=""')
    expect(html).toContain('>3 / 3</span>')

    const selected: number[] = []
    const tree = navigatorTree({ items: THREE, activeIndex: 2, onSelect: index => selected.push(index) })
    actions(tree).find(a => a.props['aria-label'] === PREVIOUS)?.props.onClick?.({} as React.MouseEvent<HTMLButtonElement>)
    expect(selected).toEqual([1])
  })

  it('negative (control): a single item renders no navigator at all', () => {
    expect(render(<PreviewItemNavigator items={[{ label: 'only' }]} activeIndex={0} onSelect={() => {}} />)).toBe('')
    expect(navigatorTree({ items: [{ label: 'only' }], activeIndex: 0, onSelect: () => {} })).toBeNull()
    // the same instrument sees the pair as soon as there are two
    expect(buttonTag(render(<PreviewItemNavigator items={[{}, {}]} activeIndex={0} onSelect={() => {}} />), PREVIOUS)).not.toBe('')
  })
})

describe('PreviewBlockFrame / Header / Action / states (UB14.10)', () => {
  it('the well is the sunken hairline frame, and the caller keeps its own classes', () => {
    const html = render(<PreviewBlockFrame className="my-2" />)
    for (const token of ['rounded-md', 'border-subtle', 'bg-sunken', 'isolate', 'my-2']) expect(html).toContain(token)
  })

  it('a header with actions draws the action group; without actions it keeps pr-3 and draws none', () => {
    const withAction = render(
      <PreviewBlockHeader icon={<Maximize2 />} title="Q3 report">
        <PreviewBlockAction aria-label="View fullscreen" icon={<Maximize2 />} />
      </PreviewBlockHeader>
    )
    expect(withAction).toContain('title="Q3 report"')
    expect(withAction).toContain('pr-1')
    expect(withAction).toContain('aria-label="View fullscreen"')

    const bare = render(<PreviewBlockHeader title="Q3 report" />)
    expect(bare).toContain('pr-3')
    expect(bare).not.toContain('<button')
  })

  it('an action is named, its tooltip repeats the name, and a caller title overrides it (the Publish action relies on this)', () => {
    const named = render(<PreviewBlockAction aria-label="View fullscreen" icon={<Maximize2 />} />)
    expect(named).toContain('aria-label="View fullscreen"')
    expect(named).toContain('title="View fullscreen"')
    expect(named).toContain('data-slot="icon-button"')
    expect(named).toContain('type="button"')

    const titled = render(<PreviewBlockAction aria-label="Publish" title="Publish this file" icon={<Maximize2 />} data-preview-publish />)
    expect(titled).toContain('title="Publish this file"')
    expect(titled).not.toContain('title="Publish"')
    expect(titled).toContain('data-preview-publish="true"')
  })

  it('loading and error lines: the label carries the state; the error is icon + destructive text', () => {
    const loading = render(<PreviewBlockLoading>Loading data...</PreviewBlockLoading>)
    expect(loading).toContain('Loading data...')
    expect(loading).toContain('text-tertiary')
    const error = render(<PreviewBlockError>File not found</PreviewBlockError>)
    expect(error).toContain('File not found')
    expect(error).toContain('text-destructive')
    expect(error).toContain('lucide-circle-alert')
  })
})
