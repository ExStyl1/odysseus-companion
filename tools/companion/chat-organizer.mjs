import {basename} from 'node:path';
import {workspaceStore,fingerprint,uid,now,text} from './workspace-store.mjs';
const topics=[
 ['automation','Автоматизации',/\bn8n\b|workflow|автоматизац|бизнес.процесс/giu,'bolt'],
 ['qa','Тестирование',/\bqa\b|\btest\w*|тестир|регресс|тест.кейс|провер[кьи]/giu,'shield'],
 ['analysis','Аналитика',/аналити|требован|бизнес.анализ|use.case|\bbrd\b|\bsrs\b|\bsa\b/giu,'graph'],
 ['knowledge','Знания и исследования',/\brag\b|граф.знан|исследова|документ|обсидиан|\bobsidian\b/giu,'memory'],
 ['development','Разработка',/\bcode\b|\bapi\b|\breact\b|\bpython\b|\btypescript\b|разработ|реализ|исправ|ошибк|баг|интерфейс|\bui\b|код[ауыом]?\b/giu,'code']
];
export function chatOrganizer(paths){const store=workspaceStore(paths);
 const state=()=>{const s=store.read();return {ratings:s.chatRatings||{},mode:s.chatOrganization?.mode||'topic',custom:s.chatOrganization?.folders||[],overrides:s.chatOrganization?.overrides||{}};};
 function describe(r,s=state()){
  let automatic={id:'other',name:'Без папки',icon:'note'};
  if(s.mode==='project'&&r.project)automatic={id:'project-'+fingerprint(r.project).slice(0,20),name:basename(r.project)||r.project,icon:'code',description:r.project};
  if(s.mode==='topic'){const title=r.title||'',body=r.messages.filter(m=>m.role==='user').slice(0,8).map(m=>m.text).join('\n').slice(0,16000);const scores=topics.map(([id,name,re,icon])=>({id,name,icon,score:(title.match(re)||[]).length*3+(body.match(re)||[]).length})).sort((a,b)=>b.score-a.score);if(scores[0].score>0){const {score,...folder}=scores[0];automatic=folder;}}
  const override=s.overrides[r.id];const manual=override==='other'?{id:'other',name:'Без папки',icon:'note'}:s.custom.find(f=>f.id===override);const folder=manual||automatic;
  return {rating:s.ratings[r.id]?.value||0,ratedAt:s.ratings[r.id]?.at||null,folder,folderManual:!!manual,automaticFolder:automatic};
 }
 function group(rows){const s=state(),data=rows.map(r=>({...r,...describe(r,s)})),folders=new Map([['other',{id:'other',name:'Без папки',icon:'note',count:0}],...s.custom.map(f=>[f.id,{...f,count:0}])]);for(const r of data){if(!folders.has(r.folder.id))folders.set(r.folder.id,{...r.folder,count:0});folders.get(r.folder.id).count++;}return {data,folders:[...folders.values()],organization:{mode:s.mode},customFolders:s.custom};}
 function rate(i){if(!Number.isInteger(i.rating)||i.rating<0||i.rating>5)throw Error('Оценка должна быть целым числом от 1 до 5, 0 снимает оценку');return store.mutate(s=>{s.chatRatings||={};if(i.rating===0)delete s.chatRatings[i.id];else s.chatRatings[i.id]={value:i.rating,at:now()};return {id:i.id,rating:i.rating};});}
 function update(i){return store.mutate(s=>{s.chatOrganization||={mode:'topic',folders:[],overrides:{}};const o=s.chatOrganization;o.folders||=[];o.overrides||={};if(i.action==='mode'){if(!['topic','project','none'].includes(i.mode))throw Error('Неизвестный способ сортировки');o.mode=i.mode;}else if(i.action==='create'){const name=text(i.name,60);if(o.folders.length>=50)throw Error('Можно создать до 50 своих папок');if(o.folders.some(f=>f.name.toLowerCase()===name.toLowerCase()))throw Error('Папка с таким названием уже есть');const f={id:'custom-'+uid(),name,icon:'note'};o.folders.push(f);return f;}else if(i.action==='move'){if(i.folderId==='auto')delete o.overrides[i.id];else{if(i.folderId!=='other'&&!o.folders.some(f=>f.id===i.folderId))throw Error('Выберите свою папку или автоматический режим');o.overrides[i.id]=i.folderId;}}else if(['rename','delete'].includes(i.action)){const f=o.folders.find(f=>f.id===i.folderId);if(!f)throw Error('Папка не найдена');if(i.action==='rename'){const name=text(i.name,60);if(o.folders.some(x=>x.id!==f.id&&x.name.toLowerCase()===name.toLowerCase()))throw Error('Папка с таким названием уже есть');f.name=name;}else{o.folders=o.folders.filter(x=>x.id!==f.id);for(const [id,folder]of Object.entries(o.overrides))if(folder===f.id)delete o.overrides[id];}}else throw Error('Неизвестное действие');return {updated:true};});}
 return {describe,group,rate,update};}
