/**
 * P6.703 — the per-chat memory scope's design surface.
 *
 * Four of its five states cannot be produced in the app on demand: they depend
 * on what the host recorded for one particular chat, and the fifth exists only
 * while the record side is missing. Source-text assertions for the reason
 * `workspace-actions-menu-registry.test.ts` measures — importing a registry entry
 * that pulls a menu component graph times out under `bun test`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

const REGISTRY_DIR = join(import.meta.dir, '..', 'registry')
const entrySource = readFileSync(join(REGISTRY_DIR, 'session-memory-scope.tsx'), 'utf-8')
const indexSource = readFileSync(join(REGISTRY_DIR, 'index.ts'), 'utf-8')

describe('per-chat memory scope playground entry', () => {
  it('declares one entry and is wired into registry/index', () => {
    expect(entrySource).toContain("id: 'session-memory-scope'")
    expect(entrySource.match(/^\s+id: '/gm) ?? []).toHaveLength(1)
    expect(indexSource).toContain("import { sessionMemoryScopeComponents } from './session-memory-scope'")
    expect(indexSource).toContain('...sessionMemoryScopeComponents,')
  })

  it('covers all five states, including BOTH lossy directions and the lossless one', () => {
    // The lossy sentence must be checked in both directions, and `both-off` is
    // the case where it must NOT appear — one enum says exactly that.
    for (const state of ['follows-global', 'read-only', 'write-only', 'both-off', 'unavailable']) {
      expect(entrySource, `no variant for ${state}`).toContain(`state: '${state}'`)
    }
  })

  it('never reaches the real bridge', () => {
    expect(entrySource).not.toContain('window.electronAPI')
  })
})
