import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { companionPaths } from '../../tools/companion/paths.mjs';
import { setupCompanion } from '../../tools/companion/setup.mjs';
import { createPlatform } from '../../tools/companion/platform.mjs';
import { redact,readSkill } from '../../tools/companion/catalog.mjs';
import { importNessyModel } from '../../tools/companion/nessy-model.mjs';
import { loadSkillsFromDir } from '../../nessy-cli-master/packages/core/dist/src/skills/skill-load.js';
import { createKnowledgeActions } from '../../tools/automations/gateway.mjs';
function put(file,data){mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,typeof data==='string'?data:JSON.stringify(data));}
function fixture(){
 const base=mkdtempSync(join(realpathSync(tmpdir()),'companion-test-')),root=join(base,'platform'),source=join(base,'backup');
 put(join(source,'settings.json'),{model:{name:'existing-model'},permissions:{allow:['Bash(sudo *)']}});
 put(join(source,'oauth_creds.json'),{access_token:'test-private-token'});
 put(join(source,'skills/original/SKILL.md'),'---\nname: original\ndescription: Original skill\n---\nOriginal');
 put(join(source,'extensions/base/nessy-extension.json'),{name:'base',version:'1',mcpServers:{wiki:{command:'${NESSY_DP}',args:['ai','mcp','wiki']}},agents:'missing-agents'});
 put(join(source,'extensions/base/extension.txt'),'original data');
 put(join(source,'extensions/extension-enablement.json'),{});
 put(join(root,'shared/skills/shared-skill/SKILL.md'),'---\nname: shared-skill\ndescription: Shared skill\n---\nShared');
 put(join(root,'shared/skills-consolidation.json'),{aliases:{}});put(join(root,'shared/user-skills-import.json'),{items:[]});
 put(join(root,'companion/skills/odysseus-companion/SKILL.md'),'---\nname: odysseus-companion\ndescription: Platform integration\n---\nPlatform');
 mkdirSync(join(root,'workspace'),{recursive:true});
 return {base,root,source,paths:companionPaths(root,{ODYSSEUS_COMPANION_HOME:join(base,'state')})};
}
test('setup preserves backup and credentials, deduplicates MCP, and does not overwrite a configured profile on repeat',()=>{
 const f=fixture();try{
  const before=readFileSync(join(f.source,'settings.json'),'utf8');const r=setupCompanion(f.paths,{source:f.source});
  assert.equal(readFileSync(join(f.source,'settings.json'),'utf8'),before);
  assert.equal(JSON.parse(readFileSync(join(r.profile,'oauth_creds.json'))).access_token,'test-private-token');
  const settings=JSON.parse(readFileSync(join(r.profile,'settings.json')));
  assert.equal(settings.model.name,'existing-model');assert.deepEqual(settings.permissions,{allow:[]});
  assert.equal(settings.mcpServers.wiki.command,join(r.profile,'dp_latest/dp'));
  assert.ok(settings.mcpServers['odysseus-companion']);
  const manifest=JSON.parse(readFileSync(join(r.profile,'extensions/base/nessy-extension.json')));
  assert.equal(manifest.mcpServers,undefined);assert.equal(manifest.agents,undefined);
  assert.ok(existsSync(join(r.profile,'original-skills/original/SKILL.md')));
  put(join(r.profile,'skills/shared-skill/SKILL.md'),'User changed this');
  assert.equal(setupCompanion(f.paths,{source:f.source}).alreadyInstalled,true);
  assert.equal(readFileSync(join(r.profile,'skills/shared-skill/SKILL.md'),'utf8'),'User changed this');
 }finally{rmSync(f.base,{recursive:true,force:true})}
});
test('MCP view redacts secrets and skill reads reject arbitrary filesystem paths',()=>{
 assert.deepEqual(redact({env:{API_TOKEN:'private'},headers:{Authorization:'Bearer private'},httpUrl:'https://x.test/api?token=private'}),{env:{API_TOKEN:'[скрыто]'},headers:{Authorization:'[скрыто]'},httpUrl:'https://x.test/api?token=[скрыто]'});
 const f=fixture();try{assert.throws(()=>readSkill(f.paths,'../../oauth_creds.json'),/не найден/)}finally{rmSync(f.base,{recursive:true,force:true})}
});
test('colliding extension skills remain separately loadable by Nessy and wrong gateway cannot receive a cached token',async()=>{
 const f=fixture();try{
  for(const name of ['qa-one','qa-two']){
   put(join(f.source,'extensions',name,'nessy-extension.json'),{name,version:'1'});
   put(join(f.source,'extensions',name,'skills/run-test/SKILL.md'),'---\nname: run-test\ndescription: Run integration tests\n---\nFollow project test instructions.');
  }
  put(join(f.source,'skills/plugin-creator/SKILL.md'),'---\nname: Plugin Creator\ndescription: Create plugins\n---\nCreate requested plugins.');
  setupCompanion(f.paths,{source:f.source});
  const one=await loadSkillsFromDir(join(f.paths.profile,'extensions/qa-one/skills'));
  const two=await loadSkillsFromDir(join(f.paths.profile,'extensions/qa-two/skills'));
  assert.deepEqual([one[0].name,two[0].name],['qa-one:run-test','qa-two:run-test']);
  const general=await loadSkillsFromDir(join(f.paths.profile,'skills'));assert.ok(general.some(s=>s.name==='plugin-creator'));
  put(join(f.paths.profile,'settings.json'),{security:{auth:{selectedType:'dp-auth'}},model:{baseUrl:'https://other.example/v1',name:'test'}});
  assert.throws(()=>importNessyModel(f.paths),/вручную/);
 }finally{rmSync(f.base,{recursive:true,force:true})}
});
test('platform retains project/catalog scope for RAG and validates MCP mutations',async()=>{
 const f=fixture();let platform;
 try{
  setupCompanion(f.paths,{source:f.source});
  put(join(f.paths.automation.home,'config.json'),{version:2,port:0,bridgePort:0,autostart:false,connections:[],sources:[],routes:{}});
  put(join(f.paths.knowledge.output,'graph.json'),{nodes:[{id:'project:a',type:'project',label:'A',source_file:join(f.root,'workspace')},{id:'file:a',type:'file',label:'apples',project_id:'a',description:'apples internal project A'},{id:'project:b',type:'project',label:'B',source_file:join(f.base,'other')},{id:'file:b',type:'file',label:'oranges',project_id:'b',description:'oranges private project B'}],links:[]});
  put(join(f.paths.knowledge.output,'collections.json'),{collections:[{id:'projects',name:'Projects'},{id:'private',name:'Private'}],assignments:{'project:a':'projects','project:b':'private'}});
  platform=await createPlatform(f.paths,{runtimeFactory:async paths=>{const actions=createKnowledgeActions(paths);return {dispatch:async(mode,input)=>actions[mode](input),close:async()=>{}};}});
  const r=await platform.dispatch('search',{collection:'projects',query:'apples oranges'});
  assert.ok(r.matches.some(m=>m.text.includes('apples')));assert.ok(r.matches.every(m=>!m.text.includes('oranges')));
  await assert.rejects(platform.dispatch('search',{collection:'projects',project:'project:b',query:'oranges'}),/не принадлежит/);
  const settings=join(f.paths.profile,'settings.json'),before=readFileSync(settings,'utf8');
  await assert.rejects(platform.dispatch('mcpToggle',{name:'unknown',enabled:true}),/не найден/);assert.equal(readFileSync(settings,'utf8'),before);
  await platform.dispatch('mcpToggle',{name:'wiki',enabled:false});assert.ok(JSON.parse(readFileSync(settings)).mcp.excluded.includes('wiki'));
  await assert.rejects(platform.dispatch('complete',{messages:[]}),/Неизвестная/);
 }finally{await platform?.close();rmSync(f.base,{recursive:true,force:true})}
});
