import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import { json } from './paths.mjs';
import { noLinks, privateWrite } from '../personal/store.mjs';

function isProfile(path) {
  try {
    const settings = join(path, 'settings.json');
    noLinks(settings);
    const stat = lstatSync(settings);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > 2 * 1024 * 1024) return false;
    const data = json(settings);
    return data && typeof data === 'object' && !Array.isArray(data);
  } catch {
    return false;
  }
}

function discoverProfile(paths, userDirectory = homedir()) {
  const connection = json(join(paths.home, 'nessy-connection.json'));
  const explicit = paths.env.NESSY_HOME;
  return [isAbsolute(explicit || '') ? explicit : undefined, connection.profile,
    join(userDirectory, '.nessy'), join(userDirectory, '.nessy-agent')]
    .filter(Boolean).map(path => resolve(path))
    .find(path => path !== paths.profile && isProfile(path));
}

export function preferredNessyProfile(paths) {
  return discoverProfile(paths) || paths.profile;
}

export function connectDiscoveredNessy(paths, userDirectory = homedir()) {
  const profile = discoverProfile(paths, userDirectory);
  if (!profile) return null;
  const attached = json(join(paths.home, 'attached-profiles.json')).profiles || [];
  privateWrite(join(paths.home, 'nessy-connection.json'), JSON.stringify({ profile }));
  return { profile, extensionInstalled: attached.some(row => row.path === profile) };
}
