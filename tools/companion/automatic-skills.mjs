import {workspaceStore,uid,now,fingerprint} from './workspace-store.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { privateWrite } from '../personal/store.mjs';
import { skills } from './catalog.mjs';
import { json,companionPaths } from './paths.mjs';
const policy=`<!-- companion-auto-selection -->
## Выбор по задаче

Самостоятельно применяй этот навык, когда запрос соответствует его назначению;
пользователю не нужно знать имя навыка или писать slash-команду. Сначала
выбери подходящий сценарий, затем прочитай инструкции и нужные ресурсы.
Требования исходника о вызове только по имени заменены этим режимом выбора.
Слова «всегда» и «перед любой работой» в исходнике относятся к задаче данного
навыка, а не к каждому сообщению пользователя. Не загружай все навыки сразу.
Автовыбор не расширяет запрос: отправка сообщений, публикация, активация
триггеров и изменения в корпоративных системах требуют соответствующего
поручения пользователя. При отсутствии зависимости сообщи о ней и продолжай
доступную часть задачи. Сохраняй разделение локального и корпоративного n8n.
<!-- /companion-auto-selection -->`;
const packageTags={
 'b2b-qa':'Zoya, Camunda, интеграционные тесты и логи', 'jump-qa':'Zoya, интеграционные тесты',
 'block-kit':'микрофронтенды, ReFormer, TUI, Figma и браузер', 'n8n':'корпоративные процессы n8n.t-tech.team',
 'devplatform-skills':'DevPlatform, GitLab, CI/CD, T-Tracker', 'eda-metrics-suite':'EDA, DWH, DLH, Greenplum и аналитика данных',
 'metric-tree-architect':'дерево бизнес-метрик', 'shopping-ai-skills':'Travel, Hotels, Jira, CX, SLA',
 'autodoc-extensions':'техническая документация AutoDoc', 'quality-gate-toolkit':'Quality Gate, покрытие тестами и линтеры',
 'superpowers':'инженерная разработка, тесты, отладка и ревью', 'procedure-analysis':'логи и процедуры',
};
function field(front,name,value){
 const re=new RegExp('^'+name+':[^\\n]*(?:\\n[ \\t]+[^\\n]*)*','m');
 const line=name+': '+(typeof value==='boolean'?String(value):JSON.stringify(value));
 return re.test(front)?front.replace(re,line):front.trimEnd()+'\n'+line+'\n';
}
export function configureAutomaticSkills(paths){
 const catalog=json(join(paths.root,'shared/skills-catalog.json')).entries||[];
 const byName=new Map(catalog.map(s=>[s.name,s]));const entries=[];
 for(const s of skills(paths)){
   const original=readFileSync(s.path,'utf8'),match=original.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);if(!match)continue;
   const backup=join(paths.profile,'original-auto-selection',relative(paths.profile,s.path));
   if(!existsSync(backup))privateWrite(backup,original);
   const base=s.name.split(':').at(-1),meta=byName.get(base),tags=packageTags[s.package]||'';
   let description=meta?.description||s.descriptionRu||s.description;
   if(!description||['>','|','>-','|-'].includes(description)){
     const folded=match[1].match(/^description:\s*[>|][-+]?\n((?:[ \t]+[^\n]*\n?)*)/m);description=folded?folded[1].replace(/\s+/g,' ').trim():base.replaceAll('-',' ');
   }
   const suffix=tags?' Область: '+tags+'.':'';
   if(suffix&&description.endsWith(suffix))description=description.slice(0,-suffix.length);
   description=(description+suffix).slice(0,980);
   let front=field(match[1],'description',description);front=field(front,'disable-model-invocation',false);front=field(front,'user-invocable',true);
   let body=match[2].replace(/<!-- odysseus-invocation-policy -->[\s\S]*?<!-- \/odysseus-invocation-policy -->\s*/g,'').replace(/<!-- companion-auto-selection -->[\s\S]*?<!-- \/companion-auto-selection -->\s*/g,'').replace(/<!-- companion-corporate-adapter -->[\s\S]*?<!-- \/companion-corporate-adapter -->\s*/g,'');
   if(s.package==='n8n')body='<!-- companion-corporate-adapter -->\nДля чтения n8n.t-tech.team используй corporate_n8n_sync, corporate_n8n_workflow_list/get и corporate_n8n_executions в MCP odysseus-companion. Они работают с API/снимком только на чтение. Инструменты записи из исходного руководства используй только при их фактическом наличии и поручении пользователя. Если их нет, подготовь JSON процесса для импорта, не имитируй публикацию.\n<!-- /companion-corporate-adapter -->\n\n'+body;
   if(s.package!=='odysseus-companion')privateWrite(s.path,'---\n'+front.trim()+'\n---\n\n'+policy+'\n\n'+body.trimStart());
   entries.push({id:s.id,name:s.name,package:s.package,description,category:meta?.category||s.package,when:meta?.when||'',path:s.path});
 }
 const state={version:1,updatedAt:new Date().toISOString(),count:entries.length,entries};
 privateWrite(join(paths.profile,'companion-auto-skills.json'),JSON.stringify(state,null,2));
 // Keep local adaptations reproducible rather than replacing them through unattended package updates.
 for(const p of new Set(entries.filter(s=>s.package!=='Odysseus').map(s=>s.package))){
   const file=join(paths.profile,'extensions',p,'.nessy-extension-install.json');if(!existsSync(file))continue;
   const m=json(file),backup=join(paths.profile,'original-install-metadata',p+'.json');
   if(!existsSync(backup))privateWrite(backup,JSON.stringify(m));m.autoUpdate=false;privateWrite(file,JSON.stringify(m,null,2));
 }
 return state;
}
const rules=[
 [/(?:задач|доск|канбан|kanban)|(?:оцен|папк|сортиров|организ).*(?:чат|разговор|истори)|(?:чат|разговор|истори).*(?:оцен|папк|сортиров|организ)/iu,['odysseus-personal-workspace'],110],
 [/сценари[йяюеив]|scenario/iu,['odysseus-scenario-builder'],170],
 [/(?:созда|измен|редакт|настро|добав|обнов).*(?:субагент|subagent)|(?:субагент|subagent).*(?:созда|измен|редакт|настро|добав|обнов)/iu,['odysseus-agent-builder'],180],
 [/(?:подбер|подбор|подоб|выбер|выбра|выбор|посовет|рекоменд).*(?:mcp|мсп|плагин|инструмент|навык)|(?:mcp|плагин|инструмент|навык).*(?:подбер|подбор|подоб|выбер|выбра|выбор|посовет|рекоменд)/iu,['odysseus-tool-advisor'],170],
 [/rag|граф\S*\s+знани|баз\S*\s+знани/iu,['odysseus-knowledge-guide'],170],
 [/n8n|н8н/iu,['odysseus-n8n'],160],
 [/субагент|subagent|параллельн.*(?:задач|разработ)|разби.*задач/iu,['odysseus-subagents'],150],
 [/n8n\.t-tech\.team|корпоратив\S*\s+n8n|n8n.*корпоратив/iu,['odysseus-companion','n8n:using-tbank-n8n-mcp'],120],
 [/n8n/iu,['odysseus-companion','n8n-workflow-agent'],60],
 [/rag|граф\S*\s+знани|баз\S*\s+знани|graphify/iu,['odysseus-companion','graphify'],100],
 [/camunda|zoya|bpmn/iu,['b2b-qa:write-zoya-test','b2b-qa:run-test'],100],
 [/тест\S*|\btests?\b/iu,['generate-tests','init-qa'],35],
 [/jira|[A-Z]{2,12}-\d+/u,['jira-auth:jira-auth','jira'],85],
 [/gitlab.*(?:ci|pipeline)|(?:ci\/cd|пайплайн|gitlab ci)/iu,['devplatform-skills:gitlab-ci-design'],100],
 [/ревью.*(?:код|ветк|mr|pr)|code.?review/iu,['code-review'],90],
 [/ошибк|падает|баг|отлад|bug|debug|не работает/iu,['systematic-debugging'],55],
 [/дерев\S*\s+метрик/iu,['metric-tree-architect:metric-tree-architect'],110],
 [/greenplum|trino|dlh|разведочн\S*\s+анализ|\beda\b/iu,['eda-metrics-suite:eda-dwh-router','eda-metrics-suite:eda-metrics-architect'],100],
 [/figma|reformer|микроблок/iu,['block-kit:figma-to-code','block-kit:create-microblock'],55],
 [/план\S*\s+(?:реализац|разработк)|implementation plan/iu,['writing-plans'],90],
 [/\bpdf\b/iu,['pdf'],80],[/\bxlsx\b|excel|таблиц\S*\s+формул/iu,['xlsx'],75],
 [/\bpptx\b|презентац/iu,['pptx'],75],[/\bdocx\b|документ word/iu,['docx'],75],
];
const tokens=s=>[...new Set(String(s).toLocaleLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu)||[])];
export function selectSkills(paths,prompt,limit=3){
 const settings=json(join(paths.profile,'settings.json'));
 const disabled=new Set((settings.skills?.disabled||[]).map(n=>String(n).toLowerCase()));
 const disabledPackages=new Set(settings.extensions?.disabled||[]);
 let sessionIds;if(process.env.COMPANION_TASK_SKILL_IDS!==undefined){try{const values=JSON.parse(process.env.COMPANION_TASK_SKILL_IDS);if(!Array.isArray(values)||values.some(v=>typeof v!=='string'))return [];sessionIds=new Set(values);}catch{return [];}}
 const entries=(json(join(paths.profile,'companion-auto-skills.json')).entries||[]).filter(s=>!disabled.has(s.name.toLowerCase())&&!disabledPackages.has(s.package)&&(!sessionIds||sessionIds.has(s.id)));
 const scores=new Map();
 // The bundled guide matches Companion's actual local/corporate capabilities.
 // Retain the older guides as fallback for profiles without the new skill.
 const nativeN8n=/n8n|н8н/iu.test(prompt)&&entries.some(s=>s.name==='odysseus-n8n');
 for(const [re,names,score]of rules)if(re.test(prompt))for(const name of names)scores.set(name,Math.max(scores.get(name)||0,score));
 const query=tokens(prompt);const corporate=/n8n\.t-tech\.team|корпоратив/iu.test(prompt);
 return entries.filter(s=>!nativeN8n||!['n8n-workflow-agent','n8n:using-tbank-n8n-mcp'].includes(s.name)).map(s=>{const text=(s.name+' '+s.description+' '+s.when).toLowerCase();let score=scores.get(s.name)||0;
   score+=query.reduce((n,t)=>n+(text.includes(t)?3:0),0);if(corporate&&s.name==='n8n-workflow-agent')score=0;
   return {...s,score};}).filter(s=>s.score>=6).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name)).slice(0,Math.min(5,Math.max(1,limit)));
}
export function skillHook(paths,input){
 let selected=selectSkills(paths,String(input.prompt||''));
 if(process.env.COMPANION_TASK_SKILL_IDS!==undefined){try{const ids=JSON.parse(process.env.COMPANION_TASK_SKILL_IDS);if(!Array.isArray(ids)||ids.length>30||ids.some(id=>typeof id!=='string'))throw Error();const settings=json(join(paths.profile,'settings.json'));const active=skills(paths).filter(s=>s.enabled&&!(settings.extensions?.disabled||[]).includes(s.package));selected=ids.map(id=>active.find(s=>s.id===id));if(selected.some(s=>!s))throw Error();}catch{return {hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'Выбранный набор навыков недоступен или изменён. Не заменяй его другим набором без согласования с пользователем; обнови выбор в Companion.'}};}}
 if(!selected.length)return {};
 let budget=24000;const loaded=[],versions=[];
 for(const s of selected){
   try{const text=readFileSync(s.path,'utf8'),body=text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'');
     versions.push({id:s.id,name:s.name,hash:fingerprint(text),loaded:body.length<=16000&&body.length<=budget});
   if(body.length<=16000&&body.length<=budget){loaded.push('### '+s.name+'\nИсточник: '+s.path+'\nХеш инструкции: '+fingerprint(text)+'\nРесурсы разрешай относительно каталога этого SKILL.md.\n'+body);budget-=body.length;}
   }catch{}
 }
 try{workspaceStore(paths).mutate(s=>{s.skillSelections||=[];s.skillSelections.push({id:uid(),at:now(),sessionId:String(input.session_id||input.sessionId||'').slice(0,200),method:process.env.COMPANION_TASK_SKILL_IDS!==undefined?'session-selection':'rules-and-words',selected:versions});s.skillSelections=s.skillSelections.slice(-300);});}catch{}
 return {hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'Автоматический выбор навыков для текущей задачи:\n'+selected.map(s=>'- '+s.name+' (ID '+s.id+'): '+s.description).join('\n')+'\nПодходящие инструкции ниже уже загружены автоматически. Применяй их в рамках текущего запроса, не жди slash-команды. Для большой инструкции, которой нет ниже, используй штатный Skill либо companion_skill по ID. Если подбор не соответствует смыслу запроса, выбери другой навык. Для n8n.t-tech.team используй corporate_n8n_*. Уточняй среду и проверяй реально доступные инструменты.\n\n'+loaded.join('\n\n')}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const paths=companionPaths(process.env.ODYSSEUS_ROOT);
 if(process.argv[2]==='configure')console.log(JSON.stringify({configured:configureAutomaticSkills(paths).count}));
 else{try{const text=readFileSync(0,'utf8');if(text.length>512000)throw Error('Input too large');console.log(JSON.stringify(skillHook(paths,JSON.parse(text))));}catch{console.log('{}');}}
}
