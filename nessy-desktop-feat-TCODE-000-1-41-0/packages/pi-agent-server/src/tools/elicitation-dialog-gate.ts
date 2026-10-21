/**
 * R24 / `mcp.md:261` — "A call waiting on an open elicitation dialog isn't
 * backgrounded while the dialog is open; the server is blocked on your input,
 * not slow, so Claude Code defers the move until the dialog closes."
 *
 * R10 shipped the auto-backgrounding race that this qualifies, and left the
 * `TODO(R24)` at the detach site naming exactly this gap. The dialog itself is
 * host-side (the MCP client's `elicitation/create` handler asks the user
 * through the permission channel) while the detach decision is subprocess-side,
 * so the host reports each dialog's open/close through the
 * `mcp_elicitation_state` message and this module holds the answer.
 *
 * Open state is keyed by dialog id rather than counted: a duplicate open or a
 * repeated close is then idempotent, and a subprocess restart cannot leave a
 * counter stuck above zero.
 */

export class ElicitationDialogGate {
  private readonly open = new Set<string>();
  private readonly waiters = new Set<() => void>();

  /** True while at least one elicitation dialog is on screen. */
  isOpen(): boolean {
    return this.open.size > 0;
  }

  /** Record a dialog opening or closing. */
  set(dialogId: string, open: boolean): void {
    if (open) {
      this.open.add(dialogId);
      return;
    }
    if (!this.open.delete(dialogId) || this.open.size > 0) return;
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiting) waiter();
  }

  /** Resolves once no dialog is open; already resolved when none is. */
  whenClosed(): Promise<void> {
    if (this.open.size === 0) return Promise.resolve();
    return new Promise<void>(resolve => { this.waiters.add(resolve); });
  }

  /** Drop all state — a new subprocess session starts with no dialog open. */
  reset(): void {
    this.open.clear();
    const waiting = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiting) waiter();
  }
}

export interface DetachTimer {
  /** Resolves when the call has been slow for `delayMs` with no dialog open. */
  readonly promise: Promise<{ kind: 'detach' }>;
  /** Stop the timer once the call settled on its own. */
  cancel(): void;
}

/**
 * The R10 detach clock, qualified by the gate.
 *
 * When the threshold elapses with a dialog open, the move is deferred and the
 * full delay is re-armed on close: the time a human spent in the dialog is not
 * evidence that the server is slow, so it must not count toward the threshold.
 */
export function detachAfter(
  delayMs: number,
  gate: Pick<ElicitationDialogGate, 'isOpen' | 'whenClosed'>,
): DetachTimer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  const promise = new Promise<{ kind: 'detach' }>(resolve => {
    const arm = (): void => {
      if (cancelled) return;
      timer = setTimeout(() => {
        if (cancelled) return;
        if (gate.isOpen()) {
          void gate.whenClosed().then(arm);
          return;
        }
        resolve({ kind: 'detach' });
      }, delayMs);
    };
    arm();
  });

  return {
    promise,
    cancel(): void {
      cancelled = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
