/**
 * P3.306 — `features.codex_git_commit` stays unwritten, and the reason is the
 * one thing a reader will not guess: it is a key that WORKS and does nothing.
 *
 * ## Why the key looks like the answer
 *
 * W2-z found it while asking P2.11's native-first question: an unattended commit
 * is a capability the host was about to build, and codex appears to ship a flag
 * for it. The appearance is well-founded — it is in the pinned release schema
 * TWICE (`properties.features.properties.codex_git_commit` and
 * `definitions.ConfigProfile.properties.features.properties.codex_git_commit`,
 * both `{"type":"boolean"}`) and twice in the shipped binary's strings. By the
 * "bundle is the denominator" rule it is real and settable.
 *
 * ## What it is, read at `rust-v0.148.0`
 *
 *     FeatureSpec { id: Feature::CodexGitCommit, key: "codex_git_commit",
 *                   stage: Stage::Removed, default_enabled: false }
 *
 * and `Stage::Removed` is codex's own comment: *"The feature flag is useless but
 * kept for backward compatibility reason."* `Feature::CodexGitCommit` has ZERO
 * readers outside `features/` — 0 in `core`, `protocol`, `config`, `app-server`,
 * `app-server-protocol`, `tui`, `exec`, `cli`, `common` — against
 * `Feature::MemoryTool` (a `Stable` feature) at 4 in `core` and 12 in `tui` on
 * the same probe, which is the positive control that the grep finds a consumed
 * feature when there is one.
 *
 * ## Why it is a worse trap than P2.456's `tool_search`, measured on the binary
 *
 * `tool_search` sits in `Features::apply_map`'s explicit `continue` list, so
 * writing it leaves the feature OFF. `codex_git_commit` does NOT: it falls
 * through to `feature_for_key` → `self.enable(feat)`. The key is applied, and
 * then consulted by nobody. Driven against the shipped `codex-app-server` with
 * the key written, `experimentalFeature/list` (114 features) answers
 *
 *     {"name":"codex_git_commit","stage":"removed","enabled":true,"defaultEnabled":false}
 *
 * while `tool_search` in the same response reads `"enabled":false`. So codex
 * itself would tell a future lane the flag is ON.
 *
 * ## The prompt sentence is not conditioned on it
 *
 * P2.11 leans on *"Do not `git commit` your changes or create new git branches
 * unless explicitly requested."* At the tag it sits in FIVE static prompt files
 * — `models-manager/prompt.md` (the `include_str!` behind `BASE_INSTRUCTIONS`,
 * and therefore the one an unknown-slug Nessy session actually gets),
 * `core/gpt_5_1_prompt.md`, `core/gpt_5_2_prompt.md`,
 * `core/prompt_with_apply_patch_instructions.md` and
 * `protocol/src/prompts/base_instructions/default.md` — ONCE each, with zero
 * `{{` templating in any of them. (P2.11's note says "twice"; it is once per
 * file, five files.)
 *
 * One turn per arm against the stub Responses server, reading what the MODEL
 * receives:
 *
 * | arm                          | tools | tools sha | instructions sha |
 * | ---------------------------- | ----- | --------- | ---------------- |
 * | baseline                     | 9     | 864af923  | ac8ae107         |
 * | `codex_git_commit = true`    | 9     | 864af923  | ac8ae107         |
 * | `multi_agent = false` (CTRL) | 8     | fe8224e3  | ac8ae107         |
 *
 * Instructions identical (20 751 chars, sentence present in all three) and the
 * tool set identical with the flag ON; the control moved the tool set in the
 * same rig, which is what makes the two identities a finding rather than a
 * blind probe.
 *
 * ## The decision this file pins
 *
 * REFUSED by name at the emission site rather than left absent. Emitting it from
 * a user's commit grant would advertise a control codex does not implement and
 * would report itself as enabled — the false-assurance shape this tree keeps
 * deleting. Where the grant should really go is P2.11's call.
 */
import { describe, expect, test } from 'bun:test';
import { buildCodexConfigToml, type CodexPermissionMode } from '../config-writer.ts';

const BASE = { codexHome: 'unused-home', model: 'tgpt/qwen35-397b-a17b-fp8', adapterPort: 54321 } as const;

const ALL_MODES: readonly CodexPermissionMode[] = [
  'dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions',
];

describe('P3.306 tripwire — codex_git_commit stays unwritten', () => {
  /**
   * Positive controls, for the reason every absence claim in this tree carries
   * one: these ARE emitted under `[features]`. A run scoring zero for the
   * forbidden key AND the controls would be an instrument failure, not a
   * finding.
   */
  const CONTROLS = ['[features]', 'multi_agent = true', 'view_image = true'] as const;

  test('no mode, in either sandbox switch position, emits the key', () => {
    for (const sandboxGloballyEnabled of [true, false]) {
      for (const mode of ALL_MODES) {
        const toml = buildCodexConfigToml({ ...BASE, mode, sandboxGloballyEnabled });
        for (const control of CONTROLS) expect(toml).toContain(control);
        expect(toml, `mode ${mode}`).not.toContain('codex_git_commit');
      }
    }
  });

  test('a bare call emits it either', () => {
    const toml = buildCodexConfigToml(BASE);
    for (const control of CONTROLS) expect(toml).toContain(control);
    expect(toml).not.toContain('codex_git_commit');
  });

  /**
   * The refusal must be RECORDED at the site, not merely an absent key — and the
   * assertion is scoped to THIS row's comment block, which is not fussiness.
   *
   * The first version of this test asserted the markers anywhere in
   * `config-writer.ts`, and a mutant that gutted `Stage::Removed` out of the
   * P3.306 comment SURVIVED: the P2.456 block three paragraphs up says
   * `Stage::Removed` about its own two keys, so the file-wide search stayed
   * green while the reason this row exists had been deleted. That is the
   * attribution defect `runtime-switch-costs-gaps-parity.test.ts` was written
   * for, reproduced here by its own re-break harness. Slice first, then assert.
   */
  test('the refusal is RECORDED at the site, not merely an absent key', async () => {
    const text = await Bun.file(new URL('../config-writer.ts', import.meta.url)).text();
    const start = text.indexOf('// P3.306 ·');
    expect(start, 'no P3.306 comment block in config-writer.ts').toBeGreaterThan(-1);
    const end = text.indexOf('// P2.450 ·', start);
    expect(end, 'the P3.306 block is not followed by the P2.450 one').toBeGreaterThan(start);
    const block = text.slice(start, end);

    // Positive control: the slice really is the block, and it really is a slice
    // — the neighbour that made the file-wide version pass must be OUTSIDE it.
    expect(block).toContain('codex_git_commit');
    expect(block.length).toBeLessThan(text.length / 2);
    expect(block).not.toContain('tool_search_always_defer_mcp_tools');

    // The stage is the whole reason the key is refused rather than emitted.
    expect(block).toContain('Stage::Removed');
    // The half a reader is most likely to get wrong: it is applied, then unread,
    // and reports itself ENABLED.
    expect(block).toContain('experimentalFeature/list');
    // And the fact that distinguishes it from P2.456's pair.
    expect(block).toContain('apply_map');
  });
});
