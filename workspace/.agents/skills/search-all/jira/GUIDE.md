---
name: Jira CLI
description:
  Работа с задачами Jira через dp jira CLI (Spirit CLI plugin) — получение, поиск, создание и обновление задач
when: |
  - Пользователь просит найти, посмотреть, создать или обновить задачу в Jira
  - Пользователь упоминает Jira-ключ задачи (формат BIGLETTERS-NUMBER, например ADS-1234, DPIAM-567)
  - Пользователь просит выполнить JQL-запрос
  - Пользователь хочет узнать статус задачи, назначить исполнителя или изменить описание
tags: [jira, cli, dp, spirit, tasks]
---

# Jira CLI — работа с задачами через dp jira

## Обзор

`dp jira` — плагин Spirit CLI для работы с Jira. Все команды выполняются через Bash tool.

## Команды

### 1. Получение задачи по ключу — `issue`

```bash
dp jira issue --key <КЛЮЧ>
```

**Флаги:**

- `--key, -k` (обязательный) — ключ задачи (формат `BIGLETTERS-NUMBER`, например `ADS-1234`)
- `--compact` — компактный plaintext вывод вместо JSON (рекомендуется для экономии токенов)
- `--only-fields` — список полей через запятую (например `key,summary,status,assignee,issuetype`)
- `--editmeta, -e` — добавить метаинформацию о редактируемых полях
- `--raw, -r` — необработанный JSON из API

**Рекомендуемый вызов (экономия токенов):**

```bash
dp jira issue --key ADS-1234 --compact --only-fields "key,summary,status,assignee,issuetype"
```

**Полный вызов для детального анализа:**

```bash
dp jira issue --key ADS-1234 --compact
```

**Если нужна метаинформация для обновления полей:**

```bash
dp jira issue --key ADS-1234 --editmeta
```

### 2. Поиск задач по JQL — `jql_search`

```bash
dp jira jql_search --jql "<JQL-запрос>"
```

**Флаги:**

- `--jql, -q` (обязательный) — JQL-запрос
- `--start-at, -s` — индекс первой задачи (по умолчанию 0)
- `--max-results, -m` — максимум задач (по умолчанию 50)
- `--compact` — компактный plaintext вывод (рекомендуется)
- `--only-fields` — список полей через запятую

**Рекомендуемый вызов (экономия токенов):**

```bash
dp jira jql_search --jql "project = ADS AND status = 'In Progress'" --compact --only-fields "key,summary,status,assignee,issuetype,created,updated"
```

**Пагинация:**

```bash
dp jira jql_search --jql "project = ADS" --max-results 100 --start-at 0 --compact
```

**Полезные JQL-примеры:**

- Задачи текущего пользователя: `assignee = currentUser()`
- Задачи в работе: `project = ADS AND status = 'In Progress'`
- Задачи по спринту: `project = ADS AND sprint in openSprints()`
- Задачи по компоненту: `project = ADS AND component = 'Frontend'`
- Недавно обновлённые: `project = ADS AND updated >= -7d`

### 3. Создание задачи — `create`

```bash
dp jira create --project-key <ПРОЕКТ> --summary "<Заголовок>"
```

**Флаги:**

- `--project-key, -p` (обязательный) — ключ проекта (например `ADS`)
- `--summary, -s` (обязательный) — заголовок задачи
- `--description, -d` — описание задачи
- `--priority` — приоритет (`High`, `Medium`, `Low`)
- `--labels, -l` — метки через запятую
- `--assignee, -a` — имя пользователя исполнителя
- `--due-date` — срок выполнения в формате `YYYY-MM-DD`
- `--jira-instance, -j` — поддомен Jira (`jira`, `jira2`, `jira3`)
- `--issue-type` — тип задачи (`Task`, `Bug`, `Story`). По умолчанию `Task`
- `--show-meta` — показать доступные типы задач и поля для проекта (без создания)

**Перед созданием — посмотри метаданные проекта:**

```bash
dp jira create --project-key ADS --show-meta
```

**Создание задачи:**

```bash
dp jira create --project-key ADS --summary "Fix auth bug" --description "Описание бага" --priority High --issue-type Bug
```

### 4. Обновление задачи — `update`

```bash
dp jira update --key <КЛЮЧ> [поля для обновления]
```

**Флаги:**

- `--key, -k` (обязательный) — ключ задачи
- `--assignee, -a` — установить исполнителя
- `--unassign` — снять исполнителя
- `--summary, -s` — обновить заголовок
- `--description, -d` — обновить описание

Нужно указать хотя бы один из: `--assignee`, `--unassign`, `--summary`, `--description`.

```bash
dp jira update --key ADS-1234 --assignee "user.name"
dp jira update --key ADS-1234 --unassign
dp jira update --key ADS-1234 --summary "Новый заголовок" --description "Новое описание"
```

### 5. Метаданные редактирования — `editmeta`

Получить информацию о доступных полях для редактирования задачи:

```bash
dp jira editmeta --key ADS-1234
```

### 6. Метаданные полей Jira — `field`

Получить информацию о полях Jira (системных и кастомных):

```bash
dp jira field --jira jira3 --query "<поисковый запрос>"
```

**Флаги:**

- `--jira, -j` (обязательный) — поддомен Jira (например `jira3`)
- `--query, -q` — фильтрация по подстроке в id/name/key/clauseNames
- `--only-fields` — атрибуты: `id,name,custom,key,orderable,navigable,searchable,clauseNames,schema`
- `--limit, -l` — максимум результатов (по умолчанию 20)
- `--all` — все результаты без лимита
- `--raw, -r` — сырой JSON

**Рекомендуемый вызов:**

```bash
dp jira field --jira jira3 --query epic
```

### 7. Метаданные плагина — `print-metadata`

```bash
dp jira print-metadata
```

## Правила использования

1. **Всегда используй `--compact`** при получении задач — это экономит токены
2. **Используй `--only-fields`** когда нужны только определённые поля. Рекомендуемый набор:
   `key,summary,status,assignee,issuetype,created,updated`
3. **Для поиска полей** всегда начинай с `dp jira field --query ...`, а не запрашивай все поля
4. **Полный JSON** запрашивай только когда явно нужна полная структура данных
5. **Извлечение ключа из URL**: если пользователь даёт URL вида `https://jira.example.com/browse/ADS-1234`, ключ — это
   часть после `browse/` (`ADS-1234`)
6. **При ошибках** — проверь формат ключа (должен быть `BIGLETTERS-NUMBER`) и доступность `dp` CLI
