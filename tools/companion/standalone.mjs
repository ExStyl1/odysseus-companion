import { connectDiscoveredNessy } from './nessy-discovery.mjs';
import {agentDefinitions} from './agent-definitions.mjs';
import { memoryService } from './memory.mjs';
import { installationManager } from './installer.mjs';
import { cpSync, existsSync, mkdirSync, readFileSync, chmodSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { privateWrite } from '../personal/store.mjs';
import { json } from './paths.mjs';
import { configureAutomaticSkills } from './automatic-skills.mjs';
import { execFileSync } from 'node:child_process';
const quote=s=>"'"+s.replaceAll("'","'\"'\"'")+"'";
function copyData(source,target,skip=[]){
 if(!source||!existsSync(source)||existsSync(target))return;
 cpSync(source,target,{recursive:true,filter:p=>!lstatSync(p).isSymbolicLink()&&!skip.includes(p.split('/').at(-1))});
}
/** User state lives outside the signed app; never package credentials into the .app. */
export function prepareStandalone(paths,{legacyHome,previousRoot,node=process.execPath,userDirectory}={}){
 mkdirSync(paths.home,{recursive:true,mode:0o700});
 const marker=join(paths.home,'standalone-installation.json'),prior=json(marker);
 const source=legacyHome&&existsSync(join(legacyHome,'installation.json'))?legacyHome:null;
 if(!existsSync(paths.profile)){
   copyData(source?join(source,'nessy'):join(paths.root,'seed/profile'),paths.profile);
   if(!existsSync(paths.profile))throw Error('Не найден начальный профиль Nessy');
   chmodSync(paths.profile,0o700);
 }
 copyData(source&&join(source,'data'),paths.data,['database.sqlite','database.sqlite-wal','database.sqlite-shm']);
 const sourceDb=source&&join(source,'data/automations/engine/.n8n/database.sqlite'),targetDb=join(paths.data,'automations/engine/.n8n/database.sqlite');
 if(sourceDb&&existsSync(sourceDb)&&!existsSync(targetDb)){
   mkdirSync(join(targetDb,'..'),{recursive:true,mode:0o700});
   execFileSync(paths.knowledge.python,['-c','import sqlite3,sys; a=sqlite3.connect(sys.argv[1]); b=sqlite3.connect(sys.argv[2]); a.backup(b); b.close(); a.close()',sourceDb,targetDb],{timeout:30000});
   chmodSync(targetDb,0o600);
 }
 copyData(source&&join(source,'corporate-n8n'),join(paths.home,'corporate-n8n'));
 if(previousRoot)copyData(join(previousRoot,'.odysseus/graphify'),join(paths.home,'graphify'),['venv','cache','refresh.pid','workflow-worker.json','watch.log']);
 if(!existsSync(join(paths.home,'graphify')))mkdirSync(join(paths.home,'graphify'),{recursive:true,mode:0o700});
 const oldInstallation=source?json(join(source,'installation.json')):{};
 const oldRoot=prior.root||previousRoot||'';
 const oldHome=prior.home||source||'';
 const rebase=x=>{
   if(typeof x==='string'){
     if(oldHome)x=x.replaceAll(oldHome,paths.home);
     if(oldRoot)x=x.replaceAll(oldRoot,paths.root);
     return x;
   }
   if(Array.isArray(x))return x.map(rebase);
   if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,rebase(v)]));
   return x;
 };
 const settingsFile=join(paths.profile,'settings.json'),settings=rebase(json(settingsFile));
 settings.mcpServers||={};
 for(const [name,c]of Object.entries(settings.mcpServers)){
   if(c.command?.endsWith('/npx'))c.command=join(paths.root,'bin/npx');
   if(c.command?.endsWith('/dp'))c.command=join(paths.profile,'dp_latest/dp');
 }
 settings.mcpServers['odysseus-companion']={command:node,args:[join(paths.root,'tools/companion/mcp.mjs')],env:{ODYSSEUS_ROOT:paths.root,ODYSSEUS_COMPANION_HOME:paths.home,ODYSSEUS_COMPANION_STANDALONE:'1',NODE_EXTRA_CA_CERTS:join(paths.profile,'certs/tinkoff-bundle.crt')},timeout:240000};
 // Retire only Companion's legacy hooks; all other Nessy hooks remain intact.
 settings.hooks||={};
 for(const event of ['UserPromptSubmit','Stop'])settings.hooks[event]=(settings.hooks[event]||[]).filter(g=>!JSON.stringify(g).includes('--companion-knowledge')&&!JSON.stringify(g).includes('--companion-auto-skills'));
 privateWrite(settingsFile,JSON.stringify(settings,null,2));
 const migrationWarnings=[];
 if(prior.resourcesVersion!==14||prior.root!==paths.root){
   const integrationSkill=join(paths.profile,'skills/odysseus-companion/SKILL.md'),bundledSkill=join(paths.root,'companion/skills/odysseus-companion/SKILL.md');
   if(!existsSync(integrationSkill)&&existsSync(bundledSkill)){
    privateWrite(integrationSkill,readFileSync(bundledSkill,'utf8'));
   }
   memoryService(paths).migrateLegacy();
   try{installationManager(paths,{node}).install();}catch(error){migrationWarnings.push('Расширение сохранено без перезаписи: '+error.message);}
   try{configureAutomaticSkills(paths);}catch(error){migrationWarnings.push('Подбор навыков требует проверки: '+error.message);}
 }else migrationWarnings.push(...(prior.migrationWarnings||[]).filter(message=>!message.startsWith('Подключение Nessy:')));
 let nessyConnection=null;
 try {
   nessyConnection=connectDiscoveredNessy(paths,installationManager(paths,{node}),userDirectory);
 } catch (error) {
   migrationWarnings.push('Подключение Nessy: '+error.message);
 }
 const launcher=join(paths.home,'Открыть Nessy с Companion.command');
 privateWrite(launcher,'#!/bin/zsh\nset -e\nexport ODYSSEUS_ROOT='+quote(paths.root)+'\nexport ODYSSEUS_COMPANION_HOME='+quote(paths.home)+'\nexport ODYSSEUS_COMPANION_STANDALONE=1\nexec '+quote(node)+' '+quote(join(paths.root,'tools/companion/launch-nessy.mjs'))+' "$@"\n');chmodSync(launcher,0o700);
 const install=rebase({...oldInstallation,...json(paths.installation)});
 privateWrite(paths.installation,JSON.stringify({...install,name:'Odysseus Companion',profile:paths.profile,launcher,standalone:true},null,2));
 const state={version:1,resourcesVersion:14,nessyConnection,migrationWarnings,root:paths.root,home:paths.home,migratedFrom:prior.migratedFrom||source,preparedAt:new Date().toISOString()};
 const vault=json(join(paths.home,'graphify/vault-selection.json')).path;
 if(!vault||!existsSync(vault)){
   const localVault=join(paths.home,'Obsidian');mkdirSync(localVault,{recursive:true,mode:0o700});
   privateWrite(join(paths.home,'graphify/vault-selection.json'),JSON.stringify({path:localVault,reason:'companion-vault'}));
   const graphConfig=json(join(paths.home,'graphify/config.json'));if(graphConfig.vault&&!existsSync(graphConfig.vault)){delete graphConfig.vault;privateWrite(join(paths.home,'graphify/config.json'),JSON.stringify(graphConfig));}
 }
 agentDefinitions(paths).ensure();privateWrite(marker,JSON.stringify(state,null,2));return state;
}
