import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { noLinks, privateWrite } from '../personal/store.mjs';
const json = path => {
  noLinks(path);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
};

/** Apply the Russian Odysseus profile once; subsequent language changes remain user-owned. */
export function initializeLanguage(profiles) {
  const marker = join(profiles.desktopHome, '.odysseus-language-v1.json');
  if (existsSync(marker)) return;
  const prefsPath = join(profiles.desktopHome, 'preferences.json');
  const cliPath = join(profiles.cliHome, 'settings.json');
  const prefs = json(prefsPath), cli = json(cliPath);
  const language = 'ru';
  privateWrite(prefsPath, JSON.stringify({ ...prefs, uiLanguage: language }, null, 2) + '\n');
  privateWrite(cliPath, JSON.stringify({ ...cli, general: { ...cli.general, language } }, null, 2) + '\n');
  privateWrite(marker, JSON.stringify({ version: 1, language }));
}
