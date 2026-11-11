import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync,realpathSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {companionPaths} from '../../tools/companion/paths.mjs';import {scenarios} from '../../tools/companion/scenarios.mjs';import {personal} from '../../tools/companion/personal.mjs';
test('release calendar follows schedule changes without altering personal notes; benefit summary uses only comparable accepted measurements',()=>{
 const root=mkdtempSync(join(realpathSync(tmpdir()),'release-calendar-')),paths=companionPaths(root),service=scenarios(paths),prefs=personal(paths);
 try{
  prefs.update({date:'2026-11-12',text:'Моя личная заметка'});
  assert.throws(()=>service.save({template:'release',input:'Release',freezeDate:'2026-11-15',releaseDate:'2026-11-12'}),/не позже/);
  let row=service.save({template:'release',input:'Release checklist',owner:'Release owner',freezeDate:'2026-11-11',releaseDate:'2026-11-12'});assert.equal(prefs.read().releaseEvents.length,2);assert.equal(prefs.read().notes['2026-11-12'].text,'Моя личная заметка');
  row=service.save({...row,expectedRevision:row.revision,releaseDate:'2026-11-13',steps:row.steps.map(s=>({...s,done:true})),output:'Checked candidate',evidence:[{kind:'check',text:'CI reviewed',source:'ci-run'}],status:'accepted',manualMinutes:30,assistedMinutes:20,rating:5});assert.ok(!prefs.read().releaseEvents.some(e=>e.date==='2026-11-12'));assert.equal(service.state().metrics.compared,1);assert.equal(service.state().metrics.assistedMinutes,20);
  service.save({template:'tutorial',input:'Unfinished',manualMinutes:900,assistedMinutes:800});assert.equal(service.state().metrics.manualMinutes,30);
  prefs.update({date:'2026-11-13',text:'Не затирать'});assert.equal(prefs.read().releaseEvents.length,2);row=service.save({...row,expectedRevision:row.revision,status:'cancelled'});assert.equal(prefs.read().releaseEvents.length,0);assert.equal(prefs.read().notes['2026-11-13'].text,'Не затирать');
 }finally{rmSync(root,{recursive:true,force:true});}
});
