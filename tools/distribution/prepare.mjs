/** Materialize bundled code in a writable user runtime; preserve user resources on upgrades. */
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  cpSync,
  chmodSync,
  statSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { noLinks, privateWrite } from '../personal/store.mjs';
import { ensureFirstRun } from '../setup/first-run.mjs';
const json = (file, fallback = {}) =>
  existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
const hash = (file) =>
  existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
const quote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
export function installCommand({ home, node, entry }) {
  const bin = join(home, '.local/bin'),
    command = join(bin, 'od'),
    marker = '# Odysseus managed CLI';
  noLinks(bin);
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  noLinks(command);
  if (existsSync(command) && !readFileSync(command, 'utf8').includes(marker))
    return ['Команда od уже занята: ' + command];
  privateWrite(command, `#!/bin/sh\n${marker}\nexec ${quote(node)} ${quote(entry)} "$@"\n`);
  chmodSync(command, 0o700);
  const warnings = [];
  for (const name of ['.zprofile', '.zshrc', '.bash_profile']) {
    const file = join(home, name);
    try {
      noLinks(file);
      const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
      if (!before.includes('# >>> Odysseus CLI >>>'))
        writeFileSync(
          file,
          before +
            '\n# >>> Odysseus CLI >>>\ncase "$PATH" in "$HOME/.local/bin"|"$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac\n# <<< Odysseus CLI <<<\n',
          { mode: 0o600 },
        );
    } catch {
      warnings.push('Добавьте ~/.local/bin в PATH: ' + file);
    }
  }
  return warnings;
}
export function prepareDistribution(payload, { home = homedir(), install = true } = {}) {
  payload = resolve(payload);
  const release = json(join(payload, 'release.json'));
  if (!release.buildId) throw Error('Invalid distribution');
  const root = join(home, 'Library/Application Support/Odysseus/runtime');
  noLinks(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const marker = join(root, 'distribution.json'),
    previous = json(marker),
    lock = join(root, '.distribution.lock');
  if (previous.buildId !== release.buildId) {
    noLinks(lock);
    if (existsSync(lock)) {
      const owner = json(join(lock, 'owner.json'));
      let alive = true;
      if (Number.isInteger(owner.pid) && owner.pid > 0) {
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') alive = false;
        }
      } else if (Date.now() - statSync(lock).mtimeMs > 30000) alive = false;
      if (!alive) rmSync(lock, { recursive: true });
    }
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch {
      throw Error('Odysseus обновляется. Повторите запуск через несколько секунд.');
    }
    privateWrite(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
    try {
      for (const name of ['tools', 'integrations', 'cli', 'desktop', 'docs']) {
        noLinks(join(root, name));
        const stage = join(root, `.${name}-stage-${process.pid}`);
        rmSync(stage, { recursive: true, force: true });
        cpSync(join(payload, name), stage, { recursive: true, dereference: true });
        const old = join(root, `.${name}-previous`);
        rmSync(old, { recursive: true, force: true });
        if (existsSync(join(root, name))) renameSync(join(root, name), old);
        renameSync(stage, join(root, name));
        rmSync(old, { recursive: true, force: true });
      }
      const managed = {};
      function merge(source, target, prefix = '') {
        mkdirSync(target, { recursive: true, mode: 0o700 });
        noLinks(target);
        for (const item of readdirSync(source, { withFileTypes: true })) {
          const key = prefix + item.name,
            s = join(source, item.name),
            t = join(target, item.name);
          noLinks(t);
          if (item.isSymbolicLink()) throw Error('Unexpected bundle link');
          if (item.isDirectory()) merge(s, t, key + '/');
          else {
            const next = hash(s),
              current = hash(t);
            if (!current || current === previous.shared?.[key] || current === next) {
              cpSync(s, t);
              managed[key] = next;
            } else managed[key] = previous.shared?.[key] || null;
          }
        }
      }
      merge(join(payload, 'shared'), join(root, 'shared'));
      cpSync(join(payload, 'odysseus.json'), join(root, 'odysseus.json'));
      mkdirSync(join(root, 'workspace'), { recursive: true, mode: 0o700 });
      mkdirSync(join(root, 'desktop'), { recursive: true, mode: 0o700 });
      privateWrite(marker, JSON.stringify({ ...release, shared: managed }));
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
  const imported = ensureFirstRun(root, { home });
  const node = join(payload, 'node');
  const warnings = install
    ? installCommand({ home, node, entry: join(payload, 'tools/distribution/cli.mjs') })
    : [];
  return {
    ODYSSEUS_ROOT: root,
    ODYSSEUS_NODE: node,
    NESSY_HOME: imported.profiles.cliHome,
    NESSY_RUNTIME_DIR: imported.profiles.cliRuntime,
    NESSY_CONFIG_DIR: imported.profiles.desktopHome,
    NESSY_APP_NAME: 'Odysseus',
    ODYSSEUS_INSTALL_WARNINGS: warnings.join('\n'),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(JSON.stringify(prepareDistribution(process.argv[2])));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
