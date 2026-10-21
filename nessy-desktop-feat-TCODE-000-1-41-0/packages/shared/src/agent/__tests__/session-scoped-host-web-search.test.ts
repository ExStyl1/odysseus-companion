/**
 * P6.148 / P6.895 — the claude builder's own host-port OFFER gate.
 *
 * P6.148 landed it for the host `web_search` alone; P6.895 measured that the
 * SAME builder advertised `ReviewDiff` with no diff port bound, because it
 * passed `reviewDiffPort` into `getSessionToolDefs`, where nothing reads it.
 * The gate is now `session-tools-core`'s own `isOfferedByHostPorts` — one
 * predicate for every advertised surface — and this file drives the exact
 * function the builder calls.
 *
 * The predicate is tested rather than the built MCP server: `getSessionScopedTools`
 * reads `config-defaults.json` out of a real config directory before it reaches
 * the tool list, so a test that drove it would be measuring config bootstrap.
 * What must not rot is the DEFAULT — a caller that has bound no diff port, or
 * that has not thought about the target model's wire, must get neither tool,
 * because claude keeps its native `WebSearch` on an `anthropic-messages`
 * passthrough connection and two search tools in front of one model is the
 * defect the whole gate family prevents.
 */

import { describe, expect, it } from 'bun:test';
import { getSessionToolDefs } from '@nessy-agent/session-tools-core';
import { hostPortOfferOptions, withHostPortGate } from '../session-scoped-tools.ts';

const DEFS = [
  { name: 'SubmitPlan' },
  { name: 'ReviewDiff' },
  { name: 'web_search' },
  { name: 'transform_data' },
];

/** A stand-in for the bound port — the gate reads its presence, not its shape. */
const PORT = { compute: async () => ({ diff: '' }) };

describe('withHostPortGate (P6.148, P6.895)', () => {
  it('offers each gated tool only when this session bound its own host fact', () => {
    expect(withHostPortGate(DEFS, { reviewDiff: PORT, hostWebSearchOffered: true }).map(d => d.name))
      .toEqual(['SubmitPlan', 'ReviewDiff', 'web_search', 'transform_data']);
    // One flag cannot lift the other — the two facts are independent, and a
    // gate that conflated them would be the bug one tool over.
    expect(withHostPortGate(DEFS, { reviewDiff: PORT }).map(d => d.name))
      .toEqual(['SubmitPlan', 'ReviewDiff', 'transform_data']);
    expect(withHostPortGate(DEFS, { hostWebSearchOffered: true }).map(d => d.name))
      .toEqual(['SubmitPlan', 'web_search', 'transform_data']);
  });

  it('withholds both by default, and for every falsy spelling of either fact', () => {
    for (const callbacks of [
      undefined,
      {},
      { hostWebSearchOffered: false },
      { reviewDiff: undefined },
      { reviewDiff: undefined, hostWebSearchOffered: false },
    ]) {
      expect(withHostPortGate(DEFS, callbacks).map(d => d.name), JSON.stringify(callbacks))
        .toEqual(['SubmitPlan', 'transform_data']);
    }
  });

  it('touches nothing else — the control that keeps it from becoming a wider filter', () => {
    const others = DEFS.filter(d => d.name !== 'web_search' && d.name !== 'ReviewDiff');
    expect(withHostPortGate(others, undefined)).toEqual(others);
    expect(withHostPortGate(others, { reviewDiff: PORT, hostWebSearchOffered: true })).toEqual(others);
  });

  it('translates the registry spelling into the gate\'s option spelling', () => {
    expect(hostPortOfferOptions(undefined)).toEqual({ reviewDiffPort: false, hostWebSearch: false });
    expect(hostPortOfferOptions({ reviewDiff: PORT, hostWebSearchOffered: true }))
      .toEqual({ reviewDiffPort: true, hostWebSearch: true });
  });

  it('the DEFINITIONS keep both tools, so the handler by-name refusal stays reachable', () => {
    // P3.276's whole reason: the classifier and the registry dispatch must go on
    // seeing a tool this builder does not advertise. If this ever goes false the
    // gate has been moved back INSIDE `getSessionToolDefs` and Explore refuses a
    // read-only diff again.
    const names = getSessionToolDefs({ includeDeveloperFeedback: true }).map(d => d.name);
    expect(names).toContain('ReviewDiff');
    expect(names).toContain('web_search');
  });
});
