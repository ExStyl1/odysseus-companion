# user-quota-display

## AIDT

- AIDT-7444

## Зачем

Пользователю Nessy CLI нужно видеть актуальные лимиты своего аккаунта без
перехода во внешний интерфейс. Патч добавляет DP Auth-клиент квот и команду
`/quota`, доступную в TUI, non-interactive и ACP. Ответ форматируется с
прогресс-баром, цветом и значком состояния, временем сброса и областью действия.
Тип и значения области действия выводятся без перевода в том виде, в котором
они пришли с backend.

При запуске новой сессии и после завершённого ответа модели TUI запрашивает
квоты и показывает краткое проактивное уведомление при `state` равном `warning`
или `exhausted`. Только развёрнутое содержимое квот фиксировано на русском
языке. Описание команды, служебные сообщения о загрузке и ошибках, а также
проактивные уведомления локализованы для русского и английского UI; для
остальных языков используется английский fallback.

## Файлы

- `packages/core/src/core/openaiContentGenerator/constants.ts`
- `packages/core/src/dp/index.ts`
- `packages/core/src/dp/user-quota-client.ts`
- `packages/core/src/dp/user-quota-client.test.ts`
- `packages/core/src/index.ts`
- `packages/cli/src/services/BuiltinCommandLoader.ts`
- `packages/cli/src/services/BuiltinCommandLoader.test.ts`
- `packages/cli/src/ui/AppContainer.tsx`
- `packages/cli/src/ui/commands/quota-command.ts`
- `packages/cli/src/ui/commands/quota-command.test.ts`
- `packages/cli/src/ui/hooks/use-quota-notifications.ts`
- `packages/cli/src/ui/hooks/use-quota-notifications.test.ts`
- `packages/cli/src/ui/hooks/useSlashCompletion.integration.test.ts`
- `packages/cli/src/ui/utils/format-user-quota.ts`
- `packages/cli/src/ui/utils/format-user-quota.test.ts`
- `packages/cli/src/i18n/locales/en.js`
- `packages/cli/src/i18n/locales/ru.js`
- `docs/users/features/commands.md`
- `mock-quota-server/server.py`
- `mock-quota-server/README.md`

Кодовые точки помечены `// [nessy-fork] user-quota-display`.

## Откат

1. Удалить DP Auth-клиент квот, endpoint и публичные экспорты из `core`.
2. Удалить форматтер и регистрацию команды `/quota` во всех режимах, включая
   связанные тесты и локализованное описание команды.
3. Удалить `useQuotaNotifications` и его вызов из `AppContainer`.
4. Удалить маркеры `// [nessy-fork] user-quota-display`, эту документацию и
   строку из реестра fork-патчей.

## Upstream

Не отправлен.
