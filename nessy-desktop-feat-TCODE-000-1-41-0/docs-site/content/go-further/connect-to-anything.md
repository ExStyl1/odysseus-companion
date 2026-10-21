# Connect to Anything

Not every service you rely on ships a public MCP server, and wiring one up by hand — registering an OAuth client, wrangling scopes, refreshing tokens — is a project of its own. Aggregators solve that by exposing thousands of apps through a single hosted MCP endpoint you can register as a [source](../sources/overview).

## Why Aggregators Help

Direct integration with a service like Google (Gmail, Calendar, Drive) or Microsoft (Outlook, Teams, OneDrive) usually means:

1. Creating an OAuth application in the vendor's developer console.
2. Declaring redirect URIs and the exact scopes you need.
3. Running the authorization flow to obtain access and refresh tokens.
4. Refreshing tokens before they expire.
5. Storing and rotating those credentials safely.

For one-off personal automation that overhead rarely pays off. Aggregators have already registered OAuth clients with the underlying services, so you authenticate once with the aggregator and get working tool access. Several of them now publish an MCP server you can point Nessy Desktop at directly.

::: tip
You do not have to edit any files by hand. Ask in chat — "connect our Zapier MCP server" or "set up Pipedream for this workspace" — and the agent creates the source, walks you through authentication, and verifies the connection.
:::

## Aggregator Options

### Zapier

[Zapier MCP](https://zapier.com/mcp) fronts thousands of apps and a large catalog of actions behind one hosted MCP URL.

Manual setup:

1. Create a Zapier account at [zapier.com](https://zapier.com).
2. Open [zapier.com/mcp](https://zapier.com/mcp) and start a new MCP configuration.
3. Add the apps you want the agent to reach; Zapier runs the OAuth step for each.
4. Copy the unique MCP server URL Zapier generates for your account.
5. Register it in Nessy Desktop as an MCP source (see [connecting servers](../sources/mcp-servers/connecting-servers)):

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

[Composio](https://composio.dev) offers per-service MCP servers and a universal server, Rube, that reaches any connected app through a compact tool set.

Manual setup:

1. Sign up at [composio.dev](https://composio.dev).
2. Connect the services you need from the dashboard.
3. Copy the MCP URL for a single service, or the universal Rube endpoint.
4. Add it as an MCP source:

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

[Make](https://www.make.com) (formerly Integromat) exposes your Make scenarios as callable tools through a hosted MCP server whose URL embeds your token.

Manual setup:

1. Sign up at [make.com](https://www.make.com).
2. Build scenarios for the actions you want the agent to trigger.
3. Generate an MCP token in your Make profile settings.
4. Assemble the URL from your zone and token, for example `https://eu2.make.com/mcp/u/your-token/stateless`.
5. Add it as an MCP source:

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

[Pipedream](https://pipedream.com) provides hosted MCP servers across a broad API catalog, keeping each service's credentials isolated.

Manual setup:

1. Sign up at [pipedream.com](https://pipedream.com).
2. Open [mcp.pipedream.com](https://mcp.pipedream.com).
3. Connect the services you want; Pipedream handles OAuth for each.
4. Copy the MCP configuration it produces.
5. Add it as an MCP source:

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
| ---------- | ---------------------------------------------- |
| Zapier     | Widest app coverage |
| Composio   | Developer-oriented, with a universal server |
| Make       | Visual scenario builder as tools |
| Pipedream  | API-first workflows with managed auth |

All four expose cloud-hosted MCP servers. Start with the one that covers the most services you actually use — you can register more than one aggregator as separate sources later.

## Example: A Mail and Calendar Assistant

Give the agent a Zapier source, then a [skill](../skills/overview) that spells out what it is allowed to do:

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

- **Test before you build on it.** Register the source, then run a small prompt ("list my last three calendar events") to confirm the connection works before wiring it into an automation.
- **Watch the aggregator's limits.** Each has its own quota; agents that run frequently can hit it.
- **Check what each service actually exposes.** Aggregators surface different actions per app — confirm the capability exists rather than assuming it.
- **Scope Plan mode.** Aggregator tools follow the same [permissions](../core-concepts/permissions) rules as any MCP source. In Plan mode they are allowlisted; add a per-source `permissions.json` to grant more (see [sources overview](../sources/overview)).

## Native Alternatives

If a service already ships its own MCP server, connect it directly instead of routing through an aggregator — see [connecting servers](../sources/mcp-servers/connecting-servers). For plain REST services, an [API source](../sources/apis/overview) is often simpler than any aggregator.
