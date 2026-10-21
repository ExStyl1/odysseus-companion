/**
 * UB1.12 — `appendProjectMemoryEntry` (v0.15.1 `packages/shared/src/projects/storage.ts`,
 * Apache-2.0): the append-only writer behind `project_memory_append`.
 *
 * The row's POSITIVE is the two-concurrent-sessions case the premise drive measured
 * losing notes under Write/Edit (`work/ub1-12/two-session-pi-drive-reading.json`):
 * two sessions appending to one folderless project's MEMORY.md keep each other's
 * notes, each under its own dated heading — one `appendFileSync` per note, no
 * read-modify-write. The CONTROL is the same instrument writing sequentially, and
 * the boundary is v0.15.1's 30/70 load (the old head-only truncation dropped the
 * tail where appends land).
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createProject,
  getProjectMemoryPath,
  loadProjectMemory,
} from '../index.ts';
import { appendProjectMemoryEntry } from '../storage.ts';

let tempDir: string;
let workspaceRoot: string;

const newWorkspace = (): string => {
  tempDir = mkdtempSync(join(tmpdir(), 'ub112-append-'));
  workspaceRoot = join(tempDir, 'workspace');
  return workspaceRoot;
};

afterEach(() => {
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe('appendProjectMemoryEntry (UB1.12, v0.15.1)', () => {
  it('keeps BOTH concurrent appends, each under its own dated heading (the premise drive lost one under Write/Edit)', async () => {
    const root = newWorkspace();
    const slug = createProject(root, { name: 'acme' }).slug;

    const noteA = 'A1: the consent page needs a JS click.';
    const noteB = 'B2: deploys need the staging flag.';
    // Two sessions appending "at the same time" — the calls race on one file.
    const [resultA, resultB] = await Promise.all([
      appendProjectMemoryEntry(root, slug, '2026-10-14T10:00:00.000Z — Session A', noteA),
      appendProjectMemoryEntry(root, slug, '2026-10-14T10:00:01.000Z — Session B', noteB),
    ]);

    const file = readFileSync(getProjectMemoryPath(root, slug), 'utf-8');
    expect(file).toContain(noteA);
    expect(file).toContain(noteB);
    expect(file).toContain('## 2026-10-14T10:00:00.000Z — Session A');
    expect(file).toContain('## 2026-10-14T10:00:01.000Z — Session B');
    // The tool's answer names the file and the heading it landed under.
    expect(resultA.path).toBe(getProjectMemoryPath(root, slug));
    expect(resultB.bytesAppended).toBeGreaterThan(0);
    // And the loader (the block's snapshot) sees both notes.
    const loaded = loadProjectMemory(root, slug);
    expect(loaded).toContain(noteA);
    expect(loaded).toContain(noteB);
  });

  it('creates the file with a heading when it does not exist, and spaces successive appends', () => {
    const root = newWorkspace();
    const slug = createProject(root, { name: 'acme' }).slug;
    expect(existsSync(getProjectMemoryPath(root, slug))).toBe(false);

    appendProjectMemoryEntry(root, slug, '2026-10-14T10:00:00.000Z — First', 'first note');
    appendProjectMemoryEntry(root, slug, '2026-10-14T10:00:05.000Z — Second', 'second note');
    const file = readFileSync(getProjectMemoryPath(root, slug), 'utf-8');
    // First note: no leading blank line (the file was created empty); the second
    // arrives under its own heading after a separating blank line — nothing read
    // was rewritten.
    expect(file.startsWith('## 2026-10-14T10:00:00.000Z — First')).toBe(true);
    expect(file).toContain('\n\n## 2026-10-14T10:00:05.000Z — Second');
    expect(file).toContain('first note');
    expect(file).toContain('second note');
  });

  it('collapses whitespace runs in the heading (the cleanHeading rule)', () => {
    const root = newWorkspace();
    const slug = createProject(root, { name: 'acme' }).slug;
    const result = appendProjectMemoryEntry(root, slug, '2026-10-14T10:00:00.000Z —   Multi\n  \t Word  ', 'note');
    expect(result.heading).toBe('2026-10-14T10:00:00.000Z — Multi Word');
    expect(readFileSync(getProjectMemoryPath(root, slug), 'utf-8')).toContain('## 2026-10-14T10:00:00.000Z — Multi Word');
  });

  it('boundary (30/70): a short appended note survives a load that was already over the cap (head-only truncation dropped the tail)', () => {
    const root = newWorkspace();
    const slug = createProject(root, { name: 'acme' }).slug;
    const filler = 'lorem ipsum dolor sit amet '.repeat(400); // ~10 800 chars, ~2 700 tokens
    writeFileSync(getProjectMemoryPath(root, slug), filler);
    const appended = 'APPENDED-NOTE-AT-THE-TAIL';
    appendProjectMemoryEntry(root, slug, '2026-10-14T10:00:00.000Z — Late', appended);

    const loaded = loadProjectMemory(root, slug, 500);
    expect(loaded).not.toBeNull();
    // The tail is where appends land, so v0.15.1 keeps 70% of it: the note survives.
    expect(loaded).toContain(appended);
    // The head is kept too (older, newest-first files), with the middle omitted.
    expect(loaded).toContain('lorem ipsum');
    expect(loaded).toContain('its middle is omitted');
  });
});
