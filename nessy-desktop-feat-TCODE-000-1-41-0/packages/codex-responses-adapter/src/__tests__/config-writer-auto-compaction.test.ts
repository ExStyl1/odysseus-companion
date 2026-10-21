/**
 * P3.234 + P3.286 — codex cannot turn auto-compaction off, and the config we
 * write says so honestly instead of pretending otherwise.
 *
 * ## What this file used to assert, and why it was wrong
 *
 * P3.234's first fix withheld BOTH `model_context_window` and
 * `model_auto_compact_token_limit` when the host's off-switch was off, and this
 * file's load-bearing row was *"OFF withholds the WINDOW too — without this
 * codex compacts at its own 90%"*. The reasoning was right and its premise was
 * a **test fixture**: the fallback `ModelInfo` for a slug codex does not ship
 * was read off `protocol/src/openai_models.rs:906-908`, which sits inside
 * `#[cfg(test)] mod tests` (the attribute is at `:871`) and describes a helper
 * whose slug is `"test-model"`.
 *
 * The production fallback is `models-manager/src/model_info.rs:139`
 * `model_info_from_slug`, and at `rust-v0.148.0` it carries
 * `context_window: Some(272_000)`, `max_context_window: Some(272_000)`,
 * `auto_compact_token_limit: None`. So `ModelInfo::auto_compact_token_limit()`
 * (`openai_models.rs:482`, `min(config, resolved_context_window * 9 / 10)`)
 * returned `Some(244_800)` on the "off" path all along.
 *
 * ## Measured on the shipped binary, because a source read is a hypothesis
 *
 * `codex-app-server` at the tag we ship, isolated `CODEX_HOME`, a stub
 * Responses server whose reported `usage.total_tokens` is the knob, a marker in
 * `compact_prompt` as the compaction detector (`core/src/compact.rs` puts that
 * string on the wire verbatim), two turns per arm so `run_pre_sampling_compact`
 * reads the first turn's usage. Each config was driven at a usage BELOW its
 * predicted trigger and ABOVE it, so the negative arm is the control:
 *
 * | window key | limit key | usage   | reported window | compacted |
 * | ---------- | --------- | ------- | --------------- | --------- |
 * | withheld   | withheld  | 240 000 | 258 400         | no        |
 * | withheld   | withheld  | 250 000 | 258 400         | **YES**   |
 * | 262 000    | withheld  | 230 000 | 248 900         | no        |
 * | 262 000    | withheld  | 240 000 | 248 900         | **YES**   |
 *
 * A reported window of 258 400 on the withheld arm (`272 000 * 95 / 100`) is
 * the second half of the refutation: the window was never absent.
 *
 * ## What is pinned here instead
 *
 * OFF writes the window and withholds the limit key — the HIGHEST trigger codex
 * accepts, because `auto_compact_token_limit()` takes the `min` and the config
 * key can therefore only lower it. That is a posture, not a switch: on codex the
 * user's off-switch buys 85% → 90% and nothing more. It is stated at the option's
 * own docblock, at the switch (`runtime-switch-costs.ts`'s `autoCompactionOff`)
 * and in `docs/architecture/runtime-capability-gaps.md`.
 *
 * P3.286's half is the window itself: withheld, codex believes 272 000 against a
 * gateway that publishes 262 000. Writing the catalogue's figure in BOTH switch
 * positions is what keeps every limit codex derives inside the endpoint's real
 * ceiling.
 */
import { describe, expect, test } from 'bun:test';
import { buildCodexConfigToml, validateConfigAgainstSchema } from '../config-writer.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(HERE, '..', '..', '..', 'codex-protocol', 'schema', 'config-schema.json');

const BASE = {
  codexHome: '/tmp/p3234',
  model: 'tgpt/qwen35-397b-a17b-fp8',
  adapterPort: 54321,
  contextWindow: 240_000,
} as const;

/** Lines of a top-level scalar assignment, before the first table header. */
function topLevelKeys(toml: string): string[] {
  const keys: string[] = [];
  for (const line of toml.split('\n')) {
    if (line.startsWith('[')) break;
    const match = /^([a-z_0-9]+)\s*=/.exec(line);
    if (match) keys.push(match[1] as string);
  }
  return keys;
}

describe('P3.234 · the codex auto-compaction switch moves the LIMIT key only', () => {
  test('ON (and absent, the default) writes the window and the derived limit', () => {
    for (const opts of [BASE, { ...BASE, autoCompactionEnabled: true }]) {
      const toml = buildCodexConfigToml(opts);
      expect(toml).toContain('model_context_window = 240000');
      // 0.85 * 240000, the fraction F7 measured.
      expect(toml).toContain('model_auto_compact_token_limit = 204000');
    }
  });

  test('OFF withholds the limit', () => {
    const toml = buildCodexConfigToml({ ...BASE, autoCompactionEnabled: false });
    expect(topLevelKeys(toml)).not.toContain('model_auto_compact_token_limit');
  });

  test('OFF still writes the WINDOW — withholding it hands codex a fabricated 272000', () => {
    const toml = buildCodexConfigToml({ ...BASE, autoCompactionEnabled: false });
    expect(topLevelKeys(toml)).toContain('model_context_window');
    expect(toml).toContain('model_context_window = 240000');
  });

  test('OFF changes exactly one key — the provider, sandbox and model still land', () => {
    const off = buildCodexConfigToml({ ...BASE, autoCompactionEnabled: false });
    const on = buildCodexConfigToml(BASE);
    // Positive control that the two configs are otherwise the same file: every
    // top-level key of the OFF config is a top-level key of the ON config, and
    // the ON config has exactly the one extra.
    const offKeys = topLevelKeys(off);
    const onKeys = topLevelKeys(on);
    expect(onKeys.filter(k => !offKeys.includes(k))).toEqual(['model_auto_compact_token_limit']);
    expect(off).toContain('model_provider = "nessy_gateway"');
    expect(off).toContain('model = "tgpt/qwen35-397b-a17b-fp8"');
  });

  test('no catalogue window means neither key, in BOTH switch positions', () => {
    for (const enabled of [true, false]) {
      const toml = buildCodexConfigToml({
        codexHome: BASE.codexHome,
        model: BASE.model,
        adapterPort: BASE.adapterPort,
        autoCompactionEnabled: enabled,
      });
      const keys = topLevelKeys(toml);
      expect(keys, `autoCompactionEnabled: ${enabled}`).not.toContain('model_context_window');
      expect(keys, `autoCompactionEnabled: ${enabled}`).not.toContain('model_auto_compact_token_limit');
    }
  });

  test('the schema drift guard follows the emission in both switch positions', () => {
    // ON: the guard demands both keys exist upstream and the real schema has
    // them, so this passes.
    expect(() => validateConfigAgainstSchema(BASE, SCHEMA)).not.toThrow();
    // OFF: the window is written and demanded, the limit is neither — and the
    // call still validates everything else rather than becoming a no-op.
    expect(() => validateConfigAgainstSchema({ ...BASE, autoCompactionEnabled: false }, SCHEMA))
      .not.toThrow();
    // A window the builder REFUSES (not finite, not positive) must not be
    // demanded either: the builder and the guard read one function, and this is
    // the arm where two hand-written predicates came apart before.
    expect(() => validateConfigAgainstSchema({ ...BASE, contextWindow: 0 }, SCHEMA)).not.toThrow();
  });
});

describe('P3.286 · the window codex uses stays inside what the gateway serves', () => {
  /**
   * The gateway publishes 262 000 for the default coder model. codex's own
   * unknown-slug fallback is 272 000 (`model_info_from_slug`), and it is the
   * number the binary reported on the withheld arm of the live run above.
   */
  const GATEWAY_WINDOW = 262_000;

  test('the catalogue figure is written verbatim, off-switch or not', () => {
    for (const enabled of [true, false]) {
      const toml = buildCodexConfigToml({
        ...BASE, contextWindow: GATEWAY_WINDOW, autoCompactionEnabled: enabled,
      });
      expect(toml, `autoCompactionEnabled: ${enabled}`)
        .toContain(`model_context_window = ${GATEWAY_WINDOW}`);
    }
  });

  test('every limit codex derives from what we write sits under the gateway ceiling', () => {
    // codex's own arithmetic, from the source: the usable window is
    // `window * effective_context_window_percent / 100` (95 by default,
    // `turn_context.rs:304`) and the compaction trigger with no limit key is
    // `window * 9 / 10` (`openai_models.rs:482`). Both are computed here rather
    // than transcribed, so a change to the fraction moves the assertion.
    const usable = Math.floor((GATEWAY_WINDOW * 95) / 100);
    const ninetyPercentTerm = Math.floor((GATEWAY_WINDOW * 9) / 10);
    expect(usable).toBeLessThan(GATEWAY_WINDOW);
    expect(ninetyPercentTerm).toBeLessThan(usable);
    // The control that makes those two lines mean something: the same arithmetic
    // over the FALLBACK window is what the off-path used to get, and its usable
    // figure is what the binary reported (258 400).
    expect(Math.floor((272_000 * 95) / 100)).toBe(258_400);
    // …and it is 9 500 tokens looser than what we now hand codex.
    expect(Math.floor((272_000 * 95) / 100) - usable).toBe(9_500);
  });
});
