#!/usr/bin/env node
/**
 * Mock OpenAI-compatible chat completions server simulating the lifecycle of
 * a model: it works for a while, then the backend takes it out of service
 * ("no longer supported" deprecation error).
 *
 * Deprecation is triggered deterministically by content (not by a fragile
 * call counter — the CLI may issue more than one request per user message):
 * as soon as the conversation history contains the marker word "третий"
 * (the third user message in the scenario), `mock-model-a` starts answering
 * HTTP 404 "no longer supported". Every other model (e.g. `mock-model-b`
 * chosen in the /model dialog) always succeeds.
 *
 * Used with the `model-deprecation.ts` terminal-capture scenario to screenshot
 * the full UX: successful work → deprecation error → model dialog → successful
 * continuation on another model.
 *
 * Based on the zero-dependency template at
 * .nessy/skills/e2e-testing/scripts/mock-openai-server.js — only the
 * `handleRequest()` body is specialized; protocol plumbing is below the fold.
 *
 * Run:
 *   PORT=4122 LOG_FILE=/tmp/model-deprecation-mock.log \
 *     node integration-tests/terminal-capture/scenarios/model-deprecation-mock.js
 */

import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 4122);
const LOG_FILE = process.env.LOG_FILE || '';

/** Model that gets deprecated once the marker appears in history. */
const deprecatableModel = 'mock-model-a';
/** Marker word present in the third user message of the scenario. */
const DEPRECATION_MARKER = 'третий';

/**
 * Route each chat completion request.
 *
 * @param {object} ctx
 * @param {object} ctx.body         - parsed JSON request body
 * @param {number} ctx.inputTokens  - chars/4 approximation over the raw body
 * @param {number} ctx.requestIndex - 0-based count of requests served so far
 * @returns one of: { kind: 'error', status, body } | { kind: 'message', ... }
 */
function handleRequest({ body }) {
  const model = body.model || 'unknown';
  const history = JSON.stringify(body.messages || []).toLowerCase();

  const deprecated =
    model === deprecatableModel && history.includes(DEPRECATION_MARKER);

  if (deprecated) {
    return {
      kind: 'error',
      status: 404,
      body: {
        error: {
          message: `Model ${model} is not a valid model and is no longer supported. Please select an available model.`,
          type: 'invalid_request_error',
          code: null,
          status: 'NOT_FOUND',
        },
      },
    };
  }

  return { kind: 'message', content: `successful reply from ${model}` };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const approxTokens = (str) => Math.ceil(str.length / 4);

function errorBody(message, type = 'invalid_request_error', extra = {}) {
  return { error: { message, type, code: null, ...extra } };
}

// ---------------------------------------------------------------------------
// Protocol handling — no need to edit below
// ---------------------------------------------------------------------------

const log = (record) => {
  const line = JSON.stringify({ t: new Date().toISOString(), ...record });
   
  console.error(line);
  if (LOG_FILE) {
    try {
      appendFileSync(LOG_FILE, line + '\n');
    } catch {
      /* ignore */
    }
  }
};

function defaultUsage(inputTokens, message) {
  const completionStr =
    (message.content || '') +
    (message.tool_calls?.map((tc) => tc.function.arguments).join('') || '');
  const completionTokens = approxTokens(completionStr);
  return {
    prompt_tokens: inputTokens,
    completion_tokens: completionTokens,
    total_tokens: inputTokens + completionTokens,
  };
}

function defaultFinishReason(message) {
  return message.finish_reason ?? (message.tool_calls ? 'tool_calls' : 'stop');
}

function writeNonStreamed(res, model, message, inputTokens) {
  const payload = {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: message.content ?? '',
          ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
        },
        finish_reason: defaultFinishReason(message),
      },
    ],
    usage: message.usage ?? defaultUsage(inputTokens, message),
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function writeStreamed(res, model, message, inputTokens) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish_reason = null) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason }],
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  send(chunk({ role: 'assistant', content: '' }));
  if (message.content) send(chunk({ content: message.content }));
  if (message.tool_calls) {
    message.tool_calls.forEach((tc, idx) => {
      send(
        chunk({
          tool_calls: [
            {
              index: idx,
              id: tc.id,
              type: 'function',
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            },
          ],
        }),
      );
    });
  }
  send({
    ...chunk({}, defaultFinishReason(message)),
    usage: message.usage ?? defaultUsage(inputTokens, message),
  });
  res.write('data: [DONE]\n\n');
  res.end();
}

let requestIndex = 0;

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end('not found');
      return;
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end('bad json');
      return;
    }

    const inputTokens = approxTokens(raw);
    const idx = requestIndex;
    requestIndex += 1;
    log({
      kind: 'request',
      url: req.url,
      model: body.model,
      messages: (body.messages || []).length,
      inputTokens,
      stream: !!body.stream,
      requestIndex: idx,
    });

    let result;
    try {
      result = handleRequest({ body, inputTokens, requestIndex: idx });
    } catch (err) {
      log({ kind: 'handler_error', error: String(err) });
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify(errorBody(String(err), 'server_error')));
      return;
    }

    if (result.kind === 'error') {
      log({ kind: 'error_response', status: result.status });
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body));
      return;
    }

    const model = body.model || 'mock-model';
    if (body.stream) {
      writeStreamed(res, model, result, inputTokens);
    } else {
      writeNonStreamed(res, model, result, inputTokens);
    }
  });
});

server.listen(PORT, () => {
  log({ kind: 'listening', port: PORT });
});
