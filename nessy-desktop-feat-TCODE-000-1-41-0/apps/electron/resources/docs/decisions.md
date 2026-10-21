# Decision Model

The decision model is a classifier you can point at text: you give it a piece of
**state** and typed **questions**, and it answers with **probabilities**, not
prose, in a fraction of a second. Nessy Desktop uses it for optional helper
judgements (inferring a task verdict, semantic labels, risk badges on
permission cards, and the `decide` tool an agent can call). It is **off by
default**; you enable it in **Settings > AI > Decision model**.

Rule of thumb: if the answer is **one of a fixed set of options, a level on a
rubric, or yes/no**, the decision model fits. If the answer is **words**
(summaries, drafts, explanations), use the chat model instead.

## Providers

All providers speak the same wire format (`POST {base}/v1/systemone`); they
differ in base URL, model id and how the key is issued:

| Provider | Where it runs | Key |
|----------|---------------|-----|
| TypeSafe AI (direct) | hosted | TypeSafe API key |
| OpenRouter | hosted | OpenRouter key (a stored OpenRouter connection's key is reused) |
| Vercel AI Gateway | hosted | AI Gateway key (a stored Vercel AI Gateway connection's key is reused) |
| Laya (local, open source) | your machine (`127.0.0.1:8000` by default) | optional |
| Custom (Jev-compatible server) | your URL | optional for local servers |

A hosted provider receives session content (the state you send) only after you
configure a key and turn the layer on. With Laya or a custom local server
nothing leaves your machine. The gateway preset does not exist: the Nessy
gateway serves chat completions, not this classifier wire.

## Question types

- **choice** — pick one of 2–255 options; `criteria` maps option key →
  one-sentence description (`null` when the key speaks for itself). The answer
  carries the most likely option and the full probability distribution.
- **score** — place the state on an ordered rubric of 2–10 levels, lowest
  first. Describe levels as situations ("broken but a workaround exists"), not
  adjectives ("moderate").
- **noul** — a yes/no probability; optional `criteria: { "true": "…",
  "false": "…" }` sharpens the question.

`instructions` may be a sentence or a small object. English works best. A call
carries at most 64 questions, and the state is cut at about 96 KB before
sending (Laya's own cap is tighter: 48 KB).

## Reading answers

- `confidence` (0–1) says how concentrated the distribution is. Below 0.5 the
  model is unsure — report that, ask, or fall back to today's behaviour.
- Pick yes/no thresholds for the stakes: 0.5 when both answers are cheap,
  0.8+ when a false yes is expensive.
- Include an `other`/`unclear` option when your categories are not exhaustive.
- **An answer is never permission.** The decision layer can add friction or
  information; it never turns a permission prompt into an allow, and every
  caller keeps the behaviour the app had before the layer existed whenever the
  answer is missing, slow or failing.

## Privacy and records

The state you send goes to the provider you configured. Do not include
secrets, credentials, or file contents that were not meant to leave the
machine. Every call appends one JSON line to `CONFIG_DIR/logs/decisions.jsonl`
with the questions, the probabilities, both the pinned and the served model id,
and a **sha256 hash and byte count of the state — never the state text
itself**. When the log passes 10 MiB it rotates to `decisions.prev.jsonl`
(one previous file is kept). What the app then did with an answer, and what
later came of it, are recorded as outcome and follow-up lines keyed by the
call's id. The same file answers "what did the decision model change?" — see
`scripts/decisions-report.ts`.

## Where the settings live

Settings > AI > Decision model: the master switch (off by default), the
provider, the key, a connection test, and the per-feature switches. Turning
the layer off makes the app behave exactly as without it; nothing is gated
behind anything but this switch.
