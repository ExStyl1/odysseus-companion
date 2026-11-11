import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,realpathSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {companionPaths} from '../../tools/companion/paths.mjs';import {systemPackageService} from '../../tools/companion/system-packages.mjs';import {workspaceStore} from '../../tools/companion/workspace-store.mjs';
test('interrupted package journal recovers partial installation without touching manual edits or arbitrary paths',()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'package-recovery-')),paths=companionPaths(root);const put=(f,v)=>{mkdirSync(join(f,'..'),{recursive:true});writeFileSync(f,typeof v==='string'?v:JSON.stringify(v));};
 try{
  put(join(paths.profile,'settings.json'),{mcpServers:{dpSage:{command:process.execPath}},mcp:{excluded:['dpSage']}});
  for(const name of ['dp-sage','sage-metrics-analyst'])put(join(root,'seed/profile/skills',name,'SKILL.md'),`---\nname: ${name}\ndescription: Sage\n---\nRead logs`);
  const service=systemPackageService(paths),plan=service.preview({id:'sage'}),installed=service.apply({id:'sage',expectedHash:plan.expectedHash});
  workspaceStore(paths).mutate(s=>s.systemPackageHistory=[]);const journal=join(paths.home,'package-transactions',installed.id+'.json');const raw=JSON.parse(readFileSync(journal));raw.status='applying';put(journal,raw);
  rmSync(join(paths.profile,'skills/sage-metrics-analyst'),{recursive:true});assert.equal(service.pending().length,1);
  const target=join(paths.profile,'skills/dp-sage/SKILL.md');put(target,'Manual changes');const blocked=service.recoveryPreview({id:installed.id});assert.equal(blocked.canRecover,false);assert.throws(()=>service.recover({id:installed.id,expectedHash:blocked.expectedHash}),/правки/);assert.equal(readFileSync(target,'utf8'),'Manual changes');
  put(target,readFileSync(join(root,'seed/profile/skills/dp-sage/SKILL.md'),'utf8'));const ready=service.recoveryPreview({id:installed.id});assert.deepEqual(ready.removeSkills,['dp-sage']);service.recover({id:installed.id,expectedHash:ready.expectedHash});assert.equal(service.pending().length,0);assert.ok(!existsSync(target));assert.ok(JSON.parse(readFileSync(join(paths.profile,'settings.json'))).mcp.excluded.includes('dpSage'));
  workspaceStore(paths).mutate(s=>s.systemPackageHistory=[]);raw.changes.install[0].target=join(root,'outside/SKILL.md');put(journal,raw);assert.throws(()=>service.recoveryPreview({id:installed.id}),/неизвестный путь/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
