import {existsSync,realpathSync} from 'node:fs';import {resolve,dirname,relative,isAbsolute,join,basename} from 'node:path';
import {noLinks} from '../personal/store.mjs';
function canonical(path){if(typeof path!=='string'||!isAbsolute(path)||/[\0\r\n]/.test(path))throw Error('Недопустимый путь ограничения записи');let parent=path;while(!existsSync(parent)){const next=dirname(parent);if(next===parent)throw Error('Корень пути не найден');parent=next;}return resolve(realpathSync(parent),relative(parent,path));}
const inside=(root,p)=>{const r=relative(root,p);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('../'));};
export function writeSandboxPolicy({repoRoot,worktreeSlug,gitCommon,companionHome,tempRoot,cacheRoots=[]}){
 if(!/^[a-z0-9-]{1,100}$/.test(worktreeSlug||''))throw Error('Недопустимое имя worktree');
 const root=canonical(repoRoot),git=canonical(gitCommon),home=canonical(companionHome),tmp=canonical(tempRoot);
 if(root==='/'||home==='/'||!['.git'].includes(basename(git)))throw Error('Неподдерживаемый корень проекта или Git metadata');
 if(tmp!=='/private/tmp'&&!tmp.includes('/T/')&&!tmp.endsWith('/T'))throw Error('Неподдерживаемая временная папка');
 if(inside(tmp,root)||inside(home,root))throw Error('Проект пересекается с разрешённой папкой данных или общей временной папкой');
 const trees=join(root,'.nessy/worktrees'),target=canonical(join(trees,worktreeSlug));if(!inside(root,target))throw Error('Worktree выходит за корень проекта через ссылку');
 const cache=[];for(const path of cacheRoots){try{noLinks(path);const p=canonical(path);if(p!=='/'&&!inside(p,root))cache.push(p);}catch{}}
 const agentPattern='/[.]nessy/worktrees/agent-'+('[0-9a-f]'.repeat(7));
 const agentScope=pattern=>'(require-all (subpath '+JSON.stringify(trees)+') (regex #'+JSON.stringify(pattern)+'))';
 const subpaths=[target,git,home,tmp,...cache];
 return '(version 1)\n(deny default)\n(allow file-read*)\n(allow process-exec)\n(allow process-fork)\n(allow process-info*)\n(allow signal)\n(allow sysctl-read)\n(allow mach-lookup)\n(allow file-ioctl)\n(allow network*)\n(allow file-write*\n'+subpaths.map(p=>' (subpath '+JSON.stringify(p)+')').join('\n')+'\n'+[join(root,'.nessy'),trees,'/dev/stdout','/dev/stderr','/dev/null','/dev/tty'].map(p=>' (literal '+JSON.stringify(p)+')').join('\n')+'\n '+agentScope(agentPattern+'$')+'\n '+agentScope(agentPattern+'/.*')+'\n (regex #"^/dev/tty.*")\n)\n';
}
