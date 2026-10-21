# tui-session-status

## AIDT

-

## Зачем

Внешние потребители (nessy-session-notifier, macOS menu-bar) не могут узнать
состояние интерактивной TUI-сессии без скрейпа терминала. Патч добавляет
машиночитаемый статус и канал управления:

- Интерактивный TUI пишет аддитивный блок `state` в существующий сайдкар
  `runtime.json` (`schema_version` не меняется): `phase` (idle / working /
  waiting_input / done), `updated_at`, `pending_request` (request_id,
  tool_name, summary, options с теми же id, что в ACP permission-модели —
  `q{n}_opt{m}` для ask) и `control` (events_file / input_file).
- Per-session контрольные пути по конвенции
  `~/.nessy/ctl/<sessionId>/{events.jsonl,input.jsonl}` (каталог 0700,
  файлы 0600) провижинит сам TUI при включённом `dualOutput.enabled`;
  в settings добавлен только флаг, без путей — параллельные сессии не
  конфликтуют, потребитель не требует настройки.
- Удалённая запись флага через ACP — отдельный патч
  `dualoutput-settings-setcorevalue`.
- Флаг `dualOutput.enabled` — `requiresRestart`: включённый удалённо (из
  тумблера питомца) ключ подхватят только НОВЫЕ сессии; уже запущенный
  терминальный nessy начнёт писать сайдкар после перезапуска.
- Запись `state` строго по переходам (awaiting_approval, result/idle),
  не периодическим рефрешем; одинаковые подряд состояния дедуплицируются
  (edge-triggered).
- `request_id` ожидающего запроса выдаётся единым реестром, общим
  с dual-output мостом: потребитель отвечает на тот же request_id, что видел.

Семантика `phase=done`: ход завершён и ответ готов к прочтению; нотификатор
гасит уведомление при следующем переходе в working. `done` не означает
«сессия закрыта».

ACP/IDE-companion/daemon-сессии статус пока не пишут (осознанный out of
scope — будущий путь покрытия через систему hooks).

## Файлы

- `packages/cli/src/config/config.ts` — `autoSessionControl` из
  `settings.dualOutput.enabled` (выключен в bare mode).
- `packages/cli/src/config/settingsSchema.ts` — флаг `dualOutput.enabled`.
- `packages/cli/src/gemini.tsx` — провижининг ctl-путей при старте TUI,
  создание `SessionStatusReporter`, обёртка `SessionStatusContext.Provider`.
- `packages/cli/src/sessionStatus/SessionStatusContext.tsx` — React-контекст
  репортера.
- `packages/cli/src/sessionStatus/index.ts` — экспорты модуля.
- `packages/cli/src/sessionStatus/session-control-paths.ts` — провижининг
  `~/.nessy/ctl/<sessionId>/` (санитизация id, права 0700/0600).
- `packages/cli/src/sessionStatus/session-control-paths.test.ts` — тесты.
- `packages/cli/src/sessionStatus/session-phase-resolver.ts` — маппинг
  TUI-состояния в фазы и `pending_request` (summarize, options).
- `packages/cli/src/sessionStatus/session-phase-resolver.test.ts` — тесты.
- `packages/cli/src/sessionStatus/session-status-reporter.ts` —
  edge-triggered сериализованная запись `state`.
- `packages/cli/src/sessionStatus/session-status-reporter.test.ts` — тесты.
- `packages/cli/src/ui/AppContainer.tsx` — эффект записи фаз по переходам;
  общий реестр request_id с dual-output мостом.
- `packages/core/src/config/config.ts` — `ConfigParameters.autoSessionControl`
  и `getAutoSessionControl()`.
- `packages/core/src/utils/runtimeStatus.ts` — типы `RuntimeSessionState` и
  `updateRuntimeStatusState()` (read-modify-write, никогда не бросает).
- `packages/core/src/utils/runtimeStatus.test.ts` — тесты.
- `packages/vscode-ide-companion/schemas/settings.schema.json` — JSON-схема
  флага `dualOutput.enabled`.

Кодовые точки помечены `// [nessy-fork] tui-session-status`.

## Откат

2. Убрать флаг `enabled` из `dualOutput` в `settingsSchema.ts` и
   `vscode-ide-companion/schemas/settings.schema.json`.
3. Убрать `autoSessionControl` из `ConfigParameters` и `getAutoSessionControl()`
   из `packages/core/src/config/config.ts`; убрать маппинг в
   `packages/cli/src/config/config.ts`.
4. Удалить `RuntimeSessionState` / `updateRuntimeStatusState()` из
   `packages/core/src/utils/runtimeStatus.ts` и `runtimeStatus.test.ts`.
5. Удалить каталог `packages/cli/src/sessionStatus/` целиком.
6. В `gemini.tsx` убрать провижининг ctl-путей, создание reporter
   и `SessionStatusContext.Provider`.
7. В `AppContainer.tsx` убрать эффект записи фаз; реестр request_id
   вернуть к локальному `confirmEmitted` (dual-output остаётся
   upstream-совместимым).
8. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен. Внутренний потребитель — nessy-session-notifier / macOS menu-bar.
