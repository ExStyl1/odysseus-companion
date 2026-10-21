/**
 * P6.451 — the in-app safe-mode relaunch.
 *
 * Two things are pinned here and they need different instruments:
 *
 * 1. **The decision** — what the relaunch does to the environment for each of
 *    the three intents. A pure function over a record, so no Electron.
 * 2. **The mechanism** — that mutating this process's environment is what a
 *    spawned child actually receives. That claim cannot be asserted on an object
 *    literal (AGENTS.md §Traps: a spread that "contained it" is not evidence the
 *    subprocess got it), so the last case spawns a REAL child and reads its own
 *    answer back.
 *
 * What is NOT pinned here, stated so nobody reads this file as more than it is:
 * that Electron's relauncher passes the environment through its own hop. That
 * needs a packaged run and is owed at the live gate. The measured fact this
 * design rests on is in `safe-mode-relaunch.ts`'s header —
 * Electron's `RelaunchOptions` has no `env` field, so the environment is the
 * only carrier available.
 */

import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  applySafeModeRelaunchEnv,
  safeModeRelaunchIntent,
} from '../safe-mode-relaunch'
import {
  SAFE_MODE_COMPAT_ENV_VAR,
  SAFE_MODE_ENV_VAR,
  isSafeModeEnabled,
} from '@nessy-agent/shared/config/safe-mode'

describe('safeModeRelaunchIntent', () => {
  it('reads an omitted flag as "leave the posture alone"', () => {
    // The boundary that protects every caller predating this row: the
    // server-settings page restarts the app to apply a server change and passes
    // nothing. Reading `undefined` as `false` would silently drop a user out of
    // safe mode when they restarted for an unrelated reason.
    expect(safeModeRelaunchIntent(undefined)).toBe('unchanged')
    expect(safeModeRelaunchIntent(true)).toBe('on')
    expect(safeModeRelaunchIntent(false)).toBe('off')
  })
})

describe('applySafeModeRelaunchEnv', () => {
  it('turns safe mode on, and the gate agrees', () => {
    const env: Record<string, string | undefined> = { PATH: '/usr/bin' }
    applySafeModeRelaunchEnv(env, 'on')
    expect(env[SAFE_MODE_ENV_VAR]).toBe('1')
    // Asserted through the real predicate rather than against the string, so a
    // change to the accepted values cannot leave this passing while the app
    // starts normally.
    expect(isSafeModeEnabled(env)).toBe(true)
    // Nothing else is touched.
    expect(env.PATH).toBe('/usr/bin')
  })

  it('clears BOTH spellings on the way out, which is the half that traps a user', () => {
    // `isSafeModeEnabled` prefers our name and falls back to the documented
    // Claude alias, so a session started by a wrapper that exported the alias
    // would stay in safe mode forever if only our own name were cleared. That is
    // the negative case worth a test: there would be no way back out from
    // inside the app, which is the whole capability this row adds.
    const env: Record<string, string | undefined> = {
      [SAFE_MODE_ENV_VAR]: '1',
      [SAFE_MODE_COMPAT_ENV_VAR]: '1',
    }
    applySafeModeRelaunchEnv(env, 'off')
    expect(env[SAFE_MODE_ENV_VAR]).toBeUndefined()
    expect(env[SAFE_MODE_COMPAT_ENV_VAR]).toBeUndefined()
    expect(isSafeModeEnabled(env)).toBe(false)
  })

  it('leaves an inherited posture exactly as it is when the intent is unchanged', () => {
    const env: Record<string, string | undefined> = { [SAFE_MODE_COMPAT_ENV_VAR]: '1' }
    applySafeModeRelaunchEnv(env, 'unchanged')
    expect(env[SAFE_MODE_COMPAT_ENV_VAR]).toBe('1')
    expect(isSafeModeEnabled(env)).toBe(true)
  })

  it('a real child process reads the posture back, so the carrier works', () => {
    // The positive control for the MECHANISM, and the reason it spawns rather
    // than asserting on a spread: AGENTS.md §Traps records that an object
    // literal containing the name proves nothing about what a subprocess
    // received. Two arms so the control is not one-sided — the same rig with the
    // posture cleared must report `false`.
    const read = (intent: 'on' | 'off'): string => {
      const env = { ...process.env }
      applySafeModeRelaunchEnv(env, intent)
      const child = spawnSync(
        process.execPath,
        ['-e', 'console.log(String(process.env.NESSY_SAFE_MODE ?? "<unset>"))'],
        { env, encoding: 'utf8' },
      )
      expect(child.status).toBe(0)
      return child.stdout.trim()
    }
    expect(read('on')).toBe('1')
    expect(read('off')).toBe('<unset>')
  })
})
