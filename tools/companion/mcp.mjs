import {toolOptions} from './tool-advisor.mjs';
import {knowledgeArea,knowledgeLink} from './knowledge-assistant.mjs';
import {exploreGraph} from './explore.mjs';
import {scenarios} from './scenarios.mjs';
import {agentDefinitions} from './agent-definitions.mjs';
import {customScenarios} from './custom-scenarios.mjs';
import {taskCatalog} from './task-catalog.mjs';
import {readRegistry} from '../graphify.mjs';
import {localSourceStatus} from './source-health.mjs';
import {isAbsolute} from 'node:path';
import {jobQueue} from './job-queue.mjs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { companionPaths,json } from './paths.mjs';
import { initializeConfig } from './platform.mjs';
import { n8nLocation } from '../automations/runtime.mjs';
import { createKnowledgeActions } from '../automations/gateway.mjs';
import { skills, readSkill, mcpCatalog, plugins, redact } from './catalog.mjs';
import {graphData} from '../knowledge/graph-store.mjs';
import { graphContext } from '../knowledge/workflow.mjs';
import { startWorkflowWorker } from '../knowledge-workflow.mjs';
import { corporateN8n } from './corporate-n8n.mjs';
import { memoryService } from './memory.mjs';
import { agentRuns } from './agent-runs.mjs';
import { searchAudit } from './search-audit.mjs';
import { knowledgeScope } from './retrieval.mjs';
import { selectSkills } from './automatic-skills.mjs';
import {boardService} from './board.mjs';
import {chatHistory} from './chat-history.mjs';
const paths=companionPaths(process.env.ODYSSEUS_ROOT);Object.assign(process.env,paths.env);initializeConfig(paths);
const require=createRequire(join(paths.localN8n ? n8nLocation(paths.automation).runtime : join(paths.root,'mcp'),'package.json'));
const {McpServer}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')));
const {StdioServerTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')));
const {z}=await import(pathToFileURL(require.resolve('zod')));
const server=new McpServer({name:'odysseus-companion',version:json(join(paths.root,'companion-release.json')).version||json(join(paths.root,'companion/package.json')).version||'unknown'});
const actions=createKnowledgeActions(paths.automation);
const corporate=corporateN8n(paths),memory=memoryService(paths),runs=agentRuns(paths),audit=searchAudit(paths);
const enabled=s=>{if((json(join(paths.profile,'settings.json')).skills?.disabled||[]).some(n=>n.toLowerCase()===s.name.toLowerCase()))return false;if(process.env.COMPANION_TASK_SKILL_IDS===undefined)return true;try{const selected=JSON.parse(process.env.COMPANION_TASK_SKILL_IDS);return Array.isArray(selected)&&selected.includes(s.id);}catch{return false;}};
const scope={collection:z.string().default('projects'),project:z.string().optional()};
const boards=boardService(paths),chats=chatHistory(paths);
const identifier=z.string().min(1).max(200);
tool('companion_boards','Личные доски с колонками и задачами; ID брать из результата',{},()=>boards.state());
tool('companion_board_save','Создать доску или изменить настройки по прочитанной revision; задачи сохраняются',{id:identifier.optional(),expectedRevision:z.number().int().optional(),name:z.string().min(1).max(100),columns:z.array(z.object({id:identifier.optional(),name:z.string().min(1).max(60),color:z.string().optional()})).min(1).max(20).optional(),labels:z.array(z.object({name:z.string(),color:z.string().optional()})).max(100).optional(),moveTo:identifier.optional()},i=>{
 if(!i.id){if(i.columns||i.labels)throw Error('Сначала создайте доску по имени, затем настройте её по полученным ID и revision');return boards.configure({action:'create',name:i.name});}
 if(i.expectedRevision===undefined)throw Error('Перед изменением прочитайте доску и передайте expectedRevision');
 return boards.configure({...i,action:'save'});
},false);
const taskFields={title:z.string().min(1).max(200).optional(),description:z.string().max(12000).optional(),columnId:identifier.optional(),priority:z.enum(['low','normal','high','urgent']).optional(),due:z.string().optional(),labels:z.array(z.string()).max(30).optional(),project:z.string().max(1000).optional(),chatIds:z.array(identifier).max(100).optional(),knowledgeIds:z.array(identifier).max(100).optional(),decisionIds:z.array(identifier).max(100).optional(),runIds:z.array(identifier).max(100).optional()};
function currentTask(i){const b=boards.state().boards.find(b=>b.id===i.boardId);if(!b)throw Error('Доска не найдена');const t=i.id&&b.tasks.find(t=>t.id===i.id);if(i.id&&!t)throw Error('Задача не найдена');if(t&&(!i.expectedUpdatedAt||i.expectedUpdatedAt!==t.updatedAt))throw Error('Прочитайте актуальную задачу и передайте expectedUpdatedAt');return {b,t};}
tool('companion_task_save','Создать личную задачу или частично изменить существующую; обновление требует expectedUpdatedAt',{boardId:identifier,id:identifier.optional(),expectedUpdatedAt:z.string().optional(),...taskFields},i=>{const {b,t}=currentTask(i);const merged={...t,...i,action:'save',columnId:i.columnId||t?.columnId||b.columns[0].id};for(const id of merged.chatIds||[])chats.lookup(id);return boards.task(merged);},false);
tool('companion_task_action','Переместить, архивировать или восстановить задачу по прочитанной версии',{boardId:identifier,id:identifier,expectedUpdatedAt:z.string(),action:z.enum(['move','archive','restore']),columnId:identifier.optional(),beforeId:identifier.optional()},i=>{currentTask(i);return boards.task(i);},false);
tool('companion_chat_list','Найти чаты и папки, фильтровать по оценке; результаты постраничные',{query:z.string().max(500).optional(),folder:identifier.optional(),project:z.string().optional(),minRating:z.number().int().min(1).max(5).optional(),sort:z.enum(['rating','updated']).optional(),offset:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(100).optional()},i=>chats.list(i));
tool('companion_chat_read','Прочитать сообщения выбранного чата; скрытые рассуждения и секреты исключаются',{id:identifier,offset:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(200).optional()},i=>chats.read(i));
tool('companion_chat_rate','Поставить пользовательскую оценку полезности 1–5; 0 снимает оценку. Не выставлять без поручения',{id:identifier,rating:z.number().int().min(0).max(5)},i=>chats.rate(i),false);
tool('companion_chat_organize','Создать/переименовать/удалить папку, переместить чат или выбрать автосортировку. Удаление папки сохраняет чаты',{action:z.enum(['create','rename','delete','move','mode']),id:identifier.optional(),folderId:identifier.optional(),name:z.string().min(1).max(60).optional(),mode:z.enum(['topic','project','none']).optional()},i=>{for(const key of ({create:['name'],rename:['folderId','name'],delete:['folderId'],move:['id','folderId'],mode:['mode']}[i.action]))if(!i[key])throw Error('Нужно поле '+key);return chats.organize(i);},false);
function tool(name,description,inputSchema,fn,readOnly=true){
  server.registerTool(name,{description,inputSchema,annotations:{readOnlyHint:readOnly,destructiveHint:name==='n8n_workflow_activate'}},async input=>{
    try{return {content:[{type:'text',text:JSON.stringify(redact(await fn(input)))}]};}
    catch(e){return {isError:true,content:[{type:'text',text:String(e.message).slice(0,400)}]};}
  });
}
tool('companion_scenario_catalog','Доступные навыки и MCP для создания сценария Companion; existing позволяет проверить результат сохранения',{query:z.string().max(200).optional()},i=>{const c=taskCatalog(paths).state(),q=(i.query||'').toLowerCase();return {skills:c.skills.filter(s=>s.enabled&&(s.name+' '+s.description).toLowerCase().includes(q)).slice(0,500).map(s=>({name:s.name,description:s.descriptionRu||s.description})),mcp:c.servers.filter(s=>s.enabled).map(s=>({name:s.name,status:s.status})),existing:customScenarios(paths).state().map(s=>({id:s.id,name:s.name,creationKey:s.creationKey}))};});
tool('companion_scenario_create','Создать готовый пользовательский сценарий в Companion. Не запускает его и не меняет профиль Nessy; повтор с тем же creationKey идемпотентен',{name:z.string().min(1).max(160),description:z.string().max(1000).optional(),instructions:z.string().min(1).max(12000),steps:z.array(z.string()).max(20).default([]),skillNames:z.array(z.string()).max(30).default([]),mcpNames:z.array(z.string()).max(30).default([]),development:z.boolean().default(false),creationKey:z.string().min(8).max(200)},i=>{const row=customScenarios(paths).save(i);return {saved:true,id:row.id,name:row.name,revision:row.revision};},false);
tool('companion_scenario_get','Прочитать текущий сценарий и версию перед редактированием',{id:z.string()},i=>{const t=scenarios(paths).state().templates.find(t=>t.id===i.id);if(!t)throw Error('Сценарий не найден');return {...t,instructions:t.rule,description:t.inputs,skillNames:t.skillNames||t.preset.skills,mcpNames:t.mcpNames||t.preset.mcpNames,copyRequired:!t.custom};});
tool('companion_scenario_update','Обновить собственный сценарий по прочитанной версии',{id:z.string(),expectedRevision:z.number().int().min(1),name:z.string().max(160),description:z.string().max(1000).optional(),instructions:z.string().max(12000),steps:z.array(z.string()).max(20),skillNames:z.array(z.string()).max(30),mcpNames:z.array(z.string()).max(30),development:z.boolean()},i=>{const row=customScenarios(paths).save(i);return {saved:true,id:row.id,name:row.name,revision:row.revision};},false);
tool('companion_agent_catalog','Список субагентов, инструментов и проверенных MCP для конструктора',{},()=>{const a=agentDefinitions(paths).state();return {tools:a.tools,mcp:taskCatalog(paths).state().servers.map(s=>({name:s.name,status:s.status})),definitions:a.definitions.map(d=>({name:d.name,title:d.title,status:d.status,updatedAt:d.updatedAt}))};});
tool('companion_agent_get','Прочитать текущую роль, права и версию субагента',{name:z.string()},i=>{const d=agentDefinitions(paths).state().definitions.find(d=>d.name===i.name);if(!d)throw Error('Субагент не найден');const {versions,nativeContent,...result}=d;return result;});
tool('companion_agent_save','Создать или изменить субагента в Nessy с резервной копией; обновление требует прочитанной версии',{originalName:z.string().optional(),expectedUpdatedAt:z.string().optional(),name:z.string().max(100),role:z.string().max(80),title:z.string().max(100),description:z.string().max(1500),instructions:z.string().max(16000),rules:z.string().max(10000),output:z.string().max(4000),fileScope:z.string().max(4000),tools:z.array(z.string()).max(100),deniedTools:z.array(z.string()).max(200),mcpServers:z.array(z.string()).max(200),model:z.string().max(200),approvalMode:z.enum(['inherit','default','plan','auto-edit','bubble']),color:z.enum(['red','blue','green','yellow','purple','orange','pink','cyan']),maxTurns:z.number().int().min(1).max(200),maxMinutes:z.number().int().min(1).max(60)},i=>{const d=agentDefinitions(paths).save(i);return {saved:true,name:d.name,title:d.title,updatedAt:d.updatedAt,restartNessy:true};},false);
tool('companion_knowledge_explore','Найти узлы и связи в выбранной области; ответ ограничен 100 узлами',{collection:z.string(),project:z.string().optional(),query:z.string().max(500).optional(),focus:z.string().optional(),offset:z.number().int().min(0).optional()},i=>{knowledgeArea(paths,i);return audit.filterGraph(i,exploreGraph(paths,{...i,mode:i.focus?'neighbors':'all'}));});
tool('companion_knowledge_link','Добавить ручную связь с основанием между двумя существующими узлами выбранной области',{collection:z.string(),project:z.string().optional(),source:z.string(),target:z.string(),relation:z.string().max(160),evidence:z.string().max(2000)},i=>knowledgeLink(paths,i),false);
tool('companion_tool_catalog','Каталог навыков, MCP, плагинов и зависимостей для подбора. Навыки постранично; конфигурации и секреты не возвращаются',{query:z.string().max(500).optional(),offset:z.number().int().min(0).optional()},i=>toolOptions(paths,i));
tool('companion_tool_preview','Проверить выбранный набор и подготовить запрос. Не применяет его к профилю и не запускает задачу',{prompt:z.string().min(1).max(12000),skillIds:z.array(z.string()).max(30),mcpNames:z.array(z.string()).max(30)},i=>taskCatalog(paths).preview(i));
tool('companion_queue_enqueue','Сохранить событие для фонового сценария. Не запускает модель: пользователь подтверждает запуск в Companion',{scenarioId:z.string(),source:z.string(),eventId:z.string()},i=>jobQueue(paths).enqueue(i),false);
tool('companion_queue_status','Показать очередь и результаты фоновых сценариев без запуска',{},()=>jobQueue(paths).state());
tool('companion_status','Проверить профиль Nessy и доступные ресурсы платформы',{},()=>({profile:paths.profile,skills:skills(paths).length,plugins:plugins(paths),mcp:mcpCatalog(paths),catalogs:actions.catalogs()}));
tool('companion_skills','Найти навыки в настроенном профиле Nessy',{query:z.string().optional()},i=>skills(paths).filter(enabled).filter(s=>(s.name+' '+s.description).toLowerCase().includes((i.query||'').toLowerCase())).slice(0,100));
tool('companion_skill','Прочитать инструкцию выбранного навыка по ID',{id:z.string()},i=>{const s=readSkill(paths,i.id);if(!enabled(s))throw Error('Навык выключен рабочим профилем');return s;});
tool('companion_select_skills','Подобрать подходящие навыки по смыслу текущей задачи',{query:z.string()},i=>selectSkills(paths,i.query));
tool('corporate_n8n_sync','Загрузить процессы и метаданные запусков n8n.t-tech.team через настроенный API-ключ. Без записи на сервер',{},()=>corporate.sync());
tool('corporate_n8n_workflow_list','Найти корпоративные процессы в снимке по имени; метаданные без тяжёлых схем. Проверяй дату и stale',{query:z.string().optional(),offset:z.number().optional(),limit:z.number().max(200).optional()},i=>corporate.workflows({...i,limit:i.limit||100}));
tool('corporate_n8n_workflow_get','Прочитать схему корпоративного процесса из снимка',{id:z.string()},i=>corporate.workflow(i.id));
tool('corporate_n8n_executions','Метаданные корпоративных запусков без payload и персональных данных',{},()=>corporate.executions());
tool('knowledge_before_task','Получить проверяемый контекст графа текущего проекта',{cwd:z.string(),prompt:z.string()},i=>{const selected=knowledgeScope(paths,i.cwd),known=selected.project&&readRegistry(paths.knowledge).projects[selected.project];const {project,facts}=graphContext(paths.knowledge,known?.path||i.cwd,i.prompt),skip=audit.excluded({collection:facts.collection,project:project.id}),nodes=graphData(paths.knowledge).graph.nodes;facts.matches=facts.matches.map(m=>{const node=nodes.find(n=>n.id===m.id),source=m.source||node?.source_file;return {...m,source,...(isAbsolute(String(source||''))&&!['project','folder'].includes(node?.type)?{description:undefined}:{})};}).filter(m=>!['missing','unreadable'].includes(localSourceStatus(m.source).status)).filter(m=>!skip.some(e=>(e.nodeId&&e.nodeId===m.id)||(e.source&&e.source===(m.source||nodes.find(n=>n.id===m.id)?.source_file))));const ids=new Set(facts.matches.map(m=>m.id));facts.links=facts.links.filter(e=>ids.has(e.source)&&ids.has(e.target));if(!facts.matches.length&&facts.status==='matches')facts.status='no_matches';audit.record({query:i.prompt,collection:facts.collection,project:project.id,origin:'mcp-before',graph:facts.matches.map(m=>({id:m.id,label:m.label,description:m.description,source_file:m.source}))});return facts;});
tool('knowledge_after_task','Предложить итог задачи во Входящие знания с источниками и проверками',{cwd:z.string(),summary:z.string(),sources:z.array(z.string()).min(1),checks:z.array(z.string()).optional()},i=>memory.capture({...knowledgeScope(paths,i.cwd),sources:i.sources,title:'Итог задачи Nessy',text:'Результат агента; проверяйте источники.\nПроект: '+i.cwd+'\n\n'+i.summary.slice(0,16000)+'\n\nИсточники:\n'+i.sources.join('\n')+'\n\nПроверки (со слов агента):\n'+(i.checks||[]).join('\n')}),false);
for(const [name,mode,description,schema,readOnly] of [
 ['knowledge_catalogs','catalogs','Каталоги, проекты и настроенные источники',{},true],
 ['knowledge_search','search','Поиск с источниками в RAG выбранного каталога',{...scope,query:z.string(),limit:z.number().optional()},true],
 ['knowledge_answer','answer','Ответ по источникам через настроенную модель платформы',{...scope,query:z.string()},true],
 ['knowledge_index','index','Обновить RAG-индекс выбранного каталога',scope,false],
 ['knowledge_save','save','Предложить знание во Входящие для подтверждения пользователем',{...scope,title:z.string(),text:z.string()},false],
 ['knowledge_graph','graph','Узлы и связи выбранного каталога',scope,true],
 ['n8n_workflow_list','workflowList','Локальные процессы Companion',{},true],
 ['n8n_workflow_get','workflowGet','Прочитать локальный процесс',{id:z.string()},true],
 ['n8n_workflow_save','workflowSave','Сохранить черновик процесса без публикации',{id:z.string().optional(),workflow:z.object({name:z.string(),nodes:z.array(z.record(z.string(),z.any())),connections:z.record(z.string(),z.any()),settings:z.record(z.string(),z.any()).optional()})},false],
 ['n8n_workflow_activate','workflowActivate','Включить или выключить триггеры процесса по поручению пользователя',{id:z.string(),active:z.boolean()},false],
 ['n8n_executions','executions','История запусков локальных процессов',{},true],
 ['external_search','externalSearch','Поиск по ID настроенного источника платформы',{source:z.string(),query:z.string()},true],
].filter(([name]) => paths.localN8n || !name.startsWith('n8n_')))tool(name,description,schema,async input=>{if(mode==='save')return memory.capture(input);if(mode==='search')return audit.search(input,i=>actions.search(i),'mcp');if(mode==='graph')return audit.filterGraph(input,actions.graph(input));if(mode==='answer'){const skip=audit.excluded(input),r=await actions.answer({...input,excludedSources:skip.map(e=>e.source),excludedNodeIds:skip.map(e=>e.nodeId)});audit.record({...input,...r.retrieval,origin:'mcp-answer'});return r;}return actions[mode](input);},readOnly);
tool('companion_run_plan','Записать план этапов субагентов до штатных вызовов Agent/Task',{title:z.string(),project:z.string().optional(),sessionId:z.string().optional(),stages:z.array(z.object({id:z.string(),title:z.string(),role:z.string().regex(/^[a-z][a-z0-9-]{1,99}$/),dependsOn:z.array(z.string()).optional(),files:z.array(z.string()).optional(),budget:z.number().optional()}))},i=>runs.plan(i),false);
tool('companion_run_stage','Записать реальное состояние этапа и отчёт; не означает запуск отдельного агента',{runId:z.string(),stageId:z.string(),status:z.enum(['planned','running','completed','failed','blocked']),report:z.string().optional(),changedFiles:z.array(z.string()).optional(),nativeAgentId:z.string().optional(),checks:z.array(z.object({command:z.string(),status:z.enum(['passed','failed','not-run']),output:z.string().optional()})).optional()},i=>runs.update(i),false);
tool('companion_runs','Прочитать планы и наблюдаемые события штатных субагентов',{},()=>runs.state());
tool('companion_decision_propose','Предложить решение пользователю; принятие выполняется в Companion',{title:z.string(),text:z.string(),reason:z.string(),sources:z.array(z.string()).optional(),project:z.string().optional(),collection:z.string().optional(),checks:z.array(z.string()).optional()},i=>memory.decisionSave({...i,status:'proposed'}),false);
await server.connect(new StdioServerTransport());
