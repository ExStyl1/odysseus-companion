import { join } from 'node:path';
import { json } from './paths.mjs';
import { configureAutomation } from '../automations/config.mjs';
import { existingDpToken } from '../personal/secrets.mjs';
export function importNessyModel(paths){
 const settings=json(join(paths.profile,'settings.json'));
 const gateway='https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1';
 const base=String(settings.model?.baseUrl||'').replace(/\/+$/,'');
 if(settings.security?.auth?.selectedType!=='dp-auth'||base!==gateway)throw Error('Для этого провайдера задайте подключение модели в Companion вручную');
 const token=existingDpToken({cliHome:paths.profile});
 if(!token)throw Error('В профиле нет неистёкшего DP-токена. Выполните вход в Nessy и повторите импорт.');
 const model=settings.model?.name;
 if(typeof model!=='string'||!model)throw Error('Сначала выберите модель в Nessy');
 configureAutomation(paths.automation,{connection:{id:'nessy-gateway',name:'Модель Nessy',kind:'chat',protocol:'openai',baseUrl:gateway,model,auth:'header',header:'Nestor-Token',token}});
 return configureAutomation(paths.automation,{routes:{answer:'nessy-gateway',agent:'nessy-gateway'}});
}
