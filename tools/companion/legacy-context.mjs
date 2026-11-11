import { existsSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateWrite } from '../personal/store.mjs';
export function isolateLegacyContext(paths){
 const marker=join(paths.profile,'companion-context-v1.json');if(existsSync(marker))return;
 // Preserve the prior owner's personal facts and example epic; they are not the new user's task.
 const memories=join(paths.profile,'memories'),archive=join(paths.profile,'original-memories');
 if(existsSync(memories)&&!existsSync(archive))renameSync(memories,archive);
 privateWrite(join(memories,'MEMORY.md'),'# Рабочая среда\n\nNessy использует платформу Odysseus Companion через MCP odysseus-companion. Выбирайте каталог и проект по задаче пользователя. Личная память исходной резервной копии сохранена в original-memories и не является сведениями о текущем пользователе.\n');
 const meta=join(paths.profile,'user-memory-meta.json');if(existsSync(meta))renameSync(meta,join(paths.profile,'original-user-memory-meta.json'));
 for(const name of ['nessy-analyst-agent','nessy-coordinator-agent']){
   const file=join(paths.profile,'extensions',name,'NESSY.md');if(!existsSync(file))continue;
   const original=join(paths.profile,'extensions',name,'references/original-NESSY.md');
   if(!existsSync(original))privateWrite(original,readFileSync(file));
   privateWrite(file,'# '+name+'\n\nПакет содержит справочные материалы исходной установки. Не принимайте описанный там эпик GTECH, имена людей, роли и автономные циклы за текущую задачу. Используйте материалы только по относящемуся к ним запросу пользователя. Исходный контекст сохранён в references/original-NESSY.md. Задачи выполняет Nessy в текущем проекте; платформа знаний доступна через MCP odysseus-companion.\n');
 }
 privateWrite(marker,JSON.stringify({version:1,archived:['original-memories','references/original-NESSY.md']},null,2));
}
