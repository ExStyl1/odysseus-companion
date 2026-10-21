/**
 * Headless PlatformServices — runs under Bun without Electron.
 *
 * Uses sharp for image processing, console for logging.
 * GUI-only methods (openPath, openExternal, quit, etc.) are left undefined —
 * handlers guard them with optional chaining and capabilities handle client-side ops.
 */

import { join } from 'path'
import type { PlatformServices, Logger } from './platform'
import { resolveInheritedAppEnv, sourceCheckoutRoot } from './inherited-app-env'

/**
 * Simple console-based logger matching the Logger interface.
 * Prefixes each line with ISO timestamp and level for structured grepping.
 *
 * ## D1.232 — EVERY level goes to stderr, and stdout is the handshake protocol
 *
 * `info` and `debug` used to go to stdout, and in this host stdout is not a log
 * stream: it is a PROTOCOL. `packages/server/src/index.ts` writes
 * `NESSY_SERVER_URL=` and `NESSY_SERVER_TOKEN=` there for the CLI's spawner to
 * parse, one of them a bearer token, and nothing else reads that stream —
 * `apps/cli`'s spawner took one line and discarded the rest until D1.211 taught
 * it to forward what it did not consume. So a `NESSY_HEALTH_PORT` deployment or
 * a supervisor running this package directly got every INFO line only if it
 * happened to capture stdout, and got it interleaved with the handshake.
 *
 * Moving a process's log stream is a posture the operator sees, so it is stated
 * rather than assumed: diagnostics are stderr, output is stdout, and after this
 * change the headless server's stdout carries the handshake lines and nothing
 * else. The spawner's stdout forwarder stays — it is what catches a stray
 * `console.log` from anywhere in the process — and the two are complementary.
 *
 * `debug` is here for the same reason and the row did not name it: in Node and
 * Bun `console.debug` is an ALIAS of `console.log`, so it was on stdout too.
 *
 * WHAT WAS NOT DONE, and why it is a refutation rather than a scope cut. D1.232
 * offers "the same `createLogger`-backed sink the rest of the tree uses" as its
 * first candidate. `createLogger` (`packages/shared/src/utils/debug.ts`) opens
 * every level with `if (!isDebugEnabled()) return`, so adopting it here would
 * silence this server's WARN and ERROR outside debug mode — a packaged build
 * that logs nothing is a trap this repo has already paid for.
 */
function createConsoleLogger(): Logger {
  const fmt = (level: string, args: unknown[]) => {
    const ts = new Date().toISOString()
    const parts = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
    return `${ts} ${level.toUpperCase().padEnd(5)} ${parts}`
  }
  // `console.warn` and `console.error` already write here; `info` and `debug`
  // are written explicitly so the destination is visible at the call site
  // rather than inherited from a console alias.
  const toStderr = (line: string) => { process.stderr.write(`${line}\n`) }
  return {
    info: (...args) => toStderr(fmt('info', args)),
    warn: (...args) => console.warn(fmt('warn', args)),
    error: (...args) => console.error(fmt('error', args)),
    debug: (...args) => {
      if (process.env.NESSY_DEBUG === 'true' || process.env.NESSY_IS_PACKAGED !== 'true') {
        toStderr(fmt('debug', args))
      }
    },
  }
}

/**
 * Create PlatformServices for headless (Bun) mode.
 *
 * Environment variables:
 * - NESSY_APP_ROOT — override appRootPath (default: cwd). Ignored, together with every NESSY_*
 *   path inside it, when this server runs from a source checkout and the value points into
 *   another one: that is a running Nessy app's root inherited through an agent shell
 *   (see inherited-app-env.ts, UB7.13).
 * - NESSY_RESOURCES_PATH — override resourcesPath (default: cwd/resources)
 * - NESSY_IS_PACKAGED — 'true' for production (default: false)
 * - NESSY_VERSION — app version string (default: '0.0.0-dev')
 * - NESSY_DEBUG — 'true' to enable debug logging
 */
export function createHeadlessPlatform(options?: { appVersion?: string }): PlatformServices {
  const logger = createConsoleLogger()
  const sourceRoot = sourceCheckoutRoot()
  const inherited = resolveInheritedAppEnv(process.env, sourceRoot, process.cwd())
  if (inherited.ignoredAppRoot) {
    for (const key of inherited.dropKeys) delete process.env[key]
    logger.warn(
      `Ignoring NESSY_APP_ROOT=${inherited.ignoredAppRoot}: it points outside this server's checkout (${sourceRoot}), ` +
      `most likely inherited from a running Nessy app. Dropped: ${inherited.dropKeys.join(', ')}. Using ${inherited.appRootPath}.`,
    )
  }
  // Republish so tools this server spawns (agent shells, scripts) resolve the same root.
  process.env.NESSY_APP_ROOT = inherited.appRootPath
  // A server running from source is never packaged, whatever an inherited env says (the packaged
  // app exports NESSY_IS_PACKAGED, which resolveScriptRuntime also reads from the env).
  if (sourceRoot && (process.env.NESSY_IS_PACKAGED === 'true' || process.env.NESSY_IS_PACKAGED === '1')) {
    logger.warn(`Ignoring NESSY_IS_PACKAGED=${process.env.NESSY_IS_PACKAGED}: this server runs from the source checkout ${sourceRoot}.`)
    process.env.NESSY_IS_PACKAGED = 'false'
  }
  const isPackaged = !sourceRoot && process.env.NESSY_IS_PACKAGED === 'true'
  const isDebugMode = process.env.NESSY_DEBUG === 'true' || !isPackaged

  return {
    appRootPath: inherited.appRootPath,
    resourcesPath: process.env.NESSY_RESOURCES_PATH || join(process.cwd(), 'resources'),
    isPackaged,
    appVersion: process.env.NESSY_VERSION || options?.appVersion || '0.0.0-dev',

    imageProcessor: {
      async getMetadata(buffer) {
        const sharp = (await import('sharp')).default
        const m = await sharp(buffer).metadata().catch(() => null)
        return (m?.width && m?.height) ? { width: m.width, height: m.height } : null
      },
      async process(input, opts = {}) {
        const sharp = (await import('sharp')).default
        let pipeline = sharp(input)
        if (opts.resize) {
          pipeline = pipeline.resize(opts.resize.width, opts.resize.height, {
            fit: opts.fit ?? 'inside',
          })
        }
        if (opts.format === 'jpeg') {
          pipeline = pipeline.jpeg({ quality: opts.quality ?? 90 })
        } else {
          pipeline = pipeline.png()
        }
        return pipeline.toBuffer()
      },
    },

    logger,
    isDebugMode,

    captureError: (err) => {
      logger.error('[captureError]', err.message, err.stack)
    },

    // GUI methods intentionally undefined — headless mode.
    // Handlers guard these with optional chaining (?.) or capability routing.
    // openPath, openExternal, showItemInFolder, quit, systemDarkMode → undefined
  }
}
