/** Start the knowledge watcher with the desktop PID as its lease owner, using bundled Node. */
import { existsSync } from 'node:fs';
import { runtimePaths, startWatcher, processIsAlive } from '../graphify.mjs';
const parent = Number(process.argv[2]),
  root = process.env.ODYSSEUS_ROOT;
if (!root || !Number.isSafeInteger(parent) || parent <= 0 || !processIsAlive(parent))
  process.exit(1);
const paths = runtimePaths(root);
if (existsSync(paths.python)) startWatcher(paths, parent);
