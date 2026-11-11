import { preferredNessyProfile } from './nessy-discovery.mjs';
import {writeSandboxPolicy} from './write-sandbox.mjs';
import {homedir,tmpdir} from 'node:os';
import { spawn,spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { companionPaths,json } from './paths.mjs';
import { findNessy } from './nessy-command.mjs';
const paths=companionPaths(process.env.ODYSSEUS_ROOT),args=process.argv.slice(2);
let cwd=join(paths.home,'workspace'),profile=preferredNessyProfile(paths);
while(['--project','--profile'].includes(args[0])){const flag=args[0],value=resolve(args[1]||'');if(flag==='--project')cwd=value;else{const allowed=[paths.profile,...(json(join(paths.home,'attached-profiles.json')).profiles||[]).map(p=>p.path)];if(!allowed.includes(value))throw Error('Профиль не подключён к Companion');profile=value;}args.splice(0,2);}
mkdirSync(cwd,{recursive:true});
const installed = findNessy(process.env);
if (!installed) throw Error('Команда nessy не найдена. Установите Nessy отдельно и проверьте nessy --version в Терминале.');
const env = { ...process.env, ODYSSEUS_ROOT: paths.root, ODYSSEUS_COMPANION_HOME: paths.home,
  ODYSSEUS_DATA_DIR: paths.data, PATH: installed.path };
if (profile !== paths.profile) env.NESSY_HOME = profile;
if (env.NESSY_HOME === paths.profile) delete env.NESSY_HOME;
if (env.NESSY_RUNTIME_DIR === paths.profile) delete env.NESSY_RUNTIME_DIR;
delete env.ELECTRON_RUN_AS_NODE;
let command = installed.command, commandArgs = args;
if(env.COMPANION_ENFORCE_WRITE_SANDBOX==='1'){
 const slug=args.find(a=>a.startsWith('--worktree='))?.slice('--worktree='.length);
 if(process.platform!=='darwin'||!existsSync('/usr/bin/sandbox-exec')||!slug)throw Error('Ограничение записи недоступно; запуск остановлен.');
 const git=option=>{const result=spawnSync('/usr/bin/git',['-C',cwd,'rev-parse',option],{encoding:'utf8',timeout:10000});if(result.status!==0)throw Error('Нужен рабочий Git-репозиторий для защищённого запуска');return result.stdout.trim();};
 const repoRoot=git('--show-toplevel'),gitCommon=resolve(cwd,git('--git-common-dir'));
 const policy=writeSandboxPolicy({repoRoot,gitCommon,worktreeSlug:slug,companionHome:paths.home,tempRoot:tmpdir(),cacheRoots:[join(homedir(),'.cache'),join(homedir(),'.npm'),join(homedir(),'.gradle'),join(homedir(),'.m2'),join(homedir(),'Library/Caches')]});
 commandArgs=['-p',policy,command,...commandArgs];command='/usr/bin/sandbox-exec';delete env.COMPANION_ENFORCE_WRITE_SANDBOX;
 console.error('Companion: запись ограничена worktree, Git metadata, данными Companion, временной папкой и стандартными кешами.');
}
const child=spawn(command,commandArgs,{cwd,env,stdio:'inherit'});
child.once('error',error=>{console.error(error.message);process.exitCode=1});child.once('exit',code=>{process.exitCode=code??1});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));

// A forked background launch belongs to its parent service; orphaned runs stop.
if(process.send)process.on('disconnect',()=>{try{process.kill(-process.pid,'SIGTERM');}catch{child.kill('SIGTERM');}setTimeout(()=>{try{process.kill(-process.pid,'SIGKILL');}catch{}},2000).unref();});
