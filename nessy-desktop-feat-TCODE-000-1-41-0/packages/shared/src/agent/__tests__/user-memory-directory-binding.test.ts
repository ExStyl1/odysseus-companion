/**
 * F1.104 (origin D1.427, F1.12 safety-review finding #20, CONFIRMED 3/3,
 * MEDIUM) — the `remember` tool's USER scope must honour `autoMemoryDirectory`.
 *
 * `getUserMemoryFilePath` has been the one answer to "where does this app keep
 * the user-scope memory index" since P6.390(2): it resolves
 * `getAutoMemoryDirectory() ?? CONFIG_DIR`, and the loader, the cleanup pass and
 * the memory RPC all read it. The two SessionToolContext factories did not —
 * `claude-context.ts` joined the file onto `CONFIG_DIR` and
 * `session-mcp-server`'s `createCodexContext` onto `--config-root` — so a user
 * who moved their memory directory got a second, invisible user index: the
 * agent's own `remember` wrote one file while everything that LOADS memories
 * read another.
 *
 * This file is the claude half. The codex half is
 * `session-mcp-server/src/remember-scopes.test.ts`, driven over the real MCP
 * stdio transport, because that factory also carries a GROUND comparison this
 * one does not need.
 *
 * ## Three propositions
 *
 * 1. **The setting moves the binding.** The arm that is RED before the fix.
 * 2. **The default is byte-identical** — D1.427's own stated control. With no
 *    `autoMemoryDirectory` the path is exactly what it was, so nobody who set
 *    nothing sees anything move.
 * 3. **It is read on ACCESS, not captured.** The tools built around this context
 *    are cached per session (`session-scoped-tools.ts`'s `sessionToolsCache`),
 *    so a value taken at construction would freeze for the life of the chat —
 *    the same reasoning `memoryEnabled` already carries two lines below it.
 *
 * The setting is planted as a REAL `config.json` through the production loader
 * rather than mocked: `getAutoMemoryDirectory` calls `loadStoredConfig`, which
 * reads the file on every call and caches nothing, and `mock.module` on
 * `config/storage.ts` would amputate that module for every other file sharing
 * this process (AGENTS.md's spread-and-restore trap) to buy nothing a file
 * write does not already give. `CONFIG_DIR` here is the private temp directory
 * the root `bunfig.toml` preload made for this test process, and the original
 * bytes are restored in a `finally` so no sibling file sees the plant.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClaudeContext } from '../claude-context.ts';
import { CONFIG_DIR, STORAGE_LAYOUT_VERSION } from '../../config/paths.ts';
import { MEMORY_FILE_NAME, getUserMemoryFilePath } from '../memory/memory-store.ts';

const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

/** A `config.json` this build's loader accepts, carrying only what an arm needs. */
function plantConfig(autoMemoryDirectory?: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify({
    storageLayoutVersion: STORAGE_LAYOUT_VERSION,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    memoryEnabled: true,
    ...(autoMemoryDirectory === undefined ? {} : { autoMemoryDirectory }),
  }), 'utf-8');
}

/**
 * Run `body` with the config file planted, and put the directory back exactly as
 * it was — including "there was no file", which is the ordinary state.
 */
function withPlantedConfig<T>(autoMemoryDirectory: string | undefined, body: () => T): T {
  const had = existsSync(CONFIG_FILE);
  const before = had ? readFileSync(CONFIG_FILE, 'utf-8') : null;
  try {
    plantConfig(autoMemoryDirectory);
    return body();
  } finally {
    if (before === null) rmSync(CONFIG_FILE, { force: true });
    else writeFileSync(CONFIG_FILE, before, 'utf-8');
  }
}

function makeContext() {
  return createClaudeContext({
    sessionId: 'user-memory-binding-session',
    workspacePath: '/tmp/user-memory-binding-ws',
    workspaceId: 'user-memory-binding-ws',
    sessionPath: '/tmp/user-memory-binding-ws/sessions/user-memory-binding-session',
    onPlanSubmitted: () => {},
    onAuthRequest: () => {},
  });
}

describe('F1.104 · claude\'s session-tool context binds the user index through the resolver', () => {
  it('follows `autoMemoryDirectory` when the operator set one', () => {
    const chosen = mkdtempSync(join(tmpdir(), 'f1104-memdir-'));
    try {
      withPlantedConfig(chosen, () => {
        // The rig control: the plant really reached the resolver. Without it a
        // `userMemoryPath` that happened to equal the default would read as a
        // pass on a setting nothing loaded.
        expect(getUserMemoryFilePath()).toBe(join(chosen, MEMORY_FILE_NAME));

        expect(makeContext().userMemoryPath).toBe(join(chosen, MEMORY_FILE_NAME));
        // And it is NOT the config root any more — the file this split created.
        expect(makeContext().userMemoryPath).not.toBe(join(CONFIG_DIR, MEMORY_FILE_NAME));
      });
    } finally {
      rmSync(chosen, { recursive: true, force: true });
    }
  });

  it('is byte-identical for everyone who set nothing — D1.427\'s own control', () => {
    withPlantedConfig(undefined, () => {
      expect(makeContext().userMemoryPath).toBe(join(CONFIG_DIR, MEMORY_FILE_NAME));
      expect(makeContext().userMemoryPath).toBe(getUserMemoryFilePath());
    });
  });

  it('resolves on ACCESS, so a chat whose tools are cached still follows a move', () => {
    // One context object, read across a change of the setting. The tools this
    // context feeds are cached per session, so a value captured at construction
    // would answer the old path for the rest of the chat and nothing would
    // invalidate it.
    const chosen = mkdtempSync(join(tmpdir(), 'f1104-memdir-live-'));
    try {
      withPlantedConfig(undefined, () => {
        const ctx = makeContext();
        expect(ctx.userMemoryPath).toBe(join(CONFIG_DIR, MEMORY_FILE_NAME));

        plantConfig(chosen);
        expect(ctx.userMemoryPath).toBe(join(chosen, MEMORY_FILE_NAME));

        plantConfig(undefined);
        expect(ctx.userMemoryPath).toBe(join(CONFIG_DIR, MEMORY_FILE_NAME));
      });
    } finally {
      rmSync(chosen, { recursive: true, force: true });
    }
  });
});
