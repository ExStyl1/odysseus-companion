import log from 'electron-log/main'
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'

/**
 * Resolve debug mode deterministically across runtimes.
 *
 * Priority:
 * 1) --debug flag always enables debug mode
 * 2) NESSY_IS_PACKAGED env (when explicitly set)
 * 3) Electron runtime heuristic (defaultApp => dev, otherwise packaged)
 * 4) Non-Electron runtimes default to debug mode (headless Bun / node --check)
 */
function resolveDebugMode(): boolean {
  if (process.argv.includes('--debug')) return true

  const packagedEnv = process.env.NESSY_IS_PACKAGED
  if (packagedEnv === 'true') return false
  if (packagedEnv === 'false') return true

  const isElectronRuntime = typeof process.versions?.electron === 'string'
  if (isElectronRuntime) {
    if (process.defaultApp) return true
    return false
  }

  return true
}

export const isDebugMode = resolveDebugMode()

// Configure transports based on debug mode
if (isDebugMode) {
  // JSON format for file (agent-parseable)
  // Note: format expects (params: FormatParams) => any[], where params.message has the LogMessage fields
  log.transports.file.format = ({ message }) => [
    JSON.stringify({
      timestamp: message.date.toISOString(),
      level: message.level,
      scope: message.scope,
      message: message.data,
    }),
  ]

  log.transports.file.maxSize = 5 * 1024 * 1024 // 5MB

  // Console output in debug mode with readable format
  // Note: format must return an array - electron-log's transformStyles calls .reduce() on it
  log.transports.console.format = ({ message }) => {
    const scope = message.scope ? `[${message.scope}]` : ''
    const level = message.level.toUpperCase().padEnd(5)
    const data = message.data
      .map((d: unknown) => (typeof d === 'object' ? JSON.stringify(d) : String(d)))
      .join(' ')
    return [`${message.date.toISOString()} ${level} ${scope} ${data}`]
  }
  log.transports.console.level = 'debug'
} else {
  // Disable file and console transports in production.
  //
  // DA1.65 — THIS IS THE LINE THAT SILENTLY DROPS A DIAGNOSTIC, and the posture
  // is deliberate and stays. A packaged build is always outside debug mode
  // (`--debug` is eaten by Node before the app sees it), so from here on every
  // `platform.logger` call in the Electron host writes nothing — including the
  // handlers under `packages/server-core/src/handlers/**`, whose
  // `deps.platform.logger` is this same electron-log when they run inside the
  // desktop. The headless host is unaffected; `platform-headless.ts` supplies a
  // console logger that always writes.
  //
  // It has cost two rows: DA2.6 and DA1.58 each added a line an operator was
  // meant to read, to this sink. Nothing could notice — the call compiles, and
  // in `bun test` and `electron:dev` the line APPEARS, because `isDebugMode` is
  // true in both. The sink that survives is `createLogger`
  // (`@nessy-agent/shared/utils`): stderr under `NESSY_DEBUG=1`, mirrored into
  // electron-log here, which is why `[ws-rpc-server]`, `[dp-auth]` and
  // `[ConfigWatcher]` are the names an operator does see.
  //
  // `scripts/check-dropped-log-sink.ts` is the ratchet that makes the NEXT one a
  // decision: it counts the population that lands in this sink and fails on a
  // RISE, with the question in its own failure message. It does not ask any
  // existing call to move — no scanner can read "credential-lifecycle" off a
  // call site, and a gate that guesses is one people stop running.
  log.transports.file.level = false
  log.transports.console.level = false
}

// Export scoped loggers for different modules
export const mainLog = log.scope('main')
export const sessionLog = log.scope('session')
export const handlerLog = log.scope('handler')
export const windowLog = log.scope('window')
export const agentLog = log.scope('agent')
export const searchLog = log.scope('search')

function normalizeLogValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]'
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: value.message,
    }
    const code = (value as { code?: unknown }).code
    if (code !== undefined) out.code = code
    const cause = (value as { cause?: unknown }).cause
    if (cause !== undefined) out.cause = normalizeLogValue(cause, depth + 1)
    if (value.stack) out.stack = value.stack
    return out
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeLogValue(item, depth + 1))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      out[key] = normalizeLogValue(inner, depth + 1)
    }
    return out
  }
  return value
}

/**
 * Dedicated auto-update log.
 *
 * In packaged builds the Electron file/console transports are disabled (see
 * above), so every `[auto-update]` / `[update-flow]` diagnostic is dropped —
 * leaving update-install failures undiagnosable in the field (see #891). This
 * dedicated, always-on rotating log records the update lifecycle at a stable
 * path regardless of debug mode.
 */
export const autoUpdateLogPath = join(CONFIG_DIR, 'logs', 'auto-update.log')
const autoUpdateBackupPath = `${autoUpdateLogPath}.1`
const AUTO_UPDATE_LOG_MAX_BYTES = 2 * 1024 * 1024 // 2MB

function rotateAutoUpdateLogIfNeeded(nextLineBytes: number): void {
  if (!existsSync(autoUpdateLogPath)) return
  try {
    const currentSize = statSync(autoUpdateLogPath).size
    if (currentSize + nextLineBytes <= AUTO_UPDATE_LOG_MAX_BYTES) return
    if (existsSync(autoUpdateBackupPath)) {
      rmSync(autoUpdateBackupPath, { force: true })
    }
    renameSync(autoUpdateLogPath, autoUpdateBackupPath)
  } catch (error) {
    mainLog.warn('[auto-update] failed to rotate dedicated log file', normalizeLogValue(error))
  }
}

function writeAutoUpdateLog(level: 'info' | 'warn' | 'error', message: string, meta?: unknown): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    scope: 'auto-update',
    ...(meta !== undefined ? { meta: normalizeLogValue(meta) } : {}),
    message,
  }

  const line = JSON.stringify(entry) + '\n'
  try {
    mkdirSync(dirname(autoUpdateLogPath), { recursive: true })
    rotateAutoUpdateLogIfNeeded(Buffer.byteLength(line))
    appendFileSync(autoUpdateLogPath, line, 'utf8')
  } catch (error) {
    mainLog.warn('[auto-update] failed to write dedicated log entry', normalizeLogValue(error))
  }

  // Mirror to the Electron logger too (a no-op in production where transports
  // are disabled, but keeps --debug console/file output intact).
  if (level === 'error') {
    mainLog.error('[auto-update]', message, entry)
  } else if (level === 'warn') {
    mainLog.warn('[auto-update]', message, entry)
  } else if (isDebugMode) {
    mainLog.info('[auto-update]', message, entry)
  }
}

/** Always-on structured logger for the auto-update lifecycle (see #891). */
export const autoUpdateLog = {
  info: (message: string, meta?: unknown) => writeAutoUpdateLog('info', message, meta),
  warn: (message: string, meta?: unknown) => writeAutoUpdateLog('warn', message, meta),
  error: (message: string, meta?: unknown) => writeAutoUpdateLog('error', message, meta),
}

export function getAutoUpdateLogFilePath(): string {
  return autoUpdateLogPath
}

/**
 * Get the path to the current Electron main log file.
 * Returns undefined if file logging is disabled.
 */
export function getLogFilePath(): string | undefined {
  if (!isDebugMode) return undefined
  return log.transports.file.getFile()?.path
}

export default log
