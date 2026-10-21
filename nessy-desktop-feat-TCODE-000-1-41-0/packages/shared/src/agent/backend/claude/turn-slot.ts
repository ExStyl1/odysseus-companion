/**
 * L2 — THE PER-TURN SLOT.
 *
 * Under a live Claude session there is ONE `query()` per agent and one reader
 * over it that outlives every turn. `chatImpl` therefore cannot be the thing
 * that iterates the SDK stream any more; it opens a SLOT, writes its message
 * into the live input channel, and drains what the reader pushes.
 *
 * Why a queue and not a shared generator: `SessionManager.sendMessage` returns
 * on the first `complete` and its `finally` calls `chatIterator.return?.()`
 * (`live-stream-consumer-baseline.test.ts` pins that). Under the old shape that
 * `.return()` unwound the SDK stream — the hang-up L1's Finding 1 named. Under
 * this one it closes a QUEUE, and the reader, the query and the child process
 * are all untouched. That is the whole reason `SessionManager` needs no change:
 * the frozen `AgentInstance.chat()` contract keeps its meaning, and Pi, Codex
 * and Nestor never learn that Claude's stream changed shape.
 *
 * THE SLOT IS `chatImpl`-SCOPED, NOT `chat()`-SCOPED. Measured in L1: one
 * `chat()` carrying a model-emitted `[skill:…]` produces TWO `chatImpl`
 * entries — each writing its own message and earning its own SDK `result` —
 * while exactly ONE `complete` leaves `chat()`. A `chat()`-scoped slot would
 * settle the caller at pass 1 and leave pass 2's events with nowhere to go. The
 * passes are strictly sequential, so "one open slot per agent" still holds; the
 * unit it counts is a BACKEND turn.
 *
 * Everything that used to be a LOCAL of `chatImpl`'s read loop lives here, on
 * the slot, for the same reason those locals existed: the reader is shared and
 * an instance field would be clobbered by a nested turn. `postCompactionContextTokens`
 * is the sharpest example — R14 made it a local on purpose, and under this shape
 * "local to the turn" spells "field of the slot".
 */
import type { AgentEvent } from '@nessy-agent/core/types';
import { SourceActivationDrainController } from '../../source-activation-drain.ts';

/** Why a slot stopped taking events. */
export type ClaudeTurnStop =
  /** A terminal SDK result reached the slot; the turn ended normally. */
  | 'terminal'
  /**
   * A source was activated mid-turn. The renderer's auto-retry contract wants
   * `source_activated` to be the LAST event of the turn — no `complete` — so
   * `chatImpl` returns without emitting one, exactly as the pre-L2 `return`
   * inside the read loop did.
   */
  | 'source-activated'
  /** The reader ended (session death, transport error) with the slot open. */
  | 'session-ended';

/**
 * A one-writer / one-reader event queue for a single backend turn.
 *
 * `push` never blocks: the reader must not be back-pressured by a consumer that
 * has hung up, because a stalled reader stalls the whole SESSION, not one turn.
 */
export class ClaudeTurnSlot {
  // -------------------------------------------------------------------------
  // Per-turn state the reader needs. All of it was a `chatImpl` local before.
  // -------------------------------------------------------------------------

  /** The user's message for this turn — the source-activation retry resends it. */
  readonly userMessage: string;
  /** `ChatOptions.isRetry`: recovery must not recurse forever. */
  readonly isRetry: boolean;
  /** This turn asked the SDK to resume or fork an existing session. */
  readonly wasResuming: boolean;
  /** This turn passed `resumeSessionAt`, so a missing-UUID failure is recoverable. */
  readonly attemptedBranchCutoff: boolean;
  /** Where tool metadata and guarded oversized results are written. */
  readonly metadataSessionDir: string;

  /** A terminal SDK result was seen (so the defensive `complete` is not needed). */
  receivedComplete = false;
  /** Any assistant content at all arrived — the empty-resume detector. */
  receivedAssistantContent = false;
  /** A "No conversation found with session ID" error was swallowed for recovery. */
  suppressedSessionExpiredError = false;
  /** A "No message found with message.uuid" error was swallowed for the cutoff fallback. */
  suppressedBranchCutoffError = false;
  /**
   * R14 — the SDK's own post-compaction context size, when THIS turn compacted.
   * A field of the slot and never of the agent: the compaction drain nests a
   * whole `chatImpl` inside this one, and an agent field would be reset by the
   * nested turn out from under the outer one.
   */
  postCompactionContextTokens: number | null = null;
  /**
   * Source-activation auto-restart drain (#790). Captures the pending restart on
   * the first triggering `tool_result` and drains sibling results from the same
   * parallel-tool batch before firing — otherwise the session journal ends up
   * with orphan `tool_use` ids that block subsequent sends. Per-turn, like
   * everything else here.
   */
  readonly sourceActivationDrain = new SourceActivationDrainController('batch-boundary');

  // -------------------------------------------------------------------------
  // Queue plumbing.
  // -------------------------------------------------------------------------

  private readonly pending: AgentEvent[] = [];
  private notify: (() => void) | null = null;
  private stop: ClaudeTurnStop | null = null;
  private failure: unknown = null;
  private drained = false;

  constructor(init: {
    userMessage: string;
    isRetry: boolean;
    wasResuming: boolean;
    attemptedBranchCutoff: boolean;
    metadataSessionDir: string;
  }) {
    this.userMessage = init.userMessage;
    this.isRetry = init.isRetry;
    this.wasResuming = init.wasResuming;
    this.attemptedBranchCutoff = init.attemptedBranchCutoff;
    this.metadataSessionDir = init.metadataSessionDir;
  }

  /** How the turn ended, or `null` while it is still open. */
  get stopReason(): ClaudeTurnStop | null {
    return this.stop;
  }

  /** True once a terminal event or a failure has landed — no more writes are accepted. */
  get settled(): boolean {
    return this.stop !== null || this.failure !== null;
  }

  /**
   * Run `listener` once the turn settles, or immediately if it already has.
   *
   * Exists for backstops that must not outlive the turn they guard — the
   * interrupt deadline is the first. A caller could poll `settled` instead, but
   * a timer that has to be cancelled is the case this is for, and polling it
   * would be a second source of truth for when a turn ended.
   */
  onSettled(listener: () => void): void {
    if (this.settled) { listener(); return; }
    this.settleListeners.push(listener);
  }

  private settleListeners: Array<() => void> = [];

  private notifySettled(): void {
    const listeners = this.settleListeners;
    this.settleListeners = [];
    for (const listener of listeners) listener();
  }

  /** Queue one event for the turn's consumer. Ignored after settlement. */
  push(event: AgentEvent): void {
    if (this.settled) return;
    this.pending.push(event);
    this.wake();
  }

  /** Queue the turn's last event and close the slot in one step. */
  close(stop: ClaudeTurnStop, finalEvent?: AgentEvent): void {
    if (this.settled) return;
    if (finalEvent) this.pending.push(finalEvent);
    this.stop = stop;
    this.wake();
    this.notifySettled();
  }

  /**
   * Settle the turn with an error. The consumer's `for await` re-throws it, so
   * every recovery arm `chatImpl` already had — resume retry, branch fallback,
   * auth/billing classification, AbortError — keeps its exact shape.
   */
  fail(error: unknown): void {
    if (this.settled) return;
    this.failure = error;
    this.wake();
    this.notifySettled();
  }

  /**
   * Read the turn's events. Exactly one consumer, once.
   *
   * Returning early (`break`, or `SessionManager` hanging up through
   * `.return()`) abandons the queue and nothing else: the reader keeps reading
   * the session.
   */
  async *drain(): AsyncGenerator<AgentEvent> {
    if (this.drained) throw new Error('ClaudeTurnSlot.drain() is single-use');
    this.drained = true;
    for (;;) {
      while (this.pending.length > 0) {
        yield this.pending.shift()!;
      }
      if (this.failure !== null) throw this.failure;
      if (this.stop !== null) return;
      await new Promise<void>(resolve => {
        this.notify = resolve;
      });
      this.notify = null;
    }
  }

  private wake(): void {
    const notify = this.notify;
    this.notify = null;
    notify?.();
  }
}
