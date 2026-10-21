import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

const assetsDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(assetsDir, 'src');

// Force all React imports to resolve to the same copy to avoid
// the "multiple React instances" bug (hooks break when two copies coexist).
const require = createRequire(join(assetsDir, 'package.json'));
const reactPath = dirname(require.resolve('react/package.json'));
const reactDomPath = dirname(require.resolve('react-dom/package.json'));

export const buildConfig = {
  entryPoints: [join(srcDir, 'main.tsx')],
  bundle: true,
  minify: true,
  write: false,
  outdir: join(assetsDir, 'dist'),
  platform: 'browser',
  format: 'iife',
  target: ['es2018'],
  jsx: 'automatic',
  alias: {
    react: reactPath,
    'react-dom': reactDomPath,
  },
  // Встраиваем ВСЁ - React, ReactDOM и webui компоненты
  // React из CDN не нужен - всё будет в одном бандле
  legalComments: 'none',
  loader: {
    '.ts': 'ts',
    '.tsx': 'tsx',
    '.js': 'jsx',
    '.jsx': 'jsx',
    '.css': 'css',
    '.svg': 'text',
  },
};
