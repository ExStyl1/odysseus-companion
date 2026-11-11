import { verifySignature, verifyTrustedApplication } from './signing.mjs';
/** Application bundles must preserve relative framework links when copied to disk images. */
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  cpSync,
  chmodSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { join, dirname, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
export function validateBundle(bundle) {
  const root = realpathSync(bundle);
  function visit(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (lstatSync(path).isSymbolicLink()) {
        const target = readlinkSync(path);
        if (isAbsolute(target))
          throw Error('Absolute link in application bundle: ' + path + ' -> ' + target);
        let resolved;
        try {
          resolved = realpathSync(path);
        } catch {
          throw Error('Broken link in application bundle: ' + path);
        }
        if (resolved !== root && !resolved.startsWith(root + sep))
          throw Error('External link in application bundle: ' + path);
      } else if (entry.isDirectory()) {
        if ((lstatSync(path).mode & 5) !== 5)
          throw Error('Application directory is not accessible to other users: ' + path);
        visit(path);
      } else if (!(lstatSync(path).mode & 4))
        throw Error('Application file is not readable by other users: ' + path);
    }
  }
  visit(root);
  const framework = join(
    root,
    'Contents/Frameworks/Electron Framework.framework/Electron Framework',
  );
  if (!existsSync(framework) || !lstatSync(realpathSync(framework)).isFile())
    throw Error('Electron Framework is missing from application bundle');
  return true;
}
export function copyApplication(source, target) {
  validateBundle(source);
  execFileSync('/usr/bin/ditto', [source, target]);
  validateBundle(target);
}

/** npm bin links must retain their package-relative resolution after relocation. */
export function copyDependencyTree(source, target) {
  const root = realpathSync(source);
  function check(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isSymbolicLink()) {
        const link = readlinkSync(path), resolved = realpathSync(path);
        if (isAbsolute(link) || (resolved !== root && !resolved.startsWith(root + sep)))
          throw Error('External dependency link: ' + path);
      } else if (entry.isDirectory()) check(path);
    }
  }
  check(root);
  cpSync(root, target, { recursive: true, dereference: false, verbatimSymlinks: true });
}

/** Materialize dependency links: node's cp fast-path can retain build-host links even with dereference. */
export function copyDataTree(source, target, ancestors = new Set()) {
  const actual = realpathSync(source),
    stat = lstatSync(actual);
  if (stat.isDirectory()) {
    if (ancestors.has(actual)) throw Error('Cyclic release input: ' + source);
    const next = new Set(ancestors).add(actual);
    mkdirSync(target, { recursive: true, mode: 0o755 });
    chmodSync(target, 0o755);
    for (const name of readdirSync(actual)) {
      if (['.git', '.DS_Store', 'mcp.local.json', '.env'].includes(name)) continue;
      copyDataTree(join(actual, name), join(target, name), next);
    }
  } else if (stat.isFile()) {
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    copyFileSync(actual, target);
    chmodSync(target, stat.mode & 0o111 ? 0o755 : 0o644);
  } else throw Error('Unsupported release input: ' + source);
}

/** Verify the delivered image, including loader resolution and fresh-user startup with no developer PATH. */
export function verifyDiskImage(image, { trusted = false } = {}) {
  const temp = mkdtempSync(join(realpathSync(tmpdir()), 'odysseus-release-'));
  const mount = join(temp, 'volume'),
    relocated = join(temp, 'Odysseus.app'),
    home = join(temp, 'home');
  mkdirSync(mount);
  mkdirSync(home);
  let mounted = false;
  try {
    execFileSync(
      '/usr/bin/hdiutil',
      ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, image],
      { stdio: 'pipe' },
    );
    mounted = true;
    copyApplication(join(mount, 'Odysseus.app'), relocated);
    if (trusted) verifyTrustedApplication(relocated);
    else verifySignature(relocated);
    const env = {
      HOME: home,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      TMPDIR: temp,
      LANG: 'en_US.UTF-8',
    };
    const contents = join(relocated, 'Contents'),
      payload = join(contents, 'Resources/odysseus');
    if (existsSync(join(contents, 'Resources/app-update.yml'))) throw Error('Unexpected network updater feed in manual DMG release');
    execFileSync(
      join(contents, 'MacOS/Odysseus'),
      ['-e', 'if(!process.versions.electron) process.exit(1)'],
      { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30000, stdio: 'pipe' },
    );
    execFileSync(join(payload, 'bun'), ['--version'], { env, timeout: 30000, stdio: 'pipe' });
    execFileSync(
      join(payload, 'python/run'),
      [
        '-c',
        'import sys, graphify, mcp, ssl; assert sys.prefix.startswith(sys.argv[1])',
        join(payload, 'python'),
      ],
      { env, timeout: 30000, stdio: 'pipe' },
    );
    execFileSync(
      join(payload, 'node'),
      [join(payload, 'tools/distribution/cli.mjs'), '--version'],
      { env, cwd: home, timeout: 120000, stdio: 'pipe' },
    );
    execFileSync(join(payload, 'node'), [join(payload, 'n8n/node_modules/n8n/bin/n8n'), '--version'], { env, cwd: home, timeout: 30000, stdio: 'pipe' });
    execFileSync(join(payload, 'node'), [join(import.meta.dirname, '../../tests/automations/engine-smoke.mjs'), payload], { env, cwd: home, timeout: 180000, stdio: 'inherit' });
    const preferences = JSON.parse(readFileSync(join(home, '.odysseus/profiles/desktop/preferences.json'), 'utf8'));
    if (preferences.uiLanguage !== 'ru') throw Error('Fresh installation did not initialize Russian UI language');
    if (
      !existsSync(
        join(
          home,
          'Library/Application Support/Odysseus/runtime/.odysseus/graphify/knowledge/graph.json',
        ),
      )
    )
      throw Error('Fresh installation did not initialize the knowledge graph');
    if (
      existsSync(
        join(home, 'Library/Application Support/Odysseus/runtime/.odysseus/graphify/watch-parents'),
      )
    )
      throw Error('Help/version smoke must not start a knowledge watcher');
    // Re-run the delivered updater against a simulated prior build with actual user files.
    const runtime = join(home, 'Library/Application Support/Odysseus/runtime');
    const fixtures = [
      [join(home, '.odysseus/automations/preserved.json'), '{"workflow":"preserve n8n state"}'],
      [join(home, '.odysseus/profiles/desktop/workspaces/update-test/sessions/preserved.jsonl'), '{"text":"preserve desktop chat"}\n'],
      [join(home, '.odysseus/profiles/cli/projects/update-test/chats/preserved.json'), '{"text":"preserve CLI chat"}'],
      [join(runtime, 'workspace/preserved.md'), '# My project notes'],
      [join(runtime, 'shared/skills/personal-update-test/SKILL.md'), '# My own skill'],
      [join(runtime, '.odysseus/graphify/knowledge/overlay.json'), '{"nodes":[],"links":[],"annotations":{}}'],
    ];
    for (const [file, value] of fixtures) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); }
    const marker = join(runtime, 'distribution.json'), previous = JSON.parse(readFileSync(marker, 'utf8'));
    writeFileSync(marker, JSON.stringify({ ...previous, buildId: 'smoke-previous-build', version: '1.42.1-odysseus.18' }));
    execFileSync(join(payload, 'node'), [join(payload, 'tools/distribution/cli.mjs'), '--version'], { env, cwd: home, timeout: 180000, stdio: 'pipe' });
    for (const [file, value] of fixtures) if (readFileSync(file, 'utf8') !== value) throw Error('Upgrade changed user fixture: ' + file);
    const status = JSON.parse(execFileSync(join(payload, 'node'), [join(payload, 'tools/distribution/cli.mjs'), 'maintenance', 'status'], { env, encoding: 'utf8', timeout: 30000 }));
    if (status.backups.length !== 1) throw Error('Upgrade did not create one snapshot');
    execFileSync(join(payload, 'node'), [join(payload, 'tools/distribution/cli.mjs'), 'maintenance', 'verify', status.backups[0].id], { env, timeout: 30000, stdio: 'pipe' });
    console.log('Mounted DMG verified: relocated framework, bundled Node/Bun/Python, CLI, Russian preferences, fresh graph and upgrade with preserved user files plus verified backup; clean HOME and system-only PATH.');
  } finally {
    if (mounted) execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'pipe' });
    rmSync(temp, { recursive: true, force: true });
  }
}
