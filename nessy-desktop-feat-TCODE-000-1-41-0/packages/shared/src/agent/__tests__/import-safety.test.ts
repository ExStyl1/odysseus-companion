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
 * that re-exports it. This directory holds two live ambient `declare const`s
 * (`options.ts`, `permissions-config.ts`) and module-scope `never` assertions
 * in `backend/runtime-vocabulary.ts`, so it is one edit from that shape.
 *
 * WHY A SCAN AND NOT A LIST. The protection this file replaces was a
 * coincidence of test topology: a module was safe only because some unrelated
 * test happened to import it. Nobody owned that topology and nothing announced
 * when it stopped holding. A hand-written list would recreate exactly that
 * defect — it is a topology someone has to maintain, and 157 modules is well
 * past what anyone maintains by hand.
 *
 * WHY THE SCAN RECURSES. A non-recursive scan of this directory covers 50 of
 * 157 modules and reports itself green, which is the same defect one level
 * down: `backend/`, `core/`, `memory/`, `pi-harness/` and `local-tools/` hold
 * the other 107. Measured 2026-08-28, the full recursive scan costs ~1.3s warm
 * for all 157 and every one of them imports clean, so there is no reason to
 * narrow it. The subdirectory assertions in the vacuity guard below exist to
 * make a future narrowing fail loudly instead of silently.
 *
 * Sibling guard, same shape: `packages/shared/src/protocol/__tests__/import-safety.test.ts`.
 */
import { describe, test, expect } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const AGENT_DIR = join(import.meta.dir, '..')

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
    // `.test.ts` matters here beyond tidiness: 38 test files sit beside their
    // subjects rather than in a `__tests__` directory, so without this filter
    // the scan would re-run a large slice of the suite as a side effect.
    if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.test.ts')) continue
    found.push(full)
  }
  return found
}

// Relative paths, not bare filenames: `index.ts`, `types.ts`, `event-adapter.ts`
// and `tool-executor.ts` each occur in several subdirectories, and bare names
// would collide into indistinguishable test names.
const MODULES = scanModules(AGENT_DIR)
  .map(file => relative(AGENT_DIR, file))
  .sort()

const REQUIRED_SUBTREES = [
  'core/',
  'memory/',
  'backend/',
  'backend/nestor-cloud/',
  'pi-harness/',
  'local-tools/',
]

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

describe('every agent module imports at runtime', () => {
  /**
   * A scan that matches nothing — or matches only the top level — makes every
   * assertion below vacuous and the suite green, the same shape as a test double
   * that drops the argument under test. It looks exactly like success, which is
   * why it is asserted rather than assumed. Proven non-decorative by mutation:
   * filtering the scan to nothing turns this into the only failing test.
   */
  test('the directory scan actually found the modules it is meant to guard', () => {
    expect(MODULES).toContain('index.ts')
    for (const subtree of REQUIRED_SUBTREES) {
      expect(MODULES.some(name => name.startsWith(subtree))).toBe(true)
    }
    // Floor set below the measured 157 but far above the 50 a non-recursive
    // scan would find, so losing the recursion fails here rather than passing
    // quietly with two thirds of the directory unguarded.
    expect(MODULES.length).toBeGreaterThanOrEqual(120)
  })

  for (const name of MODULES) {
    test(`${name} imports without throwing`, async () => {
      // Dynamic, not static: a static import of a broken module takes this test
      // FILE down before any test reports, and names the loader rather than the
      // module. Awaiting it here means one named test fails and the rest report.
      const mod = (await import(join(AGENT_DIR, name))) as Record<string, unknown>
      expect(mod).toBeDefined()
    }, IMPORT_TIMEOUT_MS)
  }
})
