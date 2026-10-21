import importlib.util, json, sys, tempfile, unittest
from pathlib import Path
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('knowledge', ROOT / 'tools/knowledge/projects.py')
knowledge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(knowledge)
bridge = knowledge.bridge

class KnowledgeTests(unittest.TestCase):
    def test_links_and_user_edits(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); vault=root/'vault'; vault.mkdir(); out=root/'out'
            (vault/'А.md').write_text('# А\n[[Б|Другое имя]]\n```\n[[Нет]]\n```\n[Б](Б.md)\n[[Не существует]]\n')
            (vault/'Б.md').write_text('# Б\n')
            original=(vault/'А.md').read_bytes()
            g,_,missing=bridge.build_graph(vault)
            self.assertEqual(len(g),2);self.assertEqual(g.number_of_edges(),2);self.assertEqual(len(missing),1)
            result=bridge.refresh(vault,out);self.assertEqual(result['notes'],2)
            self.assertEqual((vault/'А.md').read_bytes(),original)
            canvas=json.loads((vault/'Graphify/Карта.canvas').read_text());self.assertEqual(len(canvas['nodes']),2)
            edited=vault/'Graphify/Обзор.md';edited.write_text('Мои правки')
            with self.assertRaisesRegex(ValueError,'user edits'):bridge.refresh(vault,out)
            self.assertEqual(edited.read_text(),'Мои правки')

    def test_real_cross_project_graph_and_incremental_rebuild(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); a=root/'a'; b=root/'b'; vault=root/'vault'; out=root/'knowledge'
            for p in [a,b,vault]:p.mkdir()
            shared_dependencies={'react':'19', **{'lib-'+str(i):'1' for i in range(110)}}
            (a/'package.json').write_text(json.dumps({'name':'frontend','dependencies':{'backend':'workspace:*',**shared_dependencies}}))
            (b/'package.json').write_text(json.dumps({'name':'backend','dependencies':shared_dependencies}))
            (a/'app.py').write_text('def main():\n    return "frontend"\n')
            (b/'app.py').write_text('def main():\n    return "backend"\n')
            (b/'gone.py').write_text('def removed():\n    return 1\n')
            contract='# shared API contract\n'+'def validate_name(name):\n    return bool(name and len(name) > 2)\n'*3
            for p in [a,b]:(p/'contract.py').write_text(contract)
            (vault/'Projects.md').write_text('# Projects\nBackend: '+str(b)+'\n')
            bridge.refresh(vault,out/'notes')
            knowledge.index_project(a,'Frontend','a',out);knowledge.index_project(b,'Backend','b',out)
            (out/'overlay.json').write_text(json.dumps({'nodes':[{'id':'manual:test','label':'Manual decision','description':'ADR-1'}],'annotations':{'project:a':{'label':'User project title','description':'Obsidian explanation'}},'links':[{'source':'project:a','target':'manual:test','relation':'documents','manual':True,'confidence':'USER_RECORDED'}]}))
            knowledge.merge(out,vault)
            g=knowledge.load_graph(out/'graph.json')
            self.assertIn('manual:test',g)
            self.assertEqual(g.nodes['project:a']['description'], 'Obsidian explanation')
            self.assertTrue(any(d.get('relation')=='declares_package_dependency' for _,_,d in g.edges(data=True)))
            self.assertTrue(any(d.get('type')=='shared_content' for _,d in g.nodes(data=True)))
            self.assertTrue(any(d.get('relation')=='mentions_project_path' for _,_,d in g.edges(data=True)))
            import networkx as nx
            self.assertTrue(nx.has_path(g,'project:a','project:a:file:app.py'))
            for project_id in ['a','b']:
                detail=knowledge.load_graph(out/'projects'/project_id/'engine/graphify-out/graph.json')
                self.assertTrue(any(d.get('label')=='main()' for _,d in detail.nodes(data=True)))
            self.assertNotEqual('project:a:file:app.py','project:b:file:app.py')
            canvas=json.loads((vault/'Graphify/Проекты.canvas').read_text());self.assertGreaterEqual(len(canvas['nodes']),4);self.assertTrue(any(n.get('text','').startswith('Manual decision') for n in canvas['nodes']))
            duplicate=root/'duplicate';duplicate.mkdir();(duplicate/'package.json').write_text(json.dumps({'name':'backend'}))
            knowledge.index_project(duplicate,'Duplicate backend','duplicate',out,metadata_only=True)
            knowledge.merge(out,vault)
            ambiguous=knowledge.load_graph(out/'graph.json')
            self.assertFalse(any(d.get('relation')=='declares_package_dependency' for _,_,d in ambiguous.edges(data=True)))
            (b/'gone.py').unlink();knowledge.index_project(b,'Backend','b',out);knowledge.merge(out,vault)
            g=knowledge.load_graph(out/'graph.json');self.assertFalse(any(d.get('label')=='gone.py' for _,d in g.nodes(data=True)))

if __name__=='__main__':unittest.main()
