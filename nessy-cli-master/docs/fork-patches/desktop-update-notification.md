# desktop-update-notification

## AIDT

AIDT-7193

## Зачем

Desktop обнаруживал и скачивал обновления в фоне, но пользователь видел их
состояние только после перехода в Settings → App. Патч показывает одно
системное toast-уведомление для каждой новой версии и постоянный компактный
бейдж рядом с иконкой приложения в хедере.

Системное уведомление создаётся в main-процессе после launch-проверки
обновления, поэтому несколько открытых окон не дублируют toast. Клик
восстанавливает последнее активное окно и открывает Settings → App. Клик по
бейджу также открывает эту страницу, где остаются существующие прогресс
скачивания и действие установки. Логика проверки, скачивания и установки
обновлений не изменяется.

## Файлы

- `packages/desktop/apps/electron/src/main/auto-update.ts` — запуск уведомления после определения доступной версии
- `packages/desktop/apps/electron/src/main/notifications.ts` — системное toast-уведомление, дедупликация и обработка клика
- `packages/desktop/apps/electron/src/renderer/components/app-shell/TopBar.tsx` — подписка на состояние updater, бейдж и переход в App
- `packages/desktop/apps/electron/src/renderer/App.tsx` — обработка перехода из системного уведомления
- `packages/desktop/packages/shared/src/protocol/*.ts` — канал навигации из уведомления

Ключевые кодовые точки помечены
`// [nessy-fork] desktop-update-notification`.

## Откат

1. Удалить уведомление из main-процесса и бейдж обновления из TopBar.
2. Удалить канал навигации обновления и его обработчик в renderer.
3. Удалить маркер `[nessy-fork] desktop-update-notification`, строку из реестра и этот файл.

## Upstream

Не отправлен.
