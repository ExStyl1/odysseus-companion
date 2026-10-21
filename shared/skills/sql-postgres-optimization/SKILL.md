---
name: "sql-postgres-optimization"
description: "Оптимизация PostgreSQL: планы запросов, индексы и проверяемые миграции Liquibase."
tags: ["sql","postgres","liquibase","index","migrations","optimization"]
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


# PostgreSQL: индексы и Liquibase миграции

## Liquibase формат миграций

В проекте target все Postgres миграции — Liquibase XML.

### Именование файлов
```
{YYYY}-{MM}-{DD}-{TICKET}-{описание}.xml
```
Пример: `2024-07-05-TGT-36456-create-partner-id-index-in-offer-table.xml`

### CREATE TABLE
```xml
<databaseChangeLog xmlns="http://www.liquibase.org/xml/ns/dbchangelog"
                   xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                   xsi:schemaLocation="http://www.liquibase.org/xml/ns/dbchangelog
                   https://www.liquibase.org/xml/ns/dbchangelog/dbchangelog-4.20.xsd">

    <changeSet id="2024-01-24-TGT-29380-create-offer-table" author="a.developer">
        <createTable tableName="offer" remarks="Данные по офферам">
            <column name="id" type="bigint" remarks="Идентификатор оффера">
                <constraints primaryKey="true" nullable="false"/>
            </column>
            <column name="partner_id" type="bigint" remarks="Идентификатор партнёра">
                <constraints nullable="false"/>
            </column>
            <column name="name" type="text" remarks="Название оффера">
                <constraints nullable="false"/>
            </column>
            <column name="status" type="text" remarks="Статус оффера">
                <constraints nullable="false"/>
            </column>
            <column name="created_at" type="timestamptz" remarks="Дата создания">
                <constraints nullable="false"/>
            </column>
            <column name="version" type="bigint" remarks="Версия для optimistic locking">
                <constraints nullable="false"/>
            </column>
        </createTable>
    </changeSet>

</databaseChangeLog>
```

### Обычный индекс через `<createIndex>`
```xml
<changeSet id="2024-08-30-TGT-39412-create-age-task-indexes" author="a.developer">
    <createIndex indexName="age_task_process_id_task_type_idx" tableName="age_task">
        <column name="process_id"/>
        <column name="task_type"/>
    </createIndex>
    <createIndex indexName="age_task_status_idx" tableName="age_task">
        <column name="status"/>
    </createIndex>
</changeSet>
```

### CONCURRENTLY индекс — для production таблиц
Для таблиц с данными используй `CREATE INDEX CONCURRENTLY` — не блокирует таблицу.
Требует `runInTransaction="false"`:

```xml
<changeSet id="2024-07-05-TGT-36456-create-partner-id-index-in-offer-table"
           author="a.developer"
           runInTransaction="false">
    <sql dbms="postgresql">
        CREATE INDEX CONCURRENTLY
            IF NOT EXISTS idx_offer_partner_id
            ON offer(partner_id)
    </sql>
</changeSet>
```

### Частичный индекс (Partial Index)
Для колонок где большинство значений NULL или нужен индекс только по части строк:

```xml
<changeSet id="2025-03-26-TGT-49749-create-offer-s3-key-index"
           author="a.developer"
           runInTransaction="false">
    <sql dbms="postgresql">
        CREATE INDEX CONCURRENTLY offer_s3_key_idx
            ON offer (s3_key)
            WHERE s3_key IS NOT NULL
    </sql>
</changeSet>
```

### Внешний ключ
```xml
<changeSet id="2025-02-06-TGT-45817-create-offer-essence-table" author="a.developer">
    <createTable tableName="offer_essence">
        <column name="offer_id" type="bigint">
            <constraints nullable="false"/>
        </column>
        <column name="essence_id" type="bigint">
            <constraints nullable="false"/>
        </column>
        <column name="essence_type" type="text">
            <constraints nullable="false"/>
        </column>
    </createTable>

    <addPrimaryKey tableName="offer_essence"
                   columnNames="offer_id,essence_id,essence_type"/>

    <addForeignKeyConstraint
        baseTableName="offer_essence"
        baseColumnNames="offer_id"
        constraintName="offer_essence_offer_id_fk"
        referencedTableName="offer"
        referencedColumnNames="id"/>
</changeSet>
```

### ADD COLUMN
```xml
<changeSet id="2024-10-01-TGT-41000-add-is-hidden-to-offer" author="a.developer">
    <addColumn tableName="offer">
        <column name="is_hidden" type="boolean" defaultValueBoolean="false" remarks="Скрытый оффер">
            <constraints nullable="false"/>
        </column>
    </addColumn>
</changeSet>
```

## Индексирование: когда что создавать

| Сценарий | Тип индекса | Пример |
|---|---|---|
| Фильтрация по FK | Обычный | `ON offer(partner_id)` |
| Составной WHERE | Составной | `ON age_task(process_id, task_type)` |
| Nullable колонка | Partial `WHERE col IS NOT NULL` | `ON offer(s3_key) WHERE s3_key IS NOT NULL` |
| Boolean флаг | Partial `WHERE flag = true` | `ON offer(id) WHERE is_active = true` |
| Таблица с данными | CONCURRENTLY + runInTransaction=false | всегда для prod |
| Новая пустая таблица | `<createIndex>` | в том же changeSet |

## EXPLAIN ANALYZE — диагностика медленных запросов

```sql
-- Запускать в dev/staging, не в prod
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT o.id, o.name, p.brand_id
FROM offer o
JOIN offer_loyalty_program p ON p.offer_id = o.id
WHERE o.status = 'ACTIVE'
  AND p.program_type = 'CASHBACK'
ORDER BY o.created_at DESC
LIMIT 100;
```

На что смотреть:
- `Seq Scan` на большой таблице → нужен индекс
- `rows=10000` но `actual rows=1` → устаревшая статистика, запусти `ANALYZE table_name`
- `Hash Join` vs `Nested Loop` — для небольших наборов Nested Loop быстрее
- `Buffers: shared hit` — данные из кэша (хорошо), `read` — с диска (медленно)

## Kotlin: запросы в коде

SQL в Kotlin всегда через `trimIndent()` для читаемости:

```kotlin
private val FIND_BY_STATUS_SQL = """
    SELECT id, partner_id, name, status, created_at
    FROM offer
    WHERE status = :status
      AND is_hidden = false
    ORDER BY created_at DESC
    LIMIT :limit
""".trimIndent()

fun findByStatus(status: String, limit: Int = 100): List<Offer> =
    jdbcTemplate.query(
        FIND_BY_STATUS_SQL,
        mapOf("status" to status, "limit" to limit),
        DataClassRowMapper(Offer::class.java),
    )
```

Никогда не конкатенируй параметры в строку — только `:paramName`:
```kotlin
// ❌ SQL injection
"WHERE id = $id"
// ✅ Named parameter
"WHERE id = :id"
```

## Правила миграций

- Один логический change = один `<changeSet>`
- `id` changeSet = имя файла (без расширения)
- Индексы на таблицы с данными → всегда `CONCURRENTLY` + `runInTransaction="false"`
- Имена индексов: `{table}_{column(s)}_idx`
- Имена FK: `{child_table}_{column}_fk`
- Всегда добавляй `remarks` к колонкам — это документация схемы
