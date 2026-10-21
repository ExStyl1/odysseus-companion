/**
 * P2.304 — a floating-emission detector that ACTUALLY DETECTS.
 *
 * WHY THIS FILE IS A SUBPROCESS AND NOT A TEST.
 *
 * MEASURED on bun 1.3.14, with a positive control on the same rig:
 *
 *   | rig                     | `process.on('unhandledRejection')` fires? |
 *   | ----------------------- | ----------------------------------------- |
 *   | `bun run` (production)  | YES                                       |
 *   | `bun test`              | NO — the runner intercepts below `process` |
 *
 * `process.listenerCount('unhandledRejection')` is 0 inside `bun test` before
 * anything registers, so the runner is not merely installing a listener of its
 * own that runs first: it intercepts at a lower layer, and a user listener is
 * never consulted. Therefore `expect(escaped).toEqual([])` — the assertion the
 * whole floating-emission family was tracked with — CANNOT FAIL. It is a dead
 * assertion, and the family grew 5 -> 7 -> 8 -> 14 under it, every increment
 * found by a person reading rather than by that test.
 *
 * The runner is not a usable substitute detector either. Also measured:
 *
 *   - an escape that lands WHILE the test body is still awaiting aborts that
 *     test and reports it as a failure (so it is caught, but by the runner and
 *     not by the assertion, and the message names neither the site nor the fix);
 *   - an escape that lands AFTER the test body returns is COMPLETELY SILENT —
 *     `2 pass, 0 fail`, exit 0. Whether the class is detected therefore depends
 *     on whether `settle()` happens to outlast the emission.
 *
 * So the detector runs the scenario in a PLAIN bun process, which is also the
 * surface production actually has (Electron main, the headless server), and
 * reports what escaped there. Each scenario has a `rebroken` twin that restores
 * the pre-fix shape in place, so every assertion is a DELTA against a control
 * that must fail — the property the old detector never had.
 *
 * Invoked as: bun <this file> <scenario> <sink>
 *   scenario — see SCENARIOS below
 *   sink     — `record` (onDebug collects; asserts the LABEL half of the
 *              family standard) or `throw` (onDebug throws; asserts the ESCAPE
 *              half, the case that has no observable channel by construction)
 *
 * Prints exactly one line: __PROBE__{"escapes":[...],"debug":[...]}
 */
import type { BackendConfig } from '../../backend/types.ts';
import { AbortReason } from '../../backend/types.ts';
import { ClaudeAgent } from '../../claude-agent.ts';
import { CodexAgent } from '../../codex-agent.ts';
import { NestorCloudAgent } from '../../nestor-cloud-agent.ts';
import { PiAgent } from '../../pi-agent.ts';
import { TestAgent, createMockBackendConfig } from '../test-utils.ts';

const escapes: string[] = [];
process.on('unhandledRejection', (reason: unknown) => {
  escapes.push(reason instanceof Error ? reason.message : String(reason));
});

const debug: string[] = [];

/**
 * P2.333 needs a channel `escapes` cannot carry. The teardown defect is a
 * SYNCHRONOUS throw out of `destroy()`, not an unhandled rejection — the mirror
 * image of the rest of this file (there the error escaped into nothing, here it
 * escapes into the caller). A scenario that expects one records it here.
 */
const thrown: string[] = [];

/** Let detached emissions settle without sleeping on a clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * An automation system whose dispatch always throws. The dispatcher CATCHES
 * that and routes it to `emitAutomationEvent`'s `onError`, which calls
 * `this.debug` — so with a throwing sink the rejection is re-created inside the
 * handler, which is the reachable path to a rejecting `emitAutomationEvent`.
 */
function brokenAutomationSystem(): { executeAgentEvent: () => Promise<never> } {
  return {
    async executeAgentEvent(): Promise<never> {
      throw new Error('automation system is gone');
    },
  };
}

/**
 * `throw-automation` throws ONLY on the automation-event lines, and records the
 * rest. Necessary rather than fastidious: a sink that throws on EVERY message
 * makes `BaseAgent.destroy()` throw SYNCHRONOUSLY from `usageTracker.reset()`
 * long before it reaches the detached call, so the site under test is never
 * exercised (measured — see the report's separate finding on that path). A sink
 * that fails on some inputs and not others is also the realistic shape.
 */
function wire(agent: { onDebug?: (m: string) => void; setAutomationSystem: (s: unknown) => void }, sink: string): void {
  agent.onDebug = (message: string) => {
    if (sink === 'throw') throw new Error('log sink exploded');
    if (sink === 'throw-automation' && /Automation event|could not be delivered/.test(message)) {
      throw new Error('log sink exploded');
    }
    // P2.333: a host sink that fails on the UsageTracker's lines and nothing
    // else. `UsageTracker.debug` ends in `config.onDebug` — the same HOST
    // callback — and `BaseAgent.destroy()` calls `usageTracker.reset()`, so this
    // is the narrowest input that reproduces the measured teardown throw without
    // also breaking every other line the scenario needs to read back.
    if (sink === 'throw-usage' && message.startsWith('[UsageTracker]')) {
      throw new Error('log sink exploded');
    }
    debug.push(message);
  };
  agent.setAutomationSystem(brokenAutomationSystem());
}

/** A session that has STARTED — the precondition `SessionEnd` emission needs. */
function markSessionStarted(agent: { restoreLifecycleState(s: unknown): void }): void {
  agent.restoreLifecycleState({
    sessionStartEmitted: true,
    sessionEndEmitted: false,
    sessionStartHooksApplied: true,
  });
}

function codexConfig(): BackendConfig {
  return {
    ...createMockBackendConfig(),
    provider: 'codex-runtime',
    model: 'codex/test-model',
    isHeadless: true,
  } as BackendConfig;
}

/** The pre-fix shape, restored in place: a bare `void`, no rejection handler. */
function rebreakDetachedEmit(agent: object): void {
  (agent as { emitDetachedAutomationEvent: unknown }).emitDetachedAutomationEvent =
    function (this: { emitAutomationEvent(e: unknown, i: unknown): Promise<unknown> }, event: unknown, input: unknown): void {
      void this.emitAutomationEvent(event, input);
    };
}

/**
 * Replace `emitAutomationEvent` with a stub that REJECTS.
 *
 * Why the six site scenarios need this on top of the throwing-sink ones: how
 * reachable a rejection is today differs per backend, and that is a property of
 * the emitter, not of the call site. `PiAgent` in particular overrides `debug`
 * with a try/catch (P2.66's broken-sink floor, `pi-agent.ts:10155`), so a
 * throwing host sink CANNOT make its emission reject — measured, `pi:destroy`
 * reports zero escapes under `throw-automation` for that reason and not because
 * the site is guarded. This stub asks the question the row is actually about —
 * "if this promise rejects, does the rejection have somewhere to go?" — and it
 * is the same technique `detached-automation-event.test.ts` already uses.
 */
function rejectEmissions(agent: object): void {
  (agent as { emitAutomationEvent: unknown }).emitAutomationEvent =
    async (): Promise<never> => { throw new Error('automation system is gone'); };
}

/**
 * Fire the ONE event that builds `_postCompactHookEmission` (P2.332).
 *
 * `succeeded` in `handleSubprocessEvent` is `!!event.result && event.aborted !== true
 * && !event.errorMessage`, so a truthy `result` and nothing else is what a
 * successful compaction looks like on this seam.
 */
function firePiCompactionEnd(agent: object): void {
  (agent as { handleSubprocessEvent(event: Record<string, unknown>): void })
    .handleSubprocessEvent({ type: 'compaction_end', result: { ok: true } });
}

/**
 * Call `destroy()` and record a SYNCHRONOUS throw rather than letting it abort
 * the scenario (P2.333). `destroy()` is total by contract now; the rebroken twin
 * is what proves the assertion can fail.
 */
function destroyRecordingThrow(agent: { destroy(): void }): void {
  try {
    agent.destroy();
  } catch (error) {
    thrown.push(error instanceof Error ? error.message : String(error));
  }
}

/**
 * P2.347's equivalent for the RESTART path. `disposeForRestart()` is `async`, so
 * a synchronous throw in its body surfaces as a REJECTION of the returned
 * promise rather than as a synchronous throw — a different channel, the same
 * harm, and `escapes` cannot carry it either because the caller awaits.
 */
/**
 * Await a promise and record its rejection rather than letting it abort the
 * scenario (P2.335). The site under test is an `await` in a `finally`, so the
 * harm is a rejection reaching the CALLER, which neither `escapes` (nothing is
 * unhandled — the await handles it) nor a debug line can carry.
 */
async function awaitRecordingThrow(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    thrown.push(error instanceof Error ? error.message : String(error));
  }
}

async function disposeRecordingThrow(agent: { disposeForRestart(): Promise<void> }): Promise<void> {
  try {
    await agent.disposeForRestart();
  } catch (error) {
    thrown.push(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Reduce `runTeardownStep` to a bare call — the pre-fix shape, restored in
 * place. Every `:rebroken` twin below uses it, and each one must still fail.
 */
function rebreakTeardownStep(agent: object): void {
  (agent as { runTeardownStep: unknown }).runTeardownStep =
    (_what: string, step: () => void): void => { step(); };
}

/**
 * A marker the scenario can read back to prove a LATER step still ran.
 *
 * The measured harm of P2.333/P2.347 is not the visible throw — it is that every
 * step after the throwing one is skipped. An assertion on the throw alone would
 * pass on a fix that swallowed the error and still skipped the cleanup, so each
 * teardown scenario replaces one late step with a marker and checks for it.
 */
function markLateStep(agent: object, method: string, marker: string): void {
  (agent as Record<string, unknown>)[method] = function (this: { debug(m: string): void }): void {
    this.debug(marker);
  };
}

const SCENARIOS: Record<string, () => Promise<void>> = {
  // ---- P2.192's own site, re-verified rather than trusted -----------------
  async 'base:instructionsLoaded'() {
    const agent = new TestAgent(createMockBackendConfig());
    wire(agent as never, sink);
    (agent as unknown as { emitInstructionsLoaded(f: unknown[]): void }).emitInstructionsLoaded([
      { file_path: '/w/CLAUDE.md', memory_type: 'Project', load_reason: 'startup' },
      { file_path: '/w/.claude/CLAUDE.md', memory_type: 'Local', load_reason: 'startup' },
    ]);
    await settle();
  },
  async 'base:instructionsLoaded:rebroken'() {
    const agent = new TestAgent(createMockBackendConfig());
    wire(agent as never, sink);
    rebreakDetachedEmit(agent);
    (agent as unknown as { emitInstructionsLoaded(f: unknown[]): void }).emitInstructionsLoaded([
      { file_path: '/w/CLAUDE.md', memory_type: 'Project', load_reason: 'startup' },
    ]);
    await settle();
  },

  // ---- P2.303's six survivors --------------------------------------------
  async 'codex:forceAbort'() {
    const agent = new CodexAgent(codexConfig());
    wire(agent as never, sink);
    agent.forceAbort(AbortReason.UserStop);
    await settle();
  },
  async 'codex:destroy'() {
    const agent = new CodexAgent(codexConfig());
    wire(agent as never, sink);
    markSessionStarted(agent as never);
    agent.destroy();
    await settle();
  },
  async 'nestor:abort'() {
    const agent = new NestorCloudAgent(createMockBackendConfig());
    wire(agent as never, sink);
    await agent.abort('test');
    await settle();
  },
  async 'nestor:forceAbort'() {
    const agent = new NestorCloudAgent(createMockBackendConfig());
    wire(agent as never, sink);
    agent.forceAbort(AbortReason.UserStop);
    await settle();
  },
  async 'nestor:destroy'() {
    const agent = new NestorCloudAgent(createMockBackendConfig());
    wire(agent as never, sink);
    markSessionStarted(agent as never);
    agent.destroy();
    await settle();
  },
  async 'pi:destroy'() {
    const agent = new PiAgent(createMockBackendConfig());
    wire(agent as never, sink);
    markSessionStarted(agent as never);
    agent.destroy();
    await settle();
  },

  // ---- the same six, with the emitter itself rejecting -------------------
  // Reachability-independent: asks only whether the rejection has anywhere to go.
  async 'codex:forceAbort:rejecting'() {
    const agent = new CodexAgent(codexConfig());
    wire(agent as never, sink);
    rejectEmissions(agent);
    agent.forceAbort(AbortReason.UserStop);
    await settle();
  },
  async 'codex:destroy:rejecting'() {
    const agent = new CodexAgent(codexConfig());
    wire(agent as never, sink);
    rejectEmissions(agent);
    markSessionStarted(agent as never);
    agent.destroy();
    await settle();
  },
  async 'nestor:abort:rejecting'() {
    const agent = new NestorCloudAgent(createMockBackendConfig());
    wire(agent as never, sink);
    rejectEmissions(agent);
    await agent.abort('test');
    await settle();
  },
  async 'nestor:forceAbort:rejecting'() {
    const agent = new NestorCloudAgent(createMockBackendConfig());
    wire(agent as never, sink);
    rejectEmissions(agent);
    agent.forceAbort(AbortReason.UserStop);
    await settle();
  },
  async 'nestor:destroy:rejecting'() {
    const agent = new NestorCloudAgent(createMockBackendConfig());
    wire(agent as never, sink);
    rejectEmissions(agent);
    markSessionStarted(agent as never);
    agent.destroy();
    await settle();
  },
  async 'pi:destroy:rejecting'() {
    const agent = new PiAgent(createMockBackendConfig());
    wire(agent as never, sink);
    rejectEmissions(agent);
    markSessionStarted(agent as never);
    agent.destroy();
    await settle();
  },

  // ---- P2.332: the FIFTEENTH site, driven through its real seam -----------
  //
  // `compaction_end` with a result is the only place `_postCompactHookEmission`
  // is ever built, and `handleSubprocessEvent` is the method the subprocess
  // itself calls, so this is the production path rather than a hand-built
  // promise. `markSessionStarted` supplies the `sessionStartHooksApplied`
  // precondition the seam gates on.
  async 'pi:postCompactEmission'() {
    const agent = new PiAgent(createMockBackendConfig());
    wire(agent as never, sink);
    rejectEmissions(agent);
    markSessionStarted(agent as never);
    firePiCompactionEnd(agent);
    await settle();
  },
  /**
   * The control that MUST still escape: the pre-fix line, restored in place.
   *
   * `previous.then(() => this.emitPostCompactSessionStart())` with no handler is
   * exactly what `handleSubprocessEvent` used to store, and nobody awaits it —
   * which is the whole defect, independent of the two sites that drop the handle.
   */
  async 'pi:postCompactEmission:rebroken'() {
    const agent = new PiAgent(createMockBackendConfig());
    wire(agent as never, sink);
    rejectEmissions(agent);
    markSessionStarted(agent as never);
    (agent as unknown as { _postCompactHookEmission: Promise<void> })._postCompactHookEmission =
      Promise.resolve().then(
        () => (agent as unknown as { emitPostCompactSessionStart(): Promise<void> }).emitPostCompactSessionStart(),
      );
    await settle();
  },
  /**
   * The row's own line numbers: a DROP of the handle, un-awaited and un-caught.
   *
   * `setWorkspace` is the workspace-change boundary (the sibling dropper is
   * `clearHistory`); both assign `undefined` over a promise that may already
   * have rejected. After the fix the stored promise cannot reject at all, so the
   * drop is safe by construction rather than by each dropper remembering.
   */
  async 'pi:postCompactDrop'() {
    const agent = new PiAgent(createMockBackendConfig());
    wire(agent as never, sink);
    rejectEmissions(agent);
    markSessionStarted(agent as never);
    firePiCompactionEnd(agent);
    (agent as unknown as { setWorkspace(w: unknown): void }).setWorkspace({
      ...createMockBackendConfig().workspace,
      id: 'probe-workspace-2',
    });
    await settle();
  },

  // ---- P2.334: the two survivors whose failure had no NAME ----------------
  //
  // Both had their escape closed already (`.catch(() => undefined)` /
  // `.catch(() => {})`), so the delta these measure is the LABEL, not the
  // escape. The assertion is still able to fail: a wrong or missing label fails
  // it, which is what the pre-fix code would have produced.
  async 'pi:taskTurnEnd'() {
    const agent = new PiAgent(createMockBackendConfig());
    wire(agent as never, sink);
    (agent as unknown as { config: { taskPort?: unknown } }).config.taskPort = {
      notifyTurnEnd: async (): Promise<never> => { throw new Error('task registry is gone'); },
    };
    (agent as unknown as { emitStopHookOnce(): void }).emitStopHookOnce();
    await settle();
  },
  /**
   * P2.335 — the ONE emission on the cloud agent that was neither detached with
   * a named handler nor inside `runTeardownStep`.
   *
   * `chatImpl`'s `finally` does `await this.emitStopHookOnce()`, on the ordinary
   * turn end. The recorder inside that promise was belted; the emission was not.
   * A rejection there propagates out of the `finally` and skips every step below
   * it — `toolExecutor.dispose()`, `processing = false`, the two null-outs — so
   * `processing` stays true and the session refuses every later turn. The promise
   * is MEMOISED, so the wedge is permanent rather than transient.
   */
  async 'nestor:stopHookAwaited:emitRejects'() {
    const agent = new NestorCloudAgent(createMockBackendConfig());
    wire(agent as never, sink);
    rejectEmissions(agent);
    await awaitRecordingThrow(
      (agent as unknown as { emitStopHookOnce(): Promise<void> }).emitStopHookOnce(),
    );
    await settle();
  },
  async 'nestor:stopHookAwaited:emitRejects:rebroken'() {
    const agent = new NestorCloudAgent(createMockBackendConfig());
    wire(agent as never, sink);
    rejectEmissions(agent);
    // The pre-fix shape, restored in place: the recorder wrapped, the emission
    // not. Without this control the arm above passes on a promise that never
    // rejects, which proves nothing.
    (agent as unknown as { emitStopHookOnce: unknown }).emitStopHookOnce =
      function (this: {
        emitAutomationEvent(e: unknown, i: unknown): Promise<unknown>
        recordHookBlockFeedback(e: string, r: unknown): void
      }): Promise<void> {
        return this.emitAutomationEvent('Stop', { hook_event_name: 'Stop' })
          .then(result => { this.recordHookBlockFeedback('Stop', result); });
      };
    await awaitRecordingThrow(
      (agent as unknown as { emitStopHookOnce(): Promise<void> }).emitStopHookOnce(),
    );
    await settle();
  },

  async 'nestor:cancelRejects'() {
    const agent = new NestorCloudAgent(createMockBackendConfig());
    wire(agent as never, sink);
    // The remote cancel is the ONLY teardown on this backend that reaches
    // outside the process: there is no server-side close-session RPC, so a
    // swallowed rejection here is a live remote task nobody hears about (F23).
    (agent as unknown as { currentTurn: unknown }).currentTurn = {
      cancel: async (): Promise<never> => { throw new Error('remote cancel refused'); },
    };
    markSessionStarted(agent as never);
    agent.destroy();
    await settle();
  },

  /**
   * THE SIXTEENTH SITE (found by reading, like every one before it).
   *
   * `parsePiError` fires a detached token refresh whose ONLY handler
   * raw-interpolates the thrown value: `this.debug(`… failed: ${err}`)`. The
   * interpolation is evaluated BEFORE `debug` is called, so `PiAgent`'s belted
   * `debug` override cannot help: `String(Object.create(null))` raises (P2.65),
   * the rejection handler itself throws, the promise it returned rejects, and
   * nobody holds it. A rejection handler that becomes an unhandled rejection is
   * the exact state this whole family exists to close.
   */
  async 'pi:tokenRefreshFault'() {
    const agent = new PiAgent({ ...createMockBackendConfig(), authType: 'oauth' } as never);
    wire(agent as never, sink);
    (agent as unknown as { refreshAndPushTokens: unknown }).refreshAndPushTokens =
      async (): Promise<never> => { throw Object.create(null) as never; };
    (agent as unknown as { parsePiError(e: Error): unknown })
      .parsePiError(new Error('401 unauthorized'));
    await settle();
  },

  /**
   * The control for the sixteenth site: the pre-fix HANDLER SHAPE, restored in
   * place around the same rejection value.
   *
   * The interpolation was inline inside `parsePiError`, so it cannot be
   * monkeypatched back the way `emitDetachedAutomationEvent` can. This rebuilds
   * the identical shape — a floated `.catch` whose body raw-interpolates the
   * thrown value — against the same agent's belted `debug`, and it must still
   * escape. Without it the assertion above could be vacuously green.
   */
  async 'pi:tokenRefreshFault:rebroken'() {
    const agent = new PiAgent({ ...createMockBackendConfig(), authType: 'oauth' } as never);
    wire(agent as never, sink);
    const rejected = Promise.reject(Object.create(null) as never);
    void rejected.catch((err: unknown) => {
      (agent as unknown as { debug(m: string): void }).debug(`Token refresh from parsePiError failed: ${err}`);
    });
    await settle();
  },

  // ---- P2.333: teardown totality (a SYNCHRONOUS escape, not a rejection) ---
  //
  // FOUR OF FOUR, not "Codex and Nestor". The row said Pi was immune and named
  // no Claude. Measured: only `PiAgent` belts `debug` (it holds the tree's only
  // `override debug`), so Claude, Codex and Nestor all reach
  // `usageTracker.reset()` through an unbelted host sink; and Pi is immune to
  // THAT path for a reason the row does not state — it never chains
  // `super.destroy()`, so the base cleanup is not on its path at all, which
  // leaves its own four steps with no safety net underneath them.
  //
  // The two Claude scenarios target the sharper harm on that backend: its
  // `super.destroy()` is the LAST statement, so a prologue throw skipped ALL of
  // the base cleanup.
  async 'claude:destroy:prologueThrows'() {
    const agent = new ClaudeAgent(createMockBackendConfig());
    wire(agent as never, sink);
    (agent as unknown as { closeLocalAdapter: unknown }).closeLocalAdapter =
      (): never => { throw new Error('adapter close exploded'); };
    destroyRecordingThrow(agent);
    await settle();
  },
  async 'claude:destroy:prologueThrows:rebroken'() {
    const agent = new ClaudeAgent(createMockBackendConfig());
    wire(agent as never, sink);
    (agent as unknown as { closeLocalAdapter: unknown }).closeLocalAdapter =
      (): never => { throw new Error('adapter close exploded'); };
    (agent as unknown as { runTeardownStep: unknown }).runTeardownStep =
      (_what: string, step: () => void): void => { step(); };
    destroyRecordingThrow(agent);
    await settle();
  },
  async 'pi:destroy:stepThrows'() {
    const agent = new PiAgent(createMockBackendConfig());
    wire(agent as never, sink);
    (agent as unknown as { killSubprocess: unknown }).killSubprocess =
      (): never => { throw new Error('subprocess kill exploded'); };
    destroyRecordingThrow(agent);
    await settle();
  },
  async 'pi:destroy:stepThrows:rebroken'() {
    const agent = new PiAgent(createMockBackendConfig());
    wire(agent as never, sink);
    (agent as unknown as { killSubprocess: unknown }).killSubprocess =
      (): never => { throw new Error('subprocess kill exploded'); };
    (agent as unknown as { runTeardownStep: unknown }).runTeardownStep =
      (_what: string, step: () => void): void => { step(); };
    destroyRecordingThrow(agent);
    await settle();
  },

  async 'base:destroy:usageSink'() {
    const agent = new TestAgent(createMockBackendConfig());
    wire(agent as never, sink);
    destroyRecordingThrow(agent);
    await settle();
  },
  /**
   * The control that MUST throw: BOTH pre-fix shapes restored in place.
   *
   *  - `UsageTracker.debug` unbelted, so a throwing host sink propagates out of
   *    `reset()` again;
   *  - `BaseAgent.runTeardownStep` reduced to a bare call, so the throw escapes
   *    `destroy()` instead of being isolated to its own step.
   *
   * Together those are the code as it stood before this row, and the measured
   * harm is BOTH halves: `destroy()` throws into its caller AND every step after
   * the failing one is skipped — the elicitation release and the private MCP
   * pool disconnect among them. The assertion therefore checks the final
   * `Base agent destroyed` line is ABSENT here and PRESENT above.
   */
  async 'base:destroy:usageSink:rebroken'() {
    const agent = new TestAgent(createMockBackendConfig());
    wire(agent as never, sink);
    // The pre-fix `UsageTracker.debug`, restored in place: an UNBELTED call
    // straight into the host `onDebug`. An arrow closing over `tracker` rather
    // than a `this`-bound function — there is nothing this re-break needs from
    // dynamic `this`, and an un-annotated `this` is a `noImplicitThis` error
    // (TS2683) rather than a fidelity gain.
    const tracker = (agent as unknown as { usageTracker: { config: { onDebug?: (m: string) => void } } }).usageTracker;
    (tracker as unknown as { debug: (m: string) => void }).debug = (message: string): void => {
      tracker.config.onDebug?.(`[UsageTracker] ${message}`);
    };
    (agent as unknown as { runTeardownStep: unknown }).runTeardownStep =
      (_what: string, step: () => void): void => { step(); };
    destroyRecordingThrow(agent);
    await settle();
  },

  // ---- P2.347: the RESTART path, which is the one SessionManager takes -----
  //
  // `SessionManager.disposeManagedAgentRuntime` reads
  // `if (agent.disposeForRestart) await agent.disposeForRestart() else agent.dispose()`,
  // so on Codex, Nestor and Pi the method P2.333 made total is precisely the one
  // that is NOT called. Only `ClaudeAgent`, which defines no `disposeForRestart`,
  // reaches `dispose()` -> `destroy()` on a restart.
  //
  // Each scenario replaces a LATE step with a marker, because the skipped
  // cleanup — not the visible throw — is the expensive half.
  async 'codex:disposeForRestart:stepThrows'() {
    const agent = new CodexAgent(codexConfig());
    wire(agent as never, sink);
    (agent as unknown as { stopConfigWatcher: unknown }).stopConfigWatcher =
      (): never => { throw new Error('config watcher close exploded'); };
    // The late step is the whole point on this backend: `teardownRuntime` is
    // what kills the app-server child, closes the adapter and the callback
    // bridge, and `rmSync`s the managed CODEX_HOME. A prologue throw skipped all
    // of it AND left `this.destroyed = true`, so `destroy()` — which opens with
    // `if (this.destroyed) return` — could never pick the work up afterwards.
    markLateStep(agent, 'teardownRuntime', 'CODEX RUNTIME TORN DOWN');
    await disposeRecordingThrow(agent as never);
    await settle();
  },
  async 'codex:disposeForRestart:stepThrows:rebroken'() {
    const agent = new CodexAgent(codexConfig());
    wire(agent as never, sink);
    (agent as unknown as { stopConfigWatcher: unknown }).stopConfigWatcher =
      (): never => { throw new Error('config watcher close exploded'); };
    markLateStep(agent, 'teardownRuntime', 'CODEX RUNTIME TORN DOWN');
    rebreakTeardownStep(agent);
    await disposeRecordingThrow(agent as never);
    await settle();
  },

  // The nestor marker is on the REMOTE CANCEL, not only on the elicitation
  // release: this backend has no server-side close-session RPC, so `cancel()` is
  // the ONLY mechanism that stops a live task (F23). A skipped step here does
  // not merely leak locally — the server is never told to stop.
  async 'nestor:disposeForRestart:stepThrows'() {
    const agent = new NestorCloudAgent(createMockBackendConfig());
    wire(agent as never, sink);
    (agent as unknown as { toolExecutor: unknown }).toolExecutor =
      { dispose: (): never => { throw new Error('tool executor dispose exploded'); } };
    (agent as unknown as { currentTurn: unknown }).currentTurn = {
      cancel: async (): Promise<void> => { debug.push('NESTOR REMOTE TASK CANCELLED'); },
    };
    markLateStep(agent, 'releaseElicitationSurface', 'NESTOR ELICITATION RELEASED');
    await disposeRecordingThrow(agent as never);
    await settle();
  },
  async 'nestor:disposeForRestart:stepThrows:rebroken'() {
    const agent = new NestorCloudAgent(createMockBackendConfig());
    wire(agent as never, sink);
    (agent as unknown as { toolExecutor: unknown }).toolExecutor =
      { dispose: (): never => { throw new Error('tool executor dispose exploded'); } };
    (agent as unknown as { currentTurn: unknown }).currentTurn = {
      cancel: async (): Promise<void> => { debug.push('NESTOR REMOTE TASK CANCELLED'); },
    };
    markLateStep(agent, 'releaseElicitationSurface', 'NESTOR ELICITATION RELEASED');
    rebreakTeardownStep(agent);
    await disposeRecordingThrow(agent as never);
    await settle();
  },

  // ---- P2.347's THIRD disposal path, found by looking ----------------------
  //
  // `ClaudeAgent.killLiveSession` is the file's own name for "the dispose paths
  // do not have to route through the reason dispatch to get it": `close()`,
  // `abort()` and every non-interrupting `forceAbort` reason reach it, and
  // `SessionManager` calls `forceAbort(AbortReason.InternalError)` at four
  // sites. It is SYNCHRONOUS, so unlike `disposeForRestart` it really does take
  // its caller down — and the step it skips is `orphaned.fail(...)`, the only
  // thing that settles a turn slot `chatImpl` is awaiting.
  async 'claude:killLiveSession:inputEndThrows'() {
    const agent = new ClaudeAgent(createMockBackendConfig());
    wire(agent as never, sink);
    (agent as unknown as { liveInput: unknown }).liveInput =
      { end: (): never => { throw new Error('live input end exploded'); } };
    let slotFailed = false;
    (agent as unknown as { openSlot: unknown }).openSlot =
      { settled: false, fail: (): void => { slotFailed = true; } };
    try {
      agent.forceAbort(AbortReason.InternalError);
    } catch (error) {
      thrown.push(error instanceof Error ? error.message : String(error));
    }
    debug.push(slotFailed ? 'CLAUDE TURN SLOT FAILED' : 'CLAUDE TURN SLOT ORPHANED');
    await settle();
  },
  async 'claude:killLiveSession:inputEndThrows:rebroken'() {
    const agent = new ClaudeAgent(createMockBackendConfig());
    wire(agent as never, sink);
    (agent as unknown as { liveInput: unknown }).liveInput =
      { end: (): never => { throw new Error('live input end exploded'); } };
    let slotFailed = false;
    (agent as unknown as { openSlot: unknown }).openSlot =
      { settled: false, fail: (): void => { slotFailed = true; } };
    rebreakTeardownStep(agent);
    try {
      agent.forceAbort(AbortReason.InternalError);
    } catch (error) {
      thrown.push(error instanceof Error ? error.message : String(error));
    }
    debug.push(slotFailed ? 'CLAUDE TURN SLOT FAILED' : 'CLAUDE TURN SLOT ORPHANED');
    await settle();
  },
};

const scenario = process.argv[2] ?? '';
const sink = process.argv[3] ?? 'record';
const run = SCENARIOS[scenario];
if (!run) {
  console.log(`__PROBE__${JSON.stringify({ error: `unknown scenario ${scenario}`, known: Object.keys(SCENARIOS) })}`);
  process.exit(2);
}
/**
 * A WATCHDOG, not a nicety. Some teardown paths here never settle on their own
 * (`codex:destroy` awaits a runtime disposal that has no runtime to dispose),
 * and a detector that hangs is a detector people stop running. What matters to
 * every assertion is what escaped by the time emissions have had their chance,
 * so cap the wait and report rather than block.
 */
const WATCHDOG_MS = Number(process.env.PROBE_WATCHDOG_MS ?? 5000);
let timedOut = false;
await Promise.race([
  run().then(() => settle()),
  new Promise<void>(resolve => setTimeout(() => { timedOut = true; resolve(); }, WATCHDOG_MS)),
]);
console.log(`__PROBE__${JSON.stringify({ escapes, debug, thrown, ...(timedOut ? { timedOut: true } : {}) })}`);
process.exit(0);
