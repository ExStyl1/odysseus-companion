/**
 * P3.67 — the credential-paired routing exception, pinned as a DECISION.
 *
 * `server-managed-settings.md#per-key-exceptions-across-managed-sources` carries
 * two exceptions to the per-variable merge. The telemetry unit is implemented
 * and tested next door (`managed-env.test.ts`). The second one is not, verbatim:
 *
 *   "**Credential-paired routing**: a source that pairs routing variables with a
 *   selected-source-only credential key, such as `apiKeyHelper` or
 *   `otelHeadersHelper`, contributes those routing variables only when it wins
 *   the slot."
 *
 * It is unreachable because `ManagedPiPolicyV1` accepts neither key, and that
 * is a decision rather than an oversight: both are *shell command settings*
 * (`#settings-that-require-approval`, verbatim: "settings that execute shell
 * commands, such as `apiKeyHelper`, `statusLine`, and `otelHeadersHelper`"),
 * and this product does not accept an admin-supplied executable as a settings
 * source — the owner decision of 2026-08-08 that dropped `policyHelper`.
 *
 * **What this file exists to catch is the HALF state**, not the absence: a
 * future schema admitting one of the two keys WITHOUT the exception beside it
 * would let one administrator's routing variables ride in on another
 * administrator's credential — the exact pairing the telemetry unit forbids one
 * paragraph earlier. An inert exception nobody can see is indistinguishable
 * from a defect; this makes it visible when it stops being inert.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseManagedPiPolicyV1 } from '../../agent/pi-harness/managed-policy.ts'

const MANAGED_POLICY_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'agent',
  'pi-harness',
  'managed-policy.ts',
)

/** The two keys the documented exception keys off. */
const CREDENTIAL_HELPER_KEYS = ['apiKeyHelper', 'otelHeadersHelper'] as const

describe('credential-paired routing exception (P3.67)', () => {
  it('is unreachable because the policy schema admits neither helper key', () => {
    const source = readFileSync(MANAGED_POLICY_SOURCE, 'utf8')

    // Positive control on the SAME file, so the two absences below are a
    // measurement rather than a mistyped path: a key the schema really does
    // accept is present in it.
    expect(source.includes("'env'")).toBe(true)

    for (const key of CREDENTIAL_HELPER_KEYS) {
      expect({ key, present: source.includes(key) }).toEqual({ key, present: false })
    }
  })

  it('REFUSES either helper key by name, so no source can claim a slot that way', () => {
    // The behavioural arm, and it is stronger than the row assumed: the policy
    // parser is fail-CLOSED on unknown keys, so a helper key is not quietly
    // dropped — it is refused, naming itself. That is what makes the decision
    // legible to an administrator who tries it rather than silent.
    for (const key of CREDENTIAL_HELPER_KEYS) {
      expect(() => parseManagedPiPolicyV1({ schemaVersion: 1, [key]: '/bin/echo value' })).toThrow(key)
    }

    // Negative/boundary control on the same rig: a key the schema DOES accept
    // parses, so the refusals above are the schema speaking rather than the
    // parser rejecting everything handed to it.
    const parsed = parseManagedPiPolicyV1({ schemaVersion: 1, env: { NESSY_TEST_MARKER: 'kept' } })
    expect(parsed.env).toBeDefined()
  })
})
