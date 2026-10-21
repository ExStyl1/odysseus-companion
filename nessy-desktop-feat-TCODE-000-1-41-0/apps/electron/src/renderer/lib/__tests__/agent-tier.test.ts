/**
 * P6.633 — the administrator's SUBAGENTS are labelled as theirs in the agents
 * list, in P2.439's sentence and under P2.439's key.
 *
 * The three fields the renderer branches on are `origin`, `scope.kind` and
 * `readOnly`, and every case below moves exactly one of them, so a projection
 * that stopped reading any one of the three would fail here rather than in a
 * screenshot nobody takes.
 *
 * The containment arm is the same trade `skill-tier.test.ts` records: the
 * renderer component graph cannot be loaded by the bun runner, so the overlay is
 * read as SOURCE. Without it a perfectly tested projection could sit beside a
 * list still printing the raw scope word — which is exactly the state this row
 * found.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import { agentOwnerLabelKey } from '../agent-tier'

function agentRow(
  scope: SafeCapabilitySummary['scope'],
  over: Partial<Pick<SafeCapabilitySummary, 'origin' | 'readOnly'>> = {},
): Pick<SafeCapabilitySummary, 'origin' | 'scope' | 'readOnly'> {
  // `readOnly: true` is the default because every tier this label exists for is
  // one: the writable case is the negative control, stated explicitly.
  return { origin: over.origin ?? 'native', scope, readOnly: over.readOnly ?? true }
}

describe('agentOwnerLabelKey — who owns a subagent the app cannot change', () => {
  it('names the administrator for the machine-wide subagent tier', () => {
    // P6.239 emits `<systemDir>/agents` at `builtin` with `mutable: false`; this
    // is the sentence that finally says so in the list.
    expect(agentOwnerLabelKey(agentRow({ kind: 'builtin' })))
      .toBe('skillsList.managedByAdministrator')
  })

  it("reuses P2.439's key rather than a second spelling of the same sentence", () => {
    // Not a tautology with the case above: it asserts the PREFIX, which is what
    // a well-meaning `agentsList.managedByAdministrator` would break — five new
    // keys per locale saying the five things the skills tier already says.
    expect(agentOwnerLabelKey(agentRow({ kind: 'builtin' }))).toStartWith('skillsList.')
  })

  it('says nothing at all for a subagent the user can change — readOnly decides', () => {
    // The whole reason `readOnly` is an input. Same scope, same origin, opposite
    // answer: the label is a claim about an affordance, not about a directory.
    expect(agentOwnerLabelKey(agentRow({ kind: 'project', projectKey: 'p1' }, { readOnly: false })))
      .toBeUndefined()
    expect(agentOwnerLabelKey(agentRow({ kind: 'builtin' }, { readOnly: false })))
      .toBeUndefined()
  })

  it('lets plugin ownership win over the scope the plugin sits at', () => {
    // The same ordering P6.631 gave the alias contest, one layer up: a plugin
    // subagent is projected at `project` scope by
    // `storage-runtime.ts:selectedCapabilityScope`, and the plugin — not the
    // project — is the thing the user uninstalls to be rid of it.
    expect(agentOwnerLabelKey(agentRow({ kind: 'project', projectKey: 'p1' }, { origin: 'plugin' })))
      .toBe('skillsList.managedByPlugin')
    expect(agentOwnerLabelKey(agentRow({ kind: 'builtin' }, { origin: 'plugin' })))
      .toBe('skillsList.managedByPlugin')
  })

  it('gives every scope kind a distinct answer — no shared fallback', () => {
    const keys = ([
      { kind: 'builtin' },
      { kind: 'global' },
      { kind: 'workspace', workspaceId: 'ws-1' },
      { kind: 'project', projectKey: 'p1' },
    ] as SafeCapabilitySummary['scope'][]).map(scope => agentOwnerLabelKey(agentRow(scope)))
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('containment — the agents list actually asks, and offers nothing to edit', () => {
  const root = join(import.meta.dir, '..', '..')
  const overlay = readFileSync(join(root, 'components', 'app-shell', 'ChatDisplay.tsx'), 'utf8')
  const locales = join(root, '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')
  const en = JSON.parse(readFileSync(join(locales, 'en.json'), 'utf8')) as Record<string, string>
  const ru = JSON.parse(readFileSync(join(locales, 'ru.json'), 'utf8')) as Record<string, string>

  it('the overlay resolves the tier through this module', () => {
    expect(overlay).toContain('agentOwnerLabelKey(agent)')
  })

  /**
   * The overlay's own JSX, from its `overlayState` guard to the next top-level
   * comment banner. Sliced rather than grepped whole, so the two assertions
   * below are about THIS list and not about the 3 000 lines around it.
   */
  const agentsOverlay = (() => {
    const start = overlay.indexOf("overlayState?.type === 'agents'")
    expect(start).toBeGreaterThan(-1)
    const end = overlay.indexOf('P2.425', start)
    expect(end).toBeGreaterThan(start)
    return overlay.slice(start, end)
  })()

  it('the tier line no longer prints the raw scope word straight after the label', () => {
    // The defect: `Tier: builtin`, a word that names neither the owner nor the
    // reason. `agent.scope.kind` still appears twice in the block on purpose —
    // once as the scope BADGE, which is untouched, and once as the tier line's
    // fallback for a row the user CAN change — so a count proves nothing. What
    // must be gone is the tier label reading it DIRECTLY.
    expect(agentsOverlay).toMatch(/agents\.tierLabel/)
    expect(agentsOverlay).not.toMatch(/agents\.tierLabel'\)\}: <\/span>\s*\{agent\.scope\.kind\}/)
  })

  /**
   * P6.665 — the second line of the same list, and it lied about its subject.
   *
   * It renders `agent.diagnosticCodes` under `agents.tools`. Diagnostic codes
   * are not tools, and the projection cannot supply tools even in principle:
   * `SafeCapabilitySummary` has no tool list and `toSafeSummary` fills this
   * field from `cap.diagnostics.map(d => d.code)`. A reader who trusted the
   * heading would conclude an agent showing `—` declared no tools.
   *
   * Asserted as a pair — the honest key present, the old one absent from the
   * SLICE and from both locale files — because a rename that leaves the spent
   * key behind leaves a heading nothing renders and a key nothing reads, and
   * the second is what the unreachable-key ledger would meet later.
   */
  it('the diagnostics line names diagnostics, not tools', () => {
    expect(agentsOverlay).toContain("t('agents.diagnostics')")
    // The CALL, not the bare name: the line's own comment explains why the key
    // was renamed and therefore contains `agents.tools` in prose. A guard on the
    // bare identifier failed on the very commit that removed the reader, which
    // is the substring trap this tree keeps paying (P6.675, P6.736).
    expect(agentsOverlay).not.toContain("t('agents.tools')")
    expect(en['agents.diagnostics']).toBeDefined()
    expect(ru['agents.diagnostics']).toBeDefined()
    expect(en['agents.tools']).toBeUndefined()
    expect(ru['agents.tools']).toBeUndefined()
    // The control: the line the heading labels is still the diagnostics one, so
    // a future edit that renames the key AND changes what is rendered under it
    // cannot pass by satisfying only the half above.
    expect(agentsOverlay).toContain('agent.diagnosticCodes.join')
  })

  it('offers nothing to edit at any tier — the row\'s second half, verified not built', () => {
    // "No edit affordance" needed no code: this list is read-only by
    // construction. The ONE button in it is the overlay's close X, so there is
    // no control to disable for the administrator tier — and if one is ever
    // added, this goes red and it owes a `readOnly` gate.
    expect(agentsOverlay.split('<button').length - 1).toBe(1)
    expect(agentsOverlay).toContain("aria-label={t('agents.close')}")
    for (const affordance of ['onDelete', 'onEdit', 'onRename', 'onToggle', '<input', '<Switch']) {
      expect(agentsOverlay, `the agents list grew ${affordance}`).not.toContain(affordance)
    }
  })

  it('every key the projection can return exists in BOTH locales', () => {
    const keys = ([
      { kind: 'builtin' },
      { kind: 'global' },
      { kind: 'workspace', workspaceId: 'ws-1' },
      { kind: 'project', projectKey: 'p1' },
    ] as SafeCapabilitySummary['scope'][])
      .map(scope => agentOwnerLabelKey(agentRow(scope)))
      .concat(agentOwnerLabelKey(agentRow({ kind: 'global' }, { origin: 'plugin' })))
    for (const key of keys) {
      expect(key).toBeDefined()
      expect(en[key!], `en.json is missing ${key}`).toBeTruthy()
      expect(ru[key!], `ru.json is missing ${key}`).toBeTruthy()
    }
  })
})
