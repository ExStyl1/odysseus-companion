/**
 * P2.184 — A PER-ITEM LOOP MUST CONTAIN ITS OWN FAILURE, or one bad item
 * silently becomes zero items processed.
 *
 * `readClipboardLinux` iterates the `text/uri-list` the file manager put on the
 * clipboard and calls `decodeURIComponent` on each line. That throws on a
 * malformed percent-escape (`%zz`, or a lone `%`), and the only `try` was
 * OUTSIDE the loop — so ONE such filename dropped EVERY attachment, including
 * the files already read, into a `catch {}` whose comment says only "File
 * reading failed". A paste of five files silently pasted none.
 *
 * The function's contract is a list of what it COULD read (`readFileAttachment`
 * already returns null for a file it cannot open, and that null is already
 * skipped), so a URI it cannot decode is one more entry it could not read.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as childProcess from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Spread AND restore — and restore from a SNAPSHOT, which is the half the
// shorter form of this comment used to leave out. A `mock.module` without the
// spread amputates the module for some other file in the process, and one
// without a restore makes it permanent; but `mock.module` also MUTATES the
// namespace object in place, so `() => childProcess` would hand the MOCK back
// and the restore would report nothing while changing nothing (AGENTS.md
// §Traps, the `mock.module` bullet; `scripts/check-mock-module-spread.ts` is
// the gate). Copy the exports out before the first mock.
const realChildProcess = { ...childProcess };

let clipboardPayload = '';

mock.module('child_process', () => ({
  ...realChildProcess,
  execSync: (command: string) => {
    if (typeof command === 'string' && command.includes('xclip')) return clipboardPayload;
    throw new Error('xsel not available');
  },
}));

afterAll(() => {
  mock.module('child_process', () => realChildProcess);
});

const { readClipboard } = await import('../files.ts');

let dir: string;
let originalPlatform: PropertyDescriptor | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'p2184-clipboard-'));
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
});

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  // Only ever the directory this test made, under the system temp dir.
  if (dir.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true });
});

function file(name: string, body = 'hello\n'): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

describe('readClipboard on linux — one undecodable URI costs one file', () => {
  it('keeps every file it CAN read when one URI has a broken percent-escape', () => {
    const a = file('a.txt');
    const c = file('c.txt');
    // `%zz` is not a valid escape; `decodeURIComponent` throws on it. The bad
    // line sits BETWEEN two good ones, so a loop that aborts on it would also
    // lose the file it had already read.
    clipboardPayload = [`file://${a}`, 'file:///tmp/br%zzoken.txt', `file://${c}`].join('\n');

    const attachments = readClipboard();

    // Identity on which files came back, not "some came back".
    expect(attachments.map(attachment => attachment.name).sort()).toEqual(['a.txt', 'c.txt']);
  });

  it('a lone trailing percent is contained the same way', () => {
    const a = file('a.txt');
    clipboardPayload = ['file:///tmp/trailing%', `file://${a}`].join('\n');

    expect(readClipboard().map(attachment => attachment.name)).toEqual(['a.txt']);
  });

  it('POSITIVE CONTROL: a clean uri-list returns every file, so the list is not always short', () => {
    const a = file('a.txt');
    const b = file('b.txt');
    clipboardPayload = [`file://${a}`, `file://${b}`].join('\n');

    expect(readClipboard().map(attachment => attachment.name).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('POSITIVE CONTROL: a well-formed escape still DECODES rather than being skipped', () => {
    // Containment must not become "skip anything with a percent in it".
    const spaced = file('with space.txt');
    clipboardPayload = `file://${spaced.replace(/ /g, '%20')}`;

    expect(readClipboard().map(attachment => attachment.name)).toEqual(['with space.txt']);
  });
});
