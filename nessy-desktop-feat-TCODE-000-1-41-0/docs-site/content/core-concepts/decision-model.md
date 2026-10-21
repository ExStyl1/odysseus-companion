# Decision Model

The decision model is an optional helper that answers short typed questions with probabilities: "is this message a correction or a new request?", "which of these labels fits?", "did this reply finish the job?". It is a classifier, not a chat model. It never writes prose, never calls a tool and never runs anything. Nessy Desktop asks it at a few points you choose and treats every answer as advice.

It is **off by default**. While it is off, nothing is sent anywhere and every feature on this page behaves exactly as it did before the decision model existed.

## Turning It On

Open **Settings → AI → Decision model (Jev)**:

1. Switch on **Enable decision model**.
2. Pick a **Provider** (see the table below). For a hosted provider, paste its API key and press **Save key**, or choose **Use key from …** to reuse the key of an OpenRouter or Vercel AI Gateway connection you already have.
3. Press **Test** under **Connection test**. It sends one fixed yes/no question and shows the model and the latency, or the reason it failed. The test works before the switch is on, so you can check a provider first.
4. Open **Advanced settings** and choose what the decision model is used for.

The key is stored encrypted in the local credential vault, never in `config.json`.

## Providers

| Provider | Address | Key | Where your text goes |
| --- | --- | --- | --- |
| TypeSafe AI (direct) | `https://api.typesafe.ai` | required | TypeSafe's hosted service |
| OpenRouter | `https://openrouter.ai/api` | required; an OpenRouter connection's key can be reused | OpenRouter, then TypeSafe's model |
| Vercel AI Gateway | `https://ai-gateway.vercel.sh/typesafe` | required; a Vercel AI Gateway connection's key can be reused | Vercel, then TypeSafe's model |
| Laya (local, open source) | `http://127.0.0.1:8000` | optional | nowhere: it runs on your machine |
| Custom (Jev-compatible server) | the address you enter | optional | the server you point it at |

- **Laya** is an open-source (Apache 2.0) server you run yourself. The card shows the command that installs and starts it, `pip install "laya[serve]" && laya-serve`, checks whether it is reachable and lists the checkpoints it loaded. Press **Re-check** after you start it.
- **Custom** takes the base URL of any server that speaks the same protocol; `/v1/systemone` is added for you.
- Each preset pins a model id, so a provider cannot silently switch the model that answers. The model the provider reports is recorded next to the pinned one.
- **There is no Nessy Gateway provider.** The gateway serves chat models, not this kind of classifier. Your Nessy Gateway token is never sent to a decision provider: requests carry only the decision key you saved, or no key at all.
- Changing the provider clears the old provider's custom address and model, so a key is never sent to an address you set up for a different provider.

## What It Is Used For

Each use has its own switch under **Advanced settings**. Three are on by default because they act only when something asks for them; the rest change what the app does on its own, so they start off.

| Switch | Default | What an answer changes |
| --- | --- | --- |
| **Agent tool (decide)** | on | The agent gets a `decide` tool to classify, route or score items in one call — for example, sorting many messages into folders. Applies to new sessions. |
| **Task verdicts** | on | When a task's verifier forgets its `VERDICT:` line, a confident pass or fail is read from the reply and shown as inferred, with its probability. A real `VERDICT:` line always wins. |
| **Semantic label rules** | on | Labels with a yes/no question as their rule are applied by meaning. See [Label auto-apply rules](../labels/auto-rules#semantic-rules). |
| **Turn outcome** | off | An open chat session whose last reply needs you (a question, a blocker) moves to **Needs Review**, with the reason shown under its name. In a task run, a step that stalled or asked a question is not marked done. A status you set yourself, or a closed session, is never changed. |
| **Risk badges** | off | A permission card shows what the action does — deletes data, sends data out, publishes, touches secrets, changes the system, spends money. The buttons and your choice are unchanged. See [Risk badges](./permissions#risk-badges). |
| **Automation conditions** | off | An automation can carry a yes/no question that must hold before it starts a session. See [Automations](../automations/overview#semantic-condition). |
| **Targeted task repairs** | off | When a failed check does not say which steps broke, only the steps it points at, and the steps that depend on them, are repaired. |
| **Smarter titles** | off | Small talk such as "hi" gets no automatic title until you ask for something, and an automatic title that no longer fits is refreshed. A title you set is never touched. |
| **Mid-turn messages** | off | A message you send while the agent works is steered into the running turn or queued, per message. See [Sending while the agent is responding](./interactions#when-the-decision-model-decides). |
| **Skill and source suggestions** | off | Before a message is handled, the agent may get a one-turn hint naming one source that is set up but not active in this session and that your message plainly needs. Only sources are suggested: skills are already listed for the agent on every runtime. Nothing is activated for you; the agent decides, under your usual permissions. |

## What It Can Never Do

- **It never grants anything.** An answer can add information, add a step that waits for you, or choose between two behaviours the app already had. It never turns a permission card or a refusal into an allow.
- **No answer means no change.** A timeout, a network error, an error from the provider or a malformed answer all count as no answer, and the app then does what it would have done without the decision model.
- **It is quick or it is skipped.** Background checks wait 1.5 seconds by default (a provider that has been idle for a while gets a little longer on its first call). The two checks tied to a message you send — a source suggestion, and steering a mid-turn message — wait at most 3 seconds, and a mid-turn message is queued at once, so your send is never held up. The agent's `decide` tool waits up to 10 seconds.
- **Risk badges cannot approve.** A card waits for its badges for at most the background deadline. If the card can no longer be answered by the time they arrive — you already answered, the session stopped — the request is refused, never allowed.

## What Is Sent, and What Is Kept

Only the text a feature needs is sent, and only to the provider you chose:

- Semantic label rules: each message you send in a workspace that has such a rule, up to its first 8,000 characters, with code blocks removed. Messages under 20 characters are not checked, and a label the session already has is not asked about again.
- Turn outcome: the start of the request and the end of the reply.
- Risk badges: the tool name, the card's description and the command.
- Automation conditions: the event, its fields, and the session's latest user and assistant messages.
- Mid-turn messages: the request being worked on and your new message.
- Suggestions: your message and the names and descriptions of up to 60 inactive sources.
- The `decide` tool: whatever the agent passes to it.

Every check is written to `logs/decisions.jsonl` in the configuration directory with the feature, the provider, the model, the probabilities and the timing. The text that was sent is **not** stored: only its fingerprint and size. A provider's error text is not stored either, because it can echo the request. The log keeps one previous file once it passes 10 MiB.

Under each switch, the card shows the last seven days: how many checks ran, how many changed something and how many failed. After 30 answered checks that changed nothing, it says so, so a feature that does nothing for you is easy to spot and turn off.

## When Changes Take Effect

- The background features read the switches on every check, so turning one on or off applies from the next check.
- The **decide** tool is offered when a session's agent starts, so turning it on reaches new sessions. On Codex the tool list is fixed when the thread starts. Turning the decision model off applies at once: a session that still lists the tool gets a "not enabled" answer and nothing is sent.

## On Each Runtime

Everything above runs in the app, not in the agent runtime, so a Pi, a Claude Code and a Codex session get the same behaviour. The `decide` tool is offered on all three; on Codex it reaches the app through the same bridge as the other session tools.

## Remote Clients and the Headless Server

Only a window of the desktop app on this computer can choose where your text goes: the provider, the base URL, the reused connection and the key. A remote client, the [terminal client](../reference/cli) included, can read the settings and switch the decision model and its features on or off, but a request to change the destination or the key is refused.

A headless server has no window, so its provider, address and key are set by its operator in that server's `config.json`, under `decisionLayer`:

```json
{
  "decisionLayer": {
    "enabled": true,
    "provider": "laya",
    "baseUrl": "http://127.0.0.1:8000",
    "features": { "semanticLabels": true, "turnOutcome": false }
  }
}
```

`provider` is one of `typesafe`, `openrouter`, `vercel-ai-gateway`, `laya` and `custom`. A switch you leave out keeps its default.
