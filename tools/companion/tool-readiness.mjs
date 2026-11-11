// Protocol discovery never proves access to a project's business resources.
export function probeFailure(error) {
 const code=error?.code||error?.cause?.code;
 const status=Number(error?.status||error?.statusCode||error?.response?.status);
 if(status===401)return {reason:'authentication',hint:'Обновите авторизацию в корпоративном клиенте и повторите проверку.'};
 if(status===403)return {reason:'access',hint:'Проверьте права учётной записи у владельца сервиса. Авторизация сама по себе не предоставляет доступ.'};
 if(['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','ECONNRESET'].includes(code))return {reason:'network',hint:'Проверьте корпоративную сеть, VPN и доступность сервера, затем повторите проверку.'};
 if(['CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code))return {reason:'certificate',hint:'Проверьте корпоративные сертификаты. Обратитесь к поддержке, сохраняя проверку TLS включённой.'};
 if(code==='ENOENT')return {reason:'client',hint:'Установите клиент или исправьте путь к исполняемому файлу в конфигурации MCP.'};
 if(code==='EACCES')return {reason:'local-permission',hint:'Проверьте право запуска локального клиента и доступ к его файлам.'};
 if(['ETIMEDOUT','TIMEOUT'].includes(code))return {reason:'timeout',hint:'Сервер не завершил проверку вовремя. Проверьте клиент и сеть; таймаут не доказывает отсутствие доступа.'};
 return {reason:'protocol',hint:'Проверьте совместимость клиента с MCP и его конфигурацию. Причина требует уточнения; запустите проверку повторно после исправления.'};
}
export function readiness(server){
 const check=server.check;
 const failure=!server.enabled?{reason:'disabled',hint:'Включите MCP для выбранного профиля.'}:server.status==='missing'?{reason:'client',hint:'Установите клиент или исправьте команду запуска в конфигурации.'}:check?.status==='failed'?{reason:check.reason||'protocol',hint:check.hint||'Повторите проверку после проверки конфигурации клиента.'}:null;
 return {
  reason:failure?.reason||(check?.status==='ready'?'connected':'unverified'),hint:failure?.hint||check?.resourceCheck?.hint||(check?.resourceCheck?.status==='ready'?'Выбранный ресурс прочитан. Проверка не подтверждает права на остальные данные.':check?.status==='ready'?'Протокол MCP отвечает. Затем проверьте чтение конкретного разрешённого ресурса в рабочем сценарии.':'Нажмите «Проверить MCP». Проверка не вызывает прикладные инструменты.'),
  steps:[
   {id:'configuration',title:'Конфигурация',status:'passed'},
   {id:'enabled',title:'Включён в профиле',status:server.enabled?'passed':'blocked'},
   {id:'client',title:server.transport==='stdio'?'Локальный клиент':'Удалённый транспорт',status:server.transport==='stdio'?(server.resolvedCommand?'passed':'blocked'):'not-required'},
   {id:'protocol',title:'Соединение и каталог инструментов',status:check?.status==='ready'?'passed':check?.status==='failed'?'failed':'unchecked'},
   {id:'resource',title:'Чтение ресурса проекта',status:check?.resourceCheck?.status==='ready'?'passed':check?.resourceCheck?.status==='failed'?'failed':'unchecked'}
  ],resourceVerified:check?.resourceCheck?.status==='ready'
 };
}
