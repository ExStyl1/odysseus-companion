# computer-use-disabled-by-default

## AIDT

AIDT-7786

## Зачем

Upstream nessy-cli по умолчанию включает computer use (cua-driver `computer_use__*`
инструменты), из-за чего агент при первом использовании запрашивает у пользователя
доступ к управлению мышью и экраном. Для пользователей это массово даёт негативный
опыт (непонятный запрос разрешения) при незначительной пользе, а сам функционал
является опасным. Этот патч меняет значение по умолчанию `tools.computerUse.enabled`
на `false` — агент не использует computer use, пока пользователь явно не включит его
в конфигурации.

## Файлы

- `packages/core/src/config/config.ts` — дефолт `computerUseEnabled` с `true` на `false` (поле + конструктор)
- `packages/cli/src/config/config.ts` — маппинг `settings.tools?.computerUse?.enabled` с fallback `false`
- `packages/cli/src/config/settingsSchema.ts` — `computerUse.enabled.default` с `true` на `false`
- `packages/vscode-ide-companion/schemas/settings.schema.json` — перегенерация из `settingsSchema.ts`
- `packages/core/src/config/config.test.ts` — тесты: дефолт `false`, явное включение и регистрация инструментов

## Откат

1. Вернуть `params.computerUseEnabled ?? true` в `packages/core/src/config/config.ts`
2. Вернуть `settings.tools?.computerUse?.enabled ?? true` в `packages/cli/src/config/config.ts`
3. Вернуть `default: true` в `settingsSchema.ts` и перегенерировать schema
4. Убрать тесты, ожидающие дефолт `false`, из `config.test.ts`
5. Удалить `[nessy-fork] computer-use-disabled-by-default` маркеры, этот файл и строку из README.md

## Upstream

Не отправлен. Намеренное расхождение с upstream — локальная политика безопасности.