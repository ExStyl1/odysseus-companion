/**
 * DA1.72 — `loadStoredConfig` and its refusal semantics, in a module that
 * imports none of `credentials`, `sessions` or `docs`.
 *
 * ## What was measured, and why a structural instrument
 *
 * DA1.67 priced the config graph three ways and found the cost is the PAGE
 * CACHE rather than any one module: cold, tens of seconds; warm, nothing
 * measurable (the same eleven dp files answered 118.55 s with no test body
 * running, and the same single-module imports answered 0.29–0.33 s warm against
 * 40–86 s cold, at about 1 % cpu). AGENTS.md's own rule for that shape is to
 * prefer the STRUCTURAL claim to a wall-clock sentence, so this suite counts
 * the module graph rather than timing it: the count is deterministic, it is the
 * thing that actually changed, and it cannot be re-measured into a different
 * answer by a warm cache.
 *
 * The census walks `import` / `export … from` with RELATIVE specifiers and
 * skips `import type`, because a type import is erased and costs nothing at
 * runtime — which is exactly why `stored-config-load.ts` may take
 * `import type { StoredConfig } from './storage.ts'` without re-creating the
 * cycle this row removed.
 *
 * ## The readings
 *
 * Before: `config/proxy-env.ts` reached **161** files including all three of
 * `credentials/index.ts`, `sessions/index.ts` and `docs/index.ts`, for the sake
 * of `getNetworkProxySettings`, which is three lines over `loadStoredConfig`.
 * After: **13**, none of the three. `stored-config-load.ts` itself: **6**.
 *
 * ## What the split actually required, which was not what the row named
 *
 * Moving `loadStoredConfig` alone changed nothing measurable: it needs
 * `StoredConfigTopLevelSchema`, `validators.ts` imported `storage.ts` (for
 * `getToolIconsDir` and the cross-session-inbound renderer) and separately
 * reaches `agent/permissions-config.ts` and `automations/index.ts`, each 158
 * files. So three things moved to the modules that own them — the two
 * cross-session renderers to `cross-session-inbound-vocabulary.ts`,
 * `getToolIconsDir` to `config/paths.ts`, and the strict envelope
 * (`StoredConfigKnownFields` + `StoredConfigTopLevelSchema`, which is
 * `z.unknown().optional()` throughout and needs nothing but zod) to the leaf
 * beside the refusal that enforces it. Every one is re-exported from where it
 * used to live, so no importer in the tree changed.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'

const CONFIG_DIR = resolve(import.meta.dir, '..')

/** Transitive RUNTIME imports of an entry file, relative specifiers only. */
function runtimeGraph(entry: string): string[] {
  const seen = new Set<string>()
  const stack = [resolve(entry)]
  while (stack.length > 0) {
    const file = stack.pop() as string
    if (seen.has(file) || !existsSync(file)) continue
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    const pattern = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)(?:[^'"]*?\sfrom\s*)?['"](\.[^'"]*)['"]/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source)) !== null) {
      stack.push(resolve(dirname(file), match[1] as string))
    }
  }
  return [...seen]
}

const HEAVY = ['/credentials/index.ts', '/sessions/index.ts', '/docs/index.ts']

describe('DA1.72 — the stored-config leaf', () => {
  it('the census reads a real graph (positive control, both directions)', () => {
    // Without this, every "absent" below is satisfied by a walker that stopped
    // walking. `storage.ts` is the control that the SAME walker still finds all
    // three where they genuinely are.
    const storage = runtimeGraph(resolve(CONFIG_DIR, 'storage.ts'))
    expect(storage.length).toBeGreaterThan(100)
    for (const heavy of HEAVY) expect(storage.some(file => file.endsWith(heavy))).toBe(true)
  })

  it('loadStoredConfig reaches none of credentials, sessions or docs', () => {
    const leaf = runtimeGraph(resolve(CONFIG_DIR, 'stored-config-load.ts'))
    for (const heavy of HEAVY) {
      expect({ heavy, reached: leaf.some(file => file.endsWith(heavy)) }).toEqual({ heavy, reached: false })
    }
    // A ceiling rather than an exact number: the point is that it stays a leaf,
    // and an exact count is a ratchet that fires on an unrelated helper.
    expect(leaf.length).toBeLessThan(25)
  })

  it('proxy-env asks the leaf, which is the consumer the row was born from', () => {
    // DA1.67: the only thing this module wants from `storage.ts` is
    // `getNetworkProxySettings`, three lines over `loadStoredConfig`. 161 files
    // before, 13 after.
    const proxyEnv = runtimeGraph(resolve(CONFIG_DIR, 'proxy-env.ts'))
    for (const heavy of HEAVY) expect(proxyEnv.some(file => file.endsWith(heavy))).toBe(false)
    expect(proxyEnv.length).toBeLessThan(40)
  })

  it('the leaf still answers for every name that used to come from storage.ts', async () => {
    // The re-exports are the whole reason ~27 importers of
    // `UnsupportedStorageLayoutError` and every importer of `loadStoredConfig`
    // are untouched by this row. A move that forgot one would be a compile
    // error somewhere far away; this says it here.
    const storage = await import('../storage.ts')
    const leaf = await import('../stored-config-load.ts')
    for (const name of [
      'loadStoredConfig',
      'UnsupportedStorageLayoutError',
      'getNetworkProxySettings',
      'resetCorruptedConfigCopyLatchForTests',
      'CONFIG_FILE_NAME',
    ] as const) {
      expect({ name, same: (storage as Record<string, unknown>)[name] === (leaf as Record<string, unknown>)[name] })
        .toEqual({ name, same: true })
    }
    // …and the two modules that took the other three symbols.
    const validators = await import('../validators.ts')
    const vocabulary = await import('../cross-session-inbound-vocabulary.ts')
    const paths = await import('../paths.ts')
    expect((storage as Record<string, unknown>).getToolIconsDir).toBe((paths as Record<string, unknown>).getToolIconsDir)
    expect((storage as Record<string, unknown>).describeUnrecognizedCrossSessionInbound)
      .toBe((vocabulary as Record<string, unknown>).describeUnrecognizedCrossSessionInbound)
    expect((validators as Record<string, unknown>).StoredConfigTopLevelSchema)
      .toBe((leaf as Record<string, unknown>).StoredConfigTopLevelSchema)
  })
})
