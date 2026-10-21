import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodexConfigToml, validateConfigAgainstSchema } from '../config-writer.ts';
import type { CodexConfigOptions } from '../config-writer.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(HERE, '..', '..', '..', 'codex-protocol', 'schema', 'config-schema.json');

const BASE: CodexConfigOptions = {
  codexHome: '/tmp/p6532',
  model: 'tgpt/qwen35-397b-a17b-fp8',
  adapterPort: 54321,
};

/**
 * P6.532, the codex projection — a declared BYO Bedrock connection routes to
 * codex's own built-in provider, and our loopback table comes off the config.
 *
 * The host half landed at `8bdf9d061` (`resolveCodexModelProvider`, the operator
 * switch, the ambient AWS chain refused BY CONSTRUCTION). This file pins the
 * writer half, and the two open questions the hand-off named are answered here
 * from the source the shipped binary is built from, `rust-v0.148.0` — STRONG
 * tier, not the page:
 *
 * - `built_in_model_providers` (`codex-rs/model-provider-info/src/lib.rs`)
 *   returns `amazon-bedrock` and `amazon-bedrock-runtime` beside `openai`, so
 *   the declared id resolves with NO table of ours. `Config::load_from_base_...`
 *   (`codex-rs/core/src/config/mod.rs`) then looks the id up in the merged map
 *   and fails the load when it is missing — "Model provider `<id>` not found".
 * - `validateConfigAgainstSchema`'s `requiredKeys` asserts that codex's SCHEMA
 *   declares a top-level property, not that our file contains the key, so
 *   suppressing the table needs no change there. Asserted below rather than
 *   argued, because the reading is what the row turns on.
 */
describe('P6.532 · a declared codex model provider', () => {
  test('the control: nothing declared is byte-identical to the loopback config', () => {
    const toml = buildCodexConfigToml(BASE);

    expect(toml).toContain('model_provider = "nessy_gateway"');
    // The whole four-line block, in order, exactly as it was written before the
    // option existed. A conditional that changed the DEFAULT arm would be a
    // reroute sold as a feature.
    expect(toml).toContain(
      '[model_providers.nessy_gateway]\n'
      + 'name = "Nessy Gateway"\n'
      + 'base_url = "http://127.0.0.1:54321/v1"\n'
      + 'wire_api = "responses"\n'
      + 'env_key = "COMPANY_LLM_API_KEY"\n',
    );
    expect(() => validateConfigAgainstSchema(BASE, SCHEMA)).not.toThrow();
  });

  test('a declared Bedrock connection pins codex\'s own provider and writes no table', () => {
    const opts: CodexConfigOptions = { ...BASE, declaredModelProvider: 'amazon-bedrock' };
    const toml = buildCodexConfigToml(opts);

    expect(toml).toContain('model_provider = "amazon-bedrock"');
    expect(toml).not.toContain('model_provider = "nessy_gateway"');
    // No table at all — not ours under a different key, and not one under the
    // built-in id either, which codex would refuse to take fields on.
    expect(toml).not.toContain('[model_providers.');
    // The two things a reader of the config would otherwise conclude are
    // available: a gateway endpoint, and a gateway credential slot.
    expect(toml).not.toContain('127.0.0.1:54321');
    expect(toml).not.toContain('env_key');
    // The schema guard is unchanged: `model_providers` is required of the
    // SCHEMA, not of the file.
    expect(() => validateConfigAgainstSchema(opts, SCHEMA)).not.toThrow();
  });

  test('the operator retry ceiling CANNOT follow a declared provider, and is dropped rather than mis-written', () => {
    // Measured from `merge_configured_model_providers`
    // (`codex-rs/model-provider-info/src/lib.rs`, `rust-v0.150.1`): a configured
    // entry under `amazon-bedrock` or `amazon-bedrock-runtime` may carry ONLY
    // `base_url`, `auth`, `http_headers` and `aws.*`; anything else is a hard
    // error — "only supports changing `base_url`, `auth`, `http_headers`,
    // `aws.profile`, and `aws.region`". So P6.273's ceiling has nowhere to go on
    // a Bedrock session: writing it would break config load, which discards the
    // WHOLE file. Dropping it is the honest outcome, and this pins it as a
    // decision rather than leaving it to be discovered as a defect.
    const declared = buildCodexConfigToml({
      ...BASE,
      declaredModelProvider: 'amazon-bedrock',
      providerMaxRetries: 7,
      providerStreamIdleTimeoutMs: 90_000,
    });

    expect(declared).not.toContain('request_max_retries');
    expect(declared).not.toContain('stream_max_retries');
    expect(declared).not.toContain('stream_idle_timeout_ms');

    // The positive control on the same rig: with nothing declared, the very
    // same values ARE written — so the assertion above is about the declared
    // arm and not about a broken option.
    const pinned = buildCodexConfigToml({
      ...BASE,
      providerMaxRetries: 7,
      providerStreamIdleTimeoutMs: 90_000,
    });
    expect(pinned).toContain('request_max_retries = 7');
    expect(pinned).toContain('stream_idle_timeout_ms = 90000');
  });

  test('the rest of the document does not move', () => {
    // Everything outside the provider pin and its table is identical between
    // the two arms. Written as a diff of lines rather than as a spot check,
    // because the failure this guards is a conditional spread that swallows a
    // neighbouring key — the shape that has cost this writer real measurements.
    const pinned = buildCodexConfigToml(BASE).split('\n');
    const declared = buildCodexConfigToml({ ...BASE, declaredModelProvider: 'amazon-bedrock' }).split('\n');

    const removed = pinned.filter(line => !declared.includes(line));
    expect(removed.sort()).toEqual([
      '[model_providers.nessy_gateway]',
      'base_url = "http://127.0.0.1:54321/v1"',
      'env_key = "COMPANY_LLM_API_KEY"',
      'model_provider = "nessy_gateway"',
      'name = "Nessy Gateway"',
      'wire_api = "responses"',
    ].sort());
    expect(declared.filter(line => !pinned.includes(line))).toEqual([
      'model_provider = "amazon-bedrock"',
    ]);
  });

  /**
   * The PRODUCER half's consequence: a declared session starts no adapter, so it
   * has no port to name. `adapterPort` became optional for that one case and the
   * exclusivity is enforced here rather than documented — a defaulted `0` would
   * emit `base_url = "http://127.0.0.1:0/v1"`, a config codex accepts and no
   * session can reach.
   */
  test('a declared session needs no adapter port', () => {
    const { adapterPort: _omitted, ...noPort } = BASE;

    expect(() => buildCodexConfigToml({ ...noPort, declaredModelProvider: 'amazon-bedrock' }))
      .not.toThrow();
  });

  test('and an ordinary session that omits the port is REFUSED, not defaulted', () => {
    const { adapterPort: _omitted, ...noPort } = BASE;

    expect(() => buildCodexConfigToml(noPort)).toThrow(/adapterPort is required/);
  });
});
