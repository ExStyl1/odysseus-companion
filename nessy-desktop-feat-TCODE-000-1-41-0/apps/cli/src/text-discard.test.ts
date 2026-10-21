/**
 * F1.472 — the CLI honours `text_discard` (F1.298's event: a failed partial the runtime
 * retracts before retrying).
 *
 * `sendAndStream` printed every `text_delta` straight to stdout and had no `text_discard`
 * case, so a terminal showed the failed partial GLUED to the retried answer
 * (`Failed partialRecovered answer`), and `--output-format json`'s `result` carried both.
 * Upstream craft-agents-oss v0.13.4 (`apps/cli/src/retry-stream.test.ts`, Apache-2.0) prints
 * `[incomplete response discarded]` in plain mode — plain terminal output cannot be
 * retracted, so it is delimited — and leaves `stream-json` verbatim; the arms below are its
 * two, plus the json envelope this fork has and upstream does not.
 */
import { describe, expect, it, spyOn } from 'bun:test'
import type { CliRpcClient } from './client.ts'
import { parseArgs, sendAndStream } from './index.ts'

async function run(events: Record<string, unknown>[], format?: string) {
  let listener: (event: unknown) => void = () => {}
  const client = {
    isConnected: true,
    isDestroyed: false,
    on: (_channel: string, callback: typeof listener) => { listener = callback; return () => {} },
    invoke: async (channel: string) => {
      if (channel === 'sessions:sendMessage') for (const event of events) listener({ sessionId: 'test', ...event })
      return undefined
    },
  } as unknown as CliRpcClient
  const output: string[] = []
  const stdout = spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { output.push(String(chunk)); return true })
  const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    const args = parseArgs(['bun', 'index.ts', '--send-timeout', '1000', ...(format ? ['--output-format', format] : []), 'send', 'test', 'hello'])
    const code = await sendAndStream(client, 'test', 'hello', args)
    return { code, output: output.join('') }
  } finally {
    stdout.mockRestore()
    stderr.mockRestore()
  }
}

const RETRIED = [
  { type: 'text_delta', delta: 'Failed partial', turnId: 'old' },
  { type: 'text_discard', turnId: 'old' },
  { type: 'text_delta', delta: 'Recovered answer', turnId: 'new' },
  { type: 'text_complete', text: 'Recovered answer', turnId: 'new', isIntermediate: false },
  { type: 'complete' },
]

describe('F1.472 · the CLI honours text_discard', () => {
  it('text: the discarded partial is delimited, never fused into the retried answer', async () => {
    const result = await run(RETRIED)
    expect(result.code).toBe(0)
    expect(result.output).toContain('Failed partial\n[incomplete response discarded]\nRecovered answer')
    expect(result.output).not.toContain('Failed partialRecovered answer')
  })

  it('stream-json: every event verbatim, no plain-text marker inserted', async () => {
    const result = await run(RETRIED, 'stream-json')
    expect(result.code).toBe(0)
    const lines = result.output.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    // The init frame leads; every event after it is the event as sent.
    expect(lines.slice(1)).toEqual(RETRIED.map(event => ({ sessionId: 'test', ...event })))
    expect(result.output).not.toContain('[incomplete response discarded]')
  })

  it('json: the envelope result is the retried answer alone', async () => {
    const result = await run(RETRIED, 'json')
    expect(result.code).toBe(0)
    const envelope = JSON.parse(result.output) as { result: string }
    expect(envelope.result).toBe('Recovered answer')
  })

  it('BOUNDARY: a retried answer that arrives only as text_complete is still printed and reported', async () => {
    const completeOnly = [
      { type: 'text_delta', delta: 'Failed partial', turnId: 'old' },
      { type: 'text_discard', turnId: 'old' },
      { type: 'text_complete', text: 'Recovered answer', turnId: 'new', isIntermediate: false },
      { type: 'complete' },
    ]
    const text = await run(completeOnly)
    expect(text.output).toContain('[incomplete response discarded]\nRecovered answer')
    const json = await run(completeOnly, 'json')
    expect((JSON.parse(json.output) as { result: string }).result).toBe('Recovered answer')
    // Negative control: with no discard, a text_complete after deltas is NOT printed again.
    const plain = await run([
      { type: 'text_delta', delta: 'Answer', turnId: 'm1' },
      { type: 'text_complete', text: 'Answer', turnId: 'm1', isIntermediate: false },
      { type: 'complete' },
    ])
    expect(plain.output.split('Answer').length - 1).toBe(1)
  })
})
