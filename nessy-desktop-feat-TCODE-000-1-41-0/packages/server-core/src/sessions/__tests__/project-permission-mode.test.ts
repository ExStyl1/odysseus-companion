/**
 * The trusted-project permission_mode clamp ranks modes by the canonical
 * PERMISSION_MODE_ORDER (permission-modes audit, 2026-07-31).
 *
 * A hand-written PERMISSION_MODE_PERMISSIVENESS table here once inverted
 * acceptEdits/auto relative to that order: a trusted project's config.toml
 * could move a session with an acceptEdits floor UP to auto (whose write
 * auto-approval is unbounded), while the legitimate auto -> acceptEdits
 * narrowing was refused. The table also ranked plan against safe, a pair the
 * canonical clamp treats as incomparable on the write axis.
 */

import { describe, expect, it } from 'bun:test'
import {
  PERMISSION_MODE_ORDER,
  clampPermissionModeToParent,
  type PermissionMode,
} from '@nessy-agent/shared/agent'
import { normalizeProjectPermissionMode } from '../SessionManager.ts'

describe('normalizeProjectPermissionMode', () => {
  it('drops a project request for auto over an acceptEdits floor (the audited widening)', () => {
    expect(normalizeProjectPermissionMode('auto', 'acceptEdits')).toBeUndefined()
  })

  it('accepts a project narrowing from an auto floor down to acceptEdits (refused by the inverted table)', () => {
    expect(normalizeProjectPermissionMode('acceptEdits', 'auto')).toBe('acceptEdits')
  })

  // F1.1050 (DN-272): this arm pinned plan and safe (explore) as incomparable. With explore retired, `safe` and
  // `explore` read as plan, so over a plan floor they are plan itself — accepted — and the carve-out is gone.
  it('F1.1050: safe and explore read as plan, so over a plan floor they are accepted as plan', () => {
    expect(normalizeProjectPermissionMode('safe', 'plan')).toBe('plan')
    expect(normalizeProjectPermissionMode('explore', 'plan')).toBe('plan')
    expect(normalizeProjectPermissionMode('explore', 'dontAsk')).toBeUndefined()
  })

  it('agrees with clampPermissionModeToParent on every mode pair', () => {
    for (const floor of PERMISSION_MODE_ORDER) {
      for (const requested of PERMISSION_MODE_ORDER) {
        const accepted = clampPermissionModeToParent(requested, floor) === requested
        expect(
          normalizeProjectPermissionMode(requested, floor),
          `${requested} over a ${floor} floor`,
        ).toBe(accepted ? requested : (undefined as unknown as PermissionMode))
      }
    }
  })

  it('resolves legacy spellings through the shared alias table, still clamped by the floor', () => {
    // A trusted project written before the vocabulary flip keeps its mode.
    expect(normalizeProjectPermissionMode('safe', 'bypassPermissions')).toBe('plan')
    expect(normalizeProjectPermissionMode('ask', 'bypassPermissions')).toBe('default')
    expect(normalizeProjectPermissionMode('allow-all', 'bypassPermissions')).toBe('bypassPermissions')
    // The clamp is spelling-independent: no alias widens past the floor.
    expect(normalizeProjectPermissionMode('allow-all', 'acceptEdits')).toBeUndefined()
  })

  it('ignores values outside every accepted spelling', () => {
    for (const value of [undefined, '', 'sudo', 'toString', 'constructor']) {
      expect(normalizeProjectPermissionMode(value, 'bypassPermissions'), String(value)).toBeUndefined()
    }
  })
})
