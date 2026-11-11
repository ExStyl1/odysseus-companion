import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {companionPaths} from '../../tools/companion/paths.mjs';
import {prepareStandalone} from '../../tools/companion/standalone.mjs';
import {preferredNessyProfile} from '../../tools/companion/nessy-discovery.mjs';
const put=(p,data)=>{mkdirSync(join(p,'..'),{recursive:true});writeFileSync(p,typeof data==='string'?data:JSON.stringify(data))};

test('fresh standalone app initializes without the development folder and retains user settings across relocation',()=>{
 const base=mkdtempSync(join(realpathSync(tmpdir()),'companion-portable-')),root=join(base,'App Resources/platform');
 const home=join(base,'Application Support/Companion');const paths=companionPaths(root,{ODYSSEUS_COMPANION_HOME:home,ODYSSEUS_COMPANION_STANDALONE:'1'});
 try{
  put(join(root,'seed/profile/settings.json'),{model:{name:'original-model'},mcpServers:{},hooks:{}});
  put(join(root,'seed/profile/skills/planning/SKILL.md'),'---\nname: planning\ndescription: Prepare plans\n---\nPlan the requested work.');
  put(join(root,'companion/skills/odysseus-companion/SKILL.md'),'---\nname: odysseus-companion\ndescription: Companion knowledge\n---\nUse local knowledge.');
  prepareStandalone(paths,{userDirectory:base,legacyHome:join(base,'missing-backup'),previousRoot:join(base,'missing-repo'),node:'/Applications/Companion.app/Contents/Resources/node'});
  assert.ok(existsSync(join(paths.profile,'skills/odysseus-companion/SKILL.md')));
  assert.ok(existsSync(join(home,'standalone-installation.json')));
  assert.equal(paths.knowledge.runtime,join(home,'graphify'));assert.equal(paths.knowledge.python,join(root,'python/run'));
  const file=join(paths.profile,'settings.json'),settings=JSON.parse(readFileSync(file));
  assert.ok(settings.mcpServers['odysseus-companion'].args[0].startsWith(root));
  settings.model.name='user-choice';settings.hooks.UserPromptSubmit.push({hooks:[{type:'command',command:'user-owned-hook'}]});put(file,settings);
  prepareStandalone(paths,{userDirectory:base,node:'/Applications/Companion.app/Contents/Resources/node'});
  const after=JSON.parse(readFileSync(file));assert.equal(after.model.name,'user-choice');assert.ok(JSON.stringify(after.hooks).includes('user-owned-hook'));
  const launcher=readFileSync(join(home,'Открыть Nessy с Companion.command'),'utf8');assert.ok(!launcher.includes('missing-repo'));assert.ok(launcher.includes('ODYSSEUS_COMPANION_STANDALONE=1'));
  const extension=join(paths.profile,'extensions/odysseus-companion/nessy-extension.json');const manual=readFileSync(extension,'utf8')+'\n';put(extension,manual);const marker=join(home,'standalone-installation.json'),prior=JSON.parse(readFileSync(marker));prior.resourcesVersion=5;put(marker,prior);const migration=prepareStandalone(paths,{userDirectory:base,node:'/Applications/Companion.app/Contents/Resources/node'});assert.ok(migration.migrationWarnings.length);assert.equal(readFileSync(extension,'utf8'),manual);assert.equal(JSON.parse(readFileSync(file)).model.name,'user-choice');
  put(extension,manual.slice(0,-1));const custom=join(paths.profile,'extensions/odysseus-companion/my-rules.md');put(custom,'Keep my additions');prior.resourcesVersion=5;put(marker,prior);const preserved=prepareStandalone(paths,{userDirectory:base,node:'/Applications/Companion.app/Contents/Resources/node'});assert.ok(preserved.migrationWarnings.some(message=>message.includes('my-rules.md')));assert.equal(readFileSync(custom,'utf8'),'Keep my additions');
 }finally{rmSync(base,{recursive:true,force:true})}
});

test('standalone connects an existing .nessy once and preserves its settings and history', () => {
 const base=mkdtempSync(join(realpathSync(tmpdir()),'companion-discovery-'));
 const root=join(base,'platform'), profile=join(base,'.nessy');
 const paths=companionPaths(root,{ODYSSEUS_COMPANION_HOME:join(base,'companion'),ODYSSEUS_COMPANION_STANDALONE:'1'});
 try {
  const settings={model:{name:'existing'},permissions:{allow:['Read']},mcpServers:{existing:{command:'existing'}},hooks:{Stop:[{hooks:[{command:'user-hook'}]}]}};
  put(join(profile,'settings.json'),settings);
  put(join(profile,'projects/example/chats/history.jsonl'),'existing history');
  put(join(root,'companion-release.json'),{version:'0.8.7',localN8n:false});
  put(join(root,'seed/profile/settings.json'),{mcpServers:{unrelated:{command:'unrelated'}}});
  put(join(root,'companion/skills/odysseus-companion/SKILL.md'),'---\nname: odysseus-companion\ndescription: Companion\n---\nRead knowledge.');
  const first=prepareStandalone(paths,{userDirectory:base});
  assert.equal(first.nessyConnection.profile,profile);
  assert.equal(preferredNessyProfile(paths),profile);
  const current=readFileSync(join(profile,'settings.json'),'utf8');
  const after=JSON.parse(current);
  assert.deepEqual(after.model,settings.model);
  assert.deepEqual(after.permissions,settings.permissions);
  assert.deepEqual(after.mcpServers.existing,settings.mcpServers.existing);
  assert.equal(after.mcpServers.unrelated,undefined);
  assert.equal(after.hooks.Stop.length,2);
  assert.equal(readFileSync(join(profile,'projects/example/chats/history.jsonl'),'utf8'),'existing history');
  prepareStandalone(paths,{userDirectory:base});
  assert.equal(readFileSync(join(profile,'settings.json'),'utf8'),current);
 } finally {rmSync(base,{recursive:true,force:true});}
});
