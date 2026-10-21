# Label Auto-Apply Rules

Auto-rules следят за тем, что вы печатаете, и tag session за вас. Прикрепите regex к label, и каждый раз, когда user message matches, label applied with value, extracted by pattern — вставьте ticket URL, и session получит issue key; упомяните date, и появится deadline label.

Правило может быть и вопросом «да/нет», на который отвечает [модель решений](../core-concepts/decision-model), — тогда метка ставится по смыслу, а не по шаблону: см. [Семантические правила](#семантические-правила).

## Configuration

Rules живут в array `autoRules` у label в `labels/config.json`:

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

Two rules on one label means two trigger paths — здесь full URL или bare key tags session with `ticket::NES-123`.

## Rule Properties

| Property | Type | Required | Description |
| -------- | ---- | -------- | ----------- |
| `pattern` | string | Yes | JavaScript-syntax regex, usually with capture groups |
| `flags` | string | No | Regex flags; defaults to `gi`. Flag `g` added automatically if omitted. |
| `valueTemplate` | string | No | Builds value from `$1`, `$2`, … If absent, first capture group is used — or whole match when pattern has no groups. |
| `description` | string | No | Note to future self about what rule catches |

## Patterns And Capture Groups

Capture groups вытягивают интересную часть из surrounding text. `valueTemplate` может combine several groups:

```json
{
  "pattern": "gitlab\\.example\\.com/([\\w./-]+)/-/merge_requests/(\\d+)",
  "valueTemplate": "$1!$2",
  "description": "Merge request URLs → project!number"
}
```

Substitution is single pass, so captured text containing `$1` inserted literally rather than re-expanded. Matching always global, поэтому one message can produce several values — "fix NES-1 and NES-2" yields both `ticket::NES-1` and `ticket::NES-2`. Pattern без capture groups legal (full match becomes value), but validator flags it with warning, since it is usually oversight.

## Evaluation Behavior

### When rules run

Every rule in workspace evaluated each time user message is sent — including messages queued while agent busy. Only your messages scanned; agent output and tool results never trigger rules.

### Code is ignored

Fenced code blocks and inline backtick spans removed before matching, so issue key inside pasted stack trace or example snippet does not tag session.

### The whole tree participates

Rules collected from every label, including deeply nested children, in tree order.

### Deduplication

Within one evaluation, identical label + value pairs collapse to one. Against session, existing entry never added twice: once `ticket::NES-123` is on session, repeating key later changes nothing.

### Match cap

At most **10** auto-label matches applied per message. This keeps pasted log file with two hundred issue keys from burying session in tags.

### Bad patterns fail soft

Rule whose regex fails to compile is skipped at runtime with logged warning — it never blocks message. Save-time validation exists so you notice before that happens.

## Value Normalization

After extraction, value normalized according to label's `valueType`:

| `valueType` | Raw capture | Stored value | What happened |
| ----------- | ----------- | ------------ | ------------- |
| `string` | `NES-123` | `NES-123` | Passed through |
| `number` | `$45,000` | `45000` | Currency symbol and commas stripped |
| `number` | `1.5M` | `1500000` | `k`/`M`/`B` suffix expanded |
| `number` | `50k` | `50000` | Suffix expanded |
| `date` | `2026-01-30` | `2026-01-30` | Passed through (capture ISO dates) |
| `link` | ` https://…` | `https://…` | Surrounding whitespace trimmed |

Auto-applied entries always stored in valued form (`label::value`), with value from template or match itself.

## Семантические правила

Regex находит текст. Семантическое правило вместо этого задаёт вопрос «да/нет» о сообщении, а отвечает на него [модель решений](../core-concepts/decision-model). Правило действует, только пока модель решений включена и в ней включён переключатель **Семантические правила меток** (он включён по умолчанию, как только включена модель решений):

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

| Свойство | Тип | Обязательно | Описание |
| --- | --- | --- | --- |
| `semantic` | string | Да, для семантического правила | Вопрос «да/нет», до 500 символов. Лучше всего работают вопросы на английском. |
| `threshold` | number | Нет | Вероятность ответа «да», нужная, чтобы поставить метку: больше 0 и не больше 1. По умолчанию `0.9` — намеренно высоко, потому что на метку может среагировать автоматизация `LabelAdd`. |
| `value` | string | Нет | Фиксированное значение для метки со значением. На простой метке игнорируется, а при проверке конфигурации выдаётся предупреждение. |
| `description` | string | Нет | Пояснение, что ловит правило |

Как они работают:

- Проверяется каждое ваше сообщение — без блоков кода и не длиннее первых 8000 символов. Сообщения короче 20 символов не проверяются.
- Про метку, которая у сессии уже есть, больше не спрашивают — `billing`, `billing::` и `billing::Invoice` одинаково считаются ею.
- Семантические правила, как и regex, добавляют не больше 10 меток на сообщение.
- Проверка идёт рядом с сообщением и никогда его не задерживает; метка появляется, когда приходит ответ.
- Если модель решений выключена или недоступна, семантические правила ничего не делают и работают только regex-правила.

::: warning
Пока в рабочем пространстве есть семантическое правило и модель решений включена, каждое ваше сообщение там уходит провайдеру модели решений. Если это важно, выберите локального провайдера — см. [Что отправляется и что хранится](../core-concepts/decision-model#что-отправляется-и-что-хранится).
:::

## Full Example

Workspace, tracking tickets, deadlines, contacts and money mentioned in conversation:

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
Run validation after adding or changing rules. Patterns checked when config saved: syntax errors rejected outright, and nested-quantifier constructs like `(a+)+` — classic catastrophic-backtracking shape — refused because hostile input could hang matching.
:::

Label configs, including auto-rules, validate as part of full sweep:

```
config_validate({ target: "all" })
```

## Keeping Rules Sane

Prefer narrow anchored patterns over clever ones: rule firing on `\b[A-Z]{2,5}-\d+\b` predictable, while loose pattern quietly tags half your sessions. If [automations](../automations/overview) react to labels produced by rule, test pattern on a few realistic messages before trusting it for routing.
