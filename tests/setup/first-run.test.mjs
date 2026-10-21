import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  realpathSync,
  symlinkSync,
  statSync,
  chmodSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureFirstRun } from '../../tools/setup/first-run.mjs';
import { discoverNessy } from '../../tools/setup/discovery.mjs';
import { managedProfiles } from '../../tools/setup/paths.mjs';
import { personalPaths, syncPersonal } from '../../tools/personal-sync.mjs';
const root = resolve(import.meta.dirname, '../..');
const put = (p, value) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value),
  );
};
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));
function fixture(t) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'odysseus-first-run-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  mkdirSync(home);
  return {
    base,
    home,
    privateDir: join(home, '.odysseus'),
    env: { PATH: '' },
    platform: 'darwin',
    applicationRoots: [join(home, 'Applications')],
  };
}
test('discovery finds native profiles, explicit locations and application bundles without executing them', (t) => {
  const f = fixture(t),
    bin = join(f.home, 'bin'),
    app = join(f.home, 'Applications/Nessy Desktop.app');
  put(join(bin, 'nessy'), '#!/bin/sh\nexit 97');
  chmodSync(join(bin, 'nessy'), 0o700);
  mkdirSync(app, { recursive: true });
  put(join(f.home, '.nessy/settings.json'), {});
  put(join(f.home, '.nessy-agent/config.json'), {});
  mkdirSync(join(f.home, '.nessy-agent/plugins'), { recursive: true });
  put(join(f.home, '.nestor/login.json'), { provider: 'local' });
  const result = discoverNessy({ ...f, env: { PATH: bin } });
  assert.equal(result.profiles.cli[0], join(f.home, '.nessy'));
  assert.equal(result.profiles.desktop[0], join(f.home, '.nessy-agent'));
  assert.ok(result.installations.desktop.includes(app));
  assert.ok(result.installations.cli.includes(join(bin, 'nessy')));
  assert.ok(result.legacyRoots.includes(join(f.home, '.nestor')));
});
test('first run copies all native data privately, rebases config paths and preserves originals and transcripts', (t) => {
  const f = fixture(t),
    cli = join(f.home, '.nessy'),
    desktop = join(f.home, '.nessy-agent');
  put(join(cli, 'settings.json'), {
    model: { name: 'model-a' },
    mcpServers: { local: { command: 'local-server' } },
    path: join(cli, 'extensions/local'),
  });
  put(join(cli, 'projects/a/chats/chat.jsonl'), '{"content":"original ' + cli + '"}\n');
  put(join(cli, 'extensions/local/data.bin'), Buffer.from([0, 1, 255]));
  put(join(desktop, 'config.json'), {
    activeWorkspaceId: 'w',
    workspaceRefs: [{ id: 'w' }],
    path: join(desktop, 'workspaces/w'),
  });
  put(join(desktop, 'workspaces/w/sessions/s/session.jsonl'), 'opaque transcript\n');
  put(join(desktop, 'credentials.enc'), Buffer.from('encrypted-original'));
  put(join(f.home, '.agents/skills/new/SKILL.md'), '# Imported');
  const source = readFileSync(join(cli, 'settings.json'));
  const result = ensureFirstRun(root, f),
    owned = managedProfiles(f.privateDir);
  assert.equal(result.status, 'ready');
  assert.equal(
    json(join(owned.cliHome, 'settings.json')).path,
    join(owned.cliHome, 'extensions/local'),
  );
  assert.equal(
    json(join(owned.desktopHome, 'config.json')).path,
    join(owned.desktopHome, 'workspaces/w'),
  );
  assert.deepEqual(readFileSync(join(cli, 'settings.json')), source);
  assert.equal(
    readFileSync(join(owned.cliHome, 'projects/a/chats/chat.jsonl'), 'utf8'),
    '{"content":"original ' + cli + '"}\n',
  );
  assert.equal(
    readFileSync(join(owned.desktopHome, 'credentials.enc'), 'utf8'),
    'encrypted-original',
  );
  assert.ok(existsSync(join(owned.desktopHome, 'workspaces/w/skills/new/SKILL.md')));
  assert.equal(owned.cliRuntime, owned.cliHome);
  assert.equal(statSync(join(owned.cliHome, 'settings.json')).mode & 0o777, 0o600);
  assert.equal(personalPaths(root, { home: f.home }).cliHome, owned.cliHome);
});
test('preview writes nothing; empty installations create usable separate profiles', (t) => {
  const f = fixture(t);
  assert.equal(ensureFirstRun(root, { ...f, check: true }).status, 'preview');
  assert.ok(!existsSync(f.privateDir));
  const result = ensureFirstRun(root, f);
  assert.ok(existsSync(result.profiles.cliHome));
  assert.ok(existsSync(result.profiles.desktopHome));
  assert.deepEqual(result.sources, { cli: [], desktop: [] });
  assert.equal(syncPersonal(root, { home: f.home, privateDir: f.privateDir }).conflicts.length, 0);
});
test('repeated startup preserves new Odysseus data and never reimports changed legacy files', (t) => {
  const f = fixture(t);
  put(join(f.home, '.nessy/settings.json'), { model: { name: 'old' } });
  const first = ensureFirstRun(root, f);
  put(join(first.profiles.cliHome, 'settings.json'), { model: { name: 'new' } });
  put(join(f.home, '.nessy/settings.json'), { model: { name: 'legacy-changed' } });
  const again = ensureFirstRun(root, f);
  assert.equal(again.alreadyInstalled, true);
  assert.equal(json(join(again.profiles.cliHome, 'settings.json')).model.name, 'new');
});
test('alternate profiles and Nestor data are retained; live locks and links are not imported', (t) => {
  const f = fixture(t);
  put(join(f.home, '.nessy/settings.json'), {});
  put(join(f.home, '.nessy-cli/settings.json'), { alternate: true });
  put(join(f.home, '.nestor/token.bin'), 'private-token');
  put(join(f.home, '.nessy/task.runtime.json'), { pid: process.pid });
  put(join(f.home, '.nessy/logs/log.txt'), 'runtime log');
  put(join(f.base, 'outside.txt'), 'external');
  symlinkSync(join(f.base, 'outside.txt'), join(f.home, '.nessy/outside'));
  const result = ensureFirstRun(root, f);
  assert.ok(existsSync(join(f.privateDir, 'profiles/imported/cli-2/settings.json')));
  assert.ok(existsSync(join(f.privateDir, 'profiles/imported/nestor-1/token.bin')));
  assert.ok(!existsSync(join(result.profiles.cliHome, 'outside')));
  assert.ok(result.skipped.some((s) => s.reason === 'symbolic-link'));
  assert.ok(!existsSync(join(result.profiles.cliHome, 'task.runtime.json')));
  assert.ok(!JSON.stringify(result).includes('private-token'));
});
test('separate CLI runtime and bridge bookkeeping point to owned profiles', (t) => {
  const f = fixture(t),
    source = join(f.home, '.nessy'),
    runtime = join(f.home, 'runtime'),
    desktop = join(f.home, '.nessy-agent');
  put(join(source, 'settings.json'), {});
  put(join(runtime, 'projects/p/chats/c.jsonl'), '{}\n');
  put(join(desktop, 'config.json'), {});
  put(join(f.privateDir, 'state.json'), {
    schemaVersion: 1,
    chats: {
      pair: {
        cliPath: join(runtime, 'projects/p/chats/c.jsonl'),
        desktopPath: join(desktop, 'workspaces/w/sessions/c/session.jsonl'),
      },
    },
    fields: {},
  });
  const result = ensureFirstRun(root, { ...f, env: { PATH: '', NESSY_RUNTIME_DIR: runtime } }),
    state = json(join(f.privateDir, 'state.json'));
  assert.equal(
    state.chats.pair.cliPath,
    join(result.profiles.cliRuntime, 'projects/p/chats/c.jsonl'),
  );
  assert.ok(existsSync(join(f.privateDir, 'profiles/previous-bridge-state.json')));
  assert.ok(!existsSync(join(f.privateDir, 'profiles/rebased-bridge-state.json')));
  assert.notEqual(managedProfiles(f.privateDir).cliRuntime, result.profiles.cliHome);
});
test('bundle data and bundled skills are imported but application executables are not', (t) => {
  const f = fixture(t),
    app = join(f.home, 'Applications/Nessy Desktop.app');
  put(join(app, 'Contents/MacOS/Nessy Desktop'), 'binary-not-imported');
  put(join(app, 'Contents/Resources/skills/bundled/SKILL.md'), '# Bundle skill');
  put(join(app, 'Contents/Resources/default-runtime.js'), 'code-not-imported');
  put(join(f.home, '.nessy-agent/config.json'), {});
  mkdirSync(join(f.home, '.nessy-agent/plugins'), { recursive: true });
  put(join(f.home, '.nessy-agent/workspaces/w/config.json'), { id: 'w' });
  const result = ensureFirstRun(root, f);
  assert.ok(
    existsSync(
      join(f.privateDir, 'profiles/imported/apps/desktop-1/resources/skills/bundled/SKILL.md'),
    ),
  );
  assert.ok(existsSync(join(result.profiles.desktopHome, 'workspaces/w/skills/bundled/SKILL.md')));
  assert.ok(
    !existsSync(
      join(f.privateDir, 'profiles/imported/apps/desktop-1/Contents/MacOS/Nessy Desktop'),
    ),
  );
});
test('interrupted bridge relocation resumes safely, while active sync and occupied profiles block writes', (t) => {
  const f = fixture(t);
  ensureFirstRun(root, f);
  put(join(f.privateDir, 'state.json'), { old: true });
  put(join(f.privateDir, 'profiles/previous-bridge-state.json'), { old: true });
  put(join(f.privateDir, 'profiles/rebased-bridge-state.json'), { new: true });
  assert.throws(() => managedProfiles(f.privateDir), /recovery/);
  assert.equal(ensureFirstRun(root, { ...f, check: true }).status, 'recovery-needed');
  ensureFirstRun(root, f);
  assert.deepEqual(json(join(f.privateDir, 'state.json')), { new: true });
  const other = fixture(t);
  put(join(other.privateDir, 'sync.lock/owner.json'), { pid: process.pid });
  assert.throws(() => ensureFirstRun(root, other), /уже выполняется/);
  assert.ok(!existsSync(join(other.privateDir, 'profiles')));
});

test('packed application resources are read as data and imported into native skill directories', async (t) => {
  const f = fixture(t),
    app = join(f.home, 'Applications/Nessy Desktop.app'),
    source = join(f.base, 'asar-source');
  const { createRequire } = await import('node:module');
  const config = json(join(root, 'odysseus.json'));
  const require = createRequire(join(root, config.components.desktop.source, 'package.json'));
  let asar;
  try {
    asar = require('@electron/asar');
  } catch {
    t.skip('Native ASAR reader is not installed');
    return;
  }
  put(join(source, 'dist/resources/skills/from-asar/SKILL.md'), '# Packed skill');
  put(join(source, 'main.js'), 'throw Error("must never execute")');
  put(join(f.home, '.nessy-agent/config.json'), {});
  mkdirSync(join(f.home, '.nessy-agent/plugins'), { recursive: true });
  put(join(f.home, '.nessy-agent/workspaces/w/config.json'), { id: 'w' });
  mkdirSync(join(app, 'Contents/Resources'), { recursive: true });
  await asar.createPackage(source, join(app, 'Contents/Resources/app.asar'));
  const result = ensureFirstRun(root, f);
  assert.equal(result.warnings.length, 0);
  assert.ok(existsSync(join(result.profiles.desktopHome, 'plugins')));
  assert.ok(
    existsSync(
      join(
        f.privateDir,
        'profiles/imported/apps/desktop-1/app-asar/dist/resources/skills/from-asar/SKILL.md',
      ),
    ),
  );
  assert.ok(
    existsSync(join(result.profiles.desktopHome, 'workspaces/w/skills/from-asar/SKILL.md')),
  );
  assert.ok(!existsSync(join(f.privateDir, 'profiles/imported/apps/desktop-1/app-asar/main.js')));
});

test('pending personal transaction blocks publication and MCP paths address owned copies', (t) => {
  const f = fixture(t);
  put(join(f.privateDir, 'pending.json'), { native: 'journal' });
  assert.equal(ensureFirstRun(root, { ...f, check: true }).status, 'recovery-needed');
  assert.throws(() => ensureFirstRun(root, f), /синхронизацию/);
  assert.ok(!existsSync(join(f.privateDir, 'profiles')));
  const other = fixture(t);
  put(join(other.home, '.nessy/.mcp.json'), {
    command: join(other.home, '.nessy/extensions/tool.js'),
  });
  put(join(other.home, '.nessy/extensions/tool.js'), '// tool');
  put(
    join(
      other.home,
      'Applications/Nessy Desktop.app/Contents/Resources/data/skills/wrapped/SKILL.md',
    ),
    '# Wrapped',
  );
  const result = ensureFirstRun(root, other);
  assert.equal(
    json(join(result.profiles.cliHome, '.mcp.json')).command,
    join(result.profiles.cliHome, 'extensions/tool.js'),
  );
  assert.ok(existsSync(join(result.profiles.cliHome, 'skills/wrapped/SKILL.md')));
});
