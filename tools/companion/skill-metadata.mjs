import { join } from 'node:path';
import { json } from './paths.mjs';
const roleNames={general:'Общие',qa:'QA',sa:'SA',dev:'Dev'};
const areas={
'b2b-qa':'интеграционные тесты Zoya и процессы Camunda','jump-qa':'интеграционные тесты Zoya','qa-testing-toolkit':'подготовка, генерация и поддержка тестов','quality-gate-toolkit':'проверки качества, покрытия и линтеров','block-kit':'разработка микрофронтендов, ReFormer и TUI','n8n':'схемы и узлы корпоративного n8n','devplatform-skills':'DevPlatform и процессы GitLab CI/CD','eda-metrics-suite':'анализ данных DWH/DLH и проектирование метрик','metric-tree-architect':'дерево бизнес-метрик','autodoc-extensions':'техническая документация и её проверка','shopping-ai-skills':'инженерные и продуктовые процессы Travel/Hotels','procedure-analysis':'анализ процедур и журналов','superpowers':'этапы разработки, проверки и ревью','jira-auth':'авторизация Jira','wiki':'документы Wiki','agent-cloud-skills':'изолированная среда MLCore','skill-creator':'создание навыков и субагентов','promt-builder':'построение и уточнение промптов','skills':'классификация задач','dp-skills-market':'разработка, тесты и настройка MCP','odysseus-companion':'локальные знания и команда субагентов Nessy'};
const actions=[[/review|quality-gate|validat/,'Проверка'],[/debug|troubleshoot|bug|leak/,'Диагностика'],[/setup|init|install|config/,'Настройка'],[/write|create|generat|build|implementation/,'Создание'],[/run|execut/,'Выполнение'],[/analys|metric|scor|discover/,'Анализ'],[/read|search|context|guide/,'Поиск и изучение'],[/format|optimi|migrat|edit/,'Доработка']];
const cache=new Map(),purposesCache=new Map();
export function skillMetadata(paths,s) {
 const base=s.name.split(':').at(-1);const catalog=cache.get(paths.root)||json(join(paths.root,'companion/catalog-ru.json')).entries||json(join(paths.root,'shared/skills-catalog.json')).entries||[];cache.set(paths.root,catalog);
 const purposes=purposesCache.get(paths.root)||json(join(paths.root,'companion/skill-purposes-ru.json'));purposesCache.set(paths.root,purposes);
 const purpose=purposes[base];
 const meta=catalog.find(e=>e.name===base||(e.aliases||[]).includes(base));
 const inferred=/qa|test|allure|quality-gate/.test(s.package+' '+base)?['QA']:/architect|spec|prd|metric|analysis|proc-to|brainstorm|planning/.test(base)?['SA']:/block|devplatform|superpowers|code|develop|git|program/.test(s.package+' '+base)?['Dev']:['Общие'];
 const roles=meta?.roles?.map(r=>roleNames[r]).filter(Boolean)||inferred;
 const area=areas[s.package]||'инструменты '+s.package,action=actions.find(([re])=>re.test(base))?.[1]||'Работа';
 return {roles:roles.length?roles:['Общие'],descriptionRu:meta?.description||purpose||action+': '+area+'. Специализация — '+base+'.',
  when:meta?.when||(purpose?'Когда требуется: '+purpose.charAt(0).toLowerCase()+purpose.slice(1)+' Входные данные и область работы определяются текущим запросом.':null)||'Когда задача относится к области «'+area+'» и сценарию '+base+'. Навык подбирается по смыслу запроса.',
  how:meta?.how||'Прочитать инструкцию '+s.name+', определить нужный сценарий и входные артефакты, выполнить этапы руководства. Проверить результат реальной командой или источником; сообщить об ограничениях и недоступных зависимостях.',
  dependencies:meta?.dependencies||(s.package==='odysseus-companion'?'Локальная платформа Companion; для делегирования — штатный Agent/Task Nessy.':s.package==='superpowers'?'Локальный репозиторий и штатные инструменты Nessy.':'Указанные в руководстве локальные файлы и инструменты. Корпоративные CLI/MCP требуют установленного клиента, доступа в сеть и авторизации; Companion не предоставляет эти права.'),
  example:meta?.requestExample||meta?.example||'Примени '+s.name+' к текущей задаче: укажи входные файлы, ожидаемый результат и критерии проверки.'};
}
