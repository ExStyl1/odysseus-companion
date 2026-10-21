# Tracker

Используй authenticated read-only T-Tracker MCP tools Nessy. Exact TQL и поля бери из runtime schema.

## Воронка

1. Проверь соединение через `get_current_user`, затем разреши сотрудника через `get_user_by_login`.
2. Если синтаксис TQL неизвестен, прочитай `get_tql_documentation` и выполни минимальный `search_tasks` по exact login или user ID.
3. Ищи exact task IDs, затем задачи identity в абсолютном `search_window` компактными страницами.
4. Проверь исходные цели отдельными запросами по устойчивым терминам.
5. Раскрой description, ancestors, links и outcome comments только для shortlist.
6. Извлеки space, parent/epic, зависимости, repository/document references и новые seeds.

Tracker MCP может вернуть несколько content blocks: текстовое описание schema перед структурированным объектом результата. Проверь все blocks и `structuredContent`; наличие schema-блока не означает ошибку, если следующий block содержит user/task data. Нормализуй структурированный объект, а служебный schema-текст не переноси в пользовательскую сводку.

Если после проверки всех blocks ответ действительно содержит только schema, пустой envelope или неожиданный payload, сохрани точный ответ как transport anomaly и повтори проверку через другой минимальный read-only tool. Не называй это authentication error без наблюдаемого `401`, `403`, `unauthorized` или `unauthenticated`.

`failed` допустим только после минимум трёх разных диагностических попыток: connection/current user, identity и task search. Если часть tools работает либо причина неоднозначна, ставь `partial` и продолжай поиск по exact task IDs и терминам целей, где это возможно.

Отделяй текущую связь сотрудника, историческую связь и факт завершения внутри `review_period`. При platform cap сохраняй покрытый диапазон и ставь `partial`, не скрывая усечение. `complete` требует identity+search-window выдачу, goal-term поиск и проверенную пагинацию.
