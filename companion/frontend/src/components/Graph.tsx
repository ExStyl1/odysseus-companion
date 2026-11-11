import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from './primitives';
import { Empty, type Row } from '../runtime';
export function Graph({
  nodes,
  links,
  onSelect,
  flow = false,
}: {
  nodes: Row[];
  links: Row[];
  onSelect: (n: Row) => void;
  flow?: boolean;
}) {
  const [list, setList] = useState(false),
    [selected, setSelected] = useState(''),
    [view, setView] = useState({ x: 0, y: 0, z: 1 });
  const drag = useRef<any>(null),
    marker = 'arrow' + useId().replaceAll(':', '');
  const shown = flow ? nodes : nodes.slice(0, 24),
    compact = shown.length > 7,
    w = flow ? 164 : compact ? 184 : 220,
    h = flow ? 56 : 82,
    height = flow ? 540 : Math.max(540, Math.ceil(shown.length / 4) * 125 + 80);
  const coords = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    if (flow) {
      const xs = nodes.map((n) => n.position?.[0] || 0),
        ys = nodes.map((n) => n.position?.[1] || 0);
      nodes.forEach((n) =>
        map.set(n.id, {
          x:
            110 +
            (((n.position?.[0] || 0) - Math.min(...xs)) /
              Math.max(1, Math.max(...xs) - Math.min(...xs))) *
              880,
          y:
            70 +
            (((n.position?.[1] || 0) - Math.min(...ys)) /
              Math.max(1, Math.max(...ys) - Math.min(...ys))) *
              380,
        }),
      );
    } else if (shown.length <= 7) {
      const degree = (id: string) => links.filter((e) => e.source === id || e.target === id).length;
      const hub = [...shown].sort((a, b) => degree(b.id) - degree(a.id))[0];
      if (hub) map.set(hub.id, { x: 550, y: 270 });
      const rest = shown.filter((n) => n !== hub);
      rest.forEach((n, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / rest.length;
        map.set(n.id, { x: 550 + Math.cos(a) * 345, y: 270 + Math.sin(a) * 170 });
      });
    } else
      shown.forEach((n, i) =>
        map.set(n.id, { x: 160 + (i % 4) * 260, y: 85 + Math.floor(i / 4) * 125 }),
      );
    return map;
  }, [nodes, links, flow]);
  const choose = (n: Row) => {
      setSelected(n.id);
      onSelect(n);
    },
    zoom = (factor: number) =>
      setView((v) => {
        const z = Math.max(0.45, Math.min(2.5, v.z * factor)),
          r = z / v.z;
        return { x: 550 - (550 - v.x) * r, y: height / 2 - (height / 2 - v.y) * r, z };
      });
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoom(e.deltaY > 0 ? 0.9 : 1.1);
      }
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [list, height, nodes.length]);
  return (
    <div className="knowledge-stage">
      <div className="knowledge-stage-head">
        <div className="segmented">
          <Button
            id="knowledge-map"
            className={!list ? 'selected' : ''}
            onClick={() => setList(false)}
          >
            Карта
          </Button>
          <Button
            id="knowledge-list"
            className={list ? 'selected' : ''}
            onClick={() => setList(true)}
          >
            Список
          </Button>
        </div>
        <span className="map-count">
          На карте: {shown.length} из {nodes.length}
        </span>
        <div className="toolbar">
          <Button onClick={() => zoom(0.8)} aria-label="Уменьшить граф">
            −
          </Button>
          <Button onClick={() => zoom(1.2)} aria-label="Увеличить граф">
            +
          </Button>
          <Button onClick={() => setView({ x: 0, y: 0, z: 1 })}>По центру</Button>
        </div>
      </div>
      {!nodes.length && !list ? (
        <Empty title="В этой области пока нет узлов">
          Выберите другой проект или добавьте источники.
        </Empty>
      ) : list ? (
        <div className="knowledge-node-list">
          {nodes.map((n) => (
            <Button key={n.id} onClick={() => choose(n)}>
              {n.label || n.name || n.id} →
            </Button>
          ))}
        </div>
      ) : (
        <svg
          ref={svg}
          id="graph"
          className={`graph ${flow ? 'flow' : ''}`}
          viewBox={`0 0 1100 ${height}`}
          aria-label={
            flow
              ? `Схема процесса: ${shown.length} узлов`
              : `Граф знаний: ${shown.length} из ${nodes.length} узлов`
          }
          onPointerDown={(e) => {
            if ((e.target as Element).closest('[role=button]')) return;
            drag.current = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (drag.current) {
              const d = drag.current,
                r = 1100 / Math.max(1, e.currentTarget.getBoundingClientRect().width);
              setView((v) => ({
                ...v,
                x: d.ox + (e.clientX - d.x) * r,
                y: d.oy + (e.clientY - d.y) * r,
              }));
            }
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
        >
          <defs>
            <marker
              id={marker}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto"
            >
              <path d="M 0 1 L 9 5 L 0 9" fill="none" stroke="var(--muted)" />
            </marker>
          </defs>
          <g transform={`translate(${view.x},${view.y}) scale(${view.z})`}>
            {links.map((e, i) => {
              const a = coords.get(e.source),
                b = coords.get(e.target);
              if (!a || !b) return null;
              const dx = b.x - a.x,
                dy = b.y - a.y,
                d = Math.max(1, Math.hypot(dx, dy)),
                trim = Math.min(w / 2 + 14, d / 3),
                sx = a.x + (dx / d) * trim,
                sy = a.y + (dy / d) * trim,
                tx = b.x - (dx / d) * trim,
                ty = b.y - (dy / d) * trim;
              return (
                <path
                  key={i}
                  className="knowledge-edge"
                  d={`M ${sx} ${sy} Q ${(sx + tx) / 2 + dy * 0.12} ${(sy + ty) / 2 - dx * 0.12} ${tx} ${ty}`}
                  markerEnd={`url(#${marker})`}
                >
                  <title>{e.relation || 'связь'}</title>
                </path>
              );
            })}
            {shown.map((n) => {
              const p = coords.get(n.id)!;
              const kind =
                (
                  {
                    project: 'project',
                    folder: 'folder',
                    file: 'file',
                    document: 'file',
                    knowledge: 'knowledge',
                    note: 'knowledge',
                  } as Row
                )[n.type] || 'code';
              return (
                <g
                  key={n.id}
                  className={`knowledge-map-node node-${kind} ${selected === n.id ? 'is-selected' : ''}`}
                  transform={`translate(${p.x},${p.y})`}
                  role="button"
                  tabIndex={0}
                  aria-label={n.label || n.name || n.id}
                  onClick={() => choose(n)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      choose(n);
                    }
                  }}
                >
                  <rect className="map-card" x={-w / 2} y={-h / 2} width={w} height={h} rx={13} />
                  <rect
                    className="map-accent"
                    x={-w / 2 + 13}
                    y={-h / 2 + 17}
                    width="4"
                    height={h - 34}
                    rx="2"
                  />
                  <text className="map-kind" x={-w / 2 + 29} y="-15">
                    {flow
                      ? 'N8N'
                      : (
                          {
                            project: 'ПРОЕКТ',
                            folder: 'ПАПКА',
                            file: 'ФАЙЛ',
                            knowledge: 'ЗНАНИЕ',
                          } as Row
                        )[n.type] || String(n.type || 'УЗЕЛ').toUpperCase()}
                  </text>
                  <text className="map-title" x={-w / 2 + 29} y="7">
                    {String(n.label || n.name || n.id).slice(0, compact ? 19 : 25)}
                  </text>
                  {!flow && (
                    <text className="map-meta" x={-w / 2 + 29} y="26">
                      {links.filter((e) => e.source === n.id || e.target === n.id).length} связей в
                      выборке
                    </text>
                  )}
                  <title>
                    {n.label || n.name || n.id}
                    {'\n'}
                    {n.description}
                  </title>
                </g>
              );
            })}
          </g>
        </svg>
      )}
    </div>
  );
}
