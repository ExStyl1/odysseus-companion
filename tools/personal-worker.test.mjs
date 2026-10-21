import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
const put=(path,value)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==='string'?value:JSON.stringify(value))};
test('background scanning leaves the parent event loop responsive and repeated requests are idempotent',async t=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'nessy-sync-worker-'));
 const cliHome=join(root,'cli'),desktopHome=join(root,'desktop');put(join(root,'odysseus.json'),{schemaVersion:1,sharedDirectory:'shared',components:{cli:{source:'cli-source'},desktop:{source:'desktop-source'}}});
 put(join(cliHome,'settings.json'),{});put(join(desktopHome,'config.json'),{activeWorkspaceId:'ws',workspaceRefs:[{id:'ws'}]});
 for(let i=0;i<700;i++)put(join(root,'shared/skills',`skill-${i}`,'SKILL.md'),'# Test\n'+'Resource\n'.repeat(50));
 const child=fork(join(import.meta.dirname,'personal-worker.mjs'),[root],{env:{...process.env,NESSY_HOME:cliHome,NESSY_CONFIG_DIR:desktopHome,ODYSSEUS_DATA_DIR:join(root,'private')},stdio:['ignore','ignore','ignore','ipc']});
 t.after(()=>{child.kill();rmSync(root,{recursive:true,force:true})});
 const request=id=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('Background sync timed out')),15000);
  const listen=m=>{if(m.id===id){clearTimeout(timer);child.off('message',listen);m.error?reject(Error(m.error)):resolve(m)}};
  child.on('message',listen);child.send({type:'sync',id});
 });
 let ticks=0;const heartbeat=setInterval(()=>ticks++,1);
 const first=await request(1);clearInterval(heartbeat);
 assert.ok(ticks>2,'parent continued processing input while the worker scanned files');assert.ok(first.result.applied);
 const second=await request(2);assert.equal(second.result.changes.length,0);assert.equal(second.sharedChanges,0);
});
