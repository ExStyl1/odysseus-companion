import { existsSync, readdirSync, cpSync, readFileSync, renameSync } from 'node:fs';
import { join, relative } from 'node:path';
import { privateWrite } from '../personal/store.mjs';
import { json } from './paths.mjs';
function definitions(base){
 if(!existsSync(base))return [];
 return readdirSync(base,{withFileTypes:true}).filter(d=>d.isDirectory()).flatMap(d=>{
   const dir=join(base,d.name),name=readdirSync(dir).find(f=>f.toLowerCase()==='skill.md');return name?[join(dir,name)]:[];
 });
}
export function finalizeProfile(paths){
 const marker=join(paths.profile,'companion-resources.json');
 if(existsSync(marker)){
   const prior=json(marker);if(prior.version>=2)return prior;
   const editor=join(paths.profile,'extensions/autodoc-extensions/skills/test-editor/SKILL.md');
   if(existsSync(editor)&&!readFileSync(editor,'utf8').startsWith('---'))privateWrite(editor,'---\nname: autodoc-extensions:test-editor\ndescription: Редактура технической документации по редакционной политике AutoDoc.\n---\n\n'+readFileSync(editor,'utf8'));
   prior.version=2;privateWrite(marker,JSON.stringify(prior,null,2));return prior;
 }
 const extensions=join(paths.profile,'extensions'),promoted=[],renamed=[];
 const quality=join(extensions,'qa-testing-toolkit/.nessy/extensions/quality-gate-profiler');
 if(existsSync(quality)&&!existsSync(join(extensions,'quality-gate-toolkit'))){cpSync(quality,join(extensions,'quality-gate-toolkit'),{recursive:true});promoted.push('quality-gate-toolkit');}
 const editor=join(extensions,'autodoc-extensions/.nessy/skills/test-editor');
 if(existsSync(editor)&&!existsSync(join(extensions,'autodoc-extensions/skills/test-editor'))){cpSync(editor,join(extensions,'autodoc-extensions/skills/test-editor'),{recursive:true});promoted.push('autodoc:test-editor');}
 const chrome=join(extensions,'block-kit/.nessy-runtime/npx/node_modules/chrome-devtools-mcp/skills');
 for(const file of definitions(chrome)){
   const slug=relative(chrome,file).split('/')[0],target=join(extensions,'block-kit/skills',slug);
   if(!existsSync(target)){cpSync(join(chrome,slug),target,{recursive:true});promoted.push('block-kit:'+slug);}
 }
 // Native Desktop labels contain spaces; Nessy CLI accepts an identifier instead.
 for(const slug of ['plugin-creator','security-review']){
   const file=join(paths.profile,'skills',slug,'SKILL.md');if(!existsSync(file))continue;
   const text=readFileSync(file,'utf8');privateWrite(file,text.replace(/^name:.*$/m,'name: '+slug));
 }
 for(const ext of readdirSync(extensions,{withFileTypes:true}).filter(d=>d.isDirectory())){
   for(let file of definitions(join(extensions,ext.name,'skills'))){
     const rel=relative(extensions,file),original=join(paths.profile,'original-extension-skills',rel);
     if(!existsSync(original))privateWrite(original,readFileSync(file));
     let text=readFileSync(file,'utf8');
     if(ext.name==='autodoc-extensions'&&file.includes('/test-editor/')&&!text.startsWith('---'))text='---\nname: test-editor\ndescription: Редактура технической документации по редакционной политике AutoDoc.\n---\n\n'+text;
     const match=text.match(/^name:\s*([^\n]+)$/m);if(!match)continue;
     const old=match[1].trim().replace(/^["']|["']$/g,''),name=ext.name+':'+old;
     const updated=text.replace(/^name:.*$/m,'name: '+JSON.stringify(name)).replace(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/,'$1\nЛокальное имя: `'+name+'`. Для других навыков этого пакета используй префикс `'+ext.name+':` (например, `'+ext.name+':имя-навыка`).\n\n');
     if(!file.endsWith('/SKILL.md')){const temp=file+'.case';renameSync(file,temp);file=join(file,'..','SKILL.md');renameSync(temp,file);}
     privateWrite(file,updated);renamed.push({from:old,to:name});
   }
 }
 const result={version:2,promoted,renamed};privateWrite(marker,JSON.stringify(result,null,2));return result;
}
