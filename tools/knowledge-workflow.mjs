#!/usr/bin/env node
/** Same JSON hook protocol for Desktop and CLI; indexing stays outside the UI. */
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, openSync, closeSync, unlinkSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { runtimePaths, refresh, processIsAlive } from './graphify.mjs';
import { graphContext, workflowInstructions, queueProjectRefresh, workingProject, recordCompletion, recordAgentSummary } from './knowledge/workflow.mjs';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (file, fallback = {}) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback;
    throw error;
  }
};
export function startWorkflowWorker(paths, node = process.execPath) {
  if (processIsAlive(read(join(paths.runtime, 'workflow-worker.json')).pid)) return;
  const child = spawn(node, [join(paths.root, 'tools/knowledge-workflow.mjs'), 'worker'], {
    detached: true, stdio: 'ignore', env: { ...process.env, ODYSSEUS_ROOT: paths.root },
  });
  child.on('error', () => {});
  child.unref();
}
export function hookResult(paths, event, input, node = process.execPath) {
  if (event === 'before') {
    const { project, facts } = graphContext(paths, input.cwd, input.prompt || '');
    if (!facts.graphReady) queueProjectRefresh(paths, project);
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: workflowInstructions(facts, paths.root, node) } };
  }
  if (event === 'after') {
    recordAgentSummary(paths, input.cwd, input.last_assistant_message);
    queueProjectRefresh(paths, workingProject(paths, input.cwd));
    // Never block Stop or ask the model to continue: that would create a loop.
    return {};
  }
  throw Error('Unknown hook event');
}
async function worker(paths) {
  mkdirSync(paths.runtime, { recursive: true, mode: 0o700 });
  const lock = join(paths.runtime, 'workflow-worker.json');
  if (existsSync(lock)) {
    if (processIsAlive(read(lock).pid)) return;
    unlinkSync(lock);
  }
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') return; throw error; }
  writeFileSync(fd, JSON.stringify({ pid: process.pid })); closeSync(fd);
  try {
    const queue = join(paths.runtime, 'workflow-queue');
    const deadline = Date.now() + 12 * 60_000;
    while (existsSync(queue) && Date.now() < deadline) {
      const next = readdirSync(queue).filter(name => /^[a-f0-9]{16}\.json$/.test(name)).sort()[0];
      if (!next) break;
      const file = join(queue, next), request = read(file);
      const active = read(join(paths.runtime, 'refresh.pid')).pid;
      if (processIsAlive(active)) { await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
      try {
        const registered = workingProject(paths, request.project);
        if (registered.id !== request.id || next !== registered.id + '.json') throw Error('Invalid project refresh request');
        refresh(paths, { projects: true, quiet: true, projectPath: request.project });
        const status = { project: request.project, at: new Date().toISOString(), ...read(join(paths.output, 'projects', request.id, 'error.json')) };
        writeFileSync(join(paths.runtime, 'workflow-last-result.json'), JSON.stringify(status), { mode: 0o600 });
        if (read(file).requestId === request.requestId) unlinkSync(file);
      } catch (error) {
        appendFileSync(join(paths.runtime, 'workflow-errors.log'), new Date().toISOString() + ' ' + error.message + '\n', { mode: 0o600 });
        break; // Leave the request queued for the next hook/startup; do not spin.
      }
    }
  } finally { if (read(lock).pid === process.pid) unlinkSync(lock); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const paths = runtimePaths(process.env.ODYSSEUS_ROOT || root);
  const mode = process.argv[2];
  if (mode === 'worker') await worker(paths);
  else if (mode === 'complete') {
    const result = recordCompletion(paths, JSON.parse(process.argv[3] || '{}'));
    startWorkflowWorker(paths);
    console.log(JSON.stringify(result));
  } else if (mode === 'status') {
    console.log(JSON.stringify({ pending: existsSync(join(paths.runtime, 'workflow-queue')) ? readdirSync(join(paths.runtime, 'workflow-queue')).length : 0, last: read(join(paths.runtime, 'workflow-last-result.json'), null) }));
  } else {
    try {
      const data = readFileSync(0, 'utf8');
      if (data.length > 512000) throw Error('Hook input is too large');
      const result = hookResult(paths, mode, JSON.parse(data));
      startWorkflowWorker(paths);
      console.log(JSON.stringify(result));
    } catch (error) {
      // Knowledge failure never prevents the user's task or discards a prompt.
      console.log(JSON.stringify(mode === 'before' ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'База знаний сейчас недоступна. Исследуй текущую папку и проверь исходники; не выдавай данные графа за актуальные. После работы сообщи о недоступном обновлении.' } } : {}));
    }
  }
}
