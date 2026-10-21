import type { KnowledgeView } from '../../../shared/odysseus-knowledge-types';

export function layoutKnowledgeView(data: KnowledgeView) {
  const positions = new Map<string, { x: number; y: number }>(),
    projects = data.nodes.filter((n) => n.type === 'project'),
    others = data.nodes.filter((n) => n.type !== 'project');
  projects.forEach((n, i) => {
    const angle = (i * Math.PI * 2) / Math.max(1, projects.length) - Math.PI / 2;
    positions.set(n.id, {
      x: 500 + Math.cos(angle) * (projects.length === 1 ? 0 : 260),
      y: 340 + Math.sin(angle) * (projects.length === 1 ? 0 : 210),
    });
  });
  others.forEach((n, i) => {
    const angle = i * 2.399963;
    const radius = 80 + Math.sqrt((i + 1) / Math.max(1, others.length)) * 220;
    positions.set(n.id, {
      x: 500 + Math.cos(angle) * radius,
      y: 340 + Math.sin(angle) * radius,
    });
  });
  // Bounded layout: no perpetual simulation or animation on an idle tab.
  for (let step = 0; step < 45; step++) {
    const force = new Map(data.nodes.map((n) => [n.id, { x: 0, y: 0 }]));
    for (let i = 0; i < data.nodes.length; i++)
      for (let j = i + 1; j < data.nodes.length; j++) {
        const a = data.nodes[i]!,
          b = data.nodes[j]!,
          p = positions.get(a.id)!,
          q = positions.get(b.id)!,
          dx = p.x - q.x,
          dy = p.y - q.y,
          d = Math.max(30, Math.hypot(dx, dy)),
          f = 2600 / (d * d * d);
        force.get(a.id)!.x += dx * f;
        force.get(a.id)!.y += dy * f;
        force.get(b.id)!.x -= dx * f;
        force.get(b.id)!.y -= dy * f;
      }
    for (const e of data.links) {
      const a = positions.get(e.source),
        b = positions.get(e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x,
        dy = b.y - a.y,
        d = Math.max(1, Math.hypot(dx, dy)),
        f = ((d - 160) * 0.006) / d;
      force.get(e.source)!.x += dx * f;
      force.get(e.source)!.y += dy * f;
      force.get(e.target)!.x -= dx * f;
      force.get(e.target)!.y -= dy * f;
    }
    for (const n of others) {
      const p = positions.get(n.id)!,
        f = force.get(n.id)!;
      p.x = Math.min(925, Math.max(75, p.x + Math.max(-7, Math.min(7, f.x))));
      p.y = Math.min(610, Math.max(65, p.y + Math.max(-7, Math.min(7, f.y))));
    }
  }
  return positions;
}
