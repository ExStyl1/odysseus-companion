# Organisation MCP servers

An administrator can give every user the same set of remote MCP servers through the managed
policy, under the key `managedMcpServers`. Users do not add or configure these servers: they reach
every session on Pi, Claude Code and Codex alike, and a user cannot replace or remove one. The key's
name and entry shape are the ones Claude Code uses for its own setting of that name.

## What the administrator writes

### Where the policy lives

`managedMcpServers` is a key of the same host-owned managed policy described under
[Managed Pi policy](../../core-concepts/permissions#managed-pi-policy):

| Platform | Policy file |
| --- | --- |
| macOS | `/Library/Application Support/Nessy/managed-policy.json` |
| Linux | `/etc/nessy/managed-policy.json` |
| Windows | `%ProgramFiles%\Nessy\managed-policy.json` |

On Windows a policy left at the former `%ProgramData%\Nessy` location is ignored, because that
directory is writable by ordinary accounts; the diagnostics name the location to move it to.

Several teams can each ship their own part as a `.json` file in the `managed-policy.d/` directory
beside the policy file. The files are read in name order. Servers with different names combine; a later
file that names the same server replaces that server's entry whole, never field by field.

When the Nessy Gateway delivers a managed policy that carries any setting, that delivered policy
applies instead of the file. It carries `managedMcpServers` the same way, and the file's list is not
added to it. Put the key in whichever source your other managed settings come from.

The key maps a server name to the remote `.mcp.json` entry shape:

```json
{
  "schemaVersion": 1,
  "managedMcpServers": {
    "corp-docs": { "type": "http", "url": "https://mcp.corp.example/docs" },
    "corp-events": {
      "type": "sse",
      "url": "https://mcp.corp.example/events",
      "headers": { "X-Team": "platform" }
    }
  }
}
```

### Entry rules

Each entry is checked on its own, and a refused entry is dropped without affecting the others:

- **Remote servers only.** `type` is `"http"` or `"sse"`. Nothing that names a program to run
  (`"stdio"`, a `command`) is accepted.
- **`url`** must be an `http://` or `https://` URL.
- **`headers`**, when present, maps header names to string values.
- **No `${VAR}` references** anywhere in the URL or the headers.
- **Only `type`, `url` and `headers`.** An entry with any other field is refused whole rather than
  carried in part.
- **Names** use letters, digits, `_` and `-`, at most 64 characters (`__proto__`, `constructor`
  and `prototype` are refused). The name is used as-is in tool names.
- **At most 64 servers.** A value that is not an object, or that lists more than 64 servers, drops
  the whole key.

### Checking what was refused

`nessy-general-agent doctor` lists every refused entry from the policy files with its source file,
its field (`managedMcpServers.<name>`) and the reason, and exits with code 1 when it finds one — see
[doctor](../../reference/cli#doctor-configuration-checkup).

## How each runtime receives them

None of the three runtimes connects to these servers itself. Nessy's own MCP pool connects to each
one and hands its tools to the session the way it hands over any pool server: Claude Code through a
per-server in-process proxy, Pi through the pool's proxy tools, and Codex through the one aggregated
pool server it is given (`[mcp_servers.sources]`). All three read the same set, so switching a
session's runtime does not change which organisation servers it has.

Claude Code has its own `managedMcpServers` setting, and it was tried first. Measured on the bundled
Claude Code 2.1.267: a server handed over the Agent SDK's managed-settings channel — the only managed
channel an embedding application has — received no connection at all, while the same server handed
over as an ordinary MCP server connected. That channel keeps only restrictive settings and drops
additive ones such as this, so the host pool is the one delivery path.

## Rules that apply to them

- **The organisation's entry wins its name.** If a user, project or plugin server uses the same
  name, the organisation's server replaces it in the session.
- **`deniedMcpServers` still applies.** A managed deny entry that matches an organisation server
  keeps it out of every session.
- **`allowedMcpServers` does not have to name them.** A managed allowlist that leaves them out does
  not block them.
- **External models lose them like any other server.** A session whose model answers from outside
  Nessy Gateway keeps only the short allowed list described in
  [External models and MCP tools](./external-models).
- **A name taken from a built-in dp server.** An organisation server named like a
  [built-in dp server](./overview#built-in-mcp-servers) you have switched on replaces it and runs
  even while `dp` needs sign-in — the built-in under that name is the one that yields, and only the
  built-in servers the organisation did not name stay withheld with the sign-in requirement.
- **Permissions work as for any MCP tool.** The tools are named `mcp__<name>__<toolName>`, and the
  session's [permission mode](../../core-concepts/permissions) and rules govern each call.

## What the user sees

- **The tools, in every session.** The organisation's tools are offered next to the user's own,
  on all three runtimes.
- **A read-only row in the MCP servers panel.** Each organisation server has one row under
  **Sources → MCPs**, with the detail page the row opens. The row has no switch, so it cannot be
  switched off, edited or removed from the app.
- **No sign-in.** There is no credential slot and no OAuth flow for them: the static `headers` in
  the policy are the only authentication an entry can carry.

For operators, the app log records each decision that removes or replaces a server:
`managed_org_mcp.denied: <names>` for servers a deny entry kept out, and
`managed_org_mcp.displaced_configured_server: <names>` for configured servers an organisation entry
replaced.

## Related

- [MCP overview](./overview) — how tools are namespaced, pooled and offered.
- [External models and MCP tools](./external-models) — which servers a session on an external
  model keeps.
- [Permissions](../../core-concepts/permissions#managed-pi-policy) — the rest of the managed policy.
- [doctor](../../reference/cli#doctor-configuration-checkup) — checking a policy before a fleet push.
