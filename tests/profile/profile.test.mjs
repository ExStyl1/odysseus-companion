import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { syncProfile } from '../../tools/profile/index.mjs';
import { launchSpec } from '../../tools/odysseus.mjs';

function put(root, path, value) {
  const target = join(root, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
}
const get = (root, path) => readFileSync(join(root, path), 'utf8');
const doc = (root, path) => JSON.parse(get(root, path));

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'odysseus-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'manager');
  const p = join(base, 'project');
  const q = join(base, 'another project');
  mkdirSync(p);
  mkdirSync(q);
  mkdirSync(root);
  put(root, 'odysseus.json', {
    schemaVersion: 1,
    sharedDirectory: 'shared',
    components: {
      cli: { source: 'components/cli', command: ['nessy'] },
      desktop: {
        source: 'components/desktop',
        command: ['desktop', '--native'],
      },
    },
  });
  put(root, 'components/cli/package.json', { version: '1.0.0' });
  put(root, 'components/desktop/package.json', { version: '2.0.0' });
  put(root, 'shared/mcp.json', {
    mcpServers: {
      example: {
        command: 'node',
        args: ['server.mjs'],
        env: { TOKEN: '${TEST_TOKEN}' },
      },
    },
  });
  put(root, 'shared/skills/demo/SKILL.md', '---\nname: demo\ndescription: Example\n---\nHello');
  put(root, 'shared/agents/helper.md', '---\nname: helper\ndescription: Helper\n---\nHelp');
  put(root, 'shared/rules/shared.md', 'Shared rules');
  return { root, p, q };
}

test('both native layouts, MCP env placeholders, script executable bit and idempotence', (t) => {
  const { root, p } = fixture(t);
  put(root, 'shared/skills/demo/scripts/run.sh', '#!/bin/sh\nexit 0\n');
  chmodSync(join(root, 'shared/skills/demo/scripts/run.sh'), 0o755);
  const result = syncProfile(root, { attach: p });
  assert.equal(result.resources, 5);
  assert.equal(doc(p, '.mcp.json').mcpServers.example.env.TOKEN, '${TEST_TOKEN}');
  assert.equal(get(p, '.agents/skills/demo/SKILL.md'), get(root, 'shared/skills/demo/SKILL.md'));
  assert.equal(get(p, '.nessy/agents/helper.md'), get(p, '.nessy-agent/agents/helper.md'));
  assert.equal(get(p, '.nessy/rules/shared.md'), get(p, '.nessy-agent/rules/shared.md'));
  assert.ok(statSync(join(p, '.agents/skills/demo/scripts/run.sh')).mode & 0o100);
  assert.equal(statSync(join(p, '.mcp.json')).mode & 0o777, 0o600);
  assert.deepEqual(syncProfile(root).changes, []);
});

test('existing unmanaged MCP entries and top-level metadata survive', (t) => {
  const { root, p } = fixture(t);
  put(p, '.mcp.json', {
    metadata: { owner: 'local' },
    mcpServers: { local: { command: 'local-server' } },
  });
  syncProfile(root, { attach: p });
  assert.deepEqual(doc(p, '.mcp.json').metadata, { owner: 'local' });
  assert.equal(doc(p, '.mcp.json').mcpServers.local.command, 'local-server');
  assert.equal(doc(root, 'shared/mcp.json').mcpServers.local, undefined);
});

test('explicit import adds existing resources; new local resources require another import', (t) => {
  const { root, p, q } = fixture(t);
  put(p, '.mcp.json', {
    mcpServers: {
      imported: { type: 'http', url: 'https://example.invalid/mcp' },
    },
  });
  put(p, '.agents/skills/local/SKILL.md', 'Local skill');
  syncProfile(root, { attach: p, importExisting: true });
  syncProfile(root, { attach: q });
  assert.equal(doc(q, '.mcp.json').mcpServers.imported.type, 'http');
  assert.equal(get(q, '.agents/skills/local/SKILL.md'), 'Local skill');
  put(p, '.agents/skills/new/SKILL.md', 'New');
  syncProfile(root);
  assert.equal(existsSync(join(q, '.agents/skills/new/SKILL.md')), false);
  syncProfile(root, { attach: p, importExisting: true });
  assert.equal(get(q, '.agents/skills/new/SKILL.md'), 'New');
});

test('edits from Desktop projection propagate to CLI and other projects', (t) => {
  const { root, p, q } = fixture(t);
  syncProfile(root, { attach: p });
  syncProfile(root, { attach: q });
  put(p, '.nessy-agent/agents/helper.md', 'Edited from Desktop');
  const mcp = doc(q, '.mcp.json');
  mcp.mcpServers.example.args = ['changed.mjs'];
  put(q, '.mcp.json', mcp);
  syncProfile(root);
  assert.equal(get(root, 'shared/agents/helper.md'), 'Edited from Desktop');
  assert.equal(get(q, '.nessy/agents/helper.md'), 'Edited from Desktop');
  assert.deepEqual(doc(p, '.mcp.json').mcpServers.example.args, ['changed.mjs']);
  assert.deepEqual(syncProfile(root).changes, []);
});

test('different simultaneous edits abort all writes, including unrelated changes', (t) => {
  const { root, p, q } = fixture(t);
  syncProfile(root, { attach: p });
  syncProfile(root, { attach: q });
  const state = get(root, '.odysseus/state.json');
  put(root, 'shared/skills/demo/SKILL.md', 'Central edit');
  put(p, '.agents/skills/demo/SKILL.md', 'Local edit');
  put(root, 'shared/rules/shared.md', 'Unrelated change');
  assert.throws(() => syncProfile(root), /Both shared and project changed/);
  assert.equal(get(q, '.nessy/rules/shared.md'), 'Shared rules');
  assert.equal(get(root, '.odysseus/state.json'), state);
  assert.equal(get(p, '.agents/skills/demo/SKILL.md'), 'Local edit');
});

test('conflicting changes in two projects and two mirrored agent files are rejected', (t) => {
  const { root, p, q } = fixture(t);
  syncProfile(root, { attach: p });
  syncProfile(root, { attach: q });
  put(p, '.nessy/agents/helper.md', 'A');
  put(q, '.nessy-agent/agents/helper.md', 'B');
  assert.throws(() => syncProfile(root), /Projects disagree/);
});

test('deletions propagate, while unrelated local resources remain', (t) => {
  const { root, p, q } = fixture(t);
  syncProfile(root, { attach: p });
  syncProfile(root, { attach: q });
  put(q, '.agents/skills/private/SKILL.md', 'Keep');
  rmSync(join(root, 'shared/skills/demo/SKILL.md'));
  rmSync(join(p, '.nessy-agent/agents/helper.md'));
  const mcp = doc(p, '.mcp.json');
  delete mcp.mcpServers.example;
  put(p, '.mcp.json', mcp);
  syncProfile(root);
  assert.equal(existsSync(join(q, '.agents/skills/demo/SKILL.md')), false);
  assert.equal(existsSync(join(root, 'shared/agents/helper.md')), false);
  assert.equal(existsSync(join(q, '.nessy/agents/helper.md')), false);
  assert.deepEqual(doc(q, '.mcp.json').mcpServers, {});
  assert.equal(get(q, '.agents/skills/private/SKILL.md'), 'Keep');
  assert.deepEqual(syncProfile(root).changes, []);
});

test('first attach conflict and --check do not apply a partial profile', (t) => {
  const { root, p } = fixture(t);
  put(p, '.agents/skills/demo/SKILL.md', 'Existing different content');
  assert.throws(() => syncProfile(root, { attach: p }), /Existing project resource conflicts/);
  assert.equal(existsSync(join(p, '.mcp.json')), false);
  rmSync(join(p, '.agents/skills/demo/SKILL.md'));
  const result = syncProfile(root, { attach: p, check: true });
  assert.ok(result.changes.length);
  assert.equal(existsSync(join(p, '.mcp.json')), false);
  assert.equal(existsSync(join(root, '.odysseus/state.json')), false);
});

test('symlink escape, invalid config and component-source attachment are rejected', (t) => {
  const { root, p, q } = fixture(t);
  symlinkSync(q, join(p, '.agents'), 'dir');
  assert.throws(() => syncProfile(root, { attach: p }), /Symlink is not managed/);
  assert.equal(existsSync(join(q, 'skills/demo/SKILL.md')), false);
  rmSync(join(p, '.agents'));
  put(root, 'shared/mcp.json', {
    mcpServers: { bad: { command: 'node', scope: 'system' } },
  });
  assert.throws(() => syncProfile(root, { attach: p }), /scope\/trust/);
  assert.throws(
    () => syncProfile(root, { attach: join(root, 'components/cli') }),
    /component source/,
  );
});

test('lock and malformed JSON fail without writing project config', (t) => {
  const { root, p } = fixture(t);
  mkdirSync(join(root, '.odysseus/sync.lock'), { recursive: true });
  assert.throws(() => syncProfile(root, { attach: p }), /Another sync holds/);
  rmSync(join(root, '.odysseus/sync.lock'), { recursive: true });
  put(p, '.mcp.json', '{bad json');
  assert.throws(() => syncProfile(root, { attach: p }), /Invalid JSON/);
  assert.equal(get(p, '.mcp.json'), '{bad json');
});

test('replacing each component independently preserves profile, projects and installed launch commands', (t) => {
  const { root, p } = fixture(t);
  syncProfile(root, { attach: p });
  const before = get(root, '.odysseus/state.json');
  const mcp = get(p, '.mcp.json');
  const cli = launchSpec(root, 'cli', p, false, ['-p', 'literal; $(never execute)']);
  const desktop = launchSpec(root, 'desktop', p);
  assert.deepEqual(cli, {
    command: 'nessy',
    args: ['-p', 'literal; $(never execute)'],
    cwd: p,
  });
  assert.deepEqual(desktop, { command: 'desktop', args: ['--native'], cwd: p });
  rmSync(join(root, 'components/cli'), { recursive: true });
  put(root, 'components/cli/package.json', { version: '1.1.0' });
  assert.equal(doc(root, 'components/desktop/package.json').version, '2.0.0');
  assert.deepEqual(syncProfile(root).changes, []);
  rmSync(join(root, 'components/desktop'), { recursive: true });
  put(root, 'components/desktop/package.json', { version: '2.1.0' });
  assert.equal(doc(root, 'components/cli/package.json').version, '1.1.0');
  assert.equal(get(root, '.odysseus/state.json'), before);
  assert.equal(get(p, '.mcp.json'), mcp);
  assert.deepEqual(launchSpec(root, 'desktop', p), desktop);
});

test('CLI run passes literal arguments to installed executable and syncs before launch', (t) => {
  const { root, p } = fixture(t);
  const config = doc(root, 'odysseus.json');
  const fake = join(root, 'fake-cli.mjs');
  put(
    root,
    'fake-cli.mjs',
    `import {existsSync,writeFileSync} from 'node:fs'; writeFileSync('launch.json',JSON.stringify({args:process.argv.slice(2),synced:existsSync('.mcp.json')}));`,
  );
  config.components.cli.command = [process.execPath, fake];
  put(root, 'odysseus.json', config);
  const runner = fileURLToPath(new URL('../../tools/odysseus.mjs', import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {main} from ${JSON.stringify(pathToFileURL(runner).href)}; await main(${JSON.stringify(['run', 'cli', '--project', p, '--', '-p', 'literal $(touch bad)'])}, ${JSON.stringify(root)});`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(doc(p, 'launch.json'), {
    args: ['-p', 'literal $(touch bad)'],
    synced: true,
  });
  assert.equal(existsSync(join(p, 'bad')), false);
});

test('HTTP and SSE use the same transport in both native products, including legacy CLI import', (t) => {
  const { root, p, q } = fixture(t);
  put(p, '.mcp.json', {
    mcpServers: {
      legacy: { httpUrl: 'https://example.invalid/mcp' },
      events: { url: 'https://example.invalid/sse' },
    },
  });
  syncProfile(root, { attach: p, importExisting: true });
  syncProfile(root, { attach: q });
  const output = doc(q, '.mcp.json').mcpServers;
  assert.equal(output.legacy.type, 'http');
  assert.equal(output.legacy.url, output.legacy.httpUrl);
  assert.equal(output.events.type, 'sse');
  assert.equal(output.events.httpUrl, undefined);
  assert.equal(doc(root, 'shared/mcp.json').mcpServers.legacy.httpUrl, undefined);
  assert.deepEqual(syncProfile(root).changes, []);
  put(root, 'shared/mcp.json', {
    mcpServers: {
      broken: {
        type: 'http',
        url: 'https://a.invalid',
        httpUrl: 'https://b.invalid',
      },
    },
  });
  assert.throws(() => syncProfile(root), /Conflicting MCP transport/);
});

test('native Desktop parser reads projected stdio, HTTP and SSE without warnings', (t) => {
  const { root, p } = fixture(t);
  put(root, 'shared/mcp.json', {
    mcpServers: {
      child: { command: 'node', args: ['server.mjs'] },
      web: { type: 'http', url: 'https://example.invalid/mcp' },
      events: { type: 'sse', url: 'https://example.invalid/events' },
    },
  });
  syncProfile(root, { attach: p });
  const native = new URL(
    '../../nessy-desktop-feat-TCODE-000-1-41-0/packages/shared/src/mcp/project-config.ts',
    import.meta.url,
  ).href;
  const script = `import {loadProjectMcpServers} from ${JSON.stringify(native)}; const warnings=[]; const result=loadProjectMcpServers(${JSON.stringify(p)},m=>warnings.push(m)); console.log(JSON.stringify({result,warnings}));`;
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.result.child.type, 'stdio');
  assert.equal(parsed.result.child.env.NESSY_PROJECT_DIR, p);
  assert.equal(parsed.result.web.type, 'http');
  assert.equal(parsed.result.events.type, 'sse');
});

test('I/O error during apply rolls back already-written project files', (t) => {
  const { root, p, q } = fixture(t);
  syncProfile(root, { attach: p });
  syncProfile(root, { attach: q });
  const state = get(root, '.odysseus/state.json');
  put(root, 'shared/rules/shared.md', 'Next rules');
  const module = new URL('../../tools/profile/index.mjs', import.meta.url).href;
  const failPath = join(p, '.nessy-agent/rules/shared.md');
  const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const rename=fs.renameSync; let injected=false;
    fs.renameSync=(from,to)=>{if(!injected&&to===${JSON.stringify(failPath)}){injected=true;throw new Error('injected I/O failure')}return rename(from,to)};
    syncBuiltinESMExports(); const {syncProfile}=await import(${JSON.stringify(module)});
    try{syncProfile(${JSON.stringify(root)});process.exitCode=2}catch(e){if(e.message!=='injected I/O failure')throw e;console.log('rollback exercised')}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rollback exercised/);
  for (const project of [p, q]) {
    assert.equal(get(project, '.nessy/rules/shared.md'), 'Shared rules');
    assert.equal(get(project, '.nessy-agent/rules/shared.md'), 'Shared rules');
  }
  assert.equal(get(root, '.odysseus/state.json'), state);
  assert.equal(get(root, 'shared/rules/shared.md'), 'Next rules');
  syncProfile(root);
  assert.equal(get(q, '.nessy/rules/shared.md'), 'Next rules');
});

test('detach preserves copies and allows sync after removing a project', (t) => {
  const { root, p, q } = fixture(t);
  syncProfile(root, { attach: p });
  syncProfile(root, { attach: q });
  syncProfile(root, { detach: p });
  assert.ok(existsSync(join(p, '.mcp.json')));
  rmSync(p, { recursive: true });
  assert.deepEqual(syncProfile(root).projects, [q]);
});

test('shared profile cannot be placed inside a component or the sync state', (t) => {
  const { root, p } = fixture(t);
  const config = doc(root, 'odysseus.json');
  config.sharedDirectory = 'components/cli/profile';
  put(root, 'odysseus.json', config);
  assert.throws(() => syncProfile(root, { attach: p }), /outside component source/);
  config.sharedDirectory = '.odysseus/shared';
  put(root, 'odysseus.json', config);
  assert.throws(() => syncProfile(root, { attach: p }), /separate from manager state/);
});

test('crashed profile synchronizer releases a stale lock; living owner is retained', async (t) => {
  const { utimesSync } = await import('node:fs');
  const { root } = fixture(t);
  const lock = join(root, '.odysseus/sync.lock');
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 60000);
  utimesSync(lock, old, old);
  assert.doesNotThrow(() => syncProfile(root));
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
  assert.doesNotThrow(() => syncProfile(root));
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  utimesSync(lock, old, old);
  assert.throws(() => syncProfile(root), /Another sync/);
});
