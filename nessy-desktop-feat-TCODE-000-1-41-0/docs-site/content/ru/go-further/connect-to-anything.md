# Подключение к чему угодно

Не каждый service, на который вы полагаетесь, ships public MCP server, а wiring one up by hand — registering OAuth client, wrangling scopes, refreshing tokens — отдельный project. Aggregators решают это, exposing thousands of apps through single hosted MCP endpoint, который можно зарегистрировать как [source](../sources/overview).

## Why Aggregators Help

Direct integration with service like Google (Gmail, Calendar, Drive) или Microsoft (Outlook, Teams, OneDrive) обычно означает:

1. Creating OAuth application in vendor developer console.
2. Declaring redirect URIs and exact scopes needed.
3. Running authorization flow to obtain access and refresh tokens.
4. Refreshing tokens before expiry.
5. Storing and rotating credentials safely.

Для one-off personal automation такой overhead редко окупается. Aggregators уже registered OAuth clients with underlying services, поэтому вы authenticate once with aggregator and get working tool access. Several now publish MCP server, на который Nessy Desktop can point directly.

::: tip
Файлы вручную редактировать не нужно. Ask in chat — "connect our Zapier MCP server" or "set up Pipedream for this workspace" — and agent creates source, walks through authentication and verifies connection.
:::

## Aggregator Options

### Zapier

[Zapier MCP](https://zapier.com/mcp) fronts thousands of apps and large catalog actions behind one hosted MCP URL.

Manual setup:

1. Create Zapier account at [zapier.com](https://zapier.com).
2. Open [zapier.com/mcp](https://zapier.com/mcp) and start new MCP configuration.
3. Add apps you want agent to reach; Zapier runs OAuth step for each.
4. Copy unique MCP server URL Zapier generates for your account.
5. Register it in Nessy Desktop as MCP source (см. [connecting servers](../sources/mcp-servers/connecting-servers)):

```json
{
  "type": "mcp",
  "name": "Zapier",
  "slug": "zapier",
  "mcp": {
    "url": "https://mcp.zapier.com/your-unique-id"
  }
}
```

### Composio

[Composio](https://composio.dev) offers per-service MCP servers and universal server, Rube, reaching any connected app through compact tool set.

Manual setup:

1. Sign up at [composio.dev](https://composio.dev).
2. Connect services you need from dashboard.
3. Copy MCP URL for single service, or universal Rube endpoint.
4. Add it as MCP source:

```json
{
  "type": "mcp",
  "name": "Composio",
  "slug": "composio",
  "mcp": {
    "url": "https://mcp.composio.dev/your-connection"
  }
}
```

### Make

[Make](https://www.make.com) (formerly Integromat) exposes Make scenarios as callable tools through hosted MCP server whose URL embeds token.

Manual setup:

1. Sign up at [make.com](https://www.make.com).
2. Build scenarios for actions agent should trigger.
3. Generate MCP token in Make profile settings.
4. Assemble URL from zone and token, e.g. `https://eu2.make.com/mcp/u/your-token/stateless`.
5. Add it as MCP source:

```json
{
  "type": "mcp",
  "name": "Make",
  "slug": "make",
  "mcp": {
    "url": "https://eu2.make.com/mcp/u/your-token/stateless"
  }
}
```

### Pipedream

[Pipedream](https://pipedream.com) provides hosted MCP servers across broad API catalog, keeping each service credentials isolated.

Manual setup:

1. Sign up at [pipedream.com](https://pipedream.com).
2. Open [mcp.pipedream.com](https://mcp.pipedream.com).
3. Connect services you want; Pipedream handles OAuth for each.
4. Copy MCP configuration it produces.
5. Add it as MCP source:

```json
{
  "type": "mcp",
  "name": "Pipedream",
  "slug": "pipedream",
  "mcp": {
    "url": "https://mcp.pipedream.com/your-config"
  }
}
```

## Choosing an Aggregator

| Aggregator | Strength |
| ---------- | -------- |
| Zapier | Widest app coverage |
| Composio | Developer-oriented, with universal server |
| Make | Visual scenario builder as tools |
| Pipedream | API-first workflows with managed auth |

All four expose cloud-hosted MCP servers. Start with one covering most services you actually use — you can register more than one aggregator as separate sources later.

## Example: Mail and Calendar Assistant

Give agent a Zapier source, then a [skill](../skills/overview), spelling out what it may do:

````markdown
# Assistant

Manage email and calendar on my behalf.

## Capabilities
- Read and search email
- Draft and send replies
- Review calendar events
- Create and update events

## Guidelines
- Confirm before sending any email
- Add relevant context when creating events
- Summarise long threads instead of quoting them in full
````

## Practical Notes

- **Test before you build on it.** Register source, then run small prompt ("list my last three calendar events") to confirm connection works before wiring into automation.
- **Watch aggregator limits.** Each has quota; frequent agents can hit it.
- **Check what each service exposes.** Aggregators surface different actions per app — confirm capability exists rather than assuming.
- **Scope Plan mode.** Aggregator tools follow same [permissions](../core-concepts/permissions) rules as any MCP source. In Plan mode they are allowlisted; add per-source `permissions.json` to grant more (см. [sources overview](../sources/overview)).

## Native Alternatives

If service ships own MCP server, connect directly instead of routing through aggregator — see [connecting servers](../sources/mcp-servers/connecting-servers). For plain REST services, [API source](../sources/apis/overview) often simpler than aggregator.
