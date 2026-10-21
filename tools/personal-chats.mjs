import { basename, dirname, join, isAbsolute } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { files, digest, reconcile, equivalent, contained } from './personal-store.mjs';
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
export function stableUuid(value) {
  const h = createHash('sha256').update(value).digest('hex').slice(0, 32).split(''); h[12] = '5'; h[16] = '8';
  const s = h.join(''); return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
const projectName = cwd => (process.platform === 'win32' ? cwd.toLowerCase() : cwd).replace(/[^a-zA-Z0-9]/g, '-');
const iso = time => new Date(Number.isFinite(time) ? time : Date.now()).toISOString();
const timestamp = time => Number.isFinite(time) ? time : Number.isFinite(Date.parse(time)) ? Date.parse(time) : 0;
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
function parse(bytes, path) {
  if (!bytes?.length) return null;
  const text = bytes.toString(); if (!text.endsWith('\n')) throw Error(`Partial chat write: ${path}`);
  return text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
}
export function activeCliChain(rows) {
  const nodes = new Map(rows.filter(r => r.uuid).map(r => [r.uuid, r]));
  const result = [], seen = new Set(); let node = rows.at(-1);
  while (node) {
    if (seen.has(node.uuid)) throw Error('Cyclic CLI conversation'); seen.add(node.uuid); result.push(node);
    if (!node.parentUuid) break;
    node = nodes.get(node.parentUuid);
    if (!node) throw Error('Incomplete CLI conversation ancestry');
  }
  return result.reverse();
}
function partText(p) {
  if (p.thought) return '';
  if (typeof p.text === 'string') return p.text;
  if (p.functionCall) return `[Вызов инструмента из истории]\n${JSON.stringify(p.functionCall)}`;
  if (p.functionResponse) return `[Результат инструмента из истории]\n${JSON.stringify(p.functionResponse)}`;
  if (p.inlineData) return `[Вложение: ${p.inlineData.mimeType || 'данные'}; оригинал сохранён в архиве]`;
  if (p.fileData) return `[Файл: ${p.fileData.fileUri || 'см. оригинал'}]`;
  return '';
}
export function readCli(rows, pair) {
  const messages = activeCliChain(rows).flatMap(r => {
    if (r.isSidechain || !['user','assistant','tool_result'].includes(r.type) || !r.message) return [];
    const text = (r.message.parts || []).map(partText).filter(Boolean).join('\n'); if (!text) return [];
    return [{ id: pair.ids.cli[r.uuid] || `cli:${r.uuid}`, role: r.type === 'user' ? 'user' : 'assistant', text, time: timestamp(r.timestamp) }];
  });
  const title = [...rows].reverse().find(r => r.subtype === 'custom_title')?.systemPayload?.customTitle;
  return { messages, title: title || messages.find(m => m.role === 'user')?.text.slice(0,100) || 'Чат CLI' };
}
function desktopText(value, pair) {
  return value.replace(/\{\{SESSION_PATH((?:~ESC)*)\}\}/g, (_all, markers) => markers ? `{{SESSION_PATH${markers.slice(4)}}}` : dirname(pair.desktopPath));
}
const escapeDesktop = value => value.replace(/\{\{SESSION_PATH((?:~ESC)*)\}\}/g, (_all, markers) => `{{SESSION_PATH${markers}~ESC}}`);
export function readDesktop(rows, pair) {
  const messages = rows.slice(1).flatMap(r => {
    if (r.isThinking || !['user','assistant','tool','error','plan'].includes(r.type)) return [];
    let text = typeof r.content === 'string' ? desktopText(r.content,pair) : '';
    if (r.type === 'tool') text = `[Инструмент из истории: ${r.toolName || 'tool'}]\n${r.toolResult ? desktopText(String(r.toolResult),pair) : text}`;
    if (r.attachments?.length) text += '\n' + r.attachments.map(a => `[Вложение: ${a.name || a.filename || 'см. оригинал'}]`).join('\n');
    if (!text) return [];
    return [{ id: pair.ids.desktop[r.id] || `desktop:${r.id}`, role: r.type === 'user' ? 'user' : 'assistant', text, time: timestamp(r.timestamp) }];
  });
  return { messages, title: (rows[0].name && desktopText(rows[0].name,pair)) || messages.find(m => m.role === 'user')?.text.slice(0,100) || 'Чат Desktop' };
}
function prefix(shorter, longer) { return shorter.length <= longer.length && shorter.every((m,i) => equivalent(m,longer[i])); }
function contextText(messages, archive) {
  const text = messages.map(m => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}:\n${m.text}`).join('\n\n');
  return text.length <= 80000 ? text : text.slice(0,8000) + `\n\n[Контекст перехода сокращён. Полная история: ${archive}]\n\n` + text.slice(-60000);
}
function tokenUsage() { return { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 }; }
function appendCli(rows, selected, title, pair) {
  const current = rows ? readCli(rows,pair).messages : []; if (!prefix(current,selected)) throw Error('non-append-cli');
  const next = rows ? [...rows] : []; let parent = next.at(-1)?.uuid || null;
  for (const m of selected.slice(current.length)) {
    const id = stableUuid(`odysseus:${pair.id}:cli:${m.id}`); pair.ids.cli[id] = m.id;
    next.push({ uuid: id, parentUuid: parent, sessionId: pair.cliId, timestamp: iso(m.time), type: m.role,
      cwd: pair.cwd, version: 'odysseus-portable-v1', message: { role: m.role === 'user' ? 'user' : 'model', parts: [{text:m.text}] } }); parent=id;
  }
  if (next.length && (!rows || readCli(rows,pair).title !== title)) {
    const id = stableUuid(`odysseus:${pair.id}:title:${title}:${parent}`);
    next.push({ uuid:id,parentUuid:parent,sessionId:pair.cliId,timestamp:iso(selected.at(-1)?.time),type:'system',subtype:'custom_title',cwd:pair.cwd,version:'odysseus-portable-v1',systemPayload:{customTitle:title,titleSource:'manual'} });
  }
  return next;
}
function appendDesktop(rows, selected, title, pair, archive) {
  const current = rows ? readDesktop(rows,pair).messages : []; if (!prefix(current,selected)) throw Error('non-append-desktop');
  const messages = rows ? rows.slice(1) : [];
  for (const m of selected.slice(current.length)) {
    const id=stableUuid(`odysseus:${pair.id}:desktop:${m.id}`);pair.ids.desktop[id]=m.id;
    messages.push({id,type:m.role,content:escapeDesktop(m.text),timestamp:m.time});
  }
  const header = rows ? {...rows[0]} : {id:pair.desktopId,workspaceId:pair.workspaceId,createdAt:selected[0]?.time || Date.now(),permissionMode:'default',tokenUsage:tokenUsage(),workingDirectory:pair.cwd,enabledSourceSlugs:[]};
  header.name=escapeDesktop(title);header.lastUsedAt=selected.at(-1)?.time || header.createdAt;header.lastMessageAt=header.lastUsedAt;
  header.messageCount=messages.length;header.lastMessageRole=messages.at(-1)?.type;header.lastFinalMessageId=[...messages].reverse().find(m=>m.type==='assistant'&&!m.isIntermediate)?.id;
  header.preview=escapeDesktop(selected.find(m=>m.role==='user')?.text.slice(0,150) || '');
  if (!rows || selected.length>current.length) {
    delete header.sdkSessionId;delete header.sdkSessionAnchors;
    if(header.branchFrom){header.branchFrom={...header.branchFrom};delete header.branchFrom.sdkSessionId;delete header.branchFrom.sdkTurnId;}
    header.transferredSessionSummary=escapeDesktop(contextText(selected,archive));header.transferredSessionSummaryApplied=false;
  }
  return [header,...messages];
}
function archiveResource(tx, privateDir, bytes) { const id=digest(bytes), path=join(privateDir,'objects',id);tx.put(path,bytes);return id; }
function sourceArchive(tx, privateDir, pair, cliRows, desktopRows, cliPath, desktopPath, projected = {}) {
  const raw={};pair.rawVersions ||= {cli:[],desktop:[]};
  for(const [side,path] of [['cli',cliPath],['desktop',desktopPath]]){
    const content=tx.read(path);
    for(const value of [content,projected[side]])if(value){const id=archiveResource(tx,privateDir,value);if(!pair.rawVersions[side].includes(id))pair.rawVersions[side].push(id);}
    const current=projected[side]||content;if(current)raw[side]={file:path,object:digest(current),versions:pair.rawVersions[side]};
  }
  const resources={};
  if(desktopRows)for(const path of files(dirname(desktopPath),'')){
    if(path===desktopPath || !/(?:^|\/)(attachments|plans|data|long_responses|downloads)\//.test(path))continue;
    const b=tx.read(path);resources[path]=archiveResource(tx,privateDir,b);
  }
  tx.putJson(join(privateDir,'conversations',pair.id,'sources.json'),{pair:pair.id,raw,resources});
}
export function syncChats(context) {
  const { tx,state,report,cliHome,cliRuntime=cliHome,desktopHome,privateDir,defaultCwd,now=Date.now(),settleMs=2000,protectedDesktop=[],protectedCli=[] }=context;
  state.chats ||= {};
  const config=tx.json(join(desktopHome,'config.json'));
  const workspaceId=config.activeWorkspaceId || config.workspaceRefs?.[0]?.id;
  if(!safeId(workspaceId)){report.unsupported.push('chat-target-workspace-unavailable');return;}
  const knownCli=new Set(Object.values(state.chats).map(p=>p.cliPath));
  const knownDesktop=new Set(Object.values(state.chats).map(p=>p.desktopPath));
  const sources=[...files(join(cliRuntime,'projects'),'.jsonl').filter(p=>basename(dirname(p))==='chats').map(path=>({side:'cli',path})),
    ...files(join(desktopHome,'sessions'),'/session.jsonl').map(path=>({side:'desktop',path}))];
  for(const source of sources){
    if((source.side==='cli'?knownCli:knownDesktop).has(source.path))continue;
    let rows;try{rows=parse(tx.read(source.path),source.path);}catch{report.deferred.push(`unstable-chat:${digest(Buffer.from(source.path)).slice(0,12)}`);continue;}
    if(!rows?.length)continue;
    const first=rows[0],id=stableUuid(`${source.side}:${source.path}`);
    if(source.side==='cli'&&(!safeId(first.sessionId)||!isAbsolute(first.cwd||'')))continue;
    if(source.side==='desktop'&&(!safeId(first.id)||!safeId(first.workspaceId)))continue;
    const cwd=source.side==='cli'?first.cwd:isAbsolute(first.workingDirectory||'')?first.workingDirectory:defaultCwd;
    const cliId=source.side==='cli'?first.sessionId:stableUuid(`cli:${id}`);
    const desktopId=source.side==='desktop'?first.id:`odysseus-${id}`;
    const ws=source.side==='desktop'?first.workspaceId:workspaceId;
    const pair={id,origin:source.side,cwd,cliId,desktopId,workspaceId:ws,ids:{cli:{},desktop:{}},
      cliPath:source.side==='cli'?source.path:join(cliRuntime,'projects',projectName(cwd),'chats',`${cliId}.jsonl`),
      desktopPath:source.side==='desktop'?source.path:join(desktopHome,'sessions',ws,desktopId,'session.jsonl')};
    if(knownCli.has(pair.cliPath)||knownDesktop.has(pair.desktopPath)){report.conflicts.push(`chat-identity:${id}`);continue;}
    state.chats[id]=pair;knownCli.add(pair.cliPath);knownDesktop.add(pair.desktopPath);
  }
  for(const pair of Object.values(state.chats)){
    if(!contained(join(cliRuntime,'projects'),pair.cliPath)||!contained(join(desktopHome,'sessions'),pair.desktopPath))throw Error('Chat mapping outside native storage');
    let a,b;try{a=parse(tx.read(pair.cliPath),pair.cliPath);b=parse(tx.read(pair.desktopPath),pair.desktopPath);}catch{report.deferred.push(`partial-chat:${pair.id}`);continue;}
    if(!a&&!b)continue;
    if(pair.synced&&(!a||!b)){report.deferred.push(`removed-chat-preserved:${pair.id}`);continue;}
    const protectCli=protectedCli.includes(pair.cliId), protectDesktop=protectedDesktop.includes(`${pair.workspaceId}/${pair.desktopId}`);
    const active =
      (settleMs>0&&[pair.cliPath,pair.desktopPath].some(path=>existsSync(path)&&now-statSync(path).mtimeMs<settleMs))||
      (b&&['pendingApproval','pendingAskUser','deferredToolCall','pendingPlanExecution'].some(k=>b[0][k]));
    if(active){report.deferred.push(`active-chat:${pair.id}`);continue;}
    const left=a?readCli(a,pair):undefined,right=b?readDesktop(b,pair):undefined;
    if(!left?.messages.length&&!right?.messages.length)continue;
    const messages=reconcile(state,`chat-messages:${pair.id}`,left?.messages,right?.messages,report);
    const title=reconcile(state,`chat-title:${pair.id}`,left?.title,right?.title,report);
    // Archive original bytes even when a semantic conflict prevents a projection.
    if(messages.conflict||title.conflict||!messages.value){sourceArchive(tx,privateDir,pair,a,b,pair.cliPath,pair.desktopPath);continue;}
    if((left&&!prefix(left.messages,messages.value))||(right&&!prefix(right.messages,messages.value))){report.conflicts.push(`chat-rewrite:${pair.id}`);continue;}
    const archive=join(privateDir,'conversations',pair.id,'conversation.json');
    if ((protectCli && (!equivalent(left?.messages,messages.value) || left?.title!==title.value)) || (protectDesktop && (!equivalent(right?.messages,messages.value) || right?.title!==title.value))) { report.deferred.push(`active-chat:${pair.id}`); continue; }
    const projectedCli=protectCli?a:appendCli(a,messages.value,title.value,pair);
    const projectedDesktop=protectDesktop?b:appendDesktop(b,messages.value,title.value,pair,archive);
    const projected={cli:protectCli?tx.read(pair.cliPath):Buffer.from(jsonl(projectedCli)),desktop:protectDesktop?tx.read(pair.desktopPath):Buffer.from(jsonl(projectedDesktop))};
    sourceArchive(tx,privateDir,pair,a,b,pair.cliPath,pair.desktopPath,projected);
    tx.put(pair.cliPath,projected.cli);tx.put(pair.desktopPath,projected.desktop);
    tx.putJson(archive,{schemaVersion:1,id:pair.id,title:title.value,cwd:pair.cwd,messages:messages.value});
    pair.synced=true;messages.accept(readCli(projectedCli,pair).messages,readDesktop(projectedDesktop,pair).messages);title.accept(readCli(projectedCli,pair).title,readDesktop(projectedDesktop,pair).title);
    if(!equivalent(left,right))report.updatedChats.push({workspaceId:pair.workspaceId,sessionId:pair.desktopId,cliId:pair.cliId,cwd:pair.cwd});
  }
}
