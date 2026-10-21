/**
 * F1.561 (origin WJ-bg proposed row 1, 2026-09-24) — WHEN a narrow
 * `mock.module` stub amputates a module, measured on this runtime.
 *
 * AGENTS.md §Traps, `check-mock-module-spread.ts`'s docblock and the
 * narrow-first-party preamble of `mock-module-ratchet-baseline.txt` said a stub
 * without a spread amputates the module: every name it does not list is gone.
 * WJ-bg's probes A and B (F1.552, bun 1.3.14) showed that holds only for one
 * load order:
 *
 * - **A — the module was already loaded when the stub went in:** the stub
 *   replaces the names it lists, in place, and every UNLISTED export stays real,
 *   on the namespace an importer already holds and on a later import.
 * - **B — nothing had loaded the module yet:** a later import gets the stub's
 *   object as the module, and an unlisted export is `undefined`. This is the
 *   shape that amputates, and the one D1.440-B / D1.442 paid for.
 *
 * So a narrow stub harms a later file only if the stubbed module was not yet in
 * the process's registry when the stub was installed. That depends on what ran
 * before it in the same process, which a text scanner cannot see, so the gate
 * still ratchets the shape and says so.
 *
 * The two modules here are written to a temp directory by this file, so nothing
 * else can have loaded them first, and no other file can import them after: the
 * stubs cannot leak, and neither probe needs a restore. Each probe also checks
 * that its stub DID apply (a listed name answers the stub's value), so an
 * unlisted export reading real cannot come from a stub that silently did
 * nothing.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'mock-module-load-order-'))
const MODULE_SOURCE = [
  "export function listed() { return 'real listed' }",
  "export function unlisted() { return 'real unlisted' }",
  '',
].join('\n')
const loadedFirst = join(root, 'loaded-first.ts')
const neverLoaded = join(root, 'never-loaded.ts')
writeFileSync(loadedFirst, MODULE_SOURCE)
writeFileSync(neverLoaded, MODULE_SOURCE)

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

type Probe = { listed?: () => string; unlisted?: () => string }

describe('F1.561 — a narrow mock.module stub amputates only a module nothing has loaded yet', () => {
  test('A: loaded first, then stubbed narrowly — an unlisted export stays real', async () => {
    const ns = (await import(loadedFirst)) as Probe
    expect(typeof ns.unlisted).toBe('function')

    mock.module(loadedFirst, () => ({ listed: () => 'stub listed' }))

    // The stub applied, in place: the namespace this file already holds answers it.
    expect(ns.listed?.()).toBe('stub listed')
    // ...and the name it does not list is still the real one, here and on a later import.
    expect(ns.unlisted?.()).toBe('real unlisted')
    const again = (await import(loadedFirst)) as Probe
    expect(again.listed?.()).toBe('stub listed')
    expect(again.unlisted?.()).toBe('real unlisted')
  })

  test('B: stubbed narrowly before anything loaded it — the unlisted export is gone', async () => {
    mock.module(neverLoaded, () => ({ listed: () => 'stub listed' }))

    const later = (await import(neverLoaded)) as Probe
    expect(later.listed?.()).toBe('stub listed')
    expect(later.unlisted).toBeUndefined()
  })
})
