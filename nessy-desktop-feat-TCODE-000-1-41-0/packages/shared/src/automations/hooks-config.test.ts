import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HOOKS_CONFIG_FILE, loadLifecycleHooksConfig, parseHooksConfigContent } from './hooks-config.ts';
import { HOOK_NOTIFICATION_TYPES, HOOK_NOTIFICATION_TYPES_WITHOUT_EMITTER } from './types.ts';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-config-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('loadLifecycleHooksConfig', () => {
  it('loads lifecycle hooks from hooks.json and workspace config.json', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, HOOKS_CONFIG_FILE), JSON.stringify({
        hooks: {
          PreToolUse: [{
            matcher: '^Bash$',
            actions: [{ type: 'command', command: 'node ./hooks/pretool.js' }],
          }],
        },
      }));
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        hooks: {
          SessionStart: [{
            actions: [{ type: 'webhook', url: 'https://example.com/hook' }],
          }],
        },
      }));

      const result = loadLifecycleHooksConfig(dir);

      expect(result.errors).toEqual([]);
      expect(result.sources).toEqual(['config.json hooks', HOOKS_CONFIG_FILE]);
      expect(result.config.automations.SessionStart).toHaveLength(1);
      expect(result.config.automations.PreToolUse).toHaveLength(1);
      expect(result.config.automations.PreToolUse?.[0]?.actions[0]).toMatchObject({
        type: 'command',
        command: 'node ./hooks/pretool.js',
      });
    });
  });

  it('reads root-level disableAllHooks from every settings shape and omits it otherwise', () => {
    // hooks.md:612 — the switch is a root-level settings key beside `hooks`.
    withTempDir((dir) => {
      writeFileSync(join(dir, HOOKS_CONFIG_FILE), JSON.stringify({
        disableAllHooks: true,
        hooks: { PreToolUse: [{ actions: [{ type: 'command', command: 'node guard.js' }] }] },
      }));

      const result = loadLifecycleHooksConfig(dir);
      expect(result.disableAllHooks).toBe(true);
      // The hooks stay in the parsed config — "without removing them" — the
      // consumer is what turns execution off.
      expect(result.config.automations.PreToolUse).toHaveLength(1);
    });
    withTempDir((dir) => {
      // config.json honors the key even with no hooks of its own.
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ disableAllHooks: true }));
      expect(loadLifecycleHooksConfig(dir).disableAllHooks).toBe(true);
    });
    withTempDir((dir) => {
      // The bare-map form: the root key must not be read as an event name.
      writeFileSync(join(dir, HOOKS_CONFIG_FILE), JSON.stringify({
        disableAllHooks: true,
        PreToolUse: [{ actions: [{ type: 'command', command: 'node guard.js' }] }],
      }));
      const result = loadLifecycleHooksConfig(dir);
      expect(result.disableAllHooks).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.config.automations.PreToolUse).toHaveLength(1);
    });
    withTempDir((dir) => {
      // Omission and `false` are both absent — no drop, no behavior change.
      writeFileSync(join(dir, HOOKS_CONFIG_FILE), JSON.stringify({
        disableAllHooks: false,
        hooks: { PreToolUse: [{ actions: [{ type: 'command', command: 'node guard.js' }] }] },
      }));
      const result = loadLifecycleHooksConfig(dir);
      expect(result.disableAllHooks).toBeUndefined();
      expect(result.config.automations.PreToolUse).toHaveLength(1);
    });
  });

  it('rejects app events in hook config', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, HOOKS_CONFIG_FILE), JSON.stringify({
        hooks: {
          LabelAdd: [{
            actions: [{ type: 'webhook', url: 'https://example.com/hook' }],
          }],
        },
      }));

      const result = loadLifecycleHooksConfig(dir);

      expect(result.config.automations.LabelAdd).toBeUndefined();
      expect(result.errors).toContain(`${HOOKS_CONFIG_FILE}: LabelAdd is not an agent lifecycle hook event`);
    });
  });

  it('names the reason when a hooks file declares an event Nessy does not emit (R73 · f001)', () => {
    // A hand-written `Setup` block used to load and register. It cannot now —
    // hooks.md#setup fires the event only under `--init-only` / `-p --init` /
    // `-p --maintenance`, and this fork has no such launch mode. The schema
    // transform would drop the key with nothing but a console line, which is
    // the silently-dead hook this finding is about, so the reason is read from
    // the RAW map before validation and surfaces as a load error.
    withTempDir((dir) => {
      writeFileSync(join(dir, HOOKS_CONFIG_FILE), JSON.stringify({
        hooks: {
          Setup: [{ actions: [{ type: 'command', command: './install-deps.sh' }] }],
          SessionStart: [{ actions: [{ type: 'webhook', url: 'https://example.com/hook' }] }],
        },
      }));

      const result = loadLifecycleHooksConfig(dir);

      // `Setup` is deliberately absent from `AutomationEvent`, so it cannot be
      // named on the typed map at all — the compiler is restating this test's own
      // premise. Asserting on the key set says the same thing without reaching for
      // a cast, and says it more strictly: `toBeUndefined()` also passes for a key
      // that IS present holding `undefined`.
      expect(Object.keys(result.config.automations)).not.toContain('Setup');
      // The rest of the file still loads — one unsupported entry must not cost
      // the author their working hooks.
      expect(result.config.automations.SessionStart).toHaveLength(1);
      // C3.284 — a WARNING, not an error. `AutomationSystem.reloadConfig` then
      // applied nothing at all for a non-empty `errors`, so an unemitted event
      // used to turn every automation in the workspace off on the next reload.
      const setupNote = (result.warnings ?? []).find(warning => warning.includes('Setup'));
      expect(setupNote).toContain('is not supported by Nessy');
      expect(setupNote).toContain('SessionStart');
      expect(result.errors).toEqual([]);
    });
  });
});

describe('Notification vocabulary and its emitterless complement (P6.293)', () => {
  it('carries all twelve documented types', () => {
    // hooks-guide.md#get-notified-when-claude-needs-input, and the same twelve in
    // the event table's `Notification` row. The list carried eight until P6.293.
    expect(HOOK_NOTIFICATION_TYPES).toHaveLength(12);
    for (const documented of [
      'permission_prompt', 'idle_prompt', 'auth_success', 'elicitation_dialog',
      'elicitation_url_dialog', 'elicitation_complete', 'elicitation_response',
      'agent_needs_input', 'agent_completed',
      'quota_auto_resume_fired', 'quota_auto_resume_stale', 'quota_auto_resume_disabled',
    ]) {
      expect(HOOK_NOTIFICATION_TYPES).toContain(documented as never);
    }
  });

  it('declares a reason for every type except the one Nessy actually emits', () => {
    // Pins the COMPLEMENT in both directions: adding a type without a reason, or
    // keeping a reason after an emitter appears, goes red here.
    const withoutEmitter = Object.keys(HOOK_NOTIFICATION_TYPES_WITHOUT_EMITTER).sort();
    const expected = HOOK_NOTIFICATION_TYPES.filter(t => t !== 'permission_prompt').slice().sort();
    expect(withoutEmitter).toEqual(expected as unknown as string[]);
  });

  it('warns when a matcher names a type this runtime never emits, and keeps the hook', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, HOOKS_CONFIG_FILE), JSON.stringify({
        hooks: {
          Notification: [{
            matcher: 'quota_auto_resume_fired',
            actions: [{ type: 'command', command: 'echo hi' }],
          }],
        },
      }));

      const result = loadLifecycleHooksConfig(dir);

      // C3.284 — on the WARNINGS channel, which is what "reported, not
      // rejected" has to mean for the machine as well as for the reader: an
      // `errors` entry is surfaced as a hook that will not run (F1.229).
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0]).toContain('quota_auto_resume_fired');
      expect(result.warnings![0]).toContain('will never run');
      expect(result.errors).toEqual([]);
      // Reported, not rejected: the hook is portable and correct — it simply has
      // no producer here.
      expect(result.config.automations.Notification).toHaveLength(1);
    });
  });

  it('CONTROL — the one type with an emitter registers silently', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, HOOKS_CONFIG_FILE), JSON.stringify({
        hooks: {
          Notification: [{
            matcher: 'permission_prompt',
            actions: [{ type: 'command', command: 'echo hi' }],
          }],
        },
      }));

      const result = loadLifecycleHooksConfig(dir);

      expect(result.errors).toEqual([]);
      // C3.284's control: the one type with an emitter raises nothing on EITHER
      // channel, so the warning above is a discriminator rather than a constant.
      expect(result.warnings ?? []).toEqual([]);
      expect(result.config.automations.Notification).toHaveLength(1);
    });
  });

  it('CONTROL — a broad regex matcher is not misreported', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, HOOKS_CONFIG_FILE), JSON.stringify({
        hooks: {
          Notification: [{
            matcher: 'quota_.*',
            actions: [{ type: 'command', command: 'echo hi' }],
          }],
        },
      }));

      // Exact-match only: a pattern is not resolved into the type set, so a broad
      // matcher that could also cover an emitted type stays silent.
      expect(loadLifecycleHooksConfig(dir).errors).toEqual([]);
    });
  });
});

/**
 * F1.898 (origin SIT-ab, 2026-09-25) — a native `hooks.json` written in Claude's
 * settings shape (`hooks.md#configuration`: a matcher group carries an inner
 * `hooks: [...]` array of handlers) was refused with
 * `PermissionDenied.0.actions: expected array`, so 0 hooks ran. Every native door
 * (the user-global, workspace and project `hooks.json`, a workspace `config.json`
 * `hooks` block) reads through `parseHooksConfigContent`, so that is what is driven.
 */
describe('a hooks document in Claude settings shape (F1.898)', () => {
  it('loads a Claude-shaped group as a claude-matcher automation, handler `if` lifted onto the matcher', () => {
    const result = parseHooksConfigContent(JSON.stringify({
      hooks: {
        PermissionDenied: [{
          matcher: 'mcp__probe__.*',
          hooks: [{ type: 'command', command: './hook-denied.sh' }],
        }],
        // Handlers whose `if` differ cannot share one matcher, so each becomes its own.
        PreToolUse: [{
          matcher: 'Edit|Write',
          hooks: [
            { type: 'command', command: 'node lint.js', if: 'Edit(src/**)' },
            { type: 'command', command: 'node log.js' },
          ],
        }],
      },
    }), 'hooks.json');

    expect(result.errors).toEqual([]);
    expect(result.sources).toEqual(['hooks.json']);
    // F1.1176 — `blockOnNonZero: false` is Claude's exit-code contract riding the handler.
    expect(result.config.automations.PermissionDenied).toEqual([{
      matcher: 'mcp__probe__.*',
      matchMode: 'claude',
      actions: [{ type: 'command', command: './hook-denied.sh', blockOnNonZero: false }],
    }]);
    expect(result.config.automations.PreToolUse).toEqual([
      {
        matcher: 'Edit|Write',
        matchMode: 'claude',
        ifRule: 'Edit(src/**)',
        actions: [{ type: 'command', command: 'node lint.js', blockOnNonZero: false }],
      },
      {
        matcher: 'Edit|Write',
        matchMode: 'claude',
        actions: [{ type: 'command', command: 'node log.js', blockOnNonZero: false }],
      },
    ]);
  });

  it('CONTROL — our own `actions` shape parses exactly as before, with no claude matcher mode added', () => {
    const native = {
      hooks: {
        PreToolUse: [{
          matcher: '^Bash$',
          actions: [{ type: 'command' as const, command: 'node ./hooks/pretool.js' }],
        }],
      },
    };
    const result = parseHooksConfigContent(JSON.stringify(native), 'hooks.json');
    expect(result.errors).toEqual([]);
    expect(result.config).toEqual({ automations: native.hooks });
  });

  it('BOUNDARY — a group that spells BOTH `actions` and `hooks` is refused by name, not resolved', () => {
    const result = parseHooksConfigContent(JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: 'Bash',
          actions: [{ type: 'command', command: 'a' }],
          hooks: [{ type: 'command', command: 'b' }],
        }],
      },
    }), 'hooks.json');
    expect(result.config.automations).toEqual({});
    expect(result.errors.join('\n')).toContain('hooks');
  });
});

/**
 * F1.1177 — the Claude handler fields and types a hooks document used to drop
 * or load without a word. The spawn itself is driven in
 * `plugins/__tests__/settings-tier-command-hook-dispatch.test.ts`.
 */
describe('Claude-shape handler `args` and non-command types (F1.1177)', () => {
  const load = (handler: Record<string, unknown>) => parseHooksConfigContent(JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [handler] }] },
  }), 'hooks.json');

  it('keeps an exec-form `args` list on the action, and names a handler type that never runs here', () => {
    const execForm = load({ type: 'command', command: 'python3', args: ['guard.py'] });
    expect(execForm.errors).toEqual([]);
    expect(execForm.warnings).toEqual([]);
    expect(execForm.config.automations.PreToolUse?.[0]?.actions).toEqual([
      { type: 'command', command: 'python3', args: ['guard.py'], blockOnNonZero: false },
    ]);
    const http = load({ type: 'http', url: 'https://hooks.invalid/pre' });
    expect(http.errors).toEqual([]);
    expect(http.warnings).toEqual([
      'hooks.json: PreToolUse has a "http" handler, which Nessy does not run from a hooks file; '
        + 'of Claude\'s handler types only "command" runs there, so this one never runs',
    ]);
  });

  it('BOUNDARY — an `args` that is not a list of strings is refused by path, not run through the shell', () => {
    for (const args of ['guard.py', ['guard.py', 3]]) {
      const result = load({ type: 'command', command: 'python3', args });
      expect(result.config.automations).toEqual({});
      expect(result.errors).toEqual(['hooks.json: automations.PreToolUse[0].actions[0].args: `args` must be a list of strings, one argument each']);
    }
  });
});

/**
 * F1.1094 — the remaining Claude handler fields (`hooks.md#common-fields`) on the native Claude-shape path, which the
 * `~/.claude/settings.json` import shares: `timeout` (seconds) and `statusMessage` were dropped; `once` is "Only honored
 * for hooks declared in skill frontmatter; ignored in settings files and agent frontmatter", so dropping it here IS
 * the contract (the skill tier honours it: `runtime-skill-content.ts`).
 */
describe('Claude-shape handler `timeout`, `statusMessage` and `once` (F1.1094)', () => {
  const actionOf = (handler: Record<string, unknown>) => {
    const result = parseHooksConfigContent(JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [handler] }] },
    }), 'hooks.json');
    expect(result.errors).toEqual([]);
    return result.config.automations.PreToolUse?.[0]?.actions?.[0];
  };

  it('a `timeout` in seconds becomes the action\'s timeoutMs and `statusMessage` rides it; `once` is ignored, as documented', () => {
    expect(actionOf({ type: 'command', command: 'node guard.js', timeout: 5, statusMessage: 'Guarding', once: true })).toEqual({
      type: 'command', command: 'node guard.js', timeoutMs: 5000, statusMessage: 'Guarding', blockOnNonZero: false,
    });
  });

  it('BOUNDARY — a timeout above our 120 s command ceiling is clamped to it, a spelled timeoutMs wins, a non-positive one is dropped', () => {
    expect(actionOf({ type: 'command', command: 'a', timeout: 600 })).toMatchObject({ timeoutMs: 120_000 });
    expect(actionOf({ type: 'command', command: 'a', timeout: 5, timeoutMs: 7000 })).toMatchObject({ timeoutMs: 7000 });
    expect(actionOf({ type: 'command', command: 'a', timeout: 0 })).not.toHaveProperty('timeoutMs');
  });
});
