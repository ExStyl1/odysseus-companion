import { resolve, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { automationPaths } from '../automations/config.mjs';
import { runtimePaths } from '../graphify.mjs';
export function companionPaths(root = resolve(import.meta.dirname, '../..'), env = process.env) {
  const home = resolve(env.ODYSSEUS_COMPANION_HOME || join(root, '.odysseus/companion'));
  const data = join(home, 'data');
  const environment = { ...env, ODYSSEUS_ROOT: root, ODYSSEUS_DATA_DIR: data,
    NESSY_CONFIG_DIR: join(home, 'unused-desktop-profile') };
  if(env.ODYSSEUS_COMPANION_STANDALONE==='1'){
    environment.ODYSSEUS_GRAPH_RUNTIME_DIR=join(home,'graphify');
    environment.ODYSSEUS_KNOWLEDGE_DIR=join(home,'graphify/knowledge');
    environment.ODYSSEUS_PYTHON=join(root,'python/run');
  }
  const automation=automationPaths(root,environment);
  if(existsSync(join(root,'n8n/package.json')))automation.runtime=join(root,'n8n');
  return { root, home, data, localN8n: json(join(root,'companion-release.json')).localN8n !== false, profile: join(home, 'nessy'), installation: join(home, 'installation.json'), env: environment,
    automation, knowledge: runtimePaths(root, environment) };
}
export function json(file, fallback = {}) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}
