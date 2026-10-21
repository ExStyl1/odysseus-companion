/**
 * P3.234 — the sentence the host said about a control, against what the control
 * actually does.
 *
 * `codex-agent.ts` told the operator, on the auto-compaction-off path, that
 * *"model_context_window and model_auto_compact_token_limit are withheld, so
 * codex never auto-compacts"*. BOTH clauses were measured false:
 *
 *  - the window key is written in BOTH switch positions (P3.286 — withheld,
 *    codex falls back to a fabricated 272 000, above what the gateway
 *    publishes), so only the LIMIT key moves with the switch;
 *  - withholding the limit key disables nothing. `auto_compact_token_limit()`
 *    is `min(config, window * 9/10)` and falls back to the 90 % term with no
 *    config key at all — driven on the shipped binary, an OFF session compacted
 *    at 250 000 usage and did not at 240 000, with the controls in the same run.
 *
 * A diagnostic is the operator's only view of a control they cannot inspect, so
 * a false one is worse than none. Nothing pinned this string, which is how it
 * outlived the fix it described.
 *
 * WHAT EACH TEST KILLS:
 *  - "the writer does what the sentence claims" dies if the emission and the
 *    sentence drift apart in EITHER direction — it asks the real writer, so a
 *    future change to the keys fails here rather than leaving the prose behind.
 *  - "the retracted claims are gone" dies if the false sentence comes back.
 *  - "the honest claims are present" dies if the correction is watered down to
 *    something that no longer says a user cannot turn auto-compaction off.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildCodexConfigToml } from '@nessy-agent/codex-responses-adapter/config-writer';

const SOURCE = readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8');

function toml(autoCompactionEnabled: boolean): string {
  return buildCodexConfigToml({
    codexHome: '/tmp/w2s-codex-home',
    adapterPort: 1234,
    model: 'tgpt/qwen35-397b-a17b-fp8',
    contextWindow: 262_000,
    autoCompactionEnabled,
  });
}

describe('P3.234 · the off-switch diagnostic matches the config it describes', () => {
  it('the writer does what the sentence claims: the window is always written, only the limit moves', () => {
    const on = toml(true);
    const off = toml(false);
    // Both positions carry the catalogue window — the half the old sentence got
    // backwards, and the reason codex's derived limits stay inside the
    // endpoint's real ceiling.
    expect(on).toContain('model_context_window = 262000');
    expect(off).toContain('model_context_window = 262000');
    // Only the limit key moves.
    expect(on).toContain('model_auto_compact_token_limit =');
    expect(off).not.toContain('model_auto_compact_token_limit =');
  });

  it('the retracted claims are gone from the diagnostic', () => {
    // Both halves of the false sentence, each in the form the string carried.
    expect(SOURCE).not.toContain('so codex never auto-compacts');
    expect(SOURCE).not.toContain('model_auto_compact_token_limit are withheld');
  });

  it('the honest claims are present, including the posture', () => {
    expect(SOURCE).toContain('codex has NO off-switch');
    expect(SOURCE).toContain('it does not stop ');
    // The number the off position actually buys, and the one it moves from.
    // Matched around the escaped apostrophe the source carries (`codex\'s`),
    // which is why this asserts the two halves rather than the whole phrase.
    expect(SOURCE).toContain('from our 85% to');
    expect(SOURCE).toContain('own 90% of the context window');
    expect(SOURCE).toContain('the highest it will accept');
  });
});
