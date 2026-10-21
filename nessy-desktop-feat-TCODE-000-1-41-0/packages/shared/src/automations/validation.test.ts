/**
 * Tests for validation.ts
 */

import { describe, it, expect } from 'bun:test';
import { validateAutomationsConfig, validateAutomationsContent } from './validation.ts';
import { AutomationsConfigSchema, PreToolUseDecisionActionSchema, PromptActionSchema } from './schemas.ts';

describe('validation', () => {
  describe('validateAutomationsConfig', () => {
    it('should accept a valid config', () => {
      const config = {
        automations: {
          SessionStatusChange: [{
            matcher: 'done',
            actions: [{ type: 'prompt', prompt: 'echo done' }],
          }],
        },
      };
      const result = validateAutomationsConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.config).not.toBeNull();
    });

    it('should accept an empty automations object', () => {
      const result = validateAutomationsConfig({ automations: {} });
      expect(result.valid).toBe(true);
    });

    it('carries the per-task worktree flag through to the runtime config', () => {
      // The flag (desktop-scheduled-tasks.md:34) has to be in the schema before
      // any consumer can read it — that is why this test exists.
      //
      // P3.322 REPLACED this test's second half, deliberately and not by
      // accident: it used to pass an `unmodelledKey` and assert it was STRIPPED,
      // as the control proving `worktree` survived on the strength of its schema
      // entry. That strip is the defect P3.322 removed — it is what made a
      // documented `if` vanish — so the control moved to the case below, where
      // the unmodelled key is now REFUSED BY NAME. A test that pins removed
      // behaviour is worse than no test, so it is rewritten rather than
      // deleted.
      const result = validateAutomationsConfig({
        automations: {
          SchedulerTick: [{
            id: 'abc123',
            cron: '0 9 * * *',
            worktree: true,
            actions: [{ type: 'prompt', prompt: 'nightly lint' }],
          }],
        },
      });

      expect(result.valid).toBe(true);
      const matcher = result.config!.automations.SchedulerTick![0]!;
      expect(matcher.worktree).toBe(true);
    });

    it('refuses an unmodelled matcher key instead of stripping it (P3.322)', () => {
      // The other half of the test above, and the reason `worktree` surviving is
      // evidence of a schema entry rather than of a permissive parse: a key the
      // schema does not model does not reach the config at all — it stops the
      // parse and names itself.
      const result = validateAutomationsConfig({
        automations: {
          SchedulerTick: [{
            id: 'abc123',
            cron: '0 9 * * *',
            worktree: true,
            unmodelledKey: 'no longer dropped',
            actions: [{ type: 'prompt', prompt: 'nightly lint' }],
          }],
        },
      });

      expect(result.valid).toBe(false);
      expect(result.config).toBeNull();
      expect(result.errors.join('\n')).toContain('unmodelledKey');
    });

    it('should reject non-object input', () => {
      const result = validateAutomationsConfig('not an object');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should accept config without automations key (defaults to empty)', () => {
      // The schema provides a default empty automations object
      const result = validateAutomationsConfig({});
      expect(result.valid).toBe(true);
      expect(result.config?.automations).toEqual({});
    });

    it('rejects legacy matcher entries at the top level', () => {
      const result = validateAutomationsConfig({
        'beep-on-agent-end': {
          event: 'AgentEnd',
          actions: [{ type: 'bash', command: 'printf "\\a"' }],
        },
      });

      expect(result.valid).toBe(false);
      expect(result.errors.join('\n')).toContain('Unrecognized key');
    });

    it('should accept config with prompt actions', () => {
      const config = {
        automations: {
          SchedulerTick: [{
            cron: '0 9 * * *',
            actions: [{ type: 'prompt', prompt: 'Good morning!' }],
          }],
        },
      };
      const result = validateAutomationsConfig(config);
      expect(result.valid).toBe(true);
    });

    it('should accept PreToolUse decision actions', () => {
      const config = {
        automations: {
          PreToolUse: [{
            matcher: '^Bash$',
            actions: [{
              type: 'decision',
              decision: 'block',
              reason: 'blocked by policy',
              updatedInput: { command: 'echo rewritten' },
              additionalContext: 'Explain the rewrite.',
            }],
          }],
        },
      };
      const result = validateAutomationsConfig(config);
      expect(result.valid).toBe(true);
    });

    it('PreToolUseDecisionActionSchema rejects empty decision actions', () => {
      const result = PreToolUseDecisionActionSchema.safeParse({ type: 'decision' });
      expect(result.success).toBe(false);
    });

    it('should accept config with disabled matchers', () => {
      const config = {
        automations: {
          LabelAdd: [{
            enabled: false,
            matcher: 'bug',
            actions: [{ type: 'prompt', prompt: 'echo disabled' }],
          }],
        },
      };
      const result = validateAutomationsConfig(config);
      expect(result.valid).toBe(true);
    });

    it('should accept config with optional name field', () => {
      const config = {
        automations: {
          SchedulerTick: [{
            name: 'Daily Weather Report',
            cron: '0 8 * * *',
            actions: [{ type: 'prompt', prompt: 'Check the weather' }],
          }],
        },
      };
      const result = validateAutomationsConfig(config);
      expect(result.valid).toBe(true);
    });

    it('should accept thinkingLevel on prompt actions', () => {
      const config = {
        automations: {
          LabelAdd: [{
            matcher: 'review',
            actions: [{ type: 'prompt', prompt: 'Audit changes', thinkingLevel: 'high' }],
          }],
        },
      };
      const result = validateAutomationsConfig(config);
      expect(result.valid).toBe(true);
      const action = result.config?.automations.LabelAdd?.[0]?.actions[0];
      expect(action).toMatchObject({ thinkingLevel: 'high' });
    });

    it('PromptActionSchema rejects invalid thinkingLevel values', () => {
      // ActionDefinitionSchema has a passthrough fallback that absorbs malformed
      // actions (so old configs with unknown action types don't crash). To verify
      // the schema's own contract for thinkingLevel, parse with PromptActionSchema
      // directly — that's the strict path.
      const result = PromptActionSchema.safeParse({
        type: 'prompt', prompt: 'echo', thinkingLevel: 'extreme',
      });
      expect(result.success).toBe(false);
    });

    it('should migrate legacy thinkingLevel "think" to "medium"', () => {
      // Mirrors the workspace-default migration in config/validators.ts so persisted
      // 'think' values from old configs don't break automation parsing.
      const config = {
        automations: {
          LabelAdd: [{
            matcher: 'review',
            actions: [{ type: 'prompt', prompt: 'echo', thinkingLevel: 'think' }],
          }],
        },
      };
      const result = validateAutomationsConfig(config);
      expect(result.valid).toBe(true);
      const action = result.config?.automations.LabelAdd?.[0]?.actions[0];
      expect(action).toMatchObject({ thinkingLevel: 'medium' });
    });

    it('should accept prompt actions without thinkingLevel (backward compat)', () => {
      const config = {
        automations: {
          LabelAdd: [{
            matcher: 'review',
            actions: [{ type: 'prompt', prompt: 'echo' }],
          }],
        },
      };
      const result = validateAutomationsConfig(config);
      expect(result.valid).toBe(true);
      const action = result.config?.automations.LabelAdd?.[0]?.actions[0];
      expect(action).toEqual({ type: 'prompt', prompt: 'echo' });
    });

    it('should accept ephemeral opt-in on prompt actions', () => {
      const config = {
        automations: {
          SchedulerTick: [{
            cron: '0 9 * * *',
            actions: [{ type: 'prompt', prompt: 'daily scratch run', ephemeral: true }],
          }],
        },
      };
      const result = validateAutomationsConfig(config);
      expect(result.valid).toBe(true);
      const action = result.config?.automations.SchedulerTick?.[0]?.actions[0];
      expect(action).toMatchObject({ ephemeral: true });
    });

    it('should reject state conditions with no operator', () => {
      const config = {
        automations: {
          LabelAdd: [{
            conditions: [{ condition: 'state', field: 'mode' }],
            actions: [{ type: 'prompt', prompt: 'test' }],
          }],
        },
      };
      const result = validateAutomationsConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('at least one operator'))).toBe(true);
    });

    it('should reject state conditions with conflicting operator groups', () => {
      const config = {
        automations: {
          LabelAdd: [{
            conditions: [{ condition: 'state', field: 'mode', value: 'ask', not_value: 'safe' }],
            actions: [{ type: 'prompt', prompt: 'test' }],
          }],
        },
      };
      const result = validateAutomationsConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('exactly one operator group'))).toBe(true);
    });

    it('should reject semantically invalid time values in object validation path', () => {
      const config = {
        automations: {
          LabelAdd: [{
            conditions: [{ condition: 'time', after: '25:61' }],
            actions: [{ type: 'prompt', prompt: 'test' }],
          }],
        },
      };
      const result = validateAutomationsConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Invalid time value'))).toBe(true);
    });

    it('should reject condition nesting beyond maximum depth', () => {
      let nested: unknown = { condition: 'state', field: 'mode', value: 'ask' };
      for (let i = 0; i < 9; i++) {
        nested = { condition: 'and', conditions: [nested] };
      }

      const config = {
        automations: {
          LabelAdd: [{
            conditions: [nested],
            actions: [{ type: 'prompt', prompt: 'test' }],
          }],
        },
      };
      const result = validateAutomationsConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('exceeds maximum depth'))).toBe(true);
    });
  });

  describe('validateAutomationsContent', () => {
    it('should accept valid JSON config', () => {
      const json = JSON.stringify({
        automations: {
          LabelAdd: [{
            matcher: 'bug',
            actions: [{ type: 'prompt', prompt: 'echo bug' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject invalid JSON', () => {
      const result = validateAutomationsContent('not json{');
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.message).toContain('Invalid JSON');
    });

    it('should reject ReDoS patterns (nested quantifiers)', () => {
      const json = JSON.stringify({
        automations: {
          LabelAdd: [{
            matcher: '(a+)+',
            actions: [{ type: 'prompt', prompt: 'echo test' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('ReDoS'))).toBe(true);
    });

    it('should reject ReDoS patterns (repeated alternation)', () => {
      const json = JSON.stringify({
        automations: {
          LabelAdd: [{
            matcher: '(a|b)+',
            actions: [{ type: 'prompt', prompt: 'echo test' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(false);
    });

    it('should reject ReDoS patterns (repeated greedy quantifiers)', () => {
      const json = JSON.stringify({
        automations: {
          LabelAdd: [{
            matcher: '.*.*',
            actions: [{ type: 'prompt', prompt: 'echo test' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(false);
    });

    it('should reject invalid regex syntax', () => {
      const json = JSON.stringify({
        automations: {
          LabelAdd: [{
            matcher: '[invalid',
            actions: [{ type: 'prompt', prompt: 'echo test' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('Invalid regex'))).toBe(true);
    });

    it('should reject regex patterns that are too long', () => {
      const json = JSON.stringify({
        automations: {
          LabelAdd: [{
            matcher: 'a'.repeat(501),
            actions: [{ type: 'prompt', prompt: 'echo test' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('too long'))).toBe(true);
    });

    it('should reject invalid cron expressions', () => {
      const json = JSON.stringify({
        automations: {
          SchedulerTick: [{
            cron: 'not a cron',
            actions: [{ type: 'prompt', prompt: 'echo tick' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('Invalid cron'))).toBe(true);
    });

    it('should reject invalid timezone', () => {
      const json = JSON.stringify({
        automations: {
          SchedulerTick: [{
            cron: '0 9 * * *',
            timezone: 'Not/A/Timezone',
            actions: [{ type: 'prompt', prompt: 'echo tick' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes('Invalid timezone'))).toBe(true);
    });

    it('should warn about the bypass permission mode, under either spelling', () => {
      const json = JSON.stringify({
        automations: {
          LabelAdd: [{
            permissionMode: 'allow-all',
            actions: [{ type: 'prompt', prompt: 'echo danger' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(true); // Warning, not error
      expect(result.warnings.some(w => w.message.includes('bypassPermissions'))).toBe(true);
    });

    it('should accept plan and acceptEdits permission modes', () => {
      for (const permissionMode of ['plan', 'acceptEdits']) {
        const json = JSON.stringify({
          automations: {
            LabelAdd: [{
              permissionMode,
              actions: [{ type: 'prompt', prompt: 'echo mode' }],
            }],
          },
        });
        const result = validateAutomationsContent(json);
        expect(result.valid).toBe(true);
      }
    });

    it('should warn about empty automations config', () => {
      const json = JSON.stringify({ automations: {} });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.message.includes('No automations configured'))).toBe(true);
    });

    it('should warn when cron is used on non-SchedulerTick event', () => {
      const json = JSON.stringify({
        automations: {
          LabelAdd: [{
            cron: '0 9 * * *',
            actions: [{ type: 'prompt', prompt: 'echo test' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.warnings.some(w => w.message.includes('SchedulerTick'))).toBe(true);
    });

    it('should accept valid simple regex patterns', () => {
      const json = JSON.stringify({
        automations: {
          LabelAdd: [{
            matcher: 'bug|feature|fix',
            actions: [{ type: 'prompt', prompt: 'echo matched' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(true);
    });

    it('should accept valid cron with timezone', () => {
      const json = JSON.stringify({
        automations: {
          SchedulerTick: [{
            cron: '15 16 * * *',
            timezone: 'Europe/Budapest',
            actions: [{ type: 'prompt', prompt: 'Schedule check' }],
          }],
        },
      });
      const result = validateAutomationsContent(json);
      expect(result.valid).toBe(true);
    });
  });

  describe('deprecated event aliases', () => {
    it('should accept TodoStateChange as deprecated alias', () => {
      const config = JSON.stringify({
        automations: {
          TodoStateChange: [{
            actions: [{ type: 'prompt', prompt: 'echo test' }],
          }],
        },
      });
      const result = validateAutomationsContent(config);
      expect(result.valid).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          path: 'automations.TodoStateChange',
          severity: 'warning',
          suggestion: expect.stringContaining('SessionStatusChange'),
        })
      );
    });

    it('should rewrite TodoStateChange to SessionStatusChange in schema transform', () => {
      const raw = {
        automations: {
          TodoStateChange: [{
            actions: [{ type: 'prompt', prompt: 'echo test' }],
          }],
        },
      };
      const result = AutomationsConfigSchema.safeParse(raw);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.automations['SessionStatusChange']).toBeDefined();
        expect(result.data.automations['TodoStateChange']).toBeUndefined();
      }
    });
  });

  describe('events Nessy does not emit (R73 · f001)', () => {
    const setupConfig = JSON.stringify({
      automations: {
        Setup: [{ actions: [{ type: 'prompt', prompt: 'install deps' }] }],
        SessionStart: [{ actions: [{ type: 'prompt', prompt: 'greet' }] }],
      },
    });

    it('warns with the reason and the replacement instead of dropping Setup in silence', () => {
      // The transform drops the key either way. What must not happen is the
      // author never learning why — hooks.md#setup fires the event only under
      // `--init-only` / `-p --init` / `-p --maintenance`, launch modes this fork
      // does not have, so a stored `Setup` automation is inert forever.
      const result = validateAutomationsContent(setupConfig);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          path: 'automations.Setup',
          severity: 'warning',
          message: expect.stringContaining('SessionStart'),
        })
      );
      // A warning, not an error: an inert entry must not fail the file and take
      // the working automations beside it down.
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('drops the entry from the parsed config so nothing can register on it', () => {
      const parsed = AutomationsConfigSchema.safeParse(JSON.parse(setupConfig));
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.automations['Setup']).toBeUndefined();
        expect(parsed.data.automations['SessionStart']).toBeDefined();
      }
    });
  });

  describe('permissionMode alias resolution', () => {
    const matcherWith = (permissionMode: string) => ({
      automations: {
        SessionStart: [{
          permissionMode,
          actions: [{ type: 'prompt', prompt: 'echo test' }],
        }],
      },
    });

    it("resolves Claude's and legacy spellings to internal mode keys", () => {
      for (const [spelling, mode] of [
        ['allow-all', 'bypassPermissions'],
        ['ask', 'default'],
        ['execute', 'bypassPermissions'],
        ['safe', 'plan'], // F1.1050: explore's old spelling follows it to plan
        ['explore', 'plan'],
      ] as const) {
        const result = AutomationsConfigSchema.safeParse(matcherWith(spelling));
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.automations['SessionStart']?.[0]?.permissionMode).toBe(mode);
        }
      }
    });

    it('still rejects an unknown mode string', () => {
      expect(AutomationsConfigSchema.safeParse(matcherWith('sudo')).success).toBe(false);
    });
  });
});

/**
 * P3.322 — the `if` filter reaches a native config, and an unknown key is
 * refused by name instead of vanishing.
 *
 * `AutomationMatcherSchema` was a plain `z.object` listing none of `ifRule`,
 * `ifSourceRoot` or `matchMode`, and zod strips what it does not declare. So an
 * author following hooks.md#common-fields — "Permission rule syntax to filter
 * when this hook runs" — got a hook that ran UNFILTERED with no trace: P2.288's
 * registration diagnostic is the plugin reader's, not this one's, and P2.277's
 * evaluation notice cannot fire either because by then there is no rule left to
 * be unparseable.
 *
 * Every native ingress passes through `validateAutomationsConfig`, so this is
 * the one gate that decides it for `automations.json`, `hooks.json`,
 * `config.json`'s `hooks`, `.nessy-agent/hooks.json` and resource bundles.
 */
describe('P3.322 — the documented `if` filter survives a native config', () => {
  const matcherOf = (extra: Record<string, unknown>) => ({
    automations: {
      PreToolUse: [{
        name: 'guard',
        actions: [{ type: 'prompt', prompt: 'echo hi' }],
        ...extra,
      }],
    },
  });
  const parsedMatcher = (extra: Record<string, unknown>) => {
    const result = validateAutomationsConfig(matcherOf(extra));
    return { result, matcher: result.config?.automations.PreToolUse?.[0] };
  };

  it('keeps `ifRule` and `matchMode`, beside the keys that always survived', () => {
    // The three positive controls are the ones that made the strip invisible:
    // they come back from the SAME parse, so a missing `ifRule` was never "the
    // parse failed" and always "this key is not declared".
    const { result, matcher } = parsedMatcher({
      matcher: 'Bash',
      worktree: true,
      enabled: true,
      ifRule: 'Bash(git *)',
      matchMode: 'claude',
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(matcher?.matcher).toBe('Bash');
    expect(matcher?.worktree).toBe(true);
    expect(matcher?.enabled).toBe(true);
    expect(matcher?.ifRule).toBe('Bash(git *)');
    expect(matcher?.matchMode).toBe('claude');
  });

  it('accepts the page\'s own spelling, `if`, and normalises it to `ifRule`', () => {
    // hooks.md#common-fields spells the field `if`; `plugins/schema.ts` has
    // always read both for imported hooks, so a native config written against
    // the same page must too.
    const { result, matcher } = parsedMatcher({ if: 'Edit(*.ts)' });
    expect(result.valid).toBe(true);
    expect(matcher?.ifRule).toBe('Edit(*.ts)');
  });

  it('refuses an unknown key BY NAME, naming the matcher it sits in', () => {
    // The defect's other half: before this row a typo was indistinguishable
    // from a key that did nothing, because both simply disappeared.
    const { result } = parsedMatcher({ ifRul: 'Bash(git *)' });
    expect(result.valid).toBe(false);
    expect(result.config).toBeNull();
    expect(result.errors.join('\n')).toContain('ifRul');
    // The path locates the offending matcher rather than the file.
    expect(result.errors.join('\n')).toContain('automations.PreToolUse.0');
  });

  it('refuses `ifSourceRoot` with its own reason, not the generic line', () => {
    // Host-supplied for imported plugin hooks (the plugin's own installed
    // bundle, owner decision 2026-07-29). Not admitted from a file a person
    // writes — and not dropped either, which is the whole row.
    const { result } = parsedMatcher({ ifRule: 'Edit(/scripts/**)', ifSourceRoot: '/tmp/anywhere' });
    expect(result.valid).toBe(false);
    const errors = result.errors.join('\n');
    expect(errors).toContain('ifSourceRoot');
    expect(errors).toContain('set by the host');
    // It must NOT be reported as merely unrecognised: the author needs the
    // reason, and the working-directory alternative.
    expect(errors).toContain('working directory');
  });

  it('refuses a matcher that spells the filter twice rather than picking a winner', () => {
    const { result } = parsedMatcher({ if: 'Bash(git *)', ifRule: 'Edit(*.ts)' });
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('"if"');
  });

  it('leaves an unparseable rule to the runtime, which is where the fail-open is documented', () => {
    // hooks.md#bash-if-matching — "Because the `if` filter is best-effort, use
    // the permission system rather than a hook to enforce a hard allow or
    // deny." This gate ADMITS the key; whether the rule compiles is P2.288's
    // question at registration and P2.277's at evaluation. Refusing it here
    // would be a third enforcement point over a filter that must fail open.
    const { result, matcher } = parsedMatcher({ ifRule: 'not a rule ((((' });
    expect(result.valid).toBe(true);
    expect(matcher?.ifRule).toBe('not a rule ((((');
  });
});

/**
 * C3.90 (owner answer QG5 = A, 2026-09-11) — the matcher divergence, named
 * where the matcher is authored.
 *
 * `hooks.md#matcher-patterns` reads a list as *"Exact string, or list of exact
 * strings separated by `|` or `,` with optional surrounding whitespace"*, and
 * gives `*` the meaning "matches every occurrence of the event". Only matchers
 * carrying `matchMode: 'claude'` (imported plugin hooks, imported Claude
 * settings) get that reading here; a NATIVE matcher is an unanchored regular
 * expression, and flipping that default would silently re-scope every stored
 * automation — which is why option B was refused and this row is a diagnostic.
 */
describe('C3.90 — the native matcher divergence is reported where it is written', () => {
  const nativeMatcher = (matcher: string, extra: Record<string, unknown> = {}) => ({
    automations: {
      PreToolUse: [{
        name: 'guard',
        matcher,
        actions: [{ type: 'prompt', prompt: 'echo hi' }],
        ...extra,
      }],
    },
  });

  it('warns on a comma, quoting the page and saying what it will really match', () => {
    const result = validateAutomationsContent(JSON.stringify(nativeMatcher('Edit,Write')));
    // A WARNING, never an error: nothing on disk changes and the automation is
    // still saved exactly as written.
    expect(result.valid).toBe(true);
    const warning = result.warnings.find(issue => issue.path === 'automations.PreToolUse[0].matcher');
    expect(warning?.message).toContain('hooks.md#matcher-patterns');
    expect(warning?.message).toContain('separated by `|` or `,`');
    expect(warning?.message).toContain('unanchored regular expression');
    expect(warning?.message).toContain('matches only the text "Edit,Write"');
    expect(warning?.suggestion).toContain('`|`');
  });

  it('refuses a native `*` with the documented meaning in the message, once', () => {
    const result = validateAutomationsContent(JSON.stringify(nativeMatcher('*')));
    // Already an error before this row — `new RegExp('*')` throws, so the
    // matcher could never fire — but the message said "nothing to repeat". What
    // changed is the sentence, and that it is now the ONLY one.
    expect(result.valid).toBe(false);
    const errors = result.errors.filter(issue => issue.path === 'automations.PreToolUse[0].matcher');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('matches every occurrence of the event');
    expect(errors[0]?.message).toContain('omitting the matcher entirely');
    expect(errors[0]?.message).not.toContain('nothing to repeat');
  });

  it('says neither about an IMPORTED matcher, where both spellings are documented', () => {
    // The control that the two diagnostics are keyed on `matchMode` and not on
    // the characters: the same two matchers under the imported contract are
    // correct, and `*` in particular must SURVIVE — it is the page's own
    // "matches every occurrence" spelling.
    const comma = validateAutomationsContent(JSON.stringify(nativeMatcher('Edit,Write', { matchMode: 'claude' })));
    expect(comma.valid).toBe(true);
    expect(comma.warnings.filter(issue => issue.path === 'automations.PreToolUse[0].matcher')).toEqual([]);

    const star = validateAutomationsContent(JSON.stringify(nativeMatcher('*', { matchMode: 'claude' })));
    expect(star.valid).toBe(true);
    expect(star.errors).toEqual([]);
  });

  it('still compiles an imported matcher that is NOT on the literal path', () => {
    // The boundary of the exemption: `matchMode: 'claude'` falls back to an
    // unanchored regex for anything outside the documented character class, so
    // the ReDoS guard must still see those.
    const result = validateAutomationsContent(JSON.stringify(nativeMatcher('.*(.*)+', { matchMode: 'claude' })));
    expect(result.valid).toBe(false);
    expect(result.errors.some(issue => issue.message.includes('catastrophic backtracking'))).toBe(true);
  });

  it('carries the warnings out of the OBJECT entry point, which used to drop them', () => {
    // `validateAutomationsConfig` passed `[]` for warnings, so every matcher
    // diagnostic was invisible to the three paths that LOAD a config. The
    // loaders print these; they are deliberately not added to `errors`, because
    // `AutomationSystem.reloadConfig` applies no automations at all when
    // `errors` is non-empty.
    const result = validateAutomationsConfig(nativeMatcher('Edit,Write'));
    expect(result.valid).toBe(true);
    expect(result.warnings?.some(line => line.includes('contains a comma'))).toBe(true);
  });
});
