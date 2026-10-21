/**
 * P6.789 — one redaction rule, one fallback string.
 *
 * The interceptor keeps a deliberate third copy of `redactProxyUrl` (its own
 * docblock records the measurement that keeps it a copy), and the copy's
 * fallback read `(invalid proxy URL)` while `config/config-doctor.ts` and the
 * `agent/diagnostics.ts` importer beside it read `(unparseable proxy URL)`. Both
 * surfaces print a proxy string a user pastes into a ticket, and this copy's
 * output is not log-only: it lands in the HTML-error-page message the user sees.
 *
 * So the assertion that matters is the CROSS-MODULE one — the copy against the
 * canonical function — because a test that only pinned this module's own literal
 * would stay green through exactly the drift the row exists to close.
 *
 * `NESSY_INTERCEPTOR_DISABLE_AUTO_INSTALL` before the dynamic import, the way
 * every sibling interceptor suite does it: importing the module otherwise
 * replaces `globalThis.fetch` for the rest of the test process.
 */
import { beforeAll, describe, expect, it } from 'bun:test'

import { redactProxyUrl as canonicalRedactProxyUrl } from '../config/config-doctor.ts'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '../testing/module-graph-budgets.ts'

let redactProxyUrl: typeof import('../unified-network-interceptor.ts').redactProxyUrl

beforeAll(async () => {
  process.env.NESSY_INTERCEPTOR_DISABLE_AUTO_INSTALL = '1'
  ;({ redactProxyUrl } = await import('../unified-network-interceptor.ts'))
}, MODULE_GRAPH_HOOK_BUDGET_MS)

describe('the interceptor copy of redactProxyUrl', () => {
  it('NEGATIVE — reports an unparseable value in the same words as the canonical rule', () => {
    // Read into a local before asserting: never assert a shape with a matcher
    // and then read the same object (AGENTS.md §Traps, `toMatchObject`).
    const fromCopy = redactProxyUrl('not a url at all')
    const fromCanonical = canonicalRedactProxyUrl('not a url at all')

    expect(fromCopy).toBe('(unparseable proxy URL)')
    // The load-bearing line. `toBe` against the canonical output is what a
    // future edit to either side has to keep true.
    expect(fromCopy).toBe(fromCanonical)
    expect(fromCopy).not.toContain('invalid')
  })

  it('POSITIVE — strips credentials and keeps scheme, host and port, identically', () => {
    const withCredentials = 'http://alice:hunter2@proxy.internal:3128'

    const fromCopy = redactProxyUrl(withCredentials)
    const fromCanonical = canonicalRedactProxyUrl(withCredentials)

    expect(fromCopy).toBe('http://proxy.internal:3128')
    expect(fromCopy).toBe(fromCanonical)
    // The whole reason the rule exists: neither half of the credential survives.
    expect(fromCopy).not.toContain('alice')
    expect(fromCopy).not.toContain('hunter2')
  })

  it('agrees with the canonical rule on the values a real proxy env carries', () => {
    for (const value of [
      '',
      'http://proxy.internal:3128',
      'https://proxy.internal',
      'http://proxy.internal:3128/',
      'socks5://user@127.0.0.1:1080',
      '3128',
    ]) {
      const fromCopy = redactProxyUrl(value)
      expect(fromCopy).toBe(canonicalRedactProxyUrl(value))
    }
  })
})
