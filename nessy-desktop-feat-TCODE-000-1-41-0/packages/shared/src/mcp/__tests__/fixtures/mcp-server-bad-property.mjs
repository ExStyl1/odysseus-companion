#!/usr/bin/env node
// F1.699 — a stdio MCP server whose second tool has an input-schema property name
// the Anthropic tool contract refuses (`^[a-zA-Z0-9_.-]{1,64}$`). Otherwise the same
// minimal spec-compliant server as `mcp-server-good.mjs`.
// Newline-delimited JSON-RPC on stdout, as the MCP stdio spec requires.

import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })

const PROTOCOL_VERSION = '2025-11-25'

const send = (msg) => {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

rl.on('line', (line) => {
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  if (req.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-server-bad-property', version: '1.0.0' },
      },
    })
    return
  }
  if (req.method === 'notifications/initialized') {
    // Notification — no response required.
    return
  }
  if (req.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echo input back',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
          {
            name: 'spaced',
            description: 'A property name with a space in it',
            inputSchema: {
              type: 'object',
              properties: { 'file name': { type: 'string' } },
            },
          },
        ],
      },
    })
    return
  }
  // Unknown method — return method-not-found error.
  if (typeof req.id !== 'undefined') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32601, message: 'Method not found' },
    })
  }
})
