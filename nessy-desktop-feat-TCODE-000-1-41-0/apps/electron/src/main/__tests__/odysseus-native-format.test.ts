import {test,expect} from 'bun:test'
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {join,resolve,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {readSessionJsonl} from '@nessy-agent/shared/sessions/jsonl'
import {isValidProviderAuthCombination} from '@nessy-agent/shared/config/llm-connections'
test('CLI projection is readable by the native Desktop parser and uses valid native model/auth pairs',async()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'nessy-native-'));const cliHome=join(root,'cli'),desktopHome=join(root,'desktop'),privateDir=join(root,'private');
 const put=(path:string,value:unknown)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==='string'?value:JSON.stringify(value))}
 try{
  put(join(cliHome,'settings.json'),{modelProviders:{'dp-auth':[{id:'gateway-model',generationConfig:{protocol:'anthropic_messages'}}],anthropic:[{id:'api-model'}]}});
  put(join(desktopHome,'config.json'),{activeWorkspaceId:'ws',workspaceRefs:[{id:'ws'}]});
  put(join(cliHome,'projects/p/chats/one.jsonl'),JSON.stringify({uuid:'one',parentUuid:null,sessionId:'one',cwd:root,type:'user',timestamp:'2026-10-01T00:00:00.000Z',message:{role:'user',parts:[{text:'Literal {{SESSION_PATH}}'}]}})+'\n');
  const module=await import(pathToFileURL(resolve(import.meta.dir,'../../../../../../tools/personal-sync.mjs')).href);
  module.syncPersonal(root,{cliHome,desktopHome,privateDir,settleMs:0});
  const state=JSON.parse(readFileSync(join(privateDir,'state.json'),'utf8'));const pair:any=Object.values(state.chats)[0];const native=readSessionJsonl(pair.desktopPath);
  expect(native?.messages[0]?.content).toBe('Literal {{SESSION_PATH}}');expect(native?.permissionMode).toBe('default');expect(native?.transferredSessionSummary).toContain('Literal {{SESSION_PATH}}');
  const config=JSON.parse(readFileSync(join(desktopHome,'config.json'),'utf8'));
  for(const c of config.llmConnections){expect(isValidProviderAuthCombination(c.providerType,c.authType)).toBe(true);expect(c.models[0].provider).toBe('pi')}
  const gateway=config.llmConnections.find((c:any)=>c.authType==='none');expect(gateway.models[0].wire).toBe('anthropic-messages');
 }finally{rmSync(root,{recursive:true,force:true})}
})
