/**
 * Per-Workspace `CLAUDE_CONFIG_DIR` for the Claude agent subprocess (B3 Task 3).
 *
 * `env-vars.md:356` — the variable overrides "the configuration directory
 * (default: `~/.claude`). All settings, session history, and plugins are stored
 * under this path". One directory for every Workspace is one policy and history
 * store for every Workspace.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { CONFIG_DIR } from '../../config/paths.ts';
import { buildClaudeSubprocessEnv, getDefaultOptions, workspaceClaudeConfigDir } from '../options.ts';

function envFor(workspaceId?: string): NodeJS.ProcessEnv {
  const previous = process.env.NESSY_WORKSPACE_ID;
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  try {
    if (workspaceId === undefined) delete process.env.NESSY_WORKSPACE_ID;
    return buildClaudeSubprocessEnv(workspaceId === undefined ? {} : { NESSY_WORKSPACE_ID: workspaceId });
  } finally {
    if (previous === undefined) delete process.env.NESSY_WORKSPACE_ID;
    else process.env.NESSY_WORKSPACE_ID = previous;
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  }
}

describe('per-Workspace Claude config directory', () => {
  it('gives two Workspaces two config directories, both under the managed root', () => {
    const first = envFor('workspace-one').CLAUDE_CONFIG_DIR;
    const second = envFor('workspace-two').CLAUDE_CONFIG_DIR;

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
    for (const dir of [first!, second!]) {
      expect(dir.startsWith(CONFIG_DIR)).toBe(true);
      // Created eagerly: the SDK subprocess is pointed at it before it starts.
      expect(existsSync(dir)).toBe(true);
    }
  });

  it('overrides an ambient CLAUDE_CONFIG_DIR rather than inheriting it', () => {
    // An account-switching value in the developer's shell (`env-vars.md:356`'s
    // documented use) must not put two Workspaces back in one directory.
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = '/tmp/ambient-claude-config';
    try {
      expect(envFor('workspace-one').CLAUDE_CONFIG_DIR).not.toBe('/tmp/ambient-claude-config');
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  it('leaves the variable alone when there is no Workspace to scope to', () => {
    // `getDefaultOptions()` with no overrides is the host-level validation path
    // (`url-validator`, `llm-validation`), which has no Workspace and must keep
    // whatever the host environment already said.
    const previous = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      expect('CLAUDE_CONFIG_DIR' in envFor(undefined)).toBe(false);
    } finally {
      if (previous !== undefined) process.env.CLAUDE_CONFIG_DIR = previous;
    }
    expect(workspaceClaudeConfigDir(undefined)).toBeUndefined();
    expect(workspaceClaudeConfigDir('')).toBeUndefined();
  });

  it('reaches the SDK subprocess through the options the turn path builds', () => {
    // The series' recurring defect is a helper nothing consumes. `getDefaultOptions`
    // is what `chatImpl` spreads, and its `env` is the SDK's `Options.env` — the
    // environment the subprocess is actually spawned with.
    const options = getDefaultOptions({ NESSY_WORKSPACE_ID: 'workspace-one' });
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe(workspaceClaudeConfigDir('workspace-one'));
  });

  it('refuses an invalid Workspace ID instead of falling back to the shared directory', () => {
    // A silent fallback would reunite two Workspaces exactly when the identity is
    // untrustworthy, which is the wrong direction to fail in.
    expect(() => workspaceClaudeConfigDir('../escape')).toThrow('Invalid workspace storage ID');
  });
});
