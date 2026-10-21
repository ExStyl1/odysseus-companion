---
name: "analytics-sql"
description: "Написание аналитического SQL: бизнес-метрики, оконные функции, когорты и удержание."
disable-model-invocation: false
user-invocable: true
when_to_use: "Когда запрос относится к указанной корпоративной системе или процессу; передай ссылку, идентификатор, окружение и ожидаемый результат."
---

<!-- odysseus-invocation-policy -->
## Выбор и запуск

Навык можно выбирать автоматически, когда текущая задача соответствует описанию. Загружай только нужный режим и относящиеся к нему ресурсы.

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


# Analytics SQL

REQUIRED REFERENCE SKILL: Use `query-optimization` when an analytical SQL query is slow, requires EXPLAIN/EXPLAIN ANALYZE, index analysis, join-order tuning, or N+1 query investigation.

This skill owns analytical query expression, not schema design or CRUD.

## Use For

- business metrics and reporting SQL;
- window functions: `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `LAG`, `LEAD`, `SUM(...) OVER`;
- CTE decomposition with `WITH`;
- aggregations and time buckets;
- `ROLLUP`, `CUBE`, and `GROUPING SETS`;
- cohort, retention, funnel, and Pareto-style calculations.

## Rules

- Use CTEs for multi-step analytics; avoid deeply nested queries.
- Make `PARTITION BY` and `ORDER BY` explicit for window functions.
- Handle nulls intentionally with `COALESCE` and `NULLIF`.
- Use `WHERE` before aggregation and `HAVING` after aggregation.
- Group time through `DATE_TRUNC` or the database-native equivalent.
- Validate results with sanity totals and sample rows before presenting metrics.
- Do not run destructive SQL.

## Patterns

```sql
WITH monthly AS (
  SELECT
    DATE_TRUNC('month', created_at) AS month,
    user_id,
    SUM(total) AS revenue
  FROM orders
  WHERE created_at >= DATE '2026-01-01'
  GROUP BY DATE_TRUNC('month', created_at), user_id
)
SELECT
  month,
  user_id,
  revenue,
  ROW_NUMBER() OVER (PARTITION BY month ORDER BY revenue DESC) AS rn
FROM monthly;
```

```sql
SELECT
  DATE_TRUNC('month', created_at) AS month,
  status,
  COUNT(*) AS orders_count,
  SUM(total) AS revenue
FROM orders
GROUP BY ROLLUP (DATE_TRUNC('month', created_at), status);
```

```sql
SELECT
  user_id,
  DATE_TRUNC('month', created_at) AS month,
  COUNT(*) AS orders_count
FROM orders
GROUP BY GROUPING SETS (
  (user_id),
  (DATE_TRUNC('month', created_at)),
  (user_id, DATE_TRUNC('month', created_at)),
  ()
);
```

## Output

```markdown
## Analytical Query

### Metric Definition

### SQL

### Validation Checks

### Assumptions
```
