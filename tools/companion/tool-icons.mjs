import {join,basename,extname} from 'node:path';
import {homedir} from 'node:os';
import {existsSync,mkdirSync,copyFileSync,readFileSync,lstatSync} from 'node:fs';
import {json} from './paths.mjs';
import {privateWrite,noLinks} from '../personal/store.mjs';
const mime={'.png':'image/png','.ico':'image/x-icon','.svg':'image/svg+xml','.jpg':'image/jpeg','.jpeg':'image/jpeg'};
export function commandTool(command,tools){
 for(const segment of String(command).split(/&&|\|\||[;|\n]/)){
  const words=segment.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g)||[];
  while(words.length&&(/^[\w]+=.*/.test(words[0])||['sudo','time','env','command','exec','nohup'].includes(words[0])||words[0].startsWith('-')))words.shift();
  const cmd=basename((words[0]||'').replace(/^["']|["']$/g,''));const tool=tools.find(t=>t.commands.includes(cmd));if(tool)return tool;
 }return null;
}
export function toolIcons(paths){
 const dir=join(paths.env.HOME||homedir(),'.nessy-agent/tool-icons'),bundled=join(paths.root,'companion/tool-icons'),file=join(dir,'tool-icons.json');
 function image(base,name){if(typeof name!=='string'||basename(name)!==name||!mime[extname(name).toLowerCase()])return null;const p=join(base,name);try{const st=lstatSync(p);if(!st.isFile()||st.isSymbolicLink()||st.size>512000)return null;return 'data:'+mime[extname(name).toLowerCase()]+';base64,'+readFileSync(p).toString('base64');}catch{return null;}}
 function seed(){noLinks(file);mkdirSync(dir,{recursive:true,mode:0o700});const defaults=json(join(bundled,'tool-icons.json'),{version:1,tools:[]});for(const t of defaults.tools)if(basename(t.icon)===t.icon&&!existsSync(join(dir,t.icon))&&existsSync(join(bundled,t.icon)))copyFileSync(join(bundled,t.icon),join(dir,t.icon));if(!existsSync(file))privateWrite(file,JSON.stringify(defaults,null,2));}
 function state({initialize=false}={}){if(initialize)seed();const base=existsSync(file)?dir:bundled;const config=json(join(base,'tool-icons.json'),{tools:[]});if(!Array.isArray(config.tools))throw Error('Некорректный каталог иконок');return {directory:dir,tools:config.tools.filter(t=>typeof t.id==='string'&&Array.isArray(t.commands)).map(t=>({...t,image:image(base,t.icon)}))};}
 function save(i){seed();if(!/^[a-z0-9][a-z0-9-]{0,70}$/.test(i.id)||typeof i.displayName!=='string'||!i.displayName.trim()||i.displayName.length>100||!Array.isArray(i.commands)||!i.commands.length||i.commands.length>30||i.commands.some(c=>typeof c!=='string'||!/^[\w.+-]{1,80}$/.test(c)))throw Error('Укажите ID, название и имена CLI-команд без аргументов');const s=state();let icon=s.tools.find(t=>t.id===i.id)?.icon;
  if(i.data){const m=String(i.data).match(/^data:(image\/(?:png|jpeg|x-icon));base64,([A-Za-z0-9+/=]+)$/);if(!m)throw Error('Загрузите PNG, JPG или ICO');const bytes=Buffer.from(m[2],'base64');if(bytes.length>512000||bytes.length<8)throw Error('Иконка должна быть меньше 500 КБ');if(!(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes[0]===255&&bytes[1]===216||bytes[0]===0&&bytes[1]===0&&bytes[2]===1&&bytes[3]===0))throw Error('Файл не является изображением');icon=i.id+'-custom.'+({'image/png':'png','image/jpeg':'jpg','image/x-icon':'ico'}[m[1]]);privateWrite(join(dir,icon),bytes);}
  if(!icon)throw Error('Выберите изображение');const commands=[...new Set(i.commands)];if(s.tools.some(t=>t.id!==i.id&&t.commands.some(c=>commands.includes(c))))throw Error('Команда уже привязана к другой иконке');const tools=s.tools.map(({image,...t})=>t).filter(t=>t.id!==i.id);tools.push({id:i.id,displayName:i.displayName.trim(),commands,icon});privateWrite(file,JSON.stringify({version:1,tools},null,2));return state();
 }
 return {state,save};
}
