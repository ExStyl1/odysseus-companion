import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  realpathSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { prepareDistribution, installCommand } from '../../tools/distribution/prepare.mjs';
function fixture(t) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'odysseus-dist-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "home ' $ literal"),
    payload = join(base, 'payload');
  mkdirSync(home);
  const put = (p, v) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v));
  };
  for (const name of ['tools', 'integrations', 'cli', 'desktop', 'docs', 'shared'])
    mkdirSync(join(payload, name), { recursive: true });
  put(join(payload, 'release.json'), { version: '1.0.0', buildId: 'one' });
  put(join(payload, 'odysseus.json'), {
    schemaVersion: 1,
    sharedDirectory: 'shared',
    components: { cli: { source: 'cli' }, desktop: { source: 'desktop' } },
  });
  return { base, home, payload, put };
}
test('installed runtime preserves native data, workspace state and customized shared skills across upgrades', (t) => {
  const f = fixture(t);
  f.put(join(f.home, '.nessy/settings.json'), { theme: 'old' });
  f.put(join(f.payload, 'desktop/node_modules/@electron/asar/package.json'), {
    name: '@electron/asar',
  });
  f.put(join(f.payload, 'shared/skills/one/SKILL.md'), 'first');
  f.put(join(f.payload, 'shared/skills/two/SKILL.md'), 'first');
  const env = prepareDistribution(f.payload, { home: f.home });
  assert.ok(
    existsSync(join(env.ODYSSEUS_ROOT, 'desktop/node_modules/@electron/asar/package.json')),
  );
  assert.equal(JSON.parse(readFileSync(join(env.NESSY_HOME, 'settings.json'))).theme, 'old');
  f.put(join(env.ODYSSEUS_ROOT, 'workspace/user.md'), 'keep');
  f.put(join(env.ODYSSEUS_ROOT, '.odysseus/user.json'), 'keep');
  f.put(join(env.ODYSSEUS_ROOT, 'shared/skills/two/SKILL.md'), 'custom');
  f.put(join(f.payload, 'release.json'), { version: '1.1.0', buildId: 'two' });
  f.put(join(f.payload, 'shared/skills/one/SKILL.md'), 'updated');
  f.put(join(f.payload, 'shared/skills/two/SKILL.md'), 'updated');
  prepareDistribution(f.payload, { home: f.home });
  assert.equal(
    readFileSync(join(env.ODYSSEUS_ROOT, 'shared/skills/one/SKILL.md'), 'utf8'),
    'updated',
  );
  assert.equal(
    readFileSync(join(env.ODYSSEUS_ROOT, 'shared/skills/two/SKILL.md'), 'utf8'),
    'custom',
  );
  assert.equal(readFileSync(join(env.ODYSSEUS_ROOT, 'workspace/user.md'), 'utf8'), 'keep');
  assert.equal(readFileSync(join(env.ODYSSEUS_ROOT, '.odysseus/user.json'), 'utf8'), 'keep');
  assert.equal(readFileSync(join(f.home, '.nessy/settings.json'), 'utf8'), '{"theme":"old"}');
  assert.ok(existsSync(join(f.home, '.local/bin/od')));
});
test('od shim quotes paths, keeps argv, installs PATH once and refuses an existing unrelated command', (t) => {
  const f = fixture(t),
    node = join(f.home, "node ' $ test"),
    entry = join(f.home, "entry ' $ test.mjs");
  installCommand({ home: f.home, node, entry });
  installCommand({ home: f.home, node, entry });
  const shim = join(f.home, '.local/bin/od');
  assert.equal(spawnSync('/bin/sh', ['-n', shim]).status, 0);
  assert.ok(readFileSync(shim, 'utf8').includes('"$@"'));
  assert.equal(
    readFileSync(join(f.home, '.zshrc'), 'utf8').split('# >>> Odysseus CLI >>>').length,
    2,
  );
  f.put(shim, '#!/bin/sh\necho unrelated\n');
  assert.equal(installCommand({ home: f.home, node, entry }).length, 1);
  assert.ok(readFileSync(shim, 'utf8').includes('unrelated'));
});

test('distribution update recovers a dead owner lock and refuses a live owner', (t) => {
  const f = fixture(t),
    root = join(f.home, 'Library/Application Support/Odysseus/runtime'),
    lock = join(root, '.distribution.lock');
  f.put(join(lock, 'owner.json'), { pid: process.pid });
  assert.throws(() => prepareDistribution(f.payload, { home: f.home }), /обновляется/);
  rmSync(lock, { recursive: true });
  f.put(join(lock, 'owner.json'), { pid: 2147483647 });
  assert.ok(prepareDistribution(f.payload, { home: f.home }).ODYSSEUS_ROOT);
  assert.ok(!existsSync(lock));
});
