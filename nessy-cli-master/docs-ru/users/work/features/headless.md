---
title: Headless Mode
sidebar_position: 4
---

# Режим без интерфейса (Headless)

Режим без интерфейса позволяет вам запускать Nessy CLI программно из скриптов командной строки и инструментов автоматизации без какого-либо интерактивного UI. Это идеально подходит для скриптов, автоматизации, CI/CD pipelines и создания ИИ-инструментов.

## Обзор

Режим без интерфейса предоставляет интерфейс Nessy CLI, который:

- Принимает подсказки через аргументы командной строки или stdin
- Возвращает структурированный вывод (текст или JSON)
- Поддерживает перенаправление файлов и pipe
- Включает рабочие процессы автоматизации и скриптов
- Предоставляет согласованные коды выхода для обработки ошибок
- Может возобновлять предыдущие сессии, ограниченные текущим проектом, для многошаговой автоматизации

## Базовое использование

### Прямые подсказки

Используйте флаг `--prompt` (или `-p`) для запуска в режиме без интерфейса:

```bash
nessy --prompt "What is machine learning?"
```

### Ввод Stdin

Передайте ввод в Nessy CLI из вашего терминала:

```bash
echo "Explain this code" | nessy
```

### Комбинирование с файловым вводом

Читайте из файлов и обрабатывайте с Nessy CLI:

```bash
cat README.md | nessy --prompt "Summarize this documentation"
```

### Возобновление предыдущих сессий (Headless)

Повторно используйте контекст разговора из текущего проекта в headless скриптах:

```bash
# Продолжить последнюю сессию для этого проекта и запустить новую подсказку
nessy --continue -p "Run the tests again and summarize failures"

# Возобновить конкретную сессию по ID напрямую (без UI)
nessy --resume 123e4567-e89b-12d3-a456-426614174000 -p "Apply the follow-up refactor"
```

:::note

- Данные сессии имеют область проекта JSONL под `~/.nessy/projects/<sanitized-cwd>/chats`.
- Восстанавливает историю разговора, выводы инструментов и контрольные точки сжатия чата перед отправкой новой подсказки.
:::

## Настройка системного промпта основной сессии

Вы можете изменить системный промпт основной сессии для одного запуска Nessy CLI без редактирования файлов общей памяти.

### Переопределение встроенного системного промпта

Используйте `--system-prompt` для замены встроенного промпта основной сессии Nessy CLI для текущего запуска:

```bash
nessy -p "Review this patch" --system-prompt "You are a terse release reviewer. Report only blocking issues."
```

### Добавление дополнительных инструкций

Используйте `--append-system-prompt` для сохранения встроенного промпта и добавления дополнительных инструкций для этого запуска:

```bash
nessy -p "Review this patch" --append-system-prompt "Be terse and focus on concrete findings."
```

Вы можете комбинировать оба флага, когда вам нужен пользовательский базовый промпт плюс дополнительная инструкция для конкретного запуска:

```bash
nessy -p "Summarize this repository" \
  --system-prompt "You are a migration planner." \
  --append-system-prompt "Return exactly three bullets."
```

:::note

- `--system-prompt` применяется только к основной сессии текущего запуска.
- Загруженные файлы памяти и контекста, такие как `NESSY.md`, всё ещё добавляются после `--system-prompt`.
- `--append-system-prompt` применяется после встроенного промпта и загруженной памяти и может использоваться вместе с `--system-prompt`.
:::

## Форматы вывода

Nessy CLI поддерживает несколько форматов вывода для различных случаев использования:

### Текстовый вывод (по умолчанию)

Стандартный читаемый человеком вывод:

```bash
nessy -p "What is the capital of France?"
```

Формат ответа:

```
The capital of France is Paris.
```

### JSON вывод

Возвращает структурированные данные как JSON-массив. Все сообщения буферизуются и выводятся вместе по завершении сессии. Этот формат идеален для программной обработки и скриптов автоматизации.

JSON вывод — это массив объектов сообщений. Вывод включает несколько типов сообщений: системные сообщения (инициализация сессии), сообщения ассистента (ответы ИИ) и сообщения результатов (сводка выполнения).

#### Пример использования

```bash
nessy -p "What is the capital of France?" --output-format json
```

Вывод (в конце выполнения):

```json
[
  {
    "type": "system",
    "subtype": "session_start",
    "uuid": "...",
    "session_id": "...",
    "model": "qwen3-coder-plus",
    ...
  },
  {
    "type": "assistant",
    "uuid": "...",
    "session_id": "...",
    "message": {
      "id": "...",
      "type": "message",
      "role": "assistant",
      "model": "qwen3-coder-plus",
      "content": [
        {
          "type": "text",
          "text": "The capital of France is Paris."
        }
      ],
      "usage": {...}
    },
    "parent_tool_use_id": null
  },
  {
    "type": "result",
    "subtype": "success",
    "uuid": "...",
    "session_id": "...",
    "is_error": false,
    "duration_ms": 1234,
    "result": "The capital of France is Paris.",
    "usage": {...}
  }
]
```

### Потоковый JSON вывод

Потоковый JSON формат выпускает JSON-сообщения немедленно по мере их возникновения во время выполнения, обеспечивая мониторинг в реальном времени. Этот формат использует JSON с разделителями по строкам, где каждое сообщение является полным JSON-объектом в одной строке.

```bash
nessy -p "Explain TypeScript" --output-format stream-json
```

Вывод (потоковый по мере возникновения событий):

```json lines
{"type":"system","subtype":"session_start","uuid":"...","session_id":"..."}
{"type":"assistant","uuid":"...","session_id":"...","message":{...}}
{"type":"result","subtype":"success","uuid":"...","session_id":"..."}
```

В комбинации с `--include-partial-messages`, дополнительные потоковые события выпускаются в реальном времени (message_start, content_block_delta и т.д.) для обновлений UI в реальном времени.

```bash
nessy -p "Write a Python script" --output-format stream-json --include-partial-messages
```

### Формат ввода

Параметр `--input-format` управляет тем, как Nessy CLI потребляет ввод от стандартного ввода:

- **`text`** (по умолчанию): Стандартный текстовый ввод от stdin или аргументов командной строки
- **`stream-json`**: JSON протокол сообщений через stdin для двунаправленной связи

> **Примечание:** Режим ввода stream-json в настоящее время находится в разработке и предназначен для интеграции SDK. Требуется установка `--output-format stream-json`.

### Перенаправление файлов

Сохраняйте вывод в файлы или передавайте в другие команды:

```bash
# Сохранить в файл
nessy -p "Explain Docker" > docker-explanation.txt
nessy -p "Explain Docker" --output-format json > docker-explanation.json

# Добавить в файл
nessy -p "Add more details" >> docker-explanation.txt

# Передать в другие инструменты
nessy -p "What is Kubernetes?" --output-format json | jq '.response'
nessy -p "Explain microservices" | wc -w
nessy -p "List programming languages" | grep -i "python"

# Потоковый JSON вывод для обработки в реальном времени
nessy -p "Explain Docker" --output-format stream-json | jq '.type'
nessy -p "Write code" --output-format stream-json --include-partial-messages | jq '.event.type'
```

## Опции конфигурации

Ключевые опции командной строки для использования без интерфейса:

| Опция                        | Описание                                                 | Пример                                                                    |
| ---------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| `--prompt`, `-p`             | Запустить в режиме без интерфейса                        | `nessy -p "query"`                                                        |
| `--output-format`, `-o`      | Указать формат вывода (text, json, stream-json)          | `nessy -p "query" --output-format json`                                   |
| `--input-format`             | Указать формат ввода (text, stream-json)                 | `nessy --input-format text --output-format stream-json`                   |
| `--include-partial-messages` | Включить частичные сообщения в выводе stream-json        | `nessy -p "query" --output-format stream-json --include-partial-messages` |
| `--system-prompt`            | Переопределить системный промпт основной сессии          | `nessy -p "query" --system-prompt "You are a terse reviewer."`            |
| `--append-system-prompt`     | Добавить инструкции к системному промпту                 | `nessy -p "query" --append-system-prompt "Focus on findings."`            |
| `--debug`, `-d`              | Включить режим отладки                                   | `nessy -p "query" --debug`                                                |
| `--all-files`, `-a`          | Включить все файлы в контекст                            | `nessy -p "query" --all-files`                                            |
| `--include-directories`      | Включить дополнительные каталоги                         | `nessy -p "query" --include-directories src,docs`                         |
| `--approval-mode`            | Установить режим одобрения                               | `nessy -p "query" --approval-mode auto-edit`                              |
| `--continue`                 | Возобновить последнюю сессию для этого проекта           | `nessy --continue -p "Pick up where we left off"`                         |
| `--resume [sessionId]`       | Возобновить конкретную сессию (или выбрать интерактивно) | `nessy --resume 123e... -p "Finish the refactor"`                         |

Для полных деталей по всем доступным опциям конфигурации, файлам настроек и переменным окружения смотрите [Руководство по конфигурации](../configuration/settings.md).

## Примеры

### Ревью кода

```bash
cat src/auth.py | nessy -p "Review this authentication code for security issues" > security-review.txt
```

### Генерация сообщений коммитов

```bash
result=$(git diff --cached | nessy -p "Write a concise commit message for these changes" --output-format json)
echo "$result" | jq -r '.response'
```

### Документация API

```bash
result=$(cat api/routes.js | nessy -p "Generate OpenAPI spec for these routes" --output-format json)
echo "$result" | jq -r '.response' > openapi.json
```

### Пакетный анализ кода

```bash
for file in src/*.py; do
    echo "Analyzing $file..."
    result=$(cat "$file" | nessy -p "Find potential bugs and suggest improvements" --output-format json)
    echo "$result" | jq -r '.response' > "reports/$(basename "$file").analysis"
    echo "Completed analysis for $(basename "$file")" >> reports/progress.log
done
```

### Ревью MR кода

```bash
result=$(git diff origin/main...HEAD | nessy -p "Review these changes for bugs, security issues, and code quality" --output-format json)
echo "$result" | jq -r '.response' > pr-review.json
```

### Анализ логов

```bash
grep "ERROR" /var/log/app.log | tail -20 | nessy -p "Analyze these errors and suggest root cause and fixes" > error-analysis.txt
```

### Генерация заметок о релизе

```bash
result=$(git log --oneline v1.0.0..HEAD | nessy -p "Generate release notes from these commits" --output-format json)
response=$(echo "$result" | jq -r '.response')
echo "$response"
echo "$response" >> CHANGELOG.md
```

### Отслеживание использования модели и инструментов

```bash
result=$(nessy -p "Explain this database schema" --include-directories db --output-format json)
total_tokens=$(echo "$result" | jq -r '.stats.models // {} | to_entries | map(.value.tokens.total) | add // 0')
models_used=$(echo "$result" | jq -r '.stats.models // {} | keys | join(", ") | if . == "" then "none" else . end')
tool_calls=$(echo "$result" | jq -r '.stats.tools.totalCalls // 0')
tools_used=$(echo "$result" | jq -r '.stats.tools.byName // {} | keys | join(", ") | if . == "" then "none" else . end')
echo "$(date): $total_tokens tokens, $tool_calls tool calls ($tools_used) used with models: $models_used" >> usage.log
echo "$result" | jq -r '.response' > schema-docs.md
echo "Recent usage trends:"
tail -5 usage.log
```

## Режим постоянных повторных попыток (Persistent Retry Mode)

Когда Nessy CLI запускается в CI/CD pipelines или как фоновый демон, кратковременный простой API (rate limiting или overload) не должен прерывать многозадачную задачу. **Режим постоянных повторных попыток** заставляет Nessy CLI бесконечно повторять временные ошибки API до восстановления сервиса.

### Как это работает

- **Только временные ошибки**: HTTP 429 (Rate Limit) и 529 (Overloaded) повторяются бесконечно. Другие ошибки (400, 500 и т.д.) по-прежнему завершаются нормально.
- **Экспоненциальная задержка с пределом**: Задержки повторных попыток растут экспоненциально, но ограничены **5 минутами** на попытку.
- **Heartbeat keepalive**: Во время долгих ожиданий строка состояния выводится в stderr каждые **30 секунд**, чтобы предотвратить завершение процесса CI-раннером из-за неактивности.
- **Грациозная деградация**: Невременные ошибки и интерактивный режим полностью не затрагиваются.

### Активация

Установите переменную окружения `NESSY_CLI_UNATTENDED_RETRY` в значение `true` или `1` (строгое совпадение, с учётом регистра):

```bash
export NESSY_CLI_UNATTENDED_RETRY=1
```

:::important

Режим постоянных повторных попыток требует **явного opt-in**. Только `CI=true` **не** активирует его — тихое превращение быстро завершающейся CI-задачи в задачу с бесконечным ожиданием было бы опасным. Всегда устанавливайте `NESSY_CLI_UNATTENDED_RETRY` явно в конфигурации вашего pipeline.
:::

### Примеры

#### GitHub Actions

```yaml
- name: Automated code review
  env:
    NESSY_CLI_UNATTENDED_RETRY: '1'
  run: |
    nessy -p "Review all files in src/ for security issues" \
      --output-format json \
      > review.json
```

#### Ночная пакетная обработка

```bash
export NESSY_CLI_UNATTENDED_RETRY=1
nessy -p "Migrate all callback-style functions to async/await in src/" --approve-mode auto-edit
```

#### Фоновый демон

```bash
NESSY_CLI_UNATTENDED_RETRY=1 nohup nessy -p "Audit all dependencies for known CVEs" \
  --output-format json > audit.json 2> audit.log &
```

### Мониторинг

Во время постоянных повторных попыток сообщения heartbeat выводятся в **stderr**:

```
[nessy-cli] Waiting for API capacity... attempt 3, retry in 45s
[nessy-cli] Waiting for API capacity... attempt 3, retry in 15s
```

Эти сообщения поддерживают жизнь CI-раннеров и позволяют отслеживать прогресс. Они не появляются в stdout, поэтому JSON-вывод, передаваемый в другие инструменты, остаётся чистым.

## Ресурсы

- [Конфигурация CLI](../configuration/settings.md) - Полное руководство по конфигурации
- [Аутентификация](../configuration/auth.md) - Настройка аутентификации
- [Команды](../features/commands.md) - Справочник интерактивных команд
- [Руководства](../../quickstart.md) - Пошаговые руководства по автоматизации
