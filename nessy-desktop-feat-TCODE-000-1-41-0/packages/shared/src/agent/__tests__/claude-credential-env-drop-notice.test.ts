/**
 * P6.260 — four credential and base-URL names are deleted from the environment
 * before the claude child spawns, and nobody was told.
 *
 * Denominator C23, verbatim: *"The SDK's own conflict warning is unreachable: we
 * delete the names from `process.env` before the child spawns, so it never sees
 * the conflict. The host must say it — case (2) — and the precedent is in the
 * same file family, where the LAUNCHER scrub was deliberately made to announce
 * itself (P3.300)."*
 *
 * Two properties, and the second is the one worth a test of its own:
 *  1. a name that WAS exported produces exactly one line naming it;
 *  2. **no line ever carries the value.** Three of the four are credentials, so
 *     a diagnostic that printed one would convert a disclosure into a leak — the
 *     failure this whole drop exists to prevent.
 *
 * C30's verdict rides the `ANTHROPIC_BASE_URL` line: *dropped and not
 * overridable*, because the session's connection decides the endpoint on both
 * paths and the environment gets no vote.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { ClaudeAgent } from '../claude-agent.ts';
import { enableDebug } from '../../utils/debug.ts';
import type { BackendConfig } from '../backend/types.ts';

const NAMES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const;

const SECRET = 'sk-ant-w7s1-not-a-real-token';

function createConfig(): BackendConfig {
  return {
    provider: 'anthropic',
    workspace: {
      id: 'ws-claude-cred-drop',
      name: 'Claude Credential Drop Workspace',
      rootPath: '/tmp/ws-claude-cred-drop',
      workspaceRootPath: '/tmp/ws-claude-cred-drop',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-claude-cred-drop',
    } as never,
    session: {
      id: 'session-claude-cred-drop',
      workspaceRootPath: '/tmp/ws-claude-cred-drop',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as never,
    model: 'claude-sonnet-4-5',
    isHeadless: true,
  } as BackendConfig;
}

const prior: Partial<Record<(typeof NAMES)[number], string>> = {};
for (const name of NAMES) {
  const value = { ...process.env }[name];
  if (value !== undefined) prior[name] = value;
}

afterEach(() => {
  for (const name of NAMES) {
    // `delete` first, then assign — assigning straight to `process.env.X` in
    // Bun 1.3.14 can leave the name readable by property and invisible to a
    // spread, which is how the method under test reads it.
    delete process.env[name];
    const value = prior[name];
    if (value !== undefined) process.env[name] = value;
  }
});

/** Drive the private announcer and collect the lines it emitted. */
function announce(exported: Partial<Record<(typeof NAMES)[number], string>>): string[] {
  for (const name of NAMES) {
    delete process.env[name];
    const value = exported[name];
    if (value !== undefined) process.env[name] = value;
  }
  const agent = new ClaudeAgent(createConfig());
  const lines: string[] = [];
  const internals = agent as unknown as {
    announceClaudeCredentialEnvDrops(): void;
  };
  // `debug()` writes to stderr behind a module-scoped flag that is read once at
  // import time, so the flag is turned on through its own setter and the SINK is
  // captured — reading `NESSY_DEBUG` here would be too late to matter.
  enableDebug();
  const write = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (chunk: string) => boolean }).write = chunk => {
    lines.push(String(chunk));
    return true;
  };
  try {
    internals.announceClaudeCredentialEnvDrops();
  } finally {
    (process.stderr as unknown as { write: typeof write }).write = write;
    agent.destroy();
  }
  return lines.filter(line => line.includes('P6.260'));
}

describe('every dropped name is announced, and only the ones that were there', () => {
  it('names a credential that WAS exported', () => {
    const lines = announce({ ANTHROPIC_API_KEY: SECRET });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ANTHROPIC_API_KEY');
  });

  it('says nothing when nobody exported anything', () => {
    // A name nobody set was not dropped, and three lines of "did not happen" on
    // every session start would bury the case that matters.
    expect(announce({})).toEqual([]);
  });

  it('carries C30\'s verdict on the base URL — dropped AND not overridable', () => {
    const lines = announce({ ANTHROPIC_BASE_URL: 'http://operator.proxy.invalid:8080' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ANTHROPIC_BASE_URL');
    expect(lines[0]).toContain('not overridable');
  });
});

describe('no line ever carries a value', () => {
  it('announces the name and never the secret', () => {
    const lines = announce({
      ANTHROPIC_API_KEY: SECRET,
      ANTHROPIC_AUTH_TOKEN: SECRET,
      CLAUDE_CODE_OAUTH_TOKEN: SECRET,
      ANTHROPIC_BASE_URL: 'http://operator.proxy.invalid:8080',
    });
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line).not.toContain(SECRET);
    // The base URL is not a credential, but it is still not echoed: the line
    // states the rule, not the operator's configuration.
    for (const line of lines) expect(line).not.toContain('operator.proxy.invalid');
  });
});
