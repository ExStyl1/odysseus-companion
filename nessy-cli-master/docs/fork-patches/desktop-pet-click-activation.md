# desktop-pet-click-activation

## AIDT

AIDT-7352

## Зачем

Desktop PET остаётся поверх остальных приложений и служит быстрым способом
вернуться к агенту. Раньше обычный клик открывал workspace, к которому привязан
PET, и создавал в нём новое окно, если открытого окна этого workspace не было.
Это уводило пользователя из последнего активного диалога.

Патч сохраняет различие короткого клика и перетаскивания, но по клику фокусирует
последнее активное основное окно. Если основных окон нет, создаётся окно в
workspace по умолчанию. Клик по карточке уведомления по-прежнему открывает
конкретную сессию в workspace, к которому привязан PET.

## Файлы

- `packages/desktop/apps/electron/src/main/handlers/pet-window.ts` — фокусирует последнее активное окно или создаёт окно в workspace по умолчанию
- `packages/desktop/apps/electron/src/main/handlers/__tests__/pet-window.test.ts` — проверяет восстановление последнего окна и fallback на workspace по умолчанию
- `packages/desktop/apps/electron/src/renderer/components/pet/DesktopPet.tsx` — различает click и drag и вызывает отдельную активацию основного окна
- `packages/desktop/apps/electron/src/shared/__tests__/ipc-channels.test.ts` — фиксирует новый IPC-канал в публичном списке
- `packages/desktop/apps/electron/src/shared/types.ts` — объявляет renderer API активации последнего окна
- `packages/desktop/apps/electron/src/transport/channel-map.ts` — связывает renderer API с RPC-каналом
- `packages/desktop/packages/shared/src/protocol/channels.ts` — объявляет RPC-канал клика по PET
- `packages/desktop/packages/shared/src/protocol/routing.ts` — относит RPC-канал к локальным Desktop-вызовам

Ключевые кодовые точки помечены
`// [nessy-fork] desktop-pet-click-activation`.

## Откат

1. Удалить RPC-канал и renderer API `petFocusLastWindow` вместе с обработчиком и тестом.
2. Вернуть прежнюю обработку короткого клика через `getWindowWorkspace` и `openWorkspace`.
3. Удалить маркеры `[nessy-fork] desktop-pet-click-activation`, строку из реестра и этот файл.

## Upstream

Не отправлен.
