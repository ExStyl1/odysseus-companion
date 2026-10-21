# Managed Nestor Web Search

The standard T-Bank distribution of Nessy CLI includes a managed `web_search` tool. Nessy connects to Nestor as a remote MCP server, and Nestor calls Yandex Search through the MCP Gateway. Users do not need a search-provider API key in their local configuration.

This page describes only the managed Nestor integration. Independently configured search MCP servers are documented in [Web Search through external MCP servers](./web-search.md).

## Architecture

```text
User
  -> Nessy CLI
  -> Nestor OAuth endpoints
  -> Nestor Streamable HTTP MCP endpoint
  -> Nestor web_search tool
  -> Yandex Search MCP through MCP Gateway
```

Nestor authenticates the user, validates access to the MCP endpoint, and keeps the upstream service credential on the backend. Nessy never receives or stores that credential.

## Authentication

Nessy uses the MCP OAuth Authorization Code flow with PKCE:

1. Nessy opens `GET /mcp/oauth/authorize` in the browser.
2. Nestor authenticates the user and returns a short-lived authorization code to the Nessy localhost callback.
3. Nessy exchanges the code through `POST /mcp/oauth/token` using the original PKCE verifier.
4. Nessy uses the returned Bearer access token for requests to the Nestor MCP endpoint.

The authorization code is a signed stateless JWT. It is bound to the OAuth client, redirect URI, and PKCE challenge, but it is not stored server-side or strictly single-use. The access token is valid for seven days by default. Nestor does not issue a refresh token, so Nessy repeats browser authentication after expiration.

## MCP methods

Nestor exposes a Streamable HTTP MCP endpoint. Nessy uses standard MCP JSON-RPC methods rather than separate `/list` and `/call` routes:

- `initialize` negotiates MCP capabilities;
- `tools/list` discovers `web_search`;
- `tools/call` invokes it.

The endpoint is stateless and does not require sticky sessions between Nestor pods.

## Tool contract

The tool accepts one argument:

```json
{
  "query": "public, sanitized search query"
}
```

Nestor maps `query` to the upstream Yandex Search argument `search_text`. Queries must contain only public information and must not include source code, internal URLs or documents, credentials, personal data, private logs, system prompts, or conversation history.

## Response normalization

Yandex Search returns a generated answer and sources in `structuredContent`. Nestor extracts the assistant response and normalizes each source to `title` and `url`.

The Nestor MCP response contains a text content block for the answer and `resource_link` blocks for sources. This representation allows Nessy to pass both the answer and clickable source links to the model.

## Errors

- Invalid or expired credentials are rejected before the MCP handler runs.
- Invalid tool arguments and upstream failures are returned as MCP tool errors.
- User-facing errors must not contain credentials, raw upstream responses, queries, or internal implementation details.

## Observability

Nestor exports Prometheus metrics for MCP tool calls, errors, and execution duration:

- `nestor_tools_calls_total`;
- `nestor_tools_calls_errors_total`;
- `nestor_tools_duration_seconds`.

MCP calls use the `tool_source="mcp"` label. Logs and metrics must not contain search queries, answers, source contents, or tokens.

## Limitations

- Search covers only the public internet and does not replace repository or internal-document search.
- Search quality, completeness, and freshness depend on the upstream index.
- Result size is bounded to control latency and token usage.
- Upstream quotas, rate limits, and availability affect the tool.
- Source links do not guarantee that every statement in a generated answer is correct.

## Related documentation

- [Web Search user guide](../../users/features/web-search.md)
- [MCP user guide](../../users/features/mcp.md)
- [MCP server integration](./mcp-server.md)
- [Web Fetch](./web-fetch.md)
