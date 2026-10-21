#!/usr/bin/env node
/** Small graph projections run outside Electron; manual facts survive re-indexing. */
import {readFileSync,existsSync,mkdirSync,writeFileSync,renameSync,openSync,closeSync,unlinkSync,statSync,realpathSync} from 'node:fs';
import {join,resolve,isAbsolute,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {collectionState,filterCollection,manageCollection,writeCollectionGraphs,ensureCollectionSource} from './knowledge-collections.mjs';
import {runtimePaths} from './graphify.mjs';
const read=(path,fallback)=>existsSync(path)?JSON.parse(readFileSync(path,'utf8')):fallback;
export function applyOverlay(graph,overlay={}){
 const nodes=new Map(graph.nodes.map(n=>[n.id,{...n,...overlay.annotations?.[n.id]}]));
 for(const node of overlay.nodes||[])nodes.set(node.id,{...node,type:'knowledge',manual:true});
 const links=[...(graph.links||graph.edges||[]),...(overlay.links||[])].filter(e=>nodes.has(e.source)&&nodes.has(e.target));
 return {nodes:[...nodes.values()],links};
}
export function editKnowledge(output,operation){
 if(!operation||typeof operation!=='object')throw Error('Ожидается операция JSON');
 mkdirSync(output,{recursive:true});const lock=join(output,'overlay.lock');
 if(existsSync(lock)){const owner=read(lock,{});try{process.kill(owner.pid,0)}catch(e){if(e.code==='ESRCH')unlinkSync(lock);else throw e}}
 const fd=openSync(lock,'wx',0o600);writeFileSync(fd,JSON.stringify({pid:process.pid}));
 try{
 const file=join(output,'overlay.json'),overlay=read(file,{nodes:[],links:[],revision:0});
 const text=(value,max=2000)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw Error('Некорректный текст');return value.trim()};
 if(operation.type==='add-note'){
  const node={id:'manual:'+randomUUID(),label:text(operation.label,160),description:text(operation.description),...(operation.collection?{collection:operation.collection}:{}),createdAt:new Date().toISOString()};
  if(operation.parent){const graph=applyOverlay(read(join(output,'graph.json'),{nodes:[],links:[]}),overlay),parent=graph.nodes.find(n=>n.id===operation.parent);if(!parent||!['project','folder'].includes(parent.type))throw Error('Родитель должен быть проектом или папкой');node.project_id=parent.type==='project'?parent.id.replace(/^project:/,''):parent.project_id;overlay.links.push({id:'manual:'+randomUUID(),source:parent.id,target:node.id,relation:'contains',confidence:'USER_RECORDED',manual:true,source_file:file})}
  overlay.nodes.push(node);
 }else if(operation.type==='add-link'){
  let graph=applyOverlay(read(join(output,'graph.json'),{nodes:[],links:[]}),overlay);if(operation.collection)graph=filterCollection(graph,collectionState({...runtimePaths(),output},graph),operation.collection);const ids=new Set(graph.nodes.map(n=>n.id));
  if(!ids.has(operation.source)||!ids.has(operation.target)||operation.source===operation.target)throw Error('Выберите два существующих разных узла');
  const relation=text(operation.relation,160),evidence=text(operation.evidence);
  if(overlay.links.some(e=>e.source===operation.source&&e.target===operation.target&&e.relation===relation))throw Error('Эта ручная связь уже существует');
  overlay.links.push({id:'manual:'+randomUUID(),source:operation.source,target:operation.target,relation,description:evidence,source_file:file,confidence:'USER_RECORDED',manual:true});
 }else if(operation.type==='update-manual'){
  const entry=overlay.nodes.find(n=>n.id===operation.id)||overlay.links.find(e=>e.id===operation.id);if(!entry)throw Error('Ручная запись не найдена');
  if(operation.label!==undefined)entry.label=text(operation.label,160);
  if(operation.description!==undefined)entry.description=text(operation.description);
  if(operation.relation!==undefined&&entry.source)entry.relation=text(operation.relation,160);
 }else if(operation.type==='remove-manual'){
  const id=text(operation.id,200);if(!id.startsWith('manual:'))throw Error('Удалять можно только ручные записи; исправьте исходник для автоматических связей');
  overlay.nodes=overlay.nodes.filter(n=>n.id!==id);overlay.links=overlay.links.filter(e=>e.id!==id&&e.source!==id&&e.target!==id);
 }else throw Error('Операции: add-note, add-link, update-manual, remove-manual');
 overlay.revision++;overlay.updatedAt=new Date().toISOString();
 if(existsSync(file)){const history=join(output,'overlay-history');mkdirSync(history,{recursive:true});writeFileSync(join(history,String(overlay.revision-1)+'.json'),readFileSync(file),{mode:0o600})}
 const temp=file+'.tmp';writeFileSync(temp,JSON.stringify(overlay,null,2)+'\n',{mode:0o600});renameSync(temp,file);return {revision:overlay.revision};
 }finally{closeSync(fd);unlinkSync(lock)}
}
export function projectView(raw,options={}){
 const graph=raw,nodes=new Map(graph.nodes.map(n=>[n.id,n])),projects=graph.nodes.filter(n=>n.type==='project');
 const parents=new Map(),children=new Map();for(const e of graph.links)if(e.relation==='contains'){if(!parents.has(e.target))parents.set(e.target,e.source);const list=children.get(e.source)||new Set();list.add(e.target);children.set(e.source,list)}
 const ancestors=id=>{const result=[],seen=new Set();while(nodes.has(id)&&!seen.has(id)){seen.add(id);result.unshift(nodes.get(id));id=parents.get(id)}return result};
 const q=String(options.query||'').toLocaleLowerCase(),focus=String(options.focus||''),offset=Math.max(0,Number(options.offset)||0),limit=100,view=options.view==='links'?'links':'catalog';
 const chain=ancestors(focus),project=chain.find(n=>n.type==='project')||nodes.get('project:'+nodes.get(focus)?.project_id),scope=options.project||project?.id||'';
 const inScope=n=>!scope||n.id===scope||n.project_id===scope.replace(/^project:/,'')||ancestors(n.id).some(p=>p.id===scope);
 let candidates;
 if(q)candidates=graph.nodes.filter(n=>inScope(n)&&(String(n.label)+' '+String(n.description||'')).toLocaleLowerCase().includes(q));
 else if(focus&&view==='catalog'&&['project','folder'].includes(nodes.get(focus)?.type))candidates=[...(children.get(focus)||[])].map(id=>nodes.get(id)).filter(Boolean);
 else if(focus){const ids=new Set([focus]);for(const e of graph.links)if(e.source===focus)ids.add(e.target);else if(e.target===focus)ids.add(e.source);candidates=[...ids].map(id=>nodes.get(id)).filter(Boolean)}
 else if(view==='catalog')candidates=graph.nodes.filter(n=>n.type==='project'||n.type==='note'||n.manual&&!n.project_id);
 else{const owners=new Map();for(const e of graph.links)if(nodes.get(e.source)?.type==='project'){const set=owners.get(e.target)||new Set();set.add(e.source);owners.set(e.target,set)}candidates=graph.nodes.filter(n=>n.type==='project'||n.manual||(owners.get(n.id)?.size||0)>1)}
 const rank=n=>n.type==='project'?0:n.type==='folder'?1:2;candidates.sort((a,b)=>rank(a)-rank(b)||a.label.localeCompare(b.label));
 const page=candidates.slice(offset,offset+limit);let anchorCount=0;if(focus&&nodes.has(focus)&&!page.some(n=>n.id===focus)){page.unshift(nodes.get(focus));anchorCount=1}
 const ids=new Set(page.map(n=>n.id)),edges=graph.links.filter(e=>ids.has(e.source)&&ids.has(e.target));
 return {ready:true,anchorCount,scopeProject:scope,breadcrumbs:chain.map(n=>({id:n.id,label:n.label})),totalNodes:graph.nodes.length,totalLinks:graph.links.length,totalMatches:candidates.length,offset,limit,projects:projects.map(n=>({id:n.id,label:n.label,path:n.source_file,stale:n.stale,pending:n.pending})),nodes:page.map(n=>({...n,childCount:children.get(n.id)?.size||0,description:String(n.description||'').slice(0,3000)})),links:edges.slice(0,1200),hiddenLinks:Math.max(0,edges.length-1200)};
}
const graphCache=new Map();
function graphData(paths){
 const file=join(paths.output,'graph.json'),overlay=join(paths.output,'overlay.json'),error=join(paths.runtime,'last-error.json');
 const signature=[file,overlay,error,join(paths.output,'collections.json')].map(p=>{try{const s=statSync(p);return s.mtimeMs+':'+s.size}catch{return 'missing'}}).join('|');
 const prior=graphCache.get(paths.output);if(prior?.signature===signature)return prior;
 const raw=read(file,{nodes:[],links:[]});raw.nodes=raw.nodes.filter(n=>!n.manual);raw.links=(raw.links||raw.edges||[]).filter(e=>!e.manual);
 const graph=applyOverlay(raw,read(overlay,{}));const value={signature,graph};graphCache.clear();graphCache.set(paths.output,value);return value;
}
export function readKnowledgeDocument(paths,options={}){
 const all=graphData(paths).graph,graph=filterCollection(all,collectionState(paths,all),options.collection||paths.env?.ODYSSEUS_KNOWLEDGE_COLLECTION||'projects'),node=graph.nodes.find(n=>n.id===options.nodeId);if(!node)throw Error('Узел не найден');
 const allowed=new Set([node.source_file,...graph.links.filter(e=>e.source===node.id||e.target===node.id).map(e=>e.source_file)].filter(Boolean));
 if(typeof options.path!=='string'||!allowed.has(options.path))throw Error('Файл не является источником этого узла или связи');
 const vault=read(join(paths.runtime,'vault-selection.json'),{}).path||paths.root;
 const path=realpathSync(isAbsolute(options.path)?options.path:resolve(vault,options.path));const stat=statSync(path);
 if(!stat.isFile())throw Error('Это папка: раскройте её в каталоге');
 const extension=extname(path).toLowerCase(),textTypes=new Set(['.md','.txt','.json','.yaml','.yml','.toml','.ts','.tsx','.js','.jsx','.mjs','.cjs','.py','.go','.rs','.java','.kt','.cs','.rb','.swift','.c','.h','.cpp','.php','.sql','.graphql','.proto','.html','.css','.xml','.csv','.sh']);
 if(stat.size>2*1024*1024||!textTypes.has(extension))return {path,binary:true,content:'',truncated:false};
 const content=readFileSync(path,'utf8');if(content.includes('\0'))return {path,binary:true,content:'',truncated:false};
 return {path,content:content.slice(0,200000),truncated:content.length>200000,markdown:extension==='.md',binary:false};
}
export function snapshot(paths,options={}){
 const file=join(paths.output,'graph.json');if(!existsSync(file))return {ready:false,projects:[],nodes:[],links:[],totalNodes:0,totalLinks:0,totalMatches:0,offset:0,limit:160,hiddenLinks:0};
 const {signature,graph:all}=graphData(paths),state=collectionState(paths,all),collection=options.collection||paths.env?.ODYSSEUS_KNOWLEDGE_COLLECTION||'projects',graph=filterCollection(all,state,collection),viewKey=JSON.stringify([signature,collection,createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0,16),options.focus||'',options.query||'',options.offset||0,options.view||'catalog',options.project||'']);
 if(options.version===viewKey)return {unchanged:true,version:viewKey};
 return {...projectView(graph,options),scopeCollection:collection,collections:state.collections.map(c=>({...c,count:c.id==='notes'?all.nodes.filter(n=>n.type==='note').length:Object.values(state.assignments).filter(id=>id===c.id).length})),allProjects:all.nodes.filter(n=>n.type==='project').map(n=>({id:n.id,label:n.label,collectionId:state.assignments[n.id]})),version:viewKey,overlayRevision:read(join(paths.output,'overlay.json'),{}).revision||0,lastError:read(join(paths.runtime,'last-error.json'),null)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const paths=runtimePaths(),[mode,arg='{}']=process.argv.slice(2);
 if(mode==='service'){
  process.on('message',message=>{try{const result=message.mode==='agent-source'?ensureCollectionSource(paths,graphData(paths).graph,message.options.collection,message.options.workspaceRoot):message.mode==='catalogs'?manageCollection(paths,graphData(paths).graph,message.options):message.mode==='prepare-scopes'?writeCollectionGraphs(paths,graphData(paths).graph):message.mode==='document'?readKnowledgeDocument(paths,message.options):message.mode==='edit'?editKnowledge(paths.output,message.options):snapshot(paths,message.options);process.send?.({id:message.id,result})}catch(e){process.send?.({id:message.id,error:e.message})}});
  process.on('disconnect',()=>process.exit(0));
 }else try{const options=JSON.parse(arg);console.log(JSON.stringify(mode==='prepare-scopes'?writeCollectionGraphs(paths,graphData(paths).graph):mode==='catalogs'?manageCollection(paths,graphData(paths).graph,options):mode==='edit'?editKnowledge(paths.output,options):mode==='document'?readKnowledgeDocument(paths,options):snapshot(paths,options)))}catch(e){console.error(e.message);process.exitCode=1}
}
