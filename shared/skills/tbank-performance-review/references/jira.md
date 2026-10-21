# Jira

Используй authenticated read-only Jira MCP tools Nessy. Jira instances (`jira`, `jira2`, `jira3`) исследуй отдельно.

## Воронка

1. Разреши identity через доступные metadata/user fields.
2. Начни с exact issue IDs и компактного JQL по identity в `search_window`; запрашивай минимальные поля и небольшую страницу.
3. Добавь отдельные запросы по устойчивым терминам исходных целей.
4. Раскрой description, links, parent/epic и transitions только для semantic shortlist.
5. Извлеки repository, document URL, service и формулировки результата как cross-system seeds.

Identity-выдачу листай до reported total, пустой страницы или platform cap. Для каждой исходной цели выполни goal-term поиск, даже если identity search уже дал много задач. Сохраняй каждую страницу до следующего read.

Текущее назначение, историческую связь и завершение внутри `review_period` фиксируй отдельно. `assignee + Done` подтверждает связанную выполненную задачу, но не весь личный вклад, production outcome или ценность. Усечённая identity-выдача, непроверенная пагинация или детали только малой части semantic shortlist означают `partial`.
