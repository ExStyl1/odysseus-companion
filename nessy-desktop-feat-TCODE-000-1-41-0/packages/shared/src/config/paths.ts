/**
 * Centralized path configuration for Nessy Desktop.
 *
 * Supports multi-instance development via NESSY_CONFIG_DIR environment variable.
 * When running from a numbered folder (e.g., nessy-tui-agent-1), the detect-instance.sh
 * script sets NESSY_CONFIG_DIR to ~/.nessy-agent-1, allowing multiple instances to run
 * simultaneously with separate configurations.
 *
 * Default (non-numbered folders): ~/.nessy-agent/
 * Instance 1 (-1 suffix): ~/.nessy-agent-1/
 * Instance 2 (-2 suffix): ~/.nessy-agent-2/
 */

import { homedir } from 'os';
import { join, resolve } from 'path';

export const STORAGE_LAYOUT_VERSION = 2 as const;
export const DEFAULT_CONFIG_DIR = resolve(join(homedir(), '.nessy-agent'));
const CONFIG_DIR_OVERRIDE = process.env.NESSY_CONFIG_DIR?.trim();
export const IS_DEFAULT_CONFIG_DIR = !CONFIG_DIR_OVERRIDE;
export const CONFIG_DIR = resolve(CONFIG_DIR_OVERRIDE || DEFAULT_CONFIG_DIR);

// `bun test` sets NODE_ENV=test. CONFIG_DIR freezes at first import, so a test
// process without the repo-root `[test].preload` (isolate-shared-config-dir.ts
// sets NESSY_CONFIG_DIR to a per-run temp dir) would read — and any production
// SessionManager under test would WRITE — the developer's real ~/.nessy-agent.
// That already corrupted a real config.json once (a suite's fixture registry
// replaced it wholesale). Running `bun test` from a package directory skips the
// root bunfig.toml; fail fast instead of leaking.
if (process.env.NODE_ENV === 'test' && IS_DEFAULT_CONFIG_DIR) {
  throw new Error(
    'CONFIG_DIR isolation missing in a test process: run `bun test` from the repo root '
    + 'so bunfig.toml preloads isolate-shared-config-dir.ts, or set NESSY_CONFIG_DIR '
    + 'to a temp directory. Refusing to touch the real ~/.nessy-agent.',
  );
}

/**
 * DA1.72 — MOVED HERE FROM `config/storage.ts`, unchanged: one `join` over the
 * {@link CONFIG_DIR} above it, and `config/validators.ts`'s import of it from
 * `storage.ts` was the other edge of the validators/storage cycle that put the
 * credential manager, the session store and the docs initialiser behind every
 * `loadStoredConfig`. `storage.ts` re-exports it, so every caller is unchanged.
 */
const TOOL_ICONS_DIR_NAME = 'tool-icons';

/**
 * Returns the path to the tool-icons directory: ~/.nessy-agent/tool-icons/
 */
export function getToolIconsDir(): string {
  return join(CONFIG_DIR, TOOL_ICONS_DIR_NAME);
}
