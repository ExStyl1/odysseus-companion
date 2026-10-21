/**
 * F1.531 — the interceptor's "am I the Pi subprocess?" test survives the Pi model hint being CLEARED.
 *
 * F1.315 (`urlFallbackAdapter`) and F1.517 (`operatorHeadersMayRide`) scope two behaviours to the
 * Pi subprocess through one discriminator, `runsInPiSubprocess`. Until this row it read only
 * `NESSY_PI_MODEL_API`, the MODEL hint pi-agent-server's `setInterceptorApiHints` writes — and
 * DELETES in two cases where the Pi session keeps running: a `set_model` whose id the Pi registry
 * cannot resolve (it clears the hint and returns before `piSession.setModel`, so the session goes
 * on with the old model), and a session created without a resolvable model. From that moment the
 * Pi process read as the headless server: no OpenAI rewrite (tool-call consolidation, the empty
 * `tool_calls` strip, `_intent` capture) and no `NESSY_CUSTOM_HEADERS` off the verified gateway.
 * Found by the 1.41.0 review (F-auth-network-renderer-1, CONFIRMED LOW).
 *
 * The fix is a stable process marker written once at the Pi spawn site — `buildPiSubprocessEnv`,
 * the one env builder the Pi child is spawned with — and never touched by the hint's writer. This
 * file drives the discriminator with EXACTLY that builder's output: the marker it writes, then the
 * hint set and deleted the way `setInterceptorApiHints(undefined)` deletes it (that function is
 * module-private to pi-agent-server, so the deletion is emulated, and the emulation is the whole
 * of what it does to this name).
 *
 * `bun test` preloads the interceptor into this process (root `bunfig.toml`) with neither name
 * set, so this process is the headless-server shape; copying the built env's marker in makes it
 * the Pi shape. The CONTROLS are the headless server: no marker, or a marker that is not `1`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { buildPiSubprocessEnv } from '../agent/pi-agent.ts'
import { gatewaySessionFetch } from '../telemetry/gateway-headers.ts'
import { prepareOutboundHeaders, urlFallbackAdapter } from '../unified-network-interceptor.ts'

const MARKER = 'NESSY_PI_SUBPROCESS'
const HINT = 'NESSY_PI_MODEL_API'
const ENV_KEYS = [MARKER, HINT, 'NESSY_CUSTOM_HEADERS'] as const
const ORIGINAL = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

/** Delete, then assign: a value ASSIGNED to process.env must stay enumerable (AGENTS.md, Bun 1.3.14). */
function setEnv(key: string, value: string | undefined): void {
  delete process.env[key]
  if (value !== undefined) process.env[key] = value
}

afterEach(() => {
  for (const key of ENV_KEYS) setEnv(key, ORIGINAL[key])
  received.length = 0
})

/** The spawn site's own builder, with nothing ambient that could decide the answer. */
function piSpawnEnv(processEnv: NodeJS.ProcessEnv = {}, envOverrides?: Record<string, string>): NodeJS.ProcessEnv {
  return buildPiSubprocessEnv({
    processEnv,
    proxyEnv: {},
    ...(envOverrides ? { envOverrides } : {}),
    awsEnv: {},
    sessionId: 'f1531-session',
    debug: false,
  })
}

/** What the Pi child's env holds after `set_model` failed to resolve: the hint written, then deleted. */
function piEnvAfterUnresolvableSetModel(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...piSpawnEnv(), [HINT]: 'openai-completions' }
  delete env[HINT]
  return env
}

const BYO_CHAT = 'https://byo.example/v1/chat/completions'
const GATEWAY_CHAT = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1/chat/completions'

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

/** One OpenAI-wire hop through this process's global fetch — the preloaded interceptor. */
async function hop(): Promise<{ toolProperties: string[]; streamed: string }> {
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
  const streamed = await response.text()
  const sent = received.at(-1)!
  const tools = sent.tools as Array<{ function: { parameters: { properties: Record<string, unknown> } } }>
  return { toolProperties: Object.keys(tools[0]!.function.parameters.properties), streamed }
}

function operatorHeaderOn(url: string): string | undefined {
  const headers = new Headers(prepareOutboundHeaders(url, { Authorization: 'Bearer sdk-token' }) as Record<string, string>)
  return headers.get('x-tenant') ?? undefined
}

describe('F1.531 · the Pi spawn site marks the process, and the mark outlives the model hint', () => {
  it('the spawn env carries the marker, and neither the host shell nor an env override decides it', () => {
    expect(piSpawnEnv()[MARKER]).toBe('1')
    expect(piSpawnEnv({ [MARKER]: '0' })[MARKER]).toBe('1')
    expect(piSpawnEnv({}, { [MARKER]: '' })[MARKER]).toBe('1')
  })

  it('after an unresolvable set_model the Pi env still selects openAiAdapter by URL', () => {
    const env = piEnvAfterUnresolvableSetModel()
    expect(env[HINT]).toBeUndefined()
    expect(urlFallbackAdapter(BYO_CHAT, env)?.name).toBe('openai')
  })

  it('after an unresolvable set_model a Pi hop is still rewritten (the F1.315 behaviour Pi was designed for)', async () => {
    setEnv(MARKER, piEnvAfterUnresolvableSetModel()[MARKER])
    setEnv(HINT, undefined)
    const { toolProperties, streamed } = await hop()
    expect(toolProperties).toContain('_intent')
    expect(streamed).not.toContain('"tool_calls":[]')
  })

  it('after an unresolvable set_model the operator headers still ride a non-gateway provider URL in Pi (F1.517)', () => {
    setEnv(MARKER, piEnvAfterUnresolvableSetModel()[MARKER])
    setEnv(HINT, undefined)
    setEnv('NESSY_CUSTOM_HEADERS', 'X-Tenant: acme')
    expect({ byo: operatorHeaderOn(BYO_CHAT), gateway: operatorHeaderOn(GATEWAY_CHAT) })
      .toEqual({ byo: 'acme', gateway: 'acme' })
  })

  it('CONTROL — the headless server (no marker, no hint) is still not Pi, on all three decisions', async () => {
    setEnv(MARKER, undefined)
    setEnv(HINT, undefined)
    setEnv('NESSY_CUSTOM_HEADERS', 'X-Tenant: acme')
    expect(urlFallbackAdapter(BYO_CHAT, {})).toBeUndefined()
    expect({ byo: operatorHeaderOn(BYO_CHAT), gateway: operatorHeaderOn(GATEWAY_CHAT) })
      .toEqual({ byo: undefined, gateway: 'acme' })
    const { toolProperties, streamed } = await hop()
    expect(toolProperties).toEqual(['q'])
    expect(streamed).toBe(SSE)
  })

  it('BOUNDARY — only the value the spawn site writes marks Pi: `0` and empty do not', () => {
    expect(urlFallbackAdapter(BYO_CHAT, { [MARKER]: '0' })).toBeUndefined()
    expect(urlFallbackAdapter(BYO_CHAT, { [MARKER]: '' })).toBeUndefined()
    // The hint arm is kept: a process carrying the model hint (a rig that spawns
    // pi-agent-server without this builder) keeps the shape it had before this row.
    expect(urlFallbackAdapter(BYO_CHAT, { [HINT]: '' })?.name).toBe('openai')
  })
})
