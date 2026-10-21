# @nestor/nessy-cli-sdk

A minimum experimental TypeScript SDK for programmatic access to Nessy CLI.

Feel free to submit a feature request/issue/PR.

## Installation

```bash
npm install @nestor/nessy-cli-sdk
```

## Requirements

- Node.js >= 22.0.0

> From v0.1.1, the CLI is bundled with the SDK. So no standalone CLI installation is needed.

## Quick Start

```typescript
import { query } from '@nestor/nessy-cli-sdk';

// Single-turn query
const result = query({
  prompt: 'What files are in the current directory?',
  options: {
    cwd: '/path/to/project',
  },
});

// Iterate over messages
for await (const message of result) {
  if (message.type === 'assistant') {
    console.log('Assistant:', message.message.content);
  } else if (message.type === 'result') {
    console.log('Result:', message.result);
  }
}
```

## API Reference

### `query(config)`

Creates a new query session with the Nessy CLI.

#### Parameters

- `prompt`: `string | AsyncIterable<SDKUserMessage>` - The prompt to send. Use a string for single-turn queries or an async iterable for multi-turn conversations.
- `options`: `QueryOptions` - Configuration options for the query session.

#### QueryOptions

| Option                   | Type                                           | Default          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ---------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`                    | `string`                                       | `process.cwd()`  | The working directory for the query session. Determines the context in which file operations and commands are executed.                                                                                                                                                                                                                                                                                                                                                                   |
| `model`                  | `string`                                       | -                | The AI model to use (e.g., `'qwen-max'`, `'qwen-plus'`, `'nessy-turbo'`). Takes precedence over `OPENAI_MODEL` and `NESSY_MODEL` environment variables.                                                                                                                                                                                                                                                                                                                                   |
| `pathToNessyExecutable`  | `string`                                       | Auto-detected    | Path to the Nessy CLI executable. Supports multiple formats: `'nessy'` (native binary from PATH), `'/path/to/nessy'` (explicit path), `'/path/to/cli.js'` (Node.js bundle), `'node:/path/to/cli.js'` (force Node.js runtime), `'bun:/path/to/cli.js'` (force Bun runtime). If not provided, auto-detects from: `NESSY_CLI_PATH` env var, `~/.volta/bin/nessy`, `~/.npm-global/bin/nessy`, `/usr/local/bin/nessy`, `~/.local/bin/nessy`, `~/node_modules/.bin/nessy`, `~/.yarn/bin/nessy`. |
| `permissionMode`         | `'default' \| 'plan' \| 'auto-edit' \| 'yolo'` | `'default'`      | Permission mode controlling tool execution approval. See [Permission Modes](#permission-modes) for details.                                                                                                                                                                                                                                                                                                                                                                               |
| `canUseTool`             | `CanUseTool`                                   | -                | Custom permission handler for tool execution approval. Invoked when a tool requires confirmation. Must respond within 60 seconds or the request will be auto-denied. See [Custom Permission Handler](#custom-permission-handler).                                                                                                                                                                                                                                                         |
| `env`                    | `Record<string, string>`                       | -                | Environment variables to pass to the Nessy CLI process. Merged with the current process environment.                                                                                                                                                                                                                                                                                                                                                                                      |
| `systemPrompt`           | `string \| QuerySystemPromptPreset`            | -                | System prompt configuration for the main session. Use a string to fully override the built-in Nessy CLI system prompt, or a preset object to keep the built-in prompt and append extra instructions.                                                                                                                                                                                                                                                                                      |
| `mcpServers`             | `Record<string, McpServerConfig>`              | -                | MCP (Model Context Protocol) servers to connect. Supports external servers (stdio/SSE/HTTP) and SDK-embedded servers. External servers are configured with transport options like `command`, `args`, `url`, `httpUrl`, etc. SDK servers use `{ type: 'sdk', name: string, instance: Server }`.                                                                                                                                                                                            |
| `abortController`        | `AbortController`                              | -                | Controller to cancel the query session. Call `abortController.abort()` to terminate the session and cleanup resources.                                                                                                                                                                                                                                                                                                                                                                    |
| `debug`                  | `boolean`                                      | `false`          | Enable debug mode for verbose logging from the CLI process.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `maxSessionTurns`        | `number`                                       | `-1` (unlimited) | Maximum number of conversation turns before the session automatically terminates. A turn consists of a user message and an assistant response.                                                                                                                                                                                                                                                                                                                                            |
| `coreTools`              | `string[]`                                     | -                | Equivalent to `permissions.allow` in settings.json as an allowlist. If specified, only these tools will be available to the AI (all other tools are disabled at registry level). Supports tool name aliases and pattern matching. Example: `['Read', 'Edit', 'Bash(git *)']`.                                                                                                                                                                                                             |
| `excludeTools`           | `string[]`                                     | -                | Equivalent to `permissions.deny` in settings.json. Excluded tools return a permission error immediately. Takes highest priority over all other permission settings. Supports tool name aliases and pattern matching: tool name (`'write_file'`), shell command prefix (`'Bash(rm *)'`), or path patterns (`'Read(.env)'`, `'Edit(/src/**)'`).                                                                                                                                             |
| `allowedTools`           | `string[]`                                     | -                | Equivalent to `permissions.allow` in settings.json. Matching tools bypass `canUseTool` callback and execute automatically. Only applies when tool requires confirmation. Supports same pattern matching as `excludeTools`. Example: `['ShellTool(git status)', 'ShellTool(npm test)']`.                                                                                                                                                                                                   |
| `authType`               | `'openai' \| 'dp-auth'`                        | `'openai'`       | Authentication type for the AI service. Using `'dp-auth'` in SDK is not recommended as credentials are stored in `~/.nessy` and may need periodic refresh.                                                                                                                                                                                                                                                                                                                                |
| `agents`                 | `SubagentConfig[]`                             | -                | Configuration for subagents that can be invoked during the session. Subagents are specialized AI agents for specific tasks or domains.                                                                                                                                                                                                                                                                                                                                                    |
| `includePartialMessages` | `boolean`                                      | `false`          | When `true`, the SDK emits incomplete messages as they are being generated, allowing real-time streaming of the AI's response.                                                                                                                                                                                                                                                                                                                                                            |
| `resume`                 | `string`                                       | -                | Resume a previous session by providing its session ID. Equivalent to CLI's `--resume` flag.                                                                                                                                                                                                                                                                                                                                                                                               |
| `sessionId`              | `string`                                       | -                | Specify a session ID for the new session. Ensures SDK and CLI use the same ID without resuming history. Equivalent to CLI's `--session-id` flag.                                                                                                                                                                                                                                                                                                                                          |

> [!tip]
> If you need to configure `coreTools`, `excludeTools`, or `allowedTools`, it is **strongly recommended** to read the [permissions configuration documentation](../docs/users/configuration/settings.md#permissions) first, especially the **Tool name aliases** and **Rule syntax examples** sections, to understand the available aliases and pattern matching syntax (e.g., `Bash(git *)`, `Read(.env)`, `Edit(/src/**)`).

### Timeouts

The SDK enforces the following default timeouts:

| Timeout          | Default  | Description                                                                                                                  |
| ---------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `canUseTool`     | 1 minute | Maximum time for `canUseTool` callback to respond. If exceeded, the tool request is auto-denied.                             |
| `mcpRequest`     | 1 minute | Maximum time for SDK MCP tool calls to complete.                                                                             |
| `controlRequest` | 1 minute | Maximum time for control operations like `initialize()`, `setModel()`, `setPermissionMode()`, and `interrupt()` to complete. |
| `streamClose`    | 1 minute | Maximum time to wait for initialization to complete before closing CLI stdin in multi-turn mode with SDK MCP servers.        |

You can customize these timeouts via the `timeout` option:

```typescript
const query = nessy.query('Your prompt', {
  timeout: {
    canUseTool: 60000, // 60 seconds for permission callback
    mcpRequest: 600000, // 10 minutes for MCP tool calls
    controlRequest: 60000, // 60 seconds for control requests
    streamClose: 15000, // 15 seconds for stream close wait
  },
});
```

### Experimental Daemon Session Client

`DaemonSessionClient` is an experimental wrapper for clients that talk to a
running `nessy serve` daemon over HTTP + SSE. It binds one daemon session so TUI,
channel, IDE, or web backend adapters do not need to pass `sessionId` into every
call.

```typescript
import { DaemonClient, DaemonSessionClient } from '@nestor/nessy-cli-sdk';

const daemon = new DaemonClient({
  baseUrl: 'http://127.0.0.1:4170',
  token: process.env['NESSY_SERVER_TOKEN'],
});

const caps = await daemon.capabilities();
const session = await DaemonSessionClient.createOrAttach(daemon, {
  workspaceCwd: caps.workspaceCwd,
});

const eventController = new AbortController();
const eventTask = (async () => {
  for await (const event of session.events({
    signal: eventController.signal,
  })) {
    console.log(event.type, event.data);
  }
})();

const result = await session.prompt({
  prompt: [{ type: 'text', text: 'Summarize this workspace.' }],
});

eventController.abort();
await eventTask;
console.log(result.stopReason);
```

`session.events()` tracks the last seen SSE event id and reuses it on the next
subscription by default. Pass `{ resume: false }` to start a fresh subscription
without sending `Last-Event-ID`.

When `createOrAttach()` is called with `modelServiceId`, the returned session
client seeds its first event subscription with `Last-Event-ID: 0`. This replays
the daemon ring from the oldest available event so adapters can observe
attach-time `model_switch_failed` or `model_switched` events that are not
reported on the create/attach HTTP response. Raw `DaemonClient` callers should
pass `{ lastEventId: 0 }` on their first `subscribeEvents()` call when they use
`modelServiceId`.

The raw event envelope remains available as `DaemonEvent` with `data: unknown`.
Adapters that want a v1 typed view can layer the schema helpers on top without
changing the wire stream:

```typescript
import {
  asKnownDaemonEvent,
  createDaemonSessionViewState,
  reduceDaemonSessionEvent,
} from '@nestor/nessy-cli-sdk';

let view = createDaemonSessionViewState();
for await (const event of session.events()) {
  view = reduceDaemonSessionEvent(view, event);

  const known = asKnownDaemonEvent(event);
  if (known?.type === 'permission_request') {
    console.log(known.data.requestId);
  }
}
```

### Message Types

The SDK provides type guards to identify different message types:

```typescript
import {
  isSDKUserMessage,
  isSDKAssistantMessage,
  isSDKSystemMessage,
  isSDKResultMessage,
  isSDKPartialAssistantMessage,
} from '@nestor/nessy-cli-sdk';

for await (const message of result) {
  if (isSDKAssistantMessage(message)) {
    // Handle assistant message
  } else if (isSDKResultMessage(message)) {
    // Handle result message
  }
}
```

### Query Instance Methods

The `Query` instance returned by `query()` provides several methods:

```typescript
const q = query({ prompt: 'Hello', options: {} });

// Get session ID
const sessionId = q.getSessionId();

// Check if closed
const closed = q.isClosed();

// Interrupt the current operation
await q.interrupt();

// Change permission mode mid-session
await q.setPermissionMode('yolo');

// Change model mid-session
await q.setModel('qwen-max');

// Close the session
await q.close();
```

## Permission Modes

The SDK supports different permission modes for controlling tool execution:

- **`default`**: Write tools are denied unless approved via `canUseTool` callback or in `allowedTools`. Read-only tools execute without confirmation.
- **`plan`**: Blocks all write tools, instructing AI to present a plan first.
- **`auto-edit`**: Auto-approve edit tools (`edit`, `write_file`, `notebook_edit`) while other tools require confirmation.

### Permission Priority Chain

Decision priority (highest first): `deny` > `ask` > `allow` > _(default/interactive mode)_

The first matching rule wins.

1. `excludeTools` / `permissions.deny` - Blocks tools completely (returns permission error)
2. `permissions.ask` - Always requires user confirmation
3. `permissionMode: 'plan'` - Blocks all non-read-only tools
4. `permissionMode: 'yolo'` - Auto-approves all tools
5. `allowedTools` / `permissions.allow` - Auto-approves matching tools
6. `canUseTool` callback - Custom approval logic (if provided, not called for allowed tools)
7. Default behavior - Auto-deny in SDK mode (write tools require explicit approval)

## Examples

### Multi-turn Conversation

```typescript
import { query, type SDKUserMessage } from '@nestor/nessy-cli-sdk';

async function* generateMessages(): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    session_id: 'my-session',
    message: { role: 'user', content: 'Create a hello.txt file' },
    parent_tool_use_id: null,
  };

  // Wait for some condition or user input
  yield {
    type: 'user',
    session_id: 'my-session',
    message: { role: 'user', content: 'Now read the file back' },
    parent_tool_use_id: null,
  };
}

const result = query({
  prompt: generateMessages(),
  options: {
    permissionMode: 'auto-edit',
  },
});

for await (const message of result) {
  console.log(message);
}
```

### Custom Permission Handler

```typescript
import { query, type CanUseTool } from '@nestor/nessy-cli-sdk';

const canUseTool: CanUseTool = async (toolName, input, { signal }) => {
  // Allow all read operations
  if (toolName.startsWith('read_')) {
    return { behavior: 'allow', updatedInput: input };
  }

  // Prompt user for write operations (in a real app)
  const userApproved = await promptUser(`Allow ${toolName}?`);

  if (userApproved) {
    return { behavior: 'allow', updatedInput: input };
  }

  return { behavior: 'deny', message: 'User denied the operation' };
};

const result = query({
  prompt: 'Create a new file',
  options: {
    canUseTool,
  },
});
```

### With External MCP Servers

```typescript
import { query } from '@nestor/nessy-cli-sdk';

const result = query({
  prompt: 'Use the custom tool from my MCP server',
  options: {
    mcpServers: {
      'my-server': {
        command: 'node',
        args: ['path/to/mcp-server.js'],
        env: { PORT: '3000' },
      },
    },
  },
});
```

### Override the System Prompt

```typescript
import { query } from '@nestor/nessy-cli-sdk';

const result = query({
  prompt: 'Say hello in one sentence.',
  options: {
    systemPrompt: 'You are a terse assistant. Answer in exactly one sentence.',
  },
});
```

### Append to the Built-in System Prompt

```typescript
import { query } from '@nestor/nessy-cli-sdk';

const result = query({
  prompt: 'Review the current directory.',
  options: {
    systemPrompt: {
      type: 'preset',
      preset: 'nessy_cli',
      append: 'Be terse and focus on concrete findings.',
    },
  },
});
```

### With SDK-Embedded MCP Servers

The SDK provides `tool` and `createSdkMcpServer` to create MCP servers that run in the same process as your SDK application. This is useful when you want to expose custom tools to the AI without running a separate server process.

#### `tool(name, description, inputSchema, handler)`

Creates a tool definition with Zod schema type inference.

| Parameter     | Type                               | Description                                                              |
| ------------- | ---------------------------------- | ------------------------------------------------------------------------ |
| `name`        | `string`                           | Tool name (1-64 chars, starts with letter, alphanumeric and underscores) |
| `description` | `string`                           | Human-readable description of what the tool does                         |
| `inputSchema` | `ZodRawShape`                      | Zod schema object defining the tool's input parameters                   |
| `handler`     | `(args, extra) => Promise<Result>` | Async function that executes the tool and returns MCP content blocks     |

The handler must return a `CallToolResult` object with the following structure:

```typescript
{
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | { type: 'resource'; uri: string; mimeType?: string; text?: string }
  >;
  isError?: boolean;
}
```

#### `createSdkMcpServer(options)`

Creates an SDK-embedded MCP server instance.

| Option    | Type                     | Default   | Description                          |
| --------- | ------------------------ | --------- | ------------------------------------ |
| `name`    | `string`                 | Required  | Unique name for the MCP server       |
| `version` | `string`                 | `'1.0.0'` | Server version                       |
| `tools`   | `SdkMcpToolDefinition[]` | -         | Array of tools created with `tool()` |

Returns a `McpSdkServerConfigWithInstance` object that can be passed directly to the `mcpServers` option.

#### Example

```typescript
import { z } from 'zod';
import { query, tool, createSdkMcpServer } from '@nestor/nessy-cli-sdk';

// Define a tool with Zod schema
const calculatorTool = tool(
  'calculate_sum',
  'Add two numbers',
  { a: z.number(), b: z.number() },
  async (args) => ({
    content: [{ type: 'text', text: String(args.a + args.b) }],
  }),
);

// Create the MCP server
const server = createSdkMcpServer({
  name: 'calculator',
  tools: [calculatorTool],
});

// Use the server in a query
const result = query({
  prompt: 'What is 42 + 17?',
  options: {
    permissionMode: 'auto',
    mcpServers: {
      calculator: server,
    },
  },
});

for await (const message of result) {
  console.log(message);
}
```

### Abort a Query

```typescript
import { query, isAbortError } from '@nestor/nessy-cli-sdk';

const abortController = new AbortController();

const result = query({
  prompt: 'Long running task...',
  options: {
    abortController,
  },
});

// Abort after 5 seconds
setTimeout(() => abortController.abort(), 5000);

try {
  for await (const message of result) {
    console.log(message);
  }
} catch (error) {
  if (isAbortError(error)) {
    console.log('Query was aborted');
  } else {
    throw error;
  }
}
```

## Error Handling

The SDK provides an `AbortError` class for handling aborted queries:

```typescript
import { AbortError, isAbortError } from '@nestor/nessy-cli-sdk';

try {
  // ... query operations
} catch (error) {
  if (isAbortError(error)) {
    // Handle abort
  } else {
    // Handle other errors
  }
}
```

## FAQ / Troubleshooting

### Version 0.1.0 Requirements

If you're using SDK version **0.1.0**, please note the following requirements:

#### Nessy CLI Installation Required

Version 0.1.0 requires [Nessy CLI](https://gitlab.tcsbank.ru/nestor/nessy-cli) **>= 0.4.0** to be installed separately and accessible in your PATH.

```bash
# Install Nessy CLI globally
npm install -g @nestor/nessy-cli@latest
```

**Note**: From version **0.1.1** onwards, the CLI is bundled with the SDK, so no separate Nessy CLI installation is needed.

## License

Apache-2.0 - see [LICENSE](./LICENSE) for details.
