# CLI Client

Terminal client подключается к [headless server](headless) по WebSocket и покрывает повседневный цикл: создание sessions, отправка prompts с live streaming, списки ресурсов и health-check деплоя. Эта страница workflow-oriented; каждый flag, event и exit code задокументирован в [Справочнике CLI](../reference/cli).

## Installation

Из корня репозитория:

```bash
bun install --frozen-lockfile

# Вариант A — вызывать entry point напрямую (используется во всех примерах)
bun run apps/cli/src/index.ts <command>

# Вариант B — положить на PATH как `nessy-general-agent`
cd apps/cli && bun link
```

Слинкованный бинарь сохраняет upstream-имя `nessy-general-agent` для совместимости; оба вызова исполняют один и тот же код.

## Quick Start

### 1. Запустите server

```bash
export NESSY_SERVER_TOKEN=$(openssl rand -hex 32)
echo "$NESSY_SERVER_TOKEN"   # сохраните — он нужен на стороне client
bun run packages/server/src/index.ts
```

Server отклоняет tokens короче 16 символов; `bun run packages/server/src/index.ts --generate-token` печатает надёжный, если предпочитаете. На старте он выводит свой адрес строкой `NESSY_SERVER_URL=`.

### 2. Направьте client на него

```bash
export NESSY_SERVER_URL=ws://127.0.0.1:9100
export NESSY_SERVER_TOKEN=<your-token>
```

Flags (`--url`, `--token`) имеют приоритет над этими переменными.

### 3. Проверьте connectivity

```bash
bun run apps/cli/src/index.ts ping
# Connected: clientId=a1b2c3d4-... latency=12ms
```

### 4. Работайте

```bash
bun run apps/cli/src/index.ts sessions
bun run apps/cli/src/index.ts send <session-id> "What changed in the last commit?"
```

## Common Workflows

### Диагностика конфигурации без server

Двум семействам команд server не нужен вовсе — они читают локальное состояние и выходят:

```bash
# Какой managed settings source действует, что не прошло validation, какие
# user settings layers отклонены целиком. Exit 1, когда что-то найдено.
bun run apps/cli/src/index.ts doctor
bun run apps/cli/src/index.ts --json doctor | jq '.invalidManagedEntries'

# Авторинг и инвентарь plugins
bun run apps/cli/src/index.ts plugin validate ./my-plugin --strict
bun run apps/cli/src/index.ts plugin list
bun run apps/cli/src/index.ts plugin details my-plugin
```

Когда сломанный skill, plugin, hook или MCP server мешает sessions работать, начните с `--safe-mode` (или `NESSY_SAFE_MODE=1`): third-party конфигурация не загружается, а managed policy продолжает действовать — почините виновника и перезапуститесь нормально.

### One-off prompts без server

`run` поднимает приватный server, создаёт session, стримит ответ и всё убирает:

```bash
# Anthropic key из environment
ANTHROPIC_API_KEY=sk-... bun run apps/cli/src/index.ts run "Summarize the project structure"

# Зарегистрировать директорию как workspace и включить source
bun run apps/cli/src/index.ts run --workspace-dir ./my-project --source my-api "List open items"

# Nessy Gateway
JWT=$(python3 -c "import json;print(json.load(open('$HOME/.nessy/dp_auth_creds.json'))['jwt'])")
bun apps/cli/src/index.ts run \
  --provider openai \
  --base-url https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1 \
  --api-key "$JWT" \
  --model tgpt/deepseek-v4-flash-0731 \
  --workspace-dir "$TMPDIR/ws" \
  "What is 2+2?"

# Line-delimited JSON events для CI-логов
bun run apps/cli/src/index.ts run --output-format stream-json "Run the test suite"
```

Credential берётся из `--api-key`, `$LLM_API_KEY` или provider-specific переменной вроде `$OPENAI_API_KEY` — порядок резолюции и таблица провайдеров в [справочнике](../reference/cli#run-one-shot-и-self-contained). Отклонённый gateway JWT проявляется как 401-класс ошибки `Invalid API Key`.

### Валидация деплоя

После установки или обновления server запустите встроенный integration pass:

```bash
# Против работающего server
bun run apps/cli/src/index.ts --validate-server --url ws://127.0.0.1:9100 --token "$NESSY_SERVER_TOKEN"

# Или пусть он поднимет (и остановит) throwaway локальный server
bun run apps/cli/src/index.ts --validate-server
```

Pass проходит 40 шагов: connectivity, credential health, списки workspaces и sessions, streaming turns, tool use, session tools, branching, lifecycle sources/skills/automations и cleanup.

::: warning
Validation создаёт и удаляет временные ресурсы (sessions, source, skill, labels, automation config). Существующие automation files бэкапятся и восстанавливаются, но избегайте запуска против workspace, который вам дорог.
:::

Для скриптов `--json` возвращает summary-объект:

```bash
bun run apps/cli/src/index.ts --validate-server --json | jq '.failed'
# 0 означает, что каждый шаг прошёл
```

### Управление sessions

```bash
# Создать с именем и permission mode
bun run apps/cli/src/index.ts session create --name "Code Review" --mode plan

# Посмотреть
bun run apps/cli/src/index.ts sessions
bun run apps/cli/src/index.ts session messages <id>

# Остановить разогнавшийся turn, затем удалить session
bun run apps/cli/src/index.ts cancel <id>
bun run apps/cli/src/index.ts session delete <id>
```

`--mode` принимает `dontAsk`, `plan`, `default`, `acceptEdits`, `auto` или `bypassPermissions` — см. [Permissions](../core-concepts/permissions). Упразднённый `explore` (читается как `plan`) и устаревшие написания вроде `safe`, `ask` и `allow-all` продолжают приниматься и разрешаются в текущие режимы.

### Стрим ответов и pipe входа

`send` печатает ответ ассистента в stdout по мере генерации, с маркерами `[tool: …]` для tool calls:

```bash
bun run apps/cli/src/index.ts send abc-123 "Explain the authentication flow"
```

Когда inline message нет, prompt читается из piped stdin:

```bash
cat error.log | bun run apps/cli/src/index.ts send abc-123
git diff HEAD~1 | bun run apps/cli/src/index.ts send abc-123
```

Exit codes различают исходы: `0` при завершении, `1` при ошибке или send timeout, `130` когда turn был прерван.

### Скрипты с JSON output

Каждая команда принимает `--json`:

```bash
# Все workspace IDs
bun run apps/cli/src/index.ts --json workspaces | jq -r '.[].id'

# Число sessions
bun run apps/cli/src/index.ts --json sessions | jq length

# Создать session и захватить её ID
SESSION=$(bun run apps/cli/src/index.ts --json session create --name "CI" | jq -r '.id')
```

### Пример CI pipeline

```bash
#!/bin/bash
set -e

# Провалить job, если server не проходит validation
bun run apps/cli/src/index.ts --validate-server --json | jq -e '.failed == 0'

# Одна session на pipeline run
SESSION=$(bun run apps/cli/src/index.ts --json session create --name "CI-${CI_BUILD_ID}" | jq -r '.id')

bun run apps/cli/src/index.ts send "$SESSION" "Run the test suite and report failures"

bun run apps/cli/src/index.ts session delete "$SESSION"
```

## Raw RPC Access

Channels без выделенной команды достижимы через escape hatches:

```bash
# One-off request на любом channel (аргументы парсятся как JSON)
bun run apps/cli/src/index.ts invoke system:homeDir
bun run apps/cli/src/index.ts invoke sessions:get '"workspace-123"'

# Печатать push events до Ctrl+C
bun run apps/cli/src/index.ts listen session:event
```

## Going Further

[Справочник CLI](../reference/cli) документирует каждый flag с defaults, таблицу streaming events, output formats, exit codes и troubleshooting. Server-side конфигурация — в [Headless Server](headless).
