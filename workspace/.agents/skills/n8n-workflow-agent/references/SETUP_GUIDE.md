# n8n Agent Setup

Use this document when the agent cannot confirm that `n8n-mcp` and n8n skills are available.

Goal: help the user configure local agent access to n8n through MCP and install the n8n skills.

## Setup flow

### 1. Ask the user to create an n8n API key

Tell the user:

1. Open n8n API settings:
   `https://n8n.t-tech.team/settings/api`
2. Create or copy an API key.
3. Keep the key private.
4. Do not paste the real key into shared docs, tickets, screenshots, or commits.

Use `apikey` as a placeholder in examples.

### 2. Ask the user to add MCP config

Tell the user to add this MCP server config to their agent MCP configuration:

```json
{
  "n8n-mcp": {
    "type": "stdio",
    "command": "npx",
    "args": [
      "n8n-mcp"
    ],
    "env": {
      "MCP_MODE": "stdio",
      "LOG_LEVEL": "error",
      "DISABLE_CONSOLE_OUTPUT": "true",
      "N8N_API_URL": "https://n8n.t-tech.team",
      "N8N_API_KEY": "apikey"
    }
  }
}
```

Replace `apikey` with the real API key.

Security note: if the agent config is committed to a repo, use an environment variable or local ignored config instead of storing the API key directly.

### 3. Ask the user to restart/reload the agent

After editing MCP config, the user should restart the agent or reload MCP servers.

Then verify that the `n8n-mcp` server is visible and that its tools are available.

A successful setup means:

- MCP server name `n8n-mcp` is present.
- n8n MCP tools are callable.
- A harmless discovery/validation call works.
- The agent can use n8n MCP tools without authentication errors.

If authentication fails, check:

- `N8N_API_URL` is exactly `https://n8n.t-tech.team`
- `N8N_API_KEY` is present
- the API key was copied fully
- the key has not expired or been revoked
- the user can access n8n in the browser

### 4. Install n8n skills

Ask the user to install the n8n skills:

```bash
npx skills add https://github.com/czlonkowski/n8n-skills
```

Then ask the user to restart/reload the agent so skills are re-indexed.

A successful setup means these skills are available:

- `n8n Expression Syntax`
- `n8n MCP Tools Expert`
- `n8n Workflow Patterns`
- `n8n Validation Expert`
- `n8n Node Configuration`
- `n8n Code JavaScript`
- `n8n Code Python`

### 5. Verify final readiness

Before doing real workflow work, confirm:

- `n8n-mcp` tools are available.
- `n8n MCP Tools Expert` skill is available.
- Other n8n skills are available and can be loaded on demand.
- The user has provided a workflow ID, URL, exported JSON, or clear task.

Important: do not try to list all workflows. This MCP setup does not provide `list workflows`.

## Troubleshooting

### MCP tools are not visible

Tell the user to check:

- MCP config file location is correct for their agent.
- JSON syntax is valid.
- The agent was restarted after config changes.
- `npx n8n-mcp` can be resolved in the local environment.
- Corporate proxy or npm registry restrictions are not blocking `npx`.

### MCP server starts but n8n calls fail

Tell the user to check:

- API URL is correct.
- API key is correct.
- API key has access to the target n8n instance.
- User can access `https://n8n.t-tech.team` in browser.
- No extra quotes/spaces were copied into `N8N_API_KEY`.

### Skills are not available

Tell the user to check:

- `npx skills add https://github.com/czlonkowski/n8n-skills` completed successfully.
- The agent was restarted/reloaded.
- The skills directory is indexed by the agent.
- The skill names are visible in the agent’s skill list.

## After setup

Once setup is complete, return to the original n8n task.

Before changing any workflow:

1. Inspect the current workflow.
2. Propose a plan.
3. Ask for approval.
4. Apply changes only after approval.
5. Validate.
6. Summarize changes.