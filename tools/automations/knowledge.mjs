import {scrubText} from '../personal/redact-text.mjs';
/** Retrieval is local and scoped. Optional embeddings go only to the configured llm-proxy. */
import { existsSync, readFileSync, realpathSync, statSync, accessSync, constants } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runtimePaths, readRegistry } from '../graphify.mjs';
import { graphData } from '../knowledge/graph-store.mjs';
import { filterCollection, collectionState, collectionForPath } from '../knowledge/collections.mjs';
import { privateWrite, document, noLinks } from '../personal/store.mjs';
import { editKnowledge } from '../knowledge/overlay.mjs';
import { queueProjectRefresh } from '../knowledge/workflow.mjs';
const words = text => String(text).toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [];
const hash = text => createHash('sha256').update(text).digest('hex');
const inside = (base, file) => { const rel = relative(base, file); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'); };
function sourceStamp(file){try{const s=statSync(file);accessSync(file,constants.R_OK);return [s.mtimeMs,s.ctimeMs,s.size,s.mode];}catch{return null;}}
export function scopedGraph(paths, collection = 'projects', project) {
  if (!/^[a-z0-9-]{1,80}$/.test(collection)) throw Error('Неверный каталог знаний');
  const kp = runtimePaths(paths.root, paths.env), all = graphData(kp).graph;
  let graph = filterCollection(all, collectionState(kp, all), collection);
  if (project) {
    const id = project.replace(/^project:/, '');
    if (!graph.nodes.some(n => n.id === 'project:' + id)) throw Error('Проект не принадлежит выбранному каталогу');
    graph = { nodes: graph.nodes.filter(n => n.id === 'project:' + id || [id, 'project:' + id].includes(n.project_id)), links: graph.links };
    const ids = new Set(graph.nodes.map(n => n.id)); graph.links = graph.links.filter(l => ids.has(l.source) && ids.has(l.target));
  }
  return { kp, graph };
}
export function scopeFingerprint(paths, collection, project) {
  const { graph } = scopedGraph(paths, collection, project);
  return hash(JSON.stringify(graph.nodes.map(n => [n.id, n.project_id, n.source_file, n.description, n.label,sourceStamp(n.source_file)])));
}
export async function indexKnowledge(paths, input = {}, embed) {
  const collection = input.collection || 'projects', project = input.project;
  const { kp, graph } = scopedGraph(paths, collection, project);
  const revision = hash(JSON.stringify(graph.nodes.map(n => [n.id, n.project_id, n.source_file, n.description, n.label,sourceStamp(n.source_file)])));
  const registry = Object.values(readRegistry(kp).projects), roots = registry.filter(p => collectionForPath(kp, p.path) === collection && (!project || p.id === project.replace(/^project:/, '')));
  const docs = [], seen = new Set();
  for (const node of graph.nodes) {
    if (docs.length >= 1500) break;
    if (isAbsolute(String(node.source_file||''))&&!['project','folder'].includes(node.type)&&!sourceStamp(node.source_file))continue;
    if (node.description&&(!isAbsolute(String(node.source_file||''))||['project','folder'].includes(node.type))) docs.push({ source: node.source_file || node.id, nodeId: node.id, title: node.label || node.id, text: String(node.description).slice(0, 12000) });
    const file = node.source_file;
    if (typeof file !== 'string' || seen.has(file) || !/\.(md|txt|json|ya?ml|ts|tsx|js|py|java|kt|sql|go|rs)$/i.test(file) || /(?:secret|credential|token|\.env)/i.test(file)) continue;
    seen.add(file);
    try {
      const actual = realpathSync(file);
      // Only registered project files or bridge-owned notes; graph text cannot authorize arbitrary reads.
      if (!roots.some(r => inside(r.path, actual)) && !inside(join(kp.output, 'manual-documents'), actual)) continue;
      if (!statSync(actual).isFile() || statSync(actual).size > 512000) continue;
      docs.push({ source: actual, nodeId: node.id, title: node.label || file, text: readFileSync(actual, 'utf8').slice(0, 30000) });
    } catch { /* An unavailable source does not discard the graph description. */ }
  }
  // Notes saved by workflows are indexed without granting an arbitrary file-read API.
  const projectIds = new Set(graph.nodes.filter(n => n.type === 'project').map(n => n.id.replace(/^project:/, '')));
  const saved = document(join(paths.home, 'notes.json'), { entries: [] }).entries.filter(n => {
    const owner = n.project?.replace(/^project:/, '');
    // Project notes follow current membership, never their historical saved catalog.
    return owner ? projectIds.has(owner) && (!project || owner === project.replace(/^project:/, '')) : !project && n.collection === collection;
  });
  docs.push(...saved.filter(n=>!isAbsolute(String(n.source||''))||sourceStamp(n.source)).slice(-200));
  const chunks = [];
  for (const raw of docs) {const doc={...raw,text:scrubText(raw.text)};for (let i = 0; i < doc.text.length && chunks.length < 4000; i += 1200) {
    const text = doc.text.slice(i, i + 1600); chunks.push({ ...doc, text, id: hash(doc.source + ':' + i + ':' + text) });
  }}
  const file = join(paths.home, 'rag', hash(collection + ':' + (project || '')).slice(0, 20) + '.json');
  noLinks(file);
  const prior = document(file, { chunks: [] }), old = new Map(prior.chunks.map(c => [c.id, c]));
  if (embed) {
    const missing = chunks.filter(c => !old.get(c.id)?.vector || prior.embeddingModel !== input.embeddingModel);
    for (let i = 0; i < missing.length; i += 16) {
      if (scopeFingerprint(paths, collection, project) !== revision) throw Error('Каталог изменился во время индексации. Повторите запрос.');
      const batch = missing.slice(i, i + 16), vectors = await embed(batch.map(c => c.text));
      if (vectors.length !== batch.length) throw Error('Неполный ответ embeddings');
      batch.forEach((c, j) => c.vector = vectors[j]);
    }
    for (const c of chunks) c.vector ||= old.get(c.id)?.vector;
  }
  if (scopeFingerprint(paths, collection, project) !== revision) throw Error('Каталог изменился во время индексации. Повторите запрос.');
  privateWrite(file, JSON.stringify({ collection, project, scopeFingerprint: revision, redactionVersion:1, updatedAt: new Date().toISOString(), embeddingModel: embed ? input.embeddingModel : null, chunks }));
  return { collection, project, chunks: chunks.length, documents: docs.length, mode: embed ? 'semantic+keyword' : 'keyword+graph', updatedAt: new Date().toISOString() };
}
export async function searchKnowledge(paths, input, embed) {
  const collection = input.collection || 'projects'; scopedGraph(paths, collection, input.project);
  const query = String(input.query || '').trim(); if (!query || query.length > 4000) throw Error('Укажите запрос до 4000 символов');
  const file = join(paths.home, 'rag', hash(collection + ':' + (input.project || '')).slice(0, 20) + '.json');
  if (!existsSync(file)) await indexKnowledge(paths, input, embed);
  let data = document(file);
  // Never compare vectors from different embedding models.
  if (data.redactionVersion!==1||data.scopeFingerprint !== scopeFingerprint(paths, collection, input.project) || (embed && data.embeddingModel !== input.embeddingModel)) { await indexKnowledge(paths, input, embed); data = document(file); }
  const terms = new Set(words(query)), vector = embed ? (await embed([query]))[0] : null;
  if (data.scopeFingerprint !== scopeFingerprint(paths, collection, input.project)) throw Error('Каталог изменился во время поиска. Повторите запрос.');
  const excludedSources=new Set(input.excludedSources||[]),excludedNodeIds=new Set(input.excludedNodeIds||[]);
  const scored = data.chunks.filter(c=>!excludedSources.has(c.source)&&!excludedNodeIds.has(c.nodeId)).map(c => {
    const tokens = words(c.title + ' ' + c.text), matched = tokens.filter(w => terms.has(w)).length;
    let score = matched / Math.sqrt(tokens.length || 1);
    if (vector && c.vector?.length === vector.length) {
      const dot = vector.reduce((v, x, i) => v + x * c.vector[i], 0), norm = Math.hypot(...vector) * Math.hypot(...c.vector);
      score += norm ? dot / norm : 0;
    }
    return { ...c, vector: undefined, score };
  }).filter(c => c.score > (vector ? 0.15 : 0)).sort((a, b) => b.score - a.score).slice(0, Math.min(12, Math.max(1, Number(input.limit) || 6)));
  return { query, collection, project: input.project, scopeRevision: data.scopeFingerprint, mode: vector ? 'semantic+keyword' : 'keyword+graph', indexedAt: data.updatedAt, matches: scored };
}
export function saveKnowledge(paths, input) {
  const collection = input.collection || 'projects'; const { kp, graph } = scopedGraph(paths, collection, input.project);
  const title = String(input.title || '').trim(), text = String(input.text || '').trim();
  if (!title || title.length > 160 || !text || text.length > 24000) throw Error('Укажите заголовок до 160 и текст до 24000 символов');
  const id = randomUUID(), entriesFile = join(paths.home, 'notes.json'), prior = document(entriesFile, { entries: [] });
  const source = join(kp.output, 'manual-documents', collection, id + '.md'); noLinks(source);
  privateWrite(source, '# ' + title + '\n\n' + text + '\n\nПроисхождение: результат процесса n8n / агента; проверяйте источники.\n');
  editKnowledge(kp.output, { type: 'add-note', collection, label: title, description: text.slice(0, 1800), documentPath: source, ...(input.project ? { parent: input.project.startsWith('project:') ? input.project : 'project:' + input.project } : {}) });
  prior.entries.push({ source, title, text, collection, project: input.project, at: new Date().toISOString() });
  privateWrite(entriesFile, JSON.stringify(prior));
  if (input.project) {
    const project = Object.values(readRegistry(kp).projects).find(p => p.id === input.project.replace(/^project:/, ''));
    if (project) queueProjectRefresh(kp, project);
  }
  return { saved: true, source, collection, project: input.project };
}
