import { preferredNessyProfile } from './nessy-discovery.mjs';
/** Additive install: never replace Nessy code, models, auth or permissions. */
import { existsSync, cpSync, mkdirSync, renameSync, rmSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { json } from './paths.mjs';
import { privateWrite, noLinks } from '../personal/store.mjs';
import { walk,redact } from './catalog.mjs';
const owned='odysseus-companion';
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const digest=s=>createHash('sha256').update(s).digest('hex');
const ownedHash=file=>{noLinks(file);return digest(readFileSync(file));};
export function installationManager(paths,{node=process.execPath,onAttach=()=>{}}={}) {
 const registry=join(paths.home,'attached-profiles.json');
 const version=json(join(paths.root,'companion-release.json')).version||json(join(paths.root,'companion/package.json')).version||'unknown';
 const read=()=>json(registry,{profiles:[]});
 function status(){return {managedProfile:paths.profile,activeProfile:preferredNessyProfile(paths),profiles:read().profiles,bundled:true};}
 function install(input={}) {
  const target=resolve(input.profile||paths.profile);noLinks(target);
  if(!existsSync(target)||!lstatSync(target).isDirectory()||!existsSync(join(target,'settings.json')))throw Error('Выберите папку профиля Nessy с settings.json');
  if(realpathSync(target)!==target)throw Error('Профиль должен быть обычной папкой');
  const ext=join(target,'extensions',owned),file=join(target,'settings.json');noLinks(ext);noLinks(file);const settings=json(file),prior=json(join(ext,'companion-owned.json'));
  if(existsSync(ext)&&prior.owner!==owned)throw Error('Имя расширения уже занято; существующие файлы сохранены');
  if(settings.mcpServers?.[owned]&&!prior.owner&&!JSON.stringify(settings.mcpServers[owned]).includes('tools/companion/mcp.mjs'))throw Error('MCP odysseus-companion уже принадлежит другой установке');
  if(prior.hashes)for(const [rel,h]of Object.entries(prior.hashes))if(rel.startsWith('/')||rel.split('/').includes('..')||!existsSync(join(ext,rel))||ownedHash(join(ext,rel))!==h)throw Error('Файлы расширения изменены вручную: '+rel+'. Сохраните изменения перед обновлением.');
  if(prior.hashes)for(const f of walk(ext)){const rel=f.slice(ext.length+1);if(Object.hasOwn(prior.hashes,rel)||['companion-owned.json','.nessy-extension-install.json'].includes(rel))continue;const bundled=join(paths.root,'companion',rel);if(!existsSync(bundled)||digest(readFileSync(f))!==digest(readFileSync(bundled)))throw Error('В расширение добавлены пользовательские файлы: '+rel+'. Сохраните их перед обновлением.');}
  const stage=join(target,'extensions','.companion-stage-'+randomUUID());mkdirSync(stage,{recursive:true,mode:0o700});
  const existingAgentNames=new Set([...walk(join(target,'agents')),...walk(join(target,'extensions'))].filter(f=>/\/agents\/[^/]+\.md$/.test(f)&&!f.startsWith(ext+'/')).map(f=>readFileSync(f,'utf8').match(/^name:\s*(.*)$/m)?.[1]?.replace(/^['"]|['"]$/g,'')));
  try{
   for(const dir of ['skills','agents'])if(existsSync(join(paths.root,'companion',dir)))cpSync(join(paths.root,'companion',dir),join(stage,dir),{recursive:true});
   if(target===paths.profile&&existsSync(join(target,'skills/odysseus-companion/SKILL.md')))rmSync(join(stage,'skills/odysseus-companion'),{recursive:true,force:true});
   const installMetadata=join(ext,'.nessy-extension-install.json');if(existsSync(installMetadata)){noLinks(installMetadata);cpSync(installMetadata,join(stage,'.nessy-extension-install.json'));}
   let count=walk(join(stage,'skills')).filter(f=>f.endsWith('/SKILL.md')).length;
   if(target!==paths.profile&&!input.integrationOnly){
    for(const source of [join(paths.profile,'skills'),join(paths.profile,'extensions')]){
     const candidates=walk(source).filter(f=>f.endsWith('/SKILL.md')&&(source.endsWith('/skills')?f.slice(source.length+1).split('/').length===2:f.slice(source.length+1).split('/').length===4));
     for(const f of candidates.filter(f=>!f.includes('/extensions/odysseus-companion/'))){
      const original=readFileSync(f,'utf8'),match=original.match(/^---\n([\s\S]*?)\n---/);if(!match)continue;
      const slug='library-'+digest(f.slice(paths.profile.length)).slice(0,14),dest=join(stage,'skills',slug);cpSync(join(f,'..'),dest,{recursive:true});
      // Unique public name leaves existing skills in the target profile untouched.
      const name=original.match(/^name:\s*(.*)$/m)?.[1]?.replace(/^['"]|['"]$/g,'')||slug;
      const packageRel=f.slice(join(paths.profile,'extensions').length+1);
      const location=source.endsWith('/extensions')?'\n\nРесурсы исходного пакета сохранены здесь: '+join(ext,'library-packages',packageRel)+'. Относительные ссылки scripts/, agents/ и references/ разрешай от этой исходной инструкции.\n':'';
      privateWrite(join(dest,'SKILL.md'),(original+location).replace(/^name:.*$/m,'name: '+JSON.stringify('odysseus-'+name.replaceAll(':','-'))));count++;
     }
    }
    if(existsSync(join(paths.profile,'extensions')))cpSync(join(paths.profile,'extensions'),join(stage,'library-packages'),{recursive:true});
   }
   if(target!==paths.profile&&!input.integrationOnly){

    for(const f of walk(join(paths.profile,'extensions')).filter(f=>/\/agents\/[^/]+\.md$/.test(f)&&!f.includes('/extensions/odysseus-companion/'))){
     const original=readFileSync(f,'utf8');if(!original.startsWith('---'))continue;
     const name=original.match(/^name:\s*(.*)$/m)?.[1]?.replace(/^['"]|['"]$/g,'');if(!name||existingAgentNames.has(name))continue;existingAgentNames.add(name);
     const renamed='odysseus-library-'+digest(f.slice(paths.profile.length)).slice(0,12);
     privateWrite(join(stage,'agents',renamed+'.md'),original+'\nИсточник ресурсов: '+join(ext,'library-packages',f.slice(join(paths.profile,'extensions').length+1))+'\n');
    }
   }
   privateWrite(join(stage,'nessy-extension.json'),JSON.stringify({name:owned,version,description:'Локальные знания, навыки и субагенты Odysseus Companion',skills:'skills',agents:'agents'}));
   const hashes={};for(const f of walk(stage).filter(f=>!f.endsWith('/.nessy-extension-install.json')))hashes[f.slice(stage.length+1)]=digest(readFileSync(f));
   privateWrite(join(stage,'companion-owned.json'),JSON.stringify({owner:owned,hashes}));
   settings.mcpServers||={};const addedMcp=[];
   const sourceSettings=json(join(paths.profile,'settings.json'));
   // All bundled configurations are installed, but existing names/credentials take precedence.
   for(const [name,config]of Object.entries(input.integrationOnly?{}:sourceSettings.mcpServers||{}))if(name!==owned&&!Object.hasOwn(settings.mcpServers,name)){
    const copy=redact(JSON.parse(JSON.stringify(config)));if(copy.env)copy.env=Object.fromEntries(Object.entries(copy.env).filter(([k])=>!/secret|token|password|api.?key|authorization/i.test(k)));
    settings.mcpServers[name]=copy;addedMcp.push(name);
   }
   const excluded=new Set(settings.mcp?.excluded||[]);for(const name of addedMcp)if((sourceSettings.mcp?.excluded||[]).includes(name))excluded.add(name);if(excluded.size)settings.mcp={...settings.mcp,excluded:[...excluded]};
   const env={ODYSSEUS_ROOT:paths.root,ODYSSEUS_COMPANION_HOME:paths.home,...(paths.env.ODYSSEUS_COMPANION_STANDALONE==='1'?{ODYSSEUS_COMPANION_STANDALONE:'1'}:{})};
   if(existsSync(join(paths.profile,'certs/tinkoff-bundle.crt')))env.NODE_EXTRA_CA_CERTS=join(paths.profile,'certs/tinkoff-bundle.crt');
   settings.mcpServers[owned]={command:node,args:[join(paths.root,'tools/companion/mcp.mjs')],env,timeout:240000};
   const hook='env '+Object.entries(env).map(([k,v])=>k+'='+quote(v)).join(' ')+' '+quote(node)+' '+quote(join(paths.root,'tools/companion/events.mjs'));
   settings.hooks||={};for(const [event,mode]of [['UserPromptSubmit','before'],['Stop','after'],['SubagentStart','agent-start'],['SubagentStop','agent-stop']]){
    settings.hooks[event]=(settings.hooks[event]||[]).filter(g=>!JSON.stringify(g).includes('--companion-extension'));
    settings.hooks[event].push({hooks:[{type:'command',command:hook+' '+mode+' --companion-extension',timeout:10000}]});
   }
   const backup=join(paths.home,'install-backups',digest(target).slice(0,12)+'-'+Date.now()+'.json');privateWrite(backup,readFileSync(file,'utf8'));
   const old=ext+'.previous';if(existsSync(old))rmSync(old,{recursive:true});if(existsSync(ext))renameSync(ext,old);
   try{renameSync(stage,ext);privateWrite(file,JSON.stringify(settings,null,2));}catch(e){rmSync(ext,{recursive:true,force:true});if(existsSync(old))renameSync(old,ext);throw e;}
   rmSync(old,{recursive:true,force:true});
   const state=read();state.profiles=state.profiles.filter(p=>p.path!==target);state.profiles.push({path:target,installedAt:new Date().toISOString(),version,skills:count,addedMcp,backup});privateWrite(registry,JSON.stringify(state));onAttach(target);
   return {installed:true,profile:target,skills:count,addedMcp,restartNessy:true,backup};
  }finally{rmSync(stage,{recursive:true,force:true});}
 }
 return {status,install};
}
