/**
 * UB12.86 — the thirteen English default-parameter labels the UB12.57 census held as OWED now go through t().
 *
 * Each component leaves the prop unset and renders `prop ?? t(key)`, so a caller that passes no label gets the
 * locale's value and a caller that passes one still wins. Rendered with `renderToStaticMarkup` under a ru instance
 * seeded with the real `ru.json` (no DOM in this repo's `bun test`) wherever the label reaches static markup; the
 * three data tables' fullscreen titles and the colour picker's reset link render only inside a closed overlay or
 * popover, so those are pinned from source (the key read, the literal gone), as UB12.57's own pins are. The
 * skill-preview kind label is rendered in `marketplace/__tests__/MarketplaceComponents.test.tsx`, whose pdfjs stub
 * its import chain needs. The census itself (`renderer-hardcoded-strings.test.ts`) answers an empty allow-list.
 *
 * SessionSearchHeader and the workspace primitives take `Spinner` from the `@nessy-agent/ui` barrel, whose chain
 * reaches `pdfjs-dist/build/pdf.worker.min.mjs?url` (measured 2026-10-17: importing either alone throws "Missing
 * 'default' export"). So the pdfjs recipe `MarketplaceComponents.test.tsx` documents: stub the two packages, then
 * load every component with `await import(...)` AFTER the stubs (a static import would link first).
 */
import * as React from 'react'
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    is2D = true
  }
}

const { SessionSearchHeader } = await import('../app-shell/SessionSearchHeader')
const { SettingsSecretInput } = await import('../settings/SettingsInput')
const { SettingsMenuSelect, SettingsMenuSelectRow } = await import('../settings/SettingsMenuSelect')
const { SettingsSelect, SettingsSelectRow } = await import('../settings/SettingsSelect')
const { ColorPicker } = await import('../ui/color-picker')
const { AddWorkspacePrimaryButton } = await import('../workspace/primitives')

const COMPONENTS_DIR = join(import.meta.dir, '..')
const LOCALES_DIR = join(COMPONENTS_DIR, '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')
const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8')) as Record<string, string>
const ru = JSON.parse(readFileSync(join(LOCALES_DIR, 'ru.json'), 'utf8')) as Record<string, string>
const read = (rel: string) => readFileSync(join(COMPONENTS_DIR, rel), 'utf8')

let ruI18n: I18nInstance
beforeAll(async () => {
  ruI18n = createInstance()
  await ruI18n.use(initReactI18next).init({
    lng: 'ru',
    fallbackLng: 'en',
    resources: { ru: { translation: ru }, en: { translation: en } },
    interpolation: { escapeValue: false },
  })
})

const underRu = (node: React.ReactNode) => renderToStaticMarkup(<I18nextProvider i18n={ruI18n}>{node}</I18nextProvider>)
const noop = () => {}
const OPTIONS = [{ value: 'a', label: 'Alpha' }]

/** One row per rendered default: the label-less render, the same render with the prop, its key and its old literal. */
const RENDERED: ReadonlyArray<{
  name: string
  bare: () => React.ReactNode
  given: (label: string) => React.ReactNode
  key: string
  literal: string
}> = [
  {
    name: 'SessionSearchHeader placeholder',
    bare: () => <SessionSearchHeader searchQuery="" />,
    given: (label) => <SessionSearchHeader searchQuery="" placeholder={label} />,
    key: 'session.searchPlaceholder',
    literal: 'Search titles and content...',
  },
  {
    name: 'SettingsSecretInput placeholder',
    bare: () => <SettingsSecretInput value="" onChange={noop} />,
    given: (label) => <SettingsSecretInput value="" onChange={noop} placeholder={label} />,
    key: 'labels.value.enterValue',
    literal: 'Enter value...',
  },
  {
    name: 'SettingsMenuSelect placeholder',
    bare: () => <SettingsMenuSelect value="" onValueChange={noop} options={OPTIONS} />,
    given: (label) => <SettingsMenuSelect value="" onValueChange={noop} options={OPTIONS} placeholder={label} />,
    key: 'common.selectPlaceholder',
    literal: 'Select...',
  },
  {
    name: 'SettingsMenuSelectRow placeholder (passed through unset)',
    bare: () => <SettingsMenuSelectRow label="Mode" value="" onValueChange={noop} options={OPTIONS} />,
    given: (label) => <SettingsMenuSelectRow label="Mode" value="" onValueChange={noop} options={OPTIONS} placeholder={label} />,
    key: 'common.selectPlaceholder',
    literal: 'Select...',
  },
  {
    name: 'SettingsSelect placeholder',
    bare: () => <SettingsSelect value="" onValueChange={noop} options={OPTIONS} />,
    given: (label) => <SettingsSelect value="" onValueChange={noop} options={OPTIONS} placeholder={label} />,
    key: 'common.selectPlaceholder',
    literal: 'Select...',
  },
  {
    name: 'SettingsSelectRow placeholder',
    bare: () => <SettingsSelectRow label="Mode" value="" onValueChange={noop} options={OPTIONS} />,
    given: (label) => <SettingsSelectRow label="Mode" value="" onValueChange={noop} options={OPTIONS} placeholder={label} />,
    key: 'common.selectPlaceholder',
    literal: 'Select...',
  },
  {
    name: 'ColorPicker trigger aria-label',
    bare: () => <ColorPicker value="" onChange={noop} />,
    given: (label) => <ColorPicker value="" onChange={noop} ariaLabel={label} />,
    key: 'common.pickColor',
    literal: 'Pick color',
  },
  {
    name: 'AddWorkspacePrimaryButton label',
    bare: () => <AddWorkspacePrimaryButton />,
    given: (label) => <AddWorkspacePrimaryButton>{label}</AddWorkspacePrimaryButton>,
    key: 'common.continue',
    literal: 'Continue',
  },
]

describe('UB12.86 — a label-less component renders the locale value, not the English default', () => {
  it('every key it reads exists in both locales with a Russian value distinct from the English one', () => {
    const keys = [
      ...RENDERED.map(row => row.key),
      'settings.labels.autoApplyRules',
      'settings.labels.title',
      'settings.permissions.title',
      'plugins.kind.skill',
      'common.resetToDefault',
    ]
    for (const key of keys) {
      expect({ key, en: typeof en[key], ru: typeof ru[key] }).toEqual({ key, en: 'string', ru: 'string' })
      expect({ key, same: en[key] === ru[key] }).toEqual({ key, same: false })
    }
  })

  it('positive — under ru each label-less render carries the ru value and not the English literal', () => {
    for (const row of RENDERED) {
      const html = underRu(row.bare())
      expect({ name: row.name, ru: html.includes(ru[row.key]!) }).toEqual({ name: row.name, ru: true })
      expect({ name: row.name, english: html.includes(row.literal) }).toEqual({ name: row.name, english: false })
    }
  })

  it('negative — an explicit prop still wins over the locale default', () => {
    for (const row of RENDERED) {
      const html = underRu(row.given('Caller label'))
      expect({ name: row.name, given: html.includes('Caller label') }).toEqual({ name: row.name, given: true })
      expect({ name: row.name, ru: html.includes(ru[row.key]!) }).toEqual({ name: row.name, ru: false })
    }
  })
})

/** Defaults that render only inside a closed overlay or popover: the read is pinned from source. */
const SOURCE_PINNED: ReadonlyArray<readonly [file: string, read: string, gone: RegExp]> = [
  ['info/AutoRulesDataTable.tsx', "title={fullscreenTitle ?? t('settings.labels.autoApplyRules')}", /fullscreenTitle = ['"]/],
  ['info/LabelsDataTable.tsx', "title={fullscreenTitle ?? t('settings.labels.title')}", /fullscreenTitle = ['"]/],
  ['info/PermissionsDataTable.tsx', "title={fullscreenTitle ?? t('settings.permissions.title')}", /fullscreenTitle = ['"]/],
  ['ui/color-picker.tsx', "{clearLabel ?? t('common.resetToDefault')}", /clearLabel = ['"]/],
]

describe('UB12.86 — the overlay titles and the reset link read their key when no prop is passed (source)', () => {
  it('positive — each file renders `prop ?? t(key)` from a useTranslation() hook', () => {
    for (const [file, wired] of SOURCE_PINNED) {
      const source = read(file)
      expect({ file, usesHook: /\buseTranslation\(\)/.test(source), wired: source.includes(wired) })
        .toEqual({ file, usesHook: true, wired: true })
    }
  })

  it('negative — no literal default for the prop remains', () => {
    for (const [file, , gone] of SOURCE_PINNED) expect({ file, found: gone.test(read(file)) }).toEqual({ file, found: false })
  })
})
