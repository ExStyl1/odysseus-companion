import { LLM_QUERY_TIMEOUT_MS } from '../../shared/src/agent/llm-tool.ts';

/**
 * VENDORED for F1.239 (2026-09-23) from craft-agents-oss 0.13.4
 * (`packages/pi-agent-server/src/ephemeral-query-lifecycle.ts` at b2d6c8aab, read
 * under `.references/craft-agents-oss`). License: Apache-2.0 (that repository's
 * LICENSE). The coordinator below is upstream's code, unchanged; ours are this
 * header and `EPHEMERAL_QUERY_DEADLINE_MS` at the end, whose value is upstream's
 * decision too (`CRAFT_PI_EPHEMERAL_QUERY_DEADLINE_MS` in their
 * `session-settings.ts`: "one 115-second execution deadline inside the host's
 * 120-second RPC timeout").
 *
 * Request-scoped lifecycle for ephemeral Pi sessions (`call_llm`, title generation,
 * and response summarization).
 *
 * The main chat session is deliberately not registered here: cancelling one
 * utility query must never interrupt the user's in-flight conversation.
 */

export interface EphemeralQueryResource {
  abort(): void | Promise<void>;
  dispose(): void;
}

export interface EphemeralQueryContext {
  readonly signal: AbortSignal;
  throwIfCancelled(): void;
  setResource(resource: EphemeralQueryResource): void;
  clearResource(resource: EphemeralQueryResource): void;
}

interface ActiveEphemeralQuery {
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  resource?: EphemeralQueryResource;
  rejectCancellation(error: Error): void;
}

export class EphemeralQueryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`queryLlm timed out after ${timeoutMs / 1000}s`);
    this.name = 'EphemeralQueryTimeoutError';
  }
}

export class EphemeralQueryCancelledError extends Error {
  constructor(message = 'Ephemeral query cancelled') {
    super(message);
    this.name = 'EphemeralQueryCancelledError';
  }
}

function toCancellationError(reason: unknown): Error {
  return reason instanceof Error ? reason : new EphemeralQueryCancelledError();
}

/**
 * Owns deadlines and cancellation for concurrently-running ephemeral queries.
 * A query may register at most one active SDK session at a time; model fallback
 * replaces that resource between attempts while preserving the request deadline.
 */
export class EphemeralQueryCoordinator {
  private readonly active = new Map<string, ActiveEphemeralQuery>();

  get size(): number {
    return this.active.size;
  }

  has(id: string): boolean {
    return this.active.has(id);
  }

  async run<T>(
    id: string,
    timeoutMs: number,
    task: (context: EphemeralQueryContext) => Promise<T>,
  ): Promise<T> {
    if (this.active.has(id)) {
      throw new Error(`Ephemeral query already active: ${id}`);
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`Invalid ephemeral query timeout: ${timeoutMs}`);
    }

    const controller = new AbortController();
    let rejectCancellation!: (error: Error) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });

    const entry: ActiveEphemeralQuery = {
      controller,
      rejectCancellation,
    };
    this.active.set(id, entry);
    entry.timer = setTimeout(() => {
      this.cancel(id, new EphemeralQueryTimeoutError(timeoutMs));
    }, timeoutMs);

    const context: EphemeralQueryContext = {
      signal: controller.signal,
      throwIfCancelled: () => {
        if (controller.signal.aborted) {
          throw toCancellationError(controller.signal.reason);
        }
      },
      setResource: (resource) => {
        if (controller.signal.aborted) {
          this.cancelResource(resource);
          throw toCancellationError(controller.signal.reason);
        }
        entry.resource = resource;
      },
      clearResource: (resource) => {
        if (entry.resource === resource) {
          entry.resource = undefined;
        }
      },
    };

    try {
      return await Promise.race([
        Promise.resolve().then(() => task(context)),
        cancellation,
      ]);
    } finally {
      // Only remove our own registration. `cancel()` removes it eagerly so a
      // late task settlement cannot delete a newer request that reused the id.
      if (this.active.get(id) === entry) {
        this.active.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
      }
    }
  }

  cancel(id: string, reason: Error = new EphemeralQueryCancelledError()): boolean {
    const entry = this.active.get(id);
    if (!entry) return false;

    // Remove and clear first: cancellation callbacks can synchronously re-enter.
    this.active.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.controller.abort(reason);
    if (entry.resource) {
      this.cancelResource(entry.resource);
      entry.resource = undefined;
    }
    entry.rejectCancellation(reason);
    return true;
  }

  cancelAll(reason: Error = new EphemeralQueryCancelledError()): void {
    for (const id of [...this.active.keys()]) {
      this.cancel(id, reason);
    }
  }

  private cancelResource(resource: EphemeralQueryResource): void {
    try {
      const abortResult = resource.abort();
      if (abortResult && typeof abortResult.then === 'function') {
        void abortResult.catch(() => {});
      }
    } catch {
      // Cancellation is best effort; dispose still must run.
    }

    try {
      resource.dispose();
    } catch {
      // A cancellation must still reject even if SDK cleanup throws.
    }
  }
}

export function isEphemeralQueryCancellation(error: unknown): boolean {
  return error instanceof EphemeralQueryTimeoutError || error instanceof EphemeralQueryCancelledError;
}

/**
 * The subprocess's own deadline for one ephemeral query, INSIDE the host's
 * `LLM_QUERY_TIMEOUT_MS` so the subprocess answers (and aborts its session)
 * before the host gives up on the RPC. It covers `prompt()` whole — the SDK's
 * own retries included — which the `withTimeout` after `prompt()` in `queryLlm`
 * never did.
 */
export const EPHEMERAL_QUERY_DEADLINE_MS = LLM_QUERY_TIMEOUT_MS - 5_000;
