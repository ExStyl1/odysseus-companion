#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { automationPaths } from './automations/config.mjs';
import { createAutomationRuntime } from './automations/runtime.mjs';
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.env.ODYSSEUS_ROOT || resolve(import.meta.dirname, '..');
  let runtime;
  try {
    runtime = await createAutomationRuntime(automationPaths(root));
    if (process.argv[2] === 'start') { await runtime.start(); console.log('n8n: ' + runtime.status().engine.editorUrl); }
    const stop = async () => { await runtime.close(); process.exit(0); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop); process.once('disconnect', stop);
    process.on('message', async message => {
      try { const result = await runtime.dispatch(message.mode, message.input); process.send?.({ id: message.id, result }); }
      catch (error) { process.send?.({ id: message.id, error: String(error.message).slice(0, 300) }); }
    });
    process.send?.({ ready: true });
  } catch (error) {
    await runtime?.close(); process.send?.({ fatal: 'Не удалось запустить локальный мост n8n: проверьте, свободен ли порт 5789.' });
    console.error('Локальный сервис n8n не запущен:', error.code || error.message); process.exitCode = 1;
  }
}
