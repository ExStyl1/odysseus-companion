/** Manual knowledge and annotations, independent of UI transport. */
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { noLinks } from '../personal/store.mjs';
import { randomUUID } from 'node:crypto';
import { collectionState, filterCollection } from './collections.mjs';
import { runtimePaths } from '../graphify.mjs';
const read = (path, fallback) =>
  existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
export function applyOverlay(graph, overlay = {}) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, { ...n, ...overlay.annotations?.[n.id] }]));
  for (const node of overlay.nodes || [])
    nodes.set(node.id, { ...node, type: 'knowledge', manual: true });
  const links = [...(graph.links || graph.edges || []), ...(overlay.links || [])].filter(
    (e) => nodes.has(e.source) && nodes.has(e.target),
  );
  return { nodes: [...nodes.values()], links };
}
export function editKnowledge(output, operation) {
  if (!operation || typeof operation !== 'object') throw Error('Ожидается операция JSON');
  mkdirSync(output, { recursive: true });
  const lock = join(output, 'overlay.lock');
  if (existsSync(lock)) {
    const owner = read(lock, {});
    try {
      process.kill(owner.pid, 0);
    } catch (e) {
      if (e.code === 'ESRCH') unlinkSync(lock);
      else throw e;
    }
  }
  const fd = openSync(lock, 'wx', 0o600);
  writeFileSync(fd, JSON.stringify({ pid: process.pid }));
  try {
    const file = join(output, 'overlay.json'),
      overlay = read(file, { nodes: [], links: [], revision: 0 });
    const text = (value, max = 2000) => {
      if (typeof value !== 'string' || !value.trim() || value.length > max)
        throw Error('Некорректный текст');
      return value.trim();
    };
    if (operation.type === 'add-note') {
      const node = {
        id: 'manual:' + randomUUID(),
        label: text(operation.label, 160),
        description: text(operation.description),
        ...(operation.collection ? { collection: operation.collection } : {}),
        createdAt: new Date().toISOString(),
      };
      if (operation.documentPath) {
        noLinks(operation.documentPath);
        const source = realpathSync(operation.documentPath);
        const rel = relative(join(output, 'manual-documents'), source);
        if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw Error('Источник ручной заметки вне папки документов');
        node.source_file = source;
      }
      if (operation.parent) {
        const graph = applyOverlay(
            read(join(output, 'graph.json'), { nodes: [], links: [] }),
            overlay,
          ),
          parent = graph.nodes.find((n) => n.id === operation.parent);
        if (!parent || !['project', 'folder'].includes(parent.type))
          throw Error('Родитель должен быть проектом или папкой');
        node.project_id =
          parent.type === 'project' ? parent.id.replace(/^project:/, '') : parent.project_id;
        overlay.links.push({
          id: 'manual:' + randomUUID(),
          source: parent.id,
          target: node.id,
          relation: 'contains',
          confidence: 'USER_RECORDED',
          manual: true,
          source_file: file,
        });
      }
      overlay.nodes.push(node);
    } else if (operation.type === 'add-link') {
      let graph = applyOverlay(read(join(output, 'graph.json'), { nodes: [], links: [] }), overlay);
      if (operation.collection)
        graph = filterCollection(
          graph,
          collectionState({ ...runtimePaths(), output }, graph),
          operation.collection,
        );
      const ids = new Set(graph.nodes.map((n) => n.id));
      if (
        !ids.has(operation.source) ||
        !ids.has(operation.target) ||
        operation.source === operation.target
      )
        throw Error('Выберите два существующих разных узла');
      const relation = text(operation.relation, 160),
        evidence = text(operation.evidence);
      if (
        overlay.links.some(
          (e) =>
            e.source === operation.source &&
            e.target === operation.target &&
            e.relation === relation,
        )
      )
        throw Error('Эта ручная связь уже существует');
      overlay.links.push({
        id: 'manual:' + randomUUID(),
        source: operation.source,
        target: operation.target,
        relation,
        description: evidence,
        source_file: file,
        confidence: 'USER_RECORDED',
        manual: true,
      });
    } else if (operation.type === 'update-manual') {
      const entry =
        overlay.nodes.find((n) => n.id === operation.id) ||
        overlay.links.find((e) => e.id === operation.id);
      if (!entry) throw Error('Ручная запись не найдена');
      if (operation.label !== undefined) entry.label = text(operation.label, 160);
      if (operation.description !== undefined) entry.description = text(operation.description);
      if (operation.relation !== undefined && entry.source)
        entry.relation = text(operation.relation, 160);
    } else if (operation.type === 'remove-manual') {
      const id = text(operation.id, 200);
      if (!id.startsWith('manual:'))
        throw Error(
          'Удалять можно только ручные записи; исправьте исходник для автоматических связей',
        );
      overlay.nodes = overlay.nodes.filter((n) => n.id !== id);
      overlay.links = overlay.links.filter(
        (e) => e.id !== id && e.source !== id && e.target !== id,
      );
    } else throw Error('Операции: add-note, add-link, update-manual, remove-manual');
    overlay.revision++;
    overlay.updatedAt = new Date().toISOString();
    if (existsSync(file)) {
      const history = join(output, 'overlay-history');
      mkdirSync(history, { recursive: true });
      writeFileSync(join(history, String(overlay.revision - 1) + '.json'), readFileSync(file), {
        mode: 0o600,
      });
    }
    const temp = file + '.tmp';
    writeFileSync(temp, JSON.stringify(overlay, null, 2) + '\n', {
      mode: 0o600,
    });
    renameSync(temp, file);
    return { revision: overlay.revision };
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}
