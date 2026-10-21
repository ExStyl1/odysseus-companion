/**
 * P3.264 — a claude turn had no model fallback at all, from either side.
 *
 * The host owns a fallback CHAIN (`config/fallback-model-chain.ts`) and until
 * this row exactly one runtime read it: `PiAgent.getFallbackModel`. The SDK
 * offers `Options.fallbackModel` and nothing set it. So the failure was not a
 * duplication — it was host machinery that exists, a runtime mechanism that
 * exists, and neither reaching a claude session.
 *
 * `model-config.md#fallback-model-chains` is the contract:
 * *"Set a chain for one session with the `--fallback-model` flag, which accepts
 * a comma-separated list"*, and *"The `--fallback-model` flag takes precedence
 * over the `fallbackModel` setting."*
 *
 * Four claims, each failing in its own direction:
 *  - the OPTION is built, the primary filtered out, absent when empty;
 *  - it is WIRED into the one options literal that constructs the child, from
 *    the SAME resolver Pi reads;
 *  - it is a CONSTRUCTION option, so a changed chain respawns;
 *  - the SDK still spends it on `--fallback-model` AND still throws on an
 *    exact-equal primary — both measured on the shipped bundle, because that is
 *    the half a version bump can take away silently.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildClaudeFallbackModelOptions } from '../claude-agent.ts';
import { claudeLiveSessionSignature } from '../backend/claude/live-session.ts';
import {
  FALLBACK_MODEL_CHAIN_LIMIT,
  resolveFallbackModelChain,
} from '../../config/fallback-model-chain.ts';

const PRIMARY = 'claude-opus-4-6';
const ALT_A = 'claude-sonnet-5';
const ALT_B = 'claude-haiku-4-5';

function signatureOf(fields: Record<string, unknown>): string {
  return claudeLiveSessionSignature(
    { cwd: '/fixture/ws', ...fields } as unknown as Parameters<typeof claudeLiveSessionSignature>[0],
  );
}

function sdkBundleSource(): string {
  return readFileSync(require.resolve('@anthropic-ai/claude-agent-sdk'), 'utf8');
}

describe('P3.264 — the configured fallback chain reaches a claude turn', () => {
  it('joins the whole chain into one comma-separated option', () => {
    // The residual this row anticipated — "a Pi chain is a ladder, an SDK
    // fallback is one step" — does not exist at 0.3.233. The option takes the
    // list, so nothing is lost in the crossing.
    expect(buildClaudeFallbackModelOptions([ALT_A, ALT_B], PRIMARY))
      .toEqual({ fallbackModel: `${ALT_A},${ALT_B}` });
  });

  it('drops the primary from the chain — the SDK throws on it, and merely wastes a step inside it', () => {
    // Exact-equal is the SDK's own throw (pinned against the bundle below).
    expect(buildClaudeFallbackModelOptions([PRIMARY], PRIMARY)).toEqual({});
    // Contained-but-not-equal is WORSE than the throw, because it is silent: the
    // guard compares whole strings, so this chain would spawn and burn its first
    // attempt re-requesting the model that just failed.
    expect(buildClaudeFallbackModelOptions([PRIMARY, ALT_A], PRIMARY))
      .toEqual({ fallbackModel: ALT_A });
  });

  it('compares against the EFFECTIVE model, `[1m]` suffix included', () => {
    // The caller passes the same string it puts in `options.model`. Comparing
    // the bare id against a `[1m]`-suffixed primary would let the same model
    // ride along as its own fallback.
    const suffixed = `${PRIMARY}[1m]`;
    expect(buildClaudeFallbackModelOptions([suffixed, ALT_A], suffixed))
      .toEqual({ fallbackModel: ALT_A });
    // F1.1241 follow-up: `[1m]` is now appended by default for every 1M
    // `claude-` id while chain entries stay bare (the owner keeps `[1m]` out of
    // stored ids), so the bare id beside a suffixed primary is the SAME model —
    // dropped, as Pi's chain walk skips the current model.
    expect(buildClaudeFallbackModelOptions([PRIMARY], suffixed)).toEqual({});
    expect(buildClaudeFallbackModelOptions([PRIMARY, ALT_A], suffixed))
      .toEqual({ fallbackModel: ALT_A });
  });

  it('BOUNDARY — the selector is stripped to compare, never from what is kept', () => {
    // A DIFFERENT model that carries a selector stays, spelled as written.
    expect(buildClaudeFallbackModelOptions([`${ALT_A}[1m]`], `${PRIMARY}[1m]`))
      .toEqual({ fallbackModel: `${ALT_A}[1m]` });
    // A family prefix is not the same model: only the selector is removed.
    expect(buildClaudeFallbackModelOptions(['claude-opus-4'], `${PRIMARY}[1m]`))
      .toEqual({ fallbackModel: 'claude-opus-4' });
  });

  it('BOUNDARY — an empty or all-primary chain leaves the option absent, not empty', () => {
    // `{ fallbackModel: '' }` would reach the SDK's `if(h)` as falsy and spend
    // nothing, but it WOULD start appearing in the live-session signature and in
    // anything that diffs the option set. Absent means an install with no chain
    // spawns exactly as it did before this row.
    for (const chain of [[], [''], ['   '], [PRIMARY]]) {
      const options = buildClaudeFallbackModelOptions(chain, PRIMARY);
      expect(options).toEqual({});
      expect('fallbackModel' in options).toBe(false);
    }
  });

  it('is wired into the constructed child, from the same resolver Pi reads', () => {
    // The defect class this row belongs to is a mechanism with no caller, so the
    // wiring is the load-bearing half. It must read
    // `resolveFallbackModelChain(loadConfigDefaults()…, process.env)` — the one
    // reader that composes `NESSY_FALLBACK_MODEL` over the persisted setting, so
    // the two runtimes cannot disagree about which chain is in force.
    const source = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/\.\.\.buildClaudeFallbackModelOptions\(\s*\n\s*resolveFallbackModelChain\(/);
    expect(source).toContain('loadConfigDefaults().workspaceDefaults.fallbackModel');
    // The Pi side reads the same function; if either drifts to its own reader
    // this assertion is where the divergence surfaces.
    const piSource = readFileSync(new URL('../pi-agent.ts', import.meta.url), 'utf8');
    expect(piSource).toContain('resolveFallbackModelChain(');
  });

  it('is a CONSTRUCTION option — a changed chain respawns', () => {
    const base = signatureOf({});
    expect(signatureOf({ fallbackModel: ALT_A })).not.toBe(base);
    expect(signatureOf({ fallbackModel: `${ALT_A},${ALT_B}` })).not.toBe(signatureOf({ fallbackModel: ALT_A }));
    // And an unchanged chain is not a drift — otherwise every turn respawns.
    expect(signatureOf({ fallbackModel: ALT_A })).toBe(signatureOf({ fallbackModel: ALT_A }));
  });

  it('the host cap and the documented cap agree', () => {
    // `model-config.md#fallback-model-chains`: "Claude Code caps chains at three
    // models after duplicate removal and ignores extra entries." The host caps
    // too, so the number is applied twice and must not drift apart.
    expect(FALLBACK_MODEL_CHAIN_LIMIT).toBe(3);
    expect(resolveFallbackModelChain(['a', 'a', 'b', 'c', 'd'], {})).toEqual(['a', 'b', 'c']);
  });

  it('THE NATIVE MECHANISM, measured on the shipped bundle rather than quoted', () => {
    const bundle = sdkBundleSource();
    // The argv spend. If a bump stops emitting this, every assertion above still
    // passes and the feature is silently gone.
    expect(bundle).toContain('--fallback-model');
    // The throw the filter exists to avoid, quoted from the bundle's own text.
    expect(bundle).toContain('Fallback model cannot be the same as the main model');
    // POSITIVE CONTROL for the absence claim below: the three live setters that
    // DO exist are found by the same scan.
    for (const setter of ['setModel', 'setPermissionMode', 'setMcpServers']) {
      expect(bundle).toContain(setter);
    }
    // No live setter for the chain, which is what makes it a construction option.
    expect(bundle).not.toContain('setFallbackModel');
  });
});
