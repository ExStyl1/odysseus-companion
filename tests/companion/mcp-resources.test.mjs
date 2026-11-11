import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
import {copyMcpRuntime} from '../../tools/companion/copy-mcp-runtime.mjs';
import {companionPaths} from '../../tools/companion/paths.mjs';import {inventoryService} from '../../tools/companion/inventory.mjs';
test('real MCP stdio resource verification reads only an enumerated URI and persists no content or URI token',async()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'mcp-resource-')),paths=companionPaths(root),server=join(root,'server.cjs');paths.localN8n=false;
 try{
  copyMcpRuntime(resolve(import.meta.dirname,'../../nessy-cli-master'),join(root,'mcp'));
  mkdirSync(paths.profile,{recursive:true});const settings={mcpServers:{fixture:{command:process.execPath,args:[server]}}};writeFileSync(join(paths.profile,'settings.json'),JSON.stringify(settings));
  writeFileSync(server,`const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result;if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{},resources:{}},serverInfo:{name:'fixture',version:'1'}};else if(m.method==='tools/list')result={tools:[]};else if(m.method==='resources/list')result={resources:[{uri:'resource://approved?token=secret-value',name:'Approved resource'}]};else if(m.method==='resources/read'){if(m.params.uri!=='resource://approved?token=secret-value')process.exit(2);result={contents:[{uri:m.params.uri,text:'private_resource_content'}]};}else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  const service=inventoryService(paths),listed=await service.probe({name:'fixture',resources:true});assert.equal(listed.status,'ready',listed.error);assert.equal(listed.resources.length,1);assert.ok(!listed.resources[0].uri.includes('secret-value'));
  const checked=await service.resourceRead({name:'fixture',resourceId:listed.resources[0].id,expectedFingerprint:listed.fingerprint});assert.equal(checked.resourceCheck.status,'ready');assert.equal(service.state().servers[0].readiness.resourceVerified,true);
  const raw=readFileSync(join(paths.home,'workspace.json'),'utf8');assert.ok(!raw.includes('private_resource_content'));assert.ok(!raw.includes('secret-value'));
  settings.env={REGION:'changed'};writeFileSync(join(paths.profile,'settings.json'),JSON.stringify(settings));await assert.rejects(()=>service.resourceRead({name:'fixture',resourceId:listed.resources[0].id,expectedFingerprint:listed.fingerprint}),/изменилась/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
