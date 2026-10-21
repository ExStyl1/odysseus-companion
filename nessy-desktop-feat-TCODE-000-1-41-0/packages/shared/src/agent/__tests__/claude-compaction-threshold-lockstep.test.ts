/**
 * ONE compaction point, derived in two packages, with nothing between them.
 *
 * The Claude SDK never reports its auto-compaction threshold, so F4 computes
 * the composer's warning point from the window — `window − 20 000 − 13 000`,
 * `thresholdKind: 'formula-claude'` in the renderer's `context-meter-state.ts`.
 * F9 then made the SDK act on that same point by handing it the same window
 * (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `claude-agent.ts`), because the binary
 * applies the identical subtraction to whatever window it is given.
 *
 * The two derivations live in different packages and neither imports the other.
 * The failure that separation invites is silent and has a precedent in this very
 * lane: a composer that warns at one number while the runtime compacts at
 * another is indistinguishable, from the outside, from the defect F9 fixed —
 * a threshold nothing acts on. Nothing pinned them together; this is the pin.
 *
 * Live-proven pairing, `COMPACT-LIFE` claude arm, 2026-08-15: a catalogue
 * `contextWindow` of 240 000 on a run-owned gateway connection produced a
 * composer threshold of 207 000 and the SDK's own automatic `compact_boundary`
 * at `preTokens` 217 844 (`trigger: "auto"`, 217 844 → 14 748) — the first
 * automatic compaction this runtime has performed on this rig.
 *
 * The SDK's own arithmetic is a THIRD-PARTY contract, so it is written out here
 * as literals rather than imported from either side: if F4's constants drift,
 * or F9 stops handing over the catalogue window unchanged, this test fails
 * against the binary's behaviour instead of agreeing with whichever side moved.
 */
import { describe, expect, it } from 'bun:test';
import { buildClaudeAutoCompactWindowEnv } from '../claude-agent.ts';
import { resolveComposerCapabilities } from '../backend/composer-capabilities.ts';
import { resolveThreshold } from '../../../../../apps/electron/src/renderer/components/app-shell/input/context-meter-state.ts';
import { gatewayModelFixture } from '../../config/__tests__/fixtures/gateway-connection-fixture.ts';

/**
 * What the bundled SDK subtracts from its effective window before compacting:
 * `window − min(maxOutputTokens, 20 000) − 13 000` (v2.1.218, `wFe`/`pY_`; the
 * same subtraction `model-config.md` § *Default auto-compact thresholds*
 * describes). 20 000 is the ceiling of the first term, which is what both our
 * sides assume because this repo has no source for the effective max output.
 */
const SDK_OUTPUT_RESERVE = 20_000;
const SDK_COMPACT_BUFFER = 13_000;
const sdkCompactLevel = (window: number): number => window - SDK_OUTPUT_RESERVE - SDK_COMPACT_BUFFER;

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

/**
 * P6.784 — the row comes from the card's own builder, which is what puts
 * `supportsThinking: false` into it. Written by hand the field was absent, and
 * `ModelDefinition` documents it *"Defaults to true when undefined"* while both
 * shipped gateway rows declare `false`. Inert for the two numbers this file
 * compares — the window and the threshold — which is why nothing moved.
 */
function catalogue(window: number): Parameters<typeof buildClaudeAutoCompactWindowEnv>[0] {
  return {
    models: [{ ...gatewayModelFixture({ id: MODEL, contextWindow: window }), name: 'Qwen 3.5' }],
  } as unknown as Parameters<typeof buildClaudeAutoCompactWindowEnv>[0];
}

/** The window F9 hands the subprocess, as a number, or null when it emits none. */
function windowGivenToTheSdk(window: number): number | null {
  const env = buildClaudeAutoCompactWindowEnv(catalogue(window), MODEL) as Record<string, string>;
  const raw = env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  return raw === undefined ? null : Number(raw);
}

/** The number F4 draws the composer's warning against, for a claude session. */
function thresholdShownInTheComposer(window: number): number | null {
  return resolveThreshold({ thresholdKind: 'formula-claude', isProcessing: false }, window);
}

describe('the composer\'s compaction point and the SDK\'s are the same number', () => {
  it('agrees on the window F5 measured live', () => {
    // The three numbers of the live arm, in the order the product produces them.
    expect(windowGivenToTheSdk(240_000)).toBe(240_000);
    expect(thresholdShownInTheComposer(240_000)).toBe(207_000);
    expect(sdkCompactLevel(windowGivenToTheSdk(240_000)!)).toBe(207_000);
  });

  it('agrees across the windows this catalogue actually carries', () => {
    // The real spread on this profile: the gateway's own 262 144, the narrowed
    // 240 000 the live case writes, and the small models a BYO endpoint offers.
    for (const window of [262_144, 240_000, 200_000, 131_072, 100_000, 40_960]) {
      const given = windowGivenToTheSdk(window);
      expect(given, `no window emitted for ${window}`).toBe(window);
      expect(thresholdShownInTheComposer(window), `composer/SDK disagree at ${window}`)
        .toBe(sdkCompactLevel(given!));
    }
  });

  it('parts company only where the composer has nothing to draw', () => {
    // A window at or under the subtraction leaves no threshold to warn against,
    // and the composer says so rather than drawing a negative one. F9 still
    // emits the env — the value there buys a window SOURCE that is not "auto",
    // which is what makes the SDK's gate run at all, and the smallest models are
    // exactly the ones that overflow first. The asymmetry is deliberate on both
    // sides; it is pinned so that a change to either becomes visible.
    expect(thresholdShownInTheComposer(30_000)).toBeNull();
    expect(windowGivenToTheSdk(30_000)).toBe(30_000);
  });

  it('is the derivation a claude session really gets', () => {
    // Neither number above matters if the composer takes a different branch for
    // this runtime: `formula-claude` is what routes it into the subtraction,
    // and `real`/`none`/`legacy` would each show the user something else.
    expect(resolveComposerCapabilities({ provider: 'anthropic' }).contextUsage?.thresholdKind)
      .toBe('formula-claude');
  });
});
