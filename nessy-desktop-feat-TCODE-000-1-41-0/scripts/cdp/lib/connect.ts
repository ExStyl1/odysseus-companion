/**
 * CDP attach/transport for the live-audit harness.
 *
 * One persistent WebSocket per run (the previous ad-hoc driver opened and closed
 * a socket per command, which loses every CDP event and makes "wait until X"
 * impossible). Every protocol error becomes a thrown Error — a silent `null`
 * result is how a run reports a pass for a thing that never happened.
 */

export interface CdpTarget {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

export interface ConnectOptions {
  /** CDP port. Defaults to NESSY_CDP_PORT, then 9223. */
  port?: string | number
  /** Substring matched against a page target's url or title. */
  match?: string
  /** Per-command timeout in ms, and the ceiling on the socket open at attach. {@link resolveTimeoutMs} */
  timeoutMs?: number
  /** Focus the window at attach; default TRUE, opt out with `false`. {@link focusWindow} */
  focus?: boolean
}

/**
 * Methods the harness refuses to send, with the reason.
 *
 * `Input.insertText` is banned outright. It commits text without dispatching a
 * single key event, so the composer's slash palette never opens and a typed
 * `/subtask …` is submitted as prose. A run driven that way filed a PASS for a
 * fork that never started (docs/testing/cdp-live-checklist.md, 2026-07-30
 * retraction). Making it unsendable is cheaper than remembering not to send it.
 */
export const FORBIDDEN_METHODS: Readonly<Record<string, string>> = Object.freeze({
  'Input.insertText':
    'Input.insertText fires NO key events: the slash palette never opens and the ' +
    'command is submitted as prose. Use typeText()/selectSlashCommand() from lib/keys.ts.',
})

export function assertMethodAllowed(method: string): void {
  const reason = FORBIDDEN_METHODS[method]
  if (reason) throw new Error(`cdp-forbidden-method: ${method} — ${reason}`)
}

export function resolvePort(port?: string | number): string {
  return String(port ?? process.env.NESSY_CDP_PORT ?? '9223')
}

/** The per-command ceiling, and why it is a knob rather than a constant.
 *
 * `Runtime.evaluate` is answered by the RENDERER, so its latency is the
 * renderer's, not the protocol's. On an idle box a round trip is ~160 ms; on a
 * box under load — the 1.36.0 release sitting met load averages of 20 to 52
 * from sibling work on 2026-09-11 — a poll issued while a turn is streaming can
 * sit far longer than that behind the renderer's own work, and the case then
 * dies with `cdp-timeout: Runtime.evaluate did not answer in 30000ms` having
 * measured the HOST rather than the product. Four sitting cases died that way
 * in one batch, each after its own checks had already passed.
 *
 * 30 s stays the default, because a harness that waits forever reports a hang
 * as a slow pass. `NESSY_CDP_TIMEOUT_MS` lets an operator on a loaded machine
 * raise it for a run and say so in the narrative, which is the honest shape: the
 * number is visible, per run, and never silently different from the default.
 * An explicit `timeoutMs` on a call site still wins, so a case that has a reason
 * for its own ceiling keeps it.
 *
 * F1.797: `attach` waits on this ceiling for the page socket to open as well.
 * That wait was a fixed 10 s, so its default is now 30 s like everything else. */
export function resolveTimeoutMs(timeoutMs?: number): number {
  if (timeoutMs !== undefined) return timeoutMs
  const raw = process.env.NESSY_CDP_TIMEOUT_MS?.trim()
  if (!raw) return 30_000
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`cdp-bad-timeout: NESSY_CDP_TIMEOUT_MS=${raw} is not a positive number of milliseconds`)
  }
  return parsed
}

export async function listTargets(port?: string | number): Promise<CdpTarget[]> {
  const resolved = resolvePort(port)
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${resolved}/json/list`)
  } catch (cause) {
    throw new Error(
      `cdp-unreachable: nothing answered http://127.0.0.1:${resolved}/json/list. ` +
        `Start the app with NESSY_CDP_PORT=${resolved} bun run electron:dev.`,
      { cause },
    )
  }
  if (!response.ok) throw new Error(`cdp-list-failed: HTTP ${response.status}`)
  return (await response.json()) as CdpTarget[]
}

export async function pickPageTarget(options: ConnectOptions = {}): Promise<CdpTarget> {
  const pages = (await listTargets(options.port)).filter(t => t.type === 'page')
  const match = options.match
  const target = match
    ? pages.find(t => t.url.includes(match) || t.title.includes(match))
    : pages[0]
  if (!target) {
    const inventory = pages.map(t => `  ${t.title} :: ${t.url}`).join('\n') || '  (no page targets)'
    throw new Error(`cdp-no-target${match ? ` matching ${match}` : ''}; have:\n${inventory}`)
  }
  if (!target.webSocketDebuggerUrl) throw new Error(`cdp-target-has-no-socket: ${target.title}`)
  return target
}

type PendingEntry = {
  resolve: (value: Record<string, unknown>) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: string
}

export type CdpEventHandler = (params: Record<string, unknown>) => void

/** A live attachment to one page target. */
export class CdpSession {
  readonly target: CdpTarget
  /**
   * Whether this attachment applies the focus emulation — `ConnectOptions.focus`
   * as it was passed, remembered so every later re-assertion obeys the same
   * decision. Read by {@link reassertWindowFocus} and by nothing else.
   */
  readonly focusEmulation: boolean
  /** The last state {@link reassertWindowFocus} read back, for a case to report. */
  lastFocus: WindowFocusState | undefined
  private readonly socket: WebSocket
  private readonly timeoutMs: number
  private readonly pending = new Map<number, PendingEntry>()
  private readonly listeners = new Map<string, Set<CdpEventHandler>>()
  private nextId = 1
  private closedReason: string | undefined

  private constructor(target: CdpTarget, socket: WebSocket, timeoutMs: number, focusEmulation: boolean) {
    this.target = target
    this.socket = socket
    this.timeoutMs = timeoutMs
    this.focusEmulation = focusEmulation
    socket.addEventListener('message', event => this.onMessage(String((event as MessageEvent).data)))
    socket.addEventListener('close', () => this.failAll('cdp-socket-closed'))
    socket.addEventListener('error', () => this.failAll('cdp-socket-error'))
  }

  static async attach(options: ConnectOptions = {}): Promise<CdpSession> {
    // F1.797 — the socket open waits on the SAME ceiling as every command. It was
    // a hard-coded 10 s that `NESSY_CDP_TIMEOUT_MS` did not raise, so SIT-m, at a
    // load average of 13 to 35 with that knob at 120 s, still lost two attaches to
    // `cdp-socket-open-timeout`. Resolved first, so a bad knob fails before any I/O.
    const timeoutMs = resolveTimeoutMs(options.timeoutMs)
    const target = await pickPageTarget(options)
    const socket = new WebSocket(target.webSocketDebuggerUrl!)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try { socket.close() } catch { /* never opened */ }
        reject(new Error(`cdp-socket-open-timeout: the page socket did not open in ${timeoutMs}ms (NESSY_CDP_TIMEOUT_MS raises it)`))
      }, timeoutMs)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('cdp-socket-open-failed')) }, { once: true })
    })
    const session = new CdpSession(target, socket, timeoutMs, options.focus !== false)
    // F1.120 / D1.395 — the window, BEFORE the case reads anything off it.
    await reassertWindowFocus(session)
    return session
  }

  private onMessage(raw: string): void {
    let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: unknown }
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof message.id === 'number') {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        entry.reject(new Error(`cdp-error: ${entry.method} → ${JSON.stringify(message.error)}`))
      } else {
        entry.resolve(message.result ?? {})
      }
      return
    }
    if (typeof message.method === 'string') {
      for (const handler of this.listeners.get(message.method) ?? []) handler(message.params ?? {})
    }
  }

  private failAll(reason: string): void {
    this.closedReason ??= reason
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.reject(new Error(`${reason}: ${entry.method} never answered`))
    }
  }

  on(method: string, handler: CdpEventHandler): () => void {
    const set = this.listeners.get(method) ?? new Set<CdpEventHandler>()
    set.add(handler)
    this.listeners.set(method, set)
    return () => { set.delete(handler) }
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    assertMethodAllowed(method)
    if (this.closedReason) throw new Error(`${this.closedReason}: refusing to send ${method}`)
    const id = this.nextId++
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`cdp-timeout: ${method} did not answer in ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
    })
    this.socket.send(JSON.stringify({ id, method, params }))
    return result
  }

  /**
   * Evaluate an expression in the page and return its value.
   *
   * A thrown page exception becomes a thrown Error here. The old driver returned
   * `undefined` for both "the expression returned undefined" and "the expression
   * threw", which is exactly the ambiguity that lets a case pass for free.
   */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }) as { result?: { value?: T }; exceptionDetails?: { exception?: { description?: string }; text?: string } }
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'unknown'
      throw new Error(`cdp-eval-threw: ${detail}\n--- expression ---\n${expression.slice(0, 400)}`)
    }
    return result.result?.value as T
  }

  /** Evaluate a function body with `return` statements, as an async IIFE. */
  async call<T = unknown>(body: string): Promise<T> {
    return this.evaluate<T>(`(async () => { ${body} })()`)
  }

  async screenshot(file: string): Promise<string> {
    const result = await this.send('Page.captureScreenshot', { format: 'png' }) as { data?: string }
    if (!result.data) throw new Error('cdp-screenshot-empty')
    await Bun.write(file, Buffer.from(result.data, 'base64'))
    return file
  }

  close(): void {
    this.failAll('cdp-session-closed')
    try { this.socket.close() } catch { /* already gone */ }
  }
}

/** What the page says about itself after {@link focusWindow} has run. */
export interface WindowFocusState {
  hasFocus: boolean
  visibilityState: string
  /**
   * Present ONLY when the two CDP calls or the read-back could not be made.
   *
   * `hasFocus: false` then says nothing about the window — it is the absence of
   * a reading, not a reading — which is why the reason is carried beside it
   * rather than swallowed into a falsy default.
   */
  failed?: string
}

/**
 * Make the window visible and focused, and read back what the page then says.
 *
 * **A DETACHED app window has no display, and a reading taken on one can be an
 * artefact of the rig.** Measured 2026-09-19 (SIT-7, row D1.395): launched
 * detached the window reports `visibilityState: "hidden"` and
 * `document.hasFocus() === false`, Accessibility reports **0 windows** for the
 * process even while macOS calls it frontmost, and the `/btw` panel — a Radix
 * popover whose lifetime is focus-driven — mounts and is REMOVED about 15 ms
 * later (MutationObserver: added t=1303, removed t=1320). That lane nearly filed
 * it as a release-blocking product defect. Three readings say it is the rig: the
 * Enter keyup lands AFTER the close (t=82 against t=43), a send-BUTTON arm with
 * no keyboard at all reproduces it exactly, and the shipped panel code is
 * byte-identical at `df194e02e^` and at HEAD.
 *
 * These two calls restore `hasFocus: true` / `visibilityState: "visible"`, and
 * the panel then stays open past 1 200 ms. **Four sittings carried them by hand**
 * — SIT-7 (P-SIT7-3), SIT-8 (P-SIT8-2), SIT-9 (P-SIT9-3) and SIT-10 (P-SIT10-8)
 * — which is F1.120's whole subject: an instrument every lane has to remember is
 * an instrument the lane that forgot did not have.
 *
 * It is LOUD: a protocol error propagates, because a case calling this by name
 * is a case whose surface depends on it. {@link reassertWindowFocus} is the
 * quiet, opt-out-aware form the harness applies for itself.
 */
export async function focusWindow(session: CdpSession): Promise<WindowFocusState> {
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await session.send('Page.setWebLifecycleState', { state: 'active' })
  // The state is READ BACK off the page, never inferred from the two calls
  // having returned — the same discipline `applyCasePermissionMode` applies to
  // the mode it writes, and for the same reason: a command that resolved is not
  // a posture that took.
  return session.call<WindowFocusState>(
    'return { hasFocus: document.hasFocus(), visibilityState: document.visibilityState }',
  )
}

/**
 * {@link focusWindow}, applied by the harness itself — at attach, and again
 * after every `freshSession()`.
 *
 * TWICE, because the emulation does not survive a navigation and SIT-7 measured
 * that it has to be re-asserted after `freshSession()` and after every reload.
 * The re-assertion lives in the helper rather than in the cases for the reason
 * D1.385's mechanism gives for the permission mode: a default a case has to opt
 * INTO is a default the case that forgot does not have.
 *
 * It NEVER throws. A rig whose Chromium does not answer these two methods would
 * otherwise lose every case at attach, and the reason is not swallowed — it is
 * returned and stored in {@link CdpSession.lastFocus} as `failed`, where a case
 * can report it. Returns `undefined` when this attachment opted out
 * (`ConnectOptions.focus: false`), which is the one state that is not a reading.
 */
export async function reassertWindowFocus(session: CdpSession): Promise<WindowFocusState | undefined> {
  if (!session.focusEmulation) return undefined
  const state = await focusWindow(session).catch((cause: unknown) => ({
    hasFocus: false,
    visibilityState: 'unknown',
    failed: cause instanceof Error ? (cause.message.split('\n')[0] ?? cause.message) : String(cause),
  }))
  session.lastFocus = state
  return state
}

export async function attach(options: ConnectOptions = {}): Promise<CdpSession> {
  return CdpSession.attach(options)
}
