/**
 * P2.304 / P2.303 — the floating-emission family, measured with a detector that
 * can actually fail.
 *
 * WHY THIS FILE SPAWNS SUBPROCESSES INSTEAD OF ASSERTING IN PROCESS.
 *
 * The whole family used to be tracked with `expect(escaped).toEqual([])` over a
 * `process.on('unhandledRejection')` listener. MEASURED on bun 1.3.14, with a
 * positive control on the same rig:
 *
 *   | rig                    | user `unhandledRejection` listener fires? |
 *   | ---------------------- | ----------------------------------------- |
 *   | `bun run` (production) | YES                                       |
 *   | `bun test`             | NO                                        |
 *
 * `process.listenerCount('unhandledRejection')` reads 0 inside `bun test`
 * before anything registers, so the runner is not installing a competing
 * listener — it intercepts below `process`, and a user listener is never
 * consulted. **That assertion therefore could not fail.** It is the assertion
 * P2.192's commit message cites as its proof, and the class grew 5 -> 7 -> 8 ->
 * 14 under it, every increment found by a person reading rather than by a test.
 *
 * The runner's own interception is not a usable substitute either. Also
 * measured:
 *   - an escape landing WHILE the test body still awaits aborts that test and
 *     reports a failure — caught, but by the runner, naming neither site nor fix;
 *   - an escape landing AFTER the test body returns is COMPLETELY SILENT:
 *     `2 pass, 0 fail`, exit 0.
 * So detection depended on whether `settle()` happened to outlast the emission.
 *
 * A plain `bun` child process is where the listener works, and it is also the
 * surface production actually has (Electron main, the headless server). Every
 * assertion below is a DELTA against a control that MUST fail — the property
 * the old detector never had. See `fixtures/floating-emission-probe.ts`.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test';

/**
 * P6.782 (W9-bq, 2026-09-10) — ONE budget for the file, sized against the
 * largest observed per-case cost and declared here rather than repeated 24
 * times.
 *
 * ## Why this file needs a constant of its own
 *
 * `module-graph-budgets.ts` documents the escape hatch and this is it: none of
 * its three numbers fits. The cost here is NOT the module graph — the zero-case
 * control (`bun test <this file> -t '<a name nothing matches>'`) returns
 * **15.32 s with 0 cases executed**, user 0.71 / sys 0.42, and junit puts the
 * whole file at **1 489.09 s** with **1 473.71 s** of that inside the 31 bodies.
 * The graph is 1 % of the run. Every case pays a `bun run` CHILD, and the
 * child's own cold module graph is the cost.
 *
 * ## The readings the number is sized against
 *
 * | reading | value |
 * | --- | ---: |
 * | file total, quiet tree, load ~11 | 1 489.09 s, 31 pass / 0 fail, user 53.08 / sys 26.77 (5 % cpu) |
 * | slowest body, quiet | 51.30 s |
 * | one probe child, COLD, measured directly (P2.335) | 234 s for 1.54 s user / 0.68 s sys — 0 % cpu |
 * | the run that produced the row | 24 pass / 7 fail at 1 997 s, every failure a timeout with ZERO assertion failures |
 *
 * The old per-case number was **180 000**, below the 234 s a single probe has
 * been measured at cold — so the budget was under its own floor, and the seven
 * failures were the cases that happened to land on the slow side of it. 600 000
 * is 2.6x the largest observed per-case cost and 11.7x the quiet reading; it is
 * deliberately not larger, because a per-case ceiling is also what makes a
 * genuinely hung probe audible.
 */
const PROBE_CASE_BUDGET_MS = 600_000;
setDefaultTimeout(PROBE_CASE_BUDGET_MS);

interface ProbeResult {
  escapes: string[];
  debug: string[];
  /**
   * P2.333 is a SYNCHRONOUS throw out of `destroy()`, which `escapes` cannot
   * carry: it never becomes a rejection at all. The mirror image of the rest of
   * this file — there the error escaped into nothing, here into the caller.
   */
  thrown: string[];
  timedOut?: boolean;
}

const PROBE_URL = new URL('./fixtures/floating-emission-probe.ts', import.meta.url);

/** Run one scenario in a plain `bun` process and read back what escaped there. */
async function probe(
  scenario: string,
  sink: 'record' | 'throw' | 'throw-automation' | 'throw-usage',
): Promise<ProbeResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, 'run', Bun.fileURLToPath(PROBE_URL), scenario, sink],
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, PROBE_WATCHDOG_MS: '4000' },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  const line = stdout.split('\n').find(entry => entry.startsWith('__PROBE__'));
  if (!line) {
    throw new Error(`probe ${scenario}/${sink} produced no result line.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return JSON.parse(line.slice('__PROBE__'.length)) as ProbeResult;
}

/**
 * The six survivors P2.303 named, with the label each site's rejection handler
 * is required to write. The `.catch` alone is only half the family's standard.
 *
 * SITE LINE NUMBERS FROM THE ROW ARE DELIBERATELY NOT REPEATED HERE. Three of
 * the six were wrong when this ran (`codex-agent.ts:3334` is an `if`, `:3799`
 * an assignment, and `pi-agent.ts:9728` is a site that was ALREADY guarded);
 * the scenario name is the durable identifier, a line number is not.
 */
const SITES: Array<{ scenario: string; label: string }> = [
  { scenario: 'codex:forceAbort', label: 'Automation event Stop could not be delivered' },
  { scenario: 'codex:destroy', label: 'Session lifecycle end could not be delivered' },
  { scenario: 'nestor:abort', label: 'Automation event Stop could not be delivered' },
  { scenario: 'nestor:forceAbort', label: 'Automation event Stop could not be delivered' },
  { scenario: 'nestor:destroy', label: 'Session lifecycle end could not be delivered' },
  { scenario: 'pi:destroy', label: 'Pi automation event SessionEnd could not be delivered' },
];

describe('floating emissions: the detector', () => {
  it('POSITIVE CONTROL: an unguarded detached emission DOES escape, and the probe sees it', async () => {
    // Without this the whole file could be vacuously green. It restores the
    // pre-fix shape of `BaseAgent.emitDetachedAutomationEvent` in place — a bare
    // `void`, no rejection handler — and the escape must reappear.
    const broken = await probe('base:instructionsLoaded:rebroken', 'throw');
    expect(broken.escapes).toEqual(['log sink exploded']);
  });

  it('re-verifies P2.192 itself: the fixed site escapes NOTHING under the same input', async () => {
    // The row this file exists to re-measure. Its own assertion could not fail;
    // this one can, and it is a delta against the control above.
    const fixed = await probe('base:instructionsLoaded', 'throw');
    expect(fixed.escapes).toEqual([]);
  });

  it('CANARY: a user `unhandledRejection` listener is still blind under `bun test`', () => {
    // The reason every assertion here pays for a subprocess. If bun ever starts
    // consulting user listeners, this fails and the harness can be simplified —
    // which is the only circumstance in which that would be safe.
    let fired = false;
    const listener = (): void => { fired = true; };
    process.on('unhandledRejection', listener);
    try {
      expect(process.listenerCount('unhandledRejection')).toBeGreaterThan(0);
      expect(fired).toBe(false);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});

describe('floating emissions: P2.303 six survivors', () => {
  for (const { scenario, label } of SITES) {
    it(`${scenario} — the rejection is caught AND named`, async () => {
      const result = await probe(`${scenario}:rejecting`, 'record');
      expect(result.escapes).toEqual([]);
      // The label half of the family's standard: a caught rejection that writes
      // nothing is a silent failure, which is the state before the row as much
      // as an unhandled rejection is.
      expect(result.debug.some(entry => entry.includes(label))).toBe(true);
    });
  }

  // The rejection handlers end in `this.debug`, which ends in the HOST's
  // `onDebug`. A throw from there, inside a rejection handler, is one more
  // unhandled rejection — so the handlers are belted, and this measures it at
  // the five sites where a throwing sink can reach the emitter at all (Pi is
  // excluded: its belted `debug` override means a throwing sink cannot make
  // its emission reject — measured, not assumed).
  //
  // ONE CASE PER SCENARIO, not one case running five probes (P6.782, W9-bq,
  // 2026-09-10). As a single body this was BY FAR the most expensive case in the
  // file — junit measured it at **249.45 s** against ~51 s for each of its
  // siblings — so it needed a budget five times theirs, and a five-minute timer
  // on one case is the shape `module-graph-budgets.ts` argues against. Five
  // cases of the same size as every other case need no special number, and a
  // failure now names the scenario instead of being read out of a message.
  for (const scenario of ['codex:forceAbort', 'codex:destroy', 'nestor:abort', 'nestor:forceAbort', 'nestor:destroy']) {
    it(`${scenario} — a broken host debug sink does not become the failure it reports`, async () => {
      const result = await probe(scenario, 'throw-automation');
      expect({ scenario, escapes: result.escapes }).toEqual({ scenario, escapes: [] });
    });
  }
});

/**
 * P2.332 — the FIFTEENTH site: the post-compaction `SessionStart` emission.
 *
 * `handleSubprocessEvent`'s `compaction_end` arm builds
 * `_postCompactHookEmission` and stores it. Exactly one consumer awaits it; the
 * workspace-change boundary and `clearHistory` assign `undefined` over it
 * without awaiting or catching. A rejected promise dropped with no observer is
 * an unhandled rejection.
 *
 * The fix is at the CREATION, not at the two drop sites, and the scenarios below
 * are why that is the stronger place: it also covers the awaiting consumer (a
 * failed hook can no longer abort the user's next turn) and it un-poisons the
 * chain that overflow recovery builds one link at a time.
 */
describe('P2.332 — the post-compaction SessionStart emission', () => {
  it('POSITIVE CONTROL: the pre-fix chain, restored in place, still escapes', async () => {
    // `previous.then(() => this.emitPostCompactSessionStart())` with no handler
    // — the exact line that used to be stored. Without this the two assertions
    // below could be vacuously green.
    const broken = await probe('pi:postCompactEmission:rebroken', 'record');
    expect(broken.escapes).toEqual(['automation system is gone']);
  });

  it('the real seam escapes nothing and NAMES the failure', async () => {
    const fixed = await probe('pi:postCompactEmission', 'record');
    expect(fixed.escapes).toEqual([]);
    // The label half of the family's standard. Pi routes it through
    // `reportAutomationEventFault`, which also raises a transcript row.
    expect(fixed.debug.some(entry =>
      entry.includes('Pi automation event SessionStart could not be delivered'))).toBe(true);
  });

  it('dropping the handle at the workspace-change boundary escapes nothing', async () => {
    // The row's own two line numbers, driven through `setWorkspace` (the sibling
    // dropper is `clearHistory`). After the fix the stored promise cannot reject,
    // so the drop is safe by construction rather than by each dropper remembering.
    const dropped = await probe('pi:postCompactDrop', 'record');
    expect(dropped.escapes).toEqual([]);
  });
});

/**
 * P2.334 — the survivors that closed the escape and threw away the NAME.
 *
 * These two had `.catch(() => undefined)` / `.catch(() => {})`: nothing was lost
 * to the void, but the operator got no name for what failed. The delta measured
 * here is therefore the label rather than the escape, and it can still fail — a
 * missing or misspelled label fails it, which is exactly the pre-fix state.
 */
describe('P2.334 — a caught rejection that says nothing is still a silent failure', () => {
  it('pi: the turn-end TaskCompleted notice names its host port failure', async () => {
    const result = await probe('pi:taskTurnEnd', 'record');
    expect(result.escapes).toEqual([]);
    expect(result.debug.some(entry =>
      entry.includes('Task turn-end notice could not be delivered: task registry is gone'))).toBe(true);
  });

  it('nestor: a refused remote cancel is named, because nothing else will ever report it', async () => {
    // The only teardown on this backend that reaches OUTSIDE the process: there
    // is no server-side close-session RPC, so a swallowed cancel rejection is a
    // live remote task nobody hears about again (F23).
    const result = await probe('nestor:cancelRejects', 'record');
    expect(result.escapes).toEqual([]);
    expect(result.debug.some(entry =>
      entry.includes('Nestor remote cancel (destroy) could not be delivered: remote cancel refused'))).toBe(true);
  });
});

/**
 * P2.335 — the cloud agent's own emission sweep, and the one site it failed.
 *
 * The owner's D17 asked for a narrow lane holding `nestor-cloud-agent.ts` to the
 * standard the other backends are held to, because it is the runtime with no
 * external documentation corpus: nothing enumerates what it should do, so its
 * defects are found only when someone happens to look. The sweep found the file
 * conforming at every DETACHED site — `void x.catch(named)` throughout — and at
 * every teardown step, and failing at the one site that is neither: `chatImpl`'s
 * `finally` did `await this.emitStopHookOnce()`, on the ordinary turn end, with
 * the recorder inside that promise belted and the EMISSION not.
 *
 * The harm is not a lost log line. The rejection leaves the `finally` and skips
 * `toolExecutor.dispose()`, `processing = false`, `abortController = null`,
 * `toolExecutor = null` and `currentTurn = null` — so `processing` stays true and
 * the session refuses every later turn. The promise is memoised (`abort()`'s own
 * comment says so), so the same rejection is served to `endLifecycle` and to
 * every later await: permanent for the session, not transient.
 *
 * The channel is `thrown`, not `escapes`: an awaited rejection is HANDLED by the
 * await, so nothing is ever unhandled and the detector that found the other
 * fifteen sites is blind to this one by construction.
 */
describe('P2.335 — the cloud agent turn-end Stop emission, awaited rather than detached', () => {
  it('POSITIVE CONTROL: the pre-fix shape, restored in place, rejects into its caller', async () => {
    const broken = await probe('nestor:stopHookAwaited:emitRejects:rebroken', 'record');
    expect(broken.thrown).toEqual(['automation system is gone']);
  });

  it('the awaited emission resolves and NAMES the failure', async () => {
    const result = await probe('nestor:stopHookAwaited:emitRejects', 'record');
    // Nothing reaches the caller, so the `finally` runs to its end.
    expect(result.thrown).toEqual([]);
    // And nothing is discarded either — the family's other half.
    expect(result.escapes).toEqual([]);
    expect(result.debug.some(entry =>
      entry.includes('Automation event Stop could not be delivered: automation system is gone'))).toBe(true);
  });
});

/**
 * P2.333 — `BaseAgent.destroy()` is TOTAL by contract.
 *
 * The mirror image of everything above: the error escaped into the CALLER rather
 * than into nothing. `usageTracker.reset()` ends in `config.onDebug`, a
 * host-supplied callback, so a throwing log sink propagated synchronously out of
 * teardown. Two harms, and the second is the expensive one: every step after the
 * failing one was skipped — the elicitation release and the private MCP pool
 * disconnect among them, so a broken logger became a connection leak.
 */
describe('P2.333 — destroy() is total, and the later steps still run', () => {
  it('POSITIVE CONTROL: both pre-fix shapes restored → destroy throws AND skips its tail', async () => {
    // Unbelted `UsageTracker.debug` plus an un-isolated `runTeardownStep`, which
    // together are the code as it stood before this row.
    const broken = await probe('base:destroy:usageSink:rebroken', 'throw-usage');
    expect(broken.thrown).toEqual(['log sink exploded']);
    // The second harm, asserted rather than described: the last step never ran.
    expect(broken.debug.some(entry => entry.includes('Base agent destroyed'))).toBe(false);
  });

  it('a throwing host log sink neither takes destroy() down nor costs it a step', async () => {
    const fixed = await probe('base:destroy:usageSink', 'throw-usage');
    expect(fixed.thrown).toEqual([]);
    expect(fixed.escapes).toEqual([]);
    expect(fixed.debug.some(entry => entry.includes('Base agent destroyed'))).toBe(true);
  });
});

/**
 * P2.333, THE HALF ITS ROW UNDERCOUNTED: it is FOUR of four, not "Codex and
 * Nestor", and each backend is affected differently.
 *
 * Measured rather than reasoned:
 *   - `pi-agent.ts` holds the tree's ONLY `override debug`, so Claude, Codex and
 *     Nestor all reach `usageTracker.reset()` through an unbelted host sink;
 *   - `PiAgent.destroy()` never chains `super.destroy()`, which is a second and
 *     stronger reason it is immune to the path the row names — and it means its
 *     own four steps have no base-class net underneath them;
 *   - `ClaudeAgent.destroy()` chains `super.destroy()` LAST, so a throw anywhere
 *     in its prologue skipped the ENTIRE base cleanup: config watcher,
 *     whitelists, api-server retention, elicitation release, MCP pool disconnect.
 *
 * `destroy()` is total at the PUBLIC surface or not at all — callers see the
 * override, not `BaseAgent`.
 */
describe('P2.333 — every backend destroy() is total, not just the base one', () => {
  it('POSITIVE CONTROL: un-isolated, a Claude prologue throw skips the whole base cleanup', async () => {
    const broken = await probe('claude:destroy:prologueThrows:rebroken', 'record');
    expect(broken.thrown).toEqual(['adapter close exploded']);
    expect(broken.debug.some(entry => entry.includes('Base agent destroyed'))).toBe(false);
  });

  it('claude: a throwing prologue step is named, and super.destroy() still runs', async () => {
    const fixed = await probe('claude:destroy:prologueThrows', 'record');
    expect(fixed.thrown).toEqual([]);
    expect(fixed.debug.some(entry =>
      entry.includes('Teardown step claude loopback adapter could not be delivered'))).toBe(true);
    // The assertion that matters: the base cleanup was REACHED past the throw.
    expect(fixed.debug.some(entry => entry.includes('Base agent destroyed'))).toBe(true);
  });

  it('POSITIVE CONTROL: un-isolated, a Pi teardown step throw skips the rest', async () => {
    const broken = await probe('pi:destroy:stepThrows:rebroken', 'record');
    expect(broken.thrown).toEqual(['subprocess kill exploded']);
    expect(broken.debug.some(entry => entry.includes('PiAgent destroyed'))).toBe(false);
  });

  it('pi: a throwing teardown step is named, and the rest of teardown still runs', async () => {
    const fixed = await probe('pi:destroy:stepThrows', 'record');
    expect(fixed.thrown).toEqual([]);
    expect(fixed.debug.some(entry =>
      entry.includes('Teardown step pi subprocess kill could not be delivered'))).toBe(true);
    expect(fixed.debug.some(entry => entry.includes('PiAgent destroyed'))).toBe(true);
  });
});

/**
 * THE SIXTEENTH SITE, found the way all fifteen before it were — by reading.
 *
 * A rejection handler that RAW-INTERPOLATES its own error is the family in
 * miniature: `${err}` is evaluated before `debug` is called, so Pi's belted
 * `debug` override cannot help, `String(Object.create(null))` raises (P2.65),
 * and the handler's own promise rejects with nobody holding it.
 *
 * Measured on the unfixed tree before the change:
 *   `__PROBE__{"escapes":["No default value"],"debug":[],"thrown":[]}`
 */
describe('the sixteenth site — a rejection handler that cannot render its own error', () => {
  it('POSITIVE CONTROL: the pre-fix handler shape still escapes', async () => {
    const broken = await probe('pi:tokenRefreshFault:rebroken', 'record');
    expect(broken.escapes).toEqual(['No default value']);
  });

  it('parsePiError\'s detached token refresh escapes nothing and renders totally', async () => {
    const fixed = await probe('pi:tokenRefreshFault', 'record');
    expect(fixed.escapes).toEqual([]);
    expect(fixed.debug.some(entry =>
      entry.includes('Token refresh from parsePiError failed: (unrenderable thrown value)'))).toBe(true);
  });
});

/**
 * P2.347 — THE RESTART PATH, which is the one `SessionManager` actually takes.
 *
 * `disposeManagedAgentRuntime` reads
 * `if (agent.disposeForRestart) await agent.disposeForRestart() else agent.dispose()`.
 * Codex, Nestor and Pi all define `disposeForRestart`, so P2.333's belt landed
 * on `destroy()` — the path a restart never takes — while the common one kept
 * the defect. Claude is the only backend for which `destroy()` IS the restart
 * path, because it defines no `disposeForRestart`.
 *
 * Measured on the unfixed tree at 40b3c84a3955a7716bdaeef2c9098154ab52082a,
 * before any change here:
 *   codex  `{"escapes":[],"debug":[],"thrown":["config watcher close exploded"]}`
 *   nestor `{"escapes":[],"debug":[],"thrown":["tool executor dispose exploded"]}`
 *
 * The `debug` arrays are EMPTY in both, which is the whole finding: the marker
 * standing in for a late step is absent, so the throw did not merely surface —
 * it cancelled the rest of the teardown.
 */
describe('P2.347 — disposeForRestart() is total over its synchronous steps', () => {
  it('POSITIVE CONTROL: un-isolated, a codex prologue throw never even schedules teardownRuntime', async () => {
    const broken = await probe('codex:disposeForRestart:stepThrows:rebroken', 'record');
    expect(broken.thrown).toEqual(['config watcher close exploded']);
    expect(broken.debug.some(entry => entry.includes('CODEX RUNTIME TORN DOWN'))).toBe(false);
  });

  it('codex: the throw is named and the app-server teardown still runs', async () => {
    const fixed = await probe('codex:disposeForRestart:stepThrows', 'record');
    expect(fixed.thrown).toEqual([]);
    expect(fixed.debug.some(entry =>
      entry.includes('Teardown step codex restart config watcher could not be delivered'))).toBe(true);
    // The expensive half: the child, the adapter, the callback bridge and the
    // managed CODEX_HOME are only released inside `teardownRuntime`.
    expect(fixed.debug.some(entry => entry.includes('CODEX RUNTIME TORN DOWN'))).toBe(true);
  });

  it('POSITIVE CONTROL: un-isolated, a nestor step throw skips the remote cancel and the release', async () => {
    const broken = await probe('nestor:disposeForRestart:stepThrows:rebroken', 'record');
    expect(broken.thrown).toEqual(['tool executor dispose exploded']);
    // The backend-specific harm, and it is not local: there is no server-side
    // close-session RPC, so `cancel()` is the ONLY way to stop a live remote
    // task (F23). Skipped, the task keeps running with nobody left to hear.
    expect(broken.debug).not.toContain('NESTOR REMOTE TASK CANCELLED');
    expect(broken.debug.some(entry => entry.includes('NESTOR ELICITATION RELEASED'))).toBe(false);
  });

  it('nestor: the throw is named and the remote cancel still fires', async () => {
    const fixed = await probe('nestor:disposeForRestart:stepThrows', 'record');
    expect(fixed.thrown).toEqual([]);
    expect(fixed.debug.some(entry =>
      entry.includes('Teardown step nestor restart tool executor could not be delivered'))).toBe(true);
    expect(fixed.debug).toContain('NESTOR REMOTE TASK CANCELLED');
    expect(fixed.debug.some(entry => entry.includes('NESTOR ELICITATION RELEASED'))).toBe(true);
  });
});

/**
 * P2.347's THIRD disposal path — the one the row did not name, found by looking
 * for it because two identically-shaped methods with different names is the
 * pattern that hides a third.
 *
 * `ClaudeAgent.killLiveSession` is the file's own name for the shape `close()`,
 * `abort()` and every non-interrupting `forceAbort` reason reach, and
 * `SessionManager` calls `forceAbort(AbortReason.InternalError)` at four sites.
 * It is SYNCHRONOUS, so unlike `disposeForRestart` it genuinely does take its
 * caller down — and the step it skipped is `orphaned.fail(...)`, the only thing
 * that settles a turn slot `chatImpl` is blocked on.
 *
 * Measured on the unfixed tree:
 *   `{"escapes":[],"debug":["CLAUDE TURN SLOT ORPHANED"],"thrown":["live input end exploded"]}`
 * — a hang, not a leak.
 */
describe('P2.347 — the third disposal path: ClaudeAgent.killLiveSession', () => {
  it('POSITIVE CONTROL: un-isolated, a live-input throw orphans the turn slot forever', async () => {
    const broken = await probe('claude:killLiveSession:inputEndThrows:rebroken', 'record');
    expect(broken.thrown).toEqual(['live input end exploded']);
    expect(broken.debug).toContain('CLAUDE TURN SLOT ORPHANED');
  });

  it('claude: forceAbort survives a throwing EOF and still settles the orphaned slot', async () => {
    const fixed = await probe('claude:killLiveSession:inputEndThrows', 'record');
    expect(fixed.thrown).toEqual([]);
    expect(fixed.debug.some(entry =>
      entry.includes('Teardown step claude live input EOF could not be delivered'))).toBe(true);
    expect(fixed.debug).toContain('CLAUDE TURN SLOT FAILED');
  });
});
