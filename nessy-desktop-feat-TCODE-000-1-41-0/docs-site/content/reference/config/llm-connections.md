# LLM Connections

An LLM connection is a named provider configuration. You can add several and
switch between them, and a workspace can pin its own default. Each session locks
to a connection after its first message. Connections are stored in the
[config file](/reference/config/config-file); their secrets live in the
[credential store](/reference/config/credentials).

Nessy Desktop routes every connection through one of four backends: the
built-in Nessy Gateway and other custom endpoints (Pi backend), a Claude
subscription or Anthropic API key (Claude Agent SDK), a ChatGPT subscription
login (Pi backend), or the bundled Codex harness (`codex-app-server`), which can
also run on a ChatGPT subscription — see [ChatGPT (Codex)](#chatgpt-codex). Two coding
runtimes ship enabled in the default build: the
[Claude Code runtime](#claude-code-nessy-gateway) points the Claude Agent SDK
at the Nessy Gateway (or [your own endpoint](#custom-runtime-endpoints)), and
the [Codex runtime](#codex-nessy-gateway) does the same with the Codex harness.

## Location

```
~/.nessy-agent/config.json
```

Connections are the `llmConnections` array in that file.

## How connections resolve

For a new session, the connection is chosen in this order:

1. **Session connection** — locked after the first message.
2. **Workspace default** — `defaults.defaultLlmConnection` on the workspace.
3. **Global default** — `defaultLlmConnection` in `config.json`.
4. **First connection** in the list, as a fallback.

::: info
A session locks to its connection after the first message. To use a different
connection, start a new session.
:::

### The connection decides the endpoint

A session's model calls go to the endpoint its connection names: the
connection's base URL, the loopback adapter of a
[Claude Code runtime](#claude-code-nessy-gateway) card, or, for a connection
without its own endpoint (**Anthropic (API key)** without a custom endpoint,
**Claude Pro/Max**), the vendor's own address, `https://api.anthropic.com`. On a
Claude session nothing outside the connection moves it:

- **`ANTHROPIC_BASE_URL` in the environment the app was started from** (a launch
  from a terminal, or the headless `nessy-server`) is ignored, on the first turn
  and after any connection is saved alike. **Settings → Settings diagnosis**
  lists it by name, never by value. A value exported only in your login shell
  never reaches an app opened from the Dock or Finder, so it is not listed
  there.
- **`env.ANTHROPIC_BASE_URL` in a Claude settings file** (the Workspace's user
  `settings.json`, or a repository's `.claude/settings.json` or
  `.claude/settings.local.json`) is ignored too. The chat says once which file
  set it, and Settings → Settings diagnosis lists the file once a session that
  loads it has started, until the app restarts. The same name in the `env` of
  `--settings` (`NESSY_CLAUDE_SETTINGS`) is ignored and said so in the chat; its
  other `env` entries still apply.
- **A settings file's provider switches and first-party flag** in `env` are
  ignored the same way. The provider switches (`CLAUDE_CODE_USE_BEDROCK`,
  `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`,
  `CLAUDE_CODE_USE_ANTHROPIC_AWS`, `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD`,
  `CLAUDE_CODE_USE_MANTLE`, `CLAUDE_CODE_USE_GATEWAY`) are kept off, so a file
  cannot move a session to Bedrock, Vertex, a gateway or another provider. Its
  `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` does not make Claude Code treat the
  connection's endpoint as Anthropic's own. The chat names the file once, and
  Settings → Settings diagnosis lists it by path and setting name (for example
  `env.CLAUDE_CODE_USE_VERTEX`), never the value. In the `env` of `--settings`
  these names are ignored too and said so in the chat only.
- **Organisation-managed Claude settings** (`managed-settings.json`) are left
  alone and still take precedence.

The processes a Claude session starts (its shell commands, hooks and stdio MCP
servers) see the same endpoint in `ANTHROPIC_BASE_URL`: the connection's own
address, or `https://api.anthropic.com` on a connection without one, never a
launch value and never an empty one, so a script that uses an Anthropic SDK
inside the session gets a usable address. On a connection without its own
endpoint, Claude Code's `/status` therefore shows `https://api.anthropic.com` as
its base URL. To use a different endpoint, set the base URL on the
connection itself.

### The project decides which credential

The connection decides **where** requests go (the endpoint and the provider,
above). A trusted project's or Workspace's own configuration may decide **which
credential** signs them, exactly as far as each runtime itself allows, and the
app always names the file that did it:

| Runtime | Can a project's configuration choose the credential? |
| --- | --- |
| Claude | Yes, as Claude Code allows. `env.ANTHROPIC_AUTH_TOKEN` or `env.ANTHROPIC_API_KEY` in a loaded settings file is used for the session: the token is sent as a bearer beside the connection's key, the key replaces it. A file's `apiKeyHelper` and `env.CLAUDE_CODE_OAUTH_TOKEN` rank below both, by Claude Code's own authentication precedence: each replaces a Claude Pro/Max sign-in; beside an API key the OAuth token is not used, while the `apiKeyHelper` command still runs when the session starts and its output is sent as a bearer. The chat names the file and the setting, and Settings → Settings diagnosis lists it under **Settings-file credentials in use** — names only, never the value. Through the app's local adapter (**Claude Code (Nessy Gateway)**, or a Claude Code runtime card with a custom endpoint) such a credential reaches only the adapter, which signs every request with the connection's credential. Remove it from the file to use the connection's credential. |
| Codex | No. Codex itself drops `model_provider`, `model_providers` and `profile` from a project's `.codex/config.toml`, so a repository can neither pick another provider nor give the app's provider its own key or token; the connection's credential is used. |
| Pi | No. Pi sessions get their credential only from the connection; the app gives Pi no models file and reads no Pi settings file for them. |

A repository that is not trusted has none of its Claude settings files loaded,
so nothing from it is used or listed.

## Connection schema

```json
{
  "slug": "nessy-gateway",
  "name": "Nessy Gateway",
  "providerType": "pi_compat",
  "piAuthProvider": "openai",
  "authType": "bearer_token",
  "baseUrl": "https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1",
  "defaultModel": "tgpt/deepseek-v4-flash-0731",
  "createdAt": 1737451800000
}
```

### Fields

| Field               | Required | Description                                                                                        |
| ------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `slug`              | Yes      | URL-safe identifier; also the key under which credentials are stored                               |
| `name`              | Yes      | Display name shown in the UI                                                                        |
| `providerType`      | Yes      | Backend to use (see below)                                                                          |
| `authType`          | Yes      | Authentication mechanism (see below)                                                                |
| `baseUrl`           | No       | Base URL — required for `pi_compat`, optional override otherwise                                    |
| `piAuthProvider`    | No       | Pi provider name (for example `openai`, `anthropic`); relevant to `pi`/`pi_compat` connections     |
| `codexModelProvider`| No       | Codex's own provider a `codex-runtime` connection sends its turns to, instead of the local adapter: `openai` on the [ChatGPT (Codex)](#chatgpt-codex) card |
| `customEndpoint`    | No       | Custom endpoint protocol config: `api` (wire format) and optional `supportsImages`                 |
| `models`            | No       | Explicit model list — strings, or objects with `contextWindow` / `supportsImages` overrides        |
| `defaultModel`      | No       | Default model for this connection                                                                   |
| `modelSelectionMode`| No       | `automaticallySyncedFromProvider` or `userDefined3Tier`                                             |
| `midStreamBehavior` | No       | `"steer"` or `"queue"`; see [Mid-stream behaviour](#mid-stream-behaviour)                           |
| `createdAt`         | Yes      | Creation time, Unix milliseconds                                                                    |
| `lastUsedAt`        | No       | Last-used time, Unix milliseconds                                                                   |

## providerType values

| Value       | Backend                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `anthropic` | Direct Anthropic API via the Claude Agent SDK                              |
| `pi`        | Pi unified API for provider-backed routes (for example the ChatGPT Plus card) |
| `pi_compat` | Pi with a custom endpoint — the Nessy Gateway, Ollama, self-hosted models  |
| `claude-runtime` | Claude Agent SDK pointed at a non-Anthropic endpoint through a local translation adapter — the [Claude Code runtime](#claude-code-nessy-gateway) |
| `codex-runtime` | Bundled `codex-app-server` harness pointed at the Nessy Gateway or a custom endpoint through a local Responses-API adapter — the [Codex runtime](#codex-nessy-gateway) — or at Codex's own provider on your ChatGPT subscription ([ChatGPT (Codex)](#chatgpt-codex)) |
| `nestor-cloud-agent` | Native Nestor cloud code-agent over A2A 1.0 on `/api/v2/code-agent/a2a` (Nessy Gateway sign-in) |

### Nestor Cloud composer modes

Nestor Cloud composer controls are capability-driven. At session startup Nessy
Desktop reads the cloud agent's A2A AgentCard, extracts the advertised
`agent-settings` mode enum, and publishes those modes to the renderer. The
mode picker, slash menu, and Shift+Tab cycle then use the remote mode IDs when
sending turns.

If the AgentCard cannot be read, or if the extension is missing, the session
falls back to the built-in Nestor Cloud contract: **Plan** and **Act**. The
fallback does not add network I/O to synchronous config loading.

### Nestor Cloud local tools

Nestor Cloud runs the agent loop remotely over A2A, but file, shell, search,
and notebook actions still execute locally in Nessy Desktop. Remote tool calls
are adapted into the shared local tool runtime, so path scoping, permissions,
checkpoints, and command execution stay on the desktop side instead of moving
into the cloud agent.

Pi-backed local sessions use the same runtime for built-in file and shell tools
while keeping the existing Pi tool names, schemas, approval prompts, workflow
tools, and subagent behavior. Claude and Codex provider paths are separate and
do not use this runtime unless a later feature explicitly wires them in.

::: info
Older configs may carry legacy provider values (such as `bedrock`, `vertex`, or
`anthropic_compat`). These are migrated to the current set on startup.
:::

## authType values

| Value                   | Description                                     |
| ----------------------- | ----------------------------------------------- |
| `api_key`               | API key only, fixed endpoint                    |
| `api_key_with_endpoint` | API key plus a custom endpoint URL              |
| `bearer_token`          | Single bearer token (distinct header from key)  |
| `oauth`                 | Browser OAuth login (Claude subscription, both ChatGPT cards) |
| `iam_credentials`       | AWS-style access key + secret + region          |
| `service_account_file`  | GCP service-account JSON file                    |
| `environment`           | Auto-detect from environment variables          |
| `none`                  | No authentication (for example local Ollama)    |

## Nessy Gateway

The built-in Nessy Gateway is a `pi_compat` connection with `piAuthProvider`
set to `openai`:

- **Chat endpoint**:
  `https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1`
- **Models endpoint**:
  `https://code-completion-nestor.tcsbank.ru/api/v1/cli/models`
- **Auth header on the gateway path**: `Nestor-Token` carrying the JWT. An
  outgoing `Authorization: Bearer <jwt>` is rewritten to `Nestor-Token`
  **only** for URLs starting with `https://code-completion-nestor.tcsbank.ru/api/v1/cli/`.
  Any other endpoint — including a different path on the same host — keeps
  standard `Authorization: Bearer` semantics.
- **One-click auth**: the gateway card signs you in without a form. The app
  runs the corporate `dp` auth flow, exchanges the token for a gateway JWT, and
  creates the connection automatically. Credentials are cached in
  `~/.nessy/dp_auth_creds.json` (shared with nessy-cli); everything outside the
  auth module treats that file as read-only.
- **Model refresh**: the gateway model list is refreshed at startup from the
  `/models` endpoint. Server-provided models arrive with aliases (for example
  `coder`, `fast`) and a server default; your per-model overrides are preserved
  across refreshes.
- **Context window**: the built-in Gateway Qwen models use a 262,144-token
  context window. The `/models` endpoint does not always report that value, so
  Nessy Desktop applies the known window for those internal model IDs and
  refreshes older persisted 131,072-token values on startup.
- **Generation settings the catalogue publishes, and what happens to them.**
  Measured 2026-09-13: every `/models` row carries a `sampling_params` object
  (temperature, `top_p`, sometimes `top_k`), and the default `coder` row also
  carries `reasoning` with a recommended effort. **Nessy Desktop reads both, and
  applies them as defaults you can always override.**
  - **Sampling** — the published `temperature`, `top_p` and any other key on that
    object are used for that model unless your request already sets them. Before
    this, every gateway model got a fixed `temperature: 0.7` / `top_p: 0.8`
    whatever its own row said, and `top_k` reached the gateway by no route at
    all.
  - **Reasoning effort** — the recommended effort is filled in only when your
    runtime asks for reasoning and names no level. It never overrides a level you
    chose, and it never turns thinking on when you have turned it off. In
    practice that means the codex runtime picks up the recommendation when you
    have set no effort, while the Claude runtime almost always sends its own,
    derived from your thinking setting.
  - **What it costs.** Thinking is not free: on the measured arm the same prompt
    took 0.9 s with no effort key and 12 s with `low`, plus the reasoning tokens.
    The measurement that settles the scare story also stands — a turn that sends
    no effort key gets no thinking at all (measured twice on the default model:
    zero reasoning tokens), so nothing was ever being billed at a high effort
    behind your back, and both the flat `reasoning_effort` key and the nested
    `reasoning.effort` object switch it on and return identical usage.
  - `extra_body` is **not** published by this gateway on any row, so there is
    nothing to read.

## Claude Code (Nessy Gateway)

A second gateway card, **Nessy · Claude Code agent**, runs the bundled Claude
Agent SDK — the harness behind Claude Code — against the same internal gateway.
It creates a `claude-runtime` connection (slug `claude-gateway`, display name
`Claude Code (Nessy Gateway)`) with the gateway endpoint and model catalog
already filled in.

- **Build flag**: `NESSY_FEATURE_CLAUDE_RUNTIME`, **on** in the default build
  since 1.19.0 — the card and the bundled Claude SDK native binary ship unless
  a build sets the flag to `0` (an explicit `NESSY_FEATURE_PROVIDER_CLAUDE=1`
  still bundles the binary even then, because the subscription card needs it).
- **Sign-in**: one click, no form — the same corporate `dp` flow and the same
  cached JWT as the Nessy Gateway card above. No Anthropic account is involved.
- **How it reaches the gateway**: each session starts a loopback translation
  adapter and points the SDK at it (`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`).
  The adapter speaks the Anthropic Messages format to the SDK and the gateway's
  own API upstream. `Nestor-Token` is attached only when the connection's base
  URL is the verified gateway URL; any other endpoint keeps standard
  `Authorization: Bearer` semantics. The adapter is per-session and stops with
  the session.
- **Models**: the same gateway catalog as the Pi-backed card. Utility turns —
  session titles, web-page summaries — resolve the gateway's `fast` alias rather
  than the flagship, and keep doing so after the startup model refresh reorders
  the catalog. The agent's own side-model calls (`call_llm`) also run on a
  model the card serves: a call that names no model, or a Claude model the card
  does not list, runs on that same `fast` model, and the call reports the model
  that answered. Naming one of the card's own model ids in `call_llm` runs that
  model.
- **Not carried in this release**: image attachments are not forwarded on a
  `claude-runtime` connection, and **no thinking budget is sent at all**. The
  budget is resolved from the model id, and a gateway model is not a Claude
  model, so the runtime is told thinking is off before the level is ever
  consulted — the thinking-level control and the `ultrathink` keyword therefore
  both change nothing on this card. Measured live on the packaged build,
  2026-09-12: the child is spawned with `--thinking disabled` whichever level is
  selected. A reasoning block still appears in the conversation; that is the
  gateway model's own reasoning, turned into an Anthropic thinking block by the
  loopback adapter, which is why it sits beside a thinking-token count of zero.

::: info
Sessions on this connection use the Claude Agent SDK's own tool set, MCP wiring,
and skills handling — the Pi tool names and workflow tools do not apply to them.
:::

## Codex (Nessy Gateway)

A third gateway card, **Nessy · Codex agent**, runs the bundled Codex harness
(`codex-app-server` — the engine behind OpenAI's Codex CLI) against the same
internal gateway. It creates a `codex-runtime` connection (slug
`codex-gateway`) with the gateway endpoint and model catalog already filled in.

- **Build flag**: `NESSY_FEATURE_CODEX_RUNTIME`, **on** in the default build
  since 1.19.0 — the card and the bundled `codex-app-server` binary ship unless
  a build sets the flag to `0`.
- **Sign-in**: one click, no form — the same corporate `dp` flow and the same
  cached JWT as the other gateway cards. No OpenAI account is involved.
- **How it reaches the gateway**: each session starts a loopback adapter that
  speaks the Responses API to `codex-app-server` and the gateway's own
  chat/completions API upstream. `Nestor-Token` is attached only when the
  connection's base URL is the verified gateway URL; any other endpoint keeps
  standard `Authorization: Bearer` semantics. The adapter keeps a stalled
  upstream honest: heartbeats bridge mid-stream silence, and a stream that dies
  before completing surfaces as an error after five reconnect attempts — never
  as a silently truncated turn.
- **Tools**: sessions use the Codex harness's own sandboxed tool set (shell
  commands, patches); Pi tool names and workflow tools do not apply.
- **Integrity**: the bundled binary is verified against the hash pinned in the
  app before it is ever started, and a session refuses to start rather than run
  a binary that does not match. Code signing is configured to leave that binary
  untouched, and the release build itself re-runs the check against the final,
  signed bundle — so a release whose Codex runtime could not start cannot be
  produced in the first place.

## ChatGPT (Codex)

The **ChatGPT (Codex)** card runs the same bundled Codex harness on your own
ChatGPT subscription instead of the gateway. It creates a `codex-runtime`
connection (slug `chatgpt-codex`) with `authType: "oauth"` and
`codexModelProvider: "openai"`.

- **Build flag**: none of its own. The card is offered only in a build made
  with `NESSY_FEATURE_PROVIDER_CHATGPT=1` (off by default, the flag the
  ChatGPT Plus card uses) that also ships the Codex runtime. With the flag off,
  neither ChatGPT card is offered; a connection you already have keeps working.
- **Sign-in**: you sign in with your ChatGPT account in the browser, through the
  same sign-in the ChatGPT Plus card uses. Each card keeps its own stored
  sign-in, because OpenAI replaces a refresh token each time it is used, and two
  cards sharing one would sign each other out. When a session starts, the app
  refreshes the token if it has expired and hands it to Codex; when Codex later
  asks for a fresh one, the app answers from this card's sign-in. A sign-in that
  cannot be completed stops the session with the sign-in card described under
  [When a credential expires](#when-a-credential-expires). Codex marks the
  sign-in route this card uses as experimental, so a later Codex release may
  change it.
- **Where turns go**: to Codex's own `openai` provider, which sends a session
  signed in to ChatGPT to `chatgpt.com` — your subscription. No local adapter
  is started and the Nessy Gateway is not involved.
- **Models**: the card starts with Codex's own bundled model list (default
  `gpt-6.1-sol`). After sign-in, each session refreshes the list from Codex's
  own catalogue, so it follows what your account offers. A default model Codex
  no longer lists moves to Codex's own default, and a list you picked yourself
  (`modelSelectionMode: "userDefined3Tier"`) is left alone. A model Codex lists
  as text-only does not take image attachments: the composer stops offering
  them for it, and an image already attached is left out of the message with a
  notice.
- **Web search**: Codex's own web search is on here, while every other Codex
  card turns it off. The app's own `web_search` tool is not offered beside it,
  so the model sees one search tool, and
  [`NESSY_WEB_SEARCH_ALLOWED_DOMAINS`](/reference/config/environment-variables#nessy-web-search-allowed-domains),
  when set, is passed to Codex as the domains its search may use. Codex's
  search has no per-session limit, so
  [`NESSY_MAX_WEB_SEARCHES_PER_SESSION`](/reference/config/environment-variables#nessy-max-web-searches-per-session)
  does not stop it; the chat says so once when a session passes that cap.
- **`/quota`** shows the subscription's usage windows as Codex reports them —
  see [Interactions](/core-concepts/interactions). Once Codex has reported
  those windows to the session, a turn stopped by the subscription's usage
  limit names when that limit resets and asks you to send a message after that
  time. Codex does not continue a stopped turn by itself, so
  [`NESSY_AUTO_CONTINUE_AT_USAGE_LIMIT`](/reference/config/environment-variables#nessy-auto-continue-at-usage-limit)
  changes only that message here.
- **Not available**: session titles and other one-shot completions. The app has
  no route to Codex's provider outside a Codex turn, and it does not send them
  to the Nessy Gateway instead, so a session keeps its default title.
- **Where your tools go**: the line under the model list that names where your
  MCP tool schemas are sent names `chatgpt.com` for this card, as it does for
  ChatGPT Plus on Pi — see [External models](/sources/mcp-servers/external-models).

## Custom runtime endpoints

The **Custom runtime endpoint** card (onboarding and Settings → AI →
**+ Add Connection**) is, since 1.26.0, the **only** entrance for a personal
key — the separate "API key" card was merged into it. One form, three runtimes:

- **Runtime** picks the harness your key runs under: **Pi agent**,
  **Claude Code** or **Codex**. On the Pi arm you may also pick an official
  provider preset (OpenAI, Anthropic) instead of a custom endpoint, in which
  case the provider's own endpoint and catalog are used and no `baseUrl` is
  stored.
- **Endpoint** is no longer typed. A new connection is created against the
  internal LLM proxy, so the field is hidden. The exception is the Edit path on
  a connection that points somewhere else: the field is then shown **disabled**
  with the stored URL, which is submitted verbatim — an existing endpoint cannot
  be silently moved by a re-save. The exact Nessy Gateway URL is rejected on
  every arm: the one-click cards already cover it, and a personal-key connection
  on that URL would neither use your key nor stay editable.
- **API key** may be left empty for a loopback endpoint (local Ollama-class
  servers); the connection is then stored with `authType: "none"` and its
  requests carry no auth header. On the Edit path a blank key keeps the stored
  one.
- **Models** come from the endpoint. **Fetch models** reads the published
  catalog and probes it for what your key can actually reach — see
  [Custom Endpoints → availability marks](/reference/config/custom-endpoint).
  The picked models are shown as chips; the first chip is the default and
  clicking a chip moves it there. The typed comma-separated field is hidden on
  create (the picker is the only route in) and survives on every Edit path, for
  a stored connection whose catalog cannot be fetched. Vendor extras that do not
  survive an OpenAI-compatible wire (thinking signatures, prompt caching) are
  unavailable over these connections.
- **Utility model** picks which of your selected models is used for chat titles
  and short internal completions; it is stored as `miniModel`. *Automatic* leaves
  it unset and the existing heuristic chooses. On a Claude Code connection it is
  also what an agent's `call_llm` runs on when it names no model or a Claude
  model the connection does not list.
- **Editing** re-opens the same form with the runtime locked: an existing
  connection never changes its harness, and the stored key survives a blank
  submit.

A connection created here is enrolled in the 24-hour model-metadata refresh
automatically (`modelsSyncedAt`); the form also persists the context window it
displayed, so the connection is complete before the first refresh is due.

## Examples

### Nessy Gateway (bearer token)

```json
{
  "slug": "nessy-gateway",
  "name": "Nessy Gateway",
  "providerType": "pi_compat",
  "piAuthProvider": "openai",
  "authType": "bearer_token",
  "baseUrl": "https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1",
  "defaultModel": "tgpt/deepseek-v4-flash-0731",
  "createdAt": 1737451800000
}
```

### Claude Code runtime (gateway one-click)

```json
{
  "slug": "claude-gateway",
  "name": "Claude Code (Nessy Gateway)",
  "providerType": "claude-runtime",
  "authType": "api_key_with_endpoint",
  "baseUrl": "https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1",
  "defaultModel": "tgpt/deepseek-v4-flash-0731",
  "createdAt": 1737451800000
}
```

### Codex runtime (gateway one-click)

```json
{
  "slug": "codex-gateway",
  "name": "Codex (Nessy Gateway)",
  "providerType": "codex-runtime",
  "authType": "api_key_with_endpoint",
  "baseUrl": "https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1",
  "defaultModel": "tgpt/deepseek-v4-flash-0731",
  "createdAt": 1737451800000
}
```

Since 1.25.1, agents you define (or install with a plugin) are registered with
every Codex session as Codex agent roles, so the model can start them by name —
the same definitions Pi and the Claude runtime dispatch. An agent that declares
its own tool list or permission mode cannot be expressed as a role (Codex has
no per-role tool policy) and is left out with the reason in the session log.

### Custom runtime endpoint (BYO, either runtime)

```json
{
  "slug": "codex-custom",
  "name": "Codex (Custom Endpoint)",
  "providerType": "codex-runtime",
  "authType": "api_key_with_endpoint",
  "baseUrl": "https://llm-proxy.internal.example.com/v1",
  "defaultModel": "deepseek-v3",
  "models": ["deepseek-v3", "deepseek-r1"],
  "createdAt": 1737451800000
}
```

A keyless loopback endpoint (local Ollama-class) is the same shape with
`"authType": "none"` and no stored credential; `claude-custom` /
`providerType: "claude-runtime"` is the Claude Code twin.

### Anthropic (API key)

```json
{
  "slug": "anthropic-api",
  "name": "Anthropic (API Key)",
  "providerType": "anthropic",
  "authType": "api_key",
  "defaultModel": "claude-sonnet-4-6",
  "createdAt": 1737451800000
}
```

### Claude subscription (OAuth)

```json
{
  "slug": "claude-max",
  "name": "Claude Pro/Max",
  "providerType": "anthropic",
  "authType": "oauth",
  "createdAt": 1737451800000
}
```

### ChatGPT Plus on Pi (OAuth)

The **ChatGPT Plus (Pi)** card: the Pi agent on your ChatGPT subscription. The
card was titled "Codex · ChatGPT Plus" before 1.41.0; the connection it saves
is still named `ChatGPT Plus`.

```json
{
  "slug": "chatgpt-plus",
  "name": "ChatGPT Plus",
  "providerType": "pi",
  "piAuthProvider": "openai-codex",
  "authType": "oauth",
  "modelSelectionMode": "automaticallySyncedFromProvider",
  "createdAt": 1737451800000
}
```

### ChatGPT on the Codex runtime (OAuth)

The **ChatGPT (Codex)** card — see [ChatGPT (Codex)](#chatgpt-codex). The
connection also carries Codex's model list (`models`), omitted here.

```json
{
  "slug": "chatgpt-codex",
  "name": "ChatGPT (Codex)",
  "providerType": "codex-runtime",
  "authType": "oauth",
  "codexModelProvider": "openai",
  "defaultModel": "gpt-6.1-sol",
  "createdAt": 1737451800000
}
```

### Local Ollama (custom endpoint)

```json
{
  "slug": "ollama",
  "name": "Ollama",
  "providerType": "pi_compat",
  "authType": "none",
  "baseUrl": "http://localhost:11434/v1",
  "customEndpoint": { "api": "openai-completions" },
  "models": [
    { "id": "gemma4", "contextWindow": 262144, "supportsImages": true },
    { "id": "qwen3-coder", "contextWindow": 131072 }
  ],
  "defaultModel": "qwen3-coder",
  "createdAt": 1737451800000
}
```

## Custom endpoint capabilities

Custom endpoints cannot be probed, so they default to a **131,072-token context
window**, an **8,192-token max output**, and **text-only** input. Raise those
explicitly.

Use per-model objects when one endpoint hosts a mix of models:

```json
{
  "customEndpoint": { "api": "openai-completions" },
  "models": [
    { "id": "gemma4", "contextWindow": 262144, "supportsImages": true },
    { "id": "qwen3-coder", "contextWindow": 131072 }
  ]
}
```

Or opt an entire endpoint into image input at once:

```json
{
  "customEndpoint": {
    "api": "openai-completions",
    "supportsImages": true
  }
}
```

::: info
Nessy Desktop never guesses image support. A model-level setting wins over the
endpoint-wide one, so `supportsImages: false` on a single model turns vision off
for it even against an endpoint default of `true`. Models given as bare strings
retain the text-only, 131,072-token defaults.
:::

For the UI toggle and pre-flight banner, see
[Custom Endpoints → Image input](/reference/config/custom-endpoint#image-input-for-custom-endpoints).

## Pi web search engine

On a Pi connection, `web_search` picks its engine from the connection:

- **The provider's own search** — OpenAI (an `openai` API key), ChatGPT (an
  `openai-codex` ChatGPT sign-in), OpenRouter, or Google (Gemini with Google
  Search grounding) — only when the connection talks to that provider's own
  public API: it has no base URL of its own, or its base URL's host is exactly
  that provider's API host (`api.openai.com`, `chatgpt.com`, `openrouter.ai`,
  `generativelanguage.googleapis.com`). The search then goes to the host the
  connection's model calls already use, with the same credential.
- **DuckDuckGo** in every other case: the Nessy Gateway card, every custom
  endpoint (llm-proxy and other OpenAI-compatible servers included), a base URL
  on any other host, and one that cannot be read. DuckDuckGo needs no key, so
  the connection's credential is never sent to a search host its model calls do
  not already use.

If the provider's own search fails, the same query runs on DuckDuckGo and the
result says so. Each result names its engine (`via DuckDuckGo`). The app's own
`web_search` that Claude Code and Codex sessions get always searches
DuckDuckGo. [`NESSY_WEB_SEARCH_ALLOWED_DOMAINS`](/reference/config/environment-variables#nessy-web-search-allowed-domains)
and [`NESSY_MAX_WEB_SEARCHES_PER_SESSION`](/reference/config/environment-variables#nessy-max-web-searches-per-session)
apply whichever engine answers.

## Mid-stream behaviour

If a new message goes out mid-turn — the agent is still streaming its previous
reply — `midStreamBehavior` on the connection picks between folding it into the
running turn and parking it for the next one.

| Value     | Behaviour                                                                                |
| --------- | ---------------------------------------------------------------------------------------- |
| `"steer"` | Deliver the message into the current turn (Pi's and Codex's native steer, or Claude hook injection). |
| `"queue"` | Hold the message, let the current turn finish, then replay it as a new turn.             |

Whichever value is set, a message that carries attachments is always queued:
a steer carries text only, so the files ride the next turn with the message.

```json
{
  "slug": "anthropic-api",
  "providerType": "anthropic",
  "authType": "api_key",
  "midStreamBehavior": "queue",
  "createdAt": 1737451800000
}
```

### Defaults by backend

When `midStreamBehavior` is omitted, the default follows the provider type:

- **`pi` / `pi_compat`** → `"steer"`. Steering is native here and loses nothing:
  once the running tool wraps up, your message goes in with the whole
  conversation still intact.
- **`codex-runtime`** → `"steer"`. Native as well, and stricter than Pi's in a
  useful way: the runtime's own steer call carries the id of the turn it is meant
  for, so a correction aimed at a turn that has already moved on is refused by the
  runtime rather than mis-applied. Two turn kinds decline steering outright — a
  review and a compaction — and a message refused for either reason is queued
  instead of dropped.
- **`anthropic` / `claude-runtime`** → `"steer"` (since 2026-08-17). The Claude
  backend emulates steering: the message is handed to the model at its next tool
  call. When no tool call comes, the message is re-queued and replayed as the next
  turn, so nothing is lost; the cost is the tokens of the turn that ran first.
  Connections created before the change still carry `"queue"`, as the paragraph
  below explains.
- **`nestor-cloud-agent`** → `"queue"`. The remote agent exposes no mid-turn
  delivery at all.

**A default only applies to a connection that has no stored value, and a
connection normally has one.** The value is written when the connection is
created, so a default that changes in a later release does not reach connections
you already have — deliberately: the stored value carries no record of whether it
came from a default or from you, and rewriting it would silently overturn a real
choice. To take a new default on an existing connection, set it yourself in the
UI below.

### Changing it from the UI

Open **Settings → AI**, find the connection under **Connections**, open its
menu, and choose the mid-stream option. It is a per-connection setting and takes
effect on the next mid-stream send. For the user-facing walkthrough, see
[Interactions → sending while the agent is responding](/core-concepts/interactions#sending-while-the-agent-is-responding).

## Managing connections

Connections are managed under **Settings → AI**: add, edit, and delete
connections, and set the global default.

::: info
The corporate Nessy Gateway connection has no **Edit** entry — its edit form
would expose the stored gateway JWT and there is nothing to configure by hand
(auth is one-click). **Reconnect**, which re-runs that one-click sign-in without
opening any form, Rename, Validate, Mid-stream sends, and Delete remain
available. Re-running the gateway card refreshes the connection in place.
:::

### Testing a connection you are editing

When you edit a connection that has a saved API key, the key field shows the key
masked — its first seven characters, a row of dots and its last four (a short key
shows dots only). The key itself never reaches the window.

You can test the connection without typing the key again: a test sent with the
masked value uses the key stored for that connection, looked up by the app. A key you type replaces it for the test. If the
app cannot use a stored key, the test says so instead of passing or being
skipped:

- "No API key is stored for this connection. Re-enter the key to test it." — the
  connection has no saved key.
- "Re-enter the API key to test this connection." — the masked value arrived
  without the connection it belongs to.

This applies to every connection card with a key field — Pi, Claude Code and
Codex alike — because the test runs in the app, not in the runtime.

## When a credential expires

When a connection's credential stops working mid-chat — a subscription's OAuth
token expires, a stored key is revoked, the runtime reports an invalid or
suspended credential — the chat shows one card carrying the reason and a single
**Sign in** button, on every runtime. The button opens **Settings → AI** with the
connection that failed already selected, so an app with several connections does
not leave you to work out which one to fix.

This replaced two different behaviours. On Claude Code the same failure used to
arrive as a typed error whose only action was a link to the settings page; on Pi
it arrived as a line in the transcript with no action at all. The corporate Nessy
Gateway card has its own sign-in card of the same shape — see
[Gateway sign-in troubleshooting](credentials#gateway-sign-in-troubleshooting).
