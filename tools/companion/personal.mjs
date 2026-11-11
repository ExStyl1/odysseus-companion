import {workspaceStore} from './workspace-store.mjs';
import { join } from 'node:path';
import { json } from './paths.mjs';
import { privateWrite } from '../personal/store.mjs';
export function personal(paths) {
 const file=join(paths.home,'personal.json');
 const read=()=>({theme:'dark',accent:'gold',density:'comfortable',palette:'odysseus',fontScale:100,notes:{},...json(file),releaseEvents:(workspaceStore(paths).read().scenarioRuns||[]).filter(r=>r.template==='release'&&r.status!=='cancelled').flatMap(r=>[{date:r.freezeDate,title:'Код-фриз: '+r.title,owner:r.owner,scenarioId:r.id},{date:r.releaseDate,title:'Релиз: '+r.title,owner:r.owner,scenarioId:r.id}]).filter(e=>e.date)});
 return {read,update(input){
  const s=read();
  for(const [k,values] of Object.entries({theme:['dark','light','system'],accent:['theme','gold','blue','green','violet'],density:['comfortable','compact'],font:['system','humanist'],motion:['system','reduced','full'],design:['classic','aurora','spotlight','blueprint'],palette:['odysseus','codex','github','nord','paper','vitesse','one-dark-pro']}))if(k in input){if(!values.includes(input[k]))throw Error('Неизвестный вариант оформления');s[k]=input[k];}
  if('fontScale' in input){if(![90,100,110].includes(input.fontScale))throw Error('Недопустимый размер текста');s.fontScale=input.fontScale;}
  if('date' in input){if(!/^\d{4}-\d{2}-\d{2}$/.test(input.date)||new Date(input.date+'T12:00:00Z').toISOString().slice(0,10)!==input.date)throw Error('Неверная дата');if(typeof input.text!=='string'||input.text.length>12000)throw Error('Заметка должна быть короче 12000 символов');if(input.text.trim())s.notes[input.date]={text:input.text,updatedAt:new Date().toISOString()};else delete s.notes[input.date];}
  const {releaseEvents,...stored}=s;privateWrite(file,JSON.stringify(stored));return {...s,releaseEvents};
 }};
}
