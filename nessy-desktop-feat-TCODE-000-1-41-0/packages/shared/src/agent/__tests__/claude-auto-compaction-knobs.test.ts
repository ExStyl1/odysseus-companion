/**
 * P3.235 — the two operator knobs, and the SDK semantics they are projected onto.
 *
 * Two halves, and the second is the one with standing value:
 *
 *  1. the projection itself (pure, table-driven);
 *  2. a MEASUREMENT of the shipped binary's own compaction arithmetic, pinned
 *     the way `claude-managed-settings.test.ts` pins the managed filter — by an
 *     anchor that is an ENV NAME rather than a minified symbol, with a positive
 *     and a negative control, and a DECLARED skip when the platform binary is
 *     absent. The forwarding is only correct while `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`
 *     is a percent in 1…100 and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is floored at
 *     100 000 / capped at 1 000 000. If either moves, this fails and names what
 *     to re-measure — which is the failure mode the module's residual-difference
 *     sentence would otherwise start lying about silently.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'
import {
  CLAUDE_AUTO_COMPACT_WINDOW_MAX,
  CLAUDE_AUTO_COMPACT_WINDOW_MIN,
  buildClaudeAutoCompactionKnobEnv,
  claudeAutoCompactionKnobDiagnostics,
} from '../claude-auto-compaction-knobs.ts'
import { resolveAutoCompactionSettings } from '../../config/auto-compaction-settings.ts'

describe('the operator knobs reach the SDK as the SDK spells them', () => {
  test('a percent and a window both cross, through the real resolver', () => {
    // Driven through `resolveAutoCompactionSettings` rather than a hand-built
    // object: the projection is only worth anything if it consumes what the host
    // actually produces from those two env names.
    const policy = resolveAutoCompactionSettings({
      env: { NESSY_AUTOCOMPACT_PCT_OVERRIDE: '50', NESSY_AUTO_COMPACT_WINDOW: '150000' },
    })
    expect(policy).toEqual({ enabled: true, thresholdPercent: 50, contextWindow: 150_000 })
    expect(buildClaudeAutoCompactionKnobEnv(policy)).toEqual({
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000',
    })
  })

  test('each knob crosses on its own', () => {
    expect(buildClaudeAutoCompactionKnobEnv({ enabled: true, thresholdPercent: 80 }))
      .toEqual({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '80' })
    expect(buildClaudeAutoCompactionKnobEnv({ enabled: true, contextWindow: 262_144 }))
      .toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '262144' })
  })

  test('an unset knob emits nothing, so a spawn without one is byte-identical', () => {
    expect(buildClaudeAutoCompactionKnobEnv({ enabled: true })).toEqual({})
    expect(buildClaudeAutoCompactionKnobEnv(undefined)).toEqual({})
    expect(buildClaudeAutoCompactionKnobEnv(resolveAutoCompactionSettings({ env: {} }))).toEqual({})
  })

  test('compaction OFF emits neither knob', () => {
    // `Uk()` short-circuits before either value is read, so a threshold beside
    // `DISABLE_AUTO_COMPACT` would describe behaviour the session does not have.
    // The negative control for the two positives above: this is the only input
    // shape that suppresses a knob that was set.
    const off = resolveAutoCompactionSettings({
      userEnabled: false,
      env: { NESSY_AUTOCOMPACT_PCT_OVERRIDE: '50', NESSY_AUTO_COMPACT_WINDOW: '150000' },
    })
    expect(off.enabled).toBe(false)
    expect(buildClaudeAutoCompactionKnobEnv(off)).toEqual({})
    expect(claudeAutoCompactionKnobDiagnostics(off)).toEqual([])
  })

  test('the value is emitted RAW — the min against the real window is the SDK\'s', () => {
    // A window far above any model's is NOT trimmed here. `v9` takes
    // `Math.min(modelWindow, configured)` itself, and re-doing it in the host
    // would be a second copy of a rule that can drift — the same reasoning
    // `buildClaudeAutoCompactWindowEnv` records for its own numbers.
    expect(buildClaudeAutoCompactionKnobEnv({ enabled: true, contextWindow: 900_000 }))
      .toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '900000' })
    // Past the SDK's own cap, which is the value that separates "emitted raw"
    // from "clamped by us against a bound we also declare" — a host-side
    // `Math.min(window, MAX)` is invisible below it and wrong above it.
    expect(buildClaudeAutoCompactionKnobEnv({ enabled: true, contextWindow: 2_000_000 }))
      .toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '2000000' })
  })
})

describe('the residual difference is reported, not smoothed', () => {
  test('a window under the SDK floor names both numbers and both runtimes', () => {
    const lines = claudeAutoCompactionKnobDiagnostics({ enabled: true, contextWindow: 50_000 })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('NESSY_AUTO_COMPACT_WINDOW=50000')
    expect(lines[0]).toContain(String(CLAUDE_AUTO_COMPACT_WINDOW_MIN))
    expect(lines[0]).toContain('Pi')
    // …and the knob still crosses. Reporting the clamp is not a reason to
    // withhold the value: 100 000 is nearer what the operator asked for than the
    // model's whole window is.
    expect(buildClaudeAutoCompactionKnobEnv({ enabled: true, contextWindow: 50_000 }))
      .toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '50000' })
  })

  test('a window above the SDK cap says so too', () => {
    const lines = claudeAutoCompactionKnobDiagnostics({ enabled: true, contextWindow: 2_000_000 })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(String(CLAUDE_AUTO_COMPACT_WINDOW_MAX))
  })

  test('a window INSIDE the range is silent, and so is a bare percent', () => {
    // The boundaries themselves, against the SDK's resting range rather than
    // against zero: at exactly the floor and exactly the cap the binary changes
    // nothing, so neither may produce a line.
    for (const window of [CLAUDE_AUTO_COMPACT_WINDOW_MIN, 262_144, CLAUDE_AUTO_COMPACT_WINDOW_MAX]) {
      expect(claudeAutoCompactionKnobDiagnostics({ enabled: true, contextWindow: window }), `${window}`)
        .toEqual([])
    }
    // The percent has no residual difference to report — same units, same
    // narrow-only clamp on both runtimes. A line here would be noise.
    expect(claudeAutoCompactionKnobDiagnostics({ enabled: true, thresholdPercent: 1 })).toEqual([])
    expect(claudeAutoCompactionKnobDiagnostics(undefined)).toEqual([])
  })
})

// ============================================================
// The measurement. Anchored on ENV NAMES, never on minified symbols — those do
// not survive a version bump, and the symbols this test needs (`vEo`, `jvs`) are
// RESOLVED out of the anchor's own argument list rather than written down.
// ============================================================

/**
 * The version the extraction below was measured against.
 *
 * Moved 0.3.223 → 0.3.233 by S0-3 (2026-09-03) only after both method probes
 * below were re-run green on the new bundle: the constant is not edited on its
 * own, exactly as the note in the pin test says. Both resolve their symbols out
 * of their own anchor's argument list, so the bump renamed everything around
 * them and neither moved — which is the difference between these two and the
 * two probes in `claude-auto-compact-window-env.test.ts` that DID break.
 *
 * Moved 0.3.233 → 0.3.247 by P7.1 (2026-09-10), same rule: both probes re-run
 * first. Both still MATCH — the window call is
 * `yN("CLAUDE_CODE_AUTO_COMPACT_WINDOW",process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,IWe,JRt)`
 * with the same floor and cap — but the second one stopped FINISHING, and that
 * is worth a sentence because it looks like a contract break and is not. Its
 * regex began `(\w+)\(`, i.e. unanchored, so the engine tried every offset of a
 * 233 MB string; the match sits at byte 190 533 194, about 82 % in, and the scan
 * cost 12.1 s against bun's 5 s per-test default. Measured on the same rig:
 * 12 109 ms for the regex, 15 ms for an `indexOf` of the two-part literal it
 * contains. So the probe now finds its window with that `indexOf` and runs the
 * capture-bound regex inside it — the same thing the percent probe above has
 * always done, and the method is unchanged: the symbols are still read out of
 * the anchor rather than written down.
 *
 * Moved 0.3.251 → 0.3.267 by F1.255 (2026-09-24), same rule: both probes were
 * re-run on the lifted bundle in the 121-file sweep and both passed unchanged
 * before this constant moved.
 *
 * Moved 0.3.267 → 0.3.274 by F1.1213 (2026-10-01), same rule: both probes
 * re-ran on the lifted bundle and passed unchanged before this constant moved.
 *
 * Moved 0.3.274 → 0.3.280 by UA12.211 (2026-10-10), same rule: the three
 * extraction files ran together on the lifted bundle (112 pass / 3 fail /
 * "Ran 115 tests across 3 files") and both probes here passed unchanged
 * before this constant moved.
 */
const MEASURED_SDK_VERSION = '0.3.280'

describe('P3.235 · the SDK counterparts, re-extracted by method', () => {
  const sdkPackage = (): { version: string } => JSON.parse(readFileSync(
    fileURLToPath(new URL('../../../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url)),
    'utf8',
  )) as { version: string }

  test('the vendored SDK is still the one the extraction was measured against', () => {
    expect(sdkPackage().version).toBe(MEASURED_SDK_VERSION)
  })

  test('the percent env is a percent in 1…100, and it can only narrow', () => {
    const text = binaryText()
    if (text === undefined) return
    // Positive control for the window: the producer really is the compaction
    // options builder, and it really reads OUR env name.
    const anchor = text.indexOf('process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE')
    expect(anchor).toBeGreaterThan(-1)
    // Wide enough to hold the CONSUMER as well as the producer: they are
    // separate functions in the same chunk, ~4 100 characters apart at 0.3.223.
    const region = text.slice(anchor - 8000, anchor + 8000)
    expect(region).toContain('enabled:')
    // Negative control for the region itself.
    expect(region).not.toContain('nessyNotARealSdkEnvVar')
    // The producer stores it as a float on a field the consumer reads…
    const field = /testPctOverride:\w+\?parseFloat\(\w+\):/.exec(region)
    expect(field, 'the percent env is no longer parsed into testPctOverride').not.toBeNull()
    // …and the consumer divides by 100 and takes the SMALLER of the two
    // thresholds. Both halves matter: `/100` is what makes our 1…100 the right
    // units, and `Math.min` is what makes the knob narrow-only on this runtime
    // exactly as `resolvePiAutoCompactionSettings` makes it narrow-only on Pi.
    const consumer = /let \w+=\w+-13000,(\w+)=\w+\.testPctOverride;if\(\1!==void 0&&!isNaN\(\1\)&&\1>0&&\1<=100\)return Math\.min\(Math\.floor\(\w+\*\(\1\/100\)\),\w+\)/
      .exec(region)
    expect(consumer, 'the percent is no longer a 1…100 percent clamped to the default threshold').not.toBeNull()
  })

  test('the window env is floored at our MIN and capped at our MAX', () => {
    const text = binaryText()
    if (text === undefined) return
    // Anchor: the env name inside the call that parses it. The bound symbols are
    // captured here rather than written down, which is the whole "pin the
    // method" instruction — a rename moves them and this still measures.
    //
    // The literal is located with `indexOf` FIRST and the regex is run inside a
    // small window (P7.1, 2026-09-10 — the docblock above has the measurement).
    // An unanchored `(\w+)\(` over the whole 233 MB binary costs 12 s and blew
    // the per-test budget on a bundle where the anchor had not moved at all.
    const literal = '"CLAUDE_CODE_AUTO_COMPACT_WINDOW",process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,'
    const at = text.indexOf(literal)
    expect(at, 'the window env is no longer parsed from its own name').toBeGreaterThan(-1)
    // Wide enough on the left for the callee symbol, on the right for both args.
    //
    // D1.111 — and this number is NOT that row's class, which is why it stays. A
    // source-text WINDOW bounds a REGION and rots in both directions; these two
    // bound a REGEX SCAN over a 233 MB minified binary, where the region that is
    // meant is bounded by the pattern's own captures. The comment above measures
    // what removing it costs (12 s per scan), and `bracedRegion` is for code
    // whose braces balance textually, which a minified artefact's do not.
    const windowStart = at - 64
    const call = /([\w$]+)\("CLAUDE_CODE_AUTO_COMPACT_WINDOW",process\.env\.CLAUDE_CODE_AUTO_COMPACT_WINDOW,([\w$]+),([\w$]+)\)/
      .exec(text.slice(windowStart, at + 256))
    expect(call, 'the window env is no longer parsed with a floor and a cap').not.toBeNull()
    const callIndex = windowStart + call!.index
    const minSymbol = call![2]!
    const maxSymbol = call![3]!
    // C3.380 (2026-09-13, the 0.3.247 -> 0.3.251 lift): this used to read a
    // +/-4 000 window around the CALL, on the assumption that a minified
    // constant is declared near its use. At 2.1.251 both are declared at byte
    // 154 582 379 (`…,rCe=1e5,YNe=1e6;`) and the call sits at 159 905 890 —
    // **5.3 MB apart** — so the probe returned `undefined` for values that had
    // not changed at all (1e5 / 1e6, the same two numbers). A distance is not a
    // property of the bundle; find the DECLARATION by its own literal, the same
    // "literal first, regex in a small window" method the anchor above uses,
    // rather than by guessing how far the minifier put it.
    const declared = (symbol: string): number | undefined => {
      const needle = `${symbol}=`
      for (let at2 = text.indexOf(needle); at2 !== -1; at2 = text.indexOf(needle, at2 + 1)) {
        const match = new RegExp(`(?:^|[^\\w$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=(\\d+(?:e\\d+)?)(?:[^\\w$]|$)`)
          .exec(text.slice(Math.max(0, at2 - 1), at2 + symbol.length + 16))
        if (match) return Number(match[1])
      }
      return undefined
    }
    expect(declared(minSymbol)).toBe(CLAUDE_AUTO_COMPACT_WINDOW_MIN)
    expect(declared(maxSymbol)).toBe(CLAUDE_AUTO_COMPACT_WINDOW_MAX)
    // And the resolver still mins the configured value against the model's own
    // window, which is why the projection emits the operator's number raw.
    const region = text.slice(callIndex, callIndex + 400)
    expect(region).toContain(`Math.max(${minSymbol},`)
    expect(region).toMatch(/window:Math\.min\(\w+,\w+\),configured:\w+,source:"env"/)
  })
})

/**
 * The bundled native CLI as text, or `undefined` with a DECLARED skip.
 *
 * Same rule as `claude-managed-settings.test.ts`: the binary is per-platform, so
 * this dimension is unmeasurable off darwin-arm64 — and the assertion that says
 * so must itself run, rather than the test passing in silence.
 */
function binaryText(): string | undefined {
  const binary = fileURLToPath(new URL(
    '../../../../../node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
    import.meta.url,
  ))
  try {
    return readFileSync(binary).toString('latin1')
  } catch {
    expect(process.platform === 'darwin' && process.arch === 'arm64').toBe(false)
    return undefined
  }
}
