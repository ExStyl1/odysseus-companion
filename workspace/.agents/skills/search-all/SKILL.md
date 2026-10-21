---
name: "search-all"
description: "Поиск связанных материалов одновременно в Jira, Confluence и GitLab с объединением найденного контекста."
when: "- Пользователь просит найти информацию, не указывая конкретный источник\n- Пользователь хочет искать сразу по нескольким источникам (Jira + Confluence + GitLab)\n- Пользователь говорит \"найди\", \"поищи\", \"что известно про...\" без уточнения где именно\n- Пользователь спрашивает про фичу, баг или задачу и нужно собрать контекст из разных систем\n"
tags: ["search","orchestrator","jira","confluence","gitlab","wixie"]
disable-model-invocation: true
user-invocable: true
when_to_use: "Когда запрос относится к указанной корпоративной системе или процессу; передай ссылку, идентификатор, окружение и ожидаемый результат."
---

<!-- odysseus-invocation-policy -->
## Выбор и запуск

Этот навык вызывается явно: пользователь должен выбрать его или прямо запросить соответствующий специальный процесс. Не включай его фоном из-за одного совпавшего ключевого слова.

Автовыбор не создаёт фонового задания и не расширяет запрос пользователя. Делегирование агентам требует разрешения в текущем запросе или применимых инструкциях. Отправка сообщений, публикация и изменения во внешних системах допустимы только в рамках явно порученного действия. Инструкции исходного руководства применяются с учётом этих границ и профиля выбранного режима.

Ссылки на прежние имена в исходных руководствах разрешай до загрузки навыка: «jira-cli» → «jira», режим «jira-cli». Старое имя не является отдельной командой.
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


# Search All — оркестратор поиска по внутренним системам

## Обзор

Объединяет поиск по Jira, Confluence (Wixie) и GitLab в одну точку входа. Основной принцип — **минимизация контекста**:
сначала собираем краткие результаты, углубляемся только по запросу пользователя.

## Алгоритм работы

### Шаг 1 — Определи источники

Проанализируй запрос пользователя и определи, какие источники релевантны:

| Сигнал в запросе                         | Источники                                         |
| ---------------------------------------- | ------------------------------------------------- |
| Баг, задача, статус, спринт, исполнитель | **Jira**                                          |
| Документация, гайд, инструкция, wiki     | **Confluence**                                    |
| MR, merge request, код, ветка, пайплайн  | **GitLab** (нужны repo + tenant)                  |
| Общий вопрос ("что известно про X")      | **Jira + Confluence**                             |
| Фича/проект целиком                      | **Jira + Confluence + GitLab** (если указан repo) |

**Правило для GitLab:** включай GitLab в поиск только если пользователь явно указал репозиторий и тенант, или ты можешь
их определить из контекста. Если нет — спроси. У GitLab нет полнотекстового поиска, доступен только список MR по
конкретному репо.

### Шаг 2 — Параллельный лёгкий поиск

Запусти поиск по выбранным источникам **параллельно** (несколько Bash tool вызовов в одном сообщении). Используй жёсткие
лимиты:

**Jira** — только ключевые поля, максимум 5 результатов:

```bash
dp jira jql_search --jql "<JQL>" --compact --only-fields "key,summary,status,assignee" --max-results 5
```

Составляй JQL из запроса пользователя. Примеры маппинга:

- "найди задачи про авторизацию" → `summary ~ "авторизац*" OR description ~ "авторизац*"`
- "баги в проекте LP" → `project = LP AND issuetype = Bug`
- "мои задачи в работе" → `assignee = currentUser() AND status = "In Progress"`

**Confluence** — максимум 5 результатов, только таблица (заголовки + URL):

```bash
dp wixie search -q "<запрос>" -l 5
```

**GitLab** — список MR (только если указан repo + tenant):

```bash
dp gitlab merge-requests --repository <REPO> --tenant <TENANT>
```

### Шаг 3 — Сводка результатов

Покажи пользователю **единую компактную сводку**. Формат:

```
### Результаты поиска: "<запрос>"

**Jira** (N результатов):
- LP-1234 — Название задачи [В работе]
- LP-1235 — Другая задача [Готово]

**Confluence** (N результатов):
- Название страницы — URL
- Другая страница — URL

**GitLab MR** (N результатов):
- !42 Название MR — автор [открыт]
```

Если источник не дал результатов — напиши "нет результатов" одной строкой, не расписывай.

### Шаг 4 — Drill-down по запросу

Если пользователь просит подробности по конкретному элементу, тогда запрашивай полные данные:

- **Jira-задача**: `dp jira issue --key LP-1234 --compact`
- **Confluence-страница**: `dp wixie get --url <URL>`
- **GitLab MR**: `dp gitlab merge-request --repository <REPO> --tenant <TENANT> --id 42`

**Не запрашивай полные данные автоматически** — только по явному запросу пользователя.

## Оптимизация контекста

### Обязательные правила

1. **Всегда `--compact --only-fields`** для Jira на фазе поиска
2. **Максимум 5 результатов** на источник при первичном поиске
3. **Не запрашивай полные данные** (issue details, page content, MR diff) до явной просьбы
4. **Confluence в формате table** (по умолчанию) — компактнее JSON
5. **Один drill-down за раз** — не тяни подробности по 3 задачам одновременно

### Что НЕ делать

- Не запрашивай `dp jira issue` для каждого результата поиска
- Не запрашивай `dp wixie get` для каждой найденной страницы
- Не запрашивай `dp gitlab merge-request` (с diff) для каждого MR в списке
- Не используй `--max-results` больше 10 без явной просьбы пользователя
- Не запускай GitLab-поиск, если нет repo + tenant

## Примеры использования

### Общий поиск по теме

Пользователь: "Что известно про систему нотификаций?"

Запускаем параллельно:

```bash
dp jira jql_search --jql "summary ~ \"нотификац*\" OR description ~ \"нотификац*\"" --compact --only-fields "key,summary,status,assignee" --max-results 5
```

```bash
dp wixie search -q "нотификации" -l 5
```

### Поиск с указанием проекта и репо

Пользователь: "Найди всё про авторизацию в проекте LP, репо auth-service, тенант loyalty"

Запускаем параллельно:

```bash
dp jira jql_search --jql "project = LP AND (summary ~ \"авторизац*\" OR description ~ \"авторизац*\")" --compact --only-fields "key,summary,status,assignee" --max-results 5
```

```bash
dp wixie search -q "авторизация" -l 5
```

```bash
dp gitlab merge-requests --repository auth-service --tenant loyalty
```
