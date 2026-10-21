/**
 * P6.390(1) — the per-chat memory scope and the two lossy projections.
 *
 * Everything about codex here is read from `openai/codex` at `rust-v0.148.0`
 * (`app-server-protocol/src/protocol/common.rs` and `protocol/v2/thread.rs`),
 * never from a page: for codex the source outranks the page, and this method is
 * `#[experimental(...)]` so it is absent from the vendored generated artefacts
 * entirely.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareAgentMemoryDirectory } from '../agent-memory.ts';
import { loadMemoryPromptBlock } from '../memory-store.ts';

import {
  CODEX_THREAD_MEMORY_MODE_SET_METHOD,
  SESSION_MEMORY_SCOPE_FULL,
  SESSION_MEMORY_SCOPE_NONE,
  buildClaudeSessionMemoryEnv,
  buildCodexThreadMemoryModeSetParams,
  describeSessionMemoryScopeResidue,
  projectSessionMemoryScopeToCodex,
  resolveSessionMemoryScope,
} from '../session-memory-scope.ts';

describe('resolveSessionMemoryScope', () => {
  it('follows the global switch when the chat says nothing', () => {
    expect(resolveSessionMemoryScope({ globalEnabled: true })).toEqual(SESSION_MEMORY_SCOPE_FULL);
    expect(resolveSessionMemoryScope({ globalEnabled: false })).toEqual(SESSION_MEMORY_SCOPE_NONE);
    // An override object with neither axis set is the same as no override — a
    // chat that opened the control and changed nothing must not change anything.
    expect(resolveSessionMemoryScope({ globalEnabled: true, override: {} }))
      .toEqual(SESSION_MEMORY_SCOPE_FULL);
  });

  it('lets one chat narrow or widen each axis without touching the global setting', () => {
    // The row's headline: "may this chat READ existing memories; may it BECOME
    // an input for future ones", set independently.
    expect(resolveSessionMemoryScope({ globalEnabled: true, override: { write: false } }))
      .toEqual({ read: true, write: false });
    expect(resolveSessionMemoryScope({ globalEnabled: true, override: { read: false } }))
      .toEqual({ read: false, write: true });
    // "in either direction" — `settings-reference.md#automemoryenabled` on the
    // per-session override, and the shipped binary's gate reads the env var
    // before it reads `autoMemoryEnabled`.
    expect(resolveSessionMemoryScope({ globalEnabled: false, override: { read: true } }))
      .toEqual({ read: true, write: false });
  });
});

describe('the codex projection', () => {
  it('speaks codex\'s own per-thread control rather than a second mechanism', () => {
    // `ThreadMemoryModeSetParams { thread_id, mode }` with
    // `#[serde(rename_all = "camelCase")]`, so `threadId` on the wire.
    expect(CODEX_THREAD_MEMORY_MODE_SET_METHOD).toBe('thread/memoryMode/set');
    expect(buildCodexThreadMemoryModeSetParams('th_1', SESSION_MEMORY_SCOPE_FULL))
      .toEqual({ threadId: 'th_1', mode: 'enabled' });
  });

  it('collapses a split scope to `disabled`, never to `enabled`', () => {
    // One enum over two axes: granting the axis the user refused is the unsafe
    // direction, so a disagreement closes codex's own store and leaves the host
    // honouring the axis that was kept.
    expect(projectSessionMemoryScopeToCodex({ read: true, write: false })).toBe('disabled');
    expect(projectSessionMemoryScopeToCodex({ read: false, write: true })).toBe('disabled');
    expect(projectSessionMemoryScopeToCodex(SESSION_MEMORY_SCOPE_NONE)).toBe('disabled');
  });
});

describe('the claude projection', () => {
  it('writes nothing when memory is fully on, and never writes "0"', () => {
    // P6.33's rule, unchanged: `'0'` FORCES memory on over the user's own
    // `autoMemoryEnabled: false`, over `--bare` and over safe mode.
    expect(buildClaudeSessionMemoryEnv(SESSION_MEMORY_SCOPE_FULL)).toEqual({});
    expect(Object.values(buildClaudeSessionMemoryEnv({ read: true, write: false }))).not.toContain('0');
  });

  it('closes the child\'s auto memory for a narrowed or an off chat', () => {
    expect(buildClaudeSessionMemoryEnv(SESSION_MEMORY_SCOPE_NONE))
      .toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
    expect(buildClaudeSessionMemoryEnv({ read: false, write: true }))
      .toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
  });
});

describe('the residue sentence', () => {
  it('says which half the runtime could not express, and only then', () => {
    const codex = describeSessionMemoryScopeResidue({ read: true, write: false }, 'codex');
    expect(codex).toHaveLength(1);
    expect(codex[0]).toContain('thread/memoryMode/set');
    const claude = describeSessionMemoryScopeResidue({ read: false, write: true }, 'claude');
    expect(claude).toHaveLength(1);
    expect(claude[0]).toContain('CLAUDE_CODE_DISABLE_AUTO_MEMORY');
  });

  it('says nothing when the projection is lossless, or when the host owns both axes', () => {
    // Both axes agree ⇒ one enum says exactly what the chat asked for.
    expect(describeSessionMemoryScopeResidue(SESSION_MEMORY_SCOPE_FULL, 'codex')).toEqual([]);
    expect(describeSessionMemoryScopeResidue(SESSION_MEMORY_SCOPE_NONE, 'claude')).toEqual([]);
    // Pi has no native store to lose: the host honours both axes directly.
    expect(describeSessionMemoryScopeResidue({ read: true, write: false }, 'pi')).toEqual([]);
  });
});

describe('the two host seams the scope actually reaches', () => {
  // No `mock.module` and no config write: the scope short-circuits the global
  // switch, so both arms are decided by the argument rather than by the rig —
  // which is also the point of resolving once and reading the axis here.
  it('the READ axis, and only it, gates the chat memory block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w8m-mem-'));
    try {
      writeFileSync(join(dir, 'MEMORY.md'), '# Memory\n- the user prefers tabs\n');
      const on = loadMemoryPromptBlock(undefined, undefined, {
        userConfigDir: dir,
        memoryScope: { read: true, write: false },
      });
      expect(on).toContain('the user prefers tabs');
      // Negative arm: reading off, feeding on — the block disappears and the
      // write axis does not resurrect it.
      expect(loadMemoryPromptBlock(undefined, undefined, {
        userConfigDir: dir,
        memoryScope: { read: false, write: true },
      })).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a chat kept out of memory keeps its subagents out too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w8m-agentmem-'));
    try {
      expect(prepareAgentMemoryDirectory('user', 'scout', {
        configDir: dir,
        memoryScope: { read: false, write: false },
      })).toBeUndefined();
      const context = prepareAgentMemoryDirectory('user', 'scout', {
        configDir: dir,
        memoryScope: { read: true, write: false },
      });
      expect(context?.directory).toBe(join(dir, 'agent-memory', 'scout'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
