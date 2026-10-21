/**
 * P3.351 / P4.10 — the unenforceable-`blockedTools` playground draft.
 *
 * ## What this file imports, and the measurement that decided it
 *
 * It does NOT import `../registry/settings-blocked-tools`. Measured 2026-09-04:
 * that import fails under bun with `Missing 'default' export in module
 * 'pdfjs-dist/build/pdf.worker.min.mjs?url'` after 73.3 s — the entry mounts the
 * real `PermissionsDataTable`, whose graph reaches `pdfjs-dist`, and a first
 * attempt at this file died exactly that way (a `beforeAll` timeout at 71.8 s
 * with zero assertion failures, which is the signature). P3.316's ruling is
 * that the answer is CONTAINMENT, not a sixth bare `mock.module` site with no
 * spread and no restore — a spread being impossible here, since spreading means
 * importing the module that cannot load. The sibling
 * `runtime-switch-costs-registry.test.ts` records the same division of labour.
 *
 * So: the VALUES live in `registry/settings-blocked-tools-data.ts`, a module
 * with no runtime imports, and are loaded normally; the entry's own wiring is
 * asserted against SOURCE TEXT, with `tsc` already proving the export is a
 * well-formed `ComponentEntry[]` (`apps/electron`'s typecheck reaches it).
 *
 * ## The pin
 *
 * Every sample declaration's stated branch is RE-DERIVED through the real
 * predicate over the real `ALWAYS_ALLOWED_TOOLS` from `mode-manager.ts`. The
 * draft cannot import that constant — it drags 193 node-builtin edges over 274
 * files into a renderer bundle — but this test can, and that is what stops the
 * sample and the gate from drifting apart.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  BLOCKED_TOOL_TREATMENTS,
  PREEMPTION_KEYS,
  SAMPLE_BLOCKED_TOOLS,
} from '../registry/settings-blocked-tools-data'
import {
  classifyBlockedToolDeclaration,
  partitionBlockedToolDeclarations,
} from '@nessy-agent/shared/agent/blocked-tools-enforcement'
import { ALWAYS_ALLOWED_TOOLS } from '@nessy-agent/shared/agent/mode-manager'
import en from '@nessy-agent/shared/i18n/locales/en.json'

function playgroundSource(...segments: string[]): string {
  return readFileSync(join(import.meta.dir, '..', ...segments), 'utf-8')
}

function indexSource(): string {
  return playgroundSource('registry', 'index.ts')
}

function entrySource(): string {
  return playgroundSource('registry', 'settings-blocked-tools.tsx')
}

describe('unenforceable blockedTools playground draft — wiring', () => {
  it('reads every file it asserts about', () => {
    // Positive control: a `readFileSync` that silently returned '' would make
    // every `toContain` below fail loudly, but every `not.toContain` VACUOUS.
    for (const [name, source] of [
      ['index.ts', indexSource()],
      ['settings-blocked-tools.tsx', entrySource()],
    ] as const) {
      expect(source.length, name).toBeGreaterThan(500)
    }
  })

  it('is wired into registry/index under a category the sidebar orders', () => {
    const src = indexSource()
    expect(src).toContain("import { settingsBlockedToolsComponents } from './settings-blocked-tools'")
    expect(src).toContain('...settingsBlockedToolsComponents,')
    const orderLine = src.split('\n').find(line => line.includes('const categoryOrder'))
    expect(orderLine).toBeDefined()
    expect(orderLine).toContain("'Settings'")
  })

  it('registers one entry, under Settings, with a stable id', () => {
    const src = entrySource()
    expect(src).toContain("id: 'settings-blocked-tools-unenforceable'")
    expect(src).toContain("category: 'Settings'")
    expect(src.split("id: 'settings-blocked-tools-unenforceable'").length - 1).toBe(1)
  })

  it('does not import the pdfjs-poisoned barrel by accident', () => {
    // The entry legitimately reaches pdfjs through PermissionsDataTable; what
    // must not happen is the DATA module growing a runtime import, which is
    // what makes this file loadable at all.
    const data = playgroundSource('registry', 'settings-blocked-tools-data.ts')
    expect(data).toContain('import type {')
    expect(data).not.toMatch(/^import (?!type )/m)
  })

  it('drives every treatment from the shared list, so a knob cannot lose a state', () => {
    const src = entrySource()
    expect(src).toContain('BLOCKED_TOOL_TREATMENTS.map')
    // `none` first: it is the shipped behaviour and the control the four
    // candidates are read against.
    expect(BLOCKED_TOOL_TREATMENTS[0]).toBe('none')
    expect([...BLOCKED_TOOL_TREATMENTS]).toEqual(['none', 'warn', 'grey', 'annotate', 'filter'])
  })
})

describe('the sample declarations agree with the real gate predicate', () => {
  it('every stated branch is what the predicate returns over the real ALWAYS_ALLOWED_TOOLS', () => {
    expect(SAMPLE_BLOCKED_TOOLS.length).toBeGreaterThan(0)
    for (const sample of SAMPLE_BLOCKED_TOOLS) {
      expect(`${sample.tool}: ${JSON.stringify(sample.preemption)}`)
        .toBe(`${sample.tool}: ${JSON.stringify(classifyBlockedToolDeclaration(sample.tool, ALWAYS_ALLOWED_TOOLS))}`)
    }
  })

  it('covers every branch AND carries entries the runtime really does block', () => {
    const { enforced, unenforceable } = partitionBlockedToolDeclarations(
      SAMPLE_BLOCKED_TOOLS.map(s => s.tool),
      ALWAYS_ALLOWED_TOOLS,
    )
    expect(new Set(unenforceable.map(u => u.preemption.kind))).toEqual(
      new Set(['always-allowed', 'always-allowed-suffix', 'browser-tool', 'bash-classifier']),
    )
    // Without a genuinely-blocked row the draft would look like a page where
    // everything is a lie, which is not the surface the owner has to judge.
    expect(enforced.length).toBeGreaterThan(0)
  })

  it('keeps the wider-than-documented suffix case, which is the easiest one to lose', () => {
    expect(SAMPLE_BLOCKED_TOOLS.some(s => s.tool === 'anything__Read')).toBe(true)
    expect(classifyBlockedToolDeclaration('anything__Read', ALWAYS_ALLOWED_TOOLS))
      .toEqual({ kind: 'always-allowed-suffix', matched: 'Read' })
  })
})

describe('the draft renders real locale keys', () => {
  const locale = en as unknown as Record<string, string>

  it('every per-branch sentence key exists in en.json', () => {
    const keys = Object.values(PREEMPTION_KEYS)
    expect(keys.length).toBe(4)
    for (const key of keys) {
      expect(`${key} present: ${key in locale}`).toBe(`${key} present: true`)
    }
  })

  it('every settings.permissions.blockedTools* key the entry names exists in en.json', () => {
    const named = [...entrySource().matchAll(/'(settings\.permissions\.blockedTools[A-Za-z]*)'/g)].map(m => m[1]!)
    expect(named.length).toBeGreaterThan(0)
    for (const key of new Set(named)) {
      expect(`${key} present: ${key in locale}`).toBe(`${key} present: true`)
    }
  })

  it('the withdrawn-badge key the table itself renders exists too', () => {
    // Rendered from PermissionsDataTable, not from the draft, so the regex
    // above cannot see it — and a missing key there would show the key string.
    expect('settings.permissions.blockedToolsUnenforcedBadge' in locale).toBe(true)
  })
})
