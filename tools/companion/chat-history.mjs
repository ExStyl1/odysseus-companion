import {chatOrganizer} from './chat-organizer.mjs';
import {existsSync,readFileSync,statSync,realpathSync} from 'node:fs';
import {join,relative,isAbsolute} from 'node:path';
import {chatJournals} from './catalog.mjs';
import {json} from './paths.mjs';
import {privateWrite} from '../personal/store.mjs';
import {randomUUID} from 'node:crypto';
import {fingerprint,scrub,text} from './workspace-store.mjs';
const visible=r=>(r.message?.parts||[]).filter(p=>typeof p.text==='string'&&!p.thought).map(p=>p.text).join('\n');
export function chatHistory(paths){
 const cache=new Map(),organizer=chatOrganizer(paths);
 function profiles(){return [...new Set([paths.profile,...(json(join(paths.home,'attached-profiles.json')).profiles||[]).map(p=>p.path)])].filter(existsSync);}
 function files(){return profiles().flatMap(profile=>chatJournals(profile).map(file=>({profile,file,id:fingerprint(profile+'\n'+relative(profile,file))})));}
 function parse(found){
  const st=statSync(found.file);const sig=st.mtimeMs+':'+st.size;const prior=cache.get(found.id);if(prior?.signature===sig)return prior;
  if(st.size>32*1024*1024)return {...found,signature:sig,title:'Большая сессия',project:'',sessionId:'',startedAt:new Date(st.birthtimeMs||st.mtimeMs).toISOString(),messageCount:0,totalTokens:null,messages:[],unavailable:'Журнал превышает 32 МБ; откройте его в Nessy',updatedAt:new Date(st.mtimeMs).toISOString()};
  const messages=[];let malformed=0,title='',cwd='',sessionId='',startedAt='',updatedAt='',tokens=0,hasTokens=false;
  for(const line of readFileSync(found.file,'utf8').split('\n')){if(!line.trim())continue;let r;try{r=JSON.parse(line);}catch{malformed++;continue;}
   if(!sessionId&&typeof r.sessionId==='string')sessionId=r.sessionId;if(!cwd&&typeof r.cwd==='string')cwd=r.cwd;
   const stamp=new Date(r.timestamp);if(Number.isFinite(stamp.getTime())){const iso=stamp.toISOString();startedAt=!startedAt||iso<startedAt?iso:startedAt;updatedAt=iso>updatedAt?iso:updatedAt;}
   if(r.subtype==='custom_title'){const candidate=r.title||r.customTitle||visible(r);if(typeof candidate==='string'&&candidate.trim())title=scrub(candidate).slice(0,160);}
   if(['user','assistant'].includes(r.type)&&!r.subtype){const body=visible(r);const commands=(r.message?.parts||[]).filter(p=>!p.thought).flatMap(p=>{const c=p.functionCall||(p.type==='tool_use'?{name:p.name,args:p.input}:null);const a=c?.args||c?.arguments;return c&&/shell|bash|exec|terminal/i.test(c.name||'')&&typeof a?.command==='string'?[scrub(a.command).slice(0,4000)]:[];});if(body.trim()||commands.length){messages.push({id:String(r.uuid||messages.length),role:r.type,commands,text:scrub(body).slice(0,60000),textTruncated:body.length>60000,at:r.timestamp||'',model:r.model||'',usage:r.usageMetadata||null});if(!title&&r.type==='user')title=scrub(body).replace(/\s+/g,' ').slice(0,100);}}
   if(r.usageMetadata?.totalTokenCount!==undefined){tokens+=Number(r.usageMetadata.totalTokenCount)||0;hasTokens=true;}
  }
  const result={...found,signature:sig,title:title||'Чат без названия',sessionId,project:cwd,startedAt:startedAt||new Date(st.birthtimeMs||st.mtimeMs).toISOString(),updatedAt:updatedAt||new Date(st.mtimeMs).toISOString(),messages,messageCount:messages.length,totalTokens:hasTokens?tokens:null,malformed};cache.set(found.id,result);if(cache.size>200)cache.delete(cache.keys().next().value);return result;
 }
 function lookup(id){const found=files().find(f=>f.id===id);if(!found)throw Error('Чат не найден в подключённых профилях');const actual=realpathSync(found.file),rel=relative(realpathSync(found.profile),actual);if(isAbsolute(rel)||rel==='..'||rel.startsWith('../'))throw Error('Журнал вне профиля');return parse(found);}
 function summary(r){const {messages,signature,file,profile,...safe}=r;let projectAvailable=false;try{projectAvailable=!!r.project&&statSync(r.project).isDirectory();}catch{}return {...safe,projectAvailable,profileName:profile===paths.profile?'Nessy Companion':profile.split('/').at(-1)};}
 function list(i={}){const q=String(i.query||'').toLowerCase(),all=organizer.group(files().map(parse));const rows=all.data.filter(r=>(!i.folder||r.folder.id===i.folder)&&(!i.minRating||r.rating>=Number(i.minRating))&&(!i.project||r.project===i.project)&&(!q||(r.title+' '+r.project).toLowerCase().includes(q))&&(!i.from||r.updatedAt.slice(0,10)>=i.from)&&(!i.to||r.startedAt.slice(0,10)<=i.to)).sort((a,b)=>i.sort==='rating'?b.rating-a.rating||b.updatedAt.localeCompare(a.updatedAt):b.updatedAt.localeCompare(a.updatedAt));const offset=Math.max(0,Number(i.offset)||0),limit=Math.min(100,Math.max(1,Number(i.limit)||30));return {data:rows.slice(offset,offset+limit).map(summary),total:rows.length,allTotal:all.data.length,folders:all.folders,customFolders:all.customFolders,organization:all.organization,projects:[...new Set(all.data.map(r=>r.project).filter(Boolean))],offset,limit};}
 function read(i){const r=lookup(i.id),all=organizer.group(files().map(parse));const offset=Math.max(0,Number(i.offset)||0),limit=Math.min(200,Math.max(1,Number(i.limit)||100));return {...summary(r),...organizer.describe(r),folders:all.folders,customFolders:all.customFolders,messages:r.messages.slice(offset,offset+limit),offset,limit,total:r.messages.length};}
 function rate(i){lookup(i.id);return organizer.rate(i);}
 function organize(i){if(i.action==='move')lookup(i.id);return organizer.update(i);}
 function launch(i){
  if(!['resume','fork','new','repeat'].includes(i.mode))throw Error('Неизвестный способ запуска');const r=lookup(i.id);if(r.unavailable)throw Error(r.unavailable);if(!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(r.sessionId))throw Error('У сессии нет корректного UUID для Nessy');
  const lastUser=r.messages.filter(m=>m.role==='user').at(-1);if(i.mode==='repeat'&&!i.prompt){if(!lastUser)throw Error('В чате нет пользовательского запроса');return {needsPrompt:true,prompt:lastUser.text,promptTruncated:lastUser.textTruncated,title:r.title};}const prompt=i.mode==='repeat'?text(i.prompt,24000):undefined;
  let available=false;try{available=!!r.project&&statSync(r.project).isDirectory();}catch{}
  if(!available&&!i.project)return {needsProject:true,profile:r.profile,sessionId:r.sessionId,mode:i.mode,title:r.title};
  const cwd=realpathSync(i.project||r.project);if(!statSync(cwd).isDirectory())throw Error('Выберите рабочую папку проекта');
  let sessionId=r.sessionId,imported=false;
  if(i.project&&cwd!==r.project&&!['new','repeat'].includes(i.mode)){
   sessionId=randomUUID();const target=join(r.profile,'projects',cwd.replace(/[^a-zA-Z0-9]/g,'-'),'chats',sessionId+'.jsonl');
   const records=[];for(const line of readFileSync(r.file,'utf8').split('\n')){if(!line.trim())continue;let record;try{record=JSON.parse(line);}catch{continue;}record.sessionId=sessionId;record.cwd=cwd;records.push(record);}
   if(!records.length)throw Error('В истории нет полных записей для переноса');privateWrite(target,records.map(r=>JSON.stringify(r)).join('\n')+'\n');imported=true;
  }
  return {profile:r.profile,cwd,sessionId,mode:i.mode,title:r.title,imported,prompt};
 }

 return {list,read,launch,lookup,profiles,rate,organize};
}
