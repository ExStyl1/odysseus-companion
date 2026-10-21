/**
 * A green typecheck is not a green import.
 *
 * `tsc --noEmit` reports zero errors for a module that throws `ReferenceError`
 * the instant anything imports it. The way in is type ERASURE: a binding that
 * exists for the type system and not for the emitter, referenced from a
 * position the emitter keeps.
 *
 * ```ts
 * declare const _unclassified: Exclude<Channel, Classified>  // erased
 * const _assert: never = _unclassified                       // NOT erased
 * ```
 *
 * `declare` erases; the assignment does not. The failure is not one assertion
 * going red — it is the WHOLE MODULE failing to load, and with it every module
 * that re-exports it. This directory is the live case: `channel-map-parity.test.ts`
 * carries module-scope exhaustiveness assertions of exactly this family, and the
 * safe spelling (`type AssertNever<T extends never> = true` plus a real `= true`
 * initialiser) is one keystroke from the erasing one.
 *
 * WHY A SCAN AND NOT A LIST. The protection this file replaces was a
 * coincidence of test topology: a module was safe only because some unrelated
 * test happened to import it. Nobody owned that topology and nothing announced
 * when it stopped holding. A hand-written list would recreate exactly that
 * defect — it is a topology someone has to maintain. The scan covers a module
 * added tomorrow without anyone remembering this file exists.
 *
 * Measured here 2026-08-28: six of this directory's seven modules are reachable
 * from some existing test; `index.ts` — the barrel, whose failure takes every
 * consumer with it — is reachable from NONE. Tests import the leaves directly,
 * so the module with the widest blast radius is the one nothing loads. That is
 * the accident this file removes.
 *
 * Sibling guard, same shape: `packages/shared/src/protocol/__tests__/import-safety.test.ts`.
 */
import { describe, test, expect } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const TRANSPORT_DIR = join(import.meta.dir, '..')

function scanModules(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      found.push(...scanModules(full))
      continue
    }
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.test.ts')) continue
    found.push(full)
  }
  return found
}

const MODULES = scanModules(TRANSPORT_DIR)
  .map(file => relative(TRANSPORT_DIR, file))
  .sort()

// Transpiling the dependency graph is charged to whichever import touches it
// first, so the FIRST test here can take tens of seconds on a cold cache while
// the other 156 take milliseconds. Measured 2026-08-28: a cold
// `apps/electron/src/transport` scan billed 17.3s to `channel-map.ts` and 9.3s
// to `client.ts`, and under load `client.ts` blew bun's default 5000ms per-test
// timeout and failed a guard whose subject was perfectly healthy.
//
// So each import gets an explicit, generous budget. This is NOT a performance
// assertion — the defect being guarded against is a module that THROWS, which
// fails in microseconds. A timeout here would only ever mean "the machine was
// busy", and a guard that goes red for that reason is one people learn to
// ignore, which costs more than the guard is worth.
const IMPORT_TIMEOUT_MS = 60_000

describe('every transport module imports at runtime', () => {
  /**
   * A scan that matches nothing makes every assertion below vacuous and the
   * suite green — the same shape as a test double that drops the argument under
   * test. This is the failure mode the guard is most likely to acquire, because
   * it looks exactly like success. Proven non-decorative by mutation: filtering
   * the scan to nothing turns this into the only failing test.
   */
  test('the directory scan actually found the modules it is meant to guard', () => {
    expect(MODULES).toContain('channel-map.ts')
    expect(MODULES).toContain('routed-client.ts')
    expect(MODULES).toContain('index.ts')
    expect(MODULES.length).toBeGreaterThanOrEqual(6)
  })

  for (const name of MODULES) {
    test(`${name} imports without throwing`, async () => {
      // Dynamic, not static: a static import of a broken module takes this test
      // FILE down before any test reports, and names the loader rather than the
      // module. Awaiting it here means one named test fails and the rest report.
      const mod = (await import(join(TRANSPORT_DIR, name))) as Record<string, unknown>
      expect(mod).toBeDefined()
    }, IMPORT_TIMEOUT_MS)
  }
})
