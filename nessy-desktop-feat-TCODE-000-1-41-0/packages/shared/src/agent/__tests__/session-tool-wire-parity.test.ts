/**
 * The regression fence for the session-tool wire-name unification.
 *
 * Every session tool must reach the model under ONE byte-identical name on
 * every runtime — the Claude Agent SDK's own form `mcp__session__<RegistryId>`.
 * Claude mints it directly (`session-scoped-tools.ts:266-284` calls
 * `tool(def.name, …)` inside `createSdkMcpServer({ name: 'session' })`), so the
 * SDK is the reference and the other two have to agree with it: Pi through the
 * `piName` its manifest projection installs, Codex through the config key its
 * binary joins into `mcp__<server>__<tool>`.
 *
 * This repo has shipped two production bugs from an upstream tool rename
 * (`Task` → `Agent`; LSP `input.lsp` → `lspServers`), both of which a hardcoded
 * expectation table would have missed in exactly the same way. So every side
 * here is COMPUTED from live sources — `PI_TOOL_BINDINGS` for Pi,
 * `SESSION_TOOL_DEFS` for the SDK, the emitted config TOML for Codex — and the
 * test names no tool of its own. A tool added to the registry is covered the
 * day it lands; a tool whose spelling drifts on one runtime fails here before
 * it reaches a session.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildCodexConfigToml } from '@nessy-agent/codex-responses-adapter/config-writer'

import { SESSION_TOOL_DEFS } from '../../../../session-tools-core/src/tool-defs.ts'
import { PI_TOOL_BINDINGS } from '../pi-harness/harness-tool-descriptor.ts'

const here = dirname(fileURLToPath(import.meta.url))
const sessionScopedToolsPath = resolve(here, '..', 'session-scoped-tools.ts')

/** The prefix the SDK derives from its server name; see the pin below. */
const SESSION_PREFIX = 'mcp__session__'

/** Every static binding whose tool is a SESSION tool — the parity population. */
const sessionBindings = PI_TOOL_BINDINGS.filter(binding =>
  binding.bindingName.startsWith(SESSION_PREFIX))

/**
 * The name the Claude Agent SDK mints for a registry id.
 *
 * `createSdkMcpServer({ name: 'session' })` + `tool(<registry id>)` is the whole
 * rule; the SDK joins them as `mcp__<server>__<tool>`. Nothing here transforms
 * the id — that is the property Pi has to match.
 */
const claudeSdkName = (registryId: string): string => `${SESSION_PREFIX}${registryId}`

describe('session-tool wire names are identical across runtimes', () => {
  it("pins the SDK server segment the prefix is derived from", () => {
    // If this name ever moves, every expectation below is measuring the wrong
    // target — an absence check that cannot go quietly.
    const source = readFileSync(sessionScopedToolsPath, 'utf8')
    expect(source).toMatch(/createSdkMcpServer\(\{\s*name: 'session',/)
  })

  it('projects every session tool under its verbatim registry id on Pi', () => {
    const registryIds = new Set(SESSION_TOOL_DEFS.map(def => def.name))
    // Positive control: an empty or tiny population would pass the loop while
    // proving nothing. The registry carries dozens of session tools.
    expect(sessionBindings.length).toBeGreaterThan(50)

    for (const binding of sessionBindings) {
      // The handler is the registry id verbatim — the hinge the equality rests
      // on, and the reason no mapping table is needed on either side.
      const registryId = binding.handlerName
      expect(registryId, `${binding.bindingName} carries no handler name`).toBeString()
      expect(registryIds.has(registryId!), binding.bindingName).toBe(true)
      // The model-facing name Pi installs (`tool-manifest.ts` `projectPiToolDefinition`
      // sets `name: tool.binding.piName`) against the name the SDK mints.
      expect(binding.piName, `Pi wire name for ${registryId}`).toBe(claudeSdkName(registryId!))
      // The host-side registration key agrees too, so the manifest's
      // presented-name union collapses to one spelling for session tools.
      expect(binding.bindingName, `host binding name for ${registryId}`).toBe(binding.piName)
    }
  })

  it('mounts the Codex bundled session server under the same segment', () => {
    // Codex takes the third path: no SDK server and no manifest projection —
    // the binary joins its own config key with the bare registry id the bundled
    // session-mcp-server advertises (`event-adapter.ts` `mcpRowToolName`,
    // `mcp__${server}__${tool}`). So the config key IS the wire prefix, and it
    // is read here out of the TOML the writer actually emits.
    const toml = buildCodexConfigToml({
      codexHome: '/tmp/parity',
      model: 'tgpt/qwen35-397b-a17b-fp8',
      adapterPort: 54321,
      sessionMcp: { command: '/usr/bin/node', args: ['/res/session-mcp-server/index.js'] },
    })
    const keys = [...toml.matchAll(/^\[mcp_servers\.([^\]]+)\]$/gm)].map(match => match[1])
    expect(keys).toContain('session')
    expect(`mcp__${keys.find(key => key === 'session')}__`).toBe(SESSION_PREFIX)
    // …and nothing still mounts it under the pre-unification key.
    expect(toml).not.toContain('nessy_session')
  })

  it('leaves the native built-ins on their own two-spelling bindings', () => {
    // The non-goal fence. Native SDK built-ins are NOT session tools; their
    // bindings deliberately keep `piName !== bindingName` and the manifest's
    // union rule is what serves them. A change that collapsed those too would
    // pass the loop above and break dispatch for the natives.
    const natives = PI_TOOL_BINDINGS.filter(binding =>
      !binding.bindingName.startsWith(SESSION_PREFIX) && binding.piName !== binding.bindingName)
    expect(natives.map(binding => `${binding.piName}->${binding.bindingName}`))
      .toEqual(['notebook_edit->NotebookEdit', 'stop_task->stopTask'])
  })
})
