import type { MonitorStartResult } from '@nessy-agent/session-tools-core'
import type { BackgroundTaskEntryV1, BackgroundTaskStatus } from '@nessy-agent/shared/automations'
import { capHookRegistryText } from '@nessy-agent/shared/automations'
import { validateWsWatchInput } from '@nessy-agent/shared/config'
import type { SessionKey } from '@nessy-agent/shared/sessions/session-key'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import type { ProcessSupervisorPort } from '@nessy-agent/shared/agent/pi-harness/process-supervisor-port'

/**
 * Host-side runtime for the `Monitor` tool.
 *
 * `Monitor` is a SECOND PRODUCER into the background-task registry
 * `bash_background` already writes to, not a registry of its own: a `command`
 * watch is a `ProcessSupervisor` background process, so its `taskId` IS a
 * supervisor handle, owner-binding comes from `ProcessStore.assertOwner` for
 * free, and `ProcessStop` needs no identifier translation. Only the `ws` source
 * has no process behind it, which is the one case this service has to own.
 */

/**
 * The registry entry shape and its 1000-character cap now live beside
 * `SdkAutomationInput` in `@nessy-agent/shared/automations`, because R27c made
 * them hook WIRE shape: this service is one producer of `background_tasks[]`,
 * not its owner. Re-exported under the original names so existing importers and
 * their pins are untouched.
 */
export type {
  BackgroundTaskType,
  BackgroundTaskStatus,
  BackgroundTaskEntryV1,
} from '@nessy-agent/shared/automations'

export {
  HOOK_REGISTRY_TEXT_CAP as BACKGROUND_TASK_DESCRIPTION_CAP,
  capHookRegistryText as capBackgroundTaskDescription,
} from '@nessy-agent/shared/automations'

/** One monitor event on its way to the session layer. */
export interface MonitorDelivery {
  readonly sessionKey: SessionKey
  readonly taskId: string
  readonly text: string
  /** True for the event that ends the watch (exit code, close code, or error). */
  readonly terminal?: boolean
}

export interface MonitorStartRequest {
  sessionKey: SessionKey
  cwd: string
  workspaceRoot: string
  description: string
  timeoutMs: number
  persistent: boolean
  command?: string
  ws?: { url: string; protocols?: string[] }
  /**
   * Extra environment for a `command` watch, merged over the host environment
   * for that one spawn.
   *
   * The `Monitor` TOOL never sets this — the model must not be able to name the
   * environment its own watch runs in. The one producer is the plugin-monitor
   * arming path, which supplies the plugin path aliases
   * (`plugins/components.md#monitors`) through the shared `pluginRuntimeEnvForProfile`.
   * `CLAUDE_PLUGIN_OPTION_*` is deliberately not among them: `:334` says monitor
   * processes do not receive it.
   */
  env?: Record<string, string>
  /**
   * Host-authorized managed data roots for a `command` watch. Same producer and
   * same restriction as `env`: the `Monitor` tool cannot reach it, and the plugin
   * path supplies only the plugin's own `${CLAUDE_PLUGIN_DATA}` directory — the
   * one place `plugins/components.md#path-variables-and-persistent-data` tells an author to keep state.
   */
  additionalWritableRoots?: readonly string[]
}

/** A live socket, narrowed to what the ws source needs. */
export interface MonitorSocket {
  close(): void
}

export interface MonitorSocketHandlers {
  onText(text: string): void
  onBinary(byteLength: number): void
  onClose(code: number | undefined, reason: string | undefined): void
  onError(message: string): void
}

interface MonitorRecord {
  entry: BackgroundTaskEntryV1
  kind: 'command' | 'ws'
  socket?: MonitorSocket
}

export interface SessionMonitorServiceOptions {
  processPort: Pick<ProcessSupervisorPort, 'start' | 'stop'>
  deliver(delivery: MonitorDelivery): void
  /**
   * Read/retire persisted process records on resume. Monitors are documented as
   * NEVER restored, so this is only ever used to retire a stale record.
   */
  processStore?: {
    list(sessionKey: SessionKey): Promise<readonly { handle: string; semanticId: string; status: string; movedToBackgroundAt?: number }[]>
    update(handle: string, patch: { status: 'stopped' }): Promise<unknown>
  }
  /**
   * Authorize one watch before anything is started. Rejecting must leave no
   * socket, no process and no registry entry.
   */
  authorize?(request: MonitorStartRequest): Promise<void>
  /** ws transport seam. Absent means the ws source is unavailable on this host. */
  openSocket?(input: { url: string; protocols?: string[] }, handlers: MonitorSocketHandlers): Promise<MonitorSocket>
}

/** A ws message over this size ends the watch, per the documented contract. */
export const MONITOR_MAX_WS_MESSAGE_BYTES = 1024 * 1024

export class SessionMonitorService {
  private readonly bySession = new Map<string, Map<string, MonitorRecord>>()

  constructor(private readonly options: SessionMonitorServiceOptions) {}

  list(sessionKey: SessionKey): readonly BackgroundTaskEntryV1[] {
    const live = this.bySession.get(encodeSessionKey(sessionKey))
    return live ? [...live.values()].map(record => record.entry) : []
  }

  async start(request: MonitorStartRequest): Promise<MonitorStartResult> {
    // The `ws` field rules (`tools-reference.md:296`-`:297`) are enforced HERE,
    // the last gate before a socket could open, so no caller can route around
    // them — and BEFORE `authorize`, so a URL with embedded credentials never
    // reaches an approval prompt or an error string that would echo it. The
    // verdict's reason deliberately never quotes the URL.
    if (request.ws) {
      const verdict = validateWsWatchInput(request.ws)
      if (!verdict.ok) throw new Error(`Monitor ws watch refused: ${verdict.reason}`)
    }
    await this.options.authorize?.(request)
    const taskId = request.command !== undefined
      ? await this.startCommand(request)
      : await this.startWebSocket(request)
    return {
      taskId,
      timeoutMs: request.persistent ? 0 : request.timeoutMs,
      ...(request.persistent ? { persistent: true } : {}),
    }
  }

  async stop(sessionKey: SessionKey, taskId: string): Promise<boolean> {
    const key = encodeSessionKey(sessionKey)
    const record = this.bySession.get(key)?.get(taskId)
    if (!record) return false
    if (record.kind === 'ws') {
      record.socket?.close()
    } else {
      await this.options.processPort.stop({ sessionKey, handle: taskId })
    }
    this.retire(sessionKey, taskId, 'stopped')
    return true
  }

  /** Stop every watch this session owns. Used on session teardown. */
  async stopAll(sessionKey: SessionKey): Promise<void> {
    for (const taskId of [...(this.bySession.get(encodeSessionKey(sessionKey))?.keys() ?? [])]) {
      await this.stop(sessionKey, taskId).catch(() => undefined)
    }
  }

  /**
   * Monitor tasks are NEVER restored on resume. A resumed session must show no
   * phantom watches, so a persisted `running` monitor record is retired rather
   * than adopted — otherwise the registry projection would resurrect a process
   * this host no longer owns.
   */
  async sweepRestoredMonitors(sessionKey: SessionKey): Promise<readonly string[]> {
    const store = this.options.processStore
    if (!store) return []
    const records = await store.list(sessionKey)
    const retired: string[] = []
    for (const record of records) {
      if (record.status !== 'running') continue
      // The never-restore family (R3 monitors + R10 background tasks): a
      // monitor watch, a `bash_background` shell, or a command that was
      // auto-backgrounded on timeout. A plain foreground record is left to the
      // ordinary recovery path.
      const neverRestore = record.semanticId === 'monitor'
        || record.semanticId === 'bash_background'
        || record.movedToBackgroundAt !== undefined
      if (!neverRestore) continue
      await store.update(record.handle, { status: 'stopped' }).catch(() => undefined)
      retired.push(record.handle)
    }
    return retired
  }

  private async startCommand(request: MonitorStartRequest): Promise<string> {
    const sessionKey = request.sessionKey
    let taskId: string | undefined
    const pending: { text: string; terminal?: boolean }[] = []
    const flush = () => {
      if (!taskId) return
      while (pending.length > 0) {
        const event = pending.shift()!
        this.options.deliver({ sessionKey, taskId, text: event.text, ...(event.terminal ? { terminal: true } : {}) })
      }
    }
    const emit = (text: string, terminal?: boolean) => {
      pending.push({ text, ...(terminal ? { terminal: true } : {}) })
      flush()
    }
    const lines = new LineSplitter(text => emit(text))

    const result = await this.options.processPort.start({
      sessionKey,
      executionId: `monitor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      semanticId: 'monitor',
      // The documented source is a "shell script", and the supervisor spawns
      // argv directly (`sandbox-exec -p <profile> <command> <args…>`), so the
      // script has to be handed to a shell explicitly. Same shape as the
      // runtime skill-context command path.
      command: '/bin/sh',
      args: ['-lc', request.command!],
      cwd: request.cwd,
      workspaceRoot: request.workspaceRoot,
      profile: 'workspace',
      background: true,
      timeoutMs: request.timeoutMs,
      ...(request.env ? { env: request.env } : {}),
      ...(request.additionalWritableRoots?.length
        ? { additionalWritableRoots: request.additionalWritableRoots }
        : {}),
      ...(request.persistent ? { persistent: true } : {}),
      // stderr still lands in the supervisor's own output record; only stdout
      // lines become events.
      onStdout: chunk => lines.push(chunk),
      onClose: (exitCode, signal) => {
        lines.finish()
        const how = exitCode === null
          ? `signal ${signal ?? 'unknown'}`
          : `code ${exitCode}`
        emit(`Monitor ${taskId ?? 'unknown'} exited with ${how}.`, true)
        this.retire(sessionKey, taskId, exitCode === 0 ? 'completed' : 'failed')
      },
    })
    taskId = result.handle
    this.register(sessionKey, {
      kind: 'command',
      entry: this.buildEntry(result.handle, request, { tool: 'command' }),
    })
    flush()
    return result.handle
  }

  private async startWebSocket(request: MonitorStartRequest): Promise<string> {
    const open = this.options.openSocket
    if (!open) throw new Error('Monitor ws source is not available in this context.')
    const sessionKey = request.sessionKey
    const url = request.ws!.url
    const taskId = `monitor_ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const emit = (text: string, terminal?: boolean) => {
      this.options.deliver({ sessionKey, taskId, text, ...(terminal ? { terminal: true } : {}) })
    }
    let host: string
    try {
      host = new URL(url).host
    } catch {
      throw new Error(`Monitor ws url is not a valid URL: ${url}`)
    }

    // "A message over 1 MiB ends the watch" applies to a message, not to a text
    // frame: a huge binary frame must not slip through just because its own
    // event is a short placeholder.
    const tooLarge = (byteLength: number): boolean => {
      if (byteLength <= MONITOR_MAX_WS_MESSAGE_BYTES) return false
      emit(`Monitor ${taskId} ended: a ${byteLength}-byte message exceeds the ${MONITOR_MAX_WS_MESSAGE_BYTES}-byte limit.`, true)
      void this.stop(sessionKey, taskId).catch(() => undefined)
      return true
    }

    const socket = await open({ url, ...(request.ws!.protocols ? { protocols: request.ws!.protocols } : {}) }, {
      onText: text => {
        if (tooLarge(Buffer.byteLength(text, 'utf8'))) return
        emit(text)
      },
      onBinary: byteLength => {
        if (tooLarge(byteLength)) return
        emit(`[binary frame, ${byteLength} bytes]`)
      },
      onClose: (code, reason) => {
        emit(`Monitor ${taskId} closed with code ${code ?? 'unknown'}${reason ? `: ${reason}` : ''}.`, true)
        this.retire(sessionKey, taskId, 'completed')
      },
      // Errors surface BEFORE close, so the model sees the cause and then the
      // close code rather than only a bare close.
      onError: message => emit(`Monitor ${taskId} error: ${message}`),
    })

    this.register(sessionKey, {
      kind: 'ws',
      socket,
      entry: this.buildEntry(taskId, request, { server: host, tool: 'ws' }),
    })
    return taskId
  }

  private buildEntry(
    id: string,
    request: MonitorStartRequest,
    extra: { server?: string; tool?: string },
  ): BackgroundTaskEntryV1 {
    // The ONE place a registry description is capped.
    return Object.freeze({
      id,
      type: 'monitor' as const,
      status: 'running' as const,
      description: capHookRegistryText(request.description),
      ...(extra.server ? { server: extra.server } : {}),
      ...(extra.tool ? { tool: extra.tool } : {}),
    })
  }

  private register(sessionKey: SessionKey, record: MonitorRecord): void {
    const key = encodeSessionKey(sessionKey)
    const live = this.bySession.get(key) ?? new Map<string, MonitorRecord>()
    live.set(record.entry.id, record)
    this.bySession.set(key, live)
  }

  private retire(sessionKey: SessionKey, taskId: string | undefined, _status: BackgroundTaskStatus): void {
    if (!taskId) return
    const key = encodeSessionKey(sessionKey)
    const live = this.bySession.get(key)
    if (!live) return
    live.delete(taskId)
    if (live.size === 0) this.bySession.delete(key)
  }
}

/**
 * Production ws transport, on the platform `WebSocket` global (Bun and Electron
 * both ship it — no dependency). Listeners are attached BEFORE the open await so
 * a frame that arrives in the same tick as the handshake is not dropped.
 */
export async function openMonitorWebSocket(
  input: { url: string; protocols?: string[] },
  handlers: MonitorSocketHandlers,
): Promise<MonitorSocket> {
  const socket = input.protocols?.length
    ? new WebSocket(input.url, input.protocols)
    : new WebSocket(input.url)
  socket.binaryType = 'arraybuffer'

  let opened = false
  const settle: { resolve?: () => void; reject?: (error: Error) => void } = {}
  const ready = new Promise<void>((resolve, reject) => {
    settle.resolve = resolve
    settle.reject = reject
  })

  socket.addEventListener('open', () => {
    opened = true
    settle.resolve?.()
  })
  socket.addEventListener('message', event => {
    const data = (event as MessageEvent).data
    if (typeof data === 'string') {
      handlers.onText(data)
      return
    }
    if (data instanceof ArrayBuffer) {
      handlers.onBinary(data.byteLength)
      return
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      handlers.onBinary(data.size)
      return
    }
    handlers.onBinary(0)
  })
  socket.addEventListener('error', () => {
    // Before the handshake completes this is a connection failure, so it must
    // reject the start rather than becoming an event on a watch that never
    // existed. After it, errors surface as events ahead of the close code.
    if (opened) handlers.onError(`WebSocket error on ${input.url}`)
    else settle.reject?.(new Error(`Monitor could not connect to ${input.url}.`))
  })
  socket.addEventListener('close', event => {
    const closeEvent = event as CloseEvent
    if (!opened) {
      settle.reject?.(new Error(`Monitor could not connect to ${input.url}.`))
      return
    }
    handlers.onClose(closeEvent.code, closeEvent.reason || undefined)
  })

  await ready
  return { close: () => socket.close() }
}

/**
 * Splits a byte stream into stdout LINES. One line is one event, so a chunk
 * boundary mid-line must not become two events, and a final line with no
 * trailing newline must still emit when the stream ends.
 */
class LineSplitter {
  private buffer = ''

  constructor(private readonly emit: (line: string) => void) {}

  push(chunk: Uint8Array): void {
    this.buffer += Buffer.from(chunk).toString('utf8')
    let index = this.buffer.indexOf('\n')
    while (index !== -1) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      this.emit(line.endsWith('\r') ? line.slice(0, -1) : line)
      index = this.buffer.indexOf('\n')
    }
  }

  finish(): void {
    if (this.buffer.length === 0) return
    const line = this.buffer
    this.buffer = ''
    this.emit(line.endsWith('\r') ? line.slice(0, -1) : line)
  }
}
