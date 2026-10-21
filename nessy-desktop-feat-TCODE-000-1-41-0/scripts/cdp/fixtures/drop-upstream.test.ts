/**
 * F1.16 (Origin D1.178, carried C5.15) — the fixture's OWN arms, proven over a
 * real loopback HTTP client before any runtime is pointed at it.
 *
 * The row's blocker was that nothing on the rig can drop a connection
 * mid-response; this file is what makes `fixtures/drop-upstream.ts` able to,
 * and it pins the three shapes the drive needs (D1.178's rig spec):
 *
 * - the treatment: a partial response — some text PLUS at least one COMPLETE
 *   tool call — then the connection dies before any finish chunk or `[DONE]`;
 * - control (a): the same upstream closing normally completes the turn;
 * - control (b): a drop BEFORE any output, which must not manufacture a
 *   partial (zero body bytes).
 *
 * The client here is `fetch` — the same client shape the runtimes speak — so
 * an arm that delivered its bytes but ended cleanly would fail the treatment
 * assertion rather than look like a drop. The drop-vs-clean separation was
 * measured before this test was written (see the fixture's header for the
 * eight Bun.serve / node:http probes of 2026-10-11).
 */

import { describe, expect, it } from 'bun:test'

import { PARTIAL_TEXT, PROBE_COMMAND, startDropUpstream } from './drop-upstream.ts'

interface Reading {
  /** Body bytes received before the end — the partial's size. */
  bytes: number
  /** Those bytes decoded, when any arrived. */
  text: string
  /** The error the drop (or the refusal) surfaced as, if one did. */
  error?: string
  /** True when the body ended WITHOUT an error — a complete response. */
  cleanEnd: boolean
}

/** Read a streaming body to its end, recording exactly what the wire gave. */
async function readUntilEnd(response: Response): Promise<Reading> {
  const reader = response.body?.getReader()
  if (!reader) return { bytes: 0, text: '', error: 'no body', cleanEnd: false }
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  for (;;) {
    try {
      const { done, value } = await reader.read()
      if (done) return { bytes, text, cleanEnd: true }
      bytes += value.length
      text += decoder.decode(value, { stream: true })
    } catch (error) {
      return { bytes, text, error: `${(error as Error).name}: ${(error as Error).message}`, cleanEnd: false }
    }
  }
}

/**
 * Fetch + read with the drop surfaced wherever it fires. The drop-before-output
 * control surfaces at the FETCH itself — this repo's own outgoing-request
 * interceptor wraps `fetch` inside `bun test`, and a connection cut before any
 * response byte reaches the client as `ECONNRESET` from that wrapper, never as
 * a Response with an empty body.
 */
async function fetchAndRead(url: string, init: RequestInit): Promise<Reading> {
  try {
    return await readUntilEnd(await fetch(url, init))
  } catch (error) {
    return { bytes: 0, text: '', error: `${(error as Error).name}: ${(error as Error).message}`, cleanEnd: false }
  }
}

/** A streamed chat-completions POST carrying the probe command and a shell tool. */
function probeRequest(body: string, stream = true): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer rig-not-a-real-key' },
    body: JSON.stringify({
      model: 'anything',
      stream,
      messages: [{ role: 'user', content: `Run this exact command: ${PROBE_COMMAND}` }],
      tools: [{ type: 'function', function: { name: 'Bash' } }],
    }),
  }
}

describe('the F1.16 drop upstream', () => {
  it('treatment: streams text plus a COMPLETE tool call, then drops mid-response', async () => {
    const stub = startDropUpstream({ mode: 'drop-after-partial' })
    try {
      const response = await fetch(`${stub.url}/chat/completions`, probeRequest(''))
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      const reading = await readUntilEnd(response)
      // The drop: the body must NOT end cleanly while partial bytes DID arrive.
      expect(reading.cleanEnd).toBe(false)
      expect(reading.error).toBeDefined()
      expect(reading.bytes).toBeGreaterThan(0)
      // The partial carries the text marker…
      expect(reading.text).toContain(PARTIAL_TEXT)
      // …and a complete tool call — full arguments, not a fragment…
      expect(reading.text).toContain('"tool_calls"')
      const chunks = reading.text.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]'))
      const toolChunk = chunks.map(line => JSON.parse(line.slice('data: '.length)) as {
        choices: { delta: { tool_calls?: { function: { name: string; arguments: string } }[] } }[]
      }).find(parsed => parsed.choices[0]?.delta.tool_calls?.length)
      const call = toolChunk?.choices[0]?.delta.tool_calls?.[0]
      expect(call?.function.name).toBe('Bash')
      expect(JSON.parse(call?.function.arguments ?? '{}').command).toBe(PROBE_COMMAND)
      // …and NEITHER completion marker: no finish chunk, no [DONE].
      expect(reading.text).not.toContain('[DONE]')
      expect(reading.text).not.toContain('"finish_reason":"stop"')
      expect(reading.text).not.toContain('"finish_reason":"tool_calls"')
      // The stub's own record is the arm's positive control for a sitting.
      const [record] = stub.requests()
      expect(record?.mode).toBe('drop-after-partial')
      expect(record?.wire).toBe('after-partial')
      expect(record?.partialBytes).toBe(reading.bytes)
      expect(record?.toolCallIncluded).toBe(true)
      expect(record?.streamed).toBe(true)
    } finally {
      stub.stop()
    }
  })

  it('control (b): a drop BEFORE any output manufactures no partial — zero body bytes', async () => {
    const stub = startDropUpstream({ mode: 'drop-before-output' })
    try {
      const reading = await fetchAndRead(`${stub.url}/chat/completions`, probeRequest(''))
      expect(reading.bytes).toBe(0)
      expect(reading.cleanEnd).toBe(false)
      expect(reading.error).toBeDefined()
      const [record] = stub.requests()
      expect(record?.mode).toBe('drop-before-output')
      expect(record?.wire).toBe('before-headers')
      expect(record?.partialBytes).toBe(0)
    } finally {
      stub.stop()
    }
  })

  it('control (a): the same upstream closing normally completes the turn', async () => {
    const stub = startDropUpstream({ mode: 'clean' })
    try {
      const response = await fetch(`${stub.url}/chat/completions`, probeRequest(''))
      const reading = await readUntilEnd(response)
      expect(reading.cleanEnd).toBe(true)
      expect(reading.error).toBeUndefined()
      expect(reading.text.trimEnd().endsWith('data: [DONE]')).toBe(true)
      expect(reading.text).toContain('"finish_reason":"tool_calls"')
      const [record] = stub.requests()
      expect(record?.mode).toBe('clean')
      expect(record?.wire).toBe('completed')
    } finally {
      stub.stop()
    }
  })

  it('a drop mode is uniform: a non-streamed request is truncated too, and the record says so', async () => {
    const stub = startDropUpstream({ mode: 'drop-after-partial' })
    try {
      const response = await fetch(`${stub.url}/chat/completions`, probeRequest('', false))
      const reading = await readUntilEnd(response)
      expect(reading.cleanEnd).toBe(false)
      expect(reading.error).toBeDefined()
      expect(reading.bytes).toBeGreaterThan(0)
      const [record] = stub.requests()
      expect(record?.streamed).toBe(false)
      expect(record?.wire).toBe('after-partial')
    } finally {
      stub.stop()
    }
  })

  it('answers /models for the card-save flow, and never holds a key — the LENGTH only', async () => {
    const stub = startDropUpstream({ mode: 'clean' })
    try {
      const models = await (await fetch(`${stub.url}/models`, {
        headers: { authorization: 'Bearer rig-not-a-real-key' },
      })).json() as { data: { id: string }[] }
      expect(models.data[0]?.id).toBe('nessy-cdp-drop')
      // The key never becomes a record — only its length (the stub-upstream rule).
      const seen = stub.requests()
      expect(seen.map(entry => entry.authorizationLength)).toEqual(['Bearer rig-not-a-real-key'.length])
      expect(JSON.stringify(seen)).not.toContain('rig-not-a-real-key')
    } finally {
      stub.stop()
    }
  })
})
