import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';
import {
  CLAUDE_UNKNOWN_MODEL_ASSUMED_WINDOW,
  buildClaudeAutoCompactionEnv,
  buildClaudeAutoCompactWindowEnv,
  buildClaudeContextWindowWarning,
  buildClaudeMaxContextTokensEnv,
} from '../claude-agent.ts';
import { resolveAutoCompactionSettings } from '../../config/auto-compaction-settings.ts';
import { NESTOR_GATEWAY_MODEL_WINDOWS } from '../../auth/nestor.ts';
import { gatewayModelFixture } from '../../config/__tests__/fixtures/gateway-connection-fixture.ts';

/**
 * P6.784 — the card-shaped rows come from the card's own builder, which is what
 * puts `supportsThinking: false` into them; by hand the field was absent, and
 * `ModelDefinition` documents it *"Defaults to true when undefined"* while both
 * shipped gateway rows declare `false`.
 *
 * The last two rows stay hand-written and are not oversights: `tgpt/unsized`'s
 * subject is a catalogue entry with NO window (the builder seeds one) and
 * `tgpt/bare-string` is not an object at all.
 */
const gateway = {
  models: [
    { ...gatewayModelFixture({ id: 'tgpt/qwen35-397b-a17b-fp8', contextWindow: 262_144 }), name: 'Qwen 3.5' },
    { ...gatewayModelFixture({ id: 'tgpt/gateway-default', contextWindow: 240_000 }), name: 'Gateway default' },
    { ...gatewayModelFixture({ id: 'tgpt/small', contextWindow: 40_960 }), name: 'Small' },
    { id: 'tgpt/unsized', name: 'Unsized' },
    'tgpt/bare-string',
  ],
} as unknown as Parameters<typeof buildClaudeAutoCompactWindowEnv>[0];

/**
 * The one URL that is the Nessy Gateway, written out rather than imported: the
 * whole point of the gate below is that it is a WHOLE-URL match, and a test that
 * derived the literal from the implementation would agree with any change to it.
 * Same literal, same reason, as `upstream-target.test.ts`.
 */
const GATEWAY_BASE_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1';

/**
 * What the hourly `/cli/models` refresh actually leaves behind for a gateway
 * model the API reports and `NESTOR_GATEWAY_MODEL_WINDOWS` covers: the id, and
 * NO context window — the API does not report one, and `fetchNestorModels`
 * writes a window only from the API or that table
 * (`model-fetchers/__tests__/nestor.test.ts` pins both halves). The refresh
 * REPLACES the model list, so this shape is what a session then spawns on.
 */
const refreshedGateway = {
  baseUrl: GATEWAY_BASE_URL,
  models: [
    { id: 'tgpt/qwen35-397b-a17b-fp8', name: 'Qwen 3.5' },
    { id: 'tgpt/qwen36-35b-a3b-fp8', name: 'Qwen 3.6' },
    { id: 'tgpt/unknown-future', name: 'Future' },
  ],
} as unknown as Parameters<typeof buildClaudeAutoCompactWindowEnv>[0];

describe('buildClaudeAutoCompactWindowEnv', () => {
  it('turns the SDK auto-compaction on for a gateway spawn model', () => {
    // The measured defect, on the bundle it was measured on: at 2.1.218 the
    // binary's own gate skipped proactive compaction for every id it did not
    // recognise, because such an id resolved to auto-compact window source
    // "auto". F5 rode a session to 227 337 tokens of a 240 000 window with no
    // compaction and no error. On the 2.1.223 we ship the same env matters for a
    // DIFFERENT reason — see the P3.245 block at the bottom of this file — and
    // the minified names this comment used to quote no longer exist.
    expect(buildClaudeAutoCompactWindowEnv(gateway, 'tgpt/gateway-default'))
      .toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '240000' });

    expect(buildClaudeAutoCompactWindowEnv(gateway, 'tgpt/qwen35-397b-a17b-fp8'))
      .toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '262144' });
  });

  it('still sets a window below the documented 100k minimum', () => {
    // `env-vars.md` gives the range as 100000–1000000, and the binary floors the
    // CONFIGURED value at 100 000 — but it then takes
    // `Math.min(modelWindow, configured)`, so this model keeps its real 40 960
    // window and gains the one thing it was missing: a source that is not
    // "auto". Withholding the env here would leave exactly the smallest models
    // — the ones that overflow first — as the only ones that never compact.
    expect(buildClaudeAutoCompactWindowEnv(gateway, 'tgpt/small'))
      .toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '40960' });
  });

  it('is a plain integer, never a k-suffixed form', () => {
    // `env-vars.md`, the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` row: it "Accepts a
    // plain integer such as `500000` only: a value like `500k` reads as `500`
    // and clamps to the 100K minimum". A `k` form would silently become 100 000
    // and compact a 262k session at ~67k.
    const value = (buildClaudeAutoCompactWindowEnv(gateway, 'tgpt/qwen35-397b-a17b-fp8') as
      { CLAUDE_CODE_AUTO_COMPACT_WINDOW: string }).CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    expect(value).toMatch(/^\d+$/);
  });

  it('stays absent for a claude-* spawn model', () => {
    // Our choice, not the binary's: the window resolver reads this env for any
    // id, so a catalogue number here would override the SDK's own model-tuned
    // window.
    const anthropic = {
      models: [{ id: 'claude-opus-5', name: 'Opus 5', contextWindow: 200_000 }],
    } as unknown as Parameters<typeof buildClaudeAutoCompactWindowEnv>[0];
    expect(buildClaudeAutoCompactWindowEnv(anthropic, 'claude-opus-5')).toEqual({});
  });

  it('stays absent when nothing has stored a window for the spawn model', () => {
    // No window, no threshold: the binary would floor an unusable value at
    // 100 000 and compact a session at a size nobody measured.
    expect(buildClaudeAutoCompactWindowEnv(gateway, 'tgpt/unsized')).toEqual({});
    expect(buildClaudeAutoCompactWindowEnv(gateway, 'tgpt/bare-string')).toEqual({});
    expect(buildClaudeAutoCompactWindowEnv(gateway, 'tgpt/not-in-catalogue')).toEqual({});
    expect(buildClaudeAutoCompactWindowEnv(gateway, undefined)).toEqual({});
    expect(buildClaudeAutoCompactWindowEnv({ models: undefined } as never, 'tgpt/small')).toEqual({});
  });

  it('rejects a window that is not a usable number', () => {
    const broken = {
      models: [
        { id: 'a', name: 'a', contextWindow: 0 },
        { id: 'b', name: 'b', contextWindow: -1 },
        { id: 'c', name: 'c', contextWindow: Number.NaN },
      ],
    } as unknown as Parameters<typeof buildClaudeAutoCompactWindowEnv>[0];
    for (const id of ['a', 'b', 'c']) {
      expect(buildClaudeAutoCompactWindowEnv(broken, id)).toEqual({});
    }
  });

  it('describes the same model and the same number as the max-context env', () => {
    // The two are a pair: one tells the SDK how big the window is, the other
    // tells it to act on that size. A session where they disagree would compact
    // at a boundary that belongs to neither.
    for (const id of [
      'tgpt/gateway-default',
      'tgpt/qwen35-397b-a17b-fp8',
      'tgpt/small',
      'tgpt/unsized',
      'tgpt/not-in-catalogue',
      'claude-opus-5',
      undefined,
    ]) {
      const max = buildClaudeMaxContextTokensEnv(gateway, id) as Record<string, string>;
      const auto = buildClaudeAutoCompactWindowEnv(gateway, id) as Record<string, string>;
      expect(Object.keys(auto).length, `presence differs for ${id}`).toBe(Object.keys(max).length);
      expect(auto.CLAUDE_CODE_AUTO_COMPACT_WINDOW, `value differs for ${id}`)
        .toBe(max.CLAUDE_CODE_MAX_CONTEXT_TOKENS);
    }
  });

  it('falls back to the gateway window table the model fetcher already carries', () => {
    // A refresh that left the catalogue entries without a window — the live
    // `/cli/models` normally reports one now (`context_window_size`, measured
    // 2026-08-28), but a failed refresh, a hand-edited connection or a spawn
    // model no longer in the list all reproduce this shape, and the two ids
    // below are exactly the ones `NESTOR_GATEWAY_MODEL_WINDOWS` exists to
    // annotate. Before this fallback the catalogue lookup missed, both envs
    // stayed absent, and the session spawned with auto-compact window source
    // "auto", i.e. no proactive compaction at all.
    //
    // Asserted through the constant, not a literal. The table is now half
    // harvested (`scripts/refresh-nestor-model-windows.ts`) and resolves a
    // disagreement DOWNWARD, so its value moves when the gateway's does — a
    // hand-copied `'262144'` pinned this to one harvest and broke on the next.
    const qwen35 = String(NESTOR_GATEWAY_MODEL_WINDOWS['tgpt/qwen35-397b-a17b-fp8']);
    const qwen36 = String(NESTOR_GATEWAY_MODEL_WINDOWS['tgpt/qwen36-35b-a3b-fp8']);
    expect(buildClaudeAutoCompactWindowEnv(refreshedGateway, 'tgpt/qwen35-397b-a17b-fp8'))
      .toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: qwen35 });
    expect(buildClaudeAutoCompactWindowEnv(refreshedGateway, 'tgpt/qwen36-35b-a3b-fp8'))
      .toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: qwen36 });
    // Still in lockstep with the window env — one number, two variables.
    expect(buildClaudeMaxContextTokensEnv(refreshedGateway, 'tgpt/qwen35-397b-a17b-fp8'))
      .toEqual({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: qwen35 });
  });

  it('covers every entry the table carries, not just the two written above', () => {
    // Coverage, not values: a third gateway model added to the table must reach
    // the env too. Without this, the table grows and only the entries someone
    // remembered to hand-write here stay connected to compaction.
    for (const [id, window] of Object.entries(NESTOR_GATEWAY_MODEL_WINDOWS)) {
      const bare = {
        baseUrl: GATEWAY_BASE_URL,
        models: [{ id, name: id }],
      } as unknown as Parameters<typeof buildClaudeAutoCompactWindowEnv>[0];
      expect(buildClaudeAutoCompactWindowEnv(bare, id), `no window reached the env for ${id}`)
        .toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window) });
    }
  });

  it('prefers a stored window over the table, and the table only for the gateway URL', () => {
    // Stored wins: a user (or a future API that does report the field) owns the
    // number, and the table is the fallback, not an override.
    const stored = {
      baseUrl: GATEWAY_BASE_URL,
      models: [{ id: 'tgpt/qwen35-397b-a17b-fp8', name: 'Qwen 3.5', contextWindow: 131_072 }],
    } as unknown as Parameters<typeof buildClaudeAutoCompactWindowEnv>[0];
    expect(buildClaudeAutoCompactWindowEnv(stored, 'tgpt/qwen35-397b-a17b-fp8'))
      .toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '131072' });

    // A BYO endpoint on the SAME HOST under a different path is a different
    // deployment: it may serve a same-named id with a smaller real window, and a
    // window larger than the truth makes the SDK compact too late. Whole-URL
    // match, the same rule that decides whether `Nestor-Token` may be attached.
    const sameHostByo = {
      baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/other/v1',
      models: [{ id: 'tgpt/qwen35-397b-a17b-fp8', name: 'Qwen 3.5' }],
    } as unknown as Parameters<typeof buildClaudeAutoCompactWindowEnv>[0];
    expect(buildClaudeAutoCompactWindowEnv(sameHostByo, 'tgpt/qwen35-397b-a17b-fp8')).toEqual({});

    // And an id the table does not know stays absent even on the gateway itself:
    // the table is a record of measured windows, not a licence to invent one.
    expect(buildClaudeAutoCompactWindowEnv(refreshedGateway, 'tgpt/unknown-future')).toEqual({});
  });
});

describe('buildClaudeContextWindowWarning', () => {
  it('says out loud that a session with no window compacts against a guess', () => {
    // The durable half. `tgpt/unknown-future` is the shape
    // `model-fetchers/__tests__/nestor.test.ts` already pins as reaching the
    // catalogue unannotated — "Unknown model without an API window stays
    // unannotated (no faked value)" — and for such a model the SDK compacts
    // against a window it ASSUMES, with no error, no boundary and no event.
    // Nothing else in the product would say so.
    const warning = buildClaudeContextWindowWarning(refreshedGateway, 'tgpt/unknown-future');
    expect(warning.authWarningLevel).toBe('warning');
    // Names the model, or the user cannot act on it.
    expect(warning.authWarning).toContain('tgpt/unknown-future');
    // Names the capability that is degraded, not just that something is missing.
    expect(warning.authWarning).toContain('compact');
    // Names the number the SDK will actually use, which is the whole content of
    // the correction: an operator who reads "200,000" can compare it to their
    // model and see the direction of the error themselves.
    expect(warning.authWarning).toContain('200,000');
  });

  it('does NOT claim compaction is off — that sentence was true on 2.1.218 only', () => {
    // P3.245's regression guard, and the only assertion here that would have
    // caught the original defect. The bundle moved from 2.1.218 to 2.1.223, an
    // unrecognised id started resolving to `source: "unknown-model"` instead of
    // `"auto"`, the proactive gate began PASSING without our env — and this
    // message went on telling the operator the opposite of what the runtime
    // does. `CLAUDE_UNKNOWN_MODEL_ASSUMED_WINDOW` and the bundle measurement at
    // the bottom of this file are what keep the replacement honest.
    const warning = buildClaudeContextWindowWarning(refreshedGateway, 'tgpt/unknown-future');
    expect(warning.authWarning).not.toContain('compaction is OFF');
    expect(warning.authWarning).not.toContain('keep growing');
  });

  it('is silent whenever a window was resolved, from either tier', () => {
    expect(buildClaudeContextWindowWarning(gateway, 'tgpt/small')).toEqual({});
    expect(buildClaudeContextWindowWarning(refreshedGateway, 'tgpt/qwen35-397b-a17b-fp8')).toEqual({});
  });

  it('is silent where our abstention is deliberate rather than a gap', () => {
    // A `claude-*` id keeps the SDK's own model-tuned window on purpose, and a
    // spawn with no model at all has nothing to name. Warning about either would
    // train users to ignore the one case that matters.
    const anthropic = {
      models: [{ id: 'claude-opus-5', name: 'Opus 5', contextWindow: 200_000 }],
    } as unknown as Parameters<typeof buildClaudeContextWindowWarning>[0];
    expect(buildClaudeContextWindowWarning(anthropic, 'claude-opus-5')).toEqual({});
    expect(buildClaudeContextWindowWarning(gateway, undefined)).toEqual({});
  });

  it('fires exactly when the envs could not be built, for every shape', () => {
    // The invariant that keeps the two halves from drifting apart: a silent
    // no-op is precisely "no env and no warning", so that combination must be
    // unreachable for any real model id. Both connections, so the gateway
    // fallback tier is exercised rather than assumed.
    for (const [connection, ids] of [
      [gateway, ['tgpt/gateway-default', 'tgpt/small', 'tgpt/unsized', 'tgpt/bare-string', 'tgpt/absent']],
      [refreshedGateway, ['tgpt/qwen35-397b-a17b-fp8', 'tgpt/qwen36-35b-a3b-fp8', 'tgpt/unknown-future']],
    ] as const) {
      for (const id of ids) {
        const hasEnv = Object.keys(buildClaudeAutoCompactWindowEnv(connection, id)).length > 0;
        const hasWarning = !!buildClaudeContextWindowWarning(connection, id).authWarning;
        expect(hasEnv || hasWarning, `${id} is silent: no env and no warning`).toBe(true);
        expect(hasEnv && hasWarning, `${id} both compacts and warns`).toBe(false);
      }
    }
  });
});

/**
 * P6.53 — THE OFF-SWITCH SURVIVES A RUNTIME SWITCH.
 *
 * The defect: `resolveAutoCompactionSettings` is the host's ONE policy, and it
 * reached only the Pi backend. Switching a session to `claude-runtime` did not
 * merely default compaction back on — `buildClaudeAutoCompactWindowEnv` exists
 * to turn the SDK's proactive compaction ON for a gateway id, so the switch
 * ACTIVELY re-armed the thing the user had switched off, with no diagnostic.
 *
 * Nothing is invented here: `DISABLE_AUTO_COMPACT` is the SDK's own
 * per-session override (`settings-reference.md#autocompactenabled`:
 * "`DISABLE_AUTO_COMPACT` turns auto-compact off for one session; whichever of
 * the two turns it off, the other can't turn it back on"), and in the bundled
 * binary it short-circuits `Uk()` — the single gate every compaction decision
 * sits behind — before the window is ever consulted.
 */
describe('buildClaudeAutoCompactionEnv', () => {
  const ON = resolveAutoCompactionSettings({ env: {} });
  const OFF_BY_USER = resolveAutoCompactionSettings({ userEnabled: false, env: {} });
  const OFF_BY_POLICY = resolveAutoCompactionSettings({ managedEnabled: false, env: {} });
  const OFF_BY_ENV = resolveAutoCompactionSettings({ env: { DISABLE_AUTO_COMPACT: '1' } });

  it('emits the SDK off-switch INSTEAD OF the window that re-arms compaction', () => {
    // `tgpt/qwen35-397b-a17b-fp8` is the id that DOES resolve a window, so this
    // is the exact spawn the defect fired on: without the policy the same call
    // returns `CLAUDE_CODE_AUTO_COMPACT_WINDOW`.
    expect(buildClaudeAutoCompactWindowEnv(gateway, 'tgpt/qwen35-397b-a17b-fp8'))
      .toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '262144' });
    for (const off of [OFF_BY_USER, OFF_BY_POLICY, OFF_BY_ENV]) {
      const env = buildClaudeAutoCompactionEnv(gateway, 'tgpt/qwen35-397b-a17b-fp8', off);
      expect(env).toEqual({ DISABLE_AUTO_COMPACT: '1' });
      // The re-arm is GONE, not merely accompanied by a disable.
      expect(env).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
    }
  });

  it('leaves every ON spawn byte-identical to the window env it replaced', () => {
    // The default path must not move. `undefined` is the pre-P6.53 shape a
    // backend that never received a policy still sees.
    for (const policy of [undefined, ON]) {
      for (const connection of [gateway, refreshedGateway] as const) {
        for (const id of ['tgpt/qwen35-397b-a17b-fp8', 'tgpt/small', 'tgpt/unsized', 'tgpt/absent', undefined]) {
          expect(buildClaudeAutoCompactionEnv(connection, id, policy), `${String(id)} drifted`)
            .toEqual(buildClaudeAutoCompactWindowEnv(connection, id));
        }
      }
    }
  });

  it('turns it off even for a spawn that never had a window to withhold', () => {
    // `claude-*` and unresolvable ids emit no window at all, so withholding one
    // would disable nothing — the disable env has to be emitted on its own.
    const anthropic = {
      models: [{ id: 'claude-opus-5', name: 'Opus 5', contextWindow: 200_000 }],
    } as unknown as Parameters<typeof buildClaudeAutoCompactionEnv>[0];
    expect(buildClaudeAutoCompactionEnv(anthropic, 'claude-opus-5', OFF_BY_USER))
      .toEqual({ DISABLE_AUTO_COMPACT: '1' });
    expect(buildClaudeAutoCompactionEnv(refreshedGateway, 'tgpt/unknown-future', OFF_BY_USER))
      .toEqual({ DISABLE_AUTO_COMPACT: '1' });
  });

  it('stops warning about a session that is not compacting BECAUSE the user said so', () => {
    // Same id, same connection, opposite verdicts: the warning names a defect,
    // and once the switch is honoured the identical state is the setting working.
    expect(buildClaudeContextWindowWarning(refreshedGateway, 'tgpt/unknown-future').authWarningLevel)
      .toBe('warning');
    expect(buildClaudeContextWindowWarning(refreshedGateway, 'tgpt/unknown-future', OFF_BY_USER))
      .toEqual({});
    // …and it still fires while compaction is ON, so the silence is the policy's
    // and not a swallowed warning.
    expect(buildClaudeContextWindowWarning(refreshedGateway, 'tgpt/unknown-future', ON).authWarningLevel)
      .toBe('warning');
  });

  it('agrees with the Pi backend on the one setting both read', () => {
    // The switch-safety assertion. `resolveAutoCompactionSettings` is the only
    // producer of this policy and `pi-agent.ts` consumes `.enabled` from the
    // same object; if these two disagree, a runtime switch changes the answer.
    expect(OFF_BY_USER.enabled).toBe(false);
    expect(ON.enabled).toBe(true);
    expect(buildClaudeAutoCompactionEnv(gateway, 'tgpt/small', OFF_BY_USER))
      .toEqual({ DISABLE_AUTO_COMPACT: '1' });
    expect(buildClaudeAutoCompactionEnv(gateway, 'tgpt/small', ON)).not.toHaveProperty('DISABLE_AUTO_COMPACT');
  });
});

// ============================================================
// P3.245 · THE MEASUREMENT THE DOCBLOCK IS NOW PINNED TO.
//
// The defect this closes was not a wrong line of code: it was a comment that
// described bundle 2.1.218 while we shipped 2.1.223, and a user-facing warning
// derived from that comment which said the opposite of what the runtime does.
// Prose cannot hold a measurement, so the three facts the warning and
// `buildClaudeAutoCompactWindowEnv`'s docblock now rest on are asserted against
// the shipped binary instead — anchored on ENV NAMES and literal source strings,
// never on minified symbols, because the symbols are exactly what rotted (`pY_`,
// `cGe`, `dor`, `ylt`, `QI`, `vtn`, `NKc`, `MKc`, `JZn`, `XQt` all occur zero
// times at 2.1.223). Where a symbol IS needed it is captured out of the anchor's
// own text rather than written down.
//
// S0-3 (2026-09-03), re-measured on the 2.1.233 this bump ships: THE RULE ABOVE
// WAS RIGHT AND TWO OF THESE FOUR PROBES BROKE IT. Both wrote down `te`, the
// minified identifier of the env module, inside an otherwise symbol-free anchor
// — and `te` became `V`, so both regexes returned null and reported "the arm is
// gone" about arms that are byte-for-byte intact:
//
//   2.1.223  if(Uk()&&!te.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT…
//   2.1.233  if(vI()&&!V .CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT…
//
// An ENV NAME is stable; the OBJECT it hangs off is a minified symbol like any
// other. Both are now `\w+\.`, which is what "anchored on env names" meant. The
// third probe, which captures its symbol out of its own anchor, passed the bump
// untouched — it is the pattern to copy.
//
// The whole gate is intact at 2.1.233, renamed throughout: `hky`→`ulS`,
// `Uk`→`vI`, `aYe`→`i4e`, `v9`→`W9`, `YEe`→`Fye`, `Nfr`→`iNr`, `bmt`→`HPt`,
// `XL_`→`P8b`, `Gvs`→`g0r`, `war`→`nst`, `Ofr`→`dCr` (still 200000),
// `j7p`→`Jju`, `q7p`→`Yju`, `Yzo`→`_Mo`. `2.1.233` occurred 374 times in that
// binary and `2.1.223` zero times — OCCURRENCES (`grep -aoF … | wc -l`), the
// instrument named here because the same needle answers a different number by
// LINES and this reading did not say which it was (C3.294, 2026-09-12).
//
// And a version STRING count is not a reading of the bundle's version at all:
// re-measured on the vendored 2.1.247 binary, `2.1.247` scored 1561 lines /
// 1680 occurrences while `2.1.233` scored 1/1, `2.1.238` 1/1 and `2.1.223` 1/1
// — a binary that self-reports 2.1.247 still spells three versions it is not.
// Re-taken 2026-09-13 on the vendored 2.1.251 binary (C3.380's lift), which
// SHRANK 233 073 008 -> 197 171 680 bytes: `2.1.251` scores 1933 lines / 2052
// occurrences, `2.1.247` 1/1, `2.1.233` 1/1, `2.1.238` 1/1, and `2.1.223`
// **2 lines for 1 occurrence** — the sharpest form of the instrument rule in
// this file, since the two instruments disagree on a needle whose count is one.
// Negative control `9.9.999` 0/0. Instruments: `grep -ac` for lines,
// `grep -aoF … | wc -l` for occurrences.
// The two self-reports are the reading; see `MEASURED_CLAUDE_CODE_VERSION`.
// ============================================================

/**
 * The bundle the P3.245 re-measurement was taken against.
 *
 * Moved 2.1.233 → 2.1.247 by P7.1 (2026-09-10) after re-running all four probes
 * in this file, never on its own. All four still MATCH; one stopped FINISHING,
 * and the distinction is the point. The `CLAUDE_CODE_MAX_CONTEXT_TOKENS` chain
 * probe began `(\w+)=`, which the regex engine must try at every offset of a
 * 233 MB string: the match sits at byte 183 625 194 and the scan cost 11.7 s
 * against bun's 5 s per-test default, so a probe whose anchor had not moved at
 * all failed as a timeout. An `indexOf` of the literal env name finds three
 * candidate sites in 35 ms, and the regex now runs inside a window around each
 * — the method (capture the symbols out of the anchor) is unchanged.
 *
 * Moved 2.1.247 → 2.1.251 by C3.380 (2026-09-13), and this time TWO of the four
 * probes really had to be re-derived — the arm probe and the `"unknown-model"`
 * resolution were untouched:
 *
 *  1. **`\w` cannot match a minified name any more.** The predicate that
 *     compares the resolved window source to `"auto"` is called `$G` at 2.1.251,
 *     and `\w` is `[A-Za-z0-9_]` — no `$`. The probe reported "nothing compares
 *     the window source to 'auto' any more" about a line that is byte-for-byte
 *     present. Every identifier class in this file is `[\w$]` now, and the
 *     captured name is regex-escaped before it is interpolated, because a bare
 *     `$G` inside a `new RegExp` is an END ANCHOR followed by a `G` and matches
 *     nothing — the same silent null by a second route.
 *  2. **The `startsWith("claude-")` guard moved INTO a named predicate.** At
 *     2.1.247 the chain read `…&&!X(Y(Z)).startsWith("claude-"))return o`; at
 *     2.1.251 it reads `…&&Gw(e))return o`, where
 *     `function Gw(e){let t=Ot(e);return!t.startsWith("claude-")&&!PMe(Ye(t))}`
 *     — the same clause plus a second one. That is a REFACTOR, not a rename, so
 *     the probe asserts the named predicate's BODY still carries the
 *     `startsWith("claude-")` clause rather than only that the chain matched:
 *     a shape probe that stopped checking the meaning is the failure mode this
 *     whole block exists for. The assumed window is still 200000.
 *
 * Moved 2.1.251 → 2.1.267 by F1.255 (2026-09-24). Three probes matched
 * unchanged; the ARM probe had to be re-derived, because the arm gained a
 * predicate: `…&&!<fn>(e,r)&&!<fn>(e)&&!v&&!<fn>(e,o))return{…"unknown-model"}`,
 * where `v = p!==void 0&&p.believed===p.declared` and `p` is a per-model
 * DECLARED-window lookup (`function iIn(e,n){let r=<lookup>(e,n);if(r===void 0)
 * return;…}`) that is `undefined` for an id nothing declares a window for — a
 * gateway id — so `!v` is true and our ids still take the `"unknown-model"`
 * arm. The regex now admits any run of `&&!` predicates rather than exactly
 * three, and the sentence above ("its three predicates … all false") holds for
 * all four with the new one added.
 *
 * Moved 2.1.267 → 2.1.274 by F1.1213 (2026-10-01) on a driven run: every probe
 * in this file re-read the lifted binary and matched unchanged (the default
 * suite failed only on this constant) before it moved.
 *
 * Moved 2.1.274 → 2.1.280 by UA12.211 (2026-10-10), the same way: the three
 * extraction files ran together on the lifted bundle and redden only on their
 * three pin tests (112 pass / 3 fail / "Ran 115 tests across 3 files") — every
 * probe here matched the 2.1.280 binary unchanged before this constant moved.
 */
const MEASURED_CLAUDE_CODE_VERSION = '2.1.280';

describe('P3.245 · what the shipped bundle does with an id it does not know', () => {
  it('is still the bundle the docblock was re-measured against', () => {
    const manifest = JSON.parse(readFileSync(
      fileURLToPath(new URL('../../../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url)),
      'utf8',
    )) as { claudeCodeVersion?: string };
    expect(manifest.claudeCodeVersion).toBe(MEASURED_CLAUDE_CODE_VERSION);
  });

  it('resolves an unrecognised id to "unknown-model", not "auto"', () => {
    const text = binaryText();
    if (text === undefined) return;
    // The arm 2.1.218 did not have. Its three predicates are the `[1m]`/beta
    // check, the `application-inference-profile` check and the known-catalogue
    // lookup — all false for a gateway id — so this is the arm our ids take.
    const arm = /if\([\w$]+\(\)&&![\w$]+\.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT(?:&&![\w$]+(?:\([\w$]+(?:,[\w$]+)*\))?){3,}\)return\{window:([\w$]+),configured:\1,source:"unknown-model"\};return\{window:\1,configured:\1,source:"auto"\}/;
    expect(arm.exec(text), 'the unknown-model arm is gone — re-read the window resolver').not.toBeNull();
    // Negative control for the search itself.
    expect(text).not.toContain('source:"nessy-not-a-real-window-source"');
  });

  it('lets such a session THROUGH the proactive gate, which is why "OFF" was false', () => {
    const text = binaryText();
    if (text === undefined) return;
    // One function in the whole binary compares the resolved source to "auto",
    // and the gate consumes it negated: `…&&!<fn>(model, window)) return !1`.
    // So a source of "unknown-model" makes the predicate TRUE and the gate does
    // NOT bail — the exact inversion of the 2.1.218 behaviour the old warning
    // described. Its name is captured, never written down.
    const predicate = /function ([\w$]+)\([\w$]+,[\w$]+\)\{return [\w$]+\([\w$]+,[\w$]+\)\.source!=="auto"\}/.exec(text);
    expect(predicate, 'nothing compares the window source to "auto" any more').not.toBeNull();
    // The captured name is `$G` at 2.1.251, and a bare `$` inside `new RegExp`
    // is an END ANCHOR — interpolating it unescaped turns this assertion into a
    // pattern that can never match, i.e. a control that silently stops
    // controlling. Escape every regex metacharacter in a captured symbol.
    const name = predicate![1]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(new RegExp(`&&!${name}\\([\\w$]+,[\\w$]+\\)\\)return!1`).test(text)).toBe(true);
  });

  it('assumes exactly CLAUDE_UNKNOWN_MODEL_ASSUMED_WINDOW when we send no number', () => {
    const text = binaryText();
    if (text === undefined) return;
    // Anchor: the `CLAUDE_CODE_MAX_CONTEXT_TOKENS` arm of the window chain, whose
    // FINAL `return` is the constant used when neither that env nor ours is set
    // — the number the binary itself calls "the context window it assumes".
    // Candidate sites first, by an `indexOf` of the env name itself, then the
    // capture-bound regex inside each window (P7.1 — see the constant's note).
    // 2.1.251 extracted the `startsWith("claude-")` guard into a named
    // predicate: `…&&<pred>(model))return o;return <const>}`. The predicate's
    // own body is asserted below, so the MEANING is still pinned and not just
    // the shape.
    const pattern = /([\w$]+)=[\w$]+\.CLAUDE_CODE_MAX_CONTEXT_TOKENS;if\(\1!==void 0&&\1>0&&([\w$]+)\([\w$]+\)\)return \1;return ([\w$]+)\}/;
    let chain: RegExpExecArray | null = null;
    let chainIndex = -1;
    // D1.111 — this number is NOT the class that row converts, and the
    // difference is worth one line so the next sweep does not "fix" it. A
    // source-text WINDOW bounds a REGION and rots in both directions; this
    // bounds a REGEX SCAN over a 233 MB minified binary, and the region it means
    // is bounded by the pattern's own captures, not by the count. Removing it
    // costs 12 s per scan (the measurement is in the docblock above) and
    // `bracedRegion` cannot be used on a minified artefact at all. Left as it
    // is, deliberately.
    for (let at = text.indexOf('.CLAUDE_CODE_MAX_CONTEXT_TOKENS;'); at !== -1;
      at = text.indexOf('.CLAUDE_CODE_MAX_CONTEXT_TOKENS;', at + 1)) {
      const windowStart = at - 64;
      const hit = pattern.exec(text.slice(windowStart, at + 512));
      if (hit) {
        chain = hit;
        chainIndex = windowStart + hit.index;
        break;
      }
    }
    expect(chain, 'the max-context-tokens arm moved — re-read the window chain').not.toBeNull();
    // The guard the chain now delegates to still excludes `claude-` ids — the
    // clause that makes this the arm OUR gateway ids take. Measured 2026-09-13
    // at 2.1.251: `function Gw(e){let t=Ot(e);return!t.startsWith("claude-")&&!PMe(Ye(t))}`.
    const guardName = chain![2]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const guard = new RegExp(`function ${guardName}\\([\\w$]+\\)\\{[^}]{0,200}?startsWith\\("claude-"\\)`)
      .exec(text);
    expect(guard, 'the max-context-tokens guard no longer excludes `claude-` ids').not.toBeNull();
    const constName = chain![3]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declared = new RegExp(`\\b${constName}=(\\d+(?:e\\d+)?)`)
      .exec(text.slice(chainIndex - 8000, chainIndex + 8000));
    expect(declared).not.toBeNull();
    expect(Number(declared![1])).toBe(CLAUDE_UNKNOWN_MODEL_ASSUMED_WINDOW);
    // …and the binary says so in words, which is what the warning paraphrases.
    expect(text).toContain('the context window it assumes');
  });
});

/**
 * The bundled native CLI as text, or `undefined` with a DECLARED skip.
 *
 * Same rule as `claude-auto-compaction-knobs.test.ts` and
 * `claude-managed-settings.test.ts`: the binary is per-platform, so this
 * dimension is unmeasurable off darwin-arm64 — and the assertion that says so
 * must itself run, rather than the test passing in silence.
 */
let binaryTextCache: { text: string | undefined } | undefined;

function binaryText(): string | undefined {
  // Memoised because the artefact is 233 MB at the vendored 2.1.247
  // (233 073 008 bytes, measured 2026-09-12; it was 307 MB at 2.1.233 and
  // 272 MB at 2.1.223 — it SHRANK across this lift, which is why no comment in
  // this tree may explain a count by "the bundle grew") and
  // four tests read it: un-memoised, the last of them overran the 5 s default
  // by 3x on this bump while the file itself had not changed. The cache holds
  // `undefined` too, so the off-platform arm still runs its declared assertion
  // once rather than being skipped.
  if (binaryTextCache) return binaryTextCache.text;
  const binary = fileURLToPath(new URL(
    '../../../../../node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
    import.meta.url,
  ));
  try {
    binaryTextCache = { text: readFileSync(binary).toString('latin1') };
  } catch {
    expect(process.platform === 'darwin' && process.arch === 'arm64').toBe(false);
    binaryTextCache = { text: undefined };
  }
  return binaryTextCache.text;
}
