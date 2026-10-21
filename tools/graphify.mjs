#!/usr/bin/env node
import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync,readdirSync,realpathSync,statSync,unlinkSync,openSync,closeSync} from 'node:fs';
import {join,dirname,resolve,basename} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync,spawn} from 'node:child_process';
const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=(p,fallback={})=>{try{return JSON.parse(readFileSync(p,'utf8'))}catch(e){if(e.code==='ENOENT')return fallback;throw e}};
const write=(p,d)=>{mkdirSync(dirname(p),{recursive:true,mode:0o700});const temp=p+'.tmp-'+process.pid;writeFileSync(temp,JSON.stringify(d,null,2)+'\n',{mode:0o600});renameSync(temp,p)};
const isDir=p=>{try{return statSync(p).isDirectory()}catch{return false}};
export function processIsAlive(pid,probe=process.kill){
 if(!Number.isSafeInteger(Number(pid))||Number(pid)<=0)return false;
 try{probe(Number(pid),0);return true}catch(error){if(error.code==='ESRCH')return false;if(error.code==='EPERM')return true;throw error}
}
export function runtimePaths(root=projectRoot,env=process.env){
 const runtime=join(root,'.odysseus','graphify');return {root,runtime,config:join(runtime,'config.json'),registry:join(runtime,'registry'),output:env.ODYSSEUS_KNOWLEDGE_DIR?resolve(root,env.ODYSSEUS_KNOWLEDGE_DIR):join(runtime,'knowledge'),python:join(runtime,'venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),cli:join(runtime,'venv',process.platform==='win32'?'Scripts/graphify.exe':'bin/graphify'),env};
}
export function findVault({root=projectRoot,home=homedir(),platform=process.platform,env=process.env,config={}}={}){
 const explicit=env.ODYSSEUS_OBSIDIAN_VAULT||config.vault;
 if(explicit){const path=resolve(root,explicit);if(!isDir(path))throw Error('Configured Obsidian vault is unavailable: '+path);return {path:realpathSync(path),reason:'explicit',created:false}}
 const index=platform==='darwin'?join(home,'Library/Application Support/obsidian/obsidian.json'):platform==='win32'?join(env.APPDATA||join(home,'AppData/Roaming'),'obsidian/obsidian.json'):join(env.XDG_CONFIG_HOME||join(home,'.config'),'obsidian/obsidian.json');
 let entries;try{entries=Object.values(read(index).vaults||{})}catch(e){throw Error('Cannot read Obsidian vault registry: '+e.message)}
 const candidates=entries.filter(v=>typeof v.path==='string'&&isDir(v.path)).sort((a,b)=>Number(!!b.open)-Number(!!a.open)||(Number(b.ts)||0)-(Number(a.ts)||0)||a.path.localeCompare(b.path));
 if(candidates.length)return {path:realpathSync(candidates[0].path),reason:candidates[0].open?'open-vault':'most-recent-vault',created:false};
 return {path:join(root,'workspace','Obsidian'),reason:'new-vault',created:!isDir(join(root,'workspace','Obsidian'))};
}
export function ensureVault(paths){
 const selection=findVault({root:paths.root,env:paths.env,config:read(paths.config)});
 if(selection.created){mkdirSync(join(selection.path,'.obsidian'),{recursive:true});writeFileSync(join(selection.path,'Odysseus.md'),'# Odysseus\n\nЛокальная база знаний проектов. Карта и отчёты создаются в папке Graphify.\n\nСвяжите заметки через `[[Название заметки]]`, чтобы они появились в графе.\n')}
 write(join(paths.runtime,'vault-selection.json'),selection);return selection;
}
function run(command,args,options={}){const result=spawnSync(command,args,{stdio:options.capture?'pipe':'inherit',encoding:'utf8',...options});if(result.error)throw result.error;if(result.status!==0)throw Error(options.capture?(result.stderr||result.stdout||'Command failed'):'Command failed: '+basename(command));return result.stdout}
export function connectDesktopSources(paths, home=homedir(), {rebind=false}={}){
 const base=join(paths.env.NESSY_CONFIG_DIR||join(home,'.nessy-agent'),'workspaces');let created=0;
 if(!isDir(base))return created;
 for(const workspace of readdirSync(base)){
  if(!isDir(join(base,workspace)))continue;
  let folder=join(base,workspace,'sources','graphify'),file=join(folder,'config.json'),old=read(file,null);
  if(old&&old.id!=='odysseus-graphify'){folder=join(base,workspace,'sources','odysseus-knowledge');file=join(folder,'config.json');old=read(file,null);if(old&&old.id!=='odysseus-graphify')throw Error('Both knowledge source slugs are occupied; choose a separate source manually.')}
  if(old&&!rebind)continue;
  const config={id:'odysseus-graphify',slug:basename(folder),name:'Graphify · база знаний',enabled:true,type:'mcp',provider:'graphify',icon:'🕸️',tagline:'Граф знаний проектов и Obsidian: зависимости, связи и источники.',mcp:{transport:'stdio',command:process.execPath,args:[join(paths.root,'tools/graphify.mjs'),'serve'],authType:'none'},createdAt:old?.createdAt||Date.now()};
  const next=old?{...old,mcp:{...old.mcp,command:config.mcp.command,args:config.mcp.args}}:config;
  if(JSON.stringify(old)!==JSON.stringify(next)){write(file,next);created++}
  const guide=join(folder,'guide.md');if(!existsSync(guide))writeFileSync(guide,'# Graphify\n\nПоиск по сохранённому общему графу проектов и заметок Obsidian. Проверяйте confidence и source_file: общий пакет означает общий стек, а не вызов между проектами. Данные обновляются в фоне во время работы Odysseus. При необходимости вызовите node tools/graphify.mjs refresh в папке проекта Odysseus. Не выдавайте старый снимок (stale) за свежие данные.\n',{mode:0o600});
 }
 return created;
}
export function setup(paths){
 const requirements=readFileSync(join(paths.root,'shared/skills/graphify/requirements.txt'),'utf8');
 if(!/^graphifyy==0\.9\.92$/m.test(requirements))throw Error('Graphify dependency lock is missing or invalid. Restore shared/skills/graphify/requirements.txt.');
 mkdirSync(paths.runtime,{recursive:true});
 if(!existsSync(paths.python)){
  const config=read(join(paths.root,'odysseus.json')),desktop=config.components.desktop.source;
  const bundled=join(paths.root,desktop,'apps/electron/resources/bin',`${process.platform}-${process.arch}`,process.platform==='win32'?'uv.exe':'uv');
  const uv=existsSync(bundled)?bundled:'uv';
  const env={...paths.env,UV_CACHE_DIR:join(paths.runtime,'cache'),UV_PYTHON_INSTALL_DIR:join(paths.runtime,'python')};
  run(uv,['venv','--python','3.12',join(paths.runtime,'venv')],{env});
  run(uv,['pip','install','--python',paths.python,'--requirements',join(paths.root,'shared/skills/graphify/requirements.txt')],{env});
 }
 run(paths.python,['-c','import graphify, mcp; import importlib.metadata; assert importlib.metadata.version("graphifyy")=="0.9.92"']);
 const config=read(join(paths.root,'odysseus.json'));for(const [name,component]of Object.entries(config.components||{})){const path=resolve(paths.root,component.source);if(isDir(path))registerProject(paths,path,name==='cli'?'Odysseus CLI':'Odysseus Desktop')}
 const sources=connectDesktopSources(paths,homedir(),{rebind:true});const vault=ensureVault(paths);console.log(JSON.stringify({engine:'graphify 0.9.92',vault,desktopSources:sources},null,2));
 return refresh(paths);
}
export function readRegistry(paths){
 const projects={};if(existsSync(paths.registry))for(const file of readdirSync(paths.registry))if(file.endsWith('.json')){const p=read(join(paths.registry,file));if(p.id)projects[p.id]=p}return {projects};
}
export function registerProject(paths,path,name){
 path=realpathSync(resolve(path));if(!isDir(path))throw Error('Project folder unavailable');
 const registry=readRegistry(paths),id=createHash('sha256').update(path).digest('hex').slice(0,16);
 registry.projects[id]={...registry.projects[id],id,path,name:name||registry.projects[id]?.name||basename(path)};write(join(paths.registry,id+'.json'),registry.projects[id]);return registry.projects[id];
}
function discoverProjects(paths){
 const desktopHome=paths.env.NESSY_CONFIG_DIR||join(homedir(),'.nessy-agent'),base=join(desktopHome,'workspaces');
 if(!existsSync(base))return;
 for(const w of readdirSync(base)){const projects=join(base,w,'projects');if(!isDir(projects))continue;for(const slug of readdirSync(projects)){try{const c=read(join(projects,slug,'config.json'));if(!c.archivedAt&&isDir(c.folder?.workingDirectory))registerProject(paths,c.folder.workingDirectory,c.name)}catch(e){console.error('Project discovery:',e.message)}}}
}
export function refresh(paths,{projects=false,quiet=false}={}){
 if(!existsSync(paths.python))throw Error('Graphify engine is not installed. Run: node tools/graphify.mjs setup');
 mkdirSync(paths.runtime,{recursive:true});const lock=join(paths.runtime,'refresh.pid');const previous=read(lock,{pid:0});
 if(previous.pid){try{process.kill(previous.pid,0);throw Error('База знаний уже обновляется; дождитесь завершения фонового прохода.')}catch(error){if(error.code==='ESRCH')unlinkSync(lock);else throw error}}
 const fd=openSync(lock,'wx',0o600);writeFileSync(fd,JSON.stringify({pid:process.pid}));closeSync(fd);
 try{
 const selection=ensureVault(paths);mkdirSync(paths.output,{recursive:true});
 run(paths.python,[join(paths.root,'shared/skills/graphify/scripts/obsidian_bridge.py'),'--vault',selection.path,'--output',join(paths.output,'notes')],{capture:quiet});
 if(projects){connectDesktopSources(paths);discoverProjects(paths);
  for(const p of Object.values(readRegistry(paths).projects)){try{run(paths.python,[join(paths.root,'tools/knowledge_projects.py'),'index','--metadata-only','--project',p.path,'--name',p.name,'--id',p.id,'--output',paths.output],{capture:quiet})}catch(e){console.error('Project metadata deferred:',p.name,e.message)}}
  run(paths.python,[join(paths.root,'tools/knowledge_projects.py'),'merge','--vault',selection.path,'--output',paths.output],{capture:quiet});
  for(const p of Object.values(readRegistry(paths).projects)){try{
  run(paths.python,[join(paths.root,'tools/knowledge_projects.py'),'index','--project',p.path,'--name',p.name,'--id',p.id,'--output',paths.output],{timeout:650000});
 }catch(e){console.error('Project index deferred:',p.name,e.message);write(join(paths.output,'projects',p.id,'error.json'),{error:e.message,at:new Date().toISOString()})}}}
 run(paths.python,[join(paths.root,'tools/knowledge_projects.py'),'merge','--vault',selection.path,'--output',paths.output],{capture:quiet});
 run(process.execPath,[join(paths.root,'tools/knowledge-ui.mjs'),'prepare-scopes'],{capture:true,env:paths.env});
 const error=join(paths.runtime,'last-error.json');if(existsSync(error))unlinkSync(error);
 return selection;
 }finally{if(read(lock).pid===process.pid)unlinkSync(lock)}
}
export async function watch(paths,parent){
 mkdirSync(paths.runtime,{recursive:true});
 if(Number.isSafeInteger(Number(parent))&&Number(parent)>0)write(join(paths.runtime,'watch-parents',String(parent)+'.json'),{pid:Number(parent)});
 const lock=join(paths.runtime,'watch.pid');
 const previous=read(lock,{pid:0});if(previous.pid){if(processIsAlive(previous.pid))return;try{unlinkSync(lock)}catch{}}
 try{const fd=openSync(lock,'wx',0o600);writeFileSync(fd,JSON.stringify({pid:process.pid}));closeSync(fd)}catch(e){if(e.code==='EEXIST')return;throw e}let stopping=false;process.on('SIGTERM',()=>{stopping=true});process.on('SIGINT',()=>{stopping=true});
 try{do{try{refresh(paths,{projects:true})}catch(e){write(join(paths.runtime,'last-error.json'),{error:e.message,at:new Date().toISOString()})}
  if(stopping)break;await new Promise(r=>setTimeout(r,30000));let live=false;const leases=join(paths.runtime,'watch-parents');if(existsSync(leases))for(const file of readdirSync(leases)){const p=read(join(leases,file));if(processIsAlive(p.pid))live=true;else unlinkSync(join(leases,file))}if(!live)break;
 }while(!stopping)}finally{if(read(lock).pid===process.pid)unlinkSync(lock)}
}
export function startWatcher(paths,parent=process.pid){
 if(!existsSync(paths.python))return;
 write(join(paths.runtime,'watch-parents',String(parent)+'.json'),{pid:Number(parent)});
 const previous=read(join(paths.runtime,'watch.pid'),{pid:0});if(previous.pid&&processIsAlive(previous.pid))return;
 const log=openSync(join(paths.runtime,'watch.log'),'a',0o600);
 const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'watch','--parent',String(parent)],{cwd:paths.root,env:paths.env,stdio:['ignore',log,log],detached:true});
 child.on('error',error=>write(join(paths.runtime,'last-error.json'),{error:error.message,at:new Date().toISOString()}));closeSync(log);child.unref();
}
async function main(){const paths=runtimePaths(),args=process.argv.slice(2),mode=args.shift()||'doctor';
 if(mode==='setup')return setup(paths);
 if(mode==='register'){const p=registerProject(paths,args[0]||process.cwd(),args[1]);console.log(JSON.stringify(p));return}
 if(mode==='refresh')return refresh(paths,{projects:true});
 if(mode==='watch')return watch(paths,args[args.indexOf('--parent')+1]);
 if(mode==='serve'){
  if(!existsSync(join(paths.output,'graph.json')))refresh(paths,{quiet:true});
  const at=args.indexOf('--collection'),collection=at>=0?args[at+1]:(paths.env.ODYSSEUS_KNOWLEDGE_COLLECTION||'projects');
  if(!/^[a-z0-9-]{1,64}$/.test(collection||''))throw Error('Invalid knowledge catalog');
  run(process.execPath,[join(paths.root,'tools/knowledge-ui.mjs'),'prepare-scopes'],{capture:true,env:paths.env});
  const graph=join(paths.output,'collections',collection,'graphify-out/graph.json');if(!existsSync(graph))throw Error('Knowledge catalog unavailable');
  const child=spawn(paths.python,['-m','graphify.serve',graph],{stdio:'inherit',env:{...paths.env,GRAPHIFY_MAX_CONTEXTS:paths.env.GRAPHIFY_MAX_CONTEXTS||'2'}});
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));child.on('exit',code=>{process.exitCode=code??1});return;
 }
 if(mode==='record'){
  const project=args.shift(),text=args.join(' ');if(!text.trim())throw Error('Usage: graphify.mjs record PROJECT "Decision and source evidence"');
  const p=registerProject(paths,project),dir=join(paths.output,'projects',p.id);mkdirSync(dir,{recursive:true});
  const notes=read(join(dir,'decisions.json'),{entries:[]});notes.entries.push({text,at:new Date().toISOString()});write(join(dir,'decisions.json'),notes);return refresh(paths,{projects:true});
 }
 if(mode==='doctor'){console.log(JSON.stringify({installed:existsSync(paths.python),vault:findVault({root:paths.root,env:paths.env,config:read(paths.config)}),projects:readRegistry(paths),graphReady:existsSync(join(paths.output,'graph.json')),lastError:read(join(paths.runtime,'last-error.json'),null)},null,2));return}
 throw Error('Commands: setup, doctor, register PATH [NAME], refresh, record PROJECT TEXT, serve, watch');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1});
