import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { copyDataTree } from '../distribution/bundle.mjs';

export function copyMcpRuntime(source, target) {
  const copied = new Set();

  function copyPackage(name, importer) {
    const locations = createRequire(importer).resolve.paths(name) || [];
    const manifest = locations.map(location => join(location, name, 'package.json'))
      .find(path => existsSync(path) && !relative(source, path).startsWith('..'));
    if (!manifest) throw Error('Не найдена зависимость MCP: ' + name);
    if (copied.has(manifest)) return;
    copied.add(manifest);
    const packageDir = join(manifest, '..');
    copyDataTree(packageDir, join(target, relative(source, packageDir)));
    const metadata = JSON.parse(readFileSync(manifest, 'utf8'));
    for (const dependency of Object.keys(metadata.dependencies || {})) copyPackage(dependency, manifest);
  }

  for (const name of ['@modelcontextprotocol/sdk', 'zod']) copyPackage(name, join(source, 'package.json'));
}
