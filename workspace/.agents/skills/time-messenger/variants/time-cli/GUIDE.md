---
name: "time-cli"
description: "Single-file CLI для Tinkoff Time (Mattermost). Список каналов/DM, чтение постов, полнотекстовый поиск, просмотр треда, ответ в тред, профиль пользователя. Zero-deps (stdlib only). Все read-команды поддерживают --json и --format md."
allowed-tools: "Bash(python:*), Bash(python3:*), Bash(~/.nessy/skills/time-cli/time_cli.py:*), Bash(*/time_cli.py:*)"
---

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


# Time CLI

Скрипт лежит рядом с этим SKILL.md: `~/.nessy/skills/time-cli/time_cli.py`.
Один файл, только stdlib, переносимый — достаточно скопировать на любой хост
с Python 3.10+.

## Как запускать

Всегда вызывай по абсолютному пути. Инвокант — `python`:

```bash
python ~/.nessy/skills/time-cli/time_cli.py <command> [options]
```

Для агента:
- **`--json`** — машинный вывод (один JSON-объект на stdout).
- **`--format md`** — markdown-вывод (подходит для LLM-контекста).
- без флагов — человекочитаемый текст.

Ошибки всегда на stderr, exit codes 0/1/2/130.

## Креды

Скрипт читает `.env` из (в порядке приоритета):
1. текущая рабочая директория
2. директория скрипта (`~/.nessy/skills/time-cli/.env`)
3. `~/.env`

Переменные: `MM_URL`, `MM_TOKEN` (обязательный), `MM_CSRF` (для cookie-auth),
`MM_TEAM_ID` (опционально).

Проверка — самый дешёвый запрос:

```bash
python ~/.nessy/skills/time-cli/time_cli.py channels --limit 1 --json
```

Ошибка `401 Unauthorized` = токен протух. Новый: DevTools → Cookies →
`time.tbank.ru` → `MMAUTHTOKEN` и `MMCSRF`.

## Общие флаги

Во всех командах:

- `--json` — JSON-вывод
- `--format md` — markdown (если не JSON)
- `--tz Europe/Moscow` — таймзона для `--since/--until` (по умолчанию UTC)
- `--base-url`, `--token`, `--csrf`, `--team-id` — переопределение env
- `--delay` — задержка между API-запросами (по умолчанию 0.1с)
- `--no-cache` — отключить disk-cache
- `--debug` — verbose

## Disk-cache

Имена юзеров и каналов кэшируются на диске в `~/.cache/time-cli/<host>/`:
TTL 7 дней, ключ — hostname из `MM_URL`. Даёт ~1–2с ускорения на каждый
последующий вызов. Сбросить: `rm -rf ~/.cache/time-cli/`.

## Команды

### channels — список каналов

```bash
python ~/.nessy/skills/time-cli/time_cli.py channels [--pattern P] [--type T] [--limit N] [--max-pages N]
```
- `--pattern` — подстрока в `name`/`display_name` (case-insensitive)
- `--type` — `O` public, `P` private, `D` DM, `G` group DM
- `--limit` — остановиться после N совпадений (по умолчанию 50)
- `--max-pages` — кап пагинации (по умолчанию 10 = 1000 каналов)

Для DM и group возвращается `resolved_name` / `label` с именами участников,
например `dm:alice,bob` вместо `<uid>__<uid>`.

### dms — личные и групповые чаты

```bash
python ~/.nessy/skills/time-cli/time_cli.py dms [--with USERNAME] [--limit N]
```

### threads — отслеживаемые треды

```bash
python ~/.nessy/skills/time-cli/time_cli.py threads [--channel C[,C…]] [--mentions] \
  [--since D] [--until D] [--min-messages N] [--max-messages N] \
  [--include-participant U[,U…]] [--limit N] [--with-posts]
```
- `--mentions` — только с @упоминаниями
- `--include-participant` — оставить только треды, где участвуют указанные юзеры
- `--with-posts` — подгрузить посты (параллельно, до 20 тредов за раз)

### posts — сообщения канала

```bash
python ~/.nessy/skills/time-cli/time_cli.py posts --channel C [--since D] [--until D] \
  [--author U[,U…]] [--contains TEXT] [--limit N]
```

### search — полнотекстовый поиск

```bash
python ~/.nessy/skills/time-cli/time_cli.py search "QUERY" [--channel C[,C…]] \
  [--author U[,U…]] [--since D] [--until D] [--limit N] [--flat] [--expand N]
```

При нескольких авторах (`--author a,b,c`) выполняется N отдельных запросов
с `from:` и результаты объединяются — это даёт настоящий OR.

**`--expand N`** — для каждого найденного поста подтянуть N соседних постов
в том же треде (до и после). Экономит `thread --id` round-trip, когда
агенту нужен контекст вокруг хита. Посты грузятся параллельно (до 20).

**Diagnostics**: JSON-ответ содержит ключ `diagnostics` с полями:

- `queries_sent` — точные строки, отправленные в MM search
- `per_query_hits` — сколько вернулось на каждый sub-query
- `missing_authors` — авторы, которых нет на сервере (тест через `/users/username`)
- `channel_filter_ids/names` — резолвленные и исходные каналы
- `since_utc/until_utc` — фактические границы дат
- `raw_hits` vs `after_filters` — сколько MM нашёл всего vs сколько осталось после `--channel`
- `hints[]` — actionable подсказки, если результат пустой (ненайденный юзер, узкое окно, нет общих каналов)

### posts-by-user — все посты от пользователя(ей)

```bash
python ~/.nessy/skills/time-cli/time_cli.py posts-by-user --user USER[,USER...] \
  [--channel C[,C…]] [--since D] [--until D] [--limit N] [--flat]
```

Обёртка над `search`, которая не требует query-term. Поддерживает OR по авторам.

### user — профиль пользователя

```bash
python ~/.nessy/skills/time-cli/time_cli.py user USERNAME [--since D] [--until D] [--limit N]
```

Возвращает: `username`, `user_id`, `display_name`, `position`, статистику по
каналам за период (по умолчанию 30 дней), и список тредов.

### thread — один тред по ID/URL

```bash
python ~/.nessy/skills/time-cli/time_cli.py thread (--id ID | --url URL) \
  [--author U] [--contains TEXT] [--since D] [--until D]
```

### resolve — лукап имён → ID (точный и fuzzy)

```bash
python ~/.nessy/skills/time-cli/time_cli.py resolve [--users U,U] [--people "Name Surname"] [--channels C,C]
```

Всегда JSON. Три режима:

- **`--users`** — точный match по username. Если не найдено, `match: null` и поле `suggestions[]` с похожими из `/users/search`.
- **`--people`** — fuzzy lookup по display_name, email, nickname, username через `/users/search`. Полезно, когда агент знает фамилию, но не username. Возвращает до 10 кандидатов.
- **`--channels`** — резолв канала (точное имя или substring).

**Паттерн «сначала resolve, потом search»**: если агент не уверен в написании
username, сначала `resolve --people "Ivan Ivanov"` → взять `username` из ответа
→ передать в `search --author <username>`. Это устраняет false-negatives из-за
опечаток в username. Пример:

```bash
# Агент слышал "Женя Корнеев", не знает username
./time_cli.py resolve --people "Evgeniy Korneev"
# → [{"username": "e.s.korneev", "display_name": "Evgeniy Korneev", ...}]
./time_cli.py posts-by-user --user e.s.korneev --since 7d --json
```

### reply — ответ в тред (мутирующая!)

```bash
python ~/.nessy/skills/time-cli/time_cli.py reply --url URL --message "TEXT" [--dry-run]
```

- `-m -` или без флага — читать текст из stdin
- `--dry-run` — показать куда и что отправилось бы, БЕЗ фактической отправки

**Важно**: перед каждой реальной отправкой (`reply` без `--dry-run`) —
показывай пользователю текст и ссылку на тред, жди явного согласия.
`--dry-run` можно запускать автономно.

## Форматы дат

| Вход | Смысл |
|------|-------|
| `7d`, `24h`, `30m` | относительно «сейчас» |
| `2026-04-17` | полночь в `--tz` (для `--until` — конец дня) |
| `2026-04-17T12:30` | точный момент в `--tz` (если без TZ) |

Пример: `--since 2026-04-10 --tz Europe/Moscow` — начало 10 апреля в МСК.

## JSON-контракт

Все read-команды с `--json` возвращают стабильную структуру:

- **Post**: `{id, user_id, author, text, timestamp, create_at, channel_id, root_id, is_mention, permalink}`
- **ThreadData**: `{id, channel_id, channel_name, root_message, reply_count, last_reply_at, has_mentions, participant_ids[], posts[Post], message_count, last_message_time, url}`
- **ChannelInfo**: `{id, name, display_name, type, team_id, total_msg_count, resolved_name, label}`
- **SearchResult**: `{query, total_count, threads[ThreadData], posts[Post], diagnostics}`
- **diagnostics**: `{queries_sent[], per_query_hits{}, missing_authors[], channel_filter_ids[], channel_filter_names[], since_utc, until_utc, raw_hits, after_filters, hints[]}`

`permalink` и `url` — готовые ссылки в формате `https://<host>/_redirect/pl/<id>`.
`label` в `ChannelInfo` — человекочитаемое имя (`dm:alice,bob` для DM, иначе
display_name/name).

Время: `timestamp` и `last_reply_at` — ms since epoch (UTC), `create_at` — ISO-8601.

## Типичные сценарии

```bash
# Что писал пользователь за неделю — одной командой
python ~/.nessy/skills/time-cli/time_cli.py user v.levchuk --since 7d --json

# Все посты двух людей вместе (логический OR)
python ~/.nessy/skills/time-cli/time_cli.py posts-by-user --user alice,bob --since 14d --json

# Треды, где участвовал конкретный человек (не обязательно автор root)
python ~/.nessy/skills/time-cli/time_cli.py threads --include-participant alice --since 7d --json

# Поиск с группировкой, markdown для LLM
python ~/.nessy/skills/time-cli/time_cli.py search "postgres migration" --channel dev-ops --since 14d --format md

# Превью ответа без отправки
python ~/.nessy/skills/time-cli/time_cli.py reply --url "https://..." --message "ок" --dry-run

# Резолв имён перед точным запросом
python ~/.nessy/skills/time-cli/time_cli.py resolve --users alice,bob --channels dev-ops

# Что обсуждали в канале за сутки (МСК)
python ~/.nessy/skills/time-cli/time_cli.py posts --channel sage-support --since 24h --tz Europe/Moscow --format md

# Найти юзера по display name (без гадания), потом получить его посты
python ~/.nessy/skills/time-cli/time_cli.py resolve --people "Vladimir Levchuk"
python ~/.nessy/skills/time-cli/time_cli.py posts-by-user --user v.levchuk --since 7d --json

# Поиск с контекстом (3 соседних поста вокруг каждого хита)
python ~/.nessy/skills/time-cli/time_cli.py search "migration" --since 7d --expand 3 --json

# Если search вернул 0 — смотри diagnostics.hints в JSON
python ~/.nessy/skills/time-cli/time_cli.py search "foo" --author unknown --json | jq .diagnostics.hints
```

## Производительность

Все резолверы используют MM bulk-эндпоинты
(`POST /users/ids`, `POST /channels/ids`). Имена кэшируются:
- **In-memory** — в рамках одного запуска
- **Disk** — между запусками, 7 дней, в `~/.cache/time-cli/<host>/`

Параллельная загрузка постов тредов в `threads --with-posts` (до 20 workers).

Ориентиры на живом Time (~2600 каналов, cold cache):
- `channels --limit 10` — ~2с / ~1с warm
- `posts --since 24h --limit 5` — ~4с
- `search QUERY --since 7d` — ~8с

## Known limitations

- **Только reply, не root-пост**: `reply` требует URL/ID существующего треда.
- **Нет реакций/эмодзи/редактирования**: только чтение и ответ в тред.
- **Нет аплоада файлов**: вложения не отправляются.
- **Поиск — через Mattermost API**: синтаксис ограничен (`"phrase"`, `from:user`, `in:channel`).
- **OR по каналам в `--channel`** — post-filter, не server-side.
- **Cookie-auth**: токен `MMAUTHTOKEN` живёт ~месяц.
- **Нет push/streaming**: только polling.
- **Видимость ограничена**: поиск видит только каналы/DM, где у твоей учётки есть доступ.

## Exit codes

- `0` — успех
- `1` — доменная ошибка (не найдено, не авторизован)
- `2` — проблема конфигурации (нет токена, плохой ввод)
- `130` — Ctrl-C

## Автономность

Все read-команды (`channels`, `dms`, `threads`, `posts`, `search`, `thread`,
`user`, `posts-by-user`, `resolve`) плюс `reply --dry-run` — разрешены без
подтверждения. Запускай напрямую.

**Рекомендованный агентский workflow** при поиске сообщений пользователя:

1. Если username неточен — сначала `resolve --people "Display Name"` для fuzzy-поиска.
2. Вызвать `posts-by-user --user <resolved-username>` или `search --author <u>`.
3. Если вернулось 0 — прочитать `diagnostics.hints`, действовать по подсказкам.
4. Для контекста вокруг хитов — добавить `--expand 3` (или больше).

`reply` без `--dry-run` — единственная мутирующая операция. Всегда показывай
пользователю текст и ссылку на тред, жди явного согласия перед отправкой.
