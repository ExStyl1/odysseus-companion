/**
 * P6.424 — the pre-first-turn plugin-suggestion notice.
 *
 * `plugin-relevance.md` § What the user sees: "**Session-start suggestion**: if
 * the `cwd` signal matches the working directory, a one-line `plugin
 * suggestion: <name>@<marketplace> · /plugin` notification appears before the
 * first turn."
 *
 * The DECISION is `selectPluginSuggestion`'s and is pinned by
 * `marketplace/__tests__/plugin-suggestion.test.ts`; what is pinned here is the
 * emitting half — the feed, the two gates that keep it silent on an ordinary
 * machine, and the once-per-session discipline.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMarketplaceRelevance, readPluginSuggestionState } from '@nessy-agent/shared/marketplace'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
import { createTestSessionManager } from './test-session-manager.ts'

type RecordedEvent = { type: string; message?: string; level?: string; topic?: string; reference?: string }

/**
 * A REAL repository, because the pattern a marketplace writes is relative to the
 * repository root and the notice resolves that root with the same `.git` climb
 * the Discover pin uses. A fabricated path string would have silently tested a
 * different matcher branch.
 */
const REPO = mkdtempSync(join(tmpdir(), 'nessy-suggestion-repo-'))
mkdirSync(join(REPO, '.git'), { recursive: true })
mkdirSync(join(REPO, 'infra'), { recursive: true })
mkdirSync(join(REPO, 'docs'), { recursive: true })
const ROOT = join(REPO, 'infra')

function catalogItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acme:terraform-helpers',
    kind: 'plugin',
    listKind: 'plugin',
    name: 'terraform-helpers',
    icon: { kind: 'symbol', name: 'plugin' },
    capabilities: [],
    install: {},
    raw: {},
    marketplaceRegistryId: 'acme',
    marketplaceRegistryLabel: 'acme-corp-plugins',
    relevance: parseMarketplaceRelevance({ signals: { cwd: ['infra'] } }),
    ...overrides,
  }
}

/**
 * The production method is private and async, so it is awaited directly against
 * a hand-built managed session. Only the catalog reader and `sendEvent` are
 * doubles: the allowlist gate, the candidate mapping, the decision and the
 * record are all the shipped ones.
 */
function rig(options: {
  allowed?: string[]
  items?: ReturnType<typeof catalogItem>[]
  messages?: unknown[]
  omitAllowlistMethod?: boolean
} = {}) {
  const manager = createTestSessionManager()
  const internals = manager as unknown as {
    pluginManagementToolsDeps: unknown
    announcePluginSuggestion(managed: unknown): void
    emitPluginSuggestion(managed: unknown): Promise<void>
    announcePluginSuggestionTip(managed: unknown): void
    emitPluginSuggestionTip(managed: unknown): Promise<void>
    sendEvent(event: RecordedEvent, workspaceId: string): void
  }
  const events: RecordedEvent[] = []
  internals.sendEvent = event => { events.push(event) }
  const reader: Record<string, unknown> = {
    peekCachedItems: async () => options.items ?? [catalogItem()],
  }
  if (!options.omitAllowlistMethod) {
    reader.listSuggestionAllowedRegistryIds = async () => options.allowed ?? ['acme']
  }
  internals.pluginManagementToolsDeps = { marketplaceCatalogReader: reader }
  const managed = {
    id: `session-${Math.random().toString(36).slice(2)}`,
    workspace: { id: 'workspace-1', rootPath: ROOT },
    workingDirectory: ROOT,
    messages: options.messages ?? [],
  }
  return { internals, managed, events }
}

describe('P6.424 — the pre-first-turn plugin suggestion', () => {
  test('a matching cwd signal produces one notice naming the reference', async () => {
    const h = rig()
    await h.internals.emitPluginSuggestion(h.managed)
    expect(h.events).toHaveLength(1)
    expect(h.events[0]!.type).toBe('info')
    expect(h.events[0]!.message).toContain('terraform-helpers@acme-corp-plugins')
    // A suggestion is an offer, not a finding.
    expect(h.events[0]!.level).toBeUndefined()
  })

  /**
   * The gate that keeps the whole surface off an ordinary machine.
   * `pluginSuggestionMarketplaces` is managed-only, so `listSuggestionAllowedRegistryIds`
   * returns `[]` with no managed policy — and a row nobody allowed must not be
   * suggested even when its `cwd` matches perfectly.
   */
  test('an empty suggestion allowlist says nothing', async () => {
    const h = rig({ allowed: [] })
    await h.internals.emitPluginSuggestion(h.managed)
    expect(h.events).toEqual([])
  })

  /** A reader that cannot answer the allowlist question is silent, not permissive. */
  test('a reader without the allowlist method says nothing', async () => {
    const h = rig({ omitAllowlistMethod: true })
    await h.internals.emitPluginSuggestion(h.managed)
    expect(h.events).toEqual([])
  })

  test('an installed plugin and a non-matching directory both stay silent', async () => {
    const installed = rig({ items: [catalogItem({ installed: { state: 'installed' } })] })
    await installed.internals.emitPluginSuggestion(installed.managed)
    expect(installed.events).toEqual([])

    const elsewhere = rig()
    ;(elsewhere.managed as { workingDirectory: string }).workingDirectory = join(REPO, 'docs')
    await elsewhere.internals.emitPluginSuggestion(elsewhere.managed)
    expect(elsewhere.events).toEqual([])
  })

  /**
   * "before the first turn" — the gate the dispatcher applies. A session that
   * already has history has had its first turn, and a notice per turn is exactly
   * the nag the documented limits exist to prevent.
   */
  test('a session with history is never offered one, and one session is offered once', () => {
    // Counted at the DISPATCH rather than at the event: the emit is `void`-ed,
    // so an assertion on `events` after a sleep would measure the scheduler.
    const withHistory = rig({ messages: [{ id: 'user-0', role: 'user' }] })
    let historyEmits = 0
    withHistory.internals.emitPluginSuggestion = async () => { historyEmits += 1 }
    withHistory.internals.announcePluginSuggestion(withHistory.managed)
    expect(historyEmits).toBe(0)

    const fresh = rig()
    let freshEmits = 0
    fresh.internals.emitPluginSuggestion = async () => { freshEmits += 1 }
    fresh.internals.announcePluginSuggestion(fresh.managed)
    fresh.internals.announcePluginSuggestion(fresh.managed)
    fresh.internals.announcePluginSuggestion(fresh.managed)
    expect(freshEmits).toBe(1)
  })
})

/**
 * The SECOND surface the same decision feeds. `plugin-relevance.md` § What the
 * user sees: *"**Spinner tip**: a "Working with *topic*? Install the *plugin*
 * plugin" message with the `/plugin install` command appears below the spinner
 * while Claude is responding."*
 *
 * What is pinned here is the half that is NOT the notice: a different gate
 * (`spinnerTip`, and no first-turn restriction), a structural payload the
 * renderer words itself, and the discipline that makes two surfaces cost one
 * session — one ordinal claim and one record, because the page's limits count
 * the SHOW and not the surface.
 */
describe('P6.424 — the spinner tip', () => {
  test('sends the topic and the reference structurally, not a sentence', async () => {
    const h = rig()
    await h.internals.emitPluginSuggestionTip(h.managed)
    expect(h.events).toHaveLength(1)
    expect(h.events[0]!.type).toBe('plugin_suggestion_tip')
    expect(h.events[0]!.reference).toBe('terraform-helpers@acme-corp-plugins')
    expect(h.events[0]!.topic).toBeTruthy()
    // The wording belongs to the surface; a rendered sentence here would ship
    // one locale to every client.
    expect(h.events[0]!.message).toBeUndefined()
  })

  test('the allowlist gate holds for this surface too', async () => {
    const h = rig({ allowed: [] })
    await h.internals.emitPluginSuggestionTip(h.managed)
    expect(h.events).toEqual([])
  })

  /**
   * The difference from the notice, and the reason the tip could not reuse
   * `announcePluginSuggestion`: that dispatcher returns early on a session with
   * history, which would have made the tip a first-turn-only surface — a second
   * session-start notice in a different font.
   */
  test('a session with history still gets one, and only one', () => {
    const withHistory = rig({ messages: [{ id: 'user-0', role: 'user' }] })
    let emits = 0
    withHistory.internals.emitPluginSuggestionTip = async () => { emits += 1 }
    withHistory.internals.announcePluginSuggestionTip(withHistory.managed)
    withHistory.internals.announcePluginSuggestionTip(withHistory.managed)
    expect(emits).toBe(1)
  })

  /**
   * The invariant a second surface most easily breaks. The store says it in as
   * many words: *"The increment happens ONCE per session … not per turn, which
   * would make 'once every three sessions' mean 'every third message'."* Two
   * claims would count one session twice, and two records would retire the
   * session-start notice after one session instead of two.
   */
  test('two surfaces in one session claim the ordinal once and record once', async () => {
    const statePath = join(CONFIG_DIR, 'plugin-suggestions.json')
    const before = await readPluginSuggestionState(statePath)
    // A plugin of this test's own, because the record is a real file shared with
    // every case above and the documented cooldown is "once every three
    // sessions": reusing their plugin would make this case's verdict depend on
    // how many cases ran before it. Measured — it did, and read as a missing
    // record rather than as a suppressed suggestion, which is the same shape as
    // the defect this case exists to catch.
    const reference = 'vault-helpers@acme-corp-plugins'
    const shownBefore = before.shown[reference]?.shownCount ?? 0

    const h = rig({ items: [catalogItem({ id: 'acme:vault-helpers', name: 'vault-helpers' })] })
    await h.internals.emitPluginSuggestionTip(h.managed)
    await h.internals.emitPluginSuggestion(h.managed)

    const after = await readPluginSuggestionState(statePath)
    expect(after.sessionOrdinal - before.sessionOrdinal).toBe(1)
    expect((after.shown[reference]?.shownCount ?? 0) - shownBefore).toBe(1)
  })
})
