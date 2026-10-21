import * as React from 'react'
import { beforeAll, describe, expect, test } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SafeCapabilityDiagnostic } from '@nessy-agent/shared/protocol/capabilities'
import type { ContextUsageSnapshot } from '../../../../shared/types'
import enMessages from '../../../../../../../packages/shared/src/i18n/locales/en.json'
/*
 * P6.844 — the overlay is a STATIC import and the `@nessy-agent/ui` carve-out
 * that stood here is gone. The overlay never imported the barrel itself; it
 * reaches it through `Info_GroupedList`, whose `Spinner` came from the BARREL,
 * whose module graph reaches the Vite-only `pdfjs-dist/...?url` specifier bun
 * cannot resolve. So this file replaced the whole package with a one-export
 * `mock.module` — no spread, no restore: the amputation `AGENTS.md` describes,
 * process-wide for every later file in the batch, and it forced the four
 * bindings below through a dynamic import. The list now imports
 * `@nessy-agent/ui/ui/LoadingIndicator`, so the SHIPPED spinner renders here
 * instead of a stub and no mock is needed anywhere.
 */
import {
  ContextOverlayBreakdown,
  buildContextOverlayWarning,
  getContextTokenTotal,
  instructionLayerNotices,
  lacksCategoryBreakdown,
} from '../context-overlay'

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: enMessages } },
    interpolation: { escapeValue: false },
  })
})

function categoriesSnapshot(overrides: Partial<ContextUsageSnapshot> = {}): ContextUsageSnapshot {
  return {
    inputTokens: 100_000,
    contextWindow: 200_000,
    contextWindowSource: 'runtime',
    percent: 50,
    remainingWindow: 100_000,
    autoCompactionEnabled: true,
    autoCompactionThreshold: 170_000,
    remainingBeforeAutoCompact: 70_000,
    source: 'sdk_usage',
    categories: [
      { id: 'system_prompt', tokens: 12_000 },
      { id: 'system_tools', tokens: 8_000 },
      { id: 'mcp_tools', tokens: 4_000 },
      {
        id: 'custom_subagents',
        tokens: 2_000,
        items: [{ name: 'hive-scout', tokens: 2_000, source: 'plugin://honey#agent.hive-scout@workspace@gen-1' }],
      },
      { id: 'memory_files', tokens: 3_000 },
      { id: 'skills', tokens: 1_000 },
      { id: 'conversation_messages', tokens: 60_000 },
    ],
    unattributedTokens: 10_000,
    loadedFiles: [
      { name: 'project:AGENTS.md', kind: 'instruction', tokens: 2_000 },
      { name: 'auto-memory:MEMORY.md', kind: 'memory', tokens: 1_000 },
    ],
    ...overrides,
  }
}

function legacySnapshot(): ContextUsageSnapshot {
  return {
    inputTokens: 42_000,
    contextWindow: 200_000,
    contextWindowSource: 'runtime',
    percent: 21,
    remainingWindow: 158_000,
    source: 'sdk_usage',
  }
}

function render(
  contextUsage: ContextUsageSnapshot | undefined,
  tokenUsage?: Record<string, unknown>,
  diagnostics?: readonly SafeCapabilityDiagnostic[],
): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <ContextOverlayBreakdown
        contextUsage={contextUsage}
        tokenUsage={tokenUsage as never}
        locale="en"
        diagnostics={diagnostics}
      />
    </I18nextProvider>,
  )
}

describe('ContextOverlayBreakdown', () => {
  test('renders the seven category rows with tokens and percents', () => {
    const markup = render(categoriesSnapshot())
    for (const label of [
      'System prompt',
      'System tools',
      'MCP tools',
      'Custom subagents',
      'Memory files',
      'Skills',
      'Conversation messages',
    ]) {
      expect(markup).toContain(label)
    }
    // percent of the reported total: 60,000 / 100,000
    expect(markup).toContain('60%')
    // the positive unattributed remainder renders as its own row
    expect(markup).toContain('Unattributed')
  })

  test('names the subagent row source and renders the loaded-file list', () => {
    const markup = render(categoriesSnapshot())
    expect(markup).toContain('hive-scout')
    expect(markup).toContain('plugin://honey#agent.hive-scout@workspace@gen-1')
    expect(markup).toContain('project:AGENTS.md')
    expect(markup).toContain('auto-memory:MEMORY.md')
    expect(markup).toContain('Memory files')
  })

  test('humanizes raw capability layer keys in the loaded-file list', () => {
    const markup = render(categoriesSnapshot({
      loadedFiles: [
        { name: 'instruction::project::ws-1::proj-abc::::AGENTS.md', kind: 'instruction', tokens: 2_000 },
        { name: 'instruction::global::-::-::::CLAUDE.md', kind: 'instruction', tokens: 500 },
        { name: 'memory::global::-::-::::MEMORY.md', kind: 'memory', tokens: 1_000 },
      ],
    }))
    // The raw qualified layer key never reaches the user.
    expect(markup).not.toContain('instruction::project::ws-1::proj-abc::::AGENTS.md')
    expect(markup).not.toContain('proj-abc')
    // File name + scope badge, token count kept.
    expect(markup).toContain('AGENTS.md')
    expect(markup).toContain('CLAUDE.md')
    expect(markup).toContain('MEMORY.md')
    expect(markup).toContain('>Project</span>')
    expect(markup).toContain('>User</span>')
    expect(markup).toContain('>Memory</span>')
    expect(markup).toContain('2,000')
  })

  test('a legacy snapshot renders exactly the totals-only rows of today', () => {
    const markup = render(legacySnapshot(), { contextTokens: 42_000, inputTokens: 42_000 })
    // Today's tokenUsage-derived view: no per-category rows, the unattributed
    // remainder carries the whole total.
    expect(markup).not.toContain('System prompt')
    expect(markup).not.toContain('Conversation messages')
    expect(markup).toContain('Unattributed')
    expect(markup).not.toContain('Loaded files')
  })

  test('says why the breakdown carries no categories when the host composed the file list', () => {
    // `74542380e` gives claude and codex the loaded-file group from the host's
    // own capability walk, and neither publishes categories — so the list sits
    // beside the legacy totals-only rows. The sentence is keyed off that data
    // shape, never off a provider name.
    const markup = render(
      {
        ...legacySnapshot(),
        loadedFiles: [{ name: 'instruction::project::ws-1::proj-abc::::AGENTS.md', kind: 'instruction', tokens: 2_000 }],
      },
      { contextTokens: 42_000, inputTokens: 42_000 },
    )
    expect(markup).toContain('Loaded files')
    expect(markup).toContain('This runtime reports no per-category breakdown')
  })

  test('stays silent where there is no asymmetry to explain', () => {
    // Pi's snapshot carries both, so the sentence would be false there; a
    // legacy snapshot carries neither, so nothing is unexplained.
    expect(render(categoriesSnapshot())).not.toContain('no per-category breakdown')
    expect(render(legacySnapshot(), { contextTokens: 42_000, inputTokens: 42_000 }))
      .not.toContain('no per-category breakdown')
    // The boundary the renderer's own fallback uses: an EMPTY categories array
    // is as absent as no array at all.
    expect(lacksCategoryBreakdown({ ...categoriesSnapshot(), categories: [] })).toBe(true)
    expect(lacksCategoryBreakdown({ ...categoriesSnapshot(), loadedFiles: [] })).toBe(false)
    expect(lacksCategoryBreakdown(undefined)).toBe(false)
  })

  test('renders the optimization suggestions, each naming a control that exists here', () => {
    // context-window.md:1616 — `/context` is "a live breakdown by category with
    // optimization suggestions". A suggestion's token figure is the SAME number
    // as the category row it names, so the two can never disagree on screen.
    const markup = render(categoriesSnapshot({
      suggestions: [
        { id: 'defer_mcp_tools', category: 'mcp_tools', tokens: 4_000, count: 42 },
        { id: 'trim_memory_files', category: 'memory_files', tokens: 3_000, count: 2 },
        { id: 'gate_skill_listing', category: 'skills', tokens: 1_000, count: 31 },
      ],
    }))
    expect(markup).toContain('Suggestions')
    expect(markup).toContain('NESSY_ENABLE_TOOL_SEARCH=true')
    expect(markup).toContain('alwaysLoad')
    expect(markup).toContain('/memory')
    expect(markup).toContain('instructionExcludes')
    expect(markup).toContain('disable-model-invocation: true')
    expect(markup).toContain('MCP tool definitions cost 4,000 tokens.')
  })

  test('renders no suggestion group when the snapshot carries none', () => {
    expect(render(categoriesSnapshot())).not.toContain('Suggestions')
    expect(render(categoriesSnapshot({ suggestions: [] }))).not.toContain('Suggestions')
  })

  test('drops a suggestion id the overlay has no copy for', () => {
    const markup = render(categoriesSnapshot({
      suggestions: [
        { id: 'from_a_newer_subprocess' as never, category: 'mcp_tools', tokens: 4_000 },
      ],
    }))
    expect(markup).not.toContain('Suggestions')
    expect(markup).not.toContain('from_a_newer_subprocess')
  })

  test('renders the ancestor-layer-cap diagnostic as the not-loaded group (P6.599)', () => {
    // The negative space of the loaded-file list: the dropped layers are the
    // ones that are NOT in it, so the count and the cap are the only way the
    // shorter list gets a reason. Both numbers come off `safeArgs`.
    const markup = render(categoriesSnapshot(), undefined, [{
      severity: 'warning',
      code: 'capability.instruction.ancestorLayerCap',
      messageKey: 'capability.instruction.ancestorLayerCap',
      safeArgs: { droppedCount: '2', limit: '8' },
    }])
    expect(markup).toContain('Not loaded')
    expect(markup).toContain(
      '2 instruction files in parent directories were not loaded: at most 8 ancestor layers are read above the working directory.',
    )
  })

  test('renders no not-loaded group when the catalog carries no such diagnostic', () => {
    // The negative control, and the only thing that keeps the group from
    // announcing itself on every healthy session.
    expect(render(categoriesSnapshot())).not.toContain('Not loaded')
    expect(render(categoriesSnapshot(), undefined, [])).not.toContain('Not loaded')
    expect(render(categoriesSnapshot(), undefined, [{
      severity: 'info',
      code: 'capability.blocked.untrusted',
      messageKey: 'capability.blocked.untrusted',
    }])).not.toContain('Not loaded')
  })

  test('shows the over-limit warning inside the overlay', () => {
    const markup = render(categoriesSnapshot({
      inputTokens: 294_000,
      remainingWindow: 0,
      percent: 147,
    }))
    expect(markup).toContain('Context exceeds the 200k-token limit by 94k tokens — run /compact or /clear to continue.')
  })
})

describe('instructionLayerNotices', () => {
  test('keeps only the two instruction-layer codes, in catalog order', () => {
    const notices = instructionLayerNotices([
      { severity: 'info', code: 'capability.blocked.untrusted', messageKey: 'capability.blocked.untrusted' },
      {
        severity: 'warning',
        code: 'capability.instruction.overSizeLimit',
        messageKey: 'capability.instruction.overSizeLimit',
        safeArgs: { droppedCount: '1', limitMiB: '4' },
      },
      {
        severity: 'warning',
        code: 'capability.instruction.ancestorLayerCap',
        messageKey: 'capability.instruction.ancestorLayerCap',
        safeArgs: { droppedCount: '2', limit: '8' },
      },
    ])
    expect(notices).toEqual([
      { key: 'capability.instruction.overSizeLimit', params: { droppedCount: '1', limitMiB: '4' } },
      { key: 'capability.instruction.ancestorLayerCap', params: { droppedCount: '2', limit: '8' } },
    ])
  })

  test('an absent diagnostics field is not an error', () => {
    expect(instructionLayerNotices(undefined)).toEqual([])
  })
})

describe('buildContextOverlayWarning', () => {
  const base = categoriesSnapshot()

  test('over the context window names /compact or /clear (errors.md)', () => {
    const warning = buildContextOverlayWarning({ ...base, inputTokens: 294_000 })
    expect(warning).toEqual({
      key: 'context.warning.overLimitCompact',
      params: { limit: '200k', over: '94k' },
    })
    expect(testI18n.t(warning!.key, warning!.params)).toBe(
      'Context exceeds the 200k-token limit by 94k tokens — run /compact or /clear to continue.',
    )
  })

  test('over the limit with compaction disabled names /clear only', () => {
    const warning = buildContextOverlayWarning({
      ...base,
      inputTokens: 294_000,
      autoCompactionEnabled: false,
    })
    expect(warning?.key).toBe('context.warning.overLimitClear')
    expect(testI18n.t(warning!.key, warning!.params)).toBe(
      'Context exceeds the 200k-token limit by 94k tokens — run /clear to continue.',
    )
  })

  test('past the compaction window (still inside the context window) names /compact', () => {
    const warning = buildContextOverlayWarning({
      ...base,
      inputTokens: 190_000,
      autoCompactionThreshold: 170_000,
    })
    expect(warning).toEqual({
      key: 'context.warning.pastCompactionWindowCompact',
      params: { window: '170k', over: '20k' },
    })
    expect(testI18n.t(warning!.key, warning!.params)).toBe(
      'Context is 20k tokens past the 170k-token compaction window — run /compact to reduce usage.',
    )
  })

  test('past the compaction window with compaction disabled names /clear', () => {
    const warning = buildContextOverlayWarning({
      ...base,
      inputTokens: 190_000,
      autoCompactionThreshold: 170_000,
      autoCompactionEnabled: false,
    })
    expect(warning?.key).toBe('context.warning.pastCompactionWindowClear')
    expect(testI18n.t(warning!.key, warning!.params)).toBe(
      'Context is 20k tokens past the 170k-token compaction window — run /clear to reduce usage.',
    )
  })

  test('warns on capacity when close to the auto-compact threshold', () => {
    const warning = buildContextOverlayWarning({
      ...base,
      inputTokens: 160_000,
      autoCompactionThreshold: 170_000,
      remainingBeforeAutoCompact: 10_000,
    })
    expect(warning?.key).toBe('context.warning.capacity')
  })

  test('stays silent well inside the window', () => {
    expect(buildContextOverlayWarning(base)).toBeNull()
  })
})

describe('getContextTokenTotal', () => {
  const base = { outputTokens: 0, totalTokens: 0, costUsd: 0 }

  test('prefers the snapshot-written counter when a Pi session has one', () => {
    expect(getContextTokenTotal({ ...base, contextTokens: 132_377, inputTokens: 132_377 })).toBe(132_377)
  })

  test('falls through the initialiser zero to the counter claude and codex do fill', () => {
    // `applyContextUsageSnapshot` is the only writer of `contextTokens` and it
    // is Pi-only, so on the other two runtimes the 0 is `ensureTokenUsage`'s
    // initialiser. Taking it made the `/context` overlay's Current row, the
    // breakdown total and every percentage in it read zero.
    expect(getContextTokenTotal({ ...base, contextTokens: 0, inputTokens: 132_377 })).toBe(132_377)
  })

  test('is zero when neither counter observed anything, as before', () => {
    expect(getContextTokenTotal({ ...base, contextTokens: 0, inputTokens: 0 })).toBe(0)
    expect(getContextTokenTotal(undefined)).toBe(0)
  })
})
