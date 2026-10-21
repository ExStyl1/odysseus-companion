import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
const root = resolve(import.meta.dirname, '../..');
test(
  'system-terminal request starts the real CLI and writes a startup receipt',
  {
    skip: !existsSync(join(root, 'nessy-cli-master/packages/cli/dist/index.js')),
  },
  async (t) => {
    const fixture = mkdtempSync(join(realpathSync(tmpdir()), 'nessy-system-cli-')),
      data = join(fixture, 'private'),
      request = join(data, 'launch/check.json');
    mkdirSync(join(data, 'launch'), { recursive: true });
    writeFileSync(request, JSON.stringify({ cwd: join(root, 'workspace') }));
    t.after(() => rmSync(fixture, { recursive: true, force: true }));
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [join(root, 'tools/run-component.mjs'), 'cli', '--request', request, '--help'],
      {
        env: {
          ...process.env,
          ODYSSEUS_DATA_DIR: data,
          NESSY_HOME: join(fixture, 'cli'),
          NESSY_CONFIG_DIR: join(fixture, 'desktop'),
        },
        timeout: 15000,
      },
    );
    assert.match(stdout, /Usage: nessy/);
    const receipt = JSON.parse(readFileSync(request.replace(/\.json$/, '.started.json')));
    assert.ok(receipt.pid > 0);
    assert.ok(receipt.startedAt > Date.now() - 20000);
  },
);
