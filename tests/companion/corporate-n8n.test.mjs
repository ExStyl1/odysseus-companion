import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {corporateN8n} from '../../tools/companion/corporate-n8n.mjs';
const reply=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
function fixture(fetchImpl){const home=mkdtempSync(join(realpathSync(tmpdir()),'corporate-n8n-'));return {home,c:corporateN8n({home},{fetchImpl}),close:()=>rmSync(home,{recursive:true,force:true})};}

test('corporate API follows cursor pagination, excludes execution payload, and never stores or returns API secrets',async()=>{
 const seen=[];const f=fixture(async(url,init)=>{
  seen.push({url,init});assert.equal(init.headers['X-N8N-API-KEY'],'private-test-key');assert.equal(init.method,undefined);
  if(url.includes('/executions')){assert.ok(url.includes('includeData=false'));return reply({data:[{id:'e1',workflowId:'a',status:'success',data:{privateCustomer:'must-not-cache'}}]});}
  if(url.includes('cursor=next'))return reply({data:[{id:'b',name:'Second',nodes:[],connections:{}}]});
  return reply({data:[{id:'a',name:'First',nodes:[{name:'HTTP',parameters:{headers:[{name:'X-API-KEY',value:'private-node-secret'}]}}],connections:{}}],nextCursor:'next'});
 });
 try{
  f.c.configure({apiKey:'private-test-key'});await f.c.sync();
  assert.equal(seen.length,3);assert.equal(f.c.workflows().data.length,2);
  const serialized=readFileSync(join(f.home,'corporate-n8n/snapshot.json'),'utf8');
  for(const value of ['private-test-key','private-node-secret','must-not-cache'])assert.ok(!serialized.includes(value));
  assert.equal(f.c.executions().data[0].status,'success');assert.equal(f.c.status().hasApiKey,true);assert.equal(f.c.status().apiKey,undefined);
  assert.ok(!readFileSync(join(f.home,'corporate-n8n/config.json'),'utf8').includes('private-test-key'));
 }finally{f.close()}
});

test('offline failure preserves prior snapshot and changing credentials isolates the cache',async()=>{
 let online=true;const f=fixture(async url=>{
  if(!online)throw Object.assign(Error('network unavailable'),{cause:{code:'ENOTFOUND'}});
  return reply({data:url.includes('/workflows')?[{id:'a',name:'Cached',nodes:[],connections:{}}]:[]});
 });
 try{
  f.c.configure({apiKey:'old-key'});await f.c.sync();online=false;
  await assert.rejects(f.c.sync(),/VPN/);assert.equal(f.c.workflows().data[0].name,'Cached');assert.equal(f.c.status().stale,true);
  f.c.configure({apiKey:'new-key'});assert.equal(f.c.workflows().data.length,0);
  assert.throws(()=>f.c.configure({baseUrl:'http://n8n.t-tech.team'}),/HTTPS/);
 }finally{f.close()}
});

test('execution permissions are reported separately and repeated cursors cannot overwrite the last good snapshot',async()=>{
 let loop=false;const f=fixture(async url=>{
  if(url.includes('/executions'))return new Response('',{status:403});
  return reply({data:[{id:'a',name:'Workflow',nodes:[],connections:{}}],...(loop?{nextCursor:'same'}:{})});
 });
 try{
  f.c.configure({apiKey:'scoped-key'});await f.c.sync();assert.match(f.c.executions().warning,/403/);
  loop=true;await assert.rejects(f.c.sync(),/курсор/);assert.equal(f.c.workflows().data[0].name,'Workflow');
 }finally{f.close()}
});
