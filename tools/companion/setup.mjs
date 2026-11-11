import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, readdirSync, lstatSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { companionPaths, json } from './paths.mjs';
import { privateWrite } from '../personal/store.mjs';
import { initializeConfig } from './platform.mjs';
import { finalizeProfile } from './resources.mjs';
import { importNessyModel } from './nessy-model.mjs';
import { isolateLegacyContext } from './legacy-context.mjs';
import { configureAutomaticSkills } from './automatic-skills.mjs';
const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
export function setupCompanion(paths,{source=resolve(paths.root,'../nessy-backup/nessy-copy'),node=process.execPath}={}) {
  if(existsSync(paths.installation)) return {...json(paths.installation),alreadyInstalled:true};
  if(!existsSync(join(source,'settings.json'))) throw Error('Не найдена копия Nessy: '+source);
  if(existsSync(paths.profile)) throw Error('Незавершённая подготовка профиля: '+paths.profile);
  mkdirSync(paths.home,{recursive:true,mode:0o700});
  const staging=join(paths.home,'nessy-stage-'+randomUUID());
  // Copy data, never execute extension installers or follow backup symlinks.
  cpSync(source,staging,{recursive:true,filter:p=>!lstatSync(p).isSymbolicLink()&&!/(?:^|\/)(?:\.DS_Store|[^/]*\.lock|lock|refresh\.lock|\.subagent-cleanup[^/]*|\.debug-logs-cleanup[^/]*)$/.test(p)});
  chmodSync(staging,0o700);
  const settings=json(join(staging,'settings.json'));
  privateWrite(join(staging,'original-settings.json'),JSON.stringify(settings,null,2));
  const canonical={}; const repairs=[];
  const extRoot=join(staging,'extensions');
  const order=readdirSync(extRoot,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name).sort((a,b)=>(a==='nessy-default-extension'?-1:b==='nessy-default-extension'?1:a.localeCompare(b)));
  for(const name of order) {
    const file=join(extRoot,name,'nessy-extension.json');if(!existsSync(file))continue;
    const manifest=json(file);
    for(const [key,value] of Object.entries(manifest.mcpServers||{})) if(!canonical[key]) canonical[key]=structuredClone(value);
    if(manifest.mcpServers){privateWrite(join(extRoot,name,'original-mcp.json'),JSON.stringify(manifest.mcpServers,null,2));delete manifest.mcpServers;}
    for(const key of ['agents','skills','commands']) if(typeof manifest[key]==='string'&&!existsSync(join(extRoot,name,manifest[key]))) {delete manifest[key];repairs.push(name+': удалена ссылка на отсутствующий '+key);}
    privateWrite(file,JSON.stringify(manifest,null,2));
  }
  const broken=join(extRoot,'qa-testing-toolkit/.nessy/extensions/quality-gate-profiler/nessy-extension.json');
  if(existsSync(broken)) {
    const text=readFileSync(broken,'utf8');
    try{JSON.parse(text);}catch{
      // Only raw line breaks inside JSON strings; retain escaped newlines.
      let inside=false,escape=false,out='';
      for(const c of text){if(inside&&c==='\n')out+='\\n';else if(inside&&c==='\r')out+='\\r';else out+=c;
        if(c==='"'&&!escape)inside=!inside;escape=c==='\\'&&!escape;}
      privateWrite(broken,JSON.stringify(JSON.parse(out),null,2));repairs.push('Исправлен JSON Quality Gate');
    }
  }
  const archived=join(staging,'original-skills');renameSync(join(staging,'skills'),archived);
  cpSync(join(paths.root,'shared/skills'),join(staging,'skills'),{recursive:true});
  const aliases=json(join(paths.root,'shared/skills-consolidation.json')).aliases||{};
  const imports=json(join(paths.root,'shared/user-skills-import.json')).items||[];
  const mapped=Object.fromEntries(imports.filter(i=>i.sourcePath.split('/').length===2).map(i=>[i.sourcePath.split('/')[0],i.name]));
  const added=[];
  for(const e of readdirSync(archived,{withFileTypes:true}).filter(e=>e.isDirectory())) {
    const target=aliases[mapped[e.name]]||mapped[e.name]||aliases[e.name]||e.name;
    if(!existsSync(join(staging,'skills',target))) {cpSync(join(archived,e.name),join(staging,'skills',e.name),{recursive:true});added.push(e.name);}
  }
  cpSync(join(paths.root,'companion/skills/odysseus-companion'),join(staging,'skills/odysseus-companion'),{recursive:true});
  const profile=paths.profile,dp=join(profile,'dp_latest/dp');
  for(const [name,c] of Object.entries(canonical)) {
    if(c.command==='${NESSY_DP}'||c.command==='dp')c.command=dp;
    if(c.command==='npx')c.command=join(dirname(node),'npx');
    const replace=x=>typeof x==='string'?x.replaceAll('${NESSY_DP}',dp).replaceAll('${NESSY_HOME}',profile).replaceAll('/Users/ant.v.shevelev/.nessy',profile):x;
    c.args=c.args?.map(replace);if(c.env)c.env=Object.fromEntries(Object.entries(c.env).map(([k,v])=>[k,replace(v)]));
    if(c.env?.NODE_TLS_REJECT_UNAUTHORIZED==='0'){delete c.env.NODE_TLS_REJECT_UNAUTHORIZED;repairs.push(name+': восстановлена проверка TLS');}
    if(c.env?.DP_WORKDIR)c.env.DP_WORKDIR=join(profile,'dp_latest');
    if(c.url&&!c.httpUrl){c.httpUrl=c.url;c.type=c.type||'http';}
  }
  canonical['odysseus-companion']={command:node,args:[join(paths.root,'tools/companion/mcp.mjs')],env:{ODYSSEUS_ROOT:paths.root,ODYSSEUS_COMPANION_HOME:paths.home,ODYSSEUS_DATA_DIR:paths.data,NODE_EXTRA_CA_CERTS:join(profile,'certs/tinkoff-bundle.crt')},timeout:240000};
  settings.mcpServers=canonical;
  settings.mcp={...settings.mcp,excluded:[...new Set([...(settings.mcp?.excluded||[]),'filesystem','dpKube'])]};
  // A different user's durable command grants are not the new user's approvals.
  settings.permissions={allow:[]};
  const command=quote(node)+' '+quote(join(paths.root,'tools/knowledge-workflow.mjs'));
  settings.hooks={...settings.hooks};
  for(const [event,mode] of [['UserPromptSubmit','before'],['Stop','after']]) {
    settings.hooks[event]=[...(settings.hooks[event]||[]).filter(g=>!JSON.stringify(g).includes('--companion-knowledge')),
      {hooks:[{type:'command',command:command+' '+mode+' --companion-knowledge',timeout:10000}]}];
  }
  privateWrite(join(staging,'settings.json'),JSON.stringify(settings,null,2));
  // No old-home enablement rules: use Nessy's documented global default.
  privateWrite(join(staging,'extensions/extension-enablement.json'),'{}\n');
  privateWrite(join(staging,'COMPANION.md'),'# Odysseus Companion\n\nПлатформа доступна через MCP odysseus-companion. Навык: odysseus-companion. Исходные навыки и настройки сохранены в original-skills и original-settings.json.\n');
  renameSync(staging,profile);
  finalizeProfile(paths);
  isolateLegacyContext(paths);
  configureAutomaticSkills(paths);
  const activeSettings=json(join(profile,'settings.json'));
  activeSettings.hooks.UserPromptSubmit.unshift({hooks:[{type:'command',command:quote(node)+' '+quote(join(paths.root,'tools/companion/automatic-skills.mjs'))+' hook --companion-auto-skills',timeout:10000}]});
  privateWrite(join(profile,'settings.json'),JSON.stringify(activeSettings,null,2));
  initializeConfig(paths);
  let modelImport;
  try{importNessyModel(paths);modelImport='Настроено подключение к выбранной модели Nessy';}catch(e){modelImport=e.message;}
  const launcher=join(paths.home,'Открыть Nessy с Companion.command');
  const env={NESSY_HOME:profile,NESSY_RUNTIME_DIR:profile,ODYSSEUS_ROOT:paths.root,ODYSSEUS_COMPANION_HOME:paths.home,ODYSSEUS_DATA_DIR:paths.data,NESSY_DP:dp};
  privateWrite(launcher,'#!/bin/zsh\nset -e\n'+Object.entries(env).map(([k,v])=>'export '+k+'='+quote(v)).join('\n')+'\nexec '+quote(node)+' '+quote(join(paths.root,'tools/companion/launch-nessy.mjs'))+' "$@"\n');chmodSync(launcher,0o700);
  const installation={version:1,name:'Odysseus Companion',source,profile,createdAt:new Date().toISOString(),addedStandalone:added,repairs,mcp:Object.keys(canonical),excludedMcp:settings.mcp.excluded,launcher,modelImport,notes:['Оригинальный backup не изменён','Корпоративные доступы не проверены','filesystem и dpKube ждут подходящей реализации сервера','Рабочая карта знаний общая с исходным проектом; n8n и RAG-индексы отдельные']};
  privateWrite(paths.installation,JSON.stringify(installation,null,2));return installation;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const r=setupCompanion(companionPaths(),{source:process.argv[2]||undefined});console.log(JSON.stringify({profile:r.profile,addedStandalone:r.addedStandalone,repairs:r.repairs,mcp:r.mcp.length,alreadyInstalled:r.alreadyInstalled||false},null,2));}
