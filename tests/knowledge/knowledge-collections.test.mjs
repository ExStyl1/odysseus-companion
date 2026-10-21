import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectionState,
  filterCollection,
  manageCollection,
  ensureCollectionSource,
  collectionForPath,
} from '../../tools/knowledge/collections.mjs';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-catalog-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'knowledge');
  mkdirSync(output);
  writeFileSync(
    join(root, 'odysseus.json'),
    JSON.stringify({ components: { cli: { source: 'cli' } } }),
  );
  const paths = { root, output };
  const graph = {
    nodes: [
      {
        id: 'a',
        type: 'project',
        label: 'Odysseus CLI',
        source_file: join(root, 'cli'),
      },
      {
        id: 'b',
        type: 'project',
        label: 'Future app',
        source_file: join(root, 'future'),
      },
      { id: 'af', label: 'Internal code', project_id: 'a' },
      { id: 'bf', label: 'User code', project_id: 'b' },
      { id: 'dep', label: 'React', type: 'dependency' },
      { id: 'note', label: 'Vault note', type: 'note' },
    ],
    links: [
      { source: 'a', target: 'af', relation: 'contains' },
      { source: 'b', target: 'bf', relation: 'contains' },
      { source: 'a', target: 'dep' },
      { source: 'b', target: 'dep' },
    ],
  };
  return { paths, graph };
}
test('Odysseus, user projects and vault notes have separate default catalogs', (t) => {
  const { paths, graph } = fixture(t),
    state = collectionState(paths, graph);
  assert.equal(state.assignments.a, 'odysseus');
  assert.equal(state.assignments.b, 'projects');
  const user = filterCollection(graph, state, 'projects');
  assert.deepEqual(
    user.nodes.map((n) => n.id),
    ['b', 'bf', 'dep'],
  );
  assert.equal(
    user.links.some((e) => e.source === 'a'),
    false,
  );
  assert.deepEqual(
    filterCollection(graph, state, 'notes').nodes.map((n) => n.id),
    ['note'],
  );
  assert.equal(collectionForPath(paths, join(paths.root, 'cli')), 'odysseus');
});
test('moving a project persists isolation and writes an independently queryable graph', (t) => {
  const { paths, graph } = fixture(t),
    created = manageCollection(paths, graph, {
      type: 'create',
      name: 'Customer A',
    });
  manageCollection(paths, graph, {
    type: 'move-project',
    projectId: 'b',
    collectionId: created.createdId,
  });
  const state = collectionState(paths, graph);
  assert.equal(filterCollection(graph, state, 'projects').nodes.length, 0);
  const saved = JSON.parse(
    readFileSync(join(paths.output, 'collections', created.createdId, 'graphify-out/graph.json')),
  );
  assert.ok(saved.nodes.some((n) => n.id === 'b'));
  assert.ok(!saved.nodes.some((n) => n.id === 'a'));
  assert.throws(
    () => manageCollection(paths, graph, { type: 'create', name: 'Customer A' }),
    /существует/,
  );
  assert.throws(() => filterCollection(graph, state, 'absent'), /не найден/);
});
test('each catalog agent gets a scoped MCP source and disabled sources stay disabled', (t) => {
  const { paths, graph } = fixture(t),
    workspace = join(paths.root, 'workspace');
  const a = ensureCollectionSource(paths, graph, 'odysseus', workspace),
    b = ensureCollectionSource(paths, graph, 'projects', workspace);
  assert.notEqual(a.slug, b.slug);
  const file = join(workspace, 'sources', a.slug, 'config.json'),
    config = JSON.parse(readFileSync(file));
  assert.deepEqual(config.mcp.args.slice(-2), ['--collection', 'odysseus']);
  config.enabled = false;
  writeFileSync(file, JSON.stringify(config));
  assert.throws(() => ensureCollectionSource(paths, graph, 'odysseus', workspace), /Включите/);
});
