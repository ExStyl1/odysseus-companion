import {execFile} from 'node:child_process'
import {access,readFile,writeFile,chmod} from 'node:fs/promises'
import {constants} from 'node:fs'
import {join,isAbsolute} from 'node:path'
const quote=(value:string)=>`'${value.replace(/'/g, `'"'"'`)}'`
/** Explicitly open macOS Terminal, then wait for the actual CLI process receipt. */
export async function openOdysseusTerminal(root:string,node:string,request:string):Promise<void>{
 if(process.platform!=='darwin')throw new Error('System terminal launcher is configured for macOS')
 if(!isAbsolute(node)||!isAbsolute(request)||!request.endsWith('.json'))throw new Error('Invalid CLI launcher')
 await access(node,constants.X_OK)
 await access(join(root,'tools/run-component.mjs'))
 const command=request.replace(/\.json$/,'.command'),receipt=request.replace(/\.json$/,'.started.json')
 const script=`#!/bin/zsh\nexec ${quote(node)} ${quote(join(root,'tools/run-component.mjs'))} cli --request ${quote(request)}\n`
 await writeFile(command,script,{mode:0o700});await chmod(command,0o700)
 // A file association can open another app or fail to activate Terminal. Select the system app explicitly.
 await new Promise<void>((resolve,reject)=>execFile('/usr/bin/open',['-b','com.apple.Terminal',command],{timeout:10000},error=>error?reject(new Error('macOS could not open Terminal')):resolve()))
 const deadline=Date.now()+15000
 while(Date.now()<deadline){
  try{const started=JSON.parse(await readFile(receipt,'utf8'));if(Number.isInteger(started.pid)&&started.pid>0)return}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
  await new Promise(resolve=>setTimeout(resolve,100))
 }
 throw new Error('Terminal opened but CLI did not confirm startup. Check the Terminal window.')
}
