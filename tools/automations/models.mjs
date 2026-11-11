/** API protocol adapters. Selection is by owner-configured connection ID, never a request URL/token. */
import { loadAutomationConfig, selectedConnection } from './config.mjs';
export function authorization(connection, token) {
  if (!token || connection.auth === 'none') return {};
  const mode = connection.auth || (connection.bearer === false ? 'header' : 'bearer');
  return { [connection.header || 'Authorization']: (mode === 'bearer' ? 'Bearer ' : mode === 'basic' ? 'Basic ' : '') + token };
}
async function jsonResponse(response) {
  if (!response.ok) { const error = Error('API модели: HTTP ' + response.status); error.status = response.status; error.retryAfter = response.headers.get('retry-after'); await response.body?.cancel(); throw error; }
  const reader = response.body.getReader(), chunks = []; let total = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; total += value.length; if (total > 2 * 1024 * 1024) throw Error('Ответ модели слишком большой'); chunks.push(Buffer.from(value)); } }
  finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString());
}
function anthropicBody(body) {
  const messages = [], system = [];
  for (const m of body.messages || []) {
    if (m.role === 'system' || m.role === 'developer') { system.push(String(m.content || '')); continue; }
    let content = typeof m.content === 'string' ? [{ type: 'text', text: m.content || ' ' }] : (m.content || []).map(c => { if (c.type !== 'text') throw Error('Для Anthropic здесь поддерживается текст и инструменты'); return { type: 'text', text: c.text }; });
    if (m.role === 'tool') content = [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }];
    for (const call of m.tool_calls || []) content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments || '{}') });
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
  }
  const result = { messages, max_tokens: body.max_completion_tokens || body.max_tokens || 4096, stream: false };
  if (system.length) result.system = system.join('\n');
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.tools?.length) result.tools = body.tools.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters || { type: 'object', properties: {} } }));
  if (body.tool_choice) result.tool_choice = typeof body.tool_choice === 'object' ? { type: 'tool', name: body.tool_choice.function.name } : { type: { auto: 'auto', required: 'any', none: 'none' }[body.tool_choice] || 'auto' };
  return result;
}
export function modelClient(paths, fetchImpl = fetch) {
  async function request(kind, body, purpose = 'answer', id) {
    const { config, secrets } = loadAutomationConfig(paths), c = selectedConnection(config, kind === 'embeddings' ? 'embeddings' : purpose, id);
    let path = '/' + kind, payload = { ...body, model: c.model, ...(kind === 'chat/completions' ? { stream: false } : {}) };
    const headers = { 'Content-Type': 'application/json', ...authorization(c, secrets['connection:' + c.id]) };
    if (c.protocol === 'anthropic') { path = '/messages'; payload = { ...anthropicBody(body), model: c.model }; headers['anthropic-version'] = '2023-06-01'; }
    if (c.protocol === 'ollama') {
      path = kind === 'embeddings' ? '/api/embed' : '/api/chat';
      payload = kind === 'embeddings' ? { model: c.model, input: body.input } : { ...body, model: c.model, stream: false, messages: (body.messages || []).map(m => ({ ...m, tool_calls: m.tool_calls?.map(t => ({ ...t, function: { ...t.function, arguments: typeof t.function.arguments === 'string' ? JSON.parse(t.function.arguments) : t.function.arguments } })) })) };
    }
    const result = await jsonResponse(await fetchImpl(c.baseUrl + path, { method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(70000) }));
    if (kind === 'embeddings' && c.protocol === 'ollama') return { data: result.embeddings?.map((embedding, index) => ({ embedding, index })) };
    if (c.protocol === 'anthropic') return { id: result.id, object: 'chat.completion', model: c.model, choices: [{ index: 0, finish_reason: result.stop_reason === 'tool_use' ? 'tool_calls' : 'stop', message: { role: 'assistant', content: (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'), ...(result.content?.some(c => c.type === 'tool_use') ? { tool_calls: result.content.filter(c => c.type === 'tool_use').map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.input) } })) } : {}) } }], usage: { prompt_tokens: result.usage?.input_tokens || 0, completion_tokens: result.usage?.output_tokens || 0, total_tokens: (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0) } };
    if (c.protocol === 'ollama' && kind !== 'embeddings') return { id: 'ollama-' + Date.now(), object: 'chat.completion', model: c.model, choices: [{ index: 0, finish_reason: result.message?.tool_calls?.length ? 'tool_calls' : 'stop', message: { ...result.message, tool_calls: result.message?.tool_calls?.map((t, i) => ({ ...t, id: t.id || 'call_' + i, type: 'function', function: { ...t.function, arguments: JSON.stringify(t.function.arguments || {}) } })) } }], usage: { prompt_tokens: result.prompt_eval_count || 0, completion_tokens: result.eval_count || 0, total_tokens: (result.prompt_eval_count || 0) + (result.eval_count || 0) } };
    return result;
  }
  async function models(id) {
    const { config, secrets } = loadAutomationConfig(paths), c = config.connections.find(c => c.id === id); if (!c) throw Error('Сначала сохраните подключение');
    const headers = { ...authorization(c, secrets['connection:' + c.id]), ...(c.protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}) };
    const result = await jsonResponse(await fetchImpl(c.baseUrl + (c.protocol === 'ollama' ? '/api/tags' : '/models'), { headers, redirect: 'error', signal: AbortSignal.timeout(30000) }));
    return { models: (c.protocol === 'ollama' ? result.models?.map(m => m.name) : result.data?.map(m => m.id)) || [] };
  }
  const embed = async input => {
    const result = await request('embeddings', { input });
    const vectors = result.data?.sort((a, b) => a.index - b.index).map(x => x.embedding);
    if (!Array.isArray(vectors) || vectors.length !== input.length || vectors.some(v => !Array.isArray(v) || !v.length || v.length > 8192 || v.some(x => !Number.isFinite(x)))) throw Error('Некорректный ответ embeddings');
    return vectors;
  };
  return { request, embed, models };
}
