import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync,realpathSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {companionPaths} from '../../tools/companion/paths.mjs';import {memoryService} from '../../tools/companion/memory.mjs';import {sourceHealth} from '../../tools/companion/source-health.mjs';import {searchKnowledge} from '../../tools/automations/knowledge.mjs';import {localFirstContext} from '../../tools/companion/retrieval.mjs';
import {searchAudit} from '../../tools/companion/search-audit.mjs';
test('source review becomes stale after change and removed sources disappear from RAG and automatic graph context',async()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'source-health-')),paths=companionPaths(root,{ODYSSEUS_COMPANION_HOME:join(root,'state'),ODYSSEUS_COMPANION_STANDALONE:'1'});
 try{
  const memory=memoryService(paths),entry=memory.capture({title:'Reviewable',text:'zeta_contract_evidence_88'}),approved=memory.edit({id:entry.id,action:'approve'}),service=sourceHealth(paths);
  let source=service.state().sources.find(s=>s.source===approved.publishedSource);assert.equal(source.status,'available');assert.equal(source.needsReview,true);
  service.review({source:source.source,expectedStamp:source.stamp,owner:'Документация'});assert.equal(service.state().sources[0].needsReview,false);
  writeFileSync(source.source,'Updated source, different length');assert.equal(service.state().sources[0].needsReview,true);assert.throws(()=>service.review({source:source.source,expectedStamp:source.stamp,owner:'Owner'}),/изменился/);
  assert.equal((await searchKnowledge(paths.automation,{query:'zeta_contract_evidence_88'})).matches.length,0);rmSync(source.source);
  assert.equal(service.state().sources[0].status,'missing');assert.equal((await searchKnowledge(paths.automation,{query:'zeta_contract_evidence_88'})).matches.length,0);
  const graph=searchAudit(paths).filterGraph({},{nodes:[{id:'stale',source_file:source.source,description:'old fact'}],links:[]});assert.equal(graph.nodes.length,0);
  assert.ok(!(await localFirstContext(paths,{prompt:'zeta_contract_evidence_88'})).includes('Источник: '+source.source));assert.throws(()=>service.review({source:source.source,owner:'Owner'}),/недоступного/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
