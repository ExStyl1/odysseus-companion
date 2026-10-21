/** Bounded catalog and relation projections for the graph UI. */
export function projectView(raw, options = {}) {
  const graph = raw,
    nodes = new Map(graph.nodes.map((n) => [n.id, n])),
    projects = graph.nodes.filter((n) => n.type === 'project');
  const parents = new Map(),
    children = new Map();
  for (const e of graph.links)
    if (e.relation === 'contains') {
      if (!parents.has(e.target)) parents.set(e.target, e.source);
      const list = children.get(e.source) || new Set();
      list.add(e.target);
      children.set(e.source, list);
    }
  const ancestors = (id) => {
    const result = [],
      seen = new Set();
    while (nodes.has(id) && !seen.has(id)) {
      seen.add(id);
      result.unshift(nodes.get(id));
      id = parents.get(id);
    }
    return result;
  };
  const q = String(options.query || '').toLocaleLowerCase(),
    focus = String(options.focus || ''),
    offset = Math.max(0, Number(options.offset) || 0),
    limit = 100,
    view = options.view === 'links' ? 'links' : 'catalog';
  const chain = ancestors(focus),
    project =
      chain.find((n) => n.type === 'project') ||
      nodes.get('project:' + nodes.get(focus)?.project_id),
    scope = options.project || project?.id || '';
  const inScope = (n) =>
    !scope ||
    n.id === scope ||
    n.project_id === scope.replace(/^project:/, '') ||
    ancestors(n.id).some((p) => p.id === scope);
  let candidates;
  if (q)
    candidates = graph.nodes.filter(
      (n) =>
        inScope(n) &&
        (String(n.label) + ' ' + String(n.description || '')).toLocaleLowerCase().includes(q),
    );
  else if (focus && view === 'catalog' && ['project', 'folder'].includes(nodes.get(focus)?.type))
    candidates = [...(children.get(focus) || [])].map((id) => nodes.get(id)).filter(Boolean);
  else if (focus) {
    const ids = new Set([focus]);
    for (const e of graph.links)
      if (e.source === focus) ids.add(e.target);
      else if (e.target === focus) ids.add(e.source);
    candidates = [...ids].map((id) => nodes.get(id)).filter(Boolean);
  } else if (view === 'catalog')
    candidates = graph.nodes.filter(
      (n) => n.type === 'project' || n.type === 'note' || (n.manual && !n.project_id),
    );
  else {
    const owners = new Map();
    for (const e of graph.links)
      if (nodes.get(e.source)?.type === 'project') {
        const set = owners.get(e.target) || new Set();
        set.add(e.source);
        owners.set(e.target, set);
      }
    candidates = graph.nodes.filter(
      (n) => n.type === 'project' || n.manual || (owners.get(n.id)?.size || 0) > 1,
    );
  }
  const rank = (n) => (n.type === 'project' ? 0 : n.type === 'folder' ? 1 : 2);
  candidates.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  const page = candidates.slice(offset, offset + limit);
  let anchorCount = 0;
  if (focus && nodes.has(focus) && !page.some((n) => n.id === focus)) {
    page.unshift(nodes.get(focus));
    anchorCount = 1;
  }
  const ids = new Set(page.map((n) => n.id)),
    edges = graph.links.filter((e) => ids.has(e.source) && ids.has(e.target));
  return {
    ready: true,
    anchorCount,
    scopeProject: scope,
    breadcrumbs: chain.map((n) => ({ id: n.id, label: n.label })),
    totalNodes: graph.nodes.length,
    totalLinks: graph.links.length,
    totalMatches: candidates.length,
    offset,
    limit,
    projects: projects.map((n) => ({
      id: n.id,
      label: n.label,
      path: n.source_file,
      stale: n.stale,
      pending: n.pending,
    })),
    nodes: page.map((n) => ({
      ...n,
      childCount: children.get(n.id)?.size || 0,
      description: String(n.description || '').slice(0, 3000),
    })),
    links: edges.slice(0, 1200),
    hiddenLinks: Math.max(0, edges.length - 1200),
  };
}
