/**
 * F1.365 (origin t-artifacts research of the upstream-refresh session,
 * 2026-09-23; DECIDED by the controller the same day) — the tool-result secret
 * scan masks a JWT, an Ory token and a Bearer credential, and its visible
 * notice counts each one.
 *
 * `TOOL_RESULT_SECRET_RULES` recognised no JWT, `ory_*` or `Bearer` shape, so a
 * Nestor-Token JWT (it lives two years) or a dp (Ory) session token printed by a
 * tool reached the model and the session JSONL unmasked. The three rules are the
 * ones the 1.42.0 plan's UA1.17 publish guard writes locally, now in the shared
 * table, on every runtime.
 *
 * Every token below is built from random bytes — none was ever issued.
 */
import { describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'

import {
  scanToolResultForSecrets,
  scrubToolResultText,
  TOOL_RESULT_SECRET_RULE_NAMES,
} from '../tool-result-secret-scan.ts'

const b64url = (value: Buffer | string): string => Buffer.from(value).toString('base64url')

/** A JWT-shaped value: a real-looking header, a random claim and a random signature. */
function fakeJwt(): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ sub: randomBytes(8).toString('hex'), exp: 4102444800 }))
  return `${header}.${payload}.${b64url(randomBytes(32))}`
}
const fakeOry = (kind: 'at' | 'rt' | 'st' | 'ht'): string => `ory_${kind}_${b64url(randomBytes(24))}`
const fakeBearerValue = (): string => randomBytes(20).toString('hex')

describe('F1.365 · three new rules, masked and counted', () => {
  it('the table names them', () => {
    for (const name of ['jwt', 'ory-token', 'bearer']) expect(TOOL_RESULT_SECRET_RULE_NAMES).toContain(name)
  })

  it('(+) a JWT, every Ory kind and a Bearer credential are masked, and the notice counts each value', () => {
    const jwt = fakeJwt()
    const ory = (['at', 'rt', 'st', 'ht'] as const).map(fakeOry)
    const bearer = fakeBearerValue()
    const input = [
      `Nestor-Token: ${jwt}`,
      ...ory.map(token => `dp session: ${token}`),
      `curl -H 'Authorization: Bearer ${bearer}' https://example.test`,
    ].join('\n')

    const scan = scanToolResultForSecrets(input)

    for (const secret of [jwt, ...ory, bearer]) {
      expect(scan.text).not.toContain(secret)
      expect(scan.notice ?? '').not.toContain(secret)
    }
    expect(scan.counts).toEqual([
      { rule: 'jwt', count: 1 },
      { rule: 'ory-token', count: 4 },
      { rule: 'bearer', count: 1 },
    ])
    expect(scan.notice).toContain('6 credential-shaped values redacted')
    expect(scan.notice).toContain('jwt×1, ory-token×4, bearer×1')
    expect(scan.text).toContain('Nestor-Token: [REDACTED:jwt]')
    expect(scan.text).toContain("Authorization: [REDACTED:bearer]' https://example.test")
  })

  it('a Bearer carrying a JWT or a known token is reported by the more specific rule, once', () => {
    const jwt = fakeJwt()
    const pat = `ghp_${'C'.repeat(36)}`
    const scan = scanToolResultForSecrets(`Authorization: Bearer ${jwt}\nAuthorization: bearer ${pat}`)
    expect(scan.counts).toEqual([
      { rule: 'github-pat', count: 1 },
      { rule: 'jwt', count: 1 },
    ])
    expect(scan.text).toBe('Authorization: Bearer [REDACTED:jwt]\nAuthorization: bearer [REDACTED:github-pat]')
  })

  it('(boundary) a JWT inside a code block the user asked to decode is still masked, and the notice says so', () => {
    const jwt = fakeJwt()
    const text = scrubToolResultText(`Decoded below:\n\`\`\`\n${jwt}\n\`\`\`\n`)
    expect(text).not.toContain(jwt)
    expect(text).toContain('```\n[REDACTED:jwt]\n```')
    expect(text).toContain('[nessy] 1 credential-shaped value redacted from this tool result (jwt×1).')
  })

  it('(−) a plain base64 blob, a short "Bearer x" and a 19-character bearer value are untouched', () => {
    const blob = randomBytes(48).toString('base64')
    const output = [
      `data: ${blob}`,
      'Bearer x',
      `Bearer ${'a'.repeat(19)}`,
      'Bearer with no value',
      'ory_at_short',
      'eyJhbGciOi.notajwt',
    ].join('\n')
    const scan = scanToolResultForSecrets(output)
    expect(scan.counts).toEqual([])
    expect(scan.text).toBe(output)
    expect(scan.notice).toBeUndefined()
  })
})
