# Custom Endpoints

Помимо встроенного Nessy Gateway, Nessy Desktop можно направить на любой
OpenAI-compatible или Anthropic-compatible model endpoint — self-hosted proxy,
local runtime вроде Ollama или vLLM либо internal gateway. Custom endpoints
работают через Pi backend как `pi_compat` connection.

Полную schema connection и больше примеров см. в
[LLM Connections](llm-connections).

## Как настраивается custom endpoint

Custom endpoint — это LLM connection с `providerType: "pi_compat"`, `baseUrl` и
`customEndpoint.api`, который выбирает wire format:

| Field                      | Description                                                                 |
| -------------------------- | --------------------------------------------------------------------------- |
| `baseUrl`                  | Full base URL of the endpoint                                               |
| `customEndpoint.api`       | Wire format: `"openai-completions"` or `"anthropic-messages"`               |
| `customEndpoint.supportsImages` | Endpoint-wide image-input default (optional)                           |
| `authType`                 | `"api_key"`, `"api_key_with_endpoint"`, `"bearer_token"`, or `"none"`       |
| `models`                   | Optional explicit model list (strings or objects with capability overrides) |
| `defaultModel`             | Default model for the connection                                            |

Capabilities custom endpoint нельзя определить автоматически, поэтому Nessy
Desktop применяет осторожные defaults: **131,072-token context window**,
**8,192-token max output** и **text-only** input. Увеличивайте их per-model или
endpoint-level overrides.

## Чтение списка моделей эндпоинта

OpenAI-совместимый эндпоинт обычно отдаёт `GET {baseUrl}/models`. В форме
подключения кнопка **Fetch models** читает этот список и показывает его
сгруппированным по семействам провайдеров, с поиском. Ключ отправляется как
`Authorization: Bearer`, если он у подключения есть, и не отправляется вовсе, если его нет — локальный эндпоинт
без авторизации работает как прежде.

Возвращается **каталог, а не список доступного вам**. Общий шлюз обычно
публикует куда больше моделей, чем достаёт любой отдельный ключ, поэтому список
подписан как «что публикует эндпоинт», а не «что вам доступно».

### Отметки доступности

Каталог показывается сразу, а затем каждая строка проверяется в фоне —
порциями, потоком, так что список не ждёт проверки. Проверка — один
непотоковый запрос с `max_tokens: 1`, и строка получает отметку по ответу:

| Отметка | Что означает |
| --- | --- |
| *Your key reaches this model* | эндпоинт ответил |
| *Published, but your key has no quota for it* | модель в каталоге есть, у ключа на неё нет квоты |
| *This model does not answer on this protocol* | эндпоинт отказал самому протоколу, а не ключу |
| *The check failed* | проверку не удалось выполнить |
| *Only available on the Claude Code runtime* | модель доступна, но на wire Anthropic — см. ниже |

Недоступные модели сворачиваются в одну группу и не выбираются. Выбор
показывается чипсами; **первый** чипс — модель по умолчанию, а клик по чипсу
переносит его вперёд, поэтому показанное и сохранённое не могут разойтись.

### Модели на wire Anthropic

Часть моделей общего прокси отвечает только на `POST /v1/messages`, а не на
`POST /chat/completions`. Если модель отказала на wire OpenAI, проверка
**спрашивает второй wire** прежде чем делать вывод — отказ на одном протоколе
ничего не говорит о другом. Ответившая там модель записывается с
`wire: "anthropic-messages"` и на runtime Claude Code маршрутизируется
в `/v1/messages` по каждому запросу; на runtime Pi и Codex она показана
неактивной с этой причиной, а не выглядит сломанной.

### Автообновление данных о моделях

Подключение, созданное через эту форму, автоматически участвует в стартовом
обновлении не чаще раза в 24 часа: обновляются `contextWindow` и `description`
уже выбранных вами моделей. Переключателя нет: поддерживать метаданные
актуальными — не то решение, которое стоит передавать пользователю. Это слияние
по ключу, и это сделано намеренно:

- модели, которые вы не выбирали, **не добавляются**, даже если они есть в каталоге;
- выбранные модели, пропавшие на стороне сервера, **не удаляются**, чтобы
  активная сессия не потеряла свою модель на ходу;
- сам список, модель по умолчанию и записанный wire модели — ваши, обновление их
  не переписывает.

Участие фиксируется полем `modelsSyncedAt`. Форма также сохраняет то, что
показала: размер контекста из каталога записывается в подключение при
сохранении, поэтому новое подключение полно ещё до первого обновления. В
обновлении каталога участвуют только эндпоинты `openai-completions`: у ответа в
формате Anthropic нет размера контекста, сливать было бы нечего. Размер контекста
меньше 4096 токенов считается отсутствующим и не записывается — в некоторых
каталогах там стоит заглушка, а окно в 1 токен ломает арифметику автосжатия.

## Scope rule для Nessy Gateway

Nestor-specific request handling — rewrite `Authorization: Bearer <jwt>` в
header `Nestor-Token` — применяется **только** к URLs, начинающимся с точного
gateway prefix:

```
https://code-completion-nestor.tcsbank.ru/api/v1/cli/
```

Любой другой endpoint сохраняет стандартную provider auth. Это касается и
custom endpoint на том же host, но с другим path — например личного corporate
account по другому route — который продолжит отправлять token как
`Authorization: Bearer`. См. [Network Proxy](network-proxy) и заметки о gateway
в [LLM Connections](llm-connections#nessy-gateway).

## Image input для custom endpoints

Custom endpoints по умолчанию **text-only**. Nessy Desktop не может опросить
endpoint и узнать, принимает ли model images, и не угадывает: если model тихо
отбросит attachment, ответ будет сбивать с толку — картинка видна в вашем
message, но model ее не увидела. Поэтому image input для model включается
вручную.

### Toggle из model picker (рекомендуется)

Для повседневного использования включайте image support прямо в chat input:

1. Раскройте model list из chat input.
2. У каждой model на custom-endpoint (`pi_compat`) connection есть маленький
   image glyph: тусклый, пока input выключен, и активный после включения.
3. Нажатие на glyph переключает `supportsImages` override этой model и сразу
   сохраняет его в config.

Если attached image отправляется в model, которая все еще text-only, над chat
input появляется inline banner с кнопкой **Enable image support**. Один клик
ставит тот же override и убирает banner — уже прикрепленная image остается на
месте.

::: info
Picker glyph и banner меняют только **per-model** flag
(`models[i].supportsImages`). Endpoint-wide counterpart
(`customEndpoint.supportsImages`) не имеет UI control — его задают в JSON.
:::

### JSON config (automation / advanced)

Для headless runs или когда нужно включить images для всего model roster endpoint
за один раз, редактируйте connection JSON напрямую.

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
Per-model setting важнее endpoint-wide default, поэтому
`supportsImages: false` на одной model выключает vision для нее, даже если
endpoint default остается `true`. Models, записанные bare strings, получают
text-only, 131,072-token defaults.
:::

## Пример CLI

[CLI](../cli) может обращаться к custom endpoint напрямую. Передайте key через
`--api-key` или environment variable `LLM_API_KEY`:

```bash
LLM_API_KEY="$JWT" bun run apps/cli/src/index.ts run \
  --provider openai \
  --base-url https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1 \
  "Reply with pong"
```

## Troubleshooting

**Connection fails.** Проверьте, что base URL доступен с вашей машины и endpoint
говорит на wire format, выбранном в `customEndpoint.api`.

**Model not found.** Проверьте, что model id точно совпадает с ожиданиями
endpoint и есть в connection `models` list, если вы задали его вручную.

**Images are ignored.** Model все еще text-only. Включите image support через
picker icon, pre-flight banner или `supportsImages` override.
