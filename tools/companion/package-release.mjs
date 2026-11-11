import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { validateBundle } from '../distribution/bundle.mjs';

const folder = resolve(import.meta.dirname, '../../dist/companion');
const app = join(folder, 'Odysseus Companion.app');
const resources = join(app, 'Contents/Resources');
const release = JSON.parse(readFileSync(join(resources, 'platform/companion-release.json'), 'utf8'));
const runtime = JSON.parse(readFileSync(join(resources, 'app/runtime.json'), 'utf8'));

if (!/^\d+\.\d+\.\d+$/.test(release.version)) throw Error('Некорректная версия');
if (release.localN8n !== false || existsSync(join(resources, 'platform/n8n')))
  throw Error('Для выпуска нужна облегчённая сборка Companion');
if (runtime.legacyHome || runtime.previousRoot)
  throw Error('Соберите выпуск без --migrate-local');
const seed = join(resources, 'platform/seed/profile');
const settings = JSON.parse(readFileSync(join(seed, 'settings.json'), 'utf8'));
if (JSON.stringify(settings) !== JSON.stringify({ permissions: { allow: [] } }))
  throw Error('Начальный профиль должен содержать только пустой список разрешений');
validateBundle(app);
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
const binary = execFileSync('/usr/bin/file', ['-b', join(app, 'Contents/MacOS/Electron')], { encoding: 'utf8' });
if (!binary.includes('arm64')) throw Error('Выпуск должен быть собран для Apple Silicon');

const name = 'Odysseus-Companion-' + release.version + '-macos-arm64.zip';
const archive = join(folder, name), checksum = archive + '.sha256';
if (existsSync(archive) || existsSync(checksum)) throw Error('Архив этой версии уже существует');
try {
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
  const bytes = statSync(archive).size;
  if (bytes >= 2 * 1024 ** 3) throw Error('Архив превышает лимит GitHub Releases');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  writeFileSync(checksum, hash.digest('hex') + '  ' + name + '\n', { flag: 'wx' });
  console.log(archive + ' (' + Math.round(bytes / 1024 ** 2) + ' МиБ)');
  console.log(checksum);
} catch (error) {
  rmSync(archive, { force: true });
  throw error;
}
