/**
 * UB14.30 — `ComposerModelMenu` (D1.214's desktop picker menu under upstream's name): v0.15.1's chip trigger and
 * menu rows over OUR content — the integration row that switches runtimes, the effort levels the session's runtime
 * honours and the effort pill on the trigger — and the compact picker on the same capability answer.
 *
 * Instruments, both without a DOM (this repo ships none), as `composer-mode-chip.test.tsx` (UB14.29) records:
 * - `renderToStaticMarkup` for what the closed trigger draws (Radix renders the trigger server-side; the menu body
 *   sits in a portal, which SSR never mounts);
 * - the ELEMENT TREE the component returns, captured by calling it inside a probe component's render (its hooks run
 *   as the probe's), so the menu's integration row, its effort sub-menu and the drawer's level rows are real values
 *   we can read — and the integration row element is then rendered on its own, expanded, for its rows.
 *
 * Strings come from the shipped `en.json`; capability answers from the server's own `PROVIDER_DEFAULTS`.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import type { ComposerCapabilities } from '@nessy-agent/shared/protocol'
import { PERMISSION_MODE_ORDER } from '@nessy-agent/shared/agent/modes'
import { PROVIDER_DEFAULTS } from '@nessy-agent/shared/agent/backend/composer-capabilities'
import { LOCALE_REGISTRY } from '@nessy-agent/shared/i18n'
import type { LlmConnectionWithStatus } from '@config/llm-connections'
import type { ModelDefinition, ModelProvider } from '@config/models'
import { TooltipProvider } from '@nessy-agent/ui/ui/tooltip'
import { ModalProvider } from '@/context/ModalContext'
import { DropdownMenuSub } from '@/components/ui/dropdown-menu'
import { StyledDropdownMenuItem } from '@/components/ui/styled-dropdown'
import { DrawerClose } from '@/components/ui/drawer'
import { ComposerModelMenu, type ComposerModelMenuProps } from '../ComposerModelMenu'
import { CompactModelSelector } from '../CompactModelSelector'
import { ConnectionRow } from '../ConnectionRow'
import { ComposerCapabilitiesProvider } from '../composer-capabilities-context'

const EN = LOCALE_REGISTRY.en.messages as Record<string, string>

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    keySeparator: false,
    resources: { en: { translation: EN } },
    interpolation: { escapeValue: false },
  })
})

/** The app's own providers for these components: i18n, the modal registry (the confirm dialog), tooltips (the chip). */
const wrap = (node: React.ReactNode) => (
  <I18nextProvider i18n={testI18n}>
    <ModalProvider>
      <TooltipProvider>{node}</TooltipProvider>
    </ModalProvider>
  </I18nextProvider>
)
const render = (node: React.ReactNode) => renderToStaticMarkup(wrap(node))

function model(id: string, name: string): ModelDefinition {
  return { id, name, shortName: name, description: '', provider: 'pi' as ModelProvider, contextWindow: 200_000 }
}

const PI_GATEWAY: LlmConnectionWithStatus = {
  slug: 'nessy-gateway',
  name: 'Nessy Gateway',
  providerType: 'pi',
  authType: 'bearer_token',
  models: [model('tgpt/qwen36-35b-a3b-fp8', 'Qwen 3.6 35B'), model('tgpt/gpt-oss-120b', 'GPT-OSS 120B')],
  isAuthenticated: true,
  createdAt: 0,
}
const CODEX: LlmConnectionWithStatus = {
  slug: 'codex-byo',
  name: 'Codex (BYO)',
  providerType: 'codex-runtime',
  authType: 'api_key',
  models: [model('gpt-5-codex', 'GPT-5 Codex')],
  isAuthenticated: true,
  createdAt: 0,
}

const CODEX_LEVELS = PROVIDER_DEFAULTS['codex-runtime'].reasoningLevels
const NO_LEVELS = PROVIDER_DEFAULTS['nestor-cloud-agent'].reasoningLevels

/** An empty session on the Pi gateway, with a codex connection configured beside it. */
const base = (overrides: Partial<ComposerModelMenuProps> = {}): ComposerModelMenuProps => ({
  open: false,
  onOpenChange: () => {},
  llmConnections: [PI_GATEWAY, CODEX],
  effectiveConnectionDetails: PI_GATEWAY,
  effectiveConnection: PI_GATEWAY.slug,
  switchable: true,
  reasoningLevels: CODEX_LEVELS,
  isEmptySession: true,
  isProcessing: false,
  connectionUnavailable: false,
  pickerMode: 'flat',
  connectionDefaultModel: null,
  availableModels: PI_GATEWAY.models!,
  currentModel: 'tgpt/qwen36-35b-a3b-fp8',
  currentModelDisplayName: 'Qwen 3.6 35B',
  thinkingLevel: 'high',
  thinkingDisabled: false,
  onModelChange: () => {},
  onConnectionChange: () => {},
  onToggleVision: () => {},
  ...overrides,
})

type El = React.ReactElement<Record<string, unknown>>

/** The element tree a function component returns for these props (its hooks run inside the probe's render). */
function treeOf<P>(component: (props: P) => React.ReactNode, props: P, around?: (node: React.ReactNode) => React.ReactNode): El {
  let tree: React.ReactNode = null
  function Probe() {
    tree = component(props)
    return null
  }
  renderToStaticMarkup(wrap(around ? around(<Probe />) : <Probe />))
  expect(React.isValidElement(tree)).toBe(true)
  return tree as unknown as El
}

function findAll(node: React.ReactNode, match: (el: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, match, out)
    return out
  }
  if (!React.isValidElement<Record<string, unknown>>(node)) return out
  if (match(node)) out.push(node)
  findAll(node.props.children as React.ReactNode, match, out)
  return out
}

/** The trigger's opening tag: the one button carrying the menu's `aria-haspopup`. */
function triggerTag(markup: string): string {
  const tags = markup.match(/<button[^>]*aria-haspopup="menu"[^>]*>/g) ?? []
  expect(tags).toHaveLength(1)
  return tags[0]!
}

const pillOf = (markup: string) => markup.match(/<span data-effort-pill[^>]*>([^<]*)<\/span>/)

describe('UB14.30 · the trigger is v0.15.1\'s composer chip, with our effort pill', () => {
  it('POSITIVE — the chip names the model and its effort pill names the level (High), on the 28px round chip', () => {
    const markup = render(<ComposerModelMenu {...base()} />)
    const tag = triggerTag(markup)
    expect({ chip: tag.includes('h-control') && tag.includes('rounded-full'), shrinks: tag.includes('shrink gap-1 pl-2.5 pr-2') })
      .toEqual({ chip: true, shrinks: true })
    // The old footer label (hidden under a 475px footer) and the flat 6px trigger are gone. The class is built from
    // parts so this file is no hit for UB14.32's Done-means grep over `components`.
    expect({ old: markup.includes(['composer', 'footer', 'label'].join('-')) || tag.includes('rounded-[6px]') }).toEqual({ old: false })
    expect(markup).toContain('Qwen 3.6 35B')
    const pill = pillOf(markup)
    expect(pill?.[1]).toBe(EN['thinking.high'])
    expect(pill?.[0]).toContain('bg-fill-hover')
    // Two connections: the active one's icon rides the chip, as upstream draws it.
    expect(markup).toContain('<svg')
  })

  it('NEGATIVE (control) — a runtime offering no effort levels draws no pill; `off` draws none either', () => {
    expect(pillOf(render(<ComposerModelMenu {...base({ reasoningLevels: NO_LEVELS })} />))).toBeNull()
    expect(pillOf(render(<ComposerModelMenu {...base({ thinkingLevel: 'off' })} />))).toBeNull()
  })

  it('boundary — an unavailable connection draws the destructive chip and no pill', () => {
    const markup = render(<ComposerModelMenu {...base({ connectionUnavailable: true })} />)
    expect(triggerTag(markup)).toContain('text-destructive')
    expect(markup).toContain(EN['common.unavailable'])
    expect(pillOf(markup)).toBeNull()
  })
})

describe('UB14.30 · the menu keeps our integration row and the runtime\'s own effort levels', () => {
  it('POSITIVE — an empty session with two connections: the integration row reaches both runtimes, each badged', () => {
    const tree = treeOf(ComposerModelMenu, base({ open: true }))
    const rows = findAll(tree, el => el.type === ConnectionRow)
    expect(rows).toHaveLength(1)
    expect({ switchable: rows[0]!.props.switchable, hasHistory: rows[0]!.props.hasHistory, n: (rows[0]!.props.connections as unknown[]).length })
      .toEqual({ switchable: true, hasHistory: false, n: 2 })
    // The row itself, opened: one target per connection, each naming its runtime.
    const markup = render(React.cloneElement(rows[0]!, { defaultExpanded: true }))
    expect(markup.match(/data-runtime-badge="[^"]+"/g)).toEqual([
      'data-runtime-badge="pi"', // the active connection's head
      'data-runtime-badge="pi"',
      'data-runtime-badge="codex-runtime"',
    ])
    expect(markup).toContain(PI_GATEWAY.name)
    expect(markup).toContain(CODEX.name)
    // The head can open (switchable, two targets): no `disabled` on the aria-expanded toggle.
    const head = markup.match(/<button[^>]*aria-expanded="true"[^>]*>/g) ?? []
    expect(head).toHaveLength(1)
    expect(head[0]).not.toContain('disabled')
    // On v0.15.1's row vocabulary: the selected target is `bg-fill-selected`, the badge the quiet caption chip.
    expect(markup).toContain('bg-fill-selected')
    expect(markup).toContain('rounded-xs bg-fill-hover px-1.5 py-0.5 text-caption text-secondary')
  })

  it('POSITIVE — the effort sub-menu lists exactly the runtime\'s levels (codex: four), the current one checked', () => {
    const tree = treeOf(ComposerModelMenu, base({ open: true }))
    const subs = findAll(tree, el => el.type === DropdownMenuSub)
    expect(subs).toHaveLength(1)
    const items = findAll(subs[0]!, el => el.type === StyledDropdownMenuItem)
    expect(items.map(item => item.key)).toEqual(['off', 'low', 'medium', 'high'])
  })

  it('NEGATIVE (control) — reasoning.levels = [] draws no effort sub-menu (and the models are still listed)', () => {
    const tree = treeOf(ComposerModelMenu, base({ open: true, reasoningLevels: NO_LEVELS }))
    expect(findAll(tree, el => el.type === DropdownMenuSub)).toEqual([])
    const models = findAll(tree, el => el.type === StyledDropdownMenuItem)
    expect(models.map(item => item.key)).toEqual(['tgpt/qwen36-35b-a3b-fp8', 'tgpt/gpt-oss-120b'])
  })

  it('boundary — the integration row needs a ModalProvider (its confirm dialog registers one), as in the app and the playground frame (F1.281)', () => {
    const row = <ConnectionRow connections={[PI_GATEWAY, CODEX]} activeConnection={PI_GATEWAY} switchable hasHistory={false} onSwitch={() => {}} />
    expect(() => renderToStaticMarkup(<I18nextProvider i18n={testI18n}>{row}</I18nextProvider>))
      .toThrow('useModalRegistry must be used within a ModalProvider')
    expect(render(row)).toContain(EN['chat.runtimeSwitch.integration'])
  })
})

function caps(levels: ComposerCapabilities['reasoning']['levels'], ultracode?: ComposerCapabilities['ultracode']): ComposerCapabilities {
  return {
    attachments: { files: true, images: 'no', folders: true },
    mentions: { files: true, skills: true, sources: true },
    slash: { commandIds: 'all' },
    submit: { queue: false, steer: true },
    reasoning: { levels },
    permissions: { modes: PERMISSION_MODE_ORDER },
    connection: { switchable: true, activeRuntime: 'pi' },
    contextMeter: true,
    externalFooter: { gitBranch: true },
    ...(ultracode ? { ultracode } : {}),
  }
}

describe('UB14.30 · the compact picker asks the same capability answer, on v0.15.1\'s sheet look', () => {
  const compact = (value: ComposerCapabilities) =>
    treeOf(CompactModelSelector, { currentModel: 'claude-sonnet-4-5', onModelChange: () => {}, thinkingLevel: 'high', open: true },
      node => <ComposerCapabilitiesProvider value={value}>{node}</ComposerCapabilitiesProvider>)
  const levelRows = (tree: El) =>
    findAll(tree, el => el.type === DrawerClose).map(el => String(el.key)).filter(key => ['off', 'low', 'medium', 'high', 'xhigh', 'max'].includes(key))

  it('POSITIVE — codex: the sheet lists the four levels the runtime honours', () => {
    expect(levelRows(compact(caps(CODEX_LEVELS)))).toEqual(['off', 'low', 'medium', 'high'])
  })

  it('NEGATIVE (control) — no levels: no level rows, but the ultracode row still draws on its own answer', () => {
    const tree = compact(caps(NO_LEVELS, { mechanism: 'unsupported', modelCapable: true }))
    expect(levelRows(tree)).toEqual([])
    expect(findAll(tree, el => el.props['data-testid'] === 'ultracode-toggle')).toHaveLength(1)
    // …and with neither, the section is not drawn at all.
    const bare = compact(caps(NO_LEVELS))
    expect(findAll(bare, el => el.props['data-testid'] === 'ultracode-toggle')).toEqual([])
    expect(JSON.stringify(findAll(bare, el => el.props.children === EN['chat.modelPicker.thinkingSection'] || el.props.children === 'chat.modelPicker.thinkingSection'))).toBe('[]')
  })

  it('the trigger is the composer chip with the Cpu fold under a 26rem panel (name and chevron hide)', () => {
    const markup = render(
      <ComposerCapabilitiesProvider value={caps(CODEX_LEVELS)}>
        <CompactModelSelector currentModel="claude-sonnet-4-5" onModelChange={() => {}} />
      </ComposerCapabilitiesProvider>,
    )
    const tag = (markup.match(/<button[^>]*aria-haspopup="dialog"[^>]*>/g) ?? [])[0] ?? ''
    expect({ chip: tag.includes('h-control') && tag.includes('rounded-full'), fold: tag.includes('@max-[26rem]/panel:px-2'), old: tag.includes('shadow-tinted') })
      .toEqual({ chip: true, fold: true, old: false })
    expect(markup).toContain('@min-[26rem]/panel:hidden')
    expect(markup).toContain('truncate min-w-0 @max-[26rem]/panel:hidden')
  })
})
