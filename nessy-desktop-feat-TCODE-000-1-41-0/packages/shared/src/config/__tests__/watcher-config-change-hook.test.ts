/**
 * R73 · the `ConfigChange` producer seam in `ConfigWatcher`.
 *
 * hooks.md#configchange: "Runs when a configuration file changes during a
 * session […] ConfigChange hooks fire for changes to settings files, managed
 * policy settings, and skill files. The `source` field in the input tells you
 * which type of configuration changed, and the optional `file_path` field
 * provides the path to the changed file." The matcher table maps
 * `user_settings` → `~/.claude/settings.json`, `project_settings` →
 * `.claude/settings.json`, `skills` → "A skill file in `.claude/skills/`".
 *
 * And the block is real: "ConfigChange hooks can block configuration changes
 * from taking effect […] When blocked, the new settings are not applied to the
 * running session."
 *
 * The private dispatch methods are driven directly, the same way
 * `watcher-config-reload-fail-closed.test.ts` drives `reloadStoredConfig` — the
 * alternative is racing real `fs.watch` events, which is what makes a watcher
 * test flaky rather than what makes it real.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DIR } from '../paths.ts';
import { ConfigWatcher, type ConfigWatcherCallbacks } from '../watcher.ts';
import type { HookConfigChangeSource } from '../../automations/types.ts';

/** Above the watcher's 100 ms debounce, with headroom for a slow CI box. */
const AFTER_DEBOUNCE_MS = 250;

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function makeRunningWatcher(workspaceRoot: string, callbacks: ConfigWatcherCallbacks): ConfigWatcher {
  const watcher = new ConfigWatcher(workspaceRoot, callbacks);
  (watcher as unknown as { isRunning: boolean }).isRunning = true;
  return watcher;
}

interface Harness {
  watcher: ConfigWatcher;
  seen: Array<{ source: HookConfigChangeSource; filePath: string }>;
  reloads: string[];
  workspaceRoot: string;
}

function harness(allow: boolean | 'none', workspaceRoot: string): Harness {
  const seen: Array<{ source: HookConfigChangeSource; filePath: string }> = [];
  const reloads: string[] = [];
  const callbacks: ConfigWatcherCallbacks = {
    onConfigChange: () => { reloads.push('config'); },
    onAutomationsConfigChange: () => { reloads.push('automations'); },
    onUserGlobalHooksConfigChange: () => { reloads.push('user-hooks'); },
    onWorkspacePermissionsChange: () => { reloads.push('permissions'); },
    onSkillChange: () => { reloads.push('skill'); },
    ...(allow === 'none' ? {} : {
      onSettingsSourceChange: async (source, filePath) => {
        seen.push({ source, filePath });
        return allow;
      },
    }),
  };
  return { watcher: makeRunningWatcher(workspaceRoot, callbacks), seen, reloads, workspaceRoot };
}

type Dispatch = {
  handleGlobalConfigFileChange: (filename: string) => void;
  handleWorkspaceFileChange: (relativePath: string, eventType: string) => void;
};

describe('ConfigWatcher ConfigChange producer', () => {
  it('reports the documented source and an absolute file_path for each settings layer', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'nessy-cfgchange-'));
    const h = harness(true, workspaceRoot);
    const dispatch = h.watcher as unknown as Dispatch;
    try {
      dispatch.handleGlobalConfigFileChange('config.json');
      dispatch.handleGlobalConfigFileChange('hooks.json');
      dispatch.handleWorkspaceFileChange('permissions.json', 'change');
      dispatch.handleWorkspaceFileChange('automations.json', 'change');
      dispatch.handleWorkspaceFileChange('skills/review/SKILL.md', 'change');
      // `preferences.json` is appearance/UI state, not a settings layer the page
      // names — the negative that keeps the mapping honest.
      dispatch.handleGlobalConfigFileChange('preferences.json');
      await wait(AFTER_DEBOUNCE_MS);

      expect(h.seen.map(entry => entry.source).sort()).toEqual([
        'project_settings', 'project_settings', 'skills', 'user_settings', 'user_settings',
      ]);
      const byPath = new Map(h.seen.map(entry => [entry.filePath, entry.source]));
      expect(byPath.get(join(CONFIG_DIR, 'config.json'))).toBe('user_settings');
      expect(byPath.get(join(CONFIG_DIR, 'hooks.json'))).toBe('user_settings');
      expect(byPath.get(join(workspaceRoot, 'permissions.json'))).toBe('project_settings');
      expect(byPath.get(join(workspaceRoot, 'automations.json'))).toBe('project_settings');
      expect(byPath.get(join(workspaceRoot, 'skills', 'review', 'SKILL.md'))).toBe('skills');
      // No `local_settings` and no `policy_settings`: Nessy has no `.local`
      // settings file, and managed policy arrives from the gateway rather than a
      // watched file. A matcher naming either correctly never fires.
      expect(h.seen.some(entry => entry.source === 'local_settings')).toBe(false);
      expect(h.seen.some(entry => entry.source === 'policy_settings')).toBe(false);
    } finally {
      h.watcher.stop();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('does not apply the change when the hook blocks it, and applies it when it does not', async () => {
    for (const [allow, expected] of [[false, []], [true, ['automations']]] as const) {
      const workspaceRoot = mkdtempSync(join(tmpdir(), 'nessy-cfgchange-block-'));
      const h = harness(allow, workspaceRoot);
      try {
        (h.watcher as unknown as Dispatch).handleWorkspaceFileChange('hooks.json', 'change');
        await wait(AFTER_DEBOUNCE_MS);
        expect(h.seen).toHaveLength(1);
        expect(h.reloads).toEqual([...expected]);
      } finally {
        h.watcher.stop();
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    }
  });

  it('keeps the reload on its original synchronous tick when no gate is wired', () => {
    // The compatibility half. With no `onSettingsSourceChange` the apply must
    // run inside the debounce callback itself, with no microtask hop — every
    // existing embedder and test depends on that ordering.
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'nessy-cfgchange-nogate-'));
    const h = harness('none', workspaceRoot);
    try {
      const applied: string[] = [];
      (h.watcher as unknown as {
        applySettingsChange: (s: HookConfigChangeSource, p: string, apply: () => void) => void;
      }).applySettingsChange('user_settings', '/x/config.json', () => { applied.push('now'); });
      expect(applied).toEqual(['now']);
    } finally {
      h.watcher.stop();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('applies the change when the gate throws or rejects (fail open)', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'nessy-cfgchange-failopen-'));
    const applied: string[] = [];
    const watcher = makeRunningWatcher(workspaceRoot, {
      onSettingsSourceChange: () => { throw new Error('hook exploded'); },
    });
    const rejecting = makeRunningWatcher(workspaceRoot, {
      onSettingsSourceChange: () => Promise.reject(new Error('hook exploded later')),
    });
    try {
      type Apply = { applySettingsChange: (s: HookConfigChangeSource, p: string, a: () => void) => void };
      (watcher as unknown as Apply).applySettingsChange('user_settings', '/x/config.json', () => { applied.push('sync-throw'); });
      (rejecting as unknown as Apply).applySettingsChange('user_settings', '/x/config.json', () => { applied.push('async-reject'); });
      await wait(20);
      // A hook that crashes has decided nothing; freezing a user's settings on a
      // crash is the worse failure, and hooks.md's block is an explicit
      // `decision`, never an accident.
      expect(applied.sort()).toEqual(['async-reject', 'sync-throw']);
    } finally {
      watcher.stop();
      rejecting.stop();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
