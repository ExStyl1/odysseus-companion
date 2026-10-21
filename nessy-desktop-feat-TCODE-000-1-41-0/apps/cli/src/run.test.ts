import { describe, it, expect, afterEach, mock, beforeEach } from 'bun:test'
import {
  serializeEnvelope,
  deserializeEnvelope,
} from '@nessy-agent/server-core/transport'
import type { SpawnedServer } from './server-spawner.ts'

// ---------------------------------------------------------------------------
// Mock WS server for run command tests
// ---------------------------------------------------------------------------

interface MockServerOptions {
  /** What LLM_Connection:list returns */
  connections?: unknown[]
  /** What workspaces:get returns */
  workspaces?: unknown[]
  /** Events emitted after sessions:sendMessage. */
  sessionEvents?: Array<Record<string, unknown>>
  /**
   * What `capabilities:getHeadlessInit` returns. Omitted, the channel falls to
   * the `default: result = null` arm, which is the degraded path the CLI must
   * still emit a frame for.
   */
  headlessInit?: unknown
  /**
   * C3.303 — answer `sessions:sendMessage` and then send NOTHING, so the turn
   * stays in flight until {@link MockServer.releaseSessionEvents} is called.
   *
   * Opt-in, and the default is byte-identical to what every existing case in
   * this file already gets: the events are pushed on the same 10 ms timer as
   * before unless a case asks for the hold. That is the whole of W17-d's reason
   * for not writing the `onSignal` test in place — "it changes the shared mock's
   * contract for every case" — and it does not have to.
   */
  holdSessionEvents?: boolean
  /**
   * F1.594 — never answer a request on THIS channel, so a case can land a signal
   * while the CLI is still waiting on it (the idle arm: no session, no turn).
   * Opt-in; absent, every channel is answered exactly as before.
   */
  withholdResponseOf?: string
}

interface MockServer {
  url: string
  token: string
  close: () => void
  /** Channels invoked by the client, in order */
  invokedChannels: string[]
  /** Arguments passed to sessions:create */
  createSessionArgs?: unknown[]
  /** All invocation args, keyed by channel */
  invokeArgs: Record<string, unknown[][]>
  /**
   * C3.303 — send the turn's events now. A no-op unless `holdSessionEvents` was
   * asked for, and a no-op if no send is waiting, so a case may call it
   * unconditionally in its teardown.
   */
  releaseSessionEvents: () => void
  /** D1.153 — close the live socket, i.e. the server dying unasked. */
  kill: () => void
}

function pushSessionEvents(
  ws: any,
  sessionId: string,
  events: Array<Record<string, unknown>>,
): void {
  setTimeout(() => {
    for (const ev of events) {
      ws.send(serializeEnvelope({
        id: crypto.randomUUID(),
        type: 'event',
        channel: 'session:event',
        args: [{ sessionId, ...ev }],
      }))
    }
  }, 10)
}

function createMockServer(opts?: MockServerOptions): MockServer {
  const token = 'test-token'
  const invokedChannels: string[] = []
  /** C3.303 — the held send, if any. Replaced on every send, run at most once. */
  let heldSend: (() => void) | null = null
  const invokeArgs: Record<string, unknown[][]> = {}
  let createSessionArgs: unknown[] | undefined
  const connections = opts?.connections ?? []
  const workspaces = opts?.workspaces ?? [{ id: 'ws-1', name: 'Test Workspace' }]
  const sessionEvents = opts?.sessionEvents ?? [
    { type: 'text_delta', delta: 'Hello ' },
    { type: 'text_delta', delta: 'World' },
    { type: 'complete' },
  ]

  const server = Bun.serve({
    port: 0,
    fetch(req, svr) {
      if (svr.upgrade(req)) return undefined
      return new Response('Not found', { status: 404 })
    },
    websocket: {
      message(ws, message) {
        const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)
        const envelope = deserializeEnvelope(raw)

        if (envelope.type === 'handshake') {
          ws.send(serializeEnvelope({
            id: crypto.randomUUID(),
            type: 'handshake_ack',
            clientId: 'run-test-client',
            protocolVersion: '1.0',
          }))
          return
        }

        if (envelope.type === 'request') {
          const ch = envelope.channel!
          invokedChannels.push(ch)
          if (!invokeArgs[ch]) invokeArgs[ch] = []
          invokeArgs[ch].push(envelope.args ?? [])

          let result: unknown
          switch (ch) {
            case 'workspaces:get':
              result = workspaces
              break
            case 'workspaces:create':
              result = { id: 'ws-1', name: 'ci-workspace' }
              break
            case 'projects:validateDirectory':
              result = {
                id: 'project-handle-1',
                workspaceId: 'ws-1',
                displayPath: '/tmp/ws',
                trustState: 'unknown',
                expiresAt: Date.now() + 60_000,
              }
              break
            case 'window:switchWorkspace':
              result = { ok: true }
              break
            case 'LLM_Connection:list':
              result = connections
              break
            case 'LLM_Connection:save':
              result = { ok: true }
              break
            case 'settings:setupLlmConnection':
              result = { ok: true }
              break
            case 'LLM_Connection:setDefault':
              result = { ok: true }
              break
            case 'sessions:create':
              createSessionArgs = envelope.args
              result = { id: 'run-session-1', name: 'run-test' }
              break
            case 'sessions:sendMessage': {
              ws.send(serializeEnvelope({
                id: envelope.id,
                type: 'response',
                channel: ch,
                result: { started: true },
              }))
              // C3.303 — with the hold on, the turn is answered and then left
              // in flight; without it this is the same 10 ms timer as before.
              if (opts?.holdSessionEvents) {
                heldSend = () => pushSessionEvents(ws, 'run-session-1', sessionEvents)
              } else {
                pushSessionEvents(ws, 'run-session-1', sessionEvents)
              }
              return // already sent response
            }
            case 'sessions:delete':
              result = { deleted: true }
              break
            case 'sessions:cancel':
              result = { cancelled: true }
              break
            case 'capabilities:getHeadlessInit':
              result = opts?.headlessInit ?? null
              break
            default:
              result = null
          }

          if (ch === opts?.withholdResponseOf) return // F1.594 — see the option
          ws.send(serializeEnvelope({
            id: envelope.id,
            type: 'response',
            channel: ch,
            result,
          }))
        }
      },
    },
  })

  return {
    url: `ws://localhost:${server.port}`,
    token,
    close: () => server.stop(),
    // D1.153 — the server going away WITHOUT being asked to. `stop(true)` closes
    // the live socket instead of waiting for it, which is what a `kill` on the
    // spawned server looks like from this side of the wire.
    kill: () => server.stop(true),
    invokedChannels,
    invokeArgs,
    releaseSessionEvents: () => { const send = heldSend; heldSend = null; send?.() },
    get createSessionArgs() { return createSessionArgs },
  }
}

// ---------------------------------------------------------------------------
// Mock spawnServer so cmdRun doesn't actually launch a child process
// ---------------------------------------------------------------------------

let mockWsServer: MockServer | null = null

// AGENTS.md §Traps — a `mock.module` without a SPREAD amputates every other
// export of that module for some other file in the batch, and you cannot choose
// which. D1.211 added `isServerHandshakeLine` beside `spawnServer`, so the real
// namespace is snapshotted first and spread here: only `spawnServer` is stubbed.
const realServerSpawner = { ...(await import('./server-spawner.ts')) }

/**
 * D1.154 — how long the spawned server takes to stop. 0 by default, so every
 * existing case gets byte-identical behaviour to the instant `stop` it had
 * before; only the case that needs a SLOW teardown sets it, and it restores it.
 *
 * It exists because an instant `stop()` is what made the two C3.303 cases blind
 * to this row: `onSignal` awaits `cleanup()` before its own `process.exit`, so
 * with a zero-cost stop the handler always wins the race against the main
 * path's exit and `exitCodes[0]` is 143 whether or not the main path also
 * exits. On a real codex session that same stop reaches
 * `CodexRuntimeManager.kill(graceMs = 3000)`, bounded at up to 5 s, and the
 * main path — released by the SAME cleanup's `client.destroy()` — exits in
 * milliseconds with `sendAndStream`'s `!finished` value.
 */
let mockServerStopDelayMs = 0

/** D1.233 — how many times `cmdRun` asked for a server of its own. */
let spawnServerCalls = 0

mock.module('./server-spawner.ts', () => ({
  ...realServerSpawner,
  spawnServer: async (): Promise<SpawnedServer> => {
    spawnServerCalls++
    if (!mockWsServer) throw new Error('mockWsServer not initialized')
    return {
      url: mockWsServer.url,
      token: mockWsServer.token,
      stop: async () => {
        if (mockServerStopDelayMs > 0) {
          await new Promise(r => setTimeout(r, mockServerStopDelayMs))
        }
      },
    }
  },
}))

// Import main AFTER mocking
const { parseArgs, buildCustomEndpointSetupFields, printHelp, main, signalExitCode, signalEndsTurn } = await import('./index.ts')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('run command', () => {
  beforeEach(() => {
    mockWsServer = createMockServer()
  })

  afterEach(() => {
    mockWsServer?.close()
    mockWsServer = null
  })

  it('parseArgs: run with --source accumulates sources', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--source', 'nessy-kb',
      '--source', 'github',
      'run', 'do', 'stuff',
    ])
    expect(args.command).toBe('run')
    expect(args.sources).toEqual(['nessy-kb', 'github'])
    expect(args.rest).toEqual(['do', 'stuff'])
  })

  it('parseArgs: --output-format stream-json', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--output-format', 'stream-json',
      'run', 'test',
    ])
    expect(args.outputFormat).toBe('stream-json')
  })

  it('parseArgs: --no-cleanup flag', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--no-cleanup',
      'run', 'test',
    ])
    expect(args.noCleanup).toBe(true)
  })

  it('custom endpoint setup uses the explicit model as the connection default', () => {
    const fields = buildCustomEndpointSetupFields('openai', 'tgpt/qwen35-397b-a17b-fp8')

    expect(fields).toEqual({
      customEndpoint: { api: 'openai-completions' },
      defaultModel: 'tgpt/qwen35-397b-a17b-fp8',
      models: ['tgpt/qwen35-397b-a17b-fp8'],
    })
  })

  /**
   * D1.212 — the arm that was missing, and the one the row was born from.
   *
   * The case above pins the OpenAI wire and reads as if `--base-url` selected
   * it. It does not: the wire follows `--provider`, and `--provider` defaults
   * to `anthropic`, so a `--base-url` pointed at an OpenAI-compatible stub with
   * no provider named speaks Anthropic Messages at it. Measured against a real
   * loopback stub on 2026-09-17: `POST /v1/chat/completions` with the provider
   * named, `POST /v1/v1/messages` without it. Both arms here so neither can be
   * changed without the other being read.
   */
  it('custom endpoint setup takes the ANTHROPIC wire for the default provider', () => {
    expect(buildCustomEndpointSetupFields('anthropic', 'stub-model')).toEqual({
      customEndpoint: { api: 'anthropic-messages' },
      defaultModel: 'stub-model',
      models: ['stub-model'],
    })
    // The default of `--provider` itself, so the pair above is read against the
    // value a user who names no provider actually gets. `$LLM_PROVIDER` is
    // deleted rather than overwritten for the window — the fallback reads the
    // variable, and a rig that happens to export one would make this pass for
    // the wrong reason.
    const priorProvider = process.env.LLM_PROVIDER
    delete process.env.LLM_PROVIDER
    try {
      expect(parseArgs(['bun', 'index.ts', '--base-url', 'http://127.0.0.1:1/v1', 'run', 'hi']).provider)
        .toBe('anthropic')
    } finally {
      delete process.env.LLM_PROVIDER
      if (priorProvider !== undefined) process.env.LLM_PROVIDER = priorProvider
    }
  })

  it('--base-url help names the wire it selects and how to change it', () => {
    const written: string[] = []
    const realWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => { written.push(String(chunk)); return true }) as typeof process.stdout.write
    try {
      printHelp()
    } finally {
      process.stdout.write = realWrite
    }
    const help = written.join('')

    // The two halves a user needs: which wire, and how to pick the other one.
    expect(help).toContain('follows --provider')
    expect(help).toContain('--provider openai')
    // Both concrete paths, because a stub author needs the route, not the name.
    expect(help).toContain('<url>/v1/messages')
    expect(help).toContain('<url>/chat/completions')
    // The negative arm: the bare sentence this replaced said nothing about a
    // wire at all, and a reader who met it could only learn the coupling from a
    // failing turn.
    expect(help).not.toContain('Custom API endpoint (or $LLM_BASE_URL)\n')
  })

  it('creates session with correct workspace and options', async () => {
    // We can't easily call cmdRun directly since it calls process.exit.
    // Instead, test the mock server interaction via CliRpcClient to verify
    // the channels and args that cmdRun would invoke.
    const { CliRpcClient } = await import('./client.ts')

    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    // Simulate what cmdRun does: resolve workspace, create session
    const workspaces = await client.invoke('workspaces:get') as any[]
    expect(workspaces).toHaveLength(1)

    await client.invoke('window:switchWorkspace', workspaces[0].id)

    const session = await client.invoke('sessions:create', 'ws-1', {
      permissionMode: 'bypassPermissions',
      enabledSourceSlugs: ['nessy-kb'],
    }) as { id: string }
    expect(session.id).toBe('run-session-1')

    // Verify the create args
    expect(mockWsServer!.createSessionArgs).toEqual([
      'ws-1',
      { permissionMode: 'bypassPermissions', enabledSourceSlugs: ['nessy-kb'] },
    ])

    // Verify channel order
    expect(mockWsServer!.invokedChannels).toEqual([
      'workspaces:get',
      'window:switchWorkspace',
      'sessions:create',
    ])

    client.destroy()
  })

  it('streams text events from session', async () => {
    const { CliRpcClient } = await import('./client.ts')

    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    // Subscribe and collect text deltas
    const deltas: string[] = []
    let completed = false

    const unsub = client.on('session:event', (event: unknown) => {
      const ev = event as { type: string; sessionId: string; delta?: string }
      if (ev.sessionId !== 'run-session-1') return
      if (ev.type === 'text_delta') deltas.push(ev.delta!)
      if (ev.type === 'complete') completed = true
    })

    await client.invoke('sessions:sendMessage', 'run-session-1', 'test')

    // Wait for events
    const deadline = Date.now() + 5_000
    while (!completed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }

    unsub()
    expect(completed).toBe(true)
    expect(deltas).toEqual(['Hello ', 'World'])

    client.destroy()
  })

  it('treats final text_complete as terminal when complete is absent', async () => {
    mockWsServer?.close()
    mockWsServer = createMockServer({
      sessionEvents: [{
        type: 'text_complete',
        text: 'Final answer',
        isIntermediate: false,
      }],
    })

    const { CliRpcClient } = await import('./client.ts')
    const { sendAndStream, parseArgs } = await import('./index.ts')

    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    const args = parseArgs([
      'bun', 'index.ts',
      '--send-timeout', '1000',
      '--output-format', 'stream-json',
      'run', 'test',
    ])
    const exitCode = await sendAndStream(client, 'run-session-1', 'test', args)

    expect(exitCode).toBe(0)
    expect(mockWsServer!.invokedChannels).toContain('sessions:sendMessage')

    client.destroy()
  })

  it('does not finish on a subagent text_complete carrying parentToolUseId', async () => {
    mockWsServer?.close()
    mockWsServer = createMockServer({
      sessionEvents: [{
        type: 'text_complete',
        text: 'Subagent child answer',
        isIntermediate: false,
        parentToolUseId: 'toolu_parent_1',
      }],
    })

    const { CliRpcClient } = await import('./client.ts')
    const { sendAndStream, parseArgs } = await import('./index.ts')

    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    const args = parseArgs([
      'bun', 'index.ts',
      '--send-timeout', '400',
      '--output-format', 'stream-json',
      'run', 'test',
    ])
    const exitCode = await sendAndStream(client, 'run-session-1', 'test', args)

    // The child completion must NOT terminate the parent turn: the stream
    // times out instead of finishing early.
    expect(exitCode).toBe(1)

    client.destroy()
  })

  it('treats typed_error as a terminal send failure', async () => {
    mockWsServer?.close()
    mockWsServer = createMockServer({
      sessionEvents: [{
        type: 'typed_error',
        error: {
          code: 'invalid_api_key',
          title: 'Invalid API Key',
          message: 'Your API key was rejected.',
          originalError: '401 status code (no body)',
        },
      }],
    })

    const { CliRpcClient } = await import('./client.ts')
    const { sendAndStream, parseArgs } = await import('./index.ts')

    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    const args = parseArgs([
      'bun', 'index.ts',
      '--send-timeout', '1000',
      'run', 'test',
    ])
    const exitCode = await sendAndStream(client, 'run-session-1', 'test', args)

    expect(exitCode).toBe(1)
    expect(mockWsServer!.invokedChannels).toContain('sessions:sendMessage')

    client.destroy()
  })

  it('session delete is available as an explicit RPC', async () => {
    // `run` no longer calls it (see the retention tests below), but `session
    // delete <id>` still does and the channel must keep working.
    const { CliRpcClient } = await import('./client.ts')

    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    await client.invoke('sessions:create', 'ws-1', { permissionMode: 'bypassPermissions' })
    await client.invoke('sessions:delete', 'run-session-1')

    expect(mockWsServer!.invokedChannels).toContain('sessions:create')
    expect(mockWsServer!.invokedChannels).toContain('sessions:delete')

    client.destroy()
  })

  // --- R66 · signal exit codes, session retention, unknown flags ---

  it('signalExitCode follows 128+signal: SIGTERM 143, SIGINT 130', () => {
    // `headless.md#stop-a-run-with-sigterm` — a SIGTERM'd `-p` run "exits with
    // code 143" (re-read verbatim 2026-09-11 by C3.102; the line-numbered form
    // this comment used had decayed, and the wider sentence around it was
    // rewritten — see `signalExitCode`'s docblock in `index.ts`). SIGINT's
    // 130 is already correct and is the value that must not regress; anything
    // else (including an absent signal name) keeps the interrupt code.
    expect(signalExitCode('SIGTERM')).toBe(143)
    expect(signalExitCode('SIGINT')).toBe(130)
    expect(signalExitCode(undefined)).toBe(130)
    expect(signalExitCode('SIGHUP')).toBe(130)
  })

  it('C3.265 — SIGINT ends the turn, SIGTERM leaves it unfinished for a resume', () => {
    // `headless.md#stop-a-run-with-sigterm`, read verbatim 2026-09-12 with the
    // section anchor verified on the RENDERED page: SIGTERM "leaves the turn
    // that was in progress unfinished and records no result for it. To end the
    // turn instead, send SIGINT, or call the Agent SDK's `interrupt()`, before
    // you stop the process." — and "When you resume the session, Claude Code
    // continues the turn that SIGTERM left unfinished."
    //
    // `signalEndsTurn` is the whole of that posture: it is what `onSignal` asks
    // before invoking `sessions:cancel`, so both arms are load-bearing. A
    // predicate stuck at `true` restores the cancel-on-both behaviour this row
    // replaced — a supervisor kill silently discarding a turn the user could
    // have resumed; one stuck at `false` stops Ctrl-C ending a turn at all.
    expect(signalEndsTurn('SIGTERM')).toBe(false)
    expect(signalEndsTurn('SIGINT')).toBe(true)
    // Every other signal keeps the interrupt meaning, exactly as the exit code
    // does — one signal is special and the rest behave like Ctrl-C.
    expect(signalEndsTurn(undefined)).toBe(true)
    expect(signalEndsTurn('SIGHUP')).toBe(true)

    // The two halves of one decision must not drift apart: the signal that
    // reports 143 is exactly the signal that does NOT end the turn.
    for (const signal of ['SIGTERM', 'SIGINT', undefined, 'SIGHUP']) {
      expect(signalEndsTurn(signal)).toBe(signalExitCode(signal) === 130)
    }
  })

  /**
   * C3.303 — the handler itself, driven across a real signal.
   *
   * `signalEndsTurn` and its agreement with `signalExitCode` were already
   * pinned; that `onSignal` CONSULTS it before `sessions:cancel` was visible in
   * the diff and in no assertion. A predicate stuck at `true` is caught by the
   * case above; a handler that stopped asking it is not — and that handler is
   * the only thing between a supervisor `kill` and a cancelled turn.
   *
   * ## The rig, and the one thing W17-d said it would cost
   *
   * The turn has to be IN FLIGHT when the signal lands, so the mock answers
   * `sessions:sendMessage` and then sends nothing until released
   * (`holdSessionEvents`). That option is opt-in and every other case in this
   * file keeps the 10 ms timer it always had, which is why this is not the
   * shared-contract change the proposal expected.
   *
   * `process.exit` is stubbed as a recorder, exactly as the neighbouring
   * `main()`-driving cases do. It is safe HERE for a reason worth stating: in
   * both `onSignal` and `cmdRun` the call is the last statement of its function,
   * so a no-op stub lets the frame return rather than running code that was
   * never meant to run after an exit.
   *
   * `--send-timeout 1500` bounds the unwind. After the handler's `cleanup()`
   * destroys the client, `sendAndStream`'s `while (!finished && …)` poll can
   * only end on the deadline, so without a short one this case would sit for
   * the default five minutes.
   *
   * The listeners are removed by set difference rather than by trusting
   * `main()`'s `finally`: if `main` does not return, a leaked handler would make
   * the NEXT `process.emit` run two of them, and the arms would contaminate each
   * other.
   */
  async function driveSignal(
    signal: 'SIGTERM' | 'SIGINT',
    opts?: { stopDelayMs?: number; idle?: boolean },
  ): Promise<{
    channels: string[]
    exitCodes: number[]
    /** F1.594 — the argument lists of every `sessions:cancel` the handler sent. */
    cancelArgs: unknown[][]
  }> {
    mockWsServer?.close()
    // F1.594 — the IDLE arm holds `sessions:create` unanswered, so the signal lands
    // with no session and no turn: the one state whose behaviour must NOT move.
    mockWsServer = createMockServer({
      connections: [{ slug: 'existing' }],
      holdSessionEvents: true,
      ...(opts?.idle ? { withholdResponseOf: 'sessions:create' } : {}),
    })

    const before = {
      SIGTERM: new Set(process.listeners('SIGTERM')),
      SIGINT: new Set(process.listeners('SIGINT')),
    }
    const originalExit = process.exit
    const exitCodes: number[] = []
    process.exit = ((code?: number | string | null) => {
      exitCodes.push(Number(code ?? 0))
    }) as typeof process.exit
    const originalStderr = process.stderr.write.bind(process.stderr)
    process.stderr.write = (() => true) as typeof process.stderr.write
    const originalStopDelay = mockServerStopDelayMs
    mockServerStopDelayMs = opts?.stopDelayMs ?? 0

    const until = async (predicate: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !predicate(); i++) await new Promise(r => setTimeout(r, 25))
    }

    try {
      const run = main(['bun', 'index.ts', '--send-timeout', '1500', 'run', 'hello'])
        .catch(() => { /* the destroyed client's unwind is not what is under test */ })
      // The signal must land MID-TURN: before the send there is nothing to
      // cancel, and the assertion would pass for the wrong reason. The IDLE arm
      // (F1.594) lands it on purpose while `sessions:create` is still unanswered.
      const landOn = opts?.idle ? 'sessions:create' : 'sessions:sendMessage'
      await until(() => mockWsServer!.invokedChannels.includes(landOn))
      expect(mockWsServer!.invokedChannels).toContain(landOn)
      if (opts?.idle) expect(mockWsServer!.invokedChannels).not.toContain('sessions:sendMessage')

      // The NAME is passed, because Node passes it: `process.on('SIGTERM', h)`
      // calls `h('SIGTERM')`, and `onSignal` branches on that argument. A bare
      // `process.emit('SIGTERM')` calls `onSignal(undefined)`, and
      // `signalEndsTurn(undefined)` is `true` by design (an unnamed signal keeps
      // the interrupt behaviour) — so the SIGTERM arm CANCELS and the case fails
      // for a reason that has nothing to do with the handler. Measured here
      // before it was written down.
      process.emit(signal as 'SIGTERM', signal as 'SIGTERM')
      await until(() => exitCodes.length > 0)

      const channels = [...mockWsServer!.invokedChannels]
      const cancelArgs = [...(mockWsServer!.invokeArgs['sessions:cancel'] ?? [])]
      mockWsServer!.releaseSessionEvents()
      await run
      return { channels, exitCodes, cancelArgs }
    } finally {
      process.exit = originalExit
      process.stderr.write = originalStderr
      mockServerStopDelayMs = originalStopDelay
      for (const name of ['SIGTERM', 'SIGINT'] as const) {
        for (const listener of process.listeners(name)) {
          if (!before[name].has(listener)) process.off(name, listener)
        }
      }
    }
  }

  it('F1.594 — SIGTERM interrupts the in-flight turn SILENTLY (no result recorded), and exits 143', async () => {
    const { channels, exitCodes, cancelArgs } = await driveSignal('SIGTERM')
    // THE ROW. C3.303 pinned the opposite — no `sessions:cancel` on SIGTERM —
    // and measured on a real server that left the turn RUNNING: the exit then
    // waited out the whole turn (87–102 s on all three runtimes, WJ-bi's
    // F1.559 rig), because the server's shutdown cannot run SessionEnd until
    // the turn lets go. The DECIDED contract (the help text): SIGTERM stops the
    // turn promptly and records no result for it. `silent: true` is
    // `cancelProcessing`'s existing no-row mode — the turn is stopped, and no
    // "Response interrupted" row is written.
    expect(channels).toContain('sessions:cancel')
    expect(cancelArgs).toEqual([['run-session-1', true]])
    expect(exitCodes).toEqual([143])
  })

  it('C3.303 — SIGINT DOES cancel the in-flight turn, and exits 130', async () => {
    // The control that makes the case above non-vacuous: on the identical rig,
    // with the identical timing, the other signal reaches the same handler and
    // the cancel goes out — in its unchanged, recorded form (F1.594: the wire
    // carries no `silent` argument, exactly as before).
    const { channels, exitCodes, cancelArgs } = await driveSignal('SIGINT')
    expect(channels).toContain('sessions:cancel')
    expect(cancelArgs).toEqual([['run-session-1']])
    expect(exitCodes[0]).toBe(130)
  })

  it('F1.594 — SIGTERM with NO turn in flight is unchanged: no cancel, exit 143', async () => {
    const { channels, exitCodes } = await driveSignal('SIGTERM', { idle: true })
    expect(channels).not.toContain('sessions:cancel')
    expect(exitCodes).toEqual([143])
  })

  it('F1.594 — the help text, which is the contract, says what each signal does to the turn', () => {
    const written: string[] = []
    const realWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => { written.push(String(chunk)); return true }) as typeof process.stdout.write
    try {
      printHelp()
    } finally {
      process.stdout.write = realWrite
    }
    const help = written.join('').replace(/\s+/g, ' ')
    expect(help).toContain('SIGINT ends the turn in progress; SIGTERM stops it at once but records no result, so a resume continues it.')
    // The sentence this replaced described a turn left RUNNING, which is what held the exit.
    expect(help).not.toContain('SIGTERM leaves it unfinished')
  })

  /**
   * D1.154 — the SECOND exit, which the two cases above are structurally unable
   * to see.
   *
   * They assert `exitCodes[0]`, and with an instant `stop()` the handler always
   * reaches its exit first, so a main path that ALSO exits is invisible to
   * them. It is not invisible to a supervisor: whichever exit runs first in a
   * real process ends it, and on a codex session the handler's `cleanup()`
   * reaches `CodexRuntimeManager.kill(graceMs = 3000)` — bounded at up to 5 s —
   * while the SAME cleanup's `client.destroy()` releases `sendAndStream`'s poll
   * loop, so the main path reaches ITS exit in milliseconds with the
   * `!finished` value. That is the row: a signalled codex run answering
   * `sendAndStream`'s 1 where `signalExitCode` and the other two runtimes say
   * 143.
   *
   * This arm makes the teardown cost 50 ms, which is the only variable: the
   * signal, the runtime path and every assertion above are unchanged. The
   * assertion is on the WHOLE list, because "143 is in there somewhere" is
   * exactly what was true while the row was open.
   */
  it('D1.154 — a slow teardown must not let the main path exit beside the handler', async () => {
    const { channels, exitCodes } = await driveSignal('SIGTERM', { stopDelayMs: 50 })
    expect(channels).toContain('sessions:cancel') // F1.594 — the silent interrupt
    // ONLY 143. Before the fix this read `[143, 1]`: the handler won the race on
    // this rig (its `cleanup()` starts ~100 ms before the main path's, which
    // waits out one 100 ms poll of the released loop first) and the main path
    // exited anyway, one `process.exit` later.
    expect(exitCodes).toEqual([143])
  })

  /**
   * D1.153 — the spawned server dies WITHOUT being asked, and the run must say
   * so promptly rather than sitting out its whole send timeout and then blaming
   * the turn.
   *
   * W19-r drove this on a real child (2026-09-13, C3.103): `kill -TERM` on the
   * SERVER pid, the CLI's own signal handler never fires because the CLI was not
   * signalled, and the run reported success while the background child leaked.
   * What the host can answer for is the half measured HERE, on the real
   * `sendAndStream` loop: with the socket gone, `finished` can never become
   * true, so the loop ran to `--send-timeout` (FIVE MINUTES by default) and then
   * reported *"Send timeout — no completion event received"* — a dead server
   * named as a slow turn, minutes late, and non-zero only because the timeout
   * path happens to set it.
   *
   * The client is the detector and needs no new wire: it has no auto-reconnect,
   * so `isConnected` goes false on close and stays false.
   *
   * The two assertions are the two halves of the defect — the CAUSE is named,
   * and the answer is PROMPT. Both fail at HEAD: measured before the fix, the
   * run took the full 3 000 ms budget and the message was the send-timeout one.
   */
  it('D1.153 — a run whose server dies mid-turn says so, promptly', async () => {
    mockWsServer?.close()
    mockWsServer = createMockServer({ connections: [{ slug: 'existing' }], holdSessionEvents: true })

    const originalExit = process.exit
    const exitCodes: number[] = []
    process.exit = ((code?: number | string | null) => {
      exitCodes.push(Number(code ?? 0))
    }) as typeof process.exit
    const originalStderr = process.stderr.write.bind(process.stderr)
    let stderr = ''
    process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true }) as typeof process.stderr.write

    const until = async (predicate: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !predicate(); i++) await new Promise(r => setTimeout(r, 25))
    }

    let elapsed = 0
    try {
      const run = main(['bun', 'index.ts', '--send-timeout', '3000', 'run', 'hello'])
        .catch(() => { /* the lost connection's unwind is not what is under test */ })
      await until(() => mockWsServer!.invokedChannels.includes('sessions:sendMessage'))
      expect(mockWsServer!.invokedChannels).toContain('sessions:sendMessage')

      const killedAt = Date.now()
      mockWsServer!.kill()
      await until(() => exitCodes.length > 0)
      elapsed = Date.now() - killedAt
      await run
    } finally {
      process.exit = originalExit
      process.stderr.write = originalStderr
    }

    // A CI gate reads the exit code; a human reads the line above it.
    expect(exitCodes[0]).not.toBe(0)
    expect(stderr).toContain('Connection to the server was lost')
    expect(stderr).not.toContain('Send timeout')
    // Prompt: the loop notices the closed socket on its next tick rather than
    // waiting out the budget. 3 000 ms here; 300 000 ms for a real run.
    expect(elapsed).toBeLessThan(1_500)
  })

  /**
   * D1.233 — `run --url` ATTACHES, and the flags it cannot carry say so.
   *
   * `cmdValidate` has had an `if (args.url)` branch since it was written and
   * `cmdRun` had none, so a `run` pointed at a standing server spawned a second
   * one — which, on a real rig, then died on the storage host lease. The
   * assertion that matters is the spawn COUNT: a run that attaches and a run
   * that spawns both reach the same mock socket, so nothing else in this file
   * could tell them apart.
   *
   * The negative arm is the same run without the flag, in the same file, so
   * "the counter never moves" cannot pass for a fix.
   *
   * D1.258 TOOK THE THIRD ARM AWAY, and that is the whole of the change here.
   * This case used to pass `--safe-mode` beside `--url` and assert exit 0 with
   * the flag named on stderr. That combination is now a startup REFUSAL, so
   * the flag moved to the D1.258 arms below and this case is left pinning what
   * it was written for: the spawn count.
   */
  it('D1.233 — run --url attaches instead of spawning', async () => {
    mockWsServer?.close()
    mockWsServer = createMockServer({ connections: [{ slug: 'existing' }] })

    const originalExit = process.exit
    const exitCodes: number[] = []
    process.exit = ((code?: number | string | null) => {
      exitCodes.push(Number(code ?? 0))
    }) as typeof process.exit
    const originalStderr = process.stderr.write.bind(process.stderr)
    let stderr = ''
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk)
      return true
    }) as typeof process.stderr.write

    const before = spawnServerCalls
    try {
      await main([
        'bun', 'index.ts',
        '--url', mockWsServer.url,
        '--token', mockWsServer.token,
        'run', 'hello',
      ])
    } finally {
      process.exit = originalExit
      process.stderr.write = originalStderr
    }

    expect(spawnServerCalls - before).toBe(0)
    expect(exitCodes).toEqual([0])
    expect(stderr).toContain(`Server: ${mockWsServer.url} (attached`)
    expect(stderr).not.toContain('Starting server...')
  })

  /**
   * D1.258 — the three arms, and the middle one is the row's real content.
   *
   * The spawn-only flags reach a server through the ENVIRONMENT
   * `spawnLocalServer` builds, so against an attached one they do nothing at
   * all. D1.233 printed that; this refuses it, on `headless.md:33`'s "before
   * the run starts" discipline and D1.107's `err()` + `exit(1)` shape.
   *
   * ARM 1 (positive) — the typed flag with `--url`: exit 1, the flag named,
   * and NOTHING spawned or connected. The spawn counter is the instrument that
   * separates "refused" from "attached anyway", exactly as in D1.233 above.
   *
   * ARM 2 (the boundary, and the reason `attachInertFlags` exists at all) —
   * the ENV TWIN with `--url`. `parseArgs` folds `NESSY_SAFE_MODE` into the
   * same `safeMode` field as the flag, so the obvious one-line refusal
   * (`if (args.safeMode)`) would exit(1) on an operator's inherited shell
   * variable, a combination nobody typed. This arm is what fails against that
   * spelling: it must still RUN, and report the VARIABLE name rather than a
   * flag the user never passed.
   *
   * ARM 3 (the control) — the same flag WITHOUT `--url` still spawns and still
   * succeeds, so the refusal cannot have been written as "refuse `--safe-mode`".
   */
  it('D1.258 — a spawn-only flag with --url is refused before anything connects', async () => {
    mockWsServer?.close()
    mockWsServer = createMockServer({ connections: [{ slug: 'existing' }] })

    const originalExit = process.exit
    const exitCodes: number[] = []
    process.exit = ((code?: number | string | null) => {
      exitCodes.push(Number(code ?? 0))
    }) as typeof process.exit
    const originalStderr = process.stderr.write.bind(process.stderr)
    let stderr = ''
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk)
      return true
    }) as typeof process.stderr.write

    const before = spawnServerCalls
    try {
      await main([
        'bun', 'index.ts',
        '--url', mockWsServer.url,
        '--token', mockWsServer.token,
        '--safe-mode',
        '--setting-sources', 'user',
        'run', 'hello',
      ])
    } finally {
      process.exit = originalExit
      process.stderr.write = originalStderr
    }

    expect(exitCodes[0]).toBe(1)
    expect(spawnServerCalls - before).toBe(0)
    // BEFORE THE RUN STARTS, and this is the only instrument this file has for
    // it: `process.exit` is STUBBED here (the rig records the code and
    // RETURNS), so `main()` runs on past the gate and the later lines still
    // appear. What cannot be faked is the ORDER — the refusal is the first
    // byte on stderr, ahead of the settings-sources diagnostic, the attach
    // line and the session line. Against a gate placed after any of them this
    // assertion fails while the exit code still reads 1.
    expect(stderr.startsWith('Error: --safe-mode, --setting-sources are rejected with --url')).toBe(true)
    expect(stderr.indexOf('rejected with --url')).toBeLessThan(stderr.indexOf('(attached'))
    // NEGATIVE: the two names D1.233's notice used are not flags of ours, and
    // naming one here would send the reader after a flag they cannot pass.
    expect(stderr).not.toContain('--claude-settings')
  })

  it('D1.258 — the ENV twin of the same flag is reported, not refused', async () => {
    mockWsServer?.close()
    mockWsServer = createMockServer({ connections: [{ slug: 'existing' }] })

    const originalExit = process.exit
    const exitCodes: number[] = []
    process.exit = ((code?: number | string | null) => {
      exitCodes.push(Number(code ?? 0))
    }) as typeof process.exit
    const originalStderr = process.stderr.write.bind(process.stderr)
    let stderr = ''
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk)
      return true
    }) as typeof process.stderr.write

    // `delete` first, then assign — AGENTS.md's Bun env rule, and the restore
    // path deletes rather than writing `undefined` back.
    const hadSafeMode = Object.prototype.hasOwnProperty.call(process.env, 'NESSY_SAFE_MODE')
    const previousSafeMode = process.env.NESSY_SAFE_MODE
    delete process.env.NESSY_SAFE_MODE
    process.env.NESSY_SAFE_MODE = '1'

    const before = spawnServerCalls
    try {
      await main([
        'bun', 'index.ts',
        '--url', mockWsServer.url,
        '--token', mockWsServer.token,
        'run', 'hello',
      ])
    } finally {
      delete process.env.NESSY_SAFE_MODE
      if (hadSafeMode && previousSafeMode !== undefined) process.env.NESSY_SAFE_MODE = previousSafeMode
      process.exit = originalExit
      process.stderr.write = originalStderr
    }

    // The run happened. A refusal written against `args.safeMode` fails here.
    expect(exitCodes).toEqual([0])
    expect(spawnServerCalls - before).toBe(0)
    expect(stderr).toContain('(attached')
    // Reported by VARIABLE name, because no flag was typed.
    expect(stderr).toContain('NESSY_SAFE_MODE')
    expect(stderr).not.toContain('rejected with --url')
  })

  it('D1.258 — the control: the same flag WITHOUT --url still spawns and runs', async () => {
    mockWsServer?.close()
    mockWsServer = createMockServer({ connections: [{ slug: 'existing' }] })

    const originalExit = process.exit
    const exitCodes: number[] = []
    process.exit = ((code?: number | string | null) => {
      exitCodes.push(Number(code ?? 0))
    }) as typeof process.exit
    const originalStderr = process.stderr.write.bind(process.stderr)
    let stderr = ''
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk)
      return true
    }) as typeof process.stderr.write

    const before = spawnServerCalls
    try {
      await main(['bun', 'index.ts', '--safe-mode', 'run', 'hello'])
    } finally {
      process.exit = originalExit
      process.stderr.write = originalStderr
    }

    expect(exitCodes).toEqual([0])
    expect(spawnServerCalls - before).toBe(1)
    expect(stderr).not.toContain('rejected with --url')
  })

  it('D1.233 — the control: the same run WITHOUT --url still spawns one', async () => {
    mockWsServer?.close()
    mockWsServer = createMockServer({ connections: [{ slug: 'existing' }] })

    const originalExit = process.exit
    const exitCodes: number[] = []
    process.exit = ((code?: number | string | null) => {
      exitCodes.push(Number(code ?? 0))
    }) as typeof process.exit
    const originalStderr = process.stderr.write.bind(process.stderr)
    let stderr = ''
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk)
      return true
    }) as typeof process.stderr.write

    const before = spawnServerCalls
    try {
      await main(['bun', 'index.ts', 'run', 'hello'])
    } finally {
      process.exit = originalExit
      process.stderr.write = originalStderr
    }

    expect(spawnServerCalls - before).toBe(1)
    expect(exitCodes).toEqual([0])
    expect(stderr).toContain('Starting server...')
    expect(stderr).not.toContain('(attached')
  })

  it('a default run keeps its session — no sessions:delete on the way out', async () => {
    // `best-practices.md:469` — "The run still creates a resumable session
    // unless you pass `--no-session-persistence`."
    mockWsServer?.close()
    mockWsServer = createMockServer({ connections: [{ slug: 'existing' }] })

    const originalExit = process.exit
    const exitCodes: number[] = []
    process.exit = ((code?: number | string | null) => {
      exitCodes.push(Number(code ?? 0))
    }) as typeof process.exit
    const originalStderr = process.stderr.write.bind(process.stderr)
    let stderr = ''
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk)
      return true
    }) as typeof process.stderr.write

    try {
      await main(['bun', 'index.ts', 'run', 'hello'])
    } finally {
      process.exit = originalExit
      process.stderr.write = originalStderr
    }

    expect(exitCodes).toEqual([0])
    expect(mockWsServer!.invokedChannels).not.toContain('sessions:delete')
    // A kept session needs a handle, and text mode never printed one before.
    expect(stderr).toContain('Session: run-session-1')
    // Not persisted, so `ephemeral` stays off the options object entirely.
    const createOptions = mockWsServer!.createSessionArgs![1] as Record<string, unknown>
    expect(createOptions.ephemeral).toBeUndefined()
  })

  it('--no-cleanup is accepted and no longer changes anything', async () => {
    mockWsServer?.close()
    mockWsServer = createMockServer({ connections: [{ slug: 'existing' }] })

    const originalExit = process.exit
    const exitCodes: number[] = []
    process.exit = ((code?: number | string | null) => {
      exitCodes.push(Number(code ?? 0))
    }) as typeof process.exit

    try {
      await main(['bun', 'index.ts', '--no-cleanup', 'run', 'hello'])
    } finally {
      process.exit = originalExit
    }

    expect(exitCodes).toEqual([0])
    expect(mockWsServer!.invokedChannels).not.toContain('sessions:delete')
    // And it never became a prompt word.
    expect(mockWsServer!.invokeArgs['sessions:sendMessage']![0]![1]).toBe('hello')
  })

  it('--no-session-persistence creates the session ephemeral and prints no handle', async () => {
    // `cli-reference.md:105` — "sessions are not saved to disk and cannot be
    // resumed", i.e. never written, which is what `ephemeral` means here.
    mockWsServer?.close()
    mockWsServer = createMockServer({ connections: [{ slug: 'existing' }] })

    const originalExit = process.exit
    const exitCodes: number[] = []
    process.exit = ((code?: number | string | null) => {
      exitCodes.push(Number(code ?? 0))
    }) as typeof process.exit
    const originalStderr = process.stderr.write.bind(process.stderr)
    let stderr = ''
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk)
      return true
    }) as typeof process.stderr.write

    try {
      await main(['bun', 'index.ts', '--no-session-persistence', 'run', 'hello'])
    } finally {
      process.exit = originalExit
      process.stderr.write = originalStderr
    }

    expect(exitCodes).toEqual([0])
    const createOptions = mockWsServer!.createSessionArgs![1] as Record<string, unknown>
    expect(createOptions.ephemeral).toBe(true)
    // Nothing was written, so there is no resumable handle to advertise.
    expect(stderr).not.toContain('Session: run-session-1')
    // Still nothing to delete — the record never existed.
    expect(mockWsServer!.invokedChannels).not.toContain('sessions:delete')
    // The prompt is the prompt, not the prompt plus the flag.
    expect(mockWsServer!.invokeArgs['sessions:sendMessage']![0]![1]).toBe('hello')
  })

  it('an unknown flag exits 1 on stderr before the run starts', async () => {
    // `headless.md:33` — "If you pass an invalid flag, Claude Code reports the
    // error to stderr before the run starts." Before: no server, no session,
    // no message. This used to run at bypassPermissions with the flag text
    // concatenated into the prompt.
    mockWsServer?.close()
    mockWsServer = createMockServer({ connections: [{ slug: 'existing' }] })

    const originalExit = process.exit
    const exitCodes: number[] = []
    process.exit = ((code?: number | string | null) => {
      exitCodes.push(Number(code ?? 0))
      throw new Error(`process.exit(${code})`)
    }) as typeof process.exit
    const originalStderr = process.stderr.write.bind(process.stderr)
    let stderr = ''
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk)
      return true
    }) as typeof process.stderr.write

    try {
      await main([
        'bun', 'index.ts',
        'run', 'Fix the lint', '--allowedTools', 'Bash,Read',
      ]).catch(() => {})
    } finally {
      process.exit = originalExit
      process.stderr.write = originalStderr
    }

    expect(exitCodes[0]).toBe(1)
    expect(stderr).toContain('Unknown flag: --allowedTools')
    expect(mockWsServer!.invokedChannels).toEqual([])
  })

  it('spawnServer mock returns expected url and token', async () => {
    const { spawnServer } = await import('./server-spawner.ts')
    const server = await spawnServer()

    expect(server.url).toBe(mockWsServer!.url)
    expect(server.token).toBe(mockWsServer!.token)
    expect(typeof server.stop).toBe('function')
  })

  it('parseArgs: --json-schema captures the raw schema string', () => {
    const schema = '{"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}}'
    const args = parseArgs(['bun', 'index.ts', '--output-format', 'json', '--json-schema', schema, 'run', 'give json'])
    expect(args.jsonSchema).toBe(schema)
    expect(args.outputFormat).toBe('json')
    expect(parseArgs(['bun', 'index.ts', 'run', 'x']).jsonSchema).toBe('')
  })

  it('run --output-format json --json-schema sends the schema on the message options and prints .structured_output', async () => {
    const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }
    mockWsServer?.close()
    mockWsServer = createMockServer({
      connections: [{ slug: 'existing' }],
      sessionEvents: [
        { type: 'text_delta', delta: '{"ok":' },
        { type: 'text_delta', delta: 'true}' },
        { type: 'text_complete', text: '{"ok":true}', isIntermediate: false },
        { type: 'complete', structuredOutputSubtype: 'success', structuredOutput: { ok: true } },
      ],
    })

    const originalExit = process.exit
    const exitCodes: number[] = []
    process.exit = ((code?: number | string | null) => {
      exitCodes.push(Number(code ?? 0))
    }) as typeof process.exit
    const originalWrite = process.stdout.write.bind(process.stdout)
    let stdout = ''
    process.stdout.write = ((chunk: unknown) => {
      stdout += String(chunk)
      return true
    }) as typeof process.stdout.write

    try {
      await main([
        'bun', 'index.ts',
        '--output-format', 'json',
        '--json-schema', JSON.stringify(schema),
        'run', 'give me json',
      ])
    } finally {
      process.exit = originalExit
      process.stdout.write = originalWrite
    }

    expect(exitCodes).toEqual([0])
    // The schema rode the sessions:sendMessage options (5th positional arg).
    const sendArgs = mockWsServer!.invokeArgs['sessions:sendMessage']![0]!
    expect(sendArgs[4]).toEqual({ outputSchema: schema })
    // P6.371 · this assertion used to read the BARE validated object, which is
    // precisely why the documented `jq '.structured_output'` resolved to null.
    // With `--output-format json` the value now rides the envelope, at the path
    // `headless.md#get-structured-output`'s own example reads.
    const envelope = JSON.parse(stdout.trim())
    expect(envelope.structured_output).toEqual({ ok: true })
    expect(envelope.type).toBe('result')
    expect(envelope.session_id).toBe('run-session-1')
  })

  it('run --json-schema with an invalid schema fails with the documented error and a non-zero exit', async () => {
    mockWsServer?.close()
    mockWsServer = createMockServer({ connections: [{ slug: 'existing' }] })

    const originalExit = process.exit
    const exitCodes: number[] = []
    process.exit = ((code?: number | string | null) => {
      exitCodes.push(Number(code ?? 0))
      // main() does not return after exit in production; emulate by throwing.
      throw new Error(`process.exit(${code})`)
    }) as typeof process.exit
    const originalError = process.stderr.write.bind(process.stderr)
    let stderr = ''
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk)
      return true
    }) as typeof process.stderr.write

    try {
      await main([
        'bun', 'index.ts',
        '--output-format', 'json',
        '--json-schema', '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}',
        'run', 'give me json',
      ]).catch(() => {})
    } finally {
      process.exit = originalExit
      process.stderr.write = originalError
    }

    expect(exitCodes[0]).toBe(1)
    // cli-reference/headless.md exact failure string.
    expect(stderr).toContain('--json-schema is not a valid JSON Schema')
    // The gate fails BEFORE any message is sent.
    expect(mockWsServer!.invokedChannels).not.toContain('sessions:sendMessage')
  })

  it('sendAndStream exits non-zero when a schema-bearing run ends without a valid structured output', async () => {
    mockWsServer?.close()
    mockWsServer = createMockServer({
      sessionEvents: [{
        type: 'complete',
        structuredOutputSubtype: 'error_max_structured_output_retries',
        structuredOutputErrors: ['$ must have required property \'ok\''],
        terminalReason: 'structured_output_retry_exhausted',
      }],
    })

    const { CliRpcClient } = await import('./client.ts')
    const { sendAndStream, parseArgs } = await import('./index.ts')
    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    const args = parseArgs([
      'bun', 'index.ts',
      '--send-timeout', '2000',
      '--output-format', 'json',
      '--json-schema', '{"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}}',
      'run', 'test',
    ])
    const exitCode = await sendAndStream(client, 'run-session-1', 'test', args)

    expect(exitCode).toBe(1)
    client.destroy()
  })

  it('parseArgs: --workspace-dir sets workspaceDir', () => {
    const args = parseArgs([
      'bun', 'index.ts',
      '--workspace-dir', '/tmp/my-workspace',
      'run', 'hello',
    ])
    expect(args.workspaceDir).toBe('/tmp/my-workspace')
    expect(args.command).toBe('run')
  })

  it('parseArgs: workspaceDir defaults to undefined', () => {
    const args = parseArgs(['bun', 'index.ts', 'run', 'hello'])
    expect(args.workspaceDir).toBeUndefined()
  })

  it('run --workspace-dir uses the name-only Workspace and project-handle flow', async () => {
    mockWsServer?.close()
    mockWsServer = createMockServer({
      connections: [{ slug: 'existing' }],
      workspaces: [],
    })
    const originalExit = process.exit
    const exitCodes: number[] = []
    process.exit = ((code?: number | string | null) => {
      exitCodes.push(Number(code ?? 0))
    }) as typeof process.exit

    try {
      await main([
        'bun', 'index.ts',
        '--workspace-dir', '/tmp/ws',
        '--source', 'nessy-public',
        'run', 'hello',
      ])
    } finally {
      process.exit = originalExit
    }

    expect(exitCodes).toEqual([0])
    expect(mockWsServer!.invokeArgs['workspaces:create']![0]).toEqual(['ci-workspace'])
    expect(mockWsServer!.invokeArgs['projects:validateDirectory']![0]).toEqual([{
      workspaceId: 'ws-1',
      candidatePath: '/tmp/ws',
    }])
    expect(mockWsServer!.createSessionArgs).toEqual([
      'ws-1',
      {
        // T3: no --permission-mode was passed, so this is the no-flag
        // default — `default`, never a silent bypass.
        permissionMode: 'default',
        enabledSourceSlugs: ['nessy-public'],
        projectHandleId: 'project-handle-1',
      },
    ])
    expect(mockWsServer!.invokedChannels).not.toContain('projects:setTrust')
  })

  // --- T3 · `run` stops defaulting to bypassPermissions ---

  it('a run with no --permission-mode creates the session in default mode, not bypassPermissions', async () => {
    // `headless.md`'s bare `run` must not silently grant bypass — the no-flag
    // default is `default`, matching an interactive session with no mode
    // flag. This is the minimal case, isolated from the workspace-dir/source
    // flags the test above also covers.
    mockWsServer?.close()
    mockWsServer = createMockServer({ connections: [{ slug: 'existing' }] })
    const originalExit = process.exit
    const exitCodes: number[] = []
    process.exit = ((code?: number | string | null) => {
      exitCodes.push(Number(code ?? 0))
    }) as typeof process.exit

    try {
      await main(['bun', 'index.ts', 'run', 'hello'])
    } finally {
      process.exit = originalExit
    }

    expect(exitCodes).toEqual([0])
    const createOptions = mockWsServer!.createSessionArgs![1] as Record<string, unknown>
    expect(createOptions.permissionMode).toBe('default')
  })

  it('--dangerously-skip-permissions creates the session with bypassPermissions, same as --permission-mode bypassPermissions', async () => {
    mockWsServer?.close()
    mockWsServer = createMockServer({ connections: [{ slug: 'existing' }] })
    const originalExit = process.exit
    const exitCodes: number[] = []
    process.exit = ((code?: number | string | null) => {
      exitCodes.push(Number(code ?? 0))
    }) as typeof process.exit

    try {
      await main(['bun', 'index.ts', '--dangerously-skip-permissions', 'run', 'hello'])
    } finally {
      process.exit = originalExit
    }

    expect(exitCodes).toEqual([0])
    const createOptions = mockWsServer!.createSessionArgs![1] as Record<string, unknown>
    expect(createOptions.permissionMode).toBe('bypassPermissions')
    // The flag consumed no positional — the prompt is still just "hello".
    expect(mockWsServer!.invokeArgs['sessions:sendMessage']![0]![1]).toBe('hello')
  })

  it('auto-denies a permission_request in a non-interactive run: same RPC an interactive client uses, one stderr line, exit 1', async () => {
    // Rung 1 of the T3 ladder: `permission_request` already rides the same
    // `session:event` channel `sendAndStream` subscribes to, and
    // `sessions:respondToPermission` is the same RPC an interactive client
    // (Electron/iOS) already calls to answer one — no new wire. A
    // non-interactive run has no dialog to show, so it denies immediately
    // instead of hanging until --send-timeout (headless.md: "the run aborts
    // when one is attempted").
    mockWsServer?.close()
    mockWsServer = createMockServer({
      sessionEvents: [{
        type: 'permission_request',
        request: {
          requestId: 'perm-1',
          toolName: 'Bash',
          command: 'rm -rf /tmp/should-not-run',
          description: 'Execute bash command: rm -rf /tmp/should-not-run',
        },
      }],
    })

    const { CliRpcClient } = await import('./client.ts')
    const { sendAndStream, parseArgs } = await import('./index.ts')
    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    const originalStderr = process.stderr.write.bind(process.stderr)
    let stderr = ''
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk)
      return true
    }) as typeof process.stderr.write

    const args = parseArgs([
      'bun', 'index.ts',
      '--send-timeout', '800',
      'run', 'test',
    ])

    let exitCode: number
    try {
      exitCode = await sendAndStream(client, 'run-session-1', 'test', args)
    } finally {
      process.stderr.write = originalStderr
    }

    expect(exitCode).toBe(1)
    expect(stderr).toContain(
      'permission denied (non-interactive run): pass --permission-mode bypassPermissions or pre-approve with allow rules',
    )
    expect(mockWsServer!.invokedChannels).toContain('sessions:respondToPermission')
    expect(mockWsServer!.invokeArgs['sessions:respondToPermission']![0]).toEqual([
      'run-session-1', 'perm-1', false, false,
    ])

    client.destroy()
  })

  it('LLM bootstrap calls save, setup, and setDefault when no connections exist', async () => {
    // Server returns empty connections list
    mockWsServer?.close()
    mockWsServer = createMockServer({ connections: [] })

    const { CliRpcClient } = await import('./client.ts')
    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    // Simulate the LLM bootstrap path from cmdRun
    const connections = (await client.invoke('LLM_Connection:list')) as any[]
    expect(connections).toEqual([])

    await client.invoke('LLM_Connection:save', {
      slug: 'anthropic-api',
      name: 'Anthropic',
      providerType: 'anthropic',
      authType: 'api_key',
      createdAt: 123,
    })
    await client.invoke('settings:setupLlmConnection', {
      slug: 'anthropic-api',
      credential: 'sk-test-key',
    })
    await client.invoke('LLM_Connection:setDefault', 'anthropic-api')

    expect(mockWsServer!.invokedChannels).toEqual([
      'LLM_Connection:list',
      'LLM_Connection:save',
      'settings:setupLlmConnection',
      'LLM_Connection:setDefault',
    ])

    client.destroy()
  })

  it('LLM bootstrap is skipped when connections already exist', async () => {
    // Server returns existing connection
    mockWsServer?.close()
    mockWsServer = createMockServer({
      connections: [{ slug: 'existing', name: 'Existing' }],
    })

    const { CliRpcClient } = await import('./client.ts')
    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()

    // Simulate: check connections — they exist, so skip bootstrap
    const connections = (await client.invoke('LLM_Connection:list')) as any[]
    expect(connections).toHaveLength(1)

    // No further LLM calls should be needed
    expect(mockWsServer!.invokedChannels).toEqual(['LLM_Connection:list'])

    client.destroy()
  })
})

// ---------------------------------------------------------------------------
// R59 — the headless stream's mandated first line
// ---------------------------------------------------------------------------

/**
 * `best-practices.md:482`, whole line:
 *
 * > The first command prints plain text. The `json` format returns a single
 * > JSON object with a `result` field. The `stream-json` format prints one JSON
 * > object per line, starting with an init event.
 *
 * `headless.md:197` names that frame `system/init` and makes it "the first event
 * in the stream unless startup events precede it". Before this the first line a
 * CI job read was whichever `session:event` arrived first, so a `jq` gate on
 * line 1 matched nothing and passed silently.
 */
describe('stream-json init frame', () => {
  let written: string[] = []
  let restore: (() => void) | null = null

  function captureStdout(): void {
    written = []
    const original = process.stdout.write.bind(process.stdout)
    ;(process.stdout as unknown as { write: unknown }).write = ((chunk: unknown, ...rest: unknown[]) => {
      written.push(String(chunk))
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stdout.write
    restore = () => { (process.stdout as unknown as { write: unknown }).write = original }
  }

  beforeEach(() => {
    mockWsServer = createMockServer()
  })

  afterEach(() => {
    restore?.()
    restore = null
    mockWsServer?.close()
    mockWsServer = null
  })

  /** Every stdout line the run produced, in order, blank lines dropped. */
  function lines(): string[] {
    return written.join('').split('\n').filter(line => line.length > 0)
  }

  // `workspaceId` is REQUIRED, deliberately: a default of `'ws-1'` would be
  // supplied for an explicit `undefined` too, and the no-workspace case below
  // would silently exercise the bound path instead.
  async function runStream(
    extraArgs: string[],
    workspaceId: string | undefined,
  ): Promise<number> {
    const { CliRpcClient } = await import('./client.ts')
    const { sendAndStream, parseArgs } = await import('./index.ts')
    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()
    const args = parseArgs([
      'bun', 'index.ts',
      '--send-timeout', '2000',
      ...extraArgs,
      'run', 'test',
    ])
    captureStdout()
    try {
      return await sendAndStream(client, 'run-session-1', 'test', args, workspaceId)
    } finally {
      restore?.()
      restore = null
      client.destroy()
    }
  }

  it('writes the init frame as line 1, ahead of the first session event', async () => {
    mockWsServer!.close()
    mockWsServer = createMockServer({
      headlessInit: {
        plugins: [{ name: 'Plugin P', path: '/bundles/m/p/1.0.0' }],
        mcp_servers: [{ name: 'internal', status: 'pending' }],
      },
    })

    const exitCode = await runStream(['--output-format', 'stream-json', '--model', 'test-model'], 'ws-1')
    expect(exitCode).toBe(0)

    const emitted = lines()
    const frame = JSON.parse(emitted[0]!)
    expect(frame).toMatchObject({
      type: 'system',
      subtype: 'init',
      session_id: 'run-session-1',
      model: 'test-model',
      output_format: 'stream-json',
      plugins: [{ name: 'Plugin P', path: '/bundles/m/p/1.0.0' }],
      mcp_servers: [{ name: 'internal', status: 'pending' }],
    })
    // A healthy run omits BOTH keys — `headless.md:220`, "The key is omitted
    // when there are no errors, so a CI gate can fail on a non-empty array."
    // Asserted as absence, never falsiness: `[]` would pass a falsy check and
    // fail the gate.
    expect('plugin_errors' in frame).toBe(false)
    expect('mcp_server_errors' in frame).toBe(false)

    // Line 2 onward is the untouched verbatim event passthrough.
    expect(JSON.parse(emitted[1]!)).toMatchObject({ type: 'text_delta', sessionId: 'run-session-1' })
  })

  it('carries both error arrays when the capability read reports failures', async () => {
    mockWsServer!.close()
    mockWsServer = createMockServer({
      headlessInit: {
        plugins: [],
        plugin_errors: [{ plugin: 'Plugin P', type: 'dependency-unsatisfied', message: 'needs absent-plugin' }],
        mcp_servers: [],
        mcp_server_errors: [{ name: 'broken-source', type: 'unknown_type', message: 'no type' }],
      },
    })

    await runStream(['--output-format', 'stream-json'], 'ws-1')

    const frame = JSON.parse(lines()[0]!)
    expect(frame.plugin_errors).toEqual([
      { plugin: 'Plugin P', type: 'dependency-unsatisfied', message: 'needs absent-plugin' },
    ])
    expect(frame.mcp_server_errors).toEqual([
      { name: 'broken-source', type: 'unknown_type', message: 'no type' },
    ])
    // A demoted plugin is absent from `plugins`, so the two never disagree.
    expect(frame.plugins).toEqual([])
  })

  it('still writes a frame when the capability read is unavailable', async () => {
    // No bound workspace, so the scope-checked RPC is never attempted. The
    // frame's existence is bound by `best-practices.md:482` independently of
    // whether the field data resolved — degrade, never abort.
    const exitCode = await runStream(['--output-format', 'stream-json'], undefined)

    expect(exitCode).toBe(0)
    const frame = JSON.parse(lines()[0]!)
    expect(frame).toMatchObject({ type: 'system', subtype: 'init', plugins: [], mcp_servers: [] })
    expect('plugin_errors' in frame).toBe(false)
    expect('mcp_server_errors' in frame).toBe(false)
    expect(mockWsServer!.invokedChannels).not.toContain('capabilities:getHeadlessInit')
  })

  it('writes no frame in text mode', async () => {
    const exitCode = await runStream([], 'ws-1')

    expect(exitCode).toBe(0)
    expect(written.join('')).not.toContain('"subtype":"init"')
    expect(written.join('')).toContain('Hello ')
  })
})

// ---------------------------------------------------------------------------
// P6.371 — `--output-format json` branched nowhere
// ---------------------------------------------------------------------------

/**
 * `headless.md#get-structured-output`, verbatim on the three format values:
 *
 * > * `text` (default): plain text output
 * > * `json`: structured JSON with result, session ID, and metadata
 * > * `stream-json`: newline-delimited JSON for real-time streaming
 *
 * and its `jq` examples are the field contract — `jq -r '.result'` on a plain
 * run, `jq '.structured_output'` on a schema-bearing one.
 *
 * Before this row `--output-format json` parsed at `parseArgs` and was read
 * NOWHERE: the only consumer was `outputFormat === 'stream-json'`, so `json`
 * printed exactly what `text` printed and both documented `jq` paths resolved
 * to null. These three cases drive all three format values through the same
 * mock server, so a mutation that removes the `json` branch cannot pass by
 * making `text` look right.
 */
describe('P6.371 · --output-format json envelope', () => {
  let written: string[] = []
  let restore: (() => void) | null = null

  function captureStdout(): void {
    written = []
    const original = process.stdout.write.bind(process.stdout)
    ;(process.stdout as unknown as { write: unknown }).write = ((chunk: unknown) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    restore = () => { (process.stdout as unknown as { write: unknown }).write = original }
  }

  afterEach(() => {
    restore?.()
    restore = null
    mockWsServer?.close()
    mockWsServer = null
  })

  async function runWith(extraArgs: string[], events?: Array<Record<string, unknown>>): Promise<{ exitCode: number; stdout: string }> {
    mockWsServer?.close()
    mockWsServer = createMockServer(events ? { sessionEvents: events } : undefined)
    const { CliRpcClient } = await import('./client.ts')
    const { sendAndStream, parseArgs } = await import('./index.ts')
    const client = new CliRpcClient(mockWsServer!.url, {
      token: mockWsServer!.token,
      requestTimeout: 5_000,
    })
    await client.connect()
    const args = parseArgs(['bun', 'index.ts', '--send-timeout', '3000', ...extraArgs, 'run', 'test'])
    captureStdout()
    try {
      const exitCode = await sendAndStream(client, 'run-session-1', 'test', args)
      return { exitCode, stdout: written.join('') }
    } finally {
      restore?.()
      restore = null
      client.destroy()
    }
  }

  it('json prints one envelope whose .result and .session_id resolve', async () => {
    const { exitCode, stdout } = await runWith(['--output-format', 'json'], [
      { type: 'text_delta', delta: 'Hello ' },
      { type: 'text_delta', delta: 'World' },
      { type: 'complete', usage: { inputTokens: 11, outputTokens: 3, costUsd: 0.25 } },
    ])

    expect(exitCode).toBe(0)
    // ONE object on stdout, and nothing streamed ahead of it.
    const envelope = JSON.parse(stdout)
    expect(envelope.type).toBe('result')
    expect(envelope.subtype).toBe('success')
    expect(envelope.is_error).toBe(false)
    expect(envelope.result).toBe('Hello World')
    expect(envelope.session_id).toBe('run-session-1')
    expect(typeof envelope.duration_ms).toBe('number')
    expect(envelope.usage).toEqual({ input_tokens: 11, output_tokens: 3 })
    expect(envelope.total_cost_usd).toBe(0.25)
    // No schema rode this run, so the key is absent rather than null.
    expect('structured_output' in envelope).toBe(false)
  })

  it('text streams the deltas and prints no envelope (the byte-identical control)', async () => {
    const { exitCode, stdout } = await runWith([], [
      { type: 'text_delta', delta: 'Hello ' },
      { type: 'text_delta', delta: 'World' },
      { type: 'complete', usage: { inputTokens: 11, outputTokens: 3, costUsd: 0.25 } },
    ])

    expect(exitCode).toBe(0)
    expect(stdout).toBe('Hello World\n')
  })

  it('stream-json still prints one object per event and no envelope', async () => {
    const { exitCode, stdout } = await runWith(['--output-format', 'stream-json'], [
      { type: 'text_delta', delta: 'Hello' },
      { type: 'complete' },
    ])

    expect(exitCode).toBe(0)
    const emitted = stdout.split('\n').filter(l => l.length > 0).map(l => JSON.parse(l))
    expect(emitted.some(o => o.type === 'text_delta')).toBe(true)
    expect(emitted.some(o => o.type === 'result')).toBe(false)
  })

  it('a schema-bearing json run resolves jq .structured_output', async () => {
    const { exitCode, stdout } = await runWith([
      '--output-format', 'json',
      '--json-schema', '{"type":"object","properties":{"ok":{"type":"boolean"}}}',
    ], [
      { type: 'complete', structuredOutputSubtype: 'success', structuredOutput: { ok: true } },
    ])

    expect(exitCode).toBe(0)
    const envelope = JSON.parse(stdout)
    expect(envelope.structured_output).toEqual({ ok: true })
    expect(envelope.is_error).toBe(false)
  })

  it('a schema-bearing run WITHOUT --output-format json still prints the bare object', async () => {
    const { exitCode, stdout } = await runWith([
      '--json-schema', '{"type":"object","properties":{"ok":{"type":"boolean"}}}',
    ], [
      { type: 'complete', structuredOutputSubtype: 'success', structuredOutput: { ok: true } },
    ])

    expect(exitCode).toBe(0)
    // The bare validated object, exactly as before this row — no envelope keys.
    expect(JSON.parse(stdout)).toEqual({ ok: true })
  })

  it('a failed run still prints an envelope, with is_error set', async () => {
    const { exitCode, stdout } = await runWith(['--output-format', 'json'], [
      { type: 'error', error: 'upstream refused' },
    ])

    expect(exitCode).toBe(1)
    const envelope = JSON.parse(stdout)
    expect(envelope.is_error).toBe(true)
    expect(envelope.subtype).toBe('error_during_execution')
    expect(envelope.session_id).toBe('run-session-1')
  })
})
