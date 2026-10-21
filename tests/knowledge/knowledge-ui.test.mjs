import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  projectView,
  editKnowledge,
  applyOverlay,
  snapshot,
  readKnowledgeDocument,
} from '../../tools/knowledge-ui.mjs';
const base = {
  nodes: [
    { id: 'p1', type: 'project', label: 'One' },
    { id: 'p2', type: 'project', label: 'Two' },
    { id: 'dep', type: 'dependency', label: 'Shared' },
    { id: 'f', type: 'file', label: 'rare.ts' },
  ],
  links: [
    { source: 'p1', target: 'dep' },
    { source: 'p2', target: 'dep' },
    { source: 'p1', target: 'f', relation: 'contains' },
  ],
};
test('overview shows shared bridges; full search and exploration reach files', () => {
  assert.deepEqual(
    projectView(base).nodes.map((n) => n.id),
    ['p1', 'p2'],
  );
  assert.equal(projectView(base, { query: 'rare' }).nodes[0].id, 'f');
  assert.ok(projectView(base, { focus: 'p1' }).nodes.some((n) => n.id === 'f'));
  const huge = {
    nodes: Array.from({ length: 400 }, (_, i) => ({
      id: String(i),
      label: 'File ' + i,
    })),
    links: [],
  };
  assert.equal(projectView(huge, { query: 'File' }).nodes.length, 100);
  assert.equal(projectView(huge, { query: 'File', offset: 300 }).nodes.length, 100);
});
test('manual changes are persistent, validated, backed up and independently removable', (t) => {
  const output = mkdtempSync(join(tmpdir(), 'knowledge-edits-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  writeFileSync(join(output, 'graph.json'), JSON.stringify(base));
  editKnowledge(output, {
    type: 'add-note',
    label: 'Contract',
    description: 'Source: ADR-1',
  });
  let overlay = JSON.parse(readFileSync(join(output, 'overlay.json')));
  const id = overlay.nodes[0].id;
  editKnowledge(output, {
    type: 'update-manual',
    id,
    label: 'Updated contract',
  });
  assert.equal(
    JSON.parse(readFileSync(join(output, 'overlay.json'))).nodes[0].label,
    'Updated contract',
  );
  editKnowledge(output, {
    type: 'add-link',
    source: 'p1',
    target: id,
    relation: 'implements',
    evidence: 'ADR-1',
  });
  overlay = JSON.parse(readFileSync(join(output, 'overlay.json')));
  assert.equal(applyOverlay(base, overlay).links.at(-1).confidence, 'USER_RECORDED');
  assert.throws(
    () =>
      editKnowledge(output, {
        type: 'add-link',
        source: 'p1',
        target: 'absent',
        relation: 'calls',
        evidence: 'none',
      }),
    /существующих/,
  );
  assert.throws(() => editKnowledge(output, { type: 'remove-manual', id: 'p1' }), /ручные/);
  editKnowledge(output, { type: 'remove-manual', id });
  overlay = JSON.parse(readFileSync(join(output, 'overlay.json')));
  assert.equal(overlay.nodes.length, 0);
  assert.equal(overlay.links.length, 0);
  assert.equal(JSON.parse(readFileSync(join(output, 'overlay-history/1.json'))).nodes.length, 1);
});

test('folders only show immediate children; cross-project neighbors need relationships mode', () => {
  const graph = {
    nodes: [
      ...base.nodes,
      { id: 'dir', label: 'src', type: 'folder', project_id: 'p1' },
      { id: 'nested', label: 'deep.ts', type: 'file' },
    ],
    links: [
      ...base.links,
      { source: 'p1', target: 'dir', relation: 'contains' },
      { source: 'dir', target: 'nested', relation: 'contains' },
    ],
  };
  const project = projectView(graph, { focus: 'p1' });
  assert.deepEqual(
    project.nodes.map((n) => n.id),
    ['p1', 'dir', 'f'],
  );
  assert.equal(project.scopeProject, 'p1');
  const folder = projectView(graph, { focus: 'dir' });
  assert.deepEqual(
    folder.nodes.map((n) => n.id),
    ['dir', 'nested'],
  );
  assert.deepEqual(
    folder.breadcrumbs.map((n) => n.id),
    ['p1', 'dir'],
  );
  assert.ok(projectView(graph, { focus: 'p1', view: 'links' }).nodes.some((n) => n.id === 'dep'));
  assert.equal(projectView(graph, { focus: 'p2', query: 'deep' }).totalMatches, 0);
});
test('snapshots invalidate cached data without restarting and only read graph evidence', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-reader-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'note.md');
  writeFileSync(path, '# Evidence\nA fact');
  const paths = { output: root, runtime: root, root };
  writeFileSync(
    join(root, 'graph.json'),
    JSON.stringify({
      nodes: [
        { id: 'p1', label: 'Project', type: 'project' },
        {
          id: 'n',
          label: 'Evidence',
          type: 'document',
          source_file: path,
          project_id: 'p1',
        },
      ],
      links: [],
    }),
  );
  const first = snapshot(paths, { query: 'Evidence' });
  assert.equal(snapshot(paths, { query: 'Evidence', version: first.version }).unchanged, true);
  assert.equal(readKnowledgeDocument(paths, { nodeId: 'n', path }).markdown, true);
  assert.throws(
    () =>
      readKnowledgeDocument(paths, {
        nodeId: 'n',
        path: join(root, 'other.md'),
      }),
    /источником/,
  );
  editKnowledge(root, {
    type: 'add-note',
    label: 'Updated',
    description: 'User fact',
  });
  assert.notEqual(snapshot(paths, { query: 'Evidence' }).version, first.version);
  assert.equal(snapshot(paths, { query: 'Updated' }).nodes[0].label, 'Updated');
});
test('one live worker sees edits immediately and keeps notes inside their project', async (t) => {
  const { fork } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'knowledge-service-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'graph.json'), JSON.stringify(base));
  const child = fork(new URL('../../tools/knowledge-ui.mjs', import.meta.url), ['service'], {
    env: { ...process.env, ODYSSEUS_KNOWLEDGE_DIR: root },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  t.after(() => child.kill());
  let id = 0;
  const request = (mode, options) =>
    new Promise((resolve, reject) => {
      const number = ++id;
      const timer = setTimeout(() => reject(Error('Worker timeout')), 5000);
      const listener = (message) => {
        if (message.id !== number) return;
        clearTimeout(timer);
        child.off('message', listener);
        message.error ? reject(Error(message.error)) : resolve(message.result);
      };
      child.on('message', listener);
      child.send({ id: number, mode, options });
    });
  const before = await request('snapshot', { focus: 'p1' });
  await request('edit', {
    type: 'add-note',
    label: 'Project-only fact',
    description: 'ADR-2',
    parent: 'p1',
  });
  const after = await request('snapshot', {
    focus: 'p1',
    version: before.version,
  });
  assert.notEqual(after.unchanged, true);
  assert.ok(after.nodes.some((n) => n.label === 'Project-only fact'));
  assert.equal(
    (await request('snapshot', { focus: 'p2' })).nodes.some((n) => n.label === 'Project-only fact'),
    false,
  );
});
