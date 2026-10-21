import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {rolesFor,roleIds} from './build-ui-skills.mjs';
const root=resolve(import.meta.dirname,'..'),config=JSON.parse(readFileSync(join(root,'odysseus.json')));
const data=JSON.parse(readFileSync(join(root,config.components.desktop.source,'apps/electron/src/renderer/data/odysseus-skills.json')));
test('four role tabs cover every shared skill and every translated native skill exactly once by name',()=>{
 assert.deepEqual(roleIds,['general','qa','dev','sa']);const names=data.entries.map(e=>e.name);assert.equal(new Set(names).size,names.length);
 const shared=JSON.parse(readFileSync(join(root,'shared/skills-catalog.json'))),native=JSON.parse(readFileSync(join(root,'shared/ui/native-skills-ru.json')));
 for(const name of [...shared.entries.map(e=>e.name),...Object.keys(native)])assert.ok(names.includes(name),name);
 for(const e of data.entries){assert.match(e.description,/[А-Яа-яЁё]/);assert.ok(e.roles.length>0);assert.deepEqual(e.roles,rolesFor(e));assert.ok(e.roles.every(r=>roleIds.includes(r)));}
});
test('role recommendations put testing, implementation and systems-analysis tools in the expected tabs',()=>{
 const get=name=>data.entries.find(e=>e.name===name).roles;
 assert.ok(get('generate-tests').includes('qa'));assert.ok(get('review-bugbot').includes('qa'));assert.ok(get('repo-analysis').includes('dev'));assert.ok(get('threejs-shaders').includes('dev'));assert.ok(get('spec-create').includes('sa'));assert.ok(get('domain-modeling').includes('sa'));assert.ok(get('browser').includes('general'));
});

test('automatic conditions are specific, display-only and present for every automatic shared skill',()=>{
 const shared=JSON.parse(readFileSync(join(root,'shared/skills-catalog.json')));
 for(const e of data.entries){
  if(e.bundled){const source=shared.entries.find(s=>s.name===e.name);assert.equal(e.automatic,source.automatic);}
  assert.ok(e.requestExample.length>10,e.name);
  assert.equal(e.autoCriteria.length,e.bundled&&e.automatic?1:0,e.name);
  if(e.autoCriteria.length)assert.ok(e.autoCriteria[0].length>30,e.name);
 }
 assert.match(data.entries.find(e=>e.name==='browser').autoCriteria[0],/страниц/);
 assert.match(data.entries.find(e=>e.name==='docx').autoCriteria[0],/Word/);
 assert.match(data.entries.find(e=>e.name==='brand-guidelines').autoCriteria[0],/Anthropic/);
});

test('advertising exclusions stay out of the active catalog',()=>{
 const policy=JSON.parse(readFileSync(join(root,'shared/skills-policy.json')));
 const excluded=policy.removed.filter(e=>e.reason==='Реклама и маркетинг исключены по запросу пользователя.');
 assert.equal(excluded.length,53);
 assert.ok(!data.entries.some(e=>e.category==='marketing'));
 for(const e of excluded)assert.ok(!data.entries.some(s=>s.name===e.name),e.name);
});
