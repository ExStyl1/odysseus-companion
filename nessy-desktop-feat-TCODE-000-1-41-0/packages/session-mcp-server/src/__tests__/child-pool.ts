/**
 * The ONE child pool the session-mcp-server harness suites share (P6.908).
 *
 * `external-standalone.test.ts`, `host-callback-bridge.test.ts` and
 * `codex-reply-fidelity.test.ts` each carried their own byte-identical copy of
 * this — `PooledChild`, `CHILDREN`, `startChild`, `childFor`, `runMcpSession`,
 * about 130 lines apiece — differing only in the `result` shape they typed and
 * in the doc comment above them. The triplication pre-dates P6.901 (three
 * copies of the spawn harness, which P6.893 had to edit three times) and P6.901
 * made each copy longer. Generic in the result type is the whole difference the
 * three had, so it is the whole difference this module carries.
 *
 * **It ships nothing.** `package.json`'s build script is
 * `bun build src/index.ts --outdir=dist --target=node --format=cjs` — one entry
 * point — so a module under `src/__tests__/` is unreachable from it and no byte
 * of this file enters `dist/`. And it is `child-pool.ts`, not `*.test.ts`, so
 * `bun test` never collects it as a suite of its own.
 *
 * NO behaviour is defined here that the three copies did not already have: the
 * same argv keying, the same readiness and work windows, the same eviction of a
 * failed boot, the same caller-id remap.
 *
 * ## The concurrent warm-up stays out, and this is now a MEASUREMENT rather
 * ## than a promise (P6.909, W9-bq, 2026-09-10)
 *
 * `07d105be7` started the pool's seven boots together instead of lazily and was
 * reverted in `5c47a2bf9` after one child missed `READY_TIMEOUT_MS` at
 * 240 610 ms. That revert left this docblock owing a number: *"it needs a
 * measured N-way boot floor first"*. Here it is, taken on a QUIET tree — no
 * other lane running, `git status` empty — with a probe that spawns children
 * exactly as `startChild` does, in PAIRED ALTERNATING arms, because AGENTS.md's
 * own rule says a single before/after pair on this suite measures the page
 * cache:
 *
 *   | arm             | wall       | slowest child |
 *   | --------------- | ---------: | ------------: |
 *   | serial 7        | 134 722 ms |     20 153 ms |
 *   | concurrent 7    | 126 131 ms |    126 128 ms |
 *   | serial 7        | 134 681 ms |     19 640 ms |
 *   | concurrent 7    | 127 622 ms |    127 617 ms |
 *
 * Three earlier concurrent-7 rounds, each paired with a serial-1 control, agree:
 * 118 321 / 118 320 / 122 574 ms slowest child against 18 121 / 18 129 /
 * 20 147 ms for a single boot. 0 boot failures in 45 children.
 *
 * **The seven boots do not overlap.** Seven at once cost each child 6.3–6.5x
 * what one costs alone, and the whole phase finishes 5.2–6.4 % sooner — not the
 * 11–18 % the reverted attempt reported, and nowhere near the 7x the
 * "it is all I/O wait, so they overlap" premise predicts. Whatever the seven
 * contend for, they take turns at it.
 *
 * That is the whole trade, and it is a bad one: **6 % of the boot phase, paid
 * for with a 6.4x larger per-child readiness requirement.** The window is per
 * CHILD, and a quiet tree is not the condition this suite runs under — W9-ba
 * measured ONE boot at 70 689 ms under `bun test` at load 12.8, 3.5x the
 * 20.1 s measured here. Apply that factor to the concurrent arm and the slowest
 * child needs about 440 s against a 240 000 ms window, which is precisely the
 * 240 610 ms red. Re-landing would mean roughly doubling
 * {@link READY_TIMEOUT_MS} to buy 6 %, on the suite whose entire register
 * history is starvation.
 *
 * So the warm-up stays out on the measurement rather than on the accident, and
 * the window below stays where P6.893 put it — it holds a SERIAL boot, which is
 * the only boot this pool performs.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

/** The server every pooled child runs: this package's own entry point. */
const SERVER = resolve(import.meta.dir, '..', 'index.ts');

/** The last line `main()` prints; the only signal the dispatcher is connected. */
export const READY_LINE = 'Session MCP Server started';

/**
 * Against the measured 70.7 s floor (P6.893), with headroom — never zero.
 *
 * It is a PER-CHILD window on a SERIAL boot, which is what makes 240 000 enough:
 * one boot costs 18.1–20.2 s on a quiet tree and 70 689 ms under `bun test` at
 * load 12.8. Seven at once would need about 440 s — see the concurrency
 * measurement in this module's docblock before raising it for a warm-up.
 */
export const READY_TIMEOUT_MS = 240_000;

/** The window one exchange has to answer every id it asked for. */
export const WORK_TIMEOUT_MS = 60_000;

/**
 * One JSON-RPC reply. `TResult` is the only thing the three suites disagreed
 * about — a tools/list shape, an `McpCallToolResult`, a bridged content array —
 * so each suite still declares its own and this module never guesses.
 */
export interface PooledRpcResponse<TResult> {
  id?: number;
  result?: TResult;
}

export interface PooledChild<TResult> {
  send(request: object): void;
  responses: Map<number, PooledRpcResponse<TResult>>;
  kill(): void;
}

export interface ChildPool<TResult> {
  /** Run one exchange on the child that owns this argv, answered by CALLER id. */
  runMcpSession(args: string[], requests: object[]): Promise<Map<number, PooledRpcResponse<TResult>>>;
  /** Kill every pooled child and empty the pool; call it from `afterAll`. */
  killAll(): Promise<void>;
}

/** Spawn the real server and run the MCP handshake once. */
async function startChild<TResult>(args: string[]): Promise<PooledChild<TResult>> {
  const child = spawn(process.execPath, [SERVER, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const responses = new Map<number, PooledRpcResponse<TResult>>();
  // P6.893 — drained AND read. Drained because an undrained stderr pipe can
  // block the child; read because the readiness line below is the only thing
  // that says the dispatcher exists yet.
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
  let buffer = '';
  child.stdout.on('data', (d: Buffer) => {
    buffer += d.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as PooledRpcResponse<TResult>;
        if (typeof msg.id === 'number') responses.set(msg.id, msg);
      } catch {
        /* non-JSON line */
      }
    }
  });

  // Wait for the server's OWN readiness line instead of a fixed sleep. Measured
  // 2026-09-08 at load ~12: this child needs 28.3–46.6 s to reach that line in a
  // direct probe, and W9-ba measured 70 689 ms for it under `bun test` at load
  // 12.8 — a cold, I/O-bound module graph at ~1 % cpu, not contention. A 300 ms
  // handshake writes into a process that has not built its dispatcher yet, and
  // the failure then reads as a hang caused by whatever was just changed. The
  // window is set against that measured floor, never against zero.
  const ready = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < ready && !stderr.includes(READY_LINE)) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!stderr.includes(READY_LINE)) {
    child.kill('SIGKILL');
    // Loud and named: the empty-map-plus-confusing-assertion shape P6.893 was
    // born from is what a silent return produces.
    throw new Error(`session-mcp-server never printed its readiness line within ${READY_TIMEOUT_MS} ms; stderr was: ${stderr}`);
  }

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }) + '\n');
  await new Promise((r) => setTimeout(r, 300));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  return {
    send: (request: object) => { child.stdin.write(JSON.stringify(request) + '\n'); },
    responses,
    kill: () => { child.kill('SIGKILL'); },
  };
}

/**
 * ONE child per distinct argv for the WHOLE FILE, instead of one per case
 * (P6.901). Each suite builds its own pool, so the child map and the wire-id
 * sequence are file-scoped exactly as they were when each file owned a copy.
 *
 * What a suite gives up by sharing a child, and what it keeps, is a per-file
 * trade — each suite states its own in the docblock above its cases.
 */
export function createChildPool<TResult>(): ChildPool<TResult> {
  const children = new Map<string, Promise<PooledChild<TResult>>>();
  /** Wire ids are file-wide; see the remap in `runMcpSession`. */
  let nextWireId = 1000;

  function childFor(args: string[]): Promise<PooledChild<TResult>> {
    const key = args.join(' ');
    const existing = children.get(key);
    if (existing) return existing;
    const started = startChild<TResult>(args);
    children.set(key, started);
    // A boot that FAILED must not stay in the pool: the next case would await
    // the same rejection and report another case's failure as its own.
    started.catch(() => { children.delete(key); });
    return started;
  }

  return {
    async runMcpSession(args, requests) {
      const child = await childFor(args);
      // The ids are REWRITTEN onto a file-wide sequence and mapped back. Every
      // case numbers its requests from 2, and on a shared connection those would
      // collide with an earlier case's replies — a case could read a stale
      // answer and PASS.
      const wireByCaller = new Map<number, number>();
      for (const request of requests) {
        const callerId = (request as { id?: number }).id;
        if (typeof callerId !== 'number') {
          child.send(request);
          continue;
        }
        const wireId = ++nextWireId;
        wireByCaller.set(callerId, wireId);
        child.send({ ...request, id: wireId });
      }

      const wanted = [...wireByCaller.values()];
      const deadline = Date.now() + WORK_TIMEOUT_MS;
      while (Date.now() < deadline && !wanted.every((id) => child.responses.has(id))) {
        await new Promise((r) => setTimeout(r, 100));
      }

      const byCallerId = new Map<number, PooledRpcResponse<TResult>>();
      for (const [callerId, wireId] of wireByCaller) {
        const response = child.responses.get(wireId);
        if (response) byCallerId.set(callerId, { ...response, id: callerId });
      }
      return byCallerId;
    },

    async killAll() {
      for (const started of children.values()) await started.then((c) => c.kill(), () => {});
      children.clear();
    },
  };
}
