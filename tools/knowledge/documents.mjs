/** Read only evidence files belonging to a visible graph node or relation. */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute, extname } from 'node:path';
import { graphData } from './graph-store.mjs';
import { collectionState, filterCollection } from './collections.mjs';
const read = (path, fallback) =>
  existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
export function readKnowledgeDocument(paths, options = {}) {
  const all = graphData(paths).graph,
    graph = filterCollection(
      all,
      collectionState(paths, all),
      options.collection || paths.env?.ODYSSEUS_KNOWLEDGE_COLLECTION || 'projects',
    ),
    node = graph.nodes.find((n) => n.id === options.nodeId);
  if (!node) throw Error('Узел не найден');
  const allowed = new Set(
    [
      node.source_file,
      ...graph.links
        .filter((e) => e.source === node.id || e.target === node.id)
        .map((e) => e.source_file),
    ].filter(Boolean),
  );
  if (typeof options.path !== 'string' || !allowed.has(options.path))
    throw Error('Файл не является источником этого узла или связи');
  const vault = read(join(paths.runtime, 'vault-selection.json'), {}).path || paths.root;
  const path = realpathSync(isAbsolute(options.path) ? options.path : resolve(vault, options.path));
  const stat = statSync(path);
  if (!stat.isFile()) throw Error('Это папка: раскройте её в каталоге');
  const extension = extname(path).toLowerCase(),
    textTypes = new Set([
      '.md',
      '.txt',
      '.json',
      '.yaml',
      '.yml',
      '.toml',
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
      '.py',
      '.go',
      '.rs',
      '.java',
      '.kt',
      '.cs',
      '.rb',
      '.swift',
      '.c',
      '.h',
      '.cpp',
      '.php',
      '.sql',
      '.graphql',
      '.proto',
      '.html',
      '.css',
      '.xml',
      '.csv',
      '.sh',
    ]);
  if (stat.size > 2 * 1024 * 1024 || !textTypes.has(extension))
    return { path, binary: true, content: '', truncated: false };
  const content = readFileSync(path, 'utf8');
  if (content.includes('\0')) return { path, binary: true, content: '', truncated: false };
  return {
    path,
    content: content.slice(0, 200000),
    truncated: content.length > 200000,
    markdown: extension === '.md',
    binary: false,
  };
}
