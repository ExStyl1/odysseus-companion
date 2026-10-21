# desktop-first-run-setup

## AIDT

AIDT-7354

## Зачем

При первой установке Nessy Desktop (без предварительной установки nessy-cli) пользователь не может начать работу:

1. Desktop не вызывает ACP `authenticate`, когда CLI требует `dp-auth`
2. CLI bootstrap не находит bundled CA в dev/build layout, а позднее изменение
   `NODE_EXTRA_CA_CERTS` не применяется к загрузке DP через Node fetch
3. Не скачивается дефолтный extension — интерфейс ещё не доступен

Desktop создаёт встроенное LLM-подключение и на чистом локальном профиле показывает экран `Подготавливаем Nessy…`. До открытия чата он устанавливает дефолтный extension, запускает CLI метод `dp-auth` и загружает каталог моделей. Ошибка остаётся на экране подготовки с возможностью повтора. Порядок авторизации CLI до инициализации MCP описан в [acp-session-auth](./acp-session-auth.md). Desktop и CLI независимо используют CA из поставки: Desktop применяет его к собственному глобальному Undici dispatcher, а CLI выбирает сертификат в bootstrap, обновляет его кэш в `~/.nessy` и явно применяет CA при загрузке DP. Desktop не передаёт выбранный CA дочерней CLI.

## Файлы

- `packages/desktop/packages/shared/src/config/storage.ts` — `ensureDefaultNessyConnection()`
- `packages/desktop/packages/server-core/src/sessions/SessionManager.ts` — вызов `ensureDefaultNessyConnection()`
- `packages/desktop/apps/electron/src/main/index.ts` — последовательность первого запуска и поиск project root в dev
- `packages/desktop/apps/electron/src/main/default-extension.ts` — проверка установленного default extension
- `packages/desktop/apps/electron/src/main/desktop-ca.ts` и `network-proxy.ts` — CA для внутренних Desktop-запросов
- `packages/desktop/apps/electron/src/preload/bootstrap.ts` и `src/shared/types.ts` — IPC подготовки
- `packages/desktop/apps/electron/src/renderer/App.tsx` — блокирующий экран подготовки и Retry
- `packages/desktop/apps/electron/src/renderer/components/SplashScreen.tsx` — анимированный индикатор подготовки
- `packages/desktop/packages/server-core/src/bootstrap/headless-start.ts` — отложенный refresh моделей в GUI
- `packages/desktop/packages/shared/src/agent/nessy-agent.ts` — ACP-аутентификация
- `packages/cli/src/bootstrap.ts` — поиск и установка bundled CA
- `packages/core/src/dp/dp-downloader.ts` — применение CA при скачивании DP

## Откат

1. Удалить вызов `ensureDefaultNessyConnection()` из `SessionManager.initialize()`
2. Удалить first-run marker, IPC, экран подготовки и установку default extension
3. Удалить DP Auth retry и общий вызов ACP-аутентификации
4. Вернуть model refresh к безусловному запуску при bootstrap
5. Откатить изменения CA в CLI bootstrap, загрузчике DP и Desktop dispatcher
6. Удалить маркеры `[nessy-fork] desktop-first-run-setup`, строку из реестра и этот файл

## Upstream

Не отправлен. Desktop-специфичная функциональность первого запуска.
