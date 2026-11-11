const {join}=require('node:path');
function quote(s){if(typeof s!=='string'||s.includes('\0'))throw Error('Недопустимый аргумент запуска');return "'"+s.replaceAll("'","'\\''")+"'";}
function scenarioCommand({root,node,home,cwd,standalone,prompt,worktree,readOnly=true,allowedMcpNames,skillIds}){
 if(!prompt||prompt.length>50000)throw Error('Запрос должен содержать до 50000 символов');
 if(worktree&&!/^[a-z0-9-]{1,100}$/.test(worktree))throw Error('Недопустимое имя worktree');
 if(allowedMcpNames!==undefined&&(!Array.isArray(allowedMcpNames)||allowedMcpNames.some(n=>typeof n!=='string'||!n||/[\0,\r\n]/.test(n)||n.trim()!==n)))throw Error('Недопустимое имя MCP');
 if(skillIds!==undefined&&(!Array.isArray(skillIds)||skillIds.length>30||skillIds.some(id=>typeof id!=='string'||id.length>1000)))throw Error('Недопустимый набор навыков');
 const allowed=allowedMcpNames?.length?allowedMcpNames:['__companion_no_mcp_'+require('node:crypto').randomUUID()];
 const args=['--project',cwd,'--prompt-interactive='+prompt,...(worktree?['--worktree='+worktree]:[]),...(readOnly?['--approval-mode=plan']:[]),...(allowedMcpNames!==undefined?['--allowed-mcp-server-names='+allowed.join(',')]:[])];
 return '#!/bin/zsh\nset -e\nexport ODYSSEUS_ROOT='+quote(root)+'\nexport ODYSSEUS_COMPANION_HOME='+quote(home)+'\n'+(standalone?'export ODYSSEUS_COMPANION_STANDALONE=1\n':'')+(worktree?'export COMPANION_ENFORCE_WRITE_SANDBOX=1\n':'')+(skillIds!==undefined?'export COMPANION_TASK_SKILL_IDS='+quote(JSON.stringify(skillIds))+'\n':'')+'exec '+quote(node)+' '+quote(join(root,'tools/companion/launch-nessy.mjs'))+' '+args.map(quote).join(' ')+'\n';
}
module.exports={scenarioCommand};
