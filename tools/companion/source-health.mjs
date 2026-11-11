import {statSync,accessSync,constants} from 'node:fs';import {isAbsolute} from 'node:path';
import {scopedGraph} from '../automations/knowledge.mjs';
import {workspaceStore,text,now,fingerprint} from './workspace-store.mjs';
export function localSourceStatus(source){
 if(!isAbsolute(String(source||'')))return {status:'external',modifiedAt:null,stamp:null};
 try{const s=statSync(source);accessSync(source,constants.R_OK);return {status:'available',modifiedAt:s.mtime.toISOString(),stamp:fingerprint([s.mtimeMs,s.ctimeMs,s.size,s.mode])};}
 catch(e){return {status:e.code==='ENOENT'?'missing':'unreadable',modifiedAt:null,stamp:null};}
}
export function sourceHealth(paths){const store=workspaceStore(paths);
 function state(i={}){const {graph}=scopedGraph(paths.automation,i.collection||'projects',i.project);const unique=new Map();const reviews=store.read().sourceReviews||{};
  for(const n of graph.nodes){if(!n.source_file||['project','folder'].includes(n.type))continue;if(unique.has(n.source_file))continue;const health=localSourceStatus(n.source_file),review=reviews[fingerprint(n.source_file)];unique.set(n.source_file,{source:n.source_file,title:n.label||n.source_file,...health,review:review||null,needsReview:!review||review.stamp!==health.stamp||Date.now()-Date.parse(review.at)>90*86400000});}
  return {sources:[...unique.values()],checkedAt:now()};
 }
 function review(i){const source=text(i.source,2000);const found=state(i).sources.find(s=>s.source===source);if(!found)throw Error('Источник не найден в выбранной области');if(found.status!=='available')throw Error('Нельзя подтвердить актуальность недоступного или удалённого источника');if(i.expectedStamp!==found.stamp)throw Error('Источник изменился. Обновите список перед проверкой.');
  return store.mutate(s=>{s.sourceReviews||={};const entry={source,owner:text(i.owner,200),note:text(i.note||'',2000,{optional:true}),at:now(),stamp:found.stamp};s.sourceReviews[fingerprint(source)]=entry;return entry;});
 }
 return {state,review};
}
