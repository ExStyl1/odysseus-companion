import {scrubText as scrub} from '../personal/redact-text.mjs';
export {scrub};
/** Product state belongs to Companion. Transactions are serialized across hooks/MCP/UI. */
import {existsSync,openSync,writeFileSync,readFileSync,closeSync,unlinkSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {privateWrite,noLinks} from '../personal/store.mjs';
import {json} from './paths.mjs';
export const uid=()=>randomUUID();
export const now=()=>new Date().toISOString();
export const fingerprint=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
export function text(value,max=1000,{optional=false}={}){if(typeof value!=='string'||value.length>max||(!optional&&!value.trim()))throw Error('Некорректный текст (до '+max+' символов)');return value.trim();}
export function list(value,max=100){if(!Array.isArray(value)||value.length>max)throw Error('Некорректный список');return [...new Set(value.map(x=>text(x,500)))];}
export function day(value){if(value===''||value==null)return '';if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T12:00:00Z'))||new Date(value+'T12:00:00Z').toISOString().slice(0,10)!==value)throw Error('Некорректная дата');return value;}

const initial=()=>({version:1,revision:0,inbox:[],decisions:[],searches:[],exclusions:[],runs:[],agentEvents:[],toolProfiles:[],health:{},boards:[],activity:[]});
export function workspaceStore(paths){
 const file=join(paths.home,'workspace.json'),lock=file+'.lock';
 const read=()=>({...initial(),...json(file)});
 function mutate(fn){
  mkdirSync(paths.home,{recursive:true,mode:0o700});noLinks(file);noLinks(lock);
  if(existsSync(lock)){let pid;try{pid=Number(readFileSync(lock,'utf8'));if(pid>0)process.kill(pid,0);}catch(e){if(e.code==='ESRCH')try{unlinkSync(lock);}catch{}}}
  let fd;for(let attempt=0;attempt<20;attempt++){try{fd=openSync(lock,'wx',0o600);break;}catch(e){if(e.code!=='EEXIST')throw e;if(attempt===19)throw Error('Хранилище занято другой операцией. Повторите действие.');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15);}}
  try{writeFileSync(fd,String(process.pid));const state=read(),result=fn(state);if(result?.then)throw Error('Транзакция должна быть синхронной');state.revision++;privateWrite(file,JSON.stringify(state));return result===undefined?state:result;}finally{closeSync(fd);unlinkSync(lock);}
 }
 return {read,mutate};
}
export function logActivity(s,type,id,detail=''){s.activity.push({id:uid(),type,target:id,detail:scrub(detail).slice(0,1000),at:now()});s.activity=s.activity.slice(-2000);}
