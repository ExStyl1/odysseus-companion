"""Obsidian's explicit links -> Graphify graph + native Canvas. No semantic/API pass."""
from __future__ import annotations
import argparse, hashlib, json, os, re, tempfile, unicodedata
from pathlib import Path
from urllib.parse import unquote


def digest(data):
    return hashlib.sha256(data).hexdigest()


def stable_id(text):
    return hashlib.sha256(text.encode()).hexdigest()[:24]


def clean_lines(text):
    fenced = False
    for number, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith(('```', '~~~')):
            fenced = not fenced
            continue
        if not fenced:
            yield number, re.sub(r'`[^`]*`', '', line)


def build_graph(vault: Path, generated='Graphify'):
    import networkx as nx
    vault = vault.resolve(strict=True)
    files = []
    for current, dirs, names in os.walk(vault, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d != generated and not (Path(current) / d).is_symlink())
        files.extend(Path(current) / n for n in sorted(names) if n.lower().endswith('.md') and not (Path(current) / n).is_symlink())
    if len(files) > 10000:
        raise ValueError('More than 10000 notes; choose a smaller vault or adapt the limit explicitly.')
    G = nx.MultiDiGraph()
    index, stems, texts = {}, {}, {}
    norm = lambda s: unicodedata.normalize('NFC', s).casefold()
    for p in files:
        relative = p.relative_to(vault).as_posix()
        if p.stat().st_size > 2 * 1024 * 1024:
            raise ValueError(f'Note exceeds 2 MiB: {relative}')
        text = p.read_text(encoding='utf-8-sig')
        node_id = 'note:' + relative
        title = next((line[2:].strip() for _, line in clean_lines(text) if line.startswith('# ')), p.stem)
        G.add_node(node_id, label=title, type='note', source_file=relative, file_type='markdown', description='Obsidian note: ' + relative)
        index.setdefault(norm(relative.removesuffix('.md')), []).append(node_id)
        stems.setdefault(norm(p.stem), []).append(node_id)
        texts[node_id] = text
    unresolved = []
    for source, text in texts.items():
        relative = G.nodes[source]['source_file']
        for line_number, line in clean_lines(text):
            wiki = re.findall(r'!?\[\[([^\]]+)\]\]', line)
            markdown = re.findall(r'(?<!!)\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)', line)
            links = [(s.split('|', 1)[0], True) for s in wiki] + [(a or b, False) for a, b in markdown]
            for target, is_wiki in links:
                target = unquote(target.split('#', 1)[0]).strip()
                if not target or re.match(r'^[a-zA-Z][\w+.-]*:', target):
                    continue
                if not is_wiki and not target.lower().endswith('.md'):
                    continue
                if Path(target).suffix and Path(target).suffix.lower() != '.md':
                    continue
                base = target[:-3] if target.lower().endswith('.md') else target
                local = os.path.normpath(str(Path(relative).parent / base)).replace(os.sep, '/')
                if local == '..' or local.startswith('../') or Path(base).is_absolute():
                    unresolved.append({'source': relative, 'line': line_number, 'target': target, 'reason': 'outside-vault'})
                    continue
                candidates = index.get(norm(local), [])
                if is_wiki:
                    candidates = candidates or index.get(norm(base), []) or stems.get(norm(base), [])
                if len(candidates) != 1:
                    unresolved.append({'source': relative, 'line': line_number, 'target': target, 'reason': 'ambiguous' if candidates else 'not-found'})
                    continue
                destination = candidates[0]
                G.add_edge(source, destination, relation='links_to', confidence='EXTRACTED', confidence_score=1.0,
                           source_file=relative, source_location=f'{relative}:{line_number}', source_line=line_number, weight=1.0)
    communities = {i: sorted(group) for i, group in enumerate(sorted(nx.connected_components(G.to_undirected()), key=lambda c: min(c)))}
    return G, communities, unresolved


def canvas_data(G):
    nodes = []
    for i, (node, data) in enumerate(sorted(G.nodes(data=True))):
        nodes.append({'id': stable_id(node), 'type': 'file', 'file': data['source_file'], 'x': (i % 5) * 340, 'y': (i // 5) * 240, 'width': 300, 'height': 180})
    edges = []
    for source, target, key in G.edges(keys=True):
        edges.append({'id': stable_id(f'{source}:{target}:{key}'), 'fromNode': stable_id(source), 'toNode': stable_id(target), 'fromSide': 'right', 'toSide': 'left', 'label': 'ссылка'})
    return {'nodes': nodes, 'edges': edges}


def guarded_export(vault, output, planned):
    """Refuse to overwrite user edits; generated file ownership is verified by hash."""
    output.mkdir(parents=True, exist_ok=True)
    state_path = output / 'obsidian-export-state.json'
    old = json.loads(state_path.read_text()) if state_path.exists() else {'files': {}}
    if old.get('vault') not in (None, str(vault)):
        old = {'vault': str(vault), 'files': {}}
    for rel, data in planned.items():
        target = vault / rel
        for part in (target, *target.parents):
            if part == vault.parent:
                break
            if part.is_symlink():
                raise ValueError('Symlink in generated output: ' + rel)
        if target.exists():
            existing = target.read_bytes()
            if existing != data and digest(existing) != old['files'].get(rel):
                raise ValueError('Generated file has user edits; preserved: ' + rel)
    # Keep prior generated contents outside the vault for recovery; no source note is modified.
    backup = output / 'previous-export'
    for rel, data in planned.items():
        target = vault / rel
        if target.exists() and target.read_bytes() != data:
            copy = backup / rel
            copy.parent.mkdir(parents=True, exist_ok=True)
            copy.write_bytes(target.read_bytes())
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_name(target.name + '.odysseus-tmp')
        temp.write_bytes(data)
        os.replace(temp, target)
    old['files'].update({rel: digest(data) for rel, data in planned.items()})
    state_path.write_text(json.dumps(old, ensure_ascii=False, indent=2) + '\n')


def refresh(vault, output):
    from graphify.export import to_json, to_obsidian
    output.mkdir(parents=True, exist_ok=True)
    G, groups, unresolved = build_graph(vault)
    report = ['# Graphify · Obsidian', '', f'Заметок: {len(G)}. Ссылок: {G.number_of_edges()}. Связанных групп: {len(groups)}.', '',
              'Граф построен по явным ссылкам между Markdown-заметками. Смысловые связи не выдумываются; анализ содержимого моделью здесь не выполняется.', '',
              'Откройте [[Graphify/Карта.canvas|Canvas-карту]] или используйте поиск по графу в Odysseus.', '', '## Связанные группы', '']
    for group, nodes in groups.items():
        report += [f'### Группа {group + 1}', '']
        for node in nodes:
            rel = G.nodes[node]['source_file'].removesuffix('.md')
            report.append(f'- [[{rel}]]')
        report.append('')
    report += ['## Неразрешённые ссылки', '']
    report += [f"- `{e['source']}:{e['line']}` → `{e['target']}` ({e['reason']})" for e in unresolved] or ['Не обнаружены.']
    planned = {'Graphify/Обзор.md': ('\n'.join(report) + '\n').encode(),
               'Graphify/Карта.canvas': (json.dumps(canvas_data(G), ensure_ascii=False, indent=2) + '\n').encode()}
    with tempfile.TemporaryDirectory(dir=output) as tmp:
        to_obsidian(G, groups, tmp)
        for p in Path(tmp).rglob('*'):
            if p.is_file() and not any(part.startswith('.') for part in p.relative_to(tmp).parts):
                planned['Graphify/Экспорт/' + p.relative_to(tmp).as_posix()] = p.read_bytes()
    guarded_export(vault, output, planned)
    to_json(G, groups, str(output / 'graph.json'), force=True)
    (output / 'GRAPH_REPORT.md').write_text('\n'.join(report) + '\n', encoding='utf-8')
    (output / 'bridge-status.json').write_text(json.dumps({'vault': str(vault), 'notes': len(G), 'links': G.number_of_edges(), 'unresolved': unresolved}, ensure_ascii=False, indent=2) + '\n')
    return {'vault': str(vault), 'notes': len(G), 'links': G.number_of_edges(), 'unresolved': len(unresolved), 'graph': str(output / 'graph.json')}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--vault', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(refresh(args.vault.resolve(strict=True), args.output.resolve()), ensure_ascii=False))
    except (ValueError, OSError) as exc:
        parser.exit(1, str(exc) + '\n')
