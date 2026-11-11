import { findNessy } from './nessy-command.mjs';
import {customScenarios} from './custom-scenarios.mjs';
import {jobQueue} from './job-queue.mjs';
import {regressionReport} from './regression-report.mjs';
import {scenarios} from './scenarios.mjs';
import {sourceHealth} from './source-health.mjs';
import {projectPassports} from './project-passports.mjs';
import {systemPackageService} from './system-packages.mjs';
import {taskCatalog} from './task-catalog.mjs';
import {agentDefinitions} from './agent-definitions.mjs';
import {skillLibrary} from './skill-library.mjs';
import {toolIcons,commandTool} from './tool-icons.mjs';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createAutomationRuntime } from '../automations/runtime.mjs';
import { createKnowledgeActions } from '../automations/gateway.mjs';
import { loadAutomationConfig, configureAutomation, publicConfig } from '../automations/config.mjs';
import { privateWrite } from '../personal/store.mjs';
import { snapshot } from '../knowledge-ui.mjs';
import { editKnowledge } from '../knowledge/overlay.mjs';
import { graphData } from '../knowledge/graph-store.mjs';
import { manageCollection, collectionState } from '../knowledge/collections.mjs';
import { registerProject, readRegistry } from '../graphify.mjs';
import { queueProjectRefresh } from '../knowledge/workflow.mjs';
import { startWorkflowWorker } from '../knowledge-workflow.mjs';
import { readKnowledgeDocument } from '../knowledge/documents.mjs';
import { skills, readSkill, mcpCatalog, plugins, ragIndexes } from './catalog.mjs';
import { json } from './paths.mjs';
import { importNessyModel } from './nessy-model.mjs';
import { corporateN8n } from './corporate-n8n.mjs';

import { workflowTransfer } from './workflow-transfer.mjs';
import { personal } from './personal.mjs';
import { createObserver } from './observer.mjs';
import { installationManager } from './installer.mjs';

import { memoryService } from './memory.mjs';
import { boardService } from './board.mjs';
import { agentRuns } from './agent-runs.mjs';
import { chatHistory } from './chat-history.mjs';
import { searchAudit } from './search-audit.mjs';
import { toolProfiles } from './tool-profiles.mjs';
import { inventoryService } from './inventory.mjs';
import { exploreGraph } from './explore.mjs';

export function initializeConfig(paths) {
  mkdirSync(paths.home,{recursive:true,mode:0o700});
  const file=join(paths.automation.home,'config.json');
  if(!existsSync(file)) privateWrite(file,JSON.stringify({version:2,port:5688,bridgePort:5799,autostart:false,sources:[],connections:[],routes:{}}));
  return loadAutomationConfig(paths.automation);
}
export const automationModes=['status','configure','start','stop','editorSession','catalogs','search','answer','index','save','graph','workflowList','workflowGet','workflowSave','workflowActivate','executions','connectionModels','externalSearch'];
function corporateKnowledgeRuntime(paths) {
  const actions = createKnowledgeActions(paths);
  function status() {
    const { config, secrets } = loadAutomationConfig(paths);
    return { ...publicConfig(config, secrets), engine: { installed: false, running: false } };
  }
  const supported = new Set(['catalogs','search','answer','index','save','graph','connectionModels','externalSearch']);
  return {
    status,
    async dispatch(mode, input) {
      if (mode === 'status') return status();
      if (mode === 'configure') {
        configureAutomation(paths, input);
        return status();
      }
      if (supported.has(mode)) return actions[mode](input);
      throw Error('В этой сборке доступен корпоративный n8n');
    },
    async close() {},
  };
}
export async function createPlatform(paths,{runtimeFactory=paths.localN8n === false ? corporateKnowledgeRuntime : createAutomationRuntime}={}) {
  initializeConfig(paths);
  const runtime=await runtimeFactory(paths.automation);
  const corporate=corporateN8n(paths);
  const preferences=personal(paths),icons=toolIcons(paths),skillStore=skillLibrary(paths);
  const memory=memoryService(paths),boards=boardService(paths),agents=agentRuns(paths),chats=chatHistory(paths),audit=searchAudit(paths),profilesTools=toolProfiles(paths),inventory=inventoryService(paths);
  const queue=jobQueue(paths);queue.recover();
  const definitions=agentDefinitions(paths);definitions.ensure();
  const transfer=workflowTransfer(paths,runtime);
  const profiles=()=>[...new Set([paths.profile,...(json(join(paths.home,'attached-profiles.json')).profiles||[]).map(p=>p.path)])];
  const observer=createObserver(paths,{profiles});
  const installer=installationManager(paths,{onAttach:profile=>observer.attach(profile)});
  const observerTimer=setInterval(()=>observer.scan(),10000);observerTimer.unref();observer.scan();
  const tick=()=>{const s=corporate.status();if(s.autoSync&&s.hasApiKey&&!s.syncing&&(!s.lastAttemptAt||Date.now()-Date.parse(s.lastAttemptAt)>=s.intervalSeconds*1000))void corporate.sync().catch(()=>{});};
  const corporateTimer=setInterval(tick,15000);corporateTimer.unref();tick();
  async function dispatch(mode,input={}) {
    if(!input||typeof input!=='object'||Array.isArray(input)||JSON.stringify(input).length>600000) throw Error('Некорректный запрос');
    if(mode==='skillCompare')return skillStore.compare();
    if(mode==='skillInstall')return skillStore.install(input);
    if(mode==='skillImport')return skillStore.importSkill(input);
    if(mode==='memoryList')return memory.list(input);
    if(mode==='memoryCapture')return memory.capture(input);
    if(mode==='memoryEdit')return memory.edit(input);
    if(mode==='memoryMerge')return memory.merge(input);
    if(mode==='memoryHygiene')return memory.hygiene();
    if(mode==='decisions')return memory.decisions(input);
    if(mode==='decisionSave')return memory.decisionSave(input);
    if(mode==='activity')return memory.activity();
    if(mode==='boardState')return boards.state();
    if(mode==='boardConfigure')return boards.configure(input);
    if(mode==='boardTask'){for(const id of input.chatIds||[])chats.lookup(id);return boards.task(input);}
    if(mode==='agentDefinitions')return definitions.state();
    if(mode==='agentDefinitionSave')return definitions.save(input);
    if(mode==='agentDefinitionReset')return definitions.reset(input);
    if(mode==='agentDefinitionDelete')return definitions.remove(input);
    if(mode==='agentRuns')return agents.state();
    if(mode==='agentPlan')return agents.plan(input);
    if(mode==='agentStage')return agents.update(input);
    if(mode==='chatRate')return chats.rate(input);
    if(mode==='chatOrganize')return chats.organize(input);
    if(mode==='chatList')return chats.list(input);
    if(mode==='toolIcons')return icons.state({initialize:true});
    if(mode==='toolIconSave')return icons.save(input);
    if(mode==='chatRead'){const r=chats.read(input);const tools=icons.state().tools;return {...r,messages:r.messages.map(m=>({...m,commands:(m.commands||[]).map(command=>({command,tool:commandTool(command,tools)}))}))};}
    if(mode==='chatLaunch')return chats.launch(input);
    if(mode==='searchAudit')return audit.state();
    if(mode==='sourceExclusion')return audit.exclusion(input);
    if(mode==='toolProfiles')return profilesTools.state();
    if(mode==='toolProfileSave')return profilesTools.save(input);
    if(mode==='toolProfilePreview')return profilesTools.preview(input);
    if(mode==='toolProfileApply'){const result=profilesTools.apply(input);observer.setEnabled(result.changes.memory);return result;}
    if(mode==='queueState')return queue.state();
    if(mode==='queueEnqueue')return queue.enqueue(input);
    if(mode==='queueStart')return queue.start(input);
    if(mode==='queueCancel')return queue.cancel(input);
    if(mode==='queueRetry')return queue.retry(input);
    if(mode==='regressionReport')return regressionReport(input.report);
    if(mode==='customScenarioSave')return customScenarios(paths).save(input);
    if(mode==='customScenarioDelete')return customScenarios(paths).remove(input);
    if(mode==='customScenarioDraft')return customScenarios(paths).draft(input);
    if(mode==='scenarioState')return scenarios(paths).state();
    if(mode==='scenarioSave')return scenarios(paths).save(input);
    if(mode==='scenarioPrompt')return scenarios(paths).prompt(input);
    if(mode==='sourceHealth')return sourceHealth(paths).state(input);
    if(mode==='sourceReview')return sourceHealth(paths).review(input);
    if(mode==='projectPassports')return projectPassports(paths).state();
    if(mode==='projectPassportSave')return projectPassports(paths).save(input);
    if(mode==='systemPackagePreview')return systemPackageService(paths).preview(input);
    if(mode==='systemPackageApply')return systemPackageService(paths).apply(input);
    if(mode==='systemPackageRollback')return systemPackageService(paths).rollback(input);
    if(mode==='systemPackageHistory'){const service=systemPackageService(paths);return [...service.history(),...service.pending().map(e=>({...e,status:'needs-recovery'}))];}
    if(mode==='systemPackageRecoveryPreview')return systemPackageService(paths).recoveryPreview(input);
    if(mode==='systemPackageRecover')return systemPackageService(paths).recover(input);
    if(mode==='taskCatalog')return taskCatalog(paths).state();
    if(mode==='taskPreview')return taskCatalog(paths).preview(input);
    if(mode==='inventory')return inventory.state();
    if(mode==='mcpProbe')return inventory.probe(input);
    if(mode==='mcpResources')return inventory.probe({name:input.name,resources:true});
    if(mode==='mcpResourceRead')return inventory.resourceRead(input);
    if(mode==='diagnostics')return inventory.diagnostics(observer,runtime);
    if(mode==='knowledgeExplore')return exploreGraph(paths,input);
    if(mode==='graph')return audit.filterGraph(input,await runtime.dispatch('graph',input));
    if(mode==='search')return audit.search(input,i=>runtime.dispatch('search',i));
    if(mode==='answer'){const skip=audit.excluded(input);const result=await runtime.dispatch('answer',{...input,excludedSources:skip.map(e=>e.source),excludedNodeIds:skip.map(e=>e.nodeId)});if(result.retrieval){result.auditId=audit.record({...input,...result.retrieval,origin:'answer'}).id;result.retrieval.auditId=result.auditId;}return result;}
    if(automationModes.includes(mode)) return runtime.dispatch(mode,input);
    if(mode==='overview') {
      const config=runtime.status(), list=skills(paths), mcp=mcpCatalog(paths), registry=readRegistry(paths.knowledge);
      return {name:'Odysseus Companion',version:json(join(paths.root,'companion-release.json')).version||'0.4.4',profile:paths.profile,root:paths.root,installation:json(paths.installation),
        automaticSkills:list.filter(s=>s.automatic).length,
        skills:list.length,plugins:plugins(paths).length,mcp:mcp.length,enabledMcp:mcp.filter(m=>m.enabled).length,
        graphNodes:graphData(paths.knowledge).graph.nodes.length,graphLinks:graphData(paths.knowledge).graph.links.length,
        projects:Object.values(registry.projects),automation:config,rag:ragIndexes(paths),
        dependencies:{graphify:existsSync(paths.knowledge.python),nessy:Boolean(findNessy(paths.env)),dp:existsSync(join(paths.profile,'dp_latest/dp'))}};
    }
    if(mode==='workflowLibrary')return transfer.status();
    if(mode==='workflowImport')return transfer.ingest(input);
    if(mode==='workflowSync')return transfer.sync(input);
    if(mode==='workflowRestore')return transfer.restore(input);
    if(mode==='workflowCompare')return transfer.compare(input);
    if(mode==='workflowCapture')return transfer.capture();
    if(mode==='workflowExport')return transfer.exportAll();
    if(mode==='personal')return preferences.read();
    if(mode==='personalUpdate')return preferences.update(input);
    if(mode==='usage')return observer.usage();
    if(mode==='observerConfigure')return observer.setEnabled(input.enabled);
    if(mode==='installationStatus')return installer.status();
    if(mode==='installExtension')return installer.install(input);
    if(mode==='skills') return skills(paths);
    if(mode==='skill') return readSkill(paths,input.id);
    if(mode==='mcp') return mcpCatalog(paths);
    if(mode==='plugins') return plugins(paths);
    if(mode==='rag') return ragIndexes(paths);
    if(mode==='corporateStatus')return corporate.status();
    if(mode==='corporateConfigure')return corporate.configure(input);
    if(mode==='corporateCheck')return corporate.check();
    if(mode==='corporateSync')return corporate.sync();
    if(mode==='corporateWorkflows')return corporate.workflows(input);
    if(mode==='corporateWorkflow')return corporate.workflow(input.id);
    if(mode==='corporateExecutions')return corporate.executions();
    if(mode==='importNessyModel')return importNessyModel(paths);
    if(mode==='templates') {
      if(!['knowledge-question','knowledge-index','knowledge-result'].includes(input.id)) throw Error('Шаблон не найден');
      const t=json(join(paths.root,'integrations/n8n/templates',input.id+'.json'));
      return {name:t.name,nodes:t.nodes,connections:t.connections,settings:t.settings||{}};
    }
    if(mode==='graphView') return snapshot(paths.knowledge,input);
    if(mode==='document') return readKnowledgeDocument(paths.knowledge,input);
    if(mode==='collections') return collectionState(paths.knowledge,graphData(paths.knowledge).graph);
    if(mode==='collectionEdit') return manageCollection(paths.knowledge,graphData(paths.knowledge).graph,input);
    if(mode==='graphEdit') return editKnowledge(paths.knowledge.output,input);
    if(mode==='registerProject') {
      if(typeof input.path!=='string'||!isAbsolute(input.path)||!statSync(input.path).isDirectory()) throw Error('Выберите существующую папку проекта');
      const project=registerProject(paths.knowledge,input.path,input.name);
      queueProjectRefresh(paths.knowledge,project);startWorkflowWorker(paths.knowledge);
      return project;
    }
    if(mode==='refreshGraph') {
      const projects=Object.values(readRegistry(paths.knowledge).projects);
      const selected=input.project?projects.filter(p=>p.id===input.project.replace(/^project:/,'')):projects;
      if(!selected.length) throw Error('Сначала добавьте проект');
      for(const p of selected) queueProjectRefresh(paths.knowledge,p);
      startWorkflowWorker(paths.knowledge);return {queued:selected.length};
    }
    if(mode==='mcpToggle') {
      if(typeof input.enabled!=='boolean') throw Error('Укажите состояние MCP');
      const file=join(paths.profile,'settings.json'),settings=json(file);
      if(!Object.hasOwn(settings.mcpServers||{},input.name)) throw Error('Сервер не найден');
      const excluded=new Set(settings.mcp?.excluded||[]);if(input.enabled)excluded.delete(input.name);else excluded.add(input.name);
      settings.mcp={...settings.mcp,excluded:[...excluded]};privateWrite(file,JSON.stringify(settings,null,2));
      return {restartNessy:true,servers:mcpCatalog(paths)};
    }
    throw Error('Неизвестная операция Companion');
  }
  return {dispatch,close:async()=>{queue.close();clearInterval(corporateTimer);clearInterval(observerTimer);observer.scan();await runtime.close();}};
}
