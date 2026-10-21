---
name: "dp-sage"
description: "Поиск и анализ журналов сервисов в DP Sage через Spirit CLI и запросы MageQL."
tags: ["dp","sage","logs","mageql","monitoring","spirit-cli","loyalty-platforms"]
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


# DP Sage — анализ логов через dp sage CLI

## Обзор

`dp sage` — плагин Spirit CLI для поиска и анализа логов через Sage. Все команды выполняются через Bash tool.

**Важно:** группы называются через **дефис** (`loyalty-platforms`), не через подчёркивание.

## Команды

### 1. Список групп — `groups`

```bash
dp sage groups
```

Показывает все доступные группы логов. Используй для поиска нужной группы.

### 2. Список систем в группе — `systems`

```bash
dp sage systems -g "<группа>"
```

**Флаги:**
- `-g, --group` (обязательный) — имя группы

**Пример:**
```bash
dp sage systems -g "loyalty-platforms"
```

Показывает топ систем по объёму логов за 7 дней.

### 3. Сырые логи (MageQL) — `query`

```bash
dp sage query -q '<mageQL-запрос>' --hours <N> --size <N>
```

**Флаги:**
- `-q, --query` (обязательный) — MageQL-запрос
- `--hours` — глубина в часах от текущего момента (по умолчанию 1)
- `--size` — максимум записей (по умолчанию 600)
- `--from` — начало окна в ISO 8601 (например `2026-04-23T10:00:00Z`)
- `--to` — конец окна в ISO 8601

**Примеры:**
```bash
# Последние 30 логов auditory-platform за 1 час
dp sage query -q 'group="loyalty-platforms" system="auditory-platform"' --hours 1 --size 30

# Только ERROR за 2 часа
dp sage query -q 'group="loyalty-platforms" system="target" level="ERROR"' --hours 2 --size 50

# По конкретному traceId
dp sage query -q 'group="loyalty-platforms" system="auditory-platform" traceId="abc123def456"' --hours 24

# Точный временной диапазон
dp sage query -q 'group="loyalty-platforms-qa" system="target"' --from 2026-04-23T10:00:00Z --to 2026-04-23T12:00:00Z
```

### 4. Генерация MageQL из текста — `completion`

```bash
dp sage completion -g "<группа>" -s "<система>" -p "<описание на русском>"
```

**Флаги:**
- `-g, --group` (обязательный) — имя группы
- `-s, --system` (обязательный) — имя системы
- `-p, --prompt` (обязательный) — описание запроса на естественном языке

**Пример:**
```bash
dp sage completion -g "loyalty-platforms" -s "auditory-platform" -p "ошибки и исключения за последний час"
```

Возвращает готовый MageQL-запрос. Передай его в `query` или `logs -q`.

### 5. AI-анализ логов — `logs`

```bash
dp sage logs -q '<mageQL-запрос>' -p "<вопрос>" --hours <N>
```

**Флаги:**
- `-q, --query` (рекомендуется) — MageQL-запрос. **Используй `-q`, а не `-g/-s`** — иначе результат будет пустым
- `-g, --group` + `-s, --system` — альтернатива `-q` (но часто не работает без предварительного запроса)
- `-p, --prompt` (обязательный) — вопрос для AI-анализа
- `--hours` — глубина в часах (по умолчанию 1)
- `--from / --to` — точный временной диапазон
- `--no-summary` — отключить AI-резюме (только сырые логи)

**Рабочий workflow:**
```bash
# Шаг 1: получи MageQL
dp sage completion -g "loyalty-platforms" -s "auditory-platform" -p "ошибки за последние 2 часа"

# Шаг 2: передай запрос в logs -q
dp sage logs -q 'group="loyalty-platforms" system="auditory-platform" level in ["ERROR","WARN"]' \
  -p "Какие ошибки встречаются и насколько они критичны?" --hours 2
```

**Прямой вызов (если MageQL известен):**
```bash
dp sage logs -q 'group="loyalty-platforms" system="target" level="ERROR"' \
  -p "Что за ошибки? Есть ли паттерны?" --hours 1
```

## Группы и системы проекта Nessy (Loyalty Platforms)

| Окружение              | Группа                  | Системы                                                                       |
|------------------------|-------------------------|-------------------------------------------------------------------------------|
| PROD                   | `loyalty-platforms`     | `auditory-platform`, `target`, `client-facade`, `distribution-hub`, `dynalog` |
| QA (auditory-platform) | `loyalty-platforms-qa`  | `auditory-platform`                                                           |
| QA (target)            | `target_qa`             | `target`                                                                      |
| DEV                    | `loyalty-platforms-dev` | `auditory-platform`                                                           |

> **Важно:** сервис `target` в QA живёт в отдельной группе `target_qa`, а не в `loyalty-platforms-qa`. Если запрос по `loyalty-platforms-qa system="target"` возвращает пусто — переключись на `target_qa`.

## MageQL — синтаксис

```
# Базовый запрос
group="loyalty-platforms" system="auditory-platform"

# Фильтр по уровню
group="loyalty-platforms" system="target" level="ERROR"

# Несколько уровней
group="loyalty-platforms" system="auditory-platform" level in ["ERROR", "WARN"]

# По traceId
group="loyalty-platforms" system="auditory-platform" traceId="<id>"

# Агрегация (для completion)
group="loyalty-platforms" system="target" | timechart count
group="loyalty-platforms" system="target" level="ERROR" | stats count by message
```

## Алгоритм работы

### Когда просят "посмотри логи" / "есть ли ошибки":

1. Если группа/система известна (Nessy, auditory-platform, target) — используй таблицу выше
2. Если нет — вызови `dp sage groups`, затем `dp sage systems -g <группа>`
3. Для диагностики ошибок: `dp sage logs -q '...' -p "Какие ошибки?"` — получишь AI-анализ
4. Для сырых данных: `dp sage query -q '...'` — получишь JSON-записи

### Рекомендуемый порядок при расследовании:

```bash
# 1. Быстрый взгляд на ошибки
dp sage query -q 'group="loyalty-platforms" system="<сервис>" level in ["ERROR","WARN"]' --hours 1 --size 20

# 2. AI-анализ если нужен вывод
dp sage logs -q 'group="loyalty-platforms" system="<сервис>" level in ["ERROR","WARN"]' \
  -p "Что за ошибки, насколько критичны?" --hours 1

# 3. Drill-down по конкретному traceId
dp sage query -q 'group="loyalty-platforms" system="<сервис>" traceId="<id>"' --hours 24 --size 100
```

## Правило минимальных запросов

**Не делай пробных/разведочных запросов.** Прежде чем вызвать любую команду — сформулируй точный запрос мысленно:

1. Если группа и система известны (Nessy → таблица выше) — сразу пиши финальный MageQL
2. Если MageQL неизвестен — один вызов `completion`, затем один вызов `logs -q`
3. Если нужны сырые данные — один вызов `query` с нужными фильтрами

**Лимит**: не более 2 вызовов sage на один вопрос пользователя.  
Исключение: пользователь явно просит drill-down по конкретному traceId или временному диапазону.

**Типичная ошибка (так не надо):**
```bash
dp sage query -q 'group="loyalty-platforms" system="target"' --hours 1 --size 5  # разведка
dp sage query -q 'group="loyalty-platforms" system="target" level="ERROR"' --hours 1  # уточнение
dp sage logs -q '...' -p "что за ошибки" --hours 1  # итого 3 вызова
```

**Правильно:**
```bash
# Один прицельный вызов
dp sage logs -q 'group="loyalty-platforms" system="target" level in ["ERROR","WARN"]' \
  -p "Что за ошибки? Есть ли паттерны?" --hours 1
```

## Правила использования

1. **Группы через дефис**: `loyalty-platforms`, не `loyalty_platforms`
2. **AI-анализ только через `-q`**: `logs -g/-s` без `-q` даёт пустой результат
3. **Ограничивай `--size`**: для диагностики достаточно 20-50 записей, не тяни 600
4. **`--hours`**: для оперативного мониторинга — 1-2 часа; для расследования инцидентов — до 24 часов
5. **Точное время**: используй `--from/--to` для конкретного временного окна инцидента
6. **workflow completion→logs**: если не знаешь MageQL — сначала `completion`, потом `logs -q`
