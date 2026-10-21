/**
 * A loopback OpenAI-compatible upstream, so a BYO card can be measured at all —
 * C3.356.
 *
 * ## The measurement this exists for
 *
 * R2, rig day 2026-09-12: RS-16 reported `byo-classification.shellToolCalled:
 * false` against the gateway control's `true`. A BYO card exists to carry its
 * OWN key, and a key its upstream rejects gives no turn — so no shell, so no
 * reading. The case was not wrong and the rig was not broken: the arm is
 * unmeasurable without an upstream that answers, and the row offers two ways out
 * ("a local OpenAI-compatible stub upstream … or name a real BYO card the owner
 * is willing to expose"). This is the first, which needs nobody's credential.
 *
 * ## What it is, and what it deliberately is not
 *
 * It is a SCRIPTED upstream, not a model. There is no reasoning behind it: it
 * calls the shell tool with the command it was given and then hands the tool's
 * own output back as the assistant's answer. For a harness that is the feature —
 * RS-16 wants a deterministic shell call, and a real model declining to run a
 * command is one more way its reading can be vacuous.
 *
 * The wire is OpenAI chat-completions because that is what a BYO card speaks on
 * both paths that matter: AGENTS.md §Gateway Facts records that a BYO
 * `claude-runtime` connection's default upstream is `openai-compatible` (the
 * per-session loopback adapter translates Anthropic Messages to it), and a Pi
 * card with a custom endpoint speaks it directly. Streaming is supported because
 * a client that asks for `stream: true` and gets a whole-body answer sees a
 * protocol error, not a model.
 *
 * ## It never holds a key, and that is load-bearing
 *
 * `Authorization` is accepted whatever it says and is NEVER stored, logged or
 * returned — only its LENGTH is recorded, which is the one thing a case needs
 * ("did a key reach the upstream at all") and the one shape that cannot be
 * pasted into a client. Same argument as RS-16's own docblock, applied to the
 * other end of the wire: the operator points a card at this server with any
 * string as the key.
 *
 * ## The command it runs is RECOGNISED, not guessed
 *
 * {@link extractShellCommand} matches the shape RS-16's probe uses and nothing
 * else. A stub that guessed "the last quoted thing" would run whatever a prompt
 * happened to contain, which is a worse failure than running nothing. A case
 * that wants a different command teaches this function its shape, deliberately.
 */

import { appendFileSync } from 'node:fs'

const MODEL_ID = 'nessy-cdp-stub'

/** What the server saw, reduced to what is safe to record. */
export interface StubRequestRecord {
  /** ISO timestamp, so a JSONL log can be sliced to one arm's own window. */
  t?: string
  path: string
  /** The LENGTH of the Authorization header, never its value. `0` when absent. */
  authorizationLength: number
  model: string | null
  toolNames: string[]
  streamed: boolean
  /** Whether this request carried a `role: "tool"` message — i.e. the second leg. */
  carriedToolResult: boolean
}

export interface StubUpstream {
  /** The base URL a BYO card is pointed at, `/v1` included. */
  url: string
  port: number
  requests: () => StubRequestRecord[]
  /** Where the JSONL mirror of {@link StubUpstream.requests} is written, when one was asked for. */
  logPath?: string
  stop: () => void
}

interface ChatMessage {
  role?: string
  content?: unknown
  tool_call_id?: string
}

/**
 * The shell command RS-16's probe asks for, or `null`.
 *
 * The shape is `for n in <names>; do … ; done` — RS-16's `PROBE_COMMAND` builds
 * exactly that, and it is specific enough that no ordinary sentence matches it.
 * Anchored on both ends and non-greedy so a prompt quoting the command twice
 * yields the first whole command rather than a run spanning both.
 */
export function extractShellCommand(text: string): string | null {
  const match = /for n in [\s\S]*?;\s*done/.exec(text)
  return match ? match[0] : null
}

/** The first tool in the offered set that looks like a shell, by name. */
export function pickShellTool(toolNames: readonly string[]): string | null {
  return toolNames.find(name => /bash|shell|terminal|exec|run_command|local_shell/i.test(name)) ?? null
}

/**
 * The property the chosen shell tool calls its command — read from the tool's
 * OWN schema, never assumed.
 *
 * Measured 2026-09-17 (DA2.10, the RS-16 sitting): this stub hard-coded
 * `{ command }`, and the codex runtime's shell tool is `exec_command`, whose
 * argument is `cmd`. The turn died inside codex with *"failed to parse function
 * arguments: missing field `cmd`"* — no tool ran, RS-16's own `shellToolCalled`
 * control went false, and the arm presented EXACTLY like the credential failure
 * C3.356 built this file to remove ("a key the upstream rejects gives no turn").
 * One runtime's argument name, spelled as a constant, was enough to make the
 * instrument lie about the product.
 *
 * So the name comes from the offered schema: its properties in declaration
 * order, filtered to the ones a command could plausibly travel under. The
 * fallback is `command` — the OpenAI-shaped default every other client sends —
 * and a tool offering NO schema gets it, which is what the harness's own
 * name-only fixtures are.
 */
export function shellArgumentName(tools: unknown, toolName: string): string {
  const candidates = ['command', 'cmd', 'script', 'input']
  if (!Array.isArray(tools)) return 'command'
  for (const tool of tools) {
    const record = tool as { function?: { name?: unknown; parameters?: unknown }; name?: unknown; parameters?: unknown }
    const name = record.function?.name ?? record.name
    if (name !== toolName) continue
    const parameters = (record.function?.parameters ?? record.parameters) as { properties?: unknown } | undefined
    const properties = parameters?.properties
    if (properties === null || typeof properties !== 'object') return 'command'
    const declared = Object.keys(properties as Record<string, unknown>)
    return candidates.find(candidate => declared.includes(candidate)) ?? declared[0] ?? 'command'
  }
  return 'command'
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part
      const record = part as { text?: unknown }
      return typeof record.text === 'string' ? record.text : ''
    }).join('\n')
  }
  return ''
}

function toolNamesOf(tools: unknown): string[] {
  if (!Array.isArray(tools)) return []
  return tools.map(tool => {
    const record = tool as { function?: { name?: unknown }; name?: unknown }
    const name = record.function?.name ?? record.name
    return typeof name === 'string' ? name : ''
  }).filter(Boolean)
}

function completion(body: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices: [body],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

/**
 * The whole-body answer, before it is either returned or cut into SSE chunks.
 *
 * `tools` is the request's own tools array, and it is optional only so the
 * harness's name-only fixtures keep working: with it, the command travels under
 * the property the chosen tool's schema declares (see {@link shellArgumentName});
 * without it, under `command`.
 */
export function buildAnswer(messages: readonly ChatMessage[], toolNames: readonly string[], tools?: unknown): {
  kind: 'tool-call' | 'content'
  toolName?: string
  argumentName?: string
  command?: string
  content?: string
} {
  const toolResult = [...messages].reverse().find(message => message.role === 'tool')
  if (toolResult) {
    // Hand the tool's own output back VERBATIM. RS-16 parses `NAME=<length>`
    // lines out of the tool result and out of the assistant text alike, so an
    // upstream that summarised here would destroy the reading.
    return { kind: 'content', content: textOf(toolResult.content) }
  }
  const lastUser = [...messages].reverse().find(message => message.role === 'user')
  const command = extractShellCommand(textOf(lastUser?.content))
  const shellTool = pickShellTool(toolNames)
  if (command && shellTool) {
    return { kind: 'tool-call', toolName: shellTool, argumentName: shellArgumentName(tools, shellTool), command }
  }
  return {
    kind: 'content',
    content: command
      ? 'the stub upstream found a command but no shell tool was offered in this request'
      : 'the stub upstream found no command it recognises in the last user message',
  }
}

function choiceFor(answer: ReturnType<typeof buildAnswer>): Record<string, unknown> {
  if (answer.kind === 'tool-call') {
    return {
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `call_${Date.now().toString(36)}`,
          type: 'function',
          function: {
            name: answer.toolName,
            arguments: JSON.stringify({ [answer.argumentName ?? 'command']: answer.command }),
          },
        }],
      },
    }
  }
  return { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: answer.content ?? '' } }
}

function sseFor(answer: ReturnType<typeof buildAnswer>): string {
  const base = {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
  }
  const delta = answer.kind === 'tool-call'
    ? {
      role: 'assistant',
      tool_calls: [{
        index: 0,
        id: `call_${Date.now().toString(36)}`,
        type: 'function',
        function: {
          name: answer.toolName,
          arguments: JSON.stringify({ [answer.argumentName ?? 'command']: answer.command }),
        },
      }],
    }
    : { role: 'assistant', content: answer.content ?? '' }
  const finish = answer.kind === 'tool-call' ? 'tool_calls' : 'stop'
  return [
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}`,
    '',
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n')
}

/**
 * Start it. `port: 0` asks the OS for a free one, which is what a test should
 * use; a sitting names the port it put in the card.
 *
 * `logPath` mirrors every record to a JSONL file as it arrives, which is the
 * only way a SITTING can read this server's transcript at all: `requests()` is
 * in-process, and a sitting drives the app from a different process entirely, so
 * without the file the stub's own view of the turn is lost the moment the server
 * is stopped (DA2.10, 2026-09-17). It is the same instrument, and the same
 * argument, as `fixtures/refusing-proxy.ts`'s log — and it stays safe for the
 * same reason: {@link StubRequestRecord} carries the Authorization header's
 * LENGTH and never its value, so the file cannot hold a credential.
 */
export function startStubUpstream(options: { port?: number; logPath?: string } = {}): StubUpstream {
  const seen: StubRequestRecord[] = []
  const record = (entry: StubRequestRecord): void => {
    const stamped: StubRequestRecord = { t: new Date().toISOString(), ...entry }
    seen.push(stamped)
    if (options.logPath === undefined) return
    try {
      appendFileSync(options.logPath, `${JSON.stringify(stamped)}\n`)
    } catch {
      // A log that cannot be written must not take the upstream down with it —
      // the in-memory list is still a reading for an in-process caller, and a
      // sitting that finds an empty file blocks on its own positive control
      // rather than scoring a silence.
    }
  }
  // F1.185 — bound to the address the URL below NAMES, never the wildcard.
  // `Bun.serve` with no hostname listens on `*:<port>`, and on macOS a SECOND
  // process may still bind `127.0.0.1:<that port>`, after which every
  // connection the URL makes goes to IT. Measured 2026-09-23 on this rig, both
  // arms: wildcard bind -> a `node` listener took the port and a fetch failed
  // `Malformed_HTTP_Response` with the stub having seen 0 requests — the exact
  // error of the one-in-five `streams when asked` flake (WJ-j, load 6.61);
  // bound to 127.0.0.1 -> the second bind is refused `EADDRINUSE`. What this
  // does NOT claim: that the flake WAS this. Port-0 picks never collided in
  // either order (0 of 3000, 0 of 1500), so a shadow needs an explicit bind of
  // that number, and 1500 back-to-back runs of the two arms here reproduced
  // nothing — the flake's own cause is unnamed and registered as such. This
  // closes the one path measured to produce its error, and matches the two
  // sibling fixtures (`otlp-collector.ts`, `refusing-proxy.ts`), which already
  // listen on 127.0.0.1; it also stops the stub being reachable off-host.
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url)
      const authorization = request.headers.get('authorization') ?? ''
      if (request.method === 'GET' && url.pathname.endsWith('/models')) {
        record({
          path: url.pathname,
          authorizationLength: authorization.length,
          model: null,
          toolNames: [],
          streamed: false,
          carriedToolResult: false,
        })
        return Response.json({ object: 'list', data: [{ id: MODEL_ID, object: 'model', owned_by: 'nessy-cdp' }] })
      }
      if (request.method !== 'POST') return new Response('not found', { status: 404 })

      const body = await request.json().catch(() => ({})) as Record<string, unknown>
      const messages = Array.isArray(body.messages) ? body.messages as ChatMessage[] : []
      const toolNames = toolNamesOf(body.tools)
      const streamed = body.stream === true
      record({
        path: url.pathname,
        authorizationLength: authorization.length,
        model: typeof body.model === 'string' ? body.model : null,
        toolNames,
        streamed,
        carriedToolResult: messages.some(message => message.role === 'tool'),
      })

      const answer = buildAnswer(messages, toolNames, body.tools)
      if (!streamed) return Response.json(completion(choiceFor(answer)))
      return new Response(sseFor(answer), {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      })
    },
  })
  const port = server.port
  // Read once and REFUSED when absent: `port: 0` asks the OS for a free one, so
  // the number the caller puts in a card is the server's own answer and never
  // the number that was asked for.
  if (port === undefined) throw new Error('stub-upstream: the server reported no port')
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests: () => [...seen],
    ...(options.logPath === undefined ? {} : { logPath: options.logPath }),
    stop: () => { server.stop(true) },
  }
}

if (import.meta.main) {
  const portArgument = process.argv.indexOf('--port')
  const asked = portArgument >= 0 ? process.argv[portArgument + 1] : process.env.PORT
  const logArgument = process.argv.indexOf('--log')
  const logPath = logArgument >= 0 ? process.argv[logArgument + 1] : process.env.NESSY_CDP_STUB_LOG
  const stub = startStubUpstream({ port: Number(asked ?? 0) || 0, ...(logPath ? { logPath } : {}) })
  console.error(`stub-upstream listening on ${stub.url}`)
  console.error('point a BYO card at that base URL with ANY string as the key — this server never reads it')
  if (stub.logPath) console.error(`one JSONL record per request at ${stub.logPath} — header LENGTHS only, never a value`)
  else console.error('pass --log <path> (or NESSY_CDP_STUB_LOG) to mirror the records where a SITTING can read them')
}
