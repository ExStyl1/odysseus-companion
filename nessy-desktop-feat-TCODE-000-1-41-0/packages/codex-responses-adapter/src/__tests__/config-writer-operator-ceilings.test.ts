/**
 * P3.348 and P3.347 — the writer half of the three host ceilings that bound on
 * Pi and claude and reached codex nowhere: `tool_output_token_limit`, and the
 * `[agents]` pair `max_concurrent_threads_per_session` / `max_depth`.
 *
 * All three follow ONE rule — only a value the operator set EXPLICITLY is
 * written — and each `describe` below records the measurement that rule rests
 * on. The producer half (an env var reaching these options at all) is
 * `shared/src/agent/__tests__/codex-explicit-operator-ceilings.test.ts`.
 *
 * ## P3.348's own history
 *
 * The host's tool-output ceiling binds on Pi (the ProcessStore ring) and on
 * claude (the env spelling the vendored binary reads) and, until this row, on
 * codex not at all — the shell runs inside the binary, so neither reader is on
 * the path, and `codexHome` is a fresh mkdtemp per session with no raw-TOML
 * passthrough, so there was no file for an operator to hand-edit either.
 *
 * ## What was measured before anything was written
 *
 * The row required codex's own default to be read FIRST, because a smaller
 * projection would show the model LESS than it sees today. At `rust-v0.148.0`:
 * the production fallback for a slug codex does not ship
 * (`models-manager/src/model_info.rs::model_info_from_slug`, the same function
 * P3.286 measured for the context window) carries
 * `truncation_policy: TruncationPolicyConfig::bytes(10_000)` — **10 000 BYTES**,
 * multiplied by 1.2 in `context_manager/history.rs::process_item`. The host's
 * own default read-back window is 30 000 characters, so a projection raises the
 * ceiling rather than lowering it.
 *
 * ## Why the leaf guards the value as well as the caller
 *
 * A wrong-TYPED value in this file is not an ignored key: measured on the
 * bundled binary for `compact_prompt = 42`, it yields `configWarning "Invalid
 * configuration; using defaults."`, and "using defaults" discards the WHOLE file
 * — provider block, sandbox mode, every denied path. So the emit is gated on a
 * finite integer >= 1 at the leaf, not only at the caller.
 *
 * That end-to-end arm reads the config off disk from a real CODEX_HOME: a
 * capture of the options object would pass for a writer that never emitted the
 * key.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCodexConfig } from '../config-writer.ts';

const MODEL = 'tgpt/qwen35-397b-a17b-fp8';

function configWith(over: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'p3348-home-'));
  try {
    writeCodexConfig({ codexHome: home, model: MODEL, adapterPort: 45123, ...over });
    return readFileSync(join(home, 'config.toml'), 'utf8');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('P3.347 · the [agents] subagent ceilings', () => {
  /**
   * WHICH BACKEND IS IN FORCE, measured before either key was written, because
   * the schema documents `max_depth` as *"Ignored by V2"*.
   *
   * Shipped `codex-app-server` (darwin-arm64), `experimentalFeature/list` over a
   * CODEX_HOME this writer produced, 2026-09-04, 114 features:
   *   `multi_agent`    stable, enabled TRUE,  defaultEnabled true
   *   `multi_agent_v2` stable, enabled FALSE, defaultEnabled false
   * and at `rust-v0.148.0` the key `multi_agent` IS `Feature::Collab` (V1) while
   * `multi_agent_version_override` selects V2 only when the second is enabled.
   * V1 is in force, so BOTH keys are live rather than one being inert.
   */
  test('both ceilings are emitted under one [agents] table when both are given', () => {
    const toml = configWith({ maxConcurrentSubagentThreads: 4, maxSubagentSpawnDepth: 2 });
    const parsed = Bun.TOML.parse(toml) as { agents?: Record<string, unknown> };
    expect(parsed.agents?.max_concurrent_threads_per_session).toBe(4);
    expect(parsed.agents?.max_depth).toBe(2);
  });

  test('either alone opens the table alone', () => {
    const concurrencyOnly = Bun.TOML.parse(configWith({ maxConcurrentSubagentThreads: 6 })) as { agents?: Record<string, unknown> };
    expect(concurrencyOnly.agents?.max_concurrent_threads_per_session).toBe(6);
    expect(concurrencyOnly.agents?.max_depth).toBeUndefined();
    const depthOnly = Bun.TOML.parse(configWith({ maxSubagentSpawnDepth: 1 })) as { agents?: Record<string, unknown> };
    expect(depthOnly.agents?.max_depth).toBe(1);
    expect(depthOnly.agents?.max_concurrent_threads_per_session).toBeUndefined();
  });

  test('neither given means no [agents] table at all', () => {
    expect(configWith({})).not.toContain('[agents]');
  });

  /**
   * KILLS a value the binary would refuse. The schema gives the concurrency key
   * `minimum: 1`, and a depth of 0 is a nesting ceiling that forbids the root
   * agent — and a wrong-TYPED value is measured to discard the WHOLE file.
   */
  for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
    test(`a ${String(bad)} ceiling emits nothing`, () => {
      const toml = configWith({ maxConcurrentSubagentThreads: bad, maxSubagentSpawnDepth: bad });
      expect(toml).not.toContain('[agents]');
    });
  }

  /**
   * PLACEMENT, one level down from the top-level trap: every key under
   * `[agents]` is a ROLE name, so a bare assignment after an `[agents.<role>]`
   * header becomes a field of that role — which `AgentRoleToml`
   * (`additionalProperties: false` over three fields) refuses.
   */
  test('the bare keys precede the first [agents.<role>] header', () => {
    const toml = configWith({
      maxSubagentSpawnDepth: 2,
      agents: [{
        key: 'reviewer',
        name: 'reviewer',
        description: 'reviews',
        systemPrompt: 'review things',
      }],
    });
    const bareAt = toml.indexOf('max_depth = 2');
    const roleAt = toml.indexOf('[agents.reviewer]');
    expect(bareAt).toBeGreaterThan(-1);
    expect(roleAt).toBeGreaterThan(-1);
    expect(bareAt).toBeLessThan(roleAt);
    const parsed = Bun.TOML.parse(toml) as { agents?: Record<string, unknown> };
    expect(parsed.agents?.max_depth).toBe(2);
    expect((parsed.agents?.reviewer as Record<string, unknown>).description).toBe('reviews');
    // POSITIVE CONTROL: nothing above was swallowed.
    expect((Bun.TOML.parse(toml) as Record<string, unknown>).model_provider).toBe('nessy_gateway');
  });
});

describe('P3.348 · tool_output_token_limit', () => {
  test('an explicit limit is emitted, and TOML-parses as an integer', () => {
    const toml = configWith({ toolOutputTokenLimit: 7500 });
    expect(toml).toContain('tool_output_token_limit = 7500');
    const parsed = Bun.TOML.parse(toml) as Record<string, unknown>;
    expect(parsed.tool_output_token_limit).toBe(7500);
  });

  /**
   * The default position, and the decision the row asked for: the two knobs are
   * not the same knob (characters of one tool's read-back vs tokens of every
   * stored output), so an operator who never set the host value keeps codex's
   * own default rather than having a Bash-shaped budget applied runtime-wide.
   */
  test('no option means no key — codex keeps its own default', () => {
    const toml = configWith({});
    expect(toml).not.toContain('tool_output_token_limit');
  });

  /**
   * KILLS the failure this file exists for: a value that reaches the binary and
   * takes the whole config down with it. Each of these is a shape a caller could
   * hand over from a parsed env var.
   */
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    test(`a ${String(bad)} budget emits nothing rather than a config the binary discards`, () => {
      expect(configWith({ toolOutputTokenLimit: bad })).not.toContain('tool_output_token_limit');
    });
  }

  test('a fractional budget is floored, never written as a float', () => {
    const toml = configWith({ toolOutputTokenLimit: 7500.6 });
    expect(toml).toContain('tool_output_token_limit = 7500');
    expect(toml).not.toContain('7500.6');
  });

  /**
   * PLACEMENT, and it is load-bearing rather than cosmetic: every key under
   * `[agents]` is a role name and `[features]`/`[otel]` are tables, so a bare
   * assignment emitted after any header lands INSIDE that table. The same trap
   * `compact_prompt` and `approvals_reviewer` each record at their own site.
   */
  test('the key sits before the first table header, so no table can swallow it', () => {
    const toml = configWith({ toolOutputTokenLimit: 7500 });
    const keyAt = toml.indexOf('tool_output_token_limit');
    const firstTableAt = toml.search(/^\[/m);
    expect(keyAt).toBeGreaterThan(-1);
    expect(firstTableAt).toBeGreaterThan(-1);
    expect(keyAt).toBeLessThan(firstTableAt);
    // POSITIVE CONTROL that the file is otherwise intact — a malformed top-level
    // block would take these with it.
    const parsed = Bun.TOML.parse(toml) as Record<string, unknown>;
    expect(parsed.model).toBe(MODEL);
    expect(parsed.model_provider).toBe('nessy_gateway');
  });
});
