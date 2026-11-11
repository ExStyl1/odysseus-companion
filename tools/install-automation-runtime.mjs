#!/usr/bin/env node
/** Reproducible local engine install; no global npm packages and no user data migration. */
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, cpSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { N8N_VERSION } from './automations/config.mjs';
const root = resolve(import.meta.dirname, '..'), runtime = join(root, '.odysseus/n8n-runtime'), source = join(root, 'integrations/n8n');
if (existsSync(join(runtime, 'node_modules/n8n/package.json')) && JSON.parse(readFileSync(join(runtime, 'node_modules/n8n/package.json'))).version === N8N_VERSION && existsSync(join(runtime, 'package-lock.json')) && readFileSync(join(runtime, 'package-lock.json')).equals(readFileSync(join(source, 'package-lock.json')))) {
  console.log('Локальный n8n ' + N8N_VERSION + ' уже установлен.');
} else {
  const stage = join(root, '.odysseus/n8n-stage-' + randomUUID()); mkdirSync(stage, { recursive: true });
  try {
    for (const name of ['package.json', 'package-lock.json']) cpSync(join(source, name), join(stage, name));
    const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit', shell: false });
    if (result.error || result.status !== 0) throw Error('Не удалось установить n8n по lock-файлу');
    if (JSON.parse(readFileSync(join(stage, 'node_modules/n8n/package.json'))).version !== N8N_VERSION) throw Error('Неверная версия движка n8n');
    const previous = runtime + '-previous';
    if (existsSync(previous)) throw Error('Предыдущая установка n8n требует проверки: ' + previous);
    if (existsSync(runtime)) renameSync(runtime, previous);
    try { renameSync(stage, runtime); } catch (error) { if (existsSync(previous)) renameSync(previous, runtime); throw error; }
    rmSync(previous, { recursive: true, force: true });
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
