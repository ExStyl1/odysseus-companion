import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
const require=createRequire(new URL('../../nessy-cli-master/package.json',import.meta.url));
const {JSDOM}=require('jsdom');
export const wait=()=>new Promise(r=>setTimeout(r,15));
export async function until(fn,message='UI did not settle'){for(let i=0;i<180;i++){if(fn())return;await wait()}throw Error(message)}
export function setup(handlers={},native={}){
 const dom=new JSDOM(readFileSync(new URL('../../companion/index.html',import.meta.url),'utf8'),{runScripts:'outside-only',pretendToBeVisual:true,url:'file:///companion/index.html'}),w=dom.window,d=w.document,calls=[];
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'))};w.HTMLElement.prototype.scrollIntoView=function(){};w.crypto.randomUUID=randomUUID;w.structuredClone=structuredClone;w.confirm=()=>true;
 const base={catalogs:()=>({collections:[{id:'work',name:'Работа'}],projects:[]}),personal:()=>({theme:'dark',notes:{},releaseEvents:[]}),usage:()=>({days:[],sessions:[],observer:{enabled:true,captured:0}}),toolIcons:()=>({directory:'/icons',tools:[]})};
 w.companion={call:async(mode,input)=>{calls.push({mode,input});const handler=handlers[mode]||base[mode];if(!handler)throw Error('Unexpected '+mode);return handler(input)},chooseFolder:async()=>null,...native};
 w.eval(readFileSync(new URL('../../companion/themes.js',import.meta.url),'utf8'));w.eval(readFileSync(new URL('../../companion/ui/companion-ui.js',import.meta.url),'utf8'));
 const click=selector=>{const e=d.querySelector(selector);if(!e)throw Error('Missing '+selector);e.click()};
 const nav=async(page,tab)=>{await until(()=>d.querySelector(`[data-page=${page}]`));click(`[data-page=${page}]`);await wait();if(tab){click(`[data-view=${tab}]`);await wait()}await until(()=>!d.querySelector('.knowledge-loading')&&!d.querySelector('[aria-busy=true]'));};
 const input=(selector,value)=>{const e=d.querySelector(selector),proto=e.tagName==='TEXTAREA'?w.HTMLTextAreaElement.prototype:e.tagName==='SELECT'?w.HTMLSelectElement.prototype:w.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value);e.dispatchEvent(new w.Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));};
 return {dom,w,d,calls,click,nav,input};
}
