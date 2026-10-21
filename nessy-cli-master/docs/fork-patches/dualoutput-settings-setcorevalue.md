# dualoutput-settings-setcorevalue

## AIDT

-

## Зачем

Desktop-тумблеры «терминальные/ACP-сессии» питомца включают
`dualOutput.enabled` удалённо через ACP `nessy/settings/setCoreValue`,
чтобы runtime.json-сайдкары писались без ручного редактирования
`~/.nessy/settings.json`. Патч добавляет ключ `dualOutput.enabled` в
реестр core-настроек ACP-агента:

- Тип значения — boolean, вложенная запись через существующий
  dotted-механизм `setValue` (`dualOutput: { enabled }`).
- Без патча desktop-потребитель (nessy-session-notifier) не может
  включить sidecar-отчётность программно.

Осознанный out of scope: сам флаг `dualOutput.enabled` и его семантика
описаны патчем tui-session-status — здесь только удалённая запись
настройки через ACP.

## Файлы

- `packages/cli/src/acp-integration/acpAgent.ts` — ключ
  `dualOutput.enabled` в `NessyCoreSettingKey` и
  `NESSY_CORE_SETTING_DEFINITIONS`.
- `packages/cli/src/acp-integration/acpAgent.test.ts` — тест setCoreValue
  для `dualOutput.enabled` (+ eslint-disable для пре-существующего
  it.skip-черновика, триггерящего lint-staged при стейджинге файла).
- `packages/desktop/packages/shared/src/protocol/dto.ts` — ключ
  `'dualOutput.enabled'` в desktop-union `NessyCoreSettingKey`
  (вызывающая сторона — settings-хендлер патча
  desktop-pet-session-aggregation).

Кодовые точки помечены `// [nessy-fork] dualoutput-settings-setcorevalue`.

## Откат

1. Убрать `'dualOutput.enabled'` из `NessyCoreSettingKey` и
   `NESSY_CORE_SETTING_DEFINITIONS` в `acpAgent.ts`.
2. Убрать тест setCoreValue для `dualOutput.enabled` из `acpAgent.test.ts`
   (eslint-disable для it.skip можно оставить — он про пре-существующий
   черновик).
3. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен. Внутренний потребитель — desktop pet тумблеры
nessy-session-notifier.
