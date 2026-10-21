/**
 * P6.865 — the setter P6.202 clause (3)'s **Block from now on** answer calls.
 *
 * `permission-modes.md#first-read-outside-the-working-directories`, verbatim:
 * *"Block from now on: Claude Code sets
 * `permissions.blockReadsOutsideWorkingDirectories` to `true` in your user
 * settings, which makes the file tools refuse such reads in every later session
 * and every permission mode."* The key had a READER since `cb35373f4` and no
 * writer at all, so the card's third answer had nothing to call and would have
 * refused one read and forgotten the decision.
 *
 * Two properties are pinned, and the second is the one a plain toggle would get
 * wrong: the value round-trips through the strict envelope, and an ABSENT
 * `config.json` is reported as a failed write rather than swallowed — the caller
 * still refuses the read, but it must be able to say the preference was not kept.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../paths.ts';
import {
  getBlockReadsOutsideWorkingDirectories,
  loadStoredConfig,
  saveConfig,
  setBlockReadsOutsideWorkingDirectories,
  type StoredConfig,
} from '../storage.ts';
import { StoredConfigSchema, StoredConfigTopLevelSchema } from '../validators.ts';
import { STORAGE_LAYOUT_VERSION } from '../paths.ts';

/** The isolated test config directory this process was given by the preload. */
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

function seedEmptyConfig(): void {
  saveConfig({
    storageLayoutVersion: STORAGE_LAYOUT_VERSION,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
  } as unknown as StoredConfig);
}

afterEach(() => {
  // Leave the process's isolated config directory exactly as it was found —
  // every other suite in this process reads the same one.
  if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE);
});

describe('setBlockReadsOutsideWorkingDirectories (P6.865)', () => {
  it('persists the block and the reader sees it immediately', () => {
    // POSITIVE. The whole of "Block from now on": one write, and the fence the
    // page describes is on for every later session.
    seedEmptyConfig();
    expect(getBlockReadsOutsideWorkingDirectories()).toBe(false);

    expect(setBlockReadsOutsideWorkingDirectories(true)).toBe(true);

    expect(loadStoredConfig()?.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(getBlockReadsOutsideWorkingDirectories()).toBe(true);
  });

  it('writes the OFF value literally rather than deleting it, and both survive the strict envelope', () => {
    // The stored `false` is *"the same as unset"* for the RESOLUTION —
    // `getBlockReadsOutsideWorkingDirectories` ORs the shipped default over it,
    // so this layer can never lift another layer's block — but it must still be
    // a value the envelope accepts, because an undeclared key our own setter
    // writes refuses the WHOLE `config.json` (rule 19, guard `eaa7c1916`).
    seedEmptyConfig();
    expect(setBlockReadsOutsideWorkingDirectories(true)).toBe(true);
    expect(setBlockReadsOutsideWorkingDirectories(false)).toBe(true);
    expect(loadStoredConfig()?.blockReadsOutsideWorkingDirectories).toBe(false);
    expect(getBlockReadsOutsideWorkingDirectories()).toBe(false);

    for (const blocked of [true, false]) {
      const stored = {
        storageLayoutVersion: STORAGE_LAYOUT_VERSION,
        workspaceRefs: [],
        activeWorkspaceId: null,
        activeSessionId: null,
        blockReadsOutsideWorkingDirectories: blocked,
      };
      expect(StoredConfigTopLevelSchema.safeParse(stored).success).toBe(true);
      expect(StoredConfigSchema.safeParse(stored).success).toBe(true);
    }
  });

  it('reports a failed write instead of throwing when there is no config to mutate', () => {
    // NEGATIVE, and the reason the setter returns a boolean at all: the answer
    // still refuses THIS read, and the caller must be able to say that the
    // "from now on" half did not happen rather than claim a fence that is not
    // there.
    if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE);
    expect(setBlockReadsOutsideWorkingDirectories(true)).toBe(false);
    expect(getBlockReadsOutsideWorkingDirectories()).toBe(false);
  });
});
