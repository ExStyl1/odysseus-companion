import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {companionPaths} from '../../tools/companion/paths.mjs';import {taskCatalog} from '../../tools/companion/task-catalog.mjs';import {configureAutomaticSkills} from '../../tools/companion/automatic-skills.mjs';
test('system packages distinguish missing dependencies; task previews reuse router and preserve profile settings',()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'task-catalog-'));const paths=companionPaths(root);
 const put=(f,v)=>{mkdirSync(join(f,'..'),{recursive:true});writeFileSync(f,v);};
 try{
  const settings=join(paths.profile,'settings.json');put(settings,JSON.stringify({model:{name:'mine'},mcpServers:{dpSage:{command:process.execPath}},skills:{disabled:['jira']}}));
  for(const [name,description]of [['dp-sage','Анализ журналов Sage'],['jira','Задачи Jira'],['n8n-workflow-agent','Local n8n workflows']])put(join(paths.profile,'skills',name,'SKILL.md'),`---\nname: ${name}\ndescription: ${description}\n---\nRead task instructions.`);
  configureAutomaticSkills(paths);const before=readFileSync(settings,'utf8');const service=taskCatalog(paths),state=service.state(),sage=state.packages.find(p=>p.id==='sage');
  assert.equal(sage.skills[0].name,'dp-sage');assert.equal(sage.servers[0].status,'unverified');assert.ok(sage.missingSkills.includes('sage-metrics-analyst'));assert.ok(state.packages.find(p=>p.id==='allure').missingServers.includes('dpAllure'));
  const auto=service.preview({prompt:'Подготовь локальный n8n процесс'});assert.ok(auto.skills.some(s=>s.name==='n8n-workflow-agent'));assert.equal(auto.changesProfile,false);
  const manual=service.preview({prompt:'Проанализируй журнал',skillIds:[sage.skills[0].id],mcpNames:['dpSage']});assert.equal(manual.skills.length,1);assert.equal(manual.automatic,false);assert.equal(manual.skills[0].id,sage.skills[0].id);assert.match(manual.preparedPrompt,/dpSage/);
  assert.throws(()=>service.preview({prompt:'Задача',skillIds:['../unknown']}),/недоступен/);
  assert.throws(()=>service.preview({prompt:'Задача',skillIds:[state.skills.find(s=>s.name==='jira').id]}),/недоступен/);
  assert.throws(()=>service.preview({prompt:'Задача',mcpNames:['unknown']}),/отсутствует/);
  assert.deepEqual(service.preview({prompt:'Задача',skillIds:[]}).skills,[]);
  assert.equal(readFileSync(settings,'utf8'),before);
 }finally{rmSync(root,{recursive:true,force:true});}
});
