import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,wait,until} from './ui-harness.mjs';
test('React appearance preserves all styles, palettes and legacy preferences across navigation',async()=>{
 let saved={design:'aurora',palette:'nord',accent:'violet',theme:'system',font:'humanist',fontScale:110,density:'compact',motion:'reduced',notes:{'2026-11-10':'Keep my note'},releaseEvents:[]};
 const {dom,w,d,nav,click,input}=setup({personal:()=>saved,personalUpdate:patch=>(saved={...saved,...patch})});try{
 await nav('appearance');assert.ok(d.querySelector('[data-react-page=appearance]'));
 for(const design of ['classic','spotlight','blueprint','aurora']){click(`button[data-design=${design}]`);await wait();assert.equal(saved.design,design);assert.equal(d.documentElement.dataset.design,design);assert.equal(saved.palette,'nord');assert.equal(saved.motion,'reduced')}
 for(const palette of [...d.querySelectorAll('[data-palette]')].map(b=>b.dataset.palette)){click(`[data-palette=${palette}]`);await wait();assert.equal(saved.palette,palette);assert.equal(saved.design,'aurora')}
 for(const [id,values] of Object.entries({theme:['light','dark','system'],font:['system','humanist'],motion:['full','system','reduced'],accent:['gold','blue','green','violet','theme'],density:['comfortable','compact'],fontScale:['90','100','110']}))for(const value of values){input('#'+id,value);await wait();assert.equal(String(saved[id]),value)}
 await nav('overview');await nav('appearance');assert.equal(d.querySelector('button[data-design=aurora]').getAttribute('aria-pressed'),'true');assert.equal(d.querySelector('#fontScale').value,'110');assert.equal(saved.notes['2026-11-10'],'Keep my note');
 assert.equal(w.companionUI,undefined,'No imperative compatibility bridge');
 }finally{dom.window.close()}
});
test('React RAG retries, keeps evidence, scopes exclusions and ignores results after navigation',async()=>{
 let failure=true,release,launches=[];const evidence={title:'Contract',text:'Verified evidence',source:'/docs/contract.md',nodeId:'contract',score:1};
 const {dom,w,d,calls,nav,click,input}=setup({catalogs:()=>({collections:[{id:'work',name:'Работа'}],projects:[{id:'p1',name:'Проект',collection:'work'}]}),rag:()=>[],search:()=>{if(failure)throw Error('Index unavailable');return new Promise(r=>release=r)},answer:()=>({answer:'Supported answer',retrieval:{matches:[evidence],mode:'text',auditId:'this-search'}}),sourceExclusion:()=>({})},{runScenario:async i=>{launches.push(i);return {opened:true}}});try{
 await nav('rag');input('#project','p1');await wait();click('#rag-search');await wait();assert.equal(calls.filter(c=>c.mode==='search').length,0);
 input('#rag-query','contract');click('#rag-search');await wait();assert.match(d.querySelector('#rag-result').textContent,/Index unavailable/);assert.equal(d.querySelector('#rag-search').disabled,false);
 click('#rag-answer');await wait();assert.match(d.querySelector('#rag-result').textContent,/Supported answer/);assert.match(d.querySelector('#rag-result').textContent,/Verified evidence/);click('[data-exclude-result]');await wait();assert.deepEqual(JSON.parse(JSON.stringify(calls.find(c=>c.mode==='sourceExclusion'))),{mode:'sourceExclusion',input:{action:'add',source:'/docs/contract.md',nodeId:'contract',collection:'work',project:'p1'}});
 click('#knowledge-nessy-rag');await wait();input('#field-description','Найди контракт');d.querySelector('#workspace-editor').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>launches.length===1);assert.equal(launches[0].builder,'knowledge');assert.equal(launches[0].project,'p1');
 failure=false;click('#rag-search');click('#rag-search');await wait();assert.equal(calls.filter(c=>c.mode==='search').length,2);await nav('appearance');release({matches:[evidence],mode:'text'});await wait();assert.ok(d.querySelector('[data-react-page=appearance]'));assert.equal(d.querySelector('#rag-result'),null);
 }finally{dom.window.close()}
});
