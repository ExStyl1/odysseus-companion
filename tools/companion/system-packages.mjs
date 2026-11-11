import {readFileSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {systemPackages} from './task-catalog.mjs';
import {skillLibrary,skillDirectoryHash} from './skill-library.mjs';
import {mcpCatalog,skills} from './catalog.mjs';
import {json} from './paths.mjs';
import {workspaceStore,fingerprint,uid,now} from './workspace-store.mjs';
import {privateWrite,noLinks} from '../personal/store.mjs';

export function systemPackageService(paths){
 const store=workspaceStore(paths),settingsFile=join(paths.profile,'settings.json'),library=skillLibrary(paths);
 function preview(i){
  const definition=systemPackages.find(p=>p.id===i.id);if(!definition)throw Error('Пакет не найден');
  const matches=s=>definition.skills.includes(s.name.split(':').at(-1));
  const compare=library.compare().entries.filter(matches),installed=skills(paths).filter(matches),settings=json(settingsFile);
  const missing=compare.filter(s=>s.status==='missing');
  const names=[...new Set([...installed,...missing].map(s=>s.name))];
  const servers=mcpCatalog(paths).filter(s=>definition.servers.includes(s.name));
  const disabled=settings.skills?.disabled||[],excluded=settings.mcp?.excluded||[];
  const changes={install:missing.map(s=>({id:s.id,name:s.name,target:s.target,hash:s.sourceHash})),enableSkills:names.filter(n=>disabled.includes(n)),enableMcp:servers.filter(s=>!s.enabled).map(s=>s.name)};
  const unchanged=compare.filter(s=>s.status==='different').map(s=>s.name);
  const missingServers=definition.servers.filter(n=>!servers.some(s=>s.name===n));
  const unavailable=definition.skills.filter(n=>![...installed,...compare].some(s=>s.name.split(':').at(-1)===n));
  const disabledExtensions=[...new Set([...installed,...missing].filter(s=>(settings.extensions?.disabled||[]).includes(s.package)).map(s=>s.package))];
  const token=fingerprint({changes,settings:readFileSync(settingsFile,'utf8'),compare:compare.map(s=>[s.id,s.sourceHash,s.installedHash])});
  return {id:definition.id,name:definition.name,changes,unchanged,missingServers,unavailable,disabledExtensions,expectedHash:token,canApply:!disabledExtensions.length&&(changes.install.length+changes.enableSkills.length+changes.enableMcp.length)>0,notice:'Устанавливаются доступные навыки из комплекта, включаются найденные MCP. Отсутствующие корпоративные подключения требуют отдельной настройки. Отличающиеся инструкции сохраняются.'};
 }
 function history(){return (store.read().systemPackageHistory||[]).map(({id,packageId,name,status,at,rolledBackAt})=>({id,packageId,name,status,at,rolledBackAt}));}
 function validateEntry(entry){
  const def=systemPackages.find(p=>p.id===entry.packageId);if(!def||!/^[a-f0-9-]{36}$/.test(entry.id||''))throw Error('Некорректный журнал пакета');
  const known=library.compare().entries;
  for(const skill of entry.changes.install){const found=known.find(s=>s.id===skill.id);if(!found||found.target!==skill.target||found.name!==skill.name||!def.skills.includes(skill.name.split(':').at(-1))||!/^[a-f0-9]{64}$/.test(skill.hash))throw Error('Журнал ссылается на неизвестный путь навыка');}
  if(entry.changes.enableSkills.some(n=>!def.skills.includes(n.split(':').at(-1)))||entry.changes.enableMcp.some(n=>!def.servers.includes(n)))throw Error('Журнал ссылается на компоненты другого пакета');
 }
 function pending(){const dir=join(paths.home,'package-transactions');noLinks(dir);if(!existsSync(dir))return [];const known=new Set(history().map(e=>e.id));const rows=[];
  for(const name of readdirSync(dir)){if(!/^[a-f0-9-]{36}\.json$/.test(name))continue;const entry=json(join(dir,name));if(entry.id+'.json'!==name||known.has(entry.id)||!['applying','installed','failed'].includes(entry.status))continue;rows.push({id:entry.id,packageId:entry.packageId,name:entry.name,status:entry.status,at:entry.at});}return rows;
 }
 function recoveryPreview(i){const pendingEntry=pending().find(e=>e.id===i.id);if(!pendingEntry)throw Error('Незавершённая установка не найдена');const entry=json(join(paths.home,'package-transactions',pendingEntry.id+'.json'));validateEntry(entry);
  const settings=json(settingsFile),skills=entry.changes.install.map(s=>({...s,currentHash:skillDirectoryHash(dirname(s.target))}));
  const modified=skills.filter(s=>s.currentHash&&s.currentHash!==s.hash).map(s=>s.name);
  const changedMcp=entry.changes.enableMcp.filter(n=>fingerprint(settings.mcpServers?.[n]||null)!==entry.mcpHashes?.[n]);
  return {id:entry.id,name:entry.name,removeSkills:skills.filter(s=>s.currentHash===s.hash).map(s=>s.name),restoreSkills:entry.changes.enableSkills.filter(n=>!(settings.skills?.disabled||[]).includes(n)),restoreMcp:entry.changes.enableMcp.filter(n=>!(settings.mcp?.excluded||[]).includes(n)),modified,changedMcp,canRecover:!modified.length&&!changedMcp.length,expectedHash:fingerprint({entry,settings,skills})};
 }
 function recover(i){const plan=recoveryPreview(i);if(!plan.canRecover||plan.expectedHash!==i.expectedHash)throw Error('Установка изменена или есть ручные правки. Обновите предпросмотр восстановления.');
  store.mutate(s=>{const current=recoveryPreview(i);if(current.expectedHash!==i.expectedHash)throw Error('Состояние изменилось во время восстановления');const entry=json(join(paths.home,'package-transactions',plan.id+'.json'));entry.changes.install=entry.changes.install.filter(e=>plan.removeSkills.includes(e.name));entry.changes.enableSkills=plan.restoreSkills;entry.changes.enableMcp=plan.restoreMcp;entry.status='installed';s.systemPackageHistory||=[];s.systemPackageHistory.push(entry);});
  return rollback({id:i.id});
 }
 function apply(i){return store.mutate(state=>{
  const plan=preview(i);if(plan.expectedHash!==i.expectedHash)throw Error('Пакет или настройки изменились. Повторите предпросмотр.');if(!plan.canApply)throw Error('Нет доступных изменений или расширение выключено.');
  const entry={id:uid(),packageId:plan.id,name:plan.name,status:'applying',at:now(),changes:plan.changes,mcpHashes:Object.fromEntries(plan.changes.enableMcp.map(n=>[n,fingerprint(json(settingsFile).mcpServers[n])]))};
  const journal=join(paths.home,'package-transactions',entry.id+'.json');privateWrite(journal,JSON.stringify(entry));
  const original=readFileSync(settingsFile,'utf8');const added=[];let writtenSettings;
  try{
   for(const skill of plan.changes.install){const result=library.install({id:skill.id});if(!result.installed)throw Error('Навык появился после предпросмотра. Повторите установку.');added.push(skill);}
   if(readFileSync(settingsFile,'utf8')!==original)throw Error('Настройки изменились во время установки.');
   const settings=JSON.parse(original);
   if(plan.changes.enableSkills.length)settings.skills={...settings.skills,disabled:(settings.skills?.disabled||[]).filter(n=>!plan.changes.enableSkills.includes(n))};
   if(plan.changes.enableMcp.length)settings.mcp={...settings.mcp,excluded:(settings.mcp?.excluded||[]).filter(n=>!plan.changes.enableMcp.includes(n))};
   writtenSettings=JSON.stringify(settings,null,2);privateWrite(settingsFile,writtenSettings);
   entry.status='installed';privateWrite(journal,JSON.stringify(entry));
   state.systemPackageHistory||=[];state.systemPackageHistory.push(entry);
   return {installed:true,id:entry.id,restartNessy:true,installedSkills:added.length,enabledMcp:plan.changes.enableMcp.length,missingServers:plan.missingServers,unavailable:plan.unavailable};
  }catch(error){
   if(writtenSettings&&readFileSync(settingsFile,'utf8')===writtenSettings)privateWrite(settingsFile,original);
   for(const skill of added)if(skillDirectoryHash(dirname(skill.target))===skill.hash){noLinks(dirname(skill.target));rmSync(dirname(skill.target),{recursive:true});}
   entry.status='failed';entry.error='Установка не завершена';privateWrite(journal,JSON.stringify(entry));throw error;
  }
 });}
 function rollback(i){return store.mutate(state=>{
  const entry=(state.systemPackageHistory||[]).find(e=>e.id===i.id);if(!entry||entry.status!=='installed')throw Error('Установка для отката не найдена');
  validateEntry(entry);
  const settingsBefore=readFileSync(settingsFile,'utf8'),settings=JSON.parse(settingsBefore),changes=entry.changes;
  for(const skill of changes.install)if(skillDirectoryHash(dirname(skill.target))!==skill.hash)throw Error('Навык изменён после установки. Откат остановлен: '+skill.name);
  const disabled=settings.skills?.disabled||[],excluded=settings.mcp?.excluded||[];
  if(changes.enableMcp.some(n=>fingerprint(settings.mcpServers?.[n]||null)!==entry.mcpHashes?.[n]))throw Error('Конфигурация MCP изменена после установки. Откат остановлен.');
  if(changes.enableSkills.some(n=>disabled.includes(n))||changes.enableMcp.some(n=>excluded.includes(n)))throw Error('Состояние инструментов изменилось после установки. Откат остановлен.');
  // A later package can share a newly installed skill or an enabled dependency.
  const later=state.systemPackageHistory.filter(e=>e.id!==entry.id&&e.at>=entry.at&&e.status==='installed');
  const definitions=later.map(e=>systemPackages.find(p=>p.id===e.packageId)).filter(Boolean);
  if(changes.install.some(s=>definitions.some(d=>d.skills.includes(s.name.split(':').at(-1))))||changes.enableSkills.some(n=>definitions.some(d=>d.skills.includes(n.split(':').at(-1))))||changes.enableMcp.some(n=>definitions.some(d=>d.servers.includes(n))))throw Error('Компоненты нужны более позднему пакету. Сначала откатите его.');
  const archive=join(paths.home,'package-transactions',entry.id+'-before-rollback-settings.json');privateWrite(archive,readFileSync(settingsFile,'utf8'));
  // Keep installed files as recoverable backups rather than deleting user data.
  for(const skill of changes.install){noLinks(dirname(skill.target));}
  const backupRoot=join(paths.home,'package-transactions',entry.id+'-skills');
  for(const skill of changes.install){libraryBackup(dirname(skill.target),join(backupRoot,fingerprint(skill.id)));}
  if(readFileSync(settingsFile,'utf8')!==settingsBefore)throw Error('Настройки изменились во время отката. Повторите действие.');
  let writtenSettings;
  try{
  for(const skill of changes.install){if(skillDirectoryHash(dirname(skill.target))!==skill.hash)throw Error('Навык изменился во время отката');rmSync(dirname(skill.target),{recursive:true});}
  if(changes.enableSkills.length)settings.skills={...settings.skills,disabled:[...new Set([...disabled,...changes.enableSkills])]};
  if(changes.enableMcp.length)settings.mcp={...settings.mcp,excluded:[...new Set([...excluded,...changes.enableMcp])]};
  if(readFileSync(settingsFile,'utf8')!==settingsBefore)throw Error('Настройки изменились во время отката');
  writtenSettings=JSON.stringify(settings,null,2);privateWrite(settingsFile,writtenSettings);entry.status='rolled-back';entry.rolledBackAt=now();
  privateWrite(join(paths.home,'package-transactions',entry.id+'.json'),JSON.stringify(entry));
  return {rolledBack:true,restartNessy:true};
  }catch(error){
   for(const skill of changes.install)if(!existsSync(dirname(skill.target)))libraryBackup(join(backupRoot,fingerprint(skill.id)),dirname(skill.target));
   if(writtenSettings&&readFileSync(settingsFile,'utf8')===writtenSettings)privateWrite(settingsFile,settingsBefore);throw error;
  }
 });}
 return {preview,apply,rollback,history,pending,recoveryPreview,recover};
}
import {cpSync,mkdirSync} from 'node:fs';
function libraryBackup(source,target){noLinks(source);noLinks(target);mkdirSync(dirname(target),{recursive:true,mode:0o700});cpSync(source,target,{recursive:true});}
