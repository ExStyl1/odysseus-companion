import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {companionPaths} from '../../tools/companion/paths.mjs';
import {scenarios} from '../../tools/companion/scenarios.mjs';
test('ready scenario selects installed skills and enabled MCP without creating a personal task',()=>{
 const root=mkdtempSync(join(tmpdir(),'preset-')),p=companionPaths(root);
 try{
 mkdirSync(join(p.profile,'skills/jira'),{recursive:true});
 writeFileSync(join(p.profile,'skills/jira/SKILL.md'),'---\nname: jira\ndescription: Jira requirements\n---\nUse sources.');
 writeFileSync(join(p.profile,'settings.json'),JSON.stringify({mcpServers:{dpJira:{command:'node'},dpWiki:{command:'node',disabled:true},unrelated:{command:'node'}}}));
 const service=scenarios(p),launch=service.prompt({template:'requirements'});
 assert.ok(launch.skillIds.length);assert.ok(launch.allowedMcpNames.includes('dpJira'));assert.ok(!launch.allowedMcpNames.includes('unrelated'));assert.match(launch.prompt,/уточни у пользователя/);assert.equal(service.state().runs.length,0);assert.equal(launch.readOnly,true);
 assert.ok(service.prompt({template:'development'}).worktree);assert.equal(service.prompt({template:'development'}).readOnly,false);
 assert.throws(()=>service.prompt({template:'unknown'}),/не найден/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
