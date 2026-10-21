/**
 * F1.329 — the strict endpoint's OWN arms, proven over a real loopback HTTP
 * client before any pi card is pointed at it.
 *
 * The three readings the row's strict-BYO leg rests on:
 *
 * 1. the MEASURED refusal (SIT2-e, 2026-10-01): a body carrying the gateway
 *    payload's platform fields (`stream_options`, `max_completion_tokens`) is
 *    refused 400 in OpenAI's own shape, NAMING both keys — the exact text a
 *    real pi turn surfaced to the user;
 * 2. today's BYO payload — the production composition pinned key for key by
 *    `packages/pi-agent-server/src/custom-endpoint-models.test.ts` (F1.1263
 *    compat: `max_tokens`, no `stream_options`; the 0.85.1 lift added
 *    `prompt_cache_key`/`prompt_cache_retention`; a reasoning model adds
 *    `reasoning_effort` and the `developer` role) — is ACCEPTED by the
 *    measured-strict default, which is the end-to-end form of F1.1263's claim;
 * 3. the accept-all control answers the same refused body with a completion,
 *    so an arm's verdict is the refusal and never a hang.
 */

import { describe, expect, it } from 'bun:test'

import { startStrictUpstream } from './strict-upstream.ts'

/** The gateway-shaped body: the fields pi-ai's own detection sends there. */
function gatewayShapedBody(): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer rig-not-a-real-key' },
    body: JSON.stringify({
      model: 'rig-coder',
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 8192,
      messages: [{ role: 'developer', content: 'rig system prompt' }, { role: 'user', content: 'hi' }],
    }),
  }
}

/** Today's BYO payload, key for key per the production pin (reasoning variant). */
function byoCompatBody(): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'probe-model',
      stream: false,
      max_tokens: 8192,
      prompt_cache_key: 'rig-cache-key',
      prompt_cache_retention: '24h',
      reasoning_effort: 'high',
      messages: [{ role: 'developer', content: 'probe system prompt' }, { role: 'user', content: 'hi' }],
    }),
  }
}

describe('the F1.329 strict upstream', () => {
  it('the measured refusal: gateway-shaped platform fields are refused 400, naming both keys', async () => {
    const stub = startStrictUpstream({ port: 0 })
    try {
      const response = await fetch(`${stub.url}/chat/completions`, gatewayShapedBody())
      expect(response.status).toBe(400)
      const body = await response.json() as { error: { message: string; type: string } }
      expect(body.error.type).toBe('invalid_request_error')
      expect(body.error.message).toBe('Unrecognized request argument supplied: max_completion_tokens, stream_options')
      // The record names the same keys and carries the roles it saw.
      const [record] = stub.requests()
      expect(record?.accepted).toBe(false)
      expect(record?.refusedKeys).toEqual(['max_completion_tokens', 'stream_options'])
      expect(record?.bodyKeys).toEqual(['max_completion_tokens', 'messages', 'model', 'stream', 'stream_options'])
      expect(record?.roles).toEqual(['developer', 'user'])
      expect(record?.refusedRoles).toEqual([])
      // The key never becomes a record — only its length.
      expect(record?.authorizationLength).toBe('Bearer rig-not-a-real-key'.length)
      expect(JSON.stringify(stub.requests())).not.toContain('rig-not-a-real-key')
      expect(JSON.stringify(stub.requests())).not.toContain('rig system prompt')
    } finally {
      stub.stop()
    }
  })

  it("today's BYO payload — max_tokens, prompt_cache_key/retention, reasoning_effort, developer role — is ACCEPTED by the measured-strict default", async () => {
    const stub = startStrictUpstream({ port: 0 })
    try {
      const response = await fetch(`${stub.url}/chat/completions`, byoCompatBody())
      expect(response.status).toBe(200)
      const body = await response.json() as { choices: { message: { content: string } }[] }
      expect(body.choices[0]?.message.content).toBe('strict ok')
      const [record] = stub.requests()
      expect(record?.accepted).toBe(true)
      expect(record?.refusedKeys).toEqual([])
      // The record carries what the row needs to read, without the content.
      expect(record?.bodyKeys).toEqual(['max_tokens', 'messages', 'model', 'prompt_cache_key', 'prompt_cache_retention', 'reasoning_effort', 'stream'])
      expect(record?.roles).toEqual(['developer', 'user'])
    } finally {
      stub.stop()
    }
  })

  it('the knobs move the measurement: --allow un-refuses, --refuse extends, --refuse-role arms roles, accept-all answers the refused body', async () => {
    // F1.1263 in fixture form: allowing the two fields is what a compat
    // sibling does to the payload — the endpoint stops refusing.
    const allowed = startStrictUpstream({ port: 0, refuseKeys: [] })
    try {
      const response = await fetch(`${allowed.url}/chat/completions`, gatewayShapedBody())
      expect(response.status).toBe(200)
      expect(allowed.requests()[0]?.accepted).toBe(true)
    } finally {
      allowed.stop()
    }
    // An extended list: the two NEW fields the 0.85.1 lift added to every
    // custom-endpoint payload can be armed, which is the arm a real refusal
    // reading would justify.
    const extended = startStrictUpstream({ port: 0, refuseKeys: ['prompt_cache_key', 'prompt_cache_retention'] })
    try {
      const response = await fetch(`${extended.url}/chat/completions`, byoCompatBody())
      expect(response.status).toBe(400)
      const body = await response.json() as { error: { message: string } }
      expect(body.error.message).toBe('Unrecognized request argument supplied: prompt_cache_key, prompt_cache_retention')
      expect(extended.requests()[0]?.refusedKeys).toEqual(['prompt_cache_key', 'prompt_cache_retention'])
    } finally {
      extended.stop()
    }
    // Role strictness is a knob, not the default: SIT2-e measured the
    // `developer` role only at the GATEWAY, which accepted it.
    const roleStrict = startStrictUpstream({ port: 0, refuseRoles: ['developer'] })
    try {
      const response = await fetch(`${roleStrict.url}/chat/completions`, byoCompatBody())
      expect(response.status).toBe(400)
      const body = await response.json() as { error: { message: string } }
      expect(body.error.message).toBe('Unrecognized message role supplied: developer')
      expect(roleStrict.requests()[0]?.refusedRoles).toEqual(['developer'])
    } finally {
      roleStrict.stop()
    }
    // The positive control: the same body the default refused, answered.
    const control = startStrictUpstream({ port: 0, acceptAll: true })
    try {
      const response = await fetch(`${control.url}/chat/completions`, gatewayShapedBody())
      expect(response.status).toBe(200)
      expect(control.requests()[0]?.accepted).toBe(true)
      expect(control.refusedKeys()).toEqual([])
      expect(control.refusedRoles()).toEqual([])
    } finally {
      control.stop()
    }
  })

  it('an accepted streaming turn completes, and /models answers for the card-save flow', async () => {
    const stub = startStrictUpstream({ port: 0, acceptAll: true })
    try {
      const response = await fetch(`${stub.url}/chat/completions`, gatewayShapedBody())
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      const body = await response.text()
      expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true)
      const models = await (await fetch(`${stub.url}/models`)).json() as { data: { id: string }[] }
      expect(models.data[0]?.id).toBe('nessy-cdp-strict')
    } finally {
      stub.stop()
    }
  })
})
