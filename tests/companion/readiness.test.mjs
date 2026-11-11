import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {companionPaths} from '../../tools/companion/paths.mjs';
import {inventoryService} from '../../tools/companion/inventory.mjs';
import {workspaceStore} from '../../tools/companion/workspace-store.mjs';
import {probeFailure} from '../../tools/companion/tool-readiness.mjs';

test('diagnosis distinguishes auth, access, network and unknown failures without guessing from message text',()=>{
 for(const [error,reason] of [[{status:401},'authentication'],[{status:403},'access'],[{cause:{code:'ENOTFOUND'}},'network'],[{code:'CERT_HAS_EXPIRED'},'certificate'],[{code:'TIMEOUT'},'timeout'],[{code:'EACCES'},'local-permission'],[{message:'network auth error'},'protocol']])assert.equal(probeFailure(error).reason,reason);
});
test('inventory expires checks, invalidates environment changes and never claims resource access from MCP discovery',async()=>{
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'companion-readiness-'));
 try{
  const paths=companionPaths(join(dir,'app'),{ODYSSEUS_COMPANION_HOME:join(dir,'state')});
  mkdirSync(paths.profile,{recursive:true});const file=join(paths.profile,'settings.json');
  const settings={mcpServers:{test:{command:process.execPath,args:[]}},env:{CORPORATE_REGION:'one'}};
  const save=()=>writeFileSync(file,JSON.stringify(settings));save();
  let failure;
  const service=inventoryService(paths,{probeImpl:async()=>{if(failure)throw failure;return {tools:1,toolNames:['search']};}});
  assert.equal(service.state().servers[0].readiness.steps.find(s=>s.id==='protocol').status,'unchecked');
  await service.probe({name:'test'});let row=service.state().servers[0];assert.equal(row.status,'ready');assert.equal(row.readiness.resourceVerified,false);assert.equal(row.readiness.steps.at(-1).status,'unchecked');
  settings.env.CORPORATE_REGION='two';save();assert.equal(service.state().servers[0].status,'unverified');
  await service.probe({name:'test'});workspaceStore(paths).mutate(s=>s.health.test.at='2020-01-01T00:00:00Z');assert.equal(service.state().servers[0].status,'unverified');
  failure=Object.assign(Error('https://user:pass@host/?token=secret-value'),{status:401});await service.probe({name:'test'});row=service.state().servers[0];assert.equal(row.readiness.reason,'authentication');assert.ok(!row.check.error.includes('pass'));assert.ok(!row.check.error.includes('secret-value'));
  settings.mcpServers.test.command='/nonexistent/companion-client';save();assert.equal(service.state().servers[0].readiness.reason,'client');
  settings.mcp={excluded:['test']};save();assert.equal(service.state().servers[0].readiness.reason,'disabled');await assert.rejects(()=>service.probe({name:'test'}),/включите/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
