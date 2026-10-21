import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { CODEX_API_KEY_ENV } from '@nessy-agent/codex-responses-adapter/config-writer'

import {
  PRODUCT_WRITTEN_PROVIDER_KEY_ENV_NAMES,
  PROVIDER_KEY_ENV_NAMES,
} from '../provider-key-names.ts'

/**
 * DA2.20 — the list is only worth exporting if it cannot silently fall behind
 * the modules that write the names.
 *
 * Two bindings, chosen because each catches a way the old prose enumeration was
 * already wrong: `COMPANY_LLM_API_KEY` is asserted THROUGH `CODEX_API_KEY_ENV`
 * rather than retyped, and the names `resolveAuthEnvVars` writes are read out of
 * `llm-connections.ts` as source text, so a third `envVars.<NAME> =` assignment
 * added there fails here rather than showing up as an absence in a sitting six
 * weeks later.
 *
 * **What is deliberately NOT machine-checked, with the reason.** The module's
 * docblock records the measured relationship to `BLOCKED_ENV_VARS` — neither
 * list is a subset of the other, they share two names, and the blocked list
 * carried `CLAUDE_CODE_OAUTH_TOKEN` while the probe did not. Asserting that here
 * would bind this file to `packages/session-tools-core/src/runtime/sandbox-env.ts`
 * while DA2.22 is actively moving that list into a single export, and a guard
 * that reddens because a sibling row landed teaches the next reader to ignore
 * it. The measurement is dated in the docblock instead; when DA2.22 lands its
 * export, the assertion becomes cheap and safe to add.
 */
describe('DA2.20 — the provider-key name list', () => {
  it("spells codex's env key through the constant that defines it", () => {
    // Not a tautology: `scripts/cdp/cases/rs-16.ts` probed `CODEX_API_KEY`, and
    // this is the assertion that would have caught it. `CODEX_API_KEY_ENV`'s
    // VALUE is `COMPANY_LLM_API_KEY` — the two differ, which IS the defect.
    expect(CODEX_API_KEY_ENV).not.toBe('CODEX_API_KEY')
    expect(PROVIDER_KEY_ENV_NAMES as readonly string[]).toContain(CODEX_API_KEY_ENV)
    expect(PRODUCT_WRITTEN_PROVIDER_KEY_ENV_NAMES as readonly string[]).toContain(CODEX_API_KEY_ENV)
  })

  it('carries every name resolveAuthEnvVars writes a credential into', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'llm-connections.ts'), 'utf8')
    const start = source.indexOf('export async function resolveAuthEnvVars(')
    // The positive control on the slice: a renamed or moved function would read
    // as an empty body and make the loop below assert nothing at all.
    expect(start).toBeGreaterThan(0)
    const body = source.slice(start, source.indexOf('\n}', start))
    expect(body).toContain('const envVars: Record<string, string> = {}')

    const written = [...body.matchAll(/envVars\.([A-Z][A-Z0-9_]+) =/g)]
      .map(match => match[1] ?? '')
      // `ANTHROPIC_BASE_URL` is an endpoint, not a credential, and is the one
      // name this function sets that carries nothing secret.
      .filter(name => name !== 'ANTHROPIC_BASE_URL')

    // The anti-vacuum control on the extraction itself, as membership rather
    // than a count: a count would be a ratchet another lane's commit moves, and
    // these two are the names the function has written since it was written.
    expect(written).toContain('ANTHROPIC_API_KEY')
    expect(written).toContain('CLAUDE_CODE_OAUTH_TOKEN')

    for (const name of written) {
      expect(
        PRODUCT_WRITTEN_PROVIDER_KEY_ENV_NAMES as readonly string[],
        `${name}: written by resolveAuthEnvVars and absent from PRODUCT_WRITTEN_PROVIDER_KEY_ENV_NAMES`,
      ).toContain(name)
    }
  })

  it('keeps the written subset inside the probed union, with no duplicates', () => {
    // The boundary the two lists exist to hold apart: everything this product
    // writes must be probed, and the union may be wider — `ANTHROPIC_AUTH_TOKEN`
    // is the name the host DELETES rather than writes, and it is in the union
    // and not the subset precisely because an ambient one reaching a child is
    // the leak the probe is for.
    for (const name of PRODUCT_WRITTEN_PROVIDER_KEY_ENV_NAMES) {
      expect(PROVIDER_KEY_ENV_NAMES as readonly string[]).toContain(name)
    }
    expect(PRODUCT_WRITTEN_PROVIDER_KEY_ENV_NAMES as readonly string[])
      .not.toContain('ANTHROPIC_AUTH_TOKEN')
    expect(PROVIDER_KEY_ENV_NAMES as readonly string[]).toContain('ANTHROPIC_AUTH_TOKEN')

    expect(new Set(PROVIDER_KEY_ENV_NAMES).size).toBe(PROVIDER_KEY_ENV_NAMES.length)
    for (const name of PROVIDER_KEY_ENV_NAMES) expect(name.length).toBeGreaterThan(3)
  })
})
