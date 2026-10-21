# loop-detection-adaptive-cap-port

## AIDT

AIDT-8167

## Зачем

Портирование upstream-фичи адаптивного per-turn лимита вызовов инструментов
(`model.maxToolCallsPerTurn`) из `QwenLM/qwen-code` в наш форк. Длительные
автономные задачи (например, работа на ночь) обрывались на 100-м вызове за
ход, а `model.skipLoopDetection` отключает только эвристики и не влияет на
жёсткий лимит. У upstream это уже решено, переносим решение целиком.

Адаптации под форк (расхождения с upstream, важны при будущем merge):

- `SettingsType` в нашем форке не содержит `'integer'` (в upstream есть),
  поэтому настройка объявлена как `type: 'number'`, а не `'integer'`.
- В форке нет класса `FatalConfigError` — валидация `maxToolCallsPerTurn`
  кидает обычный `Error`.
- В форке нет shell-inspection guard и ACP/daemon per-turn-капа (у upstream
  они есть) — соответствующие ветки upstream не переносились.

## Файлы

- `packages/core/src/services/loopDetectionService.ts` — порт adaptive cap
  (soft 100 / hard backstop 1000), canonicalize аргументов, уважение
  `disabledForSession`; без shell-inspection guard (нет в форке).
- `packages/core/src/config/config.ts` — параметр/геттер `maxToolCallsPerTurn`,
  `isMaxToolCallsPerTurnExplicit()`, `validateMaxToolCallsPerTurn` через
  `throw new Error` (нет `FatalConfigError`).
- `packages/core/src/core/client.ts` — `loopDetector.reset(prompt_id)` на
  Stop-hook continuation (свежий бюджет на каждую `/goal`-итерацию).
- `packages/core/src/index.ts` — экспорт `DEFAULT_MAX_TOOL_CALLS_PER_TURN`.
- `packages/cli/src/config/config.ts` — проброс настройки из settings.
- `packages/cli/src/config/settingsSchema.ts` — настройка `maxToolCallsPerTurn`
  c `type: 'number'` (upstream использует `'integer'`).
- `packages/cli/src/nonInteractiveCli.ts` — headless-hint для
  `TURN_TOOL_CALL_CAP`; `isAlwaysOn` без `SHELL_COMMAND_STAGNATION` /
  `INVALID_TOOL_PARAMS_STAGNATION` (нет в форке).
- `packages/cli/src/ui/components/LoopDetectionConfirmation.tsx` — текст
  диалога без упоминания shell-inspection guard.
- `docs/users/configuration/settings.md`,
  `packages/vscode-ide-companion/schemas/settings.schema.json` — документация
  и схема настройки (`"type": "number"`).

## Откат

Когда upstream-версия этих файлов приедет в форк обычным sync (PR #6238,
#7052 и последующие), принять upstream-версии и убрать fork-адаптации:

1. `packages/cli/src/config/settingsSchema.ts` — вернуть `type` настройки
   `maxToolCallsPerTurn` к `'integer'` (после того как в форк приедет
   `SettingsType['integer']`), убрать `// [nessy-fork] loop-detection-adaptive-cap-port`.
2. `packages/core/src/config/config.ts` — заменить `throw new Error` в
   `validateMaxToolCallsPerTurn` на upstream `FatalConfigError`, если класс
   появится.
3. `packages/cli/src/nonInteractiveCli.ts` — вернуть `SHELL_COMMAND_STAGNATION`
   / `INVALID_TOOL_PARAMS_STAGNATION` в `isAlwaysOn`, если соответствующие
   LoopType появятся в форке.
4. `packages/cli/src/ui/components/LoopDetectionConfirmation.tsx` — вернуть
   upstream-текст про shell-inspection guard.
5. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Портировано из `QwenLM/qwen-code`:
- `cdf83d8bd0` — make the cap configurable (PR #6238).
- `a9d338684d` — make the per-turn tool-call cap adaptive (PR #7052).

Адаптации (числовой тип, `Error` вместо `FatalConfigError`, отсутствие
shell/ACP-веток) — локальны для форка, в upstream их нет.