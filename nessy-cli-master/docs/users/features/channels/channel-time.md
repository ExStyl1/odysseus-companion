# Channel Time

This guide covers setting up a Nessy CLI channel on Channel Time (a Mattermost-compatible platform).

## Prerequisites

- A Channel Time server with API access
- A bot account or personal access token (see below)

## Creating a Bot Account

1. Log in to your Channel Time server as an administrator
2. Go to **System Console** > **Integrations** > **Bot Accounts** and enable bot account creation
3. Go to **Integrations** > **Bot Accounts** > **Add Bot Account**
4. Fill in the bot details (username, display name, description) and create it
5. Copy the generated access token — save it securely

Alternatively, create a personal access token:

1. Go to your **Profile** > **Security** > **Personal Access Tokens**
2. Click **Create Token**, give it a description
3. Copy the token — it will only be shown once

## Finding User IDs

To use `senderPolicy: "allowlist"`, you need Channel Time user IDs:

1. Open **System Console** > **Users** and find the user
2. Click on their profile — the user ID is shown in the URL and profile details
3. User IDs are 26-character alphanumeric strings (e.g., `dkh8tozwwfnudqfwtbh61pur8y`)

## Configuration

Add the channel to `~/.nessy/settings.json`:

```json
{
  "channels": {
    "my-ct": {
      "type": "time",
      "serverUrl": "$CT_SERVER_URL",
      "token": "$CT_BOT_TOKEN",
      "senderPolicy": "allowlist",
      "allowedUsers": ["YOUR_USER_ID"],
      "sessionScope": "thread",
      "cwd": "/path/to/your/project",
      "instructions": "You are a concise coding assistant. Keep responses short.",
      "groupPolicy": "disabled",
      "groups": {
        "*": { "requireMention": true }
      }
    }
  }
}
```

Set environment variables:

```bash
export CT_SERVER_URL=https://time.tbank.ru
export CT_BOT_TOKEN=<your-bot-access-token>
```

### Channel-Specific Options

| Option      | Required | Description                                                                                      |
| ----------- | -------- | ------------------------------------------------------------------------------------------------ |
| `serverUrl` | Yes      | Full URL of your Channel Time server (e.g., `https://time.tbank.ru`). Supports `$ENV_VAR` syntax |
| `token`     | Yes      | Bot access token or personal access token. Supports `$ENV_VAR` syntax                            |

All [common channel options](./overview#options) (sender policy, session scope, group policy, dispatch modes, block streaming, etc.) are also supported.

## Running

```bash
# Start only the Channel Time channel
nessy channel start my-ct

# Or start all configured channels together
nessy channel start
```

Then send a direct message to the bot on Channel Time. You should see a typing indicator and an eyes reaction while the agent is processing, followed by the response.

## Group Chats / Public Channels

To use the bot in Channel Time channels:

1. Set `groupPolicy` to `"allowlist"` or `"open"` in your channel config
2. Add the bot to the desired channel (or invite it)
3. If using `groupPolicy: "allowlist"`, add the channel ID to `groups` in your config
4. By default, the bot requires an @mention to respond in channels. Set `"requireMention": false` for specific channels to make it respond to all messages

```json
{
  "groupPolicy": "open",
  "groups": {
    "*": { "requireMention": true },
    "specific-channel-id": { "requireMention": false }
  }
}
```

### Finding a Channel ID

To find a channel's ID for the allowlist:

1. Open the channel in Channel Time
2. Click the channel name at the top to open channel details

Alternatively, use the API:

```bash
curl -H "Authorization: Bearer $CT_BOT_TOKEN" \
  "$CT_SERVER_URL/api/v4/channels/search" \
  -d '{"term": "channel-name"}'
```

## Threads

Channel Time natively supports message threads. The adapter automatically:

- Detects when a message is a thread reply
- Responds in the same thread as the original message
- Creates separate agent sessions per thread when `sessionScope: "thread"` is configured (recommended)

This makes `sessionScope: "thread"` a natural fit for Channel Time — each conversation thread gets its own isolated agent context.

## Images and Files

**Images:** Send an image to the bot and the agent will analyze it using vision capabilities. Configure a multimodal model (e.g., `"model": "qwen3.5-plus"`) for image support. The first image is passed directly to the model; additional images are saved as file attachments.

**Files:** Send any document (code files, PDFs, text files, etc.). The bot downloads it to a temporary directory so the agent can read it with file tools. This works with any model.

## Working Indicators

While the agent is processing your message:

- **Typing indicator** — "Bot is typing..." appears in the chat, refreshed every 4 seconds
- **Reaction** — An eyes reaction is added to your message, removed when the response is ready

## Tips

- **Use `sessionScope: "thread"`** — Maps naturally to Channel Time threads. Each thread gets its own agent session.
- **Restrict access** — Use `senderPolicy: "allowlist"` for known users, or `"pairing"` for an approval flow. See [DM Pairing](./overview#dm-pairing).
- **Long messages** — The adapter automatically splits responses exceeding 16,383 characters (Mattermost's post limit) at paragraph boundaries.
- **Markdown** — Channel Time supports standard Markdown in messages. The agent's responses are sent as-is without conversion.

## Troubleshooting

### Bot doesn't respond

- Verify `serverUrl` is correct and reachable from where Nessy CLI is running
- Check that the bot token is valid: `curl -H "Authorization: Bearer $CT_BOT_TOKEN" "$CT_SERVER_URL/api/v4/users/me"`
- Verify your user ID is in `allowedUsers` if using `senderPolicy: "allowlist"`
- Check the terminal output for WebSocket connection errors

### Bot doesn't respond in channels

- Check that `groupPolicy` is set to `"allowlist"` or `"open"` (default is `"disabled"`)
- If using `"allowlist"`, verify the channel ID is in the `groups` config
- By default, the bot requires an @mention. Send `@botusername hello` to test

### WebSocket disconnects frequently

- Check network connectivity to the Channel Time server
- The adapter automatically reconnects with exponential backoff (up to 10 attempts)
- If disconnects persist, check server-side WebSocket configuration and timeouts

### "Mattermost API ... 401" errors

- The bot token may have expired or been revoked
- Regenerate the token and update the environment variable
