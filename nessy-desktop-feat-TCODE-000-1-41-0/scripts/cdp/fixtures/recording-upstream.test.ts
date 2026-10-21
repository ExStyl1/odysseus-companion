/**
 * F1.61 (Origin D1.58, carried P6.369) — the recorder's OWN arms, proven over a
 * real loopback HTTP client before any runtime is pointed at it.
 *
 * The row's measured blocker (SIT-5c, 2026-09-18) was the absence of a readable
 * surface: "the thinking budget sent is only visible off the loopback adapter,
 * which this rig does not capture". `fixtures/recording-upstream.ts` is that
 * capture, and this file pins the three properties a diff-of-two-turns reading
 * rests on:
 *
 * - the row's three fields (`reasoning_effort`, `max_completion_tokens`,
 *   `thinking`) are recorded PRESENT WITH THEIR VALUE when the body carries
 *   them, and PRESENT:FALSE when it does not — absence must never read as a
 *   zero/null/false, because the whole verdict is an absence claim;
 * - a turn COMPLETES against it (stream and non-stream), because both of the
 *   row's arms are complete turns and a recorder that cannot answer measures
 *   nothing;
 * - the Authorization header is recorded as a LENGTH only, never a value.
 */

import { describe, expect, it } from 'bun:test'

import { startRecordingUpstream } from './recording-upstream.ts'

/** A chat-completions POST carrying the row's three thinking-budget fields. */
function budgetedBody(stream: boolean): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer rig-not-a-real-key' },
    body: JSON.stringify({
      model: 'rig-claude-model',
      stream,
      reasoning_effort: 'high',
      max_completion_tokens: 8192,
      thinking: { type: 'enabled', budget_tokens: 1234 },
      messages: [{ role: 'user', content: 'rig turn' }],
    }),
  }
}

describe('the F1.61 recording upstream', () => {
  it('records the three budget fields PRESENT with their exact values, stream and non-stream', async () => {
    for (const stream of [true, false]) {
      const stub = startRecordingUpstream({ port: 0 })
      try {
        const response = await fetch(`${stub.url}/chat/completions`, budgetedBody(stream))
        if (stream) {
          expect(response.headers.get('content-type')).toContain('text/event-stream')
          const body = await response.text()
          expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true)
        } else {
          const body = await response.json() as { choices: unknown[] }
          expect(body.choices.length).toBe(1)
        }
        const [record] = stub.requests()
        expect(record?.model).toBe('rig-claude-model')
        expect(record?.streamed).toBe(stream)
        expect(record?.reasoningEffort).toEqual({ present: true, value: 'high' })
        expect(record?.maxCompletionTokens).toEqual({ present: true, value: 8192 })
        expect(record?.thinking).toEqual({ present: true, value: { type: 'enabled', budget_tokens: 1234 } })
        expect(record?.bodyKeys).toEqual([...record?.bodyKeys ?? []].sort())
        expect(record?.bodyBytes).toBeGreaterThan(0)
      } finally {
        stub.stop()
      }
    }
  })

  it('absence reads as present:false — never as a zero, a null or a false', async () => {
    const stub = startRecordingUpstream({ port: 0 })
    try {
      // One body with NONE of the three keys, and one where a key is present
      // with a falsy value — the detector has to tell those apart.
      await fetch(`${stub.url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', stream: false, messages: [{ role: 'user', content: 'x' }] }),
      })
      await fetch(`${stub.url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', stream: false, reasoning_effort: null, max_completion_tokens: 0, messages: [] }),
      })
      const [absent, falsy] = stub.requests()
      expect(absent?.reasoningEffort).toEqual({ present: false })
      expect(absent?.maxCompletionTokens).toEqual({ present: false })
      expect(absent?.thinking).toEqual({ present: false })
      // `reasoning_effort: null` IS the key being sent — present, with null.
      expect(falsy?.reasoningEffort).toEqual({ present: true, value: null })
      expect(falsy?.maxCompletionTokens).toEqual({ present: true, value: 0 })
      expect(falsy?.thinking).toEqual({ present: false })
    } finally {
      stub.stop()
    }
  })

  it('answers /models for the card-save flow, and never holds a key — the LENGTH only', async () => {
    const stub = startRecordingUpstream({ port: 0 })
    try {
      const models = await (await fetch(`${stub.url}/models`, {
        headers: { authorization: 'Bearer rig-not-a-real-key' },
      })).json() as { data: { id: string }[] }
      expect(models.data[0]?.id).toBe('nessy-cdp-recorder')
      const seen = stub.requests()
      expect(seen.map(entry => entry.authorizationLength)).toEqual(['Bearer rig-not-a-real-key'.length])
      expect(JSON.stringify(seen)).not.toContain('rig-not-a-real-key')
    } finally {
      stub.stop()
    }
  })

  it('the full body is opt-in: recorded under fullBody, absent from the record without it', async () => {
    const withFull = startRecordingUpstream({ port: 0, fullBody: true })
    const withoutFull = startRecordingUpstream({ port: 0 })
    try {
      await fetch(`${withFull.url}/chat/completions`, budgetedBody(false))
      await fetch(`${withoutFull.url}/chat/completions`, budgetedBody(false))
      expect((withFull.requests()[0]?.body as { model?: string } | undefined)?.model).toBe('rig-claude-model')
      expect('body' in (withoutFull.requests()[0] ?? {})).toBe(false)
      expect(JSON.stringify(withoutFull.requests())).not.toContain('rig turn')
    } finally {
      withFull.stop()
      withoutFull.stop()
    }
  })
})
