/**
 * Platform services — dependency injection seam.
 *
 * SessionManager and core handlers receive this instead of importing
 * directly from 'electron'. On Electron, the implementations wrap
 * app/shell/nativeImage. On headless Node, they use sharp/pino/etc.
 */

export interface Logger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug(...args: unknown[]): void
}

export interface ImageProcessor {
  /** Get image dimensions. Returns null if buffer is not a valid image. */
  getMetadata(buffer: Buffer): Promise<{ width: number; height: number } | null>

  /**
   * Process an image: resize and/or re-encode.
   * @param input - Buffer or file path
   * @param opts.resize - target dimensions (default: no resize)
   * @param opts.fit - 'inside' to maintain aspect ratio (default: 'inside')
   * @param opts.format - output format (default: 'png')
   * @param opts.quality - JPEG quality 0-100 (default: 90)
   */
  process(
    input: Buffer | string,
    opts?: {
      resize?: { width: number; height: number }
      fit?: 'inside' | 'cover' | 'fill'
      format?: 'png' | 'jpeg'
      quality?: number
    },
  ): Promise<Buffer>
}

export interface PlatformServices {
  // -- Path resolution --
  appRootPath: string
  resourcesPath: string
  isPackaged: boolean

  // -- App metadata --
  appVersion: string

  // -- Image processing (nativeImage on Electron, sharp on headless) --
  imageProcessor: ImageProcessor

  // -- OS integration (no-ops on headless) --
  openPath?(path: string): Promise<void>
  openExternal?(url: string): Promise<void>
  showItemInFolder?(path: string): void
  writeClipboardText?(text: string): void

  // -- App lifecycle (no-ops on headless) --
  quit?(): void
  systemDarkMode?(): boolean

  // -- Observability --
  logger: Logger
  isDebugMode: boolean
  getLogFilePath?(): string | undefined
  captureError?(error: Error): void
}

// ── Logger helpers ──────────────────────────────────────────────────────────

/**
 * Console-based Logger for use before platform initialization.
 *
 * D1.276 — `info` and `debug` write to STDERR, and that is not a style choice.
 * This is the default every module-scope logger in this package starts on
 * (`SessionManager`'s `sessionLog`, `services/search.ts`'s two, the
 * model-fetcher `handlerLog`), so everything logged before `setPlatform` runs
 * goes wherever these four functions point. In the headless host stdout is a
 * PROTOCOL — it carries `NESSY_SERVER_URL=` and `NESSY_SERVER_TOKEN=`, which a
 * parent process reads — and `console.debug` is an ALIAS of `console.log` in
 * Node and Bun, so the diagnostic half of this logger was landing in the middle
 * of it. D1.232 fixed exactly this for `platform-headless.ts`'s
 * `createConsoleLogger` and could not reach here, because this constant lives
 * one layer up and is shared by every host.
 *
 * Shared by every host is also why the answer is stderr rather than a
 * headless-only branch: in the Electron host both streams reach the same place,
 * so nothing is lost there, and a logger that picks its sink from an
 * environment variable would be a second rule for a fact that has one honest
 * answer — diagnostics are not the protocol.
 *
 * `warn` and `error` already write to stderr through `console`; they are left
 * spelled that way so the diff says which two moved.
 */
export const CONSOLE_LOGGER: Logger = {
  info: (...args: unknown[]) => writeDiagnosticLine(args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
  debug: (...args: unknown[]) => writeDiagnosticLine(args),
}

/**
 * D1.276 — one line on stderr, formatted the way `console.log` formats its
 * arguments: space-joined, objects serialised. Kept deliberately small — this
 * runs before any platform exists, so it may not depend on one.
 */
function writeDiagnosticLine(args: unknown[]): void {
  const line = args
    .map(arg => (typeof arg === 'string' ? arg : typeof arg === 'object' && arg !== null ? JSON.stringify(arg) : String(arg)))
    .join(' ')
  process.stderr.write(`${line}\n`)
}

/** Create a Logger that prefixes every message with [scope]. */
export function createScopedLogger(base: Logger, scope: string): Logger {
  return {
    info: (...args: unknown[]) => base.info(`[${scope}]`, ...args),
    warn: (...args: unknown[]) => base.warn(`[${scope}]`, ...args),
    error: (...args: unknown[]) => base.error(`[${scope}]`, ...args),
    debug: (...args: unknown[]) => base.debug(`[${scope}]`, ...args),
  }
}
