/**
 * P3.314 — the hosted `WebSearch` leaves the model's tool list on any
 * `claude-runtime` turn the local adapter has to TRANSLATE.
 *
 * Measured on the packaged 1.33.0 (W2-p PKG-3, run twice): through the gateway
 * the tool is dispatched, the row reads `completed`, and `searchCount` is 0 —
 * while `results[0]` carries the upstream model's own attempted tool call as
 * prose, with the SDK's *"REMINDER: You MUST include the sources above…"*
 * appended to it. A capability that reports success and does nothing, plus
 * third-party text carrying an imperative.
 *
 * `tools-reference.md#websearch-tool-behavior` (anchor verified on the rendered
 * page) is why withholding is a read rather than a choice: *"WebSearch runs a
 * query against Anthropic's web search backend"*, and for providers with no
 * server-side tool support the page states the outcome — *"deployments hosted on
 * Azure don't support server-side tools, so the WebSearch call fails"*.
 *
 * ## What these cases are really pinning
 *
 * The routers are built by the ADAPTER's own `buildClaudeRuntimeWireRouter`, not
 * by hand. That is the whole point: the withholding must agree with where the
 * request actually goes, and a stub router would let the two drift while the
 * tests stayed green — which is the shape of the defect being fixed, one layer
 * up.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import { bracedRegion } from '../../testing/source-regions.ts';
import {
  CLAUDE_HOSTED_WEB_SEARCH_TOOL,
  resolveClaudeHostedWebSearchWithheld,
} from '../claude-agent.ts';
import { buildClaudeRuntimeWireRouter } from '../backend/internal/drivers/anthropic.ts';
import type { UpstreamTarget } from '@nessy-agent/codex-responses-adapter/nestor-client';

const GATEWAY = { kind: 'nestor' } as const satisfies UpstreamTarget;
// `as const satisfies`, not `: UpstreamTarget` — the annotation widens this to
// the whole union and `baseUrl` stops being readable off it.
const BYO = { kind: 'openai-compatible', baseUrl: 'https://llm.example/v1' } as const satisfies UpstreamTarget;

function routerFor(
  models: readonly unknown[],
  upstream: UpstreamTarget,
): ((model: string) => UpstreamTarget | undefined) | null {
  return buildClaudeRuntimeWireRouter({ models } as never, upstream) ?? null;
}

describe('resolveClaudeHostedWebSearchWithheld (P3.314)', () => {
  it('names the tool by the only form the page admits', () => {
    // "WebSearch permission rules take no specifier. A bare `WebSearch` entry in
    // `allow` or `deny` is the only form."
    expect(CLAUDE_HOSTED_WEB_SEARCH_TOOL).toBe('WebSearch');
  });

  // The positive control, and the one that matters most: a session with no local
  // adapter is a subscription/API session talking to Anthropic's own endpoint,
  // where the tool is exactly what the page describes. Withholding there would
  // delete a working capability.
  it('keeps the tool on a session that has no local adapter', () => {
    expect(resolveClaudeHostedWebSearchWithheld({
      upstreamKind: null,
      wireRouter: null,
      model: 'claude-sonnet-4-6',
    })).toBe(false);
  });

  it('withholds on the gateway, where the router routes nothing by construction', () => {
    // `buildClaudeRuntimeWireRouter` returns undefined for `kind: 'nestor'`: the
    // corp gateway publishes no Anthropic Messages endpoint, so every gateway
    // turn is translated.
    const router = routerFor([{ id: 'tgpt/qwen35-397b-a17b-fp8', wire: 'anthropic-messages' }], GATEWAY);
    expect(router).toBeNull();
    expect(resolveClaudeHostedWebSearchWithheld({
      upstreamKind: 'nestor',
      wireRouter: router,
      model: 'tgpt/qwen35-397b-a17b-fp8',
    })).toBe(true);
  });

  it('withholds on a BYO endpoint whose models are all chat-completions', () => {
    const router = routerFor(['plain-model', { id: 'other' }], BYO);
    expect(router).toBeNull();
    expect(resolveClaudeHostedWebSearchWithheld({
      upstreamKind: 'openai-compatible',
      wireRouter: router,
      model: 'plain-model',
    })).toBe(true);
  });

  it('keeps the tool for a model that passes through natively', () => {
    const router = routerFor(
      [{ id: 'anthropic/claude-opus', wire: 'anthropic-messages' }, { id: 'qwen' }],
      BYO,
    );
    expect(router).not.toBeNull();
    expect(resolveClaudeHostedWebSearchWithheld({
      upstreamKind: 'openai-compatible',
      wireRouter: router,
      model: 'anthropic/claude-opus',
    })).toBe(false);
  });

  it('withholds for a translated model on the same connection as a passthrough one', () => {
    // One connection, two wires — the case the router exists for. The decision
    // has to be per model, not per session, or a mixed connection gets one
    // answer for both.
    const router = routerFor(
      [{ id: 'anthropic/claude-opus', wire: 'anthropic-messages' }, { id: 'qwen' }],
      BYO,
    );
    expect(resolveClaudeHostedWebSearchWithheld({
      upstreamKind: 'openai-compatible',
      wireRouter: router,
      model: 'qwen',
    })).toBe(true);
  });

  // P3.319. The call site asks with `effectiveModel`, and `chatImpl` appends
  // `[1m]` for a 1M-window model — so this case is the one where the two halves
  // used to agree on the WRONG answer: the router missed the suffixed id, the
  // adapter translated a turn its endpoint would have taken natively, and this
  // function withheld a tool that endpoint serves. Both are fixed by the same
  // normalisation, and this asserts the pair, not just the outcome.
  it('keeps the tool for a `[1m]`-suffixed id whose bare form routes natively', () => {
    const router = routerFor([{ id: 'anthropic/claude-opus', wire: 'anthropic-messages' }], BYO);
    expect(router?.('anthropic/claude-opus[1m]')).toEqual({
      kind: 'anthropic-messages',
      baseUrl: BYO.baseUrl,
    });
    expect(resolveClaudeHostedWebSearchWithheld({
      upstreamKind: 'openai-compatible',
      wireRouter: router,
      model: 'anthropic/claude-opus[1m]',
    })).toBe(false);
  });

  // The positive control the fix needs, and the reason it is here rather than in
  // the router's own file: normalising the suffix must not make an UNMARKED
  // model route natively. `qwen[1m]` strips to `qwen`, which is in the
  // catalogue and is NOT marked — so it still translates, and still withholds.
  // Without this, "strip the suffix" and "match everything" pass identically.
  it('still withholds for a suffixed id whose bare form is not marked', () => {
    const router = routerFor(
      [{ id: 'anthropic/claude-opus', wire: 'anthropic-messages' }, { id: 'qwen' }],
      BYO,
    );
    expect(router?.('qwen[1m]')).toBeUndefined();
    expect(resolveClaudeHostedWebSearchWithheld({
      upstreamKind: 'openai-compatible',
      wireRouter: router,
      model: 'qwen[1m]',
    })).toBe(true);
  });
});

/**
 * P6.148's claude arm — the HOST tool fills exactly the hole the withholding
 * leaves, and the two answers come from ONE resolver call.
 *
 * Asserted over the source text rather than by driving a turn, and the choice is
 * measured rather than lazy: the registration sits inside `chatImpl`, which
 * needs a spawned SDK child, a live local adapter and a session key before it
 * reaches the line — so a render-or-drive instrument here would price a whole
 * module graph to observe one assignment (AGENTS.md §Traps: a source-text
 * assertion is often the honest instrument for *does the value reach the
 * consumer*). The BEHAVIOUR of the gate itself is driven, one module over, by
 * `session-scoped-host-web-search.test.ts` over `withHostPortGate`.
 *
 * Two of these three cases are negatives, and each one is a defect that shipped
 * or nearly shipped rather than a hypothetical.
 */
describe('P6.148 — the host web-search offer is read from the withholding resolver', () => {
  const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');

  it('reads the verdict into one local and uses it for BOTH the withholding and the offer', () => {
    // The positive. `disallowedTools` and `hostWebSearchOffered` must be two
    // readings of one call: a second `resolveClaudeHostedWebSearchWithheld(...)`
    // beside the first would let a future edit move one and not the other, and
    // the failure mode is silent — a model shown two search tools, or none.
    expect(source).toContain('const hostedWebSearchWithheld = resolveClaudeHostedWebSearchWithheld({');
    expect(source).toContain('hostWebSearchOffered: hostedWebSearchWithheld');
    // Exactly one call inside the turn path; the other occurrences are the
    // export, the definition and the doc references.
    expect(source.split('resolveClaudeHostedWebSearchWithheld({').length - 1).toBe(1);
  });

  it('MERGES the offer instead of registering it, so the session keeps its other callbacks', () => {
    // The negative, and it is the bug this arm was handed with:
    // `registerSessionScopedToolCallbacks` does `registry.set(key, callbacks)` —
    // it REPLACES. Registering `{ hostWebSearchOffered }` alone would drop every
    // callback the session registered at init — the query seam, the advisor
    // consult, the spawn seam, the slash-command dispatch, the plan and auth
    // notifications — from a live session, and every one of those failures
    // looks like a different bug.
    expect(source).toContain('mergeSessionScopedToolCallbacks(sessionKey, { hostWebSearchOffered:');
    expect(source).not.toContain('registerSessionScopedToolCallbacks(sessionKey, { hostWebSearchOffered');
  });

  it('drops only THIS session\'s memoized tool list, never every session\'s', () => {
    // The second negative. The verdict is a property of one session's target
    // model, so a global invalidation would rebuild every other live session's
    // tool server to no purpose — and would hide a per-session bug behind a
    // cache that is always cold.
    //
    // Scoped to the OFFER BLOCK, not to the file: `claude-agent.ts` calls
    // `invalidateAllSessionToolsCaches` legitimately elsewhere, and a file-wide
    // `not.toContain` would have been satisfied only by deleting an unrelated
    // and correct call — a guard that fires on the wrong edit is the failure
    // mode AGENTS.md §Traps records for substring guards.
    const registration = source.indexOf('hostWebSearchOffered: hostedWebSearchWithheld');
    expect(registration, 'the offer registration is gone').toBeGreaterThan(0);
    // D1.111 — and the ANCHOR moves with the bound, which is the half a size
    // change would not have fixed: the `{` that opens the object literal on the
    // registration line sits BEFORE that needle, so a brace scan started there
    // would run to whatever block comes next and call it this one. The region is
    // the GUARD BLOCK holding the registration, anchored on its own `if`.
    const at = source.indexOf('if (this.hostWebSearchOfferedLast !== hostedWebSearchWithheld) {');
    expect(at, 'the per-session guard is gone').toBeGreaterThan(0);
    const block = bracedRegion(source, at);
    expect(block).toContain('hostWebSearchOffered: hostedWebSearchWithheld');
    expect(block).toContain('cleanupSessionScopedTools(sessionKey);');
    // BOUNDARY CONTROL: the next statement below the block. The `code` filter
    // below asserts on a DERIVED string, which no boundary gate can read as a
    // control for this region.
    expect(block).not.toContain('const resolvedCwd = this.resolveSpawnCwd(');
    // CODE only — the `//` lines are stripped first, and that is not tidiness.
    // The first draft of this assertion went red on the very commit that made
    // the code correct, because the comment stating *why* the global
    // invalidation is wrong SPELLS IT (AGENTS.md §Traps: a stale-NAME guard on
    // a bare identifier fires when the thing it guards has just been fixed).
    // Guard the CALL, in the code, or the guard is about prose.
    const code = block.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    expect(code).not.toContain('invalidateAllSessionToolsCaches');
  });
});
