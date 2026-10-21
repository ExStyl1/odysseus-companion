import {test,expect,mock,afterAll} from 'bun:test'
const snapshot={...await import('node:child_process')}
let calls:{command:string;args:string[]}[]=[]
mock.module('node:child_process',()=>({...snapshot,execFile:(command:string,args:string[],_options:unknown,callback:(error:null)=>void)=>{calls.push({command,args});callback(null)}}))
afterAll(()=>mock.module('node:child_process',()=>({...snapshot})))
test.skipIf(process.platform!=='darwin')('Terminal opens the public od command and resumes only an explicit validated chat',async()=>{
 const {openOdysseusTerminal}=await import('../odysseus-terminal')
 calls=[];await openOdysseusTerminal()
 expect(calls[0].command).toBe('/usr/bin/osascript');expect(calls[0].args[1]).toContain('do script "od"');expect(calls[0].args[1]).not.toContain('.command')
 await openOdysseusTerminal("/tmp/project ' $(never-run)",'chat-id')
 expect(calls[1].args[1]).toContain('od --resume');expect(calls[1].args[1]).toContain('cd --');expect(calls[1].args[1]).toContain(`'\\"'\\"'`)
 await expect(openOdysseusTerminal('relative')).rejects.toThrow('Invalid project')
 await expect(openOdysseusTerminal('/tmp','id;echo')).rejects.toThrow('Invalid CLI session')
 expect(calls.length).toBe(2)
})
