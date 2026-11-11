import {fingerprint} from './workspace-store.mjs';
export function regressionReport(input){
 const tests=Array.isArray(input)?input:input?.tests;
 if(!Array.isArray(tests)||!tests.length||tests.length>10000)throw Error('Нужен JSON-массив Allure result или объект tests (1–10000 тестов).');
 const seen=new Set(),counts={passed:0,failed:0,broken:0,skipped:0,unknown:0},groups=new Map();let duplicates=0;
 for(const t of tests){if(!t||typeof t!=='object'||typeof t.name!=='string')throw Error('У каждого теста нужны name и status.');
  const id=t.uuid||t.uid||t.id||fingerprint(t);if(seen.has(id)){duplicates++;continue;}seen.add(id);
  const status=String(t.status||'unknown').toLowerCase();counts[Object.hasOwn(counts,status)?status:'unknown']++;
  if(!['failed','broken'].includes(status))continue;
  const message=String(t.statusDetails?.message||t.message||'Причина в отчёте не указана').slice(0,4000);
  const key=status+':'+message.replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi,'[id]').replace(/\b\d+\b/g,'[число]').trim();
  if(!groups.has(key))groups.set(key,{status,message,tests:[]});groups.get(key).tests.push({id:String(id),name:t.name.slice(0,500)});
 }
 return {total:seen.size,duplicates,counts,groups:[...groups.values()],method:'Группировка по статусу и нормализованному сообщению. Не является установлением причины сбоя.',coverage:'Только импортированные записи; полнота прогона и связь с логами не подтверждены.'};
}
