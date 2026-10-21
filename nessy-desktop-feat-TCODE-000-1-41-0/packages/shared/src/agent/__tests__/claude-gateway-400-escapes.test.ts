/**
 * P6.374 — the two gateway-400 escapes the SDK ships and we set neither.
 *
 * `llm-gateway-connect.md#troubleshoot-gateway-errors` names both by variable,
 * one per failure class, and this is the claude runtime's own mechanism rather
 * than anything host-built — native-first case (1). Measured in the shipped
 * bundle at HEAD: `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` 6 occurrences,
 * `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` 7, control
 * `CLAUDE_CODE_NOT_A_REAL_NAME` 0, positive control
 * `CLAUDE_CODE_ATTRIBUTION_HEADER` 3 (a name we already set) — and 0 production
 * hits in-tree before this row.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildClaudeGatewayEscapeEnv } from '../claude-agent.ts';

describe('P6.374 the gateway-400 escapes', () => {
  it('sets nothing on a connection that asked for nothing', () => {
    expect(buildClaudeGatewayEscapeEnv({})).toEqual({});
    expect(buildClaudeGatewayEscapeEnv({
      disableAdaptiveThinking: false,
      disableExperimentalBetas: false,
    })).toEqual({});
  });

  it('carries each escape independently — the page says one does not imply the other', () => {
    // "The variable doesn't affect adaptive reasoning, which is selected by
    // model rather than by beta" — so the betas flag cannot stand in for the
    // thinking flag, and one knob spanning both would be wrong on one of them.
    expect(buildClaudeGatewayEscapeEnv({ disableAdaptiveThinking: true }))
      .toEqual({ CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1' });
    expect(buildClaudeGatewayEscapeEnv({ disableExperimentalBetas: true }))
      .toEqual({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' });
    expect(buildClaudeGatewayEscapeEnv({
      disableAdaptiveThinking: true,
      disableExperimentalBetas: true,
    })).toEqual({
      CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    });
  });

  it('is `1`, never a falsy string', () => {
    // The neighbouring `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is the
    // variable where `0` still disables; these two are ordinary booleans and the
    // page writes `=1` for each, so "off" is an ABSENT key.
    const env = buildClaudeGatewayEscapeEnv({ disableAdaptiveThinking: true });
    expect(Object.values(env)).toEqual(['1']);
  });

  it('reaches the adapter child, on the gateway path only', () => {
    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf-8');
    // The one call site, inside `startLocalAdapterRuntime`'s `envOverrides` —
    // which is the adapter path. A subscription session talks to
    // api.anthropic.com, where neither 400 class arises.
    expect(source).toContain('...buildClaudeGatewayEscapeEnv(connection),');
    const calls = source.split('buildClaudeGatewayEscapeEnv(connection)').length - 1;
    expect(calls).toBe(1);
  });

  it('leaves the reactive removal list alone — it refuses `thinking` on purpose', () => {
    const negotiation = readFileSync(
      new URL('../../../../codex-responses-adapter/src/anthropic/passthrough-negotiation.ts', import.meta.url),
      'utf-8',
    );
    // The module names `thinking` among the fields it must never silently
    // rewrite, which is why the escape is a per-connection variable rather than
    // a wider removable set. If this stops being true, the row's reasoning
    // needs re-reading, not this assertion deleting.
    expect(negotiation).toContain('thinking');
  });
});
