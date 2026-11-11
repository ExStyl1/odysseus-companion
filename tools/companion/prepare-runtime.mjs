import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { copyDataTree } from '../distribution/bundle.mjs';
import { stagePython } from '../distribution/python.mjs';

export function prepareRuntime(root, payload) {
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

  mkdirSync(dirname(payload), { recursive: true });
  const staging = mkdtempSync(join(dirname(payload), 'companion-runtime-'));
  try {
    stagePython({ root, payload: staging, copy, run, uv });
    rmSync(payload, { recursive: true, force: true });
    renameSync(staging, payload);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
