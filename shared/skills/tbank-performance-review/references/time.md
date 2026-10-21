# Time

Time — allowlist-only источник. Используй authenticated read-only Time MCP tools Nessy и их актуальные runtime schemas. Для исторического периода основной инструмент — `search_posts`: он поддерживает server-side даты, author/channel filters и явные `has_more/next_page`. `read_channel` с прошедшими `since/until` фильтрует только новейшую страницу канала и может вернуть ложный ноль.

## Разрешение identity и каналов

1. Разреши login через exact `get_user_info(username=..., fields=["user_id","username"])` и используй возвращённый `user_id`. Не запрашивай email, name и другие поля, не нужные для identity match.
2. Обрабатывай каждое переданное пользователем значение как один атомарный пункт: символ `@` внутри `qa_platform_@_global` является частью slug, а не разделителем. Нормализуй только синтаксис: убери ведущий `~`, а из URL извлеки team slug и полный channel slug без сокращений. `search_channels` используй лишь для получения `team_id` и диагностики; его fuzzy-кандидаты никогда не являются выбранным каналом.
3. Вызови `get_channel_info(channel_name=<полный исходный slug>, team_id=...)`. Если lookup по имени ошибся, но `search_channels.structuredContent` вернул кандидата с `name`, полностью равным исходному slug, вызови `get_channel_info(channel_id=<candidate id>)` и прими его только при полном равенстве `structuredContent.name`. Этот fallback нужен для slug со специальными символами вроде `@`; текстовое представление ответа может потерять такой символ, поэтому canonical name и ID бери из `structuredContent`, а не из display text. Частичное или fuzzy-совпадение сюда не относится.
4. Если name lookup вернул объект, зафиксируй mapping `requested slug → canonical name → channel ID`. При различии имён подтверди rename вторым сигналом: `search_posts(channel_name=<исходный slug>, ...)` должен реально вернуть posts с тем же canonical channel ID. Только тогда исследуй canonical ID как alias исходного канала. Если ни exact-name, ни exact-candidate, ни подтверждённый alias не сработали, пометь именно этот allowlisted канал unresolved; не подставляй `*-releases`, `*-private`, `*-alerts` или любой другой похожий slug.

Канал считается отсутствующим или недоступным только после этих проверок. Нулевой результат поиска в разрешённом канале — валидное покрытие, но не причина пропускать остальные стратегии. В сводке обязательно покажи mapping каждого пользовательского значения; несовпадающий fuzzy slug — ошибка scope, а не частичное покрытие.

## Поисковая воронка

Для каждого разрешённого allowlisted канала выполни все слои по порядку. **Inventory gate:** целевой поиск и синтез начинаются только после отдельного author inventory всех разрешённых каналов через `search_posts`.

### 1. Авторский inventory

Вызови `search_posts` без `query`, но с exact `channel_id`, `author_id`, inclusive `from_date/to_date` для `search_window`, `limit=100`, `page=0`. Так как workflow хранит полуоткрытый интервал, для дневного inclusive API используй `to_date = search_end - 1 день`. Это отдельный tool call на каждый разрешённый канал; результаты keyword/goal search не являются author inventory.

Форма первого вызова:

```json
{
  "channel_id": "<canonical id>",
  "author_id": "<exact employee user_id>",
  "from_date": "<search_start YYYY-MM-DD>",
  "to_date": "<search_end minus one day YYYY-MM-DD>",
  "limit": 100,
  "page": 0
}
```

Для исторического review не используй `read_channel` как inventory: его date range применяется только к новейшей странице. `read_post` используй позже только для выбранных threads.

Перед подсчётом проверь response scope: каждый `structuredContent.posts[].channel_id` должен равняться `channel_id` из arguments, каждый author — сотруднику, каждый timestamp — попадать в `search_window`. Несовпадение хотя бы одного channel ID означает, что вызов был выполнен без нужного channel filter: не считай этот ответ и повтори call с точным `channel_id`.

Пока `has_more=true`, следуй `next_page`; остановись при `has_more=false`, пустой странице либо platform cap. Проверь и `structuredContent`, и текстовые content blocks: в них могут находиться `Reply to/root_id`, ссылки и полный preview, отсутствующие в структурированном объекте. Сохрани число страниц и общее число авторских сообщений. Полный author-filtered проход внутри пользовательского allowlist — bounded collection, а не массовая выгрузка.

### 2. Целевой поиск

Разложи каждую исходную цель на короткие независимые seeds:

- точные task IDs и URLs из других систем;
- уникальные service/component names;
- один технический термин или короткую устойчивую фразу;
- слова результата, если они действительно различают задачу.

Ищи каждый сильный seed отдельным `search_posts` по `channel_id` и `search_window`. Для одного термина или устойчивой фразы предпочитай `query_type=exact`. Большой OR-запрос не заменяет отдельные запросы: Time может вернуть ноль для длинного набора, даже когда отдельные термины дают результаты. `OR` применяй только к короткой проверенной паре близких вариантов; при неожиданном нуле повтори хотя бы два самых сильных seed раздельно.

Целевой поиск выполняй без author filter, чтобы увидеть постановку, ответы коллег, упоминания сотрудника, согласование и подтверждение outcome. Для каждой цели либо найди релевантный thread, либо зафиксируй отрицательные результаты минимум по трём различным сильным seeds, если столько seeds доступны.

### 3. Группировка и раскрытие threads

Сгруппируй найденные сообщения по `root_id`; standalone posts оставь отдельными эпизодами. Приоритизируй threads, где есть сообщения сотрудника и хотя бы один из сигналов: task/MR/document URL, разбор вариантов, blocker, stage/prod, merge/release, проверка результата или подтверждение другого участника.

Для каждого high-signal thread вызови `read_post(root_id, include_thread=true)`. Извлеки не отдельную реплику, а последовательность:

```text
постановка → исследование/варианты → действие сотрудника → координация
→ артефакты → stage/prod событие → проверка результата
```

Различай собственный вклад сотрудника и действия коллег. Короткие ответы вроде «готово», «работает» или «взлетело» интерпретируй только вместе с root и соседними replies. Ссылки на Jira, Tracker, GitLab, Wiki и production evidence верни координатору как cross-system seeds.

### 4. Coverage-checkpoint

До синтеза составь внутренний preflight-реестр — ровно одна строка на каждый исходный allowlist item, без добавленных похожих каналов:

```text
requested | exact lookup | canonical/id | alias probe
| author pages/posts | goal seeds tried | candidate/expanded threads | status
```

Вернись к MCP, если в строке разрешённого канала не заполнено хотя бы одно поле покрытия. Для alias probe используй `search_posts` с исходным `channel_name`, exact `author_id`, датами, `query` omitted и `limit>0`; совпадение channel ID является подтверждением даже при отличающемся canonical name. В preflight также зафиксируй фактические arguments первого inventory call и результат scope-проверки `all post channel IDs match: yes/no`; `no` запрещает использовать этот счётчик. Сообщение с timestamp вне дат также означает ошибку фильтра и не включается в счётчик.

Канал имеет статус `complete`, только если:

- разрешены canonical ID и возможный rename;
- author inventory пройден до `has_more=false`;
- каждая цель получила релевантный результат либо документированный multi-seed negative;
- все high-signal candidate threads раскрыты;
- известны число страниц, author posts, релевантных threads и truncation.

Иначе ставь `partial` и называй конкретный непройденный слой. Ноль сообщений допустим только после author inventory и целевого multi-seed поиска. В сводке покажи исходный mapping и funnel metrics по каждому каналу: `author_posts → candidate_threads → expanded_threads → evidence_items`. Сумма `author_posts` в сводке должна совпадать с суммой страниц preflight-реестра.

## Доказательства и безопасность

Time-сообщение само по себе подтверждает наблюдаемое высказывание или координацию. Сильный outcome требует содержимого thread и, по возможности, связанного merged MR, task transition, production check или независимого подтверждения.

Ответы Time могут содержать credentials, tokens, личные email и другие лишние персональные данные. Перед сохранением raw немедленно заменяй такие значения на `<REDACTED>`; не повторяй их в сводке даже как цитату. Файл с расширением `.json` должен быть валидной сериализацией объекта; для составленной моделью сводки используй `.md`, а не псевдо-JSON. Каналы вне allowlist, DM и групповые чаты не исследуй.
