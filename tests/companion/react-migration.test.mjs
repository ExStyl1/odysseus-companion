import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {setup,wait,until} from './ui-harness.mjs';
test('the packaged entry uses one React renderer and no legacy page scripts',()=>{const html=readFileSync('companion/index.html','utf8');assert.deepEqual([...html.matchAll(/script src="([^"]+)"/g)].map(m=>m[1]),['themes.js','ui/companion-ui.js']);for(const name of ['renderer.js','workspace.js','graph-map.js','designs.js'])assert.equal(existsSync('companion/'+name),false);const bundle=readFileSync('companion/ui/companion-ui.js','utf8');assert.ok(!bundle.includes('companionUI'));});
test('corporate n8n accepts a key, checks access and opens snapshot without local controls',async()=>{
 let configured=false;
 const workflow={id:'flow1',name:'Corporate workflow',nodes:[{name:'Start',type:'manual',position:[0,0]}],connections:{}};
 const handlers={
  corporateStatus:()=>({baseUrl:'https://n8n.t-tech.team',hasApiKey:configured,stale:true}),
  corporateWorkflows:()=>({data:configured?[workflow]:[]}),
  corporateConfigure:()=>{configured=true;return {};},
  corporateCheck:()=>({connected:true}),
  corporateWorkflow:()=>workflow,
 };
 const {dom,d,calls,nav,click,input}=setup(handlers);
 try {
  await nav('n8n');
  assert.equal(d.querySelector('#start-n8n'),null);
  assert.equal(d.querySelector('#corporate-check').disabled,true);
  click('#corporate-settings');
  await until(()=>d.querySelector('#field-apiKey'));
  assert.equal(d.querySelector('#field-apiKey').type,'password');
  input('#field-apiKey','fixture-key');
  click('#workspace-editor button[type=submit]');
  await until(()=>d.querySelector('#corporate-check')&&!d.querySelector('#corporate-check').disabled);
  assert.equal(calls.find(c=>c.mode==='corporateConfigure').input.apiKey,'fixture-key');
  click('#corporate-check');
  await until(()=>calls.some(c=>c.mode==='corporateCheck'));
  await until(()=>d.querySelector('#detail').open);
  click('#close-detail');
  click('[data-corporate-flow]');
  await until(()=>d.querySelector('#graph'));
  assert.equal(d.querySelector('#save-workflow'),null);
 } finally {dom.window.close()}
});
test('React single skill comparison installs exactly the selected entry and keeps replacement hash',async()=>{const handlers={skills:()=>[],skillCompare:()=>({entries:[{id:'one',name:'My skill',package:'Companion',status:'missing',installedHash:null},{id:'changed',name:'Changed',package:'Companion',status:'different',installedHash:'local-hash'}]}),skillInstall:()=>({installed:true})};const {dom,d,calls,nav,click}=setup(handlers);try{await nav('skills');click('#compare-skills');await until(()=>d.querySelector('[data-install-single=one]'));click('[data-install-single=one]');await until(()=>calls.some(c=>c.mode==='skillInstall'));assert.equal(calls.find(c=>c.mode==='skillInstall').input.id,'one');await wait();click('[data-install-single=changed]');await until(()=>calls.filter(c=>c.mode==='skillInstall').length===2);assert.equal(calls.filter(c=>c.mode==='skillInstall')[1].input.expectedHash,'local-hash');assert.equal(calls.filter(c=>c.mode==='skillInstall')[1].input.replace,true);}finally{dom.window.close()}});
