/**
 * F1.315 — the interceptor's OpenAI chat-completions REWRITE belongs to the Pi subprocess.
 *
 * `bin/nessy-server` preloads `unified-network-interceptor.ts` into the headless server's
 * own process (`scripts/build/interceptor-pairing.ts` symbol `interceptorPreloadFragment`),
 * so a codex or claude-runtime session's OpenAI-wire upstream hop — made by the host's
 * loopback adapter through `gatewaySessionFetch`, whose `inner` is the global fetch — met
 * `openAiAdapter` by URL: `_intent`/`_displayName` injected into MCP tool schemas, tool-call
 * chunks consolidated, `tool_calls: []` keys deleted (the WJ-ee verifier measured the last on
 * F1.237). The packaged desktop app's main process preloads nothing, so the SAME sessions
 * never met it there: a rewrite nobody on those two runtimes asked for, on one deployment
 * only. Pi, where the adapter was designed, always carries `NESSY_PI_MODEL_API`
 * (pi-agent-server's `setInterceptorApiHints`).
 *
 * `bun test` preloads the interceptor into the test process exactly as `bin/nessy-server`
 * does (root `bunfig.toml`), and leaves `NESSY_PI_MODEL_API` unset — so this process IS
 * the headless-server shape, and setting the hint makes it the Pi shape (the control).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { gatewaySessionFetch } from '../telemetry/gateway-headers.ts'
import { urlFallbackAdapter } from '../unified-network-interceptor.ts'

let server: ReturnType<typeof Bun.serve>
const received: Array<Record<string, unknown>> = []
const SSE = 'data: {"choices":[{"index":0,"delta":{"content":"hi","tool_calls":[]}}]}\n\n'
  + 'data: {"choices":[{"index":0,"delta":{"tool_calls":[]},"finish_reason":"stop"}]}\n\n'
  + 'data: [DONE]\n\n'

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      received.push(await req.json() as Record<string, unknown>)
      return new Response(SSE, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
})
afterAll(() => { server.stop(true) })

const savedHint = process.env.NESSY_PI_MODEL_API
afterEach(() => {
  received.length = 0
  delete process.env.NESSY_PI_MODEL_API
  if (savedHint !== undefined) process.env.NESSY_PI_MODEL_API = savedHint
})

async function hop(): Promise<{ sent: Record<string, unknown>; streamed: string }> {
  const response = await gatewaySessionFetch(undefined)(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'm',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'mcp__src__search', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } }],
    }),
  })
  return { sent: received.at(-1)!, streamed: await response.text() }
}

const toolParams = (body: Record<string, unknown>) =>
  ((body.tools as Array<{ function: { parameters: { properties: Record<string, unknown>; required?: string[] } } }>)[0]!.function.parameters)

describe('F1.315 · openAiAdapter rewrites a /chat/completions hop only in the Pi subprocess', () => {
  it('the headless-server shape (no Pi hint): the hop goes out and comes back as sent', async () => {
    delete process.env.NESSY_PI_MODEL_API
    const { sent, streamed } = await hop()
    expect(Object.keys(toolParams(sent).properties)).toEqual(['q'])
    expect(toolParams(sent).required).toEqual(['q'])
    expect(streamed).toBe(SSE)
  })

  it('CONTROL — the Pi shape (hint set): the same hop IS rewritten, so the rig reaches the interceptor', async () => {
    process.env.NESSY_PI_MODEL_API = 'openai-completions'
    const { sent, streamed } = await hop()
    expect(Object.keys(toolParams(sent).properties)).toContain('_intent')
    expect(streamed).not.toContain('"tool_calls":[]')
  })

  it('the fallback outside Pi drops ONLY openAiAdapter: the Anthropic and Responses adapters keep their URL match', () => {
    expect(urlFallbackAdapter('https://gw.example/v1/chat/completions', {})).toBeUndefined()
    // The Anthropic adapter also requires the configured base URL (`getConfiguredBaseUrl`).
    const anthropicBase = process.env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com'
    expect(urlFallbackAdapter(`${anthropicBase}/v1/messages`, {})?.name).toBe('anthropic')
    expect(urlFallbackAdapter('https://gw.example/v1/responses', {})?.name).toBe('openai-responses')
    expect(urlFallbackAdapter('https://gw.example/v1/chat/completions', { NESSY_PI_MODEL_API: '' })?.name).toBe('openai')
  })

  it('BOUNDARY — Pi with a model whose api maps to no adapter still reaches openAiAdapter by URL, as before', async () => {
    process.env.NESSY_PI_MODEL_API = 'google-generative-ai'
    const { sent } = await hop()
    expect(Object.keys(toolParams(sent).properties)).toContain('_intent')
  })
})
