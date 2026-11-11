import { cpSync, mkdirSync, writeFileSync, renameSync, existsSync, rmSync, readFileSync, chmodSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { prepareRuntime } from './prepare-runtime.mjs';
import { copyMcpRuntime } from './copy-mcp-runtime.mjs';
import { copyDataTree, validateBundle } from '../distribution/bundle.mjs';
const root=resolve(import.meta.dirname,'../..');
const version=JSON.parse(readFileSync(join(root,'companion/package.json'),'utf8')).version;
console.log('Сборка React-интерфейса…');
const frontend=spawnSync('npm',['run','build','--prefix',join(root,'companion/frontend')],{stdio:'inherit'});
if(frontend.status!==0)throw Error('Не удалось собрать React-интерфейс Companion');
const output=join(root,'dist/companion');mkdirSync(output,{recursive:true});
const source=join(root,'companion/node_modules/electron/dist/Electron.app');
const target=join(output,'Odysseus Companion.app'),prepared=join(root,'.odysseus/companion-runtime/payload');
if(!existsSync(source))throw Error('Установите Electron: npm install --prefix companion');
if(!existsSync(join(prepared,'python/run')))prepareRuntime(root, prepared);
const stage=join(output,'companion-stage-'+randomUUID()+'.app');
console.log('Сборка самостоятельного приложения…');
cpSync(source,stage,{recursive:true,dereference:false,verbatimSymlinks:true});
const resources=join(stage,'Contents/Resources'),payload=join(resources,'platform');
rmSync(join(resources,'default_app.asar'),{force:true});
mkdirSync(join(resources,'app'),{recursive:true});
for(const name of readdirSync(join(root,'companion'))){
  // Ship only the compiled renderer; no development dependencies or Vite server.
  if(['frontend','node_modules','package-lock.json','companion.icns','.DS_Store'].includes(name))continue;
  copyDataTree(join(root,'companion',name),join(resources,'app',name));
}
cpSync(process.execPath,join(resources,'node'));
writeFileSync(join(resources,'app/runtime.json'),JSON.stringify({root:'../platform',node:'../node',standalone:true,...(process.argv.includes('--migrate-local')?{legacyHome:join(root,'.odysseus/companion'),previousRoot:root}:{})},null,2));
for(const name of ['tools','shared','docs'])copyDataTree(join(root,name),join(payload,name));
copyDataTree(join(root,'integrations/n8n'),join(payload,'integrations/n8n'));
for(const name of ['skills','agents','tool-icons'])copyDataTree(join(root,'companion',name),join(payload,'companion',name));
for(const name of ['catalog-ru.json','skill-purposes-ru.json','agent-presets.json','learning-guide.json'])cpSync(join(root,'companion',name),join(payload,'companion',name));
writeFileSync(join(payload,'odysseus.json'),JSON.stringify({schemaVersion:1,sharedDirectory:'shared',components:{cli:{source:'nessy-cli-master',command:['nessy']}}}));
writeFileSync(join(payload,'companion-release.json'),JSON.stringify({name:'Odysseus Companion',version,standalone:true,localN8n:false,bundledNessy:false}));
console.log('Копирование зависимостей MCP…');
copyMcpRuntime(join(root,'nessy-cli-master'),join(payload,'mcp'));
console.log('Копирование автономных Python и Graphify…');
copyDataTree(join(prepared,'python'),join(payload,'python'));
writeFileSync(join(payload,'python/run'),'#!/bin/sh\nunset PYTHONHOME PYTHONPATH\nexport PYTHONNOUSERSITE=1\nexec "$(dirname "$0")/bin/python3" -I -B "$@"\n');
chmodSync(join(payload,'python/run'),0o755);
const npmRoot=resolve(dirname(process.execPath),'../lib/node_modules/npm');
copyDataTree(npmRoot,join(payload,'npm'));rmSync(join(payload,'npm/npmrc'),{force:true});
mkdirSync(join(payload,'bin'),{recursive:true});
for(const name of ['npm','npx']){
 const file=join(payload,'bin',name);
 writeFileSync(file,'#!/bin/sh\np=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$p/../node" "$p/npm/bin/'+name+'-cli.js" "$@"\n');chmodSync(file,0o755);
}
// Reproducible initial settings. External Nessy profiles are attached on first launch.
const seed=join(payload,'seed/profile');
mkdirSync(seed,{recursive:true});
writeFileSync(join(seed,'settings.json'),JSON.stringify({permissions:{allow:[]}},null,2));
cpSync(join(root,'companion/companion.icns'),join(resources,'companion.icns'));
const plist=join(stage,'Contents/Info.plist');
for(const [key,value]of Object.entries({CFBundleIdentifier:'app.odysseus.companion',CFBundleName:'Odysseus Companion',CFBundleDisplayName:'Odysseus Companion',CFBundleShortVersionString:version,CFBundleVersion:'44',CFBundleIconFile:'companion.icns'})){
 const r=spawnSync('/usr/bin/plutil',['-replace',key,'-string',value,plist],{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);
}
console.log('Проверка автономных движков…');
for(const [command,args]of [[join(payload,'python/run'),['-c','import graphify,mcp,ssl,sqlite3; print("Python/Graphify OK")']]]){
 const r=spawnSync(command,args,{encoding:'utf8',timeout:90000,env:{HOME:process.env.HOME,PATH:join(resources,'..')+':/usr/bin:/bin',TMPDIR:process.env.TMPDIR||'/tmp'}});if(r.status!==0)throw Error(r.stderr||r.error?.message||'Runtime check failed');console.log(r.stdout.trim());
}
console.log('Локальная подпись приложения…');
const sign=spawnSync('/usr/bin/codesign',['--force','--deep','--sign','-',stage],{encoding:'utf8'});if(sign.status!==0)throw Error(sign.stderr);
const verify=spawnSync('/usr/bin/codesign',['--verify','--deep','--strict',stage],{encoding:'utf8'});if(verify.status!==0)throw Error(verify.stderr);
validateBundle(stage);
if(existsSync(target)){const oldVersion=JSON.parse(readFileSync(join(target,'Contents/Resources/app/package.json'))).version.replace(/[^a-zA-Z0-9.-]/g,'');const releases=join(output,'releases');mkdirSync(releases,{recursive:true});renameSync(target,join(releases,'Odysseus Companion-'+oldVersion+'-'+Date.now()+'.app'));}
renameSync(stage,target);console.log(target);
