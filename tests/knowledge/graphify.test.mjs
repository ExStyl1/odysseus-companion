import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  findVault,
  runtimePaths,
  registerProject,
  readRegistry,
  processIsAlive,
} from '../../tools/graphify.mjs';
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'odysseus-knowledge-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(path, data) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}
test('vault discovery uses registered open/latest vaults and ignores missing paths', (t) => {
  const root = fixture(t),
    a = join(root, 'A'),
    b = join(root, 'B');
  mkdirSync(a);
  mkdirSync(b);
  put(join(root, 'Library/Application Support/obsidian/obsidian.json'), {
    vaults: {
      a: { path: a, ts: 100 },
      b: { path: b, open: true, ts: 10 },
      missing: { path: join(root, 'missing'), open: true, ts: 1000 },
    },
  });
  const options = { root, home: root, platform: 'darwin', env: {} };
  assert.equal(findVault(options).path, b);
  put(join(root, 'Library/Application Support/obsidian/obsidian.json'), {
    vaults: { a: { path: a, ts: 100 }, b: { path: b, ts: 10 } },
  });
  assert.equal(findVault(options).path, a);
  assert.equal(findVault({ ...options, config: { vault: b } }).path, b);
  assert.throws(
    () =>
      findVault({
        ...options,
        env: { ODYSSEUS_OBSIDIAN_VAULT: join(root, 'absent') },
      }),
    /unavailable/,
  );
});
test('a fresh user gets a project-relative vault; platform registries stay portable', (t) => {
  const root = fixture(t);
  const options = { root, home: root, env: {} };
  assert.equal(
    findVault({ ...options, platform: 'darwin' }).path,
    join(root, 'workspace/Obsidian'),
  );
  const vault = join(root, 'notes');
  mkdirSync(vault);
  put(join(root, '.config/obsidian/obsidian.json'), {
    vaults: { a: { path: vault } },
  });
  assert.equal(findVault({ ...options, platform: 'linux' }).path, vault);
  put(join(root, 'AppData/Roaming/obsidian/obsidian.json'), {
    vaults: { a: { path: vault } },
  });
  assert.equal(findVault({ ...options, platform: 'win32' }).path, vault);
});
test('independent project records preserve two same-named folders without lost updates', (t) => {
  const root = fixture(t),
    a = join(root, 'one/service'),
    b = join(root, 'two/service');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  const paths = runtimePaths(root, {});
  const first = registerProject(paths, a),
    second = registerProject(paths, b);
  assert.notEqual(first.id, second.id);
  assert.equal(Object.keys(readRegistry(paths).projects).length, 2);
  registerProject(paths, a, 'API');
  registerProject(paths, a);
  assert.equal(readRegistry(paths).projects[first.id].name, 'API');
});
const root = resolve(import.meta.dirname, '../..'),
  python = runtimePaths(root).python;
test(
  'real Graphify extracts, merges cross-project evidence, preserves notes and exports Canvas',
  { skip: !existsSync(python) },
  () => {
    execFileSync(
      python,
      [
        '-m',
        'unittest',
        'discover',
        '-s',
        join(root, 'tests/knowledge'),
        '-p',
        'test_knowledge.py',
      ],
      { cwd: root, timeout: 60000, stdio: 'pipe' },
    );
  },
);

test('worker liveness treats a denied probe as alive and only ESRCH as dead', () => {
  assert.equal(
    processIsAlive(42, () => {
      throw Object.assign(Error(), { code: 'EPERM' });
    }),
    true,
  );
  assert.equal(
    processIsAlive(42, () => {
      throw Object.assign(Error(), { code: 'ESRCH' });
    }),
    false,
  );
  assert.equal(processIsAlive(0), false);
  assert.equal(processIsAlive(process.pid), true);
});

test('background vault refresh reuses its own selection and never probes the Obsidian registry again', async t => {
  const root = fixture(t), vault = join(root, 'vault'); mkdirSync(vault);
  const { ensureVault } = await import('../../tools/graphify.mjs');
  const paths = runtimePaths(root, {});
  put(join(paths.runtime, 'vault-selection.json'), { path: vault, reason: 'open-vault' });
  assert.equal(ensureVault(paths).reason, 'saved-vault');
  rmSync(vault, { recursive: true });
  assert.throws(() => ensureVault(paths), /Сохранённое хранилище/);
  mkdirSync(vault);
  assert.equal(ensureVault({ ...paths, env: { ODYSSEUS_OBSIDIAN_VAULT: vault } }).reason, 'explicit');
});

test('home and system roots cannot become projects, including previously registered roots', async t => {
  const root = fixture(t), paths = runtimePaths(root, {});
  const { homedir } = await import('node:os');
  assert.throws(() => registerProject(paths, homedir()), /конкретную папку/);
  assert.throws(() => registerProject(paths, '/'), /конкретную папку/);
  put(join(paths.registry, 'old.json'), { id: 'old', path: homedir() });
  assert.deepEqual(readRegistry(paths).projects, {});
  const project = join(root, 'project'); mkdirSync(project);
  assert.ok(registerProject(paths, project).id);
});
