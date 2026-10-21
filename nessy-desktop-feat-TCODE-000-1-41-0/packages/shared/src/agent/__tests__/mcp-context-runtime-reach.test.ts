/**
 * P6.25 — which MCP *context* capabilities (resources, prompts) reach a
 * claude-runtime session, and why the one that does not CANNOT be wired at the
 * seam we use. Measured at HEAD 2026-08-29; this file exists because the
 * ledger cell behind the row said "absent" for all of it, and three of the four
 * paths are live.
 *
 * ## What was measured
 *
 * 1. **MCP prompts DO reach a claude-runtime session.** `SessionManager`
 *    discovers them off the pool (`mcpPromptDescriptors`), lists them among the
 *    session's custom slash commands, and renders one on invocation through
 *    `mcpPool.getPrompt` (`SessionManager.resolveCustomSlashCommand`, the
 *    `custom:mcp:` branch). Nothing on that path consults the runtime, so it is
 *    identical for Pi, Claude and Codex — which is what
 *    `https://code.claude.com/docs/en/mcp.md#use-mcp-prompts-as-commands`
 *    specifies: "MCP servers can expose prompts that become available as
 *    commands in Claude Code."
 *
 * 2. **A user's `@server:uri` resource mention DOES reach one.** It is resolved
 *    in `BaseAgent.extractSkillInvocations` via `resolveMcpResourceMentions` →
 *    `mcpPool.readResource`, called from `BaseAgent.chat` — the ONE `chat` in
 *    the hierarchy; `ClaudeAgent` supplies `chatImpl`, which runs after the
 *    mention is already inlined. `mcp.md#reference-mcp-resources`: "Resources
 *    are automatically fetched and included as attachments when referenced".
 *
 * 3. **The MODEL-initiated pair does NOT.** `list_mcp_resources` and
 *    `read_mcp_resource` are `visibility: 'pi-only'`, and the Claude backend's
 *    session server (`getSessionScopedTools`) calls `getSessionToolDefs` with
 *    no projection, so the filter drops them. Against
 *    `mcp.md#reference-mcp-resources` — "Claude Code automatically provides
 *    tools to list and read MCP resources when servers support them" — that is
 *    a real divergence from BOTH Pi and documented Claude Code: on
 *    claude-runtime a resource can be pulled in by the USER and never by the
 *    model. Case (a) below is the pin.
 *
 * 4. **Why the FACTORY cannot carry it.** Native-first asks whether the runtime
 *    already has the mechanism. Claude Code does — those very tools — but it
 *    provides them for servers IT connected, and a claude-runtime session
 *    reaches MCP entirely through in-process SDK proxy servers built by
 *    `createSdkMcpServer` (`createSourceProxyServers`, `claude-agent.ts`).
 *    `CreateSdkMcpServerOptions` in the vendored SDK has NO resources or
 *    prompts channel — only `name`, `version`, `instructions`, `tools`,
 *    `alwaysLoad` — so a server built by that factory has nothing for the
 *    runtime's own mechanism to discover. Case (b) is the denominator pin: an
 *    SDK bump that adds a `resources` option turns this row from "cannot" into
 *    "should", and it should fail HERE the day it does.
 *
 * 5. **CORRECTION, P3.344, measured 2026-09-04: "cannot at this seam" was
 *    derived from the FACTORY's option type and does not hold of the SEAM.**
 *    The config type the SDK accepts is `McpSdkServerConfigWithInstance`, which
 *    is `{ type: 'sdk'; name: string } & { instance: McpServer }` — an
 *    arbitrary caller-built `McpServer`, not the factory's output. And the
 *    transport under it is method-agnostic: `Query.connectSdkMcpServer` calls
 *    `instance.connect(transport)`, and the CLI reaches that instance through a
 *    `subtype: "mcp_message"` control request that forwards whatever JSON-RPC
 *    message it carries (`handleMcpControlRequest` → `transport.onmessage`)
 *    with no method allowlist anywhere on the path. So an `McpServer` we
 *    construct ourselves, with `resources` registered, WOULD be asked and WOULD
 *    answer — the limitation is in what we build, not in what the seam can
 *    carry. Case (c) pins both halves of that.
 *
 *    What remains genuinely unmeasured, and is recorded as a null rather than
 *    guessed: whether the CLOSED `claude` binary actually issues `resources/list`
 *    to an `sdk`-type server once its instance declares the capability. That
 *    needs a live run of the packaged runtime, not a read. Until it is measured
 *    the claude arm of P3.344 is a HYPOTHESIS about the binary, and the codex
 *    arm — which is closed, in `mcp/pool-server.ts` — is not.
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { getSessionToolDefs } from '@nessy-agent/session-tools-core'

const MODEL_FACING_RESOURCE_TOOLS = ['list_mcp_resources', 'read_mcp_resource'] as const

describe('MCP context capabilities across runtimes', () => {
  // (a) The measured divergence, stated as a divergence rather than an absence.
  // `getSessionToolDefs()` with no projection is EXACTLY the call the Claude
  // backend's session-tool server makes (`session-scoped-tools.ts`), so this is
  // the claude-runtime surface, not a proxy for it.
  it('withholds the model-facing MCP resource tools from every non-Pi runtime', () => {
    const claudeFacing = new Set(getSessionToolDefs().map(def => def.name))
    const piFacing = new Set(getSessionToolDefs({ projection: 'pi' }).map(def => def.name))

    for (const name of MODEL_FACING_RESOURCE_TOOLS) {
      expect(piFacing.has(name), `${name} on Pi`).toBe(true)
      expect(claudeFacing.has(name), `${name} on Claude/Codex`).toBe(false)
    }
  })

  /**
   * (b) The denominator, read from the vendored SDK's own declaration rather
   * than from prose. AGENTS.md: "the vendored bundle is the denominator and the
   * documentation is a subset of it."
   *
   * `instructions` is in this list and we pass none — a separate, smaller loss
   * on the same seam, and the SDK's own comment says what it costs: "When
   * proxying a real MCP server through the SDK transport, pass the underlying
   * server's `getInstructions()` here so it isn't dropped."
   */
  it('records that an in-process SDK MCP server has no resources or prompts channel', () => {
    // Same resolution the other SDK-surface pins use
    // (`claude-live-settings.test.ts`): the package's own entry, with the
    // typings beside it — `sdk.d.ts` is not an exported subpath.
    const require_ = createRequire(import.meta.url)
    const entry = require_.resolve('@anthropic-ai/claude-agent-sdk')
    const declaration = readFileSync(entry.replace(/sdk\.mjs$/, 'sdk.d.ts'), 'utf8')
    const block = declaration.match(/declare type CreateSdkMcpServerOptions = \{([\s\S]*?)\n\};/)
    expect(block, 'CreateSdkMcpServerOptions not found in the installed sdk.d.ts').not.toBeNull()

    const fields = [...block![1]!.matchAll(/^\s{4}(\w+)\??:/gm)].map(match => match[1])
    // `timeout` joined at `0.3.251` (C3.380, 2026-09-13): a per-server tool-call
    // ceiling that overrides `MCP_TOOL_TIMEOUT` for this server, applied when the
    // server is first registered and ignored below 1000 ms. It is a NEW knob on
    // this seam and not a resources/prompts channel, so the two absences below
    // are unaffected — which is why the list is asserted whole rather than by
    // `toContain`: a field arriving is exactly what this should show.
    expect(fields).toEqual(['name', 'version', 'instructions', 'tools', 'alwaysLoad', 'timeout'])
    // The two that would make the runtime's own resource tools reachable.
    expect(fields).not.toContain('resources')
    expect(fields).not.toContain('prompts')
  })

  /**
   * (c) P3.344's correction to (b)'s CONCLUSION — the same file, read one type
   * and one function further along. (b) stays true and stays pinned; what
   * changes is what may be concluded from it.
   */
  it('records that the sdk seam itself carries an arbitrary server instance and an unfiltered message channel', () => {
    const require_ = createRequire(import.meta.url)
    const entry = require_.resolve('@anthropic-ai/claude-agent-sdk')
    const declaration = readFileSync(entry.replace(/sdk\.mjs$/, 'sdk.d.ts'), 'utf8')

    // The CONFIG type — what the SDK accepts — is not the FACTORY's output
    // type. It takes any `McpServer`, so what a proxy server can answer is
    // decided by the instance we build, not by `createSdkMcpServer`.
    const config = declaration.match(
      /declare type McpSdkServerConfigWithInstance = McpSdkServerConfig & \{([\s\S]*?)\n\};/,
    )
    expect(config, 'McpSdkServerConfigWithInstance not found in the installed sdk.d.ts').not.toBeNull()
    expect(config![1]).toContain('instance: McpServer')

    // And the runtime half: the CLI reaches an sdk-type server through one
    // control-request subtype that forwards the JSON-RPC message verbatim. Read
    // from the bundle rather than from prose, with a positive and a negative
    // control so an empty match cannot pass for a finding.
    const bundle = readFileSync(entry, 'utf8')
    expect(bundle.split('"mcp_message"').length - 1).toBeGreaterThan(0)
    expect(bundle).toContain('SDK MCP server not found')
    expect(bundle).toContain('No message handler registered')
    // Positive control: a sibling subtype on the same dispatch, so a bundle
    // that stopped containing these strings fails loudly instead of quietly.
    expect(bundle).toContain('"hook_callback"')
    // Negative control: the probe really reads the file and does not match all.
    expect(bundle).not.toContain('mcp_message_never_shipped')
  })
})
