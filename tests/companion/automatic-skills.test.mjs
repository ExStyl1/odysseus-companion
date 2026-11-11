import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,cpSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {companionPaths} from '../../tools/companion/paths.mjs';
import {configureAutomaticSkills,selectSkills,skillHook} from '../../tools/companion/automatic-skills.mjs';
import {loadSkillsFromDir} from '../../nessy-cli-master/packages/core/dist/src/skills/skill-load.js';
import {workspaceStore,fingerprint} from '../../tools/companion/workspace-store.mjs';
import {installationManager} from '../../tools/companion/installer.mjs';
const put=(p,t)=>{mkdirSync(join(p,'..'),{recursive:true});writeFileSync(p,t)};
test('ordinary Russian Companion requests select the relevant builder or guide',()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'companion-guides-')),p=companionPaths(root);
 try{
  cpSync(new URL('../../companion/skills',import.meta.url),join(p.profile,'extensions/odysseus-companion/skills'),{recursive:true});
  configureAutomaticSkills(p);
  for(const [prompt,name]of [
   ['Создай сценарий для анализа логов','odysseus-scenario-builder'],
   ['Измени субагента ревьюера','odysseus-agent-builder'],
   ['Подбери MCP для задачи','odysseus-tool-advisor'],
   ['Какие инструменты выбрать для ревью','odysseus-tool-advisor'],
   ['Найди в RAG архитектуру проекта','odysseus-knowledge-guide'],
   ['Добавь связь в граф знаний','odysseus-knowledge-guide'],
   ['Создай процесс n8n','odysseus-n8n']])assert.equal(selectSkills(p,prompt)[0]?.name,name,prompt);
  assert.deepEqual(selectSkills(p,'Привет! Как дела?'),[]);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('installed n8n guide is discovered by Nessy, selected ahead of legacy guides and respects disable settings',async()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'n8n-guide-')),p=companionPaths(root);
 try{
  put(join(p.profile,'settings.json'),'{}');
  // Simulate an already installed extension receiving a new bundled skill.
  installationManager(p).install();
  cpSync(new URL('../../companion/skills/odysseus-n8n',import.meta.url),join(root,'companion/skills/odysseus-n8n'),{recursive:true});
  cpSync(new URL('../../companion/catalog-ru.json',import.meta.url),join(root,'companion/catalog-ru.json'));
  installationManager(p).install();
  const directory=join(p.profile,'extensions/odysseus-companion/skills');
  const discovered=await loadSkillsFromDir(directory);
  assert.equal(discovered.length,1);assert.equal(discovered[0].name,'odysseus-n8n');
  assert.notEqual(discovered[0].disableModelInvocation,true);
  const source=readFileSync(join(directory,'odysseus-n8n/SKILL.md'),'utf8');
  for(const [,file]of source.matchAll(/\]\((references\/[^)]+)\)/g))assert.ok(readFileSync(join(directory,'odysseus-n8n',file),'utf8').length);
  for(const name of ['n8n-workflow-agent','n8n:using-tbank-n8n-mcp'])put(join(p.profile,'skills',name.replace(':','-'),'SKILL.md'),`---\nname: ${name}\ndescription: n8n workflows\n---\nLEGACY_N8N_INSTRUCTIONS`);
  configureAutomaticSkills(p);
  for(const prompt of ['Создай локальный n8n процесс','Добавь узел в процесс n8n','Измени workflow на n8n.t-tech.team','Импортируй JSON в н8н']){
   const selected=selectSkills(p,prompt);assert.equal(selected[0].name,'odysseus-n8n');
   assert.ok(!selected.some(s=>['n8n-workflow-agent','n8n:using-tbank-n8n-mcp'].includes(s.name)));
   const context=skillHook(p,{prompt}).hookSpecificOutput.additionalContext;
   assert.ok(context.includes(source.replace(/^---\n[\s\S]*?\n---\n/,'')));
   assert.ok(!context.includes('LEGACY_N8N_INSTRUCTIONS'));
  }
  assert.equal(readFileSync(join(directory,'odysseus-n8n/SKILL.md'),'utf8'),source);
  installationManager(p).install(); // Ownership hashes still match after routing setup.
  const settings=JSON.parse(readFileSync(join(p.profile,'settings.json')));
  settings.skills={disabled:['odysseus-n8n']};put(join(p.profile,'settings.json'),JSON.stringify(settings));
  assert.ok(selectSkills(p,'Создай n8n процесс').some(s=>s.name==='n8n-workflow-agent'));
  assert.ok(!selectSkills(p,'Создай n8n процесс').some(s=>s.name==='odysseus-n8n'));
  settings.skills.disabled=[];settings.extensions={disabled:['odysseus-companion']};put(join(p.profile,'settings.json'),JSON.stringify(settings));
  assert.ok(!selectSkills(p,'Создай n8n процесс').some(s=>s.name==='odysseus-n8n'));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('session skill selection overrides keyword routing and records hashes without modifying profile settings',()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'session-skills-')),p=companionPaths(root),prior=process.env.COMPANION_TASK_SKILL_IDS;
 try{for(const [name,body] of [['systematic-debugging','AUTO_ONLY_BODY'],['manual-review','MANUAL_ONLY_BODY']])put(join(p.profile,'skills',name,'SKILL.md'),`---\nname: ${name}\ndescription: ${name}\n---\n${body}`);put(join(p.profile,'settings.json'),'{}');const configured=configureAutomaticSkills(p);const selected=configured.entries.find(s=>s.name==='manual-review');const before=readFileSync(join(p.profile,'settings.json'),'utf8');process.env.COMPANION_TASK_SKILL_IDS=JSON.stringify([selected.id]);const result=skillHook(p,{prompt:'Ошибка, падает, bug',session_id:'session-test'}).hookSpecificOutput.additionalContext;assert.ok(result.includes('MANUAL_ONLY_BODY'));assert.ok(!result.includes('AUTO_ONLY_BODY'));const record=workspaceStore(p).read().skillSelections.at(-1);assert.equal(record.method,'session-selection');assert.equal(record.selected[0].hash,fingerprint(readFileSync(selected.path,'utf8')));assert.equal(readFileSync(join(p.profile,'settings.json'),'utf8'),before);process.env.COMPANION_TASK_SKILL_IDS='["unknown"]';assert.ok(!skillHook(p,{prompt:'bug'}).hookSpecificOutput.additionalContext.includes('AUTO_ONLY_BODY'));
 }finally{if(prior===undefined)delete process.env.COMPANION_TASK_SKILL_IDS;else process.env.COMPANION_TASK_SKILL_IDS=prior;rmSync(root,{recursive:true,force:true});}
});

test('native Nessy loader discovers formerly explicit-only skills; repeated configuration preserves instructions and avoids duplicate metadata',async()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'auto-skills-'));const p=companionPaths(root);
 try{
  const file=join(p.profile,'skills/writing-plans/SKILL.md');
  const original='---\nname: writing-plans\ndescription: Prepare implementation plans\ndisable-model-invocation: true\nuser-invocable: false\n---\n<!-- odysseus-invocation-policy -->Explicit only<!-- /odysseus-invocation-policy -->\n# Plans\nInspect the current source before proposing edits.\n';
  put(file,original);configureAutomaticSkills(p);
  const first=readFileSync(file,'utf8');configureAutomaticSkills(p);assert.equal(readFileSync(file,'utf8'),first);
  const loaded=await loadSkillsFromDir(join(p.profile,'skills'));
  assert.equal(loaded.length,1);assert.notEqual(loaded[0].disableModelInvocation,true);assert.equal(loaded[0].userInvocable,true);
  assert.ok(first.includes('Inspect the current source'));assert.ok(!first.includes('Explicit only'));
  assert.equal(readFileSync(join(p.profile,'original-auto-selection/skills/writing-plans/SKILL.md'),'utf8'),original);
 }finally{rmSync(root,{recursive:true,force:true})}
});

test('task router distinguishes corporate n8n, local n8n and Camunda and leaves unrelated conversation alone',()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'skill-routing-'));const p=companionPaths(root);
 try{
  const definitions=[['odysseus-companion','RAG and platform'],['n8n-workflow-agent','Local n8n workflows'],['b2b-qa:write-zoya-test','Camunda Zoya tests'],['n8n:using-tbank-n8n-mcp','Corporate n8n workflows']];
  for(const [name,desc]of definitions)put(join(p.profile,'skills',name.replace(':','-'),'SKILL.md'),`---\nname: ${name}\ndescription: ${desc}\n---\nTask-specific instructions.\n`);
  configureAutomaticSkills(p);
  const corporate=selectSkills(p,'Посмотри процессы на n8n.t-tech.team').map(s=>s.name);
  assert.ok(corporate.includes('n8n:using-tbank-n8n-mcp'));assert.ok(!corporate.includes('n8n-workflow-agent'));
  assert.ok(selectSkills(p,'Создай локальный n8n процесс').some(s=>s.name==='n8n-workflow-agent'));
  assert.ok(selectSkills(p,'Напиши тест Camunda Zoya').some(s=>s.name==='b2b-qa:write-zoya-test'));
  assert.deepEqual(skillHook(p,{prompt:'Привет! Как дела?'}),{});
  assert.match(skillHook(p,{prompt:'Покажи n8n.t-tech.team'}).hookSpecificOutput.additionalContext,/corporate_n8n/);
  assert.match(skillHook(p,{prompt:'Покажи n8n.t-tech.team'}).hookSpecificOutput.additionalContext,/Task-specific instructions/);
  const config=JSON.parse(readFileSync(join(p.profile,'companion-auto-skills.json'),'utf8'));
  config.entries.find(s=>s.name==='n8n-workflow-agent').package='disabled-extension';
  put(join(p.profile,'companion-auto-skills.json'),JSON.stringify(config));
  put(join(p.profile,'settings.json'),JSON.stringify({extensions:{disabled:['disabled-extension']},skills:{disabled:['ODYSSEUS-COMPANION']}}));
  assert.ok(!selectSkills(p,'Создай локальный n8n процесс').some(s=>s.name==='n8n-workflow-agent'));
  assert.ok(!selectSkills(p,'Покажи RAG и граф знаний').some(s=>s.name==='odysseus-companion'));
 }finally{rmSync(root,{recursive:true,force:true})}
});
