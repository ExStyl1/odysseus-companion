/**
 * Auto is the permission mode a new session starts in, and it takes TWO files
 * to say so.
 *
 * `syncConfigDefaults()` overwrites `~/.nessy-agent/config-defaults.json` from
 * the bundled asset on every launch, and falls back to `FALLBACK_CONFIG_DEFAULTS`
 * only when the assets directory is missing. So the bundled JSON governs a
 * normal launch and the constant governs a broken one — the two have to agree,
 * or the app's default mode silently depends on the shape of the install. They
 * did NOT agree before this file existed (`explore` bundled, `default` in code),
 * which is exactly the drift this pins shut.
 *
 * The rotation is asserted alongside the default because `loadConfigDefaults`
 * only keeps a declared `cyclablePermissionModes` when it normalizes to two or
 * more known modes; a typo silently swaps the whole rotation for the built-in
 * one. The rotation is Claude's picker modes minus the hidden `dontAsk` (Nessy's
 * own `explore` is retired, F1.1050: a stored one is read as `plan`).
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

import { DEFAULT_CYCLABLE_PERMISSION_MODES, parsePermissionMode, type PermissionMode } from '../../agent/mode-types.ts'
import { FALLBACK_CONFIG_DEFAULTS, loadConfigDefaults } from '../storage.ts'
import { CONFIG_DIR } from '../paths.ts'

const BUNDLED_ASSET = join(
  import.meta.dir, '..', '..', '..', '..', '..',
  'apps', 'electron', 'resources', 'config-defaults.json',
)

const bundled = JSON.parse(readFileSync(BUNDLED_ASSET, 'utf-8')) as {
  workspaceDefaults?: { permissionMode?: unknown; cyclablePermissionModes?: unknown }
}

describe('the shipped default permission mode', () => {
  it('is auto in the bundled asset AND in the in-code fallback', () => {
    expect(bundled.workspaceDefaults?.permissionMode).toBe('auto')
    expect(FALLBACK_CONFIG_DEFAULTS.workspaceDefaults.permissionMode).toBe('auto')
  })

  it('survives the parse `loadConfigDefaults` puts it through', () => {
    // The reader is `parsePermissionMode(raw) ?? 'default'`, and the fallback is
    // SILENT: a mis-spelled `"Auto"`/`"autoMode"` reads as a flipped file and
    // runs Manual. Nothing else in the app would say so.
    const raw = bundled.workspaceDefaults?.permissionMode
    expect(typeof raw).toBe('string')
    expect(parsePermissionMode(raw as string)).toBe('auto')
  })

  it('is a mode SHIFT+TAB can come back to', () => {
    // A default outside the rotation is a one-way door: cycle away once and the
    // keyboard can never return you to the mode the session started in.
    expect(bundled.workspaceDefaults?.cyclablePermissionModes).toContain('auto')
    expect(FALLBACK_CONFIG_DEFAULTS.workspaceDefaults.cyclablePermissionModes).toContain('auto')
  })
})

describe('the shipped rotation', () => {
  it('lists the five cyclable modes, bypassPermissions included (explore retired, dontAsk hidden)', () => {
    // D1.369 (owner, 2026-09-18) put `bypassPermissions` in. `dontAsk` is the
    // one mode still out — it is picker-hidden and settable through config, the
    // CLI flag and automations only — so this list is the whole vocabulary minus
    // that one, and it is asserted as a LITERAL here because the constant it
    // must agree with is derived.
    const expected: PermissionMode[] =
      ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'] // F1.1050: explore retired from the bundled cycle
    expect(bundled.workspaceDefaults?.cyclablePermissionModes).toEqual(expected)
    expect(FALLBACK_CONFIG_DEFAULTS.workspaceDefaults.cyclablePermissionModes).toEqual(expected)
    // The THIRD copy — the constant the renderer falls back to when a workspace
    // has no cycle of its own. Two of these three used to be hand-written
    // literals; the in-code fallback now spreads the constant, so only the JSON
    // asset can still drift, and this line is what catches it.
    expect(DEFAULT_CYCLABLE_PERMISSION_MODES).toEqual(expected)
    expect(expected).not.toContain('dontAsk')
  })
})

describe('F1.1053 — an app-defaults file that still says explore', () => {
  it('is read as plan, the default and the rotation alike (the store never writes it: the bundle overwrites it each launch)', () => {
    // The test preload points CONFIG_DIR at a private temp directory; refuse to write anywhere else.
    expect(CONFIG_DIR.startsWith(tmpdir())).toBe(true)
    expect(CONFIG_DIR.startsWith(join(homedir(), '.nessy-agent'))).toBe(false)
    const file = join(CONFIG_DIR, 'config-defaults.json')
    const before = existsSync(file) ? readFileSync(file, 'utf-8') : undefined
    const stale = JSON.parse(JSON.stringify(FALLBACK_CONFIG_DEFAULTS))
    stale.workspaceDefaults.permissionMode = 'explore'
    // Two entries only: an unread explore would leave ONE, and the loader would swap in the whole built-in rotation.
    stale.workspaceDefaults.cyclablePermissionModes = ['explore', 'default']
    try {
      writeFileSync(file, JSON.stringify(stale))
      const loaded = loadConfigDefaults()
      expect(loaded.workspaceDefaults.permissionMode).toBe('plan')
      expect(loaded.workspaceDefaults.cyclablePermissionModes).toEqual(['plan', 'default'])
    } finally {
      if (before !== undefined) writeFileSync(file, before)
      else rmSync(file, { force: true })
    }
  })
})
