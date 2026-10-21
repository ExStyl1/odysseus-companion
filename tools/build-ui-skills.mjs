import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {skillCopy} from './skill-copy.mjs';
export const roleIds=['general','qa','dev','sa'];
const roleOverrides={
 graphify:['general','dev','sa'],
 review:['qa','dev'],'review-bugbot':['qa','dev'],simplify:['dev'],revdiff:['qa','dev'],
 'split-to-prs':['dev'],'migrate-to-skills':['general','dev'],
 'tech-docs':['dev','sa'],'tech-doc-editor':['dev','sa'],'ai-doc-generator':['general','dev','sa'],
 jira:['general','qa','dev','sa'],'dp-sage':['qa','dev','sa'],'three-amigo':['qa','sa'],
 'api-design':['dev','sa'],'codebase-design':['dev','sa'],
}
export function rolesFor(entry){
 if(roleOverrides[entry.name])return roleOverrides[entry.name];
 const name=entry.name,roles=new Set();
 if(/test|(^|-)qa($|-)|coverage|allure|tperf|playwright|three-amigo/.test(name))roles.add('qa');
 if(/spec-|domain-model|analytics|data-scien|sql|bpmn|camunda|mermaid|diagram|requirements|analyst|whiteboard|roadmap|confluence|wixie|search-all/.test(name))roles.add('sa');
 if(entry.category==='engineering'||/code|repo|git|develop|debug|refactor|frontend|backend|react|vue|typescript|python|java|kotlin|rust|golang|docker|kuber|architect|api-design|sdk|security|shell|hook|rule|subagent|origin|autopilot|workflow|plan|framer|gsap|threejs|web-artifacts|tailwind|vercel/.test(name))roles.add('dev');
 if(/verification|systematic-debugging|review-security|security-review|spec-review/.test(name))roles.add('qa');
 if(/clarify|brainstorm|doc-coauthor|pdf$|docx$|xlsx$|pptx$|browser$|research$|humanizer|obsidian|handoff|canvas$|automate$|loop$|onboard$|rename-chat|skill-creator|create-skill|plugin-creator|goal$|share$/.test(name)||!roles.size)roles.add('general');
 return roleIds.filter(role=>roles.has(role));
}
export function buildUiSkills(root){
 const config=JSON.parse(readFileSync(join(root,'odysseus.json'))),catalog=JSON.parse(readFileSync(join(root,'shared/skills-catalog.json'))),native=JSON.parse(readFileSync(join(root,'shared/ui/native-skills-ru.json')));
 const entries=new Map(catalog.entries.map(entry=>[entry.name,{...entry,roles:rolesFor(entry),bundled:true}]));
 for(const [name,description]of Object.entries(native))if(!entries.has(name)){
  const entry={name,description,category:'native',categoryTitle:'Навыки агента',when:'Когда задача соответствует назначению навыка и требуется помощь агента.',how:'Откройте чат с навыком, опишите ожидаемый результат и приложите исходные данные.',dependencies:'Доступность зависит от установленных компонентов и настроек текущего агента.',automatic:false,bundled:false};
  entries.set(name,{...entry,roles:rolesFor(entry)});
 }
 for(const e of entries.values())if(!/[А-Яа-яЁё]/u.test(e.description)||!e.roles.length)throw Error(`Untranslated or unclassified skill: ${e.name}`);
 const payload={schemaVersion:1,entries:[...entries.values()].map(entry=>skillCopy(entry,JSON.parse(readFileSync(join(root,'shared/ui/skill-actions-ru.json'))))).sort((a,b)=>a.name.localeCompare(b.name,'en'))};
 const path=join(root,config.components.desktop.source,'apps/electron/src/renderer/data/odysseus-skills.json');mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(payload,null,2)+'\n');
 const template=join(root,'integrations/desktop/odysseus-skills.json');mkdirSync(dirname(template),{recursive:true});writeFileSync(template,JSON.stringify(payload,null,2)+'\n');
 return payload;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');console.log(`Russian UI catalog: ${buildUiSkills(root).entries.length} skills`)}
