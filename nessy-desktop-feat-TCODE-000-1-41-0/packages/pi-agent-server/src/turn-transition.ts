/**
 * F1.1288 (origin lane PI-1, 2026-10-02) — the abort/prompt serialization point
 * of the Pi subprocess reader.
 *
 * The reader dispatches every inbound message without awaiting (`rl.on('line',
 * …)` → `processMessage(msg).catch(…)`), which is what makes a Stop followed by
 * an immediate send race: `handlePrompt` fired `session.prompt(...)` on a
 * session the concurrently-running `handleAbort` had not yet made idle, and the
 * abort's `waitForIdle` (pi-coding-agent 0.85+) could take the new turn with it
 * while the host believed the send was accepted.
 *
 * The serialization is ONE direction, deliberately:
 *
 * - **The prompt side joins an abort** ({@link TurnTransitionGate.waitForAbort}):
 *   a prompt that arrives while a Stop is still aborting waits for the abort to
 *   finish before it starts its own turn. The wait swallows the abort's
 *   outcome — a failed abort must not fail the send.
 * - **An abort never waits for a prompt** — there is no API for that direction.
 *   `handlePrompt` awaits the whole turn (minutes), so a symmetric gate would
 *   queue every Stop behind a multi-minute run and break Stop outright.
 * - **Stops coalesce** ({@link TurnTransitionGate.runAbort}): a second `abort`
 *   joins the one in flight instead of racing it through `abortCompaction` and
 *   `agent.abort()` (idempotent per F1.591, but concurrent calls were never the
 *   intent). A coalesced Stop runs nothing and settles when the first does; a
 *   failed first abort resolves its joiners — the second Stop has nothing left
 *   to do and must not report a failure the user did not cause.
 *
 * Everything else the reader dispatches (tool responses, permission answers,
 * model changes) is untouched: they carried no measured race, and serializing
 * them behind a live abort would stall the very requests the abort is
 * answering.
 */
export class TurnTransitionGate {
  private active: Promise<void> | null = null

  /**
   * Run the abort body under the gate. The first caller's body runs; joiners
   * (a second Stop) await it and run nothing. The body's rejection propagates
   * to the first caller (its own catch reports it) and resolves — never
   * rejects — for the joiners.
   */
  runAbort(run: () => Promise<void>): Promise<void> {
    const inFlight = this.active
    if (inFlight) return inFlight.catch(() => {})
    const run0 = run()
    this.active = run0
    // The `finally` chain re-rejects when the body failed — its own `.catch`
    // keeps that SECOND copy from surfacing as an unhandled rejection (the
    // first copy belongs to the caller, which may legitimately await it).
    void run0.finally(() => { if (this.active === run0) this.active = null }).catch(() => {})
    return run0
  }

  /**
   * The prompt side: resolve once no abort is in flight (joining one that is).
   * Never rejects.
   */
  async waitForAbort(): Promise<void> {
    await this.active?.catch(() => {})
  }
}
