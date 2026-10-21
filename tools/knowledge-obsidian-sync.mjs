#!/usr/bin/env node
/** Native Markdown exchange, isolated from the Electron reader process. */
import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync,readdirSync,lstatSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,dirname,resolve,relative,basename} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {runtimePaths,ensureVault,processIsAlive} from './graphify.mjs';
import {applyOverlay} from './knowledge-ui.mjs';
import {collectionState,filterCollection,writeCollectionGraphs} from './knowledge-collections.mjs';
const read=(p,f)=>existsSync(p)?JSON.parse(readFileSync(p,'utf8')):f;
const key=id=>createHash('sha256').update(id).digest('hex').slice(0,32);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function safe(root,file){const rel=relative(root,file);if(rel.startsWith('..')||resolve(root)===resolve(file))throw Error('Invalid exchange path');let p=root;for(const part of rel.split('/')){p=join(p,part);if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw Error('Символические ссылки в папке обмена не поддерживаются: '+p)}if(existsSync(root)&&lstatSync(root).isSymbolicLink())throw Error('Папка обмена не должна быть ссылкой')}
function atomic(file,text){mkdirSync(dirname(file),{recursive:true});const temp=file+'.tmp-'+process.pid;writeFileSync(temp,text,{mode:0o600});renameSync(temp,file)}
function files(folder){if(!existsSync(folder))return [];const out=[];for(const entry of readdirSync(folder,{withFileTypes:true})){if(entry.name.startsWith('.')&&entry.isDirectory())continue;const path=join(folder,entry.name);if(entry.isSymbolicLink())throw Error('Ссылка в папке обмена: '+path);if(entry.isDirectory())out.push(...files(path));else if(entry.name.endsWith('.md'))out.push(path)}return out}
const filename=node=>(String(node.label||'Заметка').startsWith('.')?'Файл ':'')+String(node.label||'Заметка').replace(/[\/\\:*?"<>|#\[\]^]/g,'_').slice(0,70).trim()+'--'+key(node.id);
function render(id,value,source='',names=new Map()){
 return '---\nodysseus_id: '+JSON.stringify(id)+'\nodysseus_source: '+JSON.stringify(source)+'\n---\n\n# '+value.label.replace(/\n/g,' ')+'\n\n'+value.description+'\n\n## Связи\n\n'+value.links.map(e=>'- [['+(names.get(e.target)||key(e.target))+']] — '+e.relation.replace(/\n/g,' ')+'\n').join('');
}
function parse(text,path,known){
 text=text.replace(/\r\n/g,'\n');
 const match=text.match(/^---\r?\nodysseus_id: (.+)\r?\nodysseus_source: (.+)\r?\n---\s*\n# ([^\n]+)\n\n([\s\S]*?)\n\n## Связи\n\n([\s\S]*)$/);
 if(!match)throw Error('Изменён формат заметки: '+path);
 const id=JSON.parse(match[1]),label=match[3].trim(),description=match[4].trim(),links=[];
 if(typeof id!=='string'||!label||label.length>500||description.length>200000)throw Error('Некорректная заметка: '+path);
 for(const line of match[5].split('\n').filter(l=>l.trim())){
  const item=line.match(/^- \[\[([^\]|]+)(?:\|[^\]]*)?\]\] — (.+)$/);if(!item)throw Error('Не распознана связь: '+path);
  const name=basename(item[1].replace(/\.md$/,'')),target=known.get(name)||known.get(name.match(/--([0-9a-f]{32})$/)?.[1]);if(!target)throw Error('Цель связи не найдена: '+item[1]);
  links.push({target,relation:item[2].trim()});
 }
 return{id,value:{label,description,links:links.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))}};
}
const semantic=v=>({label:v.label.trim(),description:v.description.trim(),links:v.links.map(({target,relation})=>({target,relation})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))});
export function synchronizeObsidian(paths,vaultPath){
 const vault=vaultPath||ensureVault(paths).path,exchange=join(vault,'Graphify','Каталоги');safe(vault,join(exchange,'index.md'));mkdirSync(paths.output,{recursive:true});
 const lock=join(paths.output,'overlay.lock');if(existsSync(lock)){const owner=read(lock,{});if(!processIsAlive(owner.pid))unlinkSync(lock)}
 let fd;try{fd=openSync(lock,'wx',0o600)}catch(e){if(e.code==='EEXIST')throw Error('База знаний сейчас изменяется. Повторите синхронизацию через несколько секунд.');throw e}
 writeFileSync(fd,JSON.stringify({pid:process.pid}));
 try{
 const overlayFile=join(paths.output,'overlay.json'),overlay=read(overlayFile,{nodes:[],links:[],revision:0}),before=JSON.stringify(overlay);
 const raw=read(join(paths.output,'graph.json'),{nodes:[],links:[]});raw.nodes=raw.nodes.filter(n=>!n.manual);raw.links=(raw.links||[]).filter(e=>!e.manual);
 let graph=applyOverlay(raw,overlay);const state=collectionState(paths,graph),baseFile=join(paths.output,'obsidian-sync-state.json'),base=read(baseFile,{documents:{}}),next={documents:{...base.documents}},conflicts=[];
 let imported=0,exported=0;const planned=[],seenIds=new Map(),priorById=new Map(Object.entries(base.documents).map(([path,doc])=>[doc.catalog+'\0'+doc.id,{path,doc}])),manualById=new Map(overlay.nodes.map(n=>[n.id,n]));
 for(const catalog of state.collections){
  graph=applyOverlay(raw,overlay);
  if(!/^[a-z0-9-]{1,64}$/.test(catalog.id))throw Error('Некорректный каталог');
  const folder=join(exchange,catalog.id);safe(vault,join(folder,'index.md'));
  const subset=filterCollection(graph,state,catalog.id),ids=new Set(subset.nodes.map(n=>n.id)),known=new Map(subset.nodes.map(n=>[key(n.id),n.id]));
  // Stable identifiers survive a rename or a move inside the catalog.
  const existing=new Map();for(const file of files(folder)){
   if(basename(file)==='README.md')continue;
   const text=readFileSync(file,'utf8');const marker=text.match(/^odysseus_id: (.+)$/m);
   if(!marker){
    // New ordinary Markdown notes in a catalog become manual knowledge.
    if(!text.trim())continue;const recovered=overlay.nodes.find(n=>n.source_file===file&&n.collection===catalog.id);if(recovered&&base.documents[relative(vault,file)]){conflicts.push(relative(vault,file)+': удалён служебный ID; содержимое сохранено');existing.set(recovered.id,{file,text,invalid:true});continue}const id=recovered?.id||'manual:'+randomUUID(),label=(text.match(/^# (.+)$/m)?.[1]||basename(file,'.md')).trim();
    const description=text.replace(/^# .+\n?/m,'').trim();if(!label||label.length>500||description.length>200000){conflicts.push(relative(vault,file)+': слишком большая заметка');continue}
    const node={id,label,description,source_file:file,collection:catalog.id,createdAt:new Date().toISOString()};if(!recovered){overlay.nodes.push(node);subset.nodes.push({...node,type:'knowledge',manual:true});imported++}ids.add(id);known.set(key(id),id);existing.set(id,{file,text,newNote:true});continue;
   }
   let id;try{id=JSON.parse(marker[1])}catch{conflicts.push(relative(vault,file)+': неверный ID');continue}
   if(existing.has(id)){existing.get(id).duplicate=true;conflicts.push(relative(vault,file)+': повторяется ID');continue}let destination=file;if(basename(file).startsWith('.')&&basename(file).endsWith('--'+key(id)+'.md')){destination=join(dirname(file),'Файл '+basename(file));safe(vault,destination);if(existsSync(destination)){conflicts.push(relative(vault,file)+': новое имя занято');continue}renameSync(file,destination)}existing.set(id,{file:destination,text});
  }
  const names=new Map(subset.nodes.map(n=>[n.id,existing.has(n.id)?basename(existing.get(n.id).file,'.md'):filename(n)]));
  for(const [id,name]of names)known.set(name,id);
  const adjacency=new Map();for(const edge of subset.links){if(!ids.has(edge.target))continue;const entries=adjacency.get(edge.source)||[];entries.push({target:edge.target,relation:String(edge.relation||'связан с'),manual:!!edge.manual});adjacency.set(edge.source,entries)}
  const labelCounts=new Map();for(const n of subset.nodes)labelCounts.set(n.label,(labelCounts.get(n.label)||0)+1);for(const n of subset.nodes)if(labelCounts.get(n.label)===1)known.set(n.label,n.id);
  for(const node of subset.nodes){
   const entry=existing.get(node.id),file=entry?.file||join(folder,names.get(node.id)+'.md'),path=relative(vault,file),prior=base.documents[path]||priorById.get(catalog.id+'\0'+node.id)?.doc;
   if(entry?.duplicate||entry?.invalid)continue;
   const latest=manualById.get(node.id)||overlay.annotations?.[node.id]||node;
   const current={label:String(latest.label||node.id).trim(),description:String(latest.description||'').trim(),links:(adjacency.get(node.id)||[]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))};
   let merged=current;
   if(entry?.newNote){for(const match of entry.text.matchAll(/(?<!!)\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)){const target=known.get(basename(match[1].replace(/\.md$/,'')));if(target&&target!==node.id&&!overlay.links.some(e=>e.source===node.id&&e.target===target)){const edge={id:'manual:'+randomUUID(),source:node.id,target,relation:'связан с',description:'Ссылка из Obsidian',confidence:'USER_RECORDED',manual:true,source_file:file};overlay.links.push(edge);merged.links.push({target,relation:edge.relation,manual:true})}}}
   if(entry&&!entry.newNote){
    let parsed;try{parsed=parse(entry.text,path,known)}catch(e){conflicts.push(e.message);continue}
    const local=semantic(parsed.value),remote=semantic(current),ancestor=prior?semantic(prior.value):undefined;
    if(!ancestor&&!equal(local,remote)){conflicts.push(path+': нет исходной версии для сравнения');continue}
    merged={...current};let conflict=false;
    for(const field of ['label','description','links']){
     if(ancestor&&!equal(local[field],ancestor[field])){
      if(!equal(remote[field],ancestor[field])&&!equal(local[field],remote[field])){conflicts.push(path+': изменено с двух сторон ('+field+')');conflict=true;break}
      merged[field]=local[field];
     }
    }
    if(conflict)continue;
    const seen=seenIds.get(node.id);if(seen&&seen!==JSON.stringify([merged.label,merged.description])){conflicts.push(path+': разные правки общего узла в каталогах');continue}
    const manual=manualById.get(node.id);
    if(merged.label!==current.label||merged.description!==current.description){
     const fields={label:merged.label,description:merged.description};
     if(manual)Object.assign(manual,fields);else{overlay.annotations||={};overlay.annotations[node.id]={...overlay.annotations[node.id],...fields}}
     imported++;
    }
    // Source-derived relations stay source-derived; only user relations are removable.
    const desired=merged.links,has=(list,e)=>list.some(x=>x.target===e.target&&x.relation===e.relation);
    const oldLinkCount=overlay.links.length;overlay.links=overlay.links.filter(e=>e.source!==node.id||!ids.has(e.target)||has(desired,e));if(oldLinkCount!==overlay.links.length)imported++;
    for(const e of desired)if(!has(current.links,e)&&e.target!==node.id){overlay.links.push({id:'manual:'+randomUUID(),source:node.id,target:e.target,relation:e.relation,description:'Связь из Obsidian',confidence:'USER_RECORDED',manual:true,source_file:file});imported++}
    merged.links=[...current.links.filter(e=>!e.manual),...overlay.links.filter(e=>e.source===node.id&&ids.has(e.target)).map(e=>({target:e.target,relation:e.relation,manual:true}))];
   }
   // Shared dependency notes may occur in two catalogs: conflicting edits stay on disk.
   const fields=JSON.stringify([merged.label,merged.description]),previous=seenIds.get(node.id);if(previous&&previous!==fields){conflicts.push(path+': разные правки общего узла в каталогах');continue}seenIds.set(node.id,fields);
   const owned=manualById.get(node.id)||overlay.nodes.find(n=>n.id===node.id);if(owned)owned.source_file=file;
   const text=render(node.id,merged,owned?file:node.source_file||'',names);planned.push({file,text,previous:entry?.text});
   const previousPath=priorById.get(catalog.id+'\0'+node.id)?.path;if(previousPath&&previousPath!==path)delete next.documents[previousPath];
   next.documents[path]={id:node.id,catalog:catalog.id,value:semantic(merged)};
  }
  // Deleting a Markdown file never deletes its code source or user knowledge.
  for(const [id,entry]of existing)if(!ids.has(id))conflicts.push(relative(vault,entry.file)+': узел отсутствует в графе; файл сохранён');
  const index=join(folder,'README.md');if(!existsSync(index))planned.push({file:index,text:'# '+catalog.name+'\n\nВсе узлы этого каталога — соседние Markdown-файлы. Откройте локальный граф Obsidian или используйте поиск. Меняйте заголовок, описание и список «Связи»; сохраняйте служебный ID. Новые Markdown-заметки в этой папке добавляются в базу при следующей синхронизации. Удаление файла не удаляет знания. Автоматические связи исправляются в исходниках.\n'});
 }
 if(JSON.stringify(overlay)!==before){overlay.revision=(overlay.revision||0)+1;overlay.updatedAt=new Date().toISOString();if(existsSync(overlayFile)){const history=join(paths.output,'overlay-history');mkdirSync(history,{recursive:true});atomic(join(history,String(overlay.revision-1)+'.json'),readFileSync(overlayFile,'utf8'))}atomic(overlayFile,JSON.stringify(overlay,null,2)+'\n')}
 for(const item of planned){safe(vault,item.file);const actual=existsSync(item.file)?readFileSync(item.file,'utf8'):undefined;
  if(actual!==item.previous&&actual!==undefined){conflicts.push(relative(vault,item.file)+': файл изменён во время синхронизации');const path=relative(vault,item.file);if(base.documents[path])next.documents[path]=base.documents[path];else delete next.documents[path];continue}
  if(actual!==item.text){if(actual!==undefined)atomic(join(paths.output,'obsidian-history',new Date().toISOString().replace(/[:.]/g,'-'),key(relative(vault,item.file))+'.md'),actual);atomic(item.file,item.text);exported++}
 }
 atomic(baseFile,JSON.stringify(next));graph=applyOverlay(raw,overlay);writeCollectionGraphs(paths,graph);
 const result={catalogs:state.collections.length,imported,exported,conflicts,vault,folder:exchange,updatedAt:new Date().toISOString()};atomic(join(paths.output,'obsidian-sync-result.json'),JSON.stringify(result,null,2));return result;
 }finally{closeSync(fd);unlinkSync(lock)}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{console.log(JSON.stringify(synchronizeObsidian(runtimePaths())))}catch(e){console.error(e.message);process.exitCode=1}}
