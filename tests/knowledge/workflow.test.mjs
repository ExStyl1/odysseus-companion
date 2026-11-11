import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runtimePaths, registerProject } from '../../tools/graphify.mjs';
import { graphContext, recordCompletion } from '../../tools/knowledge/workflow.mjs';
import { hookResult } from '../../tools/knowledge-workflow.mjs';
import { writeProjectMarkdown } from '../../tools/knowledge/markdown.mjs';
import { installKnowledgeHooks } from '../../tools/setup/knowledge-hooks.mjs';
function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'odysseus-workflow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'service'); mkdirSync(project);
  writeFileSync(join(project, 'api.ts'), 'export const endpoint = "/health"');
  writeFileSync(join(project, 'AGENTS.md'), 'Run the actual tests.');
  const paths = runtimePaths(root, {});
  return { root, project, paths };
}
const put = (file, value) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(value)); };

test('a new working folder is registered, gets Markdown and queues its own graph before the first task', t => {
  const f = fixture(t);
  const output = hookResult(f.paths, 'before', { cwd: f.project, prompt: 'Сделай автотест на этот сервис' });
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /not_indexed/);
  assert.match(context, /исследуй текущую папку/);
  assert.match(context, /RULES.md/);
  const records = readdirSync(f.paths.registry);
  assert.equal(records.length, 1);
  const id = records[0].replace('.json', '');
  assert.ok(existsSync(join(f.paths.runtime, 'workflow-queue', id + '.json')));
  for (const file of ['README.md', 'SUMMARY.md', 'RULES.md']) assert.ok(existsSync(join(f.project, '.odysseus/knowledge', file)));
});

test('pre-query uses only the exact working project and handles a ready graph with no matches', t => {
  const f = fixture(t), project = registerProject(f.paths, f.project);
  put(join(f.paths.output, 'graph.json'), { nodes: [
    { id: 'project:' + project.id, type: 'project', source_file: f.project },
    { id: 'api', type: 'file', label: 'Health API service', source_file: join(f.project, 'api.ts'), project_id: project.id },
    { id: 'foreign', type: 'file', label: 'Health API PRIVATE OTHER PROJECT', project_id: 'other' },
  ], links: [] });
  put(join(f.paths.output, 'projects', project.id, 'engine/graphify-out/graph.json'), { nodes: [], links: [] });
  const result = graphContext(f.paths, f.project, 'Health API');
  assert.equal(result.facts.graphReady, true);
  assert.equal(result.facts.status, 'matches');
  assert.equal(result.facts.matches[0].id, 'api');
  assert.ok(!JSON.stringify(result.facts).includes('PRIVATE OTHER PROJECT'));
  assert.equal(graphContext(f.paths, f.project, 'unrelateduniqueterm').facts.status, 'no_matches');
});

test('completion stores cited results and queues refresh, rejecting outside-project evidence', t => {
  const f = fixture(t);
  const input = { cwd: f.project, summary: 'Добавлен тест /health', sources: ['api.ts'], checks: ['unit test: passed (reported)'] };
  const result = recordCompletion(f.paths, input);
  const project = registerProject(f.paths, f.project);
  assert.equal(result.refresh, 'queued');
  const dir = join(f.paths.output, 'projects', project.id, 'workflow-results');
  const data = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0])));
  assert.equal(data.provenance, 'agent_reported');
  assert.match(data.text, /сообщены агентом/);
  writeFileSync(join(f.root, 'outside'), 'external');
  assert.throws(() => recordCompletion(f.paths, { ...input, sources: ['../outside'] }), /за пределами/);
  assert.throws(() => recordCompletion(f.paths, { ...input, sources: [] }), /хотя бы один/);
});

test('Stop saves a bounded, redacted summary without blocking or asking the model to loop', t => {
  const f = fixture(t);
  const result = hookResult(f.paths, 'after', { cwd: f.project, last_assistant_message: 'Тест готов. Bearer private-value\n```secret code```' });
  assert.deepEqual(result, {});
  const summary = readFileSync(join(f.project, '.odysseus/knowledge/SUMMARY.md'), 'utf8');
  assert.match(summary, /Тест готов/);
  assert.ok(!summary.includes('private-value'));
  assert.ok(!summary.includes('secret code'));
  assert.match(summary, /не проверено автоматически/);
});

test('Markdown updates preserve user rules and do not follow document-directory symlinks', t => {
  const f = fixture(t), project = registerProject(f.paths, f.project);
  writeProjectMarkdown(f.paths, project);
  const rules = join(f.project, '.odysseus/knowledge/RULES.md');
  writeFileSync(rules, '# My rule: test with Playwright');
  writeProjectMarkdown(f.paths, project);
  assert.equal(readFileSync(rules, 'utf8'), '# My rule: test with Playwright');
  assert.ok(existsSync(rules.replace('.md', '.generated.md')));
  rmSync(join(f.project, '.odysseus/knowledge'), { recursive: true });
  mkdirSync(join(f.root, 'outside'));
  symlinkSync(join(f.root, 'outside'), join(f.project, '.odysseus/knowledge'));
  assert.throws(() => writeProjectMarkdown(f.paths, project), /link/i);
  assert.equal(readdirSync(join(f.root, 'outside')).length, 0);
});

test('hook installation is idempotent and preserves unrelated hooks and the global opt-out', t => {
  const f = fixture(t), profiles = { cliHome: join(f.root, 'cli'), desktopHome: join(f.root, 'desktop') };
  writeFileSync(join(f.root, 'tools-placeholder'), '');
  mkdirSync(join(f.root, 'tools'));
  writeFileSync(join(f.root, 'tools/knowledge-workflow.mjs'), '');
  const custom = { hooks: [{ type: 'command', command: 'echo user-custom' }] };
  put(join(profiles.cliHome, 'settings.json'), { ui: { theme: 'custom' }, hooks: { UserPromptSubmit: [custom] }, disableAllHooks: true });
  put(join(profiles.desktopHome, 'hooks.json'), { hooks: { Stop: [custom] }, disableAllHooks: true });
  installKnowledgeHooks(f.root, profiles, process.execPath);
  const once = readFileSync(join(profiles.cliHome, 'settings.json'), 'utf8');
  installKnowledgeHooks(f.root, profiles, process.execPath);
  assert.equal(readFileSync(join(profiles.cliHome, 'settings.json'), 'utf8'), once);
  const cli = JSON.parse(once);
  assert.equal(cli.disableAllHooks, true);
  assert.equal(cli.ui.theme, 'custom');
  assert.equal(cli.hooks.UserPromptSubmit.length, 2);
  assert.equal(cli.hooks.Stop.length, 1);
  assert.deepEqual(cli.hooks.UserPromptSubmit[1], custom);
});

test('Desktop legacy automations and bare event maps keep their existing hooks active', t => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'tools')); writeFileSync(join(f.root, 'tools/knowledge-workflow.mjs'), '');
  const profiles = { cliHome: join(f.root, 'cli'), desktopHome: join(f.root, 'desktop') };
  const custom = { hooks: [{ type: 'command', command: 'echo custom' }] };
  for (const shape of [{ automations: { Stop: [custom] } }, { Stop: [custom] }]) {
    put(join(profiles.desktopHome, 'hooks.json'), shape);
    installKnowledgeHooks(f.root, profiles, process.execPath);
    const result = JSON.parse(readFileSync(join(profiles.desktopHome, 'hooks.json')));
    assert.equal(result.hooks, undefined);
    const active = result.automations || result;
    assert.equal(active.Stop[0].hooks[0].command, 'echo custom');
    assert.equal(active.Stop.length, 2);
    assert.equal(active.UserPromptSubmit.length, 1);
  }
});
