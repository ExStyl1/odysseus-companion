/**
 * P6.96 · an operator's two auto-compaction knobs, and the three different
 * things they mean.
 *
 * `NESSY_AUTO_COMPACT_WINDOW` and `NESSY_AUTOCOMPACT_PCT_OVERRIDE` reach every
 * backend through `resolveAutoCompactionSettings`, and exactly two consume
 * them. Pi narrows to any value. Claude narrows to any value at or above the
 * SDK's own 100 000 floor, silently clamping anything smaller. Codex reads
 * NEITHER — its trigger is the host's own constant over the catalogue window.
 *
 * All three were true before this row and none of them was VISIBLE: the claude
 * clamp was stated only under `this.debug(...)`, which a packaged build never
 * writes, and codex said nothing at all. A control that silently stops
 * controlling is the defect; the fix is two existing notice channels and one
 * switch-report row, and no new channel.
 *
 * The two arms are source-matched, which is the precedent P3.267's own lift set
 * in `claude-launcher-drop-notice.test.ts`: the emission sits inside a spawn
 * path that needs a live SDK or a live app-server to reach, and the proposition
 * is about WHICH CHANNEL it goes to. The claims underneath are driven — the
 * producer for claude, the real config writer for codex.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildCodexConfigToml } from '@nessy-agent/codex-responses-adapter/config-writer';
import { claudeAutoCompactionKnobDiagnostics } from '../claude-auto-compaction-knobs.ts';
import { resolveAutoCompactionSettings } from '../../config/auto-compaction-settings.ts';

const CLAUDE_SOURCE = readFileSync(fileURLToPath(new URL('../claude-agent.ts', import.meta.url)), 'utf8');
const CODEX_SOURCE = readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8');
const EN: Record<string, string> = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../i18n/locales/en.json', import.meta.url)), 'utf8'),
);

/** The statement plus a little of what follows it, brace-free and enough to read the sink. */
function around(source: string, needle: string, span = 260): string {
  const at = source.indexOf(needle);
  expect(at, `probe found nothing for: ${needle}`).toBeGreaterThan(0);
  return source.slice(at, at + span);
}

describe('P6.96 · the knobs reach the runtimes that read them', () => {
  it('both env names are read into the shared settings, on every backend', () => {
    // The premise the whole row rests on: the operator's variables DO arrive.
    // If this went silent the two arms below would be reporting nothing.
    const resolved = resolveAutoCompactionSettings({
      env: { NESSY_AUTO_COMPACT_WINDOW: '50000', NESSY_AUTOCOMPACT_PCT_OVERRIDE: '70' },
    });
    expect(resolved).toMatchObject({ enabled: true, contextWindow: 50_000, thresholdPercent: 70 });
  });
});

describe('P6.96 · claude reports its clamp on the transcript, not to debug', () => {
  it('the postInit emission goes to the latched notice channel', () => {
    const site = around(CLAUDE_SOURCE, 'for (const line of claudeAutoCompactionKnobDiagnostics(');
    expect(site).toContain('this.queueDegradationNotice(line)');
    expect(site).not.toContain('this.debug(line)');
    // Positive control on the same probe: `this.debug(` is still spelled that
    // way elsewhere in this file, so a passing assertion above is about THIS
    // call site and not about a renamed method.
    expect(CLAUDE_SOURCE).toContain('this.debug(');
  });

  it('says which number the session will really use', () => {
    const [line] = claudeAutoCompactionKnobDiagnostics({ enabled: true, contextWindow: 50_000 });
    expect(line).toContain('50000');
    expect(line).toContain('100000');
    // And it names the divergence rather than only the clamp: the same variable
    // means a different number on Pi, which is what a switch report has to
    // agree with.
    expect(line).toContain('Pi session');
  });

  it('NEGATIVE CONTROL: an unset or in-range knob produces no banner', () => {
    expect(claudeAutoCompactionKnobDiagnostics(undefined)).toEqual([]);
    expect(claudeAutoCompactionKnobDiagnostics({ enabled: true })).toEqual([]);
    expect(claudeAutoCompactionKnobDiagnostics({ enabled: true, contextWindow: 200_000 })).toEqual([]);
    // Off means the knobs cannot bind at all, so there is nothing to report.
    expect(claudeAutoCompactionKnobDiagnostics({ enabled: false, contextWindow: 50_000 })).toEqual([]);
  });
});

describe('P6.96 · codex says the knobs do nothing there, which it did not', () => {
  it('the notice is guarded on either knob being set, and names both', () => {
    const site = around(CODEX_SOURCE, 'const knobs = this.config.autoCompaction;', 1400);
    expect(site).toContain('knobs?.contextWindow !== undefined || knobs?.thresholdPercent !== undefined');
    expect(site).toContain('NESSY_AUTO_COMPACT_WINDOW=');
    expect(site).toContain('NESSY_AUTOCOMPACT_PCT_OVERRIDE=');
    expect(site).toContain('surfaceCodexOperatorNotice');
    // NEGATIVE CONTROL, at the source: the guard also refuses an OFF session,
    // where the off-switch diagnostic above already speaks and a second line
    // about knobs that cannot bind would be noise.
    expect(site).toContain("knobs?.enabled !== false");
  });

  it('the inertness is real: the config writer takes no knob at all', () => {
    // Driven, not read. The only compaction inputs `buildCodexConfigToml`
    // accepts are the CATALOGUE window and the off-switch, so there is no
    // parameter an operator's value could travel on — and the limit it writes
    // is the host's own fraction of that window.
    const toml = buildCodexConfigToml({
      codexHome: '/tmp/p696-codex-home',
      adapterPort: 1234,
      model: 'tgpt/qwen35-397b-a17b-fp8',
      contextWindow: 262_000,
      autoCompactionEnabled: true,
    });
    expect(toml).toContain('model_context_window = 262000');
    expect(toml).toContain(`model_auto_compact_token_limit = ${Math.floor(262_000 * 0.85)}`);
    // The operator's 50 000 appears nowhere, on either key.
    expect(toml).not.toContain('50000');
  });
});

describe('P6.96 · the switch report names all three behaviours', () => {
  it('one sentence, three runtimes', () => {
    const body = EN['chat.runtimeSwitch.costAutoCompactionKnobs'];
    expect(body).toBeDefined();
    expect(body).toContain('{{toRuntime}}');
    expect(body).toContain('Pi');
    expect(body).toContain('Claude');
    expect(body).toContain('100,000');
    expect(body).toContain('stop having any effect');
  });
});
