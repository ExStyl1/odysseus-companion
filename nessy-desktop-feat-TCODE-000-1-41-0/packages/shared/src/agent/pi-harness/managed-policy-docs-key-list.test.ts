/**
 * F1.1148 — the docs-site "Managed Pi policy" section lists the schema's keys, and
 * the denominator is the array every whole-key-set invariant already reads
 * ({@link MANAGED_PI_POLICY_KEYS}), never prose: the section used to name five of
 * the keys while the schema accepted fifty-two. A key added to the array and not
 * to the page (either locale) turns this red with the key's name.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MANAGED_PI_POLICY_KEYS } from './managed-policy.ts'

const PAGES = {
  en: '../../../../../docs-site/content/core-concepts/permissions.md',
  ru: '../../../../../docs-site/content/ru/core-concepts/permissions.md',
} as const

/** The `### Managed Pi policy` section, up to the next heading of the same or a higher level. */
function managedSection(relative: string): string {
  const text = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
  const start = text.indexOf('\n### Managed Pi policy\n')
  if (start < 0) return ''
  const next = text.slice(start + 1).search(/\n#{1,3} /)
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next)
}

describe('the docs-site Managed Pi policy section names every schema key (F1.1148)', () => {
  for (const [locale, page] of Object.entries(PAGES)) {
    it(`${locale}: every key of MANAGED_PI_POLICY_KEYS appears as code`, () => {
      const section = managedSection(page)
      // Positive control: the section is found and is not a stub.
      expect(section).toContain('managed-policy.json')
      const missing = MANAGED_PI_POLICY_KEYS.filter(key => key !== 'schemaVersion' && !section.includes(`\`${key}\``))
      expect(missing).toEqual([])
    })
  }
})
