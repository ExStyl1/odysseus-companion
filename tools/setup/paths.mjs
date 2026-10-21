import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { noLinks } from '../personal/store.mjs';

export function managedProfiles(privateDir, { allowPending = false } = {}) {
  const base = resolve(privateDir, 'profiles');
  const file = join(base, 'installation.json');
  if (!existsSync(file)) return null;
  noLinks(file);
  const state = JSON.parse(readFileSync(file, 'utf8'));
  if (state.schemaVersion !== 1 || state.status !== 'ready') throw Error('Invalid first-run state');
  if (!allowPending && existsSync(join(base, 'rebased-bridge-state.json')))
    throw Error('First-run recovery is required; run npm run setup');
  const profiles = {
    cliHome: join(base, 'cli'),
    desktopHome: join(base, 'desktop'),
    cliRuntime: join(base, state.runtimeShared ? 'cli' : 'cli-runtime'),
  };
  for (const path of Object.values(profiles)) {
    noLinks(path);
    if (!existsSync(path)) throw Error('Imported Odysseus profile is unavailable: ' + path);
  }
  return { ...profiles, state };
}
