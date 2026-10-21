import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_CYCLABLE_PERMISSION_MODES,
  PERMISSION_MODE_ORDER,
  type PermissionMode,
} from '@nessy-agent/shared/agent/modes'
import type { ComposerCapabilities } from '@nessy-agent/shared/protocol'
import {
  applyWorkspaceCycleToComposerModes,
  getVisibleComposerPermissionModes,
  resolveComposerPermissionModeList,
  resolveWorkspaceCyclablePermissionModes,
} from '../composer-permission-modes'

function source(relativeToRenderer: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativeToRenderer}`, import.meta.url)),
    'utf8',
  )
}

describe('workspace cyclable modes: the legacy-workspace fallback', () => {
  // A pre-migration workspace — one that never wrote `cyclablePermissionModes`
  // — gets the shared default cycle, never the raw PERMISSION_MODE_ORDER. Since
  // D1.369 that default NAMES `bypassPermissions` (owner, 2026-09-18); `dontAsk`
  // is still out, which is what keeps the two lists different.
  it('a workspace with no cyclable config cycles through exactly the default modes', () => {
    const legacyWorkspaceDefaults: { cyclablePermissionModes?: undefined } = {}
    const modes = resolveWorkspaceCyclablePermissionModes(
      legacyWorkspaceDefaults.cyclablePermissionModes,
    )
    expect(modes).toEqual(DEFAULT_CYCLABLE_PERMISSION_MODES)
    expect(modes).toContain('bypassPermissions')
    expect(modes).not.toContain('dontAsk')
    expect(modes).not.toEqual(PERMISSION_MODE_ORDER)
  })

  it('a workspace that lists bypass explicitly keeps it in the cycle', () => {
    const modes = resolveWorkspaceCyclablePermissionModes(['default', 'bypassPermissions'])
    expect(modes).toEqual(['default', 'bypassPermissions'])
  })

  it('a degenerate (< 2) list cannot cycle and takes the default', () => {
    expect(resolveWorkspaceCyclablePermissionModes(['default']))
      .toEqual(DEFAULT_CYCLABLE_PERMISSION_MODES)
    expect(resolveWorkspaceCyclablePermissionModes([]))
      .toEqual(DEFAULT_CYCLABLE_PERMISSION_MODES)
  })
})

describe('the three renderer fallback sites route through the gated default', () => {
  // These sites once fell back to PERMISSION_MODE_ORDER (all seven modes), so a
  // legacy workspace could cycle into `dontAsk` — which is still out of the
  // default, and still what these three guard. The sites live inside large
  // components no unit test mounts, so the contract is pinned at source level.
  const appShell = source('components/app-shell/AppShell.tsx')
  const freeFormInput = source('components/app-shell/input/FreeFormInput.tsx')

  it('AppShell seeds enabledModes state with the shared default cycle', () => {
    expect(appShell).toMatch(/useState<PermissionMode\[\]>\(DEFAULT_CYCLABLE_PERMISSION_MODES\)/)
    expect(appShell).not.toMatch(/useState<PermissionMode\[\]>\(PERMISSION_MODE_ORDER\)/)
  })

  it('AppShell resolves loaded workspace settings through the shared fallback', () => {
    expect(appShell).toMatch(
      /setEnabledModes\(resolveWorkspaceCyclablePermissionModes\(settings\.cyclablePermissionModes\)\)/,
    )
  })

  it('AppShell cycle action falls back to the gated default, not all modes', () => {
    expect(appShell).toMatch(
      /const workspaceModes = resolveWorkspaceCyclablePermissionModes\(enabledModes\)/,
    )
    expect(appShell).not.toMatch(/workspaceModes = enabledModes\.length >= 2 \? enabledModes : PERMISSION_MODE_ORDER/)
    // F1.1052: NO PERMISSION_MODE_ORDER reference is left in AppShell. The
    // capability fallback was the last one, and it could reach the hidden
    // `dontAsk` for a session with no capabilities yet; the cycle now reads the
    // picker's own list there too, which still names bypassPermissions, so an
    // explicitly configured bypass survives the intersection.
    expect(appShell.match(/PERMISSION_MODE_ORDER/g)).toBeNull()
    expect(appShell).toContain('getVisibleComposerPermissionModes(composerCapabilities)')
  })

  it('FreeFormInput defaults its enabledModes prop to the shared default cycle', () => {
    expect(freeFormInput).toMatch(/enabledModes = DEFAULT_CYCLABLE_PERMISSION_MODES,/)
    expect(freeFormInput).not.toMatch(/enabledModes = PERMISSION_MODE_ORDER/)
  })
})

/**
 * P2.56 — the picker honours the workspace cycle, like SHIFT+TAB.
 *
 * The setting was INERT on the click path: `FreeFormInput`'s `enabledModes` prop
 * was declared and never read, so route 1 restricted the keyboard and nothing
 * else. These cases pin the rule and the two things it must NOT do.
 */
describe('P2.56 — the click menu honours cyclablePermissionModes', () => {
  const display = (mode: PermissionMode) => ({ mode })
  const RUNTIME_LIST = (['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'] as PermissionMode[])
    .map(display)

  it('narrows the menu to the workspace cycle', () => {
    const menu = applyWorkspaceCycleToComposerModes(RUNTIME_LIST, ['plan', 'default', 'auto'])
    expect(menu.map(entry => entry.mode)).toEqual(['plan', 'default', 'auto'])
    // POSITIVE CONTROL — without a cycle the runtime list survives whole, so
    // the case above is measuring the filter and not an empty list.
    expect(applyWorkspaceCycleToComposerModes(RUNTIME_LIST, undefined).map(e => e.mode))
      .toEqual(DEFAULT_CYCLABLE_PERMISSION_MODES.filter(m => RUNTIME_LIST.some(e => e.mode === m)))
  })

  it('is the SAME rule the keyboard path uses: fewer than two survivors falls back', () => {
    // `AppShell.tsx`: `intersectedModes.length >= 2 ? intersectedModes : capabilityModes`.
    // One survivor cannot cycle, and an empty picker is worse than an
    // unrestricted one.
    expect(applyWorkspaceCycleToComposerModes(RUNTIME_LIST, ['default', 'dontAsk']).map(e => e.mode))
      .toEqual(RUNTIME_LIST.map(e => e.mode))
    const noOverlap = applyWorkspaceCycleToComposerModes(
      [display('plan'), display('default')],
      ['acceptEdits', 'auto'],
    )
    expect(noOverlap.map(e => e.mode)).toEqual(['plan', 'default'])
  })

  it('a runtime that hides a mode still hides it — the cycle only narrows', () => {
    const codexLike = [display('plan'), display('default')]
    expect(applyWorkspaceCycleToComposerModes(codexLike, ['default', 'auto', 'bypassPermissions']).map(e => e.mode))
      .toEqual(codexLike.map(e => e.mode))
  })

  it('the picker reads it, and the session mode is NOT re-derived from it', () => {
    const freeFormInput = source('components/app-shell/input/FreeFormInput.tsx')
    // The NARROWING ITSELF, pinned at the memo rather than only at the two
    // render sites. Added because a mutant survived without it: replacing the
    // memo body with a plain pass-through left both render sites spelled
    // exactly as below and made the whole row inert again — which is P2.56's
    // own defect (a control that silently stops controlling) reappearing inside
    // the fix for it. This file pins contracts at source level because the
    // component is 3000 lines and no unit test mounts it.
    expect(freeFormInput).toMatch(
      /applyWorkspaceCycleToComposerModes\(permissionModeDisplays, enabledModes\)/,
    )
    // Both picker surfaces render the narrowed list (UB14.29: the desktop one is `ComposerModeChip`, which maps the
    // rows it is handed, so the composer now hands the SAME narrowed list to the chip and to the drawer)...
    expect(freeFormInput.match(/permissionModeDisplays=\{permissionModeMenuDisplays\}/g) ?? []).toHaveLength(2)
    expect(source('components/app-shell/input/ComposerModeChip.tsx')).toMatch(/\{permissionModeDisplays\.map\(\(display\) => \(/)
    // ...and `visiblePermissionModes` — which feeds the coercion effect and the
    // slash-command list — keeps reading the UNnarrowed one, so a session
    // started in a non-cyclable mode by config, the CLI or an automation is not
    // silently moved out of it.
    expect(freeFormInput).toMatch(/const visiblePermissionModes = React\.useMemo\(\s*\(\) => permissionModeDisplays\.map/)
  })
})

/**
 * D1.369 — bypass is OFFERED by the picker on a default workspace (owner,
 * 2026-09-18 ~17:00: *"нужно не скрывать, он должен быть доступен"*).
 *
 * Nothing hid it but the DEFAULT cycle. The runtime list already carried it —
 * `composer-capabilities.ts` hands every non-cloud provider
 * `[...ALL_PERMISSION_MODES]` and `PICKER_HIDDEN_MODES` holds only `dontAsk` —
 * so `applyWorkspaceCycleToComposerModes` intersecting against a five-mode
 * default was the whole of the concealment, on the click path and on SHIFT+TAB
 * alike.
 *
 * These cases drive the REAL chain the composer runs — capabilities →
 * {@link resolveComposerPermissionModeList} → {@link applyWorkspaceCycleToComposerModes}
 * — rather than re-deriving it, because a re-derivation would have stayed green
 * through the change it exists to measure.
 */
describe('D1.369 — the picker offers bypassPermissions by default', () => {
  const caps = (modes: PermissionMode[] = [...PERMISSION_MODE_ORDER]): ComposerCapabilities => ({
    attachments: { files: true, images: 'no', folders: true },
    mentions: { files: true, skills: true, sources: true },
    slash: { commandIds: 'all' },
    submit: { queue: true, steer: false },
    reasoning: { levels: [] },
    permissions: { modes },
    connection: { switchable: true, activeRuntime: 'pi' },
    contextMeter: true,
    externalFooter: { gitBranch: true },
  })

  /** The composer's own chain, `FreeFormInput.tsx`'s `permissionModeMenuDisplays`. */
  const pickerModes = (
    cyclablePermissionModes?: PermissionMode[],
    runtimeModes?: PermissionMode[],
  ): PermissionMode[] =>
    applyWorkspaceCycleToComposerModes(
      resolveComposerPermissionModeList(caps(runtimeModes), key => key).modes,
      resolveWorkspaceCyclablePermissionModes(cyclablePermissionModes),
    ).map(display => display.mode)

  it('a workspace with no cyclable config still gets bypassPermissions in the picker', () => {
    const offered = pickerModes(undefined)
    expect(offered).toContain('bypassPermissions')
    // The decision this row deliberately does NOT touch: `dontAsk` stays hidden
    // (`PICKER_HIDDEN_MODES`), so a green line above is not "the filter stopped
    // filtering".
    expect(offered).not.toContain('dontAsk')
    // And the order is Claude Desktop's (F1.1052), bypass still last — a picker
    // that put it first would be one keypress from the top of the list.
    expect(offered).toEqual(['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions'])
  })

  it('a workspace override that omits bypass still hides it', () => {
    // The narrowing is untouched: naming a cycle is still how a workspace takes
    // a mode OFF the menu, and that is the half of P2.56 this row must not undo.
    // (F1.1052: the rows keep the PICKER's order; the workspace list is a set.)
    expect(pickerModes(['plan', 'default'])).toEqual(['default', 'plan'])
    expect(pickerModes(['plan', 'default'])).not.toContain('bypassPermissions')
    // POSITIVE CONTROL on the same instrument: the same override WITH bypass
    // keeps it, so the absence above is the override and not a dead filter.
    expect(pickerModes(['plan', 'default', 'bypassPermissions']))
      .toEqual(['default', 'plan', 'bypassPermissions'])
  })

  it('a runtime that cannot honour bypass still does not offer it', () => {
    // The cycle only ever narrows: a capability set without the mode wins over a
    // default that names it.
    expect(pickerModes(undefined, ['plan', 'default']))
      .toEqual(['default', 'plan'])
  })

  it('SHIFT+TAB reaches it too, from the same default, and comes back', () => {
    // `AppShell.tsx`'s `chat.cyclePermissionMode`, copied verbatim for the reason
    // `applyWorkspaceCycleToComposerModes`'s docblock gives: the point of P2.56
    // is that the two paths agree, so a row that moved only the click path would
    // be the same divergence in the other direction.
    const capabilityModes = getVisibleComposerPermissionModes(caps())
    const workspaceModes = resolveWorkspaceCyclablePermissionModes(undefined)
    const intersected = capabilityModes.filter(mode => workspaceModes.includes(mode))
    const modes = intersected.length >= 2 ? intersected : capabilityModes
    const lap: PermissionMode[] = []
    let mode: PermissionMode = 'default'
    for (let step = 0; step < modes.length; step += 1) {
      mode = modes[(modes.indexOf(mode) + 1) % modes.length]!
      lap.push(mode)
    }
    expect(lap).toContain('bypassPermissions')
    expect(lap).not.toContain('dontAsk')
    // The lap closes — a cycle that reached bypass and stopped there would be a
    // one-way door, which is the shape `default-permission-mode.test.ts` pins
    // for `auto`.
    expect(lap[lap.length - 1]).toBe('default')
  })

  it('the first activation is still held behind the responsibility dialog', () => {
    // "Available" is not "unconfirmed". The gate is in `App.tsx`'s
    // `handleSessionOptionsChange` and it is keyed on the MODE, not on how the
    // mode was chosen, so it covers the picker, SHIFT+TAB and the slash command
    // alike. Pinned at source level because the component is 2000+ lines and no
    // unit test mounts it — the same reason the three cases above this block use.
    const app = source('App.tsx')
    expect(app).toContain("if (updates.permissionMode === 'bypassPermissions') {")
    expect(app).toContain('if (await needsBypassPermissionsAcknowledgment()) {')
    // The control: the dialog is still rendered, so the branch above has
    // somewhere to land.
    expect(app).toContain('<BypassPermissionsDialog')
  })
})
