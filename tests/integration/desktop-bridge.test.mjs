import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { installDesktopBridge } from '../../tools/install-desktop-bridge.mjs';
const root = resolve(import.meta.dirname, '../..');
const put = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
test('Desktop integration can be reapplied after an independent source update and is idempotent', (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'odysseus-bridge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(root, 'integrations/desktop/manifest.json'))),
    source = join(dir, 'desktop');
  const files = new Map();
  for (const p of manifest.patches) {
    const value = files.get(p.path) || '';
    files.set(p.path, value + '\n' + (p.append ? '// upstream end' : p.before));
  }
  for (const [path, text] of files) put(join(source, path), text);
  for (const [path] of Object.entries(manifest.locales))
    put(join(source, path), '{"unrelated":"keep"}\n');
  const preview = installDesktopBridge(root, { source, check: true });
  assert.ok(preview.changedFiles.length > 5);
  installDesktopBridge(root, { source });
  assert.equal(installDesktopBridge(root, { source }).changedFiles.length, 0);
  for (const [path] of Object.entries(manifest.locales))
    assert.equal(JSON.parse(readFileSync(join(source, path))).unrelated, 'keep');
});
test('incompatible Desktop update fails before changing any source', (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'odysseus-bridge-conflict-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifest = JSON.parse(readFileSync(join(root, 'integrations/desktop/manifest.json'))),
    source = join(dir, 'desktop'),
    path = join(source, manifest.patches[0].path);
  put(path, '// new upstream seam\n');
  assert.throws(() => installDesktopBridge(root, { source }), /integration review/);
  assert.equal(readFileSync(path, 'utf8'), '// new upstream seam\n');
});
