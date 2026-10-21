#!/usr/bin/env bun
/**
 * check-i18n-parity.ts — CI-safe locale parity check.
 *
 * Verifies every non-English locale has the same keys as en.json. Plural
 * variants (`_zero` / `_one` / `_two` / `_few` / `_many` / `_other`) are
 * allowed to diverge from English because languages have different plural
 * rules (e.g. Polish needs `_few`, Japanese has no plural distinction).
 *
 * A locale file may therefore have an `X_few` key when en.json has the `X_one` /
 * `X_other` pair — and ONLY then. A half-built English family no longer excuses
 * anything: see the P6.983 paragraph below.
 *
 * Exits 0 when all locales match en.json; 1 with a diagnostic otherwise.
 *
 * Scope: this script intentionally only checks locale files under
 * `packages/shared/src/i18n/locales`. It does NOT scan for hardcoded
 * strings — that's the job of `scripts/lint-i18n-staged.sh` (pre-commit).
 *
 * P6.973 added the second half: plural-family COMPLETENESS, over every locale
 * INCLUDING `en.json`. The key-set comparison above structurally cannot see it.
 * A family incomplete IDENTICALLY in both locales has identical key sets and
 * passes; `en.json` is the reference and is never compared with anything; and a
 * SECOND escape used to excuse any extra plural form whose English base was
 * present unpluralized — which silently excused one whose English family was
 * merely half-built. `settings.provenance.codexStateSupplies` sat with `_other`
 * and no `_one` in both locales while this script exited 0 and
 * `locale-parity.test.ts` — the only reader that looked — was red on three
 * assertions.
 *
 * P6.983 deleted that second escape, so the hole is closed by construction
 * rather than by a completeness pass catching it afterwards. Measured over this
 * tree the day it went (2026-09-10, both locales, re-derivable in one pass):
 * en 2702 keys / 69 plural families / **0** carrying the unsuffixed base, ru
 * 2768 / 69 / **0**; of ru's 66 extra plural keys all 66 are excused by the
 * surviving `_one`+`_other` test and **0** by the deleted one, so nothing in the
 * tree changes verdict. What it costs is stated rather than hidden: a locale
 * needing `X_few` where English genuinely has an unpluralized `X` and no plural
 * family at all is now an extra key. That shape does not exist here; when it
 * arrives, the English family is what should be built, not this escape restored.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const LOCALES_DIR = resolve(
  import.meta.dir ?? new URL('.', import.meta.url).pathname,
  '..',
  'packages',
  'shared',
  'src',
  'i18n',
  'locales',
)

const PLURAL_SUFFIX = /_(?:zero|one|two|few|many|other)$/

const pluralBase = (key: string): string => key.replace(PLURAL_SUFFIX, '')
const isPluralKey = (key: string): boolean => PLURAL_SUFFIX.test(key)

type Locale = Record<string, string>

const loadLocale = (path: string): Locale =>
  JSON.parse(readFileSync(path, 'utf-8')) as Locale

/**
 * Every `_one` without its `_other` and every `_other` without its `_one`, in
 * ONE locale's key set. Only that pair is required: `_zero`/`_two`/`_few`/
 * `_many` are per-language and their absence is correct in most languages,
 * while a family carrying neither `_one` nor `_other` is not a count-driven
 * family at all. Pure, so a test can state a key set by hand.
 */
export function findPluralOrphans(lang: string, keys: readonly string[]): string[] {
  const present = new Set(keys)
  const orphans: string[] = []
  for (const key of keys) {
    if (!isPluralKey(key)) continue
    const base = pluralBase(key)
    const suffix = key.slice(base.length + 1)
    if (suffix === 'one' && !present.has(`${base}_other`)) {
      orphans.push(`${lang}.json: ${key} exists but ${base}_other is missing`)
    }
    if (suffix === 'other' && !present.has(`${base}_one`)) {
      orphans.push(`${lang}.json: ${key} exists but ${base}_one is missing`)
    }
  }
  return orphans
}

/**
 * Is a key that a non-English locale carries and `en.json` does not LEGITIMATE?
 *
 * Exactly one shape is: an extra plural form of a family English pluralizes,
 * i.e. one whose `_one` AND `_other` are both in English. Languages differ in
 * how many categories they need — Russian wants `_few`/`_many`, Japanese wants
 * none — so demanding an English twin for each would fault a correct locale.
 *
 * There used to be a second escape, on the unsuffixed base being an English key.
 * It excused an extra form whose English family was merely half-built, which is
 * the hole P6.973 was born from; P6.983 deleted it after measuring that zero
 * families in either locale exercised it. Pure, so a test can state a key set by
 * hand rather than depend on the tree's current population.
 */
export function isExcusedExtraKey(key: string, enKeys: ReadonlySet<string>): boolean {
  if (!isPluralKey(key)) return false
  const base = pluralBase(key)
  return enKeys.has(`${base}_one`) && enKeys.has(`${base}_other`)
}

/**
 * The gate itself. Behind `import.meta.main` (the house pattern, and 23 other
 * `scripts/*.ts` do it) so that importing `findPluralOrphans` for a test runs
 * no check and can never reach the `process.exit` below — a module body that
 * exits kills the test runner at IMPORT time and reports exit 0 with zero
 * tests executed.
 */
export function main(): number {
  const en = loadLocale(resolve(LOCALES_DIR, 'en.json'))
  const enKeys = new Set(Object.keys(en))

  const localeFiles = readdirSync(LOCALES_DIR).filter(
    (f) => f.endsWith('.json') && f !== 'en.json',
  )

  const errors: string[] = []
  for (const file of localeFiles.sort()) {
    const lang = file.replace('.json', '')
    const locale = loadLocale(resolve(LOCALES_DIR, file))
    const otherKeys = new Set(Object.keys(locale))

    const missing: string[] = []
    for (const key of enKeys) {
      if (!otherKeys.has(key)) missing.push(key)
    }

    const extra: string[] = []
    for (const key of otherKeys) {
      if (enKeys.has(key)) continue
      if (isExcusedExtraKey(key, enKeys)) continue
      extra.push(key)
    }

    if (missing.length) {
      errors.push(
        `${lang}.json: ${missing.length} keys missing (e.g. ${missing.slice(0, 3).join(', ')})`,
      )
    }
    if (extra.length) {
      errors.push(
        `${lang}.json: ${extra.length} extra keys (e.g. ${extra.slice(0, 3).join(', ')})`,
      )
    }
  }

  // The completeness pass runs over EVERY locale, `en.json` included — it is
  // the reference for the key-set comparison above and therefore the one file
  // that comparison can never fault.
  const allFiles = [...localeFiles, 'en.json'].sort()
  for (const file of allFiles) {
    const lang = file.replace('.json', '')
    const locale = lang === 'en' ? en : loadLocale(resolve(LOCALES_DIR, file))
    errors.push(...findPluralOrphans(lang, Object.keys(locale)))
  }

  if (errors.length) {
    console.error('i18n parity check failed:')
    for (const e of errors) console.error(`  ${e}`)
    return 1
  }

  console.log(
    `i18n parity OK (${localeFiles.length} locales, ${enKeys.size} keys each; ` +
      `plural families complete in ${allFiles.length})`,
  )
  return 0
}

if (import.meta.main) process.exit(main())
