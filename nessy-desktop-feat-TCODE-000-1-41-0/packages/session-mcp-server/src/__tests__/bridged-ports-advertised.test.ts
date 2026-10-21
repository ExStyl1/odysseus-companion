/**
 * C3.360 (rig day 2026-09-12, RS-37) — a bridged session must be OFFERED
 * `ReviewDiff`. `createSessionTools` in `../index.ts` derives three port flags
 * from `hostCallbackBridge`; the third was missing for a release, so the tool
 * was advertised to no bridged session (52 tools against 53) and C4.13's
 * background review could not be requested by any model. Two instruments:
 * the registry's own answer to the filter (positive AND negative), and the
 * source line that derives the flag — a behavioural test alone would pass on
 * a caller that set the flag by hand somewhere else.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getToolDefsAsJsonSchema } from '@nessy-agent/session-tools-core';

const names = (opts: Parameters<typeof getToolDefsAsJsonSchema>[0]) =>
  getToolDefsAsJsonSchema(opts).map(d => d.name);

describe('C3.360 — ReviewDiff is offered to a bridged session', () => {
  it('a bridged session with the review-diff port lists ReviewDiff; without the port it does not', () => {
    const bridged = names({ includeDeveloperFeedback: false, externalStandaloneOnly: false, hostCallbackBridge: true, reviewDiffPort: true });
    const noPort = names({ includeDeveloperFeedback: false, externalStandaloneOnly: false, hostCallbackBridge: true, reviewDiffPort: false });
    expect({ bridged: bridged.includes('ReviewDiff'), noPort: noPort.includes('ReviewDiff') }).toEqual({ bridged: true, noPort: false });
    // the control: EnterWorktree is present in both (it hangs off worktreePort, not this flag)
    expect(bridged.includes('EnterWorktree') || noPort.includes('EnterWorktree')).toBe(bridged.includes('EnterWorktree'));
  });

  it('createSessionTools derives reviewDiffPort from the bridge, beside its two siblings', () => {
    const src = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');
    for (const line of ['notificationPort: hostCallbackBridge,', 'worktreePort: hostCallbackBridge,', 'reviewDiffPort: hostCallbackBridge,']) {
      expect({ line, present: src.includes(line) }).toEqual({ line, present: true });
    }
  });

  // UB6.11 — decide's offer, derived from the bridge AND the spawn's own flag
  // (the host emits `--decide-port` only when the decision layer is configured),
  // so a bridged codex session whose decision layer is off is not advertised
  // the tool at all.
  it('UB6.11 — decide is offered to a bridged session only with decidePort', () => {
    const both = names({ includeDeveloperFeedback: false, externalStandaloneOnly: true, hostCallbackBridge: true, decidePort: true });
    const bridgeOnly = names({ includeDeveloperFeedback: false, externalStandaloneOnly: true, hostCallbackBridge: true, decidePort: false });
    expect({ both: both.includes('decide'), bridgeOnly: bridgeOnly.includes('decide') }).toEqual({ both: true, bridgeOnly: false });
  });

  it('UB6.11 — createSessionTools derives decidePort from the bridge and the spawn flag', () => {
    const src = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');
    for (const line of ['decidePort: hostCallbackBridge && decidePort,', "decidePort = true; // UB6.11"]) {
      expect({ line, present: src.includes(line) }).toEqual({ line, present: true });
    }
  });
});
