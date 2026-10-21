/**
 * The stdio transport the UNSUPERVISED MCP spawn sites use: identical to the
 * vendored SDK's `StdioClientTransport` in every respect except teardown, which
 * signals the whole PROCESS GROUP instead of the direct child.
 *
 * WHY THIS EXISTS AT ALL. Two spawn sites in this package start an MCP server
 * without the process supervisor — `client.ts`'s non-plugin stdio branch (every
 * native, project and user `.mcp.json` entry, and the builtin dp set) and
 * `validation.ts` symbol `validateStdioMcpConnection`, which probes a
 * user-entered server and whose own comment names `uv tool run`, `npx` and
 * `pipx`. A wrapper-shaped command is a shell or a package runner that forks the
 * real server, so a teardown that signals only the direct child leaves the
 * server itself running with the pipes open.
 *
 * NATIVE-FIRST, and the reading that decided the shape (vendored
 * `@modelcontextprotocol/sdk` 1.29.0, read 2026-09-14). Its transport offers
 * `env`, `cwd`, `stderr` and a public `pid` getter, and NOTHING for process
 * groups: the needle `detached` scores 0 occurrences over the whole `dist/esm`
 * tree (`grep -rao 'detached' … | wc -l`; positive control, `spawn` in
 * `client/stdio.js`, answers 6), and its `close()` ends stdin, then
 * `kill('SIGTERM')` and `kill('SIGKILL')` the direct child. On POSIX a group
 * kill is only available to a group LEADER, so the detach cannot be added from
 * the outside — hence this transport rather than a wrapper around that one.
 *
 * THE HOST ALREADY HAD THIS MECHANISM TWICE, and both are mirrored here rather
 * than re-invented: `packages/server-core/src/pi-harness/process-supervisor.ts`
 * symbol `signalTree` (negative-pid kill on POSIX, `taskkill /T` on Windows),
 * and `packages/shared/src/mcp/headers-helper.ts`, which spawns its helper
 * `detached` off win32 for exactly this reason. This module cannot import the
 * supervisor's copy — `packages/shared` must not depend on `server-core` — so
 * the five lines are restated, with the citation, rather than the dependency
 * inverted.
 *
 * WHAT IS DELIBERATELY NOT BUILT. nessy-cli sweeps the process TABLE for
 * descendants on teardown. That exists because their transports are not
 * detached; porting it here would be a second mechanism for a problem the
 * detach already solves. The named RESIDUE is a descendant that calls
 * `setsid()` (or on Windows is re-parented after the child exits) and so leaves
 * the group: it is not reached, and the OS reaps it as an orphan.
 *
 * THE TRADE THIS MAKES, stated because it is a real behaviour change. A
 * detached child no longer receives a signal sent to the HOST's process group,
 * so a terminal-level interrupt of the app no longer reaches it; teardown now
 * runs through `close()` instead. That is the same trade
 * `process-supervisor.ts` made for every bash child in `feba3c424`, and taking
 * it here makes the supervised and unsupervised paths agree.
 *
 * WINDOWS IS A DELEGATE, ON PURPOSE. `detached` on win32 opens a console, which
 * is why neither of the two mechanisms above sets it there, and the SDK spawns
 * through `cross-spawn` precisely to resolve `.cmd` shims and shebangs that
 * Node's own `spawn` cannot run without a shell — the `npx` population this
 * transport is for. So on win32 the SDK's transport does the spawning
 * unchanged and the tree kill is issued around it with `taskkill /T`; on POSIX
 * `cross-spawn` is a pass-through (`lib/parse.js` symbol `parseNonShell`
 * returns unchanged when not win32), so spawning here loses nothing.
 */

import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { execFileSync, spawn, type ChildProcess, type IOType } from 'node:child_process';
import { PassThrough, type Stream } from 'node:stream';

/** The SDK's `StdioServerParameters`, restated so the call sites type-check against one shape. */
export interface ManagedStdioServerParameters {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  stderr?: IOType | Stream | number;
}

/** Matches the SDK's own close ladder: end stdin, wait, escalate, wait, escalate. */
const CLOSE_STEP_MS = 2_000;

function runWindowsTaskkill(args: readonly string[]): void {
  execFileSync('taskkill.exe', [...args], { stdio: 'ignore', timeout: 5_000, windowsHide: true });
}

/**
 * SIGTERM/SIGKILL the child's whole process group, falling back to the child
 * alone. Restated from `process-supervisor.ts` symbol `signalTree`; an `ESRCH`
 * means the group is already gone, which is success, not a fallback trigger.
 */
function signalTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      runWindowsTaskkill(['/PID', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])]);
      return;
    } catch { /* already gone, or taskkill unavailable — fall through to the child */ }
  } else {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

/**
 * Wait for the child's own EXIT, or the step budget — whichever comes first.
 *
 * **`exit` and deliberately not `close`, which is the SDK's choice and is the
 * second half of this leak (measured 2026-09-14).** `close` fires when the
 * stdio PIPES are closed, and a forked descendant INHERITS stdout, so on the
 * shape where the wrapper exits and leaves the real server running, `close`
 * does not arrive until the descendant does — i.e. the teardown ladder spends
 * its entire grace waiting for the very process it exists to kill, and then
 * finds nothing left to signal. Measured on that shape: a wrapper whose
 * descendant writes a marker 1.2 s after teardown begins gets `close` at
 * ~1.2 s, AFTER the marker. `exit` arrives in ~15 ms and the group kill lands
 * before the descendant does anything. `headers-helper.ts` records the same
 * pipes-not-process property for the same reason.
 */
function waitForExit(child: ChildProcess, exited: Promise<void>): Promise<unknown> {
  return Promise.race([exited, new Promise(resolve => setTimeout(resolve, CLOSE_STEP_MS).unref())]);
}

/**
 * Windows arm: the SDK spawns (so `cross-spawn` still resolves `.cmd` shims),
 * and the tree kill is issued AROUND its close ladder. The graceful `/T` must
 * go FIRST — `taskkill` walks the tree by parent pid at the moment of the call,
 * so once the direct child has exited its descendants are no longer reachable
 * through it — and the forceful `/T /F` goes last, where it sweeps only a tree
 * whose leader survived the SDK's own ladder.
 *
 * **This arm is deliberately WEAKER than the POSIX one, and the residue is
 * named rather than hidden.** A Windows console process usually refuses the
 * graceful `/T` ("can only be terminated forcefully"), and the only way to
 * reach its descendants is to issue `/T /F` while the leader is still alive —
 * i.e. BEFORE the SDK ends stdin, which would strip every Windows MCP server of
 * the clean stdin-close shutdown it has today. Trading every server's graceful
 * exit for a leak nobody has measured on Windows is the wrong way round, so the
 * force stays after the ladder. Making it unconditional is an owner call, not a
 * lane's.
 */
class WindowsTreeKillStdioTransport extends StdioClientTransport {
  constructor(readonly params: ManagedStdioServerParameters) {
    super(params);
  }

  override async close(): Promise<void> {
    const pid = this.pid;
    if (pid !== null) {
      try { runWindowsTaskkill(['/PID', String(pid), '/T']); } catch { /* already gone */ }
    }
    await super.close();
    if (pid !== null) {
      try { runWindowsTaskkill(['/PID', String(pid), '/T', '/F']); } catch { /* already gone */ }
    }
  }
}

/** POSIX arm: our own detached spawn, so the child is a group leader. */
class DetachedStdioClientTransport implements Transport {
  private process?: ChildProcess;
  private readonly readBuffer = new ReadBuffer();
  private readonly stderrStream: PassThrough | null;
  /** Resolves on the child's own `exit`; see {@link waitForExit}. */
  private exited?: Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  constructor(readonly params: ManagedStdioServerParameters) {
    this.stderrStream = params.stderr === 'pipe' || params.stderr === 'overlapped' ? new PassThrough() : null;
  }

  async start(): Promise<void> {
    if (this.process) throw new Error('ManagedStdioClientTransport already started');
    return new Promise((resolve, reject) => {
      const child = spawn(this.params.command, this.params.args ?? [], {
        // The SDK merges its own small safe baseline UNDER the caller's env;
        // both call sites already pass a complete env, so this preserves their
        // behaviour exactly rather than narrowing it.
        env: { ...getDefaultEnvironment(), ...this.params.env },
        stdio: ['pipe', 'pipe', this.params.stderr ?? 'inherit'],
        shell: false,
        cwd: this.params.cwd,
        // Own process group, so teardown can signal the whole tree. Not on
        // win32, where it opens a console — that arm is the delegate above.
        detached: true,
      });
      this.process = child;
      this.exited = new Promise<void>(resolveExited => child.once('exit', () => resolveExited()));
      child.on('error', error => { reject(error); this.onerror?.(error); });
      child.on('spawn', () => resolve());
      child.on('close', () => { this.process = undefined; this.onclose?.(); });
      child.stdin?.on('error', error => this.onerror?.(error));
      child.stdout?.on('data', (chunk: Buffer) => {
        this.readBuffer.append(chunk);
        this.drainReadBuffer();
      });
      child.stdout?.on('error', error => this.onerror?.(error));
      if (this.stderrStream && child.stderr) child.stderr.pipe(this.stderrStream);
    });
  }

  /** The SDK exposes the PassThrough before `start()`, so early output is not lost. */
  get stderr(): Stream | null {
    return this.stderrStream ?? this.process?.stderr ?? null;
  }

  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  private drainReadBuffer(): void {
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.readBuffer.readMessage();
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  }

  async close(): Promise<void> {
    const child = this.process;
    if (child) {
      this.process = undefined;
      const exited = this.exited ?? Promise.resolve();
      try { child.stdin?.end(); } catch { /* already gone */ }
      await waitForExit(child, exited);
      // The group is signalled UNCONDITIONALLY, including when the wrapper has
      // already exited on stdin close: a process group outlives its leader
      // while any member is alive, so `npx`-style "fork the real server, then
      // exit" is reached here and is reached nowhere else. An empty group
      // answers ESRCH, which `signalTree` treats as success.
      signalTree(child, 'SIGTERM');
      // The SIGKILL escalation stays tied to the LEADER, exactly as the SDK has
      // it. RESIDUE, named rather than built around: a descendant that outlives
      // an already-exited wrapper AND ignores SIGTERM is left to the OS —
      // escalating on it would mean either a blind SIGKILL with no grace, or
      // holding every close() open for a second deadline that almost never
      // fires.
      if (child.exitCode === null && child.signalCode === null) {
        await waitForExit(child, exited);
        if (child.exitCode === null && child.signalCode === null) signalTree(child, 'SIGKILL');
      }
    }
    this.readBuffer.clear();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise(resolve => {
      const stdin = this.process?.stdin;
      if (!stdin) throw new Error('Not connected');
      if (stdin.write(serializeMessage(message))) resolve();
      else stdin.once('drain', resolve);
    });
  }
}

/**
 * The transport both unsupervised stdio spawn sites use. One name on both
 * platforms so a caller — and a test — never branches on `process.platform`.
 */
/**
 * What both arms expose. `stderr` and `pid` are the SDK's own two accessors —
 * the validator attaches its idle watchdog to the former before `start()`, and
 * the latter is what a group kill needs — so they are part of the contract
 * rather than an implementation detail of either arm.
 */
export type ManagedStdioTransport = Transport & {
  readonly params: ManagedStdioServerParameters;
  readonly stderr: Stream | null;
  readonly pid: number | null;
};

export function createManagedStdioTransport(params: ManagedStdioServerParameters): ManagedStdioTransport {
  return process.platform === 'win32'
    ? new WindowsTreeKillStdioTransport(params)
    : new DetachedStdioClientTransport(params);
}
