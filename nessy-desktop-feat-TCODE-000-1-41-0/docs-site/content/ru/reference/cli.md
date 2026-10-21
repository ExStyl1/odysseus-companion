# Справочник CLI

Nessy Desktop включает terminal client, говорящий по тому же WebSocket RPC protocol, что и desktop app. Он может подключиться к уже работающему [headless server](../server/headless) или — для one-shot prompts — поднять приватный server, выполнить prompt и всё убрать за собой.

Примеры вызывают checked-in entry point напрямую, чтобы они всегда совпадали с source tree:

```bash
bun run apps/cli/src/index.ts <command> [flags]
```

`cd apps/cli && bun link` регистрирует тот же entry point на вашем `PATH` как `nessy-general-agent` (имя бинаря — compatibility holdover из upstream codebase).

Эта страница описывает только client из `apps/cli`. [Headless server](../server/headless) — отдельный бинарь (`nessy-server`, из `packages/server`) со своими flags и environment variables, задокументированный на собственной странице.

## Quick Start

Полностью self-contained запуск против Nessy Gateway:

```bash
JWT=$(python3 -c "import json;print(json.load(open('$HOME/.nessy/dp_auth_creds.json'))['jwt'])")
bun apps/cli/src/index.ts run \
  --provider openai \
  --base-url https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1 \
  --api-key "$JWT" \
  --model tgpt/deepseek-v4-flash-0731 \
  --workspace-dir "$TMPDIR/ws" \
  --output-format stream-json \
  "What is 2+2?"
```

Настройка server не нужна: `run` поднимает его сам. Полный lifecycle — в [run](#run-one-shot-и-self-contained) ниже.

## Global Options

| Flag | Environment fallback | Default | Purpose |
| --- | --- | --- | --- |
| `--url <ws[s]://…>` | `NESSY_SERVER_URL` | — | WebSocket-адрес server |
| `--token <secret>` | `NESSY_SERVER_TOKEN` | — | Bearer token, предъявляемый при handshake |
| `--workspace <id>` | — | первый workspace | Workspace, с которым работает команда |
| `--timeout <ms>` | — | `10000` | Per-request RPC timeout |
| `--send-timeout <ms>` | — | `300000` | Сколько `send`/`run` ждут завершения turn |
| `--tls-ca <path>` | `NESSY_TLS_CA` | — | Дополнительный CA-сертификат для self-signed TLS (экспортируется как `NODE_EXTRA_CA_CERTS`) |
| `--json` | — | off | Machine-readable JSON output |
| `--agents <json>` | — | — | Зарегистрировать субагентов для этого запуска прямо из JSON, не создавая файлов: объект, ключами которого служат имена агентов, а значением — как минимум `prompt`. Учитывается в `run` и в `session create`, поэтому созданная заранее session получает тех же агентов. Форма самого флага проверяется до того, как будет поднят server; одна некорректная запись исключается и называется хостом, а не валит весь запуск. Администратор может запретить сам флаг managed-настройкой `disableSideloadFlags`: тогда запуск завершается на старте ошибкой, называющей флаг и ключ, ещё до подъёма server |
| `--safe-mode` | `NESSY_SAFE_MODE` | off | Старт без instructions files, skills, plugins, hooks, MCP servers, commands и agents — для диагностики сломанной конфигурации. Managed policy продолжает действовать |
| `--fallback-model <a,b,c>` | `NESSY_FALLBACK_MODEL` | — | Список моделей через запятую, которые пробуются по порядку, когда основная модель исчерпана; дубликаты убираются, длина ограничена тремя. Флаг важнее настройки `fallbackModel` и действует только на текущий turn — следующее сообщение снова начинает с основной модели |
| `--settings <path\|json>` | `NESSY_CLAUDE_SETTINGS` | — | Settings JSON file или inline JSON-строка. Заданные здесь значения переопределяют те же ключи в ваших `settings.json` на время этой сессии; ключи, которые вы не указали, сохраняют значения из файлов. Применяется на Claude runtime — выше user/project/local settings и ниже managed policy. Нечитаемый inline JSON отбрасывается с диагностикой, а не валит запуск |
| `--setting-sources <list\|none>` | `NESSY_CLAUDE_SETTING_SOURCES` | все три | Какие файловые settings загружает Claude runtime: подмножество `user`, `project`, `local` через запятую — или `none` для пустого списка, которому нужно отдельное слово, потому что пустое значение не переживает передачу в переменной окружения. Сужение объявляется: отказ от `project` заодно перестаёт загружать skills, commands и subagents из корней `--add-dir`, а отказ от `user` убирает ваши собственные permission-правила. Нераспознанное значение оставляет все три, а не читается как пустой список |
| `--no-spinner` | — | off | Убрать progress spinner (alias: `--disable-spinner`) |
| `--verbose`, `-v` | — | off | Показать stderr spawned server во время validation |
| `--help`, `-h` | — | — | Напечатать usage |
| `--version` | — | — | Напечатать версию CLI package |

Command-line flags имеют приоритет над своими environment fallbacks. Цвета и spinner выключаются автоматически, когда задан `NO_COLOR` или stdout не terminal.

`--safe-mode`, `--fallback-model`, `--settings` и `--setting-sources` доходят до агента через окружение того server, который CLI поднимает сама, поэтому они что-то значат только для двух команд, поднимающих server, — `run` и `--validate-server`. Передайте любой из них любой из этих команд вместе с `--url` — и запуск будет отклонён ещё до подключения, потому что server, который CLI не запускала, их никогда не увидит; см. [run](#run-one-shot-и-self-contained).

Несколько команд работают без адреса server: `run` и `--validate-server` поднимают собственный server (дайте любой из них `--url` — и она подключится к тому server вместо подъёма своего), а `doctor` и verbs `plugin` читают только локальное состояние и не стартуют server вовсе. Любая другая команда завершается с кодом 1, если не задан ни `--url`, ни `$NESSY_SERVER_URL`.

Когда `--workspace` не указан, CLI запрашивает у server список workspaces и привязывается к первой записи. Команды, которым нужен workspace (`sessions`, `sources`, `session create`), завершаются с кодом 1, если его нет.

## Команды

### Diagnostics

| Command | RPC channel | Output |
| --- | --- | --- |
| `ping` | только handshake | назначенный client id и round-trip latency |
| `health` | `credentials:healthCheck` | статус credential store |
| `versions` | `system:versions` | версии runtime, о которых сообщает server |

### doctor: проверка конфигурации

```bash
bun run apps/cli/src/index.ts doctor
bun run apps/cli/src/index.ts --json doctor | jq '.invalidManagedEntries'
```

Read-only диагностика установки и settings — без server, без session. Сообщает, какой managed settings source действует, каждую managed entry, не прошедшую validation (с её source и field), и каждый user settings layer, отклонённый целиком. Exit code 1, когда что-то найдено, — так что fleet policy push можно гейтить на нём.

### plugin: авторинг и инвентарь

Три server-less verb для авторов plugins и администраторов:

| Command | Purpose |
| --- | --- |
| `plugin validate <path> [--strict]` | Валидировать директорию plugin bundle без установки — manifest, frontmatter компонентов и hook config. `--strict` считает warnings ошибками. Exit 1, если bundle не проходит, что делает verb CI-friendly |
| `plugin list` (alias `plugin ls`) | Установленные plugins: версия, source marketplace и global enable status |
| `plugin details <name>` | Инвентарь компонентов и projected token cost одного установленного plugin |

Все три принимают глобальный `--json` для machine-readable output:

```bash
bun run apps/cli/src/index.ts plugin validate ./my-plugin --strict
bun run apps/cli/src/index.ts --json plugin list | jq '.[] | select(.enabled == "enabled")'
bun run apps/cli/src/index.ts plugin details my-plugin
```

### Списки ресурсов

| Command | RPC channel | Output |
| --- | --- | --- |
| `workspaces` | `workspaces:get` | по строке на workspace: id, name, path |
| `sessions` | `sessions:get` | id, name, message preview, маркер `[processing]` |
| `connections` | `LLM_Connection:list` | настроенные [LLM connections](config/llm-connections) |
| `sources` | `sources:get` | sources активного workspace |

### Управление sessions

| Command | RPC channel | Purpose |
| --- | --- | --- |
| `session create [--name <text>] [--mode <mode>]` | `sessions:create` | создать session, напечатать её record |
| `session messages <id>` | `sessions:getMessages` | вывести историю messages |
| `session delete <id>` | `sessions:delete` | удалить session |
| `cancel <id>` | `sessions:cancel` | остановить in-flight processing |

`--mode` принимает [permission modes](../core-concepts/permissions) `dontAsk`, `plan`, `default`, `acceptEdits`, `auto` и `bypassPermissions`. Упразднённый `explore` и устаревшие написания (`safe`, `ask`, `allow-all`, `execute`, `ask-to-edit`, `automatic`, `manual`) продолжают приниматься и разрешаются в текущие режимы; `explore` и `safe` разрешаются в `plan`.

### send: стрим ответа

```bash
bun run apps/cli/src/index.ts send <session-id> "Explain the auth flow"
git diff | bun run apps/cli/src/index.ts send <session-id>
```

Prompt берётся из positional arguments; когда inline message нет, а stdin piped, prompt читается из stdin.

`send` подписывается на `session:event` и рендерит events по мере поступления:

| Event | Рендеринг в text-режиме | Effect |
| --- | --- | --- |
| `text_delta` | chunk дописывается в stdout | — |
| `text_complete` | полный текст печатается, только если deltas не приходили | завершает turn |
| `tool_start` | `[tool: <name> — <intent>]` | — |
| `tool_result` | тело результата, обрезанное до 200 символов | — |
| `error`, `typed_error` | сообщение в stderr | завершает turn, exit code 1 |
| `complete` | завершающий newline | завершает turn, exit code 0 |
| `interrupted` | `[interrupted]` | завершает turn, exit code 130 |

::: info Subagent turns
Child turns от subagents (tool Task) приходят как `text_complete` events с `parentToolUseId`. CLI их не печатает и не считает концом родительского turn. Только top-level, non-intermediate `text_complete` — или event `complete`, `error`, `interrupted` — завершает stream.
:::

Если terminal event не пришёл за `--send-timeout` (по умолчанию 5 минут), CLI печатает `Send timeout — no completion event received` и выходит с кодом 1.

### Output formats

`--output-format` применяется к `send` и `run`:

- `text` (default) — human-readable рендеринг по таблице выше.
- `json` — для structured runs: в паре с `--json-schema` печатает validated structured output одним JSON-документом (см. ниже).
- `stream-json` — поток открывается фреймом `system`/`init`, затем каждый session event пишется в stdout одним JSON-объектом на строку, включая типы, которые text-рендерер игнорирует (`user_message`, `usage_update` и т.д.). Больше ничего не печатается; поведение exit code не меняется.

#### Init-фрейм stream-json

Первая строка `stream-json`-запуска — метаданные сессии, а не событие хода:

```json
{"type":"system","subtype":"init","session_id":"…","cwd":"…","model":"…","output_format":"stream-json","plugins":[{"name":"…","path":"…"}],"mcp_servers":[{"name":"…","status":"pending"}]}
```

`plugin_errors` и `mcp_server_errors` присутствуют **только когда непусты**, так
что CI-джоба может гейтить по наличию ключа, а не по сравнению длины:

- `plugin_errors` — по записи на каждый plugin, который не загрузился (`plugin`, `type`, `message`). Такой plugin отсутствует в `plugins`. Причины: неудовлетворённая объявленная зависимость, незаполненный обязательный ключ `user_config`, неразрешённый app connector, отсутствующая обязательная MCP-переменная окружения.
- `mcp_server_errors` — по записи на каждое MCP-объявление, пропущенное валидацией конфигурации (`name`, `type`, `message`). Такой сервер отсутствует в `mcp_servers`. Причины: `config.json` источника не парсится или не объявляет распознаваемый `type`, `mcp.json` / `.mcp.json` не парсится, либо команду MCP-сервера из бандла плагина отклонил format adapter.

```bash
nessy-general-agent run --output-format stream-json "…" \
  | head -1 | jq -e 'has("mcp_server_errors") or has("plugin_errors")' && exit 1
```

Фрейм в snake_case, потому что следует headless-контракту Claude Code; строки
событий после него остаются в собственном camelCase Nessy. Смешение намеренное.

`mcp_servers[].status` на свежей сессии равен `pending` — живого состояния
подключения не существует до старта агентского рантайма, то есть до первого
хода. На `mcp_server_errors` это не влияет: массив вычисляется при сканировании
inventory, поэтому гейтить стоит именно по нему.

Когда stderr — терминал, пропущенная MCP-запись дополнительно печатает строку
`Warning: N MCP servers skipped due to invalid config:`. Когда stderr
перенаправлен или захвачен (CI-раннер, pipe), не печатается ничего, и поток
остаётся единственным каналом для этого состояния.

### Structured output: --json-schema

`--json-schema <schema>` (для `send` и `run`) принимает JSON Schema (draft-07), которой должен соответствовать финальный output run-а. Streaming text подавляется; по завершении CLI печатает только validated structured output. Невалидная schema падает на старте с `--json-schema is not a valid JSON Schema`; run, который не смог выдать schema-valid output за bounded retries, выходит с кодом 1 и ошибкой, называющей провалы validation.

```bash
bun run apps/cli/src/index.ts run \
  --json-schema '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}' \
  --output-format json \
  "Summarize this repository"
```

### run: one-shot и self-contained

`run` не требует существующего server. Его lifecycle:

1. Порождает headless server как child process (`bun run packages/server/src/index.ts`, находится из monorepo layout или переопределяется `--server-entry`). Child получает случайный token и слушает `127.0.0.1` на ephemeral port; CLI ждёт строку `NESSY_SERVER_URL=` в его stdout до 30 секунд (или `--timeout`, если он больше).
2. Создаёт или переиспользует name-only Workspace для запуска. Если задан `--workspace-dir`, server валидирует его как external Project и выбирает через Workspace-bound opaque handle; директория никогда не становится Workspace storage.
3. Настраивает LLM connection, когда у server её нет, когда задан `--base-url` или когда provider не `anthropic`. Connection сохраняется как `<provider>-cli` и делается default. Поскольку spawned server делит активный `CONFIG_DIR` с desktop app (`~/.nessy-agent` по умолчанию, или `NESSY_CONFIG_DIR`), connections из приложения переиспользуются, когда этот шаг пропущен.
4. Создаёт session с запрошенным permission mode и sources, затем применяет `--model`, если задан.
5. Отправляет prompt (positional arguments или stdin, когда piped), стримит ответ ровно как `send` и перенимает exit code стрима. Piped stdin ограничен 10 MiB; больший pipe останавливается на пределе и выходит с кодом 1 и сообщением `Piped input exceeds the 10MB stdin limit.` Запишите содержимое в файл и сошлитесь на путь в prompt.
6. Останавливает server, сохраняя session. Она остаётся resumable в общем `CONFIG_DIR`, а её id печатается в stderr как `Session: <id>` — если не задан `--no-session-persistence`, при котором session вообще никогда не записывалась.

Ctrl+C (SIGINT) отменяет in-flight turn, делает cleanup и выходит с кодом 130. SIGTERM тоже делает cleanup и выходит с кодом 143 — так supervisor отличает отмену оператором от остановки инфраструктурой, — и сразу останавливает turn в процессе, но не записывает для него результат, так что возобновление session продолжает его. У запуска с `--no-session-persistence` возобновлять нечего, так что там незавершённый turn теряется в любом случае.

Нераспознанный flag печатается в stderr и завершает процесс с кодом 1 ещё до запуска server. Используйте `--`, когда positional argument действительно начинается с дефиса.

**С `--url` `run` подключается, а не поднимает свой server.** Шаг 1 пропускается, и запуск использует server, который уже слушает по этому адресу, — так запуск направляют на server, поднятый вами самими: под отладчиком или с его собственным stdout перед глазами. Четыре флага в такой комбинации отклоняются ещё до любого подключения: `--safe-mode`, `--fallback-model`, `--settings` и `--setting-sources`. Все четыре CLI доставляет через окружение того server, который поднимает сам, поэтому против server, который она не запускала, они не делают вообще ничего, — а `--safe-mode`, который ничего не делает, это ровно тот отказ, ради предотвращения которого `--safe-mode` и существует. Сообщение называет флаги и два выхода: убрать `--url`, чтобы поднялся server, который их учтёт, либо задать соответствующую переменную в окружении того server, к которому вы подключаетесь. Отклоняются только формы из командной строки — унаследованный `NESSY_SAFE_MODE` это ваше окружение, а не то, что вы набрали в этой команде, и про эту половину запуск сообщает по имени переменной.

| Flag | Default | Purpose |
| --- | --- | --- |
| `--workspace-dir <path>` | — | выбрать external Project через validated Workspace-bound handle |
| `--source <slug>` | — | включить source на session; repeatable |
| `--permission-mode <mode>` | `bypassPermissions` | permission mode для session; также пишется `--mode` |
| `--output-format <fmt>` | `text` | `text`, `json` или `stream-json` |
| `--json-schema <schema>` | — | JSON Schema (draft-07), которой должен соответствовать финальный output; см. [Structured output](#structured-output-json-schema) |
| `--no-session-persistence` | off | не сохранять session: она никогда не пишется на диск и не может быть resumed. `NESSY_SKIP_PROMPT_HISTORY=1` (или `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`) делает то же самое |
| `--no-cleanup` | off | принимается и игнорируется — теперь run по умолчанию сохраняет свою session |
| `--server-entry <path>` | auto-detected | альтернативный server entry file |

**LLM configuration:**

| Flag | Environment fallback | Default | Purpose |
| --- | --- | --- | --- |
| `--provider <name>` | `LLM_PROVIDER` | `anthropic` | id провайдера (см. таблицу ключей ниже) |
| `--model <id>` | `LLM_MODEL` | default провайдера | модель для запуска |
| `--api-key <key>` | `LLM_API_KEY` | provider-specific переменная | credential провайдера |
| `--base-url <url>` | `LLM_BASE_URL` | — | custom OpenAI- или Anthropic-совместимый endpoint |

API key резолвится по порядку: `--api-key`, затем `$LLM_API_KEY`, затем provider-specific переменная:

| Provider | Environment variable |
| --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `google` | `GOOGLE_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `groq` | `GROQ_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `cerebras` | `CEREBRAS_API_KEY` |
| `huggingface` | `HUGGINGFACE_API_KEY` |

`amazon-bedrock` — исключение: он аутентифицируется IAM credentials из `AWS_ACCESS_KEY_ID` и `AWS_SECRET_ACCESS_KEY` (плюс опциональный `AWS_SESSION_TOKEN`; `AWS_REGION` по умолчанию `us-east-1`).

С `--base-url` connection сохраняется как [custom endpoint](config/custom-endpoint) — и создаётся даже когда другие connections уже есть, так что session гарантированно идёт через него. `--provider anthropic` выбирает Anthropic Messages wire format; любой другой provider — OpenAI Completions format. Если `--model` не указан, endpoint по умолчанию берёт `claude-sonnet-4-6` (anthropic) или `gpt-4o` (все остальные).

```bash
# Default provider (нужен $ANTHROPIC_API_KEY)
bun run apps/cli/src/index.ts run "Summarize this repository"

# OpenAI
OPENAI_API_KEY=sk-... bun run apps/cli/src/index.ts run --provider openai --model gpt-4o "Hello"

# Prompt, piped из другой команды
git log --oneline -20 | bun run apps/cli/src/index.ts run

# Nessy Gateway (извлечение JWT — в Quick Start)
bun run apps/cli/src/index.ts run --provider openai \
  --base-url https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1 \
  --api-key "$JWT" --model tgpt/deepseek-v4-flash-0731 "What is 2+2?"
```

::: warning Rejected keys
Отклонённый или истёкший gateway JWT проявляется как 401-класс ошибки `Invalid API Key` на первом turn. Перечитайте token из `~/.nessy/dp_auth_creds.json` и повторите.
:::

### invoke и listen: raw RPC

```bash
bun run apps/cli/src/index.ts invoke system:homeDir
bun run apps/cli/src/index.ts invoke sessions:get '"<workspace-id>"'
bun run apps/cli/src/index.ts listen session:event
```

`invoke` отправляет один request на любом channel и печатает ответ; дополнительные аргументы парсятся как JSON, когда возможно, и передаются plain-строками иначе. `listen` подписывается на push channel и печатает каждый event как JSON, пока вы не нажмёте Ctrl+C.

### --validate-server

```bash
# Против работающего server
bun run apps/cli/src/index.ts --validate-server --url ws://127.0.0.1:9100 --token "$TOKEN"

# Поднять throwaway server и провалидировать его
bun run apps/cli/src/index.ts --validate-server --verbose
```

Запускает 40-шаговый integration pass по одному connection. Шаги продолжают выполняться после failure; exit code 0 только когда прошёл каждый шаг. Шаги покрывают:

- handshake, credential health, версии server, home directory
- списки workspaces, sessions, connections и sources
- session lifecycle: create, чтение истории, обычный streaming turn, turn с Bash tool
- session tools: создание label плюс `set_session_labels`, `get_session_info`, `list_sessions`
- branching: ветка от assistant message, проверка укороченной истории, стрим на ветке
- sources: создание REST API source, mention его в prompt, проверка pre-committed MCP source (плюс header-auth MCP шаг, который пропускается без `$STITCH_API_KEY`)
- skills: создание skill file через Bash tool, проверка листинга, invocation, удаление
- automations: установка config template, срабатывание через смену статуса, проверка созданной session и auto-label, проверка execution history, фиксация failing webhook
- cleanup каждой временной session, ветки, source, skill, label, automation file и (при bootstrap) workspace

::: warning Validation мутирует состояние
Pass создаёт и удаляет реальные ресурсы: sessions с именами `__cli-validate-*`, Cat Facts API source, validation skill, labels и automation config (существующие `automations.json` / `automations-history.jsonl` бэкапятся и восстанавливаются). Не направляйте его на workspace, который вам дорог. Запускайте из корня репозитория — automation template читается из `.github/agents/automations.json` относительно working directory.
:::

Детали поведения:

- Без `--url` локальный server поднимается и останавливается автоматически; его stderr показывается только с `--verbose`.
- Per-step RPC timeout поднимается минимум до 30 секунд.
- `--workspace-dir` валидирует указанную директорию как external Project и выбирает её через opaque Workspace-bound handle; иначе используется первый существующий Workspace, а name-only временный создаётся, когда у server нет ни одного.
- `--provider`, `--model`, `--api-key` и `--base-url` настраивают LLM connection так же, как `run`.
- `--json` выводит `{ total, passed, failed, results: [{ step, status, detail, elapsed }], elapsedSeconds }`.

```bash
bun run apps/cli/src/index.ts --validate-server --json | jq '.failed'
```

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | turn завершился нормально, или все validation-шаги прошли |
| `1` | ошибка: нет URL/workspace/message, RPC failure, event `error`/`typed_error`, send timeout или хотя бы один failed validation-шаг |
| `130` | interrupted: session выдала `interrupted`, или `run` получил SIGINT |
| `143` | `run` получил SIGTERM: turn в процессе остановлен без записи результата |

## Environment Variables

| Variable | Used for |
| --- | --- |
| `NESSY_SERVER_URL` | адрес server, когда `--url` не задан |
| `NESSY_SERVER_TOKEN` | auth token, когда `--token` не задан |
| `NESSY_TLS_CA` | путь к CA-сертификату, когда `--tls-ca` не задан |
| `NESSY_SAFE_MODE` | `1` стартует в safe mode, то же, что `--safe-mode` |
| `NESSY_FALLBACK_MODEL` | fallback-цепочка, когда `--fallback-model` не задан |
| `NESSY_CLAUDE_SETTINGS` | tier flag-settings для Claude, когда `--settings` не задан |
| `NESSY_CLAUDE_SETTING_SOURCES` | setting sources для Claude, когда `--setting-sources` не задан |
| `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_BASE_URL` | defaults для LLM-флагов `run` |
| `NO_COLOR` | выключить цветной вывод и spinner |

Server-side переменные задокументированы в [Headless Server](../server/headless#environment-variables); app-wide список — в [Environment Variables](config/environment-variables).

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `No server URL` и exit 1 | не задан ни `--url`, ни `$NESSY_SERVER_URL` | передайте `--url` или экспортируйте переменную |
| `Connection timeout (10000ms)` | server не работает или недостижим | проверьте процесс server и адрес; поднимите `--timeout` |
| Handshake отклонён с `AUTH_FAILED` | token mismatch | используйте точное значение серверного `NESSY_SERVER_TOKEN` |
| `PROTOCOL_VERSION_UNSUPPORTED` | client и server собраны из разных checkouts | пересоберите оба из одной ревизии |
| TLS-ошибки против `wss://` | self-signed сертификат не доверен | передайте `--tls-ca <path>` с CA-файлом |
| `Invalid API Key` (401) во время `run` | отклонённый или истёкший gateway JWT, или неверный provider key | обновите JWT из `~/.nessy/dp_auth_creds.json` или передайте валидный `--api-key` |
| `Send timeout — no completion event received` | turn шёл дольше `--send-timeout` | поднимите `--send-timeout` |

См. также task-oriented [гайд CLI client](../server/cli) и страницу настройки [Headless Server](../server/headless).

## Локальный запуск Odysseus

В папке проекта используйте «Запустить Odysseus CLI.command» или «Запустить Odysseus Desktop.command». На macOS эти файлы находят установленный Node.js 22+ и запускают компонент из текущего расположения проекта. Путь к конкретному пользовательскому профилю Node.js задавать не требуется. Команды `tools/run-component.mjs` и `tools/odysseus.mjs` сохраняются для запуска из терминала.
