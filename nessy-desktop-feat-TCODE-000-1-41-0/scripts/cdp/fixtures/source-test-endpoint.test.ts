/**
 * RS-123's instrument, proven before any runtime is pointed at it — the same
 * order drop-upstream.test.ts established for its fixture (F1.16).
 *
 * UB3.8's arm B scores a source_test verdict AGAINST this endpoint, so an arm
 * that meant nothing would be invisible in the sitting: a 200 that did not
 * check the credential would make the "removed credential" arm read reachable
 * for the rig's own reason, and a 401 without a JSON body would starve UB3.2's
 * error-body half. Both properties are pinned here, over a real loopback
 * client (fetch — the same shape source_test's probes speak):
 *
 * - positive: the fixture credential answers 200 with the catalog body;
 * - negative (the control that can fail): a missing credential answers 401
 *   with the pinned JSON body — the exact pair the sitting arm needs;
 * - boundary: a STALE credential (a well-formed bearer with the wrong value)
 *   is refused too, which is what makes the row's stale-credential arm real;
 * - the log records SHAPES only — presence and length, never a value.
 */

import { describe, expect, it } from 'bun:test'

import { FIXTURE_KEY, MODELS_BODY, UNAUTHORIZED_BODY, startSourceTestEndpoint } from './source-test-endpoint.ts'

describe('source-test-endpoint — RS-123 (UB3.8 arm B) instrument', () => {
  it('answers 200 with the catalog body to the fixture credential, and logs the bearer shape', async () => {
    const endpoint = startSourceTestEndpoint()
    try {
      const response = await fetch(`${endpoint.url}/v1/models`, {
        headers: { authorization: `Bearer ${FIXTURE_KEY}` },
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(MODELS_BODY)
      const [record] = endpoint.requests()
      expect(record?.authorizationPresent).toBe(true)
      // The length is of `Bearer <key>` — the discriminator RS-123 reads in the
      // sitting's log, and never a value.
      expect(record?.authorizationLength).toBe(`Bearer ${FIXTURE_KEY}`.length)
    } finally {
      endpoint.stop()
    }
  })

  it('answers 401 with the JSON error body to a missing credential — the control that can fail', async () => {
    const endpoint = startSourceTestEndpoint()
    try {
      const response = await fetch(`${endpoint.url}/v1/models`)
      expect(response.status).toBe(401)
      // UB3.2's error-body half shows THIS body; a fixture that answered a bare
      // 401 would starve it and the sitting would invent a body to print.
      expect(await response.json()).toEqual(UNAUTHORIZED_BODY)
      expect(endpoint.requests()[0]?.authorizationPresent).toBe(false)
    } finally {
      endpoint.stop()
    }
  })

  it('refuses a STALE credential (wrong value, right shape) with the same 401', async () => {
    const endpoint = startSourceTestEndpoint()
    try {
      const response = await fetch(`${endpoint.url}/v1/models`, {
        headers: { authorization: 'Bearer rs123-stale-credential' },
      })
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual(UNAUTHORIZED_BODY)
      const [record] = endpoint.requests()
      // Present and shaped, yet refused — the stale arm's whole premise.
      expect(record?.authorizationPresent).toBe(true)
      expect(record?.authorizationLength).toBe('Bearer rs123-stale-credential'.length)
    } finally {
      endpoint.stop()
    }
  })

  it('keeps non-GET methods and unknown paths off the credential verdict', async () => {
    const endpoint = startSourceTestEndpoint({ key: 'length-check-key' })
    try {
      const post = await fetch(`${endpoint.url}/v1/models`, { method: 'POST' })
      expect(post.status).toBe(405)
      const missing = await fetch(`${endpoint.url}/favicon.ico`)
      expect(missing.status).toBe(404)
      // A credential in a refused request is still logged as its shape: the log
      // is a record of requests, not only of the ones that mattered.
      expect(endpoint.requests().map(entry => entry.status)).toEqual([405, 404])
    } finally {
      endpoint.stop()
    }
  })
})
