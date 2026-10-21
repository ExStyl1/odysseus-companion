# desktop-pet-session-aggregation

## AIDT

-

## Зачем

Desktop Pet показывал только сессии самого Desktop-приложения: карточки
уведомлений строились из событий `session:event` и исчезали, как только
пользователь уходил в терминал. Сессии Nessy CLI, запущенные в
iTerm2/Terminal.app или через ACP/IDE, были невидимы — питомец «засыпал»,
хотя агент работал.

Патч агрегирует три источника сессий:

- десктоп-сессии (как раньше, `session:event`);
- терминальные TUI-сессии — новый `TerminalSessionWatcher` поллит
  `~/.nessy/projects/*/chats/*.runtime.json` (state-блок MR1/MR3),
  нормализует в `PetSessionUpdate` и пушит `pet:sessionUpdate {to:'all'}`
  каждые 2с; liveness по pid проверяется каждый цикл, torn-read не
  кэшируется, дедуп по (phase, requestId, updatedAt), фильтр desktop-детей
  по живым sessionId, классификация источника по `ps` (`--acp`), idle
  старше 6ч скрывается, исчезнувший sidecar даёт gone;
- ACP/IDE-сессии через новые `pet:*`-каналы.

Терминальные карточки интерактивны: `pet:answerTerminalSession` валидирует
ctl-путь (`path.resolve` строго `~/.nessy/ctl/<safeId>/input.jsonl`) ДО
записи и append'ит MR2-строки `confirmation_response` (option_id или legacy
`allowed:false`); `pet:focusTerminalSession` фокусирует iTerm2/Terminal.app
по tty через AppleScript (pid → lsof, fallback по заголовку; darwin-only,
все спавны через injectable run-seam).

Карточка и чат-форма держатся в синхроне через события `*_resolved`:
`SessionManager` эмитит `permission_resolved`/`elicitation_resolved` после
ответа, renderer-процессор (event-processor) превращает их в эффекты, а
`App` дропает из очередей `pendingPermissions`/`pendingElicitations` форму,
отвеченную извне (карточкой питомца), и наоборот — карточка закрывается,
когда ответили в чате. Дроп по `requestId` (не `slice(1)`), чтобы
невыбранная follow-up форма не терялась после того, как `*_resolved` уже
убрал запись. Dev-диагностика: `NESSY_PET_DEVTOOLS=1 bun run dev` открывает
detached DevTools у pet-окна — frameless-окно иначе не даёт доступа к
консоли (без переменной не открывает, чтобы не шуметь на каждый запуск).

Включение — настройки `appearance:get/setPetTerminalSessions` (default on)
и `appearance:get/setPetAcpSessions` (default off — до релиза CLI MR3) с
CHANGED-бродкастами; watcher читает гейты каждый цикл, применение без
рестарта. Включение тумблеров best-effort включает `dualOutput.enabled`
в CLI-настройках через стандартный ACP settings call (`ensureDualOutputForPetSessions`),
чтобы CLI писал runtime.json sidecar'ы без ручной правки `~/.nessy/settings.json`;
выключение не трогает ключ — dualOutput может обслуживать других потребителей.

## Файлы

- `packages/desktop/apps/electron/src/main/session/terminal-session-watcher.ts` — новый watcher терминальных TUI-сессий (поллинг runtime.json, liveness по pid, дедуп, гейты)
- `packages/desktop/apps/electron/src/main/session/terminal-session-watcher.test.ts` — тесты watcher'а (реальный fs в tmp, monkey-patched process.kill, ps-seam)
- `packages/desktop/apps/electron/src/main/terminal-focus.ts` — AppleScript-фокус iTerm2/Terminal.app по tty (darwin-only, injectable run-seam)
- `packages/desktop/apps/electron/src/main/terminal-focus.test.ts` — тесты фокуса терминала (порядок скриптов, эскейпинг, non-darwin)
- `packages/desktop/apps/electron/src/main/handlers/pet-window.ts` — хендлеры `pet:answerTerminalSession`/`pet:focusTerminalSession` с валидацией ctl-пути
- `packages/desktop/apps/electron/src/main/window-manager.ts` — dev-диагностика: detached DevTools у pet-окна (dev + `NESSY_PET_DEVTOOLS=1`)
- `packages/desktop/packages/server-core/src/sessions/SessionManager.ts` — эмиссия `permission_resolved` после ответа на permission (карточка питомца закрывается при ответе в чате)
- `packages/desktop/apps/electron/src/renderer/App.tsx` — обработка `permission_resolved`: дроп формы из `pendingPermissions` по requestId
- `packages/desktop/apps/electron/src/renderer/event-processor/handlers/session.ts`, `processor.ts`, `types.ts` — `handlePermissionResolved`/эффект `permission_resolved`/тип `PermissionResolvedEvent`
- `packages/desktop/apps/electron/src/main/handlers/__tests__/pet-sessions.test.ts` — тесты pet-хендлеров (матрица валидации ctl-пути, wiring)
- `packages/desktop/apps/electron/src/main/handlers/__tests__/pet-window.test.ts` — тесты хендлеров pet-окна
- `packages/desktop/apps/electron/src/main/handlers/__tests__/registration.test.ts`, `registration-profiles.test.ts` — закрытие дыр RPC-регистрации (pet-window в expected-композиции)
- `packages/desktop/packages/server-core/src/handlers/rpc/skills.ts`, `extensions.ts` — сопутствующее: `MARKETPLACE_DETAILS` в `HANDLED_CHANNELS` (мастер AIDT-7260 добавил хендлер без декларации — registration-тесты падали)
- `packages/desktop/apps/electron/src/main/handlers/__tests__/settings-default-thinking.test.ts` — сопутствующее: мок agent-барреля расширен MCP-функциями, ожидание permission-mode — канонический `auto` (устаревший тест мастера после upstream-синка)
- `packages/desktop/apps/electron/src/renderer/pets/pet-session-mapping.ts` — чистые маппинги phase→PetState/карточка, нормализация desktop-вопросов (ask_user_question) в единый формат опций; флаг `questionnaire` → display-only (много-вопросные/multiSelect-опросы не разрешимы одной кнопкой)
- `packages/desktop/apps/electron/src/renderer/pets/pet-session-mapping.test.ts` — тесты mapping-таблиц
- `packages/desktop/apps/electron/src/renderer/pets/usePetActivityState.ts` — внешние CLI-сессии в активности; ожидающая поза привязана к сессии (awaitingSessions — idle/gone чужой сессии её не сбрасывают)
- `packages/desktop/apps/electron/src/renderer/pets/usePetNotifications.ts` — kind 'permission' (бывший 'pending'), подписка onPetSessionUpdate (gone/idle срывают карточку), answer() по источнику
- `packages/desktop/apps/electron/src/renderer/components/pet/PetNotifications.tsx` — кнопки опций (<=4 + «ещё»), Allow/Cancel, подзаголовок-проект, клик фокусирует терминал/окно
- `packages/desktop/apps/electron/src/renderer/components/pet/DesktopPet.tsx` — правки под новые события
- `packages/desktop/apps/electron/src/renderer/pages/settings/AppearanceSettingsPage.tsx` — тогглы external-session в pet-секции настроек
- `packages/desktop/apps/electron/src/shared/types.ts` — типы PetSessionUpdate и external-session gates
- `packages/desktop/apps/electron/src/transport/channel-map.ts` — RPC-каналы source gates
- `packages/desktop/apps/electron/src/shared/__tests__/ipc-channels.test.ts` — фиксация новых каналов
- `packages/desktop/packages/server-core/src/handlers/rpc/settings.ts` — `appearance:get/setPetTerminalSessions`/`get/setPetAcpSessions` + CHANGED-бродкасты; best-effort включение `dualOutput.enabled` через ACP при включении тумблера
- `packages/desktop/packages/shared/src/config/storage.ts` — хранение external-session gates
- `packages/desktop/packages/shared/src/protocol/pet.ts` — pet-протокол внешних сессий
- `packages/desktop/packages/shared/src/protocol/dto.ts` — ключ настройки `dualOutput.enabled` в `NessyCoreSettingKey`
- `packages/desktop/packages/server-core/src/handlers/rpc/sessions.ts` — RESPOND_TO_ELICITATION в HANDLED_CHANNELS (CI)
- `packages/desktop/packages/shared/src/protocol/channels.ts`, `events.ts`, `routing.ts`, `index.ts` — каналы, события, роутинг
- `packages/desktop/packages/shared/src/i18n/locales/*.json` — `pet.notify.terminal*/answer/cancel/openInApp` в 8 локалях

Ключевые кодовые точки помечены
`// [nessy-fork] desktop-pet-session-aggregation`.

## Откат

1. Удалить `TerminalSessionWatcher` и `terminal-focus.ts` вместе с тестами; убрать запуск watcher'а из main-процесса.
2. Удалить хендлеры `pet:answerTerminalSession`/`pet:focusTerminalSession` из `pet-window.ts` и каналы из `channels.ts`/`routing.ts`/`channel-map.ts`/`events.ts`.
3. Вернуть `usePetNotifications`/`PetNotifications` к desktop-only карточкам (kind 'pending') и убрать `pet-session-mapping.ts`.
4. Убрать поток `permission_resolved`: эмиссию в `SessionManager.ts`, `handlePermissionResolved`/эффект в event-processor и обработку в `App.tsx`; вернуть дроп очереди к `slice(1)`.
5. Удалить настройки `petTerminalSessions`/`petAcpSessions` из `storage.ts`/`settings.ts` и тогглы из `AppearanceSettingsPage`.
6. Удалить маркеры `[nessy-fork] desktop-pet-session-aggregation`, строку из реестра и этот файл.

## Upstream

Не отправлен.
