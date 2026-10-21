import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { ProcessSupervisorPort } from '@nessy-agent/shared/agent/pi-harness/process-supervisor-port'
import type { SessionKey } from '@nessy-agent/shared/sessions/session-key'
import type { PluginLspSupervision } from '@nessy-agent/shared/plugins/types'

export type LspHealth =
  | { status: 'unavailable'; reason: string }
  | { status: 'connecting' }
  | { status: 'ready' }
  | { status: 'failed'; reason: string }

export type LspRange = {
  start: { line: number; character: number }
  end: { line: number; character: number }
}

export type LspRequest =
  | { operation: 'definition' | 'references' | 'hover'; path: string; line: number; character: number; language?: string }
  | { operation: 'document_symbols' | 'diagnostics'; path: string; language?: string }
  | { operation: 'workspace_symbols'; query: string; language?: string }
  | { operation: 'formatting'; path: string; options?: Record<string, unknown>; language?: string }
  | { operation: 'range_formatting'; path: string; range: LspRange; options?: Record<string, unknown>; language?: string }
  | { operation: 'code_action'; path: string; range: LspRange; context?: Record<string, unknown>; language?: string }

/** A pushed `textDocument/publishDiagnostics` notification, delivered fail-soft. */
export type LspDiagnosticsNotification = { uri: string; diagnostics: unknown[] }

type Pending = {
  resolve(value: unknown): void
  reject(error: Error): void
  removeAbort?: () => void
}

const MAX_FRAME_BYTES = 1024 * 1024
/** Bound on distinct files retained in the pushed-diagnostics buffer. */
const MAX_DIAGNOSTIC_FILES = 256
/**
 * Bound on diagnostics retained per URI. A server spamming a huge push for one
 * file would otherwise store the whole array unbounded; keep the FIRST N
 * (deterministic truncation) so buffer memory stays bounded.
 */
const MAX_DIAGNOSTICS_PER_FILE = 1000

function isPosition(value: unknown): value is { line: number; character: number } {
  return typeof value === 'object' && value !== null
    && typeof (value as { line?: unknown }).line === 'number'
    && typeof (value as { character?: unknown }).character === 'number'
}

function isRange(value: unknown): value is LspRange {
  return typeof value === 'object' && value !== null
    && isPosition((value as { start?: unknown }).start)
    && isPosition((value as { end?: unknown }).end)
}

/** True when two positions compare `a <= b` on (line, character) order. */
function positionLte(a: { line: number; character: number }, b: { line: number; character: number }): boolean {
  return a.line < b.line || (a.line === b.line && a.character <= b.character)
}

/** Standard half-inclusive interval overlap of two LSP ranges. */
function rangesOverlap(a: LspRange, b: LspRange): boolean {
  return positionLte(a.start, b.end) && positionLte(b.start, a.end)
}

/**
 * Restrict buffered diagnostics to those overlapping `range`. A diagnostic
 * whose `range` is missing or malformed is treated as non-overlapping (skipped)
 * rather than surfaced unfiltered.
 */
function seedCodeActionDiagnostics(buffered: unknown[] | undefined, range: LspRange): unknown[] {
  if (!buffered || buffered.length === 0) return []
  return buffered.filter(diagnostic => {
    const diagnosticRange = (diagnostic as { range?: unknown } | null | undefined)?.range
    return isRange(diagnosticRange) && rangesOverlap(diagnosticRange, range)
  })
}

export class LspService {
  private state: LspHealth = { status: 'unavailable', reason: 'not-started' }
  private handle: string | undefined
  private cursor = 0
  private buffer = ''
  private nextId = 1
  private disposed = false
  private reading: Promise<void> | undefined
  /** P6.417 — crash restarts performed, never reset. See `restartAfterCrash`. */
  private restarts = 0
  readonly pending = new Map<number, Pending>()
  /** Bounded per-file buffer of the latest pushed diagnostics, keyed by URI. */
  private readonly diagnosticsBuffer = new Map<string, unknown[]>()
  /** F1.1013 — the server's resolved `textDocumentSync`, read from its `initialize` result. */
  private documentSync: DocumentSync = NO_DOCUMENT_SYNC
  /** F1.1013 — documents this client owns on the server, keyed by URI, least-recently-used first. */
  private readonly openDocuments = new Map<string, OpenDocument>()
  /** F1.1013 — serializes sync so one URI is never opened twice without a close in between. */
  private documentSyncQueue: Promise<void> = Promise.resolve()
  /** F1.1026 — the server advertised `diagnosticProvider` in its `initialize` result (see {@link advertisesPullDiagnostics}). */
  private pullDiagnostics = false

  constructor(private readonly options: {
    sessionKey: SessionKey
    workspaceRoot: string
    workingDirectory: string
    command: string
    args?: string[]
    /** Host-approved runtime variables for a plugin-owned LSP process. */
    env?: Record<string, string>
    /** Managed plugin-data and host-runtime state roots writable by this process. */
    additionalWritableRoots?: readonly string[]
    processPort: ProcessSupervisorPort
    resolveDocumentUri(path: string): Promise<string>
    timeoutMs?: number
    startupTimeoutMs?: number
    /**
     * P6.417 — the plugin author's supervision knobs, as
     * `plugins-reference.md` § LSP servers defines them. Absent means the page's
     * own defaults, which are ALSO this service's previous behaviour for every
     * field but `restartOnCrash` — see {@link supervision}.
     */
    supervision?: PluginLspSupervision
    /** Revalidates the pinned plugin bundle immediately before process start. */
    beforeStart?(): Promise<void>
    /** Fail-soft sink for pushed `textDocument/publishDiagnostics` notifications. */
    onDiagnostics?(notification: LspDiagnosticsNotification): void
    /**
     * P6.417 — told once per crash-restart, so the host can say so rather than
     * the user meeting a server that silently came back (or silently did not).
     */
    onRestart?(event: { attempt: number; maxRestarts: number; reason: string; restarted: boolean }): void
  }) {}

  /**
   * P6.417 — the page's defaults, resolved once so no call site re-derives one.
   *
   * `restartOnCrash` *"Defaults to `true`"*, and that default is the one place
   * this row CHANGES behaviour rather than exposing it: before this, a crashed
   * plugin language server stayed dead and nothing said so. `diagnostics`
   * *"(default `true`)"*. `shutdownTimeout` has no default — *"When unset, no
   * timeout applies"* — so it stays `undefined` rather than borrowing a number.
   */
  /**
   * P6.417 — the HOST's own ceiling on crash restarts, applied ONLY when the
   * author declared no `maxRestarts`.
   *
   * The page defaults `restartOnCrash` to `true` and gives `maxRestarts` no
   * default at all, so the documented reading of a plugin that sets neither is
   * *restart for ever*. That is a real hazard on a desktop app — a server that
   * crashes on startup would respawn a process in a tight loop for the life of
   * the session — and the documentation does not answer it, so this is a host
   * decision under the transparent-and-simple rule rather than a page value.
   *
   * TRANSPARENT: every attempt raises the `onRestart` notice, so the user sees
   * the count reach the ceiling instead of a server going quiet. SIMPLE: one
   * constant, and an author who wants a different number writes `maxRestarts`,
   * which wins in both directions — higher AND lower.
   */
  private static readonly DEFAULT_MAX_RESTARTS = 5

  private get supervision(): {
    restartOnCrash: boolean
    diagnostics: boolean
    maxRestarts: number
    shutdownTimeoutMs: number | undefined
  } {
    const declared = this.options.supervision
    return {
      restartOnCrash: declared?.restartOnCrash !== false,
      diagnostics: declared?.diagnostics !== false,
      maxRestarts: declared?.maxRestarts ?? LspService.DEFAULT_MAX_RESTARTS,
      shutdownTimeoutMs: declared?.shutdownTimeout,
    }
  }

  health(): LspHealth {
    return { ...this.state }
  }

  async start(): Promise<void> {
    if (this.state.status === 'ready') return
    if (this.disposed) throw new Error('lsp-service-disposed')
    this.state = { status: 'connecting' }
    try {
      const started = await this.options.processPort.start({
        sessionKey: this.options.sessionKey,
        executionId: 'lsp-service',
        semanticId: 'lsp',
        command: this.options.command,
        args: this.options.args,
        cwd: this.options.workingDirectory,
        workspaceRoot: this.options.workspaceRoot,
        profile: 'workspace',
        background: true,
        timeoutMs: this.options.timeoutMs ?? 30 * 60_000,
        stdin: 'pipe',
        ...(this.options.env ? { env: this.options.env } : {}),
        ...(this.options.additionalWritableRoots?.length
          ? { additionalWritableRoots: this.options.additionalWritableRoots }
          : {}),
        ...(this.options.beforeStart ? { beforeStart: this.options.beforeStart } : {}),
      })
      this.handle = started.handle
      this.cursor = started.nextCursor
      this.reading = this.readLoop().catch(error => {
        this.fail(error)
        // P6.417 — a read loop that ended is a CRASH, and the page counts the
        // same causes we do: the process closed, or it "writes non-protocol
        // output to stdout … and counts the disconnect as a crash for
        // `restartOnCrash` and `maxRestarts`". Fire-and-forget so a restart can
        // never re-enter the loop it is restarting.
        void this.restartAfterCrash(error)
      })
      const startupController = new AbortController()
      // P6.417 — *"Max time to wait for server startup (milliseconds)"*. The
      // plugin's own value wins over the host default; `startupTimeoutMs` stays
      // as the host-side seam it always was (tests, and a future setting).
      const startupTimer = setTimeout(
        () => startupController.abort(),
        this.options.supervision?.startupTimeout ?? this.options.startupTimeoutMs ?? 12_000,
      )
      // A fresh process owns no documents, whatever the previous one was told.
      this.openDocuments.clear()
      this.documentSync = NO_DOCUMENT_SYNC
      this.pullDiagnostics = false
      try {
        const initializeResult = await this.sendRequest('initialize', {
          processId: process.pid,
          rootUri: await this.options.resolveDocumentUri('.'),
          capabilities: LSP_CLIENT_CAPABILITIES, // F1.1145 — what this client uses; see the const
          // P6.417 — *"Options passed to the server during initialization"*.
          // Opaque by contract: the adapter checked it is an object and this
          // hands it over untouched, because its shape belongs to the server.
          ...(this.options.supervision?.initializationOptions !== undefined
            ? { initializationOptions: this.options.supervision.initializationOptions }
            : {}),
        }, startupController.signal, true)
        const serverCapabilities = (initializeResult as {
          capabilities?: { textDocumentSync?: unknown; diagnosticProvider?: unknown }
        } | null | undefined)?.capabilities
        this.documentSync = resolveDocumentSync(serverCapabilities?.textDocumentSync)
        this.pullDiagnostics = advertisesPullDiagnostics(serverCapabilities?.diagnosticProvider)
      } catch (error) {
        if (startupController.signal.aborted) throw new Error('lsp-initialize-timeout')
        throw error
      } finally {
        clearTimeout(startupTimer)
      }
      await this.sendNotification('initialized', {})
      // P6.417 — *"Settings passed via `workspace/didChangeConfiguration`"*.
      // AFTER `initialized`, which is the order the LSP spec gives: a server may
      // legally ignore configuration that arrives before it.
      if (this.options.supervision?.settings !== undefined) {
        await this.sendNotification('workspace/didChangeConfiguration', {
          settings: this.options.supervision.settings,
        })
      }
      const initializedHealth = this.health()
      if (initializedHealth.status === 'failed') throw new Error(initializedHealth.reason)
      this.state = { status: 'ready' }
    } catch (error) {
      this.fail(error)
      await this.stopHandle()
      throw error
    }
  }

  async request(input: LspRequest, signal: AbortSignal): Promise<unknown> {
    if (this.state.status !== 'ready') throw new Error('lsp-unavailable')
    const uri = await this.options.resolveDocumentUri('path' in input ? input.path : '.')
    if ('path' in input) await this.syncUri(uri, input.language)
    const position = 'line' in input ? { line: input.line, character: input.character } : undefined
    switch (input.operation) {
      case 'definition':
        return this.sendRequest('textDocument/definition', { textDocument: { uri }, position }, signal)
      case 'references':
        return this.sendRequest('textDocument/references', { textDocument: { uri }, position, context: { includeDeclaration: true } }, signal)
      case 'hover':
        return this.sendRequest('textDocument/hover', { textDocument: { uri }, position }, signal)
      case 'document_symbols':
        return this.sendRequest('textDocument/documentSymbol', { textDocument: { uri } }, signal)
      case 'workspace_symbols':
        return this.sendRequest('workspace/symbol', { query: input.query }, signal)
      case 'formatting':
        return this.sendRequest('textDocument/formatting', { textDocument: { uri }, options: input.options ?? {} }, signal)
      case 'range_formatting':
        return this.sendRequest('textDocument/rangeFormatting', { textDocument: { uri }, range: input.range, options: input.options ?? {} }, signal)
      case 'code_action': {
        // Per LSP spec `CodeActionContext.diagnostics` must hold only the
        // diagnostics overlapping the requested range. An explicit caller
        // context is passed through untouched; a seeded context filters the
        // buffered per-file diagnostics down to range overlaps.
        const context = input.context ?? { diagnostics: seedCodeActionDiagnostics(this.diagnosticsBuffer.get(uri), input.range) }
        return this.sendRequest('textDocument/codeAction', { textDocument: { uri }, range: input.range, context }, signal)
      }
      case 'diagnostics': {
        // F1.1026 — a server that did not advertise `diagnosticProvider` only
        // pushes, and answers a pull with an error, so it is not pulled: the op
        // returns the latest set it pushed for this file (`[]` when none), and the
        // absent `pulled` says no report was computed on request. Residue: that
        // set is what the server has pushed SO FAR, which can predate a
        // didOpen/didChange this very request just sent.
        if (!this.pullDiagnostics) return { pushed: this.diagnosticsBuffer.get(uri) ?? [] }
        // Pull the server-computed report AND surface anything pushed since the
        // last pull. `pushed` is fail-soft context; the pull result is authoritative.
        const pulled = await this.sendRequest('textDocument/diagnostic', { textDocument: { uri } }, signal)
        const pushed = this.diagnosticsBuffer.get(uri)
        return pushed && pushed.length > 0 ? { pulled, pushed } : pulled
      }
    }
  }

  /**
   * F1.1013 — tell the server the current on-disk state of one document, per its
   * advertised `textDocumentSync` (see {@link syncUriNow}). `request` does this
   * for every document request; this is the seam for a caller that knows a file
   * changed without asking the server anything (the host's post-edit path).
   * Without `languageId` it only refreshes a document that is already open.
   * F1.1024: resolves true only when the server was just sent the file's current
   * text (a `didOpen`, a `didChange`, or a close-and-reopen) — the one case in
   * which the spec has it push fresh diagnostics — so a caller knows whether a
   * push is worth waiting for.
   */
  async syncDocument(path: string, languageId?: string): Promise<boolean> {
    if (this.state.status !== 'ready') throw new Error('lsp-unavailable')
    return await this.syncUri(await this.options.resolveDocumentUri(path), languageId)
  }

  private syncUri(uri: string, languageId: string | undefined): Promise<boolean> {
    const run = this.documentSyncQueue.then(() => this.syncUriNow(uri, languageId))
    this.documentSyncQueue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * F1.1013 — LSP 3.17 § Text Document Synchronization. *"Before requesting
   * information from the server … the client must ensure that the document's
   * state is synchronized with the server"*, and after `didOpen` *"the server
   * must not try to read the document's content using the document's Uri"* — so
   * once a document is open, every later edit on disk has to reach the server
   * as a `didChange`, or its answers describe a file that no longer exists.
   *
   * The source of truth is the file on disk (the agent edits files, not editor
   * buffers), read afresh on every sync and compared by digest:
   *   - the server did not ask for open/close → nothing is sent, and it reads
   *     the disk itself, which is current by construction;
   *   - not open yet → `didOpen` (version 1), only when a language id is known —
   *     it comes from the request's `language`, which the port has already
   *     matched against the plugin's own `extensionToLanguage` values; never
   *     guessed from the extension;
   *   - open with another language id → `didClose` then `didOpen`, the spec's
   *     own rule for a language change;
   *   - open and changed → `didChange` at the next version: the whole text for
   *     `Full`, a range spanning the previous whole document for `Incremental`
   *     (an incremental update the server can apply to the copy it holds), and a
   *     close-and-reopen when the server asked for open/close but `change: None`,
   *     so its copy is never left stale;
   *   - unreadable, gone, not a file, or larger than {@link MAX_SYNCED_DOCUMENT_BYTES}
   *     → `didClose` if it was open, handing ownership back to the disk.
   * Open documents are bounded by {@link MAX_OPEN_DOCUMENTS}; the least recently
   * synced is closed first. A restart starts with none open.
   */
  private async syncUriNow(uri: string, languageId: string | undefined): Promise<boolean> {
    if (!this.handle || !this.documentSync.openClose) return false
    let open = this.openDocuments.get(uri)
    if (!open && languageId === undefined) return false
    const text = await readSyncableText(uri)
    if (text === undefined) {
      if (open) await this.closeDocument(uri)
      return false
    }
    if (open && languageId !== undefined && open.languageId !== languageId) {
      await this.closeDocument(uri)
      open = undefined
    }
    const digest = createHash('sha256').update(text).digest('hex')
    if (!open) {
      if (languageId === undefined) return false
      while (this.openDocuments.size >= MAX_OPEN_DOCUMENTS) {
        const oldest = this.openDocuments.keys().next().value
        if (oldest === undefined) break
        await this.closeDocument(oldest)
      }
      await this.openDocument(uri, languageId, 1, text, digest)
      return true
    }
    // LRU-on-sync: re-insert so the key moves to the end.
    this.openDocuments.delete(uri)
    this.openDocuments.set(uri, open)
    if (open.digest === digest) return false
    const version = open.version + 1
    if (this.documentSync.change === TEXT_DOCUMENT_SYNC_NONE) {
      await this.closeDocument(uri)
      await this.openDocument(uri, open.languageId, version, text, digest)
      return true
    }
    const contentChanges = this.documentSync.change === TEXT_DOCUMENT_SYNC_INCREMENTAL
      ? [{ range: { start: { line: 0, character: 0 }, end: open.end }, text }]
      : [{ text }]
    await this.sendNotification('textDocument/didChange', { textDocument: { uri, version }, contentChanges })
    this.openDocuments.set(uri, { ...open, version, digest, end: documentEnd(text) })
    return true
  }

  private async openDocument(uri: string, languageId: string, version: number, text: string, digest: string): Promise<void> {
    await this.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId, version, text } })
    this.openDocuments.set(uri, { languageId, version, digest, end: documentEnd(text) })
  }

  private async closeDocument(uri: string): Promise<void> {
    this.openDocuments.delete(uri)
    await this.sendNotification('textDocument/didClose', { textDocument: { uri } })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const pending of this.pending.values()) {
      pending.removeAbort?.()
      pending.reject(new Error('lsp-service-disposed'))
    }
    this.pending.clear()
    this.diagnosticsBuffer.clear()
    this.openDocuments.clear()
    await this.stopHandle()
    await this.reading?.catch(() => undefined)
    this.state = { status: 'unavailable', reason: 'disposed' }
  }

  private async sendRequest(method: string, params: unknown, signal?: AbortSignal, initialize = false): Promise<unknown> {
    if (!this.handle) throw new Error('lsp-process-unavailable')
    if (signal?.aborted) throw new Error('lsp-request-aborted')
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      const pending: Pending = { resolve, reject }
      if (signal) {
        const abort = () => {
          if (!this.pending.delete(id)) return
          reject(new Error('lsp-request-aborted'))
          void this.sendNotification('$/cancelRequest', { id }).catch(() => undefined)
        }
        signal.addEventListener('abort', abort, { once: true })
        pending.removeAbort = () => signal.removeEventListener('abort', abort)
      }
      this.pending.set(id, pending)
    })
    try {
      await this.write({ jsonrpc: '2.0', id, method, params })
      return await promise
    } catch (error) {
      const pending = this.pending.get(id)
      if (pending) {
        this.pending.delete(id)
        pending.removeAbort?.()
        pending.reject(error instanceof Error ? error : new Error(String(error)))
      }
      if (initialize && error instanceof Error && error.message === 'lsp-response-id-mismatch') {
        throw new Error('lsp-initialize-response-mismatch')
      }
      throw error
    }
  }

  private sendNotification(method: string, params: unknown): Promise<void> {
    return this.write({ jsonrpc: '2.0', method, params })
  }

  private async write(value: unknown): Promise<void> {
    if (!this.handle) throw new Error('lsp-process-unavailable')
    const body = JSON.stringify(value)
    await this.options.processPort.write({
      sessionKey: this.options.sessionKey,
      handle: this.handle,
      data: `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    })
  }

  private async readLoop(): Promise<void> {
    while (!this.disposed && this.handle) {
      const result = await this.options.processPort.read({
        sessionKey: this.options.sessionKey,
        handle: this.handle,
        cursor: this.cursor,
      })
      this.cursor = result.nextCursor
      if (result.output) {
        this.buffer += result.output
        this.consumeFrames()
      }
      if (!result.isRunning) {
        throw new Error('lsp-process-closed')
      }
      if (!result.output) await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  private consumeFrames(): void {
    while (this.buffer) {
      const header = this.buffer.indexOf('Content-Length:')
      if (header < 0) {
        if (this.buffer.length > MAX_FRAME_BYTES) this.buffer = ''
        return
      }
      if (header > 0) this.buffer = this.buffer.slice(header)
      const boundary = this.buffer.indexOf('\r\n\r\n')
      if (boundary < 0) return
      const match = /^Content-Length:\s*(\d+)/i.exec(this.buffer.slice(0, boundary))
      if (!match) {
        this.buffer = this.buffer.slice(boundary + 4)
        continue
      }
      const bytes = Number(match[1])
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_FRAME_BYTES) {
        this.failPending(new Error('lsp-frame-invalid'))
        this.buffer = ''
        return
      }
      const bodyStart = boundary + 4
      if (Buffer.byteLength(this.buffer.slice(bodyStart)) < bytes) return
      const bodyBuffer = Buffer.from(this.buffer.slice(bodyStart))
      const body = bodyBuffer.subarray(0, bytes).toString('utf8')
      this.buffer = bodyBuffer.subarray(bytes).toString('utf8')
      let message: any
      try { message = JSON.parse(body) } catch { continue }
      // Notifications (method-bearing, id-less) must be handled BEFORE the id
      // check below drops them. Only publishDiagnostics is consumed; every other
      // notification stays dropped. Request/response correlation is untouched.
      if (typeof message.id !== 'number') {
        if (typeof message.method === 'string') this.handleNotification(message)
        continue
      }
      // A frame with BOTH a numeric id AND a method is a server→client REQUEST
      // (e.g. workspace/configuration, client/registerCapability), NOT a
      // response. It must never enter the pending-response lookup: in ready
      // state that silently drops it and the server hangs awaiting a reply; in
      // connecting state a colliding id would resolve OUR pending request with
      // garbage. We do not implement these methods, so answer with a JSON-RPC
      // "method not found" error via the normal write path and never touch
      // `pending`.
      if (typeof message.method === 'string') {
        void this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } }).catch(() => undefined)
        continue
      }
      const pending = this.pending.get(message.id)
      if (!pending) {
        if (this.state.status === 'connecting') this.failPending(new Error('lsp-response-id-mismatch'))
        continue
      }
      this.pending.delete(message.id)
      pending.removeAbort?.()
      if (message.error) pending.reject(new Error(String(message.error.message ?? 'lsp-request-failed')))
      else pending.resolve(message.result)
    }
  }

  private handleNotification(message: any): void {
    if (message.method !== 'textDocument/publishDiagnostics') return
    const params = message.params
    if (!params || typeof params.uri !== 'string' || !Array.isArray(params.diagnostics)) return
    const notification: LspDiagnosticsNotification = { uri: params.uri, diagnostics: params.diagnostics }
    // Bounded buffer keyed by URI, retained newest-touched last so
    // `keys().next()` yields the true least-recently-updated entry:
    //   - empty push clears that file's entry
    //   - a refresh delete+set the key so it moves to the end (LRU-on-write,
    //     not FIFO — a plain `.set()` on an existing key would keep its old
    //     iteration position)
    //   - evict the least-recently-updated entry when a new file exceeds the cap
    //   - per-URI diagnostics are truncated to MAX_DIAGNOSTICS_PER_FILE
    if (notification.diagnostics.length === 0) {
      this.diagnosticsBuffer.delete(notification.uri)
    } else {
      if (this.diagnosticsBuffer.has(notification.uri)) {
        this.diagnosticsBuffer.delete(notification.uri)
      } else if (this.diagnosticsBuffer.size >= MAX_DIAGNOSTIC_FILES) {
        const oldest = this.diagnosticsBuffer.keys().next().value
        if (oldest !== undefined) this.diagnosticsBuffer.delete(oldest)
      }
      const bounded = notification.diagnostics.length > MAX_DIAGNOSTICS_PER_FILE
        ? notification.diagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE)
        : notification.diagnostics
      this.diagnosticsBuffer.set(notification.uri, bounded)
    }
    // P6.417 — *"Whether to push diagnostics into Claude's context after edits
    // (default `true`). Set to `false` to keep code navigation but suppress
    // automatic diagnostic injection."* So `false` gates the SINK and not the
    // buffer: the pull path (`textDocument/diagnostic`) and the code-action
    // context above are code navigation and stay, which is exactly what the
    // sentence distinguishes.
    if (!this.supervision.diagnostics) return
    // Fail-soft: a throwing sink must never break the read loop or drop the frame.
    try { this.options.onDiagnostics?.(notification) } catch { /* ignore */ }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.removeAbort?.()
      pending.reject(error)
    }
    this.pending.clear()
  }

  private fail(error: unknown): void {
    if (this.disposed || this.state.status === 'failed') return
    const failure = error instanceof Error ? error : new Error(String(error))
    this.state = { status: 'failed', reason: failure.message.slice(0, 256) }
    this.failPending(failure)
  }

  private async stopHandle(): Promise<void> {
    const handle = this.handle
    this.handle = undefined
    if (!handle) return
    const stop = this.options.processPort.stop({ sessionKey: this.options.sessionKey, handle })
      .catch(() => undefined)
    const { shutdownTimeoutMs } = this.supervision
    // P6.417 — *"Max time to wait for graceful shutdown (milliseconds). When the
    // timeout elapses, Claude Code terminates the server process. When unset, no
    // timeout applies."* Unset therefore AWAITS, which is the behaviour this
    // service always had; a declared bound stops waiting and lets the process
    // port's own kill path finish on its own. The stop promise is deliberately
    // not abandoned unhandled — it already swallows its rejection above.
    if (shutdownTimeoutMs === undefined) { await stop; return }
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      stop,
      new Promise<void>(resolve => { timer = setTimeout(resolve, shutdownTimeoutMs) }),
    ])
    if (timer !== undefined) clearTimeout(timer)
  }

  /**
   * P6.417 — the crash-restart policy.
   *
   * *"Whether to restart the server after it crashes. Defaults to `true`"* and
   * *"Maximum number of restart attempts before giving up"*. Before this row a
   * crashed plugin language server stayed dead and nothing said so, which is the
   * "started and left" the row is named for.
   *
   * The attempt counter is NOT reset by a successful restart, deliberately: a
   * server that crashes every few seconds would otherwise restart for ever with
   * `maxRestarts` never reached, and `maxRestarts` is written by an author who
   * means "give up eventually". An author who declares none gets
   * {@link LspService.DEFAULT_MAX_RESTARTS}, a HOST ceiling with its own reason
   * — the page names no default and its literal reading is *for ever*.
   *
   * A restart that itself fails is NOT retried from here: `start()` already
   * calls `fail` and `stopHandle`, and re-entering would be a loop with no
   * exit. The host is told either way through `onRestart`, so a server that
   * came back and one that did not are distinguishable rather than both silent.
   */
  private async restartAfterCrash(error: unknown): Promise<void> {
    if (this.disposed) return
    const { restartOnCrash, maxRestarts } = this.supervision
    const reason = error instanceof Error ? error.message : String(error)
    const attempt = this.restarts + 1
    const allowed = restartOnCrash && this.restarts < maxRestarts
    if (!allowed) {
      this.options.onRestart?.({ attempt, maxRestarts, reason, restarted: false })
      return
    }
    this.restarts = attempt
    await this.stopHandle()
    this.pending.clear()
    this.buffer = ''
    // `start()` returns early on `ready`, so the failed state has to be cleared
    // before it is called or the restart would be a silent no-op.
    this.state = { status: 'unavailable', reason: 'restarting' }
    try {
      await this.start()
      this.options.onRestart?.({ attempt, maxRestarts, reason, restarted: true })
    } catch {
      // `start()` has already recorded the failure and stopped the handle.
      this.options.onRestart?.({ attempt, maxRestarts, reason, restarted: false })
    }
  }
}

/**
 * F1.1013 — `TextDocumentSyncKind`, LSP 3.17 § Text Document Synchronization:
 * `None = 0` ("Documents should not be synced at all"), `Full = 1` ("always
 * sending the full content"), `Incremental = 2` ("full content on open. After
 * that only incremental updates").
 */
const TEXT_DOCUMENT_SYNC_NONE = 0
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2
type TextDocumentSyncKind = 0 | 1 | 2
type DocumentSync = { openClose: boolean; change: TextDocumentSyncKind }
const NO_DOCUMENT_SYNC: DocumentSync = { openClose: false, change: TEXT_DOCUMENT_SYNC_NONE }

type OpenDocument = {
  languageId: string
  version: number
  /** sha256 of the text last sent, so an unchanged file is not re-sent. */
  digest: string
  /** End position of the text last sent: the range an `Incremental` change replaces. */
  end: { line: number; character: number }
}

/**
 * F1.1013 — bound on documents held open on one server. A long session touches
 * many files and each open one costs the server a parsed copy; the least
 * recently synced is closed (ownership goes back to the disk) past this.
 */
const MAX_OPEN_DOCUMENTS = 64
/**
 * F1.1013 — a document larger than the largest frame this client accepts from
 * the server is not sent; the server reads it from disk, which is current.
 */
const MAX_SYNCED_DOCUMENT_BYTES = MAX_FRAME_BYTES

/**
 * F1.1013 — the server capability `textDocumentSync` is *"either a detailed
 * structure defining each notification or for backwards compatibility the
 * TextDocumentSyncKind number"* and *"If omitted it defaults to
 * TextDocumentSyncKind.None"*. For the structure, `openClose` *"If omitted open
 * close notifications should not be sent"* and `change` *"If omitted it defaults
 * to TextDocumentSyncKind.None"*. The bare number carries no `openClose`, so it
 * is read the way the reference client (`vscode-languageclient`, MIT) reads it:
 * `None` syncs nothing, `Full`/`Incremental` open and close documents and change
 * them by that kind.
 */
function resolveDocumentSync(capability: unknown): DocumentSync {
  const kind = (value: unknown): TextDocumentSyncKind => value === 1 || value === 2 ? value : TEXT_DOCUMENT_SYNC_NONE
  if (typeof capability === 'number') {
    const change = kind(capability)
    return change === TEXT_DOCUMENT_SYNC_NONE ? NO_DOCUMENT_SYNC : { openClose: true, change }
  }
  if (typeof capability === 'object' && capability !== null) {
    const declared = capability as { openClose?: unknown; change?: unknown }
    return { openClose: declared.openClose === true, change: kind(declared.change) }
  }
  return NO_DOCUMENT_SYNC
}

/**
 * F1.1026 — LSP 3.17 § Pull Diagnostics: the server capability
 * `diagnosticProvider` (*"The server has support for pull model diagnostics"*),
 * typed `DiagnosticOptions | DiagnosticRegistrationOptions`. It is read as the
 * reference client (`vscode-languageclient`, MIT, `getRegistration`) reads it:
 * any object, or a bare `true`. Only the static capability counts, because
 * *"A client opts in via the `dynamicRegistration` property"* for a dynamic
 * one and this client declares no dynamic registration (a `client/registerCapability`
 * gets method-not-found above). A `documentSelector` in the options is not
 * matched: one plugin server serves the languages the plugin declared.
 */
function advertisesPullDiagnostics(capability: unknown): boolean {
  return capability === true || (typeof capability === 'object' && capability !== null)
}

/**
 * The position just past the last character of `text`. LSP 3.17 § Text
 * Documents: the end-of-line sequences are `\n`, `\r\n` and `\r`, and without
 * a negotiated `positionEncoding` (this client offers none) `character` counts
 * UTF-16 code units — which is what a JavaScript string's `length` counts.
 */
function documentEnd(text: string): { line: number; character: number } {
  const lines = text.split(/\r\n|\r|\n/)
  return { line: lines.length - 1, character: lines[lines.length - 1]!.length }
}

/** The document's current text, or undefined when it cannot or should not be synced. */
async function readSyncableText(uri: string): Promise<string | undefined> {
  if (!uri.startsWith('file:')) return undefined
  try {
    const path = fileURLToPath(uri)
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_SYNCED_DOCUMENT_BYTES) return undefined
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * F1.1145 (origin DN-219, 2026-09-28) — the client capabilities `initialize`
 * declares: exactly the two this client uses. It sent `capabilities: {}`, which
 * LSP 3.17 reads as a client supporting none of them.
 *
 * - `synchronization` — {@link LspService} sends `didOpen` / `didChange` /
 *   `didClose` (whole text or an incremental range, per the server's own
 *   `textDocumentSync`) and nothing around a save, so `willSave`,
 *   `willSaveWaitUntil` and `didSave` are false.
 * - `publishDiagnostics` — pushed diagnostics are read (`onDiagnostics`) with no
 *   optional property claimed (`relatedInformation`, `versionSupport`, …).
 *
 * Every `dynamicRegistration` is false: `client/registerCapability` answers
 * method-not-found. NOT declared, deliberately: `textDocument.diagnostic` (pull).
 * The service already pulls from a server that advertises `diagnosticProvider`
 * (F1.1026); declaring the client half could make a server stop PUSHING, and the
 * post-edit wait (F1.1024) listens for pushes. The request methods
 * (definition, hover, …) are sent with no capability object, as before.
 */
const LSP_CLIENT_CAPABILITIES = Object.freeze({
  textDocument: {
    synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: false },
    publishDiagnostics: {},
  },
})
