/**
 * P6.441 (codex arm) — codex stops attributing its own way.
 *
 * The row's control is *"the same repository committed from a Pi, a claude and
 * a codex session produces byte-identical trailers"*. It could not hold at HEAD
 * for a reason that is invisible from the row: `getSystemPrompt` — where
 * `6c6a20e72` put the Git Conventions block — has exactly two production
 * callers, `claude-agent.ts` and `pi-agent.ts`. **codex never calls it**
 * (P3.251 measured that and built `prompts/codex-runtime-guidance.ts` as
 * codex's one prose channel, composed by `codexDeveloperInstructions`). So two
 * runtimes were told the rule and the third was not.
 *
 * `gitAttributionSection` was exported for exactly this, so the fix is one
 * entry in that `parts` array — the SAME section from the SAME resolver, which
 * is why this suite asserts an identity rather than a spelling. A copy of the
 * text here would let the two drift and still pass.
 *
 * No `mock.module` and no write to the stored preferences: both halves read the
 * ambient preferences, so the identity holds whatever they say, and the off
 * switch is driven through an EXPLICIT `prefs` object (the pattern
 * `config/__tests__/git-attribution.test.ts` established).
 */
import { describe, expect, it } from 'bun:test';
import { codexDeveloperInstructions } from '../codex-agent.ts';
import { gitAttributionSection } from '../../prompts/system.ts';
import { resolveGitAttribution } from '../../config/preferences.ts';
import { CODEX_RUNTIME_GUIDANCE } from '../../prompts/codex-runtime-guidance.ts';

describe('P6.441 — the codex developer instructions carry the shared git block', () => {
  it('emits the SAME section claude and Pi get, from the same resolver', () => {
    const shared = gitAttributionSection(resolveGitAttribution()).trim();
    // A control on the fixture rather than on the code: an empty section would
    // make the assertion below vacuous, and the block is only empty when the
    // operator turned `includeGitInstructions` off.
    expect(shared.startsWith('## Git Conventions')).toBe(true);
    expect(codexDeveloperInstructions()).toContain(shared);
  });

  it('places it with the operating guidance — after it, and before any style', () => {
    // Ordering is a real property, not decoration: safety outranks operating
    // guidance, and a response style must not read as outranking either.
    const withStyle = codexDeveloperInstructions('Answer in haiku.');
    const guidance = withStyle.indexOf(CODEX_RUNTIME_GUIDANCE.slice(0, 40));
    const git = withStyle.indexOf('## Git Conventions');
    const style = withStyle.indexOf('Answer in haiku.');
    expect(guidance).toBeGreaterThanOrEqual(0);
    expect(git).toBeGreaterThan(guidance);
    expect(style).toBeGreaterThan(git);
  });

  it('NEGATIVE — `includeGitInstructions: false` empties the section, and the empty part is filtered out', () => {
    // The off switch reaches codex through the same resolver; the only thing
    // between it and the composition is the one line the first case pins.
    const off = gitAttributionSection(resolveGitAttribution({ prefs: { includeGitInstructions: false } }));
    expect(off).toBe('');
    // And an empty part must not survive the join as a stray blank line — the
    // reason the `parts` array is filtered rather than pushed to blindly.
    expect([`a`, `b`, off.trim()].filter(part => part.length > 0).join('\n')).toBe('a\nb');
  });
});
