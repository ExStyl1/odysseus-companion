/** Read-only n8n Public API adapter; production workflows are never published here. */
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { privateWrite } from '../personal/store.mjs';
import { readSecrets, writeSecrets } from '../personal/secrets.mjs';
import { json } from './paths.mjs';
import { redact } from './catalog.mjs';
export const CORPORATE_N8N_URL='https://n8n.t-tech.team';
function clean(value){
  if(Array.isArray(value))return value.map(clean);
  if(value&&typeof value==='object'){
    const sensitive=/token|secret|password|authorization|api[-_]?key/i.test(String(value.name||value.key||''));
    return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k==='value'&&sensitive?'[скрыто]':clean(redact(v,k))]));
  }
  return redact(value);
}
export function corporateN8n(paths,{fetchImpl=fetch,allowHttp=false}={}){
  const home=join(paths.home,'corporate-n8n'),file=join(home,'config.json'),cacheFile=join(home,'snapshot.json');
  const config=()=>json(file,{baseUrl:CORPORATE_N8N_URL,apiPath:'/api/v1',autoSync:true,intervalSeconds:120});
  const identity=()=>createHash('sha256').update(JSON.stringify([config().baseUrl,config().apiPath,readSecrets(home).apiKey||''])).digest('hex');
  const snapshot=()=>{const s=json(cacheFile);return s.identity===identity()?{...s,workflows:Array.isArray(s.workflows)?s.workflows:[],executions:Array.isArray(s.executions)?s.executions:[]}:{workflows:[],executions:[]};};
  let running;
  function status(){const c=config(),s=snapshot();return {...c,hasApiKey:!!readSecrets(home).apiKey,syncing:!!running,lastSyncedAt:s.syncedAt||null,lastAttemptAt:s.attemptedAt||null,lastError:s.error||null,workflows:s.workflows.length,executions:s.executions.length,stale:!s.syncedAt||!!s.error||Date.now()-Date.parse(s.syncedAt)>c.intervalSeconds*2000};}
  function configure(input){
    const c=config(),url=new URL(input.baseUrl||c.baseUrl);
    if((url.protocol!=='https:'&&!(allowHttp&&url.protocol==='http:'))||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('Укажите HTTPS-адрес n8n без пути, ключей и параметров');
    const apiPath=String(input.apiPath||c.apiPath);
    if(!/^\/[a-zA-Z0-9/_-]+$/.test(apiPath)||apiPath.includes('..'))throw Error('Путь API должен иметь вид /api/v1');
    const next={...c,baseUrl:url.origin,apiPath,autoSync:typeof input.autoSync==='boolean'?input.autoSync:c.autoSync,intervalSeconds:Math.min(3600,Math.max(30,Number(input.intervalSeconds)||c.intervalSeconds))};
    const secrets=readSecrets(home);
    if(c.baseUrl!==next.baseUrl||c.apiPath!==next.apiPath||input.clearApiKey)delete secrets.apiKey;
    if(input.apiKey&&!input.clearApiKey){if(typeof input.apiKey!=='string'||input.apiKey.length>16000||/[\r\n]/.test(input.apiKey))throw Error('Некорректный API-ключ');secrets.apiKey=input.apiKey.trim();}
    writeSecrets(home,secrets);privateWrite(file,JSON.stringify(next,null,2));return status();
  }
  async function request(endpoint){
    const c=config(),key=readSecrets(home).apiKey;if(!key)throw Error('Добавьте API-ключ корпоративного n8n в приложении');
    const response=await fetchImpl(c.baseUrl+c.apiPath+endpoint,{headers:{'X-N8N-API-KEY':key,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok){await response.body?.cancel();throw Error([401,403].includes(response.status)?'Нет доступа к n8n API: проверьте API-ключ и права (HTTP '+response.status+')':'n8n API: HTTP '+response.status);}
    const type=response.headers.get('content-type')||'';
    if(!type.includes('json')){await response.body?.cancel();throw Error('n8n вернул страницу входа вместо API. Нужны доступ к Public API и API-ключ');}
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>8*1024*1024)throw Error('Ответ n8n превышает 8 МБ');chunks.push(chunk);}
    try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw Error('n8n API вернул некорректный JSON');}
  }
  async function check(){
    try {
      const result=await request('/workflows?limit=1');
      if(!Array.isArray(result.data))throw Error('Неизвестный формат ответа n8n API');
      return {connected:true, server:config().baseUrl, message:'API отвечает. Доступ к списку процессов подтверждён.'};
    } catch(error) {
      throw Error(connectionError(error));
    }
  }
  function connectionError(error){
    const code=error.cause?.code || '';
    if(/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|ETIMEDOUT/.test(code)||error.name==='TimeoutError')
      return 'Корпоративный n8n недоступен. Проверьте VPN, DNS и доступ к серверу.';
    if(/CERT|SELF_SIGNED/.test(code))return 'Не удалось проверить сертификат n8n: настройте доверенный корпоративный CA';
    return String(error.message||'Не удалось загрузить n8n').slice(0,240);
  }
  async function pages(endpoint,maxPages=20,{partial=false}={}){
    const values=[],seen=new Set();let cursor;
    for(let page=0;page<maxPages;page++){
      const data=await request(endpoint+(endpoint.includes('?')?'&':'?')+'limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
      if(!Array.isArray(data.data))throw Error('Неизвестный формат ответа n8n API');
      values.push(...data.data);if(!data.nextCursor)return values;
      if(typeof data.nextCursor!=='string'||seen.has(data.nextCursor))throw Error('API n8n повторяет курсор страницы');
      seen.add(data.nextCursor);cursor=data.nextCursor;
    }
    if(partial){values.truncated=true;return values;}
    throw Error('Слишком много страниц n8n; снимок сохранён без замены. Уточните права/область API-ключа');
  }
  async function sync(){
    if(running)return running;
    const id=identity();
    running=(async()=>{
      try{
        const workflows=await pages('/workflows');
        // Public API list normally contains definitions; support metadata-only gateways as well.
        for(const w of workflows)if(!Array.isArray(w.nodes)){
          if(typeof w.id!=='string'||!/^[\w-]{1,100}$/.test(w.id))throw Error('Некорректный ID процесса n8n');
          Object.assign(w,await request('/workflows/'+encodeURIComponent(w.id)));
        }
        let executions=[],executionError=null;
        try{executions=await pages('/executions?includeData=false',5,{partial:true});}catch(e){executions=snapshot().executions;executionError=connectionError(e);}
        if(identity()!==id)throw Error('Подключение изменилось во время загрузки; повторите синхронизацию');
        // Execution payloads can contain customer data and are intentionally not downloaded.
        const history=executions.map(e=>Object.fromEntries(['id','workflowId','status','mode','startedAt','stoppedAt','finished','retryOf'].filter(k=>k in e).map(k=>[k,e[k]])));
        privateWrite(cacheFile,JSON.stringify({identity:id,source:config().baseUrl,syncedAt:new Date().toISOString(),attemptedAt:new Date().toISOString(),error:null,executionError,executionsTruncated:!!executions.truncated,workflows:clean(workflows),executions:history}));
      }catch(error){
        const prior=snapshot();
        const message=connectionError(error);
        if(identity()===id)privateWrite(cacheFile,JSON.stringify({...prior,identity:id,attemptedAt:new Date().toISOString(),error:message}));
        throw Error(message);
      }finally{running=undefined;}
      return status();
    })();return running;
  }
  function workflow(id){const w=snapshot().workflows.find(w=>w.id===id);if(!w)throw Error('Процесс не найден в локальном снимке. Загрузите корпоративный n8n');return structuredClone(w);}
  function workflows({query='',offset=0,limit=2000}={}){
    const rows=snapshot().workflows.filter(w=>String(w.name).toLowerCase().includes(String(query).toLowerCase()));
    offset=Math.max(0,Number(offset)||0);limit=Math.min(2000,Math.max(1,Number(limit)||100));
    const data=rows.slice(offset,offset+limit).map(w=>Object.fromEntries(['id','name','active','updatedAt','createdAt','tags'].filter(k=>k in w).map(k=>[k,w[k]])));
    return {data,total:rows.length,offset,limit,nextOffset:offset+data.length<rows.length?offset+data.length:null,...status()};
  }
  return {status,configure,check,sync,workflows,executions:()=>({data:snapshot().executions,truncated:!!snapshot().executionsTruncated,warning:snapshot().executionError||null,...status()}),workflow};
}
