/**
 * The seam between the plugin runtime env contract (`plugins/data-paths.ts`)
 * and the Bash read-only guard (`agent/bash-validator.ts`).
 *
 * Q5-D1, measured live on the signed 1.25.1 artifact: the owner's plugin ships
 * `node "${CLAUDE_PLUGIN_ROOT}/hooks/honey-session.js"` as its `SessionStart`
 * hook — the documented way for a bundle to name a file inside itself — and the
 * guard answered `Bash command blocked: contains ${} / $VAR syntax`. We emit the
 * variable and then refused every command that used it.
 *
 * The negative half is the important half: opening the guard generally would be
 * worse than the bug, so every other expansion form is asserted still blocked.
 */
import { describe, expect, it } from 'bun:test';
import { buildHookCommandEnv } from '../../automations/hook-command.ts';
import { getBashRejectionReason } from '../../agent/mode-manager.ts';
import { SAFE_MODE_CONFIG } from '../../agent/mode-types.ts';
import { PLUGIN_RUNTIME_ENV_KEYS, pluginRuntimeEnvForProfile } from '../data-paths.ts';

/**
 * `SAFE_MODE_CONFIG` ships empty patterns (the real ones load from
 * `permissions/default.json`), so give the read-only allowlist just enough to
 * make the expansion the only thing under test. `node` is deliberately NOT
 * allowlisted — see the last case.
 */
const CONFIG = {
  ...SAFE_MODE_CONFIG,
  readOnlyBashPatterns: [
    { regex: /^cat\b/, source: '^cat\\b', comment: 'Concatenate and display files' },
    { regex: /^ls\b/, source: '^ls\\b', comment: 'List directory contents' },
  ],
};

const rejection = (command: string) => getBashRejectionReason(command, CONFIG);

describe('plugin runtime env names in a read-only Bash command', () => {
  it('lets a hook name its own plugin root (Q5-D1 repro, brace and bare form)', () => {
    expect(rejection('cat "${NESSY_PLUGIN_ROOT}/hooks/x.js"')).toBeNull();
    expect(rejection('cat $NESSY_PLUGIN_ROOT/hooks/x.js')).toBeNull();
  });

  it('permits every name the host injects, and nothing is left to retype', () => {
    // The set is derived from the env builders, so this loop covers whatever
    // they emit today — a name added there is covered on the same commit.
    expect(PLUGIN_RUNTIME_ENV_KEYS).toContain('NESSY_PLUGIN_ROOT');
    expect(PLUGIN_RUNTIME_ENV_KEYS).toContain('PLUGIN_ROOT');
    expect(PLUGIN_RUNTIME_ENV_KEYS).toContain('CLAUDE_PLUGIN_ROOT');
    expect(PLUGIN_RUNTIME_ENV_KEYS).toContain('CLAUDE_PLUGIN_DATA');
    for (const name of PLUGIN_RUNTIME_ENV_KEYS) {
      expect(rejection(`cat "\${${name}}/x"`)).toBeNull();
      expect(rejection(`cat $${name}/x`)).toBeNull();
    }
  });

  it('still blocks command substitution, backticks and process substitution', () => {
    expect(rejection('cat $(whoami)')?.type).toBe('dangerous_substitution');
    expect(rejection('cat `whoami`')?.type).toBe('dangerous_substitution');
    expect(rejection('cat <(whoami)')).not.toBeNull();
  });

  it('still blocks every variable the host does not compute', () => {
    for (const command of [
      'cat "${HOME}/.ssh/id_rsa"',
      'cat $HOME/.ssh/id_rsa',
      'cat "$PATH"',
      // A near-miss name: the match is exact, never a prefix.
      'cat "${NESSY_PLUGIN_ROOTX}/x"',
      'cat "${NESSY_PLUGIN}/x"',
    ]) {
      expect(rejection(command)?.type).toBe('dangerous_substitution');
    }
  });

  it('still blocks every MODIFIER form of a permitted name', () => {
    for (const command of [
      // The one that matters: bash-parser nests the operand's own expansions
      // inside `word`, where the top-level scan never looks — permitting this
      // shape would smuggle `$(whoami)` past the permitted name.
      'cat "${NESSY_PLUGIN_ROOT:-$(whoami)}"',
      'cat "${NESSY_PLUGIN_ROOT:-/etc/passwd}"',
      'cat "${NESSY_PLUGIN_ROOT:=/etc/passwd}"',
      'cat "${NESSY_PLUGIN_ROOT#/}"',
      'cat "${NESSY_PLUGIN_ROOT%/x}"',
      'cat "${NESSY_PLUGIN_ROOT/a/b}"',
      'cat "${!NESSY_PLUGIN_ROOT}"',
      'cat "${#NESSY_PLUGIN_ROOT}"',
    ]) {
      expect(rejection(command)?.type).toBe('dangerous_substitution');
    }
  });

  it('leaves the read-only allowlist as the authority on WHICH command runs', () => {
    // The permitted expansion is not an allow: the literal text still has to
    // match a read-only pattern. `node` matches none, in either position.
    expect(rejection('node "${NESSY_PLUGIN_ROOT}/hooks/x.js"')?.type).toBe('no_safe_pattern');
    expect(rejection('"${NESSY_PLUGIN_ROOT}/bin/tool" --flag')?.type).toBe('no_safe_pattern');
  });
});

describe('the permitted names are populated where a plugin hook runs', () => {
  it('carries the host-computed roots into the hook spawn environment', () => {
    const actionEnv = pluginRuntimeEnvForProfile('claude-plugin-env-v1', {
      bundleRoot: '/managed/plugin-cache/honey',
      dataPath: '/managed/plugin-data/honey/global',
      projectPath: '/validated/project',
    });
    const env = buildHookCommandEnv('SessionStart', { hook_event_name: 'SessionStart' }, actionEnv);

    // A permitted-but-empty variable would expand to `/hooks/x.js`, which is a
    // confusing failure rather than a working hook — so assert the value, not
    // just the key.
    expect(env.NESSY_PLUGIN_ROOT).toBe('/managed/plugin-cache/honey');
    expect(env.CLAUDE_PLUGIN_ROOT).toBe('/managed/plugin-cache/honey');
    expect(env.NESSY_PLUGIN_DATA).toBe('/managed/plugin-data/honey/global');
    expect(env.NESSY_PROJECT_DIR).toBe('/validated/project');
    for (const name of PLUGIN_RUNTIME_ENV_KEYS) {
      expect(env[name]).toBeTruthy();
    }
  });
});
