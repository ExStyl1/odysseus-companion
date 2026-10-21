# Web Search

Web Search lets Nessy find current information on the public internet while it works on your project. It is useful when the answer depends on information that may not be present in the repository or in the model's built-in knowledge.

Typical use cases include:

- finding current documentation for an external library or API;
- checking release notes, migration guides, and recent breaking changes;
- looking up public issues, examples, and compatibility information;
- comparing the current behavior of tools or services;
- citing public sources in an answer.

## Availability

Web Search is delivered as a managed remote MCP tool in the standard T-Bank distribution of Nessy CLI. Nestor proxies requests to Yandex Search, so you do not need to obtain a search-provider API key or add one to `settings.json`.

Availability is controlled by Nestor. The tool is shown only when all of the following are true:

- the managed Nestor MCP server is connected;
- your user account is authorized.

Open the MCP management dialog with `/mcp` to check the connection. The Nestor server should be connected and its tool list should contain `web_search`.

## Authentication

The first connection may open a browser and ask you to sign in. Nessy uses the standard OAuth Authorization Code flow with PKCE and stores the resulting access token in its MCP OAuth token storage.

Nessy sends this user access token only to Nestor. The service credential used to call the search provider stays on the Nestor backend and is never written to your local configuration.

By default, the managed access token is valid for seven days. Nestor does not issue a refresh token, so Nessy starts the browser flow again after the access token expires or is removed. You can also start authentication manually from the Nestor server entry in `/mcp`.

## How to use Web Search

Ask a normal question. Nessy decides whether Web Search is necessary and calls it as part of the task. You can also explicitly ask it to search the web.

Examples:

```text
Find the current migration guide for Go 1.25 and summarize changes relevant to this project.
```

```text
Search for the latest stable version of this dependency and check its release notes for breaking changes.
```

```text
Find the official documentation for this error, explain the likely cause, and include the sources.
```

```text
Search public issues for this stack trace and compare the suggested fixes with our code.
```

For questions about a specific page whose URL you already know, prefer [`web_fetch`](../../developers/tools/web-fetch), which reads that page directly. Web Search is intended for discovering relevant public pages and answering across search results.

## Sources

Web Search returns an answer together with links to the public pages used by the search provider. Nessy passes both the answer and source links to the model. Ask Nessy to cite or compare the sources when traceability matters.

Source links show where the search result came from, but they do not guarantee that every statement in the generated answer is correct. Open the original pages and verify important technical, security, legal, or operational decisions.

## Limitations

- **Public internet only:** Web Search is not a replacement for repository search, internal documentation search, or other company data sources.
- **No guaranteed completeness:** Search results may omit relevant pages or favor one interpretation of a topic.
- **Freshness can vary:** A recently published or updated page may not be indexed immediately.
- **Generated answers can be wrong:** Treat the returned answer as a summary of search results, not as an authoritative source.
- **Bounded output:** Nestor limits result size to control latency and token usage. Long pages and result sets may be summarized or omitted.
- **Service dependency:** Availability and latency depend on Nestor, the upstream search provider, network connectivity, quotas, and rate limits.
- **No arbitrary page access:** Search discovers and summarizes results. Use `web_fetch` when you need Nessy to process a known URL directly.

## Data safety

Search queries leave the local machine and are processed by Nestor and the configured search provider. Do not put any of the following into a Web Search request:

- source code or internal implementation details;
- internal URLs, repository names, or document contents;
- tokens, credentials, secrets, or configuration values;
- personal data;
- private logs, stack traces, or incident details;
- system prompts or conversation history.

Rewrite the query using only the minimum public context needed to find an answer. For example, search for a public error code or library API name instead of sending a complete internal log entry.

## Troubleshooting

### `web_search` is not available

Open `/mcp` and inspect the Nestor server:

- If authentication is required, start the OAuth flow from the server entry.
- If the server is disconnected, reconnect it or restart Nessy.

### Authentication opens repeatedly

Check that the browser can return to the configured local OAuth callback and that Nessy can write its MCP OAuth token storage. Removing the saved token causes a new browser flow.

### A result has no useful source

Refine the request and ask for official or primary sources explicitly. Search coverage depends on what the upstream provider indexed and returned.

For MCP connection and OAuth configuration details, see [MCP](./mcp). For the server-side design, see the [managed Nestor Web Search documentation](../../developers/tools/nestor-web-search.md).
