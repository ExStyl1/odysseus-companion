# MCP Authentication

Most useful MCP servers sit behind some form of authentication. Nessy Desktop
handles three modes for remote servers, environment/configuration requirements
for local ones, and shared Developer Platform (DP) SSO for qualified corporate
MCP subprocesses.

## Authentication Types

The `mcp.authType` field selects the mechanism for HTTP/SSE servers:

| Type | Best for | What happens |
| --- | --- | --- |
| `oauth` | Servers with user accounts and scoped access | Browser-based authorization; tokens refresh automatically |
| `bearer` | Static API keys and personal tokens | You're prompted once for the token; it's sent as `Authorization: Bearer …` |
| `none` | Public or network-trusted servers | Requests go out unauthenticated |

Ordinary stdio servers ignore source `authType`. They can still require declared
environment/configuration, while qualified `dp ai mcp ...` servers use the
separate shared DP flow below.

## Developer Platform SSO

Every supervised plugin server whose normalized command is exactly `dp` and
whose arguments begin `ai mcp` shares one Desktop-owned Spirit CLI session.
Nessy probes that session server-side and gates every such runtime until the
broker reports `ready`. If login is needed, one DP card starts `dp auth login`;
the same login covers all `dp ai mcp ...` servers. Their subprocesses receive
`DP_AI_MCP_SKIP_LOGIN=true`, so they never open an independent login flow.

Spirit CLI remains the credential owner under `DP_WORKDIR` (or its normal
default, `~/.dp` — a sign-in the app starts lands there too, so your terminal
`dp` and the `dp ai mcp` servers see it). Nessy never writes, copies, persists,
logs, or sends the raw DP token to the renderer. It reads it in one case only:
when `dp auth print-token` cannot be run, times out, or answers with output that
cannot be parsed, the Nessy Gateway sign-in reads the user entry of dp's own
session file, read-only, and exchanges it once for the gateway JWT. A saved
session with less than five minutes left is not used, and a sign-in that used
it says so. `~/.nessy/dp_auth_creds.json` is a different file: the Nessy Gateway
JWT. Its shape is nessy-cli's contract, but the file is Nessy's — its own dp
sign-in is the file's one writer (atomically, at mode 0600, keeping any keys it
does not own), and other tools such as nessy-cli only read it; see
[What Nessy Desktop does to `dp_auth_creds.json`](../../reference/config/credentials).
A token in it does not prove that plugin MCP DP SSO is ready.

The normalized command and arguments are the authority. Marketplace labels and
server names such as `dpGitlab` are presentation only; a similarly named
bundled executable is not treated as DP.

## OAuth

Declare `authType: "oauth"` for servers that implement the MCP authorization spec:

```json
{
  "type": "mcp",
  "name": "Linear",
  "tagline": "Issue tracking and project management",
  "mcp": {
    "transport": "http",
    "url": "https://mcp.linear.app/mcp",
    "authType": "oauth"
  }
}
```

### How the Flow Works

The entire flow runs between your machine, the MCP server, and its authorization server — there is no intermediary relay service.

1. **Discovery.** The app fetches the server's OAuth metadata, following RFC 9728 protected-resource metadata and RFC 8414 authorization-server metadata, trying the standard well-known locations in order.
2. **Proof setup.** A PKCE verifier/challenge pair (S256) and a random `state` value are generated for the flow.
3. **Local callback server.** A one-shot HTTP listener is bound on `localhost`, trying ports 8914 through 8924 until one is free, serving the path `/oauth/callback`.
4. **Client registration.** If the authorization server offers dynamic client registration, the app registers itself as a public client with the callback URL as its redirect URI. If registration is unavailable or gated (401/403), a default client ID is used instead.
5. **Browser authorization.** Your default browser opens the authorization URL. You log in and approve access on the provider's own pages.
6. **Callback.** The provider redirects to `http://localhost:<port>/oauth/callback`. The listener verifies the `state` value (rejecting mismatches as a possible CSRF attempt), captures the authorization code, shows a success page, and shuts down.
7. **Token exchange.** The code plus PKCE verifier are exchanged at the token endpoint for an access token and, when granted, a refresh token.
8. **Storage.** Tokens, expiry, and the client ID land in the encrypted vault, and the source flips to `connected`.

If no callback arrives within 5 minutes, the flow times out and can simply be started again. If a server issues no `expires_in`, the app assumes a one-hour lifetime so refresh logic still has something to work with.

::: info Local-only callback
The redirect target is always a loopback address on your machine. No third-party domain participates in the exchange, which also means the flow works against servers on private networks — as long as your browser can reach the authorization pages.
:::

### Token Refresh

Refresh is automatic and proactive:

- Tokens are renewed when they are expired **or within 5 minutes of expiring**, checked at session start and before requests.
- Concurrent refresh attempts for the same source are deduplicated into one request.
- A failed refresh marks the source `needs_auth` (with the error recorded on the source) and starts a 5-minute cooldown so a broken provider isn't hammered. Re-authenticating from the source view clears the state.

### Triggering Authentication

The agent can start the OAuth dance itself via its `source_oauth_trigger` tool — useful when a mid-session tool call discovers an expired grant. The tool takes either a user-created source (`sourceSlug`) or a plugin-owned server (`pluginKey` plus `serverName`, whose credential is global — one sign-in covers every workspace). In the read-only Plan [permission mode](../../core-concepts/permissions) this tool is blocked, and Don't ask denies it, so unattended sessions can't pop browser windows.

## Bearer Tokens

Declare `authType: "bearer"` for servers keyed by a static token:

```json
{
  "type": "mcp",
  "name": "Exa Search",
  "tagline": "Web search and content extraction",
  "mcp": {
    "transport": "http",
    "url": "https://mcp.exa.ai/mcp",
    "authType": "bearer"
  }
}
```

On first use the app asks for the token through a masked credential prompt (the agent's `source_credential_prompt` tool, also blocked in Plan mode). The value goes straight into the encrypted vault — it is never written to `config.json` — and every request to the server carries it as `Authorization: Bearer <token>`.

Static tokens have no refresh mechanism. When one expires or is revoked, the server starts returning 401/403, the source shows `needs_auth`, and you paste a new token. Mid-session updates take effect on the next tool call; no restart needed.

## Custom Header Authentication

Some servers want their key in a custom header rather than `Authorization`. Declare the header names, and the values are stored as secrets:

```json
{
  "type": "mcp",
  "name": "Internal Search",
  "tagline": "Company search cluster",
  "mcp": {
    "transport": "http",
    "url": "https://mcp.internal.example.com/mcp",
    "authType": "none",
    "headers": { "X-Org-Id": "platform-team" },
    "headerNames": ["X-API-Key"]
  }
}
```

Headers are layered in fixed precedence, later entries overriding earlier ones:

1. `mcp.headers` — static values from the config file (non-secret).
2. `mcp.headerNames` — secret values pulled from the credential vault at request time.
3. `Authorization: Bearer …` — the OAuth or bearer token, when `authType` is not `none`.

## Public Servers

`authType: "none"` disables credential handling completely — nothing is prompted for, stored, or read:

```json
{
  "type": "mcp",
  "name": "Docs Search",
  "tagline": "Public documentation index",
  "mcp": {
    "transport": "http",
    "url": "https://docs.example.com/mcp",
    "authType": "none"
  }
}
```

## Local Servers (Stdio)

Stdio servers authenticate the way any local process does — through environment variables or their own config files:

```json
{
  "type": "mcp",
  "name": "Postgres",
  "tagline": "Query the analytics database",
  "mcp": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "some-postgres-mcp"],
    "env": {
      "PGHOST": "localhost",
      "PGDATABASE": "analytics"
    }
  }
}
```

Note that `mcp.env` values are stored in plain text inside `config.json`. Keep genuinely sensitive material out of them where the server offers an alternative (a credentials file, the system keychain). The subprocess's inherited environment is already stripped of common high-value secrets — see [local process safety](overview#local-process-safety).

## Credential Storage

OAuth, bearer, and secret-header values for Sources live in one encrypted file.
`CONFIG_DIR` is
`NESSY_CONFIG_DIR` when set, otherwise `~/.nessy-agent`:

```
CONFIG_DIR/credentials.enc
```

- Encryption is AES-256-GCM with a key derived from a stable machine identifier — the file is useless if copied to another computer (expect a decryption error and a re-authentication prompt after migrating machines).
- Entries for user-created sources are keyed by type, workspace, and source: `source_oauth::<workspace-id>::<source-slug>` for OAuth tokens, `source_bearer::…` for static tokens. Workspaces therefore never share these credentials, and two sources pointing at the same server hold independent grants.
- Plugin-owned MCP servers use global slots instead: `plugin_mcp_oauth::<plugin-key>::<server-name>` and `plugin_mcp_bearer::…` — one credential per server, shared by every workspace, purged when the plugin is uninstalled.
- OAuth entries carry the access token, refresh token, expiry, and the OAuth client ID needed for refresh.
- DP credentials do not enter this vault; Spirit CLI owns them under
  `DP_WORKDIR`. Declared non-secret stdio environment/configuration remains
  configuration rather than an OAuth credential.

More on the vault in [credentials reference](../../reference/config/credentials).

::: warning Storage v2 cutover
The old `credentials.enc` inside a quarantined v1 home is never imported or
read. Reauthorize MCP Sources and re-enter their bearer/API credentials in v2.
The separate `~/.nessy/dp_auth_creds.json` file is only for Nessy Gateway. It
lives outside the v2 home, so storage cutover neither imports nor rewrites it,
and a valid cached Gateway JWT in it keeps working; the app's own dp sign-in
remains its one writer. It does not authorize MCP Sources.
:::

### Removing Credentials

- Deleting a source deletes its vault entries along with it.
- To force a fresh login without deleting the source, remove and re-add it, or re-run authentication from the source view — new tokens overwrite old ones.
- Deleting `CONFIG_DIR/credentials.enc` wipes **every** stored secret (LLM keys included); every connection will ask for auth again.

## Example: Mixed Auth in One Workspace

```json
[
  {
    "type": "mcp",
    "name": "Linear",
    "mcp": { "transport": "http", "url": "https://mcp.linear.app/mcp", "authType": "oauth" }
  },
  {
    "type": "mcp",
    "name": "Exa Search",
    "mcp": { "transport": "http", "url": "https://mcp.exa.ai/mcp", "authType": "bearer" }
  },
  {
    "type": "mcp",
    "name": "Docs Search",
    "mcp": { "transport": "http", "url": "https://docs.example.com/mcp", "authType": "none" }
  },
  {
    "type": "mcp",
    "name": "SQLite",
    "mcp": { "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-sqlite", "/Users/me/data/app.db"] }
  }
]
```

Linear opens a browser once and then refreshes silently; Exa asks for an API key once; the docs server just works; SQLite runs locally with no credentials at all.

## Troubleshooting

#### OAuth card reports a failure

The failed card shows the server-owned diagnostic, including missing MCP OAuth
metadata. A generic OAuth failure is terminal and its card has no retry action;
a later independently emitted pending request starts a fresh flow with a new
request identity. Nessy never converts an invalid generic URL — including a
GitLab URL — into DP based on its name.

A DP failure differs: Desktop keeps the matching server-only replay pending and
the same DP card can retry the shared broker. Cancel or session cleanup removes
that pending replay.

#### Browser never opens

- Check that a default browser is set and reachable from the app.
- Copy the authorization URL from the auth prompt into a browser manually if needed.
- A firewall blocking loopback connections will break the callback — ports 8914–8924 on `localhost` must be reachable from the browser.
- If the app reports every callback port as busy, another process (or a stuck previous flow) holds them; restarting the app releases its own listeners.

#### "State mismatch" on the callback page

The callback carried a `state` value the app didn't issue — usually a stale tab from an earlier attempt. Close old authorization tabs and run the flow once, fresh.

#### Server rejects the token

- Confirm the account you authorized has access to the resources the tools touch, and that requested scopes are sufficient.
- Verify `mcp.url` points at the same environment you authenticated against (staging vs production mix-ups are common).
- Check that `authType` matches the server: a server expecting a plain API key will reject an OAuth token and vice versa.

#### Repeated re-authentication prompts

- The provider may be revoking tokens (session policies, password change, admin action).
- A refresh failure puts the source into `needs_auth` — the source view shows the recorded error, which usually names the cause.
- After moving to a new machine, one full re-auth per source is expected: the vault key is machine-bound.

#### Wrong account got connected

Providers reuse the browser's active session. Log out of the provider (or use a private window), then re-run authentication for the source.

## Security Recommendations

- Prefer OAuth where the server offers it — grants are scoped, revocable, and rotate themselves.
- Let the credential prompt collect secrets; never paste tokens into `config.json`, `guide.md`, or session messages.
- Issue the narrowest key the integration needs, and rotate long-lived static tokens on a schedule.
- Treat `mcp.env` as visible-on-disk configuration, not secret storage.
- Review connected sources per workspace occasionally and remove ones you no longer use — their credentials go with them.
