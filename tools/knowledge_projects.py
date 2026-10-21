"""Persist per-project Graphify AST graphs and merge evidence-backed cross-project links."""
from __future__ import annotations
import argparse, hashlib, importlib.util, json, os, re, subprocess, sys, shutil, signal
from urllib.parse import unquote, urlparse
from datetime import datetime, timezone
sys.dont_write_bytecode = True
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('obsidian_bridge', ROOT / 'shared/skills/graphify/scripts/obsidian_bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
EXCLUDED = {'node_modules', 'dist', 'build', 'coverage', 'target', 'vendor', '__pycache__', 'Graphify', 'graphify-out', '.venv', 'venv'}
EXTENSIONS = {'.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.go', '.rs', '.java', '.kt', '.cs', '.rb', '.swift', '.c', '.h', '.cpp', '.php', '.sql', '.graphql', '.proto', '.md', '.toml', '.yaml', '.yml', '.json'}


def scan(project):
    files = []
    for base, dirs, names in os.walk(project, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d not in EXCLUDED and not (Path(base) / d).is_symlink())
        for name in sorted(names):
            path = Path(base) / name
            if name.startswith('.') or path.suffix not in EXTENSIONS or path.is_symlink():
                continue
            if path.stat().st_size <= 2 * 1024 * 1024 and not any(s in name.lower() for s in ('lock', 'credential', 'secret', 'token')):
                files.append(path)
            if len(files) > 50000:
                raise ValueError('Project exceeds 50000 source files: ' + str(project))
    return files


def index_project(project, name, project_id, output, metadata_only=False):
    cache = output / 'projects' / project_id
    cache.mkdir(parents=True, exist_ok=True)
    files = scan(project)
    fingerprint = hashlib.sha256()
    packages, shared_files, documents = [], [], []
    for path in files:
        rel = path.relative_to(project).as_posix()
        contents = path.read_bytes()
        fingerprint.update(rel.encode() + b'\0' + contents)
        if path.suffix == '.md':
            text = contents.decode('utf-8-sig', errors='replace')
            lines = list(bridge.clean_lines(text))
            headings = [line.lstrip('#').strip()[:180] for _, line in lines if line.startswith('#')][:12]
            links = []
            for number, line in lines:
                for target in re.findall(r'(?<!!)\[[^\]]*\]\(([^\s)]+)\)', line):
                    links.append({'target':target, 'line':number})
            documents.append({'file':rel, 'title':headings[0] if headings else path.stem, 'headings':headings, 'links':links})
        if path.name == 'package.json':
            try:
                package = json.loads(contents)
                packages.append({'file': rel, 'name': package.get('name'), 'dependencies': package.get('dependencies', {}), 'peerDependencies': package.get('peerDependencies', {}), 'devDependencies': package.get('devDependencies', {})})
            except (ValueError, UnicodeError):
                pass
        if path.suffix in {'.sql', '.graphql', '.proto', '.py', '.ts', '.go', '.java', '.kt', '.rs'} and len(contents) >= 128 and path.name not in {'index.ts', '__init__.py'} and not path.name.endswith('.d.ts'):
            shared_files.append({'file': rel, 'sha256': hashlib.sha256(contents).hexdigest()})
    revision = fingerprint.hexdigest()
    state_path = cache / 'state.json'
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    engine_graph = cache / 'engine' / 'graphify-out' / 'graph.json'
    changed = state.get('fingerprint') != revision or not engine_graph.exists()
    state.update(id=project_id, name=name, path=str(project), files=len(files), packages=packages, sharedFiles=shared_files, documents=documents, pending=changed)
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n')
    if metadata_only:
        return
    if changed:
        if engine_graph.exists():
            history = cache / 'history'
            history.mkdir(exist_ok=True)
            shutil.copyfile(engine_graph, history / (state.get('fingerprint', 'previous') + '.json'))
            for older in sorted(history.glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True)[20:]:
                older.unlink()
        status = cache / 'indexing.json'
        status.write_text(json.dumps({'stage':'AST', 'project':name, 'files':len(files), 'startedAt':datetime.now(timezone.utc).isoformat()}) + '\n')
        try:
            command = [sys.executable, '-m', 'graphify', 'extract', str(project), '--code-only', '--no-cluster', '--max-workers', '2', '--out', str(cache / 'engine')]
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=os.name != 'nt')
            try:
                stdout, stderr = process.communicate(timeout=600)
            except subprocess.TimeoutExpired:
                if os.name != 'nt':
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True)
                process.communicate()
                raise RuntimeError('AST indexing exceeded 600 seconds; previous snapshot retained')
            if process.returncode:
                raise RuntimeError(stderr[-2000:] or stdout[-2000:])
            if not engine_graph.exists():
                import networkx as nx
                from graphify.export import to_json
                to_json(nx.MultiDiGraph(), {}, str(engine_graph), force=True)
            state.update(fingerprint=revision, indexedAt=datetime.now(timezone.utc).isoformat(), pending=False)
        finally:
            status.unlink(missing_ok=True)
    (cache / 'error.json').unlink(missing_ok=True)
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'project': name, 'files': len(files), 'changed': changed}, ensure_ascii=False))


def load_graph(path):
    import networkx as nx
    data = json.loads(path.read_text())
    return nx.node_link_graph(data, edges='links' if 'links' in data else 'edges')


def merge(output, vault):
    import networkx as nx
    from graphify.export import to_json
    fingerprint = hashlib.sha256(Path(__file__).read_bytes())
    for state_file in sorted((output / 'projects').glob('*/state.json')):
        fingerprint.update(state_file.read_bytes())
        for extra in [state_file.parent/'engine/graphify-out/graph.json', state_file.parent/'decisions.json', state_file.parent/'error.json']:
            if extra.exists():
                stat=extra.stat(); fingerprint.update(str((str(extra),stat.st_size,stat.st_mtime_ns)).encode())
    overlay_path=output/'overlay.json'
    if overlay_path.exists(): fingerprint.update(overlay_path.read_bytes())
    notes_path=output/'notes/graph.json'
    if notes_path.exists(): fingerprint.update(notes_path.read_bytes())
    marker=output/'merge-state.json'
    prior=json.loads(marker.read_text()) if marker.exists() else {}
    revision=fingerprint.hexdigest()
    if prior.get('fingerprint')==revision and (output/'graph.json').exists():
        print(json.dumps({**prior,'cached':True},ensure_ascii=False));return
    G = nx.MultiDiGraph()
    projects = []
    doc_refs = []
    providers, files_by_hash = {}, {}
    for path in sorted((output / 'projects').glob('*/state.json')):
        state = json.loads(path.read_text())
        graph_path = path.parent / 'engine/graphify-out/graph.json'
        project_node = 'project:' + state['id']
        state['stale'] = (path.parent / 'error.json').exists() or state.get('pending',False) or not graph_path.exists()
        projects.append(state)
        G.add_node(project_node, label=state['name'], type='project', source_file=state['path'], project_id=state['id'], stale=state['stale'], description='Проект: ' + state['name'] + (' (последний сохранённый снимок; обновление недоступно)' if state['stale'] else ''))
        # Global view keeps the file/module tree. Full symbol graphs remain available
        # through Graphify's native project_path parameter, avoiding a huge pinned MCP graph.
        G.nodes[project_node]['graphify_project_path'] = str(path.parent / 'engine')
        G.nodes[project_node]['description'] += '; подробный граф: project_path=' + str(path.parent / 'engine')
        if graph_path.exists():
            local = load_graph(graph_path)
            owners = {}
            for node, attrs in local.nodes(data=True):
                source = attrs.get('source_file')
                if not source:
                    continue
                absolute = Path(source) if Path(source).is_absolute() else Path(state['path']) / source
                try:
                    rel = absolute.relative_to(state['path'])
                except ValueError:
                    continue
                file_node = project_node + ':file:' + rel.as_posix()
                owners[node] = file_node
                if file_node not in G:
                    G.add_node(file_node, label=rel.as_posix(), type='file', project_id=state['id'], source_file=str(absolute), graphify_project_path=str(path.parent / 'engine'))
                parent = project_node
                for i in range(len(rel.parts)-1):
                    folder = Path(*rel.parts[:i+1]).as_posix()
                    folder_node = project_node + ':folder:' + folder
                    G.add_node(folder_node, label=folder, type='folder', project_id=state['id'], source_file=str(Path(state['path']) / folder))
                    G.add_edge(parent, folder_node, key='contains', relation='contains', confidence='EXTRACTED', source_file=str(absolute))
                    parent = folder_node
                G.add_edge(parent, file_node, key='contains', relation='contains', confidence='EXTRACTED', source_file=str(absolute))
            for source, target, attrs in local.edges(data=True):
                a, b = owners.get(source), owners.get(target)
                if not a or not b or a == b:
                    continue
                relation, confidence = attrs.get('relation','related'), attrs.get('confidence','INFERRED')
                key = relation + ':' + confidence
                prior = G.get_edge_data(a,b,key) or {}
                G.add_edge(a,b,key=key,relation=relation,confidence=confidence,count=prior.get('count',0)+1,
                           source_file=G.nodes[a]['source_file'],source_location=attrs.get('source_location',local.nodes[source].get('source_location','')))
            del local
        for document in state.get('documents', []):
            node = project_node + ':doc:' + document['file']
            source = str(Path(state['path']) / document['file'])
            G.add_node(node, label=document['title'], type='document', project_id=state['id'], source_file=source, description='Разделы: ' + '; '.join(document['headings']))
            parent = project_node
            parts = Path(document['file']).parts
            for i in range(len(parts)-1):
                folder = Path(*parts[:i+1]).as_posix()
                folder_node = project_node + ':folder:' + folder
                G.add_node(folder_node, label=folder, type='folder', project_id=state['id'], source_file=str(Path(state['path']) / folder))
                G.add_edge(parent, folder_node, key='contains', relation='contains', confidence='EXTRACTED', source_file=source)
                parent = folder_node
            G.add_edge(parent, node, key='contains', relation='contains', confidence='EXTRACTED', source_file=source)
            for link in document['links']:
                doc_refs.append((node, state['id'], Path(source), link))
        for package in state.get('packages', []):
            if isinstance(package.get('name'), str):
                providers.setdefault(package['name'], set()).add(project_node)
            for field in ('dependencies', 'peerDependencies', 'devDependencies'):
                for dependency, version in package.get(field, {}).items():
                    dependency_node = 'npm:' + dependency
                    G.add_node(dependency_node, label='npm ' + dependency, type='dependency')
                    G.add_edge(project_node, dependency_node, relation='uses_' + field, confidence='EXTRACTED', confidence_score=1.0,
                               version=str(version), source_file=str(Path(state['path']) / package['file']), source_location=package['file'] + ':' + field + '.' + dependency)
        for entry in state.get('sharedFiles', []):
            files_by_hash.setdefault(entry['sha256'], []).append((project_node, state, entry))
        decisions = path.parent / 'decisions.json'
        if decisions.exists():
            for i, decision in enumerate(json.loads(decisions.read_text()).get('entries', [])):
                node = project_node + ':decision:' + str(i)
                G.add_node(node, label=decision['text'][:100], description=decision['text'], type='decision', source_file=str(decisions), project_id=state['id'])
                G.add_edge(project_node, node, relation='recorded_decision', confidence='EXTRACTED', source_file=str(decisions))
    for node, owner_id, source, link in doc_refs:
        parsed = urlparse(unquote(link['target'].split('#',1)[0]))
        if parsed.scheme and parsed.scheme != 'file':
            continue
        target = Path(parsed.path) if parsed.scheme == 'file' else source.parent / parsed.path
        target = target.resolve()
        if not target.exists():
            continue
        for state in projects:
            if state['id'] != owner_id and target.is_relative_to(state['path']):
                G.add_edge(node, 'project:' + state['id'], relation='references_project_file', confidence='EXTRACTED', confidence_score=1.0, source_file=str(source), source_line=link['line'], target_file=str(target))
    for dependency, owners in providers.items():
        # Multiple projects may vendor the same package name; that is not a proven direct dependency.
        if len(owners) != 1:
            continue
        for owner in owners:
            for state in projects:
                source = 'project:' + state['id']
                if owner == source:
                    continue
                for package in state.get('packages', []):
                    if dependency in package.get('dependencies', {}) or dependency in package.get('peerDependencies', {}):
                        G.add_edge(source, owner, relation='declares_package_dependency', confidence='EXTRACTED', confidence_score=1.0,
                                   package=dependency, source_file=str(Path(state['path']) / package['file']))
    for sha, occurrences in files_by_hash.items():
        if len({p for p, _, _ in occurrences}) < 2:
            continue
        node = 'shared-file:' + sha
        G.add_node(node, label='Одинаковый файл ' + Path(occurrences[0][2]['file']).name, type='shared_content', sha256=sha)
        for project_node, state, entry in occurrences:
            G.add_edge(project_node, node, relation='contains_identical_content', confidence='EXTRACTED', confidence_score=1.0, source_file=str(Path(state['path']) / entry['file']))
    notes = output / 'notes/graph.json'
    if notes.exists():
        local = load_graph(notes)
        G.update(local)
    # Link vault references to real registered project folders via explicit file links.
    for node, attrs in list(G.nodes(data=True)):
        if attrs.get('type') == 'note':
            for state in projects:
                note = vault / attrs.get('source_file', '')
                if note.is_file():
                    text = note.read_text(encoding='utf-8-sig')
                    if re.search(re.escape(state['path']) + r'(?:/|[\s`\"\)\]]|$)', text):
                        G.add_edge(node, 'project:' + state['id'], relation='mentions_project_path', confidence='EXTRACTED', confidence_score=1.0, source_file=str(note))
    overlay=json.loads(overlay_path.read_text()) if overlay_path.exists() else {}
    for node in overlay.get('nodes', []):
        G.add_node(node['id'], **{k:v for k,v in node.items() if k != 'id'}, type='knowledge', manual=True)
    for node_id, fields in overlay.get('annotations', {}).items():
        if node_id in G:
            G.nodes[node_id].update({k: v for k, v in fields.items() if k in {'label', 'description'}})
    for link in overlay.get('links', []):
        if link['source'] in G and link['target'] in G:
            G.add_edge(link['source'],link['target'],**{k:v for k,v in link.items() if k not in {'source','target'}})
    groups = {i: sorted(c) for i, c in enumerate(sorted(nx.connected_components(G.to_undirected()), key=lambda c: min(c)))}
    graph_temp=output/'graph.next.json'
    to_json(G, groups, str(graph_temp), force=True)
    os.replace(graph_temp,output/'graph.json')
    summary = ['# База знаний проектов Odysseus', '', f'Проектов: {len(projects)}. Узлов: {len(G)}. Связей: {G.number_of_edges()}.', '',
               'Прямые зависимости взяты из package.json. Общие npm-пакеты показывают общий стек, а не вызовы между приложениями. Одинаковые файлы сравниваются по SHA-256. Отсутствие связи означает только, что она пока не обнаружена.', '', '## Проекты', '']
    manual_lines=['# Ручные знания', '', 'Записанные утверждения пользователя; не автоматически проверенные факты.', '']
    for node in overlay.get('nodes', []):
        manual_lines += ['## '+node['label'], '', node.get('description',''), '', 'Идентификатор: `'+node['id']+'`', '']
    planned = {'Graphify/Ручные знания.md': ('\n'.join(manual_lines)+'\n').encode()}
    for state in projects:
        node = 'project:' + state['id']
        source = f'Graphify/Проекты/{state["id"]}.md'
        lines = [f'# {state["name"]}', '', f'Путь: `{state["path"]}`', '', f'Учтено файлов: {state["files"]}. Код разбирается через AST, у документов сохраняются заголовки и явные ссылки.', ('⚠ Последний сохранённый снимок: обновление сейчас недоступно.' if state['stale'] else 'Снимок успешно обновлён.'), '', '## Связи', '']
        for _, target, attrs in G.out_edges(node, data=True):
            if attrs.get('relation') == 'contains':
                continue
            evidence = attrs.get('source_file', '')
            lines.append(f'- {attrs.get("relation")}: {G.nodes[target].get("label", target)} · источник: `{evidence}`')
        lines += ['', 'Подробный граф символов для MCP project_path: `' + str(output/'projects'/state['id']/'engine') + '`.']
        planned[source] = ('\n'.join(lines) + '\n').encode()
        summary.append(f'- [[{source.removesuffix(".md")}|{state["name"]}]]')
    summary += ['', '## Как дополнять знания', '', 'Фиксируйте важные решения командой `node tools/graphify.mjs record ПУТЬ "Решение и источник"`. Не записывайте ключи и пароли. Обновление графов: `node tools/graphify.mjs refresh`.', '']
    planned['Graphify/Проекты.md'] = ('\n'.join(summary) + '\n').encode()
    project_nodes = [{'id': bridge.stable_id('project:' + s['id']), 'type': 'file', 'file': f'Graphify/Проекты/{s["id"]}.md', 'x': i * 400, 'y': 0, 'width': 340, 'height': 240} for i, s in enumerate(projects)]
    edges = []
    valid = {n['id'] for n in project_nodes}
    for source, target, key, attrs in G.edges(keys=True, data=True):
        a, b = bridge.stable_id(source), bridge.stable_id(target)
        if a in valid and b in valid:
            edges.append({'id': bridge.stable_id(source + target + str(key)), 'fromNode': a, 'toNode': b, 'label': attrs.get('package', 'зависимость')})
    # Shared dependency/content nodes become explicit bridges in the project Canvas.
    canvas_bridges = 0
    for node, attrs in sorted(G.nodes(data=True), key=lambda item: not bool(item[1].get('manual'))):
        if attrs.get('type') not in {'dependency', 'shared_content', 'knowledge'}:
            continue
        owners = sorted({source for source, _ in G.in_edges(node) if bridge.stable_id(source) in valid})
        if len(owners) < 2 and not attrs.get('manual'):
            continue
        if canvas_bridges >= 100:
            continue
        canvas_bridges += 1
        node_id = bridge.stable_id(node)
        project_nodes.append({'id': node_id, 'type': 'text', 'text': attrs['label'] + ('\n\n' + attrs.get('description','') if attrs.get('manual') else ''), 'x': (len(project_nodes) % 4) * 320, 'y': 400 + (len(project_nodes) // 4) * 160, 'width': 280, 'height': 100})
        for owner in owners:
            edges.append({'id': bridge.stable_id(owner + node), 'fromNode': bridge.stable_id(owner), 'toNode': node_id, 'label': 'общий элемент'})
    planned['Graphify/Проекты.canvas'] = (json.dumps({'nodes': project_nodes, 'edges': edges}, ensure_ascii=False, indent=2) + '\n').encode()
    bridge.guarded_export(vault, output / 'projects-export', planned)
    (output / 'GRAPH_REPORT.md').write_text('\n'.join(summary), encoding='utf-8')
    result={'projects':len(projects),'nodes':len(G),'links':G.number_of_edges(),'fingerprint':revision}
    marker.write_text(json.dumps(result)+'\n')
    print(json.dumps(result,ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['index', 'merge'])
    parser.add_argument('--project', type=Path)
    parser.add_argument('--name')
    parser.add_argument('--id')
    parser.add_argument('--vault', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--metadata-only', action='store_true')
    args = parser.parse_args()
    if args.mode == 'index':
        index_project(args.project.resolve(strict=True), args.name, args.id, args.output.resolve(), args.metadata_only)
    else:
        merge(args.output.resolve(), args.vault.resolve(strict=True))
