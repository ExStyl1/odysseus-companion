import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const root = resolve(import.meta.dirname, '../..');
test(
  'portable CLI launcher uses an existing Node and starts the real CLI',
  {
    skip:
      process.platform !== 'darwin' ||
      !existsSync(join(root, 'nessy-cli-master/packages/cli/dist/index.js')),
  },
  async (t) => {
    const fixture = mkdtempSync(join(realpathSync(tmpdir()), 'odysseus-launcher-'));
    t.after(() => rmSync(fixture, { recursive: true, force: true }));
    const { stdout } = await promisify(execFile)(
      '/bin/zsh',
      [join(root, 'Запустить Odysseus CLI.command'), '--help'],
      {
        env: {
          ...process.env,
          ODYSSEUS_NODE: process.execPath,
          NESSY_HOME: join(fixture, 'cli'),
          NESSY_CONFIG_DIR: join(fixture, 'desktop'),
          ODYSSEUS_DATA_DIR: join(fixture, 'private'),
        },
        timeout: 15000,
      },
    );
    assert.match(stdout, /Usage: nessy/);
    for (const name of ['CLI', 'Desktop']) {
      const path = join(root, 'Запустить Odysseus ' + name + '.command');
      assert.ok(statSync(path).mode & 0o111);
      assert.ok(!readFileSync(path, 'utf8').includes('/Users/'));
    }
  },
);
