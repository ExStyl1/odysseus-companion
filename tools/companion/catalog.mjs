import {scrubText} from '../personal/redact-text.mjs';
import { existsSync, readdirSync, readFileSync, statSync, lstatSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { json } from './paths.mjs';
import { skillMetadata } from './skill-metadata.mjs';
const secret = /token|secret|password|credential|authorization|api.?key|jwt/i;
export function redact(value, key = '') {
  if (secret.test(key)) return value ? '[скрыто]' : '';
  if (Array.isArray(value)) return value.map((x,i)=>i>0&&typeof value[i-1]==='string'&&/^--(?:api[-_]?key|token|secret|password|authorization)$/i.test(value[i-1])?'[скрыто]':redact(x));
  if (value && typeof value === 'object') { const out=Object.fromEntries(Object.entries(value).map(([k,v]) => [k,redact(v,k)]));if(secret.test(String(value.name||value.key||''))&&'value' in out)out.value=value.value?'[скрыто]':'';return out; }
  if (typeof value === 'string') return scrubText(value).replace(/(--(?:api[-_]?key|token|secret|password|authorization)=)[^\s]+/gi,'$1[скрыто]').replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/g,'$1[скрыто]@').replace(/([?&](?:key|token|secret|password)=)[^&\s]+/gi,'$1[скрыто]').replace(/Bearer\s+\S+/gi,'Bearer [скрыто]');
  return value;
}
export function walk(root) {
  if (!existsSync(root)) return [];
  const out=[];
  for (const entry of readdirSync(root,{withFileTypes:true})) {
    if (entry.isSymbolicLink() || ['node_modules','.git','.nessy-runtime','.cursor','.claude'].includes(entry.name)) continue;
    const file=join(root,entry.name);
    if (entry.isDirectory()) out.push(...walk(file)); else if (entry.isFile()) out.push(file);
  }
  return out;
}
export function skills(paths) {
  const rows=[];
  const disabled=new Set((json(join(paths.profile,'settings.json')).skills?.disabled||[]).map(s=>String(s).toLowerCase()));
  for (const [kind,base] of [['Общие',join(paths.profile,'skills')],['Расширения',join(paths.profile,'extensions')]]) {
    const candidates=walk(base).filter(p=>/\/SKILL\.md$/i.test(p)).filter(p=>{
      const parts=relative(base,p).split('/');
      return kind==='Общие'?parts.length===2:parts.length===4&&parts[1]==='skills';
    });
    for (const file of candidates) {
      const rel=relative(base,file), text=readFileSync(file,'utf8'), front=text.startsWith('---')?text.split('---')[1]:'';
      const field=k=>{const raw=front.match(new RegExp('^'+k+':\\s*(.*)$','m'))?.[1]?.trim();if(raw?.startsWith('"')){try{return JSON.parse(raw)}catch{}}return raw?.replace(/^["']|["']$/g,'');};
      rows.push({ id:kind+':'+rel, kind, name:field('name')||rel.split('/').at(-2), description:field('description')||'', path:file,
        package:kind==='Расширения'?rel.split('/')[0]:'Odysseus', automatic:!/^true$/i.test(field('disable-model-invocation')||'') });
    }
  }
  return rows.map(s=>({...s,...skillMetadata(paths,s),enabled:!disabled.has(s.name.toLowerCase()),automatic:s.automatic&&!disabled.has(s.name.toLowerCase())}));
}
export function readSkill(paths, id) {
  const found=skills(paths).find(s=>s.id===id);
  if (!found) throw Error('Навык не найден');
  return {...found,content:readFileSync(found.path,'utf8').slice(0,100000)};
}
export function mcpCatalog(paths) {
  const settings=json(join(paths.profile,'settings.json'));
  const excluded=new Set(settings.mcp?.excluded||[]);
  return Object.entries(settings.mcpServers||{}).map(([name,config])=>({name, enabled:!excluded.has(name),config:redact(config),
    commandAvailable:config.command&&isAbsolute(config.command)?existsSync(config.command):null,
    transport:config.httpUrl||config.url?'http':config.type||'stdio',
    environmentKeys:Object.keys(config.env||{})}));
}
export function plugins(paths) {
  const base=join(paths.profile,'extensions');
  if(!existsSync(base)) return [];
  return readdirSync(base,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink()).map(e=>{
    const manifest=json(join(base,e.name,'nessy-extension.json')); const files=walk(join(base,e.name));
    return {name:e.name,version:manifest.version||'',skills:files.filter(f=>/\/SKILL\.md$/i.test(f)).length,
      agents:files.filter(f=>/\/agents\/[^/]+\.(md|ya?ml)$/.test(f)).length,
      context:manifest.contextFileName||null};
  });
}
export function ragIndexes(paths) {
  const base=join(paths.automation.home,'rag');
  return walk(base).filter(f=>f.endsWith('.json')).map(file=>{
    const d=json(file);return {id:relative(base,file),collection:d.collection,project:d.project,updatedAt:d.updatedAt,
      chunks:d.chunks?.length||0, embeddingModel:d.embeddingModel||null,
      sources:[...new Set((d.chunks||[]).map(c=>c.source))].slice(0,60), bytes:statSync(file).size};
  });
}

/** Native chat journals are direct files; do not traverse worktrees or project caches. */
export function chatJournals(profile){const base=join(profile,'projects');if(!existsSync(base)||lstatSync(base).isSymbolicLink())return [];const out=[];for(const entry of readdirSync(base,{withFileTypes:true})){if(!entry.isDirectory()||entry.isSymbolicLink())continue;const chats=join(base,entry.name,'chats');if(!existsSync(chats)||lstatSync(chats).isSymbolicLink()||!lstatSync(chats).isDirectory())continue;for(const f of readdirSync(chats,{withFileTypes:true}))if(f.isFile()&&!f.isSymbolicLink()&&f.name.endsWith('.jsonl'))out.push(join(chats,f.name));}return out;}
