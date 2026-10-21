/**
 * WORKSPACE SETTINGS SHOWED A MODE THE PRODUCT DOES NOT USE (P4.8).
 *
 * `WorkspaceSettingsPage` seeded `useState<PermissionMode>('default')` and fell
 * back to `'default'` again when the load returned no configured mode, so a
 * workspace that had never set one DISPLAYED **Manual**. `createSession`
 * resolves that same absence as
 * `managedPiPolicy.defaultMode ?? wsConfig?.defaults?.permissionMode ??
 * globalDefaults.workspaceDefaults.permissionMode`, and the shipped tail of that
 * chain has been `auto` since P0.2 flipped it on 2026-08-14 — measured here
 * against `config-defaults.json` and `loadConfigDefaults`'s in-code copy, both
 * of which must say it, because the bundled file wins on a normal launch and the
 * in-code one only when the assets directory is missing.
 *
 * THE DIRECTION IS WHY THIS IS WORTH A ROW. The label claimed LESS autonomy than
 * the user was actually granting. Before P0.2 the identical bug pointed the
 * other way — the page claimed more autonomy than the product took, which is the
 * side a mistake is allowed to be on — which is how it survived review then and
 * why re-checking the direction is part of the fix rather than a formality.
 *
 * WHAT IS PINNED AT SOURCE LEVEL AND WHY. The page is a 589-line component that
 * needs the app-shell context, `window.electronAPI` and the router to mount; no
 * unit test in this tree mounts it. So the precedence rule was extracted into
 * `resolveWorkspaceDefaultPermissionMode` where it can be exercised directly,
 * and the page's USE of it is asserted against its source — the same instrument
 * `workspace-cyclable-modes.test.ts` uses for the three fallback sites inside
 * large components, for the same reason.
 *
 * Mutation probes, both run 2026-08-31:
 *
 *  - make `resolveWorkspaceDefaultPermissionMode` return `configured ?? 'default'`
 *    (i.e. drop the host-supplied tier) → `an unconfigured workspace shows the
 *    configured global default` goes red on `expect(...).toBe('auto')`;
 *  - drop `effectiveDefaultPermissionMode` from the `SETTINGS_GET` payload →
 *    `the handler sends the effective default` goes red on
 *    `expect(payload.effectiveDefaultPermissionMode).toBe(...)`.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadConfigDefaults } from '@nessy-agent/shared/config/storage'
import { PERMISSION_MODE_ORDER, type PermissionMode } from '@nessy-agent/shared/agent/modes'
import {
  resolveWorkspaceDefaultModeDisplay,
  resolveWorkspaceDefaultPermissionMode,
} from '@/lib/composer-permission-modes'

function source(relativeToRenderer: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../${relativeToRenderer}`, import.meta.url)),
    'utf8',
  )
}

const CONFIG_DEFAULTS_JSON = fileURLToPath(
  new URL('../../../../../resources/config-defaults.json', import.meta.url),
)

describe('the mode Workspace Settings shows for a workspace that configured none', () => {
  it('the shipped global default really is auto, in BOTH places that can answer', () => {
    // The premise of the whole row. `loadConfigDefaults` reads the bundled asset
    // on a normal launch and its own in-code copy when the assets directory is
    // missing, so a one-place flip would make the app's default mode depend on
    // the shape of the install.
    const bundled = JSON.parse(readFileSync(CONFIG_DEFAULTS_JSON, 'utf8'))
    expect(bundled.workspaceDefaults.permissionMode).toBe('auto')
    expect(loadConfigDefaults().workspaceDefaults.permissionMode).toBe('auto')
    // And `auto` is a real mode, not a string that would render as a raw key.
    expect(PERMISSION_MODE_ORDER).toContain('auto')
  })

  it('an unconfigured workspace shows the configured global default, not a hardcoded mode', () => {
    const effectiveDefault = loadConfigDefaults().workspaceDefaults.permissionMode
    expect(resolveWorkspaceDefaultPermissionMode(undefined, effectiveDefault)).toBe('auto')
    // The defect, stated as the thing that must no longer happen.
    expect(resolveWorkspaceDefaultPermissionMode(undefined, effectiveDefault)).not.toBe('default')
  })

  it('a workspace that configured a mode still shows its own, whatever the default is', () => {
    for (const mode of PERMISSION_MODE_ORDER) {
      expect(resolveWorkspaceDefaultPermissionMode(mode, 'auto')).toBe(mode)
    }
  })

  it('falls back to a mode of its own ONLY when nothing is known at all', () => {
    // The settings load failed or returned null: no configured value, no
    // effective default. `'default'` is the narrowest of the seven, which is the
    // right direction for a page that does not know.
    const unknown: PermissionMode | undefined = undefined
    expect(resolveWorkspaceDefaultPermissionMode(unknown, unknown)).toBe('default')
  })
})

describe('the page and the handler are actually wired to it', () => {
  const page = source('pages/settings/WorkspaceSettingsPage.tsx')

  it('the page no longer seeds or falls back to a hardcoded mode', () => {
    // P2.489 replaced the two-tier call with the three-tier one; the resolver
    // the P4.8 pin named is still the tail of it, called from inside.
    expect(page).toContain('resolveWorkspaceDefaultModeDisplay(')
    expect(page).toContain('const displayedPermissionMode = defaultModeDisplay.mode')
    expect(page).toContain('value={displayedPermissionMode}')
    // The two exact expressions the row's pre-check named.
    expect(page).not.toContain("useState<PermissionMode>('default')")
    expect(page).not.toContain("settings.permissionMode || 'default'")
  })

  it('the write path is untouched — the user still saves exactly what they picked', () => {
    // The row is explicit that the control's own writer stays. A fix that
    // started PERSISTING the resolved default would silently write `auto` into
    // every workspace the user merely opened this page on.
    expect(page).toContain("await updateWorkspaceSetting('permissionMode', newMode)")
    expect(page).not.toContain("updateWorkspaceSetting('permissionMode', displayedPermissionMode)")
    expect(page).not.toContain("updateWorkspaceSetting('permissionMode', effectiveDefaultMode)")
  })

  it('the handler sends the effective default, read from the config-defaults chain', () => {
    const handler = readFileSync(
      fileURLToPath(new URL(
        '../../../../../../../packages/server-core/src/handlers/rpc/settings.ts',
        import.meta.url,
      )),
      'utf8',
    )
    expect(handler).toContain(
      'effectiveDefaultPermissionMode: loadConfigDefaults().workspaceDefaults.permissionMode,',
    )
    // Read-only: `SETTINGS_UPDATE` must not accept it, or the page could write a
    // value it was only ever given to display.
    const validKeys = handler.match(/const validKeys = \[[^\]]*\]/)?.[0] ?? ''
    expect(validKeys).not.toBe('')
    expect(validKeys).not.toContain('effectiveDefaultPermissionMode')
    expect(validKeys).toContain("'permissionMode'")
  })
})


/**
 * P2.489 — THE MANAGED TIER OUTRANKS THE CONTROL, AND THE CONTROL SAID NOTHING.
 *
 * `createSession` resolves `managedPiPolicy.defaultMode ??
 * wsConfig?.defaults?.permissionMode ?? globalDefaults.workspaceDefaults.permissionMode`.
 * P4.8 above made the control honest about the LAST tier and left the FIRST out
 * — reported rather than papered over, in `effectiveDefaultPermissionMode`'s own
 * docblock. On any install that deploys a managed mode, the control wrote a
 * value no session would ever read and the user got no indication at all.
 *
 * The fix is entirely in what the control SAYS. The managed tier outranking a
 * user setting is correct and deliberate; nothing here re-ranks it.
 *
 * WHAT IS PINNED HERE AND WHAT IS NOT. The rule is a pure function and is
 * exercised directly; the page's use of it is asserted against its source, the
 * instrument this file already uses. **The host half is NOT pinned here because
 * it is not built**: `WorkspaceSettings.managedDefaultPermissionMode` is
 * declared and read, and the handler that would populate it lives in a file this
 * lane does not hold. Until it does, `managed` is `false` everywhere and the
 * behaviour is exactly P4.8's — which is the fail-open direction chosen on
 * purpose, and the reason this arm is inert rather than wrong.
 */
describe('P2.489 · what the control says when a managed policy outranks it', () => {
  it('shows the MANAGED mode, not the workspace value it silently outranks', () => {
    const display = resolveWorkspaceDefaultModeDisplay('acceptEdits', 'auto', 'plan')
    expect(display.mode).toBe('plan')
    expect(display.managed).toBe(true)
    // The defect, stated as the thing that must no longer happen: the control
    // showed the workspace's own value while sessions started in the managed one.
    expect(display.mode).not.toBe('acceptEdits')
  })

  it('outranks the host default too — it is the HEAD of the chain, not a tie-break', () => {
    expect(resolveWorkspaceDefaultModeDisplay(undefined, 'auto', 'plan').mode).toBe('plan')
    expect(resolveWorkspaceDefaultModeDisplay(undefined, undefined, 'plan').mode).toBe('plan')
  })

  it('every mode a policy can name is carried through unchanged', () => {
    for (const mode of PERMISSION_MODE_ORDER) {
      expect(resolveWorkspaceDefaultModeDisplay('default', 'auto', mode)).toEqual({ mode, managed: true })
    }
  })

  /**
   * FAIL-OPEN, and the direction is the point. The field is absent from every
   * unmanaged payload and from any host older than it, so reading absence as
   * "managed" would disable a working control for everyone. Absence therefore
   * means UNMANAGED, and the answer is byte-for-byte P4.8's.
   */
  it('an absent managed mode leaves the P4.8 behaviour exactly as it was', () => {
    for (const [configured, effective] of [
      ['acceptEdits', 'auto'], [undefined, 'auto'], [undefined, undefined],
    ] as Array<[PermissionMode | undefined, PermissionMode | undefined]>) {
      const display = resolveWorkspaceDefaultModeDisplay(configured, effective, undefined)
      expect(display.managed).toBe(false)
      expect(display.mode).toBe(resolveWorkspaceDefaultPermissionMode(configured, effective))
    }
  })

  it('the page disables the row and appends the managed note, and only then', () => {
    const page = source('pages/settings/WorkspaceSettingsPage.tsx')
    expect(page).toContain('disabled={defaultModeDisplay.managed}')
    expect(page).toContain('settings.workspace.defaultModeManaged')
    // Gated on the flag, never rendered flat — an unconditional note would tell
    // every unmanaged install that its own control does not work. Asserted on
    // the CONDITIONAL rather than on the whole expression: a formatting change
    // must not turn this pin red, and only the gate is the claim.
    const noteAt = page.indexOf('settings.workspace.defaultModeManaged')
    expect(noteAt).toBeGreaterThan(-1)
    expect(page.slice(Math.max(0, noteAt - 300), noteAt)).toContain('defaultModeDisplay.managed')
    expect(page.slice(Math.max(0, noteAt - 300), noteAt)).toContain('?')
    // The write path still sends what the user picked; the row being disabled is
    // what stops the write, not a changed writer.
    expect(page).toContain("await updateWorkspaceSetting('permissionMode', newMode)")
  })

  it('the note resolves in both locales and is really translated', () => {
    const locales = (code: string): Record<string, string> => JSON.parse(
      readFileSync(
        fileURLToPath(new URL(
          `../../../../../../../packages/shared/src/i18n/locales/${code}.json`,
          import.meta.url,
        )),
        'utf8',
      ),
    )
    const en = locales('en')
    const ru = locales('ru')
    for (const key of ['settings.workspace.defaultMode', 'settings.workspace.defaultModeDesc', 'settings.workspace.defaultModeManaged']) {
      expect(en[key], `en is missing ${key}`).toBeTruthy()
      expect(ru[key], `ru is missing ${key}`).toBeTruthy()
      expect(ru[key], `ru still holds the English text for ${key}`).not.toBe(en[key])
    }
    // No interpolation: this string is rendered with no values record, so a
    // `{{name}}` in it would reach the screen as a literal brace pair.
    expect(en['settings.workspace.defaultModeManaged']).not.toContain('{{')
    expect(ru['settings.workspace.defaultModeManaged']).not.toContain('{{')
  })

  /**
   * The host half, named so it cannot be forgotten. `SETTINGS_GET` must send
   * `managedDefaultPermissionMode` and `SETTINGS_UPDATE` must keep refusing it —
   * the same read-only shape its neighbour has. Asserted as an EXCLUSION today,
   * which is the honest state: the field is declared and consumed, and nothing
   * populates it yet.
   */
  it('the wire field is declared read-only, and no writer has been added behind our back', () => {
    const dto = readFileSync(
      fileURLToPath(new URL(
        '../../../../../../../packages/shared/src/protocol/dto.ts',
        import.meta.url,
      )),
      'utf8',
    )
    expect(dto).toContain('managedDefaultPermissionMode?: PermissionMode')
    const handler = readFileSync(
      fileURLToPath(new URL(
        '../../../../../../../packages/server-core/src/handlers/rpc/settings.ts',
        import.meta.url,
      )),
      'utf8',
    )
    const validKeys = handler.match(/const validKeys = \[[^\]]*\]/)?.[0] ?? ''
    expect(validKeys).not.toBe('')
    expect(validKeys).not.toContain('managedDefaultPermissionMode')
  })
})
