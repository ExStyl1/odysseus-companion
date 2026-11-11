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

export function preferredNessyProfile(paths) {
  const connection = json(join(paths.home, 'nessy-connection.json'));
  const attached = json(join(paths.home, 'attached-profiles.json')).profiles || [];
  const path = connection.profile;
  return path && attached.some(row => row.path === path) && isProfile(path) ? path : paths.profile;
}

export function connectDiscoveredNessy(paths, installer, userDirectory = homedir()) {
  const stateFile = join(paths.home, 'nessy-connection.json');
  const previous = json(stateFile);
  const explicit = paths.env.NESSY_HOME;
  const candidates = [
    previous.profile,
    isAbsolute(explicit || '') ? explicit : undefined,
    join(userDirectory, '.nessy'),
    join(userDirectory, '.nessy-agent'),
  ];
  const profile = candidates.filter(Boolean).map(path => resolve(path))
    .find(path => path !== paths.profile && isProfile(path));
  if (!profile) return null;
  const current = installer.status().profiles.find(row => row.path === profile);
  if (current && previous.profile === profile && previous.root === paths.root && previous.version === current.version &&
    json(join(profile, 'settings.json')).mcpServers?.['odysseus-companion']?.args?.[0] === join(paths.root, 'tools/companion/mcp.mjs') &&
    current.version === json(join(paths.root, 'companion-release.json')).version) return previous;

  const installed = installer.install({ profile, integrationOnly: true });
  const connection = { profile, root: paths.root, version: json(join(paths.root, 'companion-release.json')).version, connectedAt: new Date().toISOString() };
  privateWrite(stateFile, JSON.stringify(connection));
  return { ...connection, restartNessy: installed.restartNessy };
}
