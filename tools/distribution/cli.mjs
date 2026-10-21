#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { prepareDistribution } from './prepare.mjs';
const payload = resolve(import.meta.dirname, '../..');
const env = { ...process.env, ...prepareDistribution(payload), ODYSSEUS_PROJECT: process.cwd() };
const child = spawn(
  env.ODYSSEUS_NODE,
  [join(env.ODYSSEUS_ROOT, 'tools/run-component.mjs'), 'cli', ...process.argv.slice(2)],
  { env, stdio: 'inherit' },
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
