const {app,BrowserWindow,ipcMain,dialog,shell}=require('electron');
const {fork,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {join,resolve}=require('node:path');
const {readFileSync,existsSync,mkdirSync,appendFileSync}=require('node:fs');
const configPath=join(__dirname,'runtime.json');
const config=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')):{root:resolve(__dirname,'..'),node:process.env.ODYSSEUS_NODE||'/usr/local/bin/node'};
config.node=resolve(__dirname,config.node);
if(config.standalone)config.root=resolve(__dirname,config.root);
const home=process.env.ODYSSEUS_COMPANION_HOME||(config.standalone?join(app.getPath('appData'),'Odysseus Companion'):join(config.root,'.odysseus/companion'));
app.setName('Odysseus Companion');app.setPath('userData',join(home,'electron'));
let child,window,sequence=0,quitting=false;const pending=new Map();
const modes=new Set(['customScenarioSave','customScenarioDelete','customScenarioDraft','mcpResources','mcpResourceRead','systemPackageRecoveryPreview','systemPackageRecover','queueState','queueEnqueue','queueStart','queueCancel','queueRetry','scenarioState','scenarioSave','scenarioPrompt','sourceHealth','sourceReview','projectPassports','projectPassportSave','systemPackagePreview','systemPackageApply','systemPackageRollback','systemPackageHistory','taskCatalog','taskPreview','agentDefinitions','agentDefinitionSave','agentDefinitionReset','agentDefinitionDelete','chatRate','chatOrganize','skillCompare','skillInstall','toolIcons','toolIconSave','memoryList','memoryCapture','memoryEdit','memoryMerge','memoryHygiene','decisions','decisionSave','activity','boardState','boardConfigure','boardTask','agentRuns','agentPlan','agentStage','chatList','chatRead','chatLaunch','searchAudit','sourceExclusion','toolProfiles','toolProfileSave','toolProfilePreview','toolProfileApply','inventory','mcpProbe','diagnostics','knowledgeExplore','workflowRestore','workflowCompare','workflowCapture','workflowLibrary','workflowImport','workflowSync','workflowExport','personal','personalUpdate','usage','observerConfigure','installationStatus','installExtension','overview','skills','skill','mcp','mcpToggle','plugins','rag','graphView','graphEdit','document','collections','collectionEdit','registerProject','refreshGraph','status','configure','start','stop','catalogs','search','answer','index','save','workflowList','workflowGet','workflowSave','workflowActivate','executions','connectionModels','externalSearch','templates','importNessyModel','corporateStatus','corporateConfigure','corporateCheck','corporateSync','corporateWorkflows','corporateWorkflow','corporateExecutions']);
function request(mode,input={}) {
  if(!child?.connected)return Promise.reject(Error('Сервис Companion не запущен'));
  const id=++sequence;
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('Операция ещё не завершена; проверьте состояние'))},240000);pending.set(id,{resolve,reject,timer});child.send({id,mode,input});});
}
function trusted(event){if(!window||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw Error('Недоверенное окно');}
ipcMain.handle('companion:call',async(event,mode,input)=>{trusted(event);if(!modes.has(mode))throw Error('Недоступная операция');return request(mode,input)});
ipcMain.handle('companion:copy-result',async(event,input)=>{trusted(event);const formatted=require('./result-format.cjs').formatResult(input);require('electron').clipboard.write(formatted);return {copied:true,format:input.format};});
ipcMain.handle('companion:task-run',async(event,input)=>{trusted(event);const prepared=await request('taskPreview',input);const selected=await dialog.showOpenDialog(window,{title:'Рабочий проект для выбранного набора',properties:['openDirectory']});if(selected.canceled)return {cancelled:true};const script=require('./native-launch.cjs').scenarioCommand({root:config.root,node:config.node,home,cwd:selected.filePaths[0],standalone:config.standalone,prompt:prepared.preparedPrompt,allowedMcpNames:prepared.allowedMcpNames,skillIds:prepared.skills.map(s=>s.id),readOnly:true});const folder=join(home,'launches');mkdirSync(folder,{recursive:true,mode:0o700});const file=join(folder,'Task-'+require('node:crypto').randomUUID()+'.command');require('node:fs').writeFileSync(file,script,{mode:0o700});const error=await shell.openPath(file);if(error)throw Error(error);return {opened:true,executionVerified:false};});
ipcMain.handle('companion:scenario-run',async(event,input)=>{trusted(event);const prepared=await request('scenarioPrompt',{id:input?.id,template:input?.template,assistant:input?.assistant===true,description:input?.description,builder:input?.builder,targetId:input?.targetId,collection:input?.collection,project:input?.project});let cwd=prepared.cwd||(input?.assistant===true?home:undefined);if(!cwd){const r=await dialog.showOpenDialog(window,{title:'Проект для сценария Nessy',properties:['openDirectory']});if(r.canceled)return {cancelled:true};cwd=r.filePaths[0];}const script=require('./native-launch.cjs').scenarioCommand({root:config.root,node:config.node,home,cwd,standalone:config.standalone,prompt:prepared.prompt,skillIds:prepared.skillIds,allowedMcpNames:prepared.allowedMcpNames,worktree:prepared.worktree,readOnly:prepared.readOnly});const folder=join(home,'launches');mkdirSync(folder,{recursive:true,mode:0o700});const file=join(folder,'Scenario-'+require('node:crypto').randomUUID()+'.command');require('node:fs').writeFileSync(file,script,{mode:0o700});const error=await shell.openPath(file);if(error)throw Error(error);return {opened:true,executionVerified:false};});
ipcMain.handle('companion:regression-import',async event=>{trusted(event);const r=await dialog.showOpenDialog(window,{title:'Локальный отчёт Allure JSON',properties:['openFile'],filters:[{name:'JSON',extensions:['json']}]});if(r.canceled)return null;const file=r.filePaths[0];if(require('node:fs').statSync(file).size>500000)throw Error('Отчёт должен быть меньше 500 КБ');return request('regressionReport',{report:JSON.parse(readFileSync(file,'utf8'))});});
ipcMain.handle('companion:skill-import',async(event,kind)=>{trusted(event);const r=await dialog.showOpenDialog(window,{title:kind==='file'?'Выберите SKILL.md':'Выберите папку навыка с SKILL.md',properties:[kind==='file'?'openFile':'openDirectory'],...(kind==='file'?{filters:[{name:'Инструкция навыка',extensions:['md']}]}:{})});if(r.canceled)return null;return request('skillImport',{path:r.filePaths[0]});});
ipcMain.handle('companion:folder',async event=>{trusted(event);const r=await dialog.showOpenDialog(window,{properties:['openDirectory']});return r.canceled?null:r.filePaths[0]});
ipcMain.handle('companion:import-workflows',async event=>{trusted(event);const r=await dialog.showOpenDialog(window,{properties:['openFile'],filters:[{name:'Процессы n8n',extensions:['json']}]});if(r.canceled)return null;const f=r.filePaths[0];if(require('node:fs').statSync(f).size>500000)throw Error('Файл должен быть меньше 500 КБ');return request('workflowImport',JSON.parse(readFileSync(f,'utf8')));});
ipcMain.handle('companion:export-workflows',async event=>{trusted(event);const data=await request('workflowExport');const r=await dialog.showSaveDialog(window,{defaultPath:'odysseus-workflows.json',filters:[{name:'JSON',extensions:['json']}]});if(r.canceled)return null;require('node:fs').writeFileSync(r.filePath,JSON.stringify(data,null,2),{mode:0o600});return {count:data.workflows.length};});
ipcMain.handle('companion:profile',async event=>{trusted(event);shell.showItemInFolder(join(home,'nessy/settings.json'))});
ipcMain.handle('companion:nessy',async event=>{trusted(event);const error=await shell.openPath(join(home,'Открыть Nessy с Companion.command'));if(error)throw Error(error)});
ipcMain.handle('companion:chat-run',async(event,input)=>{
  trusted(event);let launch=await request('chatLaunch',input);if(launch.needsPrompt)throw Error('Сначала проверьте текст повторного запроса');if(launch.needsProject){const chosen=await dialog.showOpenDialog(window,{title:'Рабочая папка для чата',message:'Исходная папка недоступна. Выберите новый проект: история будет скопирована, оригинальный чат сохранится.',properties:['openDirectory']});if(chosen.canceled)return {opened:false,cancelled:true};launch=await request('chatLaunch',{...input,project:chosen.filePaths[0]});}const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
  const args=['--profile',launch.profile,'--project',launch.cwd,...(['new','repeat'].includes(launch.mode)?[]:['--resume',launch.sessionId]),...(launch.mode==='fork'?['--fork-session']:[]),...(launch.mode==='repeat'?['--prompt-interactive='+launch.prompt]:[])];
  const folder=join(home,'launches');mkdirSync(folder,{recursive:true,mode:0o700});const file=join(folder,'Nessy-'+require('node:crypto').randomUUID()+'.command');
  require('node:fs').writeFileSync(file,'#!/bin/zsh\nset -e\nexport ODYSSEUS_ROOT='+quote(config.root)+'\nexport ODYSSEUS_COMPANION_HOME='+quote(home)+'\n'+(config.standalone?'export ODYSSEUS_COMPANION_STANDALONE=1\n':'')+'exec '+quote(config.node)+' '+quote(join(config.root,'tools/companion/launch-nessy.mjs'))+' '+args.map(quote).join(' ')+'\n',{mode:0o700});const error=await shell.openPath(file);if(error)throw Error(error);return {opened:true,mode:launch.mode};
});
ipcMain.handle('companion:corporate-n8n', async (event, id) => {
  trusted(event);
  if (id !== undefined && (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id))) throw Error('Некорректный ID процесса');
  const state = await request('corporateStatus');
  const url = new URL(state.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw Error('Некорректный адрес n8n');
  url.pathname = id ? '/workflow/' + id : '/';
  await shell.openExternal(url.href);
});
ipcMain.handle('companion:n8n',async event=>{
  trusted(event);const state=await request('status');if(!state.engine.running)throw Error('Сначала запустите n8n');
  const url=state.engine.editorUrl;if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(url))throw Error('Недопустимый адрес редактора');
  const w=new BrowserWindow({title:'n8n · Odysseus Companion',width:1320,height:900,parent:window,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'persist:companion-n8n'}});
  w.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  w.webContents.on('will-navigate',(e,to)=>{if(new URL(to).origin!==url)e.preventDefault()});
  w.webContents.session.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
  const session=await request('editorSession');await w.webContents.session.cookies.set({url,name:'n8n-auth',value:session.cookie,httpOnly:true,secure:false,sameSite:'lax',path:'/'});
  await w.loadURL(url+'/home/workflows');
});
async function boot(){
  if(!existsSync(config.node)||!existsSync(join(config.root,'tools/companion/service.mjs')))throw Error('Не найдена установленная платформа. Пересоберите Companion из папки проекта.');
  mkdirSync(home,{recursive:true,mode:0o700});
  const env={...process.env,ODYSSEUS_ROOT:config.root,ODYSSEUS_COMPANION_HOME:home,ODYSSEUS_DATA_DIR:join(home,'data')};delete env.ELECTRON_RUN_AS_NODE;
  if(config.standalone){env.ODYSSEUS_COMPANION_STANDALONE='1';env.COMPANION_LEGACY_HOME=config.legacyHome||'';env.COMPANION_PREVIOUS_ROOT=config.previousRoot||'';}
  if(config.standalone)await promisify(execFile)(config.node,[join(config.root,'tools/companion/prepare-standalone.mjs')],{env,timeout:180000,maxBuffer:1024*1024});
  const cert=join(home,'nessy/certs/tinkoff-bundle.crt');if(existsSync(cert))env.NODE_EXTRA_CA_CERTS=cert;
  child=fork(join(config.root,'tools/companion/service.mjs'),[],{execPath:config.node,env,stdio:['ignore','ignore','pipe','ipc']});
  child.stderr.on('data',d=>appendFileSync(join(home,'service.log'),d,{mode:0o600}));
  const ready=new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('Сервис платформы не ответил')),30000);
    child.on('message',m=>{if(m.ready){clearTimeout(timeout);resolve()}const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.result)}});
    child.once('error',e=>{clearTimeout(timeout);reject(e)});
    child.once('exit',()=>{clearTimeout(timeout);reject(Error('Сервис завершился. Подробности: '+join(home,'service.log')));for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Сервис завершился'))}pending.clear()});
  });
  await ready;
  window=new BrowserWindow({title:'Odysseus Companion',width:1440,height:960,minWidth:1040,minHeight:720,titleBarStyle:'hiddenInset',trafficLightPosition:{x:18,y:10},backgroundColor:'#141516',webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',e=>e.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
  await window.loadFile(join(__dirname,'index.html'));
  if(process.env.COMPANION_SMOKE==='1'){
    const result=await window.webContents.executeJavaScript('window.companion.call("overview")');
    require('node:fs').writeFileSync(join(home,'ui-smoke.json'),JSON.stringify({title:window.getTitle(),skills:result.skills,mcp:result.mcp,nodes:result.graphNodes}));
  }
}
if(!app.requestSingleInstanceLock())app.quit();else{
 app.on('second-instance',()=>{window?.show();window?.focus()});
 app.whenReady().then(boot).catch(e=>{dialog.showErrorBox('Odysseus Companion',e.message);app.quit()});
 app.on('window-all-closed',()=>app.quit());
 app.on('before-quit',e=>{if(quitting)return;quitting=true;if(child?.connected){e.preventDefault();child.disconnect();const timer=setTimeout(()=>{child.kill('SIGTERM');app.quit()},14000);child.once('exit',()=>{clearTimeout(timer);app.quit()})}});
}
