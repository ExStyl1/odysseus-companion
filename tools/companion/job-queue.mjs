import {fork} from 'node:child_process';import {join} from 'node:path';
import {workspaceStore,uid,now,text,fingerprint,scrub} from './workspace-store.mjs';
import {projectPassports} from './project-passports.mjs';
import {scenarios,scenarioTemplates} from './scenarios.mjs';
export function jobQueue(paths,{forkImpl=fork,killImpl=(pid,signal='SIGTERM')=>process.kill(-pid,signal)}={}){
 const store=workspaceStore(paths),active=new Map();
 const jobs=()=>store.read().automationJobs||[];
 const mutate=(id,fn)=>store.mutate(s=>{const job=(s.automationJobs||[]).find(j=>j.id===id);if(!job)throw Error('Задание не найдено');fn(job);return job;});
 function enqueue(i){const source=text(i.source,160),eventId=text(i.eventId,200),scenarioId=text(i.scenarioId,100),key=fingerprint([source,eventId]);const prepared=scenarios(paths).prompt({id:scenarioId});if(!prepared.cwd)throw Error('Для фонового задания выберите зарегистрированный проект сценария.');
  if(prepared.prompt.length>50000)throw Error('Запрос слишком большой');const inputHash=fingerprint([prepared.cwd,prepared.prompt,prepared.templateId]);
  return store.mutate(s=>{s.automationJobs||=[];const old=s.automationJobs.find(j=>j.key===key);if(old){if(old.inputHash!==inputHash)throw Error('Для этого события уже сохранены другие входные данные');return {job:old,duplicate:true};}if(s.automationJobs.length>=1000)throw Error('Очередь содержит 1000 записей. Требуется архивирование истории.');
   const job={id:uid(),key,source,eventId,scenarioId,templateId:prepared.templateId,inputHash,prompt:prepared.prompt,cwd:prepared.cwd,worktree:prepared.worktree,status:'queued',at:now(),attempts:0,timeoutSeconds:300};s.automationJobs.push(job);return {job,duplicate:false};});
 }
 function finish(id,status,output,exitCode){mutate(id,j=>{j.status=status;j.finishedAt=now();j.output=scrub(output).slice(0,16000);j.exitCode=exitCode;j.executionVerified=false;});}
 function start(i){if(active.size)throw Error('Сначала дождитесь текущего фонового задания.');
  const pending=jobs().find(j=>j.id===i.id);if(!pending||!projectPassports(paths).state().projects.some(p=>p.path===pending.cwd))throw Error('Рабочий проект задания больше не зарегистрирован.');
  if(pending.inputHash!==fingerprint([pending.cwd,pending.prompt,pending.templateId]))throw Error('Входные данные задания изменены. Создайте новое событие.');
  if(!scenarioTemplates.some(t=>t.id===pending.templateId))throw Error('Для задания старой версии нужен новый предпросмотр и новый ID события');
  const job=mutate(i.id,j=>{if(j.status!=='queued')throw Error('Запуск возможен только из очереди.');j.status='running';j.startedAt=now();j.attempts++;j.timeoutSeconds=Number(i.timeoutSeconds||300);if(!Number.isInteger(j.timeoutSeconds)||j.timeoutSeconds<15||j.timeoutSeconds>900)throw Error('Лимит времени от 15 до 900 секунд');});
  const worktree=job.templateId==='development'?'companion-'+job.id:undefined;
  let child,output='',stopped='',timer;const stop=reason=>{if(stopped)return;stopped=reason;try{killImpl(child.pid,'SIGTERM');}catch{child.kill('SIGTERM');}setTimeout(()=>{if(active.has(job.id)){try{killImpl(child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}},2000).unref();};
  try{
   child=forkImpl(join(paths.root,'tools/companion/launch-nessy.mjs'),['--project',job.cwd,'--prompt',job.prompt,'--output-format','json','--max-session-turns','10','--max-tool-calls','30','--max-wall-time',String(job.timeoutSeconds),...(worktree?['--worktree='+worktree]:['--approval-mode=plan'])],{env:{...process.env,...paths.env,ODYSSEUS_ROOT:paths.root,ODYSSEUS_COMPANION_HOME:paths.home,COMPANION_ENFORCE_WRITE_SANDBOX:worktree?'1':'0'},detached:true,stdio:['ignore','pipe','pipe','ipc']});
   active.set(job.id,{child,stop});timer=setTimeout(()=>stop('timeout'),job.timeoutSeconds*1000);timer.unref();
   for(const stream of [child.stdout,child.stderr])stream?.on('data',chunk=>{output+=chunk.toString();if(output.length>500000){output=output.slice(0,500000);stop('output-limit');}});
   child.once('error',e=>{output+='\n'+e.message;clearTimeout(timer);active.delete(job.id);finish(job.id,'failed',e.message,null);});
   child.once('close',code=>{clearTimeout(timer);active.delete(job.id);finish(job.id,stopped==='cancelled'?'cancelled':stopped?'failed':code===0?'review':'failed',(stopped?'Остановлено: '+stopped+'\n':'')+output,code);});
  }catch(e){active.delete(job.id);finish(job.id,'failed',e.message,null);throw e;}
  return {started:true,id:job.id};
 }
 function cancel(i){const worker=active.get(i.id);if(worker){worker.stop('cancelled');return {cancelRequested:true};}return mutate(i.id,j=>{if(j.status!=='queued')throw Error('Задание не находится в очереди');j.status='cancelled';j.finishedAt=now();});}
 function retry(i){if(i.confirmRetry!==true)throw Error('Проверьте частичные внешние действия перед повтором.');return mutate(i.id,j=>{if(!['failed','interrupted'].includes(j.status))throw Error('Повтор доступен после ошибки или прерывания');j.status='queued';});}
 function recover(){store.mutate(s=>{for(const j of s.automationJobs||[])if(j.status==='running'){j.status='interrupted';j.finishedAt=now();j.output='Сервис завершился во время работы. Проверьте возможные частичные действия до повтора.';}});}
 function state(){return {jobs:jobs().map(({prompt,...job})=>job),active:active.size};}
 function close(){for(const worker of active.values())worker.stop('cancelled');}
 return {enqueue,start,cancel,retry,recover,state,close};
}
