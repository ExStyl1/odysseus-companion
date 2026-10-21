/**
 * P6.307 — `/simplify` and `/security-review` are PRESETS of the one reviewer,
 * not a third and fourth review path.
 *
 * `commands.md` § *All commands* specifies both:
 *
 *  - `/simplify [target]` — "Review the changed code for cleanup opportunities
 *    and apply the fixes. Four review agents run in parallel, covering reuse of
 *    existing helpers, simplification, efficiency, and whether the change is at
 *    the right level of abstraction. The review doesn't look for correctness
 *    bugs. Use `/code-review` to find bugs."
 *  - `/security-review` — "Analyze the changes on your current branch for
 *    security vulnerabilities. Reviews the diff between your branch and origin's
 *    default branch, identifying risks like injection, auth issues, and data
 *    exposure."
 *
 * Every premise below is DERIVED at test time — the category list from
 * `REVIEW_FINDING_CATEGORIES`, the tool availability from `getSessionToolNames`
 * — never transcribed. The day a `security` category is added, or `review`
 * becomes cross-runtime, the sentence in the skill that says otherwise fails
 * here and can be retired deliberately instead of rotting into a lie.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getSessionToolNames } from '@nessy-agent/session-tools-core';

import { REVIEW_FINDING_CATEGORIES } from '../../prompts/review.ts';

/** A bundled SKILL.md, read from the packaged source of truth (never `dist/`). */
function bundledSkill(slug: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../../../apps/electron/resources/skills/${slug}/SKILL.md`, import.meta.url)),
    'utf8',
  );
}

function frontmatter(source: string): Record<string, string> {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  expect(lines[0]).toBe('---');
  const end = lines.findIndex((line, index) => index > 0 && line === '---');
  expect(end).toBeGreaterThan(0);
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return fields;
}

/**
 * Wrapped prose read as FLOWING TEXT: a sentence quoted across a line break is
 * the same sentence, and a guard that only matched the unwrapped form would go
 * red on a reflow rather than on a change of meaning.
 */
const flow = (text: string) => text.replace(/\s+/g, ' ');

/**
 * The BACKGROUND direction's two premises, DERIVED — P6.1016 wrote them for
 * `/code-review`, P6.1024 gave the same pair to the two presets, and neither
 * transcribes them. The day claude's subagent tool stops defaulting to the
 * background, or codex stops splitting spawn from wait, every skill sentence
 * resting on that fact fails here and can be retired deliberately.
 */
const CLAUDE_SUBAGENT_BACKGROUND_DEFAULT =
  'Agents run in the background by default; you will be notified when one completes.';
const CODEX_SPAWN_THEN_WAIT = '`spawn_agent`, then `wait_agent`';

function expectBackgroundPremises(): void {
  // CLAUDE — the vendored SDK's own tool typing, and the parameter that sentence
  // documents, so a renamed field fails here too.
  const entry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
  const sdkTools = readFileSync(`${entry.slice(0, entry.lastIndexOf('/'))}/sdk-tools.d.ts`, 'utf8');
  expect(flow(sdkTools)).toContain(CLAUDE_SUBAGENT_BACKGROUND_DEFAULT);
  expect(sdkTools).toContain('run_in_background?: boolean;');

  // CODEX — the wire names the transcript router pins, read as source text
  // rather than imported: this suite has no business paying for that module
  // graph to learn two string literals.
  const codexAdapter = readFileSync(
    fileURLToPath(new URL('../../agent/backend/codex/event-adapter.ts', import.meta.url)),
    'utf8',
  );
  expect(codexAdapter).toContain("spawnAgent: 'spawn_agent',");
  expect(codexAdapter).toContain("wait: 'wait_agent',");
}

const crossRuntimeTools = getSessionToolNames();
const crossRuntimeToolsWithReviewPort = getSessionToolNames({ reviewDiffPort: true });

describe('P6.307 · the two review presets ship as bundled skills', () => {
  for (const slug of ['simplify', 'security-review'] as const) {
    it(`${slug} carries the frontmatter a slash-only command needs`, () => {
      const fields = frontmatter(bundledSkill(slug));
      expect(fields.name).toBeTruthy();
      expect(fields.description).toBeTruthy();
      // Both are commands a user TYPES. Without this the model may invoke them
      // on its own, which for `/simplify` would edit the working tree unasked.
      expect(fields['disable-model-invocation']).toBe('true');
    });

    it(`${slug} routes through the same reviewer on every runtime`, () => {
      const body = bundledSkill(slug);
      // The premise, derived: `review` is a Pi orchestrator tool and is in NO
      // cross-runtime surface, so a preset that named only `review` would be a
      // command that silently does nothing on claude and codex.
      expect(crossRuntimeTools).not.toContain('review');
      // ... and `ReviewDiff` is gated on the host port, not on the runtime.
      expect(crossRuntimeTools).not.toContain('ReviewDiff');
      expect(crossRuntimeToolsWithReviewPort).toContain('ReviewDiff');
      expect(body).toContain('`review` tool');
      expect(body).toContain('ReviewDiff');
      // The last resort is named too, so no runtime falls off the end.
      expect(body).toContain('subagent');
      // Reporting is a session tool present everywhere.
      expect(crossRuntimeTools).toContain('ReportFindings');
      expect(body).toContain('ReportFindings');
    });
  }

  it('simplify keeps to the cleanup categories the reviewer actually emits', () => {
    const body = bundledSkill('simplify');
    for (const category of ['reuse', 'simplification', 'efficiency'] as const) {
      expect(REVIEW_FINDING_CATEGORIES).toContain(category);
      expect(body).toContain(`\`${category}\``);
    }
    // The page's fourth axis — "whether the change is at the right level of
    // abstraction" — has NO category here, and the skill says so rather than
    // minting one `ReportFindings` would reject.
    expect(REVIEW_FINDING_CATEGORIES).not.toContain('altitude' as never);
    expect(body).toContain('Altitude has no category of its own here');
    // "The review doesn't look for correctness bugs" — but a bug the reviewer
    // already found is named in one line rather than dropped in silence.
    expect(body).toContain('A correctness finding is not silently dropped.');
  });

  it('security-review reports under an existing category and says why', () => {
    const body = bundledSkill('security-review');
    expect(REVIEW_FINDING_CATEGORIES).not.toContain('security' as never);
    expect(body).toContain('There is no `security` category');
    expect(REVIEW_FINDING_CATEGORIES).toContain('correctness');
    expect(body).toContain('`correctness`');
    // The default target is the branch, against origin's default branch.
    expect(body).toContain('origin');
    expect(body).toContain('`base`');
    // It reports; it does not fix. The opposite of `/simplify`.
    expect(body).toContain('It does not apply fixes.');
  });

  it('code-review hands the cross-session effort carry-over to the HOST (P6.307)', () => {
    // `code-review.md` § *Tune effort and arguments*: the review "reuses the
    // last level from `low` through `max` you typed, even in an earlier
    // session". P6.307 built that store host-side — `lastReviewEffortLevel` in
    // `StoredConfig`, written and read at Pi's PreToolUse gate — so the skill's
    // old disclosure ("this build has no store for that level") is now FALSE and
    // the instruction inverts: omit `effort`, and the host supplies it.
    const body = bundledSkill('code-review');
    expect(body).toContain('even in an earlier session');
    expect(body).toContain('The carry-over is the host');
    // The negative half: the retired disclosure must not come back, because a
    // skill that says nothing is remembered while the host remembers is worse
    // than either behaviour alone.
    expect(body).not.toContain('store for that level');
    // And the two presets are reachable from the command they extend.
    expect(body).toContain('/simplify');
    expect(body).toContain('/security-review');
  });

  /**
   * P6.1016 — the background DIRECTION on the two runtimes with no `review` tool.
   *
   * P6.798 made the Pi tool background by default, following `code-review.md`:
   * *"The review runs as a background subagent with its own context window"*. On
   * claude and codex there is no tool to flip — the skill is the only surface
   * that reaches the model — and it named no direction at all.
   *
   * NATIVE-FIRST, and the measurement is why nothing was built beside it: the
   * SDK's own subagent tool ALREADY defaults to background, and codex's spawn and
   * wait are two separate calls. Both premises are DERIVED here rather than
   * transcribed, so the day either runtime changes, the sentence in the skill
   * that rests on it fails and can be retired deliberately.
   */
  it('names the background direction, on each runtime that has no review tool', () => {
    const body = flow(bundledSkill('code-review'));
    // Both premises derived rather than transcribed; see the helper.
    expectBackgroundPremises();
    expect(body).toContain(CLAUDE_SUBAGENT_BACKGROUND_DEFAULT);
    expect(body).toContain(CODEX_SPAWN_THEN_WAIT);

    // The NEGATIVE half, and it is the one that matters: a skill that tells the
    // model to background the review while also telling it the findings come
    // back inside this turn would be read either way. `--fix` is the sentence
    // that used to say so, and its replacement says the opposite out loud.
    const retired = 'The review runs inside this turn';
    expect(flow('then say what you changed. The review runs\n  inside this turn, so'))
      .toContain(retired);
    expect(body).not.toContain(retired);
    expect(body).toContain('a backgrounded review does not change that');
  });

  /**
   * P6.1024 — the same direction on the two PRESETS, each in its own terms.
   *
   * All three bundled review skills carry the same "delegate to a subagent"
   * fallback for the runtimes with no `review` tool, and they run the SAME
   * reviewer (P6.307's whole premise) — so a user who typed `/security-review`
   * got a foreground review on claude for no stated reason, while the identical
   * fallback one file away had been given a direction by P6.1016.
   *
   * NOT one paragraph copied twice: `/simplify` APPLIES what comes back, so
   * backgrounding changes when it edits, and `/security-review` reports and
   * stops, so the findings are the only thing waiting. The shared half is the
   * pair of derived premises; the differing half is what each does with the
   * findings, and this case pins both halves in both directions.
   */
  it('names the background direction on the two presets, each in its own terms (P6.1024)', () => {
    expectBackgroundPremises();

    const simplify = flow(bundledSkill('simplify'));
    const security = flow(bundledSkill('security-review'));
    for (const body of [simplify, security]) {
      expect(body).toContain('**Leave it in the BACKGROUND.**');
      expect(body).toContain(CLAUDE_SUBAGENT_BACKGROUND_DEFAULT);
      expect(body).toContain(CODEX_SPAWN_THEN_WAIT);
    }

    // `/simplify` edits, and the direction has to say WHEN — a backgrounded
    // review that is applied before its findings land is worse than a
    // foreground one. Step 3 is where it says so.
    expect(simplify).toContain('nothing is edited before then');
    // `/security-review` does not edit at all, which its own §"What this
    // command does not do" already states and this sentence rests on.
    expect(security).toContain('This command reports and stops');
    // The control on that pair: neither carries the other's sentence, so a
    // future copy-paste of one paragraph into both files fails here rather than
    // telling `/security-review` to apply fixes it must not apply.
    expect(security).not.toContain('nothing is edited before then');
    expect(simplify).not.toContain('This command reports and stops');
  });
});
