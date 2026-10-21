import {test,expect,mock,afterAll} from 'bun:test'
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,cpSync,rmSync} from 'node:fs'
import {join,resolve,dirname} from 'node:path'
import {tmpdir} from 'node:os'
const electronSnapshot={...await import('electron')}
const terminalSnapshot={...await import('../odysseus-terminal')}
const credentialSnapshot={...await import('@nessy-agent/shared/credentials')}
afterAll(()=>{
 mock.module('electron',()=>({...electronSnapshot}))
 mock.module('../odysseus-terminal',()=>({...terminalSnapshot}))
 mock.module('@nessy-agent/shared/credentials',()=>({...credentialSnapshot}))
})
const handlers=new Map<string,(...args:any[])=>any>()
let opened='',stop=()=>{}
mock.module('../odysseus-terminal',()=>({...terminalSnapshot,openOdysseusTerminal:async(_root:string,_node:string,request:string)=>{opened=request}}))
mock.module('electron',()=>({
  ...electronSnapshot,
  app:{once:(_event:string,fn:()=>void)=>{stop=fn}},
  ipcMain:{handle:(name:string,fn:(...args:any[])=>any)=>{handlers.set(name,fn)}},
  shell:{openPath:async(path:string)=>{opened=path;return ''}},
}))
mock.module('@nessy-agent/shared/credentials',()=>({...credentialSnapshot,getCredentialManager:()=>({
  getLlmApiKey:async()=>null,setLlmApiKey:async()=>{},
})}))
test('local bridge rejects untrusted frames and foreign sessions; CLI handoff creates only a fixed launcher',async()=>{
 const fixture=mkdtempSync(join(realpathSync(tmpdir()),'nessy-handoff-')),root=join(fixture,'root');
 const saved={...process.env};
 const put=(path:string,value:unknown)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==='string'?value:JSON.stringify(value))}
 const cliHome=join(fixture,'cli'),desktopHome=join(fixture,'desktop'),privateDir=join(fixture,'private'),cwd=join(fixture,"project ' $(never-execute)");mkdirSync(cwd);
 const source=resolve(import.meta.dir,'../../../../../../tools');mkdirSync(join(root,'tools'),{recursive:true});
 for(const file of ['personal-sync','personal-store','personal-chats','personal-models','personal-secrets','profile','personal-worker'])cpSync(join(source,file+'.mjs'),join(root,'tools',file+'.mjs'));
 put(join(root,'odysseus.json'),{schemaVersion:1,sharedDirectory:'shared',components:{cli:{source:'cli'},desktop:{source:'desktop'}}});
 put(join(root,'shared/skills-catalog.json'),{entries:[{name:'fixture-skill'}]});
 put(join(cliHome,'settings.json'),{});put(join(desktopHome,'config.json'),{activeWorkspaceId:'ws',workspaceRefs:[{id:'ws'}]});
 put(join(desktopHome,'sessions/ws/chat-one/session.jsonl'),JSON.stringify({id:'chat-one',workspaceId:'ws',createdAt:1,workingDirectory:cwd,name:'Handoff'})+'\n'+JSON.stringify({id:'user-one',type:'user',content:'Continue here',timestamp:2})+'\n');
 process.env.ODYSSEUS_ROOT=root;process.env.ODYSSEUS_NODE=process.execPath;process.env.NESSY_HOME=cliHome;delete process.env.NESSY_RUNTIME_DIR;process.env.NESSY_CONFIG_DIR=desktopHome;process.env.ODYSSEUS_DATA_DIR=privateDir;
 const frame={},event={sender:{id:1,mainFrame:frame},senderFrame:frame};let busy=false;
 try{
  const {registerOdysseusIntegration}=await import('../odysseus-integration');
  registerOdysseusIntegration({windowManager:{getWorkspaceForWindow:(id:number)=>id===1?'ws':null},sessionManager:{
   refreshConnectionRuntime:async()=>{},waitForInit:async()=>{},getSessions:()=>{throw new Error('Expensive UI projection called during sync')},flushSession:async()=>{},flushOdysseusIdleSessions:async()=>{},getOdysseusProtectedSessions:()=>['ws/chat-one'],refreshOdysseusSessions:()=>{},
   getSession:async(id:string,ws:string)=>id==='chat-one'&&ws==='ws'?{id,workspaceId:ws,workingDirectory:cwd,messages:[{content:'Continue here'}],isProcessing:busy}:null,
  }} as any);
  await expect(handlers.get('odysseus:skill-prompt')!(event,'../outside')).rejects.toThrow('Invalid skill');
  await expect(handlers.get('odysseus:skill-prompt')!(event,'missing')).rejects.toThrow('Skill not found');
  expect(await handlers.get('odysseus:skill-prompt')!(event,'fixture-skill')).toContain(join(root,'shared/skills/fixture-skill/SKILL.md'));
  await expect(handlers.get('odysseus:status')!({...event,senderFrame:{}})).rejects.toThrow('Untrusted');
  await expect(handlers.get('odysseus:cli')!(event,'../../escape')).rejects.toThrow('Invalid session');
  await expect(handlers.get('odysseus:cli')!(event,'foreign')).rejects.toThrow('Session not found');
  busy=true;await expect(handlers.get('odysseus:cli')!(event,'chat-one')).rejects.toThrow('Stop');busy=false;
  const pendingSync=handlers.get('odysseus:sync')!(event);
  const immediateStatus=await Promise.race([handlers.get('odysseus:status')!(event),new Promise((_,reject)=>setTimeout(()=>reject(Error('UI status blocked by synchronization')),50))]);
  expect(immediateStatus.enabled).toBe(true);
  const status=await pendingSync;expect(status.error).toBeUndefined();
  await expect(handlers.get('odysseus:cli')!(event,'chat-one')).resolves.toEqual({opened:true});
  expect(opened.startsWith(join(privateDir,'launch'))).toBe(true);
  const request=JSON.parse(readFileSync(opened,'utf8'));expect(request.cwd).toBe(cwd);expect(request.cliId).toMatch(/^[a-z0-9-]+$/);
  const state=JSON.parse(readFileSync(join(privateDir,'state.json'),'utf8'));const pair:any=Object.values(state.chats)[0];expect(readFileSync(pair.cliPath,'utf8')).toContain('Continue here');
 }finally{
  stop();for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);rmSync(fixture,{recursive:true,force:true});
 }
})
