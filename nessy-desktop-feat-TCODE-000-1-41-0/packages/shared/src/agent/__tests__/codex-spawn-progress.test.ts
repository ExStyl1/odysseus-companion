/**
 * P2.232 — a 35-second cold spawn was indistinguishable from a hang.
 *
 * ## Why a SIGNAL and not a deadline
 *
 * P2.138 left `initialize` and `thread/start` unbounded on purpose: both are
 * mandatory, and a bound on a mandatory call manufactures failures. The
 * distribution is what rules out the other option the row offered — a deadline
 * generous enough that only a true hang trips it. Measured on the bundled
 * `darwin-arm64/codex-app-server`:
 *
 * | reading | `initialize` | `thread/start` |
 * | --- | --- | --- |
 * | P2.138, two cold spawns | — | 10.5 s and 34.7 s for the pair |
 * | W3-a, first spawn of a cold binary, load 19 | 3 162 ms | 2 938 ms |
 * | W3-a, five later spawns, fresh homes each | 253-975 ms | 232-447 ms |
 *
 * ~170x on one machine. A deadline safe against that tail detects nothing.
 *
 * ## Native-first, measured
 *
 * Every inbound frame between the `initialize` write and the `thread/start`
 * response was timestamped on the same rig: the `initialize` response, one
 * `remoteControl/status/changed` (a family we opt out of), and `thread/started`
 * AFTER the response. The runtime publishes no progress, so the host must.
 *
 * ## What each test kills
 *
 *  - "says nothing on a fast spawn" is the CONTROL. Without it a reporter that
 *    always spoke would pass every other assertion and put a line in front of
 *    every user on every session.
 *  - "reports while a slow spawn runs" dies if the reporter is removed — the
 *    shipped state.
 *  - "names the step" dies if the phase is dropped: "starting the runtime" and
 *    "codex is not answering `initialize`" call for different actions.
 *  - "repeats on the longer interval" dies if the follow-up cadence collapses to
 *    the first threshold, which turns a 35-second spawn into seven lines.
 *  - "puts no deadline on the spawn" dies if a timeout is ever added here: the
 *    slow spawn still RESOLVES, and its result still reaches the caller.
 *  - "rethrows the failure unchanged" dies if this becomes a second error
 *    channel — the integrity-seatbelt catch at the call site depends on the
 *    original error arriving at the original point.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAgent } from '../codex-agent.ts';
import { createMockBackendConfig } from './test-utils.ts';
import type { BackendConfig } from '../backend/types.ts';
import type { AgentEvent } from '@nessy-agent/core/types';

type Inner = {
  ensureRuntime(): Promise<void>;
  startupPhase: string | null;
  ensureRuntimeReportingProgress(): AsyncGenerator<AgentEvent, void>;
};

function agent(): { agent: CodexAgent; inner: Inner } {
  const instance = new CodexAgent({
    ...createMockBackendConfig(),
    provider: 'codex-runtime',
    model: 'codex/test-model',
    isHeadless: true,
  } as BackendConfig);
  return { agent: instance, inner: instance as unknown as Inner };
}

/** Drain the reporter, collecting what it emitted. */
async function drain(inner: Inner): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of inner.ensureRuntimeReportingProgress()) events.push(event);
  return events;
}

describe('P2.232 — a slow codex spawn says so', () => {
  it('CONTROL: says nothing at all on a spawn as slow as the worst WARM reading', async () => {
    const { inner } = agent();
    // 1 000 ms, deliberately ABOVE the worst warm reading measured (975 ms), and
    // not a token 20 ms. A 20 ms arm made this control vacuous: a mutant that
    // dropped the first notice from 5 s to 50 ms SURVIVED it (re-break, M2),
    // because 20 ms is under any threshold anyone would mistype. The property is
    // "an ordinary spawn says nothing", and an ordinary spawn is the measured
    // 232-975 ms, so that is what is asserted.
    inner.ensureRuntime = () => new Promise<void>(resolve => setTimeout(resolve, 1_000));
    expect(await drain(inner)).toEqual([]);
  }, 20_000);

  it('reports while a slow spawn runs, on the momentary channel', async () => {
    const { inner } = agent();
    inner.ensureRuntime = () => new Promise<void>(resolve => setTimeout(resolve, 5_400));
    inner.startupPhase = 'waiting for codex to initialize';
    const events = await drain(inner);
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe('info');
    // NOT `level: 'warning'`: that family is the durable one, and a slow start
    // is status, not a fault the session should keep.
    expect((events[0] as { level?: string }).level).toBeUndefined();
  }, 20_000);

  it('names the step, so a stall is distinguishable from a slow start', async () => {
    const { inner } = agent();
    inner.ensureRuntime = () => new Promise<void>(resolve => setTimeout(resolve, 5_400));
    inner.startupPhase = 'starting the codex app-server';
    const events = await drain(inner);
    expect((events[0] as { message: string }).message).toContain('starting the codex app-server');
    // And it says it is not going to give up, because the alternative reading of
    // a progress line is "something is being retried".
    expect((events[0] as { message: string }).message).toContain('nothing will time out');
  }, 20_000);

  it('repeats on the LONGER interval, not on the first threshold', async () => {
    const { inner } = agent();
    // 16 s crosses 5 s and 15 s and stops short of 25 s: two lines, not three,
    // and not the four a 5 s cadence would produce.
    inner.ensureRuntime = () => new Promise<void>(resolve => setTimeout(resolve, 16_000));
    const events = await drain(inner);
    expect(events.length).toBe(2);
  }, 40_000);

  it('puts NO deadline on the spawn — the slow one still succeeds', async () => {
    const { inner } = agent();
    let resolved = false;
    inner.ensureRuntime = () => new Promise<void>(resolve => setTimeout(() => {
      resolved = true;
      resolve();
    }, 6_000));
    await drain(inner);
    expect(resolved).toBe(true);
  }, 20_000);

  it('rethrows the spawn failure unchanged, at the same point', async () => {
    const { inner } = agent();
    const boom = new Error('codex-runtime-startup-failed');
    inner.ensureRuntime = () => Promise.reject(boom);
    await expect(drain(inner)).rejects.toBe(boom);
  });

  it('is WIRED: the turn awaits the REPORTING form, and the four phases are set', () => {
    // Every assertion above drives the reporter directly, so all of them survive
    // the one mutation that matters most — leaving the call site on the plain
    // `await this.ensureRuntime()`. Nothing at runtime notices a reporter nobody
    // reaches, which is the argument `managed-update-registration.test.ts` makes
    // for reading the source, so this reads the source.
    const source = readFileSync(join(import.meta.dir, '..', 'codex-agent.ts'), 'utf8');
    expect(source).toContain('yield* this.ensureRuntimeReportingProgress()');
    // A phase left unset reads as `preparing the session` forever, which is the
    // silent half of this row wearing a progress line. All four are asserted
    // because each names a different action for whoever is watching.
    for (const phase of [
      'starting the local model adapter',
      'starting the codex app-server',
      'waiting for codex to initialize',
      'opening the codex thread',
    ]) {
      expect(source).toContain(`this.startupPhase = '${phase}'`);
    }
  });

  it('clears the phase when the spawn settles, so a later read cannot be stale', async () => {
    const { inner } = agent();
    inner.startupPhase = 'opening the codex thread';
    inner.ensureRuntime = () => Promise.resolve();
    await drain(inner);
    expect(inner.startupPhase).toBeNull();
  });
});
