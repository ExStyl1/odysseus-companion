import {test,expect,mock,afterAll} from 'bun:test'
import {mkdtempSync,realpathSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
const snapshot={...await import('node:child_process')}
let call:{command:string;args:string[]}|undefined
mock.module('node:child_process',()=>({...snapshot,execFile:(command:string,args:string[],_options:unknown,callback:(error:null)=>void)=>{
 call={command,args};writeFileSync(args.at(-1)!.replace(/\.command$/,'.started.json'),JSON.stringify({pid:process.pid}));callback(null)
}}))
afterAll(()=>mock.module('node:child_process',()=>({...snapshot})))
test.skipIf(process.platform!=='darwin')('system launcher explicitly selects macOS Terminal and waits for a CLI receipt',async()=>{
 const directory=mkdtempSync(join(realpathSync(tmpdir()),"nessy-terminal-quote'-")),request=join(directory,'session.json'),root=resolve(import.meta.dir,'../../../../../..');
 writeFileSync(request,JSON.stringify({cwd:root}));
 try{
  const {openOdysseusTerminal}=await import('../odysseus-terminal')
  await openOdysseusTerminal(root,process.execPath,request)
  expect(call?.command).toBe('/usr/bin/open');expect(call?.args.slice(0,2)).toEqual(['-b','com.apple.Terminal']);
  const command=request.replace(/\.json$/,'.command'),script=readFileSync(command,'utf8');expect(script).toContain('cli --request');expect(script).toContain(`'"'"'`)
  snapshot.execFileSync('/bin/zsh',['-n',command])
 }finally{rmSync(directory,{recursive:true,force:true})}
})
