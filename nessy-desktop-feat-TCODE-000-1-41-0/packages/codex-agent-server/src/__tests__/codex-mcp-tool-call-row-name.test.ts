/**
 * F1.381 (origin the WJ-hh verifier on F1.272) — `codexMcpToolCallRowName`
 * reads the tool out of codex's fixed sentence, and since F1.272 that read
 * feeds ALLOW decisions (a user's `allow` rule answers codex's MCP card). The
 * regex was anchored only at the END, so a tool name carrying a quote could be
 * read as a DIFFERENT tool: the sentence for a tool named
 * `x" to run tool "whoami` ends `run tool "whoami"?`, and the unanchored read
 * returned `whoami`.
 *
 * ## The sentence, read at `rust-v0.154.0`
 *
 * `core/src/mcp_tool_call.rs` `build_mcp_tool_approval_fallback_message`:
 * `format!("Allow {actor} to run tool \"{tool_name}\"?")`, where the actor is
 * `the {server} MCP server` for every server that is not codex's own apps
 * server (a connector name is the apps server's alone, and so is the
 * `message_override` template, which `render_mcp_tool_approval_template` builds
 * only for a `connector_id`). `build_mcp_tool_approval_question` then trims the
 * trailing `?` and adds exactly one. So the whole sentence is known from the
 * frame's own `serverName`, and the read anchors at BOTH ends on it.
 *
 * Unreachable today — both servers codex is given expose tools named in
 * `[A-Za-z0-9_-]` — which is why it is hardening and not a fix of a live hole.
 */
import { describe, expect, test } from 'bun:test';
import { codexMcpToolCallRowName } from '../approval-bridge.ts';

const META = { codex_approval_kind: 'mcp_tool_call' };
const frame = (serverName: string, message: string) => ({ serverName, message });

describe('F1.381 · codexMcpToolCallRowName reads only the whole fixed sentence', () => {
  test('the plain sentence still names its tool (session and pool servers)', () => {
    expect(codexMcpToolCallRowName(frame('session', 'Allow the session MCP server to run tool "automation_update"?'), META))
      .toBe('mcp__session__automation_update');
    expect(codexMcpToolCallRowName(frame('sources', 'Allow the sources MCP server to run tool "linear__create_issue"?'), META))
      .toBe('mcp__sources__linear__create_issue');
  });

  test('a tool name carrying a quote is NOT read as the tool its tail names', () => {
    const embedded = 'Allow the linear MCP server to run tool "x" to run tool "whoami"?';
    expect(codexMcpToolCallRowName(frame('linear', embedded), META)).toBeNull();
  });

  test('a sentence naming ANOTHER server, a connector, or a prefixed sentence is not read', () => {
    expect(codexMcpToolCallRowName(frame('session', 'Allow the sources MCP server to run tool "whoami"?'), META)).toBeNull();
    expect(codexMcpToolCallRowName(frame('session', 'Allow Linear to run tool "whoami"?'), META)).toBeNull();
    expect(codexMcpToolCallRowName(frame('session', 'Note. Allow the session MCP server to run tool "whoami"?'), META)).toBeNull();
  });

  test('a server name with regex metacharacters is matched literally', () => {
    expect(codexMcpToolCallRowName(frame('a.b', 'Allow the a.b MCP server to run tool "t"?'), META)).toBe('mcp__a.b__t');
    expect(codexMcpToolCallRowName(frame('a.b', 'Allow the aXb MCP server to run tool "t"?'), META)).toBeNull();
  });

  test('CONTROL: a frame that is not codex\'s MCP tool-call approval answers null', () => {
    expect(codexMcpToolCallRowName(frame('session', 'Allow the session MCP server to run tool "t"?'), {})).toBeNull();
  });
});
