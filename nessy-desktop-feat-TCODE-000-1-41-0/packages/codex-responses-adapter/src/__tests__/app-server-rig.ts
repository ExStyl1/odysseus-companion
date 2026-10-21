/**
 * `AppServer` — the one JSON-RPC-over-stdio client the codex live-boot suites
 * drive the SHIPPED `codex-app-server` with. D1.225.
 *
 * ## Why this module exists
 *
 * Five suites had a private copy of this class — 52, 52, 62, 66 and 74 lines —
 * and exactly TWO of the five were byte-identical (measured 2026-09-17 by
 * hashing each class body: `config-writer-hooks-live` and
 * `config-writer-plugin-egress-live` share one md5; `sandbox-enforcement`,
 * `unresolvable-model-id-live` and `codex-hook-exit-contract-live` had each
 * drifted). A copy that has drifted three ways is worse than a copy: the suites
 * stop being comparable, and a fix to the wire handling reaches whichever copy
 * its author happened to open. Each suite still builds its own binary path,
 * spawns its own child and writes its own config — only the wire client is
 * shared, because that is the part every one of them agreed on.
 *
 * ## What the three divergences were, and how each is kept
 *
 *  1. **A request timeout of 120 s** (`sandbox-enforcement`, in the class
 *     DEFAULT rather than at the call site — its `initialize` relies on it).
 *     Kept as `requestTimeoutMs` on the constructor, defaulting to the 60 s the
 *     other four use, so no suite's budget moves.
 *  2. **Two shapes of "wait for a notification".** `sandbox-enforcement` and
 *     `unresolvable-model-id-live` had `waitForTurn(ms)` over a promise resolved
 *     by `turn/completed`/`turn/failed`; `codex-hook-exit-contract-live` had the
 *     general `waitFor(predicate, ms)` over a wake latch. The general one
 *     subsumes the special one, so `waitFor` is the primitive and `waitForTurn`
 *     is two lines on top of it. Both keep the original non-throwing contract:
 *     a timeout RETURNS, it does not reject, because every caller reads the
 *     notification list afterwards and a throw would hide what did arrive.
 *  3. **`params` typed `unknown` versus `Record<string, unknown>`.**
 *     `codex-hook-exit-contract-live` normalised `msg.params ?? {}` because it
 *     indexes the payload (`params.run as HookRun`), which `unknown` cannot do.
 *     The normalised shape is the superset and is what is kept; the four suites
 *     that cast their payloads keep casting.
 *
 * `serverRequests` is the one field only `sandbox-enforcement` declared, and it
 * was written and never read until D1.236 (2026-09-17). It is kept, rather than
 * deleted, because the refusal it records is load-bearing for every member — an
 * ACCEPTED escalation can rerun a command outside the sandbox, which would make
 * a leak look like a hole — and it now HAS its reader: `sandbox-enforcement`'s
 * `agentTurnLeaksSecret` returns the list and both real-agent-turn cases assert
 * it is EMPTY, which is what "the escalations it refused are the ones it
 * expected" means on an arm whose deny is compiled into the OS wrap and so
 * cannot be escalated to.
 *
 * This module is NOT a member of the live-boot family: it spawns nothing and
 * builds no staged path, so `scripts/codex-live-suites.ts`'s classifier does not
 * see it. Membership stays with the suites that actually boot the binary.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

/** One `method`/`params` notification, with `params` normalised to an object. */
export interface AppServerNotification {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface AppServerOptions {
  /**
   * Default deadline for `request()` when the call site names none. 60 s suits
   * every suite except `sandbox-enforcement`, whose `initialize` waits on a
   * seatbelt profile being compiled and asks for 120 s.
   */
  readonly requestTimeoutMs?: number;
}

export class AppServer {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /**
   * Every server→client request this rig REFUSED, in arrival order. See the
   * header: the refusal is what keeps a reading about the sandbox honest.
   */
  readonly serverRequests: string[] = [];
  readonly notifications: AppServerNotification[] = [];
  private readonly requestTimeoutMs: number;
  private wake: (() => void) | null = null;

  constructor(private readonly child: ChildProcessWithoutNullStreams, options: AppServerOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    createInterface({ input: child.stdout }).on('line', l => this.onLine(l));
    child.stderr.resume();
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const id = msg.id;
    if (typeof id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(id);
      this.pending.delete(id);
      if (!p) return;
      if (msg.error !== undefined) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    // REFUSE every escalation. None is expected, and an ACCEPTED approval can
    // rerun the command outside the sandbox, which would make a leak look like
    // a sandbox hole (or a denial look like enforcement).
    if (typeof id === 'number' && typeof msg.method === 'string') {
      this.serverRequests.push(msg.method);
      this.child.stdin.write(`${JSON.stringify({ id, result: { decision: 'denied' } })}\n`);
      return;
    }
    if (typeof msg.method === 'string') {
      this.notifications.push({ method: msg.method, params: (msg.params ?? {}) as Record<string, unknown> });
      const wake = this.wake;
      this.wake = null;
      wake?.();
    }
  }

  request(method: string, params: unknown = {}, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  /**
   * Resolve as soon as a notification the predicate accepts has arrived —
   * including one that arrived BEFORE this call, because the scan starts at the
   * beginning of the list. Returns `false` on the deadline instead of throwing.
   */
  async waitFor(match: (n: AppServerNotification) => boolean, timeoutMs = 45_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let seen = 0;
    for (;;) {
      for (; seen < this.notifications.length; seen += 1) {
        if (match(this.notifications[seen]!)) return true;
      }
      if (Date.now() >= deadline) return false;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.wake = null; resolve(); }, 250);
        this.wake = () => { clearTimeout(timer); resolve(); };
      });
    }
  }

  /** `waitFor`, specialised to the end of a turn. Returns on the deadline. */
  async waitForTurn(timeoutMs: number): Promise<boolean> {
    return this.waitFor(n => n.method === 'turn/completed' || n.method === 'turn/failed', timeoutMs);
  }

  kill(): void { this.child.kill('SIGKILL'); }
}
