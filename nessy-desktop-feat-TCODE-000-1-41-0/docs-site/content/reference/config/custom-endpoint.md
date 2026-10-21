# Custom Endpoints

Beyond the built-in Nessy Gateway, you can point Nessy Desktop at any
OpenAI-compatible or Anthropic-compatible model endpoint — a self-hosted proxy,
a local runtime such as Ollama or vLLM, or an internal gateway. Custom
endpoints run through the Pi backend as a `pi_compat` connection.

For the full connection schema and more examples, see
[LLM Connections](/reference/config/llm-connections).

## How a custom endpoint is configured

A custom endpoint is an LLM connection with `providerType: "pi_compat"`, a
`baseUrl`, and a `customEndpoint.api` that selects the wire format:

| Field                      | Description                                                                 |
| -------------------------- | --------------------------------------------------------------------------- |
| `baseUrl`                  | Full base URL of the endpoint                                               |
| `customEndpoint.api`       | Wire format: `"openai-completions"` or `"anthropic-messages"`               |
| `customEndpoint.supportsImages` | Endpoint-wide image-input default (optional)                           |
| `authType`                 | `"api_key"`, `"api_key_with_endpoint"`, `"bearer_token"`, or `"none"`       |
| `models`                   | Optional explicit model list (strings or objects with capability overrides) |
| `defaultModel`             | Default model for the connection                                            |

Custom endpoints cannot be probed for their capabilities, so Nessy Desktop
applies conservative defaults: a **131,072-token context window**, an
**8,192-token max output**, and **text-only** input. You raise those with
per-model or endpoint-level overrides.

## Reading the endpoint's model list

An OpenAI-compatible endpoint usually serves `GET {baseUrl}/models`. In the
connection form, **Fetch models** reads that list and shows it grouped by
provider family, with a search box. A key is sent as `Authorization: Bearer`
when the connection has one, and omitted entirely when it does not — a local endpoint that serves
`/models` unauthenticated works unchanged.

What comes back is a **catalog, not an entitlement list**. A shared gateway
commonly publishes far more models than any single key can reach, so the list
is presented as what the endpoint publishes and never as what is available to
you.

### Availability marks

The catalog is rendered first, and every row is then probed in the background —
in chunks, streaming, so the list never blocks on the check. Each probe is one
non-streaming `max_tokens: 1` request, and the row is marked with what came
back:

| Mark | Meaning |
| --- | --- |
| *Your key reaches this model* | the endpoint answered |
| *Published, but your key has no quota for it* | the catalog lists it, the key is not entitled to it |
| *This model does not answer on this protocol* | the endpoint refused the wire itself, not the key |
| *The check failed* | the probe could not be completed |
| *Only available on the Claude Code runtime* | reachable, but on the Anthropic wire — see below |

Unavailable models are collapsed into one group and cannot be selected. The
selection is written back as chips; the **first** chip is the default model, and
clicking a chip moves it to the front, so what the form shows and what it saves
cannot drift apart.

### Anthropic-wire models

Some models on a shared proxy answer only on Anthropic's `POST /v1/messages`
rather than on `POST /chat/completions`. When a model refuses the OpenAI wire,
the probe **asks the second wire** before concluding anything — a refusal on one
protocol is not evidence about the other. A model that answers there is recorded
with `wire: "anthropic-messages"` and is routed to `/v1/messages` per request on
the Claude Code runtime; on the Pi and Codex runtimes it is shown greyed out with
that reason, rather than appearing broken.

### Keeping model details up to date

A connection created through this form is enrolled automatically in a startup
refresh that runs at most once every 24 hours and updates `contextWindow` and
`description` for the models already in your list. There is no switch: keeping
metadata fresh is not a decision worth handing the user. It is a keyed merge,
deliberately:

- models you did not pick are **never added**, even when the catalog lists them;
- models you picked that vanished upstream are **never removed**, so a running
  session cannot lose its model mid-flight;
- the list itself, the default model and a model's recorded wire are yours — the
  refresh never rewrites them.

Enrollment is recorded as `modelsSyncedAt` on the connection. The form also
persists what it displayed — the context window it showed you is written into the
connection at save time, so a new connection is complete before the first refresh
is due. Only `openai-completions` endpoints are enrolled for the catalog refresh:
an Anthropic-shaped `/v1/models` reports no context length, so there would be
nothing to merge. A reported context window below 4,096 tokens is treated as
absent rather than written — some catalogs use a placeholder there, and a window
of 1 would poison the auto-compaction arithmetic.

## Scope rule for the Nessy Gateway

Nestor-specific request handling — rewriting `Authorization: Bearer <jwt>` into
the `Nestor-Token` header — applies **only** to URLs beginning with the exact
gateway prefix:

```
https://code-completion-nestor.tcsbank.ru/api/v1/cli/
```

Any other endpoint keeps standard provider auth. That includes a custom
endpoint on the same host but a different path — for example a personal
corporate account under a different route — which continues to send its token
as `Authorization: Bearer`. See [Network Proxy](/reference/config/network-proxy)
and the gateway notes in [LLM Connections](/reference/config/llm-connections#nessy-gateway).

## Image input for custom endpoints

Custom endpoints are **text-only by default**. Nessy Desktop cannot probe an
endpoint to learn whether a model accepts images, and it will not guess: a model
that quietly discards an attachment leads to baffling replies — the picture is
visible in your message, yet the model never saw it. So you turn image input on
for a model yourself.

### Toggle from the model picker (recommended)

For day-to-day use, flip image support directly in the chat input:

1. Expand the model list from the chat input.
2. Every model on a custom-endpoint (`pi_compat`) connection carries a small
   image glyph next to it: dimmed while input is off, lit once it is on.
3. Tapping that glyph toggles the model's `supportsImages` override and saves it
   to your config right away.

Attaching an image to a still-text-only model raises an inline banner over the
chat input offering an **Enable image support** button. One click sets the same
override and clears the banner — the image you already attached stays put.

::: info
The picker glyph and the banner both touch nothing but the **per-model** flag
(`models[i].supportsImages`). Its endpoint-wide counterpart
(`customEndpoint.supportsImages`) has no control in the UI — you set it in JSON.
:::

### JSON config (automation / advanced)

For headless runs, or when you want an endpoint's whole model roster to accept
images in one go, edit the connection JSON directly.

**Per-model opt-in:**

```json
{
  "customEndpoint": { "api": "openai-completions" },
  "models": [
    { "id": "gemma4", "contextWindow": 262144, "supportsImages": true },
    { "id": "qwen3-coder", "contextWindow": 131072 }
  ]
}
```

**Whole-endpoint opt-in:**

```json
{
  "customEndpoint": {
    "api": "openai-completions",
    "supportsImages": true
  }
}
```

::: info
A per-model setting beats the endpoint-wide default, so setting
`supportsImages: false` on a single model disables vision for it even while the
endpoint default stays `true`. Models written as bare strings fall back to the
text-only, 131,072-token defaults.
:::

## CLI example

The [CLI](/reference/cli) can target a custom endpoint directly. Provide the key
via `--api-key` or the `LLM_API_KEY` environment variable:

```bash
LLM_API_KEY="$JWT" bun run apps/cli/src/index.ts run \
  --provider openai \
  --base-url https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1 \
  "Reply with pong"
```

## Troubleshooting

**Connection fails.** Confirm the base URL is reachable from your machine and
that the endpoint speaks the wire format you selected in `customEndpoint.api`.

**Model not found.** Check that the model id matches exactly what the endpoint
expects, and that it appears in the connection's `models` list if you supplied
one.

**Images are ignored.** The model is still text-only. Enable image support from
the picker icon, the pre-flight banner, or a `supportsImages` override.
