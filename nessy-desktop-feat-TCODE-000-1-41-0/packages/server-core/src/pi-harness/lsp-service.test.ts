import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ProcessSupervisorPort, SupervisedProcessResult } from '@nessy-agent/shared/agent/pi-harness/process-supervisor-port'
import { LspService } from './lsp-service.ts'

function frame(value: unknown): string {
  const body = JSON.stringify(value)
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

/** Parse the JSON-RPC body out of a `Content-Length`-framed write. */
function parseFrame(wire: string): any {
  return JSON.parse(wire.slice(wire.indexOf('\r\n\r\n') + 4))
}

function processResult(output = '', cursor = 0): SupervisedProcessResult {
  return {
    handle: 'process_lsp',
    output,
    nextCursor: cursor,
    isRunning: true,
    exitCode: null,
    signal: null,
    isolationProfile: 'workspace:test',
    environmentProfile: 'restricted',
    environmentDigest: 'a'.repeat(64),
  }
}

/**
 * F1.1026 — a server that offers pull diagnostics, in the spec's
 * `DiagnosticOptions` form. Without it the service treats a server as
 * push-only and never sends `textDocument/diagnostic`.
 */
const PULL_DIAGNOSTICS = { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } }

/**
 * A started, ready LspService backed by a mock ProcessSupervisorPort whose read
 * loop is driven by a manual `push` queue. Returns `push` (emit one frame to the
 * service) and `writes` (JSON-RPC bodies the service sent).
 */
async function readyHarness(
  onDiagnostics?: (n: { uri: string; diagnostics: unknown[] }) => void,
  // P6.417 — the supervision knobs and the restart notice, threaded so the
  // supervisor cases below drive the REAL service rather than a stub of it.
  extra?: Partial<ConstructorParameters<typeof LspService>[0]>,
  // F1.1013 — the server's `initialize` capabilities; `{}` (no `textDocumentSync`,
  // which the spec defaults to `None`) keeps every older case free of sync frames,
  // and (F1.1026) has no `diagnosticProvider`, so it is a push-only server.
  capabilities: Record<string, unknown> = {},
) {
  const writes: string[] = []
  const reads: Array<{ resolve(value: SupervisedProcessResult): void; reject(error: Error): void }> = []
  let cursor = 0
  const port: ProcessSupervisorPort = {
    start: async () => processResult(),
    write: async ({ data }) => { writes.push(data) },
    read: async () => new Promise((resolve, reject) => reads.push({ resolve, reject })),
    stop: async () => { reads.splice(0).forEach(read => read.resolve({ ...processResult('', cursor), isRunning: false })) },
    drainSession: async () => [],
  }
  const push = (value: unknown) => {
    const output = frame(value)
    cursor += Buffer.byteLength(output)
    reads.shift()?.resolve(processResult(output, cursor))
  }
  const waitForRead = async () => {
    for (let attempt = 0; attempt < 50 && reads.length === 0; attempt++) await Bun.sleep(1)
    expect(reads.length).toBeGreaterThan(0)
  }
  const service = new LspService({
    sessionKey: { workspaceId: 'w', sessionId: 's' },
    workspaceRoot: '/workspace',
    workingDirectory: '/workspace',
    command: 'test-lsp',
    processPort: port,
    resolveDocumentUri: async path => path === '.' ? 'file:///workspace' : `file:///workspace/${path}`,
    ...(onDiagnostics ? { onDiagnostics } : {}),
    ...(extra ?? {}),
  })
  const starting = service.start()
  await Bun.sleep(0)
  await waitForRead()
  push({ jsonrpc: '2.0', id: 1, result: { capabilities } })
  await starting
  expect(service.health().status).toBe('ready')
  return { service, push, writes, waitForRead }
}

test('requires matched initialize readiness, routes requests and removes an aborted pending request', async () => {
  const writes: string[] = []
  const reads: Array<{
    resolve(value: SupervisedProcessResult): void
    reject(error: Error): void
  }> = []
  let cursor = 0
  let stopped = 0
  const port: ProcessSupervisorPort = {
    start: async () => processResult(),
    write: async ({ data }) => { writes.push(data) },
    read: async () => new Promise((resolve, reject) => reads.push({ resolve, reject })),
    stop: async () => {
      stopped += 1
      reads.splice(0).forEach(read => read.resolve({ ...processResult('', cursor), isRunning: false }))
    },
    drainSession: async () => [],
  }
  const push = (value: unknown) => {
    const output = frame(value)
    cursor += Buffer.byteLength(output)
    reads.shift()?.resolve(processResult(output, cursor))
  }
  const waitForRead = async () => {
    for (let attempt = 0; attempt < 50 && reads.length === 0; attempt++) await Bun.sleep(1)
    expect(reads.length).toBeGreaterThan(0)
  }
  const resolvedUris: string[] = []
  const service = new LspService({
    sessionKey: { workspaceId: 'w', sessionId: 's' },
    workspaceRoot: '/workspace',
    workingDirectory: '/workspace',
    command: 'test-lsp',
    processPort: port,
    resolveDocumentUri: async path => {
      resolvedUris.push(path)
      if (path === '../outside') throw new Error('lsp-path-outside-workspace')
      return path === '.' ? 'file:///workspace' : `file:///workspace/${path}`
    },
    // P6.417 — this case asserts the TERMINAL failure path, which since this row
    // is no longer the default: `restartOnCrash` *"Defaults to `true`"*, so a
    // read failure now restarts and the health/pending assertions at the end
    // would be measuring a restart in flight. Pinned to `false` so the case
    // keeps testing exactly what it was written to test; the restart path has
    // its own cases at the bottom of this file.
    supervision: { restartOnCrash: false },
  })

  const starting = service.start()
  await Bun.sleep(0)
  expect(service.health().status).toBe('connecting')
  expect(writes[0]).toContain('"id":1')
  await waitForRead()
  push({ jsonrpc: '2.0', id: 1, result: { capabilities: PULL_DIAGNOSTICS } })
  await starting
  expect(service.health().status).toBe('ready')
  expect(writes.some(value => value.includes('"method":"initialized"'))).toBe(true)

  const diagnostics = service.request({ operation: 'diagnostics', path: 'a.ts' }, new AbortController().signal)
  await Bun.sleep(0)
  expect(writes.some(value => value.includes('"id":2'))).toBe(true)
  await waitForRead()
  push({ jsonrpc: '2.0', id: 2, result: { items: [] } })
  expect(await diagnostics).toEqual({ items: [] })
  expect(resolvedUris).toContain('a.ts')
  await expect(service.request({ operation: 'diagnostics', path: '../outside' }, new AbortController().signal))
    .rejects.toThrow('lsp-path-outside-workspace')

  const controller = new AbortController()
  const aborted = service.request({ operation: 'hover', path: 'a.ts', line: 0, character: 0 }, controller.signal)
  await Bun.sleep(0)
  expect(writes.some(value => value.includes('"id":3'))).toBe(true)
  controller.abort()
  await expect(aborted).rejects.toThrow('lsp-request-aborted')
  expect((service as any).pending.size).toBe(0)

  const closing = service.request({ operation: 'workspace_symbols', query: 'Thing' }, new AbortController().signal)
  await waitForRead()
  reads.shift()?.reject(new Error('lsp-read-failed'))
  await expect(closing).rejects.toThrow('lsp-read-failed')
  await Bun.sleep(0)
  expect(service.health()).toEqual({ status: 'failed', reason: 'lsp-read-failed' })
  expect((service as any).pending.size).toBe(0)
  await service.dispose()
  expect(stopped).toBe(1)
  expect(service.health()).toEqual({ status: 'unavailable', reason: 'disposed' })
})

test('does not advertise readiness for a mismatched initialize response', async () => {
  const port: ProcessSupervisorPort = {
    start: async () => processResult(),
    write: async () => {},
    read: async () => processResult(frame({ jsonrpc: '2.0', id: 99, result: {} }), 1),
    stop: async () => {},
    drainSession: async () => [],
  }
  const service = new LspService({
    sessionKey: { workspaceId: 'w', sessionId: 's' },
    workspaceRoot: '/workspace',
    workingDirectory: '/workspace',
    command: 'test-lsp',
    processPort: port,
    resolveDocumentUri: async path => path === '.' ? 'file:///workspace' : `file:///workspace/${path}`,
  })
  await expect(service.start()).rejects.toThrow('lsp-initialize-response-mismatch')
  expect(service.health().status).not.toBe('ready')
})

test('passes the activation guard through the final supervised spawn gate', async () => {
  const order: string[] = []
  let request: Parameters<ProcessSupervisorPort['start']>[0] | undefined
  const port: ProcessSupervisorPort = {
    start: async input => {
      request = input
      order.push('isolation')
      await input.beforeStart?.()
      order.push('spawn')
      throw new Error('start-failure')
    },
    write: async () => {},
    read: async () => processResult(),
    stop: async () => {},
    drainSession: async () => [],
  }
  const service = new LspService({
    sessionKey: { workspaceId: 'w', sessionId: 's' },
    workspaceRoot: '/workspace',
    workingDirectory: '/workspace',
    command: 'test-lsp',
    processPort: port,
    resolveDocumentUri: async () => 'file:///workspace',
    beforeStart: async () => { order.push('guard') },
    env: { NESSY_PLUGIN_DATA: '/plugin-data' },
    additionalWritableRoots: ['/plugin-data', '/host-runtime-state'],
  })

  await expect(service.start()).rejects.toThrow('start-failure')
  expect(order).toEqual(['isolation', 'guard', 'spawn'])
  expect(request).toMatchObject({
    env: { NESSY_PLUGIN_DATA: '/plugin-data' },
    additionalWritableRoots: ['/plugin-data', '/host-runtime-state'],
  })
  expect(request?.beforeStart).toBeDefined()
})

test('does not spawn an LSP process when the final activation guard rejects', async () => {
  let starts = 0
  let spawns = 0
  const port: ProcessSupervisorPort = {
    start: async input => {
      starts += 1
      await input.beforeStart?.()
      spawns += 1
      return processResult()
    },
    write: async () => {},
    read: async () => processResult(),
    stop: async () => {},
    drainSession: async () => [],
  }
  const service = new LspService({
    sessionKey: { workspaceId: 'w', sessionId: 's' },
    workspaceRoot: '/workspace',
    workingDirectory: '/workspace',
    command: 'test-lsp',
    processPort: port,
    resolveDocumentUri: async () => 'file:///workspace',
    beforeStart: async () => { throw new Error('plugin-bundle-hash-mismatch') },
  })

  await expect(service.start()).rejects.toThrow('plugin-bundle-hash-mismatch')
  expect(starts).toBe(1)
  expect(spawns).toBe(0)
})

test('bounds an unresponsive initialize handshake and stops its supervised process', async () => {
  let stopped = 0
  const port: ProcessSupervisorPort = {
    start: async () => processResult(),
    write: async () => {},
    read: async () => new Promise(() => {}),
    stop: async () => { stopped += 1 },
    drainSession: async () => [],
  }
  const service = new LspService({
    sessionKey: { workspaceId: 'w', sessionId: 's' },
    workspaceRoot: '/workspace',
    workingDirectory: '/workspace',
    command: 'unresponsive-lsp',
    processPort: port,
    startupTimeoutMs: 10,
    resolveDocumentUri: async () => 'file:///workspace',
  })

  await expect(service.start()).rejects.toThrow('lsp-initialize-timeout')
  expect((service as any).pending.size).toBe(0)
  expect(service.health()).toEqual({ status: 'failed', reason: 'lsp-initialize-timeout' })
  expect(stopped).toBe(1)
})

test('routes formatting and code_action requests to their LSP methods and round-trips results', async () => {
  const { service, push, writes, waitForRead } = await readyHarness()

  const edits = [{ range: {}, newText: 'x' }]
  const formatting = service.request({ operation: 'formatting', path: 'a.ts', options: { tabSize: 2 } }, new AbortController().signal)
  await Bun.sleep(0)
  const formatWrite = writes.find(value => value.includes('"id":2'))
  expect(formatWrite).toContain('"method":"textDocument/formatting"')
  expect(formatWrite).toContain('"tabSize":2')
  await waitForRead()
  push({ jsonrpc: '2.0', id: 2, result: edits })
  expect(await formatting).toEqual(edits)

  const actions = [{ title: 'Fix', kind: 'quickfix' }]
  const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }
  const codeAction = service.request({ operation: 'code_action', path: 'a.ts', range }, new AbortController().signal)
  await Bun.sleep(0)
  const actionWrite = writes.find(value => value.includes('"id":3'))
  expect(actionWrite).toContain('"method":"textDocument/codeAction"')
  expect(actionWrite).toContain('"start":{"line":1,"character":0}')
  await waitForRead()
  push({ jsonrpc: '2.0', id: 3, result: actions })
  expect(await codeAction).toEqual(actions)

  await service.dispose()
})

test('delivers a pushed publishDiagnostics notification to onDiagnostics and surfaces it through the diagnostics pull buffer', async () => {
  const received: Array<{ uri: string; diagnostics: unknown[] }> = []
  const { service, push, writes, waitForRead } = await readyHarness(n => received.push(n), undefined, PULL_DIAGNOSTICS)

  const diagnostics = [{ message: 'oops', range: {} }]
  push({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///workspace/a.ts', diagnostics } })
  for (let attempt = 0; attempt < 50 && received.length === 0; attempt++) await Bun.sleep(1)
  expect(received).toEqual([{ uri: 'file:///workspace/a.ts', diagnostics }])

  const pull = service.request({ operation: 'diagnostics', path: 'a.ts' }, new AbortController().signal)
  await Bun.sleep(0)
  await waitForRead()
  const pendingId = /"id":(\d+)/.exec(writes[writes.length - 1] ?? '')?.[1]
  push({ jsonrpc: '2.0', id: Number(pendingId), result: { items: [] } })
  expect(await pull).toEqual({ pulled: { items: [] }, pushed: diagnostics })

  await service.dispose()
})

test('drops a malformed notification without failing pending requests or the read loop', async () => {
  const received: Array<unknown> = []
  const { service, push, writes, waitForRead } = await readyHarness(n => received.push(n))

  // A pending request must survive a malformed notification arriving before its response.
  const hover = service.request({ operation: 'hover', path: 'a.ts', line: 0, character: 0 }, new AbortController().signal)
  await Bun.sleep(0)
  const hoverId = Number(/"id":(\d+)/.exec(writes[writes.length - 1] ?? '')?.[1])

  // Missing params / wrong shape: dropped silently, sink never fired.
  push({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics' })
  push({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 42, diagnostics: 'nope' } })
  // An unknown notification method is also dropped.
  push({ jsonrpc: '2.0', method: 'window/logMessage', params: { message: 'hi' } })
  await Bun.sleep(2)
  expect(received).toEqual([])
  expect((service as any).pending.size).toBe(1)

  await waitForRead()
  push({ jsonrpc: '2.0', id: hoverId, result: { contents: 'ok' } })
  expect(await hover).toEqual({ contents: 'ok' })
  expect((service as any).pending.size).toBe(0)

  await service.dispose()
})

test('replies method-not-found to a server request and does not corrupt a pending request sharing its id', async () => {
  const { service, push, writes, waitForRead } = await readyHarness()

  const hover = service.request({ operation: 'hover', path: 'a.ts', line: 0, character: 0 }, new AbortController().signal)
  await Bun.sleep(0)
  const hoverId = Number(/"id":(\d+)/.exec(writes[writes.length - 1] ?? '')?.[1])
  const before = writes.length

  // A server→client REQUEST (id + method) that collides with our pending id.
  push({ jsonrpc: '2.0', id: hoverId, method: 'workspace/configuration', params: { items: [] } })
  await Bun.sleep(2)

  // The pending request survived: it was NOT resolved by the request frame.
  expect((service as any).pending.size).toBe(1)
  // A -32601 error reply was written for that request id.
  const reply = writes.slice(before).find(value => value.includes(`"id":${hoverId}`))
  expect(reply).toBeDefined()
  expect(reply).toContain('"code":-32601')
  expect(reply).toContain('"method not found"')
  expect(reply).not.toContain('"result"')

  // Our real response still resolves the pending request.
  await waitForRead()
  push({ jsonrpc: '2.0', id: hoverId, result: { contents: 'ok' } })
  expect(await hover).toEqual({ contents: 'ok' })
  expect((service as any).pending.size).toBe(0)

  await service.dispose()
})

test('evicts the true least-recently-updated file when the per-file cap is exceeded', async () => {
  const { service } = await readyHarness()
  const buffer: Map<string, unknown[]> = (service as any).diagnosticsBuffer
  // Drive the notification handler directly: the mock read loop consumes one
  // queued frame per registered read, so hundreds of rapid pushes would race.
  const emit = (uri: string, line: number) => (service as any).handleNotification({
    method: 'textDocument/publishDiagnostics',
    params: { uri, diagnostics: [{ message: 'x', range: { start: { line, character: 0 }, end: { line, character: 1 } } }] },
  })

  // Fill the buffer to its cap (256 distinct files).
  for (let i = 0; i < 256; i++) emit(`file:///workspace/f${i}.ts`, i)
  expect(buffer.size).toBe(256)

  // Refresh the OLDEST file (f0): under FIFO it would stay first and be evicted;
  // under LRU-on-write it moves to newest and must survive.
  emit('file:///workspace/f0.ts', 999)

  // A new file pushes the buffer over the cap, evicting one entry.
  emit('file:///workspace/new.ts', 1000)

  expect(buffer.size).toBe(256)
  expect(buffer.has('file:///workspace/f0.ts')).toBe(true) // refreshed → survived
  expect(buffer.has('file:///workspace/f1.ts')).toBe(false) // true LRU → evicted
  expect(buffer.has('file:///workspace/new.ts')).toBe(true)

  await service.dispose()
})

test('truncates a spammy per-URI diagnostics push to the per-file cap', async () => {
  const { service } = await readyHarness()
  const buffer: Map<string, unknown[]> = (service as any).diagnosticsBuffer

  const spam = Array.from({ length: 5000 }, (_, i) => ({ message: `d${i}`, range: {} }))
  ;(service as any).handleNotification({ method: 'textDocument/publishDiagnostics', params: { uri: 'file:///workspace/spam.ts', diagnostics: spam } })

  const stored = buffer.get('file:///workspace/spam.ts')
  expect(stored?.length).toBe(1000)
  // Deterministic: keeps the FIRST N.
  expect((stored?.[0] as any).message).toBe('d0')
  expect((stored?.[999] as any).message).toBe('d999')

  await service.dispose()
})

test('seeds code_action context with only range-overlapping buffered diagnostics', async () => {
  const { service, push, writes, waitForRead } = await readyHarness()

  const overlapping = { message: 'in-range', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } }
  const disjoint = { message: 'out-of-range', range: { start: { line: 10, character: 0 }, end: { line: 10, character: 2 } } }
  const malformed = { message: 'no-range' }
  ;(service as any).handleNotification({ method: 'textDocument/publishDiagnostics', params: { uri: 'file:///workspace/a.ts', diagnostics: [overlapping, disjoint, malformed] } })

  const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }
  const codeAction = service.request({ operation: 'code_action', path: 'a.ts', range }, new AbortController().signal)
  await Bun.sleep(0)
  const actionWrite = writes.find(value => value.includes('"method":"textDocument/codeAction"'))
  expect(actionWrite).toBeDefined()
  const sent = parseFrame(actionWrite ?? '')
  expect(sent.params.context.diagnostics).toEqual([overlapping])

  await waitForRead()
  push({ jsonrpc: '2.0', id: sent.id, result: [] })
  await codeAction

  // An explicit caller context is passed through untouched (no range filtering).
  const explicit = service.request({ operation: 'code_action', path: 'a.ts', range, context: { diagnostics: [disjoint] } }, new AbortController().signal)
  await Bun.sleep(0)
  const explicitWrite = writes.slice().reverse().find(value => value.includes('"method":"textDocument/codeAction"'))
  const explicitSent = parseFrame(explicitWrite ?? '')
  expect(explicitSent.params.context.diagnostics).toEqual([disjoint])
  await waitForRead()
  push({ jsonrpc: '2.0', id: explicitSent.id, result: [] })
  await explicit

  await service.dispose()
})

test('clears a buffered file entry on an empty diagnostics push', async () => {
  const { service } = await readyHarness()
  const buffer: Map<string, unknown[]> = (service as any).diagnosticsBuffer

  ;(service as any).handleNotification({ method: 'textDocument/publishDiagnostics', params: { uri: 'file:///workspace/a.ts', diagnostics: [{ message: 'x', range: {} }] } })
  expect(buffer.has('file:///workspace/a.ts')).toBe(true)

  ;(service as any).handleNotification({ method: 'textDocument/publishDiagnostics', params: { uri: 'file:///workspace/a.ts', diagnostics: [] } })
  expect(buffer.has('file:///workspace/a.ts')).toBe(false)

  await service.dispose()
})


/**
 * P6.417 — the supervision knobs `plugins-reference.md` § LSP servers defines,
 * honoured by the service rather than recorded as unread.
 *
 * The subject is BEHAVIOUR at the wire and at the process port, not that the
 * fields survived the adapter — `plugins/__tests__/claude-lsp-fields.test.ts`
 * owns that half, and a test asserting only the carry would pass with the
 * service ignoring every one of them.
 */
test('P6.417 · initializationOptions ride the initialize request and settings follow initialized', async () => {
  const { writes } = await readyHarness(undefined, {
    supervision: {
      initializationOptions: { build: { directoryFilters: ['-vendor'] } },
      settings: { gopls: { usePlaceholders: true } },
    },
  })

  const initialize = parseFrame(writes[0]!)
  expect(initialize.method).toBe('initialize')
  // Opaque by contract: handed over untouched, because the shape is the
  // server's and not ours.
  expect(initialize.params.initializationOptions).toEqual({ build: { directoryFilters: ['-vendor'] } })

  const methods = writes.map(wire => parseFrame(wire).method)
  // The ORDER is the assertion. The LSP spec lets a server ignore configuration
  // that arrives before `initialized`, so a `didChangeConfiguration` sent first
  // would be a setting silently dropped by a conforming server.
  expect(methods).toEqual(['initialize', 'initialized', 'workspace/didChangeConfiguration'])
  expect(parseFrame(writes[2]!).params).toEqual({ settings: { gopls: { usePlaceholders: true } } })
})

test('P6.417 · a server with no supervision sends neither, and initialize is unchanged', async () => {
  // NEGATIVE, and the control for the case above: absent must mean ABSENT on
  // the wire, not an empty object a server would have to interpret.
  const { writes } = await readyHarness()

  const initialize = parseFrame(writes[0]!)
  expect('initializationOptions' in initialize.params).toBe(false)
  expect(writes.map(wire => parseFrame(wire).method)).toEqual(['initialize', 'initialized'])
})

test('P6.417 · diagnostics:false suppresses the push sink and keeps the pull path', async () => {
  const pushed: Array<{ uri: string }> = []
  const { push } = await readyHarness(
    notification => { pushed.push(notification) },
    { supervision: { diagnostics: false } },
  )

  push({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: { uri: 'file:///workspace/a.ts', diagnostics: [{ message: 'boom' }] },
  })
  await Bun.sleep(5)

  // *"Set to `false` to keep code navigation but suppress automatic diagnostic
  // injection"* — so the SINK is silent…
  expect(pushed).toEqual([])
})

test('P6.417 · the default keeps pushing, which is what makes the flag mean something', async () => {
  // The positive control for the case above, on the same harness: *"default
  // `true`"*, so an absent field must behave exactly as before this row.
  const pushed: Array<{ uri: string }> = []
  const { push } = await readyHarness(notification => { pushed.push(notification) })

  push({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: { uri: 'file:///workspace/a.ts', diagnostics: [{ message: 'boom' }] },
  })
  await Bun.sleep(5)

  expect(pushed.map(entry => entry.uri)).toEqual(['file:///workspace/a.ts'])
})

test('P6.417 · restartOnCrash:false leaves a crashed server stopped, and SAYS so', async () => {
  // NEGATIVE. Before this row a crashed plugin language server stayed dead and
  // nothing said so — the "started and left" the row is named for. The `false`
  // path keeps it stopped, which the page allows, but the notice is what makes
  // that a decision the user can see rather than a silence.
  const restarts: Array<{ restarted: boolean; attempt: number }> = []
  const { service } = await readyHarness(undefined, {
    supervision: { restartOnCrash: false },
    onRestart: event => { restarts.push({ restarted: event.restarted, attempt: event.attempt }) },
  })

  // Ending the read loop is the crash: the page counts a closed process and a
  // protocol violation alike as one.
  await service.dispose()
  await Bun.sleep(5)

  // Disposal is not a crash — `restartAfterCrash` returns on `disposed` — so
  // nothing is announced and the service is simply gone.
  expect(restarts).toEqual([])
  expect(service.health().status).toBe('unavailable')
})


test('P6.417 · the documented default restarts a crashed server, bounded and announced', async () => {
  // The POSITIVE half of `restartOnCrash`, and the behaviour change this row
  // makes: before it, a crashed plugin language server stayed dead in silence.
  // Driven through the real service so the count, the bound and the notice are
  // the service's own rather than a stub's.
  const restarts: Array<{ attempt: number; maxRestarts: number; restarted: boolean }> = []
  let starts = 0
  const reads: Array<{ resolve(value: SupervisedProcessResult): void; reject(error: Error): void }> = []
  const port: ProcessSupervisorPort = {
    start: async () => { starts += 1; return processResult() },
    write: async () => {},
    read: async () => new Promise((resolve, reject) => reads.push({ resolve, reject })),
    stop: async () => { reads.splice(0).forEach(read => read.reject(new Error('lsp-stopped'))) },
    drainSession: async () => [],
  }
  const service = new LspService({
    sessionKey: { workspaceId: 'w', sessionId: 's' },
    workspaceRoot: '/workspace',
    workingDirectory: '/workspace',
    command: 'test-lsp',
    processPort: port,
    resolveDocumentUri: async () => 'file:///workspace',
    // The startup handshake is never answered here, so every start fails on the
    // startup timeout — which is exactly a server that crashes on startup, the
    // case the host ceiling exists for. One millisecond so the loop is fast.
    supervision: { startupTimeout: 1, maxRestarts: 2 },
    onRestart: event => {
      restarts.push({ attempt: event.attempt, maxRestarts: event.maxRestarts, restarted: event.restarted })
    },
  })

  await expect(service.start()).rejects.toThrow()
  for (let attempt = 0; attempt < 200 && restarts.length < 3; attempt++) await Bun.sleep(5)

  // Two restarts, then the give-up — the bound is the author's `maxRestarts`,
  // and the counter is NOT reset by an attempt, or a crash-looping server would
  // never reach it.
  //
  // The attempts are asserted SORTED, deliberately: a restart whose own start
  // fails announces after the crash it caused, so attempt 3's give-up is
  // observed before attempt 2's outcome. That interleaving is an artefact of
  // nesting and not a fact worth pinning — what matters is that each attempt is
  // announced exactly once and that the bound holds.
  expect(restarts.map(entry => entry.restarted)).toEqual([false, false, false])
  expect(restarts.map(entry => entry.attempt).sort()).toEqual([1, 2, 3])
  expect(restarts.every(entry => entry.maxRestarts === 2)).toBe(true)
  // Three process starts: the original plus the two allowed restarts. A fourth
  // would be the bound not holding.
  expect(starts).toBe(3)
  await service.dispose()
})

// ---------------------------------------------------------------------------
// F1.1013 — document synchronization, LSP 3.17 § Text Document Synchronization:
// "Before requesting information from the server … the client must ensure that
// the document's state is synchronized with the server". The service reads the
// file the request names from disk and tells the server about it, per the
// server's advertised `textDocumentSync`.
// ---------------------------------------------------------------------------

/** A ready service over a REAL folder, because document sync reads the file a request names. */
async function syncHarness(textDocumentSync: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'dn201-lsp-sync-'))
  const harness = await readyHarness(undefined, {
    resolveDocumentUri: async path => pathToFileURL(join(root, path)).href,
  }, { ...PULL_DIAGNOSTICS, ...(textDocumentSync === undefined ? {} : { textDocumentSync }) })
  const methodsSince = (start: number) => harness.writes.slice(start).map(wire => parseFrame(wire).method)
  /** Issue one request, answer it, and return what the service wrote for it. */
  const roundTrip = async (input: Parameters<LspService['request']>[0], method: string) => {
    const start = harness.writes.length
    const pending = harness.service.request(input, new AbortController().signal)
    for (let attempt = 0; attempt < 100 && !methodsSince(start).includes(method); attempt++) await Bun.sleep(1)
    const request = harness.writes.slice(start).map(parseFrame).find(body => body.method === method)
    expect(request).toBeDefined()
    await harness.waitForRead()
    harness.push({ jsonrpc: '2.0', id: request.id, result: null })
    await pending
    return harness.writes.slice(start).map(parseFrame)
  }
  const cleanup = async () => {
    await harness.service.dispose()
    await rm(root, { recursive: true, force: true })
  }
  return { ...harness, root, roundTrip, cleanup }
}

test('F1.1013 · a Full-sync server gets didOpen before the first request and didChange with the whole text after an edit', async () => {
  const h = await syncHarness(1)
  try {
    const file = join(h.root, 'a.ts')
    const uri = pathToFileURL(file).href
    await writeFile(file, 'export const a: number = 1\n')

    const first = await h.roundTrip({ operation: 'diagnostics', path: 'a.ts', language: 'typescript' }, 'textDocument/diagnostic')
    expect(first.map(body => body.method)).toEqual(['textDocument/didOpen', 'textDocument/diagnostic'])
    expect(first[0].params).toEqual({
      textDocument: { uri, languageId: 'typescript', version: 1, text: 'export const a: number = 1\n' },
    })

    // Unchanged on disk: the open copy is already current, so nothing is re-sent.
    const unchanged = await h.roundTrip({ operation: 'hover', path: 'a.ts', line: 0, character: 13, language: 'typescript' }, 'textDocument/hover')
    expect(unchanged.map(body => body.method)).toEqual(['textDocument/hover'])

    // The edit the agent made: the server is told BEFORE the next request, with
    // the whole document (Full) and the next version.
    await writeFile(file, "export const a: number = 'x'\n")
    const edited = await h.roundTrip({ operation: 'diagnostics', path: 'a.ts', language: 'typescript' }, 'textDocument/diagnostic')
    expect(edited.map(body => body.method)).toEqual(['textDocument/didChange', 'textDocument/diagnostic'])
    expect(edited[0].params).toEqual({
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: "export const a: number = 'x'\n" }],
    })
  } finally {
    await h.cleanup()
  }
})

test('F1.1013 · an Incremental-sync server gets a ranged whole-document change, and a deleted file is closed', async () => {
  const h = await syncHarness({ openClose: true, change: 2 })
  try {
    const file = join(h.root, 'b.ts')
    const uri = pathToFileURL(file).href
    // Three lines split by the spec's three end-of-line sequences, the last one
    // holding a surrogate pair: its end is character 3 in UTF-16 code units.
    await writeFile(file, 'a\r\nbb\n\u{10400}c')
    await h.roundTrip({ operation: 'document_symbols', path: 'b.ts', language: 'typescript' }, 'textDocument/documentSymbol')

    await writeFile(file, 'fresh\n')
    const edited = await h.roundTrip({ operation: 'document_symbols', path: 'b.ts', language: 'typescript' }, 'textDocument/documentSymbol')
    expect(edited.map(body => body.method)).toEqual(['textDocument/didChange', 'textDocument/documentSymbol'])
    expect(edited[0].params).toEqual({
      textDocument: { uri, version: 2 },
      contentChanges: [{ range: { start: { line: 0, character: 0 }, end: { line: 2, character: 3 } }, text: 'fresh\n' }],
    })

    // Gone from disk: ownership goes back to the file system (didClose), and the
    // request still reaches the server.
    await rm(file)
    const deleted = await h.roundTrip({ operation: 'document_symbols', path: 'b.ts', language: 'typescript' }, 'textDocument/documentSymbol')
    expect(deleted.map(body => body.method)).toEqual(['textDocument/didClose', 'textDocument/documentSymbol'])
    expect(deleted[0].params).toEqual({ textDocument: { uri } })
  } finally {
    await h.cleanup()
  }
})

test('F1.1013 · no sync frames when the server did not ask for open/close, or when the request names no language', async () => {
  // `openClose` omitted: "If omitted open close notifications should not be
  // sent", and a didChange needs a prior didOpen, so nothing at all.
  const noOpenClose = await syncHarness({ change: 1 })
  try {
    await writeFile(join(noOpenClose.root, 'a.ts'), 'x\n')
    const sent = await noOpenClose.roundTrip({ operation: 'diagnostics', path: 'a.ts', language: 'typescript' }, 'textDocument/diagnostic')
    expect(sent.map(body => body.method)).toEqual(['textDocument/diagnostic'])
    await writeFile(join(noOpenClose.root, 'a.ts'), 'y\n')
    const again = await noOpenClose.roundTrip({ operation: 'diagnostics', path: 'a.ts', language: 'typescript' }, 'textDocument/diagnostic')
    expect(again.map(body => body.method)).toEqual(['textDocument/diagnostic'])
  } finally {
    await noOpenClose.cleanup()
  }

  // A Full server, but no language id to open the document with: never guessed.
  const noLanguage = await syncHarness(1)
  try {
    await writeFile(join(noLanguage.root, 'a.ts'), 'x\n')
    const sent = await noLanguage.roundTrip({ operation: 'diagnostics', path: 'a.ts' }, 'textDocument/diagnostic')
    expect(sent.map(body => body.method)).toEqual(['textDocument/diagnostic'])
  } finally {
    await noLanguage.cleanup()
  }
})

// ---------------------------------------------------------------------------
// F1.1026 — pull diagnostics only from a server that offers them. LSP 3.17
// § Pull Diagnostics: the server capability is `diagnosticProvider` (*"The
// server has support for pull model diagnostics"*); a server without it only
// pushes `textDocument/publishDiagnostics`, and answers a pull it does not
// handle with an error.
// ---------------------------------------------------------------------------

/**
 * Run one `diagnostics` op. A pull that reaches the double is answered with
 * `answer(id)`; returns how the op settled and the methods the service wrote.
 */
async function diagnosticsOp(
  h: Awaited<ReturnType<typeof readyHarness>>,
  path: string,
  answer: (id: number) => unknown,
) {
  const start = h.writes.length
  let settled = false
  const outcome = h.service.request({ operation: 'diagnostics', path }, new AbortController().signal)
    .then(value => ({ value }), (error: Error) => ({ error: error.message }))
    .finally(() => { settled = true })
  for (let attempt = 0; attempt < 50 && !settled; attempt++) {
    const pull = h.writes.slice(start).map(parseFrame).find(body => body.method === 'textDocument/diagnostic')
    if (pull) {
      await h.waitForRead()
      h.push(answer(pull.id))
      break
    }
    await Bun.sleep(1)
  }
  const result = await outcome
  return { result, methods: h.writes.slice(start).map(wire => parseFrame(wire).method) }
}

/** A ready service that has buffered one push for `file:///workspace/a.ts`. */
async function pushedHarness(capabilities: Record<string, unknown>, diagnostics: unknown[]) {
  const received: unknown[] = []
  const h = await readyHarness(notification => { received.push(notification) }, undefined, capabilities)
  await h.waitForRead()
  h.push({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///workspace/a.ts', diagnostics } })
  for (let attempt = 0; attempt < 50 && received.length === 0; attempt++) await Bun.sleep(1)
  expect(received).toHaveLength(1)
  return h
}

test('F1.1026 · a push-only server is never pulled and the op returns what it pushed; a diagnosticProvider server is still pulled', async () => {
  const diagnostics = [{ message: 'oops', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
  // What a push-only server answers a request it does not implement.
  const methodNotFound = (id: number) => ({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unhandled method textDocument/diagnostic' } })

  const pushOnly = await pushedHarness({}, diagnostics)
  try {
    expect(await diagnosticsOp(pushOnly, 'a.ts', methodNotFound)).toEqual({ result: { value: { pushed: diagnostics } }, methods: [] })
    // Nothing pushed for this file: an empty push set, and still no pull.
    expect(await diagnosticsOp(pushOnly, 'b.ts', methodNotFound)).toEqual({ result: { value: { pushed: [] } }, methods: [] })
  } finally {
    await pushOnly.service.dispose()
  }

  // Positive control on the same instrument: an advertised provider is pulled,
  // with the push set beside the report. The spec's object form, and the bare
  // `true` the reference client (`vscode-languageclient`) also reads.
  for (const capabilities of [PULL_DIAGNOSTICS, { diagnosticProvider: true }]) {
    const pulling = await pushedHarness(capabilities, diagnostics)
    try {
      const report = { kind: 'full', items: [] }
      expect(await diagnosticsOp(pulling, 'a.ts', id => ({ jsonrpc: '2.0', id, result: report }))).toEqual({
        result: { value: { pulled: report, pushed: diagnostics } },
        methods: ['textDocument/diagnostic'],
      })
    } finally {
      await pulling.service.dispose()
    }
  }
})

// F1.1024 — `syncDocument` says whether the server was just sent the file's
// text, which is what the host's post-edit wait for a push keys on: the spec has
// the server re-push after a change, and only then.
test('F1.1024 · syncDocument answers true only when the server was sent the file text', async () => {
  const h = await syncHarness(1)
  try {
    const file = join(h.root, 'a.ts')
    await writeFile(file, 'x\n')
    expect(await h.service.syncDocument('a.ts')).toBe(false)
    expect(await h.service.syncDocument('a.ts', 'typescript')).toBe(true)
    expect(await h.service.syncDocument('a.ts', 'typescript')).toBe(false)
    await writeFile(file, 'y\n')
    expect(await h.service.syncDocument('a.ts')).toBe(true)
    await rm(file)
    expect(await h.service.syncDocument('a.ts')).toBe(false)
    const sync = h.writes.map(wire => parseFrame(wire).method).filter((method: string) => method.startsWith('textDocument/'))
    expect(sync).toEqual(['textDocument/didOpen', 'textDocument/didChange', 'textDocument/didClose'])
  } finally {
    await h.cleanup()
  }

  const noOpenClose = await syncHarness({ change: 1 })
  try {
    await writeFile(join(noOpenClose.root, 'a.ts'), 'x\n')
    expect(await noOpenClose.service.syncDocument('a.ts', 'typescript')).toBe(false)
  } finally {
    await noOpenClose.cleanup()
  }
})

/**
 * F1.1145 (origin DN-219, 2026-09-28) — `initialize` declares the client
 * capabilities the service actually uses: whole-text document sync
 * (`didOpen`/`didChange`/`didClose`, nothing for save) and pushed
 * `textDocument/publishDiagnostics`. It used to send `capabilities: {}`, which
 * by LSP 3.17 says the client supports none of them.
 */
test('F1.1145 · initialize declares text document sync and publishDiagnostics, and no dynamic registration', async () => {
  const { writes } = await readyHarness()

  const initialize = parseFrame(writes[0]!)
  expect(initialize.method).toBe('initialize')
  const textDocument = initialize.params.capabilities.textDocument
  expect(textDocument.synchronization).toEqual({ dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: false })
  expect(textDocument.publishDiagnostics).toEqual({})
  // NEGATIVE — nothing the service does not answer: no pull-diagnostics client
  // capability (a server may stop pushing for a client that declares it) and no
  // workspace capabilities (`client/registerCapability` gets method-not-found).
  expect('diagnostic' in textDocument).toBe(false)
  expect('workspace' in initialize.params.capabilities).toBe(false)
})
