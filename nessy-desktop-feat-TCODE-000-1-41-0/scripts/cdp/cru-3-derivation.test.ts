/**
 * CRU-3's derivation, against the module it derives from — P6.573.
 *
 * The case now computes its whole cost inventory out of `RUNTIME_SWITCH_COSTS`
 * instead of restating six rows of it. That removes the staleness this row was
 * born for and introduces exactly one new way to be wrong: a parse that reads
 * the module and gets a DIFFERENT table out of it than the module itself
 * produces. Nothing else in the tree can see that — no case file is imported by
 * `packages/` or `apps/`, which is precisely why the hand-written table could sit
 * six rows wide against a 34-row module for three waves with every suite green.
 *
 * So this file is the instrument. It runs the case's parser over the real source
 * and compares, leg by leg, against `runtimeSwitchCosts` itself.
 *
 * **The comparison is made through a dynamic import with a COMPUTED specifier,
 * and that is deliberate.** `runtime-switch-costs.ts` imports `@config/models`
 * and `@nessy-agent/shared/agent/backend/runtime-vocabulary`;
 * `scripts/cdp/tsconfig.json` maps neither, and widening it would drag the
 * shared package's type graph into the harness's typecheck — the trade
 * `lib/model-window.ts` already refused for this harness in its own words ("no
 * case in `scripts/cdp/` imports from `@nessy-agent/*`; dragging the shared
 * package into a harness process changes what the harness is"). A specifier tsc
 * cannot resolve statically keeps the harness's own program unchanged while bun
 * resolves it at run time, which is all this test needs. `@config/models` is a
 * TYPE-only import in that module, so nothing of it survives to run time.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { costFires, LOCALE_KEYS, parseCostRows } from './cases/cru-3.ts'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const COST_SOURCE = 'apps/electron/src/renderer/components/app-shell/input/runtime-switch-costs.ts'
const SOURCE = readFileSync(join(REPO_ROOT, COST_SOURCE), 'utf8')

/** Every ordered pair the dialog can be asked about, plus the two that yield nothing. */
const LEGS: readonly (readonly [string, string])[] = [
  ['pi', 'codex-runtime'],
  ['pi', 'anthropic'],
  ['codex-runtime', 'pi'],
  ['anthropic', 'pi'],
  ['anthropic', 'codex-runtime'],
  ['codex-runtime', 'anthropic'],
  // A switch that changes no runtime, and a runtime the table declines to
  // describe — `runtimeSwitchCosts` yields nothing for both, and a derivation
  // that manufactured a row out of a `null` claim would be the worst failure
  // available here: a dialog told to warn about a capability nobody has.
  ['pi', 'pi'],
  ['pi', 'nestor-cloud-agent'],
  ['nestor-cloud-agent', 'pi'],
]

/**
 * The three exports this file reads, spelled the way `runtime-switch-costs.ts`
 * spells them. `RuntimeSwitchClaim` is restated inline rather than widened to
 * `unknown`: a claim vocabulary that grew a fourth value would then fail HERE,
 * which is the one place that would notice, instead of being compared as
 * `unknown` against a parser that maps everything it does not recognise to
 * `null`.
 */
interface CostModule {
  runtimeSwitchCosts: (from: string, to: string) => { id: string; bodyKey: string; certainty: string }[]
  RUNTIME_SWITCH_COST_BODY_KEYS: readonly string[]
  RUNTIME_SWITCH_COST_CLAIMS: Record<string, Record<string, boolean | 'conditional' | 'unmeasured' | null>>
}

async function costModule(): Promise<CostModule> {
  const specifier = ['..', '..', COST_SOURCE].join('/')
  return await import(specifier) as CostModule
}

describe('parseCostRows', () => {
  it('reads every row the module declares, with all four claims', () => {
    const rows = parseCostRows(SOURCE)
    expect(rows.length).toBeGreaterThan(20)
    // The parser's own structural control: it returns [] rather than a partial
    // read, so a non-empty result already means "as many rows as `id:` fields".
    // Asserted here against the source directly, because that control is the
    // one thing between this case and the defect it was born for.
    const declared = (SOURCE.match(/^ {4}id: '/gm) ?? []).length
    expect(rows.length).toBe(declared)
    for (const row of rows) {
      expect(Object.keys(row.on).sort()).toEqual(['anthropic', 'codex-runtime', 'nestor-cloud-agent', 'pi'])
      expect(['files', 'abilities']).toContain(row.consequence)
      expect(row.bodyKey.startsWith('chat.runtimeSwitch.')).toBe(true)
    }
  })

  it('refuses a partial read rather than returning a short table', () => {
    // A row written in a shape the pattern cannot see — here an extra field
    // after `on` — is the failure mode that matters: skipped silently, it
    // produces a table short by one row, which scores a correct dialog as a
    // failure and a broken one as a pass. The control is the SAME source with
    // the same edit reverted, so the two arms differ by one clause and nothing
    // else.
    const broken = SOURCE.replace(
      "    id: 'preToolCheck',",
      "    id: 'preToolCheck',\n    unexpectedField: { nested: 'value' },",
    )
    expect(broken).not.toBe(SOURCE)
    expect(parseCostRows(broken)).toEqual([])
    expect(parseCostRows(SOURCE).length).toBeGreaterThan(20)
  })

  it('returns nothing when the table is not where it says it is', () => {
    expect(parseCostRows('export const SOMETHING_ELSE = 1\n')).toEqual([])
    expect(parseCostRows(SOURCE.replace('const RUNTIME_SWITCH_COSTS', 'const RENAMED_COSTS'))).toEqual([])
  })
})

describe('costFires', () => {
  it('fires only when the source definitely has it and the target does not', () => {
    expect(costFires(true, false)).toBe('measured')
    expect(costFires(true, 'conditional')).toBe('measured')
    expect(costFires(true, true)).toBeNull()
    // P2.484 — `'conditional'` on the SOURCE does not fire: warning about the
    // loss of something that may never have existed is noise, not safety.
    expect(costFires('conditional', false)).toBeNull()
    expect(costFires(false, false)).toBeNull()
    expect(costFires(null, false)).toBeNull()
  })

  it('carries an unmeasured endpoint under the marker instead of dropping it', () => {
    expect(costFires('unmeasured', false)).toBe('unmeasured')
    expect(costFires(true, 'unmeasured')).toBe('unmeasured')
    // The two `null` arms P6.562's docblock says to read: a source that CANNOT
    // have it loses nothing, and a target that has it outright keeps it.
    expect(costFires(false, 'unmeasured')).toBeNull()
    expect(costFires(null, 'unmeasured')).toBeNull()
    expect(costFires('unmeasured', true)).toBeNull()
  })
})

describe('the derivation against the module itself', () => {
  it('parses the same rows, keys and claims the module exports', async () => {
    const mod = await costModule()
    const rows = parseCostRows(SOURCE)
    expect(rows.map(row => row.bodyKey)).toEqual([...mod.RUNTIME_SWITCH_COST_BODY_KEYS])
    expect(Object.fromEntries(rows.map(row => [row.id, row.on]))).toEqual(mod.RUNTIME_SWITCH_COST_CLAIMS)
  })

  it('computes the same list, in the same order, for every leg', async () => {
    const mod = await costModule()
    const rows = parseCostRows(SOURCE)
    const switchable = (runtime: string): boolean =>
      rows.every(row => row.on[runtime] !== undefined && row.on[runtime] !== null)
    for (const [from, to] of LEGS) {
      const derived = from === to || !switchable(from) || !switchable(to)
        ? []
        : rows.flatMap(row => {
          const certainty = costFires(row.on[from]!, row.on[to]!)
          return certainty ? [`${row.id}:${certainty}`] : []
        })
      const actual = mod.runtimeSwitchCosts(from, to).map(cost => `${cost.id}:${cost.certainty}`)
      expect({ leg: `${from}>${to}`, rows: derived }).toEqual({ leg: `${from}>${to}`, rows: actual })
    }
  })

  it('every locale key the case reads resolves in BOTH locales', () => {
    // P6.1019. `costHeading` and `crossRuntimeTitle` were RESTATED in the case in
    // both locales until this row, and a restated string in a case file is the one
    // staleness nothing in `bun test` can see — no suite in `packages/` or `apps/`
    // imports a case module. They are read through `lookup` now, which BLOCKS on a
    // missing key; this is the offline instrument that says the keys are still
    // there, so a rename surfaces here rather than at a sitting.
    for (const locale of ['en', 'ru'] as const) {
      const strings = JSON.parse(readFileSync(
        join(REPO_ROOT, 'packages', 'shared', 'src', 'i18n', 'locales', `${locale}.json`),
        'utf8',
      )) as Record<string, unknown>
      for (const key of Object.values(LOCALE_KEYS)) {
        expect({ locale, key, type: typeof strings[key] }).toEqual({ locale, key, type: 'string' })
        expect((strings[key] as string).length).toBeGreaterThan(0)
      }
      // The boundary: a key that does not exist must read as missing, so the
      // check above cannot be passing on an empty-object read of the file.
      expect(strings['chat.runtimeSwitch.aKeyNobodyDeclared']).toBeUndefined()
    }
    // `costHeading` is the one with an interpolation, and the case fills it.
    const en = JSON.parse(readFileSync(
      join(REPO_ROOT, 'packages', 'shared', 'src', 'i18n', 'locales', 'en.json'), 'utf8',
    )) as Record<string, string>
    expect(en[LOCALE_KEYS.heading]).toContain('{{toRuntime}}')
  })

  it('the two legs of a real direction are different lists — the case control', async () => {
    // CRU-3's control used to be "the return leg lists nothing", which was a
    // property of the row set and stopped holding on 2026-09-06. What replaced
    // it is asserted here so the case's control cannot quietly become vacuous:
    // if these two ever became the same list, a hardcoded table would satisfy
    // both legs and the case would be proving nothing.
    const mod = await costModule()
    const out = mod.runtimeSwitchCosts('pi', 'codex-runtime').map(cost => cost.id)
    const back = mod.runtimeSwitchCosts('codex-runtime', 'pi').map(cost => cost.id)
    expect(out.length).toBeGreaterThan(0)
    expect(back.length).toBeGreaterThan(0)
    expect([...out].sort()).not.toEqual([...back].sort())
  })
})
