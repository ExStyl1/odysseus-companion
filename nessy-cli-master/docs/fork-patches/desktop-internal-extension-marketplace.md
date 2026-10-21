# desktop-internal-extension-marketplace

## AIDT

-

## Зачем

Добавить во встроенное Desktop-приложение поддержку установки расширений из внутреннего маркетплейса (skills-market.t-tech.team). Upstream Nessy CLI работает только с публичным npm-реестром и локальными расширениями — внутренняя витрина расширений нужна только для нашей инсталляции.

Фича добавляет:
- RPC-каналы `extensions.MARKETPLACE_LIST` и `extensions.MARKETPLACE_INSTALL`
- Клиент внутреннего API (`internal-marketplace.ts`) для получения списка расширений и метаданных
- Интеграцию с Extension Manager из `@nestor/nessy-cli-core` для установки расширений
- UI-панели в renderer: `ExtensionMarketplacePanel` и `ExtensionMarketplaceDetailPanel`
- Маршруты и навигацию для просмотра и установки расширений

## Файлы

- `packages/desktop/packages/server-core/src/handlers/rpc/extensions.ts` — RPC-обработчики marketplace list/install
- `packages/desktop/packages/server-core/src/handlers/rpc/index.ts` — регистрация `registerExtensionsHandlers`
- `packages/desktop/packages/server-core/src/services/internal-marketplace.ts` — клиент внутреннего API
- `packages/desktop/packages/server-core/src/services/internal-marketplace.test.ts` — тесты клиента
- `packages/desktop/packages/shared/src/protocol/channels.ts` — определение RPC-каналов
- `packages/desktop/packages/shared/src/protocol/dto.ts` — DTO для marketplace items
- `packages/desktop/packages/shared/src/protocol/routing.ts` — маршрут `extensionMarketplace`
- `packages/desktop/apps/electron/src/shared/routes.ts` — route builder
- `packages/desktop/apps/electron/src/shared/types.ts` — типы навигации
- `packages/desktop/apps/electron/src/renderer/components/app-shell/ExtensionMarketplacePanel.tsx` — список расширений
- `packages/desktop/apps/electron/src/renderer/components/app-shell/ExtensionMarketplaceDetailPanel.tsx` — детальная карточка
- `packages/desktop/apps/electron/src/renderer/components/app-shell/MainContentPanel.tsx` — рендер панелей marketplace
- `packages/desktop/apps/electron/src/renderer/context/AppShellContext.tsx` — контекст навигации
- `packages/desktop/apps/electron/src/renderer/contexts/NavigationContext.tsx` — обработка маршрутов
- `packages/desktop/apps/electron/src/renderer/atoms/panel-stack.ts` — стек панелей
- `packages/desktop/apps/electron/src/main/platform.ts` — platform factory (без изменений, только импорт)
- `packages/desktop/apps/electron/src/transport/channel-map.ts` — маппинг каналов
- `packages/desktop/apps/electron/src/shared/__tests__/route-parser-extension-marketplace.test.ts` — тесты роутов

## Откат

1. Удалить файлы:
   - `packages/desktop/packages/server-core/src/handlers/rpc/extensions.ts`
   - `packages/desktop/packages/server-core/src/services/internal-marketplace.ts`
   - `packages/desktop/packages/server-core/src/services/internal-marketplace.test.ts`
   - `packages/desktop/apps/electron/src/renderer/components/app-shell/ExtensionMarketplacePanel.tsx`
   - `packages/desktop/apps/electron/src/renderer/components/app-shell/ExtensionMarketplaceDetailPanel.tsx`
   - `packages/desktop/apps/electron/src/shared/__tests__/route-parser-extension-marketplace.test.ts`

2. Удалить регистрацию хендлеров из `packages/desktop/packages/server-core/src/handlers/rpc/index.ts`:
   - импорт `registerExtensionsHandlers`
   - вызов `registerExtensionsHandlers(server, deps)`

3. Удалить из `packages/desktop/packages/shared/src/protocol/routing.ts`:
   - `RPC_CHANNELS.extensions.MARKETPLACE_LIST`
   - `RPC_CHANNELS.extensions.MARKETPLACE_INSTALL` из `REMOTE_ELIGIBLE_CHANNELS`

4. Удалить из `packages/desktop/apps/electron/src/shared/routes.ts`:
   - route builder `extensionMarketplace`

5. Удалить из `packages/desktop/apps/electron/src/renderer/components/app-shell/MainContentPanel.tsx`:
   - рендеринг панелей `ExtensionMarketplacePanel` и `ExtensionMarketplaceDetailPanel`

6. Удалить импорт и использование из:
   - `AppShellContext.tsx`
   - `NavigationContext.tsx`
   - `panel-stack.ts`

7. Удалить упоминания каналов из `channel-map.ts`

8. Обновить тесты:
   - Удалить `extensions.marketplace.test.ts`
   - Обновить `skills.marketplace.test.ts` (если есть пересечения)
   - Обновить `route-parser.test.ts` (удалить тесты extension marketplace routes)

## Upstream

Не отправлен. Внутренний маркетплейс — fork-only функциональность для корпоративной инсталляции.
