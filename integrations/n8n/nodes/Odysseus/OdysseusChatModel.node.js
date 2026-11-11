'use strict';
const { createRequire } = require('node:module');
const { join } = require('node:path');
class OdysseusChatModel {
  constructor() {
    this.description = {
      displayName: 'Odysseus — llm-proxy', name: 'odysseusChatModel', group: ['transform'], version: 1,
      description: 'Модель для AI Agent и цепочек n8n через подключение Odysseus', defaults: { name: 'Odysseus llm-proxy' },
      inputs: [], outputs: ['ai_languageModel'], outputNames: ['Model'],
      properties: [{ displayName: 'ID подключения (необязательно)', name: 'connectionId', type: 'string', default: '', description: 'Пусто — модель агента по умолчанию. ID указан в Odysseus → Подключения.' }, { displayName: 'Модель и API-ключ задаются в Odysseus → Подключения. Они не сохраняются в JSON процесса.', name: 'notice', type: 'notice', default: '' }],
    };
  }
  async supplyData() {
    const base = process.env.ODYSSEUS_KNOWLEDGE_URL, token = process.env.ODYSSEUS_AUTOMATION_TOKEN;
    if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || !token || !process.env.ODYSSEUS_N8N_RUNTIME) throw Error('Запустите n8n из Odysseus');
    const req = createRequire(join(process.env.ODYSSEUS_N8N_RUNTIME, 'node_modules/@n8n/n8n-nodes-langchain/package.json'));
    const { ChatOpenAI } = req('@langchain/openai');
    const connectionId = this.getNodeParameter('connectionId', 0, '');
    return { response: new ChatOpenAI({ apiKey: token, model: connectionId ? 'odysseus:' + connectionId : 'odysseus-proxy', configuration: { baseURL: base + '/v1' }, streaming: false, maxRetries: 0, timeout: 70000 }) };
  }
}
module.exports = { OdysseusChatModel };
