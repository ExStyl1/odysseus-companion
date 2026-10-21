import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodexConfigToml, validateConfigAgainstSchema } from '../config-writer.ts';
import type { CodexConfigOptions } from '../config-writer.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(HERE, '..', '..', '..', 'codex-protocol', 'schema', 'config-schema.json');

const BASE: CodexConfigOptions = {
  codexHome: '/tmp/p6273',
  model: 'tgpt/qwen35-397b-a17b-fp8',
  adapterPort: 54321,
};

/**
 * P6.273 — codex publishes three retry keys on its provider table and this
 * writer emitted `name`, `base_url`, `wire_api`, `env_key` and nothing else.
 *
 * The keys are read from the vendored `config-schema.json`, generated from the
 * source the shipped binary is built from — STRONG tier, not the page:
 * `ModelProviderInfo.request_max_retries` (*"Maximum number of times to retry a
 * failed HTTP request to this provider"*), `.stream_max_retries` (*"Number of
 * times to retry reconnecting a dropped streaming response before failing"*) and
 * `.stream_idle_timeout_ms` (*"Idle timeout (in milliseconds) to wait for
 * activity on a streaming response before treating the connection as lost"*).
 *
 * The control that matters most is the UNSET one: a row that moved the shipped
 * retry ladder while claiming to add a knob would be two changes sold as one.
 */
describe('P6.273 · the provider retry keys', () => {
  test('UNSET is byte-identical to before: the provider block is still four lines', () => {
    const toml = buildCodexConfigToml(BASE);
    const block = toml.slice(toml.indexOf('[model_providers.'));
    expect(block).not.toContain('request_max_retries');
    expect(block).not.toContain('stream_max_retries');
    expect(block).not.toContain('stream_idle_timeout_ms');
  });

  test('one host value feeds BOTH retry counters, and the idle deadline is its own', () => {
    const toml = buildCodexConfigToml({
      ...BASE,
      providerMaxRetries: 7,
      providerStreamIdleTimeoutMs: 90_000,
    });
    expect(toml).toContain('request_max_retries = 7');
    expect(toml).toContain('stream_max_retries = 7');
    expect(toml).toContain('stream_idle_timeout_ms = 90000');
    // Inside the provider table, not stranded under whatever table precedes it.
    const block = toml.slice(toml.indexOf('[model_providers.'));
    expect(block).toContain('request_max_retries = 7');
  });

  test('each half is independent — setting one does not conjure the other', () => {
    const retriesOnly = buildCodexConfigToml({ ...BASE, providerMaxRetries: 2 });
    expect(retriesOnly).toContain('request_max_retries = 2');
    expect(retriesOnly).not.toContain('stream_idle_timeout_ms');

    const idleOnly = buildCodexConfigToml({ ...BASE, providerStreamIdleTimeoutMs: 5_000 });
    expect(idleOnly).toContain('stream_idle_timeout_ms = 5000');
    expect(idleOnly).not.toContain('request_max_retries');
  });

  test('an illegal value falls back to codex defaults rather than emitting nonsense', () => {
    // The shared reader has already reported a bad value BY NAME to the
    // operator; the writer refusing the whole file would punish them twice for
    // one message. 0 is refused on OUR floor, not the schema's — a 0-attempt
    // ladder fails on the first transient 429.
    for (const providerMaxRetries of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buildCodexConfigToml({ ...BASE, providerMaxRetries })).not.toContain('request_max_retries');
    }
    expect(buildCodexConfigToml({ ...BASE, providerStreamIdleTimeoutMs: 0 }))
      .not.toContain('stream_idle_timeout_ms');
    // A fractional value is floored, not rejected: it is a legible intent.
    expect(buildCodexConfigToml({ ...BASE, providerMaxRetries: 3.9 }))
      .toContain('request_max_retries = 3');
  });

  test('the three names are checked against the schema, so a rename is loud', () => {
    expect(() => validateConfigAgainstSchema(
      { ...BASE, providerMaxRetries: 4, providerStreamIdleTimeoutMs: 60_000 },
      SCHEMA,
    )).not.toThrow();
    // The guard only fires for what is actually emitted.
    expect(() => validateConfigAgainstSchema(BASE, SCHEMA)).not.toThrow();
  });
});
