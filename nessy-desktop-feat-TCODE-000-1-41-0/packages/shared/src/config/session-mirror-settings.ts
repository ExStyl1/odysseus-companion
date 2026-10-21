/**
 * `sessionMirror` settings — the host-side configuration for the session
 * mirror store (docs/superpowers/plans/2026-07-28-session-mirror-store.md;
 * contract: agent-sdk/session-storage.md). Parsed with the same strictness
 * `sandbox`/`worktree`/`workflow` use: an unknown key or a bad value THROWS
 * rather than silently dropping to a permissive default. The CALLER contains
 * the throw (a broken mirror config must disable the mirror with a clear
 * diagnostic — it must never break session persistence).
 *
 * Absent config = no mirror, zero overhead. `adapter` names the built-in
 * adapter; unknown names fail closed with a diagnostic naming the adapter.
 */
import { isAbsolute } from 'path'

export const SESSION_MIRROR_ADAPTERS = ['directory'] as const
export type SessionMirrorAdapter = (typeof SESSION_MIRROR_ADAPTERS)[number]

export interface SessionMirrorSettingsV1 {
  adapter: SessionMirrorAdapter
  /** Absolute root the directory adapter mirrors into. */
  path: string
}

const SESSION_MIRROR_SETTING_KEYS = ['adapter', 'path'] as const

/** Strict parser for one layer arriving from an untrusted-shape source. */
export function parseSessionMirrorSettingsV1(value: unknown): SessionMirrorSettingsV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid session mirror settings')
  }
  const layer = value as Record<string, unknown>
  const allowed = new Set<string>(SESSION_MIRROR_SETTING_KEYS)
  for (const key of Object.keys(layer)) {
    if (!allowed.has(key)) throw new Error(`invalid session mirror setting: ${key}`)
  }
  const adapter = layer.adapter
  if (typeof adapter !== 'string' || !(SESSION_MIRROR_ADAPTERS as readonly string[]).includes(adapter)) {
    throw new Error(`unknown session mirror adapter: ${String(adapter)}`)
  }
  const path = layer.path
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('invalid session mirror path')
  }
  if (!isAbsolute(path)) {
    throw new Error('session mirror path must be absolute')
  }
  return Object.freeze({ adapter: adapter as SessionMirrorAdapter, path })
}
