/**
 * Server spawner — start a headless Nessy Desktop server as a child process.
 *
 * Spawns `bun run <serverEntry>`, reads stdout for the `NESSY_SERVER_URL=`
 * and `NESSY_SERVER_TOKEN=` lines, and returns a handle to stop the server.
 */

import { resolve, join } from 'node:path'
import type { Subprocess } from 'bun'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpawnedServer {
  url: string
  token: string
  stop: () => Promise<void>
}

export interface SpawnServerOptions {
  /** Path to the server entry file. Auto-detected from monorepo root if omitted. */
  serverEntry?: string
  /** Extra env vars to pass to the server process. */
  env?: Record<string, string>
  /** How long to wait for the server to print its URL (ms). Default: 30000. */
  startupTimeout?: number
  /** Suppress server stderr output (useful for validation where only test output matters). */
  quiet?: boolean
}

// ---------------------------------------------------------------------------
// Auto-detect server entry
// ---------------------------------------------------------------------------

function findServerEntry(): string {
  // Walk up from this file's directory to find the monorepo root.
  // Expected layout: apps/cli/src/server-spawner.ts → root/packages/server/src/index.ts
  let dir = import.meta.dir
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'packages', 'server', 'src', 'index.ts')
    if (Bun.file(candidate).size > 0) return candidate
    dir = resolve(dir, '..')
  }
  throw new Error(
    'Could not auto-detect server entry. ' +
    'Pass --server-entry or ensure the monorepo layout includes packages/server/src/index.ts',
  )
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

/**
 * The two lines the spawned server prints for this parent alone.
 *
 * `NESSY_SERVER_TOKEN=` carries the session's BEARER TOKEN; `NESSY_SERVER_URL=`
 * is the readiness signal and is consumed here. Both are handshake, neither is
 * output.
 */
export function isServerHandshakeLine(line: string): boolean {
  return line.startsWith('NESSY_SERVER_URL=') || line.startsWith('NESSY_SERVER_TOKEN=')
}

/**
 * D1.211 — may this line of the server's stdout be shown to the operator?
 *
 * Pure and exported so the credential control is tested directly rather than
 * through a live child: a control asserted only end to end is a control nobody
 * can watch fail.
 *
 * Before this change the whole stream was thrown away after the URL line, so
 * "forward the rest" is a new exposure and the filter is what bounds it. The
 * handshake prefix is not enough on its own — it answers `false` for
 * `NESSY_SERVER_TOKENS=…` and for any line that merely CONTAINS the token —
 * so the token's own value is matched as a substring as well. That is
 * deliberately stricter than the emission we know about: the spawner mints the
 * token itself, so it can afford to refuse any line carrying it, whatever put
 * it there.
 */
export function shouldForwardServerStdoutLine(line: string, token: string): boolean {
  if (line.length === 0) return false
  if (isServerHandshakeLine(line)) return false
  if (token.length > 0 && line.includes(token)) return false
  return true
}

export async function spawnServer(opts?: SpawnServerOptions): Promise<SpawnedServer> {
  const serverEntry = opts?.serverEntry ?? findServerEntry()
  const startupTimeout = opts?.startupTimeout ?? 30_000
  const token = crypto.randomUUID()

  // Strip CLAUDECODE to avoid the Claude Agent SDK's nesting guard rejecting
  // subprocess launches when the CLI is invoked from within a Claude Code session.
  const { CLAUDECODE: _, ...parentEnv } = process.env
  const proc: Subprocess = Bun.spawn(['bun', 'run', serverEntry], {
    env: {
      ...parentEnv,
      ...opts?.env,
      NESSY_SERVER_TOKEN: token,
      NESSY_RPC_PORT: '0',
      NESSY_RPC_HOST: '127.0.0.1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  // Pipe server stderr to our stderr so --debug logs are visible (unless quiet)
  if (proc.stderr && !opts?.quiet) {
    ;(async () => {
      // @ts-expect-error — Bun Subprocess types don't narrow stderr to ReadableStream when stderr: 'pipe'
      const reader = proc.stderr.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          process.stderr.write(value)
        }
      } catch {
        // Server exited — normal
      }
    })()
  }

  // Read stdout line by line looking for NESSY_SERVER_URL=
  return new Promise<SpawnedServer>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`Server did not start within ${startupTimeout}ms`))
    }, startupTimeout)

    let url = ''
    let settled = false
    let buffer = ''

    const processLines = () => {
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // keep incomplete last line in buffer
      for (const line of lines) {
        // D1.211 — the handshake lines are consumed here and never echoed. One
        // of them IS the bearer token, so the filter below is a credential
        // control and not a tidy: everything else on this stream is forwarded.
        if (isServerHandshakeLine(line)) {
          if (line.startsWith('NESSY_SERVER_URL=')) {
            url = line.slice('NESSY_SERVER_URL='.length).trim()
            // Once we have the URL, the server is ready. The reader keeps
            // running past this point so later lines still reach the operator.
            if (url && !settled) {
              settled = true
              clearTimeout(timer)
              resolve({
                url,
                token,
                stop: async () => {
                  proc.kill('SIGTERM')
                  await proc.exited
                },
              })
            }
          }
          continue
        }
        forwardServerStdout(line)
      }
    }

    /**
     * D1.211 — the server's own INFO log reaches the operator, or it reaches
     * nobody.
     *
     * The headless server's `platform.logger` is
     * `{ info: console.log, warn: console.warn, error: console.error }`, and
     * `sessionLog` is scoped onto it — so `warn` and `error` go to stderr,
     * which this spawner already forwards, while EVERY `info` goes to stdout,
     * which this loop read for one line and then threw away. `Shutting down…`,
     * `Cleaning up resources…` and every `sessionLog.info` were invisible to
     * anyone driving the CLI.
     *
     * Measured 2026-09-17 while diagnosing D1.211: over three real runs the
     * CLI's stderr carried `WARN` and `ERROR` lines and **zero** `INFO` lines —
     * including the control run where the session drain provably ran (its
     * supervised record ends `status: "stopped", signal: "SIGTERM"`). So the
     * absence of an info line proved nothing, and the diagnosis had to be taken
     * from the process store instead.
     *
     * To stderr rather than stdout, for the reason the stderr forwarder already
     * gives: this CLI's stdout is the run's OUTPUT, and `--output-format
     * stream-json` has a consumer parsing it.
     */
    function forwardServerStdout(line: string): void {
      if (opts?.quiet) return
      if (!shouldForwardServerStdoutLine(line, token)) return
      process.stderr.write(`${line}\n`)
    }

    ;(async () => {
      // @ts-expect-error — Bun Subprocess types don't narrow stdout to ReadableStream when stdout: 'pipe'
      const reader = proc.stdout.getReader()
      const decoder = new TextDecoder()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          processLines()
        }
      } catch {
        // Stream closed
      }
      // If we get here without resolving, the process exited before printing the URL
      clearTimeout(timer)
      if (!url) {
        reject(new Error('Server process exited before printing NESSY_SERVER_URL'))
      }
    })()
  })
}
