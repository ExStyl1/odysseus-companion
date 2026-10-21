/**
 * `headersHelper` — dynamic MCP connection headers from a shell command.
 *
 * `mcp.md:768`: "use `headersHelper` to generate request headers at connection
 * time. Claude Code runs the command and merges its output into the connection
 * headers." The mechanics this module implements are `mcp.md:795-799`:
 *
 * - "The command must write a JSON object of string key-value pairs to stdout"
 * - "The command runs in a shell with a 10-second timeout, from the session's
 *   current working directory" (plugin-provided helpers run from the plugin
 *   root instead, `mcp.md:816` — the caller sets `spec.cwd` accordingly)
 * - the helper env carries `CLAUDE_CODE_MCP_SERVER_NAME`,
 *   `CLAUDE_CODE_MCP_SERVER_URL` and, only for a plugin-provided server,
 *   `CLAUDE_PLUGIN_ROOT` (`mcp.md:805-813`)
 *
 * The spawn/timeout/kill shape is copied from `automations/hook-command.ts`
 * (`runHookCommand`) — SIGTERM at the deadline, SIGKILL 2 s later — rather than
 * invented a second time.
 *
 * ## Fail-soft contract
 *
 * This function REJECTS with a named {@link McpHeadersHelperError} on a spawn
 * error, non-zero exit, timeout, or malformed stdout (not JSON / not a flat
 * object / a non-string value). The CALLER (`McpClientPool.connect`) catches,
 * connects with the STATIC headers only, and logs the named reason — a broken
 * helper degrades the connection to static auth, it never sinks the server.
 * The doc page states what a successful helper does and does not settle the
 * first-connect failure case; connecting anyway matches this repo's `.mcp.json`
 * house style (an optional field never sinks a server).
 *
 * Helper stdout is a header set and may be a secret: it is NEVER logged and
 * never included in an error message. Errors carry exit codes and reasons only.
 */
import { spawn } from 'node:child_process';

export const MCP_HEADERS_HELPER_TIMEOUT_MS = 10_000;

/** Helper stdout past this size is malformed, not a header set. */
const MAX_HELPER_STDOUT_BYTES = 1_048_576;

export type McpHeadersHelperFailureReason =
  | 'spawn-error'
  | 'timeout'
  | 'non-zero-exit'
  | 'malformed-stdout';

export class McpHeadersHelperError extends Error {
  constructor(
    readonly reason: McpHeadersHelperFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'McpHeadersHelperError';
  }
}

export interface McpHeadersHelperExecutionSpec {
  /** The shell command, verbatim from the config. Never a secret (`mcp.md:818`). */
  command: string;
  /** Session cwd for `.mcp.json` servers; plugin root for plugin-provided ones. */
  cwd?: string;
  /** Set only when a plugin provides the server; becomes `CLAUDE_PLUGIN_ROOT`. */
  pluginRoot?: string;
  /**
   * P6.479 — extra environment for a caller whose `headersHelper` is NOT an MCP
   * server's.
   *
   * `plugins/host-marketplace.md#write-the-headershelper-command` gives a marketplace
   * `url` source's command `CLAUDE_CODE_MARKETPLACE_URL` and
   * `CLAUDE_CODE_MARKETPLACE_NAME` where `mcp.md` gives an MCP server's command
   * `CLAUDE_CODE_MCP_SERVER_NAME` and `_URL`. Everything else about the two —
   * the shell, the 10-second budget, the JSON-object stdout contract, the
   * process-group kill, the never-log-the-output rule — is one and the same
   * mechanism, so the second caller supplies its own two variables here instead
   * of growing a second copy of the runner.
   *
   * Applied AFTER the MCP names, so a caller that sets neither is unaffected.
   */
  extraEnv?: Readonly<Record<string, string>>;
}

/**
 * Run one `headersHelper` command and parse its stdout into a header record.
 *
 * `options.timeoutMs` is a TEST seam; production always uses the documented
 * 10 000 ms default (`mcp.md:797`).
 */
export function resolveMcpDynamicHeaders(
  spec: McpHeadersHelperExecutionSpec,
  context: { serverName: string; url: string },
  options: { timeoutMs?: number } = {},
): Promise<Record<string, string>> {
  const timeoutMs = options.timeoutMs ?? MCP_HEADERS_HELPER_TIMEOUT_MS;
  // `mcp.md:805-813`: exactly these variables, on top of the host process env
  // so `PATH` and the operator's own auth environment stay reachable.
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    CLAUDE_CODE_MCP_SERVER_NAME: context.serverName,
    CLAUDE_CODE_MCP_SERVER_URL: context.url,
    ...(spec.pluginRoot ? { CLAUDE_PLUGIN_ROOT: spec.pluginRoot } : {}),
    ...(spec.extraEnv ?? {}),
  };

  return new Promise((resolve, reject) => {
    let stdout = '';
    let oversized = false;
    let settled = false;
    let timedOut = false;

    const finish = (error: McpHeadersHelperError | undefined, headers?: Record<string, string>) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(headers!);
    };

    const child = spawn(spec.command, {
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
      // Own process group (POSIX), so the deadline can signal the whole tree.
      // A helper that backgrounds work leaves children the shell does not reap,
      // and signalling the shell alone leaves them running with the stdout pipe
      // open. `process-supervisor.ts:253` takes the same posture for the same
      // reason.
      ...(process.platform !== 'win32' ? { detached: true } : {}),
    });

    /** SIGTERM/SIGKILL the whole group, falling back to the child alone. */
    const signalTree = (signal: 'SIGTERM' | 'SIGKILL') => {
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
        }
      }
      try { child.kill(signal); } catch { /* already gone */ }
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      signalTree('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) signalTree('SIGKILL');
      }, 2_000).unref();
      // Settle AT the deadline rather than waiting for `close`. `close` waits for
      // the stdio pipes, not the process, so any descendant still holding stdout
      // withholds it — and the SIGKILL escalation above is inert exactly then,
      // because the shell itself has already exited. The caller degrades to
      // static headers on this rejection, so waiting for a pipe that may never
      // close hangs the CONNECTION, which is what the deadline exists to
      // prevent. The `close` branch below stays a no-op: `finish` is idempotent.
      finish(new McpHeadersHelperError('timeout', `headersHelper timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // Deliberately NOT unref'd. Every settlement path clears it, so it cannot
    // outlive the call, and an unref'd timer is only guaranteed to fire while
    // something else keeps the loop alive — which is not a property this
    // deadline may depend on, since a hung helper produces no other work.

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (oversized) return;
      stdout += String(chunk);
      if (Buffer.byteLength(stdout) > MAX_HELPER_STDOUT_BYTES) oversized = true;
    });
    // stderr is drained and dropped: helper diagnostics may quote the very
    // values the stdout contract exists to keep out of logs.
    child.stderr?.on('data', () => {});

    child.once('error', error => {
      clearTimeout(timeout);
      finish(new McpHeadersHelperError(
        'spawn-error',
        `headersHelper failed to start: ${error instanceof Error ? error.message : String(error)}`,
      ));
    });

    child.once('close', exitCode => {
      clearTimeout(timeout);
      if (timedOut) {
        finish(new McpHeadersHelperError('timeout', `headersHelper timed out after ${timeoutMs}ms`));
        return;
      }
      if (exitCode !== 0) {
        finish(new McpHeadersHelperError('non-zero-exit', `headersHelper exited with code ${exitCode}`));
        return;
      }
      if (oversized) {
        finish(new McpHeadersHelperError('malformed-stdout', `headersHelper stdout exceeded ${MAX_HELPER_STDOUT_BYTES} bytes`));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        finish(new McpHeadersHelperError('malformed-stdout', 'headersHelper stdout is not JSON'));
        return;
      }
      // `mcp.md:795`: "a JSON object of string key-value pairs" — FLAT and
      // all-string, nothing else. A nested object or a number is a config bug
      // to name, not a value to coerce.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        finish(new McpHeadersHelperError('malformed-stdout', 'headersHelper stdout is not a JSON object'));
        return;
      }
      const entries = Object.entries(parsed as Record<string, unknown>);
      if (entries.some(([, value]) => typeof value !== 'string')) {
        finish(new McpHeadersHelperError('malformed-stdout', 'headersHelper stdout must be a flat object of string values'));
        return;
      }
      finish(undefined, Object.fromEntries(entries) as Record<string, string>);
    });
  });
}
