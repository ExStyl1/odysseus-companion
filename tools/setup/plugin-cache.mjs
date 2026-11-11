/** Plugin caches are immutable installed code, not disposable browser caches. */
import { existsSync, readFileSync, readdirSync, lstatSync, realpathSync, mkdirSync, cpSync, renameSync, rmSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { noLinks } from '../personal/store.mjs';

function cacheRelativePath(entry) {
  const ref = entry.cacheRef;
  if (!ref || !/^[a-f0-9]{64}$/.test(ref.bundleHash) || ref.bundleHash !== entry.bundleHash) return;
  const segments = [ref.marketplaceId, ref.pluginId, ref.version];
  if (segments.some(value => typeof value !== 'string' || !value || value.includes('\0'))) return;
  return join(...segments.map(value => Buffer.from(value).toString('base64url')), ref.bundleHash);
}
function validateTree(root) {
  const canonical = realpathSync(root);
  const visit = folder => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isSymbolicLink()) {
        const target = realpathSync(path);
        const rel = relative(canonical, target);
        if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw Error('Unsafe plugin bundle link');
      } else if (entry.isDirectory()) visit(path);
      else if (!entry.isFile()) throw Error('Unsupported plugin bundle entry');
    }
  };
  visit(root);
}

/** Restore ONLY wholly absent, registry-addressed bundles; never merge or rewrite installed code. */
export function restorePluginBundles(desktopHome, sourceProfiles = []) {
  const registryPath = join(desktopHome, 'plugins/installed.json');
  if (!existsSync(registryPath)) return { restored: 0, missing: [] };
  noLinks(registryPath);
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const result = { restored: 0, missing: [] };
  for (const entry of registry.plugins || []) {
    const rel = cacheRelativePath(entry);
    if (!rel) continue;
    const target = join(desktopHome, 'plugins/cache', rel);
    noLinks(target);
    if (existsSync(target)) continue;
    let restored = false;
    for (const profile of sourceProfiles) {
      const source = join(profile, 'plugins/cache', rel);
      if (!existsSync(source)) continue;
      let stage;
      try {
        noLinks(source);
        if (!lstatSync(source).isDirectory()) continue;
        validateTree(source);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        stage = target + '.import-' + randomUUID();
        cpSync(source, stage, { recursive: true, verbatimSymlinks: true });
        validateTree(stage);
        renameSync(stage, target);
        result.restored++;
        restored = true;
        break;
      } catch {
        // Keep the registry for the native Repair action; never substitute another version.
      } finally {
        if (stage) rmSync(stage, { recursive: true, force: true });
      }
    }
    if (!restored) result.missing.push(entry.pluginKey);
  }
  return result;
}
