import { afterEach, describe, expect, it } from 'bun:test';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DURABLE_FS_MODULE = pathToFileURL(join(import.meta.dir, '..', 'durable-fs.ts')).href;
const cleanups: string[] = [];

afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'nessy-durable-fs-'));
  cleanups.push(path);
  return path;
}

describe('durable fs', () => {
  it('writes a mode-0600 file through a same-parent durable rename', async () => {
    const durable = await import(DURABLE_FS_MODULE);
    const directory = temporaryDirectory();
    const path = join(directory, 'marker.json');
    writeFileSync(path, 'old');

    const result = durable.atomicWriteDurableFileSync(path, 'new', { mode: 0o600 });

    expect(readFileSync(path, 'utf8')).toBe('new');
    if (process.platform !== 'win32') expect(Number(lstatSync(path).mode & 0o777)).toBe(0o600);
    expect(result.directoryDurable).toBe(process.platform !== 'win32' ? true : result.directoryDurable);
  });

  it('classifies injected Windows sharing violations separately from unsupported directory flush', async () => {
    const durable = await import(DURABLE_FS_MODULE);
    const sharing = durable.classifyDurabilityError(
      Object.assign(new Error('EPERM: operation not permitted, rename; sharing violation'), { code: 'EPERM' }),
      'win32',
    );
    const generic = durable.classifyDurabilityError(
      Object.assign(new Error('input/output failure'), { code: 'EIO' }),
      'win32',
    );
    const unsupported = durable.classifyDirectoryFlushError(
      Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' }),
      'win32',
    );
    const windowsDirectoryOpen = durable.classifyDirectoryFlushError(
      Object.assign(new Error('EPERM: operation not permitted, open directory'), { code: 'EPERM' }),
      'win32',
    );

    expect(sharing.code).toBe('sharing-violation');
    expect(generic.code).toBe('durability-failed');
    expect(unsupported).toBe('unsupported');
    expect(windowsDirectoryOpen).toBe('unsupported');
  });

  it('refuses a preplaced temporary symlink without touching its target', () => {
    const directory = temporaryDirectory();
    const bunfig = join(directory, 'bunfig.toml');
    const target = join(directory, 'marker.json');
    const outside = join(directory, 'outside');
    writeFileSync(bunfig, '# no test preloads\n');
    const result = Bun.spawnSync([process.execPath, `--config=${bunfig}`, '--eval', `
      import { atomicWriteDurableFileSync } from ${JSON.stringify(DURABLE_FS_MODULE)};
      import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
      import { basename, join } from 'node:path';
      const directory = ${JSON.stringify(directory)};
      const target = ${JSON.stringify(target)};
      const outside = ${JSON.stringify(outside)};
      Date.now = () => 1;
      writeFileSync(outside, 'sentinel');
      symlinkSync(outside, join(directory, \`.\${basename(target)}.\${process.pid}.1.0.tmp\`), 'file');
      let threw = false;
      try { atomicWriteDurableFileSync(target, 'marker'); } catch { threw = true; }
      let targetExists = true;
      try { lstatSync(target); } catch { targetExists = false; }
      console.log(JSON.stringify({ threw, outside: readFileSync(outside, 'utf8'), targetExists }));
    `], { stdout: 'pipe', stderr: 'pipe' });

    expect(result.exitCode, result.stderr?.toString() ?? '').toBe(0);
    expect(JSON.parse(result.stdout?.toString() ?? '')).toEqual({
      threw: true,
      outside: 'sentinel',
      targetExists: false,
    });
  });

  it('does not replace an existing target in no-replace mode', async () => {
    const durable = await import(DURABLE_FS_MODULE);
    const directory = temporaryDirectory();
    const path = join(directory, 'marker.json');
    writeFileSync(path, 'sentinel');

    expect(() => durable.atomicWriteDurableFileSync(path, 'marker', { noReplace: true })).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('sentinel');
  });
});
