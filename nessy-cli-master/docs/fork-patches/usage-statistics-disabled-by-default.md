# usage-statistics-disabled-by-default

## AIDT

AIDT-7004

## Зачем

Upstream nessy-cli по умолчанию отправляет телеметрию (`usageStatisticsEnabled: true`).
Во внутренней сборке требуется явное согласие пользователя на отправку статистики.
Этот патч меняет значение по умолчанию на `false` — телеметрия отключена, пока пользователь
явно не включит её в конфигурации.

## Файлы

- `packages/core/src/config/config.ts` — изменение значения по умолчанию `usageStatisticsEnabled` с `true` на `false`
- `packages/core/src/config/config.test.ts` — обновление теста, проверяющего значение по умолчанию

## Откат

1. Вернуть `params.usageStatisticsEnabled ?? true` в `config.ts` (строка ~1518)
2. Обновить тест в `config.test.ts` на ожидание `true`
3. Удалить этот файл патча и строку из таблицы README.md

## Upstream

Не отправлен. Намеренное расхождение с upstream — внутренняя политика приватности.
