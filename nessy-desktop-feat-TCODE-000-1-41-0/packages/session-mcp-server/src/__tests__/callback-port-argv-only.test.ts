/**
 * F1.710 — `call_llm`'s HTTP fallback goes only where the SPAWN points it.
 *
 * At HEAD the session MCP server read its callback port from `--callback-port`
 * and, failing that, from the ambient `NESSY_LLM_CALLBACK_PORT`. Nothing in the
 * tree sets that variable, and its only server — the Pi subprocess's
 * unauthenticated `/call-llm` listener — is gone in the same change. What was
 * left was a launch-environment switch that sent a tool call's arguments (the
 * prompt, the attachments) to whatever listened on the named local port. The
 * integration decides where a call goes, never the launch environment (owner,
 * 2026-09-25), so the port is read from argv only — the rule
 * `--host-callback-port` already follows.
 *
 * The rig is the REAL `session-mcp-server` over MCP stdio (the shared child
 * pool), with two recording listeners standing in for a callback server: one
 * named by the environment, one named by argv.
 *
 * THE DEFECT — an inherited `NESSY_LLM_CALLBACK_PORT` routed `call_llm` to its
 * listener. F1.710's CONTROL (historical) — `--callback-port` still routed it;
 * F1.1135 below turned that arm into the removal arm.
 *
 * F1.1135 — the argv channel went too: no host passes `--callback-port` (codex's
 * spawn names `--host-callback-port` only, F1.710) and no in-tree server answers
 * `/call-llm` or `/spawn-session`, so the flag routed a call's arguments to
 * whatever a launcher named. Both tools now answer only through the host's
 * PreToolUse intercept (`_precomputedResult`); the CONTROL became the removal
 * arm, and the intercept path is the control that they still answer.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChildPool } from './child-pool.ts'

// The child's boot is a cold, I/O-bound module graph (28–70 s measured, P6.893); two argvs, so two boots.
setDefaultTimeout(480_000)

type Result = { content?: Array<{ type: string; text: string }>; isError?: boolean }
type Recorder = { port: number; hits: string[]; close(): Promise<void> }

async function startRecorder(answer: string): Promise<Recorder> {
  const hits: string[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      hits.push(`${req.method} ${req.url} ${body}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text: answer }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('recorder did not bind')
  return { port: address.port, hits, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

const pool = createChildPool<Result>()
let workspace: string
let fromEnv: Recorder
let fromArgv: Recorder
const savedEnv = process.env.NESSY_LLM_CALLBACK_PORT

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'smcp-f1710-'))
  fromEnv = await startRecorder('answered by the environment port')
  fromArgv = await startRecorder('answered by the argv port')
  // Bun 1.3.14: delete, then assign (AGENTS.md). The pooled child inherits it at spawn.
  delete process.env.NESSY_LLM_CALLBACK_PORT
  process.env.NESSY_LLM_CALLBACK_PORT = String(fromEnv.port)
})

afterAll(async () => {
  await pool.killAll()
  delete process.env.NESSY_LLM_CALLBACK_PORT
  if (savedEnv !== undefined) process.env.NESSY_LLM_CALLBACK_PORT = savedEnv
  await fromEnv?.close()
  await fromArgv?.close()
  rmSync(workspace, { recursive: true, force: true })
})

const baseArgs = () => [
  '--session-id', 'f1710-session',
  '--workspace-root', workspace,
  '--plans-folder', join(workspace, 'plans'),
  '--config-root', workspace,
]

async function callLlm(args: string[]): Promise<Result | undefined> {
  const responses = await pool.runMcpSession(args, [
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'call_llm', arguments: { prompt: 'F1710_PROMPT' } } },
  ])
  return responses.get(2)?.result
}

describe('F1.710/F1.1135 — call_llm and spawn_session reach no HTTP callback port', () => {
  test('THE DEFECT — an inherited NESSY_LLM_CALLBACK_PORT no longer receives the call', async () => {
    const result = await callLlm(baseArgs())
    expect(fromEnv.hits).toEqual([])
    expect(result?.isError).toBe(true)
    expect(result?.content?.[0]?.text).toContain('_precomputedResult')
  })

  test('F1.1135 — a --callback-port in argv receives nothing either: call_llm and spawn_session refuse, naming the intercept', async () => {
    const responses = await pool.runMcpSession([...baseArgs(), '--callback-port', String(fromArgv.port)], [
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'call_llm', arguments: { prompt: 'F1710_PROMPT' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'spawn_session', arguments: { prompt: 'F1135_SPAWN' } } },
    ])
    expect(fromArgv.hits).toEqual([])
    expect(fromEnv.hits).toEqual([])
    for (const id of [2, 3]) {
      const result = responses.get(id)?.result
      expect(result?.isError).toBe(true)
      expect(result?.content?.[0]?.text).toContain('_precomputedResult')
      expect(result?.content?.[0]?.text).not.toContain('--callback-port')
    }
  })

  test('CONTROL — the intercept path still answers call_llm', async () => {
    const responses = await pool.runMcpSession(baseArgs(), [
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'call_llm', arguments: { prompt: 'p', _precomputedResult: JSON.stringify({ text: 'answered by the intercept' }) } } },
    ])
    const result = responses.get(2)?.result
    expect(result?.isError).not.toBe(true)
    expect(result?.content?.[0]?.text).toBe('answered by the intercept')
  })
})
