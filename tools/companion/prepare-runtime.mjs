import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { copyDataTree } from '../distribution/bundle.mjs';
import { stagePython } from '../distribution/python.mjs';

export function prepareRuntime(root, payload) {
  const cli = join(root, 'nessy-cli-master');
  const uv = process.env.ODYSSEUS_UV || 'uv';
  function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error(`Не удалось выполнить ${command} ${args[0]}`);
  }
  function copy(source, target) {
    mkdirSync(dirname(target), { recursive: true });
    copyDataTree(source, target);
  }

  run(process.execPath, ['scripts/build.js', '--cli-only', '--web-shell'], cli);
  run(process.execPath, ['esbuild.config.js'], cli);
  run(process.execPath, ['scripts/copy_bundle_assets.js'], cli);
  mkdirSync(dirname(payload), { recursive: true });
  const staging = mkdtempSync(join(dirname(payload), 'companion-runtime-'));
  try {
    copy(join(cli, 'dist'), join(staging, 'cli/dist'));
    writeFileSync(join(staging, 'cli/package.json'), JSON.stringify({ type: 'module' }));
    for (const name of [
      '@lydell/node-pty', `@lydell/node-pty-darwin-${process.arch}`,
      '@teddyzhu/clipboard', `@teddyzhu/clipboard-darwin-${process.arch}`,
      '@nestor/nessy-cli-audio-capture', 'node-gyp-build',
    ]) {
      copy(join(cli, 'node_modules', name), join(staging, 'cli/node_modules', name));
    }
    stagePython({ root, payload: staging, copy, run, uv });
    rmSync(payload, { recursive: true, force: true });
    renameSync(staging, payload);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
