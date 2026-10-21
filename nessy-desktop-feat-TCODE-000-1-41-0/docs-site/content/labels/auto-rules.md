# Label Auto-Apply Rules

Auto-rules watch what you type and tag the session for you. Attach a regex to any label, and whenever a user message matches, the label is applied with the value the pattern extracted — paste a ticket URL and the session picks up the issue key, mention a date and a deadline label appears.

A rule can also be a yes/no question that the [decision model](../core-concepts/decision-model) answers, so a label is applied by meaning rather than by pattern — see [Semantic Rules](#semantic-rules).

## Configuration

Rules live in the `autoRules` array of a label in `labels/config.json`:

```json
{
  "id": "ticket",
  "name": "Ticket",
  "color": "info",
  "valueType": "string",
  "autoRules": [
    {
      "pattern": "jira\\.example\\.com/browse/([A-Z]+-\\d+)",
      "valueTemplate": "$1",
      "description": "Issue-tracker URLs"
    },
    {
      "pattern": "\\b([A-Z]{2,5}-\\d+)\\b",
      "valueTemplate": "$1",
      "description": "Bare keys like NES-123"
    }
  ]
}
```

Two rules on one label means two ways to trigger it — here, either the full URL or a bare key tags the session with `ticket::NES-123`.

## Rule Properties

| Property        | Type   | Required | Description                                                                                  |
| --------------- | ------ | -------- | -------------------------------------------------------------------------------------------- |
| `pattern`       | string | Yes      | JavaScript-syntax regex, usually with capture groups                                          |
| `flags`         | string | No       | Regex flags; defaults to `gi`. The `g` flag is added automatically if you leave it out.       |
| `valueTemplate` | string | No       | Builds the value from `$1`, `$2`, … If absent, the first capture group is used — or the whole match when the pattern has no groups. |
| `description`   | string | No       | A note to your future self about what the rule catches                                        |

## Patterns And Capture Groups

Capture groups are how a rule pulls the interesting part out of the surrounding text. `valueTemplate` can combine several of them:

```json
{
  "pattern": "gitlab\\.example\\.com/([\\w./-]+)/-/merge_requests/(\\d+)",
  "valueTemplate": "$1!$2",
  "description": "Merge request URLs → project!number"
}
```

Substitution is a single pass, so captured text that happens to contain `$1` is inserted literally rather than re-expanded. Because matching is always global, one message can produce several values — "fix NES-1 and NES-2" yields both `ticket::NES-1` and `ticket::NES-2`. A pattern with no capture groups is legal (the full match becomes the value), but the validator flags it with a warning since it is usually an oversight.

## Evaluation Behavior

### When rules run

Every rule in the workspace is evaluated each time a user message is sent — including messages that were queued while the agent was busy. Only your messages are scanned; agent output and tool results never trigger rules.

### Code is ignored

Fenced code blocks and inline backtick spans are removed before matching, so an issue key inside a pasted stack trace or example snippet does not tag the session.

### The whole tree participates

Rules are collected from every label, including deeply nested children, in tree order.

### Deduplication

Within one evaluation, identical label + value pairs collapse to one. Against the session, an entry that already exists is never added twice: once `ticket::NES-123` is on the session, repeating the key in later messages changes nothing.

### Match cap

At most **10** auto-label matches are applied per message. This keeps a pasted log file with two hundred issue keys from burying the session in tags.

### Bad patterns fail soft

A rule whose regex fails to compile is skipped at runtime with a logged warning — it never blocks the message. Save-time validation exists precisely so you notice before that happens.

## Value Normalization

After extraction, the value is normalized according to the label's `valueType`:

| `valueType` | Raw capture   | Stored value | What happened                          |
| ----------- | ------------- | ------------ | -------------------------------------- |
| `string`    | `NES-123`     | `NES-123`    | Passed through                         |
| `number`    | `$45,000`     | `45000`      | Currency symbol and commas stripped    |
| `number`    | `1.5M`        | `1500000`    | `k`/`M`/`B` suffix expanded            |
| `number`    | `50k`         | `50000`      | Suffix expanded                        |
| `date`      | `2026-01-30`  | `2026-01-30` | Passed through (capture ISO dates)     |
| `link`      | ` https://…`  | `https://…`  | Surrounding whitespace trimmed         |

Auto-applied entries are always stored in valued form (`label::value`), with the value coming from the template or the match itself.

## Semantic Rules

A regex finds text. A semantic rule asks a yes/no question about the message instead, and the [decision model](../core-concepts/decision-model) answers it. It applies only while the decision model is on and its **Semantic label rules** switch is on (the switch is on by default once the decision model is):

```json
{
  "id": "billing",
  "name": "Billing",
  "color": "info",
  "autoRules": [
    { "semantic": "Is the user asking about billing or invoices?", "threshold": 0.9 }
  ]
}
```

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `semantic` | string | Yes, for a semantic rule | The yes/no question, up to 500 characters. English questions work best. |
| `threshold` | number | No | The "yes" probability needed to apply the label, above 0 and at most 1. Defaults to `0.9`, deliberately high because a `LabelAdd` automation may react to the label. |
| `value` | string | No | A fixed value for a valued label. On a plain label it is ignored, with a warning when the config is validated. |
| `description` | string | No | A note about what the rule catches |

How they run:

- Every message you send is checked, code blocks removed and cut to its first 8,000 characters. A message shorter than 20 characters is not checked.
- A label the session already has is not asked about again — `billing`, `billing::` and `billing::Invoice` all count as having it.
- Semantic rules add at most 10 labels per message, like regex rules.
- The check runs beside the message and never delays it; the label appears when the answer arrives.
- With the decision model off or unreachable, semantic rules do nothing and only regex rules apply.

::: warning
While a workspace has a semantic rule and the decision model is on, every message you send there goes to the decision model's provider. Choose a local provider if that matters — see [What is sent, and what is kept](../core-concepts/decision-model#what-is-sent-and-what-is-kept).
:::

## Full Example

A workspace that tracks tickets, deadlines, contacts, and money mentioned in conversation:

```json
{
  "version": 1,
  "labels": [
    {
      "id": "ticket",
      "name": "Ticket",
      "color": "info",
      "valueType": "string",
      "autoRules": [
        { "pattern": "jira\\.example\\.com/browse/([A-Z]+-\\d+)", "valueTemplate": "$1", "description": "Tracker URLs" },
        { "pattern": "\\b([A-Z]{2,5}-\\d+)\\b", "valueTemplate": "$1", "description": "Bare keys" }
      ]
    },
    {
      "id": "deadline",
      "name": "Deadline",
      "color": { "light": "#EA580C", "dark": "#FB923C" },
      "valueType": "date",
      "autoRules": [
        { "pattern": "(\\d{4}-\\d{2}-\\d{2})", "valueTemplate": "$1", "description": "ISO dates" }
      ]
    },
    {
      "id": "contact",
      "name": "Contact",
      "color": "accent",
      "valueType": "string",
      "autoRules": [
        { "pattern": "([\\w.+-]+@[\\w.-]+\\.[a-zA-Z]{2,})", "valueTemplate": "$1", "description": "Email addresses" }
      ]
    },
    {
      "id": "cost",
      "name": "Cost",
      "color": "success",
      "valueType": "number",
      "autoRules": [
        { "pattern": "\\$([\\d,.]+[kKmMbB]?)", "valueTemplate": "$1", "description": "Dollar amounts" }
      ]
    }
  ]
}
```

With this in place:

- pasting `https://jira.example.com/browse/NES-456` adds `ticket::NES-456`
- writing `ship by 2026-03-15` adds `deadline::2026-03-15`
- mentioning `ping alice@example.com about it` adds `contact::alice@example.com`
- noting `the quote came in at $50k` adds `cost::50000`

## Validation

::: warning
Run validation after adding or changing rules. Patterns are checked when the config is saved: syntax errors are rejected outright, and nested-quantifier constructs like `(a+)+` — the classic catastrophic-backtracking shape — are refused because a hostile input could hang matching.
:::

Label configs, auto-rules included, are validated as part of the full sweep:

```
config_validate({ target: "all" })
```

## Keeping Rules Sane

Prefer narrow, anchored patterns over clever ones: a rule that fires on `\b[A-Z]{2,5}-\d+\b` is predictable, while a loose pattern quietly tags half your sessions. If [automations](../automations/overview) react to the labels a rule produces, test the pattern on a few realistic messages before trusting it for routing.
