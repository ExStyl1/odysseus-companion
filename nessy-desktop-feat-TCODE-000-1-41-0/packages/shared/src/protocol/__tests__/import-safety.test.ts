/**
 * A green typecheck is not a green import.
 *
 * `tsc --noEmit` reports zero errors for a module that throws `ReferenceError`
 * the instant anything imports it. The way in is type ERASURE: a binding that
 * exists for the type system and not for the emitter, referenced from a
 * position the emitter keeps.
 *
 * The canonical spelling, and the one this file exists for, is the standard
 * compile-time exhaustiveness assertion:
 *
 * ```ts
 * declare const _unclassified: Exclude<Channel, Classified>  // erased
 * const _assert: never = _unclassified                       // NOT erased
 * ```
 *
 * `declare` erases; the assignment does not. Measured 2026-08-28 on a minimal
 * pair: `tsc --noEmit --strict` exits 0 with no output for both the erasing and
 * the safe spelling, and the erasing one throws
 * `ReferenceError: _unclassified is not defined` on import under Bun.
 *
 * The failure mode is why this is worth a test rather than a comment: it is not
 * one assertion failing, it is **the whole module failing to load**, and with it
 * every module that re-exports it — here, the entire `protocol` barrel. That is
 * exactly what happened while `routing.ts` was first written (P2.296): every
 * test importing `@nessy-agent/shared/protocol` failed to load, while every
 * typecheck stayed green.
 *
 * The safe spelling is `type AssertNever<T extends never> = true` plus a real
 * `= true` initialiser (see `routing.ts`) — a binding the emitter keeps.
 *
 * So this file imports every module in `protocol/` **at runtime**. It is
 * deliberately not an assertion about any module's contents: the invariant is
 * "importing it does not throw", and only an actual import can prove it. A
 * typecheck cannot, and neither can a test that merely names the module in a
 * type position.
 *
 * The scan is a directory read rather than a hand-written list so a module added
 * later is covered without anyone remembering to add it here — the modules that
 * most need this are the ones no other test imports.
 */
import { describe, test, expect } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const PROTOCOL_DIR = join(import.meta.dir, '..')

const MODULES = readdirSync(PROTOCOL_DIR, { withFileTypes: true })
  .filter(entry => entry.isFile())
  .map(entry => entry.name)
  .filter(name => name.endsWith('.ts'))
  .filter(name => !name.endsWith('.d.ts'))
  .filter(name => !name.endsWith('.test.ts'))
  .sort()

describe('every protocol module imports at runtime', () => {
  /**
   * Without this, an empty or mis-filtered scan makes every assertion below
   * vacuous and the suite green — the same shape as a test double that drops the
   * argument under test. The floor and the two named modules are the positive
   * control: `routing.ts` carries the compile-time assertions this file guards,
   * and `index.ts` is the barrel whose failure takes the package down with it.
   */
  test('the directory scan actually found the modules it is meant to guard', () => {
    expect(MODULES).toContain('routing.ts')
    expect(MODULES).toContain('channels.ts')
    expect(MODULES).toContain('index.ts')
    expect(MODULES.length).toBeGreaterThanOrEqual(8)
  })

  for (const name of MODULES) {
    test(`${name} imports without throwing`, async () => {
      // A dynamic import, not a static one: a static import failing would take
      // this test FILE down before any test reported, and the output would name
      // the loader rather than the module. Awaiting it here means a broken
      // module fails one named test and the rest still report.
      const mod = (await import(join(PROTOCOL_DIR, name))) as Record<string, unknown>
      expect(mod).toBeDefined()
    })
  }
})
