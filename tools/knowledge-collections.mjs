/** Knowledge catalogs separate project contexts without changing their source folders. */
import{existsSync,readFileSync,writeFileSync,mkdirSync,renameSync,statSync}from'node:fs';
import{join,resolve}from'node:path';
import{randomUUID,createHash}from'node:crypto';
const read=(p,f={})=>existsSync(p)?JSON.parse(readFileSync(p,'utf8')):f;
const defaults=[{id:'projects',name:'Мои проекты'},{id:'odysseus',name:'Odysseus'},{id:'notes',name:'Заметки Obsidian'}];
export function collectionState(paths,graph){
 const stored=read(join(paths.output,'collections.json'),{collections:defaults,assignments:{}}),config=read(join(paths.root,'odysseus.json'));
 const systemPaths=new Set([resolve(paths.root,'workspace'),...Object.values(config.components||{}).map(c=>resolve(paths.root,c.source))]);
 const collections=stored.collections||defaults,valid=new Set(collections.map(c=>c.id)),assignments={};
 for(const project of graph.nodes.filter(n=>n.type==='project'))assignments[project.id]=valid.has(stored.assignments?.[project.id])?stored.assignments[project.id]:systemPaths.has(resolve(project.source_file||''))?'odysseus':'projects';
 return{collections,assignments};
}
export function collectionForPath(paths,path){
 const stored=read(join(paths.output,'collections.json')),config=read(join(paths.root,'odysseus.json')),id='project:'+createHash('sha256').update(resolve(path)).digest('hex').slice(0,16);
 if(stored.assignments?.[id])return stored.assignments[id];
 return path===resolve(paths.root,'workspace')||Object.values(config.components||{}).some(c=>resolve(paths.root,c.source)===resolve(path))?'odysseus':'projects';
}
export function filterCollection(graph,state,id){
 if(!state.collections.some(c=>c.id===id))throw Error('Каталог знаний не найден');
 const nodes=new Map(graph.nodes.map(n=>[n.id,n])),owners=new Map();
 for(const n of graph.nodes){if(n.type==='project')owners.set(n.id,new Set([n.id]));else if(n.project_id){const project=nodes.has(n.project_id)?n.project_id:'project:'+n.project_id;owners.set(n.id,new Set([project]))}}
 // Only explicit project membership and project-to-shared-element edges assign ownership.
 for(const e of graph.links)if(nodes.get(e.source)?.type==='project'&&!nodes.get(e.target)?.project_id&&nodes.get(e.target)?.type!=='project'){const set=owners.get(e.target)||new Set();set.add(e.source);owners.set(e.target,set)}
 const keep=new Set(graph.nodes.filter(n=>{
  const owner=owners.get(n.id);
  if(owner?.size)return [...owner].some(project=>state.assignments[project]===id);
  if(n.collection)return n.collection===id;
  return n.type==='note'?id==='notes':n.manual?id==='projects':false;
 }).map(n=>n.id));
 return{nodes:graph.nodes.filter(n=>keep.has(n.id)),links:graph.links.filter(e=>keep.has(e.source)&&keep.has(e.target))};
}
export function manageCollection(paths,graph,operation){
 const state=collectionState(paths,graph);
 if(operation.type==='create'){
  const name=String(operation.name||'').trim();if(!name||name.length>100)throw Error('Введите название каталога (до 100 символов)');
  if(state.collections.some(c=>c.name.toLocaleLowerCase()===name.toLocaleLowerCase()))throw Error('Каталог с таким названием уже существует');
  const collection={id:'c-'+randomUUID().slice(0,12),name};state.collections.push(collection);state.createdId=collection.id;
 }else if(operation.type==='move-project'){
  if(!graph.nodes.some(n=>n.id===operation.projectId&&n.type==='project')||!state.collections.some(c=>c.id===operation.collectionId))throw Error('Проект или каталог не найден');
  state.assignments[operation.projectId]=operation.collectionId;
 }else throw Error('Неизвестная операция каталога');
 mkdirSync(paths.output,{recursive:true});const file=join(paths.output,'collections.json'),temp=file+'.tmp-'+process.pid;writeFileSync(temp,JSON.stringify(state,null,2)+'\n',{mode:0o600});renameSync(temp,file);writeCollectionGraphs(paths,graph);return state;
}
export function writeCollectionGraphs(paths,graph){
 const state=collectionState(paths,graph),base=join(paths.output,'collections');mkdirSync(base,{recursive:true});
 for(const collection of state.collections){
  const subset=filterCollection(graph,state,collection.id),folder=join(base,collection.id,'graphify-out'),file=join(folder,'graph.json');
  const revision=createHash('sha256').update(JSON.stringify([state,subset])).digest('hex');
  if(read(file+'.state').revision===revision)continue;
  mkdirSync(folder,{recursive:true});const temp=file+'.tmp-'+process.pid;writeFileSync(temp,JSON.stringify({directed:true,multigraph:true,graph:{collection:collection.id},nodes:subset.nodes,links:subset.links,hyperedges:[]}));renameSync(temp,file);const stateTemp=file+'.state.tmp-'+process.pid;writeFileSync(stateTemp,JSON.stringify({revision}));renameSync(stateTemp,file+'.state');
 }
 return state;
}
export function ensureCollectionSource(paths,graph,collection,workspaceRoot,node=process.execPath){
 const state=collectionState(paths,graph);if(!state.collections.some(c=>c.id===collection))throw Error('Каталог не найден');
 const slug=collection==='projects'?'graphify':'graphify-'+collection,folder=join(workspaceRoot,'sources',slug),file=join(folder,'config.json'),old=read(file,null),id=collection==='projects'?'odysseus-graphify':'odysseus-graphify:'+collection;
 if(old&&old.id!==id)throw Error('Имя источника Graphify занято другим подключением');if(old?.enabled===false)throw Error('Включите источник '+slug+' в MCP');
 mkdirSync(folder,{recursive:true});const config=old||{id,slug,name:'Graphify · '+state.collections.find(c=>c.id===collection).name,enabled:true,type:'mcp',provider:'graphify',icon:'🕸️',createdAt:Date.now()};
 config.mcp={...(config.mcp||{}),transport:'stdio',command:node,args:[join(paths.root,'tools/graphify.mjs'),'serve','--collection',collection],authType:'none'};
 writeFileSync(file,JSON.stringify(config,null,2)+'\n',{mode:0o600});
 const guide=join(folder,'guide.md');if(!existsSync(guide))writeFileSync(guide,'# Graphify\n\nРаботай только с каталогом '+state.collections.find(c=>c.id===collection).name+'. Не добавляй контекст других каталогов без прямой просьбы пользователя. Источники связей важнее совпадения названий. Ручные изменения: '+join(paths.root,'tools/knowledge-ui.mjs')+' edit с JSON-аргументом, содержащим collection='+collection+'. Руководство: '+join(paths.root,'docs/knowledge-obsidian-ru.md')+'\n',{mode:0o600});
 writeCollectionGraphs(paths,graph);return{slug,name:state.collections.find(c=>c.id===collection).name};
}
