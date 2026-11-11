'use strict';
/** Bundled local node: endpoint and capability token stay in the service environment, never workflow JSON. */
class Odysseus {
  constructor() {
    this.description = {
      displayName: 'Odysseus — база знаний', name: 'odysseus', group: ['transform'], version: 1,
      description: 'RAG, Graphify, llm-proxy и внешние API Odysseus', defaults: { name: 'Odysseus' },
      inputs: ['main'], outputs: ['main'],
      properties: [
        { displayName: 'Действие', name: 'operation', type: 'options', default: 'search', options: [
          { name: 'Поиск в базе знаний', value: 'search' }, { name: 'Ответ через llm-proxy', value: 'answer' },
          { name: 'Обновить индекс', value: 'index' }, { name: 'Сохранить результат', value: 'save' },
          { name: 'Прочитать граф', value: 'graph' }, { name: 'Поиск через внешний API', value: 'externalSearch' },
        ] },
        { displayName: 'ID подключения модели для ответа (необязательно)', name: 'connectionId', type: 'string', default: '' },
        { displayName: 'Каталог знаний', name: 'collection', type: 'string', default: 'projects' },
        { displayName: 'ID проекта (необязательно)', name: 'project', type: 'string', default: '' },
        { displayName: 'Вопрос / поисковый запрос', name: 'query', type: 'string', default: '', typeOptions: { rows: 3 } },
        { displayName: 'Заголовок результата', name: 'title', type: 'string', default: '' },
        { displayName: 'Текст результата', name: 'text', type: 'string', default: '', typeOptions: { rows: 5 } },
        { displayName: 'ID внешнего API-источника', name: 'source', type: 'string', default: '' },
      ],
    };
  }
  async execute() {
    const items = this.getInputData(), output = [];
    const base = process.env.ODYSSEUS_KNOWLEDGE_URL, token = process.env.ODYSSEUS_AUTOMATION_TOKEN;
    if (!base || !token || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw Error('Запустите n8n из Odysseus');
    for (let i = 0; i < items.length; i++) {
      const operation = this.getNodeParameter('operation', i);
      if (!['search', 'answer', 'index', 'save', 'graph', 'externalSearch'].includes(operation)) throw Error('Unknown operation');
      const body = {};
      for (const name of ['collection', 'project', 'query', 'title', 'text', 'source', 'connectionId']) { const value = this.getNodeParameter(name, i, ''); if (value) body[name] = value; }
      const response = await fetch(base + '/knowledge/' + operation, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(180000) });
      const data = await response.json(); if (!response.ok) throw Error(data.error || 'Odysseus API error');
      output.push({ json: data, pairedItem: { item: i } });
    }
    return [output];
  }
}
module.exports = { Odysseus };
