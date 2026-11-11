#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { prepareDistribution } from './prepare.mjs';
import { maintenance } from './maintenance.mjs';
const payload = resolve(import.meta.dirname, '../..');
try {
  if (process.argv[2] === 'maintenance') {
    console.log(JSON.stringify(maintenance(process.argv.slice(3)), null, 2));
  } else {
    const env = { ...process.env, ...prepareDistribution(payload, { owner: process.pid }), ODYSSEUS_PROJECT: process.cwd() };
    const releaseLease = () => { try { unlinkSync(env.ODYSSEUS_RUN_LEASE); } catch {} };
    process.once('exit', releaseLease);
    const args = process.argv[2] === 'n8n'
      ? [join(env.ODYSSEUS_ROOT, 'tools/automation-service.mjs'), 'start']
      : [join(env.ODYSSEUS_ROOT, 'tools/run-component.mjs'), 'cli', ...process.argv.slice(2)];
    const child = spawn(env.ODYSSEUS_NODE, args, { env, stdio: 'inherit' });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  }
} catch (error) {
  console.error('Odysseus: ' + error.message);
  process.exitCode = 1;
}
