/**
 * F1.117 (origin WI-by, verifier 3's refinement (b) of finding #19) — a memory
 * switch flipped mid-session reaches the claude child at the NEXT turn head, by
 * respawn, and the menu's notice and the child's environment come from one
 * expression.
 *
 * ## The row, and what is true of it
 *
 * The row: the child's `CLAUDE_CODE_DISABLE_AUTO_MEMORY` is fixed at spawn while
 * the session menu's notice is derived live, so a mid-session flip can display a
 * disposition the running child does not have. Both halves of the premise are
 * true of ONE child. What the row did not account for is that the child does
 * not outlive the flip by more than a turn: `claudeLiveSessionSignature` hashes
 * the whole `env` (`backend/claude/live-session.ts`), the claude agent rebuilds
 * its options at every turn head from the chat's LIVE override (D1.426's getter)
 * and the app-wide switch, and `ensureLiveSession` reuses the running child only
 * while the signature is unchanged. So a flip changes the next turn's signature
 * and the child is rebuilt with the new environment before the turn is sent.
 *
 * The native route was asked first and measured
 * (`claude-auto-memory-live-flip-e2e.test.ts`): `applyFlagSettings` does carry
 * `autoMemoryEnabled` into a running child, but the child reads it once, before
 * its first request, so it cannot move a child already talking. The respawn is
 * the mechanism; this file pins that it happens and that it happens ONLY on a
 * flip. The turn already in flight when the switch moves is the residue, written
 * beside the respawn in `claude-agent.ts` (`ensureLiveSession`).
 */
import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';

import * as configStorage from '../../config/storage.ts';
import { bracedRegion } from '../../testing/source-regions.ts';

// `mock.module` is process-global, so the seam delegates to the real module
// and `afterAll` restores from a SNAPSHOT taken before the mock (restoring from
// the live namespace would hand the mock back — AGENTS.md, spread-and-restore).
const realStorage = { ...configStorage };

let memoryEnabled = true;

mock.module('../../config/storage.ts', () => ({
  ...realStorage,
  getMemoryEnabled: () => memoryEnabled,
}));

afterAll(() => {
  mock.module('../../config/storage.ts', () => realStorage);
});

const { buildClaudeSubprocessEnv } = await import('../options.ts');
const { claudeLiveSessionSignature } = await import('../backend/claude/live-session.ts');
const { resolveSessionRuntimeNotices } = await import('../../protocol/session-runtime-notices.ts');
const { resolveSessionMemoryScope } = await import('../memory/session-memory-scope.ts');

const VARIABLE = 'CLAUDE_CODE_DISABLE_AUTO_MEMORY';
const priorAmbient = process.env[VARIABLE];

afterEach(() => {
  memoryEnabled = true;
  if (priorAmbient === undefined) delete process.env[VARIABLE];
  else process.env[VARIABLE] = priorAmbient;
});

type Override = { read?: boolean; write?: boolean } | undefined;

/** The signature a turn head computes, over the env a turn head builds. */
function turnSignature(override: Override): string {
  const env = buildClaudeSubprocessEnv(undefined, override);
  return claudeLiveSessionSignature({ cwd: '/f1117/work', env } as never);
}

describe('F1.117 — a flip reaches the child at the next turn head, by respawn', () => {
  it('turning this chat\'s memory OFF mid-session changes the next turn\'s signature', () => {
    delete process.env[VARIABLE];
    memoryEnabled = true;
    expect(turnSignature(undefined)).not.toBe(turnSignature({ write: false }));
  });

  it('turning it back ON changes it again — the respawn is not one-way', () => {
    delete process.env[VARIABLE];
    memoryEnabled = false;
    expect(turnSignature(undefined)).not.toBe(turnSignature({ read: true, write: true }));
  });

  it('the APP-WIDE switch moving mid-session is a flip too, with no per-chat override at all', () => {
    delete process.env[VARIABLE];
    memoryEnabled = true;
    const before = turnSignature(undefined);
    memoryEnabled = false;
    expect(turnSignature(undefined)).not.toBe(before);
  });

  it('CONTROL: no flip, no respawn — two turn heads over the same answer hash alike', () => {
    delete process.env[VARIABLE];
    memoryEnabled = true;
    expect(turnSignature({ write: false })).toBe(turnSignature({ write: false }));
    expect(turnSignature(undefined)).toBe(turnSignature(undefined));
    // And a flip that does not change the child's answer does not respawn it:
    // an explicit ON over an app-wide ON writes nothing, exactly like no override.
    expect(turnSignature({ read: true, write: true })).toBe(turnSignature(undefined));
  });
});

describe('F1.117 — the notice and the child env derive from one expression', () => {
  const cases: Array<{ name: string; global: boolean; override: Override; closed: boolean }> = [
    { name: 'app ON, no override', global: true, override: undefined, closed: false },
    { name: 'app ON, chat OFF', global: true, override: { write: false }, closed: true },
    { name: 'app OFF, no override', global: false, override: undefined, closed: true },
    { name: 'app OFF, chat ON', global: false, override: { read: true, write: true }, closed: false },
  ];

  for (const c of cases) {
    it(`${c.name}: the notice says off exactly when the child env closes memory`, () => {
      delete process.env[VARIABLE];
      memoryEnabled = c.global;
      const childClosed = buildClaudeSubprocessEnv(undefined, c.override)[VARIABLE] === '1';
      const [notice] = resolveSessionRuntimeNotices({
        provider: 'anthropic',
        memoryScope: resolveSessionMemoryScope({ globalEnabled: c.global, override: c.override }),
        env: {},
      });
      expect({ childClosed, notice: notice?.id }).toEqual({
        childClosed: c.closed,
        notice: c.closed ? 'claude-auto-memory-off-by-host' : 'claude-auto-memory-runtime-default',
      });
    });
  }
});

describe('F1.117 — the three places the respawn is made of', () => {
  const agentSource = () => readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');

  it('each turn head builds the child env from the chat\'s LIVE override', () => {
    const src = agentSource();
    // The per-turn option build, and the argument it is handed.
    expect(src).toContain('}, this.config.session?.memoryScopeOverride),');
  });

  it('ensureLiveSession reuses the running child only while the signature is unchanged', () => {
    const src = agentSource();
    // The method's own return type carries braces, so the anchor is the tail of
    // that type: the first `{` after it is the BODY's.
    const start = src.indexOf('notices: AgentEvent[] }> {');
    expect(start).toBeGreaterThan(src.indexOf('private async ensureLiveSession('));
    expect(src.lastIndexOf('notices: AgentEvent[] }> {')).toBe(start);
    const region = bracedRegion(src, start);

    expect(region).toContain('const signature = claudeLiveSessionSignature(options);');
    // F1.821 — the one exception: an `effort` ALONE, moved by the reported levels' clamp (an env move is never one).
    expect(region).toContain('&& (this.liveSignature === signature || effortClamp !== null)');
    // Boundary control, declared BELOW this method: the one that ends a live
    // session, a thousand lines further down the class.
    expect(region).not.toContain('private endLiveSession(');
  });

  it('the signature hashes the child env', () => {
    const src = readFileSync(new URL('../backend/claude/live-session.ts', import.meta.url), 'utf8');
    const anchor = src.indexOf('export function claudeLiveSessionSignature(');
    expect(anchor).toBeGreaterThan(0);
    const region = bracedRegion(src, anchor);

    expect(region).toContain('env: withoutSdkSelfWrittenEnv(raw.env), // F1.512');
    // Boundary control, declared BELOW this function in the same module.
    expect(region).not.toContain('export function claudeLiveSettings(');
  });
});
