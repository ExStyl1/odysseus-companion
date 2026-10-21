/**
 * UB14.31 — v0.15.1's `ComposerSourcesChip`, the folder chip and the branch chip in the composer toolbar.
 *
 * Instruments:
 * - the chip's decision, `resolveComposerSourcesChip` (a pure module: `ComposerSourcesChip.tsx` itself imports
 *   `SourceSelectorPopover`, whose `@nessy-agent/ui` barrel reaches the pdfjs chain `bun test` cannot load);
 * - comment-stripped SOURCE of `ComposerSourcesChip`, `FreeFormInput` and `ChatInputZone` for the wiring and the
 *   placement (one identity, one decision, the chips in the toolbar, nothing under the card);
 * - the chip RENDERED for real is the playground's: `registry-render.test.ts` sweeps the `composer-toolbar-chips`
 *   entry and the `input-container` source states in dark ("A, B" on desktop, the count on compact, the stale slug).
 *
 * The fixtures give each source a mention id that differs from its logical name. Production stamps them equal
 * (`capabilities/views.ts`), which is exactly why the compact chip's old `logicalName` count looked right; a fixture
 * where they differ is the only one that can tell the two identities apart.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import { sourceSelectionId } from '@/lib/capability-catalog'
import { resolveComposerSourcesChip } from '../composer-sources-chip-state'

/** Comment-stripped source, so a sentence in a docblock cannot satisfy a pin. */
function stripped(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function source(id: string, logicalName: string, label: string): SafeCapabilitySummary {
  return {
    key: `source:${id}`,
    kind: 'source',
    sourceType: 'api',
    logicalName,
    mention: { type: 'source', id, qualifiedId: `source:${id}`, selectedAsShortAlias: true, label },
    origin: 'native',
    scope: { kind: 'workspace', workspaceId: 'w-1' },
    state: 'active',
    readOnly: false,
    trustState: 'not-required',
    credentialState: 'ready',
    selectedAsUnqualifiedAlias: true,
    diagnosticCodes: [],
  } as SafeCapabilitySummary
}

const GITHUB = source('github-api', 'GitHub API', 'GitHub')
const LINEAR = source('linear-api', 'Linear API', 'Linear')
const FILES = source('local-files', 'Local Files', 'Files')
const SOURCES = [GITHUB, LINEAR, FILES]

describe('one identity for the composer source chip, desktop and compact (UB14.31)', () => {
  it('sourceSelectionId is the mention id, else the logical name', () => {
    expect(sourceSelectionId(GITHUB)).toBe('github-api')
    const bare = { ...GITHUB, mention: undefined } as SafeCapabilitySummary
    expect(sourceSelectionId(bare)).toBe('GitHub API')
  })

  it('POSITIVE — two selected sources: desktop names them ("GitHub, Linear"), compact counts them', () => {
    const desktop = resolveComposerSourcesChip(SOURCES, ['github-api', 'linear-api'], false)
    expect(desktop.hasSelection).toBe(true)
    expect(desktop.label).toEqual({ kind: 'names', names: ['GitHub', 'Linear'] })
    expect(desktop.enabledSources.map(s => s.key)).toEqual(['source:github-api', 'source:linear-api'])
    const compact = resolveComposerSourcesChip(SOURCES, ['github-api', 'linear-api'], true)
    expect(compact.hasSelection).toBe(true)
    expect(compact.label).toEqual({ kind: 'count', count: 2 })
    // One source is a name on both; three are a count on both.
    expect(resolveComposerSourcesChip(SOURCES, ['local-files'], true).label).toEqual({ kind: 'names', names: ['Files'] })
    expect(resolveComposerSourcesChip(SOURCES, ['github-api', 'linear-api', 'local-files'], false).label)
      .toEqual({ kind: 'count', count: 3 })
  })

  it('NEGATIVE (control) — a stale slug that names no offered source is the empty affordance, never "0 sources"', () => {
    for (const compact of [false, true]) {
      const stale = resolveComposerSourcesChip(SOURCES, ['retired-mcp-server'], compact)
      expect(stale).toEqual({ enabledSources: [], hasSelection: false, label: { kind: 'empty' } })
    }
    // A stale slug beside a live one counts only the live one.
    expect(resolveComposerSourcesChip(SOURCES, ['retired-mcp-server', 'linear-api'], false).label)
      .toEqual({ kind: 'names', names: ['Linear'] })
  })

  it('NEGATIVE (control) — the compact chip no longer counts by logical name: a logical-name slug matches nothing', () => {
    // The pre-UB14.31 compact chip matched `s.logicalName`; the selectors store the mention id. On these fixtures
    // the old rule would have counted this slug and the new one must not — the arm that can tell them apart.
    expect(resolveComposerSourcesChip(SOURCES, ['GitHub API'], true).hasSelection).toBe(false)
    expect(resolveComposerSourcesChip(SOURCES, ['github-api'], true).hasSelection).toBe(true)
  })
})

describe('the toolbar wiring and placement (UB14.31)', () => {
  const chip = stripped('../ComposerSourcesChip.tsx')
  const input = stripped('../FreeFormInput.tsx')
  const zone = stripped('../ChatInputZone.tsx')

  it('the chip draws what the resolver decided, with upstream\'s two empty labels', () => {
    expect(chip).toContain('resolveComposerSourcesChip(sources, selectedSlugs, compact)')
    expect(chip).toContain('t("chat.sourcesTooltip")')
    expect(chip).toContain('t("chat.chooseSources")')
    expect(chip).toContain('t("chat.sourcesCount", { count: chipLabel.count })')
    // The stack and the empty icon follow the MATCHED selection, not the raw slug count.
    expect(chip).toContain('const icon = hasSelection')
    expect(chip).not.toContain('selectedSlugs.length')
  })

  it('FreeFormInput mounts the chip on both layouts with one toggle, and keeps no inline copy of it', () => {
    // UB14.32 — one mount for both layouts, as upstream's toolbar has it (`compact={compactMode}`).
    expect(input.match(/<ComposerSourcesChip\b/g)).toHaveLength(1)
    expect(input).toContain('<ComposerSourcesChip\n              compact={compactMode}')
    expect(input.match(/onToggleSlug=\{handleToggleSourceSlug\}/g)).toHaveLength(1)
    // R4-11's Done-means probe, plus the inline selectors the chip now owns.
    expect(input).not.toMatch(/optimisticSourceSlugs\.includes\(s\.logicalName\)/)
    for (const gone of ['<SourceSelectorPopover', '<CompactSourceSelector', '<SourceAvatar']) {
      expect({ gone, present: input.includes(gone) }).toEqual({ gone, present: false })
    }
    // An `@` mention enables a source under the same identity the chip counts.
    expect(input).toContain('const slug = sourceSelectionId(item.source)')
  })

  it('POSITIVE — desktop toolbar order: attach · sources · folder · branch, the branch chip capability-gated', () => {
    // UB14.32 — the left group of v0.15.0's two-group toolbar (one group for both layouts).
    // UB12.78 — the left group's floor is `composerLeftGroupFloor` (three icons, or four where the branch chip mounts).
    const leftAt = input.indexOf('cn(composerLeftGroupFloor(mountsBranchChip), "shrink overflow-hidden')
    expect(leftAt).toBeGreaterThan(-1)
    const attachAt = input.indexOf('<IconButton', leftAt)
    const sourcesAt = input.indexOf('<ComposerSourcesChip', leftAt)
    const folderAt = input.indexOf('<WorkingDirectoryBadge', leftAt)
    const branchAt = input.indexOf('<BranchSwitcher sessionId={sessionId} />', leftAt)
    expect({ attach: attachAt > leftAt, sourcesAfterAttach: sourcesAt > attachAt, folderAfterSources: folderAt > sourcesAt, branchAfterFolder: branchAt > folderAt })
      .toEqual({ attach: true, sourcesAfterAttach: true, folderAfterSources: true, branchAfterFolder: true })
    // UB12.77 — the capability gate is `composerMountsBranchChip` (its arms: BranchSwitcher.test.tsx), read once into
    // `mountsBranchChip` for the mount and the floor (UB12.78).
    expect(input).toContain('const mountsBranchChip = composerMountsBranchChip({ compactMode, canChangeWorkingDirectory: !!onWorkingDirectoryChange, workspaceId, sessionId, capabilities: composerCapabilities })')
    expect(input).toContain('{mountsBranchChip && sessionId && (\n            <BranchSwitcher')
    // D1.251 still reaches the folder chip: it is handed the session id.
    expect(input.slice(folderAt, input.indexOf('/>', folderAt))).toContain('sessionId={sessionId}')
  })

  it('NEGATIVE (control) — nothing of the toolbar lives under the card any more, and compact keeps no branch chip', () => {
    for (const gone of ['<WorkingDirectoryBadge', '<BranchSwitcher', 'externalFooter']) {
      expect({ gone, inZone: zone.includes(gone) }).toEqual({ gone, inZone: false })
    }
    // UB14.32 — compact is now the ternary's first arm: the drawer selector, and neither the badge nor the branch chip.
    const compactAt = input.indexOf('(compactMode ? (\n            <CompactWorkingDirectorySelector')
    const desktopAt = input.indexOf(') : (\n            <WorkingDirectoryBadge', compactAt)
    expect({ compactArm: compactAt > -1, desktopArm: desktopAt > compactAt }).toEqual({ compactArm: true, desktopArm: true })
    const compactGroup = input.slice(compactAt, desktopAt)
    expect(compactGroup).not.toContain('<BranchSwitcher')
    expect(compactGroup).not.toContain('<WorkingDirectoryBadge')
    // The branch chip's guard is `composerMountsBranchChip`, which refuses compact first (UB12.77), so compact never
    // mounts it.
    expect(input).toContain('const mountsBranchChip = composerMountsBranchChip({ compactMode, canChangeWorkingDirectory: !!onWorkingDirectoryChange, workspaceId, sessionId, capabilities: composerCapabilities })')
    expect(input).toContain('{mountsBranchChip && sessionId && (')
  })

  it('the folder chip is WorkingDirectorySelector\'s trigger; the picker keeps handles, the browser and no remove-recent', () => {
    expect(input).toContain('<WorkingDirectorySelector')
    expect(input).toContain('renderTrigger={({ open, hasFolder, folderName, workingDirectory: wd, homeDir, gitBranch }) => (')
    const selector = stripped('../WorkingDirectorySelector.tsx')
    expect(selector).toContain('onWorkingDirectoryChange: (project: IssuedProjectHandle) => void')
    expect(selector).toContain('workspaceId={workspaceId}')
    expect(selector).toContain('onSelect={() => handleSelectRecent(project)}')
    expect(selector).not.toContain('handleRemoveRecent')
    expect(selector).toContain("className={cn(MENU_ITEM_STYLE, 'pointer-events-none bg-fill-selected')}")
  })
})
