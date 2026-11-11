/** JSON hooks only add context and observe logs; no writes to project or Nessy history. */
import { readFileSync } from 'node:fs';
import { companionPaths,json } from './paths.mjs';
import { join } from 'node:path';
import { createObserver } from './observer.mjs';
import { agentRuns } from './agent-runs.mjs';
import { localFirstContext } from './retrieval.mjs';
import { skillHook } from './automatic-skills.mjs';
const paths=companionPaths(process.env.ODYSSEUS_ROOT);Object.assign(process.env,paths.env);
try{
 const raw=readFileSync(0,'utf8');if(raw.length>512000)throw Error('Input too large');const input=JSON.parse(raw);
 const profiles=()=>[...new Set([paths.profile,...(json(join(paths.home,'attached-profiles.json')).profiles||[]).map(p=>p.path)])];
 if(process.argv[2]==='agent-start'||process.argv[2]==='agent-stop'){agentRuns(paths).event(input,process.argv[2]==='agent-start'?'start':'stop');console.log('{}');process.exit(0);}
 createObserver(paths,{profiles}).scan();
 if(process.argv[2]==='before'){
  const r=skillHook(paths,input);r.hookSpecificOutput||={hookEventName:'UserPromptSubmit',additionalContext:''};
  r.hookSpecificOutput.additionalContext=(await localFirstContext(paths,input))+'\n\n'+r.hookSpecificOutput.additionalContext;
  r.hookSpecificOutput.additionalContext+='\nCompanion расширяет Nessy. Для контекста задачи используй knowledge_search; новые записи поступают во Входящие знания для подтверждения пользователем; не выдавай их за подтверждённые факты. После значимого этапа knowledge_save сохраняет проверенный итог с источниками и результатами проверок. Не сохраняй секреты. Для сложных независимых этапов используй odysseus-subagents и штатный Agent/Task, если он доступен.';
  console.log(JSON.stringify(r));
 }else console.log('{}');
}catch{console.log('{}');}
