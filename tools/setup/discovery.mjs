/** Inspect known installation/profile locations. Never run a discovered binary. */
import { existsSync, lstatSync, realpathSync, accessSync, constants } from 'node:fs';
import { join, resolve, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { contained } from '../personal/store.mjs';

const directory = (p) => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};
export function discoverNessy({
  home = homedir(),
  env = process.env,
  platform = process.platform,
  privateDir = join(home, '.odysseus'),
  root,
  applicationRoots,
} = {}) {
  const cliNames =
    platform === 'win32' ? ['nessy.cmd', 'nessy.exe', 'nessy'] : ['nessy', 'nessy-cli'];
  const cliBinaries = [];
  for (const folder of (env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const name of cliNames) {
      const file = join(folder, name);
      try {
        accessSync(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
        const path = realpathSync(file);
        if (!cliBinaries.includes(path)) cliBinaries.push(path);
      } catch {
        /* A missing PATH entry is normal. */
      }
    }
  }
  const appRoots =
    applicationRoots ||
    (platform === 'darwin'
      ? [
          '/Applications',
          join(home, 'Applications'),
          join(home, 'Downloads'),
          join(home, 'Desktop'),
          ...(root ? [root] : []),
        ]
      : platform === 'win32'
        ? [join(env.LOCALAPPDATA || join(home, 'AppData/Local'), 'Programs')]
        : ['/opt', join(home, '.local/share')]);
  const desktopNames =
    platform === 'darwin'
      ? ['Nessy Desktop.app', 'Nessy.app', 'Nessy Dekstop.app']
      : ['Nessy Desktop', 'nessy-desktop', 'nessy'];
  const desktopBinaries = appRoots
    .flatMap((folder) => desktopNames.map((name) => join(folder, name)))
    .filter(directory);
  const appData = env.APPDATA || join(home, 'AppData/Roaming');
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config');
  const candidates = {
    cli: [
      env.NESSY_HOME,
      join(home, '.nessy'),
      join(home, '.nessy-cli'),
      join(home, '.nestor'),
      join(home, '.nestor/cli'),
      join(configHome, 'nessy'),
      join(appData, 'nessy'),
    ],
    desktop: [
      env.NESSY_CONFIG_DIR,
      join(home, '.nessy-agent'),
      join(home, '.nessy-desktop'),
      join(home, '.nestor/desktop'),
      join(home, '.nestor/.nessy-agent'),
      join(home, 'Library/Application Support/Nessy'),
      join(home, 'Library/Application Support/Nessy Desktop'),
      join(configHome, 'nessy-agent'),
      join(appData, 'nessy-agent'),
    ],
  };
  const profiles = { cli: [], desktop: [] },
    seen = new Set();
  for (const [kind, paths] of Object.entries(candidates))
    for (const raw of paths.filter(Boolean)) {
      const path = resolve(raw);
      if (seen.has(kind + ':' + path) || contained(privateDir, path) || !directory(path)) continue;
      const markers =
        kind === 'cli'
          ? ['settings.json', 'projects', 'skills', 'extensions', '.mcp.json']
          : ['config.json', 'workspaces', 'credentials.enc'];
      if (!markers.some((marker) => existsSync(join(path, marker)))) continue;
      seen.add(kind + ':' + path);
      profiles[kind].push(path);
    }
  for (const app of desktopBinaries) {
    const path = join(app, 'Contents/Resources/.nessy-agent');
    if (directory(path) && !profiles.desktop.includes(path)) profiles.desktop.push(path);
  }
  let cliRuntime = env.NESSY_RUNTIME_DIR && resolve(env.NESSY_RUNTIME_DIR);
  if (!cliRuntime || !directory(cliRuntime) || contained(privateDir, cliRuntime))
    cliRuntime = profiles.cli[0] || null;
  const globalSkills = join(home, '.agents/skills');
  return {
    installations: { cli: cliBinaries, desktop: desktopBinaries },
    profiles,
    cliRuntime,
    globalSkills: directory(globalSkills) ? globalSkills : null,
    legacyRoots: [env.NESTOR_HOME, join(home, '.nestor')]
      .filter(Boolean)
      .map((path) => resolve(path))
      .filter(
        (path, index, all) =>
          directory(path) && !contained(privateDir, path) && all.indexOf(path) === index,
      ),
  };
}
