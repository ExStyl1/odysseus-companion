# remote-option-response

## AIDT

-

## Зачем

Внешние потребители (nessy-session-notifier) отвечают на ожидающее
подтверждение через `confirmation_response` в `input.jsonl`. Бинарного
`allowed` недостаточно: AskUserQuestion с вариантами ответа,
allow_always-варианты и cancel различаются только выбором опции. Патч
добавляет ответ по `option_id` — одному из id, публикуемых в runtime.json
`state.pending_request.options` (те же id, что в ACP permission-модели,
`q{n}_opt{m}` для ask):

- Команда `confirmation_response` принимает `option_id` в дополнение к
  легаси-флагу `allowed`; при обоих полях приоритет у `option_id`.
- Чистый резолвер `resolveRemoteOptionResponse()` переводит `q{n}_opt{m}`
  (ask_user_question) в `ProceedOnce` + `answers {[индекс вопроса]: label}`
  — тот же контракт, что у AskUserQuestionDialog; enum-id — в
  соответствующий `ToolConfirmationOutcome`.
- Выбор валидируется против фактически предложенных опций
  (`toPermissionOptions`, включая фильтр `hideAlwaysAllow`): устаревший,
  чужой или отфильтрованный id отклоняется `control_response`-ошибкой, а
  не уходит вслепую в `onConfirm`.
- «Свой ответ» (ProceedOnce на ask) отклоняется: текстового канала через
  input-file нет.
- `RemoteInputWatcher` нормализует команду в `RemoteConfirmationResponse
{ allowed, optionId? }`; allowed-only команды работают как раньше.
- `AppContainer` ветвится: optionId → резолвер, иначе прежний бинарный
  путь; id коррелируют с реестром `pending_request`/`control_request`
  (общий request_id).

Out of scope (осознанно): ACP/IDE/daemon-сессии — граница как в
tui-session-status.

## Файлы

- `packages/cli/src/remoteInput/remote-option-response.ts` — резолвер
  option_id → `onConfirm(outcome, answers)` с валидацией membership.
- `packages/cli/src/remoteInput/remote-option-response.test.ts` — тесты
  резолвера (membership, маппинг `q{n}_opt{m}`, матрица отказов).
- `packages/cli/src/remoteInput/RemoteInputWatcher.ts` — нормализация
  команды в `RemoteConfirmationResponse`, приоритет option_id.
- `packages/cli/src/remoteInput/RemoteInputWatcher.test.ts` — тесты
  watcher (нормализация, приоритет, обратная совместимость).
- `packages/cli/src/ui/AppContainer.tsx` — ветвление ответа: optionId →
  резолвер, иначе бинарный путь; `control_response`-ошибка для invalid.

Кодовые точки помечены `// [nessy-fork] remote-option-response`.

## Откат

1. Удалить `packages/cli/src/remoteInput/remote-option-response.ts` и
   `remote-option-response.test.ts`.
2. В `RemoteInputWatcher.ts` вернуть `confirmation_response` к
   обязательному `allowed: boolean`, убрать `RemoteConfirmationResponse`
   и вернуть `ConfirmationHandler` к `(requestId, allowed)`.
3. В `AppContainer.tsx` убрать ветку optionId и вызов резолвера, вернуть
   бинарный вызов `onConfirm(allowed ? ProceedOnce : Cancel)`.
4. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен. Внутренний потребитель — nessy-session-notifier (кнопки
уведомлений).
