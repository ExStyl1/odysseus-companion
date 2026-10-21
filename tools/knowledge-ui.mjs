#!/usr/bin/env node
/** Small graph projections run outside Electron; manual facts survive re-indexing. */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import {
  collectionState,
  filterCollection,
  manageCollection,
  writeCollectionGraphs,
  ensureCollectionSource,
} from './knowledge/collections.mjs';
import { runtimePaths } from './graphify.mjs';
import { editKnowledge } from './knowledge/overlay.mjs';
import { projectView } from './knowledge/view.mjs';
import { graphData } from './knowledge/graph-store.mjs';
import { readKnowledgeDocument } from './knowledge/documents.mjs';
export { applyOverlay, editKnowledge } from './knowledge/overlay.mjs';
export { projectView } from './knowledge/view.mjs';
export { readKnowledgeDocument } from './knowledge/documents.mjs';
const read = (path, fallback) =>
  existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
export function snapshot(paths, options = {}) {
  const file = join(paths.output, 'graph.json');
  if (!existsSync(file))
    return {
      ready: false,
      projects: [],
      nodes: [],
      links: [],
      totalNodes: 0,
      totalLinks: 0,
      totalMatches: 0,
      offset: 0,
      limit: 160,
      hiddenLinks: 0,
    };
  const { signature, graph: all } = graphData(paths),
    state = collectionState(paths, all),
    collection = options.collection || paths.env?.ODYSSEUS_KNOWLEDGE_COLLECTION || 'projects',
    graph = filterCollection(all, state, collection),
    viewKey = JSON.stringify([
      signature,
      collection,
      createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 16),
      options.focus || '',
      options.query || '',
      options.offset || 0,
      options.view || 'catalog',
      options.project || '',
    ]);
  if (options.version === viewKey) return { unchanged: true, version: viewKey };
  return {
    ...projectView(graph, options),
    scopeCollection: collection,
    collections: state.collections.map((c) => ({
      ...c,
      count:
        c.id === 'notes'
          ? all.nodes.filter((n) => n.type === 'note').length
          : Object.values(state.assignments).filter((id) => id === c.id).length,
    })),
    allProjects: all.nodes
      .filter((n) => n.type === 'project')
      .map((n) => ({
        id: n.id,
        label: n.label,
        collectionId: state.assignments[n.id],
      })),
    version: viewKey,
    overlayRevision: read(join(paths.output, 'overlay.json'), {}).revision || 0,
    lastError: read(join(paths.runtime, 'last-error.json'), null),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const paths = runtimePaths(),
    [mode, arg = '{}'] = process.argv.slice(2);
  if (mode === 'service') {
    process.on('message', (message) => {
      try {
        const result =
          message.mode === 'agent-source'
            ? ensureCollectionSource(
                paths,
                graphData(paths).graph,
                message.options.collection,
                message.options.workspaceRoot,
              )
            : message.mode === 'catalogs'
              ? manageCollection(paths, graphData(paths).graph, message.options)
              : message.mode === 'prepare-scopes'
                ? writeCollectionGraphs(paths, graphData(paths).graph)
                : message.mode === 'document'
                  ? readKnowledgeDocument(paths, message.options)
                  : message.mode === 'edit'
                    ? editKnowledge(paths.output, message.options)
                    : snapshot(paths, message.options);
        process.send?.({ id: message.id, result });
      } catch (e) {
        process.send?.({ id: message.id, error: e.message });
      }
    });
    process.on('disconnect', () => process.exit(0));
  } else
    try {
      const options = JSON.parse(arg);
      console.log(
        JSON.stringify(
          mode === 'prepare-scopes'
            ? writeCollectionGraphs(paths, graphData(paths).graph)
            : mode === 'catalogs'
              ? manageCollection(paths, graphData(paths).graph, options)
              : mode === 'edit'
                ? editKnowledge(paths.output, options)
                : mode === 'document'
                  ? readKnowledgeDocument(paths, options)
                  : snapshot(paths, options),
        ),
      );
    } catch (e) {
      console.error(e.message);
      process.exitCode = 1;
    }
}
