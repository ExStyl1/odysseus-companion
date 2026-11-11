import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,readFileSync,rmSync,realpathSync,cpSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {companionPaths} from '../../tools/companion/paths.mjs';
import {installationManager} from '../../tools/companion/installer.mjs';
import {createObserver} from '../../tools/companion/observer.mjs';
import {personal} from '../../tools/companion/personal.mjs';
import {workflowTransfer} from '../../tools/companion/workflow-transfer.mjs';
import {localFirstContext} from '../../tools/companion/retrieval.mjs';
import {loadSkillsFromDir} from '../../nessy-cli-master/packages/core/dist/src/skills/skill-load.js';
import {SubagentManager} from '../../nessy-cli-master/packages/core/dist/src/subagents/subagent-manager.js';
const repo=resolve(import.meta.dirname,'../..');
function fixture(){const base=mkdtempSync(join(realpathSync(tmpdir()),'companion-product-'));const paths=companionPaths(join(base,'platform'),{ODYSSEUS_COMPANION_HOME:join(base,'home'),ODYSSEUS_COMPANION_STANDALONE:'1'});mkdirSync(paths.profile,{recursive:true});return {base,paths};}
const put=(p,v)=>{mkdirSync(join(p,'..'),{recursive:true});writeFileSync(p,typeof v==='string'?v:JSON.stringify(v));};
const event=(id,type='assistant',extra={})=>({uuid:id,sessionId:'session-1',timestamp:new Date().toISOString(),cwd:'/project',type,message:{role:type,parts:[{text:'Локальная база знаний: проверен контракт API.'},{thought:true,text:'private reasoning'}]},...extra});
test('additive installation preserves user settings, is repeatable, and native Nessy parsers load shipped skills/agents',async()=>{
 const {base,paths}=fixture();try{
  cpSync(join(repo,'companion'),join(paths.root,'companion'),{recursive:true});
  put(join(paths.profile,'settings.json'),{model:{name:'selected'},permissions:{allow:['Read']},mcpServers:{wiki:{command:'custom-wiki'},local:{command:'node',env:{API_TOKEN:'private-value'}}},mcp:{excluded:['local']},hooks:{Stop:[{hooks:[{command:'user-hook'}]}]}});
  put(join(paths.profile,'extensions/source/agents/library-agent.md'),'---\nname: library-agent\ndescription: Analyze source contracts\n---\nRead the assigned files.');
  const target=join(base,'existing-nessy');const original={model:{name:'own'},permissions:{allow:['Bash(test)']},security:{auth:{selectedType:'dp-auth'}},mcpServers:{wiki:{command:'own-wiki'}},hooks:{Stop:[{hooks:[{command:'own-hook'}]}]}};put(join(target,'settings.json'),original);put(join(target,'oauth_creds.json'),'private-auth');
  const manager=installationManager(paths);manager.install({profile:target});manager.install({profile:target});
  const settings=JSON.parse(readFileSync(join(target,'settings.json')));
  for(const k of ['model','permissions','security'])assert.deepEqual(settings[k],original[k]);assert.equal(settings.mcpServers.wiki.command,'own-wiki');assert.ok(!JSON.stringify(settings).includes('private-value'));assert.equal(settings.hooks.Stop.length,2);assert.ok(settings.mcp.excluded.includes('local'));assert.equal(readFileSync(join(target,'oauth_creds.json'),'utf8'),'private-auth');
  const ext=join(target,'extensions/odysseus-companion');const skills=await loadSkillsFromDir(join(ext,'skills'));assert.ok(skills.some(s=>s.name==='odysseus-subagents'&&!s.disableModelInvocation));
  const native=new SubagentManager({});const names=[];for(const f of readdirSync(join(ext,'agents'))){const a=native.parseSubagentContent(readFileSync(join(ext,'agents',f),'utf8'),join(ext,'agents',f),'extension');names.push(a.name);}assert.equal(new Set(names).size,readdirSync(join(repo,'companion/agents')).length+1);assert.ok(names.includes('library-agent'));
  appendFileSync(join(ext,'agents/odysseus-qa.md'),'\nUser edit');assert.throws(()=>manager.install({profile:target}),/изменены вручную/);
 }finally{rmSync(base,{recursive:true,force:true});}
});
test('observer ignores old backup logs, tails complete lines, redacts secrets, resumes after restart and does not double-count usage',()=>{
 const {base,paths}=fixture();try{
  const log=join(paths.profile,'projects/p/chats/s.jsonl');put(log,JSON.stringify(event('old'))+'\n');const captures=[];const observer=createObserver(paths,{save:r=>captures.push(r)});observer.scan();assert.equal(captures.length,0);
  const e=event('new','assistant',{message:{parts:[{text:'API_KEY=private-key; готово'},{thought:true,text:'private reasoning'}]},usageMetadata:{totalTokenCount:120,promptTokenCount:100,candidatesTokenCount:20}}),line=JSON.stringify(e);
  appendFileSync(log,line.slice(0,80));observer.scan();assert.equal(captures.length,0);appendFileSync(log,line.slice(80)+'\n');observer.scan();assert.equal(captures.length,1);assert.ok(!captures[0].text.includes('private-key'));assert.ok(!captures[0].text.includes('private reasoning'));
  const usage=join(paths.profile,'usage_record.jsonl');put(usage,JSON.stringify({sessionId:'session-1',timestamp:Date.now(),models:{model:{totalTokens:150,inputTokens:110,outputTokens:40}}})+'\n');observer.scan();assert.equal(observer.usage().sessions[0].totalTokens,150);
  const restarted=createObserver(paths,{save:r=>captures.push(r)});restarted.scan();assert.equal(captures.length,1);appendFileSync(log,JSON.stringify(e)+'\n');restarted.scan();assert.equal(captures.length,1);assert.equal(restarted.usage().sessions[0].totalTokens,150);
  restarted.setEnabled(false);appendFileSync(log,JSON.stringify(event('paused'))+'\n');restarted.scan();assert.equal(captures.length,1);
  // Observer has not modified Nessy's input files or created project-side knowledge directories.
  assert.equal(readFileSync(log,'utf8').split('\n').filter(Boolean).length,4);
 }finally{rmSync(base,{recursive:true,force:true});}
});
test('observer retries failed knowledge writes without dropping the input record and recovers a stale lock',()=>{
 const {base,paths}=fixture();try{
  let fail=true,count=0;const o=createObserver(paths,{save:()=>{if(fail)throw Error('disk busy');count++;}});const log=join(paths.profile,'projects/p/chats/new.jsonl');put(log,JSON.stringify(event('one'))+'\n');assert.match(o.scan().error,/disk busy/);assert.equal(count,0);fail=false;o.scan();assert.equal(count,1);put(join(paths.home,'observer.json.lock'),'99999999');o.scan();assert.equal(count,1);
 }finally{rmSync(base,{recursive:true,force:true});}
});
test('calendar/preferences persist locally, reject invalid values, and deletion removes only the selected note',()=>{
 const {base,paths}=fixture();try{const p=personal(paths);p.update({date:'2026-11-10',text:'Личный план',theme:'light',accent:'blue'});p.update({date:'2026-11-11',text:'Задача'});assert.equal(personal(paths).read().notes['2026-11-10'].text,'Личный план');p.update({date:'2026-11-10',text:''});assert.equal(p.read().notes['2026-11-10'],undefined);assert.ok(p.read().notes['2026-11-11']);assert.throws(()=>p.update({date:'2026-02-31',text:'bad'}));assert.throws(()=>p.update({theme:'custom-script'}));}finally{rmSync(base,{recursive:true,force:true});}
});
test('offline workflow exchange validates all imports atomically, deduplicates and syncs only inactive drafts',async()=>{
 const {base,paths}=fixture();try{
  let running=false,saves=0;const drafts=[];const runtime={status:()=>({engine:{running}}),dispatch:async(mode,i)=>{if(mode==='workflowList')return {data:drafts};if(mode==='workflowGet')return drafts.find(w=>w.id===i.id);if(mode==='workflowSave'){saves++;const w={id:'draft'+saves,active:false,...i.workflow};drafts.push(w);return w;}throw Error('Unexpected action '+mode);}};
  const t=workflowTransfer(paths,runtime),workflow={name:'Offline task',nodes:[{name:'Start',type:'n8n-nodes-base.manualTrigger',credentials:{id:'secret'},parameters:{headers:[{name:'Authorization',value:'private-header'}]}}],connections:{}};
  assert.equal(t.ingest({workflows:[workflow]}).added,1);assert.equal(t.ingest({workflows:[workflow]}).added,0);assert.equal((await t.exportAll()).workflows[0].nodes[0].credentials,undefined);assert.ok(!JSON.stringify(await t.exportAll()).includes('private-header'));await assert.rejects(t.sync(),/Запустите/);assert.throws(()=>t.ingest({workflows:[{...workflow,name:'Another'},{}]}));assert.equal(t.status().entries.length,1);running=true;assert.equal((await t.sync()).applied,1);assert.equal((await t.sync()).applied,0);assert.equal(saves,1);assert.equal(drafts[0].active,false);
 }finally{rmSync(base,{recursive:true,force:true});}
});
test('automatic context performs local retrieval first, cites sources and excludes user prompt echoes',async()=>{
 const {base,paths}=fixture();try{const calls=[];const text=await localFirstContext(paths,{prompt:'контракт импорта',cwd:'/project'},{search:async(p,i)=>{calls.push(i);return {indexedAt:'2026-11-10',matches:[{title:'Question',text:'Роль: user\nконтракт импорта',source:'question'},{title:'Import API',text:'Локальный контракт v1',source:'/repo/api.md',nodeId:'api'}]};}});assert.equal(calls.length,1);assert.equal(calls[0].query,'контракт импорта');assert.ok(text.includes('/repo/api.md'));assert.ok(!text.includes('Источник: question'));assert.ok(text.includes('К внешнему поиску переходи'));const fallback=await localFirstContext(paths,{prompt:'test'},{search:async()=>{throw Error('Unavailable')}});assert.ok(fallback.includes('недоступен'));}finally{rmSync(base,{recursive:true,force:true});}
});
