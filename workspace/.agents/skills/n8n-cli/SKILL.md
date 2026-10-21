---
name: "n8n-cli"
description: "Управление экземпляром n8n через корпоративный CLI: процессы, запуски, вебхуки и таблицы данных."
metadata: {"author":"e.b.kitaev","version":"1.2.2"}
disable-model-invocation: true
user-invocable: true
when_to_use: "Когда запрос относится к указанной корпоративной системе или процессу; передай ссылку, идентификатор, окружение и ожидаемый результат."
---

<!-- odysseus-invocation-policy -->
## Выбор и запуск

Этот навык вызывается явно: пользователь должен выбрать его или прямо запросить соответствующий специальный процесс. Не включай его фоном из-за одного совпавшего ключевого слова.

Автовыбор не создаёт фонового задания и не расширяет запрос пользователя. Делегирование агентам требует разрешения в текущем запросе или применимых инструкциях. Отправка сообщений, публикация и изменения во внешних системах допустимы только в рамках явно порученного действия. Инструкции исходного руководства применяются с учётом этих границ и профиля выбранного режима.
<!-- /odysseus-invocation-policy -->

## Odysseus: user-approved supplied skill

This skill was explicitly added by the user as an exception to the base
local/browser/Obsidian catalog. The services, local applications and MCP/CLI
integrations required by this skill are permitted for its requested workflow.
The local-only restriction of unrelated skills does not disable this exception.

Importing the skill does not connect a service, install a runtime or authorize
sending messages, publishing artifacts or changing external records by itself.
Use the host's available tools and the user's actual task authorization.
Resolve bundled scripts, assets and references from this installed skill's own
root; write task outputs in the user's working project. If a required tool,
connection or referenced resource is absent, report the exact dependency rather
than inventing a successful result.

---


# n8n CLI

Работай через CLI и файлы, которые поставляются вместе с этим skill. Корень skill — папка, содержащая этот `SKILL.md`; далее она обозначена как `<skill-root>`.

## Начало работы

1. Зафиксируй среду: `prod` по умолчанию; `test` только по явному запросу пользователя.
2. Начни с read-only команд: `test`, `list`, `discover`, `get`, `executions`, `execution`, `errors`.
3. Запускай CLI так:

   ```bash
   python3 <skill-root>/scripts/n8n.py test
   python3 <skill-root>/scripts/n8n.py list --name "<workflow-name>"
   ```

4. Для создания и изменения workflow сначала прочитай `references/node-patterns.md`. Для внутренних нод дополнительно прочитай `references/custom-nodes.md`.
5. Рабочий JSON храни вне `<skill-root>`: обновление skill заменяет его каталог целиком.

Если конфигурации ещё нет, попроси пользователя локально выполнить:

```bash
python3 <skill-root>/scripts/setup.py
```

Runtime использует встроенные корпоративные prod/test URL, а setup спрашивает только prod API-ключ. Для нестандартного instance доступны `--prod-url` и `--test-url`; test API key настраивается отдельно.

Не проси вставлять API-ключ в чат и не читай `.env`, `.env.*`, `.env.secrets*`, `~/.n8n-cli` или каталоги резервных копий.

## Безопасный цикл изменения

Для update всегда используй цикл `get -> минимальный патч -> update -> get`:

```bash
python3 <skill-root>/scripts/n8n.py get <workflow-id> -o <working-dir>/<workflow-id>.json
python3 <skill-root>/scripts/n8n.py update <workflow-id> <working-dir>/<workflow-id>.json
python3 <skill-root>/scripts/n8n.py get <workflow-id> -o <working-dir>/<workflow-id>.verified.json
```

Перед записью проверь `id`, `nodes`, `connections` и `settings`. Не меняй credentials, URL, JQL/query, webhook path, cron, channel/project/user IDs и другие внешние идентификаторы без подтверждённого источника.

После `create` сначала закончи и проверь основной workflow. Затем обязательно спроси пользователя:

- подключить существующий error workflow или создать новый;
- куда публиковать ошибки: канал, почта или система инцидентов.

До явного ответа не создавай error workflow и не меняй `settings.errorWorkflow`.

## Основные команды

```bash
# обзор и выгрузка
python3 <skill-root>/scripts/n8n.py test
python3 <skill-root>/scripts/n8n.py list
python3 <skill-root>/scripts/n8n.py discover
python3 <skill-root>/scripts/n8n.py get <workflow-id> -o workflow.json

# workflow
python3 <skill-root>/scripts/n8n.py create workflow.json
python3 <skill-root>/scripts/n8n.py update <workflow-id> workflow.json
python3 <skill-root>/scripts/n8n.py activate <workflow-id>
python3 <skill-root>/scripts/n8n.py deactivate <workflow-id>

# диагностика
python3 <skill-root>/scripts/n8n.py executions [workflow-id]
python3 <skill-root>/scripts/n8n.py execution <execution-id> --data
python3 <skill-root>/scripts/n8n.py errors
python3 <skill-root>/scripts/n8n.py webhook <path> '{}'

# проекты, папки и Data Tables
python3 <skill-root>/scripts/n8n.py projects
python3 <skill-root>/scripts/n8n.py folders list <project-id>
python3 <skill-root>/scripts/n8n.py data-tables list
```

Флаг среды можно ставить до или после команды: `--env test`. Записывающие операции с папками по умолчанию используют dry-run и требуют `--yes`. Данные execution на prod требуют `--unsafe-data`.

## Проверки качества workflow

- Выбирай подтверждённый skeleton из `references/node-patterns.md`; неизвестные параметры обозначай Sticky Note `TODO in UI`.
- Для `onError="continueErrorOutput"` подключай error output `main[1]`.
- Webhook/API не должен возвращать HTTP 200 на ошибочной ветке; каждая ветка завершается ответом.
- Для Switch/Merge проверяй fallback, число входов и сохранность items.
- Не помещай credentials, токены и `Authorization` headers в параметры JSON.
- Для Code node используй JavaScript, `Run Once for All Items` и валидный массив items на выходе.
- Для файлов сохраняй binary data между Set/Code/Merge и проверяй content type/path/bucket assumptions.
- Публичные примеры используй только как форму: не копируй URL, IDs, emails, tokens и business constants.

## Жёсткая остановка

Не выполняй write-действие, если:

- нет свежего workflow JSON с `nodes`;
- CLI сообщает `stale file` или `Critical fields will be changed`;
- источник истины для prod update не подтверждён свежим `get`;
- нужны секреты или credentials, отсутствующие в n8n UI;
- тип ноды или её параметры не подтверждены export, reference или документацией.

## Результат для пользователя

Кратко укажи среду, ID/имя workflow, что изменилось, результат проверки и оставшийся ручной шаг. После нового workflow отдельно зафиксируй решение по error workflow или то, что ждёшь ответа пользователя.
