import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,realpathSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {companionPaths} from '../../tools/companion/paths.mjs';import {systemPackageService} from '../../tools/companion/system-packages.mjs';
test('package installation and rollback preserve model, auth, custom instructions and later unrelated changes',()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'system-package-'));const paths=companionPaths(root);
 const put=(f,v)=>{mkdirSync(join(f,'..'),{recursive:true});writeFileSync(f,typeof v==='string'?v:JSON.stringify(v));};
 try{
  const file=join(paths.profile,'settings.json');const original={model:{name:'own'},security:{auth:'preserve'},permissions:{allow:['Read']},mcpServers:{dpSage:{command:process.execPath}},mcp:{excluded:['dpSage','unrelated']},skills:{disabled:['dp-sage']}};put(file,original);
  put(join(root,'seed/profile/skills/dp-sage/SKILL.md'),'---\nname: dp-sage\ndescription: Sage logs\n---\nRead logs.');
  const service=systemPackageService(paths);let plan=service.preview({id:'sage'});assert.equal(plan.changes.install.length,1);
  const stale=plan.expectedHash;put(file,{...original,changed:true});assert.throws(()=>service.apply({id:'sage',expectedHash:stale}),/изменились/);put(file,original);
  plan=service.preview({id:'sage'});const installed=service.apply({id:'sage',expectedHash:plan.expectedHash});const target=join(paths.profile,'skills/dp-sage/SKILL.md');assert.ok(existsSync(target));assert.equal(service.preview({id:'sage'}).canApply,false);
  let settings=JSON.parse(readFileSync(file));assert.deepEqual(settings.security,original.security);assert.deepEqual(settings.permissions,original.permissions);assert.deepEqual(settings.mcp.excluded,['unrelated']);settings.model.name='later-model';put(file,settings);
  put(target,'manual change');assert.throws(()=>service.rollback({id:installed.id}),/изменён/);assert.equal(readFileSync(target,'utf8'),'manual change');
  put(target,readFileSync(join(root,'seed/profile/skills/dp-sage/SKILL.md'),'utf8'));service.rollback({id:installed.id});assert.ok(!existsSync(target));settings=JSON.parse(readFileSync(file));assert.equal(settings.model.name,'later-model');assert.ok(settings.mcp.excluded.includes('dpSage'));assert.ok(settings.skills.disabled.includes('dp-sage'));assert.equal(service.history()[0].status,'rolled-back');
  put(target,'---\nname: dp-sage\ndescription: Custom\n---\nMy instruction');plan=service.preview({id:'sage'});assert.ok(plan.unchanged.includes('dp-sage'));service.apply({id:'sage',expectedHash:plan.expectedHash});assert.match(readFileSync(target,'utf8'),/My instruction/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
