/**
 * `model-config.md:504`/`:506`, `sub-agents.md:289`, `skills.md:268` — skill and
 * subagent frontmatter `effort` OVERRIDES the session effort level. One
 * resolver, called by the skill path (`BaseAgent.applySkillInvocationEffort`)
 * and by the subagent spawner, because the two are halves of one documented
 * sentence and drifted apart while they were two implementations.
 */
import { describe, expect, it } from 'bun:test';

import {
  activeEffortLevelForModel,
  clampThinkingLevelToModel,
  DEFAULT_THINKING_LEVEL,
  getHeldModelDefaultThinkingLevel,
  getModelDefaultThinkingLevel,
  resolveEffortLevel,
  type ThinkingLevel,
} from '../thinking-levels.ts';

describe('resolveEffortLevel', () => {
  it.each([
    // session      declared     invocation   resolved
    ['high', undefined, undefined, 'high'],
    ['high', 'low', undefined, 'low'],
    // The row the downward-only clamp got wrong: a child may think HARDER.
    ['low', 'max', undefined, 'max'],
    ['off', 'xhigh', undefined, 'xhigh'],
    ['max', 'off', undefined, 'off'],
    // An unset session is not a session that chose `off`.
    [undefined, undefined, undefined, DEFAULT_THINKING_LEVEL],
    [undefined, 'low', undefined, 'low'],
    // `sub-agents.md:310` resolves the per-invocation parameter before the
    // frontmatter; effort follows the order model resolution already uses.
    ['low', 'medium', 'high', 'high'],
    ['high', undefined, 'low', 'low'],
  ] as const)(
    'session %p + declared %p + invocation %p => %p',
    (session, declared, invocation, expected) => {
      expect(resolveEffortLevel({
        ...(session === undefined ? {} : { session }),
        ...(declared === undefined ? {} : { declared }),
        ...(invocation === undefined ? {} : { invocation }),
      })).toBe(expected as ThinkingLevel);
    },
  );

  it('lets a caller name its own fallback for a session that never set a level', () => {
    expect(resolveEffortLevel({ fallback: 'off' })).toBe('off');
    // A declared level still wins over the fallback.
    expect(resolveEffortLevel({ declared: 'high', fallback: 'off' })).toBe('high');
    // A session that DID choose a level is never replaced by the fallback.
    expect(resolveEffortLevel({ session: 'low', fallback: 'max' })).toBe('low');
  });
});

/**
 * `model-config.md:452` — "If you set a level the active model does not support,
 * Claude Code falls back to the highest supported level at or below the one you
 * set. For example, `xhigh` runs as `high` on Opus 4.6."
 *
 * The one rule in this unit that NARROWS. Kept apart from `resolveEffortLevel`
 * on purpose.
 */
describe('clampThinkingLevelToModel', () => {
  it('falls back to the highest supported level at or below the one set', () => {
    // The page's own worked example.
    expect(clampThinkingLevelToModel('xhigh', 'claude-opus-4-6')).toBe('high');
    expect(clampThinkingLevelToModel('xhigh', 'claude-sonnet-4-6')).toBe('high');
    // Provider-form ids reach the same answer.
    expect(clampThinkingLevelToModel('xhigh', 'anthropic.claude-sonnet-4-6-v1:0')).toBe('high');
    expect(clampThinkingLevelToModel('xhigh', 'anthropic/claude-opus-4-6')).toBe('high');
  });

  it('never raises, and leaves supported levels alone', () => {
    // `:450` — Opus 4.6 and Sonnet 4.6 do run `max`; only `xhigh` is missing,
    // so `max` must NOT be dragged down with it.
    for (const level of ['off', 'low', 'medium', 'high', 'max'] as const) {
      expect(clampThinkingLevelToModel(level, 'claude-opus-4-6')).toBe(level);
    }
  });

  it('passes a model we do not positively know to be narrower through unchanged', () => {
    // Deliberate: reading ":444 models not listed do not support effort" as
    // "unlisted => off" would silently disable reasoning on every dynamically
    // discovered gateway model, and on Haiku's fixed token budget.
    for (const model of ['claude-opus-4-8', 'claude-fable-5', 'claude-haiku-4-5-20251001', 'tgpt/qwen35-397b-a17b-fp8', '']) {
      expect(clampThinkingLevelToModel('xhigh', model)).toBe('xhigh' as ThinkingLevel);
    }
  });
});

/**
 * `model-config.md:453` — "The default effort is `high` on every model that
 * supports effort, except Opus 4.7, which defaults to `xhigh`."
 */
describe('getModelDefaultThinkingLevel', () => {
  it('gives Opus 4.7 the one documented exception', () => {
    expect(getModelDefaultThinkingLevel('claude-opus-4-7')).toBe('xhigh');
    // Provider-form ids reach the same answer, like the narrowing table's.
    expect(getModelDefaultThinkingLevel('anthropic/claude-opus-4-7')).toBe('xhigh');
    expect(getModelDefaultThinkingLevel('us.anthropic.claude-opus-4-7-v1:0')).toBe('xhigh');
  });

  // F1.1214 — model-config.md#adjust-effort-level: "Opus 5.5 and Sonnet 5.5
  // default to `medium`". The generic row's `opus-5`/`sonnet-5` prefixes also
  // match these ids, so this pins the ordering, not just the row.
  it('gives Opus 5.5 and Sonnet 5.5 `medium`, in every id form', () => {
    for (const model of [
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'anthropic/claude-opus-5-5',
      'us.anthropic.claude-sonnet-5-5',
    ]) {
      expect(getModelDefaultThinkingLevel(model)).toBe('medium');
    }
  });

  it('gives every other effort-capable family `high`', () => {
    for (const model of [
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-fable-5',
      // Boundary for the 5.5 row: Fable 5.1 is NOT in the page's `medium` clause.
      'claude-fable-5-1',
      'claude-opus-5',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
    ]) {
      expect(getModelDefaultThinkingLevel(model)).toBe('high');
    }
  });

  it('declines for a model the page says nothing about', () => {
    // THE LOAD-BEARING CASE. Every dynamically discovered gateway model is
    // unlisted, and `undefined` is what keeps their effort on
    // DEFAULT_THINKING_LEVEL — exactly where it was before this table existed.
    for (const model of ['tgpt/qwen35-397b-a17b-fp8', 'pi/gpt-5', 'claude-haiku-4-5-20251001', '']) {
      expect(getModelDefaultThinkingLevel(model)).toBeUndefined();
    }
    expect(resolveEffortLevel({ fallback: getModelDefaultThinkingLevel('tgpt/qwen35-397b-a17b-fp8') }))
      .toBe(DEFAULT_THINKING_LEVEL);
  });

  it('never outranks a level something above it already chose', () => {
    // `:506` — "The environment variable takes precedence over all other
    // methods, then your configured level, then the model default."
    expect(resolveEffortLevel({ session: 'low', fallback: getModelDefaultThinkingLevel('claude-opus-4-7') })).toBe('low');
    expect(resolveEffortLevel({ declared: 'off', fallback: getModelDefaultThinkingLevel('claude-opus-4-8') })).toBe('off');
  });
});

/**
 * F1.1214 — two documented holds over the older top-level (user-settings)
 * level. `model-config.md#adjust-effort-level`: it "keeps applying where it
 * applied before, on Opus 5, Fable 5.1, and earlier models, while Opus 5.5 and
 * models released after it start at their own default". And Claude Code
 * 2.1.280's changelog NARROWED, not removed, the launch-default hold of Opus
 * 4.7, Opus 4.8 and Fable 5: "to stop holding their launch-default effort over
 * `/effort` in `-p` or the Agent SDK, a project, managed or `--settings`
 * `effortLevel`, or a per-model level" — the user-settings older form is not on
 * that list, so the hold over it stands (where it applied before, it did not apply).
 */
describe('getHeldModelDefaultThinkingLevel', () => {
  it('holds Opus 5.5 and Sonnet 5.5 at their own `medium` default, in every id form', () => {
    expect(getHeldModelDefaultThinkingLevel('claude-opus-5-5')).toBe('medium');
    expect(getHeldModelDefaultThinkingLevel('claude-sonnet-5-5')).toBe('medium');
    expect(getHeldModelDefaultThinkingLevel('us.anthropic.claude-opus-5-5')).toBe('medium');
  });

  it('still holds Fable 5, Opus 4.8 and Opus 4.7 at their launch defaults over the older form', () => {
    expect(getHeldModelDefaultThinkingLevel('claude-fable-5')).toBe('high');
    expect(getHeldModelDefaultThinkingLevel('anthropic.claude-fable-5')).toBe('high');
    expect(getHeldModelDefaultThinkingLevel('claude-opus-4-8')).toBe('high');
    expect(getHeldModelDefaultThinkingLevel('claude-opus-4-7')).toBe('xhigh');
  });

  it('holds nothing for a model outside that list, even one WITH a default', () => {
    // The two lists are different lengths on purpose; this is the case that
    // catches them being merged. Fable 5.1 is the page's named boundary — and
    // the reason the `fable-5` row is anchored so it cannot match `fable-5-1`.
    for (const model of [
      'claude-fable-5-1', 'anthropic.claude-fable-5-1',
      'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-6', 'tgpt/qwen35-397b-a17b-fp8', '',
    ]) {
      expect(getHeldModelDefaultThinkingLevel(model)).toBeUndefined();
    }
  });
});

/**
 * `hooks.md:707` — the effort a hook input, `$CLAUDE_EFFORT` and a Bash-tool
 * child may see. Two narrowings live in one function so those three surfaces
 * can never answer differently: the DOWNGRADED level ("If the requested model
 * effort exceeds what the current model supports, this is the downgraded level
 * the model actually used"), and presence only "when the current model supports
 * the effort parameter".
 */
describe('activeEffortLevelForModel', () => {
  it('reports the downgraded level, not the requested one', () => {
    // `model-config.md:452`'s own worked example: "`xhigh` runs as `high` on
    // Opus 4.6". A hook told `xhigh` there would be told a level that never ran.
    expect(activeEffortLevelForModel('xhigh', 'claude-opus-4-6')).toBe('high');
    expect(activeEffortLevelForModel('max', 'claude-opus-4-6')).toBe('max');
    expect(activeEffortLevelForModel('high', 'claude-opus-4-7')).toBe('high');
  });

  it('reports NOTHING when there is no level to report — never a default', () => {
    // `off` is Nessy's sixth level and the page lists no spelling for it, so a
    // session at `off` reports no effort at all rather than a word no
    // documented hook can branch on. Same withholding rule the skills path uses.
    expect(activeEffortLevelForModel('off', 'claude-opus-4-7')).toBeUndefined();
    // A model whose registry entry says it has no effort control at all. The
    // absence must stay an absence: `medium` here would tell every hook on a
    // Nestor Cloud session a level the model never ran at.
    expect(activeEffortLevelForModel('high', 'nestor-cloud-code-agent')).toBeUndefined();
  });

  it('treats an UNKNOWN model as effort-capable, because the default runtime is unlisted', () => {
    // The trap: every dynamically discovered Pi/gateway model is absent from the
    // static registry, and `supportsThinking` is documented as defaulting to
    // true when undefined. Reading absence as "unsupported" would withhold the
    // field on exactly the population it exists for.
    expect(activeEffortLevelForModel('high', 'tgpt/qwen35-397b-a17b-fp8')).toBe('high');
    expect(activeEffortLevelForModel('low', '')).toBe('low');
  });
});
