import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,realpathSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {companionPaths} from '../../tools/companion/paths.mjs';import {projectPassports} from '../../tools/companion/project-passports.mjs';import {registerProject} from '../../tools/graphify.mjs';import {knowledgeScope,localFirstContext} from '../../tools/companion/retrieval.mjs';
test('project passport follows cwd boundaries, revision conflicts and pause; unindexed project never falls back to all projects',async()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'passport-'));const paths=companionPaths(root,{ODYSSEUS_COMPANION_HOME:join(root,'state'),ODYSSEUS_COMPANION_STANDALONE:'1'});
 try{
  const a=join(root,'alpha'),b=join(root,'beta');mkdirSync(a);mkdirSync(b);registerProject(paths.knowledge,a,'Alpha');registerProject(paths.knowledge,b,'Beta');
  const service=projectPassports(paths),alpha=service.state().projects.find(p=>p.path===a);const saved=service.save({project:alpha.id,summary:'alpha-private-context',businessRules:'Do not invent commissions',sources:['contract.md']});
  assert.match(service.context(join(a,'src')),/alpha-private-context/);assert.equal(service.context(b),'');assert.equal(service.context(a+'-other'),'');
  assert.throws(()=>service.save({project:alpha.id,summary:'lost update'}),/изменился/);assert.equal(knowledgeScope(paths,a).project,alpha.id);
  let scope;const context=await localFirstContext(paths,{cwd:a,prompt:'fees'},{search:async(p,i)=>{scope=i;throw Error('No index');}});assert.equal(scope.project,alpha.id);assert.match(context,/alpha-private-context/);assert.match(context,/недоступен/);
  service.save({...saved,expectedRevision:saved.revision,enabled:false});assert.equal(service.context(a),'');
 }finally{rmSync(root,{recursive:true,force:true});}
});
