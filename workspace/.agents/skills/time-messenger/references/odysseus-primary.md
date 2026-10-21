
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


# TiMe Messenger

TiMe — корпоративный мессенджер на базе Mattermost. Доступен через MCP-сервер `time`.

## Главная ловушка: приватные каналы

`search_channels` **не находит приватные каналы**. Почти все рабочие каналы команды приватные.

Правильный алгоритм поиска канала:
1. Сначала попробуй `search_channels(term="<name>")` — быстро, работает для публичных.
2. Если результат пустой — `get_user_channels(type="private", limit=200)`, затем фильтруй по полю `name`.
3. Если нужны и DM, и каналы сразу — `get_user_channels(limit=200)` без фильтра.

Канал из URL `https://time.tbank.ru/tinkoff/channels/<channel-name>`:
- Возьми `<channel-name>` как имя канала.
- Ищи в `get_user_channels()` по полю `name`.

## Операции

### Личное сообщение (DM)

```
dm(username="s.germanovskiy", message="Текст")
```

`username` — без `@`. Канал создаётся автоматически, знать `channel_id` не нужно.

### Сообщение в канал

```
create_post(channel_id="<26-char id>", message="Текст")
```

`channel_id` берётся из результата `get_user_channels()` (поле `id`).

### Ответ в тред

Для ответа в тред нужен только `root_id` — `channel_id` не обязателен, разрешается автоматически:

```
create_post(root_id="<post_id>", message="Текст")
```

### Чтение сообщений

```
read_channel(channel_id="...")    # последние посты канала (включая ответы в тредах!)
read_post(post_id="...")          # сообщение + весь тред
get_threads(unread_only=true)     # непрочитанные треды
get_mentions()                    # упоминания (@me)
```

**Корневые сообщения против ответов в тредах.** `read_channel` возвращает все посты подряд: и корневые сообщения канала, и реплики внутри тредов (у реплик заполнено поле `root_id`). Когда пользователь просит "последние N сообщений канала", он имеет в виду корневые сообщения, а не реплики из тредов - иначе один активный тред вытеснит всю остальную ленту.

Алгоритм:
1. `read_channel(channel_id, limit=50, with_thread_count=true)` - бери с запасом, реплики съедают лимит.
2. Отфильтруй корневые посты: у них нет `root_id` (или `root_id` пустой).
3. Возьми последние N корневых и покажи их; если у поста есть тред, упомяни `reply_count` рядом.

Реплики из треда показывай только когда пользователь явно просит тред ("что ответили", "покажи обсуждение") - тогда `read_post(post_id=<root_id>)`.

### team_id

Если инструмент требует `team_id` — бери его из поля `team_id` в результате `get_user_channels()`. Не угадывай и не используй slug из URL браузера — это разные вещи.

## Быстрые сценарии

| Задача | Действие |
|---|---|
| Написать коллеге | `dm(username, message)` |
| Написать в канал по имени | `get_user_channels(type="private")` → найти → `create_post` |
| Найти канал по URL | взять `<name>` из URL → `get_user_channels()` → фильтр по `name` |
| Ответить в тред | `create_post(root_id=<post_id>, message=...)` |
| Прочитать переписку | найти `channel_id` → `read_channel` → фильтр корневых постов (без `root_id`) |
| Проверить упоминания | `get_mentions()` |

## Инструменты сервера `time`

| Инструмент | Назначение |
|---|---|
| `dm` | Личное сообщение по username |
| `create_post` | Сообщение в канал или ответ в тред |
| `search_channels` | Поиск публичных каналов (не видит приватные) |
| `get_user_channels` | Все каналы пользователя, включая приватные и DM |
| `get_channel_info` | Метаданные канала по ID или имени + team_id |
| `read_channel` | Чтение сообщений канала |
| `read_post` | Чтение сообщения + тред |
| `get_threads` | Треды (фильтр unread_only) |
| `get_mentions` | Упоминания пользователя |
| `get_unread_channels` | Каналы с непрочитанными сообщениями |

## Safety

Перед отправкой сообщения всегда показывай текст пользователю для согласования, если он не продиктовал его дословно. Не отправляй от имени пользователя без явного подтверждения.
