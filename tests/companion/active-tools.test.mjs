import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { companionPaths } from '../../tools/companion/paths.mjs';
import { createPlatform } from '../../tools/companion/platform.mjs';

test('standalone tools read the active Nessy profile without changing its settings', async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'companion-active-tools-'));
  const profile = join(root, 'external-profile');
  const paths = companionPaths(root, { NESSY_HOME: profile, ODYSSEUS_COMPANION_STANDALONE: '1' });
  function put(file, data) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
  const settings = JSON.stringify({ mcpServers: { external: { command: '/usr/bin/true' } } });
  const file = join(profile, 'settings.json');
  put(file, settings);
  put(join(profile, 'skills/example/SKILL.md'), '---\nname: example\ndescription: Example\n---\n');
  put(join(profile, 'extensions/example/nessy-extension.json'), '{"name":"example","version":"1.0.0"}');
  put(join(paths.profile, 'settings.json'), '{"mcpServers":{"managed":{"command":"/usr/bin/true"}}}');
  let platform;
  t.after(async () => {
    await platform?.close();
    rmSync(root, { recursive: true, force: true });
  });
  platform = await createPlatform(paths, { runtimeFactory: async () => ({ close: async () => {} }) });
  assert.deepEqual((await platform.dispatch('mcp')).map(row => row.name), ['external']);
  assert.deepEqual((await platform.dispatch('plugins')).map(row => row.name), ['example']);
  assert.deepEqual((await platform.dispatch('skills')).map(row => row.name), ['example']);
  assert.equal((await platform.dispatch('inventory')).servers[0].name, 'external');
  assert.equal(readFileSync(file, 'utf8'), settings);
});
