/** Cache the aggregate graph; overlay changes invalidate its revision. */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { applyOverlay } from './overlay.mjs';
const read = (path, fallback) =>
  existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
const graphCache = new Map();
export function graphData(paths) {
  const file = join(paths.output, 'graph.json'),
    overlay = join(paths.output, 'overlay.json'),
    error = join(paths.runtime, 'last-error.json');
  const signature = [file, overlay, error, join(paths.output, 'collections.json')]
    .map((p) => {
      try {
        const s = statSync(p);
        return s.mtimeMs + ':' + s.size;
      } catch {
        return 'missing';
      }
    })
    .join('|');
  const prior = graphCache.get(paths.output);
  if (prior?.signature === signature) return prior;
  const raw = read(file, { nodes: [], links: [] });
  raw.nodes = raw.nodes.filter((n) => !n.manual);
  raw.links = (raw.links || raw.edges || []).filter((e) => !e.manual);
  const graph = applyOverlay(raw, read(overlay, {}));
  const value = { signature, graph };
  graphCache.clear();
  graphCache.set(paths.output, value);
  return value;
}
