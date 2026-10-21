/**
 * P2.436 — codex's compaction-prompt knob, which the writer wrote in neither
 * spelling.
 *
 * `model_auto_compact_token_limit` says WHEN codex compacts; `compact_prompt`
 * says WHAT it preserves. The first has been emitted since F7; the second was
 * missing, so a project's standing `Compact Instructions` reached the Pi runtime
 * and stopped at codex.
 *
 * ## Why the escaping matters more here than it looks
 *
 * codex fails a config that will not parse OPEN and WHOLE-FILE. That is not a
 * deduction from the docs — it was measured against the bundled
 * `codex-app-server` while this row was written: a single bad value on this very
 * key produced `configWarning` "Invalid configuration; using defaults." naming
 * `config.toml:4:18`. One unescaped quote in a steering block would therefore
 * take the model provider, the sandbox mode and every `deniedReadPath` with it.
 *
 * So these rows check the emitted line the way the binary reads it — parsed back
 * out of the file, not string-matched — and the value they push through carries
 * a quote, a backslash, real newlines and a non-ASCII character.
 *
 * The live arm (real binary, control-first) cannot live in this package: it
 * needs `@nessy-agent/codex-agent-server`, which depends on this one.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodexConfigToml, validateConfigAgainstSchema } from '../config-writer.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(HERE, '..', '..', '..', 'codex-protocol', 'schema', 'config-schema.json');

const BASE = {
  codexHome: '/tmp/p2436',
  model: 'tgpt/qwen35-397b-a17b-fp8',
  adapterPort: 54321,
} as const;

/**
 * Every character class that has ever broken a TOML emitter, in one value: the
 * double quote that terminates the string, the backslash that starts an escape,
 * the newline a basic string cannot contain literally, and a codepoint above
 * ASCII.
 */
const GNARLY = [
  '## Project compaction steering',
  '',
  'Preserve the "API contract" decisions and any \\ escaped paths.',
  'Keep the ↯ marker rows. Drop transcript chatter.',
].join('\n');

/** The top-level scalar block: everything before the first `[table]` header. */
function scalarBlock(toml: string): string[] {
  const lines = toml.split('\n');
  const firstTable = lines.findIndex(line => line.trimStart().startsWith('['));
  return (firstTable === -1 ? lines : lines.slice(0, firstTable)).filter(Boolean);
}

describe('P2.436 — compact_prompt', () => {
  test('is emitted as a top-level scalar, and survives the round trip byte-for-byte', () => {
    const toml = buildCodexConfigToml({ ...BASE, compactPrompt: GNARLY });

    // Read the way the binary reads it. A `toContain` on the escaped form would
    // pass for an escaping that TOML itself rejects.
    const parsed = Bun.TOML.parse(toml) as { compact_prompt?: unknown };
    expect(parsed.compact_prompt).toBe(GNARLY);

    // …and it must sit BEFORE the first table header. A key emitted after one
    // is a key inside that table — the trap `approvals_reviewer` already
    // records, and here it would silently become `[features].compact_prompt`.
    expect(scalarBlock(toml).some(line => line.startsWith('compact_prompt = '))).toBe(true);
  });

  test('is checked against the pinned schema, which is the ONLY detector for a rename', () => {
    // Measured against the bundled app-server: a wrong-TYPED value is loud and
    // takes the whole config with it, but an unknown top-level key produces
    // ZERO warnings — the identical config with this key renamed booted clean
    // and simply lost the steering. Nothing at runtime would report that, so the
    // drift guard is it.
    expect(() => validateConfigAgainstSchema({ ...BASE, compactPrompt: GNARLY }, SCHEMA)).not.toThrow();

    // …and the guard has to actually be armed by the option, not be vacuously
    // true: point it at a schema whose `compact_prompt` is gone and it must fail.
    const renamed = JSON.parse(readFileSync(SCHEMA, 'utf8')) as { properties: Record<string, unknown> };
    delete renamed.properties.compact_prompt;
    const patched = join(tmpdir(), `p2436-schema-${process.pid}-${Date.now()}.json`);
    writeFileSync(patched, JSON.stringify(renamed), 'utf8');
    try {
      expect(() => validateConfigAgainstSchema({ ...BASE, compactPrompt: GNARLY }, patched))
        .toThrow(/compact_prompt/);
      // …and stays silent when we are not writing the key at all.
      expect(() => validateConfigAgainstSchema({ ...BASE }, patched)).not.toThrow();
    } finally {
      rmSync(patched, { force: true });
    }
  });

  test('leaves codex its own default when there is nothing to say', () => {
    // Absent, empty and whitespace-only are one case: an empty `compact_prompt`
    // would REPLACE codex's built-in compaction prompt with nothing, which is
    // strictly worse than never writing the key.
    for (const compactPrompt of [undefined, '', '   ', '\n\t ']) {
      const toml = buildCodexConfigToml({ ...BASE, compactPrompt });
      expect({ compactPrompt, has: toml.includes('compact_prompt') }).toEqual({ compactPrompt, has: false });
      expect((Bun.TOML.parse(toml) as { compact_prompt?: unknown }).compact_prompt).toBeUndefined();
    }
  });

  test('is trimmed, so a composer’s trailing newline does not ride into the prompt', () => {
    const toml = buildCodexConfigToml({ ...BASE, compactPrompt: `\n\n${GNARLY}\n\n` });
    expect((Bun.TOML.parse(toml) as { compact_prompt?: string }).compact_prompt).toBe(GNARLY);
  });

  test('rides alongside the auto-compaction trigger rather than replacing it', () => {
    // WHEN and WHAT are independent knobs, and a session wants both: the limit
    // fires the compaction, the prompt steers what it keeps.
    const toml = buildCodexConfigToml({ ...BASE, contextWindow: 262_144, compactPrompt: GNARLY });
    const parsed = Bun.TOML.parse(toml) as Record<string, unknown>;

    expect(parsed.model_context_window).toBe(262_144);
    expect(typeof parsed.model_auto_compact_token_limit).toBe('number');
    expect(parsed.compact_prompt).toBe(GNARLY);
    // The rest of the file is still there — this is the whole-file failure mode
    // in miniature: if the added line broke the parse, these would be gone.
    expect(parsed.model_provider).toBe('nessy_gateway');
    expect(parsed.sandbox_mode).toBeDefined();
  });
});
